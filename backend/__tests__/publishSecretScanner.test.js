// Run: node --test  (from backend/)
//
// Pins tools/publish/scan-secrets.py against the leak it was written for.
//
// THE INCIDENT. On 2026-08-25 a real password was found in the
// public mirror. It sat in three public commits inside backend/seeds/demo-data.js
// as the argument to bcrypt.hash(), as the login password for a real account. It
// was public for six days, the repository had to be deleted and rebuilt, and the
// password was in real use elsewhere.
//
// Nothing caught it. .gitignore stops whole files and that file belongs in the
// repository. The mirror strip list stops whole paths and has the same problem.
// gitleaks was green throughout and structurally always would have been, because
// a dictionary word with two digit substitutions has no key prefix, no delimiter
// and no entropy spike. redactions.txt only removes literals somebody already
// knew about, and not knowing was the whole failure.
//
// So the test below is not a unit test of a helper. It rebuilds the exact
// situation in a throwaway git repository: a bcrypt.hash() call holding a
// real-looking password, committed, then edited away in a LATER commit so the
// working tree is clean and only history still carries it. That second part is
// the part that matters, because a scanner that reads the checked-out tree would
// call that repository clean and it is not.
//
// Three things are asserted, in this order:
//   1. the scanner refuses (exit 1) and names the file, the commit and the line
//   2. the same repository passes (exit 0) once the literal is redacted out of
//      history, which is what publish-public.sh does before the scan runs
//   3. the same call shape with an obvious placeholder never fires at all, so
//      the check cannot be "made to pass" by turning it into noise everyone
//      learns to ignore
//
// No secret from the real repository appears here. Every literal is invented.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCANNER = path.join(__dirname, '..', '..', 'tools', 'publish', 'scan-secrets.py');

// Invented for this test and not a password anybody uses. It is deliberately
// shaped exactly like the one that leaked: a name, mixed case, leetspeak digits,
// no separators, no vendor prefix, nothing a signature scanner can key on.
const PLANTED = 'Br1ghtF0x22';
const PLACEHOLDER = 'Password1';

function python() {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function scan(repo, extra = []) {
  const py = python();
  const r = spawnSync(py, [SCANNER, '--repo', repo, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// A repository whose HEAD is clean and whose HISTORY is not, which is the shape
// the real leak had by the time anyone looked.
function seedRepo(secret) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-scan-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'scanner-test@example.com']);
  git(dir, ['config', 'user.name', 'Scanner Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);

  fs.mkdirSync(path.join(dir, 'backend', 'seeds'), { recursive: true });
  const seedFile = path.join(dir, 'backend', 'seeds', 'demo-data.js');

  fs.writeFileSync(seedFile, [
    "const bcrypt = require('bcrypt');",
    'const SALT_ROUNDS = 10;',
    '',
    'async function seedDemoAccount(pool) {',
    `  const hashed = await bcrypt.hash('${secret}', SALT_ROUNDS);`,
    "  await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)',",
    "    ['demo@example.com', hashed]);",
    '}',
    '',
    'module.exports = { seedDemoAccount };',
    '',
  ].join('\n'));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'Seed a demo account for the review build']);

  // The fix that is NOT a fix: the literal leaves the working tree and stays in
  // every commit behind it. This is why the scanner walks blobs and not files.
  fs.writeFileSync(seedFile, [
    "const bcrypt = require('bcrypt');",
    'const SALT_ROUNDS = 10;',
    '',
    'async function seedDemoAccount(pool) {',
    '  const hashed = await bcrypt.hash(process.env.DEMO_PASSWORD, SALT_ROUNDS);',
    "  await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)',",
    "    ['demo@example.com', hashed]);",
    '}',
    '',
    'module.exports = { seedDemoAccount };',
    '',
  ].join('\n'));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'Read the demo password from the environment']);
  return dir;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a temp directory that outlives the test is not a failure */
  }
}

const py = python();

