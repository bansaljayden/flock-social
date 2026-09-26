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
        assert.ok(!('serveMode' in r) && !('nowcast' in r) && !('offsetChangedBySwitch' in r)
          && !('usedLiveReadings' in r),
          'a switched-off response carries no new keys');
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
// replay serves 3 (no offset from a single earlier reading, then the 17:00
// reading blended in at the two-hour weight); reading the stored median would
// serve 7, a number moved by the reading it is scored against.
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
  assert.equal(on.nowcast.lagHours, 2);
  assert.equal(on.score, Math.round(20 + I.NOWCAST_WEIGHTS.curve_offset[2] * (0 - 20)));
  assert.equal(on.score, 3);
  // curve_offset alone: the curve, with no offset from the 19:00 reading.
  const co = await serveFlatCurveCase({ CROWD_SERVE_MODE: 'curve_offset' });
  assert.equal(co.score, 20);
  assert.equal(co.recentDeviation, null);
});

test('with both switches off the stored median is served as before, the hour\'s own reading included (unchanged, pre-existing)', async () => {
  const off = await serveFlatCurveCase({});
  assert.equal(off.predictionMethod, 'ml');
  // median(0 - 20, 100 - 20) = 30: the stored offset, exactly as it was read
  // before the switches existed.
  assert.equal(off.recentDeviation.offset, 30);
  assert.equal(off.recentDeviation.weight, I.DEVIATION_WEIGHT);
  assert.ok(!('serveMode' in off) && !('nowcast' in off));
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
  const mn = await serveFixture({ CROWD_NOWCAST_ENABLED: 'true' });
  const withReading = mn.out.filter((r) => r.nowcast);
  assert.ok(withReading.length > 0);
  assert.ok(withReading.some((r) => carried(r)), 'the fixture carries a reading at full weight somewhere');
  assert.ok(withReading.every((r) => describeServedArithmetic(r) === (carried(r) || 'model_live')));
  for (const r of mn.out.filter((x) => x.predictionMethod === 'ml' && !x.nowcast)) {
    assert.equal(typeof r.offsetChangedBySwitch, 'boolean');
    const want = r.offsetChangedBySwitch ? (r.recentDeviation ? 'model_live' : 'model_alone') : null;
    assert.equal(describeServedArithmetic(r), want);
    assert.equal(r.usedLiveReadings, Boolean(r.recentDeviation));
  }
  // Somewhere on the fixture a live offset reached the number while the
  // switch changed nothing, so no source is named and the yes is the only
  // account of it.
  assert.ok(mn.out.some((r) => r.predictionMethod === 'ml' && describeServedArithmetic(r) === null && r.usedLiveReadings === true),
    'the fixture has an hour whose live offset matched the stored one');
  for (const r of mn.out.filter((x) => x.predictionMethod === 'ml' && x.nowcast)) assert.equal(r.usedLiveReadings, true);
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

test('through predictBusyness, a reading carried at full weight IS the number, and says so', async () => {
  // Nowcast only, model mode: the 17:00 reading of 0 is two hours old at
  // 19:00, and model_qmap carries a two-hour reading at weight 1.
  const two = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' });
  assert.equal(two.nowcast.weight, 1);
  assert.equal(two.nowcast.lagHours, 2);
  assert.equal(two.score, 0, 'the number is the reading');
  assert.equal(crowdEngine.describeServedArithmetic(two), 'live_reading_2h');
  // A reading an hour old.
  const one = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live: [['2026-09-06', 18, 55], ['2026-09-06', 19, 100]] });
  assert.equal(one.score, 55);
  assert.equal(crowdEngine.describeServedArithmetic(one), 'live_reading_1h');
});

