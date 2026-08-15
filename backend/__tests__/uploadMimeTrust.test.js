// Run: node --test  (from backend/)
//
// UPLOAD MIME TRUST — the stored MIME on every chat/DM/story image comes from
// the payload's magic bytes, never from the sender's claim. The avatar path
// (routes/users.js detectImageFormat) set the model: type the file server-side
// from full signatures and build the data URL from that answer. The three
// user-content sites (routes/messages.js x2 routes, sockets/handlers.js x2
// events, routes/stories.js POST) all route their INSERT through ONE shared
// byte-typer, restampImageMime in sockets/handlers.js, which must agree with
// the avatar typer about what a file IS.
//
// This file PROVES the fix at each site and pins the bypasses attempted during
// the adversarial audit:
//
//   * plain spoof            — image/png claimed over JPEG bytes: normalized.
//   * whitespace starvation  — 64+ spaces (or interleaved \n / \t) in front of
//                              the base64: the WHATWG data: URL decoder strips
//                              ASCII whitespace, so the image still renders,
//                              but a fixed 64-char sniff window read only
//                              padding and kept the false claim. FIXED: the
//                              whole payload is whitespace-stripped before the
//                              head is taken. Chat paths only — the stories
//                              allowlist is whole-string and refuses
//                              whitespace outright (also pinned here).
//   * uppercase MIME         — data:IMAGE/PNG;...: rejected (case-sensitive
//                              allowlists at every site).
//   * SVG with script        — image/svg+xml is on no allowlist: rejected.
//   * text/html claim        — rejected (stored-XSS-adjacent).
//   * MIME parameter smuggle — image/png;charset=utf-8 and ;base64;x=1,:
//                              rejected (the allowlists demand ';base64,'
//                              immediately after the subtype).
//   * double-extension MIME  — image/png.html: rejected.
//
// And it pins that the accepted-format set did NOT change: an honestly
// labelled GIF still sends over chat, and is still refused by stories.
//
// No database, no network: pool.query is a scripted dispatcher that rejects
// unmodelled statements.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'upload-mime-trust-test-secret';
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

// Replaced BEFORE any router require: each is destructured at module load.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava', role: 'user' }; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const moderationMod = require('../utils/moderation');
moderationMod.moderateImage = async () => ({ allowed: true, reason: null });

const socketHandlers = require('../sockets/handlers');
const {
  restampImageMime,
  registerHandlers,
  __resetRateLimiters,
  CHAT_IMAGE_MAX_BYTES,
  IMAGE_FORMAT_MESSAGE,
} = socketHandlers;
const messagesRouter = require('../routes/messages');
const storiesRouter = require('../routes/stories');

const app = express();
app.use(express.json({ limit: CHAT_IMAGE_MAX_BYTES + 64 * 1024 }));
app.use('/api', messagesRouter);
app.use('/api/stories', storiesRouter);

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
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]);
const GIF89_BYTES = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), Buffer.alloc(24)]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(16),
]);
const WAV_BYTES = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.alloc(16),
]);
const SVG_SCRIPT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_SCRIPT = Buffer.from('<script>document.title="owned"</script>');

const asDataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
const payloadOf = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);

// The plain spoof: real JPEG bytes wearing a png label. Legal at every site
// (both formats are on every allowlist), so only the byte-typer can catch it.
const SPOOFED = asDataUrl('image/png', JPEG_BYTES);
const SPOOFED_FIXED = asDataUrl('image/jpeg', JPEG_BYTES);

// The whitespace-starvation spoof: same lie, base64 front-padded with 64
// spaces. A browser still decodes and renders the JPEG (the WHATWG data: URL
// processor strips ASCII whitespace before decoding); the old fixed-window
// sniffer read only padding and let the png claim stand.
const PADDED_PAYLOAD = ' '.repeat(64) + JPEG_BYTES.toString('base64');
const PADDED_SPOOF = `data:image/png;base64,${PADDED_PAYLOAD}`;
const PADDED_SPOOF_FIXED = `data:image/jpeg;base64,${PADDED_PAYLOAD}`;

// The claims every site must refuse regardless of payload. Each carries REAL
// PNG bytes (or live markup), so nothing here can be excused as "the payload
// was junk anyway".
const REJECT_CLAIMS = [
  ['uppercase MIME', `data:IMAGE/PNG;base64,${PNG_BYTES.toString('base64')}`],
  ['SVG with script', asDataUrl('image/svg+xml', SVG_SCRIPT)],
  ['text/html', asDataUrl('text/html', HTML_SCRIPT)],
  ['MIME parameter before base64', `data:image/png;charset=utf-8;base64,${PNG_BYTES.toString('base64')}`],
  ['parameter after base64 marker', `data:image/png;base64;x=1,${PNG_BYTES.toString('base64')}`],
  ['double-extension subtype', `data:image/png.html;base64,${PNG_BYTES.toString('base64')}`],
];