// git-filter-repo is a python module, and publish-public.sh locates it exactly
// this way. Only the redaction test needs it; the refusal tests do not.
const filterRepo = (() => {
  if (!py) return null;
  const r = spawnSync(py, ['-c', 'import git_filter_repo;print(git_filter_repo.__file__)'],
    { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
})();

test('scan-secrets.py refuses a bcrypt.hash() password that only history still holds', { skip: py ? false : 'no python on PATH' }, () => {
  const dir = seedRepo(PLANTED);
  try {
    // The literal is gone from the checked-out tree. A tree scanner sees nothing.
    assert.ok(!fs.readFileSync(path.join(dir, 'backend', 'seeds', 'demo-data.js'), 'utf8').includes(PLANTED));
    const head = scan(dir, ['--head-only']);
    assert.strictEqual(head.code, 0, `HEAD alone should look clean, got:\n${head.out}`);

    // History still holds it, and that is what gets published.
    const full = scan(dir);
    assert.strictEqual(full.code, 1, `expected a refusal, got exit ${full.code}:\n${full.out}`);
    assert.match(full.out, /credential_literal/);
    assert.match(full.out, /backend\/seeds\/demo-data\.js:5/,
      'the finding must name the file and the line, or nobody can judge it');
    assert.match(full.out, /bcrypt\.hash\(\) and not a recognizable placeholder/);
    assert.match(full.out, /oldest commit carrying this blob/);

    // The report must be usable and must not itself republish the secret.
    assert.ok(!full.out.includes(PLANTED),
      'the report printed the secret in full; the excerpt has to be redacted');
    assert.match(full.out, /Br\*+22/, 'the redacted excerpt should still be recognisable');
    assert.match(full.out, /allow:\s+credential_literal:[0-9a-f]{16}\s+# reason:/,
      'every finding must print a ready-to-paste allowlist line');
  } finally {
    rmrf(dir);
  }
});

test('the same history passes once the literal is redacted, which is what the publish script does first', { skip: filterRepo ? false : 'no python or git-filter-repo on PATH' }, () => {
  const dir = seedRepo(PLANTED);
  try {
    assert.strictEqual(scan(dir).code, 1);

    // The real redaction step, not an imitation of it: the same
    // git-filter-repo --replace-text pass publish-public.sh runs, driven by the
    // same redactions.txt line format. The scanner must be satisfied afterwards,
    // because a gate that cannot be satisfied is a gate that gets deleted.
    const redactions = path.join(os.tmpdir(), `flock-redactions-${process.pid}.txt`);
    fs.writeFileSync(redactions, `${PLANTED}==>REDACTED_PASSWORD\n`);
    const r = spawnSync(py, [filterRepo, '--force', '--replace-text', redactions],
      { cwd: dir, encoding: 'utf8' });
    fs.rmSync(redactions, { force: true });
    assert.strictEqual(r.status, 0, `git-filter-repo failed: ${r.stderr}`);

    const after = spawnSync('git', ['log', '--all', '-S', PLANTED, '--oneline'],
      { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(after.stdout.trim(), '', 'the literal should be gone from every commit');

    const clean = scan(dir);
    assert.strictEqual(clean.code, 0, `expected a pass after redaction, got:\n${clean.out}`);
    assert.match(clean.out, /clean in/);
  } finally {
    rmrf(dir);
  }
});

test('an obvious placeholder in the same call never fires, so the check stays worth reading', { skip: py ? false : 'no python on PATH' }, () => {
  const dir = seedRepo(PLACEHOLDER);
  try {
    const r = scan(dir);
    assert.strictEqual(r.code, 0,
      `Password1 is a fixture and must not refuse a push, got:\n${r.out}`);
  } finally {
    rmrf(dir);
  }
});

test('the allowlist demands a reason and rejects a bare suppression', { skip: py ? false : 'no python on PATH' }, () => {
  const dir = seedRepo(PLANTED);
  const listDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-allow-'));
  try {
    // Find the fingerprint the scanner prints for the planted secret.
    const refused = scan(dir);
    const key = /allow:\s+(credential_literal:[0-9a-f]{16})/.exec(refused.out);
    assert.ok(key, 'the refusal should print an allowlist key');

    // A key with no reason is an ERROR, not a quiet pass.
    const bare = path.join(listDir, 'bare.txt');
    fs.writeFileSync(bare, `${key[1]}\n`);
    const bareRun = scan(dir, ['--allowlist', bare]);
    assert.strictEqual(bareRun.code, 2, `a reasonless entry must fail loudly:\n${bareRun.out}`);
    assert.match(bareRun.out, /carries no reason/);

    // With a reason it suppresses, and says out loud that it did.
    const good = path.join(listDir, 'good.txt');
    fs.writeFileSync(good, `${key[1]}  # reason: invented literal planted by the scanner regression test\n`);
    const goodRun = scan(dir, ['--allowlist', good]);
    assert.strictEqual(goodRun.code, 0, `an explained entry should suppress:\n${goodRun.out}`);
    assert.match(goodRun.out, /suppressed by 1 allowlist/);
  } finally {
    rmrf(dir);
    rmrf(listDir);
  }
});
