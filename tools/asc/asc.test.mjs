// tools/asc/asc.test.mjs
// Run: node --test tools/asc/
//
// Offline throughout: every App Store Connect answer comes from FakeAsc below,
// handed to main() as its fetch. Covers argument parsing, the image checks
// against Apple's sizes, the dry-run plans (which must make no write), and the
// rule that old screenshots are deleted only after every new one is COMPLETE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCEPTED_SIZES,
  EXIT,
  MAX_SHOTS_PER_SET,
  UsageError,
  checkScreenshotFiles,
  defaultConfigPath,
  fieldForFlag,
  inspectImage,
  loadConfig,
  main,
  makeRedactor,
  parseArgs,
  planScreenshotReplace,
  readScreenshotDir,
} from './asc.mjs';

// ---------------------------------------------------------------------------
// Image fixtures: real PNG and JPEG headers, no pixel data (nothing decodes it)
// ---------------------------------------------------------------------------

function chunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function fakePng(width, height, { colourType = 2, tRNS = false, label = '' } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(tRNS ? [chunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0]))] : []),
    chunk('tEXt', Buffer.from(`Comment\0${label}`, 'latin1')),
    chunk('IDAT', Buffer.from([0])),
    chunk('IEND'),
  ]);
}

function fakeJpeg(width, height, components = 3) {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = components;
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

const md5 = (buf) => checkScreenshotFiles([{ name: 'x.png', buf }], 'APP_IPHONE_67').report[0].md5;

function tempDirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-test-'));
  for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
  return dir;
}

const newShots = (n, w = 1290, h = 2796) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => {
    const name = `${String(i + 1).padStart(2, '0')}-screen-${i + 1}.png`;
    return [name, fakePng(w, h, { label: name })];
  }),
);

// ---------------------------------------------------------------------------
// A fake App Store Connect: the routes this tool calls, with Apple's rules
// that matter here (ten screenshots a set; processing takes a few checks).
// ---------------------------------------------------------------------------

const APP_ID = '6000000001';
const KEY_ID = 'TESTKEY123';
const ISSUER_ID = '11111111-2222-3333-4444-555555555555';

const response = (status, body, bytes) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
  arrayBuffer: async () => {
    const b = bytes || Buffer.alloc(0);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
});

class FakeAsc {
  constructor({
    versionState = 'PREPARE_FOR_SUBMISSION',
    locales = ['en-US'],
    oldShots = 0,
    oldSize = [1320, 2868],
    submissions = [],
    build = { id: 'build-50', version: '50', processingState: 'VALID', usesNonExemptEncryption: false },
    failPartFor = null,
    failProcessingFor = null,
    pollsToComplete = 2,
    noSetFor = [],
  } = {}) {
    this.calls = [];
    this.seq = 0;
    this.pollsToComplete = pollsToComplete;
    this.failPartFor = failPartFor;
    this.failProcessingFor = failProcessingFor;
    this.version = { id: 'ver-101', versionString: '1.0.1', state: versionState, releaseType: 'AFTER_APPROVAL', createdDate: '2026-11-04T10:00:00Z' };
    this.liveVersion = { id: 'ver-100', versionString: '1.0', state: 'READY_FOR_SALE', releaseType: 'AFTER_APPROVAL', createdDate: '2026-10-01T10:00:00Z' };
    this.locs = locales.map((locale) => ({
      id: `loc-${locale}`, locale,
      attributes: { locale, description: 'Old description.', keywords: 'plans,friends', promotionalText: 'Old promo', whatsNew: 'Old notes', supportUrl: 'https://example.com/support', marketingUrl: 'https://example.com' },
    }));
    this.sets = new Map();
    for (const l of this.locs) {
      if (noSetFor.includes(l.locale)) continue;
      const shots = Array.from({ length: oldShots }, (_, i) => ({
        id: `old-${l.locale}-${i + 1}`, fileName: `${String(i + 1).padStart(2, '0')}-old-${i + 1}.png`, checksum: `oldsum${i + 1}`,
        state: 'COMPLETE', width: oldSize[0], height: oldSize[1], templateUrl: `https://cdn.test/old-${l.locale}-${i + 1}/{w}x{h}bb.{f}`,
      }));
      this.sets.set(`set-${l.locale}`, { id: `set-${l.locale}`, locId: l.id, displayType: 'APP_IPHONE_67', shots });
    }
    this.shotIndex = new Map();
    for (const s of this.sets.values()) for (const sh of s.shots) this.shotIndex.set(sh.id, { shot: sh, set: s });
    this.submissions = submissions.map((s) => ({ items: [], ...s }));
    this.build = build;
    this.appInfos = [
      { id: 'info-live', state: 'READY_FOR_SALE', locs: [{ id: 'iloc-live', locale: 'en-US', name: 'Old Name', subtitle: 'Old subtitle' }] },
      { id: 'info-next', state: versionState, locs: [{ id: 'iloc-next', locale: 'en-US', name: 'Flock Social App', subtitle: 'Friends Together, Venues Alive' }] },
    ];
    this.fetch = this.fetch.bind(this);
  }

  writes() {
    return this.calls.filter((c) => c.method !== 'GET');
  }

  versionJson(v) {
    return { type: 'appStoreVersions', id: v.id, attributes: { versionString: v.versionString, appStoreState: v.state, appVersionState: v.state, releaseType: v.releaseType, createdDate: v.createdDate } };
  }

  shotJson(sh) {
    return {
      type: 'appScreenshots', id: sh.id,
      attributes: {
        fileName: sh.fileName, fileSize: sh.fileSize || 1000, sourceFileChecksum: sh.checksum || null,
        assetDeliveryState: { state: sh.state, errors: sh.state === 'FAILED' ? [{ code: 'IMAGE_TOOL_FAILURE', description: 'could not process' }] : [] },
        imageAsset: sh.width ? { width: sh.width, height: sh.height, templateUrl: sh.templateUrl } : null,
      },
    };
  }

  async fetch(url, init = {}) {
    const method = init.method || 'GET';
    const u = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call = { method, host: u.host, path: u.pathname, query: u.search, url: String(url), body, auth: init.headers && init.headers.Authorization };
    this.calls.push(call);
    const r = await this.route(call, u);
    call.status = r.status;
    return r;
  }

