// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE STANDING CONTROL BEHIND THE RATE LIMITERS
// ---------------------------------------------------------------------------
// utils/cacheKeyInventory.js has enforced its list of Maps since round 5, and
// the reason it works is that __tests__/cacheKeyInventory.test.js refuses to
// let a new Map land without a row. The express-rate-limit limiters sat in the
// same file as PROSE, enforced by remembering, and the difference showed: that
// comment named five limiters and server.js had ten. advisorLimiter,
// advisorQuestionLimiter, venueDashboardLimiter, venueProfileLimiter and
// digestOptOutLimiter all landed after it was written, and none of them
// changed it, because nothing could fail when they did not.
//
// This is the forcing function for the other half of the layer. It checks four
// things a comment cannot:
//
//   1. PRESENCE — every rateLimit() in server.js has a row.
//   2. AGREEMENT — each row's windowMs, max and user-visible message equal the
//      literals in server.js. A ceiling cannot move without the row moving.
//      This is the check the Maps inventory deliberately does NOT have, and it
//      is available here only because a limiter's configuration is data.
//   3. COVERAGE — every mount in server.js either names a limiter or is on the
//      written-down list of mounts allowed to have none. "This route has no
//      ceiling" has to be a decision somebody made, not a line nobody noticed.
//   4. ARITHMETIC — the backstop is >= the sum of everything it backs, so it
//      stays a backstop rather than quietly becoming the tightest limit in the
//      app, and one request charges one unit rather than up to four.
//
// What it deliberately does NOT check, for the reason the Maps inventory gives:
// no test can decide whether a ceiling is the RIGHT number. It can only make
// sure the number is written down once, is the number actually enforced, and
// has an argument attached.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { LIMITERS, UNLIMITED_MOUNTS } = require('../utils/cacheKeyInventory');

const BACKEND = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

const HOWTO = `
  ────────────────────────────────────────────────────────────────────────────
  ADD YOUR LIMITER TO THE LIMITERS LIST IN backend/utils/cacheKeyInventory.js.

  A rate limiter is a security control and a cost control, and the three things
  worth writing down about one are not its existence:

    keyKind / key   WHAT IT KEYS ON. An address is rotatable and is shared by
                    everyone behind one NAT, so it punishes a school or a bar
                    for one member. An account is not rotatable, but it does not
                    exist yet at the signup and login doors. Say which problem
                    you took.
    message         WHAT THE CALLER SEES, verbatim, and it has to describe THIS
                    window. A 429 naming a wait shorter than the real one is
                    worse than a bare refusal: the user retries on its advice,
                    is refused again, and concludes the feature is broken.
    protects        WHAT IS ACTUALLY BEHIND IT. A request ceiling in front of a
                    per-token or per-call money meter is a brake, not a cap, and
                    the two are not substitutes.

  If the route genuinely should have no limiter, say so in UNLIMITED_MOUNTS in
  the same file, with the reason. That is a legitimate answer — two of the four
  entries there are signed webhooks we must not refuse — but it is an answer,
  not a silence.
  ────────────────────────────────────────────────────────────────────────────`;

// ── Reading server.js ───────────────────────────────────────────────────────

// Module-scope `const NAME = <expr>;` on one line, evaluated. Enough for the
// three literals the limiter options refer to by name.
function moduleConst(name) {
  const m = new RegExp(`^const ${name} = (.+);$`, 'm').exec(SRC);
  if (!m) return undefined;
  try { return Function(`"use strict"; return (${m[1]});`)(); } catch { return undefined; }
}

