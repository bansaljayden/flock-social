'use strict';

// ---------------------------------------------------------------------------
// The pool's DROP/TRUNCATE guard, and the route it silently killed
// ---------------------------------------------------------------------------
//
// config/database.js wraps pool.query and refuses a statement that drops or
// truncates a table. The refusal used to be `/TRUNCATE/i.test(queryText)` — an
// unanchored substring match over the WHOLE statement text, SQL comments
// included.
//
// routes/venueProfile.js's UPDATE carries a `--` comment that ends
// "...reaches Postgres truncated at that point." `truncat` is a substring of
// `truncated`, so from the commit that added that comment (7c696ed,
// 2026-08-14) every `PUT /api/venue-profile` was rejected by this guard and
// answered `500 Failed to update venue profile`. That is the venue settings
// save and the eighteen-field intake form behind it: the venue owner's entire
// write path, dead for six days, with the only evidence a
// `🛡️ BLOCKED dangerous query` line that reads like an attack being stopped.
//
// IT HAD ALREADY BENT THE SCHEMA ONCE, AND NOBODY JOINED THE TWO UP.
// routes/admin.js carries this note above the moderation queue's SELECT:
//
//   "NB: config/database.js rejects any query whose TEXT matches the word
//    starting "TRUNC...", alias names and comments included, which is why the
//    clipped flag is named content_excerpt_clipped."
//
// So a column alias was renamed to get around this guard, the behaviour was
// written down as a fact of life, and the route it was silently killing three
// files away went unnoticed for six days. That comment is now describing a
// guard that no longer works that way; the alias is fine as it is and is left
// alone.
//
// So this file tests three things, in the order they matter:
//
//   1. THE REGRESSION. Every SQL statement in routes/, services/, sockets/,
//      utils/, middleware/ and migrations/ is passed through the predicate.
//      Nothing the app legitimately runs may be refused. This is the test that
//      would have caught it, and it is source-driven so the NEXT comment
//      containing the word "truncated" cannot do it again.
//   2. THE GUARD STILL GUARDS. A real DROP TABLE / TRUNCATE is still refused,
//      including when it is hiding behind a comment or a newline.
//   3. THE COMMENT STRIPPER. Comments go, quoted text stays — a `--` inside a
//      string literal must not blind the guard to the statement after it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Requiring the pool does NOT connect: config/database.js only pings when the
// process entry point is server.js (or PG_STARTUP_PING=true), and neither is
// true under node --test.
delete process.env.PG_STARTUP_PING;
delete process.env.ALLOW_DROP_TABLES;
const pool = require('../config/database');
const { __dangerousStatement: dangerous, __stripSqlComments: strip } = pool;

const BACKEND = path.join(__dirname, '..');

test('the guard exposes its predicate, so this file does not restate it', () => {
  assert.equal(typeof dangerous, 'function', 'config/database.js must export __dangerousStatement');
  assert.equal(typeof strip, 'function', 'config/database.js must export __stripSqlComments');
});

// ---------------------------------------------------------------------------
// 1. THE REGRESSION — nothing the app runs may be refused
// ---------------------------------------------------------------------------

const SOURCE_DIRS = ['routes', 'services', 'sockets', 'utils', 'middleware', 'db', 'config'];

// config/database.js is the guard itself, and it is the one file in the repo
// whose text is SUPPOSED to contain the statements it refuses: its refusal
// messages quote them ("ALTER TABLE ... DROP COLUMN is BLOCKED"), and its
// header spells out the examples each rule was written for. Scanning it finds
// the documentation, not a statement the app runs, and every rule added to
// SQL_DANGER would fail this test purely for describing itself. The guard's
// behaviour is pinned by the explicit cases further down instead.
const SELF = path.join('config', 'database.js');

function jsFiles() {
  const out = [];
  for (const dir of SOURCE_DIRS) {
    const full = path.join(BACKEND, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.js') && path.join(dir, f) !== SELF) out.push(path.join(dir, f));
    }
  }
  return out;
}

// Every template literal and every ordinary quoted string that looks like SQL.
// Deliberately over-inclusive: a false positive here only means one more string
// gets checked, and the cost of a false NEGATIVE is the outage above.
const SQL_START = /^\s*(?:--|\/\*|WITH|SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|SET|BEGIN|COMMIT|ROLLBACK)\b/i;

function sqlStringsIn(src) {
  const found = [];
  for (const m of src.matchAll(/`([^`\\]*(?:\\.[^`\\]*)*)`/g)) {
    if (SQL_START.test(m[1])) found.push(m[1]);
  }
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    if (SQL_START.test(m[1]) && m[1].length > 12) found.push(m[1]);
  }
  return found;
}

