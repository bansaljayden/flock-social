// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// authLimiter meters the doors to an account, not the account's own calls
// ---------------------------------------------------------------------------
// server.js mounts authLimiter (10 a minute, keyed on the client ADDRESS) on
// the whole /api/auth router. That is the right meter for a login, a signup or
// a password reset, where nobody is identified yet and the address is the only
// key there is. It was also charging GET /api/auth/me, which every app launch
// sends first. A school or a venue puts everyone behind one public address, so
// ten cold starts in a minute emptied the bucket: the eleventh phone got a 429,
// App.js read it as the network being down and showed the unreachable screen,
// and anybody on that network trying to sign in was refused too.
//
// This file runs the REAL authLimiter configuration, lifted out of server.js
// rather than restated, in front of stub routes shaped like routes/auth.js, and
// checks both halves: the signed-in routes are never refused by it, and the
// credential doors still are. It also holds the exemption list to routes that
// really do require a signed-in account, because a credential door on that
// list would hand a password guesser an unmetered bcrypt.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const rateLimit = require('express-rate-limit');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-auth-limiter-scope';

const authRoutes = require('../routes/auth');

const BACKEND = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const AUTH_SRC = fs.readFileSync(path.join(BACKEND, 'routes', 'auth.js'), 'utf8').replace(/\r\n/g, '\n');

// The options object server.js hands rateLimit() for authLimiter, evaluated
// with the same `authRoutes` binding server.js has. Brace-matched, because the
// object holds braces of its own.
function realAuthLimiterOptions() {
  const head = 'const authLimiter = isDev ? (_req, _res, next) => next() : rateLimit(';
  const at = SERVER.indexOf(head);
  assert.ok(at > 0, 'server.js no longer declares authLimiter in the shape this test reads');
  const open = at + head.length;
  assert.strictEqual(SERVER[open], '{');
  let depth = 0;
  let close = -1;
  for (let i = open; i < SERVER.length; i++) {
    if (SERVER[i] === '{') depth++;
    else if (SERVER[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
  }
  assert.notStrictEqual(close, -1, 'unbalanced authLimiter options in server.js');
  const literal = SERVER.slice(open, close + 1);
  // eslint-disable-next-line no-new-func
  return Function('authRoutes', `"use strict"; return (${literal});`)(authRoutes);
}

// Stub routes with the real paths. What is under test is which requests the
// limiter lets through, so every handler just answers 200.
async function withApp(fn) {
  const app = express();
  const router = express.Router();
  for (const p of ['/me']) router.get(p, (_req, res) => res.json({ ok: true }));
  for (const p of ['/logout', '/logout-all', '/resend-verification', '/login', '/signup',
    '/forgot-password', '/reset-password', '/google', '/apple', '/verify-email']) {
    router.post(p, (_req, res) => res.json({ ok: true }));
  }
  router.get('/verify-email', (_req, res) => res.json({ ok: true }));
  // A fresh limiter per app, so one test's spent bucket is not the next one's.
  app.use('/api/auth', rateLimit({ ...realAuthLimiterOptions(), validate: false }), router);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const call = async (method, p) => (await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  })).status;
  try {
    await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a whole school opening the app at once is never refused by the sign-in limiter', async () => {
  await withApp(async (call) => {
    // Everyone behind one address. The limit is 10 a minute; forty launches
    // is a lunch break.
    for (let i = 0; i < 40; i++) {
      assert.strictEqual(await call('GET', '/me'), 200,
        `launch ${i + 1} from one address got refused by authLimiter. GET /me is what every app `
        + 'start sends, and App.js reads its 429 as the network being down.');
    }
    // And those launches did not spend the sign-in budget of the people on
    // the same network.
    assert.strictEqual(await call('POST', '/login'), 200,
      'forty app launches used up the address\'s sign-in attempts');
  });
});

test('the credential doors are still metered per address, and share one bucket', async () => {
  await withApp(async (call) => {
    for (let i = 0; i < 10; i++) assert.strictEqual(await call('POST', '/login'), 200);
    assert.strictEqual(await call('POST', '/login'), 429, 'the eleventh login in a minute must be refused');
    // The other doors share the same address bucket, so switching doors is
    // not a way round it.
    for (const door of ['/signup', '/forgot-password', '/reset-password', '/google', '/apple', '/verify-email']) {
      assert.strictEqual(await call('POST', door), 429, `POST ${door} escaped the spent sign-in bucket`);
    }
    assert.strictEqual(await call('GET', '/verify-email'), 429, 'GET /verify-email escaped the spent sign-in bucket');

    // An already signed-in account on that network is unaffected.
    assert.strictEqual(await call('GET', '/me'), 200);
    assert.strictEqual(await call('POST', '/logout'), 200);
    assert.strictEqual(await call('POST', '/logout-all'), 200);
    assert.strictEqual(await call('POST', '/resend-verification'), 200);
  });
});

test('the exemption matches the way Express routes, and nothing wider', () => {
  const is = (method, p) => authRoutes.isSignedInRoute({ method, path: p });
  assert.strictEqual(is('GET', '/me'), true);
  assert.strictEqual(is('GET', '/ME'), true, 'Express routes case-insensitively, so /ME reaches the /me handler');
  assert.strictEqual(is('GET', '/me/'), true, 'and a trailing slash too');
  assert.strictEqual(is('HEAD', '/me'), true, 'and HEAD is answered by the GET handler');
  // Only the method each route is registered for. A POST /me is a 404, and a
  // GET /logout is a 404; neither needs the exemption.
  assert.strictEqual(is('POST', '/me'), false);
  assert.strictEqual(is('GET', '/logout'), false);
  // The doors, by name, in case the list is ever edited carelessly.
  for (const door of ['/login', '/signup', '/forgot-password', '/reset-password', '/reset-password/check',
    '/google', '/apple', '/google/nonce', '/apple/nonce', '/verify-email']) {
    assert.strictEqual(is('POST', door), false, `POST ${door} is a credential door and must stay metered`);
    assert.strictEqual(is('GET', door), false, `GET ${door} must stay metered`);
  }
  assert.strictEqual(is('GET', '/me/../login'), false);
  assert.strictEqual(is('GET', undefined), false);
});

test('every exempt route really does require a signed-in account', () => {
  // The whole argument for skipping the address meter is that the caller is
  // already a verified account. A route on the list that does not mount
  // authenticate is a door with the meter taken off it.
  for (const entry of authRoutes.SIGNED_IN_ROUTES) {
    const [method, p] = entry.split(' ');
    const escaped = p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const re = new RegExp(`router\\.${method.toLowerCase()}\\('${escaped}', authenticate\\b`);
    assert.match(AUTH_SRC, re,
      `SIGNED_IN_ROUTES names ${entry}, and routes/auth.js does not mount it behind authenticate. `
      + 'Only a route that acts for an account that is already signed in may skip authLimiter.');
  }
});

test('the exempt routes keep a ceiling: apiLimiter is mounted on /api/auth beside authLimiter', () => {
  assert.match(SERVER, /^app\.use\('\/api\/auth', authLimiter, apiLimiter, authRoutes\);$/m,
    'server.js must mount apiLimiter on /api/auth. Without it the routes authLimiter skips have no '
    + 'per-route ceiling at all, only the app-wide backstop.');
  assert.match(SERVER, /skip: \(req\) => authRoutes\.isSignedInRoute\(req\)/,
    'authLimiter must skip exactly the list routes/auth.js owns, not a copy of it');
});
