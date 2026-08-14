// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// services/firebaseService.js was once committed with a regex literal that had
// literal control bytes inside it, one of which was a raw newline (0x0A). A
// newline terminates a regex literal, so the file did not parse. Every module
// that required it — directly or four levels down — failed to load, 28 test
// files went red at once, and not one of those 28 failures named the file that
// was actually broken. The signal read as "the suite is falling apart", which
// is the least actionable shape a failure can take. The same file would have
// killed the server on boot, and Railway deploys on push with no test gate.
//
// So the point of this file is ATTRIBUTION, not cleverness. It answers one
// question in one line: which file is broken, and where. It runs in about half
// a second so it is never the thing anyone skips, and
// every check in it is chosen so that a failure is always a real defect. A
// check that cries wolf here is worse than no check at all, because the whole
// value is that you can act on it without reading any other output.
//
// ---------------------------------------------------------------------------
// PARSE vs REQUIRE — how each file is classified
// ---------------------------------------------------------------------------
// Parsing (vm.Script over the CommonJS wrapper) compiles a file without
// running a single statement of it, so it is safe for EVERY file and is the
// check that would have caught the original bug. It is applied to all of them.
//
// Requiring additionally proves a module survives its own top-level code, but
// it runs that code, so it is opt-OUT rather than opt-in: everything ships
// under require unless it is on DO_NOT_REQUIRE below with a stated reason.
// Opt-out is the safer default here — a new file dropped into routes/ or
// services/ is covered the day it lands instead of waiting for someone to
// remember to add it to a list.
//
// Requiring is measurably safe for the modules that are not excluded: none of
// them opens a listening socket, none calls process.exit, and the one live
// handle any of them leaves (config/database.js's `SELECT NOW()` startup probe,
// config/database.js:72) is already required by the existing suite and settles
// as connection-refused against an unset DATABASE_URL in milliseconds.
//
// ---------------------------------------------------------------------------
// NO NEW DEPENDENCY
// ---------------------------------------------------------------------------
// eslint (and therefore `no-control-regex`) is not installed in backend/. acorn
// is present under node_modules, but only as a hoisted transitive of
// @sentry/node -> import-in-the-middle, so any `npm install` is free to move or
// drop it — a test that silently stops running is exactly the failure mode this
// file exists to prevent. Everything below is built on node:vm and node:module.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const BACKEND = path.join(__dirname, '..');

// Directories that are not shipped JavaScript, or whose JavaScript is not ours.
// __tests__ is deliberately absent: `node --test` already names an unparseable
// test file precisely, and several agents edit test files concurrently, so a
// half-written one would turn this file red for a reason that is not a defect.
const SKIP_DIRS = new Set([
  'node_modules', '__tests__', 'uploads', 'backups', 'coverage',
  'dist', 'build', '.git', '.cache',
]);

// Every failure below is reported through this rather than a deepStrictEqual
// against [], so the output is the sentence that says what to open instead of
// an actual/expected array diff wrapped around it.
function failWith(lines, headline, footer) {
  if (!lines.length) return;
  assert.fail(headline + '\n' + lines.join('\n') + (footer ? '\n\n' + footer : ''));
}

// Files whose top-level code must NOT run inside a test process. Each one is
// parsed like everything else; only the require pass skips it.
const DO_NOT_REQUIRE = new Map([
  ['server.js',
    'calls boot() at module scope: runs migrations against a real database and ' +
    'listen()s on PORT. scripts/e2e-local.js:85 requires it precisely for that ' +
    'side effect, so it must keep it.'],
  ['setup-database.js',
    'connects to Postgres and calls process.exit() at module scope — requiring ' +
    'it would kill the test runner.'],
  ['instrument.js',
    "calls require('dotenv').config(), which loads the developer's local " +
    'backend/.env into process.env for the rest of the process. What the ' +
    'remaining assertions saw would then differ machine to machine.'],
]);

