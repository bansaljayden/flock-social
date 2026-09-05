// ---------------------------------------------------------------------------
// THE TWO-HEAD SERVING PATH (metadata.label_type === 'two_head'), pinned the
// way mlPredictorHarness.test.js pins the single-head ladder: a fresh
// mlPredictor with onnxruntime-node and fs patched at the module boundary,
// restored in `finally`.
//
// What is asserted is structure and arithmetic, never a tuned number:
//   1. the shipped artifact on disk is a delta model, so the path is
//      unreachable in production until a two_head metadata is placed in
//      models/, and the single-head path loads exactly as before;
//   2. a two_head metadata loads WITHOUT crowd_model.onnx, from profile.onnx
//      and deviation.onnx, and answers as 'ml';
//   3. score = round(clip(clip(profile, 0, 100) + clip(deviation, lo, hi),
//      0, 100)), with the deviation clamp binding on its own and the profile
//      clipped before the sum, which train/train_two_head.reconstruct_two_head
//      mirrors;
//   4. each head's vector is ordered by ITS OWN feature_names, the stored
//      baseline reaches both heads as baseline_busyness, and the profile
//      head's output reaches the deviation head as profile_pred;
//   5. a non-finite output from either head is the rule engine's answer,
//      byte for byte, tagged rule_engine_fallback;
//   6. a cold venue (no baseline) takes the same rule_engine_no_baseline exit
//      the delta model takes;
//   7. a malformed two_head declaration (a missing head, a clamp that does not
//      straddle zero, a head with no inference twin) is refused at load and
//      the rule engine answers.
//
// Run: node --test __tests__/mlTwoHeadReconstruction.test.js  (from backend/)
// ---------------------------------------------------------------------------

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

delete process.env.TICKETMASTER_API_KEY;
delete process.env.ML_SHIP_GATE_OVERRIDE;
process.env.CROWD_QMAP_ENABLED = 'false';

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');

const MOD = require.resolve('../services/mlPredictor');
const ORT = require.resolve('onnxruntime-node');
const MODEL_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'models');
const META_FILE = path.join(MODEL_DIR, 'model_metadata.json');
const META = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));

const PROFILE_FEATURE = mlPredictor._internals.TWO_HEAD_PROFILE_FEATURE;

// The candidate's feature lists, derived from the shipped vocabulary the way
// train_two_head.py derives them: a small clock-and-venue subset plus the
// stored baseline for the profile head, everything servable plus the baseline
// and the profile output for the deviation head. Sorted, as the trainer sorts.
const PROFILE_NAMES = [
  'baseline_busyness', 'category_baseline', 'day_of_week', 'hour', 'hour_cos', 'hour_sin',
  'is_dinner_hour', 'is_weekend', 'price_level', 'rating', 'refined_category_baseline',
  'venue_category_encoded',
].sort();
const DEVIATION_NAMES = [
  ...META.feature_names.filter((n) => n !== 'is_realtime'),
  'baseline_busyness', PROFILE_FEATURE,
].sort();

function twoHeadMeta(m, over = {}) {
  const union = [...new Set([...PROFILE_NAMES, ...DEVIATION_NAMES])].sort();
  return {
    ...m,
    model_version: '2.7.0-two-head-test',
    label_type: 'two_head',
    feature_names: union,
    feature_count: union.length,
    feature_types: undefined,
    two_head: {
      deviation_clamp: [-50, 50],
      profile: { file: 'profile.onnx', onnx_input_name: 'input', feature_names: PROFILE_NAMES, feature_count: PROFILE_NAMES.length },
      deviation: { file: 'deviation.onnx', onnx_input_name: 'input', feature_names: DEVIATION_NAMES, feature_count: DEVIATION_NAMES.length },
      ...over,
    },
  };
}

