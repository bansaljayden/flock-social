// Run: node --test  (from backend/)
//
// Image handling on the two message routes and the story route, checked against
// the transports and the gate they are supposed to agree with.
//
// What this file pins:
//
//   1. SIZE PARITY. sockets/handlers.js enforces CHAT_IMAGE_MAX_BYTES on the
//      data: URL itself. The REST twins put no cap on image_url at all: the only
//      ceiling in front of them was the JSON body limit, which is
//      CHAT_IMAGE_MAX_BYTES + a 64KB envelope and caps the WHOLE BODY. So a
//      request carrying nothing but an image was accepted up to ~1.09MB over
//      REST and refused past 1,048,576 over the socket — the fallback transport
//      admitting a photo the primary would not, into a column they share. Both
//      routes now enforce the imported constant, at the same inclusive boundary,
//      with the same sentence.
//
//   2. FREE REFUSALS COME FIRST. moderateImage() is a BILLED Cloud Vision call.
//      A refusal we can make from a byte count must never be made after paying
//      for one, on either route, on either transport.
//
//   3. THE REJECTION MESSAGE MATCHES THE REASON. An animated image is refused by
//      POLICY (SafeSearch only ever sees frame 1), not because it looked unsafe.
//      routes/stories.js reached past imageRejectionMessage() for the generic
//      constant, so an animated PNG story was refused with "We couldn't verify
//      that image is safe to share" — wrong, and unactionable: there is nothing
//      you can do to a sunset GIF to make it verify.
//
//   4. THE ANIMATION GATE IS REAL, AND STORIES GOES THROUGH IT. The format regex
//      in routes/stories.js is a format allowlist and closes nothing about
//      frames: an APNG is `image/png` and an animated WebP is `image/webp`.
//      These tests post REAL animated bytes through the REAL moderateImage and
//      require a refusal, so the claim rests on utils/moderation.js's byte-level
//      inspection rather than on a MIME string.
//
//   5. THE NUMBER THE USER IS TOLD IS THE NUMBER ENFORCED. The story size
//      refusal said "under about 500 KB" while enforcing 700 KB.
//
// No database and no network: pool.query is a scripted dispatcher that REJECTS
// an unmodelled statement (a fixture that answers everything with zero rows is
// how an authorization test passes for the wrong reason), and no image
// moderation provider is configured, so the one external call this path can make
// cannot be made.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'image-route-parity-test-secret';
// Before anything reads them at module load. No provider means moderateImage
// cannot reach Google — but the animation gate runs BEFORE the provider check,
// which is exactly the property tests 4 below depend on.
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

// Auth is replaced BEFORE the routers are required: both routers destructure
// `authenticate` at module load, so a later replacement would never be seen.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// Same timing problem, same fix: routes/messages.js destructures moderateImage,
// routes/stories.js calls it through the module object. One wrapper installed
// before both requires is visible to both, and delegates to the REAL
// implementation unless a test says otherwise — so "did this cost a billed
// call?" and "does the real byte-level gate fire?" are both answerable here.
const moderationMod = require('../utils/moderation');
const realModerateImage = moderationMod.moderateImage;
let moderateImageCalls = [];
let moderateImageImpl = null;
moderationMod.moderateImage = async (url) => {
  moderateImageCalls.push(url);
  return moderateImageImpl ? moderateImageImpl(url) : realModerateImage(url);
};

const {
  CHAT_IMAGE_MAX_BYTES,
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_FORMAT_MESSAGE,
  checkInboundImage,
} = require('../sockets/handlers');
const {
  IMAGE_REJECTED_MESSAGE,
  ANIMATED_IMAGE_REJECTED_MESSAGE,
} = require('../utils/moderation');

const messagesRouter = require('../routes/messages');
const storiesRouter = require('../routes/stories');
const S = storiesRouter.__test;

