// ---------------------------------------------------------------------------
// THE PERCENTAGE ON THE VENUE CARD MUST BE A NUMBER SOMEBODY MEASURED, ON THE
// ROWS THIS CODE IS ACTUALLY ASKED TO SCORE.
//
// services/mlPredictor.js published metadata.training_metrics.within_15 as the
// card's `confidence`. scripts/ml/MODEL-METRICS.md section 2 counts that
// population: 1,565,912 of 1,934,988 rows are weekly popular_times snapshots
// whose label equals the baseline by construction, so a delta model's correct
// answer on them is zero and it gets them free. The same run, same model, two
// populations:
//
//     all_rows (the blend)   within-15  87.3%   <- what users were told
//     realtime_served        within-15  33.3%   <- what production scores
//
// scripts/ml/WITHIN-CITY-EVAL.md scored the serving population a second way
// (within-city, forward in time) and got within-10 20.7% against the blend's
// 85.1%, so the gap is not an artifact of one split.
//
// What this file pins is the rule that follows, in three states:
//
//   measured    the served slice is there -> publish it, named
//   unmeasured  no slice (every artifact exported before 2026-08-15, including
//               the one production runs) -> STILL LOAD, still serve per-venue
//               baselines, and publish 'unmeasured' instead of the blend
//   malformed   a slice that exists and is garbage -> refuse at load
//
// The middle state is the one with teeth. Refusing an old artifact would unload
// this module and take getBaseline with it, dropping every venue back to
// crowdEngine's category prior — a large user-visible downgrade shipped to fix
// a label. So the claim degrades and the model keeps serving.
//
// Nothing here asserts a tuned constant — every accuracy figure it checks is
// read out of the artifact under test, so a retrain that moves the number moves
// the assertion with it. What is asserted is which population the number came
// from and that nothing was invented to fill a gap.
//
// The sibling pins live in __tests__/mlPredictorHarness.test.js (the fallback
// ladder and the response contract) and __tests__/predictorCorrectness.test.js
// (verifyModelShape). This file only owns the confidence question.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// No live upstreams; the fail-closed gates must be armed unless a test arms the
// override itself.
delete process.env.TICKETMASTER_API_KEY;
delete process.env.ML_SHIP_GATE_OVERRIDE;

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const { readServedAccuracy } = mlPredictor._internals;

const MOD = require.resolve('../services/mlPredictor');
const ORT = require.resolve('onnxruntime-node');
const DB = require.resolve('../config/database');
const MODELS_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'models');
const META_FILE = path.join(MODELS_DIR, 'model_metadata.json');
const INCUMBENT_META_FILE = path.join(MODELS_DIR, 'incumbent', 'model_metadata.json');
const META = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));

// ---------------------------------------------------------------------------
// Plumbing: a fresh predictor instance with the metadata rewritten on the way
// in and onnxruntime stubbed, so the load path can be exercised without the
// real 11 MB artifact and without any state leaking into another test.
// (Same module-boundary seam mlPredictorHarness.test.js uses.)
// ---------------------------------------------------------------------------

function stubOrt(runImpl, meta = META) {
  const inputName = meta.onnx_input_name || 'input';
  return {
    InferenceSession: {
      create: async () => ({
        inputNames: [inputName],
        outputNames: ['variable'],
        inputMetadata: [{ name: inputName, isTensor: true, type: 'float32', shape: ['', meta.feature_names.length] }],
        outputMetadata: [{ name: 'variable', isTensor: true, type: 'float32', shape: ['', 1] }],
        run: (...args) => runImpl(...args),
      }),
    },
    Tensor: class Tensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
  };
}

// Every query answers empty: no database in the test environment, and no test
// here depends on one. The baseline comes off the venue's popular_times.
const EMPTY_DB = {
  query: async (sql) => (/FROM venue_feedback/.test(String(sql)) ? { rows: [{}] } : { rows: [] }),
};

