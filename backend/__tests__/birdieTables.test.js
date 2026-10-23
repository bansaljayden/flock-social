// Run: node --test  (from backend/)
//
// BIRDIE SEES A VENUE'S TABLES (routes/ai.js withTableSummaries): a search
// result for a venue with a live, fresh table floor carries the public
// summary's counts (open tables, whether a party of two fits now, the likely
// wait), never a table number, and a venue that hid its tables, or has no
// fresh floor, gets nothing, so Birdie cannot mention it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'birdie-tables-test-secret';

const pool = require('../config/database');
pool.query = async () => ({ rows: [], rowCount: 0 });

const tableHistory = require('../services/tableHistory');
const realSummaries = tableHistory.publicSummaries;
test.after(() => { tableHistory.publicSummaries = realSummaries; });

const { withTableSummaries } = require('../routes/ai').__testables;

const venues = () => ({
  venues: [
    { place_id: 'shown', name: 'Shown' },
    { place_id: 'hidden', name: 'Hidden' },
    { place_id: 'stale', name: 'Stale' },
  ],
});

test('a shown, fresh venue carries open, fits and wait; hidden and stale carry nothing', async () => {
  let asked = null;
  tableHistory.publicSummaries = async (ids) => {
    asked = ids;
    // publicSummaries itself leaves a hidden venue out of its answer.
    return {
      shown: { open: 2, total: 9, party: 2, fits_now: true, wait_minutes: 0, busy_hours: [{ dow: 5, hour: 20 }], updated_at: 'x', stale: false },
      stale: { open: 5, total: 9, party: 2, fits_now: true, wait_minutes: 0, busy_hours: [], updated_at: 'x', stale: true },
    };
  };
  const out = await withTableSummaries(venues());
  assert.deepStrictEqual(asked, ['shown', 'hidden', 'stale']);
  const [shown, hidden, stale] = out.venues;
  assert.deepStrictEqual(shown.tables, { open_tables: 2, party_of_two_fits_now: true, wait_minutes: 0 });
  assert.ok(!('tables' in hidden), 'a hidden venue is never mentioned');
  assert.ok(!('tables' in stale), 'a stale floor is not offered as an open table');
});

test('a failed summary read leaves the venues as they were', async () => {
  tableHistory.publicSummaries = async () => { throw new Error('db down'); };
  const out = await withTableSummaries(venues());
  assert.ok(out.venues.every((v) => !('tables' in v)));
});

test('the real summary hides a venue whose owner turned tables off', async () => {
  tableHistory.publicSummaries = realSummaries;
  const fresh = new Date().toISOString();
  pool.query = async (sql) => {
    const s = String(sql);
    if (/FROM sensor_table_states s/.test(s)) {
      return { rows: [
        { venue_place_id: 'shown', sensor_device_id: 'u1', table_no: 1, people: 0, state: 'f', state_since: fresh, seats: 4, updated_at: fresh, stale: false, party_max_seen: null },
        { venue_place_id: 'hidden', sensor_device_id: 'u2', table_no: 1, people: 0, state: 'f', state_since: fresh, seats: 4, updated_at: fresh, stale: false, party_max_seen: null },
      ] };
    }
    if (/tables_in_app = false/.test(s)) return { rows: [{ google_place_id: 'hidden' }] };
    return { rows: [] };
  };
  const out = await withTableSummaries(venues());
  assert.deepStrictEqual(out.venues[0].tables, { open_tables: 1, party_of_two_fits_now: true, wait_minutes: 0 });
  assert.ok(!('tables' in out.venues[1]));
  for (const v of out.venues) {
    if (v.tables) assert.deepStrictEqual(Object.keys(v.tables).sort(), ['open_tables', 'party_of_two_fits_now', 'wait_minutes']);
  }
});

test('every search_venues return goes through the table summary, and the prompt says how to use it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  const start = src.indexOf("case 'search_venues': {");
  const end = src.indexOf("case 'get_crowd_prediction': {", start);
  const body = src.slice(start, end);
  const returns = body.match(/return copySearchResult|return withTableSummaries\(copySearchResult|return await withTableSummaries\(copySearchResult/g);
  assert.ok(returns && returns.length === 3);
  assert.ok(returns.every((r) => r.includes('withTableSummaries')), 'no search return skips the table summary');
  assert.ok(src.includes('Never mention tables for a venue whose result has no \\`tables\\`'));
});