test('a switch that changes only the offset is attributed, even with no nowcast reading', async () => {
  // Flat curve 20. Yesterday's readings are too old for the nowcast (over
  // NOWCAST_MAX_LAG_HOURS) but inside the offset's window. Strictly before
  // 19:00 the median deviation is -20; the stored median, which includes
  // 19:00's own reading of 100, is 0.
  const live = [['2026-09-05', 10, 0], ['2026-09-05', 11, 0], ['2026-09-05', 12, 40], ['2026-09-06', 19, 100]];
  const off = await serveFlatCurveCase({}, { live });
  assert.equal(off.recentDeviation.offset, 0);
  assert.ok(!('offsetChangedBySwitch' in off));
  assert.equal(crowdEngine.describeServedArithmetic(off), null);
  const on = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live });
  assert.equal(on.nowcast, null, 'no reading the nowcast may use');
  assert.equal(on.recentDeviation.offset, -20);
  assert.notEqual(on.score, off.score, 'the switch changed the number');
  assert.equal(on.offsetChangedBySwitch, true);
  assert.equal(crowdEngine.describeServedArithmetic(on), 'model_live');

  // A stored offset and no strict one (one earlier reading is under the
  // floor): the switched number is the model's with no live readings in it.
  const lone = [['2026-09-05', 11, 0], ['2026-09-06', 19, 100]];
  const offLone = await serveFlatCurveCase({}, { live: lone });
  assert.equal(offLone.recentDeviation.offset, 30);
  const onLone = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live: lone });
  assert.equal(onLone.nowcast, null);
  assert.equal(onLone.recentDeviation, null);
  assert.equal(onLone.offsetChangedBySwitch, true);
  assert.notEqual(onLone.score, offLone.score);
  assert.equal(crowdEngine.describeServedArithmetic(onLone), 'model_alone');

  // Where the strict and stored offsets agree, the switch changed nothing and
  // nothing is claimed.
  const same = [['2026-09-05', 10, 0], ['2026-09-05', 11, 0], ['2026-09-06', 19, 0]];
  const onSame = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live: same });
  assert.equal(onSame.nowcast, null);
  assert.equal(onSame.offsetChangedBySwitch, false);
  assert.equal(crowdEngine.describeServedArithmetic(onSame), null);
  // Nothing is claimed about the arithmetic, yet live readings are in this
  // number: the strict offset of the two readings moved it. Said as a yes.
  assert.ok(onSame.recentDeviation, 'a live offset was applied');
  assert.equal(onSame.usedLiveReadings, true);
  assert.equal(onLone.usedLiveReadings, false, 'no offset and no reading: a no');
  assert.equal(on.usedLiveReadings, true);
  assert.ok(!('usedLiveReadings' in off));
});

test('each forecast hour says yes or no to live readings, including an hour no source is named for', async () => {
  // Readings too old for the nowcast but inside the offset window, and 19:00's
  // own reading. At 18:00 and 19:00 the strict offset (the two 2026-09-05
  // readings) lands on the stored offset's score, so no source is named, and
  // a live offset is still in the number. At 20:00 the 19:00 reading is an
  // hour old and carried.
  const same = [['2026-09-05', 10, 0], ['2026-09-05', 11, 0], ['2026-09-06', 19, 0]];
  const on = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { live: same, hourly: [18, 3] });
  assert.deepEqual(on.map((h) => h.numberSource || null), [null, null, 'live_reading_1h']);
  assert.deepEqual(on.map((h) => h.liveReadings), [true, true, true],
    'a missing source is not a missing live reading');
  // Switched off, no hour carries the yes or no.
  const off = await serveFlatCurveCase({}, { live: same, hourly: [18, 3] });
  for (const h of off) assert.ok(!('liveReadings' in h) && !('numberSource' in h), h.hour);
  assert.deepEqual(off.map((h) => h.score), on.slice(0, 2).map((h) => h.score).concat(off[2].score),
    'where no source is named the number is the switched-off number');
});

test('each forecast hour carries its own source, and a switched-off hour carries none', async () => {
  const OFF_KEYS = ['baselineScore', 'eventsObserved', 'eventsUnavailableReason', 'hour', 'label', 'predictionMethod', 'score'];
  const off = await serveFlatCurveCase({}, { hourly: [17, 5] });
  assert.equal(off.length, 5);
  for (const h of off) assert.deepEqual(Object.keys(h).sort(), OFF_KEYS, h.hour);
  // The stored readings as of 19:00 are 0 at 17:00 and 100 at 19:00. At 17:00
  // nothing earlier exists, so there is no reading to carry and no strict
  // offset, where the stored median would have added one: the model alone.
  // 18:00 and 19:00 carry the 17:00 reading, 20:00 and 21:00 the 19:00 one.
  const on = await serveFlatCurveCase({ CROWD_NOWCAST_ENABLED: 'true' }, { hourly: [17, 5] });
  const sources = on.map((h) => h.numberSource || null);
  assert.deepEqual(sources, ['model_alone', 'live_reading_1h', 'live_reading_2h', 'live_reading_1h', 'live_reading_2h']);
  // Each carried hour's number is the reading it names.
  assert.deepEqual(on.slice(1).map((h) => h.score), [0, 0, 100, 100]);
  // Every switched hour says yes or no to live readings; a source only where
  // one is named.
  for (const h of on) {
    if (h.numberSource) assert.deepEqual(Object.keys(h).sort(), [...OFF_KEYS, 'liveReadings', 'numberSource'].sort());
    else assert.deepEqual(Object.keys(h).sort(), [...OFF_KEYS, 'liveReadings'].sort());
  }
  assert.deepEqual(on.map((h) => h.liveReadings), [false, true, true, true, true]);
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
  // Its own statement in its own try, after the offset's, so a missing 093
  // column cannot cost the offset or the nowcast's readings.
  const body = src.slice(src.indexOf('async function buildRecentDeviation('));
  assert.ok(body.indexOf('UPSERT_SQL') < body.indexOf('storeOffsetReadings('));
  assert.match(src, /async function storeOffsetReadings[\s\S]*catch \(err\)/);
});