  async route(call, u) {
    const { method, path: p } = call;
    const q = u.searchParams;
    let m;
    if (u.host === 'cdn.test') {
      const id = p.split('/')[1];
      const hit = this.shotIndex.get(id);
      if (!hit) return response(404, {});
      return response(200, undefined, fakePng(hit.shot.width, hit.shot.height, { label: id }));
    }
    if (u.host === 'upload.test') {
      const id = p.split('/')[1];
      const hit = this.shotIndex.get(id);
      if (hit && this.failPartFor === hit.shot.fileName) return response(500, {});
      if (hit) hit.shot.bytesSent = true;
      return response(200, undefined);
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/apps\/([^/]+)\/appStoreVersions$/))) {
      const vs = q.get('filter[versionString]');
      const all = [this.version, this.liveVersion].filter((v) => !vs || v.versionString === vs);
      return response(200, { data: all.map((v) => this.versionJson(v)) });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/))) {
      return response(200, { data: m[1] === this.version.id ? this.locs.map((l) => ({ type: 'appStoreVersionLocalizations', id: l.id, attributes: l.attributes })) : [] });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)\/appScreenshotSets$/))) {
      const sets = [...this.sets.values()].filter((s) => s.locId === m[1]);
      return response(200, { data: sets.map((s) => ({ type: 'appScreenshotSets', id: s.id, attributes: { screenshotDisplayType: s.displayType } })) });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/appScreenshotSets\/([^/]+)\/appScreenshots$/))) {
      const set = this.sets.get(m[1]);
      return response(200, { data: set.shots.map((sh) => this.shotJson(sh)) });
    }
    if (method === 'POST' && p === '/v1/appScreenshotSets') {
      const id = `set-created-${++this.seq}`;
      this.sets.set(id, { id, locId: call.body.data.relationships.appStoreVersionLocalization.data.id, displayType: call.body.data.attributes.screenshotDisplayType, shots: [] });
      return response(201, { data: { type: 'appScreenshotSets', id } });
    }
    if (method === 'POST' && p === '/v1/appScreenshots') {
      const set = this.sets.get(call.body.data.relationships.appScreenshotSet.data.id);
      if (set.shots.length >= MAX_SHOTS_PER_SET) {
        return response(409, { errors: [{ code: 'ENTITY_ERROR', detail: `has already ${MAX_SHOTS_PER_SET} appScreenshots` }] });
      }
      const id = `new-${++this.seq}`;
      const { fileName, fileSize } = call.body.data.attributes;
      const sh = { id, fileName, fileSize, checksum: null, state: 'AWAITING_UPLOAD', polls: 0 };
      set.shots.push(sh);
      this.shotIndex.set(id, { shot: sh, set });
      return response(201, {
        data: {
          type: 'appScreenshots', id,
          attributes: { fileName, fileSize, uploadOperations: [{ method: 'PUT', url: `https://upload.test/${id}/0`, offset: 0, length: fileSize, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] }] },
        },
      });
    }
    if (method === 'PATCH' && (m = p.match(/^\/v1\/appScreenshots\/([^/]+)$/))) {
      const hit = this.shotIndex.get(m[1]);
      hit.shot.checksum = call.body.data.attributes.sourceFileChecksum;
      hit.shot.state = 'UPLOAD_COMPLETE';
      return response(200, { data: this.shotJson(hit.shot) });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/appScreenshots\/([^/]+)$/))) {
      const hit = this.shotIndex.get(m[1]);
      hit.shot.polls = (hit.shot.polls || 0) + 1;
      if (hit.shot.state === 'UPLOAD_COMPLETE' && hit.shot.polls >= this.pollsToComplete) {
        hit.shot.state = this.failProcessingFor === hit.shot.fileName ? 'FAILED' : 'COMPLETE';
      }
      call.result = hit.shot.state;
      return response(200, { data: this.shotJson(hit.shot) });
    }
    if (method === 'DELETE' && (m = p.match(/^\/v1\/appScreenshots\/([^/]+)$/))) {
      const hit = this.shotIndex.get(m[1]);
      if (!hit) return response(404, {});
      hit.set.shots = hit.set.shots.filter((s) => s.id !== m[1]);
      this.shotIndex.delete(m[1]);
      return response(204, undefined);
    }
    if (method === 'PATCH' && (m = p.match(/^\/v1\/appScreenshotSets\/([^/]+)\/relationships\/appScreenshots$/))) {
      const set = this.sets.get(m[1]);
      const ids = call.body.data.map((d) => d.id);
      set.shots = ids.map((id) => set.shots.find((s) => s.id === id));
      return response(204, undefined);
    }
    if (method === 'GET' && p === '/v1/reviewSubmissions') {
      const states = q.get('filter[state]') ? q.get('filter[state]').split(',') : null;
      const subs = this.submissions.filter((s) => !states || states.includes(s.state));
      return response(200, {
        data: subs.map((s) => ({
          type: 'reviewSubmissions', id: s.id, attributes: { state: s.state, platform: 'IOS', submittedDate: s.submittedDate || null },
          relationships: { appStoreVersionForReview: { data: s.versionId ? { type: 'appStoreVersions', id: s.versionId } : null } },
        })),
      });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/reviewSubmissions\/([^/]+)$/))) {
      const s = this.submissions.find((x) => x.id === m[1]);
      if (s.state === 'CANCELING') {
        s.state = 'COMPLETE';
        this.version.state = 'DEVELOPER_REJECTED';
      }
      return response(200, { data: { type: 'reviewSubmissions', id: s.id, attributes: { state: s.state } } });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/reviewSubmissions\/([^/]+)\/items$/))) {
      const s = this.submissions.find((x) => x.id === m[1]);
      return response(200, { data: s.items.map((vid, i) => ({ type: 'reviewSubmissionItems', id: `item-${i}`, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: vid } } } })) });
    }
    if (method === 'PATCH' && (m = p.match(/^\/v1\/reviewSubmissions\/([^/]+)$/))) {
      const s = this.submissions.find((x) => x.id === m[1]);
      const a = call.body.data.attributes;
      if (a.canceled) s.state = 'CANCELING';
      if (a.submitted) {
        s.state = 'WAITING_FOR_REVIEW';
        this.version.state = 'WAITING_FOR_REVIEW';
      }
      return response(200, { data: { type: 'reviewSubmissions', id: s.id, attributes: { state: s.state } } });
    }
    if (method === 'POST' && p === '/v1/reviewSubmissions') {
      const id = `sub-new-${++this.seq}`;
      this.submissions.push({ id, state: 'READY_FOR_REVIEW', versionId: null, items: [] });
      return response(201, { data: { type: 'reviewSubmissions', id, attributes: { state: 'READY_FOR_REVIEW' } } });
    }
    if (method === 'POST' && p === '/v1/reviewSubmissionItems') {
      const sid = call.body.data.relationships.reviewSubmission.data.id;
      const vid = call.body.data.relationships.appStoreVersion.data.id;
      const s = this.submissions.find((x) => x.id === sid);
      s.items.push(vid);
      s.versionId = vid;
      return response(201, { data: { type: 'reviewSubmissionItems', id: `item-${++this.seq}` } });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/appStoreVersions\/([^/]+)\/build$/))) {
      if (m[1] !== this.version.id || !this.build) return response(404, { errors: [{ code: 'NOT_FOUND' }] });
      return response(200, { data: { type: 'builds', id: this.build.id, attributes: this.build } });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/apps\/([^/]+)\/appInfos$/))) {
      return response(200, { data: this.appInfos.map((i) => ({ type: 'appInfos', id: i.id, attributes: { appStoreState: i.state, state: i.state } })) });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/appInfos\/([^/]+)\/appInfoLocalizations$/))) {
      const info = this.appInfos.find((i) => i.id === m[1]);
      return response(200, { data: info.locs.map((l) => ({ type: 'appInfoLocalizations', id: l.id, attributes: { locale: l.locale, name: l.name, subtitle: l.subtitle } })) });
    }
    if (method === 'PATCH' && (m = p.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)$/))) {
      const loc = this.locs.find((l) => l.id === m[1]);
      Object.assign(loc.attributes, call.body.data.attributes);
      return response(200, { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: loc.attributes } });
    }
    if (method === 'PATCH' && (m = p.match(/^\/v1\/appInfoLocalizations\/([^/]+)$/))) {
      const loc = this.appInfos.flatMap((i) => i.locs).find((l) => l.id === m[1]);
      Object.assign(loc, call.body.data.attributes);
      return response(200, { data: { type: 'appInfoLocalizations', id: loc.id } });
    }
    if (method === 'GET' && p === '/v1/builds') {
      return response(200, {
        data: [
          { type: 'builds', id: 'build-50', attributes: { version: '50', processingState: 'VALID', uploadedDate: '2026-11-05T13:05:00Z', usesNonExemptEncryption: false, expired: false }, relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'pre-101' } } } },
          { type: 'builds', id: 'build-49', attributes: { version: '49', processingState: 'VALID', uploadedDate: '2026-10-20T20:00:00Z', usesNonExemptEncryption: false, expired: false }, relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'pre-100' } } } },
        ],
        included: [
          { type: 'preReleaseVersions', id: 'pre-101', attributes: { version: '1.0.1' } },
          { type: 'preReleaseVersions', id: 'pre-100', attributes: { version: '1.0' } },
        ],
      });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/apps\/([^/]+)\/subscriptionGroups$/))) {
      // An error that echoes the app id back, as Apple's do: it must not be printed.
      if (this.failSubscriptions) return response(403, { errors: [{ code: 'FORBIDDEN_ERROR', detail: `no access to /v1/apps/${APP_ID}` }] });
      return response(200, { data: [{ type: 'subscriptionGroups', id: 'group-1' }] });
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/subscriptionGroups\/([^/]+)\/subscriptions$/))) {
      return response(200, { data: [{ type: 'subscriptions', id: 'sub-1', attributes: { productId: 'pro.monthly', state: 'READY_TO_SUBMIT' } }] });
    }
    return response(404, { errors: [{ code: 'NOT_FOUND', detail: `fake has no route for ${method} ${p}` }] });
  }
}

