// ---------------------------------------------------------------------------
// THE TWO SERVING SWITCHES: CROWD_SERVE_MODE AND CROWD_NOWCAST_ENABLED.
//
// services/mlPredictor.js can serve the venue's curve plus its trailing live
// offset instead of the model's number (CROWD_SERVE_MODE=curve_offset), and
// can blend in the venue's most recent live reading from an earlier hour
// (CROWD_NOWCAST_ENABLED=true). Both default off. What this file pins:
//
//   * WITH BOTH OFF NOTHING MOVES. The served number, its confidence, its label,
//     its method and its version on the band-replay fixture, value for value,
//     against the numbers recorded for the served artifact (GOLDEN), with the
//     quantile map on and off. The switches off also means nothing is read but
//     what the model itself takes in: for an artifact that lists the live
//     features, the venue's row with its readings, once per number.
//   * how each switch is read, including the values that must NOT turn it on;
//   * the nowcast's choice of reading: strictly an earlier hour, the newest one,
//     never an older one in its place, nothing past NOWCAST_MAX_LAG_HOURS;
//   * the arithmetic, the rule-engine exits a switch may not touch, the
//     confidence each switched number publishes, the version qualifier the
//     served_predictions row carries, and the coverage counters;
//   * the builder's constants, against serving's.
//
// scripts/ml/train/bandEval.js replays both switches through these same
// functions and __tests__/mlBandEval.test.js proves it row for row.
//
// No database, no network. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
delete process.env.TICKETMASTER_API_KEY;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-serve-modes';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every case here opens the shipped graph for a fresh predictor and again for
// the replay; this makes those one open (see the helper for why).
require('./helpers/sharedOnnxSession');
const B = require('../scripts/ml/train/bandEval');
const crowdEngine = require('../services/crowdEngine');
const FX = require('./helpers/bandEvalFixture');

const ML_DIR = path.join(__dirname, '..', 'scripts', 'ml');
const MODELS_DIR = path.join(ML_DIR, 'models');
const PREDICTOR = require.resolve('../services/mlPredictor');
// CROWD_NO_CURVE_FALLBACK too: it is a switch the strip's attribution reads
// (mlPredictor hourlyAttributionOn), so every case here starts with it off.
const SWITCH_ENV = ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_QMAP_ENABLED', 'CROWD_NO_CURVE_FALLBACK'];

