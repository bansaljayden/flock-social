// tools/asc-upload/asc-upload.test.js
// Run: node --test tools/asc-upload/
//
// Everything here runs offline: JWT shape against Apple's researched spec,
// parsing of the real APP-STORE-SUBMISSION.md (counts must match the doc's own
// computed numbers), mutation cases (broken delimiters, oversized fields,
// wrong display types must each fail with a message naming the fix),
// screenshot manifest handling, and idempotency of the API-call plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLE_LIMITS,
  ASC_AUDIENCE,
  MAX_SCREENSHOTS_PER_SET,
  MAX_TOKEN_LIFETIME_SECONDS,
  buildPlan,
  buildScreenshotManifest,
  decodeJwt,
  displayTypeForDimensions,
  mintAscJwt,
  parseSubmissionDoc,
  planScreenshotUploads,
  pngDimensions,
  validateListing,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DOC_PATH = join(REPO_ROOT, 'APP-STORE-SUBMISSION.md');
const DOC = readFileSync(DOC_PATH, 'utf8');

function makeP256Pem() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey,
  };
}

// ---------------------------------------------------------------------------
// JWT: header/claims/signature must match Apple's documented requirements
// (ES256, kid header, iss/iat/exp/aud, exp at most 20 minutes out; verified
// against appstoreconnectapi/generating-tokens-for-api-requests 2026-08-14).
// ---------------------------------------------------------------------------

test('JWT header is exactly {alg: ES256, kid, typ: JWT}', () => {
  const { privatePem } = makeP256Pem();
  const token = mintAscJwt({ privateKeyPem: privatePem, keyId: '2X9R4HXF34', issuerId: '57246542-96fe-1a63-e053-0824d011072a' });
  const { header } = decodeJwt(token);
  assert.deepEqual(header, { alg: 'ES256', kid: '2X9R4HXF34', typ: 'JWT' });
});

test('JWT claims: iss, iat, exp, aud=appstoreconnect-v1, exp within 20 minutes', () => {
  const { privatePem } = makeP256Pem();
  const now = 1755200000;
  const token = mintAscJwt({ privateKeyPem: privatePem, keyId: 'KID1234567', issuerId: 'issuer-uuid', nowSeconds: now });
  const { payload } = decodeJwt(token);
  assert.equal(payload.iss, 'issuer-uuid');
  assert.equal(payload.aud, ASC_AUDIENCE);
  assert.equal(payload.iat, now);
  assert.ok(payload.exp > payload.iat, 'exp must be after iat');
  assert.ok(payload.exp - payload.iat <= MAX_TOKEN_LIFETIME_SECONDS, 'exp must be at most 20 minutes after iat');
  // No stray claims: Apple accepts scope optionally; we send exactly these four.
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss']);
});

test('JWT signature is valid ES256 in raw r||s (ieee-p1363) form', () => {
  const { privatePem, publicKey } = makeP256Pem();
  const token = mintAscJwt({ privateKeyPem: privatePem, keyId: 'K', issuerId: 'I' });
  const { signature, signingInput } = decodeJwt(token);
  assert.equal(signature.length, 64, 'ES256 JWT signature must be exactly 64 bytes (r||s), not DER');
  const ok = cryptoVerify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  assert.ok(ok, 'signature must verify against the public key');
});

test('JWT minting rejects a non-EC key with a fix message', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(
    () => mintAscJwt({ privateKeyPem: rsaPem, keyId: 'K', issuerId: 'I' }),
    /not an EC key.*FIX/s
  );
});

test('JWT minting rejects a lifetime over the 20-minute cap', () => {
  const { privatePem } = makeP256Pem();
  assert.throws(
    () => mintAscJwt({ privateKeyPem: privatePem, keyId: 'K', issuerId: 'I', lifetimeSeconds: 21 * 60 }),
    /20-minute cap.*FIX/s
  );
});

// ---------------------------------------------------------------------------
// Doc parsing against the real APP-STORE-SUBMISSION.md
// ---------------------------------------------------------------------------

test('real doc: every computed count matches the doc-declared count, zero validation errors', () => {
  const listing = parseSubmissionDoc(DOC);
  const errors = validateListing(listing);
  assert.deepEqual(errors, [], `validation must pass on the real doc, got: ${JSON.stringify(errors)}`);
  // Spot-check against the doc's own numbers (section 6).
  assert.equal(listing.name, 'Flock');
  assert.equal(listing.name.length, listing.declaredCounts.name.chars);
  assert.equal(listing.subtitle.length, 28);
  assert.equal(listing.description.length, 2140);
  assert.equal(Buffer.byteLength(listing.keywords, 'utf8'), 98);
  assert.equal(listing.promotionalText.length, 157);
  assert.equal(listing.whatsNew.length, 177);
  assert.equal(listing.copyright, '2026 Flock Corp.');
});

