// ---------------------------------------------------------------------------
// TWO MORE SERVING SWITCHES: CROWD_MONTH_SUPPORT AND CROWD_ZERO_CURVE_MODEL.
//
// services/mlPredictor.js can score a vector whose month the artifact never
// trained on once per trained month and serve the mean of the three answers
// (CROWD_MONTH_SUPPORT=true), and can answer an hour whose own curve row
// blends to zero with the model at baseline 0 instead of the rule engine
// (CROWD_ZERO_CURVE_MODEL=true). Both default off. What this file pins:
//
//   * how each switch is read, including the values that must NOT turn it on;
//   * MONTH_SUPPORT against the months the served artifact was trained on;
//   * the month average itself: which rows, which slots, which arithmetic;
//   * which zero baselines the model may answer, and in which configuration;
//   * the confidence each switched number publishes and its version label;
//   * through predictBusyness on the band-replay fixture: each switch moves
//     the numbers it should and no others, the month average equals three
//     separate runs of the graph, a zero-curve hour is the model at baseline 0
//     plus the strict offset with no nowcast, and the replay
//     (scripts/ml/train/bandEval.js) publishes exactly what production does.
//
// With both off, __tests__/mlServeModes.test.js's GOLDEN values still hold.
// No database, no network. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
delete process.env.TICKETMASTER_API_KEY;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-serving-fixes';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every through-predictBusyness case here loads a fresh predictor, several
// times over; this makes the shipped graph one open (see the helper).
require('./helpers/sharedOnnxSession');
const B = require('../scripts/ml/train/bandEval');
const crowdEngine = require('../services/crowdEngine');
const FX = require('./helpers/bandEvalFixture');

const MODELS_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'models');
const META = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'model_metadata.json'), 'utf8'));
const PREDICTOR = require.resolve('../services/mlPredictor');
const SWITCH_ENV = ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_QMAP_ENABLED', 'CROWD_NO_CURVE_FALLBACK',
  'CROWD_MONTH_SUPPORT', 'CROWD_ZERO_CURVE_MODEL'];
// What production serves since 2026-11-13 (RETRAIN.md): the model, the
// nowcast on, the quantile map off.
const PRODUCTION = { CROWD_SERVE_MODE: 'model', CROWD_NOWCAST_ENABLED: 'true', CROWD_QMAP_ENABLED: 'false' };
const REPLAY_PRODUCTION = { qmap: false, serveMode: 'model', nowcast: true };

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
// THE ARTIFACT THE MONTH AVERAGE IS FOR. MONTH_SUPPORT names one artifact,
// v2.6.0-starling, which listed the month and its two angles. The shipped
// artifact, 2.8.0-starling, lists no calendar column and is not named, so the
// average has nothing in it to act on. The cases about the average itself run
// on the named artifact's shape: the shipped metadata under that version, with
// the three month names in its sorted list. While the shipped artifact is the
// named one, that shape is the shipped metadata itself.
const MONTH_ARTIFACT = '2.6.0-starling';
const MONTH_META = META.model_version === MONTH_ARTIFACT ? META : {
  ...META,
  model_version: MONTH_ARTIFACT,
  feature_names: [...new Set([...META.feature_names, 'month', 'month_sin', 'month_cos'])].sort(),
};
const NAMES = MONTH_META.feature_names;
const SLOT = { month: NAMES.indexOf('month'), sin: NAMES.indexOf('month_sin'), cos: NAMES.indexOf('month_cos') };

function vectorWithMonth(month) {
  const v = new Float32Array(NAMES.length);
  for (let j = 0; j < v.length; j++) v[j] = (j % 7) + 0.25;
  v[SLOT.month] = month;
  v[SLOT.sin] = Math.sin(2 * Math.PI * month / 12);
  v[SLOT.cos] = Math.cos(2 * Math.PI * month / 12);
  return v;
}

// ── Reading the switches ────────────────────────────────────────────────────

test("both switches are on for 'true' in any case and for nothing else", () => {
  const read = { CROWD_MONTH_SUPPORT: () => I.monthSupportEnabled(), CROWD_ZERO_CURVE_MODEL: () => I.zeroCurveModelEnabled() };
  for (const [name, on] of Object.entries(read)) {
    for (const [value, want] of [[undefined, false], ['', false], ['true', true], ['TRUE', true], [' true ', true],
      ['1', false], ['yes', false], ['on', false], ['false', false]]) {
      withEnv(value === undefined ? {} : { [name]: value }, () => assert.equal(on(), want, `${name}=${JSON.stringify(value)}`));
    }
  }
});

// ── The month average ───────────────────────────────────────────────────────

test('MONTH_SUPPORT names the months the artifact was trained on, and no artifact nobody measured', () => {
  assert.deepEqual(Object.keys(I.MONTH_SUPPORT), ['2.6.0-starling']);
  assert.deepEqual([...I.MONTH_SUPPORT['2.6.0-starling']], [3, 4, 5]);
  assert.equal(I.ZERO_CURVE_FITTED_ON, '2.6.0-starling');
  if (META.model_version === '2.6.0-starling') {
    // temp_norms is keyed "<5-degree latitude band>_<month>" over the
    // training split, so its months are the months the artifact saw.
    const trained = [...new Set(Object.keys(META.temp_norms).map((k) => Number(k.split('_')[1])))].sort((a, b) => a - b);
    assert.deepEqual(trained, [3, 4, 5]);
    assert.ok(SLOT.month >= 0 && SLOT.sin >= 0 && SLOT.cos >= 0, 'the artifact reads the month and both its angles');
  } else {
    assert.equal(I.MONTH_SUPPORT[META.model_version], undefined, 'a new artifact is averaged only once somebody measures it');
  }
});