function withEnv(env, fn) {
  const saved = Object.fromEntries(SWITCH_ENV.map((k) => [k, process.env[k]]));
  for (const k of SWITCH_ENV) delete process.env[k];
  Object.assign(process.env, env);
  const restore = () => {
    for (const k of SWITCH_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

function freshPredictor() {
  delete require.cache[PREDICTOR];
  return require(PREDICTOR);
}

const I = freshPredictor()._internals;

// ── Both off: exactly today's number ───────────────────────────────────────

// Recorded from the fixture (helpers/bandEvalFixture.js), row order the
// fixture's. Until 2026-11-26 these were v2.6.0-starling's numbers, recorded
// with the code before either switch existed. They are 2.8.0-starling's now,
// recorded 2026-11-26 by serving the fixture through this code with both
// switches off and a schedule holding no games. The quantile map was fitted on
// v2.6.0-starling and is applied to no other version (QMAP_FITTED_ON), so
// with it on or off these are the same numbers; both are still served and
// compared. Confidence is the figure measured on real readings for this
// artifact, 38.3 rounded (mlPredictor REAL_READINGS_MEASURED; re-recorded
// 2026-11-27, when it replaced the artifact's own 92.6, with every score
// unchanged), less 15 where the reading carried no weather; 68 is the rule
// engine's on its rows.
const GOLDEN_SCORES = '64,45,37,71,72,13,21,21,51,89,45,53,50,80,21,12,44,40,69,59,43,74,73,44,33,30,56,35,41,50,77,81,27,26,54,45,0,51,49,80,63,40,40,37,64,59,50,58,57,93,30,43,47,42,20,46,87,76,68,38,33,36,60,14,55,62,63,51,38,51,53,49,35,55,83,98,29,36,43,78,68,12,55,71,97,55,29,56,60,88,20,56,84,79,34,33,47,73,67,20,65,70,93,42,37,55,61,86,26,75,85,70,41,43,58,78,74,37,63,53,52,33,40,62,71,91,35,76,95,61,31,52,60,82,77';
const GOLDEN_CONFIDENCE = '38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,68,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,68,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23,38,38,68,38,23,38,38,38,38,23,38,38,38,38,23,38,38,38,38,23';
const GOLDEN = {
  version: '2.8.0-starling',
  ruleRows: [27, 72, 117],
  qmapDefault: { scores: GOLDEN_SCORES, confidence: GOLDEN_CONFIDENCE },
  qmapOff: { scores: GOLDEN_SCORES, confidence: GOLDEN_CONFIDENCE },
};

// The fixture through the real predictBusyness, with a pool answering from it
// (and offering recent readings to any statement that asks for them).
// The fixture's readings are dated 2026-09-04 to 09-06 and its stored offset
// rows are stamped with the clock, so the fixture is served on a fixed clock
// the day after them: on the wall clock a row "built now" may fall within 28
// days of a quarantined window (services/labelQuarantine.json), where its
// median is refused, and the record below would depend on the date it ran.
const FIXTURE_CLOCK = Date.parse('2026-09-07T12:00:00Z');

async function serveFixture(env) {
  const { mock } = require('node:test');
  mock.timers.enable({ apis: ['Date'], now: FIXTURE_CLOCK });
  try {
    return await serveFixtureAtClock(env);
  } finally {
    mock.timers.reset();
  }
}

async function serveFixtureAtClock(env) {
  const fx = FX.buildFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-servemodes-'));
  const csv = path.join(dir, 'fixture.csv');
  FX.writeFixtureCsv(csv, fx);
  const pool = require('../config/database');
  const realQuery = pool.query;
  const moments = new Map();
  const stub = FX.makeFixturePool(fx, (alias) => moments.get(alias));
  const sql = [];
  pool.query = (text, params) => { sql.push(String(text)); return stub.query(text, params); };
  const quiet = [console.log, console.warn, console.error];
  try {
    B.pinUtcClock();
    const corpus = await B.readCorpus([csv]);
    const art = await B.loadArtifact(MODELS_DIR);
    const prepared = B.prepareRows(corpus.live, corpus, { I: art.I, crowdEngine });
    return await withEnv(env, async () => {
      const predictor = freshPredictor();
      console.log = () => {};
      console.warn = () => {};
      console.error = () => {};
      assert.equal(await predictor.init(), true);
      const out = [];
      for (let i = 0; i < prepared.length; i++) {
        const r = prepared[i];
        const alias = `ChIJservemodes_${r.venueId}_${i}`;
        moments.set(alias, { venueId: Number(r.venueId), date: r.date, hour: r.hour });
        out.push(await predictor.predictBusyness({ ...r.venue, place_id: alias }, r.weather, r.ts));
      }
      return { out, sql, unknown: stub.unknown, version: art.meta.model_version, prepared, fx };
    });
  } finally {
    [console.log, console.warn, console.error] = quiet;
    pool.query = realQuery;
    delete require.cache[PREDICTOR];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, env, golden] of [
  ['unset', {}, GOLDEN.qmapDefault],
  ["set to their 'off' values", { CROWD_SERVE_MODE: 'model', CROWD_NOWCAST_ENABLED: 'false' }, GOLDEN.qmapDefault],
  ["set to values that are not 'on' (typo, '1')", { CROWD_SERVE_MODE: 'curve-offset', CROWD_NOWCAST_ENABLED: '1' }, GOLDEN.qmapDefault],
  ['unset, quantile map off', { CROWD_QMAP_ENABLED: 'false' }, GOLDEN.qmapOff],
]) {
  test(`both switches ${label}: every served number is the number recorded for the served artifact`, async () => {
    const { out, sql, unknown, version } = await serveFixture(env);
    assert.deepEqual(unknown, []);
    if (version !== GOLDEN.version) {
      // The golden values belong to one artifact. A new one changes the model's
      // numbers legitimately; the parity test still proves the switches off
      // serve the model's arithmetic, and these values are re-recorded.
      assert.fail(`the served artifact is ${version}; re-record GOLDEN for it from the code with both switches off`);
    }
    assert.equal(out.map((r) => r.score).join(','), golden.scores);
    assert.equal(out.map((r) => r.confidence).join(','), golden.confidence);
    out.forEach((r, i) => {
      const rule = GOLDEN.ruleRows.includes(i);
      assert.equal(r.predictionMethod, rule ? 'rule_engine_no_baseline' : 'ml', `row ${i}`);
      assert.equal(r.label, crowdEngine.getLabel(r.score));
      if (!rule) {
        assert.equal(r.modelVersion, GOLDEN.version, 'no qualifier with both off');
        assert.ok(!('serveMode' in r) && !('nowcast' in r) && !('offsetChangedBySwitch' in r)
          && !('usedLiveReadings' in r),
          'a switched-off response carries no new keys');
        assert.ok(r.dataSourcesUsed.includes('ml_model'));
        // This artifact takes the trailing offset as an input, so none is
        // added after it, and another version's quantile map is not applied.
        assert.equal(r.recentDeviation, null, `row ${i}`);
        assert.equal(r.scoreCalibration, null, `row ${i}`);
      }
    });
    // The venue's row is read once for each model number, and with its
    // readings: an artifact that lists the live features builds them from the
    // stored readings whatever the switches say. (v2.6.0-starling listed none,
    // and with the switches off it was never sent a statement asking for them.)
    const dev = sql.filter((s) => /ml_venue_recent_deviation/.test(s));
    assert.equal(dev.length, out.length - GOLDEN.ruleRows.length);
    assert.ok(dev.every((s) => /recent_readings/.test(s) && /offset_readings/.test(s)),
      'an artifact that lists the live features is read the venue\'s stored readings');
  });
}

// ── Reading the switches ────────────────────────────────────────────────────

test('CROWD_SERVE_MODE is model unless it says curve_offset; a value it does not know is model', () => {
  const cases = [[undefined, 'model'], ['', 'model'], ['model', 'model'], ['MODEL', 'model'],
    ['curve_offset', 'curve_offset'], [' Curve_Offset ', 'curve_offset'], ['curve-offset', 'model'], ['curve', 'model']];
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [v, want] of cases) {
      withEnv(v === undefined ? {} : { CROWD_SERVE_MODE: v }, () => assert.equal(I.serveMode(), want, JSON.stringify(v)));
    }
  } finally { console.warn = warn; }
});

test("CROWD_NOWCAST_ENABLED is on for 'true' in any case and for nothing else", () => {
  for (const v of ['true', 'TRUE', ' True ']) withEnv({ CROWD_NOWCAST_ENABLED: v }, () => assert.equal(I.nowcastEnabled(), true, v));
  for (const v of [undefined, '', 'false', '1', 'yes', 'on']) {
    withEnv(v === undefined ? {} : { CROWD_NOWCAST_ENABLED: v }, () => assert.equal(I.nowcastEnabled(), false, String(v)));
  }
});

// ── The nowcast's reading ───────────────────────────────────────────────────

const slot = (date, hour) => I.slotDayNumber(date) * 24 + hour;
const reading = (v, d, h) => ({ v, d, dow: 0, h, at: `${d}T${String(h).padStart(2, '0')}:20:00Z` });

test('the nowcast takes the newest reading from an EARLIER hour, never the hour it is scoring', () => {
  const stored = I.parseRecentReadings([reading(80, '2026-09-06', 19), reading(40, '2026-09-06', 18), reading(10, '2026-09-06', 16)]);
  // Scoring 19:00 after the 19:00 sweep: 19:00's own reading is skipped.
  const p = I.pickNowcastReading(stored, slot('2026-09-06', 19));
  assert.equal(p.value, 40);
  assert.equal(p.lagHours, 1);
  assert.equal(p.bucket, 1);
  // Scoring 21:00: the 19:00 reading, two hours old.
  assert.deepEqual([I.pickNowcastReading(stored, slot('2026-09-06', 21)).value, I.pickNowcastReading(stored, slot('2026-09-06', 21)).bucket], [80, 2]);
  // Scoring 17:00 (a strip hour behind the table): the 16:00 reading.
  assert.equal(I.pickNowcastReading(stored, slot('2026-09-06', 17)).value, 10);
  // Scoring 16:00: nothing earlier is stored.
  assert.equal(I.pickNowcastReading(stored, slot('2026-09-06', 16)), null);
});

test('lag buckets are 1, 2, 3 and 4 up to NOWCAST_MAX_LAG_HOURS, and a stale newest reading is not replaced by an older one', () => {
  assert.deepEqual([1, 2, 3, 4, 7, I.NOWCAST_MAX_LAG_HOURS].map(I.nowcastBucket), [1, 2, 3, 4, 4, 4]);
  assert.equal(I.nowcastBucket(0), null);
  assert.equal(I.nowcastBucket(I.NOWCAST_MAX_LAG_HOURS + 1), null);
  const stored = I.parseRecentReadings([reading(60, '2026-09-05', 20)]);
  assert.equal(I.pickNowcastReading(stored, slot('2026-09-06', 8)).lagHours, 12);
  assert.equal(I.pickNowcastReading(stored, slot('2026-09-06', 9)), null, 'thirteen hours old: nothing');
  // Across midnight the lag is wall-clock hours on the venue's own dates.
  assert.equal(I.pickNowcastReading(I.parseRecentReadings([reading(5, '2026-09-05', 23)]), slot('2026-09-06', 1)).lagHours, 2);
});

test('stored readings are read defensively: anything not a whole reading is dropped, a JSON string is parsed', () => {
  const parsed = I.parseRecentReadings(JSON.stringify([
    reading(50, '2026-09-06', 18), { v: 120, d: '2026-09-06', h: 17 }, { v: 30, d: 'yesterday', h: 16 },
    { v: 30, d: '2026-09-06', h: 24 }, null, { v: '45', d: '2026-09-06', h: 15 },
  ]));
  assert.deepEqual(parsed.map((r) => [r.value, r.hour]), [[50, 18], [45, 15]]);
  assert.equal(I.parseRecentReadings('not json'), null);
  assert.equal(I.parseRecentReadings(null), null);
  assert.equal(I.pickNowcastReading(null, 100), null);
});

// ── The arithmetic ──────────────────────────────────────────────────────────

test('curve_offset is the served curve plus CURVE_OFFSET_WEIGHT times the offset, rounded and clamped', () => {
  assert.ok(I.CURVE_OFFSET_WEIGHT > 0 && I.CURVE_OFFSET_WEIGHT <= 1, 'fitted on 0..1');
  assert.equal(I.curveOffsetScore(40, null), 40);
  assert.equal(I.curveOffsetScore(40, { offset: -20 }), Math.round(40 - 20 * I.CURVE_OFFSET_WEIGHT));
  assert.equal(I.curveOffsetScore(95, { offset: 50 }), 100);
  assert.equal(I.curveOffsetScore(5, { offset: -50 }), 0);
});

test('the nowcast blends toward the reading by its lag weight; a zero weight or a foreign model leaves the number alone', () => {
  for (const base of Object.keys(I.NOWCAST_WEIGHTS)) {
    for (const b of [1, 2, 3, 4]) {
      const w = I.NOWCAST_WEIGHTS[base][b];
      assert.ok(w >= 0 && w <= 1, `${base} lag ${b}`);
    }
    assert.ok(I.NOWCAST_WEIGHTS[base][1] >= I.NOWCAST_WEIGHTS[base][3], `${base}: the weight falls with the lag`);
  }
  const pick = { value: 80, lagHours: 1, bucket: 1, date: '2026-09-06', hour: 18, observedAt: null };
  const a = I.applyNowcast(20, pick, 'curve_offset');
  assert.equal(a.score, Math.round(20 + I.NOWCAST_WEIGHTS.curve_offset[1] * 60));
  assert.equal(a.moved, a.score - 20);
  const zeroBucket = Object.entries(I.NOWCAST_WEIGHTS.curve_offset).find(([, w]) => w === 0);
  if (zeroBucket) assert.equal(I.applyNowcast(20, { ...pick, bucket: Number(zeroBucket[0]) }, 'curve_offset'), null);
  assert.equal(I.applyNowcast(20, null, 'curve_offset'), null);
  assert.equal(I.nowcastBaseKey(false, true, 'some-other-model'), null, 'model tables apply only to the model they were fitted on');
  assert.equal(I.nowcastBaseKey(true, false, 'some-other-model'), 'curve_offset');
  assert.equal(I.nowcastBaseKey(false, true, I.NOWCAST_MODEL_FITTED_ON), 'model_qmap');
  assert.equal(I.nowcastBaseKey(false, false, I.NOWCAST_MODEL_FITTED_ON), 'model');
});

// 2026-10-14: on the curve_offset base a reading two or three hours old no
// longer moves the number (mlPredictor.js, the block above NOWCAST_WEIGHTS).
// The number is curve + offset, and the card publishes the figure measured on
// curve + offset.
test('on the curve_offset base, a reading 2, 3 or 4+ hours old leaves the number at curve + offset, and the card says so', () => {
  assert.deepEqual({ ...I.NOWCAST_WEIGHTS.curve_offset }, { 1: 1, 2: 0, 3: 0, 4: 0 });
  const base = I.curveOffsetScore(40, { offset: -20 });
  for (const bucket of [2, 3, 4]) {
    const pick = { value: 90, lagHours: bucket, bucket, date: '2026-09-06', hour: 19 - bucket, observedAt: null };
    assert.equal(I.applyNowcast(base, pick, 'curve_offset'), null, `lag ${bucket} moved the curve_offset number`);
    assert.equal(I.SERVE_MEASURED.nowcast.curve_offset[bucket], null, `lag ${bucket} still carries a figure`);
  }
  // A one-hour reading is still the number.
  assert.equal(I.applyNowcast(base, { value: 90, lagHours: 1, bucket: 1, date: '2026-09-06', hour: 18, observedAt: null }, 'curve_offset').score, 90);
  // With no nowcast applied, the confidence is the curve + offset figure.
  const accuracy = { status: 'measured', percent: 33.3, metric: 'within_15', population: 'realtime_served', rows: 1 };
  const c = I.servedConfidence({ accuracy, qmapApplied: false, hasWeather: true, curveOffset: true, nowcast: null, ladder: () => 70 });
  assert.equal(c.confidenceMeasurement.metric, 'within_15_curve_offset');
  assert.equal(c.confidenceMeasurement.measuredPercent, 42.7);
  assert.equal(c.confidenceMeasurement.populationRows, 119939);
  assert.equal(c.confidence, 43);
});

test('every switched arithmetic that can move a number has a measured confidence figure', () => {
  assert.ok(I.SERVE_MEASURED.curveOffset.within15 > 0 && I.SERVE_MEASURED.curveOffset.rows > 0);
  for (const [base, table] of Object.entries(I.NOWCAST_WEIGHTS)) {
    for (const b of [1, 2, 3, 4]) {
      const m = I.SERVE_MEASURED.nowcast[base][b];
      if (table[b] > 0) {
        assert.ok(m && m.within15 > 0 && m.within15 <= 100 && Number.isInteger(m.rows) && m.rows > 0, `${base} lag ${b}`);
      }
    }
  }
  assert.match(I.SERVE_MEASURED_POPULATION, /2026-09-09\.\.10-08/);
});

test('the confidence names the arithmetic that ran, and the weather adjustment follows the model', () => {
  const accuracy = { status: 'measured', percent: 33.3, metric: 'within_15', population: 'realtime_served', rows: 1 };
  const ladder = () => 70;
  const co = I.servedConfidence({ accuracy, qmapApplied: false, hasWeather: false, curveOffset: true, nowcast: null, ladder });
  assert.equal(co.confidenceMeasurement.metric, 'within_15_curve_offset');
  assert.equal(co.confidenceMeasurement.weatherPenalty, 0, 'curve_offset does not read the weather');
  assert.equal(co.confidence, Math.round(I.SERVE_MEASURED.curveOffset.within15));
  const partial = { base: 'model_qmap', bucket: 3, weight: I.NOWCAST_WEIGHTS.model_qmap[3] };
  const mn = I.servedConfidence({ accuracy, qmapApplied: true, hasWeather: false, curveOffset: false, nowcast: partial, ladder });
  assert.equal(mn.confidenceMeasurement.metric, 'within_15_nowcast_model_qmap_lag3');
  assert.equal(mn.confidenceMeasurement.weatherPenalty, 15, 'the model still shapes this number');
  const full = I.servedConfidence({ accuracy, qmapApplied: true, hasWeather: false, curveOffset: false, nowcast: { base: 'model_qmap', bucket: 1, weight: 1 }, ladder });
  assert.equal(full.confidenceMeasurement.weatherPenalty, 0, 'a reading carried at full weight owes nothing for the weather');
  // Neither switch: the model's own figure, exactly as before.
  const plain = I.servedConfidence({ accuracy, qmapApplied: false, hasWeather: true, curveOffset: false, nowcast: null, ladder });
  assert.equal(plain.confidence, 33);
  assert.equal(plain.confidenceMeasurement.metric, 'within_15');
});

test('the version a switched number carries names each switch that changed it', () => {
  assert.equal(I.servedModelVersion('2.6.0-starling', false, null), '2.6.0-starling');
  assert.equal(I.servedModelVersion('2.6.0-starling', true, null), '2.6.0-starling+curve_offset');
  assert.equal(I.servedModelVersion('2.6.0-starling', false, { bucket: 1 }), '2.6.0-starling+nowcast');
  assert.equal(I.servedModelVersion('2.6.0-starling', true, { bucket: 1 }), '2.6.0-starling+curve_offset+nowcast');
});

// ── The offset a switched number reads ─────────────────────────────────────

const offReading = (dev, d, h) => ({ dev, d, h });

test('a switched number\'s offset is the median strictly before the hour it scores, under the stored offset\'s floor and clamp', () => {
  const T = slot('2026-09-06', 19);
  const stored = I.parseOffsetReadings([
    offReading(80, '2026-09-06', 19), offReading(-20, '2026-09-06', 17), offReading(-10, '2026-09-06', 16),
  ]);
  // Scoring 19:00 after the 19:00 sweep: the 19:00 reading is left out.
  assert.deepEqual(I.trailingOffsetBefore(stored, T), { offset: -15, clamped: false, readings: 2 });
  // Scoring 20:00: all three count.
  assert.equal(I.trailingOffsetBefore(stored, T + 1).offset, -10);
  // Scoring 17:00: one earlier reading is below the floor, so no offset at all.
  assert.equal(I.trailingOffsetBefore(stored, slot('2026-09-06', 17)), null);
  // No list (the builder has not written one yet): no offset, never the stored median.
  assert.equal(I.trailingOffsetBefore(null, T), null);
  // The clamp, and the flag that says it bound.
  const wild = I.parseOffsetReadings([offReading(90, '2026-09-06', 10), offReading(80, '2026-09-06', 9)]);
  assert.deepEqual(I.trailingOffsetBefore(wild, T), { offset: I.DEVIATION_CLAMP, clamped: true, readings: 2 });
});

test('the strict offset takes the newest OFFSET_MAX_READINGS inside the window, and the stored slack covers the hour\'s own reading', () => {
  const T = slot('2026-09-06', 12);
  // KEPT readings, one an hour, newest at T itself: after dropping it, exactly
  // OFFSET_MAX_READINGS remain, the depth the builder's median is taken over.
  const list = [];
  for (let k = 0; k < I.OFFSET_READINGS_KEPT; k++) {
    const s = T - k;
    const d = new Date(Math.floor(s / 24) * 86400000).toISOString().slice(0, 10);
    list.push(offReading(k, d, s % 24));
  }
  const got = I.trailingOffsetBefore(I.parseOffsetReadings(list), T);
  assert.equal(got.readings, I.OFFSET_MAX_READINGS);
  // Deviations 1..20: the median of the twenty newest earlier readings.
  assert.equal(got.offset, 10.5);
  // A reading older than the window never counts.
  const old = I.parseOffsetReadings([offReading(-5, '2026-09-06', 11), offReading(-5, '2026-09-06', 10), offReading(40, '2026-08-01', 10)]);
  assert.equal(I.trailingOffsetBefore(old, T).readings, 2);
  assert.equal(I.OFFSET_WINDOW_HOURS, 28 * 24);
  assert.ok(I.OFFSET_READINGS_KEPT > I.OFFSET_MAX_READINGS);
  // Read defensively, like the nowcast's list.
  assert.equal(I.parseOffsetReadings('not json'), null);
  assert.equal(I.parseOffsetReadings([{ dev: 'x', d: '2026-09-06', h: 1 }, { dev: 5, d: 'no', h: 1 }, { dev: 5, d: '2026-09-06', h: 1 }]).length, 1);
});

// Number() turns null, false, '' and [] into 0 and true into 1, so a reading
// with a missing hour would have been read as midnight and a missing
// deviation as "exactly the curve". None of these is a reading.
const NOT_NUMBERS = [null, undefined, true, false, '', '  ', [], [5], {}, { valueOf: () => 5 }, NaN, Infinity, '5x', '0x10', '1e1'];
const NOT_DATES = [null, undefined, '', 20260906, ['2026-09-06'], { toString: () => '2026-09-06' }, new Date('2026-09-06T00:00:00Z'),
  '2026-02-31', '2026-13-01', '2026-9-6', ' 2026-09-06'];

test('the offset readings parser drops any entry whose dev, d or h is not a genuine value', () => {
  const good = { dev: -12.5, d: '2026-09-06', h: 18 };
  assert.deepEqual(I.parseOffsetReadings([good]), [{ dev: -12.5, slot: slot('2026-09-06', 18) }]);
  for (const bad of NOT_NUMBERS) {
    assert.deepEqual(I.parseOffsetReadings([{ ...good, dev: bad }]), [], `dev ${String(bad)}`);
    assert.deepEqual(I.parseOffsetReadings([{ ...good, h: bad }]), [], `h ${String(bad)}`);
  }
  for (const bad of NOT_DATES) assert.deepEqual(I.parseOffsetReadings([{ ...good, d: bad }]), [], `d ${String(bad)}`);
  // A missing field is the same as a bad one.
  assert.deepEqual(I.parseOffsetReadings([{ d: '2026-09-06', h: 18 }, { dev: 3, d: '2026-09-06' }, { dev: 3, h: 18 }]), []);
  // A plain decimal numeral still reads, as it always has, and a leap day is a date.
  assert.deepEqual(I.parseOffsetReadings([{ dev: '-4', d: '2028-02-29', h: '7' }]).map((r) => r.dev), [-4]);
});

test('the nowcast readings parser is exactly as strict about v, d and h', () => {
  const good = reading(40, '2026-09-06', 18);
  assert.equal(I.parseRecentReadings([good]).length, 1);
  for (const bad of NOT_NUMBERS) {
    assert.deepEqual(I.parseRecentReadings([{ ...good, v: bad }]), [], `v ${String(bad)}`);
    assert.deepEqual(I.parseRecentReadings([{ ...good, h: bad }]), [], `h ${String(bad)}`);
  }
  for (const bad of NOT_DATES) assert.deepEqual(I.parseRecentReadings([{ ...good, d: bad }]), [], `d ${String(bad)}`);
  // Through the picker: a reading with a null hour used to be a midnight
  // reading and could be carried into the next hours.
  assert.equal(I.pickNowcastReading(I.parseRecentReadings([{ v: 90, d: '2026-09-06', h: null }]), slot('2026-09-06', 1)), null);
});

test('a null deviation is no longer a zero that pulls the strict offset toward the curve', () => {
  const T = slot('2026-09-06', 19);
  const list = [{ dev: -30, d: '2026-09-06', h: 18 }, { dev: null, d: '2026-09-06', h: 17 }, { dev: -30, d: '2026-09-06', h: 16 }, { dev: null, d: '2026-09-06', h: 15 }];
  assert.deepEqual(I.trailingOffsetBefore(I.parseOffsetReadings(list), T), { offset: -30, clamped: false, readings: 2 });
});

// A flat curve of 20 and two live readings at one venue: 0 at 17:00 and 100 at
// 19:00. The card for 19:00 is served during 19:00, after that hour's sweep,
// so the stored median includes the 19:00 reading. With both switches on the
// replay serves 20 (no offset from a single earlier reading, and the 17:00
// reading is two hours old, a bucket the curve_offset table weights at zero
// since 2026-10-14); reading the stored median would serve a number moved by
// the reading it is scored against.
// `live` swaps in other readings on the same flat curve, as [date, hour, y];
// `hourly` asks predictHourlyForecast for [startHour, count] instead.
async function serveFlatCurveCase(env, { live = [['2026-09-06', 17, 0], ['2026-09-06', 19, 100]], hourly = null } = {}) {
  const venue = FX.VENUES[0];
  const curves = new Map();
  for (const v of FX.VENUES) curves.set(String(v.id), new Int16Array(168).fill(20));
  const date = '2026-09-06';
  const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const fx = {
    curves,
    weekly: [],
    live: live.map(([d, hour, y]) => ({ v: venue, date: d, dow: dowOf(d), hour, y, weather: null })),
  };
  const pool = require('../config/database');
  const realQuery = pool.query;
  const stub = FX.makeFixturePool(fx, () => ({ venueId: venue.id, date, hour: 19 }), { leakyOffset: true });
  // predictHourlyForecast reads the venue's whole week once (primeVenueCurve),
  // a statement the band fixture's pool does not answer: the flat curve here.
  const WHOLE_WEEK = /^SELECT day_of_week, hour, baseline, source, updated_at FROM ml_venue_baselines WHERE google_place_id = \$1$/;
  pool.query = (text, params) => {
    if (WHOLE_WEEK.test(String(text).replace(/\s+/g, ' ').trim())) {
      const rows = [];
      for (let s = 0; s < 168; s++) rows.push({ day_of_week: Math.floor(s / 24), hour: s % 24, baseline: '20', source: 'collected', updated_at: new Date() });
      return Promise.resolve({ rows });
    }
    return stub.query(text, params);
  };
  const quiet = [console.log, console.warn, console.error];
  try {
    return await withEnv(env, async () => {
      const predictor = freshPredictor();
      console.log = () => {};
      console.warn = () => {};
      console.error = () => {};
      assert.equal(await predictor.init(), true);
      const place = {
        place_id: 'ChIJservemodes_flat_curve',
        types: venue.types,
        rating: 4.4,
        user_ratings_total: 900,
        price_level: 2,
        location: { latitude: venue.lat, longitude: venue.lng },
      };
      const wx = { temp: 70, humidity: 50, windSpeed: 5, conditions: 'clear sky', conditionId: 800, isRaining: false };
      const out = hourly
        ? await predictor.predictHourlyForecast(place, wx, hourly[0], hourly[1], new Date(Date.UTC(2026, 8, 6, hourly[0])))
        : await predictor.predictBusyness(place, wx, new Date(Date.UTC(2026, 8, 6, 19, 30)));
      assert.deepEqual(stub.unknown, []);
      return out;
    });
  } finally {
    [console.log, console.warn, console.error] = quiet;
    pool.query = realQuery;
    delete require.cache[PREDICTOR];
  }
}

test('with both switches on, the hour\'s own reading never reaches the number through the offset', async () => {
  const on = await serveFlatCurveCase({ CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' });
  assert.equal(on.predictionMethod, 'ml');
  assert.equal(on.recentDeviation, null, 'one earlier reading is below the floor, so no offset');
  // The 17:00 reading is two hours old, which the curve_offset table weights
  // at zero: no nowcast, the curve alone, and nothing of the 19:00 reading.
  assert.equal(I.NOWCAST_WEIGHTS.curve_offset[2], 0);
  assert.equal(on.nowcast, null);
  assert.equal(on.score, 20);
  // An 18:00 reading is one hour old and is carried at full weight, still
  // with nothing of the 19:00 reading in it.
  const oneHour = await serveFlatCurveCase({ CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' }, { live: [['2026-09-06', 18, 55], ['2026-09-06', 19, 100]] });
  assert.equal(oneHour.nowcast.lagHours, 1);
  assert.equal(oneHour.score, 55);
  // curve_offset alone: the curve, with no offset from the 19:00 reading.
  const co = await serveFlatCurveCase({ CROWD_SERVE_MODE: 'curve_offset' });
  assert.equal(co.score, 20);
  assert.equal(co.recentDeviation, null);
});

test('with both switches off no stored median is added after an artifact that takes the offset as an input, and the hour\'s own reading reaches nothing', async () => {
  // v2.6.0-starling was served the stored median here, the hour's own reading
  // included: median(0 - 20, 100 - 20) = 30, at DEVIATION_WEIGHT. An artifact
  // that lists the live features is handed no offset after the model
  // (artifactLearnsOffset): what it knows of the venue's readings is what
  // liveFeatureValues builds from those strictly before the hour, here the
  // 17:00 reading of 0, two hours old. On the flat curve of 20 that is 17.
  assert.equal(I.artifactLearnsOffset(JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'model_metadata.json'), 'utf8'))), true);
  const off = await serveFlatCurveCase({});
  assert.equal(off.predictionMethod, 'ml');
  assert.equal(off.recentDeviation, null);
  assert.equal(off.liveFeaturesUsedReadings, true, 'the 17:00 reading is among the graph\'s inputs');
  assert.equal(off.score, 17);
  assert.ok(!('serveMode' in off) && !('nowcast' in off));
  // The stored median the pool offers includes 19:00's own reading. None of
  // it reaches the number: a 19:00 reading of 0, or none at all, serves the same.
  const ownZero = await serveFlatCurveCase({}, { live: [['2026-09-06', 17, 0], ['2026-09-06', 19, 0]] });
  const ownNone = await serveFlatCurveCase({}, { live: [['2026-09-06', 17, 0]] });
  assert.equal(ownZero.score, off.score);
  assert.equal(ownNone.score, off.score);
});

// ── Through predictBusyness ─────────────────────────────────────────────────

test('with the switches on, the rule-engine exits answer exactly as they do off, and switched numbers say what made them', async () => {
  const off = await serveFixture({});
  const on = await serveFixture({ CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' });
  assert.deepEqual(on.unknown, []);
  for (const i of GOLDEN.ruleRows) {
    assert.deepEqual(on.out[i], off.out[i], `rule-engine row ${i} must not change`);
  }
  const ml = on.out.filter((r) => r.predictionMethod === 'ml');
  assert.ok(ml.every((r) => r.serveMode === 'curve_offset'));
  assert.ok(ml.every((r) => /^2\.8\.0-starling\+curve_offset(\+nowcast)?$/.test(r.modelVersion)));
  assert.ok(ml.every((r) => !r.dataSourcesUsed.includes('ml_model') && !r.dataSourcesUsed.includes('weather')),
    'curve_offset does not claim the model or the weather fed it');
  assert.ok(ml.every((r) => r.scoreCalibration === null));
  const nowcasted = ml.filter((r) => r.nowcast);
  assert.ok(nowcasted.length > 0);
  assert.ok(nowcasted.every((r) => r.modelVersion.endsWith('+nowcast') && r.nowcast.lagHours >= 1));
  assert.ok(nowcasted.every((r) => r.confidenceMeasurement.metric.startsWith('within_15_nowcast_curve_offset_lag')));
  // The offset and the readings came from one statement per place.
  const dev = on.sql.filter((s) => /ml_venue_recent_deviation/.test(s));
  assert.equal(dev.length, on.out.length - GOLDEN.ruleRows.length);
  assert.ok(dev.every((s) => /recent_readings/.test(s) && /offset_readings/.test(s)));
});

// ── The words that attribute a switched number ─────────────────────────────

test('describeServedArithmetic names the switched arithmetic, and nothing for a number neither switch changed', async () => {
  const { describeServedArithmetic } = crowdEngine;
  assert.equal(describeServedArithmetic(null), null);
  assert.equal(describeServedArithmetic({ predictionMethod: 'rule_engine_fallback', serveMode: 'curve_offset' }), null);
  assert.equal(describeServedArithmetic({ predictionMethod: 'ml', dataSourcesUsed: ['ml_model'] }), null);
  assert.equal(describeServedArithmetic({ predictionMethod: 'ml', serveMode: 'model', nowcast: null }), null);
  assert.equal(describeServedArithmetic({ predictionMethod: 'ml', serveMode: 'model', nowcast: { bucket: 1 } }), 'model_live');
  assert.equal(describeServedArithmetic({ predictionMethod: 'ml', serveMode: 'curve_offset', dataSourcesUsed: ['venue_data'] }), 'venue_pattern');
  assert.equal(describeServedArithmetic({ predictionMethod: 'ml', serveMode: 'curve_offset', dataSourcesUsed: ['venue_data', 'recent_live_readings'] }), 'venue_pattern_live');

  // Through predictBusyness: nothing with both off, and on the fixture the
  // curve_offset answers name the pattern (with live readings wherever an
  // offset or a reading reached the number).
  const off = await serveFixture({});
  assert.ok(off.out.every((r) => describeServedArithmetic(r) === null));
  const co = await serveFixture({ CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' });
  const carried = (r) => (r.nowcast && r.nowcast.weight >= 1 ? `live_reading_${r.nowcast.lagHours}h` : null);
  for (const r of co.out) {
    if (r.predictionMethod !== 'ml') { assert.equal(describeServedArithmetic(r), null); continue; }
    const live = Boolean(r.recentDeviation || r.nowcast);
    assert.equal(describeServedArithmetic(r), carried(r) || (live ? 'venue_pattern_live' : 'venue_pattern'));
    // The explicit yes or no agrees with what actually reached the number.
    assert.equal(r.usedLiveReadings, live);
  }
  // The nowcast on in model mode. The model nowcast tables were fitted on
  // v2.6.0-starling's output and apply to no other version (nowcastBaseKey),
  // and this artifact takes the offset as an input, so its numbers carry no
  // nowcast and no offset after them: the switch changes none of them,
  // nothing is named, and the yes or no is whether a live reading was among
  // the graph's inputs.
  const mn = await serveFixture({ CROWD_NOWCAST_ENABLED: 'true' });
  assert.equal(I.nowcastBaseKey(false, false, GOLDEN.version), null);
  assert.equal(I.nowcastBaseKey(false, true, GOLDEN.version), null);
  const mnModel = mn.out.filter((r) => r.predictionMethod === 'ml');
  assert.equal(mnModel.length, mn.out.length - GOLDEN.ruleRows.length);
  for (const r of mnModel) {
    assert.equal(r.nowcast, null);
    assert.equal(r.recentDeviation, null);
    assert.equal(r.offsetChangedBySwitch, false);
    assert.equal(describeServedArithmetic(r), null);
    assert.equal(r.serveMode, 'model');
    assert.equal(r.modelVersion, GOLDEN.version, 'no qualifier: no switch changed the number');
    assert.equal(r.usedLiveReadings, r.liveFeaturesUsedReadings);
  }
  assert.deepEqual(mn.out.map((r) => r.score), off.out.map((r) => r.score), 'the switched-off numbers, row for row');
  // On the fixture 126 of the 132 model numbers had a reading or an offset in
  // their inputs, and six had neither.
  assert.equal(mnModel.filter((r) => r.usedLiveReadings === true).length, 126);
  assert.equal(mnModel.filter((r) => r.usedLiveReadings === false).length, 6);
});

test('a reading carried at full weight is attributed as that reading, with its age', () => {
  const { describeServedArithmetic } = crowdEngine;
  const ml = (extra) => ({ predictionMethod: 'ml', serveMode: 'model', dataSourcesUsed: ['ml_model', 'recent_live_readings'], ...extra });
  // Every base carries a one-hour-old reading at weight 1 today.
  for (const base of Object.keys(I.NOWCAST_WEIGHTS)) assert.equal(I.NOWCAST_WEIGHTS[base][1], 1, base);
  assert.equal(describeServedArithmetic(ml({ nowcast: { base: 'model_qmap', lagHours: 1, bucket: 1, weight: 1 } })), 'live_reading_1h');
  // Older than an hour and still weight 1: model_qmap at two hours.
  assert.equal(I.NOWCAST_WEIGHTS.model_qmap[2], 1);
  assert.equal(describeServedArithmetic(ml({ nowcast: { base: 'model_qmap', lagHours: 2, bucket: 2, weight: 1 } })), 'live_reading_2h');
  // In curve_offset mode too: the pattern did not shape it either.
  assert.equal(describeServedArithmetic({ ...ml({ nowcast: { base: 'curve_offset', lagHours: 1, bucket: 1, weight: 1 } }), serveMode: 'curve_offset' }), 'live_reading_1h');
  // A partial weight is a blend, and keeps the blend's words.
  assert.equal(describeServedArithmetic(ml({ nowcast: { base: 'model_qmap', lagHours: 3, bucket: 3, weight: 0.55 } })), 'model_live');
  assert.equal(describeServedArithmetic({ ...ml({ nowcast: { base: 'curve_offset', lagHours: 2, bucket: 2, weight: 0.85 } }), serveMode: 'curve_offset' }), 'venue_pattern_live');
  // A malformed lag never becomes a label.
  assert.equal(describeServedArithmetic(ml({ nowcast: { lagHours: null, weight: 1 } })), 'model_live');
  // The offset flag alone, off the served shape.
  assert.equal(describeServedArithmetic(ml({ nowcast: null, offsetChangedBySwitch: true, recentDeviation: { offset: -5 } })), 'model_live');
  assert.equal(describeServedArithmetic(ml({ nowcast: null, offsetChangedBySwitch: true, recentDeviation: null })), 'model_alone');
  assert.equal(describeServedArithmetic(ml({ nowcast: null, offsetChangedBySwitch: false, recentDeviation: { offset: -5 } })), null);
});

test('through predictBusyness, a model the nowcast tables were not fitted on is never handed a carried reading: the reading is one of its inputs', async () => {
  // Nowcast only, model mode. Under v2.6.0-starling the 17:00 reading of 0,
  // two hours old at 19:00, was carried at weight 1 (model_qmap) and WAS the
  // number. The tables were fitted on that version's output, so 2.8.0-starling
  // gets no nowcast: the reading is in its inputs, and the number is the
  // model's, the same one the switched-off server gives.
  const two = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' });
  assert.equal(two.nowcast, null);
  assert.equal(two.serveMode, 'model');
  assert.equal(two.modelVersion, GOLDEN.version);
  assert.equal(two.score, 17, 'the model\'s number, not the reading of 0');
  assert.equal(two.score, (await serveFlatCurveCase({})).score);
  assert.equal(crowdEngine.describeServedArithmetic(two), null);
  assert.equal(two.usedLiveReadings, true, 'and it says a live reading is in it');
  // A reading an hour old: still the model's number, pulled most of the way to it.
  const hourOld = [['2026-09-06', 18, 55], ['2026-09-06', 19, 100]];
  const one = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live: hourOld });
  assert.equal(one.nowcast, null);
  assert.equal(one.score, 51);
  assert.equal(one.score, (await serveFlatCurveCase({}, { live: hourOld })).score);
  assert.equal(crowdEngine.describeServedArithmetic(one), null);
  assert.equal(one.usedLiveReadings, true);
});

test('for an artifact that takes the offset as an input no switch changes an offset after it: the number is the same on or off, and the yes or no follows its inputs', async () => {
  // Flat curve 20. Yesterday's readings are too old for the nowcast (over
  // NOWCAST_MAX_LAG_HOURS) but inside the offset's window. Under
  // v2.6.0-starling the stored median (0, 19:00's own reading included) was
  // added after the model with the switches off and the strict one (-20) with
  // the nowcast on, so the switch changed the number and was attributed. This
  // artifact reads the strict offset as an input either way, and nothing is
  // added after it.
  const live = [['2026-09-05', 10, 0], ['2026-09-05', 11, 0], ['2026-09-05', 12, 40], ['2026-09-06', 19, 100]];
  const off = await serveFlatCurveCase({}, { live });
  assert.equal(off.recentDeviation, null);
  assert.ok(!('offsetChangedBySwitch' in off));
  assert.equal(crowdEngine.describeServedArithmetic(off), null);
  const on = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live });
  assert.equal(on.nowcast, null, 'no reading the nowcast may use');
  assert.equal(on.recentDeviation, null);
  assert.equal(on.score, 17);
  assert.equal(on.score, off.score, 'the switch changed nothing');
  assert.equal(on.offsetChangedBySwitch, false);
  assert.equal(crowdEngine.describeServedArithmetic(on), null);

  // One earlier reading, under the offset's floor and too old to be the
  // newest reading: nothing from a live reading is among the inputs, and the
  // number is the model's with no live readings in it.
  const lone = [['2026-09-05', 11, 0], ['2026-09-06', 19, 100]];
  const offLone = await serveFlatCurveCase({}, { live: lone });
  assert.equal(offLone.recentDeviation, null);
  assert.equal(offLone.liveFeaturesUsedReadings, false);
  const onLone = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live: lone });
  assert.equal(onLone.nowcast, null);
  assert.equal(onLone.recentDeviation, null);
  assert.equal(onLone.offsetChangedBySwitch, false);
  assert.equal(onLone.score, 18);
  assert.equal(onLone.score, offLone.score);
  assert.equal(crowdEngine.describeServedArithmetic(onLone), null);

  // Two readings yesterday and 19:00's own: the strict offset of the two is
  // among the inputs, so live readings are in this number. Said as a yes.
  const same = [['2026-09-05', 10, 0], ['2026-09-05', 11, 0], ['2026-09-06', 19, 0]];
  const onSame = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live: same });
  assert.equal(onSame.nowcast, null);
  assert.equal(onSame.offsetChangedBySwitch, false);
  assert.equal(crowdEngine.describeServedArithmetic(onSame), null);
  assert.equal(onSame.recentDeviation, null);
  assert.equal(onSame.liveFeaturesUsedReadings, true, 'the offset reached the graph');
  assert.equal(onSame.usedLiveReadings, true);
  assert.equal(onLone.usedLiveReadings, false, 'no offset and no reading: a no');
  assert.equal(on.usedLiveReadings, true);
  assert.ok(!('usedLiveReadings' in off));
});