const app = express();
// Mirrors server.js's imageJsonParser exactly. The point of these tests is what
// the ROUTE does, so the parser must never be the thing that refuses: a payload
// at CHAT_IMAGE_MAX_BYTES + 1 has to reach the handler and come back as our
// sentence, not as a bare 413.
app.use(express.json({ limit: CHAT_IMAGE_MAX_BYTES + 64 * 1024 }));
app.use('/api', messagesRouter);
app.use('/api/stories', storiesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  moderationMod.moderateImage = realModerateImage;
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  moderateImageCalls = [];
  moderateImageImpl = null;
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
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
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const wrote = (table) => log.filter((q) => new RegExp(`INSERT INTO ${table}`, 'i').test(q.sql));
const allowImages = () => { moderateImageImpl = async () => ({ allowed: true, reason: null }); };

// Fixtures for the happy paths. Everything a send touches before the INSERT.
function scriptFlockSend() {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => ({ rows: [{ id: 1 }] }));
  on(/INSERT INTO messages/, () => ({ rows: [{ id: 5, flock_id: 42, sender_id: 1 }] }));
}
function scriptDmSend() {
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT 1 WHERE EXISTS/, () => ({ rows: [{ '?column?': 1 }] }));
  on(/INSERT INTO direct_messages/, () => ({ rows: [{ id: 9, sender_id: 1, receiver_id: 2 }] }));
}
function scriptStoryPost() {
  on(/COUNT\(\*\) FILTER \(WHERE created_at/, () => ({ rows: [{ last_hour: 0, active: 0 }] }));
  on(/INSERT INTO stories/, () => ({ rows: [{ id: 77, user_id: 1 }] }));
}

// A data: URL of EXACTLY n bytes. ASCII throughout, so bytes and characters
// agree — the multi-byte case is built separately below, on purpose.
const PREFIX = 'data:image/png;base64,';
const dataUrl = (n) => PREFIX + 'A'.repeat(n - PREFIX.length);

const SEND_PATHS = [
  ['flock message', 'POST', '/api/flocks/42/messages', scriptFlockSend, 'messages'],
  ['direct message', 'POST', '/api/dm/2', scriptDmSend, 'direct_messages'],
];

// ---------------------------------------------------------------------------
// 1. Size parity with the socket
// ---------------------------------------------------------------------------
for (const [name, method, url, script, table] of SEND_PATHS) {
  test(`${name}: an image one byte over the socket's ceiling is refused over REST too`, async () => {
    script();
    allowImages();
    const image_url = dataUrl(CHAT_IMAGE_MAX_BYTES + 1);

    // The socket refuses this exact string. Stated here so the two assertions
    // sit next to each other and a future change to one is visibly a change to
    // both.
    assert.deepStrictEqual(checkInboundImage(image_url), { ok: false, message: IMAGE_TOO_LARGE_MESSAGE });

    const res = await call(method, url, { message_type: 'image', image_url });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error, IMAGE_TOO_LARGE_MESSAGE, 'same sentence as the socket, verbatim');
    assert.strictEqual(wrote(table).length, 0, 'nothing oversized reaches the column');
  });

  test(`${name}: the boundary is inclusive and identical to the socket's`, async () => {
    script();
    allowImages();
    const image_url = dataUrl(CHAT_IMAGE_MAX_BYTES);
    assert.deepStrictEqual(checkInboundImage(image_url), { ok: true });

    const res = await call(method, url, { message_type: 'image', image_url });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(wrote(table).length, 1);
  });

  test(`${name}: an oversized image is refused before it costs a billed Vision call`, async () => {
    script();
    // Deliberately NOT stubbed to allow: if the route ever calls the provider
    // for a photo it was always going to refuse, this records it.
    const res = await call(method, url, {
      message_type: 'image',
      image_url: dataUrl(CHAT_IMAGE_MAX_BYTES + 1),
    });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(moderateImageCalls, [], 'a refusal we can make for free must never be billed');
    assert.strictEqual(log.length, 0, 'and it must not cost a query either');
  });

  // Character count and byte count diverge the moment the payload is not ASCII,
  // and they CAN diverge here: the format guard is prefix-anchored, so anything
  // at all may follow the base64. A `.length` check would have measured this
  // string as comfortably under the ceiling while the body limit, the socket and
  // the stored column all counted ~1MB more than that.
  test(`${name}: a multi-byte payload is measured in bytes, not code units`, async () => {
    script();
    allowImages();
    const emoji = 1000;                                   // 2 code units, 4 bytes each
    const filler = CHAT_IMAGE_MAX_BYTES - PREFIX.length - 2 * emoji - 1000;
    const image_url = PREFIX + 'A'.repeat(filler) + '\u{1F600}'.repeat(emoji);

    assert.ok(image_url.length < CHAT_IMAGE_MAX_BYTES, 'by .length this looks legal');
    assert.ok(Buffer.byteLength(image_url, 'utf8') > CHAT_IMAGE_MAX_BYTES, 'by bytes it is not');
    assert.deepStrictEqual(checkInboundImage(image_url), { ok: false, message: IMAGE_TOO_LARGE_MESSAGE });

    const res = await call(method, url, { message_type: 'image', image_url });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error, IMAGE_TOO_LARGE_MESSAGE);
    assert.deepStrictEqual(moderateImageCalls, []);
    assert.strictEqual(wrote(table).length, 0);
  });

  test(`${name}: a value that is not a data: image URL is refused with the socket's sentence`, async () => {
    script();
    allowImages();
    for (const image_url of [
      'https://tracker.example/pixel.png',      // a tracking pixel aimed at every recipient
      'data:text/html;base64,PHNjcmlwdD4=',
      'javascript:alert(1)',
    ]) {
      const res = await call(method, url, { message_type: 'image', image_url });
      assert.strictEqual(res.status, 400, `${image_url} -> ${res.text}`);
      assert.strictEqual(res.body.error, IMAGE_FORMAT_MESSAGE,
        `${image_url} was refused with an unactionable message`);
    }
    assert.strictEqual(wrote(table).length, 0);
  });
}