// ---------------------------------------------------------------------------
// 1. The shared byte-typer cannot be starved by whitespace
// ---------------------------------------------------------------------------

test('restampImageMime sniffs through whitespace padding — front-padded, interleaved, and en masse', () => {
  const jpegB64 = JPEG_BYTES.toString('base64');
  const variants = [
    ['64 leading spaces', ' '.repeat(64) + jpegB64],
    ['interleaved newlines', jpegB64.split('').join('\n')],
    ['200 mixed whitespace chars', ' \t\r\n'.repeat(50) + jpegB64],
  ];
  for (const [what, payload] of variants) {
    const url = `data:image/png;base64,${payload}`;
    const out = restampImageMime(url);
    assert.ok(out.startsWith('data:image/jpeg;base64,'), `${what}: claim survived — got ${out.slice(0, 40)}`);
    assert.strictEqual(payloadOf(out), payload, `${what}: the payload must be byte-for-byte untouched`);
  }
});

test('a truthful label with a line-wrapped payload is left character-for-character alone', () => {
  // Line-wrapped base64 (whitespace every 76 chars) is the legitimate shape
  // the whitespace tolerance exists for; a truthful claim must stay a no-op.
  const wrapped = PNG_BYTES.toString('base64').replace(/(.{8})/g, '$1\n');
  const url = `data:image/png;base64,${wrapped}`;
  assert.strictEqual(restampImageMime(url), url);
});

// ---------------------------------------------------------------------------
// 2. Parity with the avatar path (the model this fix copied)
// ---------------------------------------------------------------------------