test('each forecast hour says yes or no to live readings, including an hour no source is named for', async () => {
  // Readings too old to be the newest reading but inside the offset window,
  // and 19:00's own reading. The strict offset of the two 2026-09-05 readings
  // is among every hour's inputs, and at 20:00 so is the 19:00 reading, an
  // hour old. No source is named for any of them: this artifact's numbers
  // carry no nowcast and no offset after them, so no switch changed one.
  // (Under v2.6.0-starling the 20:00 hour was the carried reading and said
  // 'live_reading_1h'.)
  const same = [['2026-09-05', 10, 0], ['2026-09-05', 11, 0], ['2026-09-06', 19, 0]];
  const on = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live: same, hourly: [18, 3] });
  assert.deepEqual(on.map((h) => h.numberSource || null), [null, null, null]);
  assert.ok(on.every((h) => !('numberSource' in h)));
  assert.deepEqual(on.map((h) => h.liveReadings), [true, true, true],
    'a missing source is not a missing live reading');
  assert.deepEqual(on.map((h) => h.score), [15, 17, 8], '20:00 follows the hour-old reading of 0');
  // Switched off, no hour carries the yes or no.
  const off = await serveFlatCurveCase({}, { live: same, hourly: [18, 3] });
  for (const h of off) assert.ok(!('liveReadings' in h) && !('numberSource' in h), h.hour);
  assert.deepEqual(off.map((h) => h.score), on.map((h) => h.score),
    'where no source is named the number is the switched-off number');
});