async function withFreshPredictor({ ort, db = EMPTY_DB, mutateMeta } = {}, fn) {
  const savedMod = require.cache[MOD];
  const savedOrt = require.cache[ORT];
  const savedDb = require.cache[DB];
  const realReadFileSync = fs.readFileSync;
  try {
    if (ort) require.cache[ORT] = { id: ORT, filename: ORT, loaded: true, exports: ort };
    if (db) require.cache[DB] = { id: DB, filename: DB, loaded: true, exports: db };
    if (mutateMeta) {
      fs.readFileSync = (p, ...rest) => {
        if (String(p).endsWith('model_metadata.json')) {
          return JSON.stringify(mutateMeta(JSON.parse(realReadFileSync(META_FILE, 'utf8'))));
        }
        return realReadFileSync(p, ...rest);
      };
    }
    delete require.cache[MOD];
    return await fn(require(MOD));
  } finally {
    fs.readFileSync = realReadFileSync;
    delete require.cache[MOD];
    if (savedOrt) require.cache[ORT] = savedOrt; else delete require.cache[ORT];
    if (savedDb) require.cache[DB] = savedDb; else delete require.cache[DB];
    if (savedMod) require.cache[MOD] = savedMod;
  }
}

// The checked-in artifact carries ship_gate.overall_pass:false (the retrain of
// 2026-08-15 failed criterion 3 — MODEL-METRICS.md section 5), so nothing loads
// it as it stands. These tests are about the confidence figure, not the gate, so
// they pass the gate explicitly and leave the gate's own pins to the harness.
const shipped = (over = {}) => (m) => ({
  ...m,
  ship_gate: { ...m.ship_gate, overall_pass: true, verdict: 'ship' },
  ...over,
});

let seq = 0;
const venueWithBaseline = (fill = 50, over = {}) => ({
  place_id: `confidence-${++seq}`,
  name: 'Confidence Venue',
  types: ['bar', 'restaurant', 'food'],
  rating: 4.2,
  price_level: 2,
  user_ratings_total: 300,
  location: { latitude: 40.71, longitude: -74.0 },
  popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(fill) })),
  ...over,
});

const WEATHER = { temp: 70, humidity: 55, windSpeed: 4, isRaining: false, conditionId: 800 };
const TS = new Date(2026, 7, 14, 20, 0, 0, 0); // Fri 8 PM venue wall clock

// WHICH ARTIFACT IS ON DISK CHANGES UNDER THIS FILE'S FEET — v2.5.0-starling
// (no slice) and the 2026-08-15 retrain (slice) were both checked in within the
// same hour. So the measured-path tests INJECT a served slice rather than
// reading one, and only the two tests that are explicitly about the on-disk
// artifact look at META. These are the numbers MODEL-METRICS.md section 2
// reports for the retrain, used here as fixture input, never as a constant the
// code may fall back to.
const SERVED_FIXTURE = { rows: 369076, mae: 27.5426, within_5: 11.9, within_10: 22.8, within_15: 33.3 };

const withServed = (slice = SERVED_FIXTURE) => (m) => ({
  ...shipped()(m),
  training_metrics_by_population: { ...(m.training_metrics_by_population || {}), realtime_served: slice },
});

// ---------------------------------------------------------------------------
// 1. The artifact says two different things about how accurate it is. Which one
//    gets published is the whole question.
// ---------------------------------------------------------------------------

test('whatever artifact is on disk is classified, and its blend is never the answer', () => {
  const onDisk = readServedAccuracy(META);
  assert.notEqual(onDisk.status, 'malformed',
    `the checked-in artifact must be loadable: ${onDisk.reason || ''}`);

  const blend = META.training_metrics.within_15;
  assert.ok(Number.isFinite(blend), 'every artifact carries the blended figure — that is the trap');

  if (onDisk.status === 'measured') {
    assert.ok(onDisk.percent < blend,
      'if these ever converge, the mixture that made the blend flattering has changed and ' +
      'this whole file needs re-reading rather than re-pointing');
    // WHY they diverge, from the artifact rather than from the argument: the
    // weekly slice is the majority of the rows and is close to tautological.
    const byPop = META.training_metrics_by_population;
    if (byPop.weekly_anchor) {
      assert.ok(byPop.weekly_anchor.rows > onDisk.rows * 2, 'the blend is majority weekly rows');
      assert.ok(byPop.weekly_anchor.within_15 > 99,
        'a weekly row\'s label equals its baseline by construction, so the model gets it free');
    }
  } else {
    assert.equal(onDisk.percent, undefined,
      'an artifact with no served slice hands back no figure, and the blend it carries ' +
      `(${blend}%) is not promoted into its place`);
  }
});

// ---------------------------------------------------------------------------
// 2. readServedAccuracy: three states, and the difference between "this
//    artifact never measured it" and "this artifact's field is broken".
// ---------------------------------------------------------------------------

