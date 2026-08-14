// Run: node --test  (from backend/)
//
// MONEY. Every image this app accepts costs a billed Google Cloud Vision call
// (utils/moderation.js), and the two transports that carry the same photo were
// metered very differently:
//
//   * the socket charges a 'send_image' bucket of 10 per 60 seconds per
//     connection, and allowEvent charges the ACCOUNT twice that across every
//     connection it holds — so one account buys at most 20 billed screens a
//     minute over the socket, from any number of addresses;
//   * the REST twins of those same sends — POST /api/flocks/:id/messages and
//     POST /api/dm/:userId — had no per-image bucket at all. Their only ceiling
//     was apiLimiter at 3000 per 15 minutes, i.e. 200 requests a minute and
//     therefore up to 200 billed calls a minute, per address, with a fresh 200
//     from every address the caller can reach us from.
//
// So the FALLBACK transport was an order of magnitude cheaper to abuse than the
// primary one it exists to back up, and __tests__/paidCallBudgets.test.js — the
// file whose whole subject is billed upstreams — never mentioned this path.
//
// Two more billed doors are covered here for the same reason, because closing
// only the two named above would have been theatre: POST /api/stories reaches
// moderateImage on every request and its flood control counts STORED rows, so a
// caller posting images that are refused never trips it; and POST
// /api/users/upload-image screens every avatar with no per-image ceiling at all.
//
// HOW THIS FILE TESTS server.js. server.js calls boot() on require
// (scripts/e2e-local.js depends on that), so it cannot be imported: doing so
// would run migrations, open a port, and process.exit(1) when Postgres is not
// there. The limiter's declarations are therefore lifted out of the source and
// EXECUTED — the key function, the "is this request billable" predicate and the
// express-rate-limit instance below are server.js's own code, not a restatement
// of it — and the wiring around them is asserted against the source text.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'image-spend-limits-test-secret';

const { TOKEN_ALGORITHMS, signUserToken } = require('../middleware/auth');
const {
  allowEvent,
  clearBuckets,
  __resetRateLimiters,
  USER_LIMIT_MULTIPLIER,
  CHAT_IMAGE_MAX_BYTES,
  checkInboundImage,
} = require('../sockets/handlers');

const BACKEND = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
const handlersSrc = fs.readFileSync(path.join(BACKEND, 'sockets', 'handlers.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. The meter the REST side has to agree with, exercised for real
// ---------------------------------------------------------------------------
// The socket's numbers are literals at its call sites rather than exported
// constants, so this establishes what they DO before anything below claims to
// mirror them.

const fakeSocket = (id, userId) => ({ id, user: { id: userId } });

test('the socket charges an image send its own bucket: 10 per connection per minute', () => {
  __resetRateLimiters();
  const s = fakeSocket('sock-a', 501);
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(allowEvent(s, 'send_image', 10, 60_000), true, `image ${i + 1} should pass`);
  }
  assert.strictEqual(allowEvent(s, 'send_image', 10, 60_000), false,
    'the eleventh photo in a minute is the one the bucket exists to refuse');
  clearBuckets(s);
});

test('and the ACCOUNT ceiling holds across every connection it opens', () => {
  __resetRateLimiters();
  // Fresh sockets are free, so the per-connection bucket alone is not a
  // ceiling. The per-user bucket is, and it is the number REST must not exceed.
  let allowed = 0;
  for (let n = 0; n < 8; n++) {
    const s = fakeSocket(`sock-${n}`, 502);
    for (let i = 0; i < 10; i++) if (allowEvent(s, 'send_image', 10, 60_000)) allowed++;
  }
  assert.strictEqual(allowed, 10 * USER_LIMIT_MULTIPLIER,
    'one account can buy exactly USER_LIMIT_MULTIPLIER x 10 billed screens a minute over the socket');
});

// ---------------------------------------------------------------------------
// 2. server.js's limiter, lifted out of the source and run
// ---------------------------------------------------------------------------

// Same technique as __tests__/chatTransportParity.test.js: the regex literals
// are our own source, evaluated rather than retyped.
function imageBodyRouteRegexes() {
  const block = /const IMAGE_BODY_ROUTES = \[([\s\S]*?)\];/.exec(serverSrc);
  assert.ok(block, 'server.js must declare IMAGE_BODY_ROUTES');
  const found = block[1].match(/\/\^[^\n]*?\/[a-z]*(?=,|\s*$)/gm) || [];
  assert.ok(found.length >= 3, `expected the image routes to be listed, found ${found.length}`);
  // eslint-disable-next-line no-eval
  return found.map((literal) => eval(literal)); // literals from our own source
}

// Everything from AVATAR_UPLOAD_ROUTE down to (but not including) the app.use
// that mounts it. If that block is deleted or renamed this throws, which is the
// point: there is no version of "the limiter was removed" that leaves this file
// green.
function loadSpendLimiterBlock() {
  const start = serverSrc.indexOf('const AVATAR_UPLOAD_ROUTE');
  const end = serverSrc.indexOf('app.use((req, res, next) => (carriesBilledImage(req)');
  assert.ok(start > 0, 'server.js must declare AVATAR_UPLOAD_ROUTE');
  assert.ok(end > start, 'server.js must mount the billed-image limiter');
  const body = serverSrc.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'rateLimit', 'jwt', 'TOKEN_ALGORITHMS', 'checkInboundImage', 'IMAGE_BODY_ROUTES', 'imageRoutePath', 'isDev',
    `${body}\nreturn { AVATAR_UPLOAD_ROUTE, billedImageKey, carriesBilledImage, imageSpendLimiter,
       IMAGE_SCREENS_PER_WINDOW, IMAGE_SCREEN_WINDOW_MS, IMAGE_RATE_LIMIT_MESSAGE };`
  );
  return factory(
    rateLimit, jwt, TOKEN_ALGORITHMS, checkInboundImage,
    imageBodyRouteRegexes(), imageRoutePathFn(), false
  );
}