// Evaluate an options-object expression, resolving any bare identifiers in it
// against server.js's own module constants. `15 * 60 * 1000` needs nothing;
// `IMAGE_SCREEN_WINDOW_MS` needs one lookup.
function evalOption(expr) {
  // Self-contained first. A string literal and `15 * 60 * 1000` both evaluate
  // with nothing in scope, and taking this path is not an optimisation: hunting
  // identifiers inside a message turns its WORDS into parameter names, and
  // 'Too many requests, please try again later' contains `try`, which is a
  // reserved word — so the whole evaluation threw and every message in the file
  // silently read as undefined.
  try { return Function('"use strict"; return (' + expr + ');')(); } catch { /* names to resolve */ }

  const names = [...new Set(expr.match(/[A-Za-z_$][\w$]*/g) || [])]
    .filter((n) => !['true', 'false', 'null', 'undefined'].includes(n));
  const values = names.map(moduleConst);
  try {
    return Function('"use strict"; return function(' + names.join(',') + '){ return (' + expr + '); }')()(...values);
  } catch {
    return undefined;
  }
}

// Every `rateLimit({ ... })` in server.js, with the binding it is assigned to.
// Brace-matched rather than regexed to the closing paren, because the options
// object contains braces of its own (`message: { error: ... }`).
function readLimiters() {
  const out = [];
  const NEEDLE = 'rateLimit({';
  for (let at = SRC.indexOf(NEEDLE); at !== -1; at = SRC.indexOf(NEEDLE, at + 1)) {
    const open = at + NEEDLE.length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    assert.notStrictEqual(close, -1, 'unbalanced rateLimit({ ... }) in server.js');
    const body = SRC.slice(open + 1, close);

    // The binding is the nearest `const NAME =` above this call.
    const before = SRC.slice(0, at);
    const decl = /const ([A-Za-z_$][\w$]*) =(?![\s\S]*const [A-Za-z_$][\w$]* =)/.exec(before)
      || [...before.matchAll(/const ([A-Za-z_$][\w$]*) =/g)].pop();
    assert.ok(decl, `a rateLimit({ ... }) at offset ${at} is not assigned to a const`);

    const pick = (key) => {
      const m = new RegExp(`^\\s*${key}:\\s*([^\\n]+?),\\s*$`, 'm').exec(body);
      return m ? m[1] : undefined;
    };
    const msg = /message:\s*\{\s*error:\s*([\s\S]+?)\s*\}/.exec(body);

    out.push({
      name: decl[1],
      windowMs: evalOption(pick('windowMs') || ''),
      max: evalOption(pick('max') || ''),
      message: msg ? evalOption(msg[1]) : undefined,
      hasKeyGenerator: /keyGenerator:/.test(body),
      body,
    });
  }
  return out;
}

// Every `app.use('/path', ...)` / `app.get('/path', ...)` with a literal path,
// in source order, plus the rest of that line so a limiter name can be spotted
// in it. Path-less mounts (`app.use(cors(...))`, `app.use((req,res,next)=>...)`)
// are app-wide and are described by their row's `mounts` entry instead.
function readMounts() {
  const out = [];
  const RE = /^app\.(use|get|post|put|patch|delete|all)\('([^']+)',(.*)$/gm;
  for (const m of SRC.matchAll(RE)) out.push({ verb: m[1], path: m[2], args: m[3] });
  return out;
}

const declared = readLimiters();
const mounts = readMounts();
const byName = new Map(LIMITERS.map((l) => [l.name, l]));

// ── 1. Nothing new may land unenumerated ────────────────────────────────────

test('every rateLimit() in server.js has a row in LIMITERS', () => {
  assert.ok(declared.length >= 10,
    `the scanner found ${declared.length} limiters in server.js, which means it is broken rather than the file being empty`);

  const missing = declared.filter((d) => !byName.has(d.name)).map((d) => d.name);
  assert.deepStrictEqual(missing, [],
    `${missing.length} rate limiter(s) in server.js are not in LIMITERS:\n`
    + missing.map((n) => `    const ${n} = ... rateLimit({ ... })`).join('\n') + '\n' + HOWTO);
});

test('no LIMITERS row names a limiter that has been deleted or renamed', () => {
  const live = new Set(declared.map((d) => d.name));
  const stale = LIMITERS.filter((l) => !live.has(l.name)).map((l) => l.name);
  assert.deepStrictEqual(stale, [],
    'LIMITERS describes limiters that no longer exist in server.js. A stale row is worse '
    + 'than no row: the next audit round reasons from a ceiling that is gone. Delete the row '
    + 'in the same change that deletes the limiter.');
});