test('with only the no-curve fallback on, each forecast hour says yes or no to live readings, and a reading among the model\'s inputs is a yes', async () => {
  // CROWD_NO_CURVE_FALLBACK is a switch too: while it is on, the strip's
  // hours say what made them, so the venue dashboard can name a peak the
  // category table made. With both serving switches off the model's number
  // still has the venue's live readings in it (for this artifact among its
  // inputs; for one that lists no live feature, in the stored offset added
  // after it), and the hour has to say yes to that, never a no it would be
  // wrong about.
  const same = [['2026-09-05', 10, 0], ['2026-09-05', 11, 0], ['2026-09-06', 19, 0]];
  const off = await serveFlatCurveCase({}, { live: same, hourly: [18, 3] });
  const fallbackOnly = await serveFlatCurveCase({ CROWD_NO_CURVE_FALLBACK: 'category_curve' }, { live: same, hourly: [18, 3] });
  assert.deepEqual(fallbackOnly.map((h) => h.score), off.map((h) => h.score), 'the same numbers as switched off');
  for (const h of fallbackOnly) {
    assert.equal(h.predictionMethod, 'ml', h.hour);
    assert.ok(!('numberSource' in h), `${h.hour}: no serving switch named an arithmetic`);
  }
  assert.deepEqual(fallbackOnly.map((h) => h.liveReadings), [true, true, true], 'a live reading is among every hour\'s inputs');
  // One number, read the same way: the switched-off response does not say it
  // used live readings, and what the graph was handed does.
  const one = await serveFlatCurveCase({}, { live: same });
  assert.equal(one.recentDeviation, null, 'no offset after a model that took it as an input');
  assert.equal(one.liveFeaturesUsedReadings, true);
  assert.ok(!('usedLiveReadings' in one));
  const { liveReadingsReached } = freshPredictor();
  assert.equal(liveReadingsReached(one), true);
  assert.equal(liveReadingsReached({ ...one, liveFeaturesUsedReadings: false }), false);
  // A stored offset recorded on the number is a yes on its own (the artifact
  // that lists no live feature), and neither is a no.
  assert.equal(liveReadingsReached({ ...one, liveFeaturesUsedReadings: false, recentDeviation: { offset: -5 } }), true);
  assert.equal(liveReadingsReached({ predictionMethod: 'ml', recentDeviation: null }), false);
  // A switched number's own answer wins, either way.
  assert.equal(liveReadingsReached({ ...one, usedLiveReadings: false }), false);
  assert.equal(liveReadingsReached({ predictionMethod: 'ml', usedLiveReadings: true }), true);
  // The rule engine and the category table read no live reading.
  assert.equal(liveReadingsReached({ predictionMethod: 'rule_engine_no_baseline' }), false);
  assert.equal(liveReadingsReached(null), false);
});

