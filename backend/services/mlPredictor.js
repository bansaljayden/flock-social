// ---------------------------------------------------------------------------
// ML Crowd Predictor — loads ONNX model, serves predictions
// Falls back to rule-based crowdEngine.js if model not available
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const crowdEngine = require('./crowdEngine');
// Same holiday/school-break calendar the training rows were stamped with —
// inference must use the identical definition or the feature is garbage.
const { isHoliday, isSchoolBreak } = require('../scripts/ml/config');
const { specialNightContext } = require('../scripts/ml/specialNights');
const { upstreamSignal } = require('../utils/upstream');

const MODEL_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'models');
const ONNX_PATH = path.join(MODEL_DIR, 'crowd_model.onnx');
const META_PATH = path.join(MODEL_DIR, 'model_metadata.json');

let pool = null;
try { pool = require('../config/database'); } catch (_) {}

let session = null;
let metadata = null;
let loadPromise = null;
let useML = false;

// Event cache: key = "lat,lng,YYYY-MM-DDTHH" (UTC) → { data, ts }
const eventCache = new Map();
const EVENT_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const EVENT_CACHE_MAX = 500;
// Upstream budget (round 6): the public demo builds current + 12h + 24h
// forecasts per card, and each prediction can reach Ticketmaster. Cap the
// daily fan-out here, where every prediction path converges.
let eventDayKey = new Date().toISOString().slice(0, 10);
let eventDayCount = 0;
const EVENT_DAILY_BUDGET = 1500;
function allowEventFetch() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== eventDayKey) { eventDayKey = today; eventDayCount = 0; }
  if (eventDayCount >= EVENT_DAILY_BUDGET) return false;
  eventDayCount++;
  return true;
}
// Round 17: the four event-cache writes each carried their own hand-inlined
// eviction, and two of them had it written out twice. THE DUPLICATE LINE WAS
// DEAD, not a double-eviction — the second `if` re-reads map.size, which the
// first delete has already put below the ceiling, so it never fires. (Checked,
// because the obvious reading of it is wrong and this comment is the only place
// that will say so.) What the duplication actually cost was a reader's
// confidence and four independent copies of a policy that has to match.
//
// Routing every write through the one bounded helper is what matters: the
// ceiling and the refresh-moves-to-the-back rule are now stated once, for this
// cache and the other three alike. (Declared above boundedSet is fine — this is
// only ever called at request time, long after the module body has run.)
function cacheEvents(key, data) {
  boundedSet(eventCache, key, { data, ts: Date.now() }, EVENT_CACHE_MAX);
}

// Baseline cache: key = "placeId_dow_hour" → baseline value
const baselineCache = new Map();
const BASELINE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (static data)