// ── 2. The row has to be TRUE, not merely present ───────────────────────────

test('every row states the windowMs, max and message server.js actually uses', () => {
  for (const d of declared) {
    const row = byName.get(d.name);
    if (!row) continue; // reported by the test above
    assert.strictEqual(d.windowMs, row.windowMs,
      `${d.name}: server.js uses windowMs ${d.windowMs}, the inventory row says ${row.windowMs}.\n`
      + 'A ceiling that moves without its row moving is how the comment block this list replaced '
      + 'came to be wrong about half the limiters in the file.');
    assert.strictEqual(d.max, row.max,
      `${d.name}: server.js allows ${d.max} per window, the inventory row says ${row.max}.`);
    assert.strictEqual(d.message, row.message,
      `${d.name}: server.js answers ${JSON.stringify(d.message)}, the row says ${JSON.stringify(row.message)}.\n`
      + 'The message is the only part of a limiter a user ever sees, so it is the part most '
      + 'worth pinning: a sentence that names a window the limiter does not have sends people '
      + 'back on advice that cannot work.');
  }
});

test('a row claiming an account key is backed by a keyGenerator, and one claiming an address key is not', () => {
  for (const d of declared) {
    const row = byName.get(d.name);
    if (!row) continue;
    if (row.keyKind === 'account') {
      assert.ok(d.hasKeyGenerator,
        `${d.name} is recorded as ACCOUNT-keyed but declares no keyGenerator, so it is keyed on `
        + 'req.ip — a meter IP rotation defeats, on a route where a real identity exists.');
    } else {
      assert.strictEqual(d.hasKeyGenerator, false,
        `${d.name} is recorded as ADDRESS-keyed but declares a keyGenerator. One of the two is wrong, `
        + 'and which one matters: an address key shares a bucket across a whole NAT.');
    }
  }
});

// ── 3. Coverage — no mount may land with no ceiling and no argument ─────────

test('every mounted path in server.js either names a limiter or is on the unlimited list', () => {
  const allowed = new Set(UNLIMITED_MOUNTS.map((u) => u.path));
  const limiterNames = [...byName.keys()];

  const uncovered = mounts.filter((m) => {
    if (limiterNames.some((n) => new RegExp(`\\b${n}\\b`).test(m.args))) return false;
    return !allowed.has(m.path);
  });

  assert.deepStrictEqual(uncovered.map((m) => `app.${m.verb}('${m.path}', ...)`), [],
    `${uncovered.length} mount(s) in server.js have no rate limiter and no written reason for `
    + 'having none.\n' + HOWTO);
});

test('every path a row claims to be mounted on really is mounted with that limiter', () => {
  for (const row of LIMITERS) {
    for (const p of row.mounts) {
      // Parenthetical entries describe an app-wide mount with no literal path
      // (`app.use(globalBackstopLimiter)`), which readMounts deliberately skips.
      if (p.startsWith('(')) continue;
      const found = mounts.some((m) => m.path === p && new RegExp(`\\b${row.name}\\b`).test(m.args));
      assert.ok(found,
        `${row.name} claims to be mounted on ${p}, and server.js does not mount it there. `
        + 'A row that describes a mount that moved is a row the next reader trusts and should not.');
    }
  }
});

test('an app-wide row says so, and is genuinely mounted app-wide', () => {
  for (const row of LIMITERS) {
    if (!row.mounts.some((m) => m.startsWith('('))) continue;
    assert.ok(new RegExp(`app\\.use\\([^'\\n]*\\b${row.name}\\b`).test(SRC),
      `${row.name} records an app-wide mount but server.js has no path-less app.use for it.`);
  }
});

// ── 4. The backstop has to be a backstop ────────────────────────────────────

