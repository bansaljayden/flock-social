// ---------------------------------------------------------------------------
// THE BAND EVALUATION (scripts/ml/train/bandEval.js) AND THE BAND GATE.
//
// The replay exists to measure what the card shows, so the property that
// matters most is PARITY: for a live reading, the score the replay computes
// must be the score services/mlPredictor.js predictBusyness would publish for
// the same venue, weather, clock and database state. The last test here runs
// the real predictBusyness against a pool stubbed from the same synthetic
// corpus the replay reads from a CSV written by the exporter's own rowToCsv,
// and requires the two to agree row for row, rule-engine rows included.
//
// Everything else pins the pieces that parity depends on and the gate's
// arithmetic: the band ladder read off crowdEngine.getLabel, the past-only
// trailing offset (buildRecentDeviation's window and depth), the neighbour
// box, the date-block bootstrap, the hedge the gate must refuse, and the way
// the band verdict combines with quick_eval's point verdict.
//
// No database, no network. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
delete process.env.TICKETMASTER_API_KEY;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-band-eval';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const B = require('../scripts/ml/train/bandEval');
const crowdEngine = require('../services/crowdEngine');
const exporter = require('../scripts/ml/train/export_training_data');

const ML_DIR = path.join(__dirname, '..', 'scripts', 'ml');
const MODELS_DIR = path.join(ML_DIR, 'models');

// ── The ladder ──────────────────────────────────────────────────────────────

test('the band ladder is read off crowdEngine.getLabel, and bandOf agrees with it on every score', () => {
  const { cuts, labels } = B.bandLadder(crowdEngine.getLabel);
  assert.deepEqual(cuts, [20, 39, 69, 84]);
  assert.deepEqual(labels, ['Quiet', 'Not Busy', 'Steady', 'Busy', 'Packed']);
  for (let s = 0; s <= 100; s++) {
    assert.equal(labels[B.bandOf(s, cuts)], crowdEngine.getLabel(s), `score ${s}`);
  }
});

test('within one band counts adjacent bands and nothing further; band_mae is the distance', () => {
  const { cuts } = B.bandLadder(crowdEngine.getLabel);
  // actual Quiet (10): Not Busy is a hit, Steady is a miss two bands away.
  const m = B.summarize([10, 10, 10, 95], [30, 55, 10, 30], cuts);
  assert.equal(m.n, 4);
  assert.equal(m.within_one_band, 50);
  assert.equal(m.band_exact, 25);
  assert.equal(m.band_mae, (1 + 2 + 0 + 3) / 4);
  assert.deepEqual(m.actual_band_share, [75, 0, 0, 0, 25]);
});

// ── CSV ─────────────────────────────────────────────────────────────────────