// A stub onnxruntime that hands back one session per head, keyed on the file
// InferenceSession.create is asked for. Each session passes verifyModelShape
// for its own width and records the vector it was run on.
function stubTwoHeadOrt(outputs) {
  const runs = { profile: [], deviation: [] };
  const session = (name, width) => ({
    inputNames: ['input'],
    outputNames: ['variable'],
    inputMetadata: [{ name: 'input', isTensor: true, type: 'float32', shape: ['', width] }],
    outputMetadata: [{ name: 'variable', isTensor: true, type: 'float32', shape: ['', 1] }],
    run: async (feeds) => {
      runs[name].push(Array.from(feeds.input.data));
      const out = typeof outputs[name] === 'function' ? outputs[name]() : outputs[name];
      return { variable: { data: out } };
    },
  });
  const ort = {
    InferenceSession: {
      create: async (p) => {
        if (/profile\.onnx$/.test(String(p))) return session('profile', PROFILE_NAMES.length);
        if (/deviation\.onnx$/.test(String(p))) return session('deviation', DEVIATION_NAMES.length);
        throw new Error(`unexpected artifact ${p}`);
      },
    },
    Tensor: class Tensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
  };
  return { ort, runs };
}

async function withFreshPredictor({ ort, mutateMeta, twoHeadFiles = true } = {}, fn) {
  const savedMod = require.cache[MOD];
  const savedOrt = require.cache[ORT];
  const realReadFileSync = fs.readFileSync;
  const realExistsSync = fs.existsSync;
  const unpatchFs = () => { fs.readFileSync = realReadFileSync; fs.existsSync = realExistsSync; };
  try {
    if (ort) require.cache[ORT] = { id: ORT, filename: ORT, loaded: true, exports: ort };
    fs.existsSync = (p) => {
      const s = String(p);
      // The two-head artifact set exists; crowd_model.onnx does NOT, which is
      // what proves the path never looks for it.
      if (/profile\.onnx|deviation\.onnx/.test(s)) return twoHeadFiles;
      if (/crowd_model\.onnx/.test(s)) return false;
      return realExistsSync(p);
    };
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
    return await fn(fresh);
  } finally {
    unpatchFs();
    delete require.cache[MOD];
    if (savedOrt) require.cache[ORT] = savedOrt; else delete require.cache[ORT];
    if (savedMod) require.cache[MOD] = savedMod;
  }
}