test('monthSupportFor: the trained months for a month outside them, and nothing otherwise', () => {
  assert.ok(SLOT.month >= 0 && SLOT.sin >= 0 && SLOT.cos >= 0, 'the named artifact reads the month and both its angles');
  for (const month of [1, 6, 9, 11, 12]) {
    assert.deepEqual(I.monthSupportFor(MONTH_META, vectorWithMonth(month)), { months: I.MONTH_SUPPORT['2.6.0-starling'], slots: SLOT }, `month ${month}`);
  }
  for (const month of [3, 4, 5]) assert.equal(I.monthSupportFor(MONTH_META, vectorWithMonth(month)), null, `month ${month} was trained on`);
  assert.equal(I.monthSupportFor({ ...MONTH_META, model_version: '2.7.0-test' }, vectorWithMonth(11)), null, 'another artifact');
  assert.equal(I.monthSupportFor({ ...MONTH_META, feature_names: NAMES.filter((n) => n !== 'month') }, vectorWithMonth(11)), null, 'no month slot');
  assert.equal(I.monthSupportFor(null, vectorWithMonth(11)), null);
  assert.equal(I.monthSupportFor(MONTH_META, null), null);
  // The shipped artifact, when it is not the named one: no vector of its own
  // is averaged, in any month, and the named version alone does not make it
  // one (it has no month slot).
  if (META !== MONTH_META) {
    const shipped = new Float32Array(META.feature_names.length).fill(1.25);
    assert.equal(I.monthSupportFor(META, shipped), null, 'the shipped artifact is not named');
    assert.equal(I.monthSupportFor({ ...META, model_version: MONTH_ARTIFACT }, shipped), null, 'and has no month to average over');
  }
});

test('monthSupportBatch: one row per trained month, its month and angles as buildFeatureMap sets them, every other slot as built', async () => {
  const v = vectorWithMonth(11);
  const s = I.monthSupportFor(MONTH_META, v);
  const batch = I.monthSupportBatch(v, s);
  assert.ok(batch instanceof Float32Array);
  assert.equal(batch.length, s.months.length * v.length);
  // buildFeatureMap reads the loaded artifact's metadata.
  const quiet = [console.log, console.warn];
  console.log = () => {};
  console.warn = () => {};
  let loaded;
  try {
    loaded = freshPredictor();
    assert.equal(await loaded.init(), true);
  } finally {
    [console.log, console.warn] = quiet;
    delete require.cache[PREDICTOR];
  }
  s.months.forEach((m, k) => {
    // buildFeatureMap's own values for a timestamp in month m.
    const map = loaded._internals.buildFeatureMap({ place_id: 'p', types: ['bar'], latitude: 40.6, longitude: -75.4 },
      { temp: 60, humidity: 50, windSpeed: 3, isRaining: false, conditionId: 800 },
      new Date(Date.UTC(2026, m - 1, 10, 20)), { observed: true, hasEvent: false }, null, 40, { count: 0, mean: 0 });
    const row = batch.subarray(k * v.length, (k + 1) * v.length);
    for (let j = 0; j < v.length; j++) {
      if (j === s.slots.month) assert.equal(row[j], map.month);
      else if (j === s.slots.sin) assert.equal(row[j], Math.fround(map.month_sin));
      else if (j === s.slots.cos) assert.equal(row[j], Math.fround(map.month_cos));
      else assert.equal(row[j], v[j], `slot ${NAMES[j]} untouched`);
    }
  });
});

test('averageMonthOutputs sums in order and divides once, and hands back anything that is not a finite number', () => {
  // These three give a different double summed in another order (0.19999999999999998
  // reversed) or divided term by term (0.2), so only the measured arithmetic passes.
  assert.equal(I.averageMonthOutputs([0.1, 0.2, 0.3], 3), 0.20000000000000004);
  assert.equal(I.averageMonthOutputs(Float32Array.from([1.5, -2.25, 4]), 3), (1.5 + -2.25 + 4) / 3);
  assert.equal(I.averageMonthOutputs([1, 2, 3, 99], 3), 2, 'only the first n');
  assert.ok(Number.isNaN(I.averageMonthOutputs([1, NaN, 3], 3)));
  assert.equal(I.averageMonthOutputs([1, Infinity, 3], 3), Infinity);
  assert.equal(typeof I.averageMonthOutputs([1n, 2n, 3n], 3), 'bigint', 'an int64 head is refused, not converted');
  assert.equal(I.averageMonthOutputs([1, 2], 3), undefined, 'too few outputs');
});

test('monthSupportServes: only an artifact MONTH_SUPPORT names, in the measured configuration', () => {
  const ok = { serveMode: 'model', nowcast: true, qmapApplies: false };
  const meta = { model_version: '2.6.0-starling', label_type: 'delta' };
  assert.equal(I.monthSupportServes(meta, ok), true);
  assert.equal(I.monthSupportServes({ ...meta, model_version: '2.7.0-test' }, ok), false);
  assert.equal(I.monthSupportServes(meta, { ...ok, nowcast: false }), false, 'with the nowcast off the offset is the stored median, which no figure was measured on');
  assert.equal(I.monthSupportServes(meta, { ...ok, qmapApplies: true }), false);
  assert.equal(I.monthSupportServes(meta, { ...ok, serveMode: 'curve_offset' }), false);
  assert.equal(I.monthSupportServes(meta, { ...ok, serveMode: 'model_when_fresh' }), false);
  assert.equal(I.monthSupportServes(null, ok), false);
});