test('legacy event types are read the way training reads them', () => {
  const pf = fs.readFileSync(path.join(ML_DIR, 'train', 'prepare_features.py'), 'utf8');
  const m = pf.match(/LEGACY_EVENT_TYPE_ALIASES: Dict\[str, str\] = \{([^}]*)\}/);
  assert.ok(m, 'prepare_features.py must still declare LEGACY_EVENT_TYPE_ALIASES');
  const py = Object.fromEntries([...m[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((x) => [x[1], x[2]]));
  assert.deepEqual(B.LEGACY_EVENT_TYPE_ALIASES, py);
});

test('parseCsvLine reads the fields escapeCsv writes', () => {
  assert.deepEqual(B.parseCsvLine('a,b,,d'), ['a', 'b', '', 'd']);
  const line = ['x', 'light rain, heavy', 'say "hi"', ''].map(exporter.escapeCsv).join(',');
  assert.deepEqual(B.parseCsvLine(line), ['x', 'light rain, heavy', 'say "hi"', '']);
});

// ── The trailing offset, past-only ──────────────────────────────────────────

function curveOf(value) {
  const c = new Int16Array(168).fill(value);
  return c;
}

test('the trailing offset uses buildRecentDeviation\'s window and depth, and never the reading it scores', () => {
  const src = fs.readFileSync(path.join(ML_DIR, 'buildRecentDeviation.js'), 'utf8');
  assert.match(src, /const WINDOW_DAYS = 28;/);
  assert.match(src, /const MAX_READINGS = 20;/);
  assert.equal(B.OFFSET_WINDOW_HOURS, 28 * 24);
  assert.equal(B.OFFSET_MAX_READINGS, 20);

  const curves = new Map([['v1', curveOf(50)]]);
  // Four readings on 2026-09-01 at 10..13h, deviations -10, -20, +30, 0.
  const live = [10, 11, 12, 13].map((h, i) => ({ venueId: 'v1', date: '2026-09-01', dow: 2, hour: h, y: 50 + [-10, -20, 30, 0][i] }));
  const at = B.makeOffsetLookup(live, curves, { minReadings: 2, clamp: 50 });
  const t = (date, hour) => B.dayNumber(date) * 24 + hour;

  assert.equal(at('v1', t('2026-09-01', 10)).offset, null, 'nothing before the first reading');
  assert.equal(at('v1', t('2026-09-01', 11)).offset, null, 'one reading is an anecdote');
  // At 12:00 the 12:00 reading itself is not visible: median(-10, -20) = -15.
  assert.equal(at('v1', t('2026-09-01', 12)).offset, -15);
  // Even count: percentile_cont interpolates.
  assert.equal(at('v1', t('2026-09-01', 14)).offset, B.median([-10, -20, 30, 0]));
  assert.equal(at('v1', t('2026-09-01', 14)).offset, -5);
  // The window is 28 x 24 hours back from the moment, inclusive: at 10:00 on
  // 09-29 all four readings (09-01 10..13h) are inside it, at 12:00 only the
  // last two, and at 14:00 none.
  assert.equal(at('v1', t('2026-09-29', 10)).offset, -5, 'readings inside 28 x 24 hours still count');
  assert.equal(at('v1', t('2026-09-29', 12)).offset, 15);
  assert.equal(at('v1', t('2026-09-29', 14)).offset, null, '28 days later the window has emptied');
});

test('the offset keeps the 20 most recent readings, clamps, and skips slots with no positive curve', () => {
  const curve = curveOf(50);
  curve[3 * 24 + 5] = 0; // one slot with no positive baseline
  const curves = new Map([['v', curve]]);
  const live = [];
  for (let d = 0; d < 25; d++) {
    const date = new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10);
    // the oldest five read -60 below the curve, the newest twenty +60 above
    live.push({ venueId: 'v', date, dow: (new Date(`${date}T00:00:00Z`)).getUTCDay(), hour: 20, y: d < 5 ? 0 : 100 });
  }
  const at = B.makeOffsetLookup(live, curves, { minReadings: 2, clamp: 50 });
  const r = at('v', B.dayNumber('2026-09-30') * 24);
  assert.equal(r.readings, 20);
  assert.equal(r.offset, 50, 'median +50 (the newest twenty), clamped to DEVIATION_CLAMP');

  const onClosedSlot = [{ venueId: 'w', date: '2026-09-02', dow: 3, hour: 5, y: 40 },
    { venueId: 'w', date: '2026-09-02', dow: 3, hour: 6, y: 40 }];
  const at2 = B.makeOffsetLookup(onClosedSlot, new Map([['w', curve]]), { minReadings: 2, clamp: 50 });
  assert.equal(at2('w', B.dayNumber('2026-09-03') * 24).readings, 1,
    'a reading whose own slot has no positive baseline is left out, as the builder\'s JOIN does');
});

test('the nowcast reference reads only the last reading, and only when it is at most two hours old', () => {
  const curves = new Map([['v', curveOf(40)]]);
  const live = [{ venueId: 'v', date: '2026-09-01', dow: 2, hour: 18, y: 90 }];
  const at = B.makeOffsetLookup(live, curves, { minReadings: 2, clamp: 50 });
  const t = B.dayNumber('2026-09-01') * 24;
  assert.equal(at.lastReading('v', t + 18), null, 'never the reading being scored');
  assert.deepEqual(at.lastReading('v', t + 19), { dev: 50, ageHours: 1 });
  assert.deepEqual(at.lastReading('v', t + 20), { dev: 50, ageHours: 2 });
  assert.equal(at.lastReading('v', t + 21), null);
  assert.equal(B.NOWCAST_MAX_AGE_HOURS, 2);
});