test('no SQL this app actually runs is refused by the guard', () => {
  const refused = [];
  for (const rel of jsFiles()) {
    const src = fs.readFileSync(path.join(BACKEND, rel), 'utf8');
    for (const sql of sqlStringsIn(src)) {
      const why = dangerous(sql);
      if (why) refused.push(`${rel}: ${why}\n    ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  assert.deepEqual(refused, [],
    'config/database.js is refusing a statement the app issues. If the match is inside a comment, '
    + 'the guard has regressed to substring matching (see the header of this file).');
});

test('the venue-profile UPDATE — the statement the guard actually killed — passes', () => {
  const src = fs.readFileSync(path.join(BACKEND, 'routes/venueProfile.js'), 'utf8');
  const stmt = sqlStringsIn(src).find((s) => /UPDATE venue_profiles SET/i.test(s) && /notification_prefs/.test(s));
  assert.ok(stmt, 'routes/venueProfile.js must still hold the PUT statement this test is named for');
  assert.match(stmt, /truncated/, 'the comment that tripped the guard is the point of this test');
  assert.equal(dangerous(stmt), null, 'PUT /api/venue-profile must not be refused by the pool guard');
});

test('no migration is refused either — the runner would fail the boot', () => {
  // db/migrate.js checks out a client, so these do not pass through the guard
  // today. They are checked anyway: migration 025's header says "a typo'd or
  // truncated label", which is the same word that broke the route, and if the
  // guard is ever extended to pooled clients a boot must not be what discovers
  // that.
  const dir = path.join(BACKEND, 'migrations');
  const refused = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const why = dangerous(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (why) refused.push(`${f}: ${why}`);
  }
  assert.deepEqual(refused, [], 'a migration is refused by the pool guard');
});

// ---------------------------------------------------------------------------
// 2. THE GUARD STILL GUARDS
// ---------------------------------------------------------------------------

test('a real DROP TABLE or TRUNCATE is still refused', () => {
  for (const sql of [
    'DROP TABLE users',
    'drop table if exists users',
    'DROP   TABLE\n  users',
    'TRUNCATE venue_owner_reports',
    'TRUNCATE TABLE users CASCADE',
    'truncate ml_training_data',
    '-- housekeeping\nTRUNCATE served_predictions',
    'SELECT 1; DROP TABLE users',
    '/* nightly */ TRUNCATE night_context',
  ]) {
    assert.ok(dangerous(sql), `must be refused: ${JSON.stringify(sql)}`);
  }
});

test('ALLOW_DROP_TABLES=true is still the documented escape hatch', () => {
  process.env.ALLOW_DROP_TABLES = 'true';
  try {
    assert.equal(dangerous('TRUNCATE users'), null);
    assert.equal(dangerous('DROP TABLE users'), null);
  } finally {
    delete process.env.ALLOW_DROP_TABLES;
  }
  assert.ok(dangerous('TRUNCATE users'), 'and it is off again when the variable is not set');
});

test('words that merely CONTAIN the verb are not the verb', () => {
  // The regression, stated as the rule rather than as one statement.
  for (const sql of [
    "SELECT date_trunc('hour', served_at) FROM served_predictions",
    'SELECT truncated FROM t',
    'SELECT * FROM t -- the body arrives truncated',
    'UPDATE t SET x = 1 -- untruncated history, see the note',
    'SELECT * FROM droptable_audit',
    'SELECT * FROM t /* we DROP TABLES nowhere near here */',
  ]) {
    assert.equal(dangerous(sql), null, `must be allowed: ${JSON.stringify(sql)}`);
  }
  // `DROP TABLES` (plural) is not a Postgres statement, but the sixth case
  // above is inside a comment, so it is stripped before the word boundary ever
  // matters. Outside a comment it would be refused, and that is the safe
  // direction.
  assert.ok(dangerous('SELECT * FROM t WHERE note = 1; DROP TABLE x'));
});

// ---------------------------------------------------------------------------
// 3. THE COMMENT STRIPPER
// ---------------------------------------------------------------------------

test('comments go and quoted text stays', () => {
  assert.equal(strip('SELECT 1 -- TRUNCATE users\nFROM t').includes('TRUNCATE'), false);
  assert.equal(strip('SELECT 1 /* TRUNCATE users */ FROM t').includes('TRUNCATE'), false);
  assert.equal(strip('SELECT 1 /* a /* nested */ comment */ FROM t').includes('comment'), false);
  // A `--` inside a string literal does NOT start a comment in Postgres, so it
  // must not start one here: otherwise a statement could be hidden from the
  // guard by putting one in a literal ahead of it.
  assert.match(strip("SELECT '-- not a comment' FROM t"), /not a comment/);
  assert.ok(dangerous("SELECT '-- x' AS a; TRUNCATE users"),
    'a `--` inside a string literal must not blind the guard to what follows');
  // Dollar-quoted bodies are literals too (the DO blocks in migrations 032/038).
  assert.match(strip('DO $$ BEGIN -- keep\nEND $$;'), /\$\$/);
});

test('a non-string query text is not a statement', () => {
  for (const v of [undefined, null, 0, {}, [], { text: 'TRUNCATE users' }]) {
    assert.equal(dangerous(v), null);
  }
});

// ---------------------------------------------------------------------------
// 4. THE OTHER HALF OF THE PROSE PROBLEM — string literals
// ---------------------------------------------------------------------------
//
// Stripping comments fixed the statement that shipped the outage and left the
// identical mistake reachable one quote character away: `stripSqlComments`
// preserves quoted text (correctly — a `--` inside a literal does not start a
// comment in Postgres), so the WORDS inside that literal were still handed to
// the verb match. Migration 030 added three free-text venue columns whose whole
// purpose is an owner describing their own room in their own words, so this
// stopped being hypothetical the moment the intake form shipped.
//
// The fix blanks literal CONTENTS for the danger match only, AFTER the comment
// strip, so nothing can be hidden inside a literal that a `--` used to protect.

test('a verb inside a string literal is a word, not a statement', () => {
  for (const sql of [
    // Migration 030's free-text columns, written the way a seed or a one-shot
    // script would write them.
    "INSERT INTO venue_profiles (quirks) VALUES ('we truncate the tap list at ten')",
    "UPDATE venue_profiles SET event_note = 'quiz night, we drop table service' WHERE id = 1",
    "UPDATE venue_profiles SET anchor_note = 'stadium across the road' WHERE quirks <> 'DROP TABLE'",
    "SELECT * FROM content_reports WHERE details <> 'DROP TABLE users'",
    "SELECT * FROM t WHERE note = 'TRUNCATE'",
  ]) {
    assert.equal(dangerous(sql), null, `must be allowed: ${JSON.stringify(sql)}`);
  }
});

test('blanking literals cannot be used to hide a statement', () => {
  // The property that makes the blanking safe: it runs after comments are
  // already gone, and a real statement lives outside the quotes.
  assert.ok(dangerous("SELECT 'TRUNCATE' AS a; TRUNCATE users"));
  assert.ok(dangerous("SELECT '-- x' AS a; DROP TABLE users"));
  // A dollar-quoted body EXECUTES, so it is not blanked (migrations 032/038).
  assert.ok(dangerous('DO $$ BEGIN DROP TABLE users; END $$'));
  // A quoted identifier is a name, not data, so it stays visible too.
  assert.ok(dangerous('DROP TABLE "users"'));
});

// ---------------------------------------------------------------------------
// 5. THE STATEMENTS THE LIST DID NOT HAVE
// ---------------------------------------------------------------------------
//
// The guard blocked DROP TABLE and TRUNCATE and waved through four things that
// are strictly worse, plus the one that is TRUNCATE spelled differently.

test('the statements that are worse than DROP TABLE are refused too', () => {
  for (const sql of [
    'DROP SCHEMA public CASCADE',       // all 46 tables, one line
    'drop schema if exists public',
    'DROP DATABASE railway',
    'DROP OWNED BY app_user',
    'ALTER TABLE users DROP COLUMN email',
    'alter table venue_profiles drop column if exists quirks',
  ]) {
    assert.ok(dangerous(sql), `must be refused: ${JSON.stringify(sql)}`);
  }
});

test('a DELETE with no WHERE is a TRUNCATE that spells itself differently', () => {
  for (const sql of [
    'DELETE FROM users',
    'delete from venue_owner_reports;',
    // The reason this is checked per statement rather than per query text: the
    // text below contains a WHERE and still empties the users table.
    'DELETE FROM sessions WHERE id = 1; DELETE FROM users',
  ]) {
    assert.ok(dangerous(sql), `must be refused: ${JSON.stringify(sql)}`);
  }
});

test('every bounded DELETE the app actually issues is still allowed', () => {
  for (const sql of [
    'DELETE FROM users WHERE id = $1',
    'DELETE FROM messages WHERE sender_id = $1',
    `DELETE FROM served_predictions
      WHERE served_at < NOW() - INTERVAL '180 days'`,
    'DELETE FROM a USING b WHERE a.id = b.id',
    "DELETE FROM night_context_runs WHERE ran_at < NOW() - INTERVAL '90 days'",
    // A DELETE whose only WHERE is inside a CTE still has one.
    'WITH doomed AS (SELECT id FROM t WHERE x = 1) DELETE FROM t USING doomed',
    // And the word inside a literal is not the verb.
    "UPDATE t SET note = 'DELETE FROM users' WHERE id = 1",
  ]) {
    assert.equal(dangerous(sql), null, `must be allowed: ${JSON.stringify(sql)}`);
  }
});

test('the new rules are off under ALLOW_DROP_TABLES too', () => {
  process.env.ALLOW_DROP_TABLES = 'true';
  try {
    for (const sql of ['DROP SCHEMA public CASCADE', 'DELETE FROM users', 'ALTER TABLE users DROP COLUMN email']) {
      assert.equal(dangerous(sql), null, `escape hatch must cover: ${sql}`);
    }
  } finally {
    delete process.env.ALLOW_DROP_TABLES;
  }
});