test('readServedAccuracy reports the served slice verbatim, and names what it is', () => {
  const meta = { training_metrics: { within_15: 83.6 }, training_metrics_by_population: { realtime_served: SERVED_FIXTURE } };
  const got = readServedAccuracy(meta);
  assert.equal(got.status, 'measured');
  assert.equal(got.percent, SERVED_FIXTURE.within_15,
    'the figure is passed through, not rescaled, rounded or adjusted');
  assert.equal(got.metric, 'within_15');
  assert.equal(got.population, 'realtime_served');
  assert.equal(got.rows, SERVED_FIXTURE.rows);
  assert.notEqual(got.percent, meta.training_metrics.within_15,
    'the served figure must not be the blend');
});

test('a row count is required to be a count, and an absent one claims nothing', () => {
  const base = SERVED_FIXTURE;
  const meta = (served) => ({ training_metrics_by_population: { realtime_served: served } });

  // Absent: the percentage still stands, the sample size simply is not claimed.
  const { rows: _drop, ...noRows } = base;
  assert.equal(readServedAccuracy(meta(noRows)).status, 'measured');
  assert.equal(readServedAccuracy(meta(noRows)).rows, null);
  assert.equal(readServedAccuracy(meta(noRows)).percent, base.within_15);

  // Present but not a count: the slice was computed over an empty or
  // nonsensical population, so the percentage above it describes nothing.
  for (const rows of [0, -1, 1.5, NaN, Infinity, 'many', {}, []]) {
    assert.equal(readServedAccuracy(meta({ ...base, rows })).status, 'malformed',
      `rows=${JSON.stringify(rows)} is not a population a percentage can be measured over`);
  }
});

test('an artifact that never measured the served slice is unmeasured, not broken', () => {
  const blend = { within_15: 87.3, within_10: 85.1, mae: 6.9 };
  const cases = [
    ['no metadata at all', null],
    ['undefined metadata', undefined],
    ['empty metadata', {}],
    ['only the blend (the shape of every pre-2026-08-15 artifact)', { training_metrics: blend }],
    // Metadata that is not an object at all has no field to be broken; it is
    // caught earlier and harder, by verifyModelShape's feature_names check.
    ['metadata that is a string (a half-read file)', '{"training_metrics":{"within_15":87.3}}'],
    ['metadata that is a number', 87.3],
    ['by_population explicitly null', { training_metrics: blend, training_metrics_by_population: null }],
    ['by_population without the served slice', {
      training_metrics_by_population: { all_rows: { ...blend, rows: 1934988 } },
    }],
    ['served slice explicitly null', { training_metrics_by_population: { realtime_served: null } }],
  ];
  for (const [what, meta] of cases) {
    const got = readServedAccuracy(meta);
    assert.equal(got.status, 'unmeasured', `${what}: nothing here is broken, it is simply not measured`);
    assert.equal(got.percent, undefined, `${what}: and no figure is handed back to publish`);
    assert.ok(got.reason, `${what}: the reason travels with the verdict, for the log line`);
  }
});

test('a served slice that exists and is garbage is malformed, and never yields a number', () => {
  const cases = [
    ['by_population is a string', { training_metrics_by_population: 'realtime_served: 33.3' }],
    ['by_population is an array', { training_metrics_by_population: [{ within_15: 33.3 }] }],
    ['served slice is a number', { training_metrics_by_population: { realtime_served: 33.3 } }],
    ['served slice is an array', { training_metrics_by_population: { realtime_served: [33.3] } }],
    ['served within_15 missing', { training_metrics_by_population: { realtime_served: { mae: 27.5, rows: 1 } } }],
    ['served within_15 null', { training_metrics_by_population: { realtime_served: { within_15: null, rows: 1 } } }],
    ['served within_15 a string', { training_metrics_by_population: { realtime_served: { within_15: '33.3', rows: 1 } } }],
    ['served within_15 NaN', { training_metrics_by_population: { realtime_served: { within_15: NaN, rows: 1 } } }],
    ['served within_15 zero', { training_metrics_by_population: { realtime_served: { within_15: 0, rows: 1 } } }],
    ['served within_15 negative', { training_metrics_by_population: { realtime_served: { within_15: -5, rows: 1 } } }],
    ['served within_15 above 100', { training_metrics_by_population: { realtime_served: { within_15: 140, rows: 1 } } }],
  ];
  for (const [what, meta] of cases) {
    const got = readServedAccuracy(meta);
    assert.equal(got.status, 'malformed', `${what}: a field that exists and cannot be read is a broken write`);
    assert.equal(got.percent, undefined, `${what}: nothing publishable comes out of garbage`);
    assert.ok(got.reason, `${what}: the refusal must be able to say why`);
  }
  // A string that happens to be an array is still not a metrics object; and no
  // input on this list ever produces the blend.
  assert.notEqual(readServedAccuracy({ training_metrics: { within_15: 87.3 } }).percent, 87.3);
});