// ── The date-block bootstrap ────────────────────────────────────────────────

test('the paired bootstrap resamples whole dates, reproducibly', () => {
  const rows = [];
  const a = [];
  const b = [];
  for (let d = 1; d <= 10; d++) {
    for (let i = 0; i < 50; i++) {
      rows.push({ date: `2026-09-${String(d).padStart(2, '0')}` });
      a.push(i % 10 < 7);
      b.push(i % 10 < 6);
    }
  }
  const one = B.pairedDateBootstrap(rows, a, b, { resamples: 500 });
  const two = B.pairedDateBootstrap(rows, a, b, { resamples: 500 });
  assert.deepEqual(one, two, 'seeded: a verdict must reproduce');
  assert.equal(one.delta, 10);
  assert.equal(one.dates, 10);
  // Every date carries the same +10pp, so no resample of dates can move it.
  assert.deepEqual(one.ci95, [10, 10]);
  const same = B.pairedDateBootstrap(rows, a, a, { resamples: 200 });
  assert.equal(same.delta, 0);
  assert.deepEqual(same.ci95, [0, 0]);
});

// ── The gate ────────────────────────────────────────────────────────────────

// A population shaped like the September live rows: bimodal, many quiet rooms.
function gatePopulation() {
  const rows = [];
  const actual = [10, 5, 0, 30, 55, 60, 75, 95, 100, 15];
  for (let d = 1; d <= 8; d++) {
    for (let i = 0; i < 200; i++) {
      rows.push({ date: `2026-10-${String(d).padStart(2, '0')}`, city: i % 4 === 0 ? 'lehigh' : 'philly', y: actual[i % 10] });
    }
  }
  return rows;
}

test('a candidate that reads the room better than the incumbent and the curve passes', () => {
  const { cuts, labels } = B.bandLadder(crowdEngine.getLabel);
  const rows = gatePopulation();
  const truth = rows.map((r) => r.y);
  const candidate = truth.map((y, i) => (i % 10 === 0 ? 60 : y)); // right 90% of the time
  const incumbent = truth.map((y, i) => (i % 10 < 3 ? 60 : y));   // right 70%
  const naive = truth.map((y, i) => (i % 10 < 4 ? 60 : y));       // right 60%
  const rule = truth.map(() => 50);
  const g = B.bandGate({ rows, cuts, labels, candidate, incumbent, naive, rule, fromDate: '2026-10-01', incumbentThrough: '2026-08-18' });
  assert.equal(g.pass, true, JSON.stringify(Object.fromEntries(Object.entries(g.criteria).map(([k, c]) => [k, c.pass]))));
  assert.ok(g.hedge_reference && g.hedge_reference.band, 'the constant-answer reference rides on every verdict');
});

test('a candidate that hedges to Not Busy wins within-one-band and still fails the gate', () => {
  const { cuts, labels } = B.bandLadder(crowdEngine.getLabel);
  const rows = gatePopulation();
  const truth = rows.map((r) => r.y);
  const hedge = truth.map(() => 30);                              // always "Not Busy"
  // The curve calls the four quiet rooms Steady and is right about the rest.
  const quietAsSteady = (y, i) => ([0, 1, 2, 9].includes(i % 10) ? 60 : y);
  const incumbent = truth.map(quietAsSteady);
  const naive = truth.map(quietAsSteady);
  const rule = truth.map(() => 50);
  const g = B.bandGate({ rows, cuts, labels, candidate: hedge, incumbent, naive, rule, fromDate: '2026-10-01', incumbentThrough: '2026-08-18' });
  assert.ok(g.candidate.within_one_band > g.naive_curve.within_one_band,
    'the hedge really does win the headline metric, which is why it cannot be the only one');
  assert.equal(g.criteria.beats_naive_curve.pass, false, 'band_mae must catch it');
  assert.ok(g.candidate.band_mae > g.naive_curve.band_mae);
  assert.equal(g.pass, false);
});