// Whole trees excluded from the require pass for the same reason: one-shot jobs
// that do their work at module scope (scripts/e2e-local.js boots the server;
// the ml collectors call paid upstream APIs; seeds write rows).
const DO_NOT_REQUIRE_TREES = ['scripts', 'seeds'];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && /\.(js|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const rel = (abs) => path.relative(BACKEND, abs).split(path.sep).join('/');

// Read every file up front, and drop any that vanishes between the walk and the
// read. Four agents write to this tree concurrently; a file that no longer
// exists is somebody else's rename in progress, not a defect, and crashing the
// whole file over it would be the same unattributable noise this exists to end.
const sources = new Map(); // abs -> source text
for (const abs of walk(BACKEND, []).sort()) {
  try {
    sources.set(abs, fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
const FILES = [...sources.keys()];

function mayRequire(abs) {
  const r = rel(abs);
  if (DO_NOT_REQUIRE.has(r)) return false;
  return !DO_NOT_REQUIRE_TREES.some((t) => r.startsWith(t + '/'));
}

// ---------------------------------------------------------------------------
// Shared analysis — done once, so no test depends on another test having run.
// ---------------------------------------------------------------------------

function lineColOf(src, index) {
  const before = src.slice(0, index);
  const nl = before.lastIndexOf('\n');
  return { line: before.split('\n').length, col: index - nl };
}

// Compile the CommonJS wrapper without executing it. The wrapper prefix is on
// the same line as the first line of the file, exactly as Node's own loader
// writes it, so reported line numbers match the file as you would open it.
function parseError(abs, src) {
  let text = src;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);          // BOM
  if (text.startsWith('#!')) text = '//' + text.slice(2);           // shebang
  try {
    new vm.Script(
      '(function (exports, require, module, __filename, __dirname) { ' + text + '\n});',
      { filename: abs }
    );
    return null;
  } catch (err) {
    // The head of a V8 SyntaxError stack is the diagnostic worth printing: the
    // offending file:line, the source line itself, and a caret at the column.
    const lines = String(err.stack || '').split('\n');
    const cut = lines.findIndex((l) => /^\s+at /.test(l));
    const head = (cut === -1 ? lines : lines.slice(0, cut)).filter((l) => l.length);
    const lineNo = (head[0] && head[0].match(/:(\d+)$/) || [])[1] || '?';
    return { line: lineNo, message: err.message, excerpt: head.slice(1).join('\n') };
  }
}

const PARSE_FAILURES = [];
for (const abs of FILES) {
  const e = parseError(abs, sources.get(abs));
  if (e) PARSE_FAILURES.push({ abs, ...e });
}

// ---------------------------------------------------------------------------
// TEST 1 — every shipped source file parses
// ---------------------------------------------------------------------------

test('every shipped backend source file parses', () => {
  if (!PARSE_FAILURES.length) {
    assert.ok(FILES.length > 50, `expected to have found the backend sources, found ${FILES.length}`);
    return;
  }
  const report = PARSE_FAILURES.map((f) =>
    `\n  ${rel(f.abs)}:${f.line}\n    ${f.message}\n` +
    f.excerpt.split('\n').map((l) => '    ' + l).join('\n')
  ).join('\n');
  assert.fail(
    `${PARSE_FAILURES.length} backend source file(s) cannot be parsed. Nothing that ` +
    `requires them can load, and the server will not boot:\n${report}\n\n` +
    'Open the file and line above. Every other failure in this run may be a ' +
    'consequence of it.'
  );
});

// ---------------------------------------------------------------------------
// TEST 2 — no literal control or invisible characters anywhere in the source
//
// This is the `no-control-regex` check, done as a superset. Rather than try to
// decide which `/` in a file starts a regex literal and which is division —
// which cannot be done reliably without a full parser and would be the one
// place this file could produce a false positive — it forbids the bytes
// outright, everywhere.
//
// That is both simpler and strictly stronger, and it costs nothing, because
// there is no legitimate reason to type a raw 0x1B or 0x00 into a .js file: in
// a regex or a string you write the escape (\x1b), and in a comment you write
// the name. A raw control byte in source is always either a paste accident or a
// deliberate obfuscation, and it is invisible in every editor, which is what
// made the original bug so expensive to find.
//
// The two control bytes that ARE line terminators (0x0A, 0x0D) are legal
// whitespace outside a regex and so cannot be banned here — but inside a regex
// literal they terminate it, which is a syntax error, so TEST 1 owns that case.
// That is exactly what happened to firebaseService.js, and it is covered.
// ---------------------------------------------------------------------------

const ALLOWED_WHITESPACE = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR

// Invisible codepoints above the C0/C1 range that have bitten real codebases.
// U+2028/U+2029 matter for the same reason 0x0A does — JavaScript treats them
// as line terminators, so one inside a regex literal ends it. The bidi
// overrides are the Trojan Source class. U+00A0 and U+200B are paste damage:
// valid JavaScript, invisible, and not the character anybody meant to type.
const INVISIBLE = new Map([
  [0x00a0, 'NO-BREAK SPACE'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x2028, 'LINE SEPARATOR (terminates a regex literal)'],
  [0x2029, 'PARAGRAPH SEPARATOR (terminates a regex literal)'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE / BOM'],
]);

const MAX_REPORTED = 20;

test('no literal control or invisible characters in backend source', () => {
  const hits = [];
  let total = 0;
  for (const abs of FILES) {
    const src = sources.get(abs);
    for (let i = 0; i < src.length; i++) {
      const code = src.charCodeAt(i);
      let name = null;
      if ((code <= 0x1f || code === 0x7f) && !ALLOWED_WHITESPACE.has(code)) {
        name = code === 0x7f ? 'DELETE' : 'control character';
      } else if (INVISIBLE.has(code)) {
        // A BOM at offset 0 is stripped by Node's loader and is what some
        // Windows editors write on save; only a stray one mid-file is a defect.
        if (code === 0xfeff && i === 0) continue;
        name = INVISIBLE.get(code);
      }
      if (!name) continue;
      total++;
      if (hits.length >= MAX_REPORTED) continue;
      const { line, col } = lineColOf(src, i);
      const point = 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
      hits.push(
        `  ${rel(abs)}:${line}:${col}  ${point} ${name}\n` +
        `      write it as \\u${code.toString(16).toUpperCase().padStart(4, '0')} instead — ` +
        'as typed it is invisible in every editor'
      );
    }
  }
  failWith(
    hits,
    `${total} literal control/invisible character(s) in backend source` +
    (total > MAX_REPORTED ? ` (first ${MAX_REPORTED} shown)` : '') + ':',
    'Inside a regex literal these are the no-control-regex bug: the pattern ' +
    'matches a byte nobody can see, and the two that are line terminators do ' +
    'not even parse.'
  );
});

// ---------------------------------------------------------------------------
// TEST 3 — every require() of a string literal resolves, in the files nothing
//          else loads
//
// Scoped deliberately to the DO_NOT_REQUIRE set — server.js, instrument.js,
// setup-database.js, scripts/**, seeds/**. For everything else TEST 4 actually
// loads the module, which proves the same thing and proves it harder, and two
// tests failing over one typo is the cascade this file exists to end. But
// nothing loads server.js in CI, and server.js is where a bad require costs the
// most: it inlines `require('./routes/guest')` and `require('./routes/badge')`
// straight into app.use() (server.js:616-617), so a renamed route file there is
// a boot crash on Railway with no test between it and production.
//
// FALSE POSITIVES ARE THE ONLY REAL RISK HERE, because this reads text rather
// than executing it, and six commented-out requires already exist in the repo
// (utils/places.js:10-11, utils/relationships.js:12 and :65, routes/users.js:1603,
// scripts/seed-review-account.js:16 — all "call it like this" doc comments). A
// doc comment naming a path that has since been renamed is not a defect, so
// matches inside comments have to be dropped, which means finding the comments.
//
// commentRanges() below walks the source a line at a time, tracking string
// state within a line and block-comment state across lines. It is deliberately
// built so that every way it can be wrong loses coverage instead of inventing a
// failure, and so that no single line can poison the rest of the file:
//
//   * String state is per line, never carried forward. A regex literal holding
//     a quote (`/['"]/`) leaves that ONE line mis-scanned; the next line starts
//     clean.
//   * `//` beats `/*` when it comes first on a line — which is the whole reason
//     this is not a naive indexOf scan. server.js:249 is a line comment
//     containing the text `/api/auth/*`, and a naive scan reads that `/*` as
//     opening a block comment that then swallows the rest of the file,
//     including the two inline `require('./routes/…')` calls at server.js:616
//     and :617 that this check exists to protect.
//   * If a block comment is still open at end of file, the whole file's ranges
//     are discarded as untrustworthy and the file is skipped entirely.
//   * A line whose trimmed form starts with `//`, `*`, `/*` or `*/` is dropped
//     outright, independently of any of the above.
// ---------------------------------------------------------------------------

const REQUIRE_LITERAL = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g;

// First `//` or `/*` at or after `from` that is not inside a string literal.
// The scan always starts at 0 so the string state is right by the time it
// reaches `from`.
function firstOpener(line, from) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && i >= from) {
      if (line[i + 1] === '/') return { index: i, block: false };
      if (line[i + 1] === '*') return { index: i, block: true };
    }
  }
  return null;
}

// Half-open [start, end) offsets covering every comment in the file, or null if
// the file ends inside an unterminated block comment.
function commentRanges(src) {
  const ranges = [];
  let inBlock = false;
  let blockStart = 0;
  let offset = 0;
  for (const line of src.split('\n')) {
    const lineEnd = offset + line.length;
    let i = 0;
    while (i <= line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', i);
        if (close === -1) break;
        ranges.push([blockStart, offset + close + 2]);
        inBlock = false;
        i = close + 2;
        continue;
      }
      const open = firstOpener(line, i);
      if (!open) break;
      if (!open.block) { ranges.push([offset + open.index, lineEnd]); break; }
      inBlock = true;
      blockStart = offset + open.index;
      i = open.index + 2;
    }
    offset = lineEnd + 1;
  }
  return inBlock ? null : ranges;
}

