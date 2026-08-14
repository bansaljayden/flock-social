#!/usr/bin/env node
// tools/asc-upload/upload.mjs
//
// App Store Connect metadata + screenshot uploader for Flock.
//
//   node tools/asc-upload/upload.mjs --key <AuthKey.p8> --key-id <KID> --issuer <ISSUER> [--dry-run]
//
// With no key arguments it runs a full offline dry run: parses
// APP-STORE-SUBMISSION.md, validates every field against Apple's limits and
// the doc's own computed counts, inventories the screenshot files, and prints
// exactly which API calls a live run would make. Nothing is written anywhere.
//
// It never touches privacy labels, the age rating, review notes, category, or
// submission; the checklist for those prints at the end of every run.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ASC_BASE_URL,
  buildPlan,
  buildScreenshotManifest,
  mintAscJwt,
  neverTouchesChecklist,
  parseSubmissionDoc,
  planScreenshotUploads,
  pngDimensions,
  validateListing,
} from './lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values: args } = parseArgs({
  options: {
    key: { type: 'string' },
    'key-id': { type: 'string' },
    issuer: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    doc: { type: 'string', default: join(REPO_ROOT, 'APP-STORE-SUBMISSION.md') },
    'screenshots-dir': { type: 'string', default: join(REPO_ROOT, 'frontend', 'public', 'screenshots', 'appstore') },
    'bundle-id': { type: 'string', default: 'com.flockcorp.flock' },
    version: { type: 'string', default: '1.0' },
    locale: { type: 'string', default: 'en-US' },
    help: { type: 'boolean', default: false },
  },
});

if (args.help) {
  console.log(`Usage: node tools/asc-upload/upload.mjs [options]

  --key <path>            AuthKey_XXXXXXXXXX.p8 from App Store Connect
  --key-id <id>           the key's 10-char ID
  --issuer <uuid>         issuer ID from the API Keys page
  --dry-run               parse + validate + plan, no network writes
  --doc <path>            submission doc (default: APP-STORE-SUBMISSION.md at repo root)
  --screenshots-dir <p>   default: frontend/public/screenshots/appstore
  --bundle-id <id>        default: com.flockcorp.flock
  --version <v>           default: 1.0
  --locale <l>            default: en-US

With --key/--key-id/--issuer absent, --dry-run is forced (offline).`);
  process.exit(0);
}

const haveCredentials = Boolean(args.key && args['key-id'] && args.issuer);
const dryRun = args['dry-run'] || !haveCredentials;

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ASC client (only constructed when credentials exist)
// ---------------------------------------------------------------------------

