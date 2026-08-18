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

test('both the REST callback and the socket handshake use the one predicate', () => {
  // R2-1 noted the two paths share a constant and said to keep it that way.
  // Anything less means one of them can be tightened and the other forgotten.
  const uses = serverSrc.match(/isAllowedOrigin\(origin\)/g) || [];
  assert.strictEqual(uses.length, 2, 'expected exactly two call sites: REST cors() and the Socket.io handshake');
  assert.ok(
    !/VERCEL_PREVIEW_ORIGIN/.test(serverSrc),
    'the bypassed preview regex is back in server.js'
  );
});