test('the artifact serving production today is unmeasured, and must keep serving', () => {
  // models/incumbent/model_metadata.json is v2.5.0-starling with
  // ship_gate.overall_pass true — what a deploy from HEAD would run. It predates
  // training_metrics_by_population entirely. Refusing it would unload
  // getBaseline and drop every corpus venue back to a category curve, so the
  // verdict has to be 'unmeasured' (loads, claims nothing), never 'malformed'.
  const incumbent = JSON.parse(fs.readFileSync(INCUMBENT_META_FILE, 'utf8'));
  assert.ok(Number.isFinite(incumbent.training_metrics.within_15),
    'the old artifact does carry a blended figure — that is exactly the trap');
  const got = readServedAccuracy(incumbent);
  assert.equal(got.status, 'unmeasured');
  assert.equal(got.percent, undefined,
    'it has nothing publishable, and the blend it does carry is not a substitute');
});

// ---------------------------------------------------------------------------
// 3. The load gate refuses GARBAGE ONLY.
//
// The first version of this change refused an artifact that merely lacked the
// slice. That was a production regression dressed as an honesty fix: refusing
// an artifact does not just drop the delta layer (WITHIN-CITY-EVAL prices that
// at +0.3 points of within-10), it unloads this module and getBaseline with it,
// so every venue in the corpus loses its own measured curve and gets
// crowdEngine's generic category prior instead. KOME in Lehigh goes from 65 at
// 6 PM off its own baseline to a restaurant-shaped guess. These tests pin that
// an old artifact keeps serving and only the CLAIM degrades.
// ---------------------------------------------------------------------------

const withoutSlice = (m) => { const c = shipped()(m); delete c.training_metrics_by_population; return c; };

async function assertRefused(mutate, what) {
  await withFreshPredictor({
    ort: stubOrt(async () => ({ variable: { data: [5] } })),
    mutateMeta: mutate,
  }, async (fresh) => {
    assert.equal(await fresh.init(), false, `${what}: this artifact must not be promoted`);
    const venue = venueWithBaseline();
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    const direct = crowdEngine.calculateCrowdScore(venue, WEATHER, TS);
    assert.equal(r.predictionMethod, 'rule_engine', `${what}: the rule engine must answer`);
    assert.equal(r.modelVersion, null, `${what}: a refused model must not be named`);
    assert.equal(r.confidence, direct.confidence,
      `${what}: the published confidence is the rule engine's own, not the model's`);
    assert.equal(r.confidenceMeasurement, undefined,
      `${what}: no measurement block, because no model measurement was used`);
  });
}

test('a served slice measured over zero rows is refused', async () => {
  await assertRefused(withServed({ ...SERVED_FIXTURE, rows: 0 }), 'zero rows');
});

test('a served slice with an out-of-range or unusable within_15 is refused', async () => {
  for (const bad of [0, -1, 140, 'high', null]) {
    await assertRefused(withServed({ ...SERVED_FIXTURE, within_15: bad }),
      `within_15=${JSON.stringify(bad)}`);
  }
});

test('AN OLDER ARTIFACT STILL LOADS, AND ITS PER-VENUE BASELINE STILL ANSWERS', async () => {
  // The regression the first draft would have shipped. The proof that the model
  // is really serving is the score itself: the venue's own baseline is 80 here,
  // the stubbed delta is +5, and the delta model reconstructs 85. The rule
  // engine, asked the same question, does not produce that number — it has no
  // access to this venue's curve at all.
  await withFreshPredictor({
    ort: stubOrt(async () => ({ variable: { data: [5] } })),
    mutateMeta: withoutSlice,
  }, async (fresh) => {
    assert.equal(await fresh.init(), true,
      'an artifact that merely predates the slice must still be promoted');
    const venue = venueWithBaseline(80);
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assert.equal(r.predictionMethod, 'ml', 'the model answers');
    assert.equal(r.modelVersion, META.model_version);
    // 86, not 85: baseline 80 + delta 5 reconstructs to 85, and 85 sits above
    // the extremes-push band [25, 65], so the dispersion-lab push (2026-08-19,
    // see reconstructScore) adds the one point. The assertion's point is
    // untouched — this number is reachable only from the venue's OWN curve.
    assert.equal(r.score, 86, 'baseline 80 + delta 5, pushed: the venue\'s OWN curve, not a category prior');
    assert.notEqual(r.score, crowdEngine.calculateCrowdScore(venue, WEATHER, TS).score,
      'and that is a different answer from the category curve, which is the whole point');
  });
});

