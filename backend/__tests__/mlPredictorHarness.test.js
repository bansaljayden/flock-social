// ---------------------------------------------------------------------------
// THE ML PATH, CHARACTERIZED THE WAY heuristicFallback.test.js CHARACTERIZED
// THE RULE ENGINE. mlPredictor.js is the PRIMARY serving path — every venue
// card score goes through predictBusyness — and its design is a ladder of
// documented fallbacks onto crowdEngine: model files missing, ship gate
// failing, trained feature with no inference twin, corrupt artifact, venue
// without a usable baseline, inference throwing. Each rung is only worth
// having if it actually reaches the rule engine instead of crashing or
// shipping garbage, and if the response's predictionMethod/modelVersion pair
// tells the truth about which engine answered. That is what this file pins.
//
// Nothing here asserts a tuned number (no thresholds, no feature weights, no
// gate criteria). What it asserts is structure: every score/confidence that
// leaves this module is an integer in 0..100; no caller-supplied garbage and
// no malformed database row can poison the tensor or the response with NaN;
// a fallback answer is the rule engine's answer, byte for byte, plus an
// honest tag; and 'ml' is claimed exactly when the model actually ran.
//
// The three bugs this harness was built around (all reproduced before fixing):
//   1. `features[name] || 0` let truthy non-numeric strings (rating: 'abc' in
//      a request-body venue — the batch endpoint scores exactly those) reach
//      the Float32Array, which coerces them to NaN inside the tensor.
//   2. A non-finite model output (NaN, or an empty output tensor's undefined)
//      rode through clamp-and-round into score NaN — serialized as null on
//      the card, labelled 'Very Busy', predictionMethod 'ml'.
//   3. An unreadable baseTimestamp made predictHourlyForecast print "NaN AM"
//      over every entry.
//
// onnxruntime-node IS available in this environment (the real artifact loads),
// so the model-side failures are injected at the module boundary with
// require.cache, the same seam predictorCorrectness.test.js and
// heuristicFallback.test.js already use for fs and fetch.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// No live upstreams, no gate override: predictions must not reach Ticketmaster,
// and the fail-closed gates must actually be armed.
delete process.env.TICKETMASTER_API_KEY;
delete process.env.ML_SHIP_GATE_OVERRIDE;

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');

const MOD = require.resolve('../services/mlPredictor');
const ORT = require.resolve('onnxruntime-node');
const DB = require.resolve('../config/database');
const META_FILE = path.join(__dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json');
const META = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));

before(async () => {
  assert.equal(await mlPredictor.init(), true,
    'the checked-in artifact must load — every real-model section below rides on it');
});

// ---------------------------------------------------------------------------
// Harness plumbing: a fresh mlPredictor instance with failures injected at its
// module boundaries (onnxruntime-node, config/database, fs), restored in
// `finally` so no later test — in this file or any other require in this
// process — ever sees a patched world.
// ---------------------------------------------------------------------------

async function withFreshPredictor({ ort, db, mutateMeta, hideModelFiles } = {}, fn) {
  const savedMod = require.cache[MOD];
  const savedOrt = require.cache[ORT];
  const savedDb = require.cache[DB];
  const realReadFileSync = fs.readFileSync;
  const realExistsSync = fs.existsSync;
  const unpatchFs = () => { fs.readFileSync = realReadFileSync; fs.existsSync = realExistsSync; };
  try {
    if (ort) require.cache[ORT] = { id: ORT, filename: ORT, loaded: true, exports: ort };
    if (db) require.cache[DB] = { id: DB, filename: DB, loaded: true, exports: db };
    if (hideModelFiles) {
      fs.existsSync = (p) =>
        (/crowd_model\.onnx|model_metadata\.json/.test(String(p)) ? false : realExistsSync(p));
    }
    if (mutateMeta) {
      fs.readFileSync = (p, ...rest) => {
        if (String(p).endsWith('model_metadata.json')) {
          return JSON.stringify(mutateMeta(JSON.parse(realReadFileSync(META_FILE, 'utf8'))));
        }
        return realReadFileSync(p, ...rest);
      };
    }
    delete require.cache[MOD];
    const fresh = require(MOD);
    return await fn(fresh, { unpatchFs });
  } finally {
    unpatchFs();
    delete require.cache[MOD];
    if (savedOrt) require.cache[ORT] = savedOrt; else delete require.cache[ORT];
    if (savedDb) require.cache[DB] = savedDb; else delete require.cache[DB];
    if (savedMod) require.cache[MOD] = savedMod;
  }
}

