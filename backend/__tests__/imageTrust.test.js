// Run: node --test  (from backend/)
//
// IMAGE TRUST — two findings from the 2026-08-14 security sweep, pinned.
//
//   1. THE STORED MIME IS THE SNIFFED ONE. A chat/story image arrives as a
//      data: URL whose MIME prefix the CLIENT wrote. The byte-level frame gate
//      in utils/moderation.js is what actually protects users (the declared
//      type gates nothing — browsers sniff), but the declared string used to be
//      stored verbatim in messages.image_url / direct_messages.image_url /
//      stories.image_url even when the payload's magic bytes contradict it.
//      Only the avatar path re-typed from the bytes. All four chat/story write
//      paths (flock REST, DM REST, socket send_message, socket send_dm) plus
//      stories now restamp the prefix from the sniffed format via ONE shared
//      byte-typer, restampImageMime in sockets/handlers.js — which must agree
//      with the repo's other two byte-typers (routes/users.js
//      detectImageFormat and utils/moderation.js inspectImageFrames) about
//      what a file IS, or the truncated-signature seam users.js round 19
//      closed reopens between files.
//
//      What it must NOT do: become a second gate. Accept/reject behaviour is
//      pinned by __tests__/chatTransportParity.test.js and
//      __tests__/imageRouteParity.test.js, several of whose happy paths send
//      payloads that decode to no recognisable image at all (with the
//      moderation screen stubbed open). Unrecognised bytes therefore keep
//      their declared prefix and moderateImage stays the sole judge of whether
//      they are stored.
//
//   2. venue_profiles.photo_url ONLY HOLDS WHAT THE APP MINTS. The old rule
//      accepted any https URL on the strength of a comment about an upload
//      endpoint (/uploads/...) that was removed in routes/users.js round 12.
//      The honest contract is the one venue cards and DM pins already live
//      under: utils/venuePayload.safeVenuePhotoUrl, i.e. our own Places photo
//      proxy path and nothing else, with absolute spellings re-anchored to the
//      relative form at the write.
//
// No database, no network: pool.query is a scripted dispatcher that REJECTS
// unmodelled statements, and moderateImage is wrapped so tests can open the
// screen and count billed calls.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'image-trust-test-secret';
process.env.VISION_API_KEY = '';
process.env.GOOGLE_VISION_API_KEY = '';
process.env.IMAGE_MODERATION_REQUIRED = 'false';

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 140)}`));
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

// All replaced BEFORE any router/handler require: every one of these is
// destructured at module load by at least one file under test.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava', role: 'user' }; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const moderationMod = require('../utils/moderation');
let moderateImageCalls = [];
moderationMod.moderateImage = async (url) => {
  moderateImageCalls.push(url);
  return { allowed: true, reason: null };
};

const socketHandlers = require('../sockets/handlers');
const { restampImageMime, registerHandlers, __resetRateLimiters, CHAT_IMAGE_MAX_BYTES } = socketHandlers;
const messagesRouter = require('../routes/messages');
const storiesRouter = require('../routes/stories');
const venueProfileRouter = require('../routes/venueProfile');

const app = express();
app.use(express.json({ limit: CHAT_IMAGE_MAX_BYTES + 64 * 1024 }));
app.use('/api', messagesRouter);
app.use('/api/stories', storiesRouter);
app.use('/api/venue-profile', venueProfileRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  moderateImageCalls = [];
  __resetRateLimiters();
});

function on(re, fn) { handlers.push([re, fn]); }

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const wrote = (table) => log.filter((q) => new RegExp(`INSERT INTO ${table}`, 'i').test(q.sql));

// --- byte fixtures ----------------------------------------------------------
// Full magic numbers, padded so every parser has room to walk.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]);
const GIF87_BYTES = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), Buffer.alloc(24)]);
const GIF89_BYTES = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), Buffer.alloc(24)]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(16),
]);
// RIFF that is NOT an image: WAV opens with the same four bytes.
const WAV_BYTES = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.alloc(16),
]);
// Decodes to all zero bytes — no signature matches.
const JUNK_PAYLOAD = 'A'.repeat(64);

const asDataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
const payloadOf = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);

// ---------------------------------------------------------------------------
// 1a. The shared byte-typer itself
// ---------------------------------------------------------------------------

const RETYPE_CASES = [
  ['PNG bytes declared as jpeg', asDataUrl('image/jpeg', PNG_BYTES), 'image/png'],
  ['JPEG bytes declared as png', asDataUrl('image/png', JPEG_BYTES), 'image/jpeg'],
  ['GIF (87a) bytes declared as png', asDataUrl('image/png', GIF87_BYTES), 'image/gif'],
  ['GIF (89a) bytes declared as webp', asDataUrl('image/webp', GIF89_BYTES), 'image/gif'],
  ['WebP bytes declared as jpeg', asDataUrl('image/jpeg', WEBP_BYTES), 'image/webp'],
];

test('restampImageMime rewrites the declared MIME from the sniffed bytes', () => {
  for (const [what, url, expectedMime] of RETYPE_CASES) {
    const out = restampImageMime(url);
    assert.ok(out.startsWith(`data:${expectedMime};base64,`), `${what}: got ${out.slice(0, 40)}`);
    assert.strictEqual(payloadOf(out), payloadOf(url), `${what}: the payload must be byte-for-byte untouched`);
  }
});

test('a declared MIME the bytes agree with is a no-op, character for character', () => {
  for (const [mime, buf] of [
    ['image/png', PNG_BYTES], ['image/jpeg', JPEG_BYTES],
    ['image/gif', GIF89_BYTES], ['image/webp', WEBP_BYTES],
  ]) {
    const url = asDataUrl(mime, buf);
    assert.strictEqual(restampImageMime(url), url);
  }
});

test('unrecognised bytes keep the declared prefix — this is a re-typer, not a second gate', () => {
  // The parity suites' happy paths depend on exactly this: a payload of junk
  // base64 with the moderation screen stubbed open must be stored verbatim.
  for (const url of [
    `data:image/png;base64,${JUNK_PAYLOAD}`,
    asDataUrl('image/webp', WAV_BYTES),        // RIFF but not WEBP: not typed as an image
    'data:image/png;base64,',                  // empty payload — moderateImage's problem
  ]) {
    assert.strictEqual(restampImageMime(url), url, url.slice(0, 40));
  }
  // Values that are not data: URL strings pass through untouched too; every
  // caller's format gate runs first, so these never reach a column from here.
  assert.strictEqual(restampImageMime(null), null);
  assert.strictEqual(restampImageMime(undefined), undefined);
  assert.strictEqual(restampImageMime(''), '');
  assert.strictEqual(restampImageMime('no-comma-here'), 'no-comma-here');
});

test('the three byte-typers in this repo agree about what a file is', () => {
  // restampImageMime (sockets/handlers.js), detectImageFormat (routes/users.js,
  // the avatar path) and inspectImageFrames (utils/moderation.js, the frame
  // gate). Two of these disagreeing about the same bytes is a moderation bypass
  // waiting for someone to find the seam — the exact bug users.js round 19
  // fixed by adopting full signatures.
  const { detectImageFormat } = require('../routes/users').__testing;
  const { inspectImageFrames } = require('../utils/moderation').__test;

  // The last two are the round-19 seam fixtures themselves: a 4-byte PNG
  // prefix with a wrong continuation, and the `GIF8Xa` version that does not
  // exist. TRUNCATED signatures type both; full signatures refuse both. A
  // typer that says "png"/"gif" here disagrees with the frame gate about what
  // the file is — the exact divergence this test exists to keep closed.
  const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(16)]);
  const FAKE_GIF = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x58, 0x61]), Buffer.alloc(16)]);
  const cases = [
    [PNG_BYTES, 'png'], [JPEG_BYTES, 'jpeg'], [GIF87_BYTES, 'gif'],
    [GIF89_BYTES, 'gif'], [WEBP_BYTES, 'webp'], [WAV_BYTES, null],
    [FAKE_PNG, null], [FAKE_GIF, null],
  ];
  for (const [buf, expected] of cases) {
    assert.strictEqual(detectImageFormat(buf), expected, `avatar typer on ${buf.slice(0, 6).toString('hex')}`);
    const inspected = inspectImageFrames(buf).format;
    if (expected === null) {
      assert.strictEqual(inspected, 'unknown', 'the frame gate must not type what the others refuse to');
    } else {
      assert.strictEqual(inspected, expected, `frame gate on ${buf.slice(0, 6).toString('hex')}`);
    }
    // And the restamp lands on the same answer, read through the prefix it writes.
    const out = restampImageMime(asDataUrl('image/x-probe', buf));
    const sniffed = /^data:image\/([a-z-]+);base64,/.exec(out)[1];
    assert.strictEqual(sniffed, expected === null ? 'x-probe' : expected);
  }
});

// ---------------------------------------------------------------------------
// 1b. Every write path stores the restamped value
// ---------------------------------------------------------------------------

function scriptFlockSend() {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => ({ rows: [{ id: 1 }] }));
  on(/INSERT INTO messages/, (p) => ({ rows: [{ id: 5, flock_id: 42, sender_id: 1, image_url: p[5] }] }));
  on(/SELECT name FROM flocks WHERE id = \$1/, () => ({ rows: [{ name: 'Friday' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, () => ({ rows: [] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
}
function scriptDmSend() {
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT 1 WHERE EXISTS/, () => ({ rows: [{ '?column?': 1 }] }));
  on(/SELECT id, name FROM users WHERE id = \$1/, () => ({ rows: [{ id: 2, name: 'Bo' }] }));
  on(/INSERT INTO direct_messages/, (p) => ({ rows: [{ id: 9, sender_id: 1, receiver_id: 2, image_url: p[5] }] }));
}
function scriptStoryPost() {
  on(/COUNT\(\*\) FILTER \(WHERE created_at/, () => ({ rows: [{ last_hour: 0, active: 0 }] }));
  on(/INSERT INTO stories/, () => ({ rows: [{ id: 77, user_id: 1 }] }));
}

// PNG bytes wearing a jpeg label: passes every declared-format allowlist
// (jpeg is legal everywhere) and must be stored as what it IS.
const MISLABELLED = asDataUrl('image/jpeg', PNG_BYTES);
const MISLABELLED_FIXED = asDataUrl('image/png', PNG_BYTES);

const REST_PATHS = [
  ['flock message', 'POST', '/api/flocks/42/messages', scriptFlockSend, 'messages', (q) => q.params[5]],
  ['direct message', 'POST', '/api/dm/2', scriptDmSend, 'direct_messages', (q) => q.params[5]],
  ['story', 'POST', '/api/stories', scriptStoryPost, 'stories', (q) => q.params[1]],
];

for (const [name, method, url, script, table, imageParam] of REST_PATHS) {
  test(`${name}: a mislabelled image is STORED under its sniffed MIME`, async () => {
    script();
    const res = await call(method, url, { message_type: 'image', image_url: MISLABELLED });
    assert.strictEqual(res.status, 201, res.text);
    const insert = wrote(table)[0];
    assert.ok(insert, 'the row must be stored');
    assert.strictEqual(imageParam(insert), MISLABELLED_FIXED,
      'the stored MIME must come from the bytes, not from the sender');
    assert.strictEqual(moderateImageCalls.length, 1, 'still exactly one billed screen');
  });

  test(`${name}: an honestly-labelled image is stored verbatim`, async () => {
    script();
    const honest = asDataUrl('image/png', PNG_BYTES);
    const res = await call(method, url, { message_type: 'image', image_url: honest });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(imageParam(wrote(table)[0]), honest);
  });
}

test('chat routes: unsniffable payloads are stored exactly as sent (parity contract)', async () => {
  // __tests__/chatTransportParity.test.js and imageRouteParity.test.js pin
  // this same property through their own fixtures; restated here so a future
  // "refuse what we cannot sniff" edit fails THIS file with the reason spelled
  // out rather than a parity test with a confusing diff.
  scriptFlockSend();
  const junk = `data:image/jpeg;base64,${JUNK_PAYLOAD}`;
  const res = await call('POST', '/api/flocks/42/messages', { message_type: 'image', image_url: junk });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(wrote('messages')[0].params[5], junk);
});

// --- the two socket paths ---------------------------------------------------

function fakeSocket(id, user) {
  const socketHandlersMap = new Map();
  const emitted = [];
  const rooms = new Set();
  const socket = {
    id, user, rooms,
    handshake: null,
    on(event, handler) { socketHandlersMap.set(event, handler); },
    join(room) { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    emit(event, payload) { emitted.push({ event, payload }); },
    to() { return { except() { return this; }, emit() {} }; },
    disconnect() {},
    handlers: socketHandlersMap,
    emitted,
  };
  return socket;
}
const fakeIo = () => ({ sockets: { sockets: new Map() }, to: () => ({ except() { return this; }, emit() {} }) });

function connectSocket() {
  const io = fakeIo();
  const socket = fakeSocket('s1', { id: 1, name: 'Ava' });
  registerHandlers(io, socket);
  socket.emitted.length = 0;
  return socket;
}
const fire = (socket, event, data) => socket.handlers.get(event)(data);
const socketErrors = (socket) => socket.emitted.filter((e) => e.event === 'error').map((e) => e.payload.message);

test('socket send_message stores the sniffed MIME too — the primary transport must match its fallback', async () => {
  const socket = connectSocket();
  scriptFlockSend();
  await fire(socket, 'send_message', { flockId: 3, message_type: 'image', image_url: MISLABELLED });
  const inserts = wrote('messages');
  assert.strictEqual(inserts.length, 1, `refused: ${socketErrors(socket).join(' | ')}`);
  assert.strictEqual(inserts[0].params[5], MISLABELLED_FIXED);
});

test('socket send_dm stores the sniffed MIME too', async () => {
  const socket = connectSocket();
  scriptDmSend();
  await fire(socket, 'send_dm', { receiverId: 2, message_type: 'image', image_url: MISLABELLED });
  const inserts = wrote('direct_messages');
  assert.strictEqual(inserts.length, 1, `refused: ${socketErrors(socket).join(' | ')}`);
  assert.strictEqual(inserts[0].params[5], MISLABELLED_FIXED);
});

test('socket paths leave an unsniffable payload exactly as sent', async () => {
  const socket = connectSocket();
  scriptFlockSend();
  const junk = `data:image/png;base64,${JUNK_PAYLOAD}`;
  await fire(socket, 'send_message', { flockId: 3, message_type: 'image', image_url: junk });
  assert.strictEqual(wrote('messages')[0].params[5], junk);
});

// ---------------------------------------------------------------------------
// 2. venue_profiles.photo_url — only what the app mints
// ---------------------------------------------------------------------------

const scriptVenueUpdate = () => on(/UPDATE venue_profiles SET/i, (p) => ({ rows: [{ user_id: p[p.length - 1] }] }));
const venueUpdates = () => log.filter((q) => /UPDATE venue_profiles SET/i.test(q.sql));
const PHOTO_PARAM = 9; // $10 in the UPDATE

test('the photo proxy path is accepted and stored as-is', async () => {
  scriptVenueUpdate();
  const res = await call('PUT', '/api/venue-profile', { photoUrl: '/api/venues/photo?ref=abc123&maxwidth=400' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(venueUpdates()[0].params[PHOTO_PARAM], '/api/venues/photo?ref=abc123&maxwidth=400');
});

test('an absolute spelling of our own proxy is re-anchored to the relative path', async () => {
  // Same normalization the DM-pin and venue-card paths apply: what the sender
  // wrote as a host is discarded, so the stored value can only ever resolve
  // against our own origin.
  scriptVenueUpdate();
  const res = await call('PUT', '/api/venue-profile', {
    photoUrl: 'https://api.flockcorp.com/api/venues/photo?ref=abc123',
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(venueUpdates()[0].params[PHOTO_PARAM], '/api/venues/photo?ref=abc123');
});

test('everything the app does not mint is a 400 that never reaches the database', async () => {
  for (const photoUrl of [
    'https://evil.example.com/logo.png',       // the finding: any https host was accepted
    'https://example.com/api/venues/photo',    // proxy-shaped but no query — not a value we mint
    '/uploads/logo.png',                       // the writer this rule used to trust; removed round 12
    '/etc/passwd',
    `data:image/png;base64,${'A'.repeat(40)}`, // unmoderatable through this route
    'javascript:alert(1)',
    '//evil.example.com/logo.png',
  ]) {
    handlers = []; log = [];
    scriptVenueUpdate();
    const res = await call('PUT', '/api/venue-profile', { photoUrl });
    assert.strictEqual(res.status, 400, `${photoUrl} -> ${res.status} ${res.text}`);
    assert.ok(/photo url/i.test(res.body.error), `the refusal must name the field: ${res.body.error}`);
    assert.strictEqual(log.length, 0, `${photoUrl} still reached the database`);
  }
});

test("an empty photoUrl still means 'leave it alone', not 'clear it'", async () => {
  scriptVenueUpdate();
  const res = await call('PUT', '/api/venue-profile', { businessName: 'Bar', photoUrl: '' });
  assert.strictEqual(res.status, 200, res.text);
  // NULL into the COALESCE keeps whatever the row holds — the pre-audit
  // round-trip behaviour clients depend on.
  assert.strictEqual(venueUpdates()[0].params[PHOTO_PARAM], null);
});

test('the rule is the shared helper, not a second copy of it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueProfile.js'), 'utf8');
  assert.match(src, /require\('\.\.\/utils\/venuePayload'\)/,
    'the photo allowlist must come from utils/venuePayload.safeVenuePhotoUrl');
  assert.ok(!/https:\\\/\\\//.test(src) && !/\^https:/.test(src),
    'no resident https allowlist may survive in this file');
});