test('every require() of a literal path resolves', () => {
  const missing = [];
  let checked = 0;
  for (const abs of FILES) {
    if (mayRequire(abs)) continue;          // TEST 4 loads these for real
    const src = sources.get(abs);
    const ranges = commentRanges(src);
    if (ranges === null) continue;          // unterminated block comment: not trustworthy
    const lines = src.split('\n');
    REQUIRE_LITERAL.lastIndex = 0;
    let m;
    while ((m = REQUIRE_LITERAL.exec(src))) {
      if (ranges.some(([s, e]) => m.index >= s && m.index < e)) continue;
      const { line } = lineColOf(src, m.index);
      const trimmed = (lines[line - 1] || '').trim();
      if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue;
      checked++;
      try {
        Module.createRequire(abs).resolve(m[2]);
      } catch (err) {
        missing.push(
          `  ${rel(abs)}:${line}  require('${m[2]}') does not resolve [${err.code || err.name}]`
        );
      }
    }
  }
  failWith(
    missing,
    'require() target(s) that do not exist — each one throws the moment its ' +
    'file is loaded, and nothing else in this suite loads these files:'
  );
  assert.ok(checked > 20, `expected to have checked the boot-path requires, checked ${checked}`);
});

// ---------------------------------------------------------------------------
// TEST 4 — every module that is safe to require actually loads
//
// The parse check proves a file is valid JavaScript; this proves it survives
// running its own top-level code (a bad destructure off a circular import, a
// JSON.parse of a malformed constant, a throw in an IIFE).
//
// It stands down completely whenever TEST 1 has anything to report, and that is
// the most important line in this file. Requiring a module whose dependency
// four levels down will not parse fails that module too, so with
// firebaseService.js broken this test named routes/admin.js, routes/billing.js,
// routes/budget.js and twenty more — it reproduced the exact cascade that cost
// the afternoon this file exists to prevent. One root cause has to produce one
// failure, so when a file will not parse, TEST 1 owns the run and this one gets
// out of the way.
// ---------------------------------------------------------------------------