test('an older artifact publishes "unmeasured", never the blend', async () => {
  await withFreshPredictor({
    ort: stubOrt(async () => ({ variable: { data: [5] } })),
    mutateMeta: (m) => {
      const c = withoutSlice(m);
      // Make the blend as tempting as it has ever been.
      c.training_metrics = { ...c.training_metrics, within_15: 87.3, within_10: 85.1 };
      return c;
    },
  }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const venue = venueWithBaseline();
    const r = await fresh.predictBusyness(venue, WEATHER, TS);

    assert.equal(r.predictionMethod, 'ml');
    assert.deepEqual(r.confidenceMeasurement, {
      status: 'unmeasured',
      means: 'input_completeness',
      metric: 'venue_metadata_completeness',
      population: null,
      populationRows: null,
      measuredPercent: null,
      weatherPenalty: 0,
    }, 'the payload states plainly that no served-population accuracy exists for this artifact');

    assert.notEqual(r.confidence, 87, 'THE REGRESSION: the blend must never be published as accuracy');
    assert.notEqual(r.confidence, Math.round(META.training_metrics.within_15));

    // The number it does carry is the rule engine's own input-completeness
    // ladder for this venue: the same quantity, for the same venue, that
    // routes/crowd.js already labels 'input_completeness' on the fallback path.
    // Not an accuracy, and nothing invented.
    assert.equal(r.confidence, crowdEngine.calculateCrowdScore(venue, WEATHER, TS).confidence);
    assert.ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100);
  });
});