test('each forecast hour carries its own yes or no, a source only where a switch made the number, and a switched-off hour neither', async () => {
  const OFF_KEYS = ['baselineScore', 'eventsObserved', 'eventsUnavailableReason', 'hour', 'label', 'predictionMethod', 'score'];
  const off = await serveFlatCurveCase({}, { hourly: [17, 5] });
  assert.equal(off.length, 5);
  for (const h of off) assert.deepEqual(Object.keys(h).sort(), OFF_KEYS, h.hour);
  // The stored readings as of 19:00 are 0 at 17:00 and 100 at 19:00. At 17:00
  // nothing earlier exists. 18:00 and 19:00 have the 17:00 reading among
  // their inputs (one and two hours old), 20:00 and 21:00 the 19:00 one.
  // Under v2.6.0-starling those four hours WERE the carried reading (0, 0,
  // 100, 100) and named it; this artifact's numbers carry no nowcast, so no
  // source is named and each number is the model's own, moved by the reading:
  // down to 12 an hour after the 0, up to 71 an hour after the 100 (the flat
  // curve of 20 plus the serve clamp of 50, and the one-point push).
  const on = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { hourly: [17, 5] });
  assert.deepEqual(on.map((h) => h.numberSource || null), [null, null, null, null, null]);
  assert.deepEqual(on.map((h) => h.score), [15, 12, 17, 71, 60]);
  assert.deepEqual(on.map((h) => h.score), off.map((h) => h.score), 'the switched-off numbers');
  // Every switched hour says yes or no to live readings; a source only where
  // one is named, which here is nowhere.
  for (const h of on) assert.deepEqual(Object.keys(h).sort(), [...OFF_KEYS, 'liveReadings'].sort());
  assert.deepEqual(on.map((h) => h.liveReadings), [false, true, true, true, true]);
  // Where a switch does make the number, the hour names it: curve_offset
  // with the nowcast, on the same readings, carries the hour-old reading at
  // 18:00 and 20:00, and by 21:00 two earlier readings give the curve an offset.
  const co = await serveFlatCurveCase({ CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' }, { hourly: [17, 5] });
  assert.deepEqual(co.map((h) => h.numberSource || null), ['venue_pattern', 'live_reading_1h', 'venue_pattern', 'live_reading_1h', 'venue_pattern_live']);
  assert.deepEqual([co[1].score, co[3].score], [0, 100], 'each carried hour\'s number is the reading it names');
  for (const h of co) assert.deepEqual(Object.keys(h).sort(), [...OFF_KEYS, 'liveReadings', 'numberSource'].sort());
  // The venue dashboard passes each hour's source through to its bars.
  const dash = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  assert.match(dash, /todayHourly: todayHourly\.map\(\(\{ baselineScore, \.\.\.bar \}\) => bar\),/);
});

test('describePublishedArithmetic names the published number: adjusted by reporters, or nothing under an owner reading', () => {
  const { describePublishedArithmetic } = crowdEngine;
  const carried = { predictionMethod: 'ml', serveMode: 'model', nowcast: { base: 'model_qmap', lagHours: 1, bucket: 1, weight: 1 } };
  assert.equal(describePublishedArithmetic(carried), 'live_reading_1h');
  assert.equal(describePublishedArithmetic(carried, { reportsBlended: false }), 'live_reading_1h');
  // A reading of 20 blended to 35 by verified reporters is not the reading.
  assert.equal(describePublishedArithmetic(carried, { reportsBlended: true }), 'live_reading_1h_adjusted');
  // The owner's figure names its own source.
  assert.equal(describePublishedArithmetic(carried, { ownerReading: true }), null);
  assert.equal(describePublishedArithmetic(carried, { reportsBlended: true, ownerReading: true }), null);
  const pattern = { predictionMethod: 'ml', serveMode: 'curve_offset', dataSourcesUsed: ['venue_data', 'recent_live_readings'] };
  assert.equal(describePublishedArithmetic(pattern, { reportsBlended: true }), 'venue_pattern_live_adjusted');
  // With both switches off nothing is named, adjusted or not.
  const plain = { predictionMethod: 'ml', dataSourcesUsed: ['ml_model'] };
  for (const adj of [undefined, {}, { reportsBlended: true }, { ownerReading: true }]) {
    assert.equal(describePublishedArithmetic(plain, adj), null);
  }
  assert.equal(describePublishedArithmetic(null, { reportsBlended: true }), null);
  assert.equal(describePublishedArithmetic({ predictionMethod: 'rule_engine_fallback', serveMode: 'curve_offset' }, { reportsBlended: true }), null);
});

test('the card, Birdie, the public demo and the venue dashboard publish the arithmetic only when a switch made the number, as adjusted', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const crowd = read('routes/crowd.js');
  assert.match(crowd, /const numberSource = crowdEngine\.describePublishedArithmetic\(crowdResult, \{\s*reportsBlended: calibration\.feedbackUsed === true,\s*\}\);/);
  assert.match(crowd, /\.\.\.\(numberSource \? \{ numberSource \} : \{\}\),/);
  const ai = read('routes/ai.js');
  assert.match(ai, /\.\.\.\(describePublishedArithmetic\(crowdResult, \{ reportsBlended, ownerReading: Boolean\(ownerLive\) \}\)\s*\? \{ crowd_method: describePublishedArithmetic\(crowdResult, \{ reportsBlended, ownerReading: Boolean\(ownerLive\) \}\) \}\s*: \{\}\),/);
  assert.match(ai, /reportsBlended = cal\.feedbackUsed === true;/);
  assert.match(ai, /delete result\.crowd_method;/, 'a locked forecast drops it with the rest of the reading');
  assert.match(ai, /When get_crowd_prediction returns \\`crowd_method\\`/);
  assert.match(ai, /A value ending in "_adjusted"[^\n]*never present it as the live reading itself/);
  const demo = read('routes/publicCrowd.js');
  assert.match(demo, /\.\.\.\(describePublishedArithmetic\(scored\) \? \{ number_source: describePublishedArithmetic\(scored\) \} : \{\}\),/);
  const dash = read('routes/venueDashboard.js');
  assert.match(dash, /\.\.\.\(crowdEngine\.describePublishedArithmetic\(current\)\s*\? \{ numberSource: crowdEngine\.describePublishedArithmetic\(current\) \}\s*: \{\}\),/);
  // No surface publishes the served source unfiltered any more.
  for (const [name, src] of [['crowd', crowd], ['ai', ai], ['demo', demo], ['dash', dash]]) {
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /describeServedArithmetic\(/, name);
  }
  // An applied owner reading drops the served source from the card.
  const owner = read('services/ownerReports.js');
  assert.match(owner, /delete out\.numberSource;\n\s*delete out\.number_source;/);
});

