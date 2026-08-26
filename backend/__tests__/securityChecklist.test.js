// Run: node --test  (from backend/)
//
// §P of SLOP-AUDIT.md is a twenty-item security checklist. Most of it was
// already true when this file was written, and most of it was already pinned
// somewhere else in __tests__ — parameterised queries, hashed passwords, login
// throttling, input validation, the sanitizer. This file covers the items that
// nothing was watching, and it covers them the way the rest of this suite
// covers server.js: by lifting the real declarations out of the source and
// EXECUTING them, rather than restating what they ought to do.
//
// WHY LIFTING, AND NOT `require('../server')`. server.js calls boot() on
// require (scripts/e2e-local.js depends on that), so importing it runs
// migrations, opens a port, and process.exit(1)s when Postgres is absent.
// __tests__/imageSpendLimits.test.js established the workaround and this file
// uses the same one: slice the block out of the source text, evaluate it with
// the bindings it expects, and drive it with real HTTP.
//
// ONE TRAP THIS FILE HAS TO AVOID, WRITTEN DOWN BECAUSE IT HAS BITTEN PEOPLE
// HERE. Every file in this repo is CRLF. A find-string written with a bare
// "\n" therefore matches nothing, and an assertion built on it passes
// vacuously — it reports "no violations found" when what happened is "no
// source was searched". Every read in this file normalises line endings first,
// and `assertScannedSomething` below refuses to let a zero-hit scan count as a
// pass.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');

const BACKEND = path.join(__dirname, '..');