let seq = 0;
function baselineVenue(fill = 50, over = {}) {
  return {
    place_id: `two-head-${++seq}`,
    name: 'Two Head Venue',
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
const TS = new Date(2026, 7, 14, 20, 0, 0, 0);

function assertIsRuleEngine(r, venue, method, what) {
  const direct = crowdEngine.calculateCrowdScore(venue, WEATHER, TS);
  assert.equal(r.predictionMethod, method, `${what}: predictionMethod`);
  assert.equal(r.modelVersion, null, `${what}: modelVersion`);
  assert.equal(r.score, direct.score, `${what}: score diverged from the rule engine`);
  assert.equal(r.label, direct.label, `${what}: label`);
  assert.equal(r.confidence, direct.confidence, `${what}: confidence`);
  assert.deepEqual(r.factors, direct.factors, `${what}: factors`);
}

before(async () => {
  assert.equal(await mlPredictor.init(), true, 'the checked-in artifact must load');
});

// --- 1. unreachable under the shipped artifact ------------------------------

test('the shipped artifact is a delta model, so the two-head path is unreachable and the single head loads as before', async () => {
  assert.equal(META.label_type, 'delta');
  assert.equal(mlPredictor._internals.twoHeadState(), null,
    'no two-head state may exist while the delta artifact is loaded');
  await withFreshPredictor({}, async (fresh) => {
    // crowd_model.onnx is hidden by this harness, so the single-head path
    // must report its files missing exactly as rung 1 of the harness does.
    assert.equal(await fresh.init(), false);
    assert.equal(fresh._internals.twoHeadState(), null);
  });
});

// --- 2 + 3. the reconstruction --------------------------------------------

test('score = round(clip(clip(profile) + clamp(deviation))), each clamp binding on its own', async () => {
  const out = { profile: [60], deviation: [7.4] };
  const { ort } = stubTwoHeadOrt({ profile: () => out.profile, deviation: () => out.deviation });
  await withFreshPredictor({ ort, mutateMeta: (m) => twoHeadMeta(m) }, async (fresh) => {
    assert.equal(await fresh.init(), true, 'a two_head metadata loads from profile.onnx + deviation.onnx');
    const state = fresh._internals.twoHeadState();
    assert.ok(state, 'two-head state is set');
    assert.deepEqual(state.clamp, [-50, 50]);
    assert.equal(fresh._internals.getSession(), null, 'the single-head session is not in use');

    const cases = [
      [[60], [7.4], 67, 'ordinary fractional deviation is rounded onto the profile'],
      [[60], [1e9], 100, '60 + clamp(1e9) = 110 clips to 100'],
      [[40], [1e9], 90, '40 + 50: the deviation clamp binds, the 0..100 clamp does not'],
      [[60], [-1e9], 10, '60 - 50: the negative clamp binds'],
      [[5], [-1e9], 0, '5 - 50 clips to the floor'],
      [[120], [0], 100, 'a runaway profile is clipped before the sum'],
      [[-15], [0], 0, 'a negative profile is clipped to 0 before the sum'],
      [[120], [-30], 70, 'the profile is clipped BEFORE the deviation is added (120 -> 100, then -30)'],
      [[49.5], [0.25], 50, 'rounding happens once, on the sum'],
    ];
    for (const [p, d, expected, what] of cases) {
      out.profile = p;
      out.deviation = d;
      const r = await fresh.predictBusyness(baselineVenue(50), WEATHER, TS);
      assert.equal(r.predictionMethod, 'ml', what);
      assert.equal(r.modelVersion, '2.7.0-two-head-test', what);
      assert.equal(r.score, expected, what);
      assert.equal(r.label, fresh.getLabel(r.score), what);
      assert.equal(fresh._internals.reconstructTwoHeadScore(p[0], d[0], [-50, 50]), expected,
        `${what}: the exported reconstruction agrees with the served one`);
      assert.equal(r.baselineScore, 50, 'the stored baseline still rides along for the hour ordering');
      assert.equal(r.scoreCalibration, null, 'the v2.6.0 quantile map never applies to another version');
    }
  });
});

// --- 4. per-head vectors ------------------------------------------------------

test('each head is fed its own feature order, the baseline reaches both, and the profile output reaches the deviation head', async () => {
  const { ort, runs } = stubTwoHeadOrt({ profile: [63.25], deviation: [-4] });
  await withFreshPredictor({ ort, mutateMeta: (m) => twoHeadMeta(m) }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const r = await fresh.predictBusyness(baselineVenue(50), WEATHER, TS);
    assert.equal(r.score, Math.round(63.25 - 4));
    assert.equal(runs.profile.length, 1, 'the profile head ran once');
    assert.equal(runs.deviation.length, 1, 'the deviation head ran once');
    const pv = runs.profile[0];
    const dv = runs.deviation[0];
    assert.equal(pv.length, PROFILE_NAMES.length);
    assert.equal(dv.length, DEVIATION_NAMES.length);
    assert.equal(pv[PROFILE_NAMES.indexOf('baseline_busyness')], 50, 'profile head sees the stored baseline');
    assert.equal(dv[DEVIATION_NAMES.indexOf('baseline_busyness')], 50, 'deviation head sees the stored baseline');
    assert.equal(pv[PROFILE_NAMES.indexOf('hour')], TS.getHours());
    assert.equal(dv[DEVIATION_NAMES.indexOf('hour')], TS.getHours());
    assert.equal(dv[DEVIATION_NAMES.indexOf(PROFILE_FEATURE)], 63.25,
      'the profile head\'s raw output is the deviation head\'s profile_pred, unclipped and unrounded');
    // The same map, laid out two ways: every name the two lists share carries
    // the same value in both vectors.
    for (const name of PROFILE_NAMES) {
      const j = DEVIATION_NAMES.indexOf(name);
      if (j >= 0) assert.equal(pv[PROFILE_NAMES.indexOf(name)], dv[j], `${name} differs between the two vectors`);
    }
    for (const v of [...pv, ...dv]) assert.ok(Number.isFinite(v), 'no NaN reaches a tensor');
  });
});

// --- 5. non-finite outputs -----------------------------------------------------

test('a non-finite output from either head is the rule engine, tagged rule_engine_fallback', async () => {
  const out = { profile: [60], deviation: [0] };
  const { ort } = stubTwoHeadOrt({ profile: () => out.profile, deviation: () => out.deviation });
  await withFreshPredictor({ ort, mutateMeta: (m) => twoHeadMeta(m) }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const cases = [
      ['profile NaN', [NaN], [0]],
      ['profile empty tensor', [], [0]],
      ['profile +Infinity', [Infinity], [0]],
      ['deviation NaN', [60], [NaN]],
      ['deviation -Infinity', [60], [-Infinity]],
      ['deviation BigInt', [60], [7n]],
    ];
    for (const [what, p, d] of cases) {
      out.profile = p;
      out.deviation = d;
      const venue = baselineVenue(50);
      const r = await fresh.predictBusyness(venue, WEATHER, TS);
      assertIsRuleEngine(r, venue, 'rule_engine_fallback', what);
    }
  });
});

