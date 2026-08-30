// Run: node --test  (from backend/)
//
// PREP SCRIPTS SPEND NOTHING BY SURPRISE.
//
// Two scripts landed 2026-08-29 while all BestTime usage was paused on
// Jayden's word: addDemandVenues.js (stages the user-demand want-list into
// ml_venues off Google Places) and collectSportsSchedules.js (game schedules
// for the crowd model off TheSportsDB). Both exist to make the paid pulls
// one command away WITHOUT being the paid pull. Pinned here:
//   1. Neither script touches BestTime: no endpoint, no key, no import.
//   2. The demand script defaults to a dry run, refuses a surprise pileup
//      through --max-new, keeps the corpus PA by geometry, and treats a
//      Places 429 as rate limiting rather than a dead venue (the first dry
//      run mislabeled live venues as gone for exactly that reason).
//   3. The sports collector reads its key from the environment, never a
//      literal, tracks games HOME OR AWAY (the expanded scope: bars fill
//      for road games on TV), and its --verify path returns before any
//      database pool exists.
//   4. Migration 057 is a pure CREATE, replay-safe under migrationBootSafety
//      for the same reason 056 is.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DEMAND = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'addDemandVenues.js'), 'utf8');
const SPORTS = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectSportsSchedules.js'), 'utf8');
const MIG = fs.readFileSync(path.join(__dirname, '..', 'migrations', '057_ml_sports_events.sql'), 'utf8');

// Comments are allowed to NAME the no-BestTime rule; only code can break it.
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');

test('neither prep script can spend a BestTime credit', () => {
  assert.ok(!/besttime/i.test(stripComments(DEMAND)),
    'the demand script stages rows; admission happens through the collector');
  assert.ok(!/besttime/i.test(stripComments(SPORTS)),
    'the sports collector must not reach any BestTime endpoint');
});

test('the demand script is a dry run unless told otherwise, and bounded', () => {
  assert.match(DEMAND, /process\.argv\.includes\('--commit'\)/, 'writes are opt-in');
  assert.match(DEMAND, /WOULD ADD/, 'the dry run prints the list it would write');
  assert.match(DEMAND, /maxNewArg \? parseInt\(maxNewArg\.split\('='\)\[1\], 10\) : 95/,
    'the default ceiling matches the plan and sits under the Package tier monthly admission cap');
  assert.match(DEMAND, /--max-new must be a positive integer/, 'a bad ceiling refuses, not defaults');
  assert.match(DEMAND, /ON CONFLICT \(google_place_id\) DO NOTHING/, 're-runs cannot clobber a row');
});

test('the demand script keeps the corpus PA by geometry, not trust', () => {
  assert.match(DEMAND, /const MAX_KM = 80/);
  assert.match(DEMAND, /best > MAX_KM/, 'a candidate outside both centroids is skipped entirely');
  assert.match(DEMAND, /philly: \{ lat: 39\.9526/, 'the centroids are the corpus cities');
  assert.match(DEMAND, /lehigh: \{ lat: 40\.6023/);
});

test('a Places 429 is rate limiting, never a dead venue', () => {
  assert.match(DEMAND, /response\.status === 429/, 'the retry ladder keys on 429 specifically');
  assert.match(DEMAND, /rateLimited: true/, 'exhausted retries surface as rate limiting');
  assert.match(DEMAND, /break;/, 'a saturated quota stops the run instead of mislabeling the rest');
});

test('the sports collector reads its key from the environment and tracks both sides', () => {
  assert.match(SPORTS, /process\.env\.SPORTSDB_API_KEY/);
  // Generic on purpose: an earlier version of this assertion embedded the
  // actual key digits inside the forbidding regex, which put the secret in
  // the repo to ban the secret from the repo. SportsDB keys are long numeric
  // ids and nothing else in this script legitimately carries one, so any
  // standalone run of nine-plus digits is a smuggled credential.
  assert.ok(!/\d{9,}/.test(SPORTS), 'no literal numeric key in source, ever');
  assert.match(SPORTS, /ev\.idHomeTeam === t\.teamId/);
  assert.match(SPORTS, /ev\.idAwayTeam === t\.teamId/,
    'home or away is the point: the flag is "is this team playing at all tonight"');
  assert.match(SPORTS, /is_home/, 'home-ness stays its own column for the arena-distance features');
});

test('the sports verify path proves the key without touching the database', () => {
  const verifyIdx = SPORTS.indexOf("process.argv.includes('--verify')");
  const poolIdx = SPORTS.indexOf('new Pool', SPORTS.indexOf('async function main'));
  assert.ok(verifyIdx !== -1 && poolIdx !== -1);
  assert.ok(verifyIdx < poolIdx, 'the verify branch returns before any pool exists inside main');
});

test('the sports event instant comes from the UTC timestamp, never the local pair', () => {
  // The naive-timestamp landmine (migration 056 and 057 headers): the local
  // date and time are stored as-is for the venue-local join, and the instant
  // is derived only from strTimestamp.
  assert.match(SPORTS, /ev\.strTimestamp/);
  assert.ok(!/new Date\(`?\$\{?ev\.dateEvent/.test(SPORTS),
    'deriving an instant from the local date pair would move evening games across nights');
});

test('migration 057 is a pure CREATE, replay-safe by construction', () => {
  assert.match(MIG, /CREATE TABLE IF NOT EXISTS ml_sports_events/);
  assert.match(MIG, /sportsdb_event_id VARCHAR\(32\) NOT NULL UNIQUE/, 'the upsert has a real conflict target');
  assert.ok(!/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i.test(MIG),
    'a data-moving statement would fail the boot-safety replay over live data');
});