// A stub onnxruntime whose session passes verifyModelShape against the real
// metadata (right input name, right width, single-value float head) so the
// load gates all open — and whose run() is whatever the test needs. This is
// the shape a REAL artifact presents; only the arithmetic is fake.
function stubOrt(runImpl) {
  const inputName = META.onnx_input_name || 'input';
  const session = {
    inputNames: [inputName],
    outputNames: ['variable'],
    inputMetadata: [{ name: inputName, isTensor: true, type: 'float32', shape: ['', META.feature_names.length] }],
    outputMetadata: [{ name: 'variable', isTensor: true, type: 'float32', shape: ['', 1] }],
    run: (...args) => runImpl(...args),
  };
  return {
    session,
    ort: {
      InferenceSession: { create: async () => session },
      Tensor: class Tensor {
        constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
      },
    },
  };
}

let seq = 0;
function baselineVenue(fill = 50, over = {}) {
  return {
    place_id: `harness-${++seq}`,
    name: 'Harness Venue',
    types: ['bar', 'restaurant', 'food', 'point_of_interest', 'establishment'],
    rating: 4.2,
    price_level: 2,
    user_ratings_total: 300,
    location: { latitude: 40.71, longitude: -74.0 },
    popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(fill) })),
    ...over,
  };
}

const WEATHER = { temp: 70, humidity: 55, windSpeed: 4, isRaining: false, conditionId: 800 };
const TS = new Date(2026, 7, 14, 20, 0, 0, 0); // Fri 8 PM venue wall clock

// The response contract every outcome must satisfy, including the truthfulness
// invariant: 'ml' is claimed exactly when modelVersion names the model and
// dataSourcesUsed carries 'ml_model'; every fallback carries a rule_engine*
// method, a null modelVersion, and no model in its sources.
function assertContract(r, what) {
  assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100,
    `${what}: score ${r.score} is not an integer in 0..100`);
  assert.ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100,
    `${what}: confidence ${r.confidence} is not an integer in 0..100`);
  assert.equal(r.label, mlPredictor.getLabel(r.score), `${what}: label drifted from getLabel`);
  assert.ok(Array.isArray(r.dataSourcesUsed), `${what}: dataSourcesUsed missing`);
  if (r.predictionMethod === 'ml') {
    assert.equal(r.modelVersion, META.model_version,
      `${what}: an 'ml' answer must name the model that produced it`);
    assert.ok(r.dataSourcesUsed.includes('ml_model'), `${what}: 'ml' without ml_model source`);
  } else {
    assert.match(r.predictionMethod, /^rule_engine(_no_baseline|_no_weather_norm|_fallback)?$/,
      `${what}: unknown predictionMethod ${r.predictionMethod}`);
    assert.equal(r.modelVersion, null,
      `${what}: a fallback answer must not carry a model version`);
    assert.ok(!r.dataSourcesUsed.includes('ml_model'),
      `${what}: a fallback answer must not claim the model as a source`);
  }
}