test('migration 093 adds the offset readings column additively, in ASCII, and declares it', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '093_venue_offset_readings.sql'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(sql), 'ASCII only: the boot-safety server is WIN1252');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS offset_readings JSONB;/);
  assert.match(sql, /-- @requires column ml_venue_recent_deviation\.offset_readings/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(DROP|DELETE|UPDATE|NOT NULL|DEFAULT)\b/i);
});

// ── The live and sports feature families leave this artifact alone ─────────
//
// v2.6.0-starling lists neither family, so every response it serves, under
// every switch configuration production can set, must be what it was before
// the families existed, and so must every statement it sends. Recorded
// (sha256 of the fixture's 135 responses, `asOf` left out because it is the
// wall clock, and of the statements in order) from the code before the
// families were added.
const PRE_FAMILY = {
  off: ['2c1c088f1d0937e4b3a71818dddce32051465a48b94f930140259c029f5aa9e1', 'c0fb5514e3b331fa2080c4aacf86fd9345558366dfc3a8269a3cb93cb38a719d'],
  off_qmapoff: ['fec289f0febb8c101c3ef9101bd2dd0d8fb3cc922856fdeab8b6b425394ce4c7', 'c0fb5514e3b331fa2080c4aacf86fd9345558366dfc3a8269a3cb93cb38a719d'],
  co: ['5a457531c684479c013318fddcc7fdce662664bfb776469a5829295c1051e7f5', '8042bcfe0ce42e931a3adb64e366418e9f64be2f6af5cfc1b854f05493093ba2'],
  conow: ['6eaaa13d2017ee6de88af71b077d2ac6668e7cd818c23e33c7c2211c90115a7a', '8042bcfe0ce42e931a3adb64e366418e9f64be2f6af5cfc1b854f05493093ba2'],
  now: ['6e86b0594039e7f3097dc4cfcf8957936e2293999cc0f80f75902a94a327e096', '8042bcfe0ce42e931a3adb64e366418e9f64be2f6af5cfc1b854f05493093ba2'],
  now_qmapoff: ['57b39eae7cbd6af3dc21cc47bd2bd56934997b73bc0f62536d5e5ef339dc0c0b', '8042bcfe0ce42e931a3adb64e366418e9f64be2f6af5cfc1b854f05493093ba2'],
};
const PRE_FAMILY_ENV = {
  off: {},
  off_qmapoff: { CROWD_QMAP_ENABLED: 'false' },
  co: { CROWD_SERVE_MODE: 'curve_offset' },
  conow: { CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' },
  now: { CROWD_NOWCAST_ENABLED: 'true' },
  now_qmapoff: { CROWD_NOWCAST_ENABLED: 'true', CROWD_QMAP_ENABLED: 'false' },
};

test('an artifact that lists no live or sports feature serves byte for byte as before, under every switch configuration', async () => {
  const crypto = require('crypto');
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const meta = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'model_metadata.json'), 'utf8'));
  assert.equal(I.artifactReadsLiveFeatures(meta), false);
  assert.equal(I.artifactReadsSportsFeatures(meta), false);
  assert.equal(I.artifactLearnsOffset(meta), false);
  for (const [name, env] of Object.entries(PRE_FAMILY_ENV)) {
    const { out, sql, version } = await serveFixture(env);
    if (version !== GOLDEN.version) assert.fail(`the served artifact is ${version}; re-record PRE_FAMILY for it`);
    assert.equal(sha(JSON.stringify(out, (k, v) => (k === 'asOf' ? null : v))), PRE_FAMILY[name][0], `${name}: responses`);
    assert.equal(sha(JSON.stringify(sql)), PRE_FAMILY[name][1], `${name}: statements`);
    assert.ok(sql.every((s) => !/ml_sports_events/.test(s)), `${name}: the schedule is never read`);
  }
});