// Found while re-auditing the size fix, one field over: the socket's
// checkInboundImage returns null for '' — "no image", not "a broken image" —
// while the REST validator ran '' through the format regex and refused it. So
// `{ message_text: 'hi', image_url: '' }` was a delivered message on the
// primary transport and a 400 on the fallback. Unreachable from the shipping
// client only because services/socket.js and services/api.js both normalise
// `opts.image_url || null` on the way out, which is a client-side accident, not
// a server-side rule.
for (const [name, method, url, script, table] of SEND_PATHS) {
  test(`${name}: an empty image_url means "no image" on both transports`, async () => {
    script();
    allowImages();
    assert.strictEqual(checkInboundImage(''), null, 'the socket reads it as absent');

    const res = await call(method, url, { message_text: 'hi', image_url: '' });
    assert.strictEqual(res.status, 201, res.text);
    const insert = wrote(table)[0];
    assert.ok(insert, 'the message is stored');
    assert.ok(!insert.params.includes(''), 'and nothing stores the empty string as an image');
    assert.deepStrictEqual(moderateImageCalls, [], 'there is no image to screen');
  });

  test(`${name}: an empty image_url and no text is still an empty message`, async () => {
    script();
    allowImages();
    const res = await call(method, url, { image_url: '' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Message is required', 'the same refusal the socket gives');
    assert.strictEqual(wrote(table).length, 0);
  });

  test(`${name}: false and 0 are client bugs, not "no image"`, async () => {
    script();
    allowImages();
    for (const image_url of [false, 0]) {
      const res = await call(method, url, { message_text: 'hi', image_url });
      assert.strictEqual(res.status, 400, `${image_url} -> ${res.text}`);
      assert.strictEqual(res.body.error, IMAGE_FORMAT_MESSAGE);
    }
  });
}

// The parity above is only worth anything if the number is genuinely shared.
test('the REST routes import the ceiling rather than keeping their own copy of it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8');
  assert.match(src, /require\('\.\.\/sockets\/handlers'\)/);
  assert.match(src, /CHAT_IMAGE_MAX_BYTES/);
  assert.ok(
    !/(const|let|var)\s+CHAT_IMAGE_MAX_BYTES\s*=/.test(src),
    'the ceiling must be imported from sockets/handlers.js, never redeclared here'
  );
  // A hand-written byte literal in the size check is the same bug wearing a
  // different name: it would not follow the constant when the constant moves.
  assert.ok(
    /Buffer\.byteLength\(image, 'utf8'\) > CHAT_IMAGE_MAX_BYTES/.test(src),
    'the check must be expressed in terms of the shared constant'
  );
});

// ---------------------------------------------------------------------------
// 2. Real animated bytes, through the real gate
// ---------------------------------------------------------------------------
// Built by hand rather than pulled from a fixture file so it is obvious that
// nothing here declares itself animated: an APNG is a PNG with an `acTL` chunk
// before the first IDAT, and its MIME type, extension and magic number are all
// exactly those of a still PNG.
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ANIMATED_PNG = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk('IHDR', Buffer.alloc(13)),
  pngChunk('acTL', Buffer.alloc(8)),
  pngChunk('IDAT', Buffer.alloc(8)),
  pngChunk('IEND', Buffer.alloc(0)),
]);
const STILL_PNG = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk('IHDR', Buffer.alloc(13)),
  pngChunk('IDAT', Buffer.alloc(8)),
  pngChunk('IEND', Buffer.alloc(0)),
]);

function riffChunk(fourcc, data) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length, 0);
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(fourcc, 'latin1'), size, data, pad]);
}
function webp(chunks) {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, body]);
}
const ANIMATED_WEBP = webp([riffChunk('VP8X', Buffer.alloc(10)), riffChunk('ANIM', Buffer.alloc(6))]);
const STILL_WEBP = webp([riffChunk('VP8 ', Buffer.alloc(16))]);

const asDataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

