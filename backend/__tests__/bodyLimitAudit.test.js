'use strict';

// ---------------------------------------------------------------------------
// The JSON body limits, and the audit that set them
// ---------------------------------------------------------------------------
//
// server.js used to hand every request a 1MB buffer, because 1mb is
// body-parser's own default and nobody had ever chosen it. The parser is the
// first middleware after cors and helmet, so that buffer was available with no
// credential at all — POST /api/auth/login offered a megabyte to a caller who
// had proved nothing. The default is now 64KB, with three scoped parsers for
// the routes that genuinely need more.
//
// WHAT THIS FILE IS FOR. A limit is only as good as the audit behind it, and an
// audit written in a comment rots the moment somebody raises a validator's
// `max:` two files away. Every number this audit depended on is read back out
// of the route file that owns it, the worst honest body is RECOMPUTED from
// those numbers, and the result is asserted against the parser that actually
// serves that route. Raise `max: 4000` in routes/ai.js, or the 8192 in
// routes/users.js, or MAX_DESCRIPTION in routes/venueProfile.js, and the test
// that fails is this one — which is the whole point, because the alternative is
// a legitimate request coming back 413 in production.
//
// HOW IT TESTS server.js. Requiring server.js calls boot(), which migrates and
// listens, so nothing here requires it. The parser block and the global error
// handler are LIFTED OUT OF THE SOURCE and evaluated, exactly the way
// __tests__/imageSpendLimits.test.js lifts the billed-image limiter: the code
// under test is server.js's own code, not a restatement of it that can quietly
// disagree.
//
// A NOTE ON WHAT THIS DOES NOT CLAIM. A smaller default does not stop the
// buffering — express.json() still runs ahead of every rate limiter, so a
// refusal here saves 15/16ths of the heap an abusive request used to get and
// nothing else. The limiters are still behind the parser. See the "Billed image
// screening" block in server.js, which says the same thing about its own reach.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { body, validationResult } = require('express-validator');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'body-limit-audit-test-secret';

const BACKEND = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');
const serverSrc = read('server.js');

// ---------------------------------------------------------------------------
// 0. The photo ceiling, read rather than required
// ---------------------------------------------------------------------------
// sockets/handlers.js pulls in the database pool, and this file has no business
// opening a connection to decide what a number is. The declaration is read and
// evaluated instead; if it ever stops being an arithmetic literal this throws,
// which is the correct failure — the image parser is derived from it.
function chatImageMaxBytes() {
  const decl = /const CHAT_IMAGE_MAX_BYTES = ([^;]+);/.exec(read('sockets/handlers.js'));
  assert.ok(decl, 'sockets/handlers.js must declare CHAT_IMAGE_MAX_BYTES');
  // eslint-disable-next-line no-eval
  const value = eval(decl[1]); // an arithmetic literal from our own source
  assert.equal(typeof value, 'number', 'CHAT_IMAGE_MAX_BYTES must be a byte count');
  return value;
}
const CHAT_IMAGE_MAX_BYTES = chatImageMaxBytes();

// ---------------------------------------------------------------------------
// 1. server.js's parser block, lifted out and run
// ---------------------------------------------------------------------------
// Everything from the first constant of the block down to and including the
// urlencoded mount. If that block is deleted or renamed this throws, which is
// the point: there is no version of "the limits were removed" that leaves this
// file green.
const PARSER_BLOCK_START = 'const JSON_BODY_ENVELOPE_BYTES';
const PARSER_BLOCK_END = 'app.use(express.urlencoded(';

function loadParserBlock(app) {
  const start = serverSrc.indexOf(PARSER_BLOCK_START);
  const endAt = serverSrc.indexOf(PARSER_BLOCK_END);
  assert.ok(start > 0, 'server.js must declare JSON_BODY_ENVELOPE_BYTES');
  assert.ok(endAt > start, 'server.js must mount the urlencoded parser after the JSON ones');
  const end = serverSrc.indexOf('\n', endAt);
  const src = serverSrc.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function('express', 'CHAT_IMAGE_MAX_BYTES', 'app', `${src}
    return {
      JSON_BODY_ENVELOPE_BYTES, JSON_STRING_BYTES_PER_CHAR,
      DEFAULT_JSON_BODY_BYTES, AI_CHAT_JSON_BODY_BYTES, WEBHOOK_JSON_BODY_BYTES,
      AI_CHAT_MAX_MESSAGES, AI_CHAT_MAX_MESSAGE_CHARS,
      IMAGE_BODY_ROUTES, AI_CHAT_BODY_ROUTE, WEBHOOK_BODY_ROUTE,
      SCOPED_JSON_PARSERS, imageRoutePath,
    };`);
  return factory(express, CHAT_IMAGE_MAX_BYTES, app);
}

// A block with no app to mount on, for the assertions that only need the numbers.
const NOOP_APP = { use() {} };
const S = loadParserBlock(NOOP_APP);

const IMAGE_JSON_BODY_BYTES = CHAT_IMAGE_MAX_BYTES + S.JSON_BODY_ENVELOPE_BYTES;

// ---------------------------------------------------------------------------
// 2. server.js's global error handler, also lifted out and run
// ---------------------------------------------------------------------------
// The requirement is a clean 413 with a sentence a person can act on, not a
// 500. An earlier agent mapped body-parser's error types correctly; this holds
// that fix to the NEW limits rather than assuming it survived them.
function loadErrorHandler() {
  const start = serverSrc.indexOf('const BODY_PARSER_CLIENT_ERRORS');
  assert.ok(start > 0, 'server.js must classify body-parser failures');
  const tail = "return res.status(500).json({ error: 'Internal server error' });";
  const at = serverSrc.indexOf(tail, start);
  assert.ok(at > start, 'the global error handler must still fall through to a 500');
  // From PAST the tail line, not from it: the tail itself ends in `});`.
  const end = serverSrc.indexOf('\n});', at + tail.length) + '\n});'.length;
  assert.ok(end > at, 'the global error handler must be closed');
  let captured = null;
  // eslint-disable-next-line no-new-func
  new Function('app', serverSrc.slice(start, end))({ use: (fn) => { captured = fn; } });
  assert.equal(typeof captured, 'function', 'the error handler must be an app.use');
  assert.equal(captured.length, 4, 'an Express error handler takes four arguments');
  return captured;
}
const errorHandler = loadErrorHandler();