// A fallback answer IS the rule engine's answer — same numbers, same factors,
// same sources — plus the honest tag. Anything else means the fallback path
// rescored or mangled the venue on the way through.
function assertIsRuleEngine(r, venue, weather, ts, method, what) {
  const direct = crowdEngine.calculateCrowdScore(venue, weather, ts);
  assert.equal(r.predictionMethod, method, `${what}: predictionMethod`);
  assert.equal(r.modelVersion, null, `${what}: modelVersion`);
  assert.equal(r.score, direct.score, `${what}: score diverged from the rule engine`);
  assert.equal(r.label, direct.label, `${what}: label`);
  assert.equal(r.confidence, direct.confidence, `${what}: confidence`);
  assert.deepEqual(r.factors, direct.factors, `${what}: factors`);
  assert.deepEqual(r.dataSourcesUsed, direct.dataSourcesUsed, `${what}: dataSourcesUsed`);
  // Same seven keys the ML path publishes — the boundary is invisible to a
  // route except through the method channel (heuristicFallback.test.js pins
  // the no-model side of this same shape).
  assert.deepEqual(Object.keys(r).sort(), [
    'confidence', 'dataSourcesUsed', 'factors', 'label',
    'modelVersion', 'predictionMethod', 'score',
  ], `${what}: response shape`);
}

// ---------------------------------------------------------------------------
// 1. The fallback ladder — every documented trigger must actually land on the
//    rule engine, honestly tagged. One test per rung.
// ---------------------------------------------------------------------------

test('rung 1 — model files missing: init resolves false, the rule engine answers as rule_engine', async () => {
  await withFreshPredictor({ hideModelFiles: true }, async (fresh) => {
    assert.equal(await fresh.init(), false);
    const venue = baselineVenue();
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assertIsRuleEngine(r, venue, WEATHER, TS, 'rule_engine', 'files missing');
    // The forecast surface falls back to the same generator wholesale.
    const f = await fresh.predictHourlyForecast(venue, WEATHER, 20, 4, TS);
    assert.deepEqual(f, crowdEngine.generateHourlyForecast(venue, WEATHER, 20, 4, TS));
  });
});

test('rung 2 — ship gate FAIL in metadata: the model is refused and the rule engine answers', async () => {
  await withFreshPredictor({
    mutateMeta: (m) => ({ ...m, ship_gate: { ...m.ship_gate, overall_pass: false, verdict: 'do_not_ship' } }),
  }, async (fresh) => {
    assert.equal(await fresh.init(), false,
      'a failing gate must refuse promotion, not shrug and load the artifact');
    const venue = baselineVenue();
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assertIsRuleEngine(r, venue, WEATHER, TS, 'rule_engine', 'gate fail');
  });
});

test('rung 3 — a trained feature with no inference twin: refused, rule engine answers', async () => {
  // A feature the training run learned but buildFeatureMap cannot produce
  // would be silently zero-filled on every prediction — confidently wrong
  // numbers, strictly worse than the rule engine. Fail closed.
  //
  // RENAMED, not appended, and that is the point of the probe: an appended
  // name also changes the width, which verifyModelShape catches on its own —
  // a renamed feature keeps every count coherent and is caught by the
  // feature-coverage gate ALONE. This is also the realistic failure: a
  // training-side rename whose inference twin never landed.
  await withFreshPredictor({
    mutateMeta: (m) => ({
      ...m,
      feature_names: ['zz_feature_with_no_inference_twin', ...m.feature_names.slice(1)],
    }),
  }, async (fresh) => {
    assert.equal(await fresh.init(), false);
    const venue = baselineVenue();
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assertIsRuleEngine(r, venue, WEATHER, TS, 'rule_engine', 'feature mismatch');
  });
});

test('rung 4 — corrupt/truncated ONNX artifact: load fails quietly, rule engine answers', async () => {
  // A truncated or corrupted .onnx surfaces as InferenceSession.create
  // rejecting (protobuf parse failure). loadModel's catch must turn that into
  // "no model", never into a rejection that 500s every prediction.
  await withFreshPredictor({
    ort: {
      InferenceSession: { create: async () => { throw new Error('Protobuf parsing failed'); } },
      Tensor: class {},
    },
  }, async (fresh) => {
    assert.equal(await fresh.init(), false);
    assert.equal(await fresh.init(), false, 'and the answer is stable');
    const venue = baselineVenue();
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assertIsRuleEngine(r, venue, WEATHER, TS, 'rule_engine', 'corrupt artifact');
  });
});