// The path normaliser both the parser and the meter match against, again taken
// from server.js rather than retyped.
function imageRoutePathFn() {
  const line = /const imageRoutePath = ([^\n]*);/.exec(serverSrc);
  assert.ok(line, 'server.js must normalise the path it matches these routes against');
  // eslint-disable-next-line no-eval
  return eval(`(${line[1]})`);
}

const S = loadSpendLimiterBlock();

// The socket's allowance is written as literals at its two call sites rather
// than as an exported constant, so it is read back out of the file. Both call
// sites must agree, or "the socket's meter" is not one number.
function socketImageMeter() {
  const found = [...handlersSrc.matchAll(/allowEvent\(socket, 'send_image', ([\d_]+), ([\d_]+)\)/g)]
    .map((m) => [Number(m[1].replace(/_/g, '')), Number(m[2].replace(/_/g, ''))]);
  assert.strictEqual(found.length, 2, 'flock chat and DMs both meter their image sends');
  assert.deepStrictEqual(found[0], found[1], 'and they meter it identically');
  return { limit: found[0][0], windowMs: found[0][1] };
}

test('the REST meter is the socket meter, not a number somebody picked', () => {
  const socket = socketImageMeter();
  assert.strictEqual(S.IMAGE_SCREENS_PER_WINDOW, socket.limit,
    'the REST allowance must track the socket allowance; move one and you move both');
  assert.strictEqual(S.IMAGE_SCREEN_WINDOW_MS, socket.windowMs, 'and over the same window');
});

test('REST never permits more billed screens per minute than the socket does', () => {
  const socket = socketImageMeter();
  assert.strictEqual(socket.windowMs, S.IMAGE_SCREEN_WINDOW_MS, 'compare like with like');
  assert.ok(
    S.IMAGE_SCREENS_PER_WINDOW <= socket.limit * USER_LIMIT_MULTIPLIER,
    'the fallback transport must not be the cheap door into the Vision invoice'
  );
  // And the ceiling it used to sit behind, for scale: apiLimiter is 3000 per 15
  // minutes, i.e. 200 requests — and so up to 200 billed calls — a minute.
  assert.ok(S.IMAGE_SCREENS_PER_WINDOW < (3000 / 15) / 10,
    'the general API limiter was never a spending control');
});

// The real predicate, driven the way the mounted middleware drives it.
const post = (path, body) => ({ method: 'POST', path, body, headers: {} });
const dataUrl = (n) => 'data:image/png;base64,' + 'A'.repeat(n - 'data:image/png;base64,'.length);
const A_PHOTO = { image_url: dataUrl(4096) };
const billable = (p) => S.carriesBilledImage(post(p, A_PHOTO));