test('the gate refuses an incumbent that may have trained on the held-out window, and a thin sample', () => {
  const { cuts, labels } = B.bandLadder(crowdEngine.getLabel);
  const rows = gatePopulation();
  const truth = rows.map((r) => r.y);
  const g = B.bandGate({ rows, cuts, labels, candidate: truth, incumbent: truth, naive: truth, rule: truth, fromDate: '2026-10-01', incumbentThrough: '2026-10-05' });
  assert.equal(g.criteria.incumbent_unseen.pass, false);
  const thin = rows.slice(0, 300);
  const g2 = B.bandGate({ rows: thin, cuts, labels, candidate: truth.slice(0, 300), incumbent: truth.slice(0, 300), naive: truth.slice(0, 300), rule: truth.slice(0, 300), fromDate: '2026-10-01', incumbentThrough: '2026-08-18' });
  assert.equal(g2.criteria.sample.pass, false);
});

test('the incumbent\'s data horizon comes from its time holdout, else from when it was trained', () => {
  assert.deepEqual(B.incumbentDataThrough({ time_holdout: { training_live_through: '2026-10-01' }, trained_at: '2026-10-15T00:00:00Z' }).date, '2026-10-01');
  assert.equal(B.incumbentDataThrough({ trained_at: '2026-08-18T22:37:37+00:00' }).date, '2026-08-18');
  assert.equal(B.incumbentDataThrough({}).date, null);
});