async function run(argv, fake, extra = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    config: { appId: APP_ID, keyId: KEY_ID, issuerId: ISSUER_ID },
    token: 'test-token',
    fetch: fake ? fake.fetch : async () => { throw new Error('no network in this test'); },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    sleep: async () => {},
    pollMs: 1,
    now: () => new Date(2026, 10, 5, 18, 30, 0),
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const isOldDelete = (c) => c.method === 'DELETE' && /\/v1\/appScreenshots\/old-/.test(c.path);
const isNewComplete = (c) => c.method === 'GET' && /\/v1\/appScreenshots\/new-/.test(c.path) && c.result === 'COMPLETE';
const lastIndex = (arr, pred) => arr.reduce((acc, x, i) => (pred(x) ? i : acc), -1);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test('parseArgs reads commands, sub-commands and both option spellings', () => {
  assert.equal(parseArgs(['status']).name, 'status');
  const r = parseArgs(['screenshots', 'replace', '--dir', 'D', '--version=1.0.1', '--dry-run', '--make-room']);
  assert.equal(r.name, 'screenshots replace');
  assert.equal(r.write, true);
  assert.deepEqual(r.opts, { dir: 'D', version: '1.0.1', 'dry-run': true, 'make-room': true });
  assert.equal(parseArgs(['builds', 'list', '--limit', '5']).opts.limit, 5);
  assert.equal(parseArgs(['screenshots', 'list']).write, false);
  assert.equal(parseArgs([]).command, 'help');
  assert.equal(parseArgs(['review', 'submit', '--help']).command, 'help');
});

test('parseArgs refuses what it cannot run, naming the problem', () => {
  const bad = [
    [['nope'], /unknown command/],
    [['screenshots'], /takes one of: list, backup, replace/],
    [['screenshots', 'replace', '--version', '1.0.1'], /needs --dir/],
    [['review', 'cancel'], /needs --version/],
    [['status', '--yes'], /does not apply/],
    [['screenshots', 'list', '--dry-run'], /does not apply/],
    [['metadata', 'get', '--bogus', 'x'], /unknown option --bogus/],
    [['review', 'cancel', '--version'], /needs a value/],
    [['review', 'cancel', '--version', '1', '--version', '2'], /given twice/],
    [['builds', 'list', '--limit', 'ten'], /whole number/],
    [['builds', 'list', '--limit', '0'], /whole number/],
    [['screenshots', 'replace', '--dir', 'D', '--version', '1', '--display-type', 'APP_IPHONE_69'], /not one this tool has/],
    [['metadata', 'set', '--version', '1.0.1'], /at least one field/],
    [['metadata', 'get', '--whats-new', 'x'], /apply only to "metadata set"/],
    [['screenshots', 'list', '--locale', 'en US'], /--locale takes/],
    [['status', 'extra'], /unexpected "extra"/],
    [['review', 'cancel', '--version', '1', '--yes=please'], /takes no value/],
  ];
  for (const [argv, re] of bad) assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && re.test(e.message), argv.join(' '));
});