test('real doc: fields are within Apple limits with the researched values', () => {
  const listing = parseSubmissionDoc(DOC);
  assert.ok(listing.name.length <= APPLE_LIMITS.name.chars);
  assert.ok(listing.subtitle.length <= APPLE_LIMITS.subtitle.chars);
  assert.ok(Buffer.byteLength(listing.keywords, 'utf8') <= APPLE_LIMITS.keywords.bytes);
  assert.ok(listing.description.length <= APPLE_LIMITS.description.chars);
  assert.ok(listing.promotionalText.length <= APPLE_LIMITS.promotionalText.chars);
  assert.ok(listing.whatsNew.length <= APPLE_LIMITS.whatsNew.chars);
});

test('real doc: URLs are the canonical https://www forms', () => {
  const listing = parseSubmissionDoc(DOC);
  assert.equal(listing.supportUrl, 'https://www.flockcorp.com/support');
  assert.equal(listing.marketingUrl, 'https://www.flockcorp.com');
  assert.equal(listing.privacyPolicyUrl, 'https://www.flockcorp.com/privacy');
});

test('real doc: screenshot plan has 8 slots, 16 files, naming convention holds', () => {
  const listing = parseSubmissionDoc(DOC);
  assert.equal(listing.screenshotPlan.length, 8);
  const manifest = buildScreenshotManifest(listing.screenshotPlan, new Map());
  assert.deepEqual(manifest.errors, []);
  assert.equal(manifest.missing.length, 16);
  assert.ok(manifest.missing.includes('01-plan-light.png'));
  assert.ok(manifest.missing.includes('08-safety-dark.png'));
});

// ---------------------------------------------------------------------------
// Mutations: each must fail with a message naming the fix
// ---------------------------------------------------------------------------

test('mutation: broken paste-block delimiter fails naming section 6.4', () => {
  const mutated = DOC.replace('---PASTE START---', '---PASTE-START---'); // first occurrence = 6.4
  assert.throws(() => parseSubmissionDoc(mutated), /6\.4 paste block delimiters.*FIX/s);
});

test('mutation: oversized description fails naming the 4000 limit', () => {
  const mutated = DOC.replace(
    'Plans die in the group chat.',
    `Plans die in the group chat.${'x'.repeat(2000)}`
  );
  const errors = validateListing(parseSubmissionDoc(mutated));
  const limitError = errors.find((e) => e.field === 'description' && /limit is 4000.*FIX/s.test(e.message));
  assert.ok(limitError, `expected a description over-limit error, got: ${JSON.stringify(errors)}`);
});

test('mutation: over-100-byte keyword field fails naming the byte limit', () => {
  const mutated = DOC.replace(
    'weekend,meet up,decide,invite',
    'weekend,meet up,decide,invite,anextremelylongkeywordthatpushesitover'
  );
  const errors = validateListing(parseSubmissionDoc(mutated));
  const limitError = errors.find((e) => e.field === 'keywords' && /limit is 100 bytes.*FIX/s.test(e.message));
  assert.ok(limitError, `expected a keywords byte-limit error, got: ${JSON.stringify(errors)}`);
});

test('mutation: over-30-character app name fails naming the limit', () => {
  // ^...$ with /m tolerates CRLF line endings in the doc.
  const mutated = DOC.replace(/^> Flock\r?$/m, '> Flock The Coordination App For Nights Out');
  const errors = validateListing(parseSubmissionDoc(mutated));
  const limitError = errors.find((e) => e.field === 'name' && /limit is 30.*FIX/s.test(e.message));
  assert.ok(limitError, `expected a name over-limit error, got: ${JSON.stringify(errors)}`);
});

test('mutation: an em dash in listing copy fails, naming the copy standard', () => {
  const mutated = DOC.replace('and split the bill after. Free to use.', 'and split the bill after — free to use.');
  const errors = validateListing(parseSubmissionDoc(mutated));
  const emDashError = errors.find((e) => e.field === 'promotionalText' && /em dash.*FIX/s.test(e.message));
  assert.ok(emDashError, `expected an em-dash error, got: ${JSON.stringify(errors)}`);
});

test('mutation: copy changed without its recorded count fails as doc drift', () => {
  const mutated = DOC.replace('Plans die in the group chat.', 'Plans die in the group chat'); // one char shorter
  const errors = validateListing(parseSubmissionDoc(mutated));
  const drift = errors.find((e) => e.field === 'description' && /Doc drift.*declares.*2140.*2139.*FIX/s.test(e.message));
  assert.ok(drift, `expected a doc-drift error, got: ${JSON.stringify(errors)}`);
});

test('mutation: a removed section heading fails naming the section', () => {
  const mutated = DOC.replace('### 6.3 Keyword field', '### Keyword field');
  assert.throws(() => parseSubmissionDoc(mutated), /6\.3.*FIX/s);
});