test('predictionCoverage says which switches are on and how many answers each made', async () => {
  await withEnv({ CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' }, async () => {
    const c = I.__resetRecentDeviationCache;
    c();
    const p = freshPredictor();
    const cov = p.predictionCoverage();
    assert.equal(cov.serveMode, 'curve_offset');
    assert.equal(cov.nowcastEnabled, true);
    assert.equal(cov.curveOffsetAnswers, 0);
    assert.deepEqual(cov.nowcastAnswersByLag, { 1: 0, 2: 0, 3: 0, 4: 0 });
    delete require.cache[PREDICTOR];
  });
});

// ── The builder and serving agree ──────────────────────────────────────────

test('the builder stores as many readings as serving expects, over a window the lag cap fits inside', () => {
  const src = fs.readFileSync(path.join(ML_DIR, 'buildRecentDeviation.js'), 'utf8');
  const kept = Number(/const READINGS_KEPT = (\d+);/.exec(src)[1]);
  const windowHours = Number(/const READINGS_WINDOW_HOURS = (\d+);/.exec(src)[1]);
  assert.equal(kept, I.NOWCAST_READINGS_KEPT);
  assert.ok(kept >= 2, 'the target hour\'s own reading plus the one before it');
  assert.ok(windowHours >= 2 * I.NOWCAST_MAX_LAG_HOURS);
  // The same population as the offset, and past-only in the serving sense.
  assert.match(src, /t\.label_source = 'live'[\s\S]*b\.baseline > 0[\s\S]*make_interval\(hours => \$1::int\)/);
  // Its own statement in its own try, so a missing column cannot cost the
  // offset, and since 2026-11-22 BEFORE the offset's, so the hour-old reading
  // reaches serving about a minute sooner after each sweep.
  const body = src.slice(src.indexOf('async function buildRecentDeviation('));
  assert.ok(body.indexOf('storeLatestReadings(') > 0 && body.indexOf('storeLatestReadings(') < body.indexOf('UPSERT_SQL'));
  assert.match(src, /async function storeLatestReadings[\s\S]*catch \(err\)/);
});

test('migration 092 adds the column additively, in ASCII, and declares it', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '092_venue_recent_readings.sql'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(sql), 'ASCII only: the boot-safety server is WIN1252');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS recent_readings JSONB;/);
  assert.match(sql, /-- @requires column ml_venue_recent_deviation\.recent_readings/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(DROP|DELETE|UPDATE|NOT NULL|DEFAULT)\b/i);
});

test('the builder stores the offset\'s readings over the offset\'s own window and depth, plus the slack serving expects', () => {
  const src = fs.readFileSync(path.join(ML_DIR, 'buildRecentDeviation.js'), 'utf8');
  const windowDays = Number(/const WINDOW_DAYS = (\d+);/.exec(src)[1]);
  const maxReadings = Number(/const MAX_READINGS = (\d+);/.exec(src)[1]);
  const slack = Number(/const OFFSET_READINGS_SLACK = (\d+);/.exec(src)[1]);
  assert.equal(windowDays * 24, I.OFFSET_WINDOW_HOURS);
  assert.equal(maxReadings, I.OFFSET_MAX_READINGS);
  assert.equal(maxReadings + slack, I.OFFSET_READINGS_KEPT);
  // The offset's population, newest slot first, each against its own slot's curve.
  const stmt = /const OFFSET_READINGS_SQL = `([\s\S]*?)`;/.exec(src)[1];
  assert.match(stmt, /t\.busyness_pct - b\.baseline AS deviation/);
  assert.match(stmt, /t\.label_source = 'live'[\s\S]*b\.baseline > 0/);
  assert.match(stmt, /ORDER BY t\.observed_date DESC, t\.hour DESC, t\.collected_at DESC/);
  assert.match(stmt, /'dev', deviation/);
  // The window's rows are read first, in a MATERIALIZED step of their own
  // written as the offsets statement's scan (2026-11-22; buildRecentDeviation.js
  // has production's plans): without MATERIALIZED the planner folds the step
  // back into the query, and an observed_date test inside it brings back the
  // estimate that chose the realtime slot index.
  const win = /WITH win AS MATERIALIZED \(([\s\S]*?)\)\s*,\s*ranked AS \(/.exec(stmt);
  assert.ok(win, 'the window is its own MATERIALIZED step, before the ranking');
  assert.doesNotMatch(win[1], /observed_date IS NOT NULL/);
  assert.match(stmt, /FROM win t\s/);
  assert.match(stmt, /t\.observed_date IS NOT NULL\s+AND b\.baseline > 0/);
  // Its own statement in its own try, after the offset's, so a missing 093
  // column cannot cost the offset or the nowcast's readings.
  const body = src.slice(src.indexOf('async function buildRecentDeviation('));
  assert.ok(body.indexOf('UPSERT_SQL') < body.indexOf('storeOffsetReadings('));
  assert.match(src, /async function storeOffsetReadings[\s\S]*catch \(err\)/);
});

test('the builder ranks and groups on the place id, the text production ran before 11 November', () => {
  // 575cc04d (2026-11-11) ranked and grouped on ml_training_data's integer
  // venue_id on a local bench's word (19 s -> 12 s); it was reverted the next
  // night on a comparison across days that the old text's first run back did
  // not bear out (buildRecentDeviation.js has the numbers). Which is faster in
  // production is not known, so the text production ran for weeks is the one
  // pinned; changing it needs production's own plans (the daily EXPLAIN line).
  const src = fs.readFileSync(path.join(ML_DIR, 'buildRecentDeviation.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const name of ['UPSERT_SQL', 'LATEST_READINGS_SQL', 'OFFSET_READINGS_SQL']) {
    const stmt = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;').exec(src)[1];
    assert.match(stmt, /PARTITION BY v\.google_place_id\s/, name);
    assert.match(stmt, /GROUP BY (r\.)?google_place_id\s/, name);
    assert.doesNotMatch(stmt, /(PARTITION|GROUP) BY\s+(\w+\.)?venue_id/, name);
  }
});

test('migration 093 adds the offset readings column additively, in ASCII, and declares it', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '093_venue_offset_readings.sql'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(sql), 'ASCII only: the boot-safety server is WIN1252');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS offset_readings JSONB;/);
  assert.match(sql, /-- @requires column ml_venue_recent_deviation\.offset_readings/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(DROP|DELETE|UPDATE|NOT NULL|DEFAULT)\b/i);
});