test('the band verdict is ANDed with the point verdict, and a deliberate no-band-gate run is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-bandgate-'));
  const meta = path.join(dir, 'model_metadata.json');
  try {
    const write = (g) => fs.writeFileSync(meta, JSON.stringify({ model_version: 'x', ship_gate: g }));
    const quiet = console.log;
    console.log = () => {};
    try {
      write({ overall_pass: false, verdict: 'pending_band_gate', point_gate_pass: true, band_gate_required: true });
      B.writeBandGate(meta, { pass: true });
      let g = JSON.parse(fs.readFileSync(meta, 'utf8')).ship_gate;
      assert.equal(g.overall_pass, true);
      assert.equal(g.verdict, 'ship');

      write({ overall_pass: false, verdict: 'pending_band_gate', point_gate_pass: true, band_gate_required: true });
      B.writeBandGate(meta, { pass: false });
      g = JSON.parse(fs.readFileSync(meta, 'utf8')).ship_gate;
      assert.equal(g.overall_pass, false);
      assert.equal(g.verdict, 'do_not_ship');

      write({ overall_pass: false, verdict: 'do_not_ship', point_gate_pass: false, band_gate_required: true });
      B.writeBandGate(meta, { pass: true });
      g = JSON.parse(fs.readFileSync(meta, 'utf8')).ship_gate;
      assert.equal(g.overall_pass, false, 'a band pass never rescues a point failure');
    } finally {
      console.log = quiet;
    }
    write({ overall_pass: true });
    assert.throws(() => B.writeBandGate(meta, { pass: true }), /point_gate_pass/);
    write({ overall_pass: true, point_gate_pass: true, band_gate_required: false });
    assert.throws(() => B.writeBandGate(meta, { pass: true }), /ML_ALLOW_NO_BAND_GATE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the evaluation points every database setting at an address nothing listens on', () => {
  const env = { PGHOST: 'prod.example', PGPASSWORD: 'x', DATABASE_URL: 'postgresql://u:p@prod.example/db' };
  B.isolateFromDatabases(env);
  assert.equal(env.PGHOST, undefined);
  assert.equal(env.PGPASSWORD, undefined);
  assert.equal(env.DATABASE_URL, B.OFFLINE_DATABASE_URL);
  assert.match(B.OFFLINE_DATABASE_URL, /@127\.0\.0\.1:1\//);
});

// ── Parity with predictBusyness ─────────────────────────────────────────────

// Four venues inside one neighbour box, one far away. Curves are deterministic
// multiples of five; venue 4 has holes and a zero-valued slot beside positive
// neighbours, the edge where blendBaselineRows serves a positive baseline.
const VENUES = [
  { id: 101, lat: 40.60210, lng: -75.47120, cat: 'bar', types: ['bar', 'restaurant', 'food'] },
  { id: 102, lat: 40.60250, lng: -75.47000, cat: 'restaurant', types: ['restaurant', 'food', 'point_of_interest'] },
  { id: 103, lat: 40.59990, lng: -75.47300, cat: 'cafe', types: ['cafe', 'food', 'store'] },
  { id: 104, lat: 40.60100, lng: -75.47150, cat: 'restaurant', types: ['meal_takeaway', 'restaurant'] },
  { id: 105, lat: 40.75000, lng: -75.30000, cat: 'gym', types: ['gym', 'health'] },
];

function curveValue(v, dow, hour) {
  return Math.min(100, 5 * ((dow * 3 + hour * 2 + v.id) % 21));
}

function buildFixture() {
  const curves = new Map();
  const weekly = [];
  for (const v of VENUES) {
    const c = new Int16Array(168).fill(-1);
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        if (v.id === 104 && hour === 3) continue;          // a slot with no row at all
        let val = curveValue(v, dow, hour);
        if (v.id === 104 && hour === 10) val = 0;          // zero, with positive neighbours
        if (v.id === 104 && (hour === 9 || hour === 11)) val = Math.max(val, 40);
        c[dow * 24 + hour] = val;
        weekly.push({ v, dow, hour, val });
      }
    }
    curves.set(String(v.id), c);
  }
  const live = [];
  const dates = ['2026-09-04', '2026-09-05', '2026-09-06'];
  let k = 0;
  for (const date of dates) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const v of VENUES) {
      for (const hour of [9, 10, 11, 18, 19, 20, 3]) {
        k++;
        const base = curves.get(String(v.id))[dow * 24 + hour];
        const y = Math.max(0, Math.min(100, 5 * Math.round(((base < 0 ? 30 : base) + ((k * 37) % 61) - 30) / 5)));
        live.push({
          v, date, dow, hour, y,
          weather: k % 5 === 0 ? null : { temp: 60 + (k % 25), humidity: 40 + (k % 30), wind: k % 12, code: [800, 801, 803, 500, 701][k % 5], rain: k % 5 === 3 },
        });
      }
    }
  }
  return { curves, weekly, live };
}

function toCsvRow(fields) {
  return exporter.rowToCsv(fields);
}