test('every route that can reach a billed Vision call is metered', () => {
  for (const p of [
    '/api/flocks/12/messages',   // REST twin of send_message
    '/api/dm/7',                 // REST twin of send_dm
    '/api/stories',              // story photo
    '/api/users/upload-image',   // avatar
    '/api/DM/7',                 // Express routes case-insensitively
    '/api/stories/',             // a trailing slash reaches the same handler
  ]) {
    assert.ok(billable(p), `${p} reaches moderateImage and must be metered`);
  }
  // And nothing else: metering a route that cannot spend money is a limit on
  // ordinary use with no saving to show for it.
  for (const p of [
    '/api/auth/login', '/api/waitlist', '/api/flocks', '/api/dm', '/api/dm/7/read',
    '/api/dm/7/venue-votes', '/api/stories/9', '/api/messages/9/react', '/api/users/profile-image',
  ]) {
    assert.ok(!billable(p), `${p} spends nothing and must not be metered`);
  }
});

test('a URL spelt differently is the same URL as far as the meter is concerned', () => {
  // Both of these reach the very same handlers, verified against a real Express
  // router while auditing this limiter, and neither matched the anchored
  // patterns as they were written. A meter a caller can step around by typing
  // an extra slash is not a meter.
  for (const p of [
    '/api//dm/7',                  // Express does not collapse repeated slashes
    '/api///dm/7',
    '/api//flocks/1/messages',
    '/api/stories//',
    '/api/users//upload-image',
    '/api/dm/+7',                  // isInt() accepts a leading plus; parseInt reads 7
    '/api/dm/%2B7',                // and the encoded spelling of the same thing
    '/api/flocks/+1/messages',
    '/api/dm/007',
  ]) {
    assert.ok(billable(p), `${p} reaches a billed handler and must be metered`);
  }
});

// ---------------------------------------------------------------------------
// 3. What gets charged — free refusals stay free
// ---------------------------------------------------------------------------

test('an ordinary text message over REST is not charged a photo token', () => {
  // These three URLs carry text and photos alike. Charging the text would meter
  // normal chat to protect an invoice text cannot run up.
  for (const body of [{ message_text: 'hi' }, { message_text: 'hi', image_url: '' }, {}]) {
    assert.strictEqual(S.carriesBilledImage(post('/api/flocks/12/messages', body)), false,
      `${JSON.stringify(body)} carries no image`);
  }
  assert.strictEqual(checkInboundImage(''), null,
    'the empty string means "no image" on both transports; this must read it the same way');
});

test('a photo that will be refused for free does not spend the allowance', () => {
  // Same ordering the socket uses: its format and size checks run AHEAD of the
  // bucket, so a photo that could never work does not cost the user a token
  // they need for one that would.
  for (const image_url of [
    dataUrl(CHAT_IMAGE_MAX_BYTES + 1),      // oversized
    'https://tracker.example/pixel.png',    // not a data: URL
    'data:text/html;base64,PHNjcmlwdD4=',   // not an image
    false, 0, { nested: true }, ['data:image/png;base64,AAAA'],
  ]) {
    assert.strictEqual(S.carriesBilledImage(post('/api/dm/7', { image_url })), false,
      `${String(image_url)} is refused from the bytes alone and must cost nothing`);
  }
});

test('a real photo is charged, on every route that would screen it', () => {
  const image_url = dataUrl(4096);
  for (const p of ['/api/flocks/12/messages', '/api/dm/7', '/api/stories']) {
    assert.strictEqual(S.carriesBilledImage(post(p, { image_url })), true, p);
  }
  // The avatar upload is multipart, so there is no parsed image_url to look at
  // — but every POST to it is an image by definition.
  assert.strictEqual(S.carriesBilledImage(post('/api/users/upload-image', undefined)), true);
  // A GET cannot spend anything.
  assert.strictEqual(
    S.carriesBilledImage({ method: 'GET', path: '/api/stories', headers: {} }), false);
});

// ---------------------------------------------------------------------------
// 4. Identity: the account, not the address
// ---------------------------------------------------------------------------

test('a signed-in caller is metered by account, so rotating addresses buys nothing', () => {
  const token = signUserToken({ id: 4242, token_version: 0 });
  const fromHome = { headers: { authorization: `Bearer ${token}` }, ip: '203.0.113.9' };
  const fromCafe = { headers: { authorization: `Bearer ${token}` }, ip: '198.51.100.4' };
  assert.strictEqual(S.billedImageKey(fromHome), 'user:4242');
  assert.deepStrictEqual(S.billedImageKey(fromHome), S.billedImageKey(fromCafe),
    'the socket meter cannot be beaten by changing address and neither may this one');
});

