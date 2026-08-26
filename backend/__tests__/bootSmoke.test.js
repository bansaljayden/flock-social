'use strict';
// ---------------------------------------------------------------------------
// Boot smoke test — the test the 2026-08-13 outage did not have.
//
// A refactor deleted `const pool = require('./config/database')` from
// server.js while four call sites kept using `pool`. Nothing in the suite went
// red, because server.js boots on require, so every other test covers it by
// LIFTING blocks out of the source and running them with a supplied pool —
// right for logic, structurally blind to the file's own imports. Production
// crash-looped for 73 minutes on a ReferenceError the first time boot() ran.
//
// This test closes that class by actually EXECUTING server.js, in a child
// process, under a controlled environment, and demanding one of exactly two
// outcomes before a deadline:
//
//   1. the boot-progress line ("Flock API running on port ..."), or
//   2. a nonzero exit that NAMES its cause (the FATAL + CAUSE lines boot()
//      prints when migrations fail).
//
// A refused TCP connection is a perfectly acceptable named outcome — the child
// is pointed at 127.0.0.1:1, where nothing listens, precisely so no database
// is needed. What is NOT acceptable is the outage class: a ReferenceError or
// SyntaxError anywhere in the output (a deleted require, a typo, a top-of-file
// crash) fails this test naming it, even when boot()'s catch dresses it up in
// a CAUSE line. Reaching either accepted outcome proves module-scope
// evaluation completed — boot() only runs after the whole file evaluated.
//
// CRITICAL SAFETY: the child env is built EXPLICITLY, never copied from
// process.env, so this test can never pick up the real DATABASE_URL from a
// developer shell (backend/.env points at the production Railway proxy). The
// child's cwd is an empty temp directory so dotenv finds no .env to load.
// A dedicated test below asserts the allowlist holds.
//
// Mutation verification (do it against a COPY, never the real server.js):
//   cp server.js server.mutant.tmp.js   # then delete the pool require in it
//   BOOT_SMOKE_ENTRY=server.mutant.tmp.js node --test __tests__/bootSmoke.test.js
//   # must FAIL naming the ReferenceError; delete the copy afterwards.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BACKEND = path.join(__dirname, '..');
// BOOT_SMOKE_ENTRY exists only for mutation drills against a scratch copy; the
// basename() confines it to files inside backend/ no matter what is passed.
const ENTRY = path.join(BACKEND, path.basename(process.env.BOOT_SMOKE_ENTRY || 'server.js'));

// Well under 10s total: the measured boot-to-CAUSE time on this repo is <1s;
// the margin is for a cold module cache on a slow disk.
const DEADLINE_MS = 9000;

// Port 1 on loopback: connection refused immediately, on every OS, with no
// DNS lookup and no chance of anything real listening there.
const REFUSED_DB_URL = 'postgresql://boot-smoke:boot-smoke@127.0.0.1:1/boot_smoke_no_db';

const BOOT_LINE = /Flock API running on port \d+/;
const FATAL_LINE = /FATAL: migration failed/;
const CAUSE_LINE = /^CAUSE: .+/m;
// The outage class. "is not defined" catches a ReferenceError even when only
// its .message survives into the CAUSE line.
const CRASH_CLASS = /\b(ReferenceError|SyntaxError)\b|\bis not defined\b/;

// The complete allowlist. EXPLICIT_ENV is everything server.js needs to reach
// a decision; PLUMBING_KEYS are OS process plumbing (compared lowercase —
// Windows spells them inconsistently) that carry no credentials.
const EXPLICIT_ENV = Object.freeze({
  NODE_ENV: 'production', // exercises the strictest path (JWT guard, TLS default)
  PORT: '0',
  JWT_SECRET: 'boot-smoke-placeholder-not-a-real-secret',
  DATABASE_URL: REFUSED_DB_URL,
});
const PLUMBING_KEYS = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'comspec', 'pathext']);