test('the backstop allows at least as much as everything it backs', () => {
  const backstop = byName.get('globalBackstopLimiter');
  assert.ok(backstop, 'there is no app-wide backstop limiter. Before one existed, /api/revenuecat, '
    + '/api/email-events, GET /api/health and every unmatched path had no ceiling at all.');

  // Deliberately the SUM OF EVERYTHING, with no cleverness about which limiters
  // sit behind which. A sharper model is available — imageSpendLimiter and
  // advisorQuestionLimiter are extra gates on requests already counted
  // elsewhere, and mount order decides whether the bare /api catch-alls charge
  // a request before its real mount does — but a backstop derived from a subtle
  // model is a backstop that is wrong the first time somebody reorders a mount.
  // The plain sum is close enough to an upper bound to be the right number,
  // and it is worth being exact about how it is NOT one. express-rate-limit's
  // MemoryStore starts a key's window at that key's FIRST HIT (see resetClient
  // in the 7.5.1 source), so the ten windows below are not aligned with each
  // other or with the backstop's. A caller who bursts at the seam of every one
  // of them can therefore fit sixteen one-minute windows, not fifteen, into a
  // fifteen-minute backstop window, and two whole apiLimiter windows into one
  // of these: about 11,800 rather than 8,403. That is a real gap in the claim
  // 'cannot refuse a caller every per-route limiter would have allowed', and it
  // is deliberately not fixed by raising the number, because the only caller
  // who reaches it is one sustaining thirteen requests a second across every
  // surface of the app at the same time, and the cost of being wrong in that
  // direction is a 429 telling them to try again.
  const lanes = LIMITERS.filter((l) => l !== backstop);
  const perWindow = (l) => Math.round(l.max * (backstop.windowMs / l.windowMs));
  const sum = lanes.reduce((t, l) => t + perWindow(l), 0);

  assert.ok(backstop.max >= sum,
    `the backstop allows ${backstop.max} per ${backstop.windowMs / 60000} minutes, and the limiters `
    + `it backs allow ${sum} between them:\n`
    + lanes.map((l) => `    ${l.name.padEnd(24)} ${String(l.max).padStart(5)} / ${l.windowMs / 60000}min  = ${perWindow(l)}`).join('\n')
    + '\n\nA backstop below that sum is not a backstop — it is a new, tighter ceiling that starts '
    + 'refusing callers every per-route limiter was built to allow, and it does it invisibly '
    + 'because the 429 comes from a limiter nobody was looking at. Either raise the backstop to '
    + 'the new sum and say in its row why, or lower the limiter you just added.');

  // And not far above it either: a backstop several times the sum is a number
  // nobody derived, which is the thing its row claims it is not.
  assert.ok(backstop.max <= sum * 1.5,
    `the backstop allows ${backstop.max} against a derived sum of ${sum}. Its row says the number IS `
    + 'that sum, rounded up. Keep them close, or the row is telling a story about how the number was '
    + 'picked rather than describing it.');
});

test('the backstop runs before the body parsers, and reuses billedImageKey rather than restating it', () => {
  const mountAt = SRC.indexOf('app.use(globalBackstopLimiter);');
  const parserAt = SRC.indexOf('const JSON_BODY_ENVELOPE_BYTES');
  assert.ok(mountAt > 0, 'globalBackstopLimiter is declared but never mounted');
  assert.ok(mountAt < parserAt,
    'the backstop is mounted AFTER the body parsers. That is the one thing it can do that no other '
    + 'limiter here can: express.json has already read the body by the time a per-route limiter runs, '
    + 'so only a refusal from up there actually stops the read. Moved below them it becomes a '
    + 'duplicate of apiLimiter.');

  const decl = /const globalBackstopLimiter = [\s\S]*?\n\}\);/.exec(SRC);
  assert.ok(decl, 'globalBackstopLimiter is no longer a single rateLimit declaration');
  assert.match(decl[0], /keyGenerator: \(req\) => billedImageKey\(req\)/,
    'the backstop derives its own key instead of reusing billedImageKey. billedImageKey\'s own comment '
    + 'is about exactly this: two readings of the Authorization header in one file disagree on '
    + '`Bearer <token> junk`, and a caller who can pick which bucket they land in by adding a space to '
    + 'their own header is not metered by account at all.');
});

