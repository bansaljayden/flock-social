// Run: node --test  (from backend/)
//
// This file has now been rewritten twice for the same reason, which is the
// point it exists to make.
//
// SECURITY-AUDIT-config.md finding #1 (MEDIUM): the CORS origin check used
//   /^https:\/\/flock-app(-[a-z0-9]+)*\.vercel\.app$/
// which matched ANY flock-app-<anything>.vercel.app. Anyone can register a
// Vercel project named `flock-app-evil` and receive exactly the origin
// `https://flock-app-evil.vercel.app`.
//
// SECURITY-AUDIT-auth.md R2-1 (MEDIUM): the replacement pinned the production
// slug and the preview URL SHAPE —
//   /^https:\/\/flock-app-w65m-(?:git-[a-z0-9-]+|[a-z0-9]+)-[a-z0-9-]+\.vercel\.app$/
// — and this test asserted a "representative preview host" was ALLOWED. But the
// shape is `<pinned-slug>-<label>-<label>` and a Vercel project name is free
// text, so `flock-app-w65m-evil-x` is registrable and was admitted. The old
// assertion was measuring the pattern against itself, not against an attacker.
//
// The policy is now EXACT HOSTS ONLY. There is no pattern to bypass: the
// preview namespace `*.vercel.app` is self-service, so any pattern over it is a
// pattern over hostnames an attacker can mint. Preview deploys are opt-in per
// deploy via EXTRA_CORS_ORIGIN, which is unset in production.
//
// The test still drives the REAL allowlist logic lifted out of server.js — the
// exact `allowedOrigins` array and the `isAllowedOrigin` predicate the running
// server uses, both the REST cors() callback and the Socket.io handshake — so
// it tracks the code rather than a copy of it, the same lift-from-source
// discipline securityChecklist.test.js uses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Lift the region that declares `allowedOrigins` and `isAllowedOrigin`.
// Both anchors are asserted unique so a rename fails loudly here instead of
// silently lifting the wrong bytes.
function lift(startAnchor, endAnchor) {
  const start = serverSrc.indexOf(startAnchor);
  assert.notStrictEqual(start, -1, `server.js no longer contains: ${startAnchor}`);
  assert.strictEqual(
    serverSrc.indexOf(startAnchor, start + startAnchor.length), -1,
    `anchor is no longer unique in server.js: ${startAnchor}`
  );
  const end = serverSrc.indexOf(endAnchor, start);
  assert.notStrictEqual(end, -1, `server.js no longer contains: ${endAnchor} (after ${startAnchor})`);
  return serverSrc.slice(start, end);
}

const region = lift('const allowedOrigins = [', 'app.use(cors(');

// Reconstruct the predicate the origin callbacks consult, from server.js's own
// source. A fake `process` supplies the env reads in the region, and a fake
// `console` swallows the startup warning EXTRA_CORS_ORIGIN prints.
function buildAllowlist(env = {}) {
  const build = new Function(
    'process', 'console',
    `${region}\n; return { allowedOrigins, isAllowedOrigin };`
  );
  return build({ env }, { warn() {}, log() {}, error() {} });
}

const { allowedOrigins, isAllowedOrigin } = buildAllowlist({});

test('no pattern is ever matched against the caller-supplied Origin', () => {
  // The whole policy change is "exact hosts, no patterns". A regex may still
  // appear in this region (EXTRA_CORS_ORIGIN shape-checks its OWN env value),
  // but nothing may pattern-match the ORIGIN the caller sent. If a future edit
  // reintroduces that, it is the third bypass waiting to happen and it fails
  // here first.
  assert.ok(
    !/\.test\(\s*origin\s*\)/.test(region),
    'a pattern is being matched against the caller-supplied origin again'
  );
  // ...and the predicate itself is an exact-membership test, nothing more.
  assert.match(
    region.replace(/\/\/[^\n]*/g, ''),
    /const isAllowedOrigin = \(origin\) => allowedOrigins\.includes\(origin\);/,
    'isAllowedOrigin is no longer a plain exact-host membership check'
  );
  for (const entry of allowedOrigins) {
    assert.strictEqual(typeof entry, 'string', `allowlist entry is not an exact host string: ${entry}`);
  }
});