// --- 6. cold venues ----------------------------------------------------------------

test('a venue with no baseline takes the rule_engine_no_baseline exit under a two-head model too', async () => {
  const { ort, runs } = stubTwoHeadOrt({ profile: [60], deviation: [0] });
  await withFreshPredictor({ ort, mutateMeta: (m) => twoHeadMeta(m) }, async (fresh) => {
    assert.equal(await fresh.init(), true);
    const venue = baselineVenue(50, { popular_times: undefined, place_id: null });
    const r = await fresh.predictBusyness(venue, WEATHER, TS);
    assertIsRuleEngine(r, venue, 'rule_engine_no_baseline', 'cold venue');
    assert.equal(runs.profile.length, 0, 'neither head ran on a venue outside the profile head\'s training distribution');
  });
});

// --- 7. malformed declarations are refused at load ---------------------------------

test('a two_head metadata missing a head, with a bad clamp, with no artifact, or naming a feature with no inference twin is refused', async () => {
  const bad = [
    ['deviation head missing', (m) => { const t = twoHeadMeta(m); delete t.two_head.deviation; return t; }, true],
    ['clamp does not straddle zero', (m) => twoHeadMeta(m, { deviation_clamp: [10, 50] }), true],
    ['clamp not a pair', (m) => twoHeadMeta(m, { deviation_clamp: [-50] }), true],
    ['head file escapes the model directory', (m) => twoHeadMeta(m, {
      profile: { file: '../profile.onnx', onnx_input_name: 'input', feature_names: PROFILE_NAMES },
    }), true],
    ['profile feature with no inference twin', (m) => twoHeadMeta(m, {
      profile: { file: 'profile.onnx', onnx_input_name: 'input', feature_names: [...PROFILE_NAMES, 'zz_no_twin'].sort() },
    }), true],
    ['artifacts not on disk', (m) => twoHeadMeta(m), false],
  ];
  for (const [what, mutate, files] of bad) {
    const { ort } = stubTwoHeadOrt({ profile: [60], deviation: [0] });
    await withFreshPredictor({ ort, mutateMeta: mutate, twoHeadFiles: files }, async (fresh) => {
      assert.equal(await fresh.init(), false, `${what}: must refuse to promote`);
      assert.equal(fresh._internals.twoHeadState(), null, `${what}: no two-head state may survive a refusal`);
      const venue = baselineVenue(50);
      const r = await fresh.predictBusyness(venue, WEATHER, TS);
      assertIsRuleEngine(r, venue, 'rule_engine', what);
    });
  }
});

test('a two_head metadata whose ship gate fails is refused like any other artifact', async () => {
  const { ort } = stubTwoHeadOrt({ profile: [60], deviation: [0] });
  await withFreshPredictor({
    ort,
    mutateMeta: (m) => ({ ...twoHeadMeta(m), ship_gate: { overall_pass: false, verdict: 'do_not_ship' } }),
  }, async (fresh) => {
    assert.equal(await fresh.init(), false);
    const venue = baselineVenue(50);
    assertIsRuleEngine(await fresh.predictBusyness(venue, WEATHER, TS), venue, 'rule_engine', 'gate fail');
  });
});

test('missingTwoHeadFeatureNames exempts profile_pred and nothing else', () => {
  const { missingTwoHeadFeatureNames } = mlPredictor._internals;
  assert.deepEqual(missingTwoHeadFeatureNames(twoHeadMeta(META)), []);
  const withStranger = twoHeadMeta(META, {
    deviation: { file: 'deviation.onnx', feature_names: [...DEVIATION_NAMES, 'zz_stranger'] },
  });
  assert.deepEqual(missingTwoHeadFeatureNames(withStranger), ['zz_stranger']);
});