// ── The served artifact, byte for byte, under every switch configuration ───
//
// sha256 of the fixture's 135 responses (`asOf` left out because it is the
// wall clock) and of the statements in order, under every switch
// configuration production can set. Until 2026-11-26 this recorded
// v2.6.0-starling, an artifact that lists neither the live nor the sports
// family, from the code before the families were added (and proved they left
// it alone; re-recorded 2026-10-08 and 10-14 for the measured confidence
// figures and the curve_offset nowcast weights, and 2026-11-10 for the
// statements when the neighbour box became a weekday-at-a-time read).
// Re-recorded 2026-11-26 for 2.8.0-starling, which lists both families, by
// serving the fixture through this code with a schedule holding no games:
//   * off and off_qmapoff are one record, and now and now_qmapoff another: the
//     quantile map applies to no version but the one it was fitted on;
//   * off and now send the same statements (the model path reads the venue's
//     row with its readings either way, and the schedule once) and differ
//     only in the keys a switched response adds;
//   * co and conow send exactly the statements recorded for v2.6.0-starling
//     (the same hash): the curve_offset path runs no model, so it reads no
//     schedule. Their responses differ from that record in the version.
// Re-recorded 2026-11-27 for off, off_qmapoff, now and now_qmapoff, whose
// responses changed in confidence and confidenceMeasurement alone: a model
// number now publishes the figure measured on real readings
// (mlPredictor REAL_READINGS_MEASURED). Their statements, every score, label
// and version, and both curve_offset records are the ones recorded on
// 2026-11-26.
const RECORDED = {
  off: ['9f357271ab76db38571736a86fcd7285cbcbf81d8d8f3083553394284f26eecc', '977432f8bd4fad5a94ca588f21bab570e5ea192a65b478baab79a28fa21fd19c'],
  off_qmapoff: ['9f357271ab76db38571736a86fcd7285cbcbf81d8d8f3083553394284f26eecc', '977432f8bd4fad5a94ca588f21bab570e5ea192a65b478baab79a28fa21fd19c'],
  co: ['b49b32c55a8135f3b4221b9327f424c13df915d4f63cc87cdafa6811ec48bab8', '80b3c413e5f577ef1f7ff7767c75ca1586818aa3ad8845bd010c0876c4ad9e6b'],
  conow: ['052962d4b4c068867ba9ad59347b25c36b6106b3113a6038e33ed19a0ed57603', '80b3c413e5f577ef1f7ff7767c75ca1586818aa3ad8845bd010c0876c4ad9e6b'],
  now: ['567ca2855ac59d8f21860371519c1d2696014221714d517976bcbb041c3676d6', '977432f8bd4fad5a94ca588f21bab570e5ea192a65b478baab79a28fa21fd19c'],
  now_qmapoff: ['567ca2855ac59d8f21860371519c1d2696014221714d517976bcbb041c3676d6', '977432f8bd4fad5a94ca588f21bab570e5ea192a65b478baab79a28fa21fd19c'],
};
const RECORDED_ENV = {
  off: {},
  off_qmapoff: { CROWD_QMAP_ENABLED: 'false' },
  co: { CROWD_SERVE_MODE: 'curve_offset' },
  conow: { CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' },
  now: { CROWD_NOWCAST_ENABLED: 'true' },
  now_qmapoff: { CROWD_NOWCAST_ENABLED: 'true', CROWD_QMAP_ENABLED: 'false' },
};

test('the served artifact serves byte for byte what was recorded for it, under every switch configuration', async () => {
  const crypto = require('crypto');
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const meta = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'model_metadata.json'), 'utf8'));
  // What the record below is a record of: an artifact that lists both
  // families and so takes the offset as an input.
  assert.equal(I.artifactReadsLiveFeatures(meta), true);
  assert.equal(I.artifactReadsSportsFeatures(meta), true);
  assert.equal(I.artifactLearnsOffset(meta), true);
  for (const [name, env] of Object.entries(RECORDED_ENV)) {
    const { out, sql, version } = await serveFixture(env);
    if (version !== GOLDEN.version) assert.fail(`the served artifact is ${version}; re-record RECORDED for it`);
    assert.equal(sha(JSON.stringify(out, (k, v) => (k === 'asOf' ? null : v))), RECORDED[name][0], `${name}: responses`);
    // 2026-09-28: the two neighbour statements gained one clause, leaving
    // harvested venues out of the box (HARVESTED_STATUS in mlPredictor.js).
    // 2026-11-10: the box statement gained a second, its weekday (the box is
    // read a weekday at a time). Both are taken out before hashing, as they
    // were for the record this one replaced, so the curve_offset statements
    // still hash to what that record held.
    const stripped = sql.map((s) => s.replace(/\r?\n[ \t]*AND v\.besttime_status IS DISTINCT FROM 'harvested'/g, '').replace(/\r?\n[ \t]*AND b\.day_of_week = \$4/g, ''));
    assert.ok(sql.every((s, i) => s === stripped[i] || /FROM ml_venues v\s+JOIN ml_venue_baselines b/.test(s)),
      `${name}: the harvested clause reached a statement other than the neighbour box`);
    assert.ok(sql.some((s, i) => s !== stripped[i]), `${name}: the neighbour box no longer leaves harvested venues out`);
    assert.equal(sha(JSON.stringify(stripped)), RECORDED[name][1], `${name}: statements`);
    // The schedule: read once, and cached, wherever the model runs; never on
    // the curve_offset path, which runs no model.
    const modelRuns = env.CROWD_SERVE_MODE !== 'curve_offset';
    assert.equal(sql.filter((s) => /ml_sports_events/.test(s)).length, modelRuns ? 1 : 0, `${name}: schedule reads`);
  }
});

// ── CROWD_SERVE_MODE=model_when_fresh (2026-11-05) ─────────────────────────
//
// The model where the venue has the reading rule (b)'s nowcast would carry,
// the curve_offset path everywhere else. What is pinned here: the value is
// read as its own mode and nothing else changes for 'model', unset or an
// unknown value; "fresh" is the nowcast's own rule, not a second one; and
// through predictBusyness every number is, response for response, the number
// the 'model' or the 'curve_offset' setting serves, chosen by that rule. The
// comparisons are between settings on the same artifact, so they hold for
// whichever artifact is checked in. __tests__/mlBandEval.test.js proves the
// replay serves the same numbers.

// The fixture's own answer to "how old is this venue's newest reading from an
// earlier hour", restated from the readings themselves rather than through the
// serving code: the reading the builder stored (positive curve at its slot)
// with the latest slot strictly before the scored one, in hours, or null.
function naiveLagHours(fx, venueId, date, hour) {
  const t = FX.dayNumber(date) * 24 + hour;
  const earlier = FX.builderHistory(fx, venueId).filter((x) => x.t < t).sort((a, b) => b.t - a.t);
  return earlier.length ? t - earlier[0].t : null;
}

// A response without the mix's own account of itself, and without the wall
// clock (baselineData.asOf), so two settings' answers can be compared whole.
const comparable = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'asOf' || k === 'freshMix' ? undefined : v)));

test('CROWD_SERVE_MODE=model_when_fresh is its own mode; unset, model and unknown values still serve model', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.ok(I.SERVE_MODES.includes('model_when_fresh'));
    for (const [v, want] of [['model_when_fresh', 'model_when_fresh'], [' Model_When_Fresh ', 'model_when_fresh'],
      ['model-when-fresh', 'model'], ['model_fresh', 'model'], ['fresh', 'model'], [undefined, 'model'], ['model', 'model']]) {
      withEnv(v === undefined ? {} : { CROWD_SERVE_MODE: v }, () => assert.equal(I.serveMode(), want, JSON.stringify(v)));
    }
    // A switch: it reads the readings, and its numbers take the strict offset.
    withEnv({ CROWD_SERVE_MODE: 'model_when_fresh' }, () => assert.equal(I.switchedArithmeticOn(), true));
    // Production today (model, nowcast on) and both off are what they were.
    withEnv({ CROWD_SERVE_MODE: 'model', CROWD_NOWCAST_ENABLED: 'true' }, () => assert.equal(I.switchedArithmeticOn(), true));
    withEnv({ CROWD_SERVE_MODE: 'model' }, () => assert.equal(I.switchedArithmeticOn(), false));
    withEnv({}, () => assert.equal(I.switchedArithmeticOn(), false));
    withEnv({ CROWD_SERVE_MODE: 'model-when-fresh' }, () => assert.equal(I.switchedArithmeticOn(), false, 'an unknown value is model'));
    // The served-accuracy headline describes curve_offset + nowcast numbers only.
    withEnv({ CROWD_SERVE_MODE: 'model_when_fresh', CROWD_NOWCAST_ENABLED: 'true' }, () => assert.equal(I.servedAccuracyHeadline(), null));
  } finally { console.warn = warn; }
});

