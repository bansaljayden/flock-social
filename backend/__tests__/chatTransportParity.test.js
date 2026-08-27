// Run: node --test  (from backend/)
//
// CHAT TRANSPORT PARITY — a chat photo has to mean the same thing on both
// transports.
//
// A flock/DM message can go out over Socket.IO (primary) or over REST (the
// fallback the client uses while the socket is down). Those two paths were
// written months apart and drifted in four separate ways, every one of which
// this file pins:
//
//   1. PAYLOAD CEILING. Socket.IO was deliberately raised to an 8MB frame to
//      carry photos; express.json() was never moved off the 1mb it shipped
//      with. base64 inflates by ~4/3, so the fallback died at roughly a 750KB
//      photo — on the weak signal that put the send on the fallback in the
//      first place. Neither number had been chosen with the other in mind and
//      neither capped the IMAGE, only the envelope around it. There is now one
//      number, CHAT_IMAGE_MAX_BYTES, enforced by the socket handler and used
//      to size the REST body limit.
//   2. DROPPED FIELD. services/socket.js sendMessage() had no image_url field
//      at all, so a captioned photo could not be sent over the socket: callers
//      had to fall back to sendImageMessage(), which hardcoded an empty
//      caption. The same photo therefore arrived with different content
//      depending on which transport was up.
//   3. WRONG REFUSAL STRING. Both socket send paths reached past
//      imageRejectionMessage() for the IMAGE_REJECTED_MESSAGE constant, so an
//      image refused for being ANIMATED was reported as having failed a SAFETY
//      check. The REST twin has always called the function.
//   4. SILENT DROPS. The socket refused an empty or over-long DM with a bare
//      `return`, while REST answers 400 with a sentence.
//
// The assertions below are about behaviour a user can feel, not about the
// shape of the code, with one deliberate exception: server.js boots on require
// (scripts/e2e-local.js depends on that), so its body-limit wiring is verified
// by extracting the real values out of the source and exercising them, rather
// than by importing a module that would run migrations and open a port.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'chat-transport-parity-secret';

const pool = require('../config/database');

// Both of these are destructured at module load by sockets/handlers.js, so
// they have to be replaced BEFORE the handlers are required.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const moderationMod = require('../utils/moderation');
// imageRejectionMessage stays REAL — the point of several tests below is which
// sentence the real function picks for a given verdict. Only the provider call
// is stubbed, and it counts itself so a test can prove a refusal happened
// BEFORE any (billed) Cloud Vision request.
const realImageRejectionMessage = moderationMod.imageRejectionMessage;
let imageVerdict = { allowed: true, reason: null };
let moderateImageCalls = 0;
moderationMod.moderateImage = async () => {
  moderateImageCalls += 1;
  return imageVerdict;
};

const {
  registerHandlers,
  __resetRateLimiters,
  CHAT_IMAGE_MAX_BYTES,
  checkInboundImage,
  EMPTY_MESSAGE,
  MESSAGE_TOO_LONG_MESSAGE,
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_FORMAT_MESSAGE,
} = require('../sockets/handlers');

// --- harness ---------------------------------------------------------------

let calls = [];
let routes = [];

function dispatch(sql, params) {
  calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, rows] of routes) {
    if (re.test(sql)) {
      return Promise.resolve({ rows: typeof rows === 'function' ? rows(params || []) : rows });
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 120)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => dispatch(sql, params),
  release: () => {},
});

test.after(() => { pool.end?.().catch(() => {}); });

