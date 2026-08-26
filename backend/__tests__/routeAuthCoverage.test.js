// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// EVERY ROUTE IS EITHER GUARDED OR ON THE LIST. THERE IS NO THIRD CATEGORY.
// ---------------------------------------------------------------------------
// The question this answers is not "are the public routes safe" — several of
// them are public on purpose and each has a reason. It is "did anything become
// public by ACCIDENT". A route file gains an endpoint in a hurry, the
// authenticate middleware is left off, nothing fails, and it ships. Nothing in
// the suite could have told you.
//
// So the shape here is an expected-set check rather than a scan. Every router
// that serves an endpoint without auth middleware must be named in
// EXPECTED_PUBLIC with the reason it is public. A new unguarded router fails
// this test with its own name in the message. Adding it to the list is a
// deliberate act that leaves a written reason behind, which is the point: the
// failure is not "you did something wrong", it is "say why".
//
// TWO THINGS THIS HAS TO GET RIGHT, AND THE FIRST DRAFT GOT ONE WRONG.
//
// Comments and string literals are stripped before anything is matched. The
// first version of this audit declared routes/sensors.js fully guarded because
// the word "authenticate" appears in a COMMENT above POST /data ("Authenticate
// before reporting validation errors"). That route takes an x-api-key inside
// the handler and has no middleware at all. A scanner that cannot tell code
// from prose reports whatever the prose says, and on these files the prose is
// about auth on almost every route. It read as full coverage. It was the same
// blind spot the em dash sweep and the story purge guard both had to fix.
//
// In-handler auth is counted SEPARATELY rather than folded into "guarded".
// POST /api/sensors/data really is authenticated, by a device key checked in
// the body, and calling that "guarded" would hide the distinction that matters:
// middleware is uniform and auditable, an in-body check is bespoke and has to
// be read. It is allowed, it is counted, and it is visible.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

// Routers that serve at least one endpoint with no auth middleware, ON PURPOSE.
// The value is the reason, and an entry without one is useless to the next
// reader, so the test asserts they are all non-empty.
const EXPECTED_PUBLIC = {
  auth: 'login, signup and password reset cannot require a session',
  waitlist: 'landing page signup form, public by design',
  publicCrowd: 'website live crowd demo; own per-IP and daily caps inside',
  badge: 'embeddable live-busyness SVG for claimed venues',
  guest: 'share-link RSVP and vote, authenticated by the link token itself',
  checkin: 'an NFC tap opens a URL on a phone with no session',
  unsubscribe: 'one-click unsubscribe from an email, signed token',
  venueDigest: 'digest opt-out link from an email, signed token',
  emailWebhook: 'Resend delivery webhook, shared secret',
  revenuecat: 'RevenueCat purchase webhook, shared secret',
  sensors: 'Pi ingest checks x-api-key in the handler; the read APIs use JWT',
};

const AUTH_MW = /\b(authenticate|authenticateAllowBanned|requireVerified)\b/;
const IN_BODY_AUTH = /\b(x-api-key|findDeviceByApiKey|verifyGuestToken|requireSharedSecret|timingSafeEqual)\b/i;

/** Remove comments only, keeping string literals.
 *
 * The survey below blanks strings as well, because a route path or an error
 * message containing the word "authenticate" would fool it exactly the way a
 * comment did. But a check that needs to see WHICH header is read cannot use
 * that output: `req.headers['x-api-key']` comes back as `req.headers[ ]`. So
 * the two strippers exist for two different questions, and neither one is
 * usable for the other's. */
