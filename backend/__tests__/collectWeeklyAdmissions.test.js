// Run: node --test  (from backend/)
//
// The plan admits 100 NEW BestTime venues a calendar month, and every weekly
// collection of a venue without a besttime_venue_id is a by-name lookup that
// spends one. The collector's credit ceiling cannot see that allowance (2,500
// credits is 1,250 by-name lookups), so these pin the guard that can, plus the
// flag that aims an admission run at the venues addDemandVenues.js just staged
// instead of the oldest never-attempted rows in the city.

// The module builds a Pool at load time. Point it somewhere that does not
// exist before requiring it, and hand it a pool that only records: the
// selection tests below run the real collector and read the statements it
// issued, and nothing here can reach a database or BestTime.
process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/never';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const issued = [];
class RecordingPool {
  async query(sql, params) {
    issued.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    // requireSlotIndex asks whether the upsert's unique index is valid.
    if (/indisvalid/.test(sql)) return { rows: [{ indisvalid: true }] };
    return { rows: [] };
  }
  async end() {}
  async connect() { throw new Error('these tests never take a client'); }
  on() {}
}
function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}
stubModule('pg', { Pool: RecordingPool });
stubModule('../scripts/ml/bestTimeService', {
  fetchWeeklyForecast: async () => { throw new Error('these tests never call BestTime'); },
});

const { newVenueCheck, createdAfterFrom, selectionOptions, run } = require('../scripts/ml/collectWeekly');

// Runs the real collector with exactly these flags and returns the venue
// SELECTs it issued (with no venues returned, it ends right after the SELECT).
async function selectsFor(args) {
  const savedArgv = process.argv;
  const savedExit = process.exitCode;
  issued.length = 0;
  process.argv = [savedArgv[0], savedArgv[1], ...args];
  try {
    await run();
  } finally {
    process.argv = savedArgv;
  }
  const exitCode = process.exitCode;
  process.exitCode = savedExit;
  return { exitCode, selects: issued.filter((q) => q.sql.startsWith('SELECT * FROM ml_venues')) };
}

const WEEKLY = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectWeekly.js'), 'utf8');
const DEMAND = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'addDemandVenues.js'), 'utf8');

const byName = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, besttime_venue_id: null }));
const byId = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, besttime_venue_id: `ven_${i}` }));

test('a refresh looks nothing up by name and is never refused', () => {
  assert.deepStrictEqual(newVenueCheck(byId(1915), []), { byName: 0, refusal: null });
  assert.deepStrictEqual(newVenueCheck(byId(3), ['--max-new=0']), { byName: 0, refusal: null });
});

test('a run with any by-name lookup refuses unless the count is asked for', () => {
  const { byName: n, refusal } = newVenueCheck([...byName(3), ...byId(10)], []);
  assert.strictEqual(n, 3);
  assert.match(refusal, /REFUSED: 3 of these venues have no BestTime id/);
  assert.match(refusal, /--max-new=3 to spend them on purpose/);
});

test('a run bigger than a month of admissions points at the demand list, never at a bigger --max-new', () => {
  // 2026-09-25: a pasted all-cities run selected 2,000 never-attempted venues,
  // and the first version of this message suggested --max-new=2000.
  const { refusal } = newVenueCheck(byName(2000), []);
  assert.match(refusal, /REFUSED: 2000 of these venues have no BestTime id/);
  assert.match(refusal, /No single run can admit that many/);
  assert.match(refusal, /addDemandVenues\.js --commit/);
  assert.doesNotMatch(refusal, /--max-new=2000/);
});