function fakeSocket(id, user) {
  const handlers = new Map();
  const emitted = [];
  const rooms = new Set();
  const socket = {
    id,
    user,
    rooms,
    handshake: null, // no handshake => the session watchdog timer stays off
    on(event, handler) { handlers.set(event, handler); },
    join(room) { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    emit(event, payload) { emitted.push({ target: 'self', event, payload }); },
    to(room) {
      const op = {
        excepted: null,
        except(r) { op.excepted = [].concat(r); return op; },
        emit(event, payload) { emitted.push({ target: room, event, payload, excepted: op.excepted }); },
      };
      return op;
    },
    disconnect() { socket.disconnected = true; },
    handlers,
    emitted,
  };
  return socket;
}

function fakeIo() {
  const emitted = [];
  return {
    emitted,
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
    to(room) {
      const op = {
        excepted: null,
        except(r) { op.excepted = [].concat(r); return op; },
        emit(event, payload) { emitted.push({ room, event, payload, excepted: op.excepted }); },
      };
      return op;
    },
  };
}

function connect(user = { id: 1, name: 'Ava' }) {
  __resetRateLimiters();
  calls = [];
  routes = [];
  moderateImageCalls = 0;
  imageVerdict = { allowed: true, reason: null };
  const io = fakeIo();
  const socket = fakeSocket('s1', user);
  registerHandlers(io, socket);
  socket.emitted.length = 0; // drop the join/user-room bookkeeping
  return { io, socket };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);
const wrote = (table) => calls.filter((c) => new RegExp(`INSERT INTO ${table}`, 'i').test(c.sql));
const errors = (socket) => socket.emitted.filter((e) => e.event === 'error').map((e) => e.payload.message);

// A syntactically valid data: URL of a requested total byte length.
function dataUrl(totalBytes, mime = 'image/jpeg') {
  const prefix = `data:${mime};base64,`;
  return prefix + 'A'.repeat(Math.max(0, totalBytes - prefix.length));
}

const SMALL_IMAGE = dataUrl(2048);

// Everything the flock send path reads once it gets past validation.
function scriptFlockSend() {
  routes = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, [{ id: 10 }]],
    [/INSERT INTO messages/, (p) => [{
      id: 501, flock_id: p[0], sender_id: p[1], message_text: p[2], message_type: p[3], image_url: p[5],
    }]],
    [/SELECT name FROM flocks WHERE id = \$1/, [{ name: 'Friday' }]],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, [{ user_id: 2 }]],
    [/FROM user_blocks/, []],
  ];
}

function scriptDmSend() {
  routes = [
    [/FROM user_blocks/, []],
    [/SELECT 1 WHERE EXISTS/, [{ '?column?': 1 }]],
    [/SELECT id, name FROM users WHERE id = \$1/, [{ id: 7, name: 'Bo' }]],
    [/INSERT INTO direct_messages/, (p) => [{
      id: 88, sender_id: p[0], receiver_id: p[1], message_text: p[2], message_type: p[3], image_url: p[5],
    }]],
  ];
}

// ---------------------------------------------------------------------------
// 1. The shared ceiling
// ---------------------------------------------------------------------------

test('the chat image ceiling is a real number, above what the client can produce', () => {
  // App.js resizes every chat photo down to CHAT_IMAGE_MAX_CHARS = 700 * 1024
  // characters of data: URL before it sends, on BOTH transports. The server's
  // ceiling has to sit above that, or the client's own output is refused; it
  // also has to be finite, which for the socket it previously was not (its only
  // bound was Socket.IO's 8MB frame).
  const CLIENT_CAP = 700 * 1024;
  assert.ok(Number.isInteger(CHAT_IMAGE_MAX_BYTES), 'the ceiling must be a concrete byte count');
  assert.ok(
    CHAT_IMAGE_MAX_BYTES > CLIENT_CAP,
    `server ceiling ${CHAT_IMAGE_MAX_BYTES} must exceed the client's ${CLIENT_CAP}`
  );
  // And it must stay well under the Socket.IO frame ceiling, so an oversized
  // send is refused by the handler WITH a sentence rather than dropped by the
  // transport with nothing said at all.
  assert.ok(CHAT_IMAGE_MAX_BYTES < 8 * 1024 * 1024);
});

test('checkInboundImage: no image is not an error, it is simply no image', () => {
  assert.strictEqual(checkInboundImage(undefined), null);
  assert.strictEqual(checkInboundImage(null), null);
  assert.strictEqual(checkInboundImage(''), null);
});