test('two accounts behind one address do not share an allowance', () => {
  const shared = '203.0.113.50';
  const a = { headers: { authorization: `Bearer ${signUserToken({ id: 11, token_version: 0 })}` }, ip: shared };
  const b = { headers: { authorization: `Bearer ${signUserToken({ id: 12, token_version: 0 })}` }, ip: shared };
  assert.notStrictEqual(S.billedImageKey(a), S.billedImageKey(b),
    'one household or one school on a shared address must not be one bucket');
});

test('a header the router authenticates is a header this meter recognises', () => {
  // Found re-auditing the key function. middleware/auth.js reads the token as
  // `header.split(' ')[1]`, so `Bearer <valid> junk` is an authenticated
  // request — while reading the same header as `slice(7)` hands jwt.verify a
  // string with trailing junk, which throws, and drops that caller out of their
  // account's bucket into the shared per-address one. A caller who can choose
  // which bucket they land in by adding a space to their own header is a caller
  // who is not metered by account at all.
  const token = signUserToken({ id: 777, token_version: 0 });
  const asRouterReadsIt = (h) => (h.startsWith('Bearer ') ? h.split(' ')[1] : null);

  for (const header of [`Bearer ${token}`, `Bearer ${token} junk`, `Bearer ${token} `]) {
    assert.ok(
      jwt.verify(asRouterReadsIt(header), process.env.JWT_SECRET, { algorithms: TOKEN_ALGORITHMS }),
      'precondition: the router accepts this header'
    );
    assert.strictEqual(S.billedImageKey({ headers: { authorization: header }, ip: '203.0.113.1' }),
      'user:777', `${JSON.stringify(header)} authenticates, so it must be metered by account`);
  }
});

test('a forged or absent token cannot mint a bucket', () => {
  const ip = '203.0.113.77';
  const forged = jwt.sign({ userId: 9999, tv: 0 }, 'not-the-real-secret');
  const alg = jwt.sign({ userId: 9999, tv: 0 }, process.env.JWT_SECRET, { algorithm: 'none' });
  for (const authorization of [undefined, '', 'Bearer', 'Bearer garbage', `Bearer ${forged}`, `Bearer ${alg}`]) {
    assert.strictEqual(S.billedImageKey({ headers: { authorization }, ip }), `addr:${ip}`,
      `an unusable token must fall back to the address, not to a bucket of its own: ${authorization}`);
  }
  // Two different forgeries must not be two different buckets.
  const other = jwt.sign({ userId: 1234, tv: 0 }, 'still-not-the-secret');
  assert.strictEqual(S.billedImageKey({ headers: { authorization: `Bearer ${other}` }, ip }), `addr:${ip}`);
});

// ---------------------------------------------------------------------------
// 5. The limiter, mounted and driven
// ---------------------------------------------------------------------------
// server.js's own rateLimit instance, in front of a stub that stands in for the
// four billed routes. What is being proved is the ceiling and its scope, so the
// handler does nothing but answer 201.

const app = express();
app.use(express.json({ limit: CHAT_IMAGE_MAX_BYTES + 64 * 1024 }));
app.use((req, res, next) => (S.carriesBilledImage(req) ? S.imageSpendLimiter(req, res, next) : next()));
app.post('*', (req, res) => res.status(201).json({ ok: true }));

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => { server.close(() => resolve()); }));

async function send(path, body, token) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

const PHOTO = A_PHOTO;
let nextTestUser = 90000;
const freshToken = () => signUserToken({ id: nextTestUser++, token_version: 0 });

test('the eleventh photo in a minute is refused, in the socket‘s own words', async () => {
  const token = freshToken();
  for (let i = 0; i < S.IMAGE_SCREENS_PER_WINDOW; i++) {
    const res = await send('/api/flocks/12/messages', PHOTO, token);
    assert.strictEqual(res.status, 201, `photo ${i + 1} should go through`);
  }
  const refused = await send('/api/flocks/12/messages', PHOTO, token);
  assert.strictEqual(refused.status, 429);
  assert.strictEqual(refused.body.error, S.IMAGE_RATE_LIMIT_MESSAGE);
  // The sentence is the socket's, verbatim: one condition described two ways
  // reads to a user as two different products.
  assert.ok(handlersSrc.includes(`'${S.IMAGE_RATE_LIMIT_MESSAGE}'`),
    'the REST refusal must be the same sentence the socket emits');
});