function stripComments(srcRaw) {
  const src = srcRaw.split('\r').join('');
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        if (quote !== '`' && src[i] === '\n') break;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Remove comments and string literals so only real code is matched. */
function stripCommentsAndStrings(srcRaw) {
  const src = srcRaw.split('\r').join('');
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        if (quote !== '`' && src[i] === '\n') break;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function auditRouter(file) {
  const raw = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  const code = stripCommentsAndStrings(raw);
  const blanket = /router\.use\(\s*(authenticate|authenticateAllowBanned|requireVerified)\b/.test(code);

  const calls = [];
  const re = /router\.(get|post|put|patch|delete)\(/g;
  let m;
  while ((m = re.exec(code)) !== null) calls.push({ method: m[1].toUpperCase(), at: m.index });

  const routes = calls.map((call, k) => {
    const from = call.at;
    const to = k + 1 < calls.length ? calls[k + 1].at : code.length;
    const whole = code.slice(from, to);
    const headEnd = whole.search(/async\s*\(|\(\s*req\s*,/);
    const head = headEnd > 0 ? whole.slice(0, headEnd) : whole.slice(0, 300);
    return {
      method: call.method,
      middleware: blanket || AUTH_MW.test(head),
      inBody: IN_BODY_AUTH.test(whole),
    };
  });

  return {
    name: file.slice(0, -3),
    total: routes.length,
    open: routes.filter((r) => !r.middleware && !r.inBody).length,
    inBody: routes.filter((r) => !r.middleware && r.inBody).length,
  };
}

const audited = fs.readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.js'))
  .map(auditRouter);

// ---------------------------------------------------------------------------

test('the scanner can still see an unguarded route (canary)', () => {
  // An empty finding list is indistinguishable from a broken scanner unless the
  // scanner is known to fire on something it must catch. This is the exact
  // input the first draft got wrong: auth named only in a comment.
  const guardedOnlyByProse = stripCommentsAndStrings(
    "// authenticate is handled elsewhere\nrouter.post('/open', async (req, res) => { res.json({}); });"
  );
  assert.ok(!AUTH_MW.test(guardedOnlyByProse),
    'a route whose only mention of auth is a comment reads as guarded, so every result below is worthless');

  const reallyGuarded = stripCommentsAndStrings(
    "router.post('/x', authenticate, async (req, res) => { res.json({}); });"
  );
  assert.ok(AUTH_MW.test(reallyGuarded),
    'the stripper ate real middleware, so every router would read as public');
});

test('it is actually reading the route files', () => {
  assert.ok(audited.length >= 30,
    `expected the full router set, found ${audited.length}`);
  const totalRoutes = audited.reduce((n, r) => n + r.total, 0);
  assert.ok(totalRoutes >= 100,
    `expected to have parsed a realistic number of endpoints, found ${totalRoutes}`);
});

test('no router serves an unauthenticated endpoint without a written reason', () => {
  const unaccounted = audited
    .filter((r) => r.open > 0 && !(r.name in EXPECTED_PUBLIC))
    .map((r) => `${r.name}.js (${r.open} of ${r.total} endpoints have no auth middleware and no in-handler check)`);

  assert.deepStrictEqual(unaccounted, [],
    'these routers expose endpoints nobody decided to make public. If that is intended, add the router to '
    + 'EXPECTED_PUBLIC in this file with the reason. If it is not, add authenticate:\n  '
    + unaccounted.join('\n  '));
});

test('every reason on the public list is a real sentence', () => {
  for (const [name, reason] of Object.entries(EXPECTED_PUBLIC)) {
    assert.ok(typeof reason === 'string' && reason.trim().length > 20,
      `${name} is listed as public with no usable reason, which tells the next reader nothing`);
  }
});

test('no reason on the public list has gone stale', () => {
  // A router listed as public that is now fully guarded means the reason is
  // describing something that is no longer true. Stale reasons are how a real
  // one gets waved through later.
  const stale = audited
    .filter((r) => r.open === 0 && r.inBody === 0 && r.name in EXPECTED_PUBLIC)
    .map((r) => r.name);

  assert.deepStrictEqual(stale, [],
    'these routers are listed as public but every endpoint is now guarded by middleware. '
    + 'Remove them from EXPECTED_PUBLIC:\n  ' + stale.join('\n  '));
});

test('every router named on the public list still exists', () => {
  const present = new Set(audited.map((r) => r.name));
  const ghosts = Object.keys(EXPECTED_PUBLIC).filter((n) => !present.has(n));
  assert.deepStrictEqual(ghosts, [],
    'these names are on the public list but there is no such route file, so the list is drifting:\n  ' + ghosts.join('\n  '));
});

test('the sensor ingest is authenticated in the handler, not by middleware', () => {
  // The one in-handler case, pinned so that a change of mechanism is a visible
  // decision rather than a silent one. A Pi has no session; it holds a device
  // key. If this ever moves to middleware, this test says so.
  const sensors = audited.find((r) => r.name === 'sensors');
  assert.ok(sensors, 'routes/sensors.js is gone');
  assert.strictEqual(sensors.open, 0,
    'a sensor endpoint now has no authentication at all, neither middleware nor a device key');
  assert.ok(sensors.inBody >= 1,
    'the x-api-key ingest check disappeared from routes/sensors.js');
});

test('the sensor ingest still reads the key AND resolves it to a device', () => {
  // IN_BODY_AUTH is deliberately a coarse net: it answers "does this handler do
  // auth of its own", and it is satisfied by any one of several tokens. That is
  // the right shape for the survey above and the wrong shape for proving THIS
  // route is safe, which the mutation check showed directly — blanking the
  // header read left findDeviceByApiKey in the file and the survey never
  // noticed. Both halves are named here, because either one alone is not
  // authentication: a key nobody looks up, or a lookup with nothing to look up.
  // Comments stripped, strings KEPT: this check is about which header is read.
  const code = stripComments(
    fs.readFileSync(path.join(ROUTES_DIR, 'sensors.js'), 'utf8')
  );
  const from = code.indexOf('router.post(');
  assert.ok(from > -1, 'routes/sensors.js no longer has a POST ingest at all');
  const rest = code.slice(from + 1);
  const nextCall = rest.search(/router\.(get|post|put|patch|delete)\(/);
  const ingest = nextCall > -1 ? code.slice(from, from + 1 + nextCall) : code.slice(from);

  assert.match(ingest, /req\.headers\[\s*['"]x-api-key['"]\s*\]/i,
    'the ingest no longer reads a device key off the request, so anything can post sensor readings');
  assert.match(ingest, /findDeviceByApiKey\s*\(/,
    'the ingest no longer resolves the key to a registered device, so any string authenticates');
});