test('the month average is in the number unless a reading carried at full weight replaced it', () => {
  assert.equal(I.monthReachesNumber(true, null), true);
  assert.equal(I.monthReachesNumber(true, { weight: 0.9 }), true);
  assert.equal(I.monthReachesNumber(true, { weight: 1 }), false);
  assert.equal(I.monthReachesNumber(false, null), false);
});

// ── The zero-curve hour ─────────────────────────────────────────────────────

test('zeroCurveServes: only the measured artifact, in the measured configuration', () => {
  const ok = { serveMode: 'model', nowcast: true, qmapApplies: false };
  const meta = { model_version: '2.6.0-starling', label_type: 'delta' };
  assert.equal(I.zeroCurveServes(meta, ok), true);
  assert.equal(I.zeroCurveServes({ ...meta, model_version: '2.7.0-test' }, ok), false);
  // The November 2026 retrain was replayed on these hours before it shipped,
  // and no artifact after it has been. What serves is its own list
  // (ZERO_CURVE_ALSO_SERVES); the replay's figures (ZERO_CURVE_ALSO_MEASURED)
  // are a record of generated readings and decide nothing.
  assert.deepEqual([...I.ZERO_CURVE_ALSO_SERVES], ['2.8.0-starling']);
  assert.deepEqual(Object.keys(I.ZERO_CURVE_ALSO_MEASURED), ['2.8.0-starling']);
  assert.equal(I.zeroCurveServes({ ...meta, model_version: '2.8.0-starling' }, ok), true);
  assert.equal(I.zeroCurveServes({ ...meta, model_version: '2.8.0-starling' }, { ...ok, nowcast: false }), false);
  assert.equal(I.zeroCurveServes({ ...meta, model_version: '2.8.1-starling' }, ok), false);
  assert.equal(I.zeroCurveMeasuredOn('2.6.0-starling'), true);
  assert.equal(I.zeroCurveMeasuredOn(undefined), false);
  assert.equal(I.zeroCurveMeasuredOn('toString'), false, 'a version is looked up as an own key');
  assert.equal(I.zeroCurveServes({ ...meta, label_type: 'two_head' }, ok), false);
  assert.equal(I.zeroCurveServes(meta, { ...ok, serveMode: 'curve_offset' }), false);
  assert.equal(I.zeroCurveServes(meta, { ...ok, serveMode: 'model_when_fresh' }), false);
  assert.equal(I.zeroCurveServes(meta, { ...ok, nowcast: false }), false);
  assert.equal(I.zeroCurveServes(meta, { ...ok, qmapApplies: true }), false);
  assert.equal(I.zeroCurveServes(null, ok), false);
});

test("storedZeroSlot: the provenance of the entry this request's own lookup answered with, not refused or failed", () => {
  const row = { source: 'collected', asOf: 1, basis: 'baseline_row_written', stale: false, staleAfterMs: 1 };
  assert.equal(I.storedZeroSlot(row, 'none'), true);
  assert.equal(I.storedZeroSlot(row, undefined), true, 'the cache answered with that entry');
  assert.equal(I.storedZeroSlot(row, 'refused'), false);
  assert.equal(I.storedZeroSlot(row, 'error'), false);
  assert.equal(I.storedZeroSlot(null, 'none'), false, 'no row for the hour');
  assert.equal(I.storedZeroSlot({ ...row, basis: 'live_places_payload' }, 'none'), false, 'a popular_times answer is not the curve');
});

// ── What the numbers publish ────────────────────────────────────────────────