function buildChildEnv() {
  const env = { ...EXPLICIT_ENV };
  for (const key of Object.keys(process.env)) {
    if (PLUMBING_KEYS.has(key.toLowerCase()) && !(key in env)) env[key] = process.env[key];
  }
  return env;
}

test('the child env is an explicit allowlist — it can never carry the real DATABASE_URL', () => {
  const env = buildChildEnv();
  for (const key of Object.keys(env)) {
    assert.ok(
      key in EXPLICIT_ENV || PLUMBING_KEYS.has(key.toLowerCase()),
      `child env carries "${key}", which is on neither allowlist — the env must be built ` +
      'explicitly, never spread from process.env, or the smoke test could boot against production'
    );
  }
  assert.strictEqual(env.DATABASE_URL, REFUSED_DB_URL,
    'the child DATABASE_URL must be the refused-port sentinel');
  if (process.env.DATABASE_URL) {
    assert.notStrictEqual(env.DATABASE_URL, process.env.DATABASE_URL,
      'the child must never receive the parent shell\'s DATABASE_URL');
  }
  // pg falls back to PG* natively when connectionString is missing, so these
  // must be absent too, not merely different.
  for (const pgKey of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE']) {
    assert.ok(!(pgKey in env), `${pgKey} must not reach the child`);
  }
});

test('server.js boots to its listen line or exits with a NAMED cause — never a bare crash', async () => {
  assert.ok(fs.existsSync(ENTRY), `entry file does not exist: ${ENTRY}`);

  // An empty cwd so `require('dotenv').config()` in the child finds no .env —
  // nothing in the boot path reads process.cwd() (checked), all file access is
  // __dirname-relative.
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-boot-smoke-'));
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [ENTRY], {
        cwd: tmpCwd,
        env: buildChildEnv(),
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let bootSeen = false;
      let timedOut = false;
      let forceTimer = null;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // If even SIGKILL-adjacent teardown stalls, report the deadline rather
        // than hanging the suite.
        forceTimer = setTimeout(
          () => resolve({ outcome: 'deadline', code: null, stdout, stderr }), 3000);
      }, DEADLINE_MS);
      child.stdout.on('data', (d) => {
        stdout += d;
        if (!bootSeen && BOOT_LINE.test(stdout)) {
          bootSeen = true; // outcome 1 reached; stop the child, then wait for exit
          child.kill();
        }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); reject(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        resolve({
          outcome: timedOut ? 'deadline' : (bootSeen ? 'booted' : 'exited'),
          code, stdout, stderr,
        });
      });
    });
  } finally {
    fs.rmSync(tmpCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const tail = combined.trim().split('\n').slice(-15).join('\n');

  // The outage class fails REGARDLESS of which outcome the process reached:
  // boot()'s catch turns "pool is not defined" into a tidy CAUSE line, and a
  // tidy CAUSE line does not make a deleted require acceptable.
  const crash = CRASH_CLASS.exec(combined);
  if (crash) {
    const line = combined.split('\n').find((l) => CRASH_CLASS.test(l)) || crash[0];
    assert.fail(
      `server.js hit the outage class this test exists for: ${line.trim()}\n` +
      `--- child output (tail) ---\n${tail}`
    );
  }

  if (result.outcome === 'booted') return; // outcome 1: the listen line

  assert.notStrictEqual(result.outcome, 'deadline',
    `server.js neither booted nor exited within ${DEADLINE_MS}ms — a hang is not a named outcome\n` +
    `--- child output (tail) ---\n${tail}`);

  // outcome 2: a nonzero exit that names its cause.
  assert.notStrictEqual(result.code, 0,
    `server.js exited 0 without ever printing its listen line — a silent no-op boot\n` +
    `--- child output (tail) ---\n${tail}`);
  assert.ok(FATAL_LINE.test(combined) && CAUSE_LINE.test(combined),
    `server.js exited ${result.code} without the named FATAL + CAUSE lines — an unnamed ` +
    `crash is exactly what turned the last refactor into a 73-minute outage\n` +
    `--- child output (tail) ---\n${tail}`);

  // Proof module-scope evaluation completed: this line prints at the very top
  // of server.js, and the FATAL/CAUSE pair only prints from boot(), which runs
  // after the entire module evaluated.
  assert.match(result.stdout, /DATABASE_URL: \[configured\]/,
    'the child never printed the top-of-file config line — module evaluation did not even start');
});