test('rung 5 — inference throwing at run(): that prediction is the rule engine as rule_engine_fallback', async () => {
  const { ort } = stubOrt(async () => { throw new Error('ORT kernel error'); });
  await withFreshPredictor({ ort }, async (fresh) => {
    assert.equal(await fresh.init(), true, 'the stub artifact loads — the failure is at run time');
    const venue = baselineVenue();
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assertIsRuleEngine(r, venue, WEATHER, TS, 'rule_engine_fallback', 'run() throws');
    // The forecast keeps answering too — every entry a real integer under a
    // real wall-clock label, none of them claiming anything.
    const f = await fresh.predictHourlyForecast(venue, WEATHER, 20, 4, TS);
    assert.equal(f.length, 4);
    for (const entry of f) {
      assert.ok(Number.isInteger(entry.score) && entry.score >= 0 && entry.score <= 100);
      assert.match(entry.hour, /^\d{1,2} (AM|PM)$/);
      assert.equal(entry.label, mlPredictor.getLabel(entry.score));
    }
  });
});

test('rung 6 — no usable baseline (delta model): rule_engine_no_baseline, pinned on the live module', async () => {
  // The shipped model is a delta model; with baseline 0 it caps at ~30 no
  // matter how packed the venue is, so the guard must answer with the rule
  // engine instead. (mlPipeline.test.js pins this too; here it feeds the
  // truthfulness sweep and anchors the malformed-row tests below.)
  assert.equal(META.label_type, 'delta');
  const venue = baselineVenue(50, { place_id: null, popular_times: undefined });
  const r = await mlPredictor.predictBusyness(venue, WEATHER, TS);
  assertIsRuleEngine(r, venue, WEATHER, TS, 'rule_engine_no_baseline', 'no baseline');
});

test('rung 7 — no weather reading and no climatology: rule_engine_no_weather_norm', async () => {
  // With no live reading the vector carries the training run's climate norm
  // (round 15). If the metadata carries no temp_norms at all there is no
  // in-distribution number to hand a model trained on `temperature` —
  // zero-filling would feed it 0°F — so the rule engine, which handles a null
  // reading honestly, must answer instead.
  await withFreshPredictor({
    mutateMeta: (m) => { const c = { ...m }; delete c.temp_norms; return c; },
  }, async (fresh) => {
    assert.equal(await fresh.init(), true, 'missing climatology does not block the load, only weatherless predictions');
    const venue = baselineVenue();
    const r = await fresh.predictBusyness(venue, null, TS);
    assertIsRuleEngine(r, venue, null, TS, 'rule_engine_no_weather_norm', 'no weather, no norms');
    // With a live reading the same model still answers as itself.
    const withWx = await fresh.predictBusyness(baselineVenue(), WEATHER, TS);
    assert.equal(withWx.predictionMethod, 'ml');
    assertContract(withWx, 'no norms but live weather');
  });
});

// ---------------------------------------------------------------------------
// 2. Malformed baseline rows — the database is an input too. A row whose
//    `baseline` column does not parse must degrade to "no baseline", and a
//    junk NEIGHBOR row must not poison a healthy current-hour value.
// ---------------------------------------------------------------------------

