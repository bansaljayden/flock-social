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
// Sections 1 to 5 assert no tuned constant: every accuracy figure they check
// is read out of the artifact under test, so a retrain that moves the number
// moves the assertion with it. What is asserted is which population the
// number came from and that nothing was invented to fill a gap.
//
// SECTION 6 (2026-11-27) PINS ONE MORE RULE. 2.8.0-starling's own served
// slice (92.6% within 15 on 1,481,472 rows) is 89.3% readings the data
// provider generated from its own weekly forecast after 2026-10-23, so it
// describes agreement with the provider, not real crowds. An artifact named in
// mlPredictor's REAL_READINGS_MEASURED publishes the figure measured on real
// readings instead (2.8.0-starling: 38.3% on 9,912 Miami readings, a city it
// never trained on); every other artifact publishes exactly what it did
// before; and every number whose only figure was measured on generated
// readings (a zero-curve hour, the month average, the category table)
// publishes 'unmeasured'. Those figures ARE constants, measured once on the
// only real readings there are, so section 6 pins them as such. Sections 1
// to 5 run on a copy of the artifact under a version that table does not
// name (UNLISTED), because they are about an artifact's own figure.
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
// The score quantile map is ARMED BY DEFAULT in production since 2026-08-28.
// This suite pins the reconstruction stage BENEATH the map (clamp, push,
// rounding, confidence provenance), whose contracts are unchanged by the
// arming; the map itself, its default, and its published-figure switch are
// pinned end to end by dispersionReconstruction.test.js. The kill switch here
// keeps these fixtures scoring the stage they were written to hold still.
process.env.CROWD_QMAP_ENABLED = 'false';


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
//
// The copy is also given a version mlPredictor's REAL_READINGS_MEASURED does
// not name (UNLISTED): these sections pin what an artifact publishes from its
// own metadata, which is what every artifact outside that table publishes.
// Section 6 pins the table under the version on disk.
const UNLISTED = `${META.model_version}-unlisted`;
const shipped = (over = {}) => (m) => ({
  ...m,
  model_version: UNLISTED,
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
      // The majority of the artifact's own rows. This asked for twice the
      // served slice while v2.6.0-starling was on disk (1,565,912 weekly rows
      // against 369,076 served, 81% of its 1,934,988). 2.8.0-starling trains
      // on four times the live readings: 2,052,008 weekly rows of 3,533,480,
      // 58%, against 1,481,472 served. Still the majority, which is the claim.
      assert.ok(byPop.weekly_anchor.rows > byPop.all_rows.rows / 2, 'the blend is majority weekly rows');
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

test('whatever artifact is on disk loads and reports the verdict its own metrics earn', () => {
  // This used to assert the on-disk incumbent was 'unmeasured', which was true
  // of v2.5.0-starling and stopped being true the moment v2.6.0-starling was
  // built carrying training_metrics_by_population. The file is gitignored, so it
  // differs per machine and is absent on a fresh clone, and pinning a verdict to
  // one artifact generation made this test go red for a model upgrade rather
  // than for a defect. The invariant worth holding is the one the load gate
  // exists for: a loadable artifact must keep serving whatever it can or cannot
  // claim, because refusing it unloads getBaseline and drops every corpus venue
  // back to a category curve. The synthetic cases above already pin each verdict
  // in isolation, so this one pins the real file against the same contract.
  if (!fs.existsSync(INCUMBENT_META_FILE)) return;
  const incumbent = JSON.parse(fs.readFileSync(INCUMBENT_META_FILE, 'utf8'));
  const got = readServedAccuracy(incumbent);

  assert.notEqual(got.status, 'malformed',
    'a loadable artifact must never be refused, whatever it does or does not measure');

  if (incumbent.training_metrics_by_population) {
    assert.equal(got.status, 'measured');
    assert.ok(Number.isFinite(got.percent),
      'an artifact that measured the served slice has a figure to publish');
  } else {
    assert.equal(got.status, 'unmeasured');
    assert.equal(got.percent, undefined,
      'it has nothing publishable, and the blend it does carry is not a substitute');
    assert.ok(Number.isFinite(incumbent.training_metrics.within_15),
      'the old artifact does carry a blended figure, which is exactly the trap');
  }
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
    assert.equal(r.modelVersion, UNLISTED);
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

// ---------------------------------------------------------------------------
// 6. A figure measured on real readings, and none measured on generated ones
//    (2026-11-27).
//
// From 2026-10-23 the data provider's "live" readings were generated from its
// own weekly forecast, not measured. A figure measured on them says how
// closely a number reproduces the provider's, not how often a card is right,
// so it is never published as accuracy.
// ---------------------------------------------------------------------------

const { REAL_READINGS_MEASURED, artifactFigure, servedConfidence, noCurveFallbackResponse, NOWCAST_WEIGHTS } = mlPredictor._internals;
const REAL_VERSION = '2.8.0-starling';
// The artifact on disk, under the version the table names.
const asRealVersion = (m) => ({ ...m, model_version: REAL_VERSION, ship_gate: { ...m.ship_gate, overall_pass: true, verdict: 'ship' } });

// Every calendar date a population string names, as YYYY-MM-DD: full dates,
// and the end of a range written 2026-09-05..10-12.
function datesIn(s) {
  const out = [];
  for (const m of String(s).matchAll(/(\d{4})-(\d{2})-(\d{2})(?:\.\.(\d{2})-(\d{2}))?/g)) {
    out.push(`${m[1]}-${m[2]}-${m[3]}`);
    if (m[4]) out.push(`${m[1]}-${m[4]}-${m[5]}`);
  }
  return out;
}
// The last day the provider's readings were measurements, and the first day
// its readings were generated.
const LAST_REAL_DAY = '2026-10-12';
const FIRST_GENERATED_DAY = '2026-10-23';

test('REAL_READINGS_MEASURED names 2.8.0-starling: 38.3 within 15 on 9,912 real Miami readings it never trained on', () => {
  assert.deepEqual(Object.keys(REAL_READINGS_MEASURED), [REAL_VERSION]);
  const m = REAL_READINGS_MEASURED[REAL_VERSION];
  assert.ok(Object.isFrozen(REAL_READINGS_MEASURED) && Object.isFrozen(m));
  assert.equal(m.within15, 38.3);
  assert.equal(m.rows, 9912);
  assert.match(m.population, /2026-09-05\.\.10-12/);
  assert.match(m.population, /Miami/);
  assert.match(m.population, /never trained on/);
  assert.match(m.population, /none with a reading from the hour before/);
  const dates = datesIn(m.population);
  assert.ok(dates.length >= 2);
  for (const d of dates) assert.ok(d <= LAST_REAL_DAY, `${d}: every reading under it was a measurement`);
  // And it is not the artifact's own figure, which is the one it replaces.
  assert.notEqual(m.within15, META.training_metrics_by_population.realtime_served.within_15);
});

test('2.8.0-starling publishes 38, or 23 without a live temperature reading, with the real readings\' population and row count', async () => {
  const m = REAL_READINGS_MEASURED[REAL_VERSION];
  await withLoadedModel(async (fresh) => {
    const venue = venueWithBaseline();
    const withWx = await fresh.predictBusyness(venue, WEATHER, TS);
    const noWx = await fresh.predictBusyness(venue, null, TS);
    assert.equal(withWx.predictionMethod, 'ml');
    assert.equal(noWx.predictionMethod, 'ml');
    assert.equal(withWx.modelVersion, REAL_VERSION);
    assert.equal(withWx.confidence, 38);
    assert.equal(noWx.confidence, 23, '38 less the 15 the rule engine adds for a live reading');
    const block = (penalty) => ({
      status: 'measured',
      means: 'measured_accuracy',
      metric: 'within_15_real_readings',
      population: m.population,
      populationRows: 9912,
      measuredPercent: 38.3,
      weatherPenalty: penalty,
    });
    assert.deepEqual(withWx.confidenceMeasurement, block(0));
    assert.deepEqual(noWx.confidenceMeasurement, block(15));
    // The artifact's own figure is not what the card says.
    const own = META.training_metrics_by_population.realtime_served.within_15;
    assert.notEqual(withWx.confidence, Math.round(own));
    assert.notEqual(noWx.confidence, Math.max(0, Math.round(own) - 15));
  }, asRealVersion);
});

test('the version a figure is published for moves the claim and nothing else: score, label and hourly forecast are the same', async () => {
  const serve = async (mutate) => {
    let got;
    await withLoadedModel(async (fresh) => {
      const venue = venueWithBaseline(55, { place_id: 'confidence-same-venue' });
      const now = await fresh.predictBusyness(venue, WEATHER, TS);
      const strip = await fresh.predictHourlyForecast(venue, WEATHER, 18, 4, TS);
      got = { now, strip };
    }, mutate);
    return got;
  };
  const real = await serve(asRealVersion);
  const unlisted = await serve(withServed({ ...META.training_metrics_by_population.realtime_served }));
  assert.equal(real.now.score, unlisted.now.score);
  assert.equal(real.now.label, unlisted.now.label);
  assert.deepEqual(real.strip.map((h) => [h.score, h.label]), unlisted.strip.map((h) => [h.score, h.label]));
  assert.ok(real.strip.length === 4 && real.strip.every((h) => h.predictionMethod === 'ml'));
  // The strip's hours carry no confidence of their own; the whole entry is
  // the same under both versions.
  assert.deepEqual(real.strip, unlisted.strip);
  // Only the claim differs: 38 against the 93 the artifact's own figure gave.
  assert.equal(real.now.confidence, 38);
  assert.equal(unlisted.now.confidence, Math.round(META.training_metrics_by_population.realtime_served.within_15));
});

test('an artifact the table does not name publishes exactly what it did before', async () => {
  // The artifact on disk under another version: its own served slice, as
  // 2.8.0-starling itself published until 2026-11-27 (93, and 78 without a
  // live temperature reading).
  const own = META.training_metrics_by_population.realtime_served;
  await withLoadedModel(async (fresh) => {
    const withWx = await fresh.predictBusyness(venueWithBaseline(), WEATHER, TS);
    const noWx = await fresh.predictBusyness(venueWithBaseline(), null, TS);
    assert.equal(withWx.confidence, Math.round(own.within_15));
    assert.equal(noWx.confidence, Math.round(own.within_15) - 15);
    assert.deepEqual(withWx.confidenceMeasurement, {
      status: 'measured',
      means: 'measured_accuracy',
      metric: 'within_15',
      population: 'realtime_served',
      populationRows: own.rows,
      measuredPercent: own.within_15,
      weatherPenalty: 0,
    });
  }, withServed({ ...own }));
  // artifactFigure hands back readServedAccuracy's own answer, the same
  // object, for every version it does not name, and never turns a malformed
  // slice into a figure.
  for (const version of [undefined, null, '', 'toString', '2.6.0-starling', '2.9.0-starling', UNLISTED]) {
    const acc = readServedAccuracy({ training_metrics_by_population: { realtime_served: SERVED_FIXTURE } });
    assert.equal(artifactFigure(acc, version), acc, String(version));
  }
  const broken = readServedAccuracy({ training_metrics_by_population: { realtime_served: { within_15: 'high' } } });
  assert.equal(artifactFigure(broken, REAL_VERSION), broken);
  // v2.6.0-starling, with its own 33.3 (spring readings that behave like real
  // ones): 33, as before.
  const v260 = servedConfidence({
    accuracy: { status: 'measured', percent: 33.3, metric: 'within_15', population: 'realtime_served', rows: 369076 },
    qmapApplied: false, hasWeather: true, curveOffset: false, nowcast: null, version: '2.6.0-starling', ladder: () => 70,
  });
  assert.equal(v260.confidence, 33);
  assert.equal(v260.confidenceMeasurement.population, 'realtime_served');
  // The real file, when this machine has it.
  if (fs.existsSync(INCUMBENT_META_FILE)) {
    const incumbent = JSON.parse(fs.readFileSync(INCUMBENT_META_FILE, 'utf8'));
    if (!Object.prototype.hasOwnProperty.call(REAL_READINGS_MEASURED, incumbent.model_version)) {
      const acc = readServedAccuracy(incumbent);
      assert.equal(artifactFigure(acc, incumbent.model_version), acc);
    }
  }
});

test('the load gate still reads the metadata alone, under the version the table names', async () => {
  // Garbage in the slice is refused whatever the table says.
  await assertRefused((m) => ({ ...withServed({ ...SERVED_FIXTURE, rows: 0 })(m), model_version: REAL_VERSION }), 'zero rows under 2.8.0-starling');
  await assertRefused((m) => ({ ...withServed({ ...SERVED_FIXTURE, within_15: 140 })(m), model_version: REAL_VERSION }), 'within_15=140 under 2.8.0-starling');
  // Under the override a malformed slice still publishes nothing.
  process.env.ML_SHIP_GATE_OVERRIDE = 'true';
  try {
    await withFreshPredictor({
      ort: stubOrt(async () => ({ variable: { data: [4] } })),
      mutateMeta: (m) => ({ ...withServed({ ...SERVED_FIXTURE, within_15: 'high' })(m), model_version: REAL_VERSION }),
    }, async (fresh) => {
      assert.equal(await fresh.init(), true);
      const r = await fresh.predictBusyness(venueWithBaseline(), WEATHER, TS);
      assert.equal(r.predictionMethod, 'rule_engine_fallback');
      assert.equal(r.confidenceMeasurement, undefined);
    });
  } finally {
    delete process.env.ML_SHIP_GATE_OVERRIDE;
  }
});

test('every number whose only figure describes generated readings publishes unmeasured, and no published population is dated after the readings stopped being measurements', () => {
  const LADDER = 70;
  const UNMEASURED = {
    status: 'unmeasured', means: 'input_completeness', metric: 'venue_metadata_completeness',
    population: null, populationRows: null, measuredPercent: null, weatherPenalty: 0,
  };
  const accuracies = [
    { status: 'measured', percent: 33.3, metric: 'within_15', population: 'realtime_served', rows: 369076 },
    readServedAccuracy(META),
    { status: 'unmeasured', reason: 'none' },
  ];
  const nowcasts = [null];
  for (const [base, table] of Object.entries(NOWCAST_WEIGHTS)) {
    for (const bucket of [1, 2, 3, 4]) {
      if (table[bucket] > 0) nowcasts.push({ base, bucket, lagHours: bucket, weight: table[bucket] });
    }
  }
  const published = new Set();
  let n = 0;
  for (const version of [undefined, '2.6.0-starling', REAL_VERSION, UNLISTED]) {
    for (const accuracy of accuracies) {
      for (const qmapApplied of [false, true]) {
        for (const hasWeather of [true, false]) {
          for (const curveOffset of [false, true]) {
            for (const nowcast of nowcasts) {
              for (const monthSupport of [false, true]) {
                for (const zeroCurve of [false, true]) {
                  const got = servedConfidence({
                    accuracy, qmapApplied, hasWeather, curveOffset, nowcast, monthSupport, zeroCurve, version, ladder: () => LADDER,
                  });
                  const where = JSON.stringify({ version, accuracy: accuracy.population || accuracy.status, qmapApplied, hasWeather, curveOffset, nowcast, monthSupport, zeroCurve });
                  n++;
                  if (zeroCurve || monthSupport) {
                    // A zero-curve hour and the month average: every figure
                    // either was measured on is from 2026-10-23 or later.
                    assert.deepEqual(got.confidenceMeasurement, UNMEASURED, where);
                    assert.equal(got.confidence, LADDER, where);
                  }
                  const m = got.confidenceMeasurement;
                  if (m.status === 'measured') published.add(m.population);
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(n > 1000, `only ${n} combinations`);
  // The category table's number, whatever the ladder says.
  for (const ladder of [0, 42, 100]) {
    const r = noCurveFallbackResponse(62, true, null, ladder);
    assert.deepEqual(r.confidenceMeasurement, UNMEASURED);
    assert.equal(r.confidence, ladder);
    assert.equal(r.score, 62);
  }
  // Every population any of those published: none is dated after the last
  // day the provider's readings were measurements, so none calls readings
  // after 2026-10-23 live.
  assert.ok(published.size >= 4, [...published].join(' | '));
  for (const population of published) {
    for (const d of datesIn(population)) {
      assert.ok(d <= LAST_REAL_DAY, `${d} in a published population: ${population}`);
      assert.ok(d < FIRST_GENERATED_DAY);
    }
  }
  assert.ok(published.has(REAL_READINGS_MEASURED[REAL_VERSION].population), 'the real-readings figure is among them');
  // And the records of what was measured on generated readings say so in
  // their own words, so none can be republished as a live figure.
  const I = mlPredictor._internals;
  for (const record of [I.MONTH_SUPPORT_POPULATION, I.ZERO_CURVE_ALSO_MEASURED[REAL_VERSION].population, I.NO_CURVE_FALLBACK_POPULATION]) {
    assert.doesNotMatch(record, /\blive readings\b/, record);
    assert.match(record, /generated by the data provider from its own weekly forecast/, record);
    assert.ok(datesIn(record).some((d) => d >= FIRST_GENERATED_DAY), record);
    assert.ok(!published.has(record), `published: ${record}`);
  }
});

// Last in the file: bandEval pins the process clock to UTC and points the
// database settings at an address nothing listens on.
test('the replay (bandEval.js) publishes the figure predictBusyness publishes for the artifact on disk, row for row', async () => {
  require('./helpers/sharedOnnxSession');
  const os = require('os');
  const B = require('../scripts/ml/train/bandEval');
  const FX = require('./helpers/bandEvalFixture');
  const fx = FX.buildFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-confidence-honesty-'));
  const csv = path.join(dir, 'fixture.csv');
  FX.writeFixtureCsv(csv, fx);
  const quiet = [console.log, console.warn, console.error];
  try {
    B.pinUtcClock();
    const corpus = await B.readCorpus([csv]);
    const art = await B.loadArtifact(MODELS_DIR);
    const prepared = B.prepareRows(corpus.live, corpus, { I: art.I, crowdEngine });
    const replay = await B.scoreArtifact(art, prepared, { serveMode: 'model', nowcast: false, qmap: false });
    const moments = new Map();
    const stub = FX.makeFixturePool(fx, (alias) => moments.get(alias));
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    const production = await withFreshPredictor({ db: stub }, async (fresh) => {
      assert.equal(await fresh.init(), true);
      const out = [];
      for (let i = 0; i < prepared.length; i++) {
        const r = prepared[i];
        const alias = `ChIJconfidencehonesty_${r.venueId}_${i}`;
        moments.set(alias, { venueId: Number(r.venueId), date: r.date, hour: r.hour });
        out.push(await fresh.predictBusyness({ ...r.venue, place_id: alias }, r.weather, r.ts));
      }
      return out;
    });
    [console.log, console.warn, console.error] = quiet;
    assert.deepEqual(stub.unknown, []);
    const real = REAL_READINGS_MEASURED[art.meta.model_version];
    let ml = 0;
    production.forEach((p, i) => {
      const q = replay.rows[i];
      assert.equal(p.score, q.served, `row ${i}: the number`);
      assert.equal(p.confidence, q.confidence, `row ${i}: the confidence`);
      if (p.predictionMethod !== 'ml') return;
      ml++;
      assert.equal(p.confidenceMeasurement.metric, q.confidenceMetric, `row ${i}: the metric`);
      if (real) {
        // The figure measured on real readings, in both.
        assert.equal(q.confidenceMetric, 'within_15_real_readings', `row ${i}`);
        assert.ok([Math.round(real.within15), Math.round(real.within15) - 15].includes(q.confidence), `row ${i}: ${q.confidence}`);
      }
    });
    assert.ok(ml >= 60, `only ${ml} model rows`);
  } finally {
    [console.log, console.warn, console.error] = quiet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
