// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-config.md finding #1 (MEDIUM): the CORS origin check used
//   /^https:\/\/flock-app(-[a-z0-9]+)*\.vercel\.app$/
// which matches ANY flock-app-<anything>.vercel.app. Anyone can register a
// Vercel project named `flock-app-evil` and receive exactly the origin
// `https://flock-app-evil.vercel.app`, so the regex admitted an
// attacker-controlled origin.
//
// The fix pins the pattern to this project's real production slug
// `flock-app-w65m` AND to the Vercel PREVIEW url structure (a build-hash or
// `git-<branch>` label, then a deploy-scope label). This test drives the REAL
// allowlist logic lifted out of server.js — the exact `allowedOrigins` array
// and the `VERCEL_PREVIEW_ORIGIN` regex the running server uses — so it tracks
// the code rather than a copy of it, the same lift-from-source discipline
// securityChecklist.test.js uses. If a future edit re-widens the pattern, the
// two attacker origins below start being ACCEPTED and this file goes red.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Lift the region that declares `allowedOrigins` and `VERCEL_PREVIEW_ORIGIN`.
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

// Reconstruct the two values the origin callback consults, from server.js's
// own source. A fake `process` supplies the one env read in the region.
const build = new Function(
  'process',
  `${region}\n; return { allowedOrigins, VERCEL_PREVIEW_ORIGIN };`
);
const { allowedOrigins, VERCEL_PREVIEW_ORIGIN } = build({ env: {} });

// The exact predicate both cors() callbacks apply (REST at app.use(cors(...))
// and the Socket.io handshake).
const isAllowed = (origin) =>
  allowedOrigins.includes(origin) || VERCEL_PREVIEW_ORIGIN.test(origin);

test('the real production host is allowed', () => {
  assert.ok(isAllowed('https://flock-app-w65m.vercel.app'));
});

test('a representative real Vercel preview host is allowed', () => {
  // Vercel preview shape: <project>-<build-hash>-<scope>.vercel.app
  assert.ok(isAllowed('https://flock-app-w65m-abc123def-flock.vercel.app'));
  // ...and the git-branch preview shape: <project>-git-<branch>-<scope>.vercel.app
  assert.ok(isAllowed('https://flock-app-w65m-git-main-flock.vercel.app'));
});

test('the attacker-registrable flock-app-evil.vercel.app is REJECTED', () => {
  assert.strictEqual(isAllowed('https://flock-app-evil.vercel.app'), false);
  // Any other project-root host of the flock-app-* family is likewise a
  // different project, not a preview of ours.
  assert.strictEqual(isAllowed('https://flock-app-attacker.vercel.app'), false);
});

test('a suffix-smuggling host is REJECTED', () => {
  assert.strictEqual(isAllowed('https://flock-app-w65m.vercel.app.attacker.com'), false);
  // A prefix-smuggling variant is rejected too.
  assert.strictEqual(isAllowed('https://evil-flock-app-w65m.vercel.app'), false);
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
    assert.ok(isAllowed(origin), `expected allowed: ${origin}`);
  }
});