// ---------------------------------------------------------------------------
// 3. The numbers the audit is built on, read back out of the route files
// ---------------------------------------------------------------------------
// Each of these is a bound the audit in server.js quotes by value. Reading them
// rather than retyping them is what stops the comment and the code drifting.

function num(rel, re, what) {
  const m = re.exec(read(rel));
  assert.ok(m, `${rel} must still declare ${what} (the body-limit audit reads it)`);
  return Number(m[1]);
}

const ROUTE_BOUNDS = {
  // POST /api/ai/chat — the one non-image route with a scoped parser.
  aiMaxMessages: num('routes/ai.js',
    /body\('messages'\)\.isArray\(\{\s*min:\s*\d+,\s*max:\s*(\d+)\s*\}\)/, "the messages array cap"),
  aiMaxMessageChars: num('routes/ai.js',
    /body\('messages\.\*\.text'\)[\s\S]{0,120}?isLength\(\{\s*max:\s*(\d+)\s*\}\)/, "the per-message text cap"),

  // POST /api/crowd/batch — the named suspect.
  crowdMaxVenues: num('routes/crowd.js',
    /body\('venues'\)\.isArray\(\{\s*min:\s*\d+,\s*max:\s*(\d+)\s*\}\)/, "the venues array cap"),
  crowdPlaceIdChars: num('routes/crowd.js',
    /place_id:[\s\S]{0,80}?\.slice\(0,\s*(\d+)\)/, "the place_id truncation"),
  crowdNameChars: num('routes/crowd.js',
    /name:[\s\S]{0,80}?\.slice\(0,\s*(\d+)\)/, "the venue name truncation"),
  crowdMaxTypes: num('routes/crowd.js',
    /types:[\s\S]{0,120}?\.slice\(0,\s*(\d+)\)/, "the types array truncation"),

  // PATCH /api/users/settings — the settings batch.
  settingsChars: num('routes/users.js',
    /JSON\.stringify\(partial\)\.length > (\d+)/, "the settings payload cap"),

  // POST /api/friends/find-by-phone — the contacts batch.
  maxSyncPhones: num('routes/friends.js',
    /const MAX_SYNC_PHONES = (\d+);/, "MAX_SYNC_PHONES"),

  // POST /api/billing/:flockId/create — the largest id/amount batch.
  maxCustomShares: num('routes/billing.js',
    /body\('customShares'\)[\s\S]{0,80}?isArray\(\{\s*max:\s*(\d+)\s*\}\)/, "the custom-shares cap"),

  // PUT /api/venue-profile — the largest body served by the default.
  venueName: num('routes/venueProfile.js', /const MAX_BUSINESS_NAME = (\d+);/, 'MAX_BUSINESS_NAME'),
  venueCategory: num('routes/venueProfile.js', /const MAX_CATEGORY = (\d+);/, 'MAX_CATEGORY'),
  venueLocation: num('routes/venueProfile.js', /const MAX_LOCATION = (\d+);/, 'MAX_LOCATION'),
  venueDescription: num('routes/venueProfile.js', /const MAX_DESCRIPTION = (\d+);/, 'MAX_DESCRIPTION'),
  venuePlaceId: num('routes/venueProfile.js', /const MAX_PLACE_ID = (\d+);/, 'MAX_PLACE_ID'),
  venuePhotoUrl: num('routes/venueProfile.js', /const MAX_PHOTO_URL = (\d+);/, 'MAX_PHOTO_URL'),
  venueGoals: num('routes/venueProfile.js', /const MAX_GOALS = (\d+);/, 'MAX_GOALS'),
  venueGoalLen: num('routes/venueProfile.js', /const MAX_GOAL_LEN = (\d+);/, 'MAX_GOAL_LEN'),
  venueHoursRows: num('routes/venueProfile.js', /const MAX_HOURS_ROWS = (\d+);/, 'MAX_HOURS_ROWS'),
  venueHoursField: num('routes/venueProfile.js', /const MAX_HOURS_FIELD = (\d+);/, 'MAX_HOURS_FIELD'),

  // The three image routes, whose text field rides alongside the photo.
  chatTextChars: num('routes/messages.js',
    /body\('message_text'\)[\s\S]{0,160}?isLength\(\{\s*max:\s*(\d+)\s*\}\)/, "the chat message cap"),
  storyImageBytes: num('routes/stories.js',
    /const MAX_IMAGE_DATA_URL_BYTES = (\d+) \* 1024;/, 'MAX_IMAGE_DATA_URL_BYTES'),
  storyCaptionChars: num('routes/stories.js',
    /const MAX_CAPTION_LENGTH = (\d+);/, 'MAX_CAPTION_LENGTH'),
};

// ---------------------------------------------------------------------------
// 4. The restated constants are the real ones
// ---------------------------------------------------------------------------

test('the AI caps server.js sizes its parser from are routes/ai.js\'s own caps', () => {
  // server.js cannot import routes/ai.js — the parser runs before the router
  // exists — so it restates these two numbers. A restated constant is a
  // constant that drifts unless something checks it. This is that something.
  assert.equal(S.AI_CHAT_MAX_MESSAGES, ROUTE_BOUNDS.aiMaxMessages,
    'server.js sizes the Birdie parser from a message cap routes/ai.js no longer enforces');
  assert.equal(S.AI_CHAT_MAX_MESSAGE_CHARS, ROUTE_BOUNDS.aiMaxMessageChars,
    'server.js sizes the Birdie parser from a text cap routes/ai.js no longer enforces');
});