test('the real production host is allowed', () => {
  assert.ok(isAllowedOrigin('https://flock-app-w65m.vercel.app'));
});

test('R2-1: the attacker-registrable preview-shaped host is REJECTED', () => {
  // This is the exact origin the round-2 audit re-derived against the old
  // regex and found ALLOWED. It is `<pinned-slug>-<label>-<label>`, which is a
  // Vercel project name anyone can register.
  assert.strictEqual(isAllowedOrigin('https://flock-app-w65m-evil-x.vercel.app'), false);
  assert.strictEqual(isAllowedOrigin('https://flock-app-w65m-a-b.vercel.app'), false);
  assert.strictEqual(isAllowedOrigin('https://flock-app-w65m-abc-def-ghi.vercel.app'), false);
});

test('preview-shaped hosts are no longer allowed by pattern', () => {
  // These two were previously asserted ALLOWED by this very file. They are
  // indistinguishable from the attacker origin above by shape alone, which is
  // why pattern matching was abandoned rather than tightened again.
  assert.strictEqual(isAllowedOrigin('https://flock-app-w65m-abc123def-flock.vercel.app'), false);
  assert.strictEqual(isAllowedOrigin('https://flock-app-w65m-git-main-flock.vercel.app'), false);
});

test('the attacker-registrable flock-app-evil.vercel.app is REJECTED', () => {
  assert.strictEqual(isAllowedOrigin('https://flock-app-evil.vercel.app'), false);
  // Any other project-root host of the flock-app-* family is likewise a
  // different project, not a preview of ours.
  assert.strictEqual(isAllowedOrigin('https://flock-app-attacker.vercel.app'), false);
});

test('a suffix-smuggling host is REJECTED', () => {
  assert.strictEqual(isAllowedOrigin('https://flock-app-w65m.vercel.app.attacker.com'), false);
  // A prefix-smuggling variant is rejected too.
  assert.strictEqual(isAllowedOrigin('https://evil-flock-app-w65m.vercel.app'), false);
});

test('the localhost-dev and flockcorp.com entries are preserved exactly', () => {
  for (const origin of [
    'https://flockcorp.com',
    'https://www.flockcorp.com',
    'http://localhost',
    'https://localhost',
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost:5173',
  ]) {
    assert.ok(isAllowedOrigin(origin), `expected allowed: ${origin}`);
  }
});

test('EXTRA_CORS_ORIGIN is opt-in per deploy and unset by default', () => {
  // Default (production) shape: nothing extra.
  const prod = buildAllowlist({});
  assert.strictEqual(prod.isAllowedOrigin('https://flock-app-w65m-git-main-flock.vercel.app'), false);

  // A preview deploy that wants to reach this backend names its OWN origin.
  const preview = buildAllowlist({
    EXTRA_CORS_ORIGIN: 'https://flock-app-w65m-git-main-flock.vercel.app',
  });
  assert.ok(preview.isAllowedOrigin('https://flock-app-w65m-git-main-flock.vercel.app'));
  // ...and naming one preview does NOT admit the attacker's neighbour host.
  assert.strictEqual(preview.isAllowedOrigin('https://flock-app-w65m-evil-x.vercel.app'), false);
});

test('EXTRA_CORS_ORIGIN accepts a comma-separated list and drops junk entries', () => {
  const multi = buildAllowlist({
    EXTRA_CORS_ORIGIN: 'https://a.example.com , https://b.example.com,,not-an-origin, /relative',
  });
  assert.ok(multi.isAllowedOrigin('https://a.example.com'));
  assert.ok(multi.isAllowedOrigin('https://b.example.com'));
  assert.strictEqual(multi.isAllowedOrigin('not-an-origin'), false);
  assert.strictEqual(multi.isAllowedOrigin('/relative'), false);
  assert.strictEqual(multi.isAllowedOrigin(''), false);
});