function baselineDb(rowsForBaselineQuery) {
  return {
    query: async (sql, params) => {
      const text = String(sql);
      // Column list left loose on purpose: getBaseline also selects `source,
      // updated_at` to publish baseline freshness, and this fake exists to
      // answer the baseline lookup, not to pin its SELECT list.
      if (/day_of_week, hour, baseline.* FROM ml_venue_baselines/.test(text)) {
        return { rows: rowsForBaselineQuery(params) };
      }
      if (/FROM venue_feedback/.test(text)) return { rows: [{}] };
      if (/FROM ml_venues v/.test(text)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('a malformed stored baseline row is "no baseline", not NaN in the score', async () => {
  // getBaseline params: [placeId, dow, hour, prevDay, prevHour, nextDay, nextHour]
  await withFreshPredictor({
    db: baselineDb((p) => [{ day_of_week: p[1], hour: p[2], baseline: 'garbage' }]),
  }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const venue = baselineVenue(50, { popular_times: undefined });
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assertIsRuleEngine(r, venue, WEATHER, TS, 'rule_engine_no_baseline', 'baseline row "garbage"');

    // NULL in the column is the other way a row goes bad.
    const venue2 = baselineVenue(50, { popular_times: undefined });
    const r2 = await fresh.predictBusyness(venue2, WEATHER, TS);
    assertIsRuleEngine(r2, venue2, WEATHER, TS, 'rule_engine_no_baseline', 'baseline row null');
  });
});

test('a numeric-string baseline row counts (pg numeric arrives as text), and junk neighbors cannot poison it', async () => {
  await withFreshPredictor({
    db: baselineDb((p) => [
      { day_of_week: p[1], hour: p[2], baseline: '60' },   // current hour, healthy
      { day_of_week: p[3], hour: p[4], baseline: 'junk' }, // prev neighbor, malformed
      { day_of_week: p[5], hour: p[6], baseline: '40' },   // next neighbor, healthy
    ]),
  }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const venue = baselineVenue(50, { popular_times: undefined });
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    // The point is WHICH engine answered: a NaN anywhere in the smoothing
    // blend would have zeroed the baseline and routed this to the rule
    // engine. 'ml' proves the malformed neighbor was absorbed, not spread.
    assert.equal(r.predictionMethod, 'ml',
      'a junk neighbor row must not take down a healthy current-hour baseline');
    assertContract(r, 'junk neighbor row');
    const [lo, hi] = META.delta_clamp_range || [-30, 30];
    // Blended baseline is 60-ish (0.6·60 + 0.2·60 + 0.2·40 = 56); the delta
    // clamp bounds how far the score can sit from it.
    assert.ok(r.score >= 56 + lo && r.score <= 56 + hi,
      `score ${r.score} outside the clamp around the blended baseline`);
  });
});

// ---------------------------------------------------------------------------
// 3. A failed load is STICKY for the life of the process — by design, and now
//    by documentation: one decision per process, no per-request disk reads or
//    load retries on the hot path. Fixing an artifact means a deploy, and a
//    deploy is a new process. Pinned so a future "helpful" retry loop is a
//    deliberate edit, not drift.
// ---------------------------------------------------------------------------

test('a failed load stays failed in this process even after the file is fixed; a new process loads it', async () => {
  await withFreshPredictor({
    mutateMeta: (m) => ({ ...m, ship_gate: { ...m.ship_gate, overall_pass: false } }),
  }, async (fresh, { unpatchFs }) => {
    assert.equal(await fresh.init(), false);
    // "Fix the file": restore the real metadata mid-process.
    unpatchFs();
    assert.equal(await fresh.init(), false,
      'the load decision is memoised per process — sticky by design (see init())');
    const venue = baselineVenue();
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assert.equal(r.predictionMethod, 'rule_engine');
  });
  // And a fresh process (fresh module instance, clean fs) promotes the same
  // artifact — the stickiness lives in memory, not on disk.
  await withFreshPredictor({}, async (fresh) => {
    assert.equal(await fresh.init(), true);
  });
});

// ---------------------------------------------------------------------------
// 4. Output hygiene — the model's own output is untrusted. A head that emits
//    NaN, nothing, infinity, or an int64 BigInt must never reach the card;
//    a finite output is clamped and rounded into the 0..100 integer contract.
// ---------------------------------------------------------------------------

test('a non-finite model output never ships: NaN, empty tensor, ±Infinity, BigInt all fall back honestly', async () => {
  let output;
  const { ort } = stubOrt(async () => ({ variable: { data: output } }));
  await withFreshPredictor({ ort }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const cases = [
      ['NaN output', [NaN]],
      ['empty output tensor', []],
      ['+Infinity output', [Infinity]],
      ['-Infinity output', [-Infinity]],
      ['int64 BigInt output', [7n]],
    ];
    for (const [what, data] of cases) {
      output = data;
      const venue = baselineVenue();
      const r = await fresh.predictBusyness(venue, WEATHER, TS);
      // Before the guard: score NaN (JSON null), label 'Very Busy',
      // predictionMethod 'ml'. Now: the rule engine, honestly tagged.
      assertIsRuleEngine(r, venue, WEATHER, TS, 'rule_engine_fallback', what);
    }
  });
});

test('a finite model output is clamped by the delta range and the 0..100 contract, then rounded', async () => {
  let output;
  const { ort } = stubOrt(async () => ({ variable: { data: output } }));
  await withFreshPredictor({ ort }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const [lo, hi] = META.delta_clamp_range;

    // A runaway positive delta: clamped to `hi`, then the score clamped to 100.
    output = [1e9];
    const high = await fresh.predictBusyness(baselineVenue(95), WEATHER, TS);
    assert.equal(high.predictionMethod, 'ml');
    assert.equal(high.score, Math.min(100, 95 + hi), 'the runaway delta must hit both clamps');
    assertContract(high, 'delta 1e9 / baseline 95');

    // A runaway negative delta: clamped to `lo`, then the floor at 0.
    output = [-1e9];
    const low = await fresh.predictBusyness(baselineVenue(5), WEATHER, TS);
    assert.equal(low.score, Math.max(0, 5 + lo), 'the negative runaway must hit the floor');
    assertContract(low, 'delta -1e9 / baseline 5');

    // Mid-baseline runaways: here the DELTA clamp binds and the 0..100 clamp
    // does not, so these two are the assertions that catch a dropped
    // delta_clamp_range specifically (at baseline 95/5 both clamps land on
    // the same number and a dropped delta clamp hides behind the outer one).
    output = [1e9];
    const midHigh = await fresh.predictBusyness(baselineVenue(50), WEATHER, TS);
    assert.equal(midHigh.score, 50 + hi, 'the delta clamp itself must bind, not just the 0..100 clamp');
    output = [-1e9];
    const midLow = await fresh.predictBusyness(baselineVenue(50), WEATHER, TS);
    assert.equal(midLow.score, 50 + lo, 'and in the negative direction too');

    // An ordinary fractional delta is rounded, not truncated and not left
    // fractional — the card renders integers.
    output = [7.4];
    const mid = await fresh.predictBusyness(baselineVenue(50), WEATHER, TS);
    assert.equal(mid.score, Math.round(50 + 7.4));
    assertContract(mid, 'delta 7.4 / baseline 50');
  });
});

