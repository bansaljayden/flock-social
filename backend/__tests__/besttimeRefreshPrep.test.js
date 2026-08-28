// Run: node --test  (from backend/)
//
// THE THREE GUARDS THAT STAND BETWEEN THE BESTTIME BUDGET AND THE TRAPS.
//
// Jayden approved paying for two fresh collection windows (2026-08-28, ~$205).
// The spend research found three ways that money destroys itself, and each got
// a code guard. These pins hold the guards still, as source pins, because the
// scripts construct their own Pool against DATABASE_URL and running them in a
// test would talk to production:
//
//   1. THE OVERWRITE TRAP. collectWeekly upserts newest-wins, so a refresh
//      erases window 1 and with it the drift features the second window exists
//      to unlock. archiveWeeklyWindow.js copies the window first and REFUSES
//      to run onto an existing archive table.
//   2. THE RE-BILLED-404 TRAP. A full refresh through the by-name path
//      re-attempts every historical 404 at a credit per failure. --only-found
//      selects only venues with a stored besttime_venue_id, the 1-credit
//      by-id path, and refuses the contradictory --skip-collected pairing.
//   3. THE CRON BOMB. collectRealtime used to sweep every venue with an id,
//      ~14,000 across 34 cities; on a metered key the old 3-hour Railway cron
//      would spend about $4,500/day. The sweep is PA-only by default now, and
//      the global sweep is spelled --all-cities so it can only happen on
//      purpose.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', name), 'utf8');
const ARCHIVE = read('archiveWeeklyWindow.js');
const WEEKLY = read('collectWeekly.js');
const REALTIME = read('collectRealtime.js');

test('the archive refuses an existing table and verifies its own row count', () => {
  assert.match(ARCHIVE, /information_schema\.tables WHERE table_schema = 'public' AND table_name = \$1/);
  assert.match(ARCHIVE, /already exists and this script will not touch it/);
  assert.match(ARCHIVE, /COUNT MISMATCH/);
  // The suffix that names the table is validated before it is interpolated.
  assert.match(ARCHIVE, /\^\[a-z0-9_\]\{1,16\}\$/);
});

test('the archive is copy-only: no destructive verb anywhere in it', () => {
  // Comments stripped first: the header PROSE names the upsert's DO UPDATE
  // and promises "no DELETE", and a verb scan that reads comments fails on
  // the sentence that documents the rule (the comment-vs-code trap this
  // session has hit before).
  const code = ARCHIVE.replace(/^\s*\/\/.*$/gm, '');
  for (const verb of ['DELETE', 'UPDATE', 'DROP', 'TRUNCATE']) {
    assert.ok(!code.includes(verb), `${verb} has no business in an archive script`);
  }
  assert.match(ARCHIVE, /CREATE TABLE .* AS SELECT \* FROM ml_training_data WHERE collection_mode = 'weekly'/);
});

test('collectWeekly has the refresh mode and refuses the contradictory pairing', () => {
  assert.match(WEEKLY, /const onlyFound = process\.argv\.includes\('--only-found'\);/);
  assert.match(WEEKLY, /--only-found and --skip-collected select opposite sets/);
  assert.match(WEEKLY, /if \(onlyFound\) \{\s*query \+= ' AND besttime_venue_id IS NOT NULL';/);
});

test('collectRealtime is PA-scoped by default and global only on purpose', () => {
  assert.match(REALTIME, /\['philly', 'lehigh'\]/);
  assert.match(REALTIME, /--all-cities/);
  assert.match(REALTIME, /city = ANY\(\$1\)/);
  // The default is the SCOPED set: the null (global) branch requires the
  // explicit flag, so a bare cron invocation can never sweep 34 cities.
  assert.match(REALTIME, /const cityScope = allCities\s*\?\s*null/);
});