// ---------------------------------------------------------------------------
// Screenshots: dimensions, naming, missing files, per-set cap
// ---------------------------------------------------------------------------

function fakePng(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('pngDimensions reads IHDR width/height; non-PNG fails with a fix message', () => {
  assert.deepEqual(pngDimensions(fakePng(1290, 2796)), { width: 1290, height: 2796 });
  assert.throws(() => pngDimensions(Buffer.from('definitely not a png, not even close')), /Not a PNG.*FIX/s);
});

test('display type mapping: researched identifiers APP_IPHONE_67 and APP_IPHONE_65', () => {
  assert.equal(displayTypeForDimensions(1290, 2796), 'APP_IPHONE_67');
  assert.equal(displayTypeForDimensions(1320, 2868), 'APP_IPHONE_67'); // 6.9" assets land in the 67 set
  assert.equal(displayTypeForDimensions(1284, 2778), 'APP_IPHONE_65');
  assert.equal(displayTypeForDimensions(1242, 2688), 'APP_IPHONE_65');
});

test('mutation: an unsupported pixel size fails listing the allowed sizes', () => {
  assert.throws(() => displayTypeForDimensions(1170, 2532), /matches no supported.*FIX.*1290x2796/s);
});

test('missing files are listed and never fatal (metadata-only continue)', () => {
  const listing = parseSubmissionDoc(DOC);
  const files = new Map([['01-plan-light.png', { size: 100, width: 1290, height: 2796 }]]);
  const manifest = buildScreenshotManifest(listing.screenshotPlan, files);
  assert.deepEqual(manifest.errors, []);
  assert.equal(manifest.present.length, 1);
  assert.equal(manifest.missing.length, 15);
  assert.ok(manifest.missing.includes('01-plan-dark.png'));
});

test('mutation: a planned file breaking the naming convention fails naming the convention', () => {
  const listing = parseSubmissionDoc(DOC);
  const plan = structuredClone(listing.screenshotPlan);
  plan[0].light = '1-plan-light.png'; // one digit, not two
  const manifest = buildScreenshotManifest(plan, new Map());
  assert.ok(
    manifest.errors.some((e) => /naming convention.*FIX.*NN-slug-light\.png/s.test(e)),
    `expected a naming-convention error, got: ${JSON.stringify(manifest.errors)}`
  );
});

test('a stray misnamed file on disk fails naming the convention', () => {
  const listing = parseSubmissionDoc(DOC);
  const files = new Map([['Screenshot 2026-08-14 at 9.12.01 PM.png', { size: 5, width: 1290, height: 2796 }]]);
  const manifest = buildScreenshotManifest(listing.screenshotPlan, files);
  assert.ok(manifest.errors.some((e) => /naming convention/.test(e) && /FIX/.test(e)));
});

test('per-set cap: 16 same-size files plan 10 uploads, all lights first, 6 skipped', () => {
  const listing = parseSubmissionDoc(DOC);
  const files = new Map();
  for (const slot of listing.screenshotPlan) {
    files.set(slot.light, { size: 10, width: 1290, height: 2796 });
    files.set(slot.dark, { size: 10, width: 1290, height: 2796 });
  }
  const manifest = buildScreenshotManifest(listing.screenshotPlan, files);
  const uploads = planScreenshotUploads(manifest);
  const set = uploads.APP_IPHONE_67;
  assert.equal(set.upload.length, MAX_SCREENSHOTS_PER_SET);
  assert.equal(set.skipped.length, 6);
  assert.deepEqual(set.upload.slice(0, 8).map((s) => s.mode), Array(8).fill('light'));
  assert.deepEqual(set.upload.slice(0, 8).map((s) => s.slot), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(set.upload.slice(8).map((s) => `${s.slot}-${s.mode}`), ['1-dark', '2-dark']);
});

// ---------------------------------------------------------------------------
// Plan building and idempotency
// ---------------------------------------------------------------------------

function uploadsFor(listing, count = 2) {
  const files = new Map();
  for (const slot of listing.screenshotPlan.slice(0, count)) {
    files.set(slot.light, { size: 10, width: 1290, height: 2796 });
  }
  return planScreenshotUploads(buildScreenshotManifest(listing.screenshotPlan, files));
}

const OPTIONS = { bundleId: 'com.flockcorp.flock', versionString: '1.0', locale: 'en-US' };

test('first run (empty remote): plan creates version, localization, set; no deletes', () => {
  const listing = parseSubmissionDoc(DOC);
  const remote = { appId: 'app1', versionId: null, versionLocalizationId: null, appInfoId: 'info1', appInfoLocalizationId: null, screenshotSets: {} };
  const steps = buildPlan({ listing, uploads: uploadsFor(listing), remote, options: OPTIONS });
  const kinds = steps.map((s) => s.kind);
  assert.ok(kinds.includes('create-version'));
  assert.ok(kinds.includes('create-version-localization'));
  assert.ok(kinds.includes('create-appinfo-localization'));
  assert.ok(kinds.includes('create-screenshot-set'));
  assert.ok(!kinds.includes('delete-screenshot'));
  const createLoc = steps.find((s) => s.kind === 'create-version-localization');
  assert.equal(createLoc.body.attributes.locale, 'en-US');
  assert.equal(createLoc.body.attributes.description.length, 2140);
  assert.equal(createLoc.body.attributes.supportUrl, 'https://www.flockcorp.com/support');
});

test('second run (populated remote): plan replaces, never duplicates', () => {
  const listing = parseSubmissionDoc(DOC);
  const remote = {
    appId: 'app1', versionId: 'ver1', versionLocalizationId: 'loc1',
    appInfoId: 'info1', appInfoLocalizationId: 'infoloc1',
    screenshotSets: { APP_IPHONE_67: { id: 'set1', screenshotIds: ['shotA', 'shotB'] } },
  };
  const steps = buildPlan({ listing, uploads: uploadsFor(listing), remote, options: OPTIONS });
  const kinds = steps.map((s) => s.kind);
  // Replace, not create:
  assert.ok(!kinds.includes('create-version'), 'must not create a second appStoreVersion');
  assert.ok(!kinds.includes('create-version-localization'), 'must not create a duplicate localization');
  assert.ok(!kinds.includes('create-appinfo-localization'), 'must not create a duplicate app info localization');
  assert.ok(!kinds.includes('create-screenshot-set'), 'must reuse the existing screenshot set');
  assert.ok(kinds.includes('update-version-localization'));
  assert.ok(kinds.includes('update-appinfo-localization'));
  assert.ok(kinds.includes('reuse-screenshot-set'));
  // Existing screenshots deleted before new reservations (replace semantics):
  const deletes = steps.filter((s) => s.kind === 'delete-screenshot');
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((d) => d.method === 'DELETE'));
  const firstReserve = kinds.indexOf('reserve-screenshot');
  const lastDelete = kinds.lastIndexOf('delete-screenshot');
  assert.ok(lastDelete < firstReserve, 'deletes must come before new reservations');
  // PATCH targets the known ids:
  assert.ok(steps.find((s) => s.kind === 'update-version-localization').path.endsWith('/loc1'));
  assert.ok(steps.find((s) => s.kind === 'update-appinfo-localization').path.endsWith('/infoloc1'));
});

test('mutation: an invalid display type in the upload plan fails naming valid identifiers', () => {
  const listing = parseSubmissionDoc(DOC);
  const uploads = { APP_IPHONE_69: { upload: [], skipped: [] } };
  assert.throws(
    () => buildPlan({ listing, uploads, remote: null, options: OPTIONS }),
    /not a valid iPhone screenshot display type.*FIX.*APP_IPHONE_67, APP_IPHONE_65/s
  );
});

test('plan payloads carry no key material or auth headers', () => {
  const listing = parseSubmissionDoc(DOC);
  const steps = buildPlan({ listing, uploads: uploadsFor(listing), remote: null, options: OPTIONS });
  const s = JSON.stringify(steps);
  assert.ok(!s.includes('PRIVATE KEY'));
  assert.ok(!s.includes('Authorization'));
  assert.ok(!s.includes('Bearer '));
});

test('offline plan (no credentials) marks create-vs-update steps as resolved live', () => {
  const listing = parseSubmissionDoc(DOC);
  const steps = buildPlan({ listing, uploads: uploadsFor(listing), remote: null, options: OPTIONS });
  const loc = steps.find((s) => s.kind === 'create-version-localization');
  assert.ok(loc.conditional, 'offline steps must be flagged conditional');
  assert.match(loc.note, /resolved live/);
});

// ---------------------------------------------------------------------------
// CLI smoke test: full offline dry run against the real repo
// ---------------------------------------------------------------------------

test('CLI dry run exits 0, prints the plan, missing screenshots, and the never-touches checklist', () => {
  const result = spawnSync(process.execPath, [join(HERE, 'upload.mjs'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /DRY RUN, no network writes/);
  assert.match(result.stdout, /01-plan-light\.png/); // listed as missing today
  assert.match(result.stdout, /appStoreVersionLocalizations/);
  assert.match(result.stdout, /Privacy nutrition labels: NOT pushed/);
  assert.match(result.stdout, /Age rating questionnaire: NOT pushed/);
  assert.match(result.stdout, /Submission for review: NOT triggered/);
  assert.match(result.stdout, /Dry run complete\. No network writes were made\./);
  // The dry run must never print anything token-like.
  assert.ok(!result.stdout.includes('Bearer '));
  assert.ok(!result.stdout.includes('PRIVATE KEY'));
});