test('a fresh reading is exactly one rule (b)\'s nowcast would carry: the nowcast\'s pick, at a lag its curve_offset table weighs', () => {
  // The rule itself, bucket by bucket, against the nowcast's own arithmetic.
  for (const bucket of [1, 2, 3, 4]) {
    const pick = { value: 77, lagHours: bucket, bucket, date: '2026-09-06', hour: 10, observedAt: null };
    assert.equal(I.isFreshReading(pick), I.NOWCAST_WEIGHTS.curve_offset[bucket] > 0, `bucket ${bucket}`);
    assert.equal(I.isFreshReading(pick), I.applyNowcast(40, pick, 'curve_offset') !== null,
      `bucket ${bucket}: fresh must mean exactly "rule (b)'s nowcast uses it"`);
  }
  assert.equal(I.isFreshReading(null), false);
  assert.equal(I.isFreshReading(undefined), false);
  // Under today's table that is one hour old, and nothing else.
  const fresh = [1, 2, 3, 4].filter((b) => I.isFreshReading({ bucket: b }));
  assert.deepEqual(fresh, [1]);
  // Through the nowcast's own picker: the target hour's own reading is never
  // fresh, an hour-old one is, a two-hour-old one is not, and an older reading
  // never stands in for a missing newer one.
  const stored = I.parseRecentReadings([reading(90, '2026-09-06', 19), reading(40, '2026-09-06', 17)]);
  assert.equal(I.isFreshReading(I.pickNowcastReading(stored, slot('2026-09-06', 19))), false, '17:00 is two hours before 19:00');
  assert.equal(I.isFreshReading(I.pickNowcastReading(stored, slot('2026-09-06', 18))), true, '17:00 is one hour before 18:00');
  assert.equal(I.isFreshReading(I.pickNowcastReading(stored, slot('2026-09-06', 20))), true, '19:00 is one hour before 20:00');
  const onlyOwnHour = I.parseRecentReadings([reading(90, '2026-09-06', 19)]);
  assert.equal(I.pickNowcastReading(onlyOwnHour, slot('2026-09-06', 19)), null);
  assert.equal(I.isFreshReading(I.pickNowcastReading(onlyOwnHour, slot('2026-09-06', 19))), false);
  // No second definition: the serving path chooses its side with the nowcast's
  // picker and this predicate, and the predicate reads the nowcast's table.
  const src = fs.readFileSync(PREDICTOR, 'utf8').replace(/\r\n/g, '\n');
  assert.match(I.isFreshReading.toString(), /NOWCAST_WEIGHTS\.curve_offset\[pick\.bucket\] > 0/);
  assert.match(src, /mixPick = mixEntry \? pickNowcastReading\(mixEntry\.readings, venueSlotOf\(ts\)\) : null;/);
  assert.match(src, /mode === 'model_when_fresh' && !isFreshReading\(mixPick\)/);
  const bandEvalSrc = fs.readFileSync(path.join(ML_DIR, 'train', 'bandEval.js'), 'utf8');
  assert.match(bandEvalSrc, /mode === 'model_when_fresh' && !I\.isFreshReading\(r\.nowcastPick\)/);
});

test('unset, model and an unknown value serve the same responses and send the same statements, the nowcast on or off', async () => {
  const warn = console.warn;
  for (const nowcast of [{}, { CROWD_NOWCAST_ENABLED: 'true' }]) {
    const unset = await serveFixture({ ...nowcast });
    const model = await serveFixture({ ...nowcast, CROWD_SERVE_MODE: 'model' });
    console.warn = () => {};
    let unknown;
    try { unknown = await serveFixture({ ...nowcast, CROWD_SERVE_MODE: 'model-when-fresh' }); } finally { console.warn = warn; }
    for (const other of [model, unknown]) {
      assert.deepEqual(other.out.map(comparable), unset.out.map(comparable), JSON.stringify(nowcast));
      assert.deepEqual(other.sql, unset.sql, `${JSON.stringify(nowcast)}: the statements changed`);
    }
    assert.ok(unset.out.every((r) => !('freshMix' in r)), 'only the mix says which side answered');
  }
});

test('model_when_fresh: each number is the model setting\'s where the reading is fresh and the curve_offset setting\'s elsewhere, response for response', async () => {
  // With the nowcast on, as production runs it.
  const now = { CROWD_NOWCAST_ENABLED: 'true' };
  const mix = await serveFixture({ ...now, CROWD_SERVE_MODE: 'model_when_fresh' });
  const model = await serveFixture({ ...now, CROWD_SERVE_MODE: 'model' });
  const co = await serveFixture({ ...now, CROWD_SERVE_MODE: 'curve_offset' });
  const { fx } = mix;
  let fresh = 0;
  let stale = 0;
  mix.out.forEach((r, i) => {
    const row = fx.live[i];
    assert.equal(mix.prepared[i].venueId, String(row.v.id));
    if (r.predictionMethod !== 'ml') {
      // A rule-engine exit answers before any serve mode is read.
      assert.deepEqual(comparable(r), comparable(model.out[i]), `row ${i}: a rule-engine exit changed`);
      assert.ok(!('freshMix' in r));
      return;
    }
    const lag = naiveLagHours(fx, row.v.id, row.date, row.hour);
    const isFresh = lag === 1;
    if (isFresh) fresh++; else stale++;
    const want = isFresh ? model.out[i] : co.out[i];
    assert.deepEqual(comparable(r), comparable(want), `row ${i} (${row.v.id} ${row.date} ${row.hour}h, lag ${lag}): not the ${isFresh ? 'model' : 'curve_offset'} setting's answer`);
    // The labels name the side that answered.
    assert.deepEqual(r.freshMix, { answered: isFresh ? 'model' : 'curve_offset', readingLagHours: lag !== null && lag <= I.NOWCAST_MAX_LAG_HOURS ? lag : null });
    assert.equal(r.serveMode, isFresh ? 'model' : 'curve_offset');
    if (isFresh) {
      assert.ok(r.dataSourcesUsed.includes('ml_model'));
      assert.ok(!/\+curve_offset/.test(r.modelVersion));
    } else {
      assert.ok(!r.dataSourcesUsed.includes('ml_model') && !r.dataSourcesUsed.includes('weather'));
      assert.match(r.modelVersion, /\+curve_offset$/, 'a curve number carries the curve qualifier and never a nowcast one');
      assert.equal(r.nowcast, null, 'on the curve side the nowcast never has a reading it would carry');
      assert.match(crowdEngine.describeServedArithmetic(r), /^venue_pattern(_live)?$/);
    }
  });
  assert.ok(fresh >= 20 && stale >= 20, `the fixture must exercise both sides (fresh ${fresh}, not fresh ${stale})`);
  // One read of the venue's row per number, as the other switched settings make.
  const devOf = (run) => run.sql.filter((s) => /ml_venue_recent_deviation/.test(s));
  assert.equal(devOf(mix).length, devOf(model).length);
  assert.ok(devOf(mix).every((s) => /recent_readings/.test(s) && /offset_readings/.test(s)));

  // With the nowcast off the curve side is still the curve_offset setting's
  // answer; the model side is the model path with the strict offset, which
  // mlBandEval.test.js checks against the replay.
  const mixOff = await serveFixture({ CROWD_SERVE_MODE: 'model_when_fresh' });
  const coOff = await serveFixture({ CROWD_SERVE_MODE: 'curve_offset' });
  mixOff.out.forEach((r, i) => {
    if (r.predictionMethod !== 'ml') return;
    const row = fx.live[i];
    if (naiveLagHours(fx, row.v.id, row.date, row.hour) === 1) {
      assert.equal(r.serveMode, 'model');
      assert.equal(r.nowcast, null);
      assert.ok(r.dataSourcesUsed.includes('ml_model'));
    } else {
      assert.deepEqual(comparable(r), comparable(coOff.out[i]), `row ${i}: the curve side is not curve_offset's answer`);
    }
  });
});

test('model_when_fresh through predictBusyness: an hour-old reading gets the model, a two-hour-old one or the hour\'s own gets the curve', async () => {
  const mixEnv = { CROWD_SERVE_MODE: 'model_when_fresh', CROWD_NOWCAST_ENABLED: 'true' };
  const modelEnv = { CROWD_SERVE_MODE: 'model', CROWD_NOWCAST_ENABLED: 'true' };
  const coEnv = { CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' };
  // 19:00 scored after its own sweep; the newest earlier reading is 17:00.
  const twoHours = await serveFlatCurveCase(mixEnv);
  assert.deepEqual(twoHours.freshMix, { answered: 'curve_offset', readingLagHours: 2 });
  assert.equal(twoHours.score, 20, 'the flat curve, with no offset from one earlier reading');
  assert.deepEqual(comparable(twoHours), comparable(await serveFlatCurveCase(coEnv)));
  // An 18:00 reading is an hour old: the model setting's answer, whatever the artifact makes of it.
  const hourOld = [['2026-09-06', 18, 55], ['2026-09-06', 19, 100]];
  const oneHour = await serveFlatCurveCase(mixEnv, { live: hourOld });
  assert.deepEqual(oneHour.freshMix, { answered: 'model', readingLagHours: 1 });
  assert.deepEqual(comparable(oneHour), comparable(await serveFlatCurveCase(modelEnv, { live: hourOld })));
  // Read only in the hour being scored: no earlier reading, so the curve.
  const ownHour = await serveFlatCurveCase(mixEnv, { live: [['2026-09-06', 19, 100]] });
  assert.deepEqual(ownHour.freshMix, { answered: 'curve_offset', readingLagHours: null });
  assert.equal(ownHour.score, 20, 'nothing of the 19:00 reading reaches the number');
});

test('model_when_fresh across a forecast strip: each hour takes its own side, with its own source', async () => {
  // Stored as of 19:00: 0 at 17:00 and 100 at 19:00. 17:00 has no earlier
  // reading, 18:00 and 20:00 have one an hour old, 19:00 and 21:00 two hours.
  const mixEnv = { CROWD_SERVE_MODE: 'model_when_fresh', CROWD_NOWCAST_ENABLED: 'true' };
  const mix = await serveFlatCurveCase(mixEnv, { hourly: [17, 5] });
  const model = await serveFlatCurveCase({ CROWD_SERVE_MODE: 'model', CROWD_NOWCAST_ENABLED: 'true' }, { hourly: [17, 5] });
  const co = await serveFlatCurveCase({ CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' }, { hourly: [17, 5] });
  const freshHours = [false, true, false, true, false];
  assert.deepEqual(mix.map((h) => h.hour), model.map((h) => h.hour));
  mix.forEach((h, k) => {
    const want = freshHours[k] ? model[k] : co[k];
    assert.deepEqual(h, want, `${h.hour}: not the ${freshHours[k] ? 'model' : 'curve_offset'} setting's hour`);
  });
  for (const k of [0, 2, 4]) assert.match(mix[k].numberSource, /^venue_pattern(_live)?$/, `${mix[k].hour}`);
  assert.ok(mix.every((h) => typeof h.liveReadings === 'boolean'), 'a switched strip says yes or no on every hour');
  await withEnv(mixEnv, async () => {
    assert.equal(freshPredictor().predictionCoverage().serveMode, 'model_when_fresh');
    delete require.cache[PREDICTOR];
  });
});
