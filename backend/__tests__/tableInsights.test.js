// Run: node --test  (from backend/)
//
// TABLE INSIGHTS (services/tableInsights.js): last night at the tables, the
// digest's "Your tables" section, the advisor's table facts and the free
// forecast. Pinned here:
//
//   * every sentence is built from the numbers handed in, with no em dash,
//     and a typical time is said only over the twenty seating floor;
//   * the digest section exists only for a venue with seatings that week,
//     and it names no table number;
//   * the advisor facts carry source 'table_sensor', the forecast refuses
//     under four weeks, and a venue with no tables gets one refusal;
//   * every statement is parameterized and none selects anything about a
//     person.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pool = require('../config/database');
const tableHistory = require('../services/tableHistory');
const tableInsights = require('../services/tableInsights');

let handlers = [];
let queryLog = [];
pool.query = async (sql, params = []) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) return fn(params);
  }
  return { rows: [], rowCount: 0 };
};

const realStats = tableHistory.tableStats;
const realZone = tableHistory.venueTimeZone;

function reset({ zone = 'America/New_York', stats = null } = {}) {
  handlers = [];
  queryLog = [];
  tableHistory.venueTimeZone = async () => zone;
  tableHistory.tableStats = async (placeId, days) => (stats ? stats(days) : emptyStats(days));
}

function emptyStats(days) {
  return {
    days, seatings: 0, turn_minutes: { median: null, by_hour: [] }, waited_share: null,
    clear_minutes_median: null, full_hours: [], timeZone: 'America/New_York',
  };
}

function busyStats(days) {
  return {
    days,
    seatings: days === 7 ? 64 : 240,
    turn_minutes: { median: 52.4, by_hour: [] },
    waited_share: 0.184,
    clear_minutes_median: 4.2,
    full_hours: [{ dow: 5, hour: 19, share: 0.8 }, { dow: 5, hour: 20, share: 0.9 }, { dow: 6, hour: 20, share: 0.6 }],
    timeZone: 'America/New_York',
  };
}

const NOW = new Date('2026-10-19T13:00:00Z'); // a Monday morning in New York

test.after(() => {
  tableHistory.tableStats = realStats;
  tableHistory.venueTimeZone = realZone;
});

// ---------------------------------------------------------------------------
// I2. Last night.
// ---------------------------------------------------------------------------
test('last night: counts, a typical turn over the floor, and the full hours as ranges', async () => {
  reset();
  handlers.push([/FROM sensor_table_seatings s .*::date = /, () => ({
    rows: [{ seatings: 42, waited: 6, turn_median: 55.4, day: '2026-10-18' }],
  })]);
  handlers.push([/FROM venue_sensor_data v .*GROUP BY 1$/, () => ({
    rows: [
      { hour: 19, readings: 60, full_readings: 50 },
      { hour: 20, readings: 60, full_readings: 40 },
      { hour: 21, readings: 60, full_readings: 10 },
    ],
  })]);
  const s = await tableInsights.lastNightSummary('place-a', NOW);
  assert.strictEqual(s.seatings, 42);
  assert.strictEqual(s.turn_minutes, 55);
  assert.deepStrictEqual(s.full_hours, [19, 20]);
  assert.strictEqual(s.date, '2026-10-18');
  assert.strictEqual(s.timeZone, 'America/New_York');
  assert.strictEqual(s.text,
    'Your tables had 42 seatings yesterday. A typical party sat for about 55 minutes. '
    + '6 of 42 seatings waited past your wait limit for a server. Every table was in use for most of 7 PM to 9 PM.');
  assert.ok(!s.text.includes('—'));
  // Parameterized: place, zone, now.
  const q = queryLog.find((x) => /sensor_table_seatings/.test(x.sql));
  assert.deepStrictEqual(q.params.slice(0, 2), ['place-a', 'America/New_York']);
  assert.strictEqual(q.params[2], NOW.toISOString());
});

test('last night: under twenty seatings there is no typical turn, and an unknown zone says UTC', async () => {
  reset({ zone: null });
  handlers.push([/FROM sensor_table_seatings s/, () => ({ rows: [{ seatings: 7, waited: 0, turn_median: 40, day: '2026-10-18' }] })]);
  handlers.push([/FROM venue_sensor_data v/, () => ({ rows: [{ hour: 20, readings: 10, full_readings: 9 }] })]);
  const s = await tableInsights.lastNightSummary('place-a', NOW);
  assert.strictEqual(s.turn_minutes, null);
  assert.strictEqual(s.timeZone, null);
  assert.ok(!/typical/.test(s.text), 'no typical time from seven seatings');
  assert.ok(s.text.includes('No seating waited'));
  assert.ok(s.text.includes('Hours are in UTC'));
});

test('last night: a quiet night says so plainly', async () => {
  reset();
  const s = await tableInsights.lastNightSummary('place-a', NOW);
  assert.strictEqual(s.seatings, 0);
  assert.strictEqual(s.text, 'No seatings were recorded at your tables yesterday.');
});