const ANIMATED = [
  ['an APNG, which ships as image/png', asDataUrl('image/png', ANIMATED_PNG)],
  ['an animated WebP, which ships as image/webp', asDataUrl('image/webp', ANIMATED_WEBP)],
];
const STILL = [
  ['a still PNG', asDataUrl('image/png', STILL_PNG)],
  ['a still WebP', asDataUrl('image/webp', STILL_WEBP)],
];

for (const [what, image_url] of ANIMATED) {
  test(`stories: ${what} is refused by the byte-level gate, not by the format regex`, async () => {
    scriptStoryPost();
    // The format allowlist is satisfied — that is the whole point.
    assert.match(image_url, S.IMAGE_DATA_URL);

    const res = await call('POST', '/api/stories', { image_url });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.moderation, 'animated_image');
    assert.strictEqual(wrote('stories').length, 0);
    assert.strictEqual(moderateImageCalls.length, 1, 'stories really does go through the shared screen');
  });

  test(`stories: ${what} is told what to do about it`, async () => {
    scriptStoryPost();
    const res = await call('POST', '/api/stories', { image_url });
    assert.strictEqual(res.body.error, ANIMATED_IMAGE_REJECTED_MESSAGE);
    assert.notStrictEqual(res.body.error, IMAGE_REJECTED_MESSAGE,
      'a policy refusal must not be dressed up as a failed safety check');
  });

  test(`stories: the rate-limit probe is spent BEFORE the animation refusal, never a Vision call after it`, async () => {
    scriptStoryPost();
    await call('POST', '/api/stories', { image_url });
    // moderateImage answers 'animated_image' from the bytes alone; no provider
    // is configured here, and even with one the gate returns before the fetch.
    assert.strictEqual(moderateImageCalls.length, 1);
  });

  test(`flock chat and DMs describe ${what} the same way`, async () => {
    for (const [, method, url, script] of SEND_PATHS) {
      handlers = []; log = []; moderateImageCalls = [];
      script();
      const res = await call(method, url, { message_type: 'image', image_url });
      assert.strictEqual(res.status, 400, res.text);
      assert.strictEqual(res.body.error, ANIMATED_IMAGE_REJECTED_MESSAGE,
        'all three image routes must say the same thing about the same file');
      assert.strictEqual(res.body.moderation, 'animated_image');
    }
  });
}

for (const [what, image_url] of STILL) {
  test(`stories: ${what} still posts — the gate refuses frames, not formats`, async () => {
    scriptStoryPost();
    const res = await call('POST', '/api/stories', { image_url });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(wrote('stories').length, 1);
  });
}