function writeFixtureCsv(file, fx) {
  const lines = [exporter.HEADER];
  for (const w of fx.weekly) {
    lines.push(toCsvRow({
      venue_id: w.v.id, day_of_week: w.dow, hour: w.hour, month: 9, season: 'fall',
      venue_category: w.v.cat, price_level: 2, rating: 4.4, review_count: 900,
      baseline_busyness: w.val, collection_mode: 'weekly', busyness_pct: w.val, city: 'lehigh',
      google_types: w.v.types, latitude: w.v.lat, longitude: w.v.lng,
      avg_user_crowd: 0, user_feedback_count: 0, avg_prediction_error: 0,
      events_observed: false,
    }));
  }
  for (const r of fx.live) {
    const c = fx.curves.get(String(r.v.id))[r.dow * 24 + r.hour];
    lines.push(toCsvRow({
      venue_id: r.v.id, day_of_week: r.dow, hour: r.hour, month: 9, season: 'fall',
      venue_category: r.v.cat, price_level: 2, rating: 4.4, review_count: 900,
      temperature: r.weather ? r.weather.temp : null, humidity: r.weather ? r.weather.humidity : null,
      wind_speed: r.weather ? r.weather.wind : null, weather_condition: r.weather ? 'clear sky' : null,
      weather_condition_code: r.weather ? r.weather.code : null, is_raining: r.weather ? r.weather.rain : null,
      has_nearby_event: null, events_observed: false,
      baseline_busyness: c < 0 ? 0 : c, collection_mode: 'realtime', busyness_pct: r.y, city: 'lehigh',
      google_types: r.v.types, latitude: r.v.lat, longitude: r.v.lng,
      avg_user_crowd: 0, user_feedback_count: 0, avg_prediction_error: 0,
      stored_observed_date: r.date, label_source: 'live', vendor_forecast_pct: 50,
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// buildRecentDeviation's UPSERT, restated naively and independently of
// bandEval.makeOffsetLookup: the venue's live readings inside 28 days before
// the moment, newest twenty, each against its own slot's positive curve.
function builderOffset(fx, venueId, date, hour) {
  const t = B.dayNumber(date) * 24 + hour;
  const devs = fx.live
    .filter((r) => r.v.id === venueId)
    .map((r) => ({ t: B.dayNumber(r.date) * 24 + r.hour, b: fx.curves.get(String(venueId))[r.dow * 24 + r.hour], y: r.y }))
    .filter((r) => r.t < t && r.t >= t - 28 * 24 && r.b > 0)
    .sort((a, b) => b.t - a.t)
    .slice(0, 20)
    .map((r) => r.y - r.b)
    .sort((a, b) => a - b);
  if (devs.length === 0) return null;
  const n = devs.length;
  return { offset: n % 2 ? devs[(n - 1) / 2] : (devs[n / 2 - 1] + devs[n / 2]) / 2, n };
}

test('the replay publishes the score predictBusyness publishes, row for row', async () => {
  const fx = buildFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-bandeval-'));
  const csv = path.join(dir, 'fixture.csv');
  writeFixtureCsv(csv, fx);
  try {
    B.pinUtcClock();
    const corpus = await B.readCorpus([csv]);
    assert.equal(corpus.live.length, fx.live.length);
    const art = await B.loadArtifact(MODELS_DIR);
    assert.equal(art.meta.model_version, require(path.join(MODELS_DIR, 'model_metadata.json')).model_version);
    const prepared = B.prepareRows(corpus.live, corpus, { I: art.I, crowdEngine });
    assert.equal(prepared.length, fx.live.length);
    const replay = await B.scoreArtifact(art, prepared);
    // THE FIXTURE MUST EXERCISE EVERY STEP, or agreement proves nothing: the
    // model and the rule engine both answer, the quantile map and the offset
    // each move published numbers, and the zero-slot edge is present.
    const ml = replay.rows.filter((r) => r.ml);
    assert.ok(ml.length >= 60, `only ${ml.length} rows reached the model`);
    assert.ok(replay.rows.some((r) => !r.ml), 'the fixture must reach the rule engine too');
    assert.equal(replay.qmapApplied, true, 'the shipped artifact is served through the quantile map by default');
    assert.ok(ml.filter((r) => r.mapped !== r.reconstructed).length >= 10, 'the quantile map must move scores');
    assert.ok(ml.filter((r) => r.served !== (replay.qmapApplied ? r.mapped : r.reconstructed)).length >= 10,
      'the trailing offset must move published scores');
    assert.ok(prepared.some((r) => r.rawCurve === 0 && r.smoothed > 0),
      'the fixture must include the zero-slot-with-neighbours edge');
    assert.ok(prepared.some((r) => r.neighbors.count > 0), 'and rows with neighbours');

    // The production path, against a pool that answers from the same corpus.
    const pool = require('../config/database');
    const aliasToVenue = new Map();
    const byPlace = (placeId) => VENUES.find((v) => v.id === aliasToVenue.get(placeId));
    const realQuery = pool.query;
    const unknown = [];
    pool.query = async (text, params = []) => {
      const sql = String(text).replace(/\s+/g, ' ');
      if (/FROM ml_venue_baselines WHERE google_place_id = \$1 AND/.test(sql)) {
        const v = byPlace(params[0]);
        const c = fx.curves.get(String(v.id));
        const rows = [];
        for (const [d, h] of [[params[1], params[2]], [params[3], params[4]], [params[5], params[6]]]) {
          if (c[d * 24 + h] >= 0) rows.push({ day_of_week: d, hour: h, baseline: String(c[d * 24 + h]), source: 'collected', updated_at: new Date() });
        }
        return { rows };
      }
      if (/v\.latitude BETWEEN/.test(sql) && /GROUP BY b\.day_of_week, b\.hour/.test(sql)) {
        const [lat, lng, box] = params.map(Number);
        const agg = new Map();
        for (const v of VENUES) {
          if (!(v.lat >= lat - box && v.lat <= lat + box && v.lng >= lng - box && v.lng <= lng + box)) continue;
          const c = fx.curves.get(String(v.id));
          for (let s = 0; s < 168; s++) {
            if (c[s] < 0) continue;
            const key = s;
            const e = agg.get(key) || { dow: Math.floor(s / 24), hour: s % 24, cnt: 0, sum_bl: 0 };
            e.cnt += 1;
            e.sum_bl += c[s];
            agg.set(key, e);
          }
        }
        return { rows: [...agg.values()].map((e) => ({ ...e, sum_bl: String(e.sum_bl) })) };
      }
      if (/AS lat, v\.longitude AS lng/.test(sql)) {
        const v = byPlace(params[0]);
        const c = fx.curves.get(String(v.id));
        const rows = [];
        for (let s = 0; s < 168; s++) if (c[s] >= 0) rows.push({ lat: String(v.lat), lng: String(v.lng), dow: Math.floor(s / 24), hour: s % 24, baseline: String(c[s]) });
        return { rows };
      }
      if (/FROM ml_venue_recent_deviation/.test(sql)) {
        const at = aliasToVenue.moment.get(params[0]);
        const off = builderOffset(fx, aliasToVenue.get(params[0]), at.date, at.hour);
        return { rows: off ? [{ offset_pct: off.offset, n_readings: off.n, updated_at: new Date() }] : [] };
      }
      if (/FROM venue_feedback/.test(sql)) return { rows: [{ avg_crowd: null, count: 0, avg_error_mapped: null, avg_error_legacy: null }] };
      unknown.push(sql.slice(0, 120));
      return { rows: [] };
    };
    aliasToVenue.moment = new Map();
    try {
      const predictorPath = require.resolve('../services/mlPredictor');
      delete require.cache[predictorPath];
      const predictor = require(predictorPath);
      const quiet = [console.log, console.warn, console.error];
      console.log = () => {};
      console.warn = () => {};
      console.error = () => {};
      let mismatches = [];
      try {
        assert.equal(await predictor.init(), true);
        for (let i = 0; i < prepared.length; i++) {
          const r = prepared[i];
          // A fresh place id per row: getRecentDeviation caches per place for
          // five minutes, and each row is a different moment of the same venue.
          const alias = `ChIJbandeval_${r.venueId}_${i}`;
          aliasToVenue.set(alias, Number(r.venueId));
          aliasToVenue.moment.set(alias, { date: r.date, hour: r.hour });
          const venue = { ...r.venue, place_id: alias };
          const out = await predictor.predictBusyness(venue, r.weather, r.ts);
          if (out.score !== replay.rows[i].served || (out.predictionMethod === 'ml') !== replay.rows[i].ml) {
            mismatches.push({ i, venue: r.venueId, date: r.date, hour: r.hour, production: [out.score, out.predictionMethod], replay: [replay.rows[i].served, replay.rows[i].ml] });
          }
        }
      } finally {
        [console.log, console.warn, console.error] = quiet;
        delete require.cache[predictorPath];
      }
      assert.deepEqual(unknown, [], 'predictBusyness asked the pool something the fixture does not answer');
      assert.deepEqual(mismatches, [], 'the replay must publish exactly what production publishes');
    } finally {
      pool.query = realQuery;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses an export that is missing a column the replay reads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-bandeval-cols-'));
  const csv = path.join(dir, 'old.csv');
  fs.writeFileSync(csv, 'venue_id,day_of_week,hour\n1,2,3\n');
  try {
    await assert.rejects(() => B.readCorpus([csv]), /missing \d+ column\(s\) the replay reads/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