test('metadata field flags: kebab, camel and -file forms all name the same field', () => {
  assert.deepEqual(fieldForFlag('whats-new'), { field: 'whatsNew', fromFile: false });
  assert.deepEqual(fieldForFlag('whatsNew'), { field: 'whatsNew', fromFile: false });
  assert.deepEqual(fieldForFlag('whats-new-file'), { field: 'whatsNew', fromFile: true });
  assert.deepEqual(fieldForFlag('promotional-text'), { field: 'promotionalText', fromFile: false });
  assert.deepEqual(fieldForFlag('support-url'), { field: 'supportUrl', fromFile: false });
  assert.equal(fieldForFlag('privacy-url'), null);
  const r = parseArgs(['metadata', 'set', '--version', '1.0.1', '--subtitle', 'Hi', '--description-file', 'd.txt']);
  assert.deepEqual(r.fields, { subtitle: { value: 'Hi' }, description: { file: 'd.txt' } });
});

test('a usage error exits 2 without a single call', async () => {
  const r = await run(['screenshots', 'replace', '--version', '1.0.1'], null);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /needs --dir/);
});

// ---------------------------------------------------------------------------
// Images and Apple's sizes
// ---------------------------------------------------------------------------

test('inspectImage reads PNG and JPEG headers, alpha included', () => {
  const rgb = inspectImage(fakePng(1290, 2796));
  assert.equal(rgb.format, 'png');
  assert.equal(rgb.width, 1290);
  assert.equal(rgb.height, 2796);
  assert.equal(rgb.alpha, false);
  assert.match(rgb.colourSpace, /untagged/);
  assert.equal(inspectImage(fakePng(10, 10, { colourType: 6 })).alpha, true);
  assert.equal(inspectImage(fakePng(10, 10, { colourType: 4 })).alpha, true);
  assert.equal(inspectImage(fakePng(10, 10, { tRNS: true })).alpha, true);
  const jpg = inspectImage(fakeJpeg(1290, 2796));
  assert.deepEqual([jpg.format, jpg.width, jpg.height, jpg.alpha], ['jpeg', 1290, 2796, false]);
  assert.deepEqual(inspectImage(fakeJpeg(10, 10, 4)).problems, ['CMYK JPEG; export it as RGB']);
  assert.deepEqual(inspectImage(Buffer.from('hello')).problems, ['not a PNG or JPEG file']);
});

test("checkScreenshotFiles holds every file to the display type's exact sizes", () => {
  const ok = checkScreenshotFiles([
    { name: '01.png', buf: fakePng(1290, 2796) },
    { name: '02.png', buf: fakePng(1320, 2868) },
    { name: '03.png', buf: fakePng(2796, 1290) },
    { name: '04.jpg', buf: fakeJpeg(1260, 2736) },
  ], 'APP_IPHONE_67');
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.report.every((r) => r.ok && r.md5.length === 32));

  const bad = checkScreenshotFiles([
    { name: '01.png', buf: fakePng(1284, 2778) },
    { name: '02.png', buf: fakePng(1290, 2796, { colourType: 6 }) },
    { name: '03.png', buf: fakePng(1290, 2795) },
    { name: '04.png', buf: Buffer.from('not an image') },
  ], 'APP_IPHONE_67');
  assert.equal(bad.problems.length, 4);
  assert.match(bad.problems[0], /01\.png: 1284x2778 is not a APP_IPHONE_67 size \(1260x2736, 2736x1260, 1290x2796/);
  assert.match(bad.problems[1], /02\.png: has an alpha channel/);
  assert.match(bad.problems[2], /03\.png: 1290x2795/);
  assert.match(bad.problems[3], /04\.png: not a PNG or JPEG/);
  // The 6.5-inch size belongs to its own type.
  assert.deepEqual(checkScreenshotFiles([{ name: '01.png', buf: fakePng(1284, 2778) }], 'APP_IPHONE_65').problems, []);
  // Old "no status bar" sizes are not transposes.
  assert.deepEqual(checkScreenshotFiles([{ name: '01.png', buf: fakePng(1136, 600) }], 'APP_IPHONE_40').problems, []);
  assert.equal(checkScreenshotFiles([{ name: '01.png', buf: fakePng(600, 1136) }], 'APP_IPHONE_40').problems.length, 1);
  assert.ok(ACCEPTED_SIZES.APP_IPHONE_67.some(([w, h]) => w === 1290 && h === 2796));
});