// ---------------------------------------------------------------------------
// 3. Story rejection messages that fit their reason
// ---------------------------------------------------------------------------
test('a story refused as unsafe still gets the safety sentence', async () => {
  scriptStoryPost();
  moderateImageImpl = async () => ({ allowed: false, reason: 'unsafe_adult' });
  const res = await call('POST', '/api/stories', { image_url: asDataUrl('image/png', STILL_PNG) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, IMAGE_REJECTED_MESSAGE);
  assert.strictEqual(res.body.moderation, 'unsafe_adult');
  assert.strictEqual(wrote('stories').length, 0);
});

test('a story refused because the screen itself failed gets the safety sentence too', async () => {
  scriptStoryPost();
  moderateImageImpl = async () => ({ allowed: false, reason: 'moderation_error' });
  const res = await call('POST', '/api/stories', { image_url: asDataUrl('image/png', STILL_PNG) });
  assert.strictEqual(res.body.error, IMAGE_REJECTED_MESSAGE);
  assert.strictEqual(wrote('stories').length, 0);
});

test('a screen that THROWS is still fail-closed, and still says something true', async () => {
  scriptStoryPost();
  moderateImageImpl = async () => { throw new Error('provider module exploded'); };
  const res = await call('POST', '/api/stories', { image_url: asDataUrl('image/png', STILL_PNG) });
  assert.strictEqual(res.status, 400, 'a throw must never become a stored story');
  assert.strictEqual(res.body.error, IMAGE_REJECTED_MESSAGE);
  assert.strictEqual(res.body.moderation, 'moderation_error');
  assert.strictEqual(wrote('stories').length, 0);
});

// ---------------------------------------------------------------------------
// 4. The story size limit, and the number the user is told
// ---------------------------------------------------------------------------
test('the story size refusal quotes the limit it actually enforces', async () => {
  scriptStoryPost();
  moderateImageImpl = async () => ({ allowed: true, reason: null });

  const res = await call('POST', '/api/stories', {
    image_url: PREFIX + 'A'.repeat(S.MAX_IMAGE_DATA_URL_BYTES),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, S.IMAGE_TOO_LARGE_MESSAGE);

  const quoted = /under about (\d+) KB/.exec(res.body.error);
  assert.ok(quoted, `the refusal must name a number: ${res.body.error}`);
  assert.strictEqual(Number(quoted[1]), S.ADVERTISED_PHOTO_KB, 'and it must be the derived one');
  assert.deepStrictEqual(moderateImageCalls, [], 'refused for free, before the billed call');
  assert.strictEqual(log.length, 0, 'and before the flood-check query');
});

// The property the advertised number has to have, which is NOT "equals the
// enforced number". The ceiling is on the base64 DATA URL and base64 inflates
// by 4/3; the user picks a PHOTO. Quoting 700 KB — the enforced figure — would
// refuse a 700 KB photo a second time with the same sentence, which is worse
// than saying nothing. So: encode a photo of exactly the size we advertise and
// require that it fits. Reverting the derivation to the enforced number, or
// dropping the ceiling without touching the sentence, both turn this red.
test('a photo of exactly the advertised size actually posts', async () => {
  scriptStoryPost();
  moderateImageImpl = async () => ({ allowed: true, reason: null });

  const photo = Buffer.alloc(S.ADVERTISED_PHOTO_KB * 1024, 0x41);
  const image_url = `data:image/png;base64,${photo.toString('base64')}`;
  assert.ok(
    Buffer.byteLength(image_url, 'utf8') <= S.MAX_IMAGE_DATA_URL_BYTES,
    `a ${S.ADVERTISED_PHOTO_KB} KB photo encodes to ${Buffer.byteLength(image_url, 'utf8')} bytes, ` +
    `over the ${S.MAX_IMAGE_DATA_URL_BYTES}-byte ceiling — the message tells users to do something that fails`
  );

  const res = await call('POST', '/api/stories', { image_url });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(wrote('stories').length, 1);
});

// And the advertised number must be a real conversion of the enforced one, not
// a literal that happens to fit today.
test('the advertised size is derived from the enforced ceiling', () => {
  assert.ok(S.ADVERTISED_PHOTO_KB > 0);
  assert.ok(
    S.ADVERTISED_PHOTO_KB * 1024 < S.MAX_IMAGE_DATA_URL_BYTES * 3 / 4 + 1,
    'the advertised photo size must be at most the ceiling converted out of base64'
  );
  assert.ok(
    S.ADVERTISED_PHOTO_KB * 1024 > S.MAX_IMAGE_DATA_URL_BYTES / 2,
    'and not so conservative that it refuses photos the route would happily take'
  );
});

test('the story ceiling is inclusive, like every other image ceiling in the app', async () => {
  scriptStoryPost();
  moderateImageImpl = async () => ({ allowed: true, reason: null });
  const atCap = PREFIX + 'A'.repeat(S.MAX_IMAGE_DATA_URL_BYTES - PREFIX.length);
  assert.strictEqual(Buffer.byteLength(atCap, 'utf8'), S.MAX_IMAGE_DATA_URL_BYTES);

  const res = await call('POST', '/api/stories', { image_url: atCap });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(wrote('stories').length, 1);
});

// ---------------------------------------------------------------------------
// 5. An image-only message carries no push text, and that is handled downstream
// ---------------------------------------------------------------------------
// The client stopped sending the literal word "Photo" as the body of an image
// message, so the preview both send routes build — `(message_text || '')` — is
// now genuinely empty. It is not fixed here, and this test is why: the socket
// send paths build the same empty preview from the same expression, and
// services/firebaseService.js already turns an empty body into a sentence. A
// REST-only "Sent a photo" would put two different notifications on one message
// depending on which transport happened to be up.
test('an empty push body becomes a real sentence, per notification type', () => {
  const { normalizeBody } = require('../services/firebaseService');
  assert.strictEqual(normalizeBody('', 'flock_message'), 'Shared something in the chat');
  assert.strictEqual(normalizeBody('', 'dm_message'), 'Sent you something');
  assert.strictEqual(normalizeBody('a caption', 'dm_message'), 'a caption');
});

test('both REST send routes and both socket send paths build the preview identically', () => {
  const restSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8');
  const socketSrc = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');
  const previewExpr = /\(\s*(?:message_text|text)\s*\|\|\s*''\s*\)\.substring\(0, 100\)/g;
  assert.strictEqual((restSrc.match(previewExpr) || []).length, 2, 'flock + DM over REST');
  assert.strictEqual((socketSrc.match(previewExpr) || []).length, 2, 'flock + DM over the socket');
});
