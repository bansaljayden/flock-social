// ---------------------------------------------------------------------------
// THE LABEL QUARANTINE (services/labelQuarantine.js, 2026-11-27).
//
// From 23 October 2026 the provider's live endpoint answered with values made
// from its own forecast, stored as label_source 'live'. Serving must not
// steer a number with them: the per-venue offset and the nowcast read their
// readings from ml_venue_recent_deviation, which the builder filled from those
// rows until collection stopped on 25 November.
//
// No database, no network. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-label-quarantine';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Q = require('../services/labelQuarantine');
const PREDICTOR = require.resolve('../services/mlPredictor');
const SWITCHES = ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_QMAP_ENABLED', 'CROWD_NO_CURVE_FALLBACK'];
const DAY = 24 * 60 * 60 * 1000;

test('the file names one closed window, 23 October to 25 November 2026, with its evidence', () => {
  assert.equal(Q.WINDOWS.length, 1);
  const [w] = Q.WINDOWS;
  assert.equal(w.fromDate, '2026-10-23');
  assert.equal(w.throughDate, '2026-11-25');
  assert.equal(w.labelSource, 'live');
  const raw = require('../services/labelQuarantine.json');
  assert.ok(raw.windows[0].evidence.length >= 3);
});

test('the window edges, by local reading date', () => {
  assert.equal(Q.isQuarantinedDate('2026-10-12'), false, 'the last real day before the outage');
  assert.equal(Q.isQuarantinedDate('2026-10-22'), false);
  assert.equal(Q.isQuarantinedDate('2026-10-23'), true);
  assert.equal(Q.isQuarantinedDate('2026-11-25'), true);
  assert.equal(Q.isQuarantinedDate('2026-11-26'), false);
  assert.equal(Q.isQuarantinedDate('2026-11-01', 'forecast'), false, 'only live labels are in question');
  assert.equal(Q.isQuarantinedDate('not a date'), false);
});

test('the file refuses an open, reversed, unevidenced or non-live window', () => {
  const ok = { id: 'w', label_source: 'live', from_date: '2026-10-23', through_date: '2026-11-25', evidence: ['x'] };
  assert.doesNotThrow(() => Q.validate({ windows: [ok] }));
  assert.throws(() => Q.validate({ windows: [{ ...ok, through_date: null }] }), /open window/);
  assert.throws(() => Q.validate({ windows: [{ ...ok, through_date: '2026-10-01' }] }), /before from_date/);
  assert.throws(() => Q.validate({ windows: [{ ...ok, evidence: [] }] }), /no evidence/);
  assert.throws(() => Q.validate({ windows: [{ ...ok, label_source: 'forecast' }] }), /must be 'live'/);
  assert.throws(() => Q.validate({ windows: [ok, ok] }), /duplicate id/);
  // The same broken shapes scripts/ml/train/test_label_quarantine.py refuses.
  for (const bad of [{}, { windows: null }, { windows: {} }, [],
    { windows: [{ ...ok, id: 7 }] }, { windows: [{ ...ok, id: '' }] },
    { windows: [{ ...ok, evidence: 'a sentence' }] }, { windows: [{ ...ok, from_date: '2026-10-3' }] }]) {
    assert.throws(() => Q.validate(bad), undefined, JSON.stringify(bad));
  }
});

test('a reading list loses exactly its quarantined readings, and no list stays no list', () => {
  const p = require(PREDICTOR)._internals;
  const list = p.parseOffsetReadings([
    { d: '2026-11-20', h: 20, dev: -8 }, { d: '2026-10-23', h: 9, dev: 4 },
    { d: '2026-10-12', h: 20, dev: 12 }, { d: '2026-10-11', h: 21, dev: 10 },
  ]);
  const kept = Q.withoutQuarantinedSlots(list);
  assert.deepEqual(kept.map((r) => r.dev), [12, 10]);
  assert.equal(Q.withoutQuarantinedSlots(null), null);
  assert.deepEqual(Q.withoutQuarantinedSlots([]), []);
});

test('a span touches the window by calendar day, widened a day each way for the venue\'s time zone', () => {
  const at = (s) => Date.parse(`${s}T12:00:00Z`);
  assert.equal(Q.overlapsQuarantine(at('2026-09-17'), at('2026-10-15')), false);
  assert.equal(Q.overlapsQuarantine(at('2026-09-26'), at('2026-10-22')), true, 'a reading dated the 23rd locally can be the 22nd in UTC');
  assert.equal(Q.overlapsQuarantine(at('2026-10-28'), at('2026-11-25')), true);
  // A Los Angeles reading dated 25 November at 20:00 was taken on the 26th in UTC.
  assert.equal(Q.overlapsQuarantine(Date.parse('2026-11-26T04:00:00Z'), at('2026-12-24')), true);
  assert.equal(Q.overlapsQuarantine(at('2026-11-27'), at('2026-12-25')), false);
});