// Read a repo file with line endings normalised. See the CRLF note above.
function readSource(...parts) {
  return fs.readFileSync(path.join(BACKEND, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

const serverSrc = readSource('server.js');

// A scan that examined nothing is not a passing scan. Every sweep below states
// how many files or matches it expected to look at, so that deleting the thing
// under test turns the assertion red instead of green.
function assertScannedSomething(count, what) {
  assert.ok(count > 0, `scanned ${count} ${what} — the scan itself is broken, not the code`);
}

// ---------------------------------------------------------------------------
// Lifting blocks out of server.js
// ---------------------------------------------------------------------------
// Slice from the first line that starts with `startAnchor` up to (not
// including) the first line at or after it that starts with `endAnchor`. Both
// anchors are asserted, so a rename in server.js fails loudly here instead of
// silently extracting the wrong region.
function liftRegion(startAnchor, endAnchor) {
  const start = serverSrc.indexOf(startAnchor);
  assert.notStrictEqual(start, -1, `server.js no longer contains: ${startAnchor}`);
  const end = serverSrc.indexOf(endAnchor, start);
  assert.notStrictEqual(end, -1, `server.js no longer contains: ${endAnchor} (after ${startAnchor})`);
  return serverSrc.slice(start, end);
}

// Each anchor below is unique in server.js — a test asserts that, so a future
// edit that duplicates one of these strings fails here rather than quietly
// extracting the wrong region.
const LIFT_ANCHORS = [
  'const allowedOrigins = [', 'app.use(cors(',
  'const HTTPS_EXEMPT_PATHS', '// Response trimming',
  'const SECRET_RESPONSE_FIELDS', '// JSON body limits',
  'app.use(helmet({', '// Force HTTPS',
];

const ORIGINS_SRC = liftRegion('const allowedOrigins = [', 'app.use(cors(');
const HTTPS_SRC = liftRegion('const HTTPS_EXEMPT_PATHS', '// Response trimming');
// The end anchor is whatever section comes NEXT, and it moved once: the
// app-wide backstop limiter was inserted between the response trimmer and the
// JSON body limits, because it has to run before the parsers. Lifting through
// it would eval a `rateLimit({ ... })` into a Function that has no rateLimit in
// scope, which is a ReferenceError and not a security finding. The region this
// file cares about is the response trimmer; the anchor only has to name the
// first line that is not part of it.
const TRIM_SRC = liftRegion('const SECRET_RESPONSE_FIELDS', '// JSON body limits');

// Build an express app whose middleware IS server.js's own code.
function appFromServerSource(regions, { nodeEnv = 'production' } = {}) {
  const app = express();
  const fakeProcess = { env: { NODE_ENV: nodeEnv } };
  // eslint-disable-next-line no-new-func
  const run = new Function('app', 'process', 'console', regions.join('\n'));
  run(app, fakeProcess, { log() {}, warn() {}, error() {} });
  return app;
}

// One request against an ephemeral listener.
function request(app, { method = 'GET', pathname = '/probe', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, path: pathname, method, headers },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, headers: res.headers, body });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// ===========================================================================
// ITEM: add security headers
// ===========================================================================
// "Helmet is mounted" and "the headers are right" are different claims, and
// this app was relying on the first. The options object is lifted and handed
// to the real helmet, and the assertions are made against the bytes that come
// back over a socket — not against the object that went in.

const HELMET_SRC = liftRegion('app.use(helmet({', '// Force HTTPS');

test('every anchor this file lifts on is still unique in server.js', () => {
  // The lifting above is only sound while each anchor names one place. If an
  // edit duplicates one, liftRegion would silently slice a different block and
  // every assertion built on it would go on passing against the wrong code.
  for (const anchor of LIFT_ANCHORS) {
    const hits = serverSrc.split(anchor).length - 1;
    assert.strictEqual(hits, 1, `anchor ${JSON.stringify(anchor)} appears ${hits} times in server.js, expected exactly 1`);
  }
});

function helmetOptionsFromSource() {
  const open = HELMET_SRC.indexOf('helmet(') + 'helmet('.length;
  // Balance braces/brackets from the opening paren to find the argument.
  let depth = 0;
  let end = -1;
  for (let i = open; i < HELMET_SRC.length; i++) {
    const c = HELMET_SRC[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      if (c === ')' && depth === 0) { end = i; break; }
      depth--;
    }
  }
  assert.notStrictEqual(end, -1, 'could not find the end of the helmet() argument in server.js');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${HELMET_SRC.slice(open, end)});`)();
}

async function emittedHeaders() {
  const app = express();
  app.use(helmet(helmetOptionsFromSource()));
  app.get('/probe', (_req, res) => res.json({ ok: true }));
  return (await request(app)).headers;
}

test('the emitted CSP denies framing, rather than the config merely looking like it does', async () => {
  const headers = await emittedHeaders();
  const csp = headers['content-security-policy'];
  assert.ok(csp, 'no Content-Security-Policy header was emitted at all');

  // THE BUG THIS PINS. helmet merges the given directives OVER its own
  // defaults, and one of those defaults is `frame-ancestors 'self'`. So a
  // config that set `frameguard: { action: 'deny' }` and said nothing about
  // frame-ancestors emitted BOTH `X-Frame-Options: DENY` and
  // `frame-ancestors 'self'` — and every current browser ignores
  // X-Frame-Options entirely when frame-ancestors is present, so the header
  // that was actually consulted permitted same-origin framing.
  assert.ok(
    /frame-ancestors 'none'/.test(csp),
    `CSP must deny framing outright. Emitted: ${csp}`
  );
  assert.ok(
    !/frame-ancestors 'self'/.test(csp),
    "CSP still carries helmet's default `frame-ancestors 'self'`, which contradicts frameguard DENY"
  );

  // The legacy header stays, for anything old enough to need it. The two must
  // agree; a future edit that relaxes one has to relax the other on purpose.
  assert.strictEqual(headers['x-frame-options'], 'DENY');
});

test('the headers a shipping API needs are actually on the wire', async () => {
  const headers = await emittedHeaders();

  assert.match(headers['strict-transport-security'], /max-age=31536000/);
  assert.match(headers['strict-transport-security'], /includeSubDomains/);
  assert.strictEqual(headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(headers['referrer-policy'], 'no-referrer');

  // Express advertises its own name unless something removes it. Helmet does;
  // this asserts helmet is actually reaching the response.
  assert.strictEqual(headers['x-powered-by'], undefined, 'X-Powered-By is being advertised');

  const csp = headers['content-security-policy'];
  // The directives that matter on a JSON API that also serves an SVG badge to
  // third-party pages: no plugins, no inline script, and a fixed base URI.
  for (const directive of ["object-src 'none'", "base-uri 'self'", "script-src-attr 'none'", "default-src 'self'"]) {
    assert.ok(csp.includes(directive), `CSP is missing ${directive}. Emitted: ${csp}`);
  }
});

// ===========================================================================
// ITEM: force HTTPS
// ===========================================================================
// Before this block existed nothing in the app refused a plaintext request.
// HSTS was doing the work in the story but not in the code: a browser is
// required to IGNORE Strict-Transport-Security when it arrives over http://,
// so it protects only a client that has already completed one successful HTTPS
// request — never a first contact, and never the Capacitor shell or any other
// non-browser caller, none of which implement HSTS at all.

const httpsApp = (nodeEnv) => {
  const app = appFromServerSource([ORIGINS_SRC, HTTPS_SRC], { nodeEnv });
  app.all('/probe', (_req, res) => res.json({ reached: true }));
  app.all('/api/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
};

test('a plaintext GET through the proxy is redirected to HTTPS, not served', async () => {
  const res = await request(httpsApp('production'), {
    pathname: '/probe',
    headers: { 'x-forwarded-proto': 'http', host: 'flockcorp.com' },
  });
  assert.strictEqual(res.status, 308, 'a plaintext GET was not redirected');
  assert.strictEqual(res.headers.location, 'https://flockcorp.com/probe');
});

test('a plaintext POST is refused outright rather than redirected', async () => {
  // A 3xx on a POST asks the client to send the body a SECOND time, and the
  // copy that already crossed the network in the clear is not recoverable by
  // redirecting. Refusing says so; redirecting pretends the first send did not
  // happen.
  const res = await request(httpsApp('production'), {
    method: 'POST',
    pathname: '/probe',
    headers: { 'x-forwarded-proto': 'http', host: 'flockcorp.com' },
  });
  assert.strictEqual(res.status, 403);
  assert.ok(!JSON.parse(res.body).reached, 'the handler ran on a plaintext POST');
});

test('the LAST forwarded hop decides, so a client cannot spell its way past the gate', async () => {
  // Express's own req.protocol reads the FIRST entry of X-Forwarded-Proto. A
  // client may send that header itself, and a proxy that appends rather than
  // replaces leaves the client's value in front — so `https, http` reads as
  // "https" through req.protocol while the real last hop was plaintext. The
  // last entry is the one our proxy appended and the only one a client cannot
  // write, which is the same rule socketClientIp already applies to
  // X-Forwarded-For.
  const res = await request(httpsApp('production'), {
    pathname: '/probe',
    headers: { 'x-forwarded-proto': 'https, http', host: 'flockcorp.com' },
  });
  assert.strictEqual(res.status, 308, 'a spoofed leading "https" got the request served');
});

test('a genuine HTTPS request is served untouched', async () => {
  const res = await request(httpsApp('production'), {
    pathname: '/probe',
    headers: { 'x-forwarded-proto': 'https', host: 'flockcorp.com' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).reached, true);
});

test('a request with no forwarding header is served — this is the deploy healthcheck', async () => {
  // Railway's container healthcheck reaches this process directly over
  // plaintext with no forwarding headers, and so does anything else on the
  // private network. Refusing it would fail the healthcheck and roll back every
  // deploy. The rule refuses only what a proxy has positively told us was
  // plaintext.
  const res = await request(httpsApp('production'), { pathname: '/probe' });
  assert.strictEqual(res.status, 200);
});

test('/api/health answers over plaintext even when a proxy says http', async () => {
  const res = await request(httpsApp('production'), {
    pathname: '/api/health',
    headers: { 'x-forwarded-proto': 'http', host: 'flockcorp.com' },
  });
  assert.strictEqual(res.status, 200);
});

test('the redirect target is allowlisted, so a forged Host cannot make us sign an open redirect', async () => {
  // req.headers.host is client-controlled. Interpolating it into Location
  // blindly turns this server into an open redirect that carries our name.
  const res = await request(httpsApp('production'), {
    pathname: '/probe',
    headers: { 'x-forwarded-proto': 'http', host: 'evil.example.com' },
  });
  assert.strictEqual(res.status, 403, 'an unknown Host was echoed into a redirect');
  assert.strictEqual(res.headers.location, undefined);
});

test('development is untouched, because there is no TLS terminator in front of it', async () => {
  const res = await request(httpsApp('development'), {
    pathname: '/probe',
    headers: { 'x-forwarded-proto': 'http', host: 'flockcorp.com' },
  });
  assert.strictEqual(res.status, 200);
});

test('the socket handshake is held to the same HTTPS rule as REST', () => {
  // Socket.IO attaches to the raw http.Server and its engine intercepts
  // /socket.io/ requests BEFORE Express, so the app-level gate above never sees
  // a handshake — and a handshake carries the JWT in its auth payload exactly
  // like an Authorization header does. Enforcing on one transport and not the
  // other is not enforcing.
  //
  // Asserted against the source rather than by standing up a real Socket.IO
  // server, because server.js cannot be imported (see the header of this file).
  // What is pinned is that the gate exists, precedes authentication, and shares
  // ONE implementation of "which protocol was this" with the REST side.
  const ioSection = serverSrc.slice(serverSrc.indexOf('const io = new Server('));
  assert.ok(ioSection.length > 0, 'could not find the Socket.IO section of server.js');

  const gateAt = ioSection.indexOf('forwardedProtocol(');
  assert.notStrictEqual(gateAt, -1, 'the socket handshake has no HTTPS gate');

  // It must reuse forwardedProtocol, not restate the header parsing. Two
  // readings of X-Forwarded-Proto is how the two transports drift into
  // disagreeing about what counts as secure.
  assert.ok(
    !/x-forwarded-proto/.test(ioSection.slice(0, gateAt + 400).replace('forwardedProtocol(', '')),
    'the socket gate parses X-Forwarded-Proto itself instead of reusing forwardedProtocol'
  );

  // And it must run before the connection is authenticated.
  const authAt = ioSection.indexOf('io.use(authenticateSocket)');
  assert.notStrictEqual(authAt, -1, 'authenticateSocket is no longer mounted on the io chain');
  assert.ok(gateAt < authAt, 'the HTTPS gate runs after authentication instead of before it');

  // Production only, same as REST — otherwise local development, which has no
  // TLS terminator, could not open a socket at all.
  assert.ok(/if \(!isProduction\) return next\(\);/.test(ioSection.slice(gateAt - 400, gateAt)),
    'the socket HTTPS gate is not scoped to production');
});

// ===========================================================================
// ITEM: trim API responses (the half that leaks credentials)
// ===========================================================================
// `SELECT * FROM users` appears five times in the routers, because each of
// those queries genuinely needs the bcrypt hash. The row it produces also
// carries `apple_refresh_token`, a LIVE Apple credential. Three handlers strip
// both by hand, all three spelling the same destructure. A fourth handler that
// does `res.json({ user })` is one line of ordinary-looking code.

const trimApp = () => {
  const app = appFromServerSource([TRIM_SRC], { nodeEnv: 'production' });
  app.get('/leak-user', (_req, res) => res.json({
    user: { id: 7, name: 'Ada', email: 'a@b.c', password: '$2b$10$hash', apple_refresh_token: 'r1', token_version: 2 },
  }));
  app.get('/leak-nested', (_req, res) => res.json({
    flocks: [{ id: 1, members: [{ id: 7, name: 'Ada', password: '$2b$10$hash' }] }],
  }));
  app.get('/leak-sensor', (_req, res) => res.json([{ device_id: 'sensor_001', api_key: 'sha256:deadbeef' }]));
  app.get('/ordinary', (_req, res) => res.json({ flocks: [{ id: 1, name: 'pizza < tacos' }], count: 1 }));
  app.get('/via-send', (_req, res) => res.send({ user: { id: 7, password: '$2b$10$hash' } }));
  return app;
};

test('a bcrypt hash cannot leave the server in a response body', async () => {
  const body = JSON.parse((await request(trimApp(), { pathname: '/leak-user' })).body);
  assert.strictEqual(body.user.password, undefined, 'a bcrypt hash was served to the client');
  assert.strictEqual(body.user.id, 7, 'the guard ate a field it had no business touching');
  assert.strictEqual(body.user.name, 'Ada');
});

test('a live Apple refresh token cannot leave the server either', async () => {
  const body = JSON.parse((await request(trimApp(), { pathname: '/leak-user' })).body);
  assert.strictEqual(body.user.apple_refresh_token, undefined);
});

test('the guard reaches into nested rows, not just the top level', async () => {
  const body = JSON.parse((await request(trimApp(), { pathname: '/leak-nested' })).body);
  assert.strictEqual(body.flocks[0].members[0].password, undefined);
  assert.strictEqual(body.flocks[0].members[0].name, 'Ada');
});

test('a bare array response is walked too', async () => {
  const body = JSON.parse((await request(trimApp(), { pathname: '/leak-sensor' })).body);
  assert.strictEqual(body[0].api_key, undefined, 'a sensor API key was served');
  assert.strictEqual(body[0].device_id, 'sensor_001');
});

test('res.send(object) goes through the same guard as res.json', async () => {
  // Express implements res.send(object) as this.json(object), so the wrapper
  // covers it — but only because it is installed as an own property on res.
  // If that ever stops being true this is the test that notices.
  const body = JSON.parse((await request(trimApp(), { pathname: '/via-send' })).body);
  assert.strictEqual(body.user.password, undefined);
});

test('an ordinary response is returned byte for byte', async () => {
  // A guard that mangles legitimate payloads gets deleted the first time it
  // breaks a screen, and then it is protecting nothing.
  const res = await request(trimApp(), { pathname: '/ordinary' });
  assert.deepStrictEqual(JSON.parse(res.body), { flocks: [{ id: 1, name: 'pizza < tacos' }], count: 1 });
});

// ===========================================================================
// ITEM: enforce server side authorisation on every route
// ===========================================================================
// The failure this pins is positional and completely silent: `router.use(
// authenticate)` protects only the routes DECLARED BELOW IT. A new route added
// above that line — at the top of the file, which is where people add things —
// is public, and nothing about it looks wrong.

const ROUTES_DIR = path.join(BACKEND, 'routes');

// Routers that legitimately declare a route before (or without) a blanket
// authenticate. Every entry names the route and what guards it instead; an
// unexplained addition to this list is the thing to argue with in review.
const AUTH_EXEMPT = new Map([
  ['auth.js', 'public by definition — signup/login/verify/reset; the four routes that need a session mount authenticate inline'],
  ['badge.js', 'GET /api/badge/:placeId.svg is a public embeddable image with its own cache and rate caps'],
  ['checkin.js', 'anonymous NFC tap GET; writes are gated on an HMAC signature (NFC_TAG_SECRET)'],
  ['guest.js', 'guest RSVP/vote, authorised by an unguessable per-invite token rather than a JWT'],
  ['publicCrowd.js', 'public website crowd demo; per-IP and per-day caps inside the router'],
  ['revenuecat.js', 'third-party webhook, authorised by a shared secret compared with timingSafeEqual'],
  ['sensors.js', 'Pi ingest, authorised by a hashed x-api-key; the JWT read routes mount authenticate inline'],
  ['users.js', 'DELETE /api/users/me is declared first with authenticateAllowBanned, so a banned user can still erase their account (Apple 5.1.1(v) / GDPR)'],
  ['venueDigest.js', 'GET/POST /api/venue-digest/opt-out is the CAN-SPAM unsubscribe link, opened from a mail client with no session; authorised by a signed single-purpose JWT whose purpose claim is checked in services/venueDigest.js. The GET only renders (mail scanners follow every href), the POST is the write'],
  ['unsubscribe.js', 'GET/POST /api/unsubscribe is the CAN-SPAM unsubscribe link on the waitlist mail, opened from a mail client by somebody who has no Flock account at all, so a session gate here would be an unsubscribe nobody on that list could use. Authorised by an HMAC over the address under a key derived from JWT_SECRET (services/emailUnsubscribe.js), which scopes it to one recipient. Same split as venueDigest: the GET only renders (mail scanners follow every href), the POST is the write'],
  ['emailWebhook.js', 'third-party webhook (Resend delivery events), authorised by a Svix signature verified against the raw request bytes with timingSafeEqual and a 5-minute timestamp window; a missing secret answers 503 rather than trusting the sender'],
  ['venueSearch.js', 'GET /api/venues/photo is a deliberately anonymous image proxy with a path-traversal-guarded ref allowlist'],
  ['waitlist.js', 'public landing-page signup; per-IP hourly and global daily caps inside the router'],
]);

test('no router declares a route above its own authenticate gate', () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
  assertScannedSomething(files.length, 'route files');

  const offenders = [];
  let gatedRouters = 0;

  for (const file of files) {
    const lines = readSource('routes', file).split('\n');
    let gateLine = -1;
    let firstRouteLine = -1;
    lines.forEach((line, i) => {
      if (gateLine < 0 && /^\s*router\.use\(\s*authenticate/.test(line)) gateLine = i + 1;
      if (firstRouteLine < 0 && /^\s*router\.(get|post|put|patch|delete)\(/.test(line)) firstRouteLine = i + 1;
    });

    if (gateLine < 0) continue;      // handled by the exemption sweep below
    gatedRouters++;
    if (firstRouteLine > 0 && firstRouteLine < gateLine && !AUTH_EXEMPT.has(file)) {
      offenders.push(`${file}: route at line ${firstRouteLine} is declared above router.use(authenticate) at line ${gateLine}`);
    }
  }

  assertScannedSomething(gatedRouters, 'routers with a blanket authenticate');
  assert.deepStrictEqual(offenders, [], `unauthenticated route(s):\n${offenders.join('\n')}`);
});

test('every router without a blanket authenticate is a named, justified exemption', () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
  const unexplained = [];
  for (const file of files) {
    const src = readSource('routes', file);
    const hasGate = /^\s*router\.use\(\s*authenticate/m.test(src);
    const hasInline = /^\s*router\.(get|post|put|patch|delete)\([^\n]*authenticate/m.test(src);
    if (!hasGate && !hasInline && !AUTH_EXEMPT.has(file)) unexplained.push(file);
  }
  assert.deepStrictEqual(
    unexplained, [],
    `router(s) with no authentication and no recorded reason: ${unexplained.join(', ')}`
  );
});

// ===========================================================================
// ITEM: secure session cookies
// ===========================================================================

test('the app issues no cookies at all, so there is no cookie to secure', () => {
  // Sessions here are bearer JWTs in the Authorization header. That makes the
  // checklist item vacuous TODAY — and vacuous is only safe while it stays
  // true. The moment somebody reaches for res.cookie the item stops being
  // vacuous and starts needing Secure, HttpOnly, SameSite and a CSRF story,
  // none of which exist in this codebase. This test is the tripwire for that
  // day; it is not a claim that cookies are configured correctly.
  const dirs = ['routes', 'services', 'sockets', 'middleware', 'utils'];
  const offenders = [];
  let scanned = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(BACKEND, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue; }
      if (!entry.name.endsWith('.js')) continue;
      scanned++;
      const src = readSource(dir, entry.name);
      if (/res\.cookie\(|cookie-parser|express-session/.test(src)) {
        offenders.push(path.join(dir, entry.name));
      }
    }
  };
  dirs.forEach(walk);
  scanned++;
  if (/res\.cookie\(|cookie-parser|express-session/.test(serverSrc)) offenders.push('server.js');

  assertScannedSomething(scanned, 'backend source files');
  assert.deepStrictEqual(
    offenders, [],
    `a cookie appeared in ${offenders.join(', ')}. Sessions in this app are bearer JWTs; ` +
    'a cookie needs Secure + HttpOnly + SameSite and a CSRF defence, and none exist here yet.'
  );
});

// ===========================================================================
// ITEM: parameterise queries
// ===========================================================================

test('no request value is ever interpolated into SQL text', () => {
  // The check is deliberately about the INPUT, not about the presence of `${`:
  // several queries build fragment lists (calendar.js conditions, users.js SET
  // clauses, admin.js whitelisted table names) out of server-side literals, and
  // those are fine. What must never appear inside a template-literal query is a
  // value that came off the request.
  const dirs = ['routes', 'services', 'sockets', 'utils'];
  const offenders = [];
  let scanned = 0;

  const REQUEST_VALUE = /\$\{[^}]*\b(req\.(body|query|params|headers)|request\.)/;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(BACKEND, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue; }
      if (!entry.name.endsWith('.js')) continue;
      scanned++;
      const src = readSource(dir, entry.name);
      src.split('\n').forEach((line, i) => {
        if (!REQUEST_VALUE.test(line)) return;
        if (!/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES|ORDER BY|LIMIT)\b/i.test(line)) return;
        if (/^\s*(\/\/|\*)/.test(line)) return;   // commentary about the rule is not a breach of it
        offenders.push(`${dir}/${entry.name}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  dirs.forEach(walk);

  assertScannedSomething(scanned, 'backend source files');
  assert.deepStrictEqual(offenders, [], `request data interpolated into SQL:\n${offenders.join('\n')}`);
});

// ===========================================================================
// ITEM: record access
// ===========================================================================

test('an admin role grant is recorded, and a failed grant is not swallowed', () => {
  // This is the only path in the app that grants role='admin', and admin is the
  // role that reads reported images and bans accounts. It used to run under a
  // bare `.catch(() => {})`, which hid BOTH outcomes at once: a success wrote
  // nothing anywhere, and a failure was silent — so a boot where nobody got
  // promoted looked exactly like a boot where somebody did.
  const block = serverSrc.slice(
    serverSrc.indexOf('if (process.env.ADMIN_USER_IDS)'),
    serverSrc.indexOf('KEEP_DEMO_STORIES')
  );
  assert.ok(block.length > 100, 'could not find the admin provisioning block in server.js');

  assert.ok(
    !/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(block),
    'the admin role grant is swallowing its errors again'
  );
  assert.ok(
    /RETURNING id/.test(block),
    'the grant does not report which ids it actually promoted'
  );
  // BOTH lines, named separately. Asserting "some admin-provisioning log
  // exists" was satisfied by either one, so deleting the other went unnoticed —
  // and they answer different questions. The configured set says who is
  // EXPECTED to hold admin; the granted set says who was promoted on this
  // particular boot. An incident review wants both.
  assert.ok(
    /console\.log\([^)]*admin-provisioning\] configured admin ids/.test(block),
    'the grant no longer records which ids are configured as admin'
  );
  assert.ok(
    /console\.warn\([^)]*admin-provisioning\] GRANTED/.test(block),
    'the grant no longer records who was actually promoted'
  );
  assert.ok(
    /console\.error\([^)]*admin-provisioning/.test(block),
    'a failed admin grant is still silent'
  );
});

// ===========================================================================
// ITEM: escape user content
// ===========================================================================

test('the sanitizer leaves no residual markup, under adversarial splicing', () => {
  // stripHtml runs to a fixed point precisely because one pass can splice two
  // halves of the input into a construct that was not there before
  // ("<<script>script>x" leaves "<script>x" after a single pass). This builds
  // exactly those inputs out of markup fragments and asserts nothing that could
  // reopen a tag survives.
  const { stripHtml } = require('../utils/sanitize');
  const pieces = ['<', '>', '/', '!', '-', 'a', 'script', 'img', 'svg', '"', "'", '=', '?', ' ', 'onerror', '<!--', '-->', '</', ' ', 'style'];

  // Deterministic PRNG, so a failure here is reproducible rather than a
  // once-a-month mystery.
  let seed = 0x5eed1234;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };

  const failures = [];
  for (let i = 0; i < 30000; i++) {
    let input = '';
    const len = 2 + Math.floor(rnd() * 9);
    for (let j = 0; j < len; j++) input += pieces[Math.floor(rnd() * pieces.length)];
    const out = stripHtml(input);
    if (/<[a-zA-Z!/?]/.test(out)) failures.push([input, out]);
    // Stripping must also be a fixed point: a second pass changing anything
    // would mean the first returned something still parseable.
    if (stripHtml(out) !== out) failures.push([input, out]);
  }
  assert.deepStrictEqual(failures.slice(0, 5), [], `markup survived sanitisation (${failures.length} cases)`);
});

test('ordinary punctuation still survives byte for byte', () => {
  // The predecessor to this sanitizer was an HTML *filter*, and it corrupted
  // real user text on every route that called it: "5 > 3" became "5 &gt; 3",
  // "I <3 you" became "I ". A flock called "pizza < tacos" is not an attack.
  // Any future hardening has to keep passing this.
  const { stripHtml } = require('../utils/sanitize');
  for (const s of ['5 > 3', 'a < b', '5 <= 6 >= 4', 'I <3 you', 'pizza < tacos', 'Ada & Grace', "O'Brien"]) {
    assert.strictEqual(stripHtml(s), s, `sanitizer corrupted ordinary text: ${s}`);
  }
});