test('alternating between the four billed routes shares one allowance', async () => {
  // The obvious way to defeat a per-route bucket: spread the spend. There is
  // one bucket per account for all of them, so the sum is the ceiling.
  const token = freshToken();
  const paths = ['/api/flocks/1/messages', '/api/dm/2', '/api/stories', '/api/users/upload-image'];
  let ok = 0;
  for (let i = 0; i < S.IMAGE_SCREENS_PER_WINDOW + 4; i++) {
    const res = await send(paths[i % paths.length], PHOTO, token);
    if (res.status === 201) ok++;
  }
  assert.strictEqual(ok, S.IMAGE_SCREENS_PER_WINDOW,
    'rotating routes must not buy a fresh bucket per route');
});

test('sending to different conversations does not buy a fresh allowance', async () => {
  // The bucket is keyed by who is spending, never by what they are spending it
  // on: a caller with 5000 flock ids to aim at is still one caller.
  const token = freshToken();
  let ok = 0;
  for (let i = 0; i < S.IMAGE_SCREENS_PER_WINDOW + 3; i++) {
    const res = await send(`/api/dm/${100 + i}`, PHOTO, token);
    if (res.status === 201) ok++;
  }
  assert.strictEqual(ok, S.IMAGE_SCREENS_PER_WINDOW);
});

test('text messages keep flowing after the photo allowance is spent', async () => {
  // The failure this must not have: metering photos and taking ordinary chat
  // down with them. A conversation is not a photo.
  const token = freshToken();
  for (let i = 0; i < S.IMAGE_SCREENS_PER_WINDOW + 5; i++) await send('/api/dm/3', PHOTO, token);
  const spent = await send('/api/dm/3', PHOTO, token);
  assert.strictEqual(spent.status, 429, 'the photo allowance is gone');

  for (let i = 0; i < 25; i++) {
    const res = await send('/api/dm/3', { message_text: `still talking ${i}` }, token);
    assert.strictEqual(res.status, 201, 'text is not metered by the photo bucket');
  }
});

test('one account running out does not refuse anybody else', async () => {
  const heavy = freshToken();
  for (let i = 0; i < S.IMAGE_SCREENS_PER_WINDOW + 2; i++) await send('/api/stories', PHOTO, heavy);
  assert.strictEqual((await send('/api/stories', PHOTO, heavy)).status, 429);
  assert.strictEqual((await send('/api/stories', PHOTO, freshToken())).status, 201,
    'a per-account meter must not become a global outage');
});

// ---------------------------------------------------------------------------
// 6. The wiring in server.js, which the block above cannot see
// ---------------------------------------------------------------------------

test('the limiter is mounted, once, ahead of every router', () => {
  const mount = serverSrc.indexOf('app.use((req, res, next) => (carriesBilledImage(req)');
  assert.ok(mount > 0, 'the billed-image limiter must actually be mounted');
  const firstRouter = serverSrc.indexOf("app.use('/api/auth'");
  assert.ok(firstRouter > mount,
    'a limiter mounted after the routers never runs for the routes it is supposed to meter');
  assert.strictEqual(
    (serverSrc.match(/carriesBilledImage\(req\) \? imageSpendLimiter/g) || []).length, 1,
    'one mount, or the buckets are charged twice for one photo');
});

test('the limiter sits AFTER the body parser, and the comment says so', () => {
  // Not an accident and not free. express.json() is mounted ahead of every
  // route and every limiter, so the body is already in memory by the time this
  // runs: the refusal saves the billed call, the row and the fan-out, but it
  // does NOT save the buffer. Moving it earlier would recover the buffer and
  // would meter plain text messages, which arrive on the same URLs and cannot
  // be told apart from photos before the body is parsed.
  const parser = serverSrc.indexOf('const imageJsonParser');
  const limiter = serverSrc.indexOf('const imageSpendLimiter');
  assert.ok(parser > 0 && limiter > parser,
    'the predicate reads req.body, so it cannot run before the parser');
  const block = serverSrc.slice(serverSrc.indexOf('Billed image screening'), limiter);
  assert.match(block, /buffer is genuinely not recovered/,
    'the limit of what this saves must stay written down where it is claimed');
});