test('a set holds at most ten, and an empty folder is refused', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png`, buf: fakePng(1290, 2796) }));
  assert.match(checkScreenshotFiles(eleven, 'APP_IPHONE_67').problems[0], /11 images, and a set holds at most 10/);
  assert.match(checkScreenshotFiles([], 'APP_IPHONE_67').problems[0], /no numbered images/);
});

test('readScreenshotDir takes numbered images in filename order and ignores the rest', () => {
  const dir = tempDirWith({
    '10-last.png': fakePng(1290, 2796), '02-second.png': fakePng(1290, 2796), '01-first.jpg': fakeJpeg(1290, 2796),
    'contact-sheet.jpg': fakeJpeg(4000, 1000), 'notes.txt': Buffer.from('x'),
  });
  try {
    const r = readScreenshotDir(dir);
    assert.deepEqual(r.files.map((f) => f.name), ['01-first.jpg', '02-second.png', '10-last.png']);
    assert.deepEqual(r.ignored, ['contact-sheet.jpg', 'notes.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshots replace checks every file before any call or credential', async () => {
  const dir = tempDirWith({ '01-a.png': fakePng(1290, 2796), '02-b.png': fakePng(1179, 2556) });
  try {
    let called = 0;
    const r = await main(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--yes'], {
      fetch: async () => { called += 1; throw new Error('no call expected'); },
      env: {}, // no credentials at all: the local check must come first
      stdout: () => {}, stderr: () => {},
    });
    assert.equal(r, EXIT.REFUSED);
    assert.equal(called, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dry runs: the exact calls, and no write
// ---------------------------------------------------------------------------

test('replace --dry-run prints reserve, send, commit, wait, then the old deletes and the order, and writes nothing', async () => {
  const files = newShots(3);
  const dir = tempDirWith(files);
  try {
    const fake = new FakeAsc({ oldShots: 2 });
    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--dry-run'], fake);
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    assert.deepEqual(fake.writes(), []);
    const lines = r.out.split('\n');
    const at = (re) => lines.findIndex((l) => re.test(l));
    for (const name of Object.keys(files)) {
      assert.ok(r.out.includes(`POST /v1/appScreenshots {"data":{"type":"appScreenshots","attributes":{"fileName":"${name}","fileSize":${files[name].length}}`), name);
      assert.ok(r.out.includes(`"sourceFileChecksum":"${md5(files[name])}"`), name);
    }
    const lastUpload = lines.reduce((acc, l, i) => (/POST \/v1\/appScreenshots \{/.test(l) ? i : acc), -1);
    const firstDelete = at(/DELETE \/v1\/appScreenshots\/old-en-US-1/);
    assert.ok(lastUpload > 0 && firstDelete > lastUpload, 'the old deletes come after the uploads');
    assert.ok(at(/DELETE \/v1\/appScreenshots\/old-en-US-2/) > firstDelete);
    assert.ok(at(/PATCH \/v1\/appScreenshotSets\/set-en-US\/relationships\/appScreenshots/) > firstDelete);
    assert.match(r.out, /keep 0, upload 3, delete 2 old \(after every new one is COMPLETE\)/);
    assert.match(r.out, /Dry run: nothing changed\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a write without --yes prints the plan, writes nothing and exits 4', async () => {
  const dir = tempDirWith(newShots(2));
  try {
    const fake = new FakeAsc({ oldShots: 1 });
    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1'], fake);
    assert.equal(r.code, EXIT.UNCONFIRMED);
    assert.deepEqual(fake.writes(), []);
    assert.match(r.out, /add --yes to make these calls/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replace is refused while the version waits for review, and says how to take it out', async () => {
  const dir = tempDirWith(newShots(2));
  try {
    const fake = new FakeAsc({ versionState: 'WAITING_FOR_REVIEW', oldShots: 1 });
    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--yes'], fake);
    assert.equal(r.code, EXIT.REFUSED);
    assert.deepEqual(fake.writes(), []);
    assert.match(r.out, /version 1\.0\.1 is WAITING_FOR_REVIEW/);
    assert.match(r.out, /review cancel --version 1\.0\.1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a full set (ten) is refused without --make-room; with it the dry run saves every old one first', async () => {
  const dir = tempDirWith(newShots(10));
  try {
    const fake = new FakeAsc({ oldShots: 10, locales: ['en-GB', 'en-US'] });
    const refused = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--dry-run'], fake);
    assert.equal(refused.code, EXIT.REFUSED);
    assert.match(refused.out, /en-US: the APP_IPHONE_67 set holds 10 and Apple caps a set at 10/);
    assert.match(refused.out, /--make-room/);

    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--dry-run', '--make-room'], fake);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(fake.writes(), []);
    const lines = r.out.split('\n');
    const lastBackup = lastIndex(lines, (l) => /GET https:\/\/cdn\.test\//.test(l));
    const firstDelete = lines.findIndex((l) => /DELETE \/v1\/appScreenshots\//.test(l));
    const firstUpload = lines.findIndex((l) => /POST \/v1\/appScreenshots \{/.test(l));
    assert.ok(lastBackup > 0 && firstDelete > lastBackup, 'every old screenshot is saved before the first delete');
    assert.ok(firstUpload > firstDelete);
    assert.equal(lines.filter((l) => /GET https:\/\/cdn\.test\//.test(l)).length, 20);
    assert.match(r.out, /screenshots-replaced|asc-test-.*-replaced-20261105-183000/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('review cancel --dry-run names the waiting submission and the one PATCH, and writes nothing', async () => {
  const fake = new FakeAsc({
    versionState: 'WAITING_FOR_REVIEW',
    submissions: [
      { id: 'sub-old', state: 'COMPLETE', versionId: 'ver-100' },
      { id: 'sub-wait', state: 'WAITING_FOR_REVIEW', versionId: 'ver-101', submittedDate: '2026-11-05T13:30:00Z' },
    ],
  });
  const r = await run(['review', 'cancel', '--version', '1.0.1', '--dry-run'], fake);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.deepEqual(fake.writes(), []);
  assert.match(r.out, /review submission sub-wait: WAITING_FOR_REVIEW, submitted 2026-11-05T13:30/);
  assert.match(r.out, /PATCH \/v1\/reviewSubmissions\/sub-wait \{"data":\{"type":"reviewSubmissions","id":"sub-wait","attributes":\{"canceled":true\}\}\}/);
  assert.doesNotMatch(r.out, /sub-old/);
});

test('review cancel with nothing waiting is refused', async () => {
  const fake = new FakeAsc({ versionState: 'PREPARE_FOR_SUBMISSION', submissions: [{ id: 'sub-old', state: 'COMPLETE', versionId: 'ver-100' }] });
  const r = await run(['review', 'cancel', '--version', '1.0.1', '--yes'], fake);
  assert.equal(r.code, EXIT.REFUSED);
  assert.deepEqual(fake.writes(), []);
  assert.match(r.out, /nothing to cancel/);
});

test('review cancel --yes sends canceled:true and waits for the version to come back editable', async () => {
  const fake = new FakeAsc({ versionState: 'WAITING_FOR_REVIEW', submissions: [{ id: 'sub-wait', state: 'WAITING_FOR_REVIEW', versionId: 'ver-101' }] });
  const r = await run(['review', 'cancel', '--version', '1.0.1', '--yes'], fake);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.deepEqual(fake.writes().map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`), [
    'PATCH /v1/reviewSubmissions/sub-wait {"data":{"type":"reviewSubmissions","id":"sub-wait","attributes":{"canceled":true}}}',
  ]);
  assert.match(r.out, /submission COMPLETE, version DEVELOPER_REJECTED/);
});