test('nothing cors answers or refuses gets past the backstop, because the backstop is mounted first', async () => {
  // WHAT WENT WRONG, 2026-08-26. The backstop landed below `app.use(cors(...))`
  // and was described as app-wide. It was not, and cors is the reason: it does
  // not set headers and fall through, it ANSWERS. Two classes never reached the
  // limiter at all.
  //
  //   * A preflight. cors defaults preflightContinue to false, so it writes 204
  //     and ends the request on its own line.
  //   * ANY request carrying an Origin the allowlist does not hold. server.js's
  //     origin callback hands `new Error('Not allowed by CORS')` to next(),
  //     which jumps to the error handlers at the very bottom of the file, past
  //     every mount in between.
  //
  // The second is strictly worse than the unrouted-404 hole this limiter was
  // written to close. That Error carries no `status`, so
  // Sentry.setupExpressErrorHandler captures it and the handler below logs the
  // stack: one extra request header, on any URL, from any address, with no
  // account, bought an unbounded stream of Sentry events. "Nothing guarded the
  // app as a whole" was still true for anything a caller could get cors to
  // decide.
  const cors = require('cors');
  const ALLOWED = 'https://flockcorp.com';

  // server.js's own predicate and callback shape, so this measures the real
  // arrangement rather than a friendlier one.
  const corsMw = cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin === ALLOWED) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  });

  // The exemption server.js declares, restated here only so the two arrangements
  // below differ in ONE thing: where the counter is mounted.
  const isPreflightFromAllowedOrigin = (req) => req.method === 'OPTIONS'
    && typeof req.headers['access-control-request-method'] === 'string'
    && req.headers.origin === ALLOWED;

  async function measure(backstopFirst) {
    const app = express();
    let counted = 0;
    const backstop = (req, _res, next) => {
      if (!isPreflightFromAllowedOrigin(req)) counted++;
      next();
    };
    if (backstopFirst) app.use(backstop);
    app.use(corsMw);
    if (!backstopFirst) app.use(backstop);
    app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
    // Stands in for Sentry.setupExpressErrorHandler + the handler below it.
    let captured = 0;
    app.use((err, _req, res, _next) => { captured++; res.status(500).json({ error: String(err.message) }); });

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const seen = {};
    try {
      for (const [label, path, init] of [
        ['plain GET, no Origin at all', '/api/nothing-here', {}],
        ['GET from the real web origin', '/api/nothing-here', { headers: { origin: ALLOWED } }],
        ['GET carrying an Origin the allowlist refuses', '/api/nothing-here',
          { headers: { origin: 'https://evil.example' } }],
        ['a preflight from the real web origin', '/api/anything',
          { method: 'OPTIONS', headers: { origin: ALLOWED, 'access-control-request-method': 'POST' } }],
        ['a preflight from an origin the allowlist refuses', '/api/anything',
          { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }],
        ['a bare OPTIONS that is not a preflight', '/api/anything', { method: 'OPTIONS' }],
      ]) {
        counted = 0;
        await fetch(base + path, init);
        seen[label] = counted;
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
    return { seen, captured };
  }

  const after = await measure(false);   // where it was
  const before = await measure(true);   // where it is now

  // The bug, stated as a measurement rather than an argument.
  assert.equal(after.seen['GET carrying an Origin the allowlist refuses'], 0,
    'this assertion documents the OLD arrangement; if it no longer holds, cors has stopped '
    + 'short-circuiting and the rest of this test needs rewriting rather than trusting.');
  assert.ok(after.captured > 0,
    'a refused origin is supposed to reach the error handler, which is what made it expensive');

  // And what the mount order buys.
  for (const label of [
    'plain GET, no Origin at all',
    'GET from the real web origin',
    'GET carrying an Origin the allowlist refuses',
    'a preflight from an origin the allowlist refuses',
    'a bare OPTIONS that is not a preflight',
  ]) {
    assert.equal(before.seen[label], 1,
      `"${label}" was not counted by the backstop. Everything Express sees has to pass it, or the `
      + 'ceiling is a ceiling over the paths somebody remembered.');
  }
  assert.equal(before.seen['a preflight from the real web origin'], 0,
    'an allowed-origin preflight is the one deliberate exemption: it carries no Authorization '
    + 'header, so it keys to addr:, and a bar full of Capacitor clients would then share one '
    + '8,500 bucket for a request cors answers in constant time without reading a body.');

  // Finally, the source order that makes it true in the real file.
  const backstopAt = SRC.indexOf('app.use(globalBackstopLimiter);');
  const corsAt = SRC.indexOf('app.use(cors({');
  assert.ok(backstopAt > 0 && corsAt > 0, 'the backstop or the cors mount has been renamed');
  assert.ok(backstopAt < corsAt,
    'globalBackstopLimiter is mounted AFTER cors again. cors answers preflights itself and turns a '
    + 'disallowed Origin into next(err), so everything it decides skips the limiter entirely, '
    + 'including the Sentry capture, which is the expensive half.');

  const decl = /const globalBackstopLimiter = [\s\S]*?\n\}\);/.exec(SRC);
  assert.match(decl[0], /skip: \(req\) => req\.method === 'OPTIONS'[\s\S]*?isAllowedOrigin\(req\.headers\.origin\)/,
    'the backstop no longer exempts the allowed-origin preflight, or exempts something wider. '
    + 'Wider than that and a caller picks their own exemption with a request header.');
});