test('the chat/story byte-typer and the avatar byte-typer agree, format for format', () => {
  const { detectImageFormat, DETECTED_MIME } = require('../routes/users').__testing;
  const cases = [
    [PNG_BYTES, 'png'], [JPEG_BYTES, 'jpeg'], [GIF89_BYTES, 'gif'],
    [WEBP_BYTES, 'webp'],
    [WAV_BYTES, null],                 // RIFF but not WEBP — an image to neither
    [SVG_SCRIPT, null],                // markup is not a sniffable image
    [Buffer.alloc(32), null],          // no signature at all
  ];
  for (const [buf, expected] of cases) {
    assert.strictEqual(detectImageFormat(buf), expected,
      `avatar typer on ${buf.slice(0, 6).toString('hex')}`);
    const out = restampImageMime(asDataUrl('image/x-probe', buf));
    const sniffed = /^data:([\w/+.-]+);base64,/.exec(out)[1];
    if (expected === null) {
      // A re-typer, not a second gate: unknown bytes keep the declared prefix
      // and moderateImage stays the judge of whether they are stored at all
      // (fail-closed on stories; IMAGE_MODERATION_REQUIRED in production).
      assert.strictEqual(sniffed, 'image/x-probe');
    } else {
      // Same MIME string the avatar path would mint for these bytes.
      assert.strictEqual(sniffed, DETECTED_MIME[expected],
        `restamp and avatar path disagree on ${expected}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. REST: each site stores the sniffed MIME and refuses the spoofed claims
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

const REST_SITES = [
  ['flock chat', 'POST', '/api/flocks/42/messages', scriptFlockSend, 'messages', (q) => q.params[5]],
  ['DM', 'POST', '/api/dm/2', scriptDmSend, 'direct_messages', (q) => q.params[5]],
  ['story', 'POST', '/api/stories', scriptStoryPost, 'stories', (q) => q.params[1]],
];

for (const [name, method, url, script, table, imageParam] of REST_SITES) {
  test(`${name}: image/png claimed over JPEG bytes is stored as image/jpeg`, async () => {
    script();
    const res = await call(method, url, { message_type: 'image', image_url: SPOOFED });
    assert.strictEqual(res.status, 201, res.text);
    const insert = wrote(table)[0];
    assert.ok(insert, 'the row must be stored');
    assert.strictEqual(imageParam(insert), SPOOFED_FIXED,
      'the stored MIME must come from the bytes, not from the sender');
  });

  test(`${name}: spoofable claims are refused before any row is written`, async () => {
    for (const [what, image_url] of REJECT_CLAIMS) {
      handlers = []; log = [];
      script();
      const res = await call(method, url, { message_type: 'image', image_url });
      assert.strictEqual(res.status, 400, `${name} / ${what}: ${res.status} ${res.text}`);
      assert.strictEqual(wrote(table).length, 0, `${name} / ${what}: a row was written`);
    }
  });
}

test('flock chat REST: the whitespace-starvation spoof is restamped, payload untouched', async () => {
  scriptFlockSend();
  const res = await call('POST', '/api/flocks/42/messages', { message_type: 'image', image_url: PADDED_SPOOF });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(wrote('messages')[0].params[5], PADDED_SPOOF_FIXED);
});

test('DM REST: the whitespace-starvation spoof is restamped, payload untouched', async () => {
  scriptDmSend();
  const res = await call('POST', '/api/dm/2', { message_type: 'image', image_url: PADDED_SPOOF });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(wrote('direct_messages')[0].params[5], PADDED_SPOOF_FIXED);
});

test('stories: whitespace in the payload never gets in at all (whole-string allowlist)', async () => {
  // The starvation spoof has no stories analogue to miss: the stories format
  // gate is anchored at both ends and its alphabet has no whitespace.
  scriptStoryPost();
  const res = await call('POST', '/api/stories', { image_url: PADDED_SPOOF });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(wrote('stories').length, 0);
});

// ---------------------------------------------------------------------------
// 4. The accepted-format set did not move
// ---------------------------------------------------------------------------

test('an honestly labelled GIF still sends over chat, verbatim', async () => {
  scriptFlockSend();
  const gif = asDataUrl('image/gif', GIF89_BYTES);
  const res = await call('POST', '/api/flocks/42/messages', { message_type: 'image', image_url: gif });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(wrote('messages')[0].params[5], gif);
});

test('an honestly labelled GIF is still refused by stories (its allowlist never took gif)', async () => {
  scriptStoryPost();
  const res = await call('POST', '/api/stories', { image_url: asDataUrl('image/gif', GIF89_BYTES) });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(wrote('stories').length, 0);
});

// ---------------------------------------------------------------------------
// 5. The socket transport — send_message and send_dm
// ---------------------------------------------------------------------------

function fakeSocket(id, user) {
  const socketHandlersMap = new Map();
  const emitted = [];
  const rooms = new Set();
  return {
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

test('socket send_message: plain and whitespace-padded spoofs both store the sniffed MIME', async () => {
  let socket = connectSocket();
  scriptFlockSend();
  await fire(socket, 'send_message', { flockId: 3, message_type: 'image', image_url: SPOOFED });
  assert.strictEqual(wrote('messages')[0]?.params[5], SPOOFED_FIXED,
    `plain spoof: ${socketErrors(socket).join(' | ') || 'stored under the claimed MIME'}`);

  handlers = []; log = [];
  socket = connectSocket();
  scriptFlockSend();
  await fire(socket, 'send_message', { flockId: 3, message_type: 'image', image_url: PADDED_SPOOF });
  assert.strictEqual(wrote('messages')[0]?.params[5], PADDED_SPOOF_FIXED,
    `padded spoof: ${socketErrors(socket).join(' | ') || 'stored under the claimed MIME'}`);
});

test('socket send_dm: plain and whitespace-padded spoofs both store the sniffed MIME', async () => {
  let socket = connectSocket();
  scriptDmSend();
  await fire(socket, 'send_dm', { receiverId: 2, message_type: 'image', image_url: SPOOFED });
  assert.strictEqual(wrote('direct_messages')[0]?.params[5], SPOOFED_FIXED,
    `plain spoof: ${socketErrors(socket).join(' | ') || 'stored under the claimed MIME'}`);

  handlers = []; log = [];
  socket = connectSocket();
  scriptDmSend();
  await fire(socket, 'send_dm', { receiverId: 2, message_type: 'image', image_url: PADDED_SPOOF });
  assert.strictEqual(wrote('direct_messages')[0]?.params[5], PADDED_SPOOF_FIXED,
    `padded spoof: ${socketErrors(socket).join(' | ') || 'stored under the claimed MIME'}`);
});

test('socket paths refuse every spoofable claim with the format message, nothing written', async () => {
  for (const [event, data, table] of [
    ['send_message', (u) => ({ flockId: 3, message_type: 'image', image_url: u }), 'messages'],
    ['send_dm', (u) => ({ receiverId: 2, message_type: 'image', image_url: u }), 'direct_messages'],
  ]) {
    for (const [what, image_url] of REJECT_CLAIMS) {
      handlers = []; log = [];
      // The per-user bucket deliberately outlives sockets; reset it so this
      // test can only ever fail on the format gate, never on the rate limiter.
      __resetRateLimiters();
      const socket = connectSocket();
      scriptFlockSend();
      scriptDmSend();
      await fire(socket, event, data(image_url));
      assert.strictEqual(wrote(table).length, 0, `${event} / ${what}: a row was written`);
      assert.deepStrictEqual(socketErrors(socket), [IMAGE_FORMAT_MESSAGE],
        `${event} / ${what}: expected the format refusal`);
    }
  }
});