// ---------------------------------------------------------------------------
// EVERY TIMER boot() STARTS, shutdown() STOPS
// ---------------------------------------------------------------------------
// boot() starts fourteen repeating jobs: crowd alerts, the venue digest, the
// photo prune, the expired-story purge, the flock sweep, the money watch, the
// night-context sweep and their staggered kickoffs. shutdown() has to clear
// every one, or the process keeps a live handle after SIGTERM and Railway's
// stop turns into a kill.
//
// THIS TEST IS A CLASS, AND IT EXISTS BECAUSE ITS INSTANCE WAS NOT. The story
// purge was scheduled on 2026-08-26 with a guard written for exactly that one
// timer, by name. That guard would not have noticed the next timer added
// without a clear, which is the same fix-the-instance-miss-the-class shape that
// has come up repeatedly. Naming a new timer is not a thing anybody should have
// to remember to do twice.
//
// Comments and string literals are stripped before matching. A source scan that
// cannot tell code from prose reports whatever the prose says, and server.js is
// full of comments that name these handles while explaining them.
test('every interval and timeout boot() assigns is cleared in shutdown()', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  const code = (() => {
    const s = raw.split('\r').join('');
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      const d = s[i + 1];
      if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
      if (c === '/' && d === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c; out += ' '; i += 1;
        while (i < s.length) {
          if (s[i] === '\\') { i += 2; continue; }
          if (s[i] === q) { i += 1; break; }
          if (q !== '`' && s[i] === '\n') break;
          i += 1;
        }
        continue;
      }
      out += c; i += 1;
    }
    return out;
  })();

  const scheduled = new Map();   // handle -> 'Interval' | 'Timeout'
  for (const m of code.matchAll(/(\w+)\s*=\s*set(Interval|Timeout)\s*\(/g)) {
    // Skip locals that are not module-level handles; every real one is
    // declared as `let <name> = null;` at module scope.
    //
    // A plain includes(), not a RegExp built from a template literal. That
    // construction ate its own backslashes twice in this codebase already
    // (\s became s, \b became a backspace character) and produced a pattern
    // that matched nothing while reading like a check.
    if (code.includes('let ' + m[1] + ' = null')) scheduled.set(m[1], m[2]);
  }

  const cleared = new Set();
  for (const m of code.matchAll(/clear(?:Interval|Timeout)\s*\(\s*(\w+)\s*\)/g)) cleared.add(m[1]);

  // The scan has to be known to have found something. An empty `scheduled`
  // would make the assertion below pass over a server with no cleanup at all.
  assert.ok(scheduled.size >= 8,
    `expected boot() to schedule the known set of repeating jobs; found ${scheduled.size}, so this scan is reading the wrong thing`);

  const leaked = [...scheduled.keys()].filter((h) => !cleared.has(h)).sort();
  assert.deepStrictEqual(leaked, [],
    'these timers are started and never cleared, so SIGTERM leaves a live handle and the stop becomes a kill:\n  '
    + leaked.join('\n  '));
});

test('the clears live in shutdown(), not somewhere that never runs', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = raw.indexOf('function shutdown(');
  assert.ok(from > -1, 'server.js no longer has a shutdown function');
  const body = raw.slice(from, from + 4000);
  // A representative handful rather than all fourteen: this asserts the clears
  // are INSIDE shutdown, which the test above cannot see. The class check is
  // the one above; this pins where it happens.
  for (const handle of ['crowdAlertsInterval', 'storyPurgeInterval', 'nightContextInterval']) {
    assert.ok(body.includes(`clearInterval(${handle})`),
      `${handle} is cleared somewhere other than shutdown(), so SIGTERM does not reach it`);
  }
});