test('the backstop key function answers every hostile Authorization header without throwing', () => {
  // A limiter whose keyGenerator throws is a 500 on every request, and this one
  // is now the FIRST middleware in the app, so it would be a 500 on every
  // request including the health check. billedImageKey is lifted from the file
  // rather than restated, for the reason its own comment gives.
  const fn = /function billedImageKey\(req\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(fn, 'billedImageKey is gone; the backstop has no key to compute');
  const jwt = require('jsonwebtoken');
  const billedImageKey = Function('jwt', 'TOKEN_ALGORITHMS',
    `"use strict"; ${fn[0]}; return billedImageKey;`)(jwt, ['HS256']);

  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-for-key-derivation';
  try {
    const hostile = [
      {},
      { authorization: '' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer ' },
      { authorization: 'Bearer  ' },
      { authorization: 'Bearer null' },
      { authorization: 'Bearer ' + 'A'.repeat(200000) },
      { authorization: 'Bearer a.b.c' },
      { authorization: 'bearer lowercase' },
      { authorization: 'Basic ' + Buffer.from('a:b').toString('base64') },
      // Node joins duplicate Authorization headers with ', '.
      { authorization: 'Bearer one, Bearer two' },
      { authorization: 'Bearer  �' },
      { authorization: 'Bearer ' + jwt.sign({ userId: 'not-an-integer' }, 'test-secret-for-key-derivation') },
      { authorization: 'Bearer ' + jwt.sign({ userId: 7 }, 'the-wrong-secret') },
    ];
    for (const headers of hostile) {
      for (const ip of ['203.0.113.9', undefined]) {
        const key = billedImageKey({ headers, ip });
        assert.equal(typeof key, 'string',
          `billedImageKey returned ${typeof key} for ${JSON.stringify(headers)}. express-rate-limit `
          + 'buckets on this value, and a non-string key is a bucket nobody can reason about.');
      }
    }
    // And the one input that must NOT fall through to the address bucket.
    const good = jwt.sign({ userId: 7 }, 'test-secret-for-key-derivation');
    assert.equal(billedImageKey({ headers: { authorization: `Bearer ${good}` }, ip: '203.0.113.9' }), 'user:7');
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

// ── 5. One request, one unit ────────────────────────────────────────────────

test('one request charges a limiter exactly one unit, whatever the mount order or the spelling', async () => {
  // countOncePerRequest is lifted from server.js rather than restated, for the
  // reason billedImageKey's comment gives: two copies of one rule is how the
  // rule comes to be true in one place only.
  const fn = /function countOncePerRequest\(limiter, label\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(fn, 'countOncePerRequest is gone from server.js. Without it, `app.use(\'/api\', apiLimiter, router)` '
    + 'charges every request that falls through it, and the shared 3000/15min bucket drains at one to '
    + 'four units per request depending on which route was asked for.');
  const countOncePerRequest = Function(`"use strict"; ${fn[0]}; return countOncePerRequest;`)();

  // And apiLimiter has to actually BE wrapped in it. Lifting the helper and
  // applying it here would prove only that the helper works — the first version
  // of this test did exactly that and passed happily with the wrapper deleted
  // from the declaration, which is the "the control exists on paper" failure
  // utils/cacheKeyInventory.js was written to stop.
  const wrapped = /const apiLimiter = countOncePerRequest\(/.test(SRC);
  assert.ok(wrapped,
    'apiLimiter is no longer wrapped in countOncePerRequest, so it charges once per mount it '
    + 'falls through rather than once per request.');

  // server.js's real mount order, with stub routers that authenticate nothing
  // and match nothing, so every request falls all the way through — which is
  // exactly what an authenticated request to a route the catch-alls do not
  // define already does.
  const app = express();
  let charged = 0;
  const raw = (_req, _res, next) => { charged++; next(); };
  const limiter = wrapped ? countOncePerRequest(raw, 'apiLimiter') : raw;
  const fallthrough = () => { const r = express.Router(); r.use((_q, _s, n) => n()); return r; };

  for (const m of mounts.filter((x) => x.verb === 'use')) {
    if (/\bapiLimiter\b/.test(m.args)) app.use(m.path, limiter, fallthrough());
    else app.use(m.path, fallthrough());
  }
  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // One representative path per mount, plus the unrouted case (which used to
  // cost two units for a 404), plus the spellings a caller picks when they are
  // trying to make a request cost NOTHING. EXACTLY one, not at most one: a
  // limiter that charges once per request is worthless if a request can be
  // spelled so that it charges zero, and "at most one" is equally satisfied by
  // a hole. Every one of these reaches a handler through a mount that carries
  // apiLimiter, so every one of them owes it a unit.
  const probes = [
    ...new Set(mounts.filter((m) => m.verb === 'use').map((m) => `${m.path}/probe`)),
    '/api/nothing-here',
    '/api//users//me',            // doubled separators reach the same handlers
    '/api/users%2fme',            // an encoded separator
    '/api/users/',                // a trailing slash
    '/api/users/../users/me',     // dot segments, normalised by the client
    '/api/users/me?next=/api/x',  // a query string that looks like a path
  ];
  try {
    for (const p of probes) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
        charged = 0;
        await fetch(`http://127.0.0.1:${port}${p}`, { method });
        assert.strictEqual(charged, 1,
          `${method} ${p} charged apiLimiter ${charged} times for ONE request.\n`
          + (charged > 1
            ? 'The bare /api catch-alls match every path under /api, so a request they have no route '
              + 'for charges on the way through and then charges again at its real mount. That makes '
              + 'the enforced ceiling depend on mount order, makes the busiest product routes the most '
              + 'expensive ones, and leaves /api/users as the cheapest lane in the app, which is '
              + 'where enumeration goes.'
            : 'Zero is the worse direction. countOncePerRequest marks the request with a Symbol on the '
              + 'first pass and skips the limiter on every later one, so a spelling that reaches a '
              + 'handler while carrying that mark already, or that routes around every apiLimiter '
              + 'mount and still gets served, is a free lane through the ceiling.'));
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── 6. The address every ip-keyed row rests on ──────────────────────────────

// Every `keyKind: 'ip'` row above is worth exactly what req.ip is worth, and
// req.ip is decided by one line: `app.set('trust proxy', 1)`. Get that wrong in
// either direction and the consequence is total rather than partial.
//
//   TOO PERMISSIVE (`true`, or a number larger than the real hop count) and
//   req.ip becomes whatever the CLIENT put at the front of X-Forwarded-For, so
//   every per-address limit in the app is defeated by one header.
//   TOO STRICT (`false`, or no setting) and req.ip is Railway's own internal
//   proxy address, identical for everyone, so every per-address limit becomes
//   one global bucket and a single reconnect loop locks the whole user base out.
//   That second one is not hypothetical here: round 9 shipped it on the socket
//   handshake, which is why socketClientIp exists.
test('trust proxy is set so req.ip is the address the platform appended, not one the caller chose', async () => {
  assert.match(SRC, /^app\.set\('trust proxy', 1\);$/m,
    'server.js no longer trusts exactly one forwarding hop. Every keyKind:\'ip\' row in the limiter '
    + 'inventory rests on this line.');

  const app = express();
  app.set('trust proxy', 1);
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const REAL = '203.0.113.9'; // what Railway's edge appends
  try {
    for (const [label, xff] of [
      ['edge appended the client', REAL],
      ['client spoofed a prefix', `1.2.3.4, ${REAL}`],
      ['client spoofed many hops', `9.9.9.9, 8.8.8.8, 7.7.7.7, ${REAL}`],
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': xff } });
      const { ip } = await res.json();
      assert.strictEqual(ip, REAL,
        `${label}: req.ip came back as ${ip}. The LAST entry in X-Forwarded-For is the only one a `
        + 'client cannot write, because our proxy appends it after everything they sent.');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the socket handshake derives the client address the same way Express does', () => {
  // Express and Socket.IO reach req.ip by completely different routes — the
  // engine intercepts /socket.io/ on the raw http.Server, so `trust proxy`
  // never applies to it — and two derivations of "who is this" is the bug
  // billedImageKey's comment warns about. socketClientIp has to land on the
  // same hop or socketConnections is metering a different population.
  const fn = /function socketClientIp\(socket\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(fn, 'socketClientIp is gone; the socket connection limiter has no client address to key on');
  assert.match(fn[0], /hops\[hops\.length - 1\]/,
    'socketClientIp no longer takes the LAST forwarded hop. Taking the first is taking the one the '
    + 'client wrote; taking none is putting every user behind Railway\'s proxy into one 10-per-minute '
    + 'bucket, which is the round-9 bug where one reconnect loop locked everybody out.');
});

// ── 7. Every row has to actually say something ──────────────────────────────

test('every LIMITERS row answers the questions, and no row is a shrug', () => {
  const REQUIRED = ['name', 'windowMs', 'max', 'keyKind', 'key', 'message', 'mounts', 'protects', 'verdict', 'why'];
  for (const l of LIMITERS) {
    for (const f of REQUIRED) {
      assert.ok(l[f] !== undefined && l[f] !== null && String(l[f]).length > 0,
        `${l.name} is missing "${f}".\n${HOWTO}`);
    }
    assert.ok(['ip', 'account'].includes(l.keyKind),
      `${l.name} has keyKind "${l.keyKind}"; use 'ip' or 'account'.`);
    assert.ok(Array.isArray(l.mounts) && l.mounts.length > 0, `${l.name} lists no mounts.`);
    assert.ok(['SAFE', 'OPEN'].includes(l.verdict), `${l.name} has verdict "${l.verdict}".`);
    assert.ok(l.why.length >= 40,
      `${l.name} has a "why" too short to be an argument: "${l.why}"\n`
      + 'Say what the key costs a caller to rotate, or what the ceiling is really protecting.' + HOWTO);
  }
});

test('every UNLIMITED_MOUNTS entry carries a reason, not just a path', () => {
  assert.ok(UNLIMITED_MOUNTS.length > 0, 'the unlimited list is empty, which is only true if every mount is limited');
  for (const u of UNLIMITED_MOUNTS) {
    assert.ok(typeof u.path === 'string' && u.path.length > 0, 'an UNLIMITED_MOUNTS entry has no path');
    assert.ok(typeof u.why === 'string' && u.why.length >= 60,
      `${u.path} is allowed to have no limiter with a reason too short to check: "${u.why}"\n`
      + 'Say what would break if it were limited, or what bounds it instead.');
  }
});