test('every backend module that is safe to require loads', (t) => {
  if (PARSE_FAILURES.length) {
    t.skip(
      'not run: ' + PARSE_FAILURES.map((f) => rel(f.abs)).join(', ') + ' cannot be ' +
      'parsed, so every module that requires them would fail too. Fix what the ' +
      '"every shipped backend source file parses" test named, then re-run.'
    );
    return;
  }
  const failures = [];
  let loaded = 0;
  for (const abs of FILES) {
    if (!mayRequire(abs)) continue;
    try {
      require(abs);
      loaded++;
    } catch (err) {
      const frame = String(err.stack || '').split('\n').find((l) => l.includes(rel(abs).split('/').pop()));
      failures.push(
        `  ${rel(abs)}\n      ${err.name}: ${err.message}` + (frame ? `\n      ${frame.trim()}` : '')
      );
    }
  }
  failWith(
    failures,
    'backend module(s) threw while loading — the server cannot boot with these:'
  );
  assert.ok(loaded > 50, `expected to have loaded the backend modules, loaded ${loaded}`);
});

// ---------------------------------------------------------------------------
// TEST 5 — a shipped module exports something
//
// A file under routes/ that exports nothing is not a compile error and not a
// test failure; it is an express app that 404s a whole surface, or a `const
// { thing } = require(...)` that yields undefined and blows up at the first
// call. It runs off the modules TEST 4 already loaded, so it costs nothing.
// Scoped to the directories where "this file is a module other code consumes"
// is true by construction, and stood down alongside TEST 4 for the same reason:
// with a parse failure in the tree its scope silently shrinks, and a check that
// quietly inspects less than it says it does should report nothing rather than
// report green.
// ---------------------------------------------------------------------------