test('the key generator verifies the token rather than trusting it', () => {
  const fn = /function billedImageKey\(req\) \{[\s\S]*?\n\}/.exec(serverSrc);
  assert.ok(fn, 'server.js must derive the bucket key in a named function');
  assert.match(fn[0], /jwt\.verify\(/, 'an unverified id lets a caller mint buckets from forged tokens');
  assert.match(fn[0], /TOKEN_ALGORITHMS/,
    'the accepted algorithms must come from middleware/auth.js, never a second list here');
});

// ---------------------------------------------------------------------------
// 7. The advertised photo size is derived, in both files that advertise one
// ---------------------------------------------------------------------------
// Different subject, same failure mode as everything above: a number a user is
// told and a number the server enforces, with the conversion between them done
// in somebody's head.

const storyLimits = require('../routes/stories').__test;
const avatarLimits = require('../routes/users').__testing;

const encodedSize = (photoKb, mime = 'image/jpeg') =>
  Buffer.byteLength(`data:${mime};base64,${Buffer.alloc(photoKb * 1024).toString('base64')}`);

test('a photo of exactly the advertised avatar size actually uploads', () => {
  // The property that matters, and the one a hand-written literal cannot
  // promise: the number in the sentence has to be a size a person can act on.
  const encoded = encodedSize(avatarLimits.ADVERTISED_AVATAR_KB);
  assert.ok(
    encoded <= avatarLimits.MAX_AVATAR_DATA_URL_BYTES,
    `a ${avatarLimits.ADVERTISED_AVATAR_KB} KB photo encodes to ${encoded} bytes, over the `
    + `${avatarLimits.MAX_AVATAR_DATA_URL_BYTES}-byte ceiling — the message tells users to do something that fails`
  );
  assert.match(avatarLimits.AVATAR_TOO_LARGE_MESSAGE,
    new RegExp(`under about ${avatarLimits.ADVERTISED_AVATAR_KB} KB`),
    'the sentence must quote the derived number, not a second literal');
});

test('rounding the conversion down to a round number is not enough on its own', () => {
  // routes/stories.js derived its advertised figure by inverting base64 and
  // rounding down to the nearest 50 KB. Applied to the 600 KB avatar ceiling
  // that yields 450 — and 450 KB of photo encodes to exactly 614,400 bytes,
  // which IS the ceiling, so the `data:image/jpeg;base64,` prefix alone puts it
  // over. The slack the stories figure has is a coincidence of its ceiling, not
  // a property of the arithmetic. Taking the prefix off first is what makes it
  // a property, and both files now do.
  const naive = Math.floor(avatarLimits.MAX_AVATAR_DATA_URL_BYTES * 3 / 4 / 1024 / 50) * 50;
  assert.strictEqual(naive, 450, 'the naive inverse of the avatar ceiling');
  assert.ok(encodedSize(naive) > avatarLimits.MAX_AVATAR_DATA_URL_BYTES,
    'and it does not fit, which is why it is not what we advertise');
  assert.ok(avatarLimits.ADVERTISED_AVATAR_KB < naive);
});

test('both image routes run the same conversion, and neither number moved', () => {
  // Deriving a figure is only an improvement if it lands on the figure users
  // were already given. Changing what people are told is a separate decision
  // from removing a duplicated literal, and this was not that decision.
  assert.strictEqual(avatarLimits.ADVERTISED_AVATAR_KB, 400, 'the avatar sentence still says 400 KB');
  assert.strictEqual(storyLimits.ADVERTISED_PHOTO_KB, 500, 'the story sentence still says 500 KB');
  assert.strictEqual(
    avatarLimits.advertisedPhotoKb(storyLimits.MAX_IMAGE_DATA_URL_BYTES),
    storyLimits.ADVERTISED_PHOTO_KB,
    'one conversion, two ceilings — if these diverge the next route to copy one will copy the wrong one');
  const storyEncoded = encodedSize(storyLimits.ADVERTISED_PHOTO_KB);
  assert.ok(storyEncoded <= storyLimits.MAX_IMAGE_DATA_URL_BYTES,
    `a ${storyLimits.ADVERTISED_PHOTO_KB} KB photo encodes to ${storyEncoded} bytes`);
});

test('neither advertised figure is the enforced one wearing different units', () => {
  for (const [advertised, ceiling] of [
    [avatarLimits.ADVERTISED_AVATAR_KB, avatarLimits.MAX_AVATAR_DATA_URL_BYTES],
    [storyLimits.ADVERTISED_PHOTO_KB, storyLimits.MAX_IMAGE_DATA_URL_BYTES],
  ]) {
    assert.ok(advertised * 1024 < ceiling, 'quoting the ceiling refuses the photo a second time');
    assert.ok(advertised * 1024 > ceiling / 2, 'and it must not be so cautious it refuses photos we accept');
  }
});