test('review submit --dry-run plans create, add and submit, never touching the release type', async () => {
  const fake = new FakeAsc({ versionState: 'DEVELOPER_REJECTED', oldShots: 3, submissions: [{ id: 'sub-done', state: 'COMPLETE', versionId: 'ver-101' }] });
  const r = await run(['review', 'submit', '--version', '1.0.1', '--dry-run'], fake);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.deepEqual(fake.writes(), []);
  const calls = r.out.split('\n').filter((l) => /^\s+\d+\. /.test(l));
  assert.equal(calls.length, 3);
  assert.match(calls[0], /POST \/v1\/reviewSubmissions \{"data":\{"type":"reviewSubmissions","attributes":\{"platform":"IOS"\},"relationships":\{"app":\{"data":\{"type":"apps","id":"\{appId\}"\}\}\}\}\}/);
  assert.match(calls[1], /POST \/v1\/reviewSubmissionItems .*"appStoreVersion":\{"data":\{"type":"appStoreVersions","id":"ver-101"\}\}/);
  assert.match(calls[2], /PATCH \/v1\/reviewSubmissions\/\{new review submission\} .*"submitted":true/);
  assert.doesNotMatch(calls.join('\n'), /releaseType|appStoreVersions\/ver-101 /);
  assert.match(r.out, /releaseType AFTER_APPROVAL \(left as it is/);
});

test('review submit --yes reuses nothing stale, submits, and never writes the version itself', async () => {
  const fake = new FakeAsc({ versionState: 'DEVELOPER_REJECTED', oldShots: 1 });
  const r = await run(['review', 'submit', '--version', '1.0.1', '--yes'], fake);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  const writes = fake.writes().map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(writes, ['POST /v1/reviewSubmissions', 'POST /v1/reviewSubmissionItems', 'PATCH /v1/reviewSubmissions/sub-new-1']);
  assert.equal(fake.writes()[0].body.data.relationships.app.data.id, APP_ID);
  assert.match(r.out, /version 1\.0\.1: WAITING_FOR_REVIEW, releaseType AFTER_APPROVAL/);
});

test('review submit is refused while a cancellation is still in progress or screenshots are processing', async () => {
  const fake = new FakeAsc({ versionState: 'DEVELOPER_REJECTED', oldShots: 1, submissions: [{ id: 'sub-c', state: 'CANCELING', versionId: 'ver-101' }] });
  const set = fake.sets.get('set-en-US');
  set.shots[0].state = 'UPLOAD_COMPLETE';
  const r = await run(['review', 'submit', '--version', '1.0.1', '--yes'], fake);
  assert.equal(r.code, EXIT.REFUSED);
  assert.deepEqual(fake.writes(), []);
  assert.match(r.out, /sub-c is still CANCELING/);
  assert.match(r.out, /still processing/);
});

test('metadata set --dry-run patches only what changes, each field where Apple keeps it', async () => {
  const fake = new FakeAsc({ versionState: 'DEVELOPER_REJECTED' });
  const r = await run(['metadata', 'set', '--version', '1.0.1', '--whats-new', 'New notes', '--subtitle', 'Friends Together, Venues Alive', '--name', 'Flock Social', '--dry-run'], fake);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.deepEqual(fake.writes(), []);
  assert.match(r.out, /subtitle: already "Friends Together, Venues Alive", left as it is/);
  assert.match(r.out, /PATCH \/v1\/appStoreVersionLocalizations\/loc-en-US \{"data":\{"type":"appStoreVersionLocalizations","id":"loc-en-US","attributes":\{"whatsNew":"New notes"\}\}\}/);
  assert.match(r.out, /PATCH \/v1\/appInfoLocalizations\/iloc-next \{"data":\{"type":"appInfoLocalizations","id":"iloc-next","attributes":\{"name":"Flock Social"\}\}\}/);
});

test("metadata set refuses Apple's limits and non-editable states before writing", async () => {
  const fake = new FakeAsc({ versionState: 'WAITING_FOR_REVIEW' });
  const r = await run(['metadata', 'set', '--version', '1.0.1', '--subtitle', 'x'.repeat(31), '--description', 'New', '--promotional-text', 'Fine any time', '--yes'], fake);
  assert.equal(r.code, EXIT.REFUSED);
  assert.deepEqual(fake.writes(), []);
  assert.match(r.out, /subtitle is 31 characters; Apple's limit is 30/);
  assert.match(r.out, /description: version 1\.0\.1 is WAITING_FOR_REVIEW; only promotionalText can change/);
  assert.doesNotMatch(r.out, /promotionalText: version/);
  const kw = await run(['metadata', 'set', '--version', '1.0.1', '--keywords', 'é'.repeat(51), '--dry-run'], new FakeAsc({ versionState: 'DEVELOPER_REJECTED' }));
  assert.match(kw.out, /keywords is 102 bytes; Apple's limit is 100 bytes/);
});

// ---------------------------------------------------------------------------
// The ordering rule, executed: old screenshots go only after all new succeed
// ---------------------------------------------------------------------------

test('replace --yes: every old delete comes after the last new upload is COMPLETE, and the set ends in filename order', async () => {
  const files = newShots(4);
  const dir = tempDirWith(files);
  try {
    const fake = new FakeAsc({ oldShots: 3, locales: ['en-GB', 'en-US'] });
    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--yes'], fake);
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    const firstOldDelete = fake.calls.findIndex(isOldDelete);
    const lastComplete = lastIndex(fake.calls, isNewComplete);
    assert.ok(lastComplete > 0, 'uploads reached COMPLETE');
    assert.ok(firstOldDelete > lastComplete, 'no old screenshot was deleted before every new one, in every set, was COMPLETE');
    assert.equal(fake.calls.filter(isOldDelete).length, 6);
    for (const id of ['set-en-GB', 'set-en-US']) {
      assert.deepEqual(fake.sets.get(id).shots.map((s) => s.fileName), Object.keys(files));
      assert.ok(fake.sets.get(id).shots.every((s) => s.state === 'COMPLETE'));
    }
    // Each upload: reserve, send, commit with the file's MD5, then checks.
    const commit = fake.calls.find((c) => c.method === 'PATCH' && /\/v1\/appScreenshots\/new-/.test(c.path));
    assert.equal(commit.body.data.attributes.uploaded, true);
    assert.equal(commit.body.data.attributes.sourceFileChecksum, md5(files['01-screen-1.png']));
    // The token goes to the API only, never to the upload host.
    assert.ok(fake.calls.filter((c) => c.host === 'upload.test').every((c) => !c.auth));
    assert.match(r.out, /en-US 04-screen-4\.png: uploaded, COMPLETE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replace --yes: a failed upload stops the run and no old screenshot is deleted', async () => {
  const dir = tempDirWith(newShots(4));
  try {
    const fake = new FakeAsc({ oldShots: 3, failPartFor: '03-screen-3.png' });
    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--yes'], fake);
    assert.equal(r.code, EXIT.API);
    assert.equal(fake.calls.filter(isOldDelete).length, 0);
    assert.equal(fake.sets.get('set-en-US').shots.filter((s) => s.id.startsWith('old-')).length, 3);
    // Its own half-made reservation is removed; the two finished ones stay for a re-run to keep.
    assert.deepEqual(fake.sets.get('set-en-US').shots.filter((s) => s.id.startsWith('new-')).map((s) => s.fileName), ['01-screen-1.png', '02-screen-2.png']);
    assert.match(r.out, /03-screen-3\.png: FAILED: .*HTTP 500/);
    assert.match(r.out, /04-screen-4\.png: not reached/);
    assert.match(r.out, /All 3 old screenshot\(s\) due to go after the new ones are still in place/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replace --yes: Apple marking an upload FAILED also leaves every old screenshot in place', async () => {
  const dir = tempDirWith(newShots(2));
  try {
    const fake = new FakeAsc({ oldShots: 2, failProcessingFor: '02-screen-2.png' });
    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--yes'], fake);
    assert.equal(r.code, EXIT.API);
    assert.equal(fake.calls.filter(isOldDelete).length, 0);
    assert.match(r.err, /Apple marked the upload FAILED \(could not process\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a re-run after a stop keeps what finished and uploads only the rest', async () => {
  const dir = tempDirWith(newShots(4));
  try {
    const fake = new FakeAsc({ oldShots: 3, failPartFor: '03-screen-3.png' });
    assert.equal((await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--yes'], fake)).code, EXIT.API);
    fake.failPartFor = null;
    fake.calls = [];
    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--yes'], fake);
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    assert.match(r.out, /keep 2, upload 2, delete 3 old/);
    assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/appScreenshots').length, 2);
    assert.ok(fake.calls.findIndex(isOldDelete) > lastIndex(fake.calls, isNewComplete));
    assert.deepEqual(fake.sets.get('set-en-US').shots.map((s) => s.fileName), ['01-screen-1.png', '02-screen-2.png', '03-screen-3.png', '04-screen-4.png']);
    // And once done, a third run has nothing to do.
    fake.calls = [];
    const again = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--yes'], fake);
    assert.equal(again.code, EXIT.OK);
    assert.deepEqual(fake.writes(), []);
    assert.match(again.out, /already this set, in this order/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replace --make-room --yes: saves all old first, frees only what the cap forces, deletes the rest after the new ones are COMPLETE', async () => {
  const dir = tempDirWith(newShots(3));
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-backup-'));
  try {
    const fake = new FakeAsc({ oldShots: 9 });
    const r = await run(['screenshots', 'replace', '--dir', dir, '--version', '1.0.1', '--make-room', '--backup-dir', backup, '--yes'], fake);
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    const deletes = fake.calls.map((c, i) => [c, i]).filter(([c]) => isOldDelete(c));
    const lastSave = lastIndex(fake.calls, (c) => c.host === 'cdn.test');
    assert.ok(deletes[0][1] > lastSave, 'every old screenshot was saved before the first delete');
    // Room for one under the cap of ten: two old ones go early, from the end of the order.
    const firstUpload = fake.calls.findIndex((c) => c.method === 'POST' && c.path === '/v1/appScreenshots');
    const early = deletes.filter(([, i]) => i < firstUpload).map(([c]) => c.path);
    assert.deepEqual(early, ['/v1/appScreenshots/old-en-US-8', '/v1/appScreenshots/old-en-US-9']);
    const late = deletes.filter(([, i]) => i > firstUpload);
    assert.equal(late.length, 7);
    assert.ok(late[0][1] > lastIndex(fake.calls, isNewComplete));
    assert.deepEqual(fs.readdirSync(path.join(backup, 'en-US')).sort().slice(0, 2), ['01-01-old-1.png', '02-02-old-2.png']);
    assert.equal(fs.readdirSync(path.join(backup, 'en-US')).length, 9);
    assert.ok(fake.calls.filter((c) => c.host === 'cdn.test').every((c) => !c.auth), 'no token sent to the image host');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
});

test('planScreenshotReplace creates a missing set before uploading into it', () => {
  const files = checkScreenshotFiles([{ name: '01-a.png', buf: fakePng(1290, 2796) }], 'APP_IPHONE_67').report;
  const plan = planScreenshotReplace({
    version: { attributes: { versionString: '1.0.1', appStoreState: 'PREPARE_FOR_SUBMISSION' } },
    localizations: [{ locale: 'en-US', localizationId: 'loc-1', sets: [] }],
    displayType: 'APP_IPHONE_67', files, backupDir: 'b',
  });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.steps.map((s) => s.kind), ['create-set', 'upload', 'order', 'verify']);
});

// ---------------------------------------------------------------------------
// Read commands, configuration and redaction
// ---------------------------------------------------------------------------

test('status prints the four lines in the same shape as the old one-off status script', async () => {
  const fake = new FakeAsc({ versionState: 'WAITING_FOR_REVIEW', submissions: [{ id: 's1', state: 'WAITING_FOR_REVIEW', versionId: 'ver-101', submittedDate: '2026-11-05T13:30:12Z' }] });
  const r = await run(['status'], fake);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.deepEqual(r.out.split('\n'), [
    'versions: 1.0.1 WAITING_FOR_REVIEW | 1.0 READY_FOR_SALE',
    'review submissions: WAITING_FOR_REVIEW 2026-11-05T13:30',
    'builds: 50 VALID 2026-11-05 | 49 VALID 2026-10-20',
    'subscriptions: pro.monthly READY_TO_SUBMIT',
  ]);
  assert.deepEqual(fake.writes(), []);
});

test('no output line carries the app id, key id or issuer id, even an API error that echoes one', async () => {
  const fake = new FakeAsc();
  fake.failSubscriptions = true;
  const r = await run(['status'], fake);
  assert.equal(r.code, EXIT.API);
  const all = r.out + r.err;
  for (const secret of [APP_ID, KEY_ID, ISSUER_ID]) assert.ok(!all.includes(secret), secret);
  const red = makeRedactor({ appId: APP_ID, keyId: KEY_ID, issuerId: ISSUER_ID });
  assert.equal(red(`/v1/apps/${APP_ID} ${KEY_ID} ${ISSUER_ID}`), '/v1/apps/{appId} {keyId} {issuerId}');
  // Every call went to the app the config names.
  assert.ok(fake.calls.some((c) => c.path === `/v1/apps/${APP_ID}/appStoreVersions`));
});

test('screenshots list, metadata get and builds list read and never write', async () => {
  const fake = new FakeAsc({ versionState: 'WAITING_FOR_REVIEW', oldShots: 2, locales: ['en-GB', 'en-US'] });
  const list = await run(['screenshots', 'list', '--version', '1.0.1'], fake);
  assert.equal(list.code, EXIT.OK);
  assert.match(list.out, /en-GB APP_IPHONE_67: 2 screenshot\(s\)\n {3}1\. 01-old-1\.png {2}1320x2868 {2}COMPLETE/);
  const meta = await run(['metadata', 'get', '--version', '1.0.1'], fake);
  assert.equal(meta.code, EXIT.OK);
  assert.match(meta.out, /name {13}"Flock Social App" \(16\/30\) {2}\[app info\]/);
  assert.match(meta.out, /keywords {9}"plans,friends" \(13\/100 bytes\) {2}\[version\]/);
  const asJson = JSON.parse((await run(['metadata', 'get', '--version', '1.0.1', '--json'], fake)).out);
  assert.equal(asJson.fields.subtitle, 'Friends Together, Venues Alive');
  const builds = await run(['builds', 'list'], fake);
  assert.match(builds.out, /build 50 {4}1\.0\.1 {3}VALID {6}uploaded 2026-11-05 13:05Z {2}encryption no {2}attached to 1\.0\.1 WAITING_FOR_REVIEW/);
  assert.deepEqual(fake.writes(), []);
});

test('the token sent to the API is an ES256 JWT for the configured key', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-key-'));
  try {
    const keyPath = path.join(dir, 'AuthKey_TEST.p8');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const fake = new FakeAsc();
    const code = await main(['builds', 'list'], {
      env: { ASC_KEY_PATH: keyPath, ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER_ID, ASC_APP_ID: APP_ID },
      fetch: fake.fetch, stdout: () => {}, stderr: () => {}, sleep: async () => {},
    });
    assert.equal(code, EXIT.OK);
    const auth = fake.calls[0].auth;
    const [h, p] = auth.replace('Bearer ', '').split('.').slice(0, 2).map((s) => JSON.parse(Buffer.from(s, 'base64url').toString()));
    assert.deepEqual([h.alg, h.kid, h.typ], ['ES256', KEY_ID, 'JWT']);
    assert.deepEqual([p.iss, p.aud], [ISSUER_ID, 'appstoreconnect-v1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: each environment variable beats the file, and a gap names what is missing without values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-cfg-'));
  try {
    const keyPath = path.join(dir, 'k.p8');
    fs.writeFileSync(keyPath, 'PEM');
    const file = path.join(dir, 'asc-config.json');
    fs.writeFileSync(file, JSON.stringify({ keyPath, keyId: 'FILEKEY', issuerId: 'file-issuer', appId: 111 }));
    const c = loadConfig({ env: { ASC_KEY_ID: 'ENVKEY' }, configPath: file });
    assert.deepEqual([c.keyId, c.issuerId, c.appId, c.keyPem], ['ENVKEY', 'file-issuer', '111', 'PEM']);
    fs.writeFileSync(file, JSON.stringify({ keyPath, keyId: 'SECRETKEYID' }));
    assert.throws(() => loadConfig({ env: {}, configPath: file }), (e) => e instanceof UsageError
      && /missing issuerId \(ASC_ISSUER_ID\), appId \(ASC_APP_ID\)/.test(e.message) && !e.message.includes('SECRETKEYID'));
    assert.throws(() => loadConfig({ env: {}, configPath: path.join(dir, 'nope.json') }), /no config file/);
    // All four in the environment: the default file is never opened.
    const opened = [];
    const fromEnv = loadConfig({
      env: { ASC_KEY_PATH: keyPath, ASC_KEY_ID: 'K', ASC_ISSUER_ID: 'I', ASC_APP_ID: 'A' }, home: dir,
      exists: (p) => { opened.push(p); return fs.existsSync(p); },
      readFile: (p, e) => { opened.push(p); return fs.readFileSync(p, e); },
    });
    assert.equal(fromEnv.appId, 'A');
    assert.deepEqual(opened.filter((p) => p.endsWith('asc-config.json')), []);
    assert.equal(defaultConfigPath('C:\\Users\\someone'), path.join('C:\\Users\\someone', 'OneDrive', 'Documents', 'Flock', 'Apple-Review', 'asc-config.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