test('checkInboundImage: the boundary is exact and inclusive', () => {
  assert.deepStrictEqual(checkInboundImage(dataUrl(CHAT_IMAGE_MAX_BYTES)), { ok: true });
  assert.deepStrictEqual(
    checkInboundImage(dataUrl(CHAT_IMAGE_MAX_BYTES + 1)),
    { ok: false, message: IMAGE_TOO_LARGE_MESSAGE }
  );
});

test('checkInboundImage: a remote URL is still refused, and so is a non-image data URL', () => {
  // Remote URLs were never allowed: they would let a sender track everyone who
  // opens the thread.
  for (const bad of ['https://example.com/cat.jpg', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA']) {
    assert.deepStrictEqual(checkInboundImage(bad), { ok: false, message: IMAGE_FORMAT_MESSAGE });
  }
});

test('checkInboundImage: a value that only STRINGIFIES to a data URL is refused', () => {
  // The old check was a bare regex .test(), which coerces. `['data:image/...']`
  // passed it as a string, then reached Buffer.byteLength (a TypeError, which
  // the catch turned into "message vanished") and reached pg as an array
  // literal. Same shape class routes/messages.js closes with scalarOnly().
  assert.deepStrictEqual(checkInboundImage([SMALL_IMAGE]), { ok: false, message: IMAGE_FORMAT_MESSAGE });
  assert.deepStrictEqual(
    checkInboundImage({ toString: () => SMALL_IMAGE }),
    { ok: false, message: IMAGE_FORMAT_MESSAGE }
  );
  assert.deepStrictEqual(checkInboundImage(12345), { ok: false, message: IMAGE_FORMAT_MESSAGE });
});

// ---------------------------------------------------------------------------
// 2. send_message — a photo with a caption
// ---------------------------------------------------------------------------

test('send_message stores a CAPTIONED photo: text and image together, not one or the other', async () => {
  const { socket } = connect();
  scriptFlockSend();

  await fire(socket, 'send_message', {
    flockId: 3,
    message_text: 'we made it',
    message_type: 'image',
    image_url: SMALL_IMAGE,
  });

  const inserts = wrote('messages');
  assert.strictEqual(inserts.length, 1, `expected one insert, got errors: ${errors(socket).join(' | ')}`);
  assert.strictEqual(inserts[0].params[2], 'we made it', 'the caption must survive');
  assert.strictEqual(inserts[0].params[5], SMALL_IMAGE, 'the photo must survive');
  assert.deepStrictEqual(errors(socket), []);
});

test('send_message accepts a photo whose message_type the caller forgot to set', async () => {
  const { socket } = connect();
  scriptFlockSend();

  // The old rule tested the TYPE LABEL (`!message_text && message_type !==
  // 'image'`), so an image-only send with no message_type was refused as an
  // empty message even though it plainly carried something.
  await fire(socket, 'send_message', { flockId: 3, image_url: SMALL_IMAGE });

  assert.strictEqual(wrote('messages').length, 1, `refused: ${errors(socket).join(' | ')}`);
  assert.strictEqual(wrote('messages')[0].params[5], SMALL_IMAGE);
});

test('send_message refuses a message_type of image that carries NOTHING', async () => {
  const { socket } = connect();
  scriptFlockSend();

  // The mirror image of the test above, and the reason the rule had to change
  // rather than merely loosen: this used to satisfy the old check and store an
  // empty row, which renders as a blank bubble in the thread forever.
  await fire(socket, 'send_message', { flockId: 3, message_type: 'image' });

  assert.strictEqual(wrote('messages').length, 0, 'an empty row must never be stored');
  assert.deepStrictEqual(errors(socket), [EMPTY_MESSAGE]);
  assert.strictEqual(calls.length, 0, 'it must bail before touching the database');
});

// ---------------------------------------------------------------------------
// 3. Refusal strings the user actually reads
// ---------------------------------------------------------------------------

test('an ANIMATED image is refused as animated, not as unsafe', async () => {
  const { socket } = connect();
  scriptFlockSend();
  imageVerdict = { allowed: false, reason: 'animated_image' };

  await fire(socket, 'send_message', { flockId: 3, message_type: 'image', image_url: SMALL_IMAGE });

  // Asserted against the real function's own answer rather than against a
  // copied string, so rewording utils/moderation.js cannot silently un-fix
  // this: what matters is that the handler asks the function, and that the two
  // verdicts do not produce the same sentence.
  const animated = realImageRejectionMessage({ reason: 'animated_image' });
  const unsafe = realImageRejectionMessage({ reason: 'unsafe_adult' });
  assert.notStrictEqual(animated, unsafe, 'the two refusals must not read the same');
  assert.deepStrictEqual(errors(socket), [animated]);
  assert.strictEqual(wrote('messages').length, 0);
});

test('an UNSAFE image still says unsafe', async () => {
  const { socket } = connect();
  scriptFlockSend();
  imageVerdict = { allowed: false, reason: 'unsafe_adult' };

  await fire(socket, 'send_message', { flockId: 3, message_type: 'image', image_url: SMALL_IMAGE });

  assert.deepStrictEqual(errors(socket), [realImageRejectionMessage({ reason: 'unsafe_adult' })]);
});

test('send_dm reports an animated image the same way send_message does', async () => {
  const { socket } = connect();
  scriptDmSend();
  imageVerdict = { allowed: false, reason: 'animated_image' };

  await fire(socket, 'send_dm', { receiverId: 7, message_type: 'image', image_url: SMALL_IMAGE });

  assert.deepStrictEqual(errors(socket), [realImageRejectionMessage({ reason: 'animated_image' })]);
  assert.strictEqual(wrote('direct_messages').length, 0);
});

// ---------------------------------------------------------------------------
// 4. Oversized payloads are refused before anything is spent on them
// ---------------------------------------------------------------------------

test('an oversized photo is refused without spending a Cloud Vision call', async () => {
  const { socket } = connect();
  scriptFlockSend();

  await fire(socket, 'send_message', {
    flockId: 3,
    message_type: 'image',
    image_url: dataUrl(CHAT_IMAGE_MAX_BYTES + 1),
  });

  assert.deepStrictEqual(errors(socket), [IMAGE_TOO_LARGE_MESSAGE]);
  assert.strictEqual(moderateImageCalls, 0, 'a refusal we can make for free must not be billed');
  assert.strictEqual(wrote('messages').length, 0);
  assert.strictEqual(calls.length, 0);
});

test('the DM path applies the same ceiling as the flock path', async () => {
  const { socket } = connect();
  scriptDmSend();

  await fire(socket, 'send_dm', {
    receiverId: 7,
    message_type: 'image',
    image_url: dataUrl(CHAT_IMAGE_MAX_BYTES + 1),
  });

  assert.deepStrictEqual(errors(socket), [IMAGE_TOO_LARGE_MESSAGE]);
  assert.strictEqual(moderateImageCalls, 0);
  assert.strictEqual(wrote('direct_messages').length, 0);
});

test('a photo at exactly the ceiling still sends', async () => {
  const { socket } = connect();
  scriptFlockSend();

  await fire(socket, 'send_message', {
    flockId: 3,
    message_type: 'image',
    image_url: dataUrl(CHAT_IMAGE_MAX_BYTES),
  });

  assert.deepStrictEqual(errors(socket), []);
  assert.strictEqual(wrote('messages').length, 1);
});

// ---------------------------------------------------------------------------
// 5. The DM path stopped dropping messages in silence
// ---------------------------------------------------------------------------

test('send_dm says why it refused an empty message instead of vanishing', async () => {
  const { socket } = connect();
  scriptDmSend();

  // A bare `return` here left the client on a pending bubble that declared
  // itself failed eight seconds later with nothing to explain it. POST
  // /api/dm/:userId answers 400 "Message is required" for the same input.
  await fire(socket, 'send_dm', { receiverId: 7, message_text: '   ' });

  assert.deepStrictEqual(errors(socket), [EMPTY_MESSAGE]);
  assert.strictEqual(wrote('direct_messages').length, 0);
});

test('send_dm says why it refused an over-long message, in the flock path words', async () => {
  const { socket } = connect();
  scriptDmSend();

  await fire(socket, 'send_dm', { receiverId: 7, message_text: 'x'.repeat(5001) });

  assert.deepStrictEqual(errors(socket), [MESSAGE_TOO_LONG_MESSAGE]);
  assert.strictEqual(wrote('direct_messages').length, 0);
});

test('the two send paths use the SAME sentence for the same refusal', async () => {
  const flock = connect();
  scriptFlockSend();
  await fire(flock.socket, 'send_message', { flockId: 3, message_text: 'x'.repeat(5001) });

  const dm = connect();
  scriptDmSend();
  await fire(dm.socket, 'send_dm', { receiverId: 7, message_text: 'x'.repeat(5001) });

  assert.deepStrictEqual(errors(flock.socket), errors(dm.socket));
});

test('send_dm still carries a captioned photo end to end', async () => {
  const { socket } = connect();
  scriptDmSend();

  await fire(socket, 'send_dm', {
    receiverId: 7,
    message_text: 'look',
    message_type: 'image',
    image_url: SMALL_IMAGE,
  });

  const inserts = wrote('direct_messages');
  assert.strictEqual(inserts.length, 1, `refused: ${errors(socket).join(' | ')}`);
  assert.strictEqual(inserts[0].params[2], 'look');
  assert.strictEqual(inserts[0].params[5], SMALL_IMAGE);
});

test('a non-string image_url is refused rather than reaching Postgres or throwing', async () => {
  const { socket } = connect();
  scriptFlockSend();

  await fire(socket, 'send_message', { flockId: 3, message_type: 'image', image_url: [SMALL_IMAGE] });

  assert.deepStrictEqual(errors(socket), [IMAGE_FORMAT_MESSAGE]);
  assert.strictEqual(wrote('messages').length, 0);
  assert.strictEqual(moderateImageCalls, 0);
});

// ---------------------------------------------------------------------------
// 6. server.js — the REST body limit is derived from the same number
// ---------------------------------------------------------------------------
//
// server.js calls boot() on require (scripts/e2e-local.js depends on that), so
// it cannot be imported here without running migrations and opening a port.
// The values that matter are pulled out of the source and then EXERCISED — the
// route patterns below are the real ones, run against real request paths.

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function imageBodyRouteRegexes() {
  const block = /const IMAGE_BODY_ROUTES = \[([\s\S]*?)\];/.exec(serverSrc);
  assert.ok(block, 'server.js must declare IMAGE_BODY_ROUTES');
  const found = block[1].match(/\/\^[^\n]*?\/[a-z]*(?=,|\s*$)/gm) || [];
  assert.ok(found.length >= 3, `expected the image routes to be listed, found ${found.length}`);
  // eslint-disable-next-line no-eval
  return found.map((literal) => eval(literal)); // literals from our own source
}

test('the larger body limit is applied to exactly the routes that carry an image', () => {
  const res = imageBodyRouteRegexes();
  const matches = (p) => res.some((re) => re.test(p));

  // The REST twins of send_message and send_dm, plus the story upload.
  assert.ok(matches('/api/flocks/12/messages'), 'flock chat photo');
  assert.ok(matches('/api/dm/7'), 'DM photo');
  assert.ok(matches('/api/stories'), 'story photo');
  assert.ok(matches('/api/DM/7'), 'Express routes case-insensitively; the parser must too');
  assert.ok(matches('/api/stories/'), 'a trailing slash reaches the same handler');

  // And nowhere else. A bigger buffer on an unauthenticated route is the exact
  // blast radius a global raise would have had.
  for (const p of [
    '/api/auth/login', '/api/auth/signup', '/api/waitlist', '/api/public/crowd',
    '/api/flocks', '/api/flocks/12', '/api/flocks/12/messages/9/react',
    '/api/dm', '/api/dm/7/read', '/api/stories/9', '/api/users/upload-image',
  ]) {
    assert.ok(!matches(p), `${p} must keep the default 1mb ceiling`);
  }
});

test('the default body limit was NOT raised globally', () => {
  // This used to pin the literal string `limit: '1mb'`. That made it
  // unsatisfiable the moment the default was audited downward and moved behind
  // a named constant, which is a change it should never have had a vote on.
  // The property it was actually protecting is a RELATIONSHIP, so assert that:
  // whatever the default is, it must be smaller than the image ceiling, and it
  // must not be spelled as a literal at the parser. The exact value is pinned
  // by __tests__/bodyLimitAudit.test.js, which owns that number and derives it
  // from every route's real maximum.
  assert.ok(
    /const defaultJsonParser = express\.json\(\{ limit: DEFAULT_JSON_BODY_BYTES \}\)/.test(serverSrc),
    'the default must come from the audited constant, not an inline literal'
  );
  const declared = /const DEFAULT_JSON_BODY_BYTES = (\d+) \* 1024;/.exec(serverSrc);
  assert.ok(declared, 'DEFAULT_JSON_BODY_BYTES must be declared, not inlined');
  const defaultBytes = Number(declared[1]) * 1024;
  assert.ok(
    defaultBytes < CHAT_IMAGE_MAX_BYTES,
    `the default (${defaultBytes}) must stay below the image ceiling (${CHAT_IMAGE_MAX_BYTES}); ` +
    'raising it to image size is the global raise this test exists to prevent'
  );

  // The body is buffered before any rate limiter runs, so there must be exactly
  // one place where the IMAGE limit is handed out. Other scoped parsers may
  // exist (Birdie and the payment webhook both have one, both far below the
  // image ceiling); what must never happen is a second route being handed the
  // image-sized buffer.
  const bigParsers = serverSrc.match(/express\.json\(\{ limit: [^}]*CHAT_IMAGE_MAX_BYTES/g) || [];
  assert.strictEqual(bigParsers.length, 1);
});

test('the image body limit fits the largest message a client can legally send', () => {
  const envelope = /const JSON_BODY_ENVELOPE_BYTES = (\d+) \* 1024;/.exec(serverSrc);
  assert.ok(envelope, 'the envelope must be declared, not inlined');
  const limit = CHAT_IMAGE_MAX_BYTES + Number(envelope[1]) * 1024;

  // Worst legal body: an image at the ceiling, 5000 characters of message text
  // where every one costs 6 bytes as a JSON \uXXXX escape, a sanitized venue
  // card (its photo URL alone is clamped to 1024 characters), and the keys.
  const worstCase = CHAT_IMAGE_MAX_BYTES + 5000 * 6 + 4096 + 256;
  assert.ok(
    limit > worstCase,
    `body limit ${limit} must exceed the worst legal body ${worstCase}`
  );
});

test('a body-parser refusal is reported as a client error, not as a server fault', () => {
  // body-parser raises `entity.too.large` with status 413. The global handler
  // ignored both fields and answered 500 "Internal server error" to everything,
  // so an oversized photo told the user the server had broken — on a screen
  // that now shows these strings as a toast.
  assert.ok(/err\.type === 'entity\.too\.large'/.test(serverSrc));
  assert.ok(/res\.status\(413\)/.test(serverSrc));
  assert.ok(/BODY_PARSER_CLIENT_ERRORS/.test(serverSrc), 'the other parse failures are 4xx too');
  assert.ok(/if \(res\.headersSent\) return next\(err\)/.test(serverSrc),
    'writing a second response is a crash on a request that may have succeeded');
});

// ---------------------------------------------------------------------------
// 7. frontend/src/services/socket.js — the emitted payload
// ---------------------------------------------------------------------------
//
// The client module is ESM and imports two things. Rather than assert on its
// text, it is loaded here with those imports stubbed and the emitted frames
// captured, so the assertions are about what actually goes on the wire.

function loadClientSocketModule() {
  const file = path.join(__dirname, '..', '..', 'frontend', 'src', 'services', 'socket.js');
  const src = fs.readFileSync(file, 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']*';\s*$/gm, '')
    .replace(/^export /gm, '');

  const emitted = [];
  const instance = {
    connected: true,
    on() {}, off() {}, emit(event, payload) { emitted.push({ event, payload }); },
    removeAllListeners() {}, disconnect() { instance.connected = false; }, connect() {},
    active: true,
  };
  const exportsObj = {};
  const factory = new Function(
    'io', 'getToken', 'BASE_URL', 'exports', 'window', 'document',
    `${src}\nObject.assign(exports, { connectSocket, sendMessage, sendImageMessage, socketSendDm, onSocketError });`
  );
  factory(() => instance, () => 'token', 'http://localhost', exportsObj, undefined, undefined);
  exportsObj.connectSocket();
  return { api: exportsObj, emitted, instance };
}

// The exact key set api.js's sendMessage() puts in the REST body. If the two
// transports stop agreeing on the fields a message carries, one of them is
// dropping something the other keeps — which is finding 2 in its general form.
const MESSAGE_FIELDS = ['message_text', 'message_type', 'venue_data', 'image_url', 'thumb_url'];

test('client sendMessage carries image_url — a captioned photo survives the socket', () => {
  const { api, emitted } = loadClientSocketModule();

  api.sendMessage(4, 'we made it', { message_type: 'image', image_url: SMALL_IMAGE });

  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].event, 'send_message');
  const body = emitted[0].payload;
  assert.strictEqual(body.image_url, SMALL_IMAGE, 'image_url was missing from this emitter entirely');
  assert.strictEqual(body.message_text, 'we made it', 'the caption must not be dropped');
  for (const field of MESSAGE_FIELDS) {
    assert.ok(field in body, `${field} must be sent on both transports, missing: ${field}`);
  }
});

