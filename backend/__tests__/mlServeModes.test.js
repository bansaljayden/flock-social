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
//     against numbers recorded from the code before either switch existed, with
//     the quantile map on and off. The switches off also means the offset is
//     read with exactly the statement it always was.
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

const B = require('../scripts/ml/train/bandEval');
const crowdEngine = require('../services/crowdEngine');
const FX = require('./helpers/bandEvalFixture');

const ML_DIR = path.join(__dirname, '..', 'scripts', 'ml');
const MODELS_DIR = path.join(ML_DIR, 'models');
const PREDICTOR = require.resolve('../services/mlPredictor');
const SWITCH_ENV = ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_QMAP_ENABLED'];

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

// Recorded from the fixture (helpers/bandEvalFixture.js) with the code before
// either switch existed, artifact 2.6.0-starling. Row order is the fixture's.
const GOLDEN = {
  version: '2.6.0-starling',
  ruleRows: [27, 72, 117],
  qmapDefault: {
    scores: '100,70,94,100,100,28,23,38,55,100,70,91,93,99,5,16,40,58,100,75,95,100,98,5,31,55,71,35,85,23,100,100,11,40,68,83,25,100,100,96,93,16,55,84,100,100,100,100,100,100,15,50,73,85,23,98,100,100,100,10,40,68,92,25,100,100,99,5,18,61,85,100,35,100,34,100,18,34,76,100,100,13,100,98,100,10,55,100,100,100,20,100,100,100,33,50,98,100,100,18,100,100,100,5,40,88,100,100,23,100,100,100,5,49,96,100,100,37,100,15,35,9,63,99,98,99,45,100,100,30,31,95,100,100,100',
    confidence: '36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,68,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,68,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21,36,36,68,36,21,36,36,36,36,21,36,36,36,36,21,36,36,36,36,21',
  },
  qmapOff: {
    scores: '100,53,62,78,95,34,33,39,47,100,53,59,66,91,15,28,40,48,100,55,62,77,92,17,38,46,54,35,60,33,84,100,25,42,54,59,34,76,87,91,86,28,48,57,72,98,68,80,91,100,29,45,54,60,33,65,79,89,88,25,42,52,62,35,70,79,86,20,30,51,60,70,35,79,41,100,32,40,57,68,76,27,89,97,100,23,47,67,77,87,31,82,93,100,38,45,65,75,84,30,81,91,98,18,42,61,74,83,33,83,93,80,15,45,64,76,84,37,91,29,39,26,49,69,80,89,43,100,91,37,38,63,83,94,100',
    confidence: '33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,68,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,68,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18,33,33,68,33,18,33,33,33,33,18,33,33,33,33,18,33,33,33,33,18',
  },
};

// The fixture through the real predictBusyness, with a pool answering from it
// (and offering recent readings to any statement that asks for them).
async function serveFixture(env) {
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
      return { out, sql, unknown: stub.unknown, version: art.meta.model_version };
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
  test(`both switches ${label}: every served number is the number served before the switches existed`, async () => {
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
        assert.ok(!('serveMode' in r) && !('nowcast' in r), 'a switched-off response carries no new keys');
        assert.ok(r.dataSourcesUsed.includes('ml_model'));
      }
    });
    // The offset is read with the statement it has always been read with.
    const dev = sql.filter((s) => /ml_venue_recent_deviation/.test(s));
    assert.ok(dev.length > 0);
    assert.ok(dev.every((s) => !/recent_readings/.test(s)), 'the switched-off server never asks for the readings');
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
  assert.match(I.SERVE_MEASURED_POPULATION, /2026-09-06\.\.08/);
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
  assert.ok(ml.every((r) => /^2\.6\.0-starling\+curve_offset(\+nowcast)?$/.test(r.modelVersion)));
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
  assert.ok(dev.every((s) => /recent_readings/.test(s)));
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
  // Its own statement, after the offset's, so a missing column cannot cost the offset.
  const body = src.slice(src.indexOf('async function buildRecentDeviation('));
  assert.ok(body.indexOf('UPSERT_SQL') < body.indexOf('storeLatestReadings()'));
  assert.match(src, /async function storeLatestReadings[\s\S]*catch \(err\)/);
});

test('migration 092 adds the column additively, in ASCII, and declares it', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '092_venue_recent_readings.sql'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(sql), 'ASCII only: the boot-safety server is WIN1252');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS recent_readings JSONB;/);
  assert.match(sql, /-- @requires column ml_venue_recent_deviation\.recent_readings/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(DROP|DELETE|UPDATE|NOT NULL|DEFAULT)\b/i);
});