test('--max-new above the monthly allowance is refused outright', () => {
  assert.match(newVenueCheck(byName(5), ['--max-new=101']).refusal, /more than the plan's 100 new-venue admissions/);
  assert.strictEqual(newVenueCheck(byName(100), ['--max-new=100']).refusal, null);
});

test('--max-new admits up to its count and refuses one more', () => {
  assert.strictEqual(newVenueCheck(byName(42), ['--max-new=42']).refusal, null);
  assert.strictEqual(newVenueCheck(byName(7), ['--max-new=42']).refusal, null);
  assert.match(newVenueCheck(byName(43), ['--max-new=42']).refusal, /That is more than --max-new=42\./);
});

test('a malformed --max-new refuses instead of meaning zero or everything', () => {
  for (const bad of ['--max-new=', '--max-new=0', '--max-new=-5', '--max-new=4.5', '--max-new=all', '--max-new=1e3']) {
    assert.match(newVenueCheck(byName(1), [bad]).refusal, /--max-new must be a positive integer/, bad);
  }
});

test('--created-after reads a date or a timestamp and refuses anything else', () => {
  assert.deepStrictEqual(createdAfterFrom([]), { at: null });
  assert.strictEqual(createdAfterFrom(['--created-after=2026-09-25']).at.toISOString(), '2026-09-25T00:00:00.000Z');
  assert.strictEqual(
    createdAfterFrom(['--created-after=2026-09-25T20:00:00-04:00']).at.toISOString(),
    '2026-09-26T00:00:00.000Z'
  );
  for (const bad of ['--created-after=', '--created-after=yesterday']) {
    assert.match(createdAfterFrom([bad]).error, /--created-after must be a date or timestamp/, bad);
  }
});

test('the collector wires both into the run before the first call', () => {
  // Source pins for the wiring only; the behaviour is pinned above. The
  // script builds its own Pool, so running it here would need a database.
  assert.match(WEEKLY, /if \(createdAfter\.at\) \{\s*params\.push\(createdAfter\.at\.toISOString\(\)\);\s*query \+= ` AND created_at >= \$\$\{params\.length\}`;/);
  const check = WEEKLY.indexOf('newVenueCheck(venues, process.argv)');
  const firstCall = WEEKLY.indexOf('fetchWeeklyForecast(', WEEKLY.indexOf('async function collectWeekly'));
  assert.ok(check > 0 && firstCall > check, 'the admission check must run before the first BestTime call');
});

test('--order=reviews and --without-weekly aim the rest of a month at uncovered, well-reviewed places', () => {
  assert.deepStrictEqual(selectionOptions([]), { withoutWeekly: false, orderBy: 'city, id' });
  assert.deepStrictEqual(
    selectionOptions(['--order=reviews', '--without-weekly']),
    { withoutWeekly: true, orderBy: 'review_count DESC NULLS LAST, id' }
  );
  // Anything else refuses: a typo must not quietly fall back to the oldest rows.
  for (const bad of ['--order=', '--order=rating', '--order=reviews;drop']) {
    assert.match(selectionOptions([bad]).error, /--order must be "reviews"/, bad);
  }
});

test('the collector refuses a bad --order before it selects a single venue', async () => {
  const { exitCode, selects } = await selectsFor(['--city=philly', '--order=rating', '--max-new=5']);
  assert.strictEqual(exitCode, 1);
  assert.strictEqual(selects.length, 0, 'a refused run must not read the venue list');
});

test('the month-end command selects uncovered, never-tried venues, most reviewed first', async () => {
  const { exitCode, selects } = await selectsFor([
    '--city=philly', '--skip-collected', '--without-weekly', '--order=reviews', '--limit=5', '--max-new=5',
  ]);
  assert.notStrictEqual(exitCode, 1);
  assert.strictEqual(selects.length, 1);
  const { sql, params } = selects[0];
  // The harvest writes weekly rows onto matched rows without a BestTime id, so
  // the filter has to look at the corpus, not at the id column.
  assert.match(sql, / AND besttime_venue_id IS NULL /);
  assert.match(sql, / AND besttime_attempted_at IS NULL /);
  assert.match(sql, / AND NOT EXISTS \(SELECT 1 FROM ml_training_data t WHERE t\.venue_id = ml_venues\.id AND t\.collection_mode = 'weekly'\) /);
  assert.match(sql, / ORDER BY review_count DESC NULLS LAST, id LIMIT \$2$/);
  assert.deepStrictEqual(params, ['philly', 5]);
});

test('without the new flags the selection is what it always was', async () => {
  const { selects } = await selectsFor(['--city=philly', '--only-found']);
  assert.strictEqual(selects.length, 1);
  assert.doesNotMatch(selects[0].sql, /NOT EXISTS/);
  assert.match(selects[0].sql, / ORDER BY city, id$/);
});

test('addDemandVenues prints the exact admission command for what it staged', () => {
  assert.match(DEMAND, /collectWeekly\.js --skip-attempted --created-after=\$\{stagedSince\.toISOString\(\)\} --max-new=\$\{inserted\}/);
  assert.doesNotMatch(DEMAND, /console\.log\('  node scripts\/ml\/collectWeekly\.js --city=/);
});