// User feedback cache: key = venue_place_id → { data, ts }
const feedbackCache = new Map();
const FEEDBACK_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Round 8: these maps are keyed by caller-supplied place ids/coords (the batch
// endpoint), so without a ceiling they grow forever. Oldest-first eviction —
// Map iteration order is insertion order.
//
// Round 17: DELETE THE KEY FIRST. Map.set on an existing key keeps its ORIGINAL
// position in the insertion order, so an oldest-first policy over a map that is
// refreshed in place evicts the entries that get re-read the most — exactly
// backwards, and exactly the bug services/weatherService.js setCache already
// documents finding in itself. It costs money in this file too: an evicted
// baseline or neighbour entry is another database round trip, and an evicted
// event entry is another paid Ticketmaster call.
//
// Evicting BEFORE the insert also has to account for the key already being
// present, or refreshing an entry while the map is full throws away a second,
// unrelated entry for no reason and the map settles one below its ceiling.
const PREDICTOR_CACHE_MAX = 2000;
function boundedSet(map, key, value, max = PREDICTOR_CACHE_MAX) {
  map.delete(key);
  while (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
}


// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

// Round 10: the ship gate written by scripts/ml/train/quick_eval.py was read
// by nobody — init() promoted whatever artifact was on disk. It is now
// honored, and the decision is logged at startup either way.
//
// The gate that matters is `overall_pass`, which quick_eval derives from the
// REALTIME-ONLY holdout slice: rows where the actual busyness differs from the
// popular_times baseline, i.e. the only rows where a delta model can show real
// signal. (The aggregate holdout is ~84% weekly rows where label == baseline by
// construction; its numbers are meaningless as a gate. Pre-round-10 metadata
// wrote overall_pass from those aggregate slices, which is why v2.5.0-starling
// carries overall_pass:false despite quick_eval printing "VERDICT: SHIP".)
//
// Round 11: an absent or malformed gate used to return promote:true, so any
// hand-edited, truncated or pre-gate metadata bypassed the check silently —
// exactly the case the gate exists to catch. Missing gate now FAILS closed:
// the rule engine serves and the refusal is logged at error level.
//
// Escape hatch: ML_SHIP_GATE_OVERRIDE=true promotes a failing artifact anyway,
// loudly. Intended for local debugging, not production.
function evaluateShipGate(meta) {
  const gate = meta && meta.ship_gate;
  if (!gate || typeof gate !== 'object') {
    // No verdict means nothing has verified this artifact. Do not promote it.
    return { promote: false, reason: 'no valid ship_gate in metadata — the artifact is unverified' };
  }
  if (gate.overall_pass === true) {
    const basis = gate.gate_basis || 'unspecified';
    const detail = gate.realtime_mae_improvement != null
      ? ` (realtime MAE Δ=${gate.realtime_mae_improvement}, R² Δ=${gate.realtime_r2_improvement})`
      : '';
    return { promote: true, reason: `ship gate PASS on ${basis}${detail}` };
  }
  return {
    promote: false,
    reason: `ship gate FAIL (verdict=${gate.verdict || 'unknown'}, basis=${gate.gate_basis || 'unspecified'}) — ${gate.criteria || 'no criteria recorded'}`,
  };
}

// The ONNX graph consumes POSITIONS. metadata.feature_names is the only record
// of which position means what, and metadata.feature_count is a third copy of
// the same fact — so the artifact and the file describing it can disagree, and
// until round 17 nothing compared them.
//
// Two failure shapes. If the widths differ, onnxruntime throws on EVERY
// prediction: the catch in predictBusyness swallows it into
// 'rule_engine_fallback' and the product runs on the rule engine indefinitely
// while the logs fill with one identical line per request — a total outage of
// the ML path that looks like the ML path working. If the widths happen to
// match but the ORDER does not, nothing throws at all and every number served
// is confidently wrong; the order itself is unrecoverable from the graph, but
// __tests__/mlPipeline.test.js pins feature_names against the sorted order
// prepare_features.py emits, which is the half that can be checked.
//
// Returns a list of problems; empty means the pair is coherent.
function verifyModelShape(session_, meta) {
  const problems = [];
  const names = (meta && meta.feature_names) || null;
  if (!Array.isArray(names) || names.length === 0) {
    problems.push('metadata carries no feature_names — nothing says what the model\'s columns mean');
    return problems;
  }
  if (meta.feature_count != null && meta.feature_count !== names.length) {
    problems.push(`metadata.feature_count=${meta.feature_count} but feature_names lists ${names.length} — the metadata has been hand-edited`);
  }
  const inputName = meta.onnx_input_name || 'input';
  const inputNames = (session_ && session_.inputNames) || [];
  if (inputNames.length > 0 && !inputNames.includes(inputName)) {
    problems.push(`metadata.onnx_input_name="${inputName}" is not an input of the graph (has: ${inputNames.join(', ')}) — every run() would throw`);
  }
  // inputMetadata is available from onnxruntime-node 1.20 onward; treat its
  // absence as "cannot check", never as "checked and fine".
  const md = ((session_ && session_.inputMetadata) || []).find((m) => m && m.name === inputName);
  const shape = md && Array.isArray(md.shape) ? md.shape : null;
  const width = shape ? shape[shape.length - 1] : null;
  if (typeof width === 'number' && width !== names.length) {
    problems.push(`the ONNX graph takes ${width} features but metadata.feature_names lists ${names.length} — the .onnx and the .json are from different training runs`);
  }
  // feature_types is a fourth copy of the same width and drifts the same way.
  if (Array.isArray(meta.feature_types) && meta.feature_types.length !== names.length) {
    problems.push(`metadata.feature_types has ${meta.feature_types.length} entries but feature_names has ${names.length}`);
  }
  // predictBusyness reads session.outputNames[0] and then .data[0], i.e. it
  // assumes a single-value regression head. An artifact re-exported as a
  // classifier ('label' + 'probabilities') runs without error and hands back a
  // class index that gets clamped into 0..100 and shipped as a busyness score.
  const outNames = (session_ && session_.outputNames) || [];
  if (outNames.length > 1) {
    problems.push(`the graph has ${outNames.length} outputs (${outNames.join(', ')}) — this code reads outputNames[0].data[0] and only a single-value regression head is safe to read that way`);
  }
  const outMd = ((session_ && session_.outputMetadata) || []).find((m) => m && m.name === outNames[0]);
  const outShape = outMd && Array.isArray(outMd.shape) ? outMd.shape : null;
  const outWidth = outShape && outShape.length > 1 ? outShape[outShape.length - 1] : null;
  if (typeof outWidth === 'number' && outWidth !== 1) {
    problems.push(`the graph's first output is ${outWidth} wide, not a single value`);
  }
  // A MODEL THAT CANNOT SAY HOW ACCURATE IT IS MUST NOT BE PROMOTED.
  //
  // THIS IS NO LONGER THE NUMBER USERS SEE, and the distinction matters to
  // anyone editing either check. predictBusyness used to publish this figure
  // verbatim as the card's `confidence`; it is the BLENDED population, ~80% of
  // which is weekly rows whose label equals the baseline by construction, and
  // readServedAccuracy below explains why the served slice replaced it. What this
  // check still is: an artifact-completeness check. An export that cannot state
  // its own headline accuracy is an incomplete export, whatever population that
  // headline covers, and export_model.py guarantees the key
  // (__tests__/mlExportContracts.test.js pins that guarantee against this
  // function, and __tests__/predictorCorrectness.test.js pins the rejection of
  // every malformed shape). The honesty of what gets PUBLISHED is enforced
  // separately, at load, by the readServedAccuracy gate in loadModel — deliberately
  // not folded in here, because this function's contract is coherence between
  // the .onnx and the .json, not what the payload may claim.
  const within15 = meta.training_metrics && meta.training_metrics.within_15;
  if (!(typeof within15 === 'number' && Number.isFinite(within15) && within15 > 0 && within15 <= 100)) {
    problems.push('metadata.training_metrics.within_15 is missing or unusable — an export that cannot state its own headline accuracy is incomplete (the number published to users is training_metrics_by_population.realtime_served.within_15 when the artifact carries it; see readServedAccuracy)');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// THE NUMBER ON THE VENUE CARD THAT SAYS HOW OFTEN THIS IS RIGHT.
//
// It used to be metadata.training_metrics.within_15, published verbatim. That
// figure is measured over EVERY training row, and scripts/ml/MODEL-METRICS.md
// section 2 counts what is in that population: 1,565,912 of 1,934,988 rows are
// weekly popular_times snapshots whose label EQUALS the baseline by
// construction. A delta model's correct answer on such a row is zero, and it
// gets it free. Four rows in five are that kind, so the blend is mostly a count
// of how many easy questions were on the test.
//
// The two numbers, from the same run, on the same model:
//
//   blended (all_rows)      within-15  87.3%   <- what users were told
//   realtime_served          within-15  33.3%  <- what production scores
//
// A factor of 2.6. scripts/ml/WITHIN-CITY-EVAL.md then scored the serving
// population a second way, within-city and forward in time, and got within-10
// 20.7% against the blend's 85.1% — so the gap is not an artifact of one split.
// SLOP-AUDIT.md rule 5 is "never claim what the shipping build cannot support",
// and publishing 87 when the measured figure is 33 is the largest instance of
// that in this repo.
//
// SO THIS READS THE SERVED SLICE AND NOTHING ELSE. The trainer writes
// training_metrics_by_population with three keys (all_rows, realtime_served,
// weekly_anchor); realtime_served is `is_realtime == 1 AND baseline > 0`, the
// same serving_population_mask prepare_features filters training with and
// quick_eval.py gates on, and it is the predicate this file's own no-baseline
// guard enforces at request time. It is therefore the population predictBusyness
// is actually asked to score, not an approximation of it.
//
// THREE STATES, AND THE MIDDLE ONE IS THE POINT.
//
//   measured    the slice is there and usable -> publish it, say what it is
//   unmeasured  no slice at all (every artifact exported before 2026-08-15,
//               including models/incumbent/model_metadata.json, which is what
//               production runs) -> LOAD ANYWAY, and say the accuracy is
//               unmeasured instead of quoting the blend
//   malformed   a slice that exists but is garbage (a string, NaN, out of
//               range, a row count of zero) -> refuse at load, fail closed
//
// WHY `unmeasured` LOADS, written down because the first version of this change
// refused it and that was wrong. Refusing an artifact does not merely drop the
// delta layer — it unloads this whole module, and getBaseline with it. The
// per-venue curves in ml_venue_baselines (the ones migration 023 put back on the
// venue-local clock) are the good layer: KOME in Lehigh reads 65 at 6 PM off its
// own measured curve, and crowdEngine's generic restaurant category prior is
// what answers instead. So the cost of refusing is not WITHIN-CITY-EVAL's +0.3
// points of within-10; it is every venue in the corpus falling back to a
// category shape. That is a large, user-visible downgrade, and shipping it to
// fix a LABEL would be trading a real regression for a copy fix.
//
// The label is fixable without it. An old artifact still serves its baselines;
// it just does not get to call anything an accuracy. See predictBusyness: the
// published `confidence` for an unmeasured artifact is crowdEngine's own
// input-completeness ladder, the same number and the same meaning the rule
// engine publishes for the same venue, and confidenceMeasurement.means says
// 'input_completeness' so nothing downstream can mistake it for a hit rate.
//
// Malformed still fails closed, because garbage in this field is not an older
// honest artifact, it is a broken write, and refusing it is how every other gate
// in this file behaves.
function readServedAccuracy(meta) {
  const byPop = meta && meta.training_metrics_by_population;
  // Absent: an artifact from a trainer that did not report per-population
  // metrics. Nothing is wrong with it; it simply cannot state this number.
  if (byPop === undefined || byPop === null) {
    return { status: 'unmeasured', reason: 'metadata carries no training_metrics_by_population' };
  }
  if (typeof byPop !== 'object' || Array.isArray(byPop)) {
    return { status: 'malformed', reason: 'training_metrics_by_population is not an object' };
  }

  const served = byPop.realtime_served;
  if (served === undefined || served === null) {
    return { status: 'unmeasured', reason: 'training_metrics_by_population carries no realtime_served slice' };
  }
  // Present but not a metrics block: a broken write, not an old artifact.
  if (typeof served !== 'object' || Array.isArray(served)) {
    return { status: 'malformed', reason: 'training_metrics_by_population.realtime_served is not an object' };
  }

  const percent = served.within_15;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return {
      status: 'malformed',
      reason: `realtime_served.within_15 is ${JSON.stringify(percent)}, which is not a percentage`,
    };
  }

  // A percentage measured over no rows is not a measurement. `rows` absent is
  // tolerated (nothing is claimed about the sample size); `rows` present and
  // not a positive count means the slice was computed over an empty or
  // nonsensical population, which is worse than silence.
  let rows = null;
  if (served.rows != null) {
    const n = Number(served.rows);
    if (!Number.isInteger(n) || n <= 0) {
      return {
        status: 'malformed',
        reason: `realtime_served.rows is ${JSON.stringify(served.rows)}, so the percentage above it was measured over nothing`,
      };
    }
    rows = n;
  }

  return { status: 'measured', percent, metric: 'within_15', population: 'realtime_served', rows };
}

// Concurrency: init() used to flip a `loadAttempted` flag SYNCHRONOUSLY and only
// then await InferenceSession.create(). Everything before that await is
// synchronous, so a second caller entering during the load saw the flag already
// set, read `useML` while it was still false, and was told there is no model.
// On a Railway cold boot — or the public demo scoring twenty venues in one
// Promise.all — that meant some venues on one screen were scored by the model
// and the rest by the rule engine, with nothing anywhere saying so. Callers now
// share the load promise, so the answer is "wait", not "no".
//
// AND THE PROMISE MUST NEVER REJECT. Found re-auditing this fix: memoising a
// promise converts a ONE-TIME failure into a PERMANENT one. `await init()` sits
// OUTSIDE the try/catch in both predictBusyness and predictHourlyForecast, so a
// stored rejection would reject every prediction for the life of the process —
// routes/crowd.js turns that into a 500 and the card renders nothing, where the
// old code merely degraded to the rule engine once. loadModel's own try/catch
// does not cover the fs.existsSync calls that precede it, so this is reachable
// (an unreadable model volume), not theoretical.
//
// STICKY BY DESIGN: the settled promise is kept for the life of the process,
// so a failed load (missing files, gate refusal, corrupt artifact) is decided
// ONCE and every later prediction takes the rule engine without re-reading
// disk or re-attempting InferenceSession.create per request — the alternative
// is a load-retry storm on the hottest path in the API. Fixing the artifact
// on disk therefore requires a process restart, which is how an artifact gets
// fixed anyway (a deploy). Pinned in __tests__/mlPredictorHarness.test.js.
function init() {
  if (!loadPromise) {
    loadPromise = loadModel().catch((err) => {
      console.warn('[MLPredictor] Model load threw, serving rule engine:', err.message);
      session = null;
      metadata = null;
      useML = false;
      return false;
    });
  }
  return loadPromise;
}

async function loadModel() {
  if (!fs.existsSync(ONNX_PATH) || !fs.existsSync(META_PATH)) {
    console.log('[MLPredictor] Model files not found — using rule engine');
    return false;
  }

  try {
    const ort = require('onnxruntime-node');
    const candidate = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    const version = candidate.model_version || '?';
    const gate = evaluateShipGate(candidate);
    const overridden = !gate.promote && process.env.ML_SHIP_GATE_OVERRIDE === 'true';

    if (!gate.promote && !overridden) {
      console.error(`[MLPredictor] REFUSING to promote model v${version}: ${gate.reason}. Serving rule engine instead. Set ML_SHIP_GATE_OVERRIDE=true to force promotion.`);
      return false;
    }
    if (overridden) {
      console.warn(`[MLPredictor] ML_SHIP_GATE_OVERRIDE=true — promoting model v${version} despite: ${gate.reason}`);
    }

    metadata = candidate;

    // Round 13: feature-coverage parity check. Any trained feature that this
    // file cannot compute would be silently zero-filled on EVERY prediction —
    // confidently wrong numbers with no error anywhere. That is strictly worse
    // than the rule engine, so it fails closed (same override hatch as the
    // ship gate, for local debugging of a half-migrated feature set).
    const missing = missingFeatureNames(candidate);
    if (missing.length > 0 && process.env.ML_SHIP_GATE_OVERRIDE !== 'true') {
      console.error(`[MLPredictor] REFUSING to promote model v${version}: ${missing.length} trained feature(s) have no inference-side implementation and would be silently zero-filled: ${missing.join(', ')}. Serving rule engine instead.`);
      metadata = null;
      return false;
    }
    if (missing.length > 0) {
      console.warn(`[MLPredictor] ML_SHIP_GATE_OVERRIDE=true — promoting despite ${missing.length} missing feature(s): ${missing.join(', ')}`);
    }

    // Confidence honesty gate. This one refuses GARBAGE only: a served slice
    // that exists and cannot be read is a broken write, and a broken artifact
    // is refused here exactly like a broken graph. An artifact that never had
    // the slice is not broken and still loads — it keeps serving ml_venue_baselines,
    // which is the layer users feel, and gives up only the right to call
    // anything an accuracy (see readServedAccuracy and predictBusyness).
    const served = readServedAccuracy(candidate);
    if (served.status === 'malformed' && process.env.ML_SHIP_GATE_OVERRIDE !== 'true') {
      console.error(`[MLPredictor] REFUSING to promote model v${version}: ${served.reason}. That field is the accuracy published to users; a malformed one is a broken export, not an old artifact. Serving rule engine instead.`);
      metadata = null;
      return false;
    }
    if (served.status === 'malformed') {
      console.warn(`[MLPredictor] ML_SHIP_GATE_OVERRIDE=true — promoting v${version} despite a malformed served-accuracy slice (${served.reason}); predictions will fall back per request rather than publish it.`);
    }

    const loaded = await ort.InferenceSession.create(ONNX_PATH);

    // Round 17: artifact/metadata coherence. See verifyModelShape — a mismatch
    // is either an ML outage disguised as a working product or a silently
    // wrong vector, so it fails closed like the two gates above.
    const shapeProblems = verifyModelShape(loaded, metadata);
    if (shapeProblems.length > 0 && process.env.ML_SHIP_GATE_OVERRIDE !== 'true') {
      console.error(`[MLPredictor] REFUSING to promote model v${version}: the ONNX artifact and its metadata disagree — ${shapeProblems.join('; ')}. Serving rule engine instead.`);
      metadata = null;
      return false;
    }
    if (shapeProblems.length > 0) {
      console.warn(`[MLPredictor] ML_SHIP_GATE_OVERRIDE=true — promoting despite artifact/metadata drift: ${shapeProblems.join('; ')}`);
    }

    session = loaded;
    useML = true;
    console.log(`[MLPredictor] Loaded ONNX model v${version} (${metadata.best_model || '?'}, ${metadata.feature_count || '?'} features) — ${overridden ? 'gate overridden' : gate.reason}`);
    // BOTH NUMBERS, ONCE, WHERE AN OPERATOR CAN SEE THEM. The training report,
    // the retrain runbook and every earlier version of this file quote the
    // blended figure, so an operator who reads the logs and then reads a card
    // would otherwise have no way to know why they disagree. This line says
    // which one is published and why the other is not.
    if (served.status === 'measured') {
      console.log(`[MLPredictor] confidence published = ${served.percent}% (${served.metric} on ${served.population}${served.rows ? `, ${served.rows} rows` : ''}). The blended training_metrics figure ${metadata.training_metrics?.within_15}% is NOT published: ~80% of those rows are weekly anchors whose label equals the baseline by construction.`);
    } else {
      console.warn(`[MLPredictor] v${version} reports no usable served-population accuracy (${served.reason}). The model still serves, including its per-venue baselines. No accuracy figure will be published: \`confidence\` carries crowdEngine's input-completeness ladder and confidenceMeasurement.status says 'unmeasured'. Re-export from a training run that writes training_metrics_by_population to publish a real one.`);
    }
    return true;
  } catch (err) {
    console.warn('[MLPredictor] Failed to load model:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Baseline Lookup (from precomputed ml_venue_baselines table)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE `hour` COLUMN OF ml_venue_baselines IS NOT A VENUE-LOCAL HOUR, AND THIS
// FUNCTION LOOKS IT UP AS THOUGH IT WERE. Found 2026-08-14 chasing a user
// report of a well-known dinner restaurant reading ~20% at 6 PM.
//
// THE WRITE SIDE. scripts/ml/collectWeekly.js iterates BestTime's `day_raw`
// array and writes the ARRAY INDEX into ml_training_data.hour:
//
//     for (let hour = 0; hour < day.hours.length && hour < 24; hour++) {
//       const busyness = day.hours[hour];        // day.hours = day.day_raw
//       ... venue.id, jsDayOfWeek, hour, ...
//
// BestTime's day_raw does not start at midnight — its day runs 06:00 to 05:59,
// so day_raw[0] is the venue's 6 AM and day_raw[18] is the venue's MIDNIGHT.
// scripts/ml/buildBaselines.js then copies that column verbatim into
// ml_venue_baselines.hour. So the stored key is a bucket index:
//
//     stored_hour = (venue_local_hour - 6) mod 24
//
// THE PROOF, from the shipped artifact rather than from the vendor's docs.
// scripts/ml/models/model_metadata.json carries category_baselines derived from
// the same column. Read literally they are impossible: restaurants peak at
// 12:00-14:00 every day of the week and bottom out at midnight; bars peak at
// 13:00-15:00; nightclubs peak at 17:00 and are emptiest at 00:00; gyms peak at
// noon. Add six hours and every one of them lands where it belongs —
// restaurants 18:00-20:00, bars 19:00-21:00, nightclubs 22:00-23:00, gyms
// 18:00, museums 14:00, and every trough at 04:00-07:00. 84 of the 91
// (category, day) peaks fall in stored buckets 6..15, i.e. local noon to 9 PM.
// __tests__/dinnerPeakAccuracy.test.js pins that arithmetic.
//
// WHAT IT COSTS. This model is `label_type: 'delta'`: predictBusyness returns
// baseline + clamp(delta, ±30), so the baseline IS the answer and the model
// only nudges it. A 6 PM request reads stored slot 18, which holds the venue's
// LOCAL MIDNIGHT busyness. For a restaurant the shipped corpus average at that
// slot is 45 against 60 for the true 6 PM slot and 65 at the real dinner peak —
// and a single venue that genuinely empties out overnight reads far lower than
// any of those. That is exactly the reported symptom: a dinner venue reading a
// small-hours number at dinner.
//
// WHY THIS IS NOT FIXED HERE, and it is a deliberate refusal rather than an
// oversight. The obvious patch is to shift the lookup by six. It is wrong,
// because the corpus does not have ONE clock:
//   * scripts/ml/collectWeekly.js writes the BestTime bucket index (above);
//   * scripts/ml/collectRealtime.js writes `local.hour` from
//     config.getLocalTime(tz) — the TRUE venue-local hour;
//   * scripts/ml/collectRealtime.js's baseline refresh has no
//     `collection_mode` filter at all (`WHERE t.busyness_pct IS NOT NULL`), so
//     it averages both conventions into the same slot, while
//     buildBaselines.js filters to `collection_mode = 'weekly'`. Which blend a
//     row holds depends on which script ran last.
//   * collectRealtime also stamps each realtime row's baseline_busyness by
//     looking weekly rows up at `local.hour`, so the DELTA LABEL the model was
//     trained on was itself computed against a slot six hours off.
// The trained weights therefore sit on a mixed axis. No shift applied here is
// right for both halves, and there is no holdout on this side to check a guess
// against — shifting the read would be changing served numbers on an
// unverifiable hunch, which is how this class of bug got here.
//
// WHAT ACTUALLY FIXES IT (needs a decision + a retrain, not a serving patch):
//   1. collectWeekly.js: write `(index + 6) % 24` as the hour, and roll the day
//      forward for indices >= 18 (BestTime day D covers local D 06:00 to D+1
//      05:59).
//   2. Backfill ml_training_data for collection_mode = 'weekly' with the same
//      transform, then rebuild ml_venue_baselines.
//   3. Give collectRealtime.js's baseline refresh the same
//      `collection_mode = 'weekly'` filter buildBaselines.js has, so the two
//      writers stop disagreeing.
//   4. Retrain. Until then every ml_venue_baselines-anchored number is on an
//      axis nobody can vouch for.
// Until step 4 lands, routes/crowd.js publishes the provenance of every number
// it serves (see crowdEngine.describePredictionSupport) so a wrong one is at
// least legible instead of being asserted as a measurement.
// ---------------------------------------------------------------------------
async function getBaseline(placeId, dayOfWeek, hour) {
  if (!pool || !placeId) return 0;

  const cacheKey = `${placeId}_${dayOfWeek}_${hour}`;
  const cached = baselineCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < BASELINE_CACHE_TTL) return cached.data;

  try {
    // Fetch current hour + neighbors for smoothing
    const prevHour = (hour - 1 + 24) % 24;
    const nextHour = (hour + 1) % 24;
    const prevDay = prevHour === 23 ? (dayOfWeek - 1 + 7) % 7 : dayOfWeek;
    const nextDay = nextHour === 0 ? (dayOfWeek + 1) % 7 : dayOfWeek;

    const { rows } = await pool.query(
      `SELECT day_of_week, hour, baseline FROM ml_venue_baselines
       WHERE google_place_id = $1 AND (
         (day_of_week = $2 AND hour = $3) OR
         (day_of_week = $4 AND hour = $5) OR
         (day_of_week = $6 AND hour = $7)
       )`,
      [placeId, dayOfWeek, hour, prevDay, prevHour, nextDay, nextHour]
    );

    if (rows.length === 0) {
      boundedSet(baselineCache, cacheKey, { data: 0, ts: Date.now() });
      return 0;
    }

    // Weighted average: current hour 60%, neighbors 20% each
    let current = 0, prev = 0, next = 0;
    let hasCurrent = false;
    for (const r of rows) {
      const val = parseInt(r.baseline);
      if (r.day_of_week === dayOfWeek && r.hour === hour) { current = val; hasCurrent = true; }
      else if (r.hour === prevHour) prev = val;
      else if (r.hour === nextHour) next = val;
    }

    if (!hasCurrent) {
      boundedSet(baselineCache, cacheKey, { data: 0, ts: Date.now() });
      return 0;
    }

    // Smooth: blend with neighbors if available
    const hasNeighbors = prev > 0 || next > 0;
    const val = hasNeighbors
      ? Math.round(current * 0.6 + (prev || current) * 0.2 + (next || current) * 0.2)
      : current;

    boundedSet(baselineCache, cacheKey, { data: val, ts: Date.now() });
    return val;
  } catch (err) {
    console.error('[MLPredictor] Baseline lookup failed:', err.message);
    return 0;
  }
}

// Store Google popular_times as baselines on first encounter
async function storeGoogleBaselines(placeId, popularTimes) {
  if (!pool || !placeId || !popularTimes || !Array.isArray(popularTimes)) return;
  try {
    for (const day of popularTimes) {
      const dow = day.day != null ? day.day : null;
      const hours = day.data || day.hours || [];
      if (dow == null || !hours.length) continue;
      for (let h = 0; h < hours.length && h < 24; h++) {
        const val = hours[h];
        if (val == null) continue;
        await pool.query(
          `INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source)
           VALUES ($1, $2, $3, $4, 'google')
           ON CONFLICT (google_place_id, day_of_week, hour) DO NOTHING`,
          [placeId, dow, h, Math.max(0, Math.min(100, Math.round(val)))]
        );
      }
    }
  } catch (err) {
    console.error('[MLPredictor] Store Google baselines failed:', err.message);
  }
}

// Read the current dow/hour baseline straight out of a venue's Google
// popular_times payload, so the FIRST request for a venue can use the ML
// model instead of waiting for storeGoogleBaselines() to land for next time.
function baselineFromPopularTimes(popularTimes, dayOfWeek, hour) {
  if (!popularTimes || !Array.isArray(popularTimes)) return 0;
  for (const day of popularTimes) {
    const dow = day.day != null ? day.day : null;
    if (dow !== dayOfWeek) continue;
    const hours = day.data || day.hours || [];
    const val = hours[hour];
    if (val == null) return 0;
    return Math.max(0, Math.min(100, Math.round(val)));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// User Feedback Lookup
// ---------------------------------------------------------------------------

async function getUserFeedback(placeId) {
  const noFeedback = { avgCrowd: 0, count: 0, avgErrorMapped: 0, avgErrorLegacy: 0 };
  if (!pool || !placeId) return noFeedback;

  const cached = feedbackCache.get(placeId);
  if (cached && Date.now() - cached.ts < FEEDBACK_CACHE_TTL) return cached.data;

  try {
    const { rows } = await pool.query(
      `SELECT
        AVG(crowd_level)::numeric(4,1) AS avg_crowd,
        COUNT(*)::int AS count,
        -- Two variants of the feedback-error feature. 'mapped' (20/50/80 minus
        -- score, one scale) is the sane definition and what the training
        -- export now emits; 'legacy' (raw ordinal minus score) is what models
        -- trained before round 3 — including shipped v2.5-starling — actually
        -- saw. Feature assembly picks by model metadata so inference always
        -- matches the checked-in model's training distribution.
        AVG((CASE crowd_level WHEN 1 THEN 20 WHEN 2 THEN 50 ELSE 80 END) - predicted_score)::numeric(5,2) AS avg_error_mapped,
        AVG(crowd_level - predicted_score)::numeric(5,2) AS avg_error_legacy
      -- verified only: unverified rows are stored for product UX but must not
      -- move live predictions (round 6 — the round-5 filters missed this one)
      FROM venue_feedback WHERE venue_place_id = $1 AND verified = true`,
      [placeId]
    );
    const r = rows[0];
    const result = {
      avgCrowd: parseFloat(r?.avg_crowd) || 0,
      count: parseInt(r?.count) || 0,
      avgErrorMapped: parseFloat(r?.avg_error_mapped) || 0,
      avgErrorLegacy: parseFloat(r?.avg_error_legacy) || 0,
    };
    boundedSet(feedbackCache, placeId, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    console.error('[MLPredictor] Feedback lookup failed:', err.message);
    return noFeedback;
  }
}

// ---------------------------------------------------------------------------
// Feature Engineering (mirrors prepare_features.py)
// ---------------------------------------------------------------------------

function getLabel(score) {
  if (score <= 20) return 'Quiet';
  if (score <= 40) return 'Not Busy';
  if (score <= 60) return 'Moderate';
  if (score <= 80) return 'Busy';
  return 'Very Busy';
}

function groupWeatherCode(code) {
  if (!code && code !== 0) return 'unknown';
  const c = Number(code);
  if (c >= 200 && c <= 232) return 'thunderstorm';
  if ((c >= 300 && c <= 321) || (c >= 500 && c <= 501)) return 'light_rain';
  if (c >= 502 && c <= 531) return 'heavy_rain';
  if (c >= 600 && c <= 622) return 'snow';
  if (c === 800) return 'clear';
  if (c >= 801 && c <= 802) return 'few_clouds';
  if (c >= 803 && c <= 804) return 'cloudy';
  return 'other';
}

// ---------------------------------------------------------------------------
// Live Ticketmaster Event Lookup
// ---------------------------------------------------------------------------

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function mapTmEventType(classifications) {
  if (!classifications || !classifications.length) return 'other';
  const seg = (classifications[0].segment?.name || '').toLowerCase();
  if (seg.includes('music')) return 'music';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre')) return 'arts';
  if (seg.includes('family')) return 'family';
  return 'other';
}

// THIS MUST STAY BYTE-FOR-BYTE EQUIVALENT TO
// scripts/ml/collectEvents.js estimateAttendance(), which is the function that
// produced `estimated_attendance` for every event row in the corpus. Four
// features are derived from the number it returns (nearest_event_attendance,
// its log, total_nearby_attendance and its log) plus the binary
// large_event_nearby, so a serving-side estimator that has drifted from the
// collector labels the same Ticketmaster payload with one number at training
// time and a different one at prediction time.
//
// Round 17: it had drifted, by four branches, all of them downward:
//   * the arena vocabulary had lost "garden" and "field", so a concert at
//     Madison Square Garden estimated 500 instead of 20,000;
//   * music at a theatre (3,000) had no branch and fell to 500;
//   * arts (1,500) and family (1,000) both collapsed to the 500 default.
// The user-visible half of that: `eventAlert` on the venue card fires at
// >5,000 attendance, so a Garden or arena show — exactly the event a person
// wants to be warned about — could never raise the banner.
function estimateTmAttendance(event) {
  const venues = event._embedded?.venues || [];
  for (const v of venues) {
    const cap = parseInt(v.generalInfo?.capacity, 10) ||
                parseInt(v.boxOfficeInfo?.capacity, 10) || 0;
    if (cap > 0) return cap;
  }
  const venueName = (venues[0]?.name || '').toLowerCase();
  const isArena = venueName.includes('arena') || venueName.includes('stadium') ||
                  venueName.includes('center') || venueName.includes('centre') ||
                  venueName.includes('garden') || venueName.includes('field');
  const type = mapTmEventType(event.classifications);
  if (type === 'sports') return isArena ? 25000 : 5000;
  if (type === 'music') {
    if (isArena) return 20000;
    if (venueName.includes('theater') || venueName.includes('theatre')) return 3000;
    return 500;
  }
  if (type === 'arts') return 1500;
  if (type === 'family') return 1000;
  return 500;
}

// Round 13 (timezone): callers pass a "venue wall clock encoded in server
// time" Date (crowd.js builds clientTime with weekdayOffset + setHours so
// .getHours()/.getDay() read venue-local — that is the feature contract).
// But the Ticketmaster query window is built with .toISOString(), which
// treats that fake Date as a real instant: on a UTC server, "8 PM in Tokyo"
// was queried as 20:00Z — 5 AM Tokyo, up to a half-day off. Same
// wall-clock-vs-instant confusion family as the crowd card's six-day bug.
// When the venue carries Google's utcOffsetMinutes we can recover the true
// instant: wallFields = fake read in server tz, so
//   trueEpoch = fakeEpoch − (serverOffsetWestMin + venueOffsetEastMin) · 60s
// (getTimezoneOffset is west-positive, utcOffsetMinutes east-positive).
// Without an offset we keep the old behavior — wrong-window events are still
// better than none, and most callers with real venues do have the offset.
function trueEventInstant(timestamp, utcOffsetMinutes) {
  const ts = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(ts.getTime())) return ts;
  const off = Number(utcOffsetMinutes);
  if (utcOffsetMinutes == null || Number.isNaN(off)) return ts;
  return new Date(ts.getTime() - (ts.getTimezoneOffset() + off) * 60 * 1000);
}

async function getNearbyEvents(lat, lng, timestamp) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  const noEvents = {
    hasEvent: false, nearestAttendance: 0, totalEvents: 0,
    totalAttendance: 0, nearestType: null, nearestDistance: 0,
    nearestName: null,
  };
  if (!apiKey || !lat || !lng) return noEvents;

  // Round 10: the key used to be hour-only, so the 6-day owner forecast served
  // day 1's events for every future date — the upstream query window is built
  // from the full timestamp (startDateTime/endDateTime), so the key has to
  // carry the date too. UTC "YYYY-MM-DDTHH" matches the request window exactly.
  const keyTs = timestamp ? new Date(timestamp) : new Date();
  const slot = Number.isNaN(keyTs.getTime())
    ? new Date().toISOString().slice(0, 13)
    : keyTs.toISOString().slice(0, 13);
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${slot}`;
  const cached = eventCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < EVENT_CACHE_TTL) return cached.data;
  // Budget applies only to cache MISSES (real upstream calls).
  if (!allowEventFetch()) return noEvents;

  try {
    const ts = timestamp ? new Date(timestamp) : new Date();
    const startDt = ts.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const endTs = new Date(ts.getTime() + 3 * 60 * 60 * 1000);
    const endDt = endTs.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: `${lat},${lng}`,
      radius: '2',
      unit: 'km',
      startDateTime: startDt,
      endDateTime: endDt,
      size: '20',
      sort: 'date,asc',
    });

    // Round 12: event enrichment sits on the crowd-prediction path — without a
    // deadline a slow Ticketmaster held every scored request open. The catch
    // below already degrades to "no events". See utils/upstream.js.
    const response = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params}`,
      { signal: upstreamSignal('ticketmaster') }
    );

    if (!response.ok) {
      cacheEvents(cacheKey, noEvents);
      return noEvents;
    }

    const data = await response.json();
    const events = data._embedded?.events || [];

    if (events.length === 0) {
      cacheEvents(cacheKey, noEvents);
      return noEvents;
    }

    // ONE POPULATION, COUNTED ONCE. scripts/ml/enrichWithEvents.js builds the
    // training values by filtering to DISTANCE_THRESHOLD_KM = 2 and then
    // deriving total_nearby_events AND total_nearby_attendance from the same
    // surviving list. Round 17: this counted `events.length` — everything
    // Ticketmaster returned, including entries with no coordinates at all and
    // whatever the vendor's own radius interpretation let through — while
    // summing attendance over a strictly smaller set. So the two features
    // described different populations, and total_nearby_events was inflated
    // relative to every row the model was trained on.
    const NEARBY_KM = 2; // enrichWithEvents.DISTANCE_THRESHOLD_KM
    let nearestDist = Infinity;
    let nearestEvent = null;
    let totalAttendance = 0;
    let totalNearby = 0;

    for (const e of events) {
      const eLat = parseFloat(e._embedded?.venues?.[0]?.location?.latitude) || 0;
      const eLng = parseFloat(e._embedded?.venues?.[0]?.location?.longitude) || 0;
      // An event we cannot place is an event we cannot say is nearby.
      if (!eLat || !eLng) continue;

      const dist = distanceKm(lat, lng, eLat, eLng);
      if (dist > NEARBY_KM) continue;

      const attendance = estimateTmAttendance(e);
      totalNearby++;
      totalAttendance += attendance;

      if (dist < nearestDist) {
        nearestDist = dist;
        nearestEvent = { name: e.name, type: mapTmEventType(e.classifications), attendance };
      }
    }

    const result = nearestEvent ? {
      hasEvent: true,
      nearestAttendance: nearestEvent.attendance,
      totalEvents: totalNearby,
      totalAttendance,
      nearestType: nearestEvent.type,
      nearestDistance: Math.round(nearestDist * 100) / 100,
      nearestName: nearestEvent.name,
    } : noEvents;

    cacheEvents(cacheKey, result);
    return result;
  } catch (err) {
    console.error('[MLPredictor] Event lookup failed:', err.message);
    cacheEvents(cacheKey, noEvents);
    return noEvents;
  }
}

// ---------------------------------------------------------------------------
// Feature Engineering (mirrors prepare_features.py)
// ---------------------------------------------------------------------------

// v2.4 astronomy — the SAME closed-form mid-month solar approximation as
// prepare_features.py add_astronomy_features (parity by construction).
function astronomyFeatures(lat, month, hour) {
  const doy = month * 30.4 - 15.2;
  const decl = -23.44 * Math.cos((Math.PI / 180) * (360 / 365) * (doy + 10));
  const latC = Math.max(-65, Math.min(65, lat || 0));
  let x = -Math.tan(latC * Math.PI / 180) * Math.tan(decl * Math.PI / 180);
  x = Math.max(-1, Math.min(1, x));
  const daylight = (2 * (Math.acos(x) * 180 / Math.PI)) / 15;
  const sunsetHour = 12 + daylight / 2;
  const hh = hour < 5 ? hour + 24 : hour; // 1 AM belongs to the evening
  const afterSunset = Math.max(-8, Math.min(12, hh - sunsetHour));
  return { daylight_hours: daylight, hours_after_sunset: afterSunset, is_after_sunset: afterSunset > 0 ? 1 : 0 };
}

// v2.4 neighbor activity — same quantity the training pipeline computes
// (mean same-hour baseline of venues within ~1km, excluding self), served
// from ml_venues + ml_venue_baselines.
// PERF: cached per LOCATION with all dow/hour slots fetched in ONE query.
// The first version keyed the cache by (location, dow, hour), so a single
// venue view (now + 12h + 24h forecasts = ~37 predictions at different
// hours) fired ~37 sequential SQL round trips — the "10 seconds to load a
// venue" bug. Now it's one query per venue per 24h.
const neighborCache = new Map();
async function getNeighborActivity(placeId, lat, lng, dayOfWeek, hour) {
  const none = { count: 0, mean: 0 };
  if (!pool || !lat || !lng) return none;
  const key = `${(+lat).toFixed(3)}_${(+lng).toFixed(3)}_${placeId || ''}`;
  let entry = neighborCache.get(key);
  if (!entry || Date.now() - entry.ts >= 24 * 60 * 60 * 1000) {
    try {
      const r = await pool.query(
        `SELECT b.day_of_week AS dow, b.hour, COUNT(*)::int AS cnt, COALESCE(AVG(b.baseline), 0) AS mean_bl
         FROM ml_venues v
         JOIN ml_venue_baselines b ON b.google_place_id = v.google_place_id
         WHERE v.latitude BETWEEN $1 - 0.0075 AND $1 + 0.0075
           AND v.longitude BETWEEN $2 - 0.0075 AND $2 + 0.0075
           AND ($3::text IS NULL OR v.google_place_id != $3)
         GROUP BY b.day_of_week, b.hour`,
        [lat, lng, placeId || null]
      );
      const byDowHour = new Map();
      for (const row of r.rows) {
        byDowHour.set(`${row.dow}_${row.hour}`, {
          count: row.cnt,
          mean: Math.max(0, Math.min(100, parseFloat(row.mean_bl) || 0)),
        });
      }
      entry = { ts: Date.now(), byDowHour };
      boundedSet(neighborCache, key, entry);
    } catch {
      return none;
    }
  }
  return entry.byDowHour.get(`${dayOfWeek}_${hour}`) || none;
}

// ---------------------------------------------------------------------------
// A WEATHER OUTAGE MUST NOT BECOME A FABRICATED READING (round 15).
//
// services/weatherService.js returns null when it has no reading — that is its
// documented FAILURE CONTRACT, and the rule engine reads it honestly:
// getWeatherFactor contributes 0, 'weather' is left out of dataSourcesUsed, and
// confidence drops by the 15 points a live reading is worth. This file did the
// opposite: `weather?.temp ?? 20`. weatherService fetches units=imperial, and
// every training row was collected through that same function, so 20 meant
// 20°F. Every prediction made during a weather outage was told the venue was
// below freezing, which is exactly the confident-wrong-number failure the
// feature-parity gate exists to prevent — and it shipped on the ML path, the
// one that actually serves.
//
// WHY A CLIMATE NORM AND NOT A SENTINEL. The model has never seen "missing".
// prepare_features.add_weather_features() imputes a null temperature with the
// city-month median and then the global median before training, so
// `temperature` is always an ordinary number inside the training distribution;
// there is no NaN, no -999 and no 0 for the model to recognise as absence. A
// sentinel would therefore be a value it has never been shown, and 0 would be
// a second, colder lie. The train-consistent substitute is the CLIMATE NORM for
// this venue's latitude band and month — the `temp_norms` table the training
// run itself saved into metadata, and precisely what add_climate_anomaly()
// fills a missing temperature with. It also makes temp_anomaly resolve to 0,
// i.e. "nothing unusual about the weather", which is the neutral the rule
// engine expresses by zeroing its weather factor.
//
// The remaining honesty is at the caller: the imputed value is NOT evidence, so
// predictBusyness leaves 'weather' out of dataSourcesUsed and takes the same 15
// confidence points off that the rule engine adds for having a reading.
// ---------------------------------------------------------------------------

function hasTempReading(weather) {
  const t = weather?.temp ?? weather?.temperature;
  return typeof t === 'number' && Number.isFinite(t);
}

// Mean of the whole norms table = prepare_features' `global_mean`, the value it
// fills an unseen latitude band / month with. Recomputed whenever the metadata
// object identity changes (i.e. never, in practice — it is loaded once).
let tempNormMean = { src: null, value: null };
function globalTempNorm() {
  const norms = (metadata && metadata.temp_norms) || {};
  if (tempNormMean.src === norms) return tempNormMean.value;
  const vals = Object.values(norms).map(Number).filter(Number.isFinite);
  const value = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  tempNormMean = { src: norms, value };
  return value;
}

// The training run's climatology for this venue: same 5-degree latitude banding
// as prepare_features.add_climate_anomaly, same global-mean fallback. Units are
// whatever the training rows were in, which is °F.
function climateNorm(lat, month) {
  const norms = (metadata && metadata.temp_norms) || {};
  const band = Math.round((Number(lat) || 0) / 5) * 5;
  const exact = Number(norms[`${band}_${month}`]);
  if (Number.isFinite(exact)) return exact;
  return globalTempNorm();
}

// The temperature to hand the model: the real reading, else the climatology.
// Returns null only when metadata carries no norms at all, which predictBusyness
// treats as "cannot build a train-consistent vector" and answers with the rule
// engine rather than letting the vector zero-fill 0°F.
function tempForFeature(weather, lat, month) {
  if (hasTempReading(weather)) return weather.temp ?? weather.temperature;
  const norm = climateNorm(lat, month);
  return Number.isFinite(norm) ? norm : null;
}

// Round 13: split from buildFeatureVector so init() can verify that every
// name in metadata.feature_names is actually produced. The vector builder
// zero-fills any name it doesn't recognize (`features[name] || 0`), which is
// right for genuinely-zero features but silently feeds the model garbage when
// a trained feature is missing from this map (renamed, dropped, or a new
// training feature that never got its inference-side twin). That failure mode
// is confident wrong numbers — the worst one a prediction can have.
function buildFeatureMap(venue, weather, timestamp, eventData, feedback, baseline, neighbors) {
  const ts = timestamp ? new Date(timestamp) : new Date();
  const dayOfWeek = ts.getDay(); // 0=Sun
  const hour = ts.getHours();
  const dateStr = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`;
  const month = ts.getMonth() + 1;

  // Determine season
  let season;
  if (month >= 3 && month <= 5) season = 'spring';
  else if (month >= 6 && month <= 8) season = 'summer';
  else if (month >= 9 && month <= 11) season = 'fall';
  else season = 'winter';

  const types = venue.types || [];
  const rating = venue.rating || metadata.median_rating || 4.0;
  const priceLevel = venue.price_level != null ? venue.price_level : (metadata.median_price_level || 2);
  const reviewCount = venue.user_ratings_total || venue.review_count || 0;

  // Coordinates. Round 15: this read only venue.latitude/venue.lat, and NOT ONE
  // live caller sets those — routes/crowd.js, routes/ai.js, routes/badge.js and
  // routes/publicCrowd.js all shape a venue as `{ location: { latitude,
  // longitude } }`, which is also what predictBusyness itself reads. So every
  // live prediction built its features at lat/lng 0,0: astronomy ran on the
  // equator, the temperature anomaly looked up latitude band 0, and
  // specialNightContext returned all-zeros because 0,0 is nowhere near a
  // training city — i.e. the v2.5 special-night features, the headline of the
  // shipped model, were dead on every request while the training rows carried
  // real coordinates. Read the same place the predictor does, then fall back.
  const lat = venue.location?.latitude ?? venue.latitude ?? venue.lat ?? 0;
  const lng = venue.location?.longitude ?? venue.longitude ?? venue.lng ?? 0;

  // Weather — accept BOTH naming styles. weatherService returns camelCase
  // (windSpeed/isRaining/conditionId); reading only snake_case silently fed
  // the model wind=0, rain=0, weather_group=unknown on every live prediction
  // (audit 2026-08-12), skewing all bad-weather forecasts.
  //
  // A MISSING reading is not a reading of 20. See tempForFeature: the old
  // `?? 20` told the model 20°F — below freezing — every time OpenWeatherMap
  // was down, because weatherService fetches units=imperial and the training
  // rows were collected through that same function.
  const temp = tempForFeature(weather, lat, month);
  const humidity = weather?.humidity ?? 50;      // prepare_features: fillna(50)
  const windSpeed = weather?.wind_speed ?? weather?.windSpeed ?? 0; // fillna(0)
  const isRaining = (weather?.is_raining ?? weather?.isRaining) ? 1 : 0; // fillna(0)
  const weatherCode = weather?.weather_condition_code || weather?.conditionId || weather?.id || null;
  // No code -> 'unknown', which is a real one-hot column the model was trained
  // on (prepare_features emits weather_unknown), so a missing reading lands in
  // a bucket the model has actually seen rather than being smeared into 'clear'.
  const weatherGroup = groupWeatherCode(weatherCode);

  // Map venue category
  const categoryMap = metadata.category_encoding || {};
  const venueCategory = venue.venue_category || venue.category || guessCategory(types);
  const categoryEncoded = categoryMap[venueCategory] ?? -1;

  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6) ? 1 : 0;
  const isFriSatNight = ((dayOfWeek === 5 || dayOfWeek === 6) && hour >= 18) ? 1 : 0;
  const isLunch = (hour >= 11 && hour <= 13) ? 1 : 0;
  const isDinner = (hour >= 17 && hour <= 21) ? 1 : 0;
  const isLateNight = (hour >= 22 || hour <= 3) ? 1 : 0;
  const isMorning = (hour >= 6 && hour <= 10) ? 1 : 0;

  // Event data (from live Ticketmaster lookup)
  const ev = eventData || {};
  const hasEvent = ev.hasEvent ? 1 : 0;
  const nearestAttendance = ev.nearestAttendance || 0;
  const totalEvents = ev.totalEvents || 0;
  const totalAttendance = ev.totalAttendance || 0;
  const nearestDistance = ev.nearestDistance || 0;
  const nearestType = ev.nearestType || null;
  const isBar = (venueCategory === 'bar' || venueCategory === 'nightclub') ? 1 : 0;

  // Build feature dict
  const features = {
    day_of_week: dayOfWeek,
    hour: hour,
    month: month,
    is_holiday: isHoliday(dateStr) ? 1 : 0,
    is_school_break: isSchoolBreak(dateStr) ? 1 : 0,
    // v2.5 special-night features — only consumed when the loaded model's
    // metadata.feature_names includes them (older models ignore extra keys)
    ...specialNightContext(lat, lng, dateStr),
    price_level: priceLevel,
    rating: rating,
    review_count: reviewCount,
    temperature: temp,
    humidity: humidity,
    wind_speed: windSpeed,
    is_raining: isRaining,
    hour_sin: Math.sin(2 * Math.PI * hour / 24),
    hour_cos: Math.cos(2 * Math.PI * hour / 24),
    month_sin: Math.sin(2 * Math.PI * month / 12),
    month_cos: Math.cos(2 * Math.PI * month / 12),
    dow_sin: Math.sin(2 * Math.PI * dayOfWeek / 7),
    dow_cos: Math.cos(2 * Math.PI * dayOfWeek / 7),
    is_weekend: isWeekend,
    is_friday_saturday_night: isFriSatNight,
    is_lunch_hour: isLunch,
    is_dinner_hour: isDinner,
    is_late_night: isLateNight,
    is_morning: isMorning,
    season_spring: season === 'spring' ? 1 : 0,
    season_summer: season === 'summer' ? 1 : 0,
    season_fall: season === 'fall' ? 1 : 0,
    season_winter: season === 'winter' ? 1 : 0,
    venue_category_encoded: categoryEncoded,
    log_review_count: Math.log(reviewCount + 1),
    rain_x_weekend: isRaining * isWeekend,
    rain_x_dinner: isRaining * isDinner,
    // Number.isFinite first: with no reading AND no climatology to impute from
    // (see tempForFeature) `temp` is null, and `null < 5` is true — which would
    // turn "we have no idea what the weather is" into "it is freezing and
    // clear". Serving never reaches that state (predictBusyness answers with
    // the rule engine instead), and this makes the map itself safe anyway.
    cold_outdoor: (Number.isFinite(temp) && temp < 5 && weatherGroup === 'clear') ? 1 : 0,
    // Baseline + freshness — venue-specific if available, category fallback otherwise
    baseline_busyness: baseline || 0,
    category_baseline: (metadata.category_baselines || {})[`${venueCategory}_${dayOfWeek}_${hour}`] || 0,
    refined_category_baseline: (() => {
      const pt = priceLevel >= 2 ? 1 : 0;
      const pop = rating >= 4.3 ? 1 : 0;
      return (metadata.refined_baselines || {})[`${venueCategory}_${pt}_${pop}_${dayOfWeek}_${hour}`]
        || (metadata.category_baselines || {})[`${venueCategory}_${dayOfWeek}_${hour}`] || 0;
    })(),
    has_venue_baseline: baseline > 0 ? 1 : 0,
    is_realtime: 1, // live predictions are always "realtime" quality
    // Event features
    has_nearby_event: hasEvent,
    nearest_event_attendance: nearestAttendance,
    log_nearest_event_attendance: Math.log(nearestAttendance + 1),
    nearest_event_distance_km: nearestDistance,
    total_nearby_events: totalEvents,
    total_nearby_attendance: totalAttendance,
    log_total_nearby_attendance: Math.log(totalAttendance + 1),
    large_event_nearby: nearestAttendance > 5000 ? 1 : 0,
    event_x_weekend: hasEvent * isWeekend,
    event_x_dinner: hasEvent * isDinner,
    event_x_bar: hasEvent * isBar,
    etype_music: nearestType === 'music' ? 1 : 0,
    etype_sports: nearestType === 'sports' ? 1 : 0,
    etype_arts: nearestType === 'arts' ? 1 : 0,
    etype_family: nearestType === 'family' ? 1 : 0,
    etype_other: nearestType === 'other' ? 1 : 0,
    // User feedback features
    avg_user_crowd: feedback?.avgCrowd || 0,
    log_user_feedback_count: Math.log((feedback?.count || 0) + 1),
    has_user_feedback: (feedback?.count > 0) ? 1 : 0,
    // Match the checked-in model's training distribution: only models whose
    // metadata declares mapped semantics get the mapped feature (see
    // getUserFeedback). v2.5-starling and earlier trained on the legacy one.
    avg_prediction_error: (metadata.feedback_error_semantics === 'mapped'
      ? feedback?.avgErrorMapped
      : feedback?.avgErrorLegacy) || 0,
    // v2.4 features (older models simply don't list these in feature_names)
    ...astronomyFeatures(lat, month, hour),
    ...(() => {
      // prepare_features.add_climate_anomaly: temp_norm is the latitude-band x
      // month mean, filled with the mean of the whole norms table where that
      // band/month was never seen, and temp_anomaly is (temperature, itself
      // filled with temp_norm when missing) minus temp_norm, clipped to +/-25.
      // climateNorm() is that same number, which is why an imputed temperature
      // comes out at anomaly 0 here without a second special case.
      const norm = climateNorm(lat, month);
      const anomaly = Number.isFinite(norm) && Number.isFinite(temp)
        ? Math.max(-25, Math.min(25, temp - norm))
        : 0;
      return {
        temp_anomaly: anomaly,
        is_warm_anomaly_evening: (anomaly > 5 && hour >= 17) ? 1 : 0,
      };
    })(),
    log_neighbor_count: Math.log1p(neighbors?.count || 0),
    neighbor_baseline_same_hour: neighbors?.mean || 0,
  };

  // Weather group one-hot
  const weatherGroups = ['clear', 'few_clouds', 'cloudy', 'light_rain', 'heavy_rain',
    'snow', 'thunderstorm', 'other', 'unknown'];
  for (const g of weatherGroups) {
    features[`weather_${g}`] = weatherGroup === g ? 1 : 0;
  }

  // Google types one-hot — ONLY THE FIRST THREE TYPES, because that is all the
  // training corpus has.
  //
  // Round 17: this tested membership of the whole `types` array. The corpus
  // does not have a whole array: scripts/ml/train/export_training_data.js
  // rowToCsv writes exactly `types[0]`, `types[1]`, `types[2]` into
  // google_type_1/2/3, and prepare_features.add_venue_features builds every
  // gtype_* column by testing those three columns and nothing else. Anything at
  // position 4 or later was zero in every row the model ever saw.
  //
  // That is not a rare edge. Google returns its generic tail types last on
  // essentially every place — a bar comes back as
  // ["bar","restaurant","food","point_of_interest","establishment"] — and both
  // `point_of_interest` and `establishment` are in metadata.top_google_types.
  // So two of the thirty type one-hots were ~always 1 at inference and ~always
  // 0 in training: a systematic distribution shift on every single prediction,
  // in the direction the model has no experience of. Same class as the 0,0
  // coordinate bug — no error anywhere, just a different vector than the one
  // the weights were fit on.
  const trainedTypes = types.slice(0, 3);
  const topTypes = metadata.top_google_types || [];
  for (const t of topTypes) {
    features[`gtype_${t}`] = trainedTypes.includes(t) ? 1 : 0;
  }

  return features;
}

function buildFeatureVector(venue, weather, timestamp, eventData, feedback, baseline, neighbors) {
  const features = buildFeatureMap(venue, weather, timestamp, eventData, feedback, baseline, neighbors);
  // Build ordered array matching feature_names — the model consumes POSITIONS,
  // so this ordering is the entire train/inference contract.
  const featureNames = metadata.feature_names || [];
  const vector = new Float32Array(featureNames.length);
  for (let i = 0; i < featureNames.length; i++) {
    // Round 18: `features[name] || 0` only screened FALSY garbage. A non-numeric
    // STRING is truthy, and Float32Array assignment coerces it — so a venue
    // shaped from request-body fields (routes/crowd.js POST /batch scores
    // exactly those) with rating: 'abc' or price_level: 'x' put literal NaN
    // into the tensor. Number() first, then the finite check: every valid
    // input coerces to the same value the typed array would have produced,
    // and everything else zero-fills like any other absent feature.
    const value = Number(features[featureNames[i]]);
    vector[i] = Number.isFinite(value) ? value : 0;
  }
  return vector;
}

// Every feature the model was trained on must be computable at inference, or
// the vector silently zero-fills it. Returns the list of metadata
// feature_names that buildFeatureMap does NOT produce (empty list = healthy).
function missingFeatureNames(meta) {
  const probeVenue = {
    place_id: 'probe', types: ['restaurant'], rating: 4.0, price_level: 2,
    user_ratings_total: 10, latitude: 40.7, longitude: -74.0,
  };
  const probeWeather = { temp: 20, humidity: 50, windSpeed: 2, isRaining: false, conditionId: 800 };
  const probeEvents = {
    hasEvent: true, nearestAttendance: 100, totalEvents: 1, totalAttendance: 100,
    nearestType: 'music', nearestDistance: 1, nearestName: 'probe',
  };
  const probeFeedback = { avgCrowd: 2, count: 1, avgErrorMapped: 0, avgErrorLegacy: 0 };
  const map = buildFeatureMap(probeVenue, probeWeather, new Date(), probeEvents,
    probeFeedback, 50, { count: 1, mean: 50 });
  return (meta.feature_names || []).filter(name => !(name in map));
}

function guessCategory(types) {
  if (!types || !types.length) return 'restaurant';
  if (types.includes('bar') || types.includes('night_club')) return 'bar';
  if (types.includes('cafe') || types.includes('coffee_shop')) return 'cafe';
  if (types.includes('gym') || types.includes('fitness_center')) return 'gym';
  if (types.includes('shopping_mall')) return 'mall';
  if (types.includes('museum')) return 'museum';
  if (types.includes('movie_theater')) return 'movie_theater';
  if (types.includes('fast_food_restaurant') || types.includes('meal_takeaway')) return 'fast_food';
  if (types.includes('bakery') || types.includes('ice_cream_shop')) return 'dessert';
  if (types.includes('brewery')) return 'brewery';
  return 'restaurant';
}

// ---------------------------------------------------------------------------
// Prediction Functions
// ---------------------------------------------------------------------------

async function predictBusyness(venue, weather, timestamp) {
  await init();

  if (!useML) {
    const result = crowdEngine.calculateCrowdScore(venue, weather, timestamp);
    result.predictionMethod = 'rule_engine';
    result.modelVersion = null;
    return result;
  }

  try {
    // Fetch events, feedback, and baseline in parallel — all from local DB/cache
    const lat = venue.location?.latitude || venue.latitude || venue.lat || 0;
    const lng = venue.location?.longitude || venue.longitude || venue.lng || 0;
    const placeId = venue.place_id || venue.google_place_id || null;
    const ts = timestamp ? new Date(timestamp) : new Date();

    // Event lookup needs a REAL instant (UTC query window), not the venue
    // wall clock the feature builder consumes — see trueEventInstant.
    const eventInstant = trueEventInstant(ts,
      venue.utcOffsetMinutes ?? venue.utc_offset_minutes ?? venue.utc_offset ?? null);

    const [eventData, feedback, storedBaseline, neighbors] = await Promise.all([
      getNearbyEvents(lat, lng, eventInstant),
      getUserFeedback(placeId),
      getBaseline(placeId, ts.getDay(), ts.getHours()),
      getNeighborActivity(placeId, lat, lng, ts.getDay(), ts.getHours()),
    ]);

    // Best-available baseline: stored table first, else read it directly off
    // the venue's Google popular_times payload so even the FIRST request for
    // a venue runs through the ML model instead of the fallback.
    let baseline = storedBaseline;
    if ((!baseline || baseline <= 0) && venue.popular_times) {
      baseline = baselineFromPopularTimes(venue.popular_times, ts.getDay(), ts.getHours());
      // Persist for future requests/hours (async, non-blocking).
      storeGoogleBaselines(placeId, venue.popular_times).catch(() => {});
    }

    // No-baseline guard (delta models only): the delta model reconstructs
    // score = baseline + clamp(delta, ±30). With baseline 0 that caps the
    // score at ~30 ("Not Busy") no matter how packed the venue really is —
    // strictly worse than the rule engine. Only venues with NO stored
    // baseline AND no popular_times land here; the rule engine answers.
    // (Retrain plan: teach the model an absolute head so this path dies.)
    if (metadata.label_type === 'delta' && (!baseline || baseline <= 0)) {
      const result = crowdEngine.calculateCrowdScore(venue, weather, timestamp);
      result.predictionMethod = 'rule_engine_no_baseline';
      result.modelVersion = null;
      return result;
    }

    // Weather honesty (round 15). With no reading the vector carries the
    // training run's climatology for this venue (see tempForFeature). If the
    // metadata has no climatology at all there is no in-distribution number to
    // hand a model that was trained on `temperature`, and zero-filling it would
    // be 0°F — so the rule engine, which handles a null reading honestly,
    // answers instead of the model guessing cold.
    const hasWeather = hasTempReading(weather);
    if (!hasWeather
        && (metadata.feature_names || []).includes('temperature')
        && tempForFeature(weather, lat, ts.getMonth() + 1) == null) {
      const result = crowdEngine.calculateCrowdScore(venue, weather, timestamp);
      result.predictionMethod = 'rule_engine_no_weather_norm';
      result.modelVersion = null;
      return result;
    }

    const ort = require('onnxruntime-node');
    const vector = buildFeatureVector(venue, weather, timestamp, eventData, feedback, baseline, neighbors);
    const inputName = metadata.onnx_input_name || 'input';
    const tensor = new ort.Tensor('float32', vector, [1, vector.length]);
    const results = await session.run({ [inputName]: tensor });

    const outputName = session.outputNames[0];
    const rawOutput = results[outputName].data[0];
    // A model output that is not a finite number must not reach the arithmetic
    // below: NaN (or an empty output tensor's undefined, or an int64 head's
    // BigInt) sails through clamp-and-round as NaN, getLabel(NaN) falls through
    // every band to 'Very Busy', and the response ships score:null with
    // predictionMethod 'ml'. verifyModelShape can only check the head shape
    // when onnxruntime exposes outputMetadata, so this is the runtime backstop:
    // throw, and the catch below answers with the rule engine, honestly labelled.
    if (typeof rawOutput !== 'number' || !Number.isFinite(rawOutput)) {
      throw new Error(`model emitted a non-finite output (${String(rawOutput)})`);
    }
    let score;
    if (metadata.label_type === 'delta') {
      // Delta-trained model: reconstruct absolute as baseline + clamp(delta).
      // The model corrects systematic bias and adds nuance on top of popular_times.
      const [lo, hi] = metadata.delta_clamp_range || [-30, 30];
      const clampedDelta = Math.max(lo, Math.min(hi, rawOutput));
      score = (baseline || 0) + clampedDelta;
    } else {
      score = rawOutput;
    }
    score = Math.max(0, Math.min(100, Math.round(score)));

    const label = getLabel(score);

    // THE CONFIDENCE FIGURE, AND WHAT IT IS ALLOWED TO CLAIM.
    //
    // The `|| 58` that used to end this line is gone: a number with no
    // provenance, shipped to a user as a measurement. What replaces it depends
    // on what the artifact can actually support (readServedAccuracy).
    const accuracy = readServedAccuracy(metadata);
    if (accuracy.status === 'malformed') {
      // Only reachable under ML_SHIP_GATE_OVERRIDE; the load gate refuses this
      // artifact otherwise. Same shape as the non-finite-output guard: throw,
      // and the catch below answers with the rule engine, honestly tagged.
      throw new Error(`refusing to publish a confidence figure: ${accuracy.reason}`);
    }

    let confidence;
    let confidenceMeasurement;
    if (accuracy.status === 'measured') {
      confidence = Math.round(accuracy.percent);
      // Without a live reading the temperature in the vector is climatology,
      // not evidence, and the weather one-hot sits in 'unknown'. The rule
      // engine adds 15 confidence for having weather; take the same 15 back off
      // here so a degraded prediction cannot report an undegraded number. It is
      // an adjustment, not a measurement, so it is published as one rather than
      // folded silently into the percentage.
      const weatherPenalty = hasWeather ? 0 : 15;
      confidence = Math.max(0, confidence - weatherPenalty);
      confidenceMeasurement = {
        status: 'measured',
        means: 'measured_accuracy',
        metric: accuracy.metric,
        population: accuracy.population,
        populationRows: accuracy.rows,
        measuredPercent: accuracy.percent,
        weatherPenalty,
      };
    } else {
      // UNMEASURED (every artifact exported before 2026-08-15). The model still
      // runs and its per-venue baseline still answers; what it cannot do is
      // state a hit rate. The blend is not a substitute — it is the specific
      // wrong number this whole change exists to stop publishing — and 0 would
      // be a lie in the other direction, so `confidence` carries the only other
      // defined quantity in this system: crowdEngine's input-completeness
      // ladder, the SAME number and the SAME meaning the rule-engine path
      // publishes for this venue, which routes/crowd.js already labels
      // 'input_completeness'. It is not an accuracy and `means` says so.
      //
      // No weather penalty is applied on this branch and none is owed: the
      // ladder already adds 15 for a live reading (crowdEngine
      // calculateCrowdScore), so subtracting it again would double-count the
      // same outage.
      const ladder = Number(crowdEngine.calculateCrowdScore(venue, weather, timestamp).confidence);
      confidence = Number.isFinite(ladder) ? Math.max(0, Math.min(100, Math.round(ladder))) : 0;
      confidenceMeasurement = {
        status: 'unmeasured',
        means: 'input_completeness',
        metric: 'venue_metadata_completeness',
        population: null,
        populationRows: null,
        measuredPercent: null,
        weatherPenalty: 0,
      };
    }

    const dataSources = ['ml_model', hasWeather ? 'weather' : null, 'venue_data'];
    if (eventData.hasEvent) dataSources.push('ticketmaster_events');

    const response = {
      score,
      label,
      confidence,
      factors: {},
      dataSourcesUsed: dataSources.filter(Boolean),
      predictionMethod: 'ml',
      modelVersion: metadata.model_version || '2.1.0',
      // WHAT THE NUMBER ABOVE IS, said in the payload rather than left to be
      // inferred. `confidence` is one integer and cannot carry its own
      // provenance: which metric, over which population, how many rows, and
      // whether anything was subtracted from it. A client that renders a
      // percentage without reading this is asserting a measurement it has not
      // read. The shape is the same in both states so a client branches on
      // `status`/`means` rather than on the presence of keys.
      //
      // `means: 'measured_accuracy'` describes THE NUMBER's provenance, not the
      // card's standing. crowdEngine.describePredictionSupport still returns
      // supported:false for the ML path while ML_BASELINE_AXIS_VERIFIED is
      // false, and that hedge is about the baseline axis, a separate open
      // question. Both can be true at once: a figure genuinely measured on the
      // served rows, anchored on an axis nobody has vouched for yet.
      confidenceMeasurement,
    };

    // Add event alert when large event nearby
    if (eventData.hasEvent && eventData.nearestAttendance > 5000) {
      response.eventAlert = {
        hasEvent: true,
        eventName: eventData.nearestName,
        estimatedAttendance: eventData.nearestAttendance,
        distance: `${eventData.nearestDistance} km away`,
      };
    }

    return response;
  } catch (err) {
    console.error('[MLPredictor] Prediction error, falling back:', err.message);
    const result = crowdEngine.calculateCrowdScore(venue, weather, timestamp);
    result.predictionMethod = 'rule_engine_fallback';
    result.modelVersion = null;
    return result;
  }
}

async function predictHourlyForecast(venue, weather, startHour, count, baseTimestamp) {
  await init();

  if (!useML) {
    return crowdEngine.generateHourlyForecast(venue, weather, startHour, count, baseTimestamp);
  }

  const hours = count || 12;
  const start = startHour != null ? startHour : new Date().getHours();
  const forecast = [];

  let base = baseTimestamp ? new Date(baseTimestamp) : new Date();
  // An unreadable baseTimestamp is not a timestamp — treat it exactly like an
  // omitted one (same normalization getNearbyEvents applies to its cache key).
  // Before this guard an Invalid Date rode through setHours untouched and
  // labelFor below read NaN off it, printing "NaN AM" over every entry.
  if (Number.isNaN(base.getTime())) base = new Date();
  base.setHours(start, 0, 0, 0);

  // THE LABEL IS READ OFF THE TIMESTAMP THAT WAS ACTUALLY SCORED.
  //
  // Round 17: `ts` advances by i * 3,600,000 ms — a fixed amount of ELAPSED
  // TIME — while the label was `(start + i) % 24`, a count of WALL-CLOCK hours.
  // Those agree only when no clock change falls between them. Across a DST
  // transition they diverge by an hour: on the fall-back night the entry
  // labelled "2 AM" had been scored at 1 AM, and on the spring-forward night
  // "2 AM" was labelled over a bar scored at 3 AM — an hour that does not exist.
  // Every feature in the vector comes from ts.getHours(), so ts is the truth and
  // the label has to follow it, not a parallel count that can drift from it.
  // (Railway runs UTC, which has no transitions, so this was a developer-machine
  // and future-deployment bug rather than a live one — but the card publishing a
  // score under the wrong hour is the same failure whatever the odds.)
  const labelFor = (d) => {
    const h = d.getHours();
    const period = h >= 12 ? 'PM' : 'AM';
    const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${displayHour} ${period}`;
  };

  for (let i = 0; i < hours; i++) {
    const ts = new Date(base.getTime() + i * 60 * 60 * 1000);
    try {
      const result = await predictBusyness(venue, weather, ts);
      forecast.push({ hour: labelFor(ts), score: result.score, label: result.label });
    } catch (err) {
      // Fallback for this hour
      const fallback = crowdEngine.calculateCrowdScore(venue, weather, ts);
      forecast.push({ hour: labelFor(ts), score: fallback.score, label: fallback.label });
    }
  }

  return forecast;
}

// Re-export crowdEngine functions that ML doesn't replace
const { estimateCapacity, estimateWait, findBestTime, findPeakTime,
  findQuieterAlternatives, buildCalibrationAdjustment } = crowdEngine;

module.exports = {
  predictBusyness,
  predictHourlyForecast,
  estimateCapacity,
  estimateWait,
  findBestTime,
  findPeakTime,
  findQuieterAlternatives,
  buildCalibrationAdjustment,
  storeGoogleBaselines,
  getLabel,
  init,
  // Internals exported for backend/__tests__/mlPipeline.test.js — the
  // train/inference parity surface. Not part of the serving API.
  _internals: {
    buildFeatureMap,
    buildFeatureVector,
    missingFeatureNames,
    evaluateShipGate,
    astronomyFeatures,
    groupWeatherCode,
    baselineFromPopularTimes,
    trueEventInstant,
    hasTempReading,
    climateNorm,
    tempForFeature,
    estimateTmAttendance,
    getNearbyEvents,
    verifyModelShape,
    readServedAccuracy,
    boundedSet,
    PREDICTOR_CACHE_MAX,
    EVENT_CACHE_MAX,
    eventCacheSize: () => eventCache.size,
    getMetadata: () => metadata,
    getSession: () => session,
  },
};