test('every origin decision in server.js goes through the one predicate', () => {
  // R2-1 noted the paths share a constant and said to keep it that way.
  // Anything less means one of them can be tightened and the other forgotten.
  //
  // This counted call sites and required exactly two, which made it fail the
  // moment a THIRD place correctly used the predicate: the global backstop
  // limiter's 429 handler, which echoes the origin so a browser will let the
  // page read the refusal. That call site is the property this test wants, not
  // a violation of it, and a count cannot tell those apart. What actually
  // matters is that nobody re-derives the allowlist, so that is what is
  // asserted: at least the two original readers still call it, and no second
  // definition of "is this origin allowed" exists anywhere in the file.
  const uses = serverSrc.match(/isAllowedOrigin\(/g) || [];
  assert.ok(uses.length >= 3, `expected the REST callback, the socket handshake and the backstop refusal to call it, saw ${uses.length}`);
  // A count alone is too weak, and I proved that on this very assertion: with
  // only the count, replacing the backstop handler's check with a hand-rolled
  // `origin.endsWith('flockcorp.com')` left the test green, because the skip
  // predicate above it already supplied a third call. So the handler is pinned
  // by name. This is the exact failure this file exists to prevent, one path
  // deciding origins by its own rule while the others share the predicate.
  const handlerAt = serverSrc.indexOf('handler: (req, res, _next, options)');
  assert.ok(handlerAt > 0, 'the backstop refusal handler is gone; retarget this test');
  const handlerBody = serverSrc.slice(handlerAt, handlerAt + 700);
  assert.match(handlerBody, /isAllowedOrigin\(origin\)/,
    'the backstop 429 must decide the echoed origin with the shared predicate, never its own comparison');
  // One definition, and nothing that rebuilds the list beside it.
  const defs = serverSrc.match(/function isAllowedOrigin|isAllowedOrigin\s*=/g) || [];
  assert.strictEqual(defs.length, 1, 'isAllowedOrigin must have exactly one definition in server.js');
  assert.ok(
    !/VERCEL_PREVIEW_ORIGIN/.test(serverSrc),
    'the bypassed preview regex is back in server.js'
  );
});

// ---------------------------------------------------------------------------
// A REFUSED ORIGIN IS NOT A SERVER FAULT (2026-08-26).
// ---------------------------------------------------------------------------
// Adversarial pass over 546a734, which moved globalBackstopLimiter above cors
// because "one request header on any URL bought an unbounded stream of Sentry
// events". Measured against the real server booted on embedded Postgres, the
// header still bought them; it just bought 8,500 per key per fifteen minutes
// instead of an unlimited number, because the mount order bounds the VOLUME and
// leaves the KIND alone. Every refusal was still:
//
//   HTTP/1.1 500 Internal Server Error
//   [unhandled-error] GET /nothing-here user=anon: Error: Not allowed by CORS
//       at origin (server.js) ... plus the rest of the stack
//
// The cause is one missing property. Sentry's defaultShouldHandleError reads
// `error.status || error.statusCode || error.status_code ||
// error.output?.statusCode` and treats a MISSING one as 500, so a bare Error is
// always captured; and server.js's own error handler falls through to its
// "genuine server fault" branch for anything it does not recognise, which is
// where the stack and the 500 come from. Naming the status at the throw site
// takes the refusal out of both.
//
// This is measured through the REAL @sentry/node error handler rather than a
// restatement of its rule, because that rule is what decides whether the alert
// storm happens, and a copy of it in this file could go stale against a version
// bump with nothing failing. No DSN is needed: the handler sets `res.sentry` to
// an event id exactly when it decided to capture.
test('the refusal carries a 4xx status, so Sentry does not capture it and the handler does not log a stack', async () => {
  const express = require('express');
  const http = require('node:http');
  const cors = require('cors');
  const Sentry = require('@sentry/node');

  // The origin callback exactly as server.js writes it, lifted rather than
  // restated for the same reason buildAllowlist above is lifted.
  const callbackSrc = /origin: \(origin, callback\) => \{[\s\S]*?\n {2}\},/.exec(
    serverSrc.slice(serverSrc.indexOf('app.use(cors({'))
  );
  assert.ok(callbackSrc, 'the cors origin callback has moved or been renamed');
  const originCallback = new Function(
    'isAllowedOrigin', 'CORS_REFUSED',
    `"use strict"; return ({ ${callbackSrc[0]} }).origin;`
  )(isAllowedOrigin, 'cors.origin.refused');

  // What the callback hands back for a refusal, on its own.
  let refused = null;
  originCallback('https://evil.example', (err) => { refused = err; });
  assert.ok(refused instanceof Error, 'a disallowed origin must still be refused');
  assert.strictEqual(refused.status, 403,
    'the refusal has no status again. Sentry reads a missing status as 500 and captures the error as an '
    + 'unhandled server exception, so one request header from any address turns into an alert storm that '
    + 'the rate limiter can only bound, never stop.');
  assert.strictEqual(refused.type, 'cors.origin.refused',
    'the marker the global error handler branches on is gone, so the refusal falls back to the 500 branch');

  // And an ALLOWED origin still passes, so the status is not being handed out
  // by a callback that has quietly stopped refusing anything.
  let allowedErr = 'unset';
  let allowedOk = null;
  originCallback('https://flockcorp.com', (e, ok) => { allowedErr = e; allowedOk = ok; });
  assert.strictEqual(allowedErr, null);
  assert.strictEqual(allowedOk, true);

  // End to end, through the real cors middleware and the real Sentry handler.
  const app = express();
  app.use(cors({ origin: originCallback, credentials: true }));
  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use(Sentry.expressErrorHandler());
  app.use((err, _req, res, _next) => {
    // Stands in for the two branches of server.js's handler that matter here.
    const captured = res.sentry === undefined ? null : String(res.sentry);
    if (err && err.type === 'cors.origin.refused') return res.status(403).json({ captured });
    return res.status(500).json({ captured });
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [what, init] of [
      ['a plain GET carrying a refused Origin', { headers: { origin: 'https://evil.example' } }],
      ['a preflight from a refused Origin', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      }],
      ['two Origin headers, which Node joins into one string that matches nothing', {
        headers: { origin: 'https://evil.example, https://flockcorp.com' },
      }],
    ]) {
      const res = await fetch(`${base}/nothing-here`, init);
      const body = await res.json();
      assert.strictEqual(res.status, 403, `${what} answered ${res.status}, not 403`);
      assert.strictEqual(body.captured, null,
        `${what} was captured by Sentry as an unhandled exception. That is the alert storm this test `
        + 'exists to stop, and it comes back the moment the refusal loses its status.');
    }

    // The control: an error with NO status IS captured, which is what makes the
    // assertions above mean something rather than measuring a disabled SDK.
    const control = express();
    control.get('/boom', (_req, _res, next) => next(new Error('a real fault')));
    control.use(Sentry.expressErrorHandler());
    control.use((err, _req, res, _next) => res.status(500).json({
      captured: res.sentry === undefined ? null : String(res.sentry),
    }));
    const controlServer = http.createServer(control);
    await new Promise((r) => controlServer.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${controlServer.address().port}/boom`);
      const body = await res.json();
      assert.notStrictEqual(body.captured, null,
        'the Sentry express handler captured nothing even for a status-less Error, so the assertions '
        + 'above prove nothing. Its capture rule has changed and this test needs rewriting.');
    } finally {
      await new Promise((r) => controlServer.close(r));
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the global error handler answers the refusal itself instead of falling through to the 500 branch', () => {
  // The source half. The end-to-end test above builds a stand-in handler,
  // because lifting the real one would drag in the body-parser table and the
  // headersSent guard. This is what pins the real file to the same shape.
  const handler = serverSrc.slice(serverSrc.indexOf('const BODY_PARSER_CLIENT_ERRORS'));
  const corsBranch = handler.indexOf('err.type === CORS_REFUSED');
  // Anchored on the LOG CALL, not on the tag. The tag now appears in a comment
  // above the 4xx branch too (it quotes the measured output), and an anchor that
  // matches a comment is an ordering assertion that stops measuring the code.
  const faultBranch = handler.indexOf('`[unhandled-error] ${req.method}');
  assert.ok(corsBranch > 0, 'the global error handler no longer has a branch for a refused origin');
  assert.ok(faultBranch > 0, 'the unhandled-error branch has been renamed');
  assert.ok(corsBranch < faultBranch,
    'the refused-origin branch is now BELOW the unhandled-error branch, so every refusal logs a stack '
    + 'and answers 500 again');
  assert.match(serverSrc, /const CORS_REFUSED = 'cors\.origin\.refused';/,
    'CORS_REFUSED is the one spelling shared by the throw site and the handler, and two spellings is '
    + 'how the branch stops matching');
});

// ---------------------------------------------------------------------------
// AND NEITHER IS ANYTHING ELSE THAT NAMES A 4xx (2026-08-26).
// ---------------------------------------------------------------------------
// Adversarial pass over ce3b14c, which is the commit directly above. That
// change was right and it stopped one line short. It fixed ONE error that this
// handler was reporting as a crash, and the argument it made ("an origin that
// is not on the allowlist is exactly the case this allowlist exists to answer")
// is not specific to CORS: any error carrying a 4xx status has already declared
// itself a client fault, and the handler fell through all of them into the
// branch that writes a stack and answers 500.
//
// The next one along needs no new code anywhere to be reachable, because
// EXPRESS ITSELF raises it. Every router in this app mounts `:id` routes, and a
// malformed percent-escape in one of those parameters makes Express's own
// decode_param throw a URIError carrying status = statusCode = 400. Measured
// against the real handler, before the branch this test pins existed:
//
//     GET /api/users/%ZZ  ->  HTTP/1.1 500 Internal Server Error
//     [unhandled-error] GET /api/users/%ZZ user=anon: URIError: Failed to
//         decode param '%ZZ' ... plus the rest of the stack
//
// Three characters, from any address, with no account. Sentry does NOT capture
// it, because its rule reads the 400 and leaves it alone, and that is exactly
// why it survived the previous pass: the half that got measured was the Sentry
// half. The other two halves were still wrong. The caller is told the server
// broke when the caller's own URL was malformed, and every one of these writes
// a full stack into the production log.
//
// Driven END TO END through real Express rather than by calling the handler
// with a hand-built error, because the point of the case is that Express is the
// thing raising it. A synthetic `err.status = 400` would prove the branch
// matches and would not prove the branch is REACHED.
test('an error that declares a 4xx is answered as one, with one line and no stack', async () => {
  const express = require('express');
  const http = require('node:http');

  const start = serverSrc.indexOf('const BODY_PARSER_CLIENT_ERRORS');
  assert.ok(start > 0, 'server.js must still classify body-parser failures');
  const tail = "return res.status(500).json({ error: 'Internal server error' });";
  const at = serverSrc.indexOf(tail, start);
  assert.ok(at > start, 'the global error handler must still fall through to a 500');
  const end = serverSrc.indexOf('\n});', at + tail.length) + '\n});'.length;
  const marker = /const CORS_REFUSED = '([^']+)';/.exec(serverSrc);
  assert.ok(marker, 'server.js no longer declares CORS_REFUSED');

  const logged = [];
  const con = {
    error: (...a) => logged.push(['error', a.map(String).join(' ')]),
    warn: (...a) => logged.push(['warn', a.map(String).join(' ')]),
    log: () => {},
  };
  let handler = null;
  // eslint-disable-next-line no-new-func
  new Function('app', 'console', 'CORS_REFUSED', serverSrc.slice(start, end))(
    { use: (fn) => { handler = fn; } }, con, marker[1]
  );
  assert.equal(typeof handler, 'function');

  const app = express();
  // The route SHAPE every router in this app uses. Nothing in the handler is
  // route-specific; this is here so that EXPRESS raises the error rather than
  // the test.
  app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));
  app.get('/boom', (_req, _res, next) => next(new Error('a genuine fault')));
  app.get('/refused-5xx', (_req, _res, next) => {
    // A 502 is a SERVER fault that happens to carry a status, and it must keep
    // its stack. Honouring every declared status rather than only 4xx would
    // quietly take the debugging line off the errors that need it most.
    const e = new Error('upstream said no');
    e.status = 502;
    next(e);
  });
  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use(handler);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [what, url] of [
      ['a malformed percent-escape in a :param', '/api/users/%ZZ'],
      ['a truncated multi-byte escape in a :param', '/api/users/%E0%A4'],
    ]) {
      logged.length = 0;
      const res = await fetch(base + url);
      assert.equal(res.status, 400,
        `${what} answered ${res.status}. Express raised a URIError that already says status 400, and this `
        + 'handler overrode it with a 500, telling the caller the server broke when their own URL was '
        + 'malformed. Same class as the CORS refusal above, one branch further down.');
      const body = await res.json();
      assert.ok(body.error && !/Internal server error/.test(body.error),
        'the body still calls a client mistake a server fault');
      assert.equal(logged.filter(([lvl]) => lvl === 'error').length, 0,
        `${what} still writes a console.error. That is the stack-per-request half of the same problem: `
        + 'anonymous, unauthenticated, and as fast as the backstop allows.');
      const warns = logged.filter(([lvl]) => lvl === 'warn');
      assert.equal(warns.length, 1, `${what} must log exactly one line`);
      assert.ok(!/\n/.test(warns[0][1]), 'the one line must be one line');
      assert.ok(warns[0][1].length < 600, 'the line must be clamped, not a stack in disguise');
      assert.match(warns[0][1], /GET/, 'a log line with no verb and no URL is not worth writing');
    }

    // THE TWO CONTROLS. Without them this test would pass equally well against
    // a handler that had stopped writing stacks for anything at all.
    logged.length = 0;
    const fault = await fetch(`${base}/boom`);
    assert.equal(fault.status, 500, 'an error with NO status is still a server fault');
    assert.equal(logged.filter(([lvl]) => lvl === 'error').length, 1,
      'a genuine fault must still log its stack; that line is where a 3am debug starts');

    logged.length = 0;
    const upstream = await fetch(`${base}/refused-5xx`);
    assert.equal(upstream.status, 500, 'a 5xx declaration is a server fault, not a client one');
    assert.equal(logged.filter(([lvl]) => lvl === 'error').length, 1,
      'a 502 must keep its stack: honouring every declared status, rather than only 4xx, would strip the '
      + 'debugging line off exactly the errors that need it');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the 4xx branch sits below the two that name their own status, and above the 500 fallback', () => {
  // Order is the whole behaviour here. The body-parser table and the cors
  // marker each answer with a SENTENCE of their own, and a general 4xx branch
  // above either of them would swallow both and replace their wording with the
  // generic one.
  const handler = serverSrc.slice(serverSrc.indexOf('const BODY_PARSER_CLIENT_ERRORS'));
  const bodyParser = handler.indexOf('BODY_PARSER_CLIENT_ERRORS.has(err.type)');
  const corsBranch = handler.indexOf('err.type === CORS_REFUSED');
  const declared = handler.indexOf('const declaredStatus');
  // Anchored on the LOG CALL, not on the tag. The tag now appears in a comment
  // above the 4xx branch too (it quotes the measured output), and an anchor that
  // matches a comment is an ordering assertion that stops measuring the code.
  const faultBranch = handler.indexOf('`[unhandled-error] ${req.method}');
  assert.ok(declared > 0, 'the global error handler no longer honours a declared 4xx status');
  assert.ok(bodyParser > 0 && corsBranch > 0 && faultBranch > 0);
  assert.ok(bodyParser < declared && corsBranch < declared,
    'the general 4xx branch has moved above a branch with its own wording, which it would now swallow');
  assert.ok(declared < faultBranch,
    'the general 4xx branch is below the unhandled-error branch, so every one of them logs a stack and '
    + 'answers 500 again');
});