test('a zone Postgres refuses is read again in UTC and reported unknown', async () => {
  reset({ zone: 'Mars/Olympus' });
  handlers.push([/FROM sensor_table_seatings s/, (p) => {
    if (p[1] !== 'UTC') { const e = new Error('bad zone'); e.code = '22023'; throw e; }
    return { rows: [{ seatings: 3, waited: 1, turn_median: 30, day: '2026-10-18' }] };
  }]);
  const s = await tableInsights.lastNightSummary('place-a', NOW);
  assert.strictEqual(s.seatings, 3);
  assert.strictEqual(s.timeZone, null);
});

test('hour ranges join whole hours and wrap past midnight in words', () => {
  const { hourRanges } = tableInsights.__test;
  assert.deepStrictEqual(hourRanges([19, 20, 21, 23]), ['7 PM to 10 PM', '11 PM to 12 AM']);
  assert.deepStrictEqual(hourRanges([0]), ['12 AM to 1 AM']);
});

// ---------------------------------------------------------------------------
// S7. The digest section.
// ---------------------------------------------------------------------------
test('digest section: absent for a venue with no seatings in the week', async () => {
  reset();
  assert.strictEqual(await tableInsights.buildDigestTableFacts('place-a', NOW), null);
});

test('digest section: last night, seatings, full hours, turn, waited share and clear, venue wide only', async () => {
  reset({ stats: busyStats });
  handlers.push([/FROM sensor_table_seatings s/, () => ({ rows: [{ seatings: 30, waited: 3, turn_median: 50, day: '2026-10-18' }] })]);
  const facts = await tableInsights.buildDigestTableFacts('place-a', NOW);
  assert.deepStrictEqual(facts.map((f) => f.id), [
    'tables_last_night', 'tables_week_seatings', 'tables_full_hours', 'tables_turn_typical', 'tables_waited_share', 'tables_clear_typical',
  ]);
  for (const f of facts) {
    assert.strictEqual(f.source, 'table_sensor');
    assert.ok(!/—/.test(f.label), `${f.id} has no em dash`);
    assert.ok(!/\btable \d/.test(f.label), `${f.id} names no table number`);
  }
  const byId = Object.fromEntries(facts.map((f) => [f.id, f.label]));
  assert.strictEqual(byId.tables_full_hours, 'Every table was in use for most of Friday 7 PM to 9 PM and Saturday 8 PM to 9 PM.');
  assert.strictEqual(byId.tables_turn_typical, 'A typical party sat for about 52 minutes.');
  assert.strictEqual(byId.tables_waited_share, 'About 18% of seatings waited past your wait limit for a server.');
  assert.strictEqual(byId.tables_clear_typical, 'A table was typically cleared about 4 minutes after the party left.');
  assert.ok(byId.tables_last_night.startsWith('Last night at your tables: Your tables had 30 seatings yesterday.'));
});

test('digest section: under the floor only the count is said', async () => {
  reset({ stats: (days) => ({ ...emptyStats(days), seatings: 9 }) });
  const facts = await tableInsights.buildDigestTableFacts('place-a', NOW);
  assert.deepStrictEqual(facts.map((f) => f.id), ['tables_week_seatings']);
});

// ---------------------------------------------------------------------------
// I1, I3, I4. The advisor facts.
// ---------------------------------------------------------------------------
const CTX = { profile: { google_place_id: 'place-a', user_id: 7, verified: true } };

test('advisor: a venue with no table history gets one refusal that names the unlock', async () => {
  reset();
  const facts = await tableInsights.buildTableFacts(CTX, { now: NOW });
  assert.strictEqual(facts.length, 1);
  assert.strictEqual(facts[0].id, 'refuse_no_table_history');
  assert.strictEqual(facts[0].status, 'refused');
});