// ---------------------------------------------------------------------------
// 5. Input hygiene on the REAL model — no caller-supplied garbage can poison
//    the tensor, crash the path, or produce anything outside the contract.
//    The batch endpoint scores venue objects built from request-body fields,
//    so every one of these shapes is live-reachable.
// ---------------------------------------------------------------------------

test('non-numeric strings in venue fields cannot reach the tensor as NaN', () => {
  // The reproduced bug: 'abc' is truthy, `features[name] || 0` passed it, and
  // Float32Array coerced it to NaN — price_level, rating and review_count all
  // went NaN into the model with nothing anywhere saying so.
  const venue = baselineVenue(50, {
    rating: 'abc',
    price_level: 'x',
    user_ratings_total: 'many',
  });
  const vec = mlPredictor._internals.buildFeatureVector(venue, WEATHER, TS, null, null, 50, null);
  assert.equal(vec.length, META.feature_names.length);
  for (let i = 0; i < vec.length; i++) {
    assert.ok(Number.isFinite(vec[i]),
      `feature ${META.feature_names[i]} is ${vec[i]} — a truthy non-number reached the tensor`);
  }
  // And a NUMERIC string still counts as its number, exactly as the typed
  // array would have coerced it — the fix must not turn pg's text-typed
  // numerics into zeros.
  const textNums = baselineVenue(50, { rating: '4.2', price_level: '2', user_ratings_total: '300' });
  const a = mlPredictor._internals.buildFeatureVector(textNums, WEATHER, TS, null, null, 50, null);
  const b = mlPredictor._internals.buildFeatureVector(baselineVenue(50), WEATHER, TS, null, null, 50, null);
  const ratingIdx = META.feature_names.indexOf('rating');
  assert.equal(a[ratingIdx], b[ratingIdx], 'a numeric string must score as its number');
});