test('client sendImageMessage is now a spelling of sendMessage, and keeps a caption', () => {
  const { api, emitted } = loadClientSocketModule();

  api.sendImageMessage(4, SMALL_IMAGE, { message_text: 'look' });

  assert.strictEqual(emitted.length, 1);
  assert.deepStrictEqual(
    { ...emitted[0].payload, flockId: undefined },
    {
      flockId: undefined,
      message_text: 'look',
      message_type: 'image',
      venue_data: null,
      image_url: SMALL_IMAGE,
      // The chat-photo thumbnail (2026-08-27) rides both transports; null
      // here because this caller derived none.
      thumb_url: null,
    }
  );
});

test('client sendMessage normalises a missing caption to an empty string, never null', () => {
  const { api, emitted } = loadClientSocketModule();
  // message_text is NOT NULL on both tables; api.js already sends `text || ''`.
  api.sendImageMessage(4, SMALL_IMAGE);
  assert.strictEqual(emitted[0].payload.message_text, '');
});

test('client DM send carries every field its REST twin does', () => {
  const { api, emitted } = loadClientSocketModule();

  api.socketSendDm(7, 'look', { message_type: 'image', image_url: SMALL_IMAGE, reply_to_id: 3 });

  const body = emitted[0].payload;
  for (const field of [...MESSAGE_FIELDS, 'reply_to_id']) {
    assert.ok(field in body, `missing ${field}`);
  }
  assert.strictEqual(body.image_url, SMALL_IMAGE);
  assert.strictEqual(body.reply_to_id, 3);
});

test('a send made while the socket is down reports that it did not happen', () => {
  const { api, emitted, instance } = loadClientSocketModule();
  instance.connected = false;

  assert.strictEqual(api.sendMessage(4, 'hi'), false);
  assert.strictEqual(api.sendImageMessage(4, SMALL_IMAGE), false);
  assert.strictEqual(api.socketSendDm(7, 'hi'), false);
  assert.strictEqual(emitted.length, 0, 'nothing may be emitted on a dead socket');
});

test('the server error channel is subscribable through the registry', () => {
  // Every refusal in sockets/handlers.js arrives on the generic 'error' event.
  // Bound directly to a socket instance it is lost the moment that instance is
  // replaced; through the registry it survives a rebuild.
  const { api } = loadClientSocketModule();
  const seen = [];
  const off = api.onSocketError((d) => seen.push(d));
  assert.strictEqual(typeof off, 'function', 'it must return an unsubscribe like every other onX');
  off();
});