test('advisor: turn by weekday, the tables that waited most, the full hours and the rarely free hours', async () => {
  reset({ stats: busyStats });
  handlers.push([/EXTRACT\(DOW FROM \(s\.seated_at/, () => ({
    rows: [
      { dow: 5, seatings: 64, turn_median: 61.2, waited_share: 0.22 },
      { dow: 2, seatings: 8, turn_median: 40, waited_share: 0 },
    ],
  })]);
  handlers.push([/GROUP BY s\.table_no/, () => ({
    rows: [
      { table_no: 7, seatings: 25, waited: 10 },
      { table_no: 3, seatings: 30, waited: 3 },
      { table_no: 9, seatings: 4, waited: 4 }, // too few to name
      { table_no: 1, seatings: 20, waited: 0 },
    ],
  })]);
  handlers.push([/GROUP BY d\.dow, d\.hour/, () => ({
    rows: [
      { dow: 5, hour: 20, weeks: 8, free_weeks: 2 },
      { dow: 6, hour: 20, weeks: 8, free_weeks: 7 },
      { dow: 4, hour: 20, weeks: 3, free_weeks: 0 }, // too few weeks
    ],
  })]);
  const facts = await tableInsights.buildTableFacts(CTX, { now: NOW });
  const byId = Object.fromEntries(facts.map((f) => [f.id, f]));
  assert.ok(byId.tables_turn_friday, 'Friday has enough seatings');
  assert.ok(!byId.tables_turn_tuesday, 'Tuesday has eight seatings and is not said');
  assert.strictEqual(byId.tables_turn_friday.value.turnMinutes, 61);
  assert.strictEqual(byId.tables_turn_friday.value.waitedPercent, 22);
  assert.ok(byId.tables_waiting_most.label.includes('table 7 (about 40% of 25 seatings) and table 3 (about 10% of 30 seatings)'));
  assert.ok(!byId.tables_waiting_most.label.includes('table 9'));
  assert.ok(byId.tables_rarely_free.label.includes('Friday 8 PM (2 of 8 weeks)'));
  assert.ok(!byId.tables_rarely_free.label.includes('Thursday'), 'three weeks is not a record');
  assert.ok(byId.tables_full_hours_month);
  for (const f of facts) {
    if (f.status === 'refused') continue;
    assert.strictEqual(f.source, 'table_sensor');
    assert.ok(!/—/.test(f.label));
  }
});

test('advisor: a failed read is a refusal, never a thrown card', async () => {
  reset({ stats: busyStats });
  handlers.push([/sensor_table_seatings/, () => { throw new Error('boom'); }]);
  const facts = await tableInsights.buildTableFacts(CTX, { now: NOW });
  assert.strictEqual(facts.length, 1);
  assert.strictEqual(facts[0].id, 'refuse_table_read_failed');
});

test('free forecast: a cell with four or more weeks answers a share, fewer answers null', async () => {
  reset();
  handlers.push([/GROUP BY d\.dow, d\.hour/, () => ({
    rows: [{ dow: 5, hour: 20, weeks: 8, free_weeks: 2 }, { dow: 4, hour: 20, weeks: 3, free_weeks: 3 }],
  })]);
  const fri = await tableInsights.freeForecast('place-a', 5, 20, NOW);
  assert.strictEqual(fri.share, 0.25);
  assert.strictEqual(fri.weeks, 8);
  const thu = await tableInsights.freeForecast('place-a', 4, 20, NOW);
  assert.strictEqual(thu.share, null);
  const q = queryLog.find((x) => /GROUP BY d\.dow/.test(x.sql));
  assert.strictEqual(q.params[3], 56, 'eight weeks of days');
});

test('the statements are parameterized and select nothing about a person', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'tableInsights.js'), 'utf8');
  assert.ok(!/\$\{[^}]*\}[^`]*\bFROM\b/.test(src.match(/_SQL = `[\s\S]*?`/g).join('\n')), 'no interpolation inside a statement');
  for (const word of ['user_id', 'users', 'email', 'name', 'sensor_device_id']) {
    for (const stmt of src.match(/_SQL = `[\s\S]*?`/g)) {
      assert.ok(!new RegExp(`\\b${word}\\b`).test(stmt), `a statement reads ${word}`);
    }
  }
  assert.ok(!src.includes('—'), 'no em dash anywhere in the module');
});

test('the advisor registers the source and the two table chips', () => {
  const advisorFacts = require('../services/advisorFacts');
  const advisorPhrasing = require('../services/advisorPhrasing');
  assert.ok(advisorFacts.FACT_SOURCES.has('table_sensor'));
  assert.strictEqual(typeof advisorFacts.buildTableFacts, 'function');
  assert.ok(advisorPhrasing.isKnownIntent('tables_service'));
  assert.ok(advisorPhrasing.isKnownIntent('tables_free'));
  assert.ok(advisorPhrasing.CHIP_PRIORITY.includes('tables_service'));
  const plans = require('../routes/advisor').__INTENT_PLANS;
  assert.strictEqual(typeof plans.tables_service, 'function');
  assert.strictEqual(typeof plans.tables_free, 'function');
});

test('the tables_free plan selects the forecast facts and tables_service leaves them out', async () => {
  const advisorFacts = require('../services/advisorFacts');
  const plans = require('../routes/advisor').__INTENT_PLANS;
  const fact = (id) => advisorFacts.makeFact({ id, value: 1, source: 'table_sensor', asOf: '2026-10-19', label: `${id}.` });
  const entries = [fact('tables_last_night'), fact('tables_turn_friday'), fact('tables_rarely_free')];
  const b = { tables: async () => entries };
  assert.deepStrictEqual((await plans.tables_free(b)).map((e) => e.id), ['tables_rarely_free']);
  assert.deepStrictEqual((await plans.tables_service(b)).map((e) => e.id), ['tables_last_night', 'tables_turn_friday']);
});