test('every number either switch makes publishes no measured figure: the only ones there are describe generated readings', () => {
  // The record of what each switch measured: every figure on readings of
  // 2026-10-23 or later, which the data provider generated from its own
  // weekly forecast. Kept, labelled, and read by nothing that publishes.
  const M = I.MONTH_SUPPORT_MEASURED;
  const valid = (m) => m && m.within15 > 0 && m.within15 <= 100 && Number.isInteger(m.rows) && m.rows > 0;
  assert.equal(M.readings, 'generated');
  assert.ok(valid(M.model) && valid(M.zeroCurve.monthSupport) && valid(M.zeroCurve.asBuilt));
  assert.match(I.MONTH_SUPPORT_POPULATION, /2026-10-23\.\.11-05/);
  assert.match(I.MONTH_SUPPORT_POPULATION, /generated by the data provider from its own weekly forecast/);
  assert.doesNotMatch(I.MONTH_SUPPORT_POPULATION, /\blive readings\b/);
  const Z = I.ZERO_CURVE_ALSO_MEASURED['2.8.0-starling'];
  assert.ok(valid(Z) && Z.readings === 'generated' && /2026-11-12\.\.11-25/.test(Z.population));
  assert.doesNotMatch(Z.population, /\blive readings\b/);

  const accuracy = { status: 'measured', percent: 33.3, metric: 'within_15', population: 'realtime_served', rows: 1 };
  const ladder = () => 70;
  const conf = (o) => I.servedConfidence({ accuracy, qmapApplied: false, hasWeather: true, curveOffset: false, nowcast: null, ladder, ...o });
  const UNMEASURED = {
    status: 'unmeasured', means: 'input_completeness', metric: 'venue_metadata_completeness',
    population: null, populationRows: null, measuredPercent: null, weatherPenalty: 0,
  };
  // The month average in the number, alone or under a reading blended in at
  // less than full weight, and a zero-curve hour with or without it, under
  // every version: the ladder, and a block that says so. No weather penalty:
  // the ladder prices a missing reading itself.
  const blended = (b) => ({ base: 'model', bucket: b, weight: I.NOWCAST_WEIGHTS.model[b] });
  for (const version of [undefined, '2.6.0-starling', '2.8.0-starling', '2.9.0-test']) {
    for (const o of [
      { monthSupport: true }, { monthSupport: true, hasWeather: false },
      { monthSupport: true, nowcast: blended(2) }, { monthSupport: true, nowcast: blended(3) },
      { zeroCurve: true }, { zeroCurve: true, monthSupport: true }, { zeroCurve: true, hasWeather: false },
    ]) {
      const got = conf({ ...o, version });
      assert.deepEqual(got.confidenceMeasurement, UNMEASURED, `${version} ${JSON.stringify(o)}`);
      assert.equal(got.confidence, 70, `${version} ${JSON.stringify(o)}: the ladder`);
    }
  }
  // A reading carried at full weight replaces the month average entirely
  // (monthReachesNumber says false), so the figure is the nowcast's own,
  // measured in September on real readings, exactly as before.
  const lag1 = conf({ monthSupport: false, nowcast: { base: 'model', bucket: 1, weight: 1 } });
  assert.equal(lag1.confidenceMeasurement.metric, 'within_15_nowcast_model_lag1');
  assert.equal(lag1.confidenceMeasurement.population, I.SERVE_MEASURED_POPULATION);
  // Neither switch: the artifact's own figure, as before, for a version the
  // real-readings table does not name; that table's figure for one it does.
  assert.equal(conf({}).confidenceMeasurement.metric, 'within_15');
  assert.equal(conf({ version: '2.9.0-test' }).confidenceMeasurement.metric, 'within_15');
  assert.equal(conf({ version: '2.8.0-starling' }).confidenceMeasurement.metric, 'within_15_real_readings');
});

test('the version a number carries names the month average and the zero-curve hour when they made it', () => {
  const v = '2.6.0-starling';
  assert.equal(I.servedModelVersion(v, false, null), v);
  assert.equal(I.servedModelVersion(v, false, null, { monthSupport: true }), `${v}+month_support`);
  assert.equal(I.servedModelVersion(v, false, { bucket: 2 }, { monthSupport: true }), `${v}+month_support+nowcast`);
  assert.equal(I.servedModelVersion(v, false, null, { monthSupport: true, zeroCurve: true }), `${v}+month_support+zero_curve`);
  assert.equal(I.servedModelVersion(v, false, null, { zeroCurve: true }), `${v}+zero_curve`);
  assert.equal(I.servedModelVersion(v, true, { bucket: 1 }), `${v}+curve_offset+nowcast`, 'unchanged for the other switches');
});

// ── Through predictBusyness and the replay ─────────────────────────────────

// Runs predictBusyness over every prepared row under one environment, against
// a pool answering from the fixture as of each row's serve moment (the same
// harness as __tests__/mlBandEval.test.js).
async function runProduction(fx, prepared, env, poolOptions = {}) {
  const pool = require('../config/database');
  const moments = new Map();
  const stub = FX.makeFixturePool(fx, (alias) => moments.get(alias), poolOptions);
  const realQuery = pool.query;
  pool.query = stub.query;
  const quiet = [console.log, console.warn, console.error];
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await withEnv(env, async () => {
      const predictor = freshPredictor();
      assert.equal(await predictor.init(), true);
      const out = [];
      for (let i = 0; i < prepared.length; i++) {
        const r = prepared[i];
        const alias = `ChIJservingfixes_${r.venueId}_${i}`;
        moments.set(alias, { venueId: Number(r.venueId), date: r.date, hour: r.hour });
        out.push(await predictor.predictBusyness({ ...r.venue, place_id: alias }, r.weather, r.ts));
      }
      assert.deepEqual(stub.unknown, [], 'predictBusyness asked the pool something the fixture does not answer');
      return out;
    });
  } finally {
    [console.log, console.warn, console.error] = quiet;
    delete require.cache[PREDICTOR];
    pool.query = realQuery;
  }
}

function mismatchesOf(production, replay) {
  const bad = [];
  production.forEach((p, i) => {
    const q = replay.rows[i];
    if (p.score !== q.served || (p.predictionMethod === 'ml') !== q.ml
      || p.confidence !== q.confidence || (p.modelVersion || null) !== (q.modelVersion || null)) {
      bad.push({ i, production: [p.score, p.predictionMethod, p.confidence, p.modelVersion], replay: [q.served, q.ml, q.confidence, q.modelVersion] });
    }
  });
  return bad;
}

// The fixture, optionally with hours whose own rows say zero beside
// neighbours that say zero: venue 101 at 09:00-11:00 and venue 102 at
// 18:00-20:00, so 10:00 and 19:00 blend to zero and are read live on every
// date. The shared fixture itself is never changed (mlServeModes' GOLDEN
// values are recorded on it).
function fixture({ zeroHours = false } = {}) {
  const fx = FX.buildFixture();
  if (zeroHours) {
    const zero = { 101: [9, 10, 11], 102: [18, 19, 20] };
    for (const [id, hours] of Object.entries(zero)) {
      const c = fx.curves.get(id);
      for (let dow = 0; dow < 7; dow++) for (const h of hours) c[dow * 24 + h] = 0;
    }
    for (const w of fx.weekly) if (zero[w.v.id] && zero[w.v.id].includes(w.hour)) w.val = 0;
  }
  return fx;
}

