// Run: node --test  (from backend/)
//
// EVERY VARIABLE THE BACKEND READS IS DOCUMENTED IN .env.example.
//
// .claude/CLAUDE.md names backend/.env.example as "the authoritative list" of
// every variable the code actually reads, with what BREAKS when each is
// missing. That promise had no guard, and on 2026-09-01 six variables were
// being read with no entry at all, two of them added that same day
// (HEARTBEAT_DISABLED, PHOTO_BUDGET_USD_PER_YEAR). A deployer reading the
// authoritative list would not have known they existed. This pins the promise:
// any `process.env.NAME` read in the application source must have a line in
// .env.example that documents NAME, either as `NAME=` or as a commented
// `# NAME=` example. Tests and scripts are not swept, on purpose: a one-off
// script's knob is not a deployment variable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const SWEPT_DIRS = ['routes', 'services', 'utils', 'config', 'middleware', 'sockets', 'db'];
const SWEPT_FILES = ['server.js'];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(p, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

function readVars(extraDirs = []) {
  const files = SWEPT_FILES.map((f) => path.join(BACKEND, f));
  for (const d of [...SWEPT_DIRS, ...extraDirs]) {
    const full = path.join(BACKEND, d);
    if (fs.existsSync(full)) walk(full, files);
  }
  const names = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
    // Bracket form, and the `env.NAME` alias routes/ai.js uses after binding
    // `env` to process.env. An upper-case property on something called env is
    // an environment read by any other spelling.
    for (const m of src.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) names.add(m[1]);
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]);
    // services/entitlements.js reads flags through boolFlag('NAME'), which is a
    // process.env read by any other name and must count as one.
    for (const m of src.matchAll(/boolFlag\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) names.add(m[1]);
  }
  return names;
}

function documentedVars() {
  const example = fs.readFileSync(path.join(BACKEND, '.env.example'), 'utf8').replace(/\r\n/g, '\n');
  const names = new Set();
  for (const m of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) names.add(m[1]);
  return names;
}

test('the sweep is reading real code, not an empty tree', () => {
  const read = readVars();
  assert.ok(read.size >= 40, `expected dozens of env reads in the backend, found ${read.size}; the sweep is pointed at the wrong place`);
  assert.ok(read.has('JWT_SECRET') && read.has('GEMINI_API_KEY'), 'two variables every deploy needs must be in the swept set');
});

test('every variable the backend reads has an entry in .env.example', () => {
  const read = readVars();
  const documented = documentedVars();
  const missing = [...read].filter((n) => !documented.has(n)).sort();
  assert.deepStrictEqual(missing, [],
    `these variables are read by the backend and have no entry in backend/.env.example, which .claude/CLAUDE.md calls the authoritative list:\n  `
    + missing.join('\n  ')
    + '\nAdd each with what it does, where it is read, and what breaks when it is missing.');
});

test('.env.example does not document variables nothing reads', () => {
  // The other direction. A documented variable nobody reads sends a deployer
  // to set something that does nothing; the same file already warns about
  // its own rot. A short allowlist covers names read indirectly: by the pg
  // driver, by the platform, or by a script rather than the server.
  const INDIRECT = new Set([
    'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'DATABASE_URL',
    'PORT', 'NODE_ENV', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PUBLIC_DOMAIN',
    'SEED_REVIEW_CONFIRM', 'SEED_REAL_USER_PASSWORD',
  ]);
  // Scripts are swept here and only here: a variable a script reads is a
  // legitimate entry, but a script's knob is not an application variable.
  const read = readVars(['scripts', 'seeds']);
  for (const f of fs.readdirSync(BACKEND)) {
    if (f.endsWith('.js') && !SWEPT_FILES.includes(f)) {
      const src = fs.readFileSync(path.join(BACKEND, f), 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) read.add(m[1]);
    }
  }
  const documented = documentedVars();
  const stale = [...documented].filter((n) => !read.has(n) && !INDIRECT.has(n)).sort();
  // This began as a report rather than a failure, because the file predated
  // the guard and sixteen names came back the first time. Widening the read
  // patterns to the env alias and the bracket form, and sweeping seeds and
  // scripts, took that list to zero, so it is a failure now: a documented
  // variable nothing reads sends a deployer to set something that does nothing.
  const staleMsg = ['these .env.example entries are read by nothing in server.js, routes, services, utils, config, middleware, sockets, db, scripts or seeds:']
    .concat(stale.map((n) => '  ' + n))
    .concat(['Either the code stopped reading them, so remove the entry, or add the reading site to the sweep.'])
    .join(String.fromCharCode(10));
  assert.deepStrictEqual(stale, [], staleMsg);
});