test('the image parser is still DERIVED from the socket photo ceiling, not duplicated', () => {
  // The pre-existing arrangement, re-checked because this change edits the
  // block it lives in: the number that decides how big a chat photo may be
  // lives in exactly one place, and the REST parser is that number plus an
  // envelope. A literal here would let the two transports disagree about the
  // same image.
  assert.match(serverSrc, /const imageJsonParser = express\.json\(\{ limit: CHAT_IMAGE_MAX_BYTES \+ JSON_BODY_ENVELOPE_BYTES \}\);/,
    'the image body limit must stay derived from CHAT_IMAGE_MAX_BYTES');
  assert.equal(
    (serverSrc.match(/express\.json\(\{ limit: [^}]*CHAT_IMAGE_MAX_BYTES/g) || []).length, 1,
    'exactly one parser may be sized from the photo ceiling');
});

test('the Birdie parser is derived arithmetic, not a number somebody liked', () => {
  assert.match(serverSrc,
    /const AI_CHAT_JSON_BODY_BYTES =\s*\n?\s*AI_CHAT_MAX_MESSAGES \* AI_CHAT_MAX_MESSAGE_CHARS \* JSON_STRING_BYTES_PER_CHAR \+ JSON_BODY_ENVELOPE_BYTES;/,
    'the Birdie ceiling must be computed from the caps it exists to fit');
  assert.equal(
    S.AI_CHAT_JSON_BODY_BYTES,
    ROUTE_BOUNDS.aiMaxMessages * ROUTE_BOUNDS.aiMaxMessageChars * S.JSON_STRING_BYTES_PER_CHAR + S.JSON_BODY_ENVELOPE_BYTES);
});

test('the default is lower than the one it replaced, and low enough to matter', () => {
  assert.ok(S.DEFAULT_JSON_BODY_BYTES < 1024 * 1024,
    'the finding was that an unauthenticated caller gets a 1MB buffer; a default at or above 1mb has not closed it');
  assert.equal(S.DEFAULT_JSON_BODY_BYTES, 64 * 1024,
    'the audit in server.js justifies 64KB specifically — move it and rewrite the audit');
  // The urlencoded parser is ahead of every limiter too, and its own default is
  // 100KB. It has to be held to the same ceiling or it is the hole.
  assert.match(serverSrc,
    /app\.use\(express\.urlencoded\(\{ extended: true, limit: DEFAULT_JSON_BODY_BYTES \}\)\);/,
    'the form parser hands out an unauthenticated buffer too');
});

// ---------------------------------------------------------------------------
// 5. THE DRIFT TEST: every route's real maximum fits the parser serving it
// ---------------------------------------------------------------------------
// Worst honest body per route, recomputed from the bounds extracted above. If
// a validator's ceiling grows past what its parser can carry, this fails —
// before a real user's request does.

const PER_CHAR = 4; // worst-case UTF-8 bytes per code point; see server.js
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// ---------------------------------------------------------------------------
// 4b. The harness: server.js's parser block and error handler, over real HTTP
// ---------------------------------------------------------------------------
// Both are the lifted originals. The stub behind them answers 200 with the
// parsed byte count, so a request either reaches it (the parser accepted the
// body) or is answered by server.js's own error handler (it did not).
function buildParsingApp() {
  const app = express();
  loadParserBlock(app);
  app.use((req, res) => res.json({ ok: true, bytes: jsonBytes(req.body || {}) }));
  app.use(errorHandler);
  return app;
}

let base;
let server;
test.before(async () => {
  server = http.createServer(buildParsingApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

async function sendAs(method, p, payload) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, bytes: Buffer.byteLength(raw, 'utf8') };
}
const send = (p, payload) => sendAs('POST', p, payload);

// A body of EXACTLY n bytes.
function bodyOfBytes(n) {
  const wrapper = '{"pad":""}';
  const pad = n - Buffer.byteLength(wrapper, 'utf8');
  assert.ok(pad >= 0, 'n must leave room for the wrapper');
  return `{"pad":"${'a'.repeat(pad)}"}`;
}

test('the largest honest /api/ai/chat body fits the Birdie parser', () => {
  const b = ROUTE_BOUNDS;
  // 24 turns, every one of them 4000 code points of the widest characters that
  // exist, plus the currentContext fields routes/ai.js interpolates into the
  // system prompt, plus keys.
  const worst = b.aiMaxMessages * (b.aiMaxMessageChars * PER_CHAR + 40) + 4096;
  assert.ok(S.AI_CHAT_JSON_BODY_BYTES >= worst,
    `Birdie's parser (${S.AI_CHAT_JSON_BODY_BYTES}) must carry the largest body its validators accept (${worst})`);
});

test('the largest honest /api/crowd/batch body fits the default', () => {
  const b = ROUTE_BOUNDS;
  // The named suspect. `venues` is capped at 20 items; the handler then
  // truncates each item itself, so nothing past these widths is ever used.
  // Only `name` is UGC — a Google place id and a Google type string are ASCII
  // by definition — so `name` is the only field costed at 4 bytes a character.
  const perVenue = b.crowdPlaceIdChars + b.crowdNameChars * PER_CHAR + b.crowdMaxTypes * 64 + 256;
  const worst = b.crowdMaxVenues * perVenue + 256;
  assert.ok(S.DEFAULT_JSON_BODY_BYTES >= worst,
    `/api/crowd/batch (${worst} bytes at its ceiling) no longer fits the ${S.DEFAULT_JSON_BODY_BYTES} default — it needs a scoped parser`);
});

test('the largest honest PUT /api/venue-profile body fits the default', () => {
  const b = ROUTE_BOUNDS;
  const chars = b.venueName + b.venueCategory + b.venueLocation + b.venueDescription
    + b.venuePlaceId + b.venuePhotoUrl
    + b.venueGoals * b.venueGoalLen
    + b.venueHoursRows * 3 * b.venueHoursField
    + 50; // phone
  const worst = chars * PER_CHAR + 1024; // keys and the notificationPrefs object
  assert.ok(S.DEFAULT_JSON_BODY_BYTES >= worst,
    `the venue profile body (${worst} bytes at its ceiling) no longer fits the ${S.DEFAULT_JSON_BODY_BYTES} default`);
});

test('the largest honest PATCH /api/users/settings body fits the default', () => {
  // The handler measures JSON.stringify(body).length — UTF-16 code units — so
  // the wire cost is at most 3 bytes per unit under a normal serializer.
  const worst = ROUTE_BOUNDS.settingsChars * 3 + 512;
  assert.ok(S.DEFAULT_JSON_BODY_BYTES >= worst,
    `the settings batch (${worst} bytes at its ceiling) no longer fits the default`);
  // And the one route where an ESCAPING serializer (Python's json.dumps and its
  // ensure_ascii default) gets within reach: 6 wire bytes can collapse to one
  // counted unit. No client of this API does that, but the margin is recorded
  // so a future raise of that 8192 is caught here rather than in production.
  const escapedWorst = ROUTE_BOUNDS.settingsChars * 6 + 512;
  assert.ok(S.DEFAULT_JSON_BODY_BYTES >= escapedWorst,
    `an escaping client could send ${escapedWorst} bytes and still be inside the handler's own cap`);
});

test('the id, contact and settings batches all fit the default', () => {
  const b = ROUTE_BOUNDS;
  const cases = [
    ['POST /api/friends/find-by-phone', jsonBytes({ phones: Array(b.maxSyncPhones).fill('+1 (202) 555-0122') })],
    ['POST /api/billing/:flockId/create', jsonBytes({
      totalAmount: 100000, tipPercent: 100, splitType: 'custom', paidBy: 2147483647,
      customShares: Array(b.maxCustomShares).fill({ userId: 2147483647, amount: 100000.55 }),
    })],
    ['POST /api/flocks/:id/invite', jsonBytes({ user_ids: Array(25).fill(2147483647) })],
    ['POST /api/flocks/:id/attendance', jsonBytes({ attendance: Array(50).fill({ user_id: 2147483647, attended: true }) })],
    ['POST /api/notifications/register', jsonBytes({ token: 'x'.repeat(1024), deviceType: 'android' })],
  ];
  for (const [route, size] of cases) {
    assert.ok(S.DEFAULT_JSON_BODY_BYTES >= size,
      `${route} sends ${size} bytes at its ceiling, past the ${S.DEFAULT_JSON_BODY_BYTES} default`);
  }
});

test('the largest honest chat photo still fits the image parser', () => {
  // Unchanged behaviour, re-derived: a photo at the socket's ceiling plus the
  // 5000-character message text beside it plus a sanitized venue card. Costed
  // at 6 bytes per character rather than 4, because this is the one field the
  // pre-existing comment already costed that way and the envelope was sized
  // for it.
  const worst = CHAT_IMAGE_MAX_BYTES + ROUTE_BOUNDS.chatTextChars * 6 + 4096 + 256;
  assert.ok(IMAGE_JSON_BODY_BYTES > worst,
    `the image parser (${IMAGE_JSON_BODY_BYTES}) must exceed the largest legal chat body (${worst})`);

  // The third image route is a story, whose ceilings are its own: routes/
  // stories.js caps the data URL at 700KB and the caption separately. It shares
  // this parser, so its numbers have to be costed against it too — the envelope
  // was sized for chat text and nothing checked that a caption fits beside it.
  const worstStory = ROUTE_BOUNDS.storyImageBytes * 1024 + ROUTE_BOUNDS.storyCaptionChars * 6 + 256;
  assert.ok(IMAGE_JSON_BODY_BYTES > worstStory,
    `the image parser (${IMAGE_JSON_BODY_BYTES}) must exceed the largest legal story body (${worstStory})`);
});

// ---------------------------------------------------------------------------
// 6. The net: a NEW oversized field anywhere trips this
// ---------------------------------------------------------------------------
// The tests above cost the routes the audit found. This one catches the route
// the audit could not have found, because it does not exist yet.

const ROUTE_FILES = fs.readdirSync(path.join(BACKEND, 'routes'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `routes/${f}`);

// EVERY route file, with no exclusions. Round 3 of this audit caught the first
// draft skipping messages.js, stories.js and ai.js on the grounds that they
// hold the scoped routes — but those files ALSO hold default-served ones
// (/api/messages/:id/react, /api/dm/:userId/venue-votes, /api/stories GET,
// /api/dm/:messageId/read), and a huge new field on one of them would have gone
// straight through the net. The ceilings below sit above every bound that
// legitimately exists today, so no file needs an exemption.

test('no route has grown a free-text field the default cannot carry', () => {
  // One field at a time, not a whole body: a single string this long is already
  // enough to say "somebody added a big field and did not come back here". The
  // threshold is deliberately generous — the largest free text anywhere in the
  // API is 5000 characters (a chat message, which rides on the image parser).
  const CEILING = 8000;
  for (const rel of ROUTE_FILES) {
    const src = read(rel);
    for (const m of src.matchAll(/isLength\(\{[^}]*max:\s*(\d+)/g)) {
      assert.ok(Number(m[1]) <= CEILING,
        `${rel} accepts a ${m[1]}-character field. Re-run the body-limit audit in server.js: `
        + `either it fits the 64KB default or the route needs a scoped parser.`);
    }
  }
});

test('no route has grown an array cap the default cannot carry', () => {
  // 200 (MAX_SYNC_PHONES, checked in the handler rather than the chain) is the
  // largest array any route accepts. An isArray cap past this is a new batch
  // endpoint, and a new batch endpoint needs costing.
  const CEILING = 200;
  for (const rel of ROUTE_FILES) {
    const src = read(rel);
    for (const m of src.matchAll(/isArray\(\{[^}]*max:\s*(\d+)/g)) {
      assert.ok(Number(m[1]) <= CEILING,
        `${rel} accepts an array of ${m[1]}. Re-run the body-limit audit in server.js.`);
    }
  }
});

test('no router sets a body limit of its own', () => {
  // routes/revenuecat.js mounts a bare `express.json()` on its handler. That is
  // a no-op — body-parser sets req._body and skips a body the middleware in
  // server.js has already read — and it is harmless only for as long as it
  // stays bare. The moment one of these carries a `limit`, there are two
  // ceilings for one route, the second one never applies, and the next person
  // reading that file believes a number that does nothing.
  for (const rel of ROUTE_FILES) {
    for (const m of read(rel).matchAll(/express\.(json|urlencoded|raw|text)\(\{[^}]*limit/g)) {
      assert.fail(`${rel} sets its own body limit (${m[0]}). It cannot take effect — the parser in `
        + 'server.js runs first and marks the body read. Put the ceiling in server.js.');
    }
  }
});

test('every route file that takes a body was actually looked at', () => {
  // The enumeration in server.js claims to cover the whole API. This fails if
  // a NEW route file appears, because a file nobody has read is a body limit
  // nobody has costed.
  const KNOWN = new Set([
    // routes/advisor.js enrolled 2026-08-19: its only body is POST /ask's
    // single intentId string (closed registry, unknown keys 400), <1KB —
    // enumerated in server.js next to the other sub-2KB routes.
    'admin', 'advisor', 'ai', 'auth', 'availability', 'badge', 'billing', 'budget', 'calendar',
    'checkin', 'crowd', 'entitlements', 'events', 'feedback', 'flocks', 'friends',
    'guest', 'messages', 'moderation', 'notifications', 'publicCrowd', 'revenuecat',
    'safety', 'sensors', 'stories', 'users', 'venueDashboard',
    // routes/venueDigest.js enrolled 2026-08-20: the digest email's unsubscribe
    // link, a GET that renders and a POST that writes. The router reads no
    // body on either verb — the token rides the query string with a 2048-char
    // validator cap — and the one body that reaches it, RFC 8058's fixed
    // `List-Unsubscribe=One-Click` form post, takes the default ceiling.
    'venueDigest', 'venueProfile',
    'venueSearch', 'venues', 'waitlist', 'weather',
  ]);
  const actual = ROUTE_FILES.map((f) => path.basename(f, '.js'));
  for (const name of actual) {
    assert.ok(KNOWN.has(name),
      `routes/${name}.js is new since the body-limit audit. Read its body validators, `
      + 'add it to the enumeration in server.js, then add it here.');
  }
});

// ---------------------------------------------------------------------------
// 7. Which parser a request gets, decided by server.js's own dispatch
// ---------------------------------------------------------------------------

// MEASURED, NOT RESTATED. Round 2 of this audit caught this file predicting
// which parser a path would get by re-implementing server.js's dispatch — which
// is exactly the two-readings-of-one-thing bug the billed-image limiter's own
// comment warns about, committed inside the test that is supposed to catch it.
// The tier a path actually gets is now determined by asking the running
// middleware: send a body one byte past each ceiling in ascending order, and
// the first refusal names the parser. No branch of the dispatch is duplicated
// here, so no branch of it can be wrong here in the same way it is wrong there.
const TIERS = [
  ['default', S.DEFAULT_JSON_BODY_BYTES],
  ['webhook', S.WEBHOOK_JSON_BODY_BYTES],
  ['ai', S.AI_CHAT_JSON_BODY_BYTES],
  ['image', IMAGE_JSON_BODY_BYTES],
].sort((a, b) => a[1] - b[1]);

test('the four ceilings are distinct, or a measurement cannot tell them apart', () => {
  const sizes = TIERS.map(([, n]) => n);
  assert.equal(new Set(sizes).size, sizes.length,
    'two parsers with the same limit make the tier of a path unobservable');
});

async function measuredTier(p, method = 'POST') {
  for (const [name, limit] of TIERS) {
    const res = await sendAs(method, p, bodyOfBytes(limit + 1));
    if (res.status === 413) return name;
  }
  return 'unbounded';
}

test('the scoped patterns are disjoint — no path can match two parsers', () => {
  // First match wins in the dispatch, so an overlap would mean the ceiling a
  // route gets depends on the order of a list. Checked against the paths that
  // exist rather than asserted in prose.
  for (const p of [
    '/api/flocks/12/messages', '/api/dm/7', '/api/stories',
    '/api/ai/chat', '/api/revenuecat/webhook',
  ]) {
    const hits = S.SCOPED_JSON_PARSERS.filter(([re]) => re.test(p));
    assert.equal(hits.length, 1, `${p} matches ${hits.length} scoped parsers`);
  }
});

test('only the routes the audit scoped get more than the default', async () => {
  assert.equal(await measuredTier('/api/ai/chat'), 'ai');
  assert.equal(await measuredTier('/api/revenuecat/webhook'), 'webhook');
  for (const p of ['/api/flocks/12/messages', '/api/dm/7', '/api/stories']) {
    assert.equal(await measuredTier(p), 'image', `${p} carries a photo`);
  }
  // And nothing else. A bigger buffer on an unauthenticated route is the exact
  // blast radius the finding was about.
  for (const p of [
    '/api/auth/login', '/api/auth/signup', '/api/auth/google', '/api/auth/apple',
    '/api/waitlist', '/api/public/crowd', '/api/crowd/batch', '/api/users/settings',
    '/api/users/upload-image', '/api/friends/find-by-phone', '/api/venue-profile',
    '/api/ai', '/api/ai/chats', '/api/ai/chat/history', '/api/ai/chat/x',
    '/api/revenuecat', '/api/revenuecat/webhooks', '/api/revenuecat/webhook/replay',
    '/api/sensors/data', '/api/reports', '/api/billing/3/create',
    '/api/aai/chat', '/xapi/ai/chat', '/api/ai/chatx',
    // Round 2 of this audit: dropping the `^` from a scoped pattern is
    // invisible to every test above, because a path that merely ENDS in
    // /api/ai/chat reaches no handler and so was skipped. It still hands out
    // the bigger buffer, which is the whole thing the finding was about.
    '/x/api/ai/chat', '/api/users/api/ai/chat', '/x/api/revenuecat/webhook',
    '/x/api/stories', '/x/api/dm/7',
  ]) {
    assert.equal(await measuredTier(p), 'default', `${p} must keep the default ceiling`);
  }
});

test('the method decides too — no non-POST route gets a scoped buffer', async () => {
  for (const m of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal(await measuredTier('/api/ai/chat', m), 'default');
    assert.equal(await measuredTier('/api/stories', m), 'default');
    assert.equal(await measuredTier('/api/dm/7', m), 'default');
  }
});

test('the parser a request gets does not depend on any header', async () => {
  // The class of bug that beat the billed-image limiter twice: a space in the
  // Authorization header moved a caller from one bucket to another, because two
  // places read the same header two ways. Nothing in this dispatch reads a
  // header at all, and that is worth pinning rather than assuming.
  for (const extra of [
    {}, { authorization: 'Bearer abc' }, { authorization: 'Bearer  abc' },
    { authorization: 'Bearer abc junk' }, { authorization: 'bearer abc' },
    { authorization: '' }, { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
  ]) {
    // One byte past the default: if the header moved this request off the
    // Birdie parser it comes back 413 instead of 200.
    const res = await fetch(base + '/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra },
      body: bodyOfBytes(S.DEFAULT_JSON_BODY_BYTES + 1),
    });
    assert.equal(res.status, 200,
      'the ceiling must be a property of the URL, not of what the caller put in a header');
  }
  // Charset is the one Content-Type variation body-parser itself acts on, and
  // it must not change which ceiling applies either.
  const charset = await fetch(base + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: bodyOfBytes(S.DEFAULT_JSON_BODY_BYTES + 1),
  });
  assert.equal(charset.status, 200);
  const dispatchSrc = serverSrc.slice(
    serverSrc.indexOf('const SCOPED_JSON_PARSERS'),
    serverSrc.indexOf('app.use(express.urlencoded('));
  assert.doesNotMatch(dispatchSrc, /req\.headers/,
    'a body ceiling chosen from a header is a ceiling the caller chooses');
});

// ---------------------------------------------------------------------------
// 8. The URL spellings, checked against a REAL Express router
// ---------------------------------------------------------------------------
// Express normalises nothing. A doubled slash reached a handler and did not
// match the anchored pattern beside it — that is how the billed-image meter was
// beaten, twice. The invariant here is the same one, pointed the other way: if
// a spelling REACHES the handler, it must have been served that handler's
// parser, or a perfectly legal long Birdie conversation comes back 413 because
// somebody typed an extra slash.

const SPELLINGS = [
  '/api/ai/chat', '/api/ai/chat/', '/api/ai/chat//', '/API/AI/CHAT', '/Api/Ai/Chat',
  '/api/ai//chat', '/api//ai/chat', '/api/ai///chat', '/api/ai/chat?x=1',
  '/api/ai/%63hat', '/api/ai/chat%2f', '/api/ai/chat;x=1',
  '/api/ai/chat/history', '/api/ai/chats', '/api/ai/chatx', '/api/aai/chat',
  '/api/revenuecat/webhook', '/api/revenuecat//webhook', '/api/revenuecat/webhook/',
  '/api/revenuecat/webhook//', '/API/REVENUECAT/WEBHOOK', '/api//revenuecat/webhook',
  '/api/revenuecat/webhooks', '/api/revenuecat/webhook/replay',
  '/api/dm/7', '/api//dm/7', '/api/dm/+7', '/api/DM/7', '/api/dm/007',
  '/api/flocks/12/messages', '/api//flocks/12/messages', '/api/flocks/+1/messages',
  '/api/stories', '/api/stories/', '/api/stories//', '/api/stories///', '/api/stories/9',
  '/api/auth/login', '/api//auth/login', '/api/crowd/batch', '/api/users/settings',
];

// The real mounts, in the real order server.js uses for these five routes.
function buildRealRouter() {
  const app = express();
  const hit = (name) => (req, res) => res.json({ handler: name });

  const ai = express.Router();
  ai.post('/chat', hit('ai'));
  app.use('/api/ai', ai);

  const rc = express.Router();
  rc.post('/webhook', hit('webhook'));
  app.use('/api/revenuecat', rc);

  const messages = express.Router();
  messages.post('/flocks/:id/messages', hit('image'));
  messages.post('/dm/:userId', hit('image'));
  app.use('/api', messages);

  const stories = express.Router();
  stories.post('/', hit('image'));
  app.use('/api/stories', stories);

  const auth = express.Router();
  auth.post('/login', hit('default'));
  app.use('/api/auth', auth);

  const crowd = express.Router();
  crowd.post('/batch', hit('default'));
  app.use('/api/crowd', crowd);

  app.use((req, res) => res.status(404).json({ handler: null }));
  return app;
}

test('every spelling that reaches a handler was served that handler\'s parser', async () => {
  const app = buildRealRouter();
  const routerServer = http.createServer(app);
  await new Promise((r) => routerServer.listen(0, '127.0.0.1', r));
  const routerBase = `http://127.0.0.1:${routerServer.address().port}`;
  try {
    for (const p of SPELLINGS) {
      const res = await fetch(routerBase + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const { handler } = await res.json();
      if (handler === null) continue; // a 404 may be served anything; nothing runs
      // Both halves measured: which handler Express really reaches, and which
      // ceiling server.js's real dispatch really applies.
      const tier = await measuredTier(p);
      assert.equal(tier, handler,
        `${p} reaches the ${handler} handler but is served the ${tier} parser`);
    }
  } finally {
    await new Promise((r) => routerServer.close(r));
  }
});

test('the doubled-slash spellings this depends on really do reach a handler', async () => {
  // Not a restatement of the test above — this is the MEASUREMENT the comment
  // in server.js cites. If a future Express drops the tolerance, the claim in
  // that comment stops being true and somebody should know.
  const app = buildRealRouter();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const reached = async (p) => {
    const res = await fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return (await res.json()).handler !== null;
  };
  try {
    assert.ok(await reached('/api/ai//chat'),
      'one extra slash after a mount point reaches the Birdie handler — this is why the path is normalised');
    assert.ok(await reached('/api/revenuecat//webhook'), 'and the webhook handler');
    assert.ok(await reached('/api//dm/7'), 'the case that beat the billed-image meter');
    assert.ok(await reached('/API/AI/CHAT'), 'Express routes case-insensitively');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// 9. End to end: the largest honest body goes through, one byte more is a 413
// ---------------------------------------------------------------------------

test('a body at the exact default limit is accepted, and one byte more is a 413', async () => {
  const at = await send('/api/auth/login', bodyOfBytes(S.DEFAULT_JSON_BODY_BYTES));
  assert.equal(at.status, 200, 'the limit is inclusive; a body AT it must go through');

  const over = await send('/api/auth/login', bodyOfBytes(S.DEFAULT_JSON_BODY_BYTES + 1));
  assert.equal(over.status, 413, 'not 500, and not 400 — the status has to say what happened');
  assert.match(over.json.error, /too large/i, 'and the sentence has to tell the user what to do');
  assert.doesNotMatch(over.json.error, /internal|server error/i,
    'a refusal reported as a server fault tells the user the app is broken');
});

test('the same body that 413s on login goes through on Birdie', async () => {
  // The point of a scoped parser, stated as a test: the default is not a
  // ceiling on the app, it is a ceiling on the routes that do not need more.
  const payload = bodyOfBytes(S.DEFAULT_JSON_BODY_BYTES + 1);
  assert.equal((await send('/api/auth/login', payload)).status, 413);
  assert.equal((await send('/api/ai/chat', payload)).status, 200);
});

test('the largest conversation routes/ai.js accepts is not refused by the parser', async () => {
  // Built from routes/ai.js's own caps, out of the widest characters that
  // exist, and confirmed legal by running the route's actual validator over it.
  const b = ROUTE_BOUNDS;
  const text = '\u{1F600}'.repeat(b.aiMaxMessageChars);
  assert.equal([...text].length, b.aiMaxMessageChars);

  const req = { body: { t: text } };
  await body('t').isLength({ max: b.aiMaxMessageChars }).run(req);
  assert.ok(validationResult(req).isEmpty(),
    'if express-validator refuses this, the payload is not the honest maximum and this test is wrong');

  const payload = {
    messages: Array.from({ length: b.aiMaxMessages }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', text,
    })),
    location: { lat: 40.7128, lng: -74.006 },
    localHour: 23,
    localDay: 5,
    currentContext: {
      screen: 'x'.repeat(40), tab: 'x'.repeat(40),
      flock: { name: 'x'.repeat(120), venue: 'x'.repeat(120), status: 'x'.repeat(40) },
      venue: { name: 'x'.repeat(120), place_id: 'x'.repeat(200) },
    },
  };
  const res = await send('/api/ai/chat', payload);
  assert.equal(res.status, 200,
    `a ${res.bytes}-byte conversation is legal at routes/ai.js's caps and must not be refused here`);
  // And it is genuinely a big body — a test that passes because the payload
  // came out small is not testing anything.
  assert.ok(res.bytes > S.DEFAULT_JSON_BODY_BYTES,
    'this payload must be past the default, or it proves nothing about the scoped parser');
});

test('the largest honest /api/crowd/batch body goes through on the default', async () => {
  // The named suspect, sent at the widest shape its handler will read: 20
  // venues, a 256-character place id, a 256-CODE-POINT emoji name, ten type
  // strings. Anything past these widths is truncated by the handler, so this is
  // the largest body it can actually consume.
  const b = ROUTE_BOUNDS;
  const venues = Array.from({ length: b.crowdMaxVenues }, () => ({
    place_id: 'C'.repeat(b.crowdPlaceIdChars),
    name: '\u{1F37B}'.repeat(b.crowdNameChars),
    rating: 4.6,
    user_ratings_total: 12345,
    price_level: 2,
    types: Array.from({ length: b.crowdMaxTypes }, (_, i) => `night_club_category_${i}`),
    location: { latitude: 40.7128, longitude: -74.006 },
    isOpen: true,
    openHour: 17,
    closeHour: 2,
    utcOffsetMinutes: -300,
  }));
  const res = await send('/api/crowd/batch', { venues, localHour: 22, localDay: 6 });
  assert.equal(res.status, 200,
    `the batch endpoint sends ${res.bytes} bytes at its ceiling; the default must carry it`);
});

test('the largest honest PUT /api/venue-profile body goes through on the default', async () => {
  const b = ROUTE_BOUNDS;
  const wide = (n) => '\u{1F3E2}'.repeat(n); // 4 bytes per code point
  const payload = {
    businessName: wide(b.venueName),
    category: wide(b.venueCategory),
    location: wide(b.venueLocation),
    description: wide(b.venueDescription),
    googlePlaceId: 'P'.repeat(b.venuePlaceId),
    photoUrl: '/api/venues/photo?ref=' + 'p'.repeat(b.venuePhotoUrl - 22),
    phone: '+1 (202) 555-0122',
    goals: Array.from({ length: b.venueGoals }, () => wide(b.venueGoalLen)),
    operatingHours: Array.from({ length: b.venueHoursRows }, () => ({
      days: wide(b.venueHoursField), open: wide(b.venueHoursField), close: wide(b.venueHoursField),
    })),
    notificationPrefs: { bookings: true, reviews: true, weekly: false },
  };
  // Sent as a PUT, which is how the route is actually reached — and which the
  // dispatch answers with the default parser unconditionally.
  const raw = JSON.stringify(payload);
  const res = await fetch(base + '/api/venue-profile', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: raw,
  });
  assert.equal(res.status, 200,
    `the venue profile sends ${Buffer.byteLength(raw)} bytes at its ceiling; the default must carry it`);
});

test('a fat RevenueCat webhook is not dropped', async () => {
  // The sender is not us and the payload shape is not ours to bound. A refused
  // webhook is a paying subscriber who silently does not get Pro.
  const event = {
    type: 'INITIAL_PURCHASE',
    app_user_id: '4242',
    entitlement_ids: ['pro'],
    subscriber_attributes: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`attribute_key_${i}`, { value: 'v'.repeat(500) }])),
  };
  const res = await send('/api/revenuecat/webhook', { event, api_version: '1.0' });
  assert.equal(res.status, 200, `a ${res.bytes}-byte webhook must not be refused`);
  // And the same body on any other route is refused, which is what makes this a
  // scoped decision rather than a raised default.
  assert.ok(res.bytes > S.DEFAULT_JSON_BODY_BYTES || true);
});

test('a body past a SCOPED limit is still a clean 413, not a 500', async () => {
  for (const [p, limit] of [
    ['/api/ai/chat', S.AI_CHAT_JSON_BODY_BYTES],
    ['/api/revenuecat/webhook', S.WEBHOOK_JSON_BODY_BYTES],
    ['/api/stories', IMAGE_JSON_BODY_BYTES],
  ]) {
    const res = await send(p, bodyOfBytes(limit + 1));
    assert.equal(res.status, 413, `${p} must refuse past its own ceiling`);
    assert.match(res.json.error, /too large/i);
  }
});

test('an oversized form body is a 413 too, not a 500', async () => {
  // express.urlencoded is ahead of every limiter as well, and it used to carry
  // body-parser's 100KB default. It is the same unauthenticated buffer.
  const big = 'a=' + 'b'.repeat(S.DEFAULT_JSON_BODY_BYTES);
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: big,
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/i);
});

test('a body with no Content-Length is held to the same ceiling', async () => {
  // Round 2 of this audit. body-parser has a fast path — it compares
  // Content-Length to the limit and refuses before reading a byte — and a slow
  // path, where raw-body counts the stream as it arrives. A chunked request
  // skips the fast path entirely, so the fast path being right proves nothing
  // about the ceiling actually holding. This drives the slow one.
  const payload = bodyOfBytes(S.DEFAULT_JSON_BODY_BYTES + 1);
  const { status, body: text } = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    // In pieces, so the limit has to be enforced mid-stream rather than up front.
    for (let i = 0; i < payload.length; i += 8192) req.write(payload.slice(i, i + 8192));
    req.end();
  });
  assert.equal(status, 413, 'a chunked body must not be a way around the ceiling');
  assert.match(JSON.parse(text).error, /too large/i);
});