async function replaySetup(fx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-servingfixes-'));
  try {
    const csv = path.join(dir, 'fixture.csv');
    FX.writeFixtureCsv(csv, fx);
    B.pinUtcClock();
    const corpus = await B.readCorpus([csv]);
    const art = await B.loadArtifact(MODELS_DIR);
    const prepared = B.prepareRows(corpus.live, corpus, { I: art.I, crowdEngine });
    return { art, prepared };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The graph, run once per row per month with nothing shared with the serving
// code but the session: the mean the month average should equal.
async function independentMonthMean(art, vector) {
  const ort = require('onnxruntime-node');
  const inputName = art.meta.onnx_input_name || 'input';
  let sum = 0;
  for (const m of [3, 4, 5]) {
    const v = Float32Array.from(vector);
    v[SLOT.month] = m;
    v[SLOT.sin] = Math.sin(2 * Math.PI * m / 12);
    v[SLOT.cos] = Math.cos(2 * Math.PI * m / 12);
    const res = await art.session.run({ [inputName]: new ort.Tensor('float32', v, [1, v.length]) });
    sum += Number(res[art.session.outputNames[0]].data[0]);
  }
  return sum / 3;
}

test('month average on: each model number is the mean of three runs of the graph, and the replay publishes what production does', async () => {
  const fx = fixture();
  const { art, prepared } = await replaySetup(fx);
  if (art.meta.model_version !== '2.6.0-starling') {
    // MONTH_SUPPORT names no other artifact, and the shipped one reads no
    // month. So under it the switch must change nothing in the very
    // configuration it was measured in: the same numbers, versions and
    // confidence figures, in production and in the replay.
    assert.equal(art.I.MONTH_SUPPORT[art.meta.model_version], undefined);
    const same = (rows) => JSON.parse(JSON.stringify(rows, (k, v) => (k === 'asOf' ? undefined : v)));
    const without = await runProduction(fx, prepared, PRODUCTION, { leakyOffset: true });
    const withIt = await runProduction(fx, prepared, { ...PRODUCTION, CROWD_MONTH_SUPPORT: 'true' }, { leakyOffset: true });
    assert.deepEqual(same(withIt), same(without), 'the month switch moved a number under an artifact it does not name');
    assert.ok(withIt.filter((a) => a.predictionMethod === 'ml').length >= 60, 'the model must have answered these rows');
    assert.ok(withIt.every((a) => !/month_support/.test(String(a.modelVersion))));
    const replayOff = await B.scoreArtifact(art, prepared, { ...REPLAY_PRODUCTION, monthSupport: false, zeroCurve: false });
    const replayOn = await B.scoreArtifact(art, prepared, { ...REPLAY_PRODUCTION, monthSupport: true, zeroCurve: false });
    assert.equal(replayOn.monthSupport, false);
    assert.deepEqual(same(replayOn.rows), same(replayOff.rows));
    assert.deepEqual(mismatchesOf(withIt, replayOn), [], 'the replay must publish exactly what production publishes');
    return;
  }
  assert.ok(prepared.every((r) => r.ts.getUTCMonth() + 1 === 9), 'the fixture is dated September, outside the trained months');
  const off = await B.scoreArtifact(art, prepared, { ...REPLAY_PRODUCTION, monthSupport: false, zeroCurve: false });
  const on = await B.scoreArtifact(art, prepared, { ...REPLAY_PRODUCTION, monthSupport: true, zeroCurve: false });
  const production = await runProduction(fx, prepared, { ...PRODUCTION, CROWD_MONTH_SUPPORT: 'true' }, { leakyOffset: true });
  assert.deepEqual(mismatchesOf(production, on), [], 'the replay must publish exactly what production publishes');

  const ml = on.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.ml);
  assert.ok(ml.length >= 60, `only ${ml.length} rows reached the model`);
  let moved = 0;
  let carried = 0;
  for (const { r, i } of ml) {
    const p = prepared[i];
    const vector = art.I.buildFeatureVector(p.venue, p.weather, p.ts, p.events, null, p.smoothed, p.neighbors, { live: p.live, sports: null });
    const mean = await independentMonthMean(art, vector);
    assert.ok(Math.abs(r.rawDelta - mean) < 1e-4, `row ${i}: ${r.rawDelta} against three runs' mean ${mean}`);
    if (r.nowcast && r.nowcast.weight >= 1) {
      // The reading replaced the model's number: same number, no qualifier.
      carried++;
      assert.equal(r.served, off.rows[i].served);
      assert.equal(production[i].modelVersion, '2.6.0-starling+nowcast');
    } else {
      assert.match(production[i].modelVersion, /^2\.6\.0-starling\+month_support(\+nowcast)?$/);
      // Its only figures describe generated readings (SWITCHED_UNMEASURED).
      assert.equal(production[i].confidenceMeasurement.status, 'unmeasured');
      if (r.served !== off.rows[i].served) moved++;
    }
  }
  assert.ok(carried >= 5 && moved >= 20, `the switch must move numbers here (${moved} moved, ${carried} carried)`);
  // The rule-engine rows stay the rule engine's.
  on.rows.forEach((r, i) => { if (!r.ml) assert.equal(production[i].predictionMethod, 'rule_engine_no_baseline'); });
});

test('month average on: nothing moves outside the configuration it was measured in, in production or the replay', async () => {
  const fx = fixture();
  const { art, prepared } = await replaySetup(fx);
  const comparable = (rows) => JSON.parse(JSON.stringify(rows, (k, v) => (k === 'asOf' ? undefined : v)));
  for (const [env, cfg] of [
    [{ CROWD_NOWCAST_ENABLED: 'true' }, { serveMode: 'model', nowcast: true, qmap: true }],            // quantile map on (the default)
    [{}, { serveMode: 'model', nowcast: false, qmap: true }],                                        // every switch off, map on
    [{ CROWD_SERVE_MODE: 'model', CROWD_QMAP_ENABLED: 'false' }, { serveMode: 'model', nowcast: false, qmap: false }], // nowcast off: the stored median
    [{ CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true', CROWD_QMAP_ENABLED: 'false' }, { serveMode: 'curve_offset', nowcast: true, qmap: false }],
    [{ CROWD_SERVE_MODE: 'model_when_fresh', CROWD_NOWCAST_ENABLED: 'true', CROWD_QMAP_ENABLED: 'false' }, { serveMode: 'model_when_fresh', nowcast: true, qmap: false }],
  ]) {
    const leaky = cfg.nowcast || cfg.serveMode !== 'model';
    const without = await runProduction(fx, prepared, env, { leakyOffset: leaky });
    const withIt = await runProduction(fx, prepared, { ...env, CROWD_MONTH_SUPPORT: 'true' }, { leakyOffset: leaky });
    assert.deepEqual(comparable(withIt), comparable(without), JSON.stringify(env));
    const replayWithout = await B.scoreArtifact(art, prepared, { ...cfg, monthSupport: false, zeroCurve: false });
    const replayWith = await B.scoreArtifact(art, prepared, { ...cfg, monthSupport: true, zeroCurve: false });
    assert.deepEqual(comparable(replayWith.rows), comparable(replayWithout.rows), `replay ${JSON.stringify(cfg)}`);
  }
});

test("zero-curve hours: the model at baseline 0 plus the strict offset, no nowcast, only where the hour's own row is zero", async () => {
  const fx = fixture({ zeroHours: true });
  const { art, prepared } = await replaySetup(fx);
  const version = art.meta.model_version;
  // The shipped artifact must be one these hours were replayed under, or it
  // hands them back to the rule engine without anyone deciding that. A
  // retrain is replayed and added to ZERO_CURVE_ALSO_SERVES before it ships.
  // (Those replays ran on readings the data provider generated from its own
  // weekly forecast, so whether the switch should serve at all is a separate
  // decision; this test pins that it serves as it did.)
  assert.ok(art.I.zeroCurveMeasuredOn(version), `${version} has no zero-curve replay`);
  // An artifact that takes the offset as an input gets none after it, and
  // only an artifact MONTH_SUPPORT names has a month average to combine.
  const learnsOffset = art.I.artifactLearnsOffset(art.meta);
  const months = art.I.MONTH_SUPPORT[version] ? [false, true] : [false];
  const zeroIdx = prepared.map((r, i) => (r.smoothed === 0 && r.rawCurve === 0 ? i : -1)).filter((i) => i >= 0);
  const noRowIdx = prepared.map((r, i) => (r.rawCurve === null ? i : -1)).filter((i) => i >= 0);
  assert.ok(zeroIdx.length >= 6, `the variant must hold zero-curve readings (${zeroIdx.length})`);
  assert.ok(noRowIdx.length >= 3, 'and readings of an hour with no row at all');
  const before = await runProduction(fx, prepared, PRODUCTION, { leakyOffset: true });
  for (const month of months) {
    const env = { ...PRODUCTION, CROWD_ZERO_CURVE_MODEL: 'true', ...(month ? { CROWD_MONTH_SUPPORT: 'true' } : {}) };
    const production = await runProduction(fx, prepared, env, { leakyOffset: true });
    const replay = await B.scoreArtifact(art, prepared, { ...REPLAY_PRODUCTION, monthSupport: month, zeroCurve: true });
    assert.deepEqual(mismatchesOf(production, replay), [], `month ${month}: the replay must publish exactly what production publishes`);
    let withOffset = 0;
    for (const i of zeroIdx) {
      const p = prepared[i];
      const answer = production[i];
      assert.equal(before[i].predictionMethod, 'rule_engine_no_baseline', 'the rule engine answered it before');
      assert.equal(answer.predictionMethod, 'ml');
      assert.equal(answer.modelVersion, `${version}${month ? '+month_support' : ''}+zero_curve`);
      assert.equal(answer.nowcast, null, 'no nowcast on a zero-curve hour');
      assert.equal(answer.baselineScore, null);
      // Its only figures describe generated readings, so it publishes none:
      // the venue's input-completeness ladder, the rule engine's own figure
      // for it, which is what this hour carried before the switch.
      assert.equal(answer.confidenceMeasurement.status, 'unmeasured');
      assert.equal(answer.confidenceMeasurement.means, 'input_completeness');
      assert.equal(answer.confidenceMeasurement.population, null);
      assert.equal(answer.confidence, crowdEngine.calculateCrowdScore(p.venue, p.weather, p.ts).confidence);
      // Restated: the graph at baseline 0, then DEVIATION_WEIGHT times the
      // strict offset, clamped and rounded; for an artifact that reads the
      // offset as an input, the graph at baseline 0 and nothing after it.
      const vector = art.I.buildFeatureVector(p.venue, p.weather, p.ts, p.events, null, 0, p.neighbors,
        { live: p.live, sports: prepared.sports === undefined ? null : prepared.sports });
      const ort = require('onnxruntime-node');
      const raw = month
        ? await independentMonthMean(art, vector)
        : Number((await art.session.run({ [art.meta.onnx_input_name || 'input']: new ort.Tensor('float32', vector, [1, vector.length]) }))[art.session.outputNames[0]].data[0]);
      let want = art.I.reconstructScore(raw, 0);
      if (p.switchedOffset !== null) {
        withOffset++;
        if (!learnsOffset) want = Math.max(0, Math.min(100, Math.round(want + art.I.DEVIATION_WEIGHT * p.switchedOffset)));
      }
      assert.equal(answer.score, want, `row ${i}`);
    }
    assert.ok(withOffset >= 2, `some zero-curve readings must carry an offset (${withOffset})`);
    for (const i of noRowIdx) assert.equal(production[i].predictionMethod, 'rule_engine_no_baseline', 'no row: the rule engine, as before');
    // Every other number is what it was (month off) or the month average's.
    production.forEach((a, i) => {
      if (zeroIdx.includes(i)) return;
      if (!month) assert.equal(a.score, before[i].score, `row ${i} moved without being a zero-curve hour`);
    });
  }
});

test('a zero-curve hour whose earlier lookup failed, answered since by a whole-curve read, is still the model\'s', async () => {
  const fx = fixture({ zeroHours: true });
  const { prepared } = await replaySetup(fx);
  const r = prepared.find((p) => p.smoothed === 0 && p.rawCurve === 0);
  assert.ok(r, 'the variant holds a zero-curve reading');
  const alias = 'ChIJservingfixes_stale_marker';
  const stub = FX.makeFixturePool(fx, () => ({ venueId: Number(r.venueId), date: r.date, hour: r.hour }), { leakyOffset: true });
  const pool = require('../config/database');
  const realQuery = pool.query;
  let failSlots = true;
  pool.query = (text, params) => {
    if (failSlots && /FROM ml_venue_baselines WHERE google_place_id = \$1 AND/.test(String(text).replace(/\s+/g, ' '))) {
      return Promise.reject(new Error('connection reset'));
    }
    return stub.query(text, params);
  };
  const quiet = [console.log, console.warn, console.error];
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    await withEnv({ ...PRODUCTION, CROWD_ZERO_CURVE_MODEL: 'true' }, async () => {
      const predictor = freshPredictor();
      assert.equal(await predictor.init(), true);
      // The switch serves only beside the artifact it was measured on
      // (ZERO_CURVE_FITTED_ON), which the shipped one is no longer. What this
      // case pins is the lookup's bookkeeping, so the loaded artifact carries
      // that version for the length of it.
      predictor._internals.getMetadata().model_version = predictor._internals.ZERO_CURVE_FITTED_ON;
      const venue = { ...r.venue, place_id: alias };
      const failed = await predictor.predictBusyness(venue, r.weather, r.ts);
      assert.equal(failed.predictionMethod, 'rule_engine_baseline_error', 'a lookup that failed never read the row');
      // The venue's whole curve, read since, as the strip's primeVenueCurve
      // reads it: the slot is answered now, while the failure's marker stays.
      failSlots = false;
      const c = fx.curves.get(String(r.venueId));
      const rows = [];
      for (let s = 0; s < 168; s++) {
        if (c[s] >= 0) rows.push({ day_of_week: Math.floor(s / 24), hour: s % 24, baseline: String(c[s]), source: 'collected', updated_at: new Date() });
      }
      assert.ok(predictor.primeBaselineCache(alias, rows) > 0);
      assert.equal(predictor._internals.baselineMissFor(alias, r.ts.getDay(), r.ts.getHours()), 'error', 'the marker outlives the read');
      const answered = await predictor.predictBusyness(venue, r.weather, r.ts);
      assert.equal(answered.predictionMethod, 'ml');
      assert.match(answered.modelVersion, /\+zero_curve$/);
    });
  } finally {
    [console.log, console.warn, console.error] = quiet;
    delete require.cache[PREDICTOR];
    pool.query = realQuery;
  }
});

test('a zero from a lookup that found no row stays the rule engine\'s, though another request primes the slot meanwhile', async () => {
  const fx = fixture();
  const { prepared } = await replaySetup(fx);
  const r = prepared.find((p) => p.rawCurve === null);
  assert.ok(r, 'the fixture holds a reading of an hour with no row (venue 104 at 03:00)');
  const alias = 'ChIJservingfixes_race';
  const stub = FX.makeFixturePool(fx, () => ({ venueId: Number(r.venueId), date: r.date, hour: r.hour }), { leakyOffset: true });
  const pool = require('../config/database');
  const realQuery = pool.query;
  let predictor;
  let primed = 0;
  pool.query = (text, params) => {
    const sql = String(text).replace(/\s+/g, ' ');
    const answer = stub.query(text, params);
    if (/v\.latitude BETWEEN/.test(sql) && /GROUP BY b\.day_of_week, b\.hour/.test(sql)) {
      // While this request's neighbour lookup is in flight (its baseline
      // lookup has already answered zero), another request's whole-curve
      // read primes the same slot with a positive baseline.
      return new Promise((resolve) => setTimeout(() => {
        const rows = [];
        for (let h = 0; h < 24; h++) rows.push({ day_of_week: r.dow, hour: h, baseline: '80', source: 'collected', updated_at: new Date() });
        primed = predictor.primeBaselineCache(alias, rows);
        resolve(answer);
      }, 20));
    }
    return answer;
  };
  const quiet = [console.log, console.warn, console.error];
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    await withEnv({ ...PRODUCTION, CROWD_ZERO_CURVE_MODEL: 'true' }, async () => {
      predictor = freshPredictor();
      assert.equal(await predictor.init(), true);
      // Under the version the switch serves beside, as in the case above, so
      // the rule engine's answer below is the bookkeeping's doing and not the
      // switch standing aside for another artifact.
      predictor._internals.getMetadata().model_version = predictor._internals.ZERO_CURVE_FITTED_ON;
      const answer = await predictor.predictBusyness({ ...r.venue, place_id: alias }, r.weather, r.ts);
      assert.ok(primed > 0, 'the slot was primed while the request was in flight');
      assert.equal(predictor._internals.baselineProvenanceFor(alias, r.ts.getDay(), r.ts.getHours()).basis, 'baseline_row_written',
        "the cache holds the other request's row by the time the lookups finish");
      assert.equal(answer.predictionMethod, 'rule_engine_no_baseline', 'the zero this request got had no row behind it');
    });
  } finally {
    [console.log, console.warn, console.error] = quiet;
    delete require.cache[PREDICTOR];
    pool.query = realQuery;
  }
});

test('bandEval --fit fits on the arithmetic as shipped, whatever the two switches say', async () => {
  // The fit restates one model base for every serving configuration, and the
  // month average serves only model+nowcast, so under --fit both switches are
  // set aside; with them honoured the check inside --fit refused the run.
  const fx = fixture({ zeroHours: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-servingfixes-fit-'));
  const csv = path.join(dir, 'fixture.csv');
  FX.writeFixtureCsv(csv, fx);
  // A schedule with no games: the shipped artifact reads the sports features,
  // and a clean checkout has no train/sports_events.csv. And the window, named:
  // a report's default starts the day after the scored artifact's live
  // training data ended, which for the shipped one is after this fixture.
  const sportsCsv = path.join(dir, 'sports_events.csv');
  fs.writeFileSync(sportsCsv, 'is_home,event_local_date,event_local_time,venue_lat,venue_lon\n');
  const fit = async (env, name) => {
    const out = path.join(dir, `${name}.json`);
    await withEnv(env, async () => {
      const quiet = console.log;
      console.log = () => {};
      try {
        await B.main([`--train=${csv}`, '--holdout=-', `--model=${MODELS_DIR}`, `--sports=${sportsCsv}`, `--from=${FX.DATES[0]}`, '--fit', '--qmap=false', '--score-from=2026-09-06', `--out=${out}`]);
      } finally {
        console.log = quiet;
      }
    });
    return JSON.parse(fs.readFileSync(out, 'utf8')).fit;
  };
  try {
    const shipped = await fit(PRODUCTION, 'shipped');
    const switched = await fit({ ...PRODUCTION, CROWD_MONTH_SUPPORT: 'true', CROWD_ZERO_CURVE_MODEL: 'true' }, 'switched');
    assert.ok(shipped && shipped.scored_rows > 0);
    assert.deepEqual(switched, shipped);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zero-curve switch on: nothing moves outside the configuration it was measured in', async () => {
  const fx = fixture({ zeroHours: true });
  const { prepared } = await replaySetup(fx);
  const comparable = (rows) => JSON.parse(JSON.stringify(rows, (k, v) => (k === 'asOf' ? undefined : v)));
  for (const env of [
    { CROWD_SERVE_MODE: 'model', CROWD_QMAP_ENABLED: 'false' },                           // nowcast off
    { CROWD_NOWCAST_ENABLED: 'true' },                                                     // quantile map on
    { CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true', CROWD_QMAP_ENABLED: 'false' },
    { CROWD_SERVE_MODE: 'model_when_fresh', CROWD_NOWCAST_ENABLED: 'true', CROWD_QMAP_ENABLED: 'false' },
  ]) {
    const leaky = env.CROWD_NOWCAST_ENABLED === 'true' || (env.CROWD_SERVE_MODE && env.CROWD_SERVE_MODE !== 'model');
    const without = await runProduction(fx, prepared, env, { leakyOffset: leaky });
    const withIt = await runProduction(fx, prepared, { ...env, CROWD_ZERO_CURVE_MODEL: 'true' }, { leakyOffset: leaky });
    // The quantile map is one artifact's table (QMAP_FITTED_ON). Left on under
    // any other artifact it reshapes no number, so "map on" is then the
    // measured configuration itself (model mode, the nowcast on, no map in
    // the number) and the zero-curve hours are the model's there as well.
    const mapOnly = !env.CROWD_SERVE_MODE && !env.CROWD_QMAP_ENABLED && env.CROWD_NOWCAST_ENABLED === 'true';
    if (mapOnly && META.model_version !== I.QMAP_FITTED_ON && I.zeroCurveMeasuredOn(META.model_version)) {
      const zeroIdx = prepared.map((r, i) => (r.smoothed === 0 && r.rawCurve === 0 ? i : -1)).filter((i) => i >= 0);
      assert.ok(zeroIdx.length >= 6);
      withIt.forEach((a, i) => {
        if (zeroIdx.includes(i)) {
          assert.equal(without[i].predictionMethod, 'rule_engine_no_baseline');
          assert.equal(a.predictionMethod, 'ml');
          assert.equal(a.modelVersion, `${META.model_version}+zero_curve`);
        } else {
          assert.deepEqual(comparable([a]), comparable([without[i]]), `row ${i} moved without being a zero-curve hour`);
        }
      });
      continue;
    }
    assert.deepEqual(comparable(withIt), comparable(without), JSON.stringify(env));
  }
});