test('an unmeasured artifact applies no second weather penalty', async () => {
  // The ladder already adds 15 for a live reading, so subtracting 15 again
  // would double-count one outage. The measured branch does subtract it,
  // because its figure knows nothing about weather.
  await withFreshPredictor({
    ort: stubOrt(async () => ({ variable: { data: [5] } })),
    mutateMeta: withoutSlice,
  }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const venue = venueWithBaseline();
    const noWx = await fresh.predictBusyness(venue, null, TS);
    if (noWx.predictionMethod === 'ml') {
      assert.equal(noWx.confidenceMeasurement.weatherPenalty, 0);
      assert.equal(noWx.confidence, crowdEngine.calculateCrowdScore(venue, null, TS).confidence,
        'the ladder priced the missing reading once, and nothing priced it twice');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. What the payload says when the model does answer.
// ---------------------------------------------------------------------------

async function withLoadedModel(fn, mutate = withServed()) {
  await withFreshPredictor({
    ort: stubOrt(async () => ({ variable: { data: [4] } })),
    mutateMeta: mutate,
  }, async (fresh) => {
    assert.equal(await fresh.init(), true, 'this artifact must load — the section is about its payload');
    await fn(fresh);
  });
}

test('the confidence on the card is the served figure, and never the blend', async () => {
  await withLoadedModel(async (fresh) => {
    const r = await fresh.predictBusyness(venueWithBaseline(), WEATHER, TS);
    assert.equal(r.predictionMethod, 'ml');

    assert.equal(r.confidence, Math.round(SERVED_FIXTURE.within_15),
      'the number a user reads is the accuracy measured on the rows production scores');
    assert.notEqual(r.confidence, Math.round(META.training_metrics.within_15),
      'THE REGRESSION: the blended figure must never reach a card again');
    assert.ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100,
      'and it stays inside the response contract');
  });
});

test('the payload names the number: which metric, which population, how many rows', async () => {
  await withLoadedModel(async (fresh) => {
    const r = await fresh.predictBusyness(venueWithBaseline(), WEATHER, TS);
    const slice = SERVED_FIXTURE;
    assert.deepEqual(r.confidenceMeasurement, {
      status: 'measured',
      means: 'measured_accuracy',
      metric: 'within_15',
      population: 'realtime_served',
      populationRows: slice.rows,
      measuredPercent: slice.within_15,
      weatherPenalty: 0,
    }, 'a percentage with no stated population is the bug this file exists for');
    // The published integer must be reconstructible from the block beside it,
    // or the block describes a different number than the one on the card.
    assert.equal(r.confidence,
      Math.max(0, Math.round(r.confidenceMeasurement.measuredPercent) - r.confidenceMeasurement.weatherPenalty));
  });
});

test('a weather outage is published as an adjustment, not folded into the measurement', async () => {
  await withLoadedModel(async (fresh) => {
    const withWx = await fresh.predictBusyness(venueWithBaseline(), WEATHER, TS);
    const noWx = await fresh.predictBusyness(venueWithBaseline(), null, TS);
    assert.equal(noWx.predictionMethod, 'ml', 'climatology keeps the model answering');
    assert.ok(!noWx.dataSourcesUsed.includes('weather'));

    // The measured figure is the same measurement in both answers; only the
    // adjustment moves. A reader can therefore always recover what was measured.
    assert.equal(noWx.confidenceMeasurement.measuredPercent, withWx.confidenceMeasurement.measuredPercent);
    assert.equal(withWx.confidenceMeasurement.weatherPenalty, 0);
    assert.equal(noWx.confidenceMeasurement.weatherPenalty, 15);
    assert.equal(noWx.confidence, Math.max(0, withWx.confidence - 15),
      'the rule engine adds 15 for having weather; the ML path gives the same 15 back');
  });
});

test('a retrain that moves the served figure moves the card with it', async () => {
  // The number is not pinned anywhere in this file or that one: it is read from
  // the artifact. A better model publishes a better number without an edit here,
  // and a worse one cannot hide behind a stale constant.
  for (const percent of [12.5, 33.3, 61, 99.9]) {
    await withLoadedModel(async (fresh) => {
      const r = await fresh.predictBusyness(venueWithBaseline(), WEATHER, TS);
      assert.equal(r.confidence, Math.round(percent));
      assert.equal(r.confidenceMeasurement.measuredPercent, percent);
    }, withServed({ ...SERVED_FIXTURE, within_15: percent }));
  }
});

// ---------------------------------------------------------------------------
// 5. The override hatch cannot become a back door for a garbage number.
//    ML_SHIP_GATE_OVERRIDE exists for local debugging and forces promotion past
//    every other gate. It must not force a percentage into existence.
// ---------------------------------------------------------------------------

test('under ML_SHIP_GATE_OVERRIDE a malformed slice loads but still publishes nothing', async () => {
  process.env.ML_SHIP_GATE_OVERRIDE = 'true';
  try {
    await withFreshPredictor({
      ort: stubOrt(async () => ({ variable: { data: [4] } })),
      mutateMeta: withServed({ ...SERVED_FIXTURE, within_15: 'high' }),
    }, async (fresh) => {
      assert.equal(await fresh.init(), true, 'the override does promote the artifact');
      const venue = venueWithBaseline();
      const r = await fresh.predictBusyness(venue, WEATHER, TS);
      // The prediction refuses at the point the number would be invented, and
      // the existing catch answers with the rule engine, honestly tagged. The
      // old code put `58` here instead.
      const direct = crowdEngine.calculateCrowdScore(venue, WEATHER, TS);
      assert.equal(r.predictionMethod, 'rule_engine_fallback');
      assert.equal(r.modelVersion, null);
      assert.equal(r.confidence, direct.confidence);
      assert.equal(r.score, direct.score);
      assert.equal(r.confidenceMeasurement, undefined);
      assert.ok(!r.dataSourcesUsed.includes('ml_model'),
        'a fallback answer must not claim the model as a source');
    });
  } finally {
    delete process.env.ML_SHIP_GATE_OVERRIDE;
  }
});

test('no invented confidence constant survives anywhere in the serving path', () => {
  // The reproduced original: `Math.round(metadata.training_metrics?.within_15 || 58)`.
  // 58 had no provenance whatsoever and shipped to users as a measurement.
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'mlPredictor.js'), 'utf8');
  assert.ok(!/within_15\s*\|\|\s*\d/.test(src),
    'a numeric fallback behind the accuracy figure is an invented measurement');
  assert.ok(!/confidence\s*=\s*\d+\s*;/.test(src),
    'confidence must be derived from a measurement, never assigned a literal');
});