test('no garbage in any venue field, weather field, or timestamp breaks the response contract', async () => {
  const garbage = [undefined, null, NaN, 'abc', '', 0, -5, {}, [], true, Infinity];
  for (const field of ['rating', 'user_ratings_total', 'price_level', 'types', 'location']) {
    for (const g of garbage) {
      const venue = baselineVenue(50, { [field]: g });
      const r = await mlPredictor.predictBusyness(venue, WEATHER, TS);
      assertContract(r, `${field}=${String(g)}`);
    }
  }
  // Garbage weather objects — hasTempReading screens the temp, the rest of
  // the fields must coerce or zero without leaking NaN into the score.
  for (const g of garbage) {
    const venue = baselineVenue();
    const r = await mlPredictor.predictBusyness(venue, { temp: g, humidity: g, windSpeed: g, isRaining: g, conditionId: g }, TS);
    assertContract(r, `weather fields=${String(g)}`);
  }
  // Garbage timestamps: Date, ISO string, invalid string, Invalid Date,
  // nothing. crowdEngine's harness pinned these for the fallback; the ML path
  // owes the caller the same tolerance.
  for (const ts of [undefined, null, 'garbage', new Date('nope'), 0, '2026-08-14T20:00:00Z', TS]) {
    const venue = baselineVenue();
    const r = await mlPredictor.predictBusyness(venue, WEATHER, ts);
    assertContract(r, `timestamp=${String(ts)}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Forecast hygiene — the hour label is a real wall-clock label whatever the
//    caller sends, and midnight wraps read off the scored timestamp.
// ---------------------------------------------------------------------------

test('an unreadable baseTimestamp is "now", never a "NaN AM" forecast', async () => {
  for (const badBase of ['garbage', new Date('nope')]) {
    const f = await mlPredictor.predictHourlyForecast(baselineVenue(), WEATHER, 20, 3, badBase);
    assert.deepEqual(f.map((e) => e.hour), ['8 PM', '9 PM', '10 PM'],
      `base=${String(badBase)}: an unreadable base timestamp must behave like an omitted one`);
    for (const e of f) {
      assert.ok(Number.isInteger(e.score) && e.score >= 0 && e.score <= 100, `score ${e.score}`);
      assert.equal(e.label, mlPredictor.getLabel(e.score));
    }
  }
});

test('the forecast crosses midnight with honest labels at the hour edges', async () => {
  const base = new Date(2026, 7, 14, 12, 0, 0, 0);
  const f = await mlPredictor.predictHourlyForecast(baselineVenue(), WEATHER, 23, 3, base);
  assert.deepEqual(f.map((e) => e.hour), ['11 PM', '12 AM', '1 AM'],
    'hour 23 -> 0 -> 1: the 12 AM/12-hour display convention at the wrap');
  const g = await mlPredictor.predictHourlyForecast(baselineVenue(), WEATHER, 0, 2, base);
  assert.deepEqual(g.map((e) => e.hour), ['12 AM', '1 AM'], 'start hour 0 is 12 AM, not 0 AM');
});