const MODULE_DIRS = ['routes', 'services', 'utils', 'middleware', 'sockets', 'validators', 'config', 'db'];

test('every shipped module exports something', (t) => {
  if (PARSE_FAILURES.length) {
    t.skip('not run: see the parse failure above.');
    return;
  }
  const empty = [];
  let inspected = 0;
  for (const abs of FILES) {
    if (!mayRequire(abs)) continue;
    if (!MODULE_DIRS.includes(rel(abs).split('/')[0])) continue;
    let mod;
    try { mod = require(abs); } catch { continue; }   // TEST 4 owns load failures
    inspected++;
    const isBarePlainObject =
      mod !== null &&
      typeof mod === 'object' &&
      Object.getPrototypeOf(mod) === Object.prototype &&
      Reflect.ownKeys(mod).length === 0;
    if (mod === undefined || mod === null || isBarePlainObject) {
      empty.push(`  ${rel(abs)} exports ${mod === undefined ? 'undefined' : mod === null ? 'null' : 'an empty object'}`);
    }
  }
  failWith(
    empty,
    'module(s) with no exports — every consumer of these destructures undefined:'
  );
  assert.ok(inspected > 50, `expected to have inspected the backend modules, inspected ${inspected}`);
});

// ---------------------------------------------------------------------------
// TEST 6 — no route path registered twice on the same router
//
// Express keeps both and only ever runs the first, so the second handler is
// dead code that looks live. Scoped to a single file (one router = one file
// here) and to `router.<method>('/...')` with a literal path starting with `/`.
//
// Deliberately NOT extended across files by mount prefix: server.js:630-632
// stacks moderationRoutes and messageRoutes on '/api', and venueRoutes on
// '/api/flocks' alongside flockRoutes, on purpose and with a comment saying so.
// Ordering there is load-bearing, not accidental, and a cross-file check would
// have to guess which overlaps are intended.
//
// `app.get('io')` is why the pattern is anchored to `router.` — that is
// express's settings getter, and 28 of those read as fake duplicate GET routes.
// ---------------------------------------------------------------------------

const ROUTE_REGISTRATION = /\brouter\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])(\/[^'"`\n]*)\2/g;

test('no route path is registered twice on the same router', () => {
  const dupes = [];
  for (const abs of FILES) {
    if (!rel(abs).startsWith('routes/')) continue;
    const src = sources.get(abs);
    const seen = new Map();
    ROUTE_REGISTRATION.lastIndex = 0;
    let m;
    while ((m = ROUTE_REGISTRATION.exec(src))) {
      const key = `${m[1].toUpperCase()} ${m[3]}`;
      const { line } = lineColOf(src, m.index);
      if (seen.has(key)) {
        dupes.push(
          `  ${rel(abs)}: ${key} registered at line ${seen.get(key)} and again at ` +
          `line ${line} — express only ever runs the first, so line ${line} is dead.`
        );
      } else {
        seen.set(key, line);
      }
    }
  }
  failWith(dupes, 'duplicate route registration(s):');
});