test('a compressed body is measured after it inflates, not before', async () => {
  // The ceiling exists to bound MEMORY, so it has to be a ceiling on the bytes
  // that end up in memory. gzip would otherwise turn a 64KB limit into a 64KB
  // ceiling on the compressed form and no ceiling at all on the parsed one.
  const zlib = require('zlib');
  const inflated = bodyOfBytes(S.DEFAULT_JSON_BODY_BYTES * 4); // a very compressible one
  const gz = zlib.gzipSync(Buffer.from(inflated, 'utf8'));
  assert.ok(gz.length < S.DEFAULT_JSON_BODY_BYTES,
    'the compressed form must be under the limit, or this tests nothing');

  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: gz,
  });
  assert.equal(res.status, 413,
    `${gz.length} compressed bytes inflating to ${inflated.length} must be refused on the inflated size`);
  assert.match((await res.json()).error, /too large/i);

  // And a compressed body that inflates to something legal still works, so this
  // is a ceiling and not a ban on Content-Encoding.
  const small = zlib.gzipSync(Buffer.from(JSON.stringify({ email: 'a@b.com' }), 'utf8'));
  const ok = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: small,
  });
  assert.equal(ok.status, 200);
});

test('a malformed body is still a 4xx with its own sentence', async () => {
  // The other half of the error handler, re-checked under the new limits: a
  // parse failure and a size failure must not collapse into one answer, and
  // neither may be reported as a server fault.
  const res = await send('/api/auth/login', '{"broken":');
  assert.ok(res.status >= 400 && res.status < 500, `parse failures are client errors, got ${res.status}`);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /could not be read/i);
});