// recentDeviationEntry on a fixed clock: the stored single offset's refusal
// depends on when the builder ran relative to the window, so these tests
// name the date instead of reading the wall clock.
async function entryAt(nowIso, row, env) {
  const { mock } = require('node:test');
  mock.timers.enable({ apis: ['Date'], now: Date.parse(nowIso) });
  try {
    return await entryFor(row, env);
  } finally {
    mock.timers.reset();
  }
}

async function entryFor(row, env) {
  const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) delete process.env[k];
  Object.assign(process.env, env);
  const pool = require('../config/database');
  const realQuery = pool.query;
  pool.query = async () => ({ rows: row ? [row] : [] });
  try {
    delete require.cache[PREDICTOR];
    const p = require(PREDICTOR);
    return { entry: await p._internals.recentDeviationEntry('ChIJ-label-quarantine'), I: p._internals };
  } finally {
    pool.query = realQuery;
    for (const k of SWITCHES) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const GENERATED = [
  { d: '2026-11-21', h: 20, dev: -15 }, { d: '2026-11-14', h: 20, dev: -15 },
  { d: '2026-11-07', h: 20, dev: -15 }, { d: '2026-10-31', h: 20, dev: -15 },
];
const REAL = [{ d: '2026-10-09', h: 20, dev: 12 }, { d: '2026-10-02', h: 20, dev: 12 }];

test('serving: a venue whose stored readings are all generated gets no offset and no nowcast reading', async () => {
  const row = {
    offset_pct: -15, n_readings: GENERATED.length, updated_at: new Date('2026-11-26T12:00:00Z'),
    recent_readings: [{ d: '2026-11-25', h: 19, v: 40, at: '2026-11-25T19:05:00Z' }],
    offset_readings: GENERATED,
  };
  const { entry, I } = await entryAt('2026-11-27T12:00:00Z', row, { CROWD_NOWCAST_ENABLED: 'true' });
  assert.equal(entry.fresh, true);
  assert.deepEqual(entry.offsetReadings, []);
  assert.deepEqual(entry.readings, []);
  assert.equal(entry.data, null, 'the stored median of those readings is refused too');
  const target = I.slotDayNumber('2026-11-24') * 24 + 20;
  assert.equal(I.trailingOffsetBefore(entry.offsetReadings, target), null);
});

test('serving: real readings beside generated ones survive, and only they make the offset', async () => {
  const row = {
    offset_pct: -15, n_readings: GENERATED.length + REAL.length, updated_at: new Date('2026-11-26T12:00:00Z'),
    recent_readings: null, offset_readings: [...GENERATED, ...REAL],
  };
  const { entry, I } = await entryAt('2026-11-27T12:00:00Z', row, { CROWD_NOWCAST_ENABLED: 'true' });
  assert.deepEqual(entry.offsetReadings.map((r) => r.dev), [12, 12]);
  assert.equal(entry.data, null, 'its stored median included generated readings');
  const target = I.slotDayNumber('2026-10-16') * 24 + 20;
  assert.equal(I.trailingOffsetBefore(entry.offsetReadings, target).offset, 12);
});

test('serving, long after the window: a fresh single offset is refused when its list holds a quarantined reading', async () => {
  // The build span (December to January) is clear of the window, so only the
  // list clause can refuse this median; with that clause removed it is served.
  const row = {
    offset_pct: -15, n_readings: GENERATED.length + REAL.length, updated_at: new Date('2027-01-14T12:00:00Z'),
    recent_readings: null, offset_readings: [...GENERATED, ...REAL],
  };
  const { entry } = await entryAt('2027-01-15T12:00:00Z', row, { CROWD_NOWCAST_ENABLED: 'true' });
  assert.equal(entry.data, null);
  assert.deepEqual(entry.offsetReadings.map((r) => r.dev), [12, 12]);
  const clean = await entryAt('2027-01-15T12:00:00Z', { ...row, offset_pct: 12, n_readings: REAL.length, offset_readings: REAL },
    { CROWD_NOWCAST_ENABLED: 'true' });
  assert.ok(clean.entry.data, 'the same row with a clean list is served');
});

test('serving: a stored single offset built a day before the window, from real readings, is served', async () => {
  const row = {
    offset_pct: 12, n_readings: REAL.length, updated_at: new Date('2026-10-11T12:00:00Z'),
    recent_readings: null, offset_readings: REAL,
  };
  const { entry } = await entryAt('2026-10-12T12:00:00Z', row, { CROWD_SERVE_MODE: 'curve_offset' });
  assert.ok(entry.data);
  assert.equal(entry.data.offset, 12);
});

test('serving: a stored single offset built within 28 days after the window is refused, even beside a clean list', async () => {
  // Written apart from its list, the median cannot be vouched for by it.
  const row = {
    offset_pct: 12, n_readings: REAL.length, updated_at: new Date('2026-12-01T12:00:00Z'),
    recent_readings: null, offset_readings: REAL,
  };
  const { entry } = await entryAt('2026-12-02T12:00:00Z', row, { CROWD_SERVE_MODE: 'curve_offset' });
  assert.equal(entry.data, null);
  assert.deepEqual(entry.offsetReadings.map((r) => r.dev), [12, 12], 'the list itself is clean and kept');
});

test('serving, both switches off: the stored single offset is refused inside the reach of the window and served outside it', async () => {
  const row = (built) => ({ offset_pct: -15, n_readings: 4, updated_at: new Date(built) });
  const inside = await entryAt('2026-11-27T12:00:00Z', row('2026-11-26T12:00:00Z'), {});
  assert.equal(inside.entry.data, null);
  const late = await entryAt('2026-12-24T12:00:00Z', row('2026-12-23T12:00:00Z'), {});
  assert.equal(late.entry.data, null, 'its 28 days still reach 25 November, a day widened');
  const outside = await entryAt('2027-01-15T12:00:00Z', row('2027-01-14T12:00:00Z'), {});
  assert.ok(outside.entry.data);
  assert.equal(outside.entry.data.offset, -15);
});

test('the evaluations: readCorpus never scores a quarantined row as a live reading, and counts it', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const exporter = require('../scripts/ml/train/export_training_data');
  const bandEval = require('../scripts/ml/train/bandEval');
  const base = {
    venue_id: 9401, hour: 20, season: 'fall', venue_category: 'bar', price_level: 2, rating: 4.4, review_count: 900,
    temperature: 55, humidity: 60, wind_speed: 5, weather_condition: 'clear sky', weather_condition_code: 800, is_raining: false,
    events_observed: false, baseline_busyness: 30, busyness_pct: 40, city: 'philly',
    google_types: ['bar'], latitude: 39.95, longitude: -75.16, avg_user_crowd: 0, user_feedback_count: 0, avg_prediction_error: 0,
  };
  const live = (date) => exporter.rowToCsv({ ...base, day_of_week: new Date(`${date}T00:00:00Z`).getUTCDay(), month: Number(date.slice(5, 7)),
    collection_mode: 'realtime', stored_observed_date: date, label_source: 'live', vendor_forecast_pct: 35 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-quarantine-'));
  const csv = path.join(dir, 'export.csv');
  try {
    fs.writeFileSync(csv, [exporter.HEADER, live('2026-10-09'), live('2026-10-12'), live('2026-10-23'), live('2026-11-20'), live('2026-11-25')].join('\n') + '\n');
    const kept = await bandEval.readCorpus([csv]);
    assert.deepEqual(kept.live.map((r) => r.date).sort(), ['2026-10-09', '2026-10-12']);
    assert.equal(kept.census.quarantined, 3);
    const all = await bandEval.readCorpus([csv], { quarantine: false });
    assert.equal(all.live.length, 5);
    assert.equal(all.census.quarantined, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the export: a quarantined live row is read, counted and never written; forecast and weekly rows are untouched', async () => {
  const { PassThrough } = require('stream');
  const exporter = require('../scripts/ml/train/export_training_data');
  const base = {
    venue_id: 9501, hour: 20, day_of_week: 5, month: 10, season: 'fall', venue_category: 'bar', price_level: 2, rating: 4.4,
    review_count: 900, temperature: 55, humidity: 60, wind_speed: 5, weather_condition: 'clear sky', weather_condition_code: 800,
    is_raining: false, events_observed: false, baseline_busyness: 30, busyness_pct: 40, city: 'philly', google_types: ['bar'],
    latitude: 39.95, longitude: -75.16, avg_user_crowd: 0, user_feedback_count: 0, avg_prediction_error: 0,
  };
  const rows = [
    { ...base, collection_mode: 'realtime', stored_observed_date: '2026-10-09', label_source: 'live', vendor_forecast_pct: 35 },
    { ...base, collection_mode: 'realtime', stored_observed_date: '2026-11-06', label_source: 'live', vendor_forecast_pct: 35 },
    { ...base, collection_mode: 'realtime', stored_observed_date: '2026-11-06', label_source: 'forecast', vendor_forecast_pct: 40 },
    { ...base, collection_mode: 'weekly', stored_observed_date: null, label_source: null, vendor_forecast_pct: null },
  ];
  assert.deepEqual(rows.map(exporter.isQuarantinedRow), [false, true, false, false]);
  const fakePool = () => {
    let fetched = false;
    return {
      connect: async () => ({
        query: async (sql) => {
          if (/^FETCH/.test(sql)) { const r = fetched ? [] : rows; fetched = true; return { rows: r }; }
          return { rows: [] };
        },
        release: () => {},
      }),
    };
  };
  const capture = async (opts) => {
    const out = new PassThrough();
    let text = '';
    out.on('data', (c) => { text += c; });
    const counted = { rows: 0 };
    const n = await exporter.exportCity(fakePool(), 'philly', out, {}, null, { ...opts, quarantined: counted });
    return { n, counted: counted.rows, lines: text.split('\n').filter(Boolean).length };
  };
  assert.deepEqual(await capture({}), { n: 3, counted: 1, lines: 3 });
  assert.deepEqual(await capture({ includeQuarantined: true }), { n: 4, counted: 0, lines: 4 });
});