function makeClient({ keyPem, keyId, issuerId }) {
  let token = null;
  let tokenExp = 0;
  const authHeader = () => {
    const now = Math.floor(Date.now() / 1000);
    if (!token || now > tokenExp - 60) {
      token = mintAscJwt({ privateKeyPem: keyPem, keyId, issuerId, nowSeconds: now });
      tokenExp = now + 19 * 60;
    }
    return `Bearer ${token}`;
  };

  async function request(method, path, body) {
    const res = await fetch(`${ASC_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: authHeader(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const err = new Error(formatAscError(res.status, json, text, method, path));
      err.status = res.status;
      err.ascErrors = json?.errors ?? null;
      throw err;
    }
    return json;
  }

  return { request };
}

function formatAscError(status, json, rawText, method, path) {
  const lines = [`${method} ${path} -> HTTP ${status}`];
  if (json?.errors?.length) {
    lines.push("Apple's response, verbatim:");
    for (const e of json.errors) {
      lines.push(`  [${e.status ?? status}] ${e.code ?? ''} ${e.title ?? ''}`.trimEnd());
      if (e.detail) lines.push(`      ${e.detail}`);
    }
  } else if (rawText) {
    lines.push(`Response body: ${rawText.slice(0, 500)}`);
  }
  if (status === 401) {
    lines.push('Plain English: the key, key ID, and issuer do not form a valid trio (or the key was revoked, or system clock skew broke the token window). Re-check --key-id and --issuer against the exact row on the ASC API Keys page for this .p8.');
  }
  if (status === 409) {
    lines.push('Plain English: App Store Connect rejected the value as-is. For app name/subtitle this usually means the name is not reserved for this app yet (or another app holds it). Reserve the name in the ASC UI first (doc section 6.1 has the fallback pair). This tool never retries a 409 blindly.');
  }
  if (status === 403) {
    lines.push('Plain English: the key is valid but lacks permission for this resource. Check the key role (App Manager or Admin needed for metadata writes).');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Screenshot directory inventory
// ---------------------------------------------------------------------------

async function inventoryScreenshots(dir) {
  const files = new Map();
  if (!existsSync(dir)) return files;
  for (const name of await readdir(dir)) {
    if (!name.toLowerCase().endsWith('.png')) continue;
    const full = join(dir, name);
    const s = await stat(full);
    if (!s.isFile()) continue;
    const buf = await readFile(full);
    let width = null; let height = null;
    try { ({ width, height } = pngDimensions(buf)); } catch { /* surfaced by manifest */ }
    files.set(name, { size: s.size, width, height, path: full });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Live remote-state discovery + execution
// ---------------------------------------------------------------------------

async function discoverRemote(client, { bundleId, versionString, locale }) {
  const remote = { appId: null, versionId: null, versionLocalizationId: null, appInfoId: null, appInfoLocalizationId: null, screenshotSets: {} };

  const apps = await client.request('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  if (!apps?.data?.length) {
    throw new Error(
      `No app with bundle id ${bundleId} is visible to this key. ` +
      'FIX: create the app record in App Store Connect first (My Apps > + > New App), or check the key belongs to the right team.'
    );
  }
  remote.appId = apps.data[0].id;

  const versions = await client.request(
    'GET',
    `/v1/apps/${remote.appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${encodeURIComponent(versionString)}`
  );
  if (versions?.data?.length) {
    remote.versionId = versions.data[0].id;
    const locs = await client.request('GET', `/v1/appStoreVersions/${remote.versionId}/appStoreVersionLocalizations`);
    const loc = locs?.data?.find((l) => l.attributes?.locale === locale);
    if (loc) {
      remote.versionLocalizationId = loc.id;
      const sets = await client.request('GET', `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`);
      for (const set of sets?.data ?? []) {
        const shots = await client.request('GET', `/v1/appScreenshotSets/${set.id}/appScreenshots`);
        remote.screenshotSets[set.attributes.screenshotDisplayType] = {
          id: set.id,
          screenshotIds: (shots?.data ?? []).map((s) => s.id),
        };
      }
    }
  }

  // App infos: pick the editable one (state readable via filter on the
  // localizations themselves; the first appInfo whose localizations we can
  // PATCH is the in-progress one).
  const infos = await client.request('GET', `/v1/apps/${remote.appId}/appInfos?include=appInfoLocalizations`);
  const editable = (infos?.data ?? []).find((i) => {
    const state = i.attributes?.state ?? i.attributes?.appStoreState;
    return state && !['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_INFO'].includes(state);
  }) ?? infos?.data?.[0];
  if (editable) {
    remote.appInfoId = editable.id;
    // Ask for the localizations directly instead of trusting the include
    // payload's relationship linkage: ASC omits the linkage array unless the
    // relationship itself is requested, which made an existing en-US record
    // invisible here and sent executePlan down the POST path into a 409
    // (ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE, seen live 2026-08-14 after
    // the name was set by hand in the UI).
    const locs = await client.request('GET', `/v1/appInfos/${editable.id}/appInfoLocalizations`);
    const loc = locs?.data?.find((l) => l.attributes?.locale === locale);
    if (loc) remote.appInfoLocalizationId = loc.id;
  }
  return remote;
}

async function executePlan(client, steps, { remote, locale, files, screenshotsDir }) {
  // Mutable ids resolved as we go.
  let versionId = remote.versionId;
  let versionLocalizationId = remote.versionLocalizationId;
  const setIds = Object.fromEntries(
    Object.entries(remote.screenshotSets).map(([t, s]) => [t, s.id])
  );

  for (const step of steps) {
    switch (step.kind) {
      case 'lookup-app':
      case 'lookup-version':
      case 'reuse-screenshot-set':
      case 'skip-screenshot':
        console.log(`  - ${step.note ?? step.kind}`);
        break;

      case 'create-version': {
        const body = {
          data: {
            ...step.body,
            relationships: { app: { data: { type: 'apps', id: remote.appId } } },
          },
        };
        const res = await client.request('POST', step.path, body);
        versionId = res.data.id;
        console.log(`  + created appStoreVersion ${versionId}`);
        break;
      }
      case 'update-version':
        await client.request('PATCH', step.path, { data: { ...step.body, id: versionId } });
        console.log(`  ~ updated appStoreVersion ${versionId}`);
        break;

      case 'create-version-localization': {
        const body = {
          data: {
            ...step.body,
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        };
        const res = await client.request('POST', step.path, body);
        versionLocalizationId = res.data.id;
        console.log(`  + created ${locale} appStoreVersionLocalization ${versionLocalizationId}`);
        break;
      }
      case 'update-version-localization':
        try {
          await client.request('PATCH', step.path, { data: { ...step.body, id: versionLocalizationId } });
          console.log(`  ~ updated ${locale} appStoreVersionLocalization ${versionLocalizationId}`);
        } catch (e) {
          // Apple refuses whatsNew on a version of an app that has never
          // shipped (What's New only exists for updates). That exact refusal
          // is retried once without the attribute; anything else re-throws.
          // This is a different request body, not a blind retry.
          const whatsNewRefused = e.status === 409
            && (e.ascErrors ?? []).some((x) => /whatsNew/.test(x.detail ?? ''))
            && step.body.attributes?.whatsNew !== undefined;
          if (!whatsNewRefused) throw e;
          const attributes = { ...step.body.attributes };
          delete attributes.whatsNew;
          await client.request('PATCH', step.path, { data: { ...step.body, attributes, id: versionLocalizationId } });
          console.log(`  ~ updated ${locale} appStoreVersionLocalization ${versionLocalizationId} (whatsNew skipped: not editable on a first version)`);
        }
        break;

      case 'create-appinfo-localization': {
        const body = {
          data: {
            ...step.body,
            relationships: { appInfo: { data: { type: 'appInfos', id: remote.appInfoId } } },
          },
        };
        const res = await client.request('POST', step.path, body);
        console.log(`  + created ${locale} appInfoLocalization ${res.data.id} (name + subtitle + privacy policy URL)`);
        break;
      }
      case 'update-appinfo-localization':
        await client.request('PATCH', step.path, { data: { ...step.body, id: remote.appInfoLocalizationId } });
        console.log(`  ~ updated ${locale} appInfoLocalization (name + subtitle + privacy policy URL)`);
        break;

      case 'delete-screenshot':
        await client.request('DELETE', step.path);
        console.log(`  - ${step.note}`);
        break;

      case 'create-screenshot-set': {
        const displayType = step.body.attributes.screenshotDisplayType;
        const body = {
          data: {
            ...step.body,
            relationships: {
              appStoreVersionLocalization: {
                data: { type: 'appStoreVersionLocalizations', id: versionLocalizationId },
              },
            },
          },
        };
        const res = await client.request('POST', step.path, body);
        setIds[displayType] = res.data.id;
        console.log(`  + created appScreenshotSet ${res.data.id} (${displayType})`);
        break;
      }

      case 'reserve-screenshot': {
        const { displayType, fileName } = step;
        const info = files.get(fileName);
        const fileBuf = await readFile(info.path);
        const reservation = await client.request('POST', '/v1/appScreenshots', {
          data: {
            type: 'appScreenshots',
            attributes: { fileName, fileSize: fileBuf.length },
            relationships: {
              appScreenshotSet: { data: { type: 'appScreenshotSets', id: setIds[displayType] } },
            },
          },
        });
        const ops = reservation.data.attributes.uploadOperations ?? [];
        for (const op of ops) {
          const part = fileBuf.subarray(op.offset, op.offset + op.length);
          const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
          const up = await fetch(op.url, { method: op.method, headers, body: part });
          if (!up.ok) {
            throw new Error(`Part upload for ${fileName} failed: HTTP ${up.status} from the upload URL. Re-run the tool; parts can be retried until the reservation is committed.`);
          }
        }
        const md5 = createHash('md5').update(fileBuf).digest('hex');
        await client.request('PATCH', `/v1/appScreenshots/${reservation.data.id}`, {
          data: {
            type: 'appScreenshots',
            id: reservation.data.id,
            attributes: { uploaded: true, sourceFileChecksum: md5 },
          },
        });
        // Poll assetDeliveryState until COMPLETE / FAILED.
        let state = 'UPLOAD_COMPLETE';
        for (let i = 0; i < 30; i++) {
          const check = await client.request(
            'GET',
            `/v1/appScreenshots/${reservation.data.id}?fields[appScreenshots]=assetDeliveryState`
          );
          state = check?.data?.attributes?.assetDeliveryState?.state ?? state;
          if (state === 'COMPLETE' || state === 'FAILED') break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (state === 'FAILED') {
          throw new Error(`${fileName}: App Store Connect reports assetDeliveryState FAILED. Delete is automatic on the next run; check the image meets the ${displayType} pixel size and PNG requirements, then re-run.`);
        }
        console.log(`  + uploaded ${fileName} (${displayType}, ${state})`);
        break;
      }

      case 'upload-parts':
      case 'commit-screenshot':
        // Folded into the reserve-screenshot step during live execution.
        break;

      default:
        console.log(`  - ${step.note ?? step.kind}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`ASC uploader ${dryRun ? '(DRY RUN, no network writes)' : '(LIVE)'}`);
  if (!haveCredentials && !args['dry-run']) {
    console.log('No --key/--key-id/--issuer given: dry run forced.');
  }

  // 1. Parse + validate the submission doc.
  let md;
  try {
    md = await readFile(args.doc, 'utf8');
  } catch {
    fail(`Cannot read the submission doc at ${args.doc}. FIX: pass --doc or run from the repo.`);
  }
  let listing;
  try {
    listing = parseSubmissionDoc(md);
  } catch (e) {
    fail(e.message);
  }
  const errors = validateListing(listing);
  if (errors.length) {
    console.error('\nListing validation FAILED:');
    for (const e of errors) console.error(`  [${e.field}] ${e.message}`);
    process.exit(1);
  }
  console.log('\nListing copy parsed and validated:');
  console.log(`  name "${listing.name}" (${listing.name.length}/30), subtitle "${listing.subtitle}" (${listing.subtitle.length}/30)`);
  console.log(`  keywords ${Buffer.byteLength(listing.keywords)}/100 bytes, description ${listing.description.length}/4000, promo ${listing.promotionalText.length}/170, what's new ${listing.whatsNew.length}/4000`);
  console.log(`  every count matches the doc's own computed numbers (section 6)`);

  // 2. Screenshot inventory.
  const files = await inventoryScreenshots(args['screenshots-dir']);
  const manifest = buildScreenshotManifest(listing.screenshotPlan, files);
  if (manifest.errors.length) {
    console.error('\nScreenshot manifest FAILED:');
    for (const e of manifest.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`\nScreenshots (${args['screenshots-dir']}):`);
  console.log(`  present: ${manifest.present.length} of ${listing.screenshotPlan.length * 2} planned`);
  if (manifest.missing.length) {
    console.log(`  missing (continuing metadata-only for these): ${manifest.missing.join(', ')}`);
  }
  if (manifest.unexpected.length) {
    console.log(`  on disk but not in the section 8 plan (ignored): ${manifest.unexpected.join(', ')}`);
  }
  const uploads = planScreenshotUploads(manifest);

  const options = { bundleId: args['bundle-id'], versionString: args.version, locale: args.locale };

  // 3. Dry run: print the plan and stop before any write.
  if (dryRun) {
    let remote = null;
    if (haveCredentials) {
      // Read-only discovery so the plan shows exact PATCH-vs-POST decisions.
      const keyPem = await readFile(args.key, 'utf8');
      const client = makeClient({ keyPem, keyId: args['key-id'], issuerId: args.issuer });
      console.log(`\nCredentials present: performing read-only discovery as issuer ${args.issuer.slice(0, 8)}… (no writes).`);
      remote = await discoverRemote(client, options);
    }
    const steps = buildPlan({ listing, uploads, remote, options });
    console.log('\nAPI calls a live run would make, in order:');
    for (const step of steps) {
      if (!step.method) { console.log(`  (info) ${step.note}`); continue; }
      console.log(`  ${step.method.padEnd(6)} ${step.path}${step.conditional ? '  [conditional]' : ''}`);
      console.log(`         ${step.note}`);
      if (step.body?.attributes) {
        const attrs = { ...step.body.attributes };
        if (typeof attrs.description === 'string') attrs.description = `${attrs.description.slice(0, 60)}… (${attrs.description.length} chars)`;
        console.log(`         attributes: ${JSON.stringify(attrs)}`);
      }
    }
    printChecklist();
    console.log('\nDry run complete. No network writes were made.');
    return;
  }

  // 4. Live run.
  const keyPem = await readFile(args.key, 'utf8');
  const client = makeClient({ keyPem, keyId: args['key-id'], issuerId: args.issuer });
  console.log('\nDiscovering current App Store Connect state…');
  const remote = await discoverRemote(client, options);
  console.log(`  app ${remote.appId}, version ${remote.versionId ?? '(will create)'}, ${args.locale} localization ${remote.versionLocalizationId ?? '(will create)'}`);
  const steps = buildPlan({ listing, uploads, remote, options });
  console.log('\nExecuting:');
  await executePlan(client, steps, { remote, locale: args.locale, files, screenshotsDir: args['screenshots-dir'] });
  printChecklist();
  console.log('\nDone.');
}

function printChecklist() {
  console.log('\nThis tool deliberately did NOT touch (do these by hand):');
  for (const item of neverTouchesChecklist()) console.log(`  [ ] ${item}`);
}

main().catch((e) => fail(e.message));