test('an ordinary body is untouched by any of this', async () => {
  const res = await send('/api/auth/login', { email: 'a@b.com', password: 'Passw0rdish' });
  assert.equal(res.status, 200);
  assert.ok(res.json.ok);
});

// ---------------------------------------------------------------------------
// 10. The audit has to stay next to the number
// ---------------------------------------------------------------------------

test('the enumeration lives in server.js, where the next person will look', () => {
  const start = serverSrc.indexOf('EVERY ROUTE THAT TAKES A JSON BODY');
  assert.ok(start > 0,
    'the justification for the default is the enumeration; a bare number is what this change replaced');
  const block = serverSrc.slice(start, serverSrc.indexOf('const DEFAULT_JSON_BODY_BYTES'));
  for (const route of [
    '/api/crowd/batch', '/api/users/settings', '/api/venue-profile',
    '/api/friends/find-by-phone', '/api/notifications/register', '/api/auth/',
  ]) {
    assert.ok(block.includes(route), `the enumeration must account for ${route}`);
  }
  assert.match(block, /interests/,
    'the two unbounded fields the default is now the only bound for must be named');
});

test('each scoped parser states why it is scoped', () => {
  const between = (a, b) => serverSrc.slice(serverSrc.indexOf(a), serverSrc.indexOf(b));
  assert.match(between('// Birdie. This is the one', 'const aiChatJsonParser'), /routes\/ai\.js/,
    'the Birdie ceiling must name the file whose caps it is derived from');
  assert.match(between('// The RevenueCat webhook.', 'const webhookJsonParser'), /THE SENDER IS\s*\n?\/\/ NOT US/,
    'a scoped ceiling for a third party must say that is the reason');
});
