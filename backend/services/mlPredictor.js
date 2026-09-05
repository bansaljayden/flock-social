// ---------------------------------------------------------------------------
// ML Crowd Predictor — loads ONNX model, serves predictions
// Falls back to rule-based crowdEngine.js if model not available
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const crowdEngine = require('./crowdEngine');
// Namespace require, not destructured: predictHourlyForecast reads
// weatherService.getHourlyForecast at call time, which is also the seam
// __tests__/serveTrainSkew.test.js stubs.
const weatherService = require('./weatherService');
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
// key -> in-flight Promise, so concurrent misses on one key make ONE call.
// See the block in getNearbyEvents; entries live only for the duration of a
// single fetch and are removed in a finally.
const eventInflight = new Map();
const EVENT_CACHE_TTL = 60 * 60 * 1000; // 1 hour
// How long a lookup that DID NOT SUCCEED is remembered. Same value and same
// reasoning as weatherService's WX_NEGATIVE_TTL; the long version sits at the
// cache read in getNearbyEvents.
const EVENT_NEGATIVE_TTL = 60 * 1000; // 1 minute
const EVENT_CACHE_MAX = 500;
// Upstream budget (round 6): the public demo builds current + 12h + 24h
// forecasts per card, and each prediction can reach Ticketmaster. Cap the
// daily fan-out here, where every prediction path converges.
let eventDayKey = new Date().toISOString().slice(0, 10);
let eventDayCount = 0;
const EVENT_DAILY_BUDGET = 1500;
// ---------------------------------------------------------------------------
// THE UNAUTHENTICATED SHARE OF IT. Same control as UNAUTH_DAILY in
// utils/placesBudget.js, added for the same reason (money audit round 4).
//
// The block below used to end by saying the unauthenticated marketing demo
// "keeps the old global-only behavior" because "the demo already has its own
// per-IP gate". That is the argument placesBudget's M5-1 section had already
// disproved on its own three doors, and the arithmetic here is worse than it
// was there. MEASURED against the real module: one predictBusyness is 1
// Ticketmaster call and one predictHourlyForecast(24) is 23 more, so ONE
// public venue card (routes/publicCrowd.js buildCard) is 24 calls. Sixty-three
// of them empties EVENT_DAILY_BUDGET, and routes/publicCrowd.js allowDemo will
// serve 600 requests a day. So the demo could spend the whole product's event
// allowance using a tenth of its own permitted traffic, from any number of
// addresses, and after that allowEventFetch answers false for EVERY caller
// until UTC midnight: the card, the vote list, the alternatives list, the
// owner dashboard and the advisor all quietly lose their event enrichment. A
// per-IP gate bounds one address; it does not reserve anything for anybody.
//
// WHY 900/600. The reserve is 600 authenticated calls, 40% of the day, the
// same share placesBudget keeps. It is also strictly above EVENT_USER_DAILY
// (400), which is the property worth stating: one account still cannot drain
// the reserve on its own, so it takes two cooperating accounts to do what no
// volume of anonymous traffic can now do at all. There is no per-door event
// sub-ceiling for this to accidentally repeal, so the upward constraint that
// pins placesBudget's 1800 does not apply here.
//
// WHO COUNTS AS ANONYMOUS: only a caller that says so, with
// { anonymous: true }. Absence of a userId is deliberately NOT the signal —
// services/crowdAlerts.js and the ML scripts also pass no id, and they are our
// own traffic rather than unattributable traffic.
const EVENT_UNAUTH_DAILY = 900;
// The unauthenticated slice of eventDayCount, charged IN ADDITION to it.
let eventUnauthDayCount = 0;

// ---------------------------------------------------------------------------
// THE PER-ACCOUNT LEG OF THE EVENT BUDGET (money audit round 2, finding M1).
//
// EVENT_DAILY_BUDGET above is process-wide and has no caller dimension, and it
// was the only spend counter in this repo built that way — utils/placesBudget.js
// and services/birdieUsage.js both carry a per-account leg and both explain at
// length why. What that missing dimension bought:
//
//   POST /api/crowd/batch fans one request out to twenty predictions, so one
//   request is up to twenty cache-missing Ticketmaster calls. 1500 / 20 = 75
//   requests, and apiLimiter allows 200 a minute — about twenty-three seconds
//   of ONE authenticated session. After that allowEventFetch() answered false
//   for every user until UTC midnight and every crowd surface in the product
//   silently lost its event enrichment: the card, the vote list, the
//   alternatives list, the marketing demo, the owner dashboard.
//
// So the ceiling that matters is per ACCOUNT, and it is deliberately set below
// two other numbers in this file. Both relationships are load-bearing; a test
// pins each (__tests__/crowdBatchAmplification.test.js):
//
//   EVENT_USER_DAILY (400) < EVENT_DAILY_BUDGET (1500)
//       One account can no longer exhaust the global allowance for everybody
//       else. It takes four cooperating accounts to do what one used to do in
//       twenty-three seconds, and the per-account hourly cap stretches that
//       over hours rather than seconds.
//
//   EVENT_USER_DAILY (400) < EVENT_CACHE_MAX (500)
//       This is the answer to the cache-FLUSH variant of the same attack. An
//       entry is only ever written to eventCache after a real upstream call
//       (cacheEvents runs downstream of this gate on every branch), so the
//       number of entries one account can write is exactly the number of units
//       it is allowed to spend. 400 < 500 means a single account that spends
//       its entire day cannot evict everything other users have cached. Keep
//       this inequality if either constant is ever changed.
//
// WHY 200/HOUR AND 400/DAY and not something tighter. A cold area costs a real
// session about twenty calls for a vote list, plus up to twenty-five for the
// first venue card in that area (the card scores now plus a 24-hour forecast,
// and each forecast hour is its own UTC hour slot in the cache key). Everything
// after that in the same ~1 km bucket and the same hour is free. 200 an hour is
// therefore roughly eight cold venue cards an hour, which is well past what
// browsing looks like, and 400 a day leaves 2x headroom on top. Exceeding it
// degrades gracefully: getNearbyEvents returns "no events", the prediction
// still ships, nothing errors.
//
// WHO IS CHARGED. The per-account leg, only callers that HAVE an account.
// Background producers (services/crowdAlerts.js) pass no userId and are
// bounded by the global ceiling alone, which is right: they are our own
// traffic and there is no account to hold responsible. The unauthenticated
// marketing demo used to be lumped in with them, and EVENT_UNAUTH_DAILY above
// is the correction — it declares itself anonymous and is bounded by a share
// of the day rather than by the global ceiling alone. A userId that is
// supplied but MALFORMED is refused rather than waved through:
// createUserBudget.allow() fails closed on anything that is not a positive
// integer id, matching placesBudget.keyOf().
// ---------------------------------------------------------------------------
const { createUserBudget } = require('../utils/probeBudget');
const EVENT_USER_HOURLY = 200;
const EVENT_USER_DAILY = 400;
const eventUserBudget = createUserBudget({
  name: 'crowd-events',
  hourly: EVENT_USER_HOURLY,
  daily: EVENT_USER_DAILY,
});

// ---------------------------------------------------------------------------
// THE THREE PLACE-KEYED CACHES NOBODY METERED — found by the round-5 sweep
// ---------------------------------------------------------------------------
// The round-4 audit asked for every cache key and every spend counter to be
// enumerated against "which part of this can the caller pick" rather than for
// the reported instance to be patched again. Doing that turned up an instance
// nobody had reported, sitting in this file next to the one that was:
//
//   baselineCache      key `${placeId}_${dow}_${hour}`   miss = 1 Postgres query
//   feedbackCache      key placeId                        miss = 1 Postgres query
//   selfBaselineCache  key placeId                        miss = 1 Postgres query
//
// `placeId` on POST /api/crowd/batch is `v.place_id.slice(0, 256)` — routes/
// crowd.js deliberately does NOT shape-check it, and the comment that argues
// for that reasons only about paid Google calls and about writes. It does not
// account for cache thrash against Postgres. So the key space is every string
// up to 256 characters, against three 2,000-entry FIFOs, and NOTHING meters the
// database leg: twenty venues a request times three caches is up to sixty
// forced round trips per request that can never be served from memory, at
// apiLimiter's 3,000 requests per 15 minutes.
//
// That is R4-I2's arithmetic on a different set of maps, and it is worse in one
// respect: eventCache is protected by the pinned inequality
// EVENT_USER_DAILY(400) < EVENT_CACHE_MAX(500), so one account cannot flush
// what everybody else cached. These three had no equivalent, so the same loop
// also evicts real venues' baselines and feedback and makes THEIR next request
// pay a query too.
//
// TWO GATES, IN THIS ORDER, AND THE ORDER IS THE POINT.
//
//   1. SHAPE, free. A place id that cannot match PLACE_ID_RE cannot match a row
//      in ml_venue_baselines, venue_feedback or ml_venues, because everything
//      that writes those tables writes a real Google place id (the corpus
//      loader, and routes/feedback.js, which shape-checks). So refusing it is
//      not a degradation, it is answering a question whose answer is already
//      known — and it must be FREE, or junk would spend a real user's
//      allowance. This is what collapses the arbitrary-256-char half of the key
//      space, and it costs nothing to be wrong about: the failure contract
//      below is the one a genuine miss already returns.
//   2. BUDGET, charged. Shape alone is not enough and it is important to say
//      why: `spoof-000001`, `spoof-000002`, … are all perfectly well shaped, so
//      an attacker who reads this file simply generates shaped ids instead.
//      The bounded key space is a nice-to-have; the budget is the control.
//
// WHY 1500/HOUR AND 5000/DAY, which are much larger numbers than anything else
// in this file. The unit here is one uncached DATABASE lookup, not one request
// and not one venue, and a single cold venue costs THREE of them. A batch of
// twenty venues in an area this process has never seen is therefore up to 60
// units, and a heavy hour of exploring genuinely new cities — say twenty such
// cold lists, which is already well past browsing — is 1,200. 1,500 leaves
// headroom on top of that and still cuts the walk from ~180,000 round trips an
// hour to 1,500, a ~120x reduction. These are cheap indexed lookups, not paid
// API calls, so the right ceiling is the one that a real session cannot reach
// rather than the tightest one that still works.
//
// FAILING IS SAFE HERE, which is why a ceiling this loose is acceptable. Each
// of the three already has a documented degradation: getBaseline returns 0 (and
// predictBusyness then reads the venue's own popular_times, or hands the whole
// prediction to the rule engine), getUserFeedback returns noFeedback, and
// getSelfBaselines returns null so nothing is subtracted and the neighbour
// count is one too high rather than wrong in the model's favour. A refused
// lookup takes exactly the branch a database error already takes.
// ---------------------------------------------------------------------------
// The shape predicate is IMPORTED, not restated. utils/places.js already owns
// `/^[A-Za-z0-9_-]{6,128}$/` and eight other surfaces already gate on it; a
// second copy here would be two definitions of "could this match a row" free to
// drift apart, which is the same mistake NEIGHBOR_BOX_DEG has a test pinning
// against. (No require cycle: utils/places.js pulls in config/database and
// nothing else.)
const { isPlaceIdShaped } = require('../utils/places');
const VENUE_LOOKUP_USER_HOURLY = 1500;
const VENUE_LOOKUP_USER_DAILY = 5000;
const venueLookupBudget = createUserBudget({
  name: 'crowd-venue-lookup',
  hourly: VENUE_LOOKUP_USER_HOURLY,
  daily: VENUE_LOOKUP_USER_DAILY,
});

// True when this caller may spend one uncached place-keyed Postgres lookup.
// Callers with no account (services/crowdAlerts.js, the unauthenticated demo)
// pass no userId and keep the un-metered behaviour, exactly as allowEventFetch
// decides it; a SUPPLIED but malformed id is refused rather than waved through.
function allowVenueLookup(placeId, userId) {
  if (!isPlaceIdShaped(placeId)) return false;
  if (userId != null && !venueLookupBudget.allow(userId)) return false;
  return true;
}

// `userId` is optional; see WHO IS CHARGED above.
//
// ORDER MATTERS. The global ceiling is READ first and INCREMENTED last, with
// the per-account charge in between, so a call the global budget was going to
// refuse never eats one of the caller's units. Same all-or-nothing rule
// utils/placesBudget.js states: a partial charge must never leave the caller
// believing it may proceed.
function allowEventFetch(userId, opts) {
  const anonymous = !!(opts && opts.anonymous);
  const today = new Date().toISOString().slice(0, 10);
  if (today !== eventDayKey) { eventDayKey = today; eventDayCount = 0; eventUnauthDayCount = 0; }
  if (eventDayCount >= EVENT_DAILY_BUDGET) return false;
  // Checked before either counter moves, so a refused call is charged nothing
  // on either leg. This is the reserve: EVENT_DAILY_BUDGET - EVENT_UNAUTH_DAILY
  // calls a day that no volume of anonymous traffic can reach, through this
  // door or one added later, because every event fetch in the product comes
  // through this function.
  if (anonymous && eventUnauthDayCount >= EVENT_UNAUTH_DAILY) return false;
  if (userId != null && !eventUserBudget.allow(userId)) return false;
  eventDayCount++;
  if (anonymous) eventUnauthDayCount++;
  return true;
}

// ---------------------------------------------------------------------------
// HOW OFTEN DOES THE TRAINED MODEL ACTUALLY ANSWER. Added 2026-08-26, because
// nothing in this repo had ever counted it, and the crowd number is the one
// differentiated claim the product makes.
//
// predictBusyness has five exits and only one of them is the model. The other
// four are honest refusals that return crowdEngine's category curve, and the
// most common of them by a wide margin is `rule_engine_no_baseline`: a delta
// model reconstructs score = baseline + clamp(delta), so a venue with no row in
// ml_venue_baselines cannot be scored by it at all.
//
// HOW THAT SET GROWS. There are exactly two ways a venue acquires a baseline
// row. One is the BestTime collector, and the paragraph here used to say it was
// finished — key dead, zero rows since 2026-05-18. That was wrong, and wrong in
// the direction that stops work: the 403s were BestTime's abuse guard tripping
// on a 600/min pace against a 300/min limit, the account was never unpaid, and
// since the pacing fix the Railway BESTTIME service has been collecting on a
// cron (245 rows on 2026-09-03, provenance clean). The corpus is NOT frozen.
// The other is
// storeGoogleBaselines, which predictBusyness calls only when the venue it was
// handed carries `popular_times` -- and no route in this repo puts that field on
// a venue (routes/crowd.js says so at its batch whitelist, and the Places field
// masks in that file do not request it, because the Places API does not sell
// popular times). So baselineFromPopularTimes, storeGoogleBaselines and
// GOOGLE_BASELINE_REFRESH_DAYS are unreachable from every request path: the
// corpus grows only where the collector goes, and a venue outside the collected
// set takes the rule engine until collection reaches it.
//
// Which venues to collect next is a product decision, not a bug to patch here.
// What was missing is the number to make it on: the split is invisible in the
// payload (a client sees one card either way), invisible in the logs (no line is
// written per prediction), and invisible in the database (nothing is stored).
// These counters are the cheapest thing that makes it visible.
//
// IN MEMORY AND PER PROCESS, deliberately, exactly like eventBudgetStatus above.
// A counter that needed a table would need a migration, a write on the hottest
// path in the API, and a retention policy, to answer a question a restart-scoped
// tally already answers. Read it, do not gate on it.
//
// VISIBLE SINCE 2026-08-26, AND THE WIRE HAS ITS OWN GUARD. GET
// /api/admin/costs serves this block (routes/admin.js, through
// meterBlockOrNull, after the meterOrNull null-bug costModel.test.js
// documents), and the admin Revenue screen renders it
// (frontend/src/screens/RevenueScreen.js, the predictionCoverage panel). The
// paragraph that stood here said the counter was read by nothing but its own
// test; that was true on the morning of 2026-08-26 and false by that evening,
// and it kept saying it for two more days, which is its own small lesson in
// comments that describe wiring.
//
// NOTE ON WHAT IT COUNTS. predictHourlyForecast calls predictBusyness once per
// hour of the strip, so `total` is scored VENUE-HOURS, not cards. A single card
// view of a cold venue contributes up to 24. That is the right denominator for
// "how often does the trained model answer", and the wrong one for "how many
// users saw an ML number", so do not read it as the second.
const predictionMethodCounts = Object.create(null);
let predictionCountsSince = Date.now();

function countPrediction(method) {
  const key = typeof method === 'string' && method ? method : 'unknown';
  predictionMethodCounts[key] = (predictionMethodCounts[key] || 0) + 1;
}

// Non-consuming read, for routes/admin.js. `modelShare` is the fraction of
// predictions this process answered with the trained model, null while nothing
// has been scored yet rather than 0, because "no data" and "the model never
// answers" are the two readings this panel exists to tell apart.
function predictionCoverage() {
  const byMethod = { ...predictionMethodCounts };
  const total = Object.values(byMethod).reduce((a, b) => a + b, 0);
  const ml = byMethod.ml || 0;
  return {
    since: predictionCountsSince,
    total,
    ml,
    ruleEngine: total - ml,
    modelShare: total > 0 ? ml / total : null,
    byMethod,
    modelVersion: (metadata && metadata.model_version) || null,
    modelLoaded: useML,
    inMemory: true,
  };
}

// Non-consuming read, for routes/admin.js's cost panel. This ledger is the
// THIRD Ticketmaster counter in the repo (routes/events.js has one at 2000/day
// and services/nightContext.js one at 200/day) and it was the only one with no
// reader, so the panel and services/costModel.js both priced a repo-wide
// Ticketmaster ceiling that was missing 1500 calls a day. Same shape as
// placesBudgetStatus: never gate on this and then call the upstream.
function eventBudgetStatus() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== eventDayKey) { eventDayKey = today; eventDayCount = 0; eventUnauthDayCount = 0; }
  return {
    day: eventDayKey,
    globalUsed: eventDayCount,
    globalRemaining: Math.max(0, EVENT_DAILY_BUDGET - eventDayCount),
    unauthUsed: eventUnauthDayCount,
    unauthRemaining: Math.max(0, EVENT_UNAUTH_DAILY - eventUnauthDayCount),
    cacheEntries: eventCache.size,
    limits: {
      globalDaily: EVENT_DAILY_BUDGET,
      unauthDaily: EVENT_UNAUTH_DAILY,
      perUserHourly: EVENT_USER_HOURLY,
      perUserDaily: EVENT_USER_DAILY,
    },
    inMemory: true,
  };
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
// THE ml_venue_baselines HOUR-AXIS BUG — DATA FIX SHIPPED 2026-08-15; ONLY
// THE RETRAIN REMAINS. Found 2026-08-14 chasing a user report of a well-known
// dinner restaurant reading ~20% at 6 PM. The `hour` column this function
// reads IS a venue-local hour now (see STATUS below); the record of what was
// wrong is kept here because it is the best one that exists.
//
// THE WRITE SIDE, as it was. scripts/ml/collectWeekly.js iterated BestTime's
// `day_raw` array and wrote the ARRAY INDEX into ml_training_data.hour:
//
//     for (let hour = 0; hour < day.hours.length && hour < 24; hour++) {
//       const busyness = day.hours[hour];        // day.hours = day.day_raw
//       ... venue.id, jsDayOfWeek, hour, ...
//
// BestTime's day_raw does not start at midnight — its day runs 06:00 to 05:59,
// so day_raw[0] is the venue's 6 AM and day_raw[18] is the venue's MIDNIGHT.
// scripts/ml/buildBaselines.js then copied that column verbatim into
// ml_venue_baselines.hour. So the stored key was a bucket index:
//
//     stored_hour = (venue_local_hour - 6) mod 24
//
// THE PROOF, from the shipped artifact rather than from the vendor's docs.
// scripts/ml/models/model_metadata.json carries category_baselines derived from
// that column before the fix. Read literally they are impossible: restaurants
// peak at 12:00-14:00 every day of the week and bottom out at midnight; bars
// peak at 13:00-15:00; nightclubs peak at 17:00 and are emptiest at 00:00; gyms
// peak at noon. Add six hours and every one of them lands where it belongs —
// restaurants 18:00-20:00, bars 19:00-21:00, nightclubs 22:00-23:00, gyms
// 18:00, museums 14:00, and every trough at 04:00-07:00. 84 of the 91
// (category, day) peaks fall in stored buckets 6..15, i.e. local noon to 9 PM.
// __tests__/dinnerPeakAccuracy.test.js pins that arithmetic — against the
// ARTIFACT, which is still the pre-fix vintage, so it still holds today.
//
// WHAT IT COST. This model is `label_type: 'delta'`: predictBusyness returns
// baseline + clamp(delta, ±30), so the baseline IS the answer and the model
// only nudges it. A 6 PM request read stored slot 18, which held the venue's
// LOCAL MIDNIGHT busyness. For a restaurant the pre-fix corpus average at that
// slot was 45 against 60 for the true 6 PM slot and 65 at the real dinner peak
// — and a single venue that genuinely empties out overnight read far lower
// than any of those. That is exactly the reported symptom: a dinner venue
// reading a small-hours number at dinner.
//
// WHY THE FIX COULD NOT LIVE HERE, and why no shift was ever applied to this
// lookup. The obvious patch was to shift the read by six. It was wrong,
// because the corpus did not have ONE clock: collectWeekly.js wrote the
// BestTime bucket index while collectRealtime.js wrote the TRUE venue-local
// hour, collectRealtime's baseline refresh averaged both conventions into the
// same slot, and the DELTA LABEL the model was trained on was itself computed
// against a slot six hours off. No shift applied here was right for both
// halves, and there was no holdout on this side to check a guess against. So
// the fix went to the data, not to the read — which is what has now happened:
//
// STATUS 2026-08-18 — ALL FOUR STEPS SHIPPED. The collector, the backfill, the
// single baseline writer and now the weights are all on the venue-local clock.
//   1. DONE. scripts/ml/collectWeekly.js writes (index + 6) % 24 as the hour,
//      rolls day_of_week forward for slots 18-23, and declares
//      hour_axis = 'venue_local' on every row it writes.
//   2. DONE. Migration 023_backfill_ml_weekly_local_hours.sql applied the same
//      transform to every existing weekly row and rebuilt ml_venue_baselines
//      from the corrected rows. Applied in production 2026-08-15, verified
//      against schema_migrations 2026-08-16: 3,454,955 weekly rows on
//      hour_axis = 'venue_local', ZERO rows left on the BestTime index. The
//      query below therefore reads a real wall clock.
//   3. DONE. scripts/ml/collectRealtime.js's baseline refresh now delegates to
//      buildBaselines.refreshCollectedBaselines() (one writer, one definition,
//      with the collection_mode = 'weekly' filter), and its per-row baseline
//      stamp filters on collection_mode = 'weekly' AND
//      hour_axis = 'venue_local'. The two-clock blend cannot recur.
//   4. DONE 2026-08-18. v2.6.0-starling is trained on the corrected corpus and
//      exported from the fresh 44-column re-export, so the WEIGHTS now sit on
//      the same wall clock this query reads. The proof is in the artifact, not
//      in this comment: category peaks in local 17:00-23:00 went from 2 of 91
//      to 53 of 91 and lunchtime peaks from 35 to 9, and
//      __tests__/dinnerPeakAccuracy.test.js PART 3 fails if a pre-fix artifact
//      is ever served again. The predecessor (v2.5.0-starling) was trained on
//      the mixed-axis corpus and is the artifact that flag exists to catch.
// All four layers now agree, so crowdEngine.ML_BASELINE_AXIS_VERIFIED is TRUE
// as of v2.6.0-starling and describePredictionSupport may return basis
// 'model_holdout' with supported: true for the ML path. routes/crowd.js still
// publishes the provenance of every number it serves, because the point was
// never the hedge — it was that an ML answer is labeled by what stands behind
// it rather than asserted, and that is as true when the label is good news.
//
// WHAT THE FLIP DOES NOT COVER, because the caution still applies here: the
// confidence integer. It is training_metrics_by_population.realtime_served
// .within_15 (33.3%), NOT the blended 87.3% that mixes in weekly rows whose
// label equals the baseline by construction — see readServedAccuracy below.
// A verified axis makes the measurement describable; it does not make a
// different, larger number true.
//
// TURN THE FLAG BACK TO false if the served artifact is ever rolled back to a
// pre-2026-08-18 model, because then the weights are on the old axis again.
// ---------------------------------------------------------------------------
// The three slots a baseline answer is blended from: the hour itself and the
// hour either side of it, each carrying its own weekday because 23:00 and
// 00:00 belong to different days. Extracted so the single-slot query below and
// the whole-curve prime further down cannot drift apart on the arithmetic.
function baselineNeighborSlots(dayOfWeek, hour) {
  const prevHour = (hour - 1 + 24) % 24;
  const nextHour = (hour + 1) % 24;
  return {
    prevHour,
    nextHour,
    prevDay: prevHour === 23 ? (dayOfWeek - 1 + 7) % 7 : dayOfWeek,
    nextDay: nextHour === 0 ? (dayOfWeek + 1) % 7 : dayOfWeek,
  };
}

// The blend itself, over exactly the three rows the query returns: current
// hour 60%, each neighbour 20%, a missing neighbour standing in as the current
// hour so a closed hour either side does not drag the number down. Returns the
// cache ENTRY body rather than a bare number, because the provenance of the
// anchoring row is what baselineProvenanceFor publishes and it must be decided
// here, in the one place that knows which row was the anchor.
function blendBaselineRows(rows, dayOfWeek, hour) {
  const { prevHour, nextHour } = baselineNeighborSlots(dayOfWeek, hour);
  let current = 0, prev = 0, next = 0;
  let hasCurrent = false;
  let currentRow = null;
  for (const r of rows) {
    const val = parseInt(r.baseline);
    if (r.day_of_week === dayOfWeek && r.hour === hour) { current = val; hasCurrent = true; currentRow = r; }
    else if (r.hour === prevHour) prev = val;
    else if (r.hour === nextHour) next = val;
  }
  if (!hasCurrent) return { data: 0, meta: null };
  const hasNeighbors = prev > 0 || next > 0;
  const data = hasNeighbors
    ? Math.round(current * 0.6 + (prev || current) * 0.2 + (next || current) * 0.2)
    : current;
  return { data, meta: baselineMeta(currentRow.source || null, currentRow.updated_at || null) };
}

// ---------------------------------------------------------------------------
// ONE QUERY FOR A WHOLE WEEK, INSTEAD OF ONE PER HOUR.
//
// getBaseline is keyed per (place, day, hour) and reads three rows per call.
// That is right for the crowd card, which asks about one hour. It is badly
// wrong for the callers that walk a venue's entire week: services/
// advisorFacts.js buildWeekAhead scans every open hour of all seven days, so a
// venue open ten hours a day cost SEVENTY sequential round trips, and a 24/7
// venue a hundred and sixty-eight — and it had already fetched the whole curve
// in one query on the line above the loop, then thrown it away and re-read the
// same table an hour at a time. GET /api/advisor/cards paid that twice over
// and POST /api/advisor/ask pays it on every chip tap, both on the request
// path, both against the twenty-slot pool.
//
// This takes the curve the caller already has and computes every slot's answer
// from it with the SAME blend the query path uses, so the loop that follows is
// a hundred cache hits and no queries at all. Nothing here queries, nothing
// here is charged to the venue-lookup budget, and nothing here can be reached
// with a place id the caller did not already pay to read: it only ever writes
// what the caller's own rows say.
//
// Slots the curve has no row for are deliberately NOT primed. getBaseline then
// misses and takes its normal path, which is the honest answer for an hour the
// venue has no data on, and it keeps this function incapable of teaching the
// cache that a slot is zero when nobody looked.
function primeBaselineCache(placeId, rows) {
  if (!placeId || !Array.isArray(rows) || rows.length === 0) return 0;

  // `Number(null)` is 0 and `Number('')` is 0, so a null hour would key itself
  // as midnight and a null weekday as Sunday — a row silently relocated rather
  // than skipped. ml_venue_baselines makes both columns part of its primary
  // key so the query path cannot produce one, but this function takes rows from
  // its caller, and the cheap check is the one that keeps that true.
  const slotNumber = (v, max) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
  };

  const bySlot = new Map();
  for (const r of rows) {
    const day = slotNumber(r.day_of_week, 6);
    const hour = slotNumber(r.hour, 23);
    if (day === null || hour === null) continue;
    bySlot.set(`${day}_${hour}`, {
      day_of_week: day, hour, baseline: r.baseline,
      source: r.source || null, updated_at: r.updated_at || null,
    });
  }

  const ts = Date.now();
  let primed = 0;
  for (const [slot, row] of bySlot) {
    const { prevHour, nextHour, prevDay, nextDay } = baselineNeighborSlots(row.day_of_week, row.hour);
    // Exactly the row set the single-slot query would have returned, in the
    // same order, so blendBaselineRows cannot tell the two paths apart.
    const trio = [row, bySlot.get(`${prevDay}_${prevHour}`), bySlot.get(`${nextDay}_${nextHour}`)]
      .filter(Boolean);
    const entry = blendBaselineRows(trio, row.day_of_week, row.hour);
    boundedSet(baselineCache, `${placeId}_${slot}`, { data: entry.data, ts, meta: entry.meta });
    primed += 1;
  }
  return primed;
}

// `userId` (optional) is the account a cache MISS is charged to — see
// allowVenueLookup. Hits are answered above the gate and cost nothing.
async function getBaseline(placeId, dayOfWeek, hour, userId) {
  if (!pool || !placeId) return 0;

  const cacheKey = `${placeId}_${dayOfWeek}_${hour}`;
  const cached = baselineCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < BASELINE_CACHE_TTL) return cached.data;

  // Refused misses take the same branch a query error takes, and crucially do
  // NOT write a cache entry — an account that cannot query must also be unable
  // to evict a real venue's baseline. They DO record why, in a separate map,
  // for the reason above noteBaselineMiss.
  if (!allowVenueLookup(placeId, userId)) {
    // TWO DIFFERENT REFUSALS BEHIND ONE GUARD. A place id that is not shaped
    // like one is a standing property of the venue: there is no row for it and
    // there never will be, which is exactly the corpus gap `no_baseline`
    // already names. A budget refusal is momentary and is the one that means
    // "we could not ask". Calling both 'refused' would move every place-id-less
    // venue onto the outage tag and undo the split.
    noteBaselineMiss(cacheKey, isPlaceIdShaped(placeId) ? 'refused' : 'none');
    return 0;
  }

  try {
    // Fetch current hour + neighbors for smoothing
    const { prevHour, nextHour, prevDay, nextDay } = baselineNeighborSlots(dayOfWeek, hour);

    const { rows } = await pool.query(
      // `source, updated_at` join the SELECT so the answer can say how old it
      // is — see BASELINE_STALE_AFTER_MS. They are read, never filtered on: a
      // stale baseline is still the best number this venue has, and refusing to
      // serve it would drop the venue to the rule engine, which is worse. The
      // fix is to LABEL it, not to withhold it.
      `SELECT day_of_week, hour, baseline, source, updated_at FROM ml_venue_baselines
       WHERE google_place_id = $1 AND (
         (day_of_week = $2 AND hour = $3) OR
         (day_of_week = $4 AND hour = $5) OR
         (day_of_week = $6 AND hour = $7)
       )`,
      [placeId, dayOfWeek, hour, prevDay, prevHour, nextDay, nextHour]
    );

    if (rows.length === 0) {
      noteBaselineMiss(cacheKey, 'none');
      boundedSet(baselineCache, cacheKey, { data: 0, ts: Date.now(), meta: null });
      return 0;
    }

    // Weighted average: current hour 60%, neighbors 20% each. The blend and
    // the provenance of the row it anchors on both come from
    // blendBaselineRows, which primeBaselineCache also uses — the two paths
    // must produce the same number for the same rows or a venue's forecast
    // would change depending on which one warmed the cache.
    const entry = blendBaselineRows(rows, dayOfWeek, hour);
    // A usable number clears any recorded miss: the slot is answered now, and
    // leaving the old reason behind would let a resolved outage keep labelling
    // a venue that has since been scored.
    if (entry.data > 0) baselineMissCache.delete(cacheKey);
    else noteBaselineMiss(cacheKey, 'none');
    boundedSet(baselineCache, cacheKey, { data: entry.data, ts: Date.now(), meta: entry.meta });
    return entry.data;
  } catch (err) {
    console.error('[MLPredictor] Baseline lookup failed:', err.message);
    noteBaselineMiss(cacheKey, 'error');
    return 0;
  }
}

// WHY THE ZERO CAME BACK.
//
// getBaseline returns 0 for three unrelated reasons — this venue has no row,
// this caller was refused the lookup, or the query threw — and predictBusyness
// reported all three to the coverage counter as `rule_engine_no_baseline`.
// That tag is a claim about the CORPUS, and it is the dominant entry on the
// admin Revenue panel, so a database wobble or a rate-limited account read as
// "the collector has not reached these venues yet". The one number built to
// answer "should we go collect more baselines" answered it wrongly whenever
// the real problem was that we could not ask.
//
// Its own map rather than a field on the baseline cache entry, because the
// refused path must not write a baseline cache entry at all: an account that
// cannot query must not be able to evict a real venue's number. Same TTL, so
// the two expire together and a reason can never outlive the lookup it
// explains. Bounded the same way as every other cache in this file.
const baselineMissCache = new Map();

function noteBaselineMiss(cacheKey, reason) {
  boundedSet(baselineMissCache, cacheKey, { reason, ts: Date.now() });
}

// null when there is nothing recorded, which includes the case where the entry
// aged out — the caller then falls back to the corpus reading, which is the
// safe default because it is the only one of the three that is a standing
// property of the venue rather than a momentary failure.
function baselineMissFor(placeId, dayOfWeek, hour) {
  if (!placeId) return null;
  const e = baselineMissCache.get(`${placeId}_${dayOfWeek}_${hour}`);
  if (!e || Date.now() - e.ts >= BASELINE_CACHE_TTL) return null;
  return e.reason || null;
}

// ---------------------------------------------------------------------------
// BASELINE FRESHNESS
//
// THE DEFECT THIS EXISTS FOR. ml_venue_baselines had no freshness anywhere:
// storeGoogleBaselines wrote ON CONFLICT DO NOTHING, so a row written once was
// never written again, and no read path looked at its age. Realtime collection
// stopped 2026-05-18. Checked read-only against production 2026-08-18: all
// 3,454,955 baseline rows are source='collected', covering 20,569 venues, and
// there is not one source='google' row. A user in December would have been
// served a spring number with nothing on the card saying so.
//
// WHAT `updated_at` ACTUALLY MEANS, because publishing it as "data age" without
// this caveat would be a second dishonesty on top of the first. It is when the
// ROW was last written, not when the venue was last observed. Every collected
// row in production carries 2026-08-15, which is when migration
// 023_backfill_ml_weekly_local_hours.sql rebuilt the table from the corrected
// weekly corpus — months after the observations behind it were taken. So this
// timestamp is an UPPER BOUND on freshness: the underlying data can only be
// older than the row that holds it, never fresher. `basis` says exactly that in
// the payload so nobody has to re-derive it from a migration file.
//
// 90 DAYS, because a baseline is a WEEKLY pattern and a weekly pattern is
// stable across weeks and unstable across seasons: a college bar in August and
// the same bar in November are different venues. One quarter is the shortest
// interval over which the thing being modelled reliably changes. It is a
// labelling threshold, not a gate — nothing stops being served for being stale.
const BASELINE_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

// 30 DAYS for a Google-sourced row to be rewritten from a fresh popular_times
// payload. Google's popular_times is itself a multi-week aggregate of Google's
// own history, so rewriting it faster than it moves would spend writes on
// noise; a month is inside the 90-day staleness threshold with room to spare,
// so a venue that is looked at even once a month can never go stale by neglect.
const GOOGLE_BASELINE_REFRESH_DAYS = 30;

function baselineMeta(source, updatedAt) {
  const t = updatedAt ? new Date(updatedAt).getTime() : NaN;
  const asOf = Number.isFinite(t) ? t : null;
  return {
    source: source || null,
    // Absolute, never a duration: this object is CACHED (both here and in the
    // crowd route's card cache), and an age baked into a cached object is wrong
    // by the age of the cache. The serve path derives age_ms from this, the way
    // routes/publicCrowd.js already derives it from as_of.
    asOf,
    basis: 'baseline_row_written',
    stale: asOf == null ? null : (Date.now() - asOf) > BASELINE_STALE_AFTER_MS,
    staleAfterMs: BASELINE_STALE_AFTER_MS,
  };
}

// Provenance of the baseline getBaseline just answered with, read back out of
// the same cache entry. Split out rather than folded into getBaseline's return
// because that return is a NUMBER on which the whole delta reconstruction and
// every existing caller depends; widening it would be a shape change for a
// label. Returns null when there is nothing to say (no row, refused lookup,
// query error, or the entry aged out between the two calls).
function baselineProvenanceFor(placeId, dayOfWeek, hour) {
  if (!placeId) return null;
  const cached = baselineCache.get(`${placeId}_${dayOfWeek}_${hour}`);
  if (!cached || Date.now() - cached.ts >= BASELINE_CACHE_TTL) return null;
  return cached.meta || null;
}

// Store Google popular_times as baselines, and REFRESH them once they age out.
//
// This was `DO NOTHING`, which made every row here write-once-forever: the
// first request that ever touched a venue with no collected baseline fixed its
// numbers permanently, and no later request could correct them however much the
// venue changed. `DO NOTHING` was the right instinct for the wrong clause — the
// thing that must not be overwritten is a COLLECTED row, not an old google one.
//
// Hence the WHERE. A collected row is measured data on the corrected clock
// axis, and it is what the delta model's `baseline_busyness` label was computed
// against (see the axis note above getBaseline); overwriting it with Google's
// coarser popular_times would move the anchor out from under the trained
// weights and bias every score for that venue. A google row has no such claim
// on it, so once it is older than GOOGLE_BASELINE_REFRESH_DAYS the fresh
// payload — which is already in hand, fetched for this very request — replaces
// it. Rows fresher than that are left alone, so a busy venue does not pay 168
// writes per request.
//
// `updated_at` is NULLABLE (the column only has a DEFAULT), and a NULL there
// is read as infinitely old rather than skipped. A row whose age is unknown is
// exactly the row that most needs rewriting, and the alternative — NULL makes
// the predicate NULL, so the row is never touched — is the write-once bug
// again, in a corner where nothing would ever have surfaced it.
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
          // The refresh horizon is BOUND, not interpolated: no SQL in this
          // repo is built by string concatenation, and a constant is not an
          // exception worth making.
          `INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source, updated_at)
           VALUES ($1, $2, $3, $4, 'google', NOW())
           ON CONFLICT (google_place_id, day_of_week, hour) DO UPDATE
             SET baseline = EXCLUDED.baseline, updated_at = NOW()
             WHERE ml_venue_baselines.source = 'google'
               AND COALESCE(ml_venue_baselines.updated_at, 'epoch'::timestamptz)
                     < NOW() - make_interval(days => $5::int)`,
          [placeId, dow, h, Math.max(0, Math.min(100, Math.round(val))), GOOGLE_BASELINE_REFRESH_DAYS]
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

// `userId` (optional) is the account a cache MISS is charged to — see
// allowVenueLookup.
async function getUserFeedback(placeId, userId) {
  const noFeedback = { avgCrowd: 0, count: 0, avgErrorMapped: 0, avgErrorLegacy: 0 };
  if (!pool || !placeId) return noFeedback;

  const cached = feedbackCache.get(placeId);
  if (cached && Date.now() - cached.ts < FEEDBACK_CACHE_TTL) return cached.data;

  // Same contract as getBaseline: a refused miss returns what a query error
  // returns and writes nothing.
  if (!allowVenueLookup(placeId, userId)) return noFeedback;

  try {
    const { rows } = await pool.query(
      // ONE ROW PER REPORTER, AND ONLY RECENT ONES.
      //
      // buildCalibrationAdjustment, which moves the PUBLISHED score, carries a
      // three-reporter minimum, a 28 day window, a per-account leverage cap and
      // a DISTINCT ON (user_id) in its own SQL. This query, which feeds FOUR
      // MODEL FEATURES (avg_user_crowd, log_user_feedback_count,
      // has_user_feedback, avg_prediction_error), carried none of them. So the
      // public number was protected from one account and the model's input was
      // not: routes/feedback.js allows one row per person per venue per two
      // hours, so a single verified account tapping the NFC at its own bar
      // every evening for a month is 300 rows, is 100% of that venue's feature
      // values, and nothing ages them out. The header below already named the
      // property ("this average has no time bound, so one bad row steers the
      // venue's anchor for good") and then acted on the owner case only.
      //
      // KEEP THIS IN PARITY WITH scripts/ml/train/export_training_data.js. The
      // training aggregate had the same shape and now has the same guards; a
      // feature computed one way in training and another at inference is the
      // distribution mismatch this file spends its whole feature-assembly
      // section preventing.
      `WITH latest AS (
        SELECT DISTINCT ON (vf.user_id)
               vf.user_id, vf.crowd_level, vf.predicted_score
        -- Two variants of the feedback-error feature. 'mapped' (20/50/80 minus
        -- score, one scale) is the sane definition and what the training
        -- export emits; 'legacy' (raw ordinal minus score) is what models
        -- trained before round 3 saw. Feature assembly picks by model metadata.
        --
        -- verified only: unverified rows are stored for product UX but must not
        -- move live predictions (round 6). And not against an owner-set card:
        -- a comparison with a number the model did not produce is not model
        -- error, and routes/feedback.js closes that at the source.
          FROM venue_feedback vf
         WHERE vf.venue_place_id = $1
           AND vf.verified = true
           -- Equal to crowdEngine.CALIBRATION_MAX_AGE_MS. A report from last
           -- spring may not vote on tonight's features any more than it may
           -- vote on tonight's number.
           AND vf.created_at > NOW() - INTERVAL '28 days'
           AND NOT EXISTS (
             SELECT 1 FROM served_predictions sp
              WHERE sp.id = vf.served_prediction_id
                AND sp.prediction_method = 'owner_report'
           )
         ORDER BY vf.user_id, vf.created_at DESC
      )
      SELECT
        AVG(crowd_level)::numeric(4,1) AS avg_crowd,
        COUNT(*)::int AS count,
        AVG((CASE crowd_level WHEN 1 THEN 20 WHEN 2 THEN 50 ELSE 80 END) - predicted_score)::numeric(5,2) AS avg_error_mapped,
        AVG(crowd_level - predicted_score)::numeric(5,2) AS avg_error_legacy
      FROM latest`,
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
  // Re-cut 2026-08-28 with the qmap arming; the reasoning lives on the
  // canonical copy in crowdEngine.js getLabel, which this must mirror.
  if (score <= 39) return 'Not Busy';
  if (score <= 69) return 'Steady';
  if (score <= 84) return 'Busy';
  return 'Packed';
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

// MUST MATCH scripts/ml/collectEvents.js estimateEndHour: the corpus's event
// window for every training row was [startHour, startHour + duration],
// INCLUSIVE of both end hours (enrichWithEvents.isHourInRange). Serving
// re-derives the same window from the same duration table, so an event is
// "nearby" at prediction time exactly when training would have counted it.
const EVENT_DURATION_HOURS = { music: 3, sports: 3, arts: 2, family: 3, other: 3 };
const EVENT_MAX_DURATION_H = 3; // max of the table — bounds the query window
// Module scope since 2026-09-04: buildEventResult below is lifted out of the
// fetch and needs it, and a constant used by two functions belongs to neither.
const HOUR_MS = 60 * 60 * 1000;

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
// Same ceiling, same reason, as services/nightContext.js MAX_EVENT_ATTENDANCE,
// which carries the long version of this note: `generalInfo.capacity` is a
// promoter-typed field, it was parsed with no bound, and the number lands in
// two INTEGER columns (ml_events.estimated_attendance and
// venue_owner_report_context.total_nearby_attendance / nearest_event_attendance)
// as well as in four features of the crowd model. Past int4 it is a 22003 that
// loses the row; short of that it is simply a wrong score. 250,000 is above
// every venue on earth.
const MAX_EVENT_ATTENDANCE = 250000;

function estimateTmAttendance(event) {
  const venues = event._embedded?.venues || [];
  for (const v of venues) {
    const raw = parseInt(v.generalInfo?.capacity, 10) ||
                parseInt(v.boxOfficeInfo?.capacity, 10) || 0;
    const cap = Number.isFinite(raw) ? Math.min(raw, MAX_EVENT_ATTENDANCE) : 0;
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

// TWO DIFFERENT ZEROS, AND WHY THEY CANNOT SHARE ONE OBJECT (round 24).
//
// This function used to answer with the SAME `noEvents` object in five
// situations: the key is missing, the budget refused the call, Ticketmaster
// returned an error, the request timed out, and Ticketmaster answered with an
// empty list. Only the last of those is an observation. The other four are a
// question nobody asked, and a caller reading `hasEvent: false` could not tell
// which it had.
//
// The crowd model does not care, because a missing feature and a zero feature
// score the same way there and the prediction degrades either way. The venue
// advisor does care, and that is where the indistinguishable sentinel became a
// falsehood: services/advisorFacts.js counted seven of these as seven negative
// observations and built a SOURCED fact reading "No big listed events within
// about a kilometer over the next 7 days" out of seven calls that never
// happened. An owner can staff a night against that sentence.
//
// So every return carries `observed`. True means Ticketmaster answered and
// this is what it said. False means no answer reached us, `unavailableReason`
// says which of the four it was, and the zeros in the rest of the object are
// placeholders rather than measurements. Callers that only read hasEvent keep
// working unchanged; callers that make CLAIMS about the street must check
// `observed` first.
const EVENT_ZERO = {
  hasEvent: false, nearestAttendance: 0, totalEvents: 0,
  totalAttendance: 0, nearestType: null, nearestDistance: 0,
  nearestName: null,
};

// Ticketmaster answered, and the answer was nothing nearby.
function eventsObserved() {
  return { ...EVENT_ZERO, observed: true, unavailableReason: null };
}

// No answer reached us. The zeros below mean "unknown", not "none".
function eventsUnavailable(reason) {
  return { ...EVENT_ZERO, observed: false, unavailableReason: reason };
}

// `userId` (optional) is the account this cache MISS is charged to. Passing it
// is what gives the Ticketmaster budget a caller dimension — see the block above
// allowEventFetch. Cache HITS are answered before the gate and cost nothing,
// which is the rule utils/placesBudget.js states: charging for a call you did
// not make masks the real burn rate.
// The cache key for one venue at one hour. Lifted out so the range prefetch
// below and getNearbyEvents cannot disagree about where an answer is stored.
function eventCacheKeyFor(lat, lng, ms) {
  const d = new Date(ms);
  const slot = Number.isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 13)
    : d.toISOString().slice(0, 13);
  return `${lat.toFixed(2)},${lng.toFixed(2)},${slot}`;
}

// ONE CALL FOR A WHOLE STRIP.
//
// predictHourlyForecast scores up to 24 hours and each hour used to ask
// Ticketmaster for itself. The windows overlap by three of their four hours, so
// the strip re-bought most of the same events 24 times over, and with the card's
// own lookup that is 25 calls for one venue. EVENT_DAILY_BUDGET is 1500, so
// sixty cold cards a day emptied the budget for the entire product and event
// enrichment then silently vanished for everybody.
//
// The union of those windows is one contiguous range, and buildEventResult is
// pure in the hour, so a single fetch answers every slot. `size` is raised for
// the range because a 27 hour window in a dense city can hold more than the 20
// a single-hour window ever needed; Discovery allows up to 200 on one page.
//
// FAILURE IS A NO-OP ON PURPOSE. Nothing is cached and nothing is thrown: the
// per-hour path then behaves exactly as it does today. This can only turn 25
// calls into 1, never into 0 answers.
async function prefetchEventRange(lat, lng, startMs, hours, userId, opts) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey || !lat || !lng) return;
  const from = new Date(startMs);
  if (Number.isNaN(from.getTime()) || !(hours > 1)) return;

  // Every slot already answered is one this prefetch does not need to buy.
  const startHour = Math.floor(from.getTime() / HOUR_MS);
  const wanted = [];
  for (let i = 0; i < hours; i += 1) {
    const h = startHour + i;
    if (!eventCache.get(eventCacheKeyFor(lat, lng, h * HOUR_MS))) wanted.push(h);
  }
  if (wanted.length < 2) return; // one slot is what getNearbyEvents already does well

  if (!allowEventFetch(userId, opts)) return;

  try {
    const openMs = (wanted[0] - EVENT_MAX_DURATION_H) * HOUR_MS;
    const closeMs = (wanted[wanted.length - 1] + 1) * HOUR_MS - 1000;
    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: `${lat},${lng}`,
      radius: '2',
      unit: 'km',
      startDateTime: new Date(openMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      endDateTime: new Date(closeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      size: '200',
      sort: 'date,asc',
    });
    const response = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params}`,
      { signal: upstreamSignal('ticketmaster') }
    );
    if (!response.ok) return;
    const data = await response.json();
    const events = data._embedded?.events || [];
    for (const h of wanted) {
      cacheEvents(eventCacheKeyFor(lat, lng, h * HOUR_MS),
        buildEventResult(events, lat, lng, h));
    }
  } catch {
    // Same posture as the per-hour catch: an unseen street is not an empty one,
    // and here we simply decline to seed. The hourly path will ask for itself.
  }
}

async function getNearbyEvents(lat, lng, timestamp, userId, opts) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return eventsUnavailable('no_api_key');
  if (!lat || !lng) return eventsUnavailable('no_coordinates');

  // Round 10: the key used to be hour-only, so the 6-day owner forecast served
  // day 1's events for every future date — the upstream query window is built
  // from the full timestamp (startDateTime/endDateTime), so the key has to
  // carry the date too. UTC "YYYY-MM-DDTHH" matches the request window exactly.
  const keyTs = timestamp ? new Date(timestamp) : new Date();
  // Built by eventCacheKeyFor so this and prefetchEventRange cannot
  // disagree about where an answer is stored.
  const cacheKey = eventCacheKeyFor(lat, lng, keyTs.getTime());
  const cached = eventCache.get(cacheKey);
  if (cached) {
    // A remembered FAILURE expires in a minute, a remembered ANSWER in an hour.
    // Failures are cached at all for the reason weatherService's WX_NEGATIVE_TTL
    // states: an outage that is not remembered re-charges the budget on every
    // request, so a broken upstream is the fastest way to spend a day. But an
    // hour was the wrong length once the advisor started reading `observed`,
    // because it holds the venue advisor silent about the street for an hour
    // after Ticketmaster has already recovered. Sixty seconds keeps the
    // hundredfold reduction and follows a recovery almost immediately.
    const ttl = cached.data && cached.data.observed === false
      ? EVENT_NEGATIVE_TTL
      : EVENT_CACHE_TTL;
    if (Date.now() - cached.ts < ttl) return cached.data;
  }

  // IN-FLIGHT COALESCING — the half of the cache that a cache alone cannot do.
  //
  // Found while pinning the batch route (money audit round 2, M1): bucketing
  // the coordinates makes twenty venues in one metro area share ONE cache key,
  // but routes/crowd.js scores those twenty venues in a Promise.all, so all
  // twenty reach this line before any of them has written a cache entry. A
  // cache is a memory of a FINISHED call; twenty simultaneous misses on the
  // same key were still twenty Ticketmaster calls, and the cache only ever saw
  // the last one. So the worst case of one request stayed at twenty upstream
  // calls no matter how well the key space collapsed.
  //
  // A promise per key closes that: the first caller starts the call, the other
  // nineteen await the same promise and are answered with the same object. It
  // is charged ONCE, because the budget gate lives on the far side of this
  // check — which is the correct reading of "charge what you spend", not a
  // discount.
  //
  // Deleted in a finally, so a rejection (impossible today — the fetch is
  // wrapped below — but not something this line should depend on) cannot leave
  // a permanently poisoned key behind. The map is therefore bounded by
  // concurrency rather than by time and needs no eviction policy of its own.
  const inflight = eventInflight.get(cacheKey);
  if (inflight) return inflight;
  const pending = fetchNearbyEvents(cacheKey, lat, lng, timestamp, userId, opts);
  eventInflight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    eventInflight.delete(cacheKey);
  }
}

// The per-slot filter, lifted out of the fetch on 2026-09-04 so ONE fetched
// list can answer many hours.
//
// Everything below depends only on the events, the venue's coordinates and
// the HOUR being asked about. That is what makes a range prefetch possible:
// a 24 hour strip used to make up to 24 upstream calls whose windows overlap
// by three hours each, re-buying most of the same events every time, and
// EVENT_DAILY_BUDGET divided by 25 is sixty cold venue cards a day for the
// whole product before event enrichment silently vanishes for everyone.
//
// Pure: no cache write, no budget charge, no network. The two callers below
// own those.
function buildEventResult(events, lat, lng, tsHour) {
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

    // ONGOING, THE WAY TRAINING COUNTED IT: hour(t) inside [startHour,
    // startHour + duration], both ends inclusive, at hour granularity
    // (enrichWithEvents.isHourInRange over collectEvents.estimateEndHour's
    // per-type durations). Hour floors of real instants: offsets cancel for
    // whole-hour timezones, and a half-hour zone is off by at most the same
    // hour of slack training's integer-hour comparison already had. An event
    // whose start Ticketmaster does not timestamp stays counted — it matched
    // the query window, so it started within the last EVENT_MAX_DURATION_H
    // hours, and "probably mid-show" beats inventing a start time.
    const type = mapTmEventType(e.classifications);
    const startMs = Date.parse(e.dates?.start?.dateTime || '');
    if (Number.isFinite(startMs)) {
      const hoursSinceStart = tsHour - Math.floor(startMs / HOUR_MS);
      const durH = EVENT_DURATION_HOURS[type] ?? EVENT_MAX_DURATION_H;
      if (hoursSinceStart < 0 || hoursSinceStart > durH) continue;
    }

    const attendance = estimateTmAttendance(e);
    totalNearby++;
    totalAttendance += attendance;

    if (dist < nearestDist) {
      nearestDist = dist;
      nearestEvent = { name: e.name, type, attendance };
    }
  }

  // Everything Ticketmaster listed was too far away, over, or unplaceable.
  // The listing ran, so this is observed: an empty street, honestly.
  return nearestEvent ? {
    hasEvent: true,
    nearestAttendance: nearestEvent.attendance,
    totalEvents: totalNearby,
    totalAttendance,
    nearestType: nearestEvent.type,
    nearestDistance: Math.round(nearestDist * 100) / 100,
    nearestName: nearestEvent.name,
    observed: true,
    unavailableReason: null,
  } : eventsObserved();
}

// The uncoalesced half of getNearbyEvents. Never call this directly: it neither
// reads the cache nor dedupes concurrent callers, so a direct call is an
// unshared paid Ticketmaster request.
async function fetchNearbyEvents(cacheKey, lat, lng, timestamp, userId, opts) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  // Budget applies only to cache MISSES (real upstream calls). A refusal here
  // is the cheapest of the four unobserved cases: no call was made, so nothing
  // is cached and the next request in a new budget window asks for real.
  if (!allowEventFetch(userId, opts)) return eventsUnavailable('budget_exhausted');

  try {
    const ts = timestamp ? new Date(timestamp) : new Date();
    // TRAINING'S WINDOW, NOT "COMING SOON" (train/serve skew hunt 2026-08-19).
    // This used to ask Ticketmaster for events STARTING in [t, t+3h] — but
    // training (scripts/ml/enrichWithEvents.js) counted events ONGOING at the
    // row hour: startHour through startHour + duration, inclusive. Two
    // divergences at once: a 20:00 arena show was invisible at 21:00, mid-show
    // (which also suppressed the eventAlert banner during the show itself),
    // while a show starting at 23:00 was counted at 20:00, three hours before
    // training would have counted it. The window now opens EVENT_MAX_DURATION_H
    // back from the prediction HOUR (hour floor, matching training's integer-
    // hour comparison) and closes at the end of that hour, so every candidate
    // whose active window can contain this hour is fetched; the per-event
    // duration filter in the loop below does the exact per-type arithmetic.
    const tsHour = Math.floor(ts.getTime() / HOUR_MS);
    const startDt = new Date((tsHour - EVENT_MAX_DURATION_H) * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const endDt = new Date((tsHour + 1) * HOUR_MS - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

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
      // Ticketmaster refused to answer. That is not an empty street.
      const failed = eventsUnavailable('provider_error');
      cacheEvents(cacheKey, failed);
      return failed;
    }

    const data = await response.json();
    const events = data._embedded?.events || [];

    if (events.length === 0) {
      // A real answer, and the answer is nothing. This is the one branch that
      // may be quoted back to an owner as a listing we made and came up empty.
      const empty = eventsObserved();
      cacheEvents(cacheKey, empty);
      return empty;
    }

    const result = buildEventResult(events, lat, lng, tsHour);

    cacheEvents(cacheKey, result);
    return result;
  } catch (err) {
    // The timeout lands here (upstreamSignal aborts the fetch), along with a
    // network error and an unreadable body. None of them saw the street.
    console.error('[MLPredictor] Event lookup failed:', err.message);
    // Both names, because which one arrives depends on the fetch
    // implementation: AbortSignal.timeout aborts with a TimeoutError, and
    // undici has historically surfaced a plain AbortError for the same event.
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const failed = eventsUnavailable(aborted ? 'timeout' : 'lookup_failed');
    cacheEvents(cacheKey, failed);
    return failed;
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
//
// ---------------------------------------------------------------------------
// THE CACHE KEY MUST NOT CONTAIN A VALUE THE CALLER PICKS (audit round 3, I3-2)
// ---------------------------------------------------------------------------
// 2878da5 bucketed the caller's coordinates to 2 decimals in
// POST /api/crowd/batch so this cache and the event cache would collapse. It
// did not work here, because the key was
// `lat.toFixed(3)_lng.toFixed(3)_place_id` and `place_id` on that route is
// deliberately not shape-checked. A caller sending 20 arbitrary place ids per
// request therefore missed 20 times per request, forever — and a miss is the
// lat/lng RANGE SCAN below, the dominant database cost on this path. The audit
// measured ~4,000 range scans a minute from one account.
//
// WHY IT IS SAFE TO SHARE ONE ENTRY ACROSS EVERY VENUE IN A BUCKET. The query
// is a geographic range scan: its WHERE clause names only latitude, longitude
// and the ml_venues/ml_venue_baselines join. The ONLY thing the venue's own
// identity ever did in it was the `v.google_place_id != $3` exclusion, i.e.
// "do not count myself as my own neighbour". So the expensive half of the
// answer — which venues surround this point, and what their same-hour
// baselines are — genuinely depends on the coordinates and the time slot
// alone, and two venues inside the same ~1.1 km bucket have the same
// neighbourhood by construction.
//
// SO THE EXCLUSION IS ARITHMETIC, NOT A FILTER. The cached entry now holds the
// COUNT and the SUM over the whole box, self included, and self is subtracted
// at read time. That is exactly what the training pipeline does — read
// scripts/ml/train/prepare_features.py add_neighbor_features:
//
//     neighbor_count               = w_cnt - 1
//     neighbor_baseline_same_hour  = (w_sum - bl) / neighbor_count
//
// window totals first, self taken off afterwards. Serving it the same way is
// parity by construction rather than by coincidence.
//
// Dropping the exclusion instead would NOT have been immaterial, and this is
// worth stating because it is the tempting shortcut: a venue alone in its box
// would go from `{count: 0, mean: 0}` to `{count: 1, mean: <its own
// baseline>}`, which feeds the venue's own baseline into a feature the model
// learned means "the activity around me". The model has never seen that during
// training. It is a train/serve skew and a self-referential feature at once.
//
// The self lookup that pays for the subtraction is keyed on google_place_id,
// so it is an INDEX SEEK returning at most 168 rows, not a range scan, and it
// is cached per place for 24h (negative results included, which is the
// fabricated-id case). An attacker cycling place ids still pays one seek each
// — the same class of per-id cost getBaseline and getUserFeedback already
// carry on this path — but the range scan, which is the finding, now happens
// once per bucket per day no matter how many ids are thrown at it.
//
// The query coordinates are the BUCKETED ones, not the raw ones. Before, the
// key was rounded but the box was centred on whichever caller happened to
// populate the entry, so the cached value was not actually a function of its
// own key. It is now.
const NEIGHBOR_CACHE_TTL = 24 * 60 * 60 * 1000;
// ~0.0075 degrees is ~830 m of latitude, i.e. the ~1 km neighbourhood the
// training pipeline's 3x3 grid of 500 m buckets covers.
const NEIGHBOR_BOX_DEG = 0.0075;
const neighborCache = new Map();      // "lat.toFixed(3)_lng.toFixed(3)" -> box totals
const selfBaselineCache = new Map();  // place_id -> that venue's own baselines

// ---------------------------------------------------------------------------
// THE BUCKET IS STILL THE CALLER'S NUMBER — audit round 4, R4-I2
// ---------------------------------------------------------------------------
// Round 3 took `place_id` out of the key above and the round-4 audit confirmed
// the correctness half of that held in every case it could construct. The
// DENIAL half did not, and the reason is one sentence: the key stopped being
// the caller's STRING and became the caller's NUMBER.
//
//     {"venues":[{"place_id":"x","location":{"latitude":40.11,"longitude":-74.01}},
//                {"place_id":"x","location":{"latitude":40.12,"longitude":-74.01}}, …]}
//
// routes/crowd.js rounds the batch route's coordinates to 2 decimals, so the
// reachable key space is ~648 million buckets, and twenty distinct coordinate
// pairs in one request are still twenty guaranteed misses — twenty bounding-box
// range scans over ml_venues ⋈ ml_venue_baselines, which is the same figure
// round 3 measured for the place_id version. At apiLimiter's 3,000 requests per
// 15 minutes that is ~4,000 range scans a minute from one account, aimed at the
// primary pool. The 2,000-entry FIFO makes it worse than a wasted query: the
// map is fully churned in 100 requests, so real users' buckets miss too.
//
// RAISING PREDICTOR_CACHE_MAX IS NOT A FIX. No cache size beats a 648-million-
// wide key space. The rule the round-4 audit asked to be applied to the CLASS
// rather than to the instance is: **a cache key is a security control, and it
// is only as good as the part of the key the caller cannot choose.** When no
// part of the key is server-derived, the cache cannot be the control, and the
// control has to be a budget denominated in the work a MISS actually does.
//
// So the two halves below, in the order getNearbyEvents already uses for the
// identical problem on the Ticketmaster leg (M1):
//
//   1. IN-FLIGHT COALESCING. routes/crowd.js scores twenty venues in a
//      Promise.all, so twenty callers on one bucket all reach the miss branch
//      before any of them has written an entry. A cache is a memory of a
//      FINISHED query; without coalescing, twenty simultaneous misses on one
//      key were still twenty range scans and the cache only ever saw the last.
//      This is the half that makes the legitimate case free: a vote list in one
//      downtown collapses to ONE scan.
//   2. A PER-ACCOUNT BUDGET ON MISSES ONLY. Hits are answered above the gate
//      and cost nothing — charging for a query you did not run masks the real
//      burn rate (utils/placesBudget.js states the same rule). A refused miss
//      does not run the scan AND does not write a cache entry, so the same
//      gate closes the eviction-churn variant: an account that cannot scan
//      cannot evict anybody either.
//
// WHY 120/HOUR AND 400/DAY. The unit is one uncached ~1 km bucket, not one
// request and not one venue. A batch of twenty venues in one metro collapses to
// a handful of 0.01-degree buckets after routes/crowd.js's rounding, and the
// entry then lives 24 hours, so a real session in a new city costs single
// digits and a session in a city the user already browsed costs zero. 120 an
// hour is therefore roughly twenty cold vote lists an hour, far past what
// browsing looks like, and 400 a day leaves headroom for a heavy day of travel.
// It cuts the walk from ~4,000 range scans a minute to 2, a ~2,000x reduction,
// and unlike apiLimiter a fresh lane costs a fresh account rather than a fresh
// proxy.
//
// WHY REFUSAL RETURNS `none` AND NOT AN ERROR, and why that is not train/serve
// skew. `{count: 0, mean: 0}` is already this function's failure contract on
// every other path — no pool, no coordinates, a thrown query — and it is also
// what a genuinely empty box returns. buildFeatureMap consumes it as
// log_neighbor_count = log1p(0) and neighbor_baseline_same_hour = 0, values the
// model saw during training for isolated venues. The subtraction arithmetic
// above is UNTOUCHED by this change: parity with prepare_features.py's
// add_neighbor_features (window totals first, self removed afterwards) is
// decided entirely inside the hit branch, which a budget refusal never reaches.
//
// WHO IS CHARGED. Only callers that HAVE an account, exactly as allowEventFetch
// decides it: background producers (services/crowdAlerts.js) and the
// unauthenticated marketing demo pass no userId and keep the un-metered
// behaviour, because routes/publicCrowd.js already gates the demo per IP and
// buckets its coordinates. A userId that is SUPPLIED but malformed is refused
// rather than waved through — createUserBudget.allow() fails closed on anything
// that is not a positive integer id.
// ---------------------------------------------------------------------------
const NEIGHBOR_USER_HOURLY = 120;
const NEIGHBOR_USER_DAILY = 400;
const neighborUserBudget = createUserBudget({
  name: 'crowd-neighbors',
  hourly: NEIGHBOR_USER_HOURLY,
  daily: NEIGHBOR_USER_DAILY,
});
// key -> Promise<entry|null>. Bounded by concurrency rather than by time: every
// entry is deleted in a `finally`, so a rejection cannot leave a poisoned key.
const neighborInflight = new Map();

// The venue's own contribution to the box it sits in: its coordinates (so the
// caller can check it really is inside the box the totals were taken over) and
// its baseline per dow/hour. Returns null when the venue is not in the corpus
// at all — the common case for a fabricated place id — and null on failure, in
// which case nothing is subtracted and the neighbour count is one too high
// rather than wrong in the model's favour.
// `userId` (optional) is the account a cache MISS is charged to — see
// allowVenueLookup. A refusal returns null, which is the same value a failed
// query returns and which the caller reads as "subtract nothing", so the
// neighbour count comes back one too high rather than wrong in the model's
// favour. The self-subtraction arithmetic itself is untouched.
async function getSelfBaselines(placeId, userId) {
  if (!pool || !placeId) return null;
  const cached = selfBaselineCache.get(placeId);
  if (cached && Date.now() - cached.ts < NEIGHBOR_CACHE_TTL) return cached.data;
  if (!allowVenueLookup(placeId, userId)) return null;
  try {
    const r = await pool.query(
      `SELECT v.latitude AS lat, v.longitude AS lng, b.day_of_week AS dow, b.hour, b.baseline
         FROM ml_venues v
         JOIN ml_venue_baselines b ON b.google_place_id = v.google_place_id
        WHERE v.google_place_id = $1`,
      [placeId]
    );
    let data = null;
    if (r.rows.length > 0) {
      const byDowHour = new Map();
      for (const row of r.rows) {
        byDowHour.set(`${row.dow}_${row.hour}`, parseFloat(row.baseline) || 0);
      }
      data = { lat: parseFloat(r.rows[0].lat), lng: parseFloat(r.rows[0].lng), byDowHour };
    }
    boundedSet(selfBaselineCache, placeId, { ts: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

// The uncoalesced, unmetered half of getNeighborActivity. Never call this
// directly: it neither reads the cache nor dedupes concurrent callers, so a
// direct call is an unshared bounding-box range scan on the primary pool.
// Returns null when the scan did not happen or failed, which the caller reads
// as `none` — see the `none` note in the block above.
async function scanNeighborBox(key, bLat, bLng, userId) {
  // Budget applies only to cache MISSES (real range scans), and it is read
  // BEFORE the query so a refused caller neither scans nor writes an entry.
  //
  // `userId != null` is the same optional-identity contract allowEventFetch
  // uses, and the guard has to be written this way round: allow() fails CLOSED
  // on anything that is not a positive integer id, so `!allow(undefined)` would
  // have refused every background producer and the whole unauthenticated demo.
  // A SUPPLIED but malformed id still goes to allow() and is still refused.
  if (userId != null && !neighborUserBudget.allow(userId)) return null;
  try {
    const r = await pool.query(
      `SELECT b.day_of_week AS dow, b.hour, COUNT(*)::int AS cnt, COALESCE(SUM(b.baseline), 0) AS sum_bl
       FROM ml_venues v
       JOIN ml_venue_baselines b ON b.google_place_id = v.google_place_id
       WHERE v.latitude BETWEEN $1 - $3::float AND $1 + $3::float
         AND v.longitude BETWEEN $2 - $3::float AND $2 + $3::float
       GROUP BY b.day_of_week, b.hour`,
      [Number(bLat), Number(bLng), NEIGHBOR_BOX_DEG]
    );
    const byDowHour = new Map();
    for (const row of r.rows) {
      byDowHour.set(`${row.dow}_${row.hour}`, {
        cnt: row.cnt,
        sum: parseFloat(row.sum_bl) || 0,
      });
    }
    const entry = { ts: Date.now(), byDowHour };
    boundedSet(neighborCache, key, entry);
    return entry;
  } catch {
    return null;
  }
}

// `userId` (optional) is the account a cache MISS is charged to — see the
// R4-I2 block above. Omitting it keeps the un-metered behaviour, which is the
// right answer for background producers and the unauthenticated demo.
async function getNeighborActivity(placeId, lat, lng, dayOfWeek, hour, userId) {
  const none = { count: 0, mean: 0 };
  if (!pool || !lat || !lng) return none;
  // The key IS the box. Query on the bucketed coordinates so the cached entry
  // is a function of nothing else.
  const bLat = (+lat).toFixed(3);
  const bLng = (+lng).toFixed(3);
  const key = `${bLat}_${bLng}`;
  let entry = neighborCache.get(key);
  if (!entry || Date.now() - entry.ts >= NEIGHBOR_CACHE_TTL) {
    // Coalesce first, charge second. Nineteen of the twenty callers on one
    // bucket await the same promise and are charged nothing, because the gate
    // lives on the far side of this check. That is the correct reading of
    // "charge what you spend", not a discount: only one scan is spent.
    const inflight = neighborInflight.get(key);
    if (inflight) {
      entry = await inflight;
    } else {
      const pending = scanNeighborBox(key, bLat, bLng, userId);
      neighborInflight.set(key, pending);
      try {
        entry = await pending;
      } finally {
        neighborInflight.delete(key);
      }
    }
    if (!entry) return none;
  }

  const slot = entry.byDowHour.get(`${dayOfWeek}_${hour}`);
  if (!slot || slot.cnt <= 0) return none;

  // Take self back out, the way add_neighbor_features does. Only if this venue
  // really is one of the rows the totals counted: it needs a baseline for THIS
  // slot and its stored coordinates have to fall inside the box.
  const self = await getSelfBaselines(placeId, userId);
  const inBox = !!self
    && Math.abs(self.lat - Number(bLat)) <= NEIGHBOR_BOX_DEG
    && Math.abs(self.lng - Number(bLng)) <= NEIGHBOR_BOX_DEG;
  const own = inBox ? self.byDowHour.get(`${dayOfWeek}_${hour}`) : undefined;

  const count = Math.max(0, slot.cnt - (own === undefined ? 0 : 1));
  if (count === 0) return none;
  const mean = Math.max(0, Math.min(100, (slot.sum - (own || 0)) / count));
  return { count, mean };
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

// Training's fill for a category the baseline table has never seen:
// prepare_features.add_baseline_features does fillna(cat_maps['global_mean'])
// — the corpus mean of busyness_pct — never 0. An artifact that carries the
// exact number publishes it as `category_global_mean` (none does yet); until
// then the mean of the category_baselines table is the closest train-consistent
// stand-in, the same construction globalTempNorm uses for temp_norms. The old
// `|| 0` here was worth 11 points if ever reached (measured 2026-08-18 on the
// shipped artifact: 59 vs 70). Latent — no live caller produces an
// out-of-vocab category today — which is exactly why it must not wait to be
// found live. Memoised per table identity, like globalTempNorm.
let catBaselineMean = { src: null, value: null };
function categoryGlobalMean(meta) {
  const m = meta || metadata || {};
  const explicit = Number(m.category_global_mean);
  if (Number.isFinite(explicit)) return explicit;
  const table = m.category_baselines || {};
  if (catBaselineMean.src === table) return catBaselineMean.value;
  const vals = Object.values(table).map(Number).filter(Number.isFinite);
  const value = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  catBaselineMean = { src: table, value };
  return value;
}

// The training run's climatology for this venue: same 5-degree latitude banding
// as prepare_features.add_climate_anomaly, same global-mean fallback. Units are
// whatever the training rows were in, which is °F.
function climateNorm(lat, month) {
  const exact = monthClimateNorm(lat, month);
  if (exact != null) return exact;
  return globalTempNorm();
}

// ---------------------------------------------------------------------------
// THE SEASONAL NORMAL FOR THIS MONTH, OR NOTHING. Split out of climateNorm
// 2026-08-26, because its two consumers need different answers and sharing one
// pinned temp_anomaly at its clip for most of the year.
//
// WHAT THE TABLE ACTUALLY CONTAINS. prepare_features.add_climate_anomaly builds
// temp_norms by grouping the TRAIN SPLIT on (5-degree latitude band, month) and
// taking mean temperature, so a key exists exactly when training rows exist for
// that band and month. The shipped v2.6.0-starling artifact carries thirty keys
// and every one of them is month 3, 4 or 5: the corpus is one spring, its last
// row is 2026-05-18, and all four season one-hots are declared constant slots
// in corpus_contract.dead_slots.
//
// WHAT THAT DID TO SERVING. climateNorm's miss fell through to globalTempNorm(),
// the mean of the whole table, which on this artifact is 66.01F. That number is
// a spring average taken across every latitude from -35 to 55, so outside March
// through May it is not a climatology at all, and it was the norm subtracted on
// EVERY prediction for nine months of the year:
//
//   band 40 (Lehigh), August, an 82F evening    anomaly +16.0, warm_evening 1
//   band 40 (Lehigh), December, a 34F evening   anomaly -25.0 (the clip floor)
//
// A normal December evening is not twenty-five degrees colder than normal, and
// a normal August evening is not sixteen degrees warmer than normal. The
// feature is DEFINED as the deviation from the seasonal norm, so with no norm
// for the season there is no deviation to state, and is_warm_anomaly_evening
// (anomaly > 5 AND hour >= 17) was stuck at 1 on every summer evening, which is
// the exact opposite of the patio signal it was added in v2.4 to carry.
//
// MEASURED on the shipped artifact, 72 venue-hours per month across bar, cafe
// and restaurant, comparing the served vector against the same vector with
// these two slots zeroed:
//
//   May (inside the corpus)   mean |delta| 0.035 pts, max 0.236
//   August                    mean |delta| 0.260 pts, max 0.755
//   December                  mean |delta| 2.049 pts, max 7.069
//
// So the feature is worth almost nothing when it is in distribution and up to
// seven points of pure fabrication when it is not.
//
// WHY ZERO IS THE RIGHT NO-INFORMATION VALUE, and why mirroring the training
// fill was not. The obvious objection is that prepare_features fills a missing
// norm with global_mean and serving must match it. It does not apply here: the
// norms table is BUILT from the train split, so the merge cannot miss on a
// training row and `fillna(global_mean)` never described a single one. It is a
// serve-time-only construct. Zero, by contrast, is the centre of the trained
// temp_anomaly distribution and is already what this file produces for an
// imputed temperature (see the block in buildFeatureMap), so it is a value the
// model has seen hundreds of thousands of times. Copying a Python line that
// never ran is not parity; landing in the distribution the weights were fit on
// is. Same lesson cold_outdoor's unit bug taught two rounds ago: check the
// values, not the source.
//
// WHAT REOPENS THIS. A retrain on a corpus that spans the year fills the table
// in and this branch stops firing on its own, with no code change. Nothing here
// invents a climatology, and nothing here should: the honest answer to "what is
// normal for a Lehigh Valley December" is that this artifact has never seen one.
// Pinned by __tests__/serveTrainSkew.test.js (e).
//
// Returns null rather than a number when the artifact has no norm for this
// (band, month). tempForFeature still goes through climateNorm above, because
// there the global mean is doing a different job: it is the only in-range
// temperature available to impute, and the alternative is the rule engine.
//
// THAT CHOICE HAS A PRICE AND IT IS NOW MEASURED, 2026-08-26. The sentence
// above was an argument with no number under it, and the number is not small.
// Outside March through May, climateNorm hands the model 66.01F as this venue's
// temperature, which is the same spring-average-of-every-latitude the anomaly
// slot was just stopped from using. Scored on the shipped graph, band 40,
// 60 venue-hours per month across bar, cafe and restaurant, comparing the
// served number against the same vector holding a plausible reading for that
// month (32F in January through 36F in December):
//
//   January   mean |delta| 4.57 pts, max 7      December  mean 1.35, max 3
//   February  mean 3.67 pts, max 6              April     mean 0.00, max 0
//
// So a January answer built on an imputed temperature is further from the
// answer a real reading would have produced than the December anomaly bug ever
// was (that one measured 2.05 mean, 7.07 max). It is NOT the same defect: this
// path fires only when the reading is missing entirely, which is a weather
// outage rather than every request, and unlike the anomaly there is no
// no-information value for a temperature, so imputing or refusing are the only
// two moves. But the refusal IS wired and reachable: tempForFeature returning
// null already lands on rule_engine_no_weather_norm below. Swapping this to
// monthClimateNorm would route every no-reading prediction for nine months of
// the year to the rule engine, which is a product decision about degraded mode
// and not one to make inside a comment. It is left as it is, with the cost
// written down instead of asserted away.
//
// AND THE PRESENCE CHECK IS NOT A CONFIDENCE CHECK. A (band, month) cell is
// trusted the moment it exists, however few training rows built it, and the
// artifact carries no counts to tell a cell built from thousands from one built
// from a handful. The shipped table shows the shape of the problem: months 3
// and 4 hold 8 and 9 bands, month 5 holds 13, and bands 0, 5, 15 and -25 exist
// in May and nowhere else. A retrain that emits row counts alongside the norms
// is what would let this ask the better question.
function monthClimateNorm(lat, month) {
  const norms = (metadata && metadata.temp_norms) || {};
  const band = Math.round((Number(lat) || 0) / 5) * 5;
  const exact = Number(norms[`${band}_${month}`]);
  return Number.isFinite(exact) ? exact : null;
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
  // FILLED THE WAY THE LOADED MODEL WAS TRAINED, which is not the same answer
  // forever. prepare_features.py used to do review_count.fillna(0), so a venue
  // with no Google data was described to the model as having zero reviews -
  // the minimum of the range, meaning "nobody has ever been here", while
  // `rating` one line above was filled with the median. Two features about the
  // same unknown venue disagreeing about what unknown means is a learnable
  // signature for the collection path rather than the venue, which is why the
  // trainer now imputes the median and publishes it as median_review_count.
  //
  // Serving cannot simply follow suit. The artifact in models/ decides: a model
  // trained with the zero fill must be SERVED the zero fill, or every cold
  // venue moves under weights that never saw that value. So the presence of
  // median_review_count in the metadata is the signal, exactly as
  // median_rating is above, and v2.6.0-starling (which has no such key) keeps
  // the zero it was trained on. The first retrain after this ships the key and
  // the branch flips on its own.
  //
  // `??` rather than `||` because once the median fill is live the difference
  // matters: Google answering "0 reviews" is a measurement, and `||` would
  // throw that away and substitute the median for a venue we know is new.
  const reviewCount = venue.user_ratings_total
    ?? venue.review_count
    ?? (metadata.median_review_count ?? 0);

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

  // Event data (from live Ticketmaster lookup).
  //
  // WHAT AN UNOBSERVED LOOKUP IS ALLOWED TO PUT IN THE VECTOR (2026-08-20).
  //
  // getNearbyEvents now says whether it actually heard from Ticketmaster
  // (`observed`), because four different failures used to arrive here wearing
  // the same zeros. The question this block has to answer is what those
  // fourteen event slots should hold when the answer is "nobody knows".
  //
  // They hold the same values a genuinely event-free hour holds, and that is a
  // decision rather than the old accident. There is no in-distribution way to
  // say "unknown" to this model: prepare_features.py ends with fillna(0) over
  // the feature columns, so every missing event value in the corpus was
  // trained as 0, and has_nearby_event is a hard 0/1 that every tree splits at
  // 0.5. A sentinel (-1, NaN, a fractional base rate) would be a value the
  // model has never seen, which is the same mistake as the `?? 20` that told
  // it 20F on every weather outage. Train/serve skew invented to express
  // honesty is still train/serve skew.
  //
  // What that produces is the right fallback anyway, and it is worth naming.
  // With every event slot at its no-information value the event pathway
  // contributes nothing, and this is a delta model: the answer reverts to
  // baseline plus what the non-event features say, which IS the venue's own
  // baseline expectation for that slot. The failure mode being fixed was never
  // the arithmetic. It was that the system could not tell it had done this,
  // so an outage was published with the confidence of a measurement and
  // written into venue_owner_report_context as one. predictBusyness now reads
  // `observed` and says so in the response, and drops the Ticketmaster claim
  // out of dataSourcesUsed. It does NOT invent a confidence penalty for it:
  // see the note above predictBusyness for why an unmeasured deduction would
  // be the same class of mistake one level up.
  //
  // REJECTED: answering from crowdEngine when events are unobserved, the way
  // the no-climatology weather path does. The rule engine has no event input
  // either, so it would trade every other feature away for nothing.
  //
  // The polarity here is deliberately the opposite of
  // services/ownerReportContext.js, which treats a shape with no `observed`
  // flag as unobserved. Writing a fact into a training corpus should fail
  // closed. Changing a live prediction's inputs should not fire on the absence
  // of a flag, only on a positive statement that the lookup failed.
  const ev = eventData || {};
  const eventsUnobserved = ev.observed === false;
  const hasEvent = (!eventsUnobserved && ev.hasEvent) ? 1 : 0;
  const nearestAttendance = eventsUnobserved ? 0 : (ev.nearestAttendance || 0);
  const totalEvents = eventsUnobserved ? 0 : (ev.totalEvents || 0);
  const totalAttendance = eventsUnobserved ? 0 : (ev.totalAttendance || 0);
  const nearestDistance = eventsUnobserved ? 0 : (ev.nearestDistance || 0);
  const nearestType = eventsUnobserved ? null : (ev.nearestType || null);
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
    // 41, not 5. The threshold was written in Celsius against a Fahrenheit
    // column: weatherService fetches units=imperial, so `temp < 5` meant -15C.
    // It was false on every one of the 1.93M training rows (corpus minimum
    // 14.7F) and on essentially every live reading, so cold_outdoor was a dead
    // feature slot on BOTH sides. The parity gate stayed green throughout,
    // because both sides were wrong in exactly the same way — which is the
    // reason a unit error has to be caught by looking at the values, and is now
    // caught by prepare_features.py's dead-slot contract. 41F is the same 5C the
    // author meant, and the two files must keep the same number.
    // Number.isFinite first: with no reading AND no climatology to impute from
    // (see tempForFeature) `temp` is null, and `null < 41` is true — which would
    // turn "we have no idea what the weather is" into "it is freezing and
    // clear". Serving never reaches that state (predictBusyness answers with
    // the rule engine instead), and this makes the map itself safe anyway.
    cold_outdoor: (Number.isFinite(temp) && temp < 41 && weatherGroup === 'clear') ? 1 : 0,
    // Baseline + freshness — venue-specific if available, category fallback otherwise
    baseline_busyness: baseline || 0,
    // Fill chain mirrors prepare_features.add_baseline_features exactly:
    // category misses fill with the corpus global mean (categoryGlobalMean,
    // skew fix d — this was `|| 0`, an 11-point divergence if ever reached);
    // refined misses fall back to the category value, THEN the global mean.
    // Number.isFinite instead of `||` so a legitimate 0.0 table entry is a
    // value, not a miss — training's fillna only fills NaN.
    category_baseline: (() => {
      const v = Number((metadata.category_baselines || {})[`${venueCategory}_${dayOfWeek}_${hour}`]);
      if (Number.isFinite(v)) return v;
      const fill = categoryGlobalMean(metadata);
      return Number.isFinite(fill) ? fill : 0;
    })(),
    refined_category_baseline: (() => {
      const pt = priceLevel >= 2 ? 1 : 0;
      const pop = rating >= 4.3 ? 1 : 0;
      const refined = Number((metadata.refined_baselines || {})[`${venueCategory}_${pt}_${pop}_${dayOfWeek}_${hour}`]);
      if (Number.isFinite(refined)) return refined;
      const cat = Number((metadata.category_baselines || {})[`${venueCategory}_${dayOfWeek}_${hour}`]);
      if (Number.isFinite(cat)) return cat;
      const fill = categoryGlobalMean(metadata);
      return Number.isFinite(fill) ? fill : 0;
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
      // month mean and temp_anomaly is (temperature, itself filled with
      // temp_norm when missing) minus temp_norm, clipped to +/-25.
      //
      // monthClimateNorm, NOT climateNorm, and the difference is nine months of
      // the year. The long version sits above monthClimateNorm; the short one is
      // that this artifact's norms table covers months 3, 4 and 5 only, so
      // climateNorm's global-mean fallback was subtracting a spring average of
      // every latitude on earth from a live August or December reading and
      // publishing the difference as a seasonal anomaly. Null means the artifact
      // has no normal for this month, and with no normal there is no anomaly to
      // claim, so the slot carries 0: the centre of the trained distribution and
      // the same value an imputed temperature produces.
      //
      // THE IMPUTED-TEMPERATURE CASE STILL LANDS ON 0 EITHER WAY, which is why
      // no second special case appeared here. Inside the corpus months `temp`
      // falls back to this same (band, month) norm and the subtraction cancels.
      // Outside them `norm` is null and the branch below answers 0 directly.
      const norm = monthClimateNorm(lat, month);
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

// Maps Google Places types to the venue_category the model was TRAINED on.
//
// This has to agree with how the corpus was labelled or the category feature is
// simply wrong at serve time. Training labels come from two places, and both
// emit categories this function could not:
//   - scripts/ml/discoverBestTime.js:84  mapCategory(), which emits nightclub
//     and park by name
//   - scripts/ml/config.js               per-query category assignment, which
//     emits entertainment for bowling alleys, arcades and amusement parks
//
// Until 2026-08-19 this function could emit only 10 of the model's 13 encoded
// categories. nightclub, entertainment and park were unreachable — they have
// encodings in category_encoding AND their own curves in category_baselines,
// and nothing live could ever select them.
//
// night_club was the expensive one, because it was actively routed to 'bar'.
// Those two curves are not close. Friday, from the shipped artifact:
//
//     bar        peaks 20:00 at 52.6   (23:00 -> 40.5)
//     nightclub  peaks 23:00 at 34.9   (20:00 -> 25.1)
//
// So a nightclub was told 52.6 at 20:00 where its own cohort says 25.1. A
// 27-point error from the category label alone, against a model whose whole
// realtime MAE is 29.4 — the mis-mapping was worth about as much error as
// everything else in the model combined, on the venue category most likely to
// pay for a dashboard.
//
// Order matters below: night_club is tested BEFORE bar, because Google returns
// both types on most clubs and the first match wins.
function guessCategory(types) {
  if (!types || !types.length) return 'restaurant';
  if (types.includes('night_club')) return 'nightclub';
  if (types.includes('bar') || types.includes('pub')) return 'bar';
  if (types.includes('cafe') || types.includes('coffee_shop')) return 'cafe';
  if (types.includes('gym') || types.includes('fitness_center')) return 'gym';
  if (types.includes('shopping_mall')) return 'mall';
  if (types.includes('museum')) return 'museum';
  if (types.includes('movie_theater')) return 'movie_theater';
  if (types.includes('fast_food_restaurant') || types.includes('meal_takeaway')) return 'fast_food';
  if (types.includes('bakery') || types.includes('ice_cream_shop')) return 'dessert';
  if (types.includes('brewery')) return 'brewery';
  // config.js assigns 'entertainment' to bowling alleys, arcades and amusement
  // parks, so those three are what may claim it here and nothing wider.
  if (types.includes('bowling_alley') || types.includes('amusement_park')
      || types.includes('video_arcade')) return 'entertainment';
  // Checked after amusement_park on purpose: Google returns 'park' on many
  // amusement parks, and config.js counted those as entertainment.
  if (types.includes('park') || types.includes('national_park')
      || types.includes('state_park')) return 'park';
  return 'restaurant';
}

// ---------------------------------------------------------------------------
// Prediction Functions
// ---------------------------------------------------------------------------

// `options.userId` — the authenticated account this prediction is being served
// to, when there is one. It is threaded through for exactly one reason: it is
// the identity the Ticketmaster budget is charged against (see allowEventFetch).
// Optional and backward compatible: a caller that omits it gets the old
// global-only metering, which is the right answer for background producers and
// for the unauthenticated demo. Nothing else in the prediction depends on it,
// and it never reaches a cache key or the feature vector.
// ---------------------------------------------------------------------------
// THE DELTA RECONSTRUCTION, WITH THE DISPERSION-LAB CORRECTION (2026-08-19).
//
// The shipped model is too narrow: prediction sd 21.6 against an actual sd of
// 36.65 on the gate slice. The dispersion lab (scripts/ml/train/
// RETRAIN-V27-LOG.md, "Dispersion lab") ran every post-hoc widener — clamp
// widths, affine and quantile maps, isotonic in delta and score space, banded
// pushes — against the ship gate on the v2.6.0 holdout, prequentially (fit on
// the earliest 30% of gate dates, scored forward). Exactly ONE candidate
// cleared it: widen the clamp to ±50 and push the extremes by a single point.
// Date-block bootstrap, 2000 resamples: within-10 +0.262pp CI [+0.171,
// +0.365], MAE -0.0002 CI [-0.053, +0.031]. A real dispersion gain, MAE-
// neutral. Everything stronger buys its width with MAE the gate refuses.
//
// The ±50 DELIBERATELY OVERRIDES metadata.delta_clamp_range (±30). That key
// remains the training-time record — train_model.resolve_clamp still reads it
// for the training-side report — but the lab measured the SERVE clamp at ±50
// on the shipped artifact, and quick_eval.py's reconstruct() applies this
// same arithmetic so the ship gate scores the reconstruction production
// actually performs. If this function changes, quick_eval changes with it.
//
// The push reads the ROUNDED score and fires only outside [25, 65], one point
// toward the nearer rail, never across it. Pinned by
// __tests__/dispersionReconstruction.test.js.
// ---------------------------------------------------------------------------
const DELTA_CLAMP_LO = -50;
const DELTA_CLAMP_HI = 50;
const EXTREMES_PUSH_LOW = 25;
const EXTREMES_PUSH_HIGH = 65;
function reconstructScore(rawDelta, baseline) {
  const clampedDelta = Math.max(DELTA_CLAMP_LO, Math.min(DELTA_CLAMP_HI, rawDelta));
  let score = Math.max(0, Math.min(100, Math.round(baseline + clampedDelta)));
  if (score < EXTREMES_PUSH_LOW) score = Math.max(0, score - 1);
  else if (score > EXTREMES_PUSH_HIGH) score = Math.min(100, score + 1);
  return score;
}

// ---------------------------------------------------------------------------
// SCORE-QMAP — ARMED 2026-08-28, BY JAYDEN'S DECISION. Flag: CROWD_QMAP_ENABLED.
//
// The decision this block used to wait for has been made: within-10 is the
// primary accuracy metric, because the one number on the card is the product
// ("I'm really big on the one number"), and the number being roughly right is
// what a person experiences. The map is ON unless CROWD_QMAP_ENABLED=false,
// which remains the instant kill switch. GATE-B in quick_eval.py armed the
// same day, so future retrains are judged under the arithmetic production
// actually serves. The evidence that forced the call, re-measured 2026-09-01
// against the shipped v2.6.0 artifact on the gate slice (the first figures
// written here were wrong on all four counts and one of them, "never served
// once", was categorically false): 51.6% of served scores sat in the 41-80
// middle against a reality that puts 24.2% there, and a score of 5 or less
// was served on only 2.5% of rows while 23.6% of real venue-hours are exactly
// that. The 23.6% agrees with the figure twelve lines below, which the earlier
// text contradicted.
//
// WHAT IT IS. A 41-knot monotone quantile lookup that rewrites the published
// score so its DISTRIBUTION matches the distribution of real busyness, instead
// of the compressed one a delta model produces. Fitted by matching quantiles:
// the score at the q-th percentile of what we publish is replaced by the actual
// busyness at the q-th percentile of what really happened.
//
// WHY IT EXISTS. Reality on the gate slice is bimodal — actual sd 36.65, 23.6%
// of served venue-hours at or below 5 and 22.1% at or above 90 — and the shipped
// number sits in the middle of it at sd 21.4, 0.58 of the truth's spread. A
// point estimate cannot be near both modes: MAE is minimised by the conditional
// median of a bimodal target, within-10 by committing to a mode. So this is a
// product choice between two metrics, not a bug fix, and it is Jayden's to make.
// Full write-up: scripts/ml/train/QMAP-DECISION.md.
//
// WHAT IT IS WORTH, re-derived 2026-08-20 against the reconstruction production
// performs TODAY (clamp ±50 + push, rounded — NOT the legacy ±30 arithmetic the
// 2026-08-19 dispersion lab used as its reference, which is why its +8.65pp is
// not this change's number). Prequential: fitted on the earliest 30% of gate
// dates (<= 2026-03-28, 21,148 rows), scored on the forward 46,101:
//
//     within-10   20.84%  ->  29.22%   (+8.38pp, CI95 [+7.17, +9.69])
//     within-15   30.12%  ->  36.42%   (+6.30pp)
//     within-20   39.08%  ->  43.61%   (+4.53pp, CI95 [+3.57, +5.55])
//     MAE         29.976  ->  33.126   (+3.15,   CI95 [+2.72, +3.57])
//     sd / actual  0.576  ->   0.927
//
// 2000-resample date-block bootstrap. It fails the ship gate's MAE arm on
// purpose; RETRAIN.md carries the drafted two-metric alternative that would let
// it through, also unarmed.
//
// WHERE IT SITS. AFTER reconstructScore and BEFORE getLabel, so the band on the
// card always describes the number on the card. Because the map is monotone it
// cannot reorder anything: measured on 21,905 within-venue-day hour pairs and
// 123,051 same-hour cross-venue pairs, ZERO order reversals. It does create
// ties (6.4% of hour pairs, 10.3% of venue pairs) where the rails flatten, which
// is why the hour-ordering axis staying on `baselineScore` matters more, not
// less, with this on.
//
// THE TABLE IS ARTIFACT-SPECIFIC. It was fitted on 2.6.0-starling's output
// distribution. Applying it to any other artifact would be calibrating one
// model with another's quantiles, so the flag refuses politely rather than
// doing that silently: QMAP_FITTED_ON is checked at the call site and an
// unmatched artifact serves unmapped.
// ---------------------------------------------------------------------------
const QMAP_FITTED_ON = '2.6.0-starling';
// x = published score (the quantile grid of what we publish), y = actual
// busyness at the same quantile. 41 knots requested at q = 0.005..0.995; 40
// survive after collapsing duplicate x, which is the table below. Strictly
// increasing in x, non-decreasing in y — both asserted at fit time and pinned by
// __tests__/dispersionReconstruction.test.js.
const QMAP_X = [0, 5, 8, 10, 12, 14, 16, 18, 20, 21, 23, 25, 27, 28, 29, 31, 32,
  34, 35, 36, 37, 39, 40, 42, 43, 45, 46, 48, 50, 51, 53, 55, 58, 60, 63, 67, 70,
  74, 80, 89];
const QMAP_Y = [0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 10, 10, 10, 15, 15, 20, 20, 25, 25,
  30, 30, 35, 40, 40, 45, 50, 55, 55, 60, 65, 70, 75, 80, 85, 95, 100, 100, 100,
  100, 100];

// The measurement of the MAPPED number, carried next to the map so the
// confidence field can stop quoting a figure that describes the unmapped one.
// Holdout-forward window, same 46,101 rows as the block above. It is NOT the
// same population as metadata's training-CV within_15 (369,076 training rows,
// 33.3%) — that is precisely why it is published with its own population string
// rather than substituted quietly.
const QMAP_MEASURED = Object.freeze({
  within10: 29.22,
  within15: 36.42,
  within15Unmapped: 30.12,
  mae: 33.13,
  rows: 46101,
  population: 'holdout gate slice, prequential forward window (fit <= 2026-03-28, scored 2026-03-29..05-18)',
});

function qmapEnabled() {
  // Default ON since 2026-08-28. 'false' is the kill switch; any other value,
  // including unset, serves the mapped number. Lowercased to match how
  // quick_eval.py reads the SAME variable, so CROWD_QMAP_ENABLED=FALSE cannot
  // disarm the eval while leaving serving mapped.
  return String(process.env.CROWD_QMAP_ENABLED || '').toLowerCase() !== 'false';
}

// np.interp semantics, deliberately: constant extrapolation at both ends, linear
// between knots. scripts/ml/train/quick_eval.py applies the SAME two arrays with
// np.interp so the gate scores the arithmetic production performs. The only
// difference is the final rounding, and it is the difference that already exists
// between reconstructScore and quick_eval's reconstruct(): serving publishes an
// integer, the gate stays float because every prior gate number was computed
// that way. If either table changes, both sides change together.
function applyScoreQuantileMap(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return score;
  const n = QMAP_X.length;
  if (score <= QMAP_X[0]) return Math.max(0, Math.min(100, Math.round(QMAP_Y[0])));
  if (score >= QMAP_X[n - 1]) return Math.max(0, Math.min(100, Math.round(QMAP_Y[n - 1])));
  let hi = 1;
  while (hi < n - 1 && QMAP_X[hi] < score) hi += 1;
  const lo = hi - 1;
  const span = QMAP_X[hi] - QMAP_X[lo];
  const t = span === 0 ? 0 : (score - QMAP_X[lo]) / span;
  const mapped = QMAP_Y[lo] + t * (QMAP_Y[hi] - QMAP_Y[lo]);
  return Math.max(0, Math.min(100, Math.round(mapped)));
}

// WHY AN UNCHECKED STREET DOES NOT MOVE THE CONFIDENCE FIGURE.
//
// The obvious symmetry with weatherPenalty is wrong, and the reason is worth
// keeping. Weather's 15 is not a judgement call: it is the exact amount
// crowdEngine's input-completeness ladder ADDS for having a live reading, so
// taking it back off is arithmetic on a quantity that already exists. Nothing
// in this system has ever measured what an unchecked event listing is worth,
// so any number here would be one somebody made up and then published to a
// user as a measurement. __tests__/confidenceHonesty.test.js exists because
// this file already shipped such a number once (`|| 58`), and it re-scans the
// serving path for new ones on every run.
//
// So the fact is stated instead of priced: `eventsObserved` and
// `eventsUnavailableReason` ride on the response, and 'ticketmaster_events'
// leaves dataSourcesUsed when the listing was never reached. A caller that
// wants to discount the score can, on evidence it can see. Measure the cost
// first, then charge it.

async function predictBusyness(venue, weather, timestamp, options = {}) {
  await init();
  const userId = options && options.userId != null ? options.userId : undefined;
  // `anonymous` marks a caller with no account behind it that is reachable from
  // the open internet (routes/publicCrowd.js, routes/badge.js). It charges the
  // unauthenticated share of the event ledger on top of the global one, so
  // public traffic cannot spend the whole day out from under signed-in callers.
  // See EVENT_UNAUTH_DAILY. Not the same thing as "no userId": background jobs
  // also pass no id and are deliberately outside this bucket.
  const eventOpts = options && options.anonymous ? { anonymous: true } : undefined;

  if (!useML) {
    const result = crowdEngine.calculateCrowdScore(venue, weather, timestamp);
    result.predictionMethod = 'rule_engine';
    result.modelVersion = null;
    // No listing was queried on this path, so the field states that rather than
    // going absent. An undefined here reads as observed to every caller that
    // tests eventsObserved !== false, which is the inference this field exists
    // to remove.
    result.eventsObserved = false;
    result.eventsUnavailableReason = 'not_attempted';
    countPrediction(result.predictionMethod);
    return result;
  }

  // Declared OUT here, not inside the try, so the catch at the bottom can say
  // what it knows. The catch answers from the rule engine after an exception,
  // and until now it returned that answer with no provenance at all, which
  // every caller reads as observed: the one exit that fires when something
  // already went wrong was the one exit that claimed the street had been
  // checked. If the throw beat the lookup these keep their opening values,
  // which is the honest reading (nothing was attempted); if it came after, the
  // assignment below has already recorded what the lookup actually said.
  let eventsSeen = false;
  let eventsReason = 'not_attempted';

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
      getNearbyEvents(lat, lng, eventInstant, userId, eventOpts),
      getUserFeedback(placeId, userId),
      getBaseline(placeId, ts.getDay(), ts.getHours(), userId),
      getNeighborActivity(placeId, lat, lng, ts.getDay(), ts.getHours(), userId),
    ]);

    // DID ANYONE ACTUALLY CHECK THE STREET. `observed === false` is
    // getNearbyEvents saying no answer reached it: a missing key, an exhausted
    // budget, a provider error, a timeout. The feature vector treats that as
    // no information (see the long note in buildFeatureMap), which is the right
    // input but the wrong thing to stay silent about, so it is stated in the
    // response and taken out of dataSourcesUsed. A shape with no flag at all is
    // read as observed, matching every caller that predates the contract.
    eventsSeen = eventData.observed !== false;
    eventsReason = eventsSeen ? null : (eventData.unavailableReason || 'unknown');

    // Best-available baseline: stored table first, else read it directly off
    // the venue's Google popular_times payload so even the FIRST request for
    // a venue runs through the ML model instead of the fallback.
    //
    // THAT SECOND BRANCH IS UNREACHABLE FROM EVERY REQUEST PATH TODAY, and this
    // comment used to describe it as if it were live. No route in this repo puts
    // `popular_times` on a venue: routes/crowd.js says so at its batch whitelist,
    // and the Places field masks in that file do not ask for it, because the
    // Places API does not sell popular times. So the stored table is the only
    // source of a baseline, and a venue with no row in it takes the no-baseline
    // exit below every time, forever. The branch is kept because it is correct
    // and because the day a popular-times source exists it is what uses it. The
    // consequence for coverage, and the counter added to make it visible, are in
    // the note above predictionCoverage.
    let baseline = storedBaseline;
    // How old the number under this score is. Captured HERE, where the branch
    // that chose the baseline is still visible, because the two branches have
    // genuinely different ages: a stored row can be months old, while a
    // popular_times payload was fetched for this request.
    let baselineData = baselineProvenanceFor(placeId, ts.getDay(), ts.getHours());
    if ((!baseline || baseline <= 0) && venue.popular_times) {
      baseline = baselineFromPopularTimes(venue.popular_times, ts.getDay(), ts.getHours());
      baselineData = {
        source: 'google_popular_times',
        asOf: Date.now(),
        // Not 'baseline_row_written': this one did not come out of the table at
        // all, it came off the live Places payload, so its age is real rather
        // than an upper bound.
        basis: 'live_places_payload',
        stale: false,
        staleAfterMs: BASELINE_STALE_AFTER_MS,
      };
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
      // Which of the three zeros this was. `no_baseline` stays the name of the
      // corpus gap so every existing reader of that tag keeps its meaning; the
      // two failures get their own names instead of borrowing it.
      const miss = baselineMissFor(placeId, ts.getDay(), ts.getHours());
      result.predictionMethod = miss === 'refused' ? 'rule_engine_baseline_refused'
        : miss === 'error' ? 'rule_engine_baseline_error'
        : 'rule_engine_no_baseline';
      result.modelVersion = null;
      result.eventsObserved = eventsSeen;
      result.eventsUnavailableReason = eventsReason;
      countPrediction(result.predictionMethod);
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
      result.eventsObserved = eventsSeen;
      result.eventsUnavailableReason = eventsReason;
      countPrediction(result.predictionMethod);
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
    // every band to 'Packed', and the response ships score:null with
    // predictionMethod 'ml'. verifyModelShape can only check the head shape
    // when onnxruntime exposes outputMetadata, so this is the runtime backstop:
    // throw, and the catch below answers with the rule engine, honestly labelled.
    if (typeof rawOutput !== 'number' || !Number.isFinite(rawOutput)) {
      throw new Error(`model emitted a non-finite output (${String(rawOutput)})`);
    }
    let score;
    if (metadata.label_type === 'delta') {
      // Delta-trained model: reconstruct absolute as baseline + clamp(delta)
      // + the dispersion-lab extremes push — see reconstructScore above for
      // why the clamp is ±50 and not metadata.delta_clamp_range's ±30.
      score = reconstructScore(rawOutput, baseline || 0);
    } else {
      score = Math.max(0, Math.min(100, Math.round(rawOutput)));
    }

    // score-qmap, ON unless CROWD_QMAP_ENABLED=false. After the reconstruction,
    // before getLabel, so the band never describes a different number than the
    // one shown. The version check is not defensive padding: the table is one
    // artifact's quantile grid and would be meaningless applied to another's.
    let qmapApplied = false;
    if (qmapEnabled() && (metadata.model_version || '') === QMAP_FITTED_ON) {
      score = applyScoreQuantileMap(score);
      qmapApplied = true;
    }

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
      // WHEN THE QMAP IS ON, metadata's figure stops describing the published
      // number. `accuracy` is the artifact's measured within-15 on the RAW
      // reconstruction; the qmap publishes a different number, and quoting the
      // old figure for it would be exactly the "publishing a measurement of
      // something else" failure readServedAccuracy was written to end. So the
      // map carries its own measurement and it is published with its own
      // population string, which is a smaller, later, holdout-side one. On the
      // rows where both were measured the direction is real and the same:
      // within-15 30.12% unmapped -> 36.42% mapped.
      const served = qmapApplied
        ? {
          percent: QMAP_MEASURED.within15,
          metric: 'within_15_score_qmap',
          population: QMAP_MEASURED.population,
          rows: QMAP_MEASURED.rows,
        }
        : accuracy;
      confidence = Math.round(served.percent);
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
        metric: served.metric,
        population: served.population,
        populationRows: served.rows,
        measuredPercent: served.percent,
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

    // `ticketmaster_events` is a claim that the listing was consulted, so it
    // needs `observed`, not just `hasEvent`. A quiet night that Ticketmaster
    // actually answered for IS a source and now says so; an outage never is.
    const dataSources = ['ml_model', hasWeather ? 'weather' : null, 'venue_data'];
    if (eventsSeen) dataSources.push('ticketmaster_events');

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
      // card's standing. Those are two separate questions and they are answered
      // in two places: this field says which metric produced the integer, and
      // crowdEngine.describePredictionSupport says whether anything vouches for
      // the axis it sits on. Since v2.6.0-starling flipped
      // ML_BASELINE_AXIS_VERIFIED to true they happen to agree for the ML path
      // (basis 'model_holdout', supported: true) — but they are still not the
      // same claim, and they come apart again the moment a pre-2026-08-18
      // artifact is served or a venue has three verified reporters, which
      // outrank the holdout and return basis 'user_reports'.
      confidenceMeasurement,
      // WHETHER THE NEARBY-EVENT INPUT IS A READING OR A BLANK. Always
      // present and always a boolean, so nothing downstream has to infer it
      // from the absence of `eventAlert`, which is the inference that let an
      // outage read as a quiet street. False means the event slots in the
      // vector held no information and this score is the venue's baseline
      // expectation for the slot rather than an event-aware number.
      eventsObserved: eventsSeen,
      eventsUnavailableReason: eventsReason,
      // HOW OLD THE NUMBER UNDER THE SCORE IS. This model is `label_type:
      // 'delta'` — score = baseline + clamp(delta, ±30) — so the baseline is
      // most of the answer, and until now nothing anywhere said when it was
      // measured. `asOf` is absolute and `stale` is a boolean, so a client can
      // caption the card without doing date arithmetic against a migration
      // history. Null when there is nothing honest to say (no stored row and no
      // popular_times), which cannot co-occur with a served ML score under a
      // delta model but is possible under an absolute-head one.
      baselineData: baselineData || null,
      // THE NUMBER THAT ORDERS THE HOURS (2026-08-20). `score` above is the
      // model's level and stays the published one; this is the smoothed
      // popular-times anchor the delta was added to, and it is what
      // crowdEngine's best-time and peak lines RANK on, because ranking is the
      // one thing the trained layer was measured to be worse at
      // (scripts/ml/HOUR-RANKING-EVAL.md: baseline 63.1% vs model 62.7% on
      // within-night hour pairs, bootstrap of the difference -0.49pp with a
      // CI95 that excludes zero).
      //
      // It is deliberately the SMOOTHED value getBaseline returns, not the raw
      // ml_venue_baselines cell and not popular_times[hour]: the evaluation's
      // baseline arm was the smoothed anchor, so serving anything else would
      // ship a predictor nobody measured. Internal to the serve path — routes
      // strip it before it reaches a client.
      baselineScore: Number.isFinite(Number(baseline)) && Number(baseline) > 0
        ? Number(baseline)
        : null,
      // Whether the score above went through the dispersion quantile map. Null
      // rather than false when the flag is off, so nothing downstream has to
      // decide what a `false` on a pre-flag response would have meant. Internal
      // to the serve path; routes strip it, same as baselineScore.
      scoreCalibration: qmapApplied ? 'score_qmap_v26' : null,
    };

    // Add event alert when large event nearby
    if (eventsSeen && eventData.hasEvent && eventData.nearestAttendance > 5000) {
      response.eventAlert = {
        hasEvent: true,
        eventName: eventData.nearestName,
        estimatedAttendance: eventData.nearestAttendance,
        distance: `${eventData.nearestDistance} km away`,
      };
    }

    // Counted HERE and not at the top of the try, because everything above can
    // still divert to the rule engine and the tally has to record the exit that
    // was actually taken.
    countPrediction(response.predictionMethod);
    return response;
  } catch (err) {
    console.error('[MLPredictor] Prediction error, falling back:', err.message);
    const result = crowdEngine.calculateCrowdScore(venue, weather, timestamp);
    result.predictionMethod = 'rule_engine_fallback';
    result.modelVersion = null;
    // The fourth exit. The three above were given these fields when the
    // contract landed; this one was missed, and it is the exit that answers
    // after an exception, so the shape that reached callers on the worst path
    // was the shape that asserts the most.
    result.eventsObserved = eventsSeen;
    result.eventsUnavailableReason = eventsReason;
    countPrediction(result.predictionMethod);
    return result;
  }
}

// ---------------------------------------------------------------------------
// PER-SLOT WEATHER for the 24h strip (train/serve skew hunt 2026-08-19).
//
// Every training row carried the weather OF ITS OWN HOUR; the 24h forecast
// used to hand all 24 slots ONE current reading, so 3 AM was scored with
// 3 PM's temperature and "raining now" rained on tonight's dinner slot —
// worth 2-3 points on tail hours. weatherService.getHourlyForecast (the OWM
// 3-hour list) supplies dated entries; this picks the one nearest the slot's
// REAL instant.
//
// The live reading still wins near now: it is an observation where the
// forecast is a model, and OWM's first list entry can itself be hours out.
// 90 minutes is half the vendor's 3-hour step — past it the nearest forecast
// entry is closer in time to the slot than "now" is, and inside it the
// observation is. The same 90 minutes bounds a match at the far end: a slot
// past the 5-day horizon falls back to the live reading (the pre-fix
// behavior, kept as the honest degradation), never to a five-day-old entry.
// ---------------------------------------------------------------------------
const FORECAST_SLOT_MAX_GAP_MS = 90 * 60 * 1000;
function weatherForSlot(hourlyWx, slotInstantMs, currentWeather, nowMs) {
  if (!Array.isArray(hourlyWx) || hourlyWx.length === 0) return currentWeather;
  if (!Number.isFinite(slotInstantMs)) return currentWeather;
  if (Math.abs(slotInstantMs - nowMs) < FORECAST_SLOT_MAX_GAP_MS) return currentWeather;
  let best = null;
  let bestGap = Infinity;
  for (const entry of hourlyWx) {
    const gap = Math.abs(Number(entry?.at) - slotInstantMs);
    if (Number.isFinite(gap) && gap < bestGap) {
      bestGap = gap;
      best = entry;
    }
  }
  if (!best || bestGap > FORECAST_SLOT_MAX_GAP_MS) return currentWeather;
  return best;
}

// `options.userId` is forwarded to every hour's predictBusyness. This path is
// the largest single-request event fan-out in the app — 24 hours, each its own
// UTC hour slot in the event cache key, so a cold venue can be 24 upstream calls
// from ONE card view — which makes it the path that most needs to be charged to
// somebody.
async function predictHourlyForecast(venue, weather, startHour, count, baseTimestamp, options = {}) {
  await init();

  // No useML early return here any more: predictBusyness makes the same
  // ML-or-rule-engine decision PER HOUR and tags its answer, which is the
  // whole point of skew fix (c) — the old shortcut skipped per-slot weather
  // and produced entries that did not say which engine scored them.
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

  // ONE forecast fetch per card (cached and coalesced inside weatherService,
  // budget-refused misses return null and every slot keeps the live reading).
  // The slot instant handed to weatherForSlot is the REAL instant — `ts` below
  // is the venue wall clock encoded in server time (see trueEventInstant), and
  // matching a fake instant against the vendor's real-UTC entries would fetch
  // the wrong hour's weather by exactly the venue's offset.
  const wxLat = venue.location?.latitude || venue.latitude || venue.lat || 0;
  const wxLng = venue.location?.longitude || venue.longitude || venue.lng || 0;
  const utcOff = venue.utcOffsetMinutes ?? venue.utc_offset_minutes ?? venue.utc_offset ?? null;
  const hourlyWx = (wxLat || wxLng)
    ? await weatherService.getHourlyForecast(wxLat, wxLng, {
      userId: options && options.userId,
      // Same marker, same reason, on the weather ledger's own unauthenticated
      // share (services/weatherService.js WX_UNAUTH_DAILY).
      anonymous: !!(options && options.anonymous),
    })
    : null;
  const nowMs = Date.now();

  // ONE EVENT CALL FOR THE WHOLE STRIP, seeded before the loop. Each hour below
  // asks getNearbyEvents for itself, and their upstream windows overlap by three
  // of their four hours, so a 24 hour strip re-bought most of the same events 24
  // times. With the card's own lookup that is 25 calls for one venue against a
  // daily budget of 1500, which is sixty cold cards a day for the entire product.
  //
  // The event instant is the venue's true one, the same conversion the loop uses
  // for weather, so the seeded slots are the slots the loop will ask for. A
  // failure seeds nothing and the loop behaves exactly as it does today.
  //
  // WRAPPED, because this is an optimisation and an optimisation may never be
  // the reason a strip fails. __tests__/eventUnknownVsZero.js proves the point
  // by making options.userId a throwing getter: read outside a guard, that
  // exception escaped the per-hour try/catch below and took the whole forecast
  // with it, which is a worse outcome than the 25 calls this exists to avoid.
  try {
    await prefetchEventRange(
      wxLat, wxLng,
      trueEventInstant(base, utcOff).getTime(),
      hours,
      options && options.userId,
      options
    );
  } catch { /* seed nothing; every hour below asks for itself, as before */ }

  for (let i = 0; i < hours; i++) {
    const ts = new Date(base.getTime() + i * 60 * 60 * 1000);
    const slotWeather = weatherForSlot(hourlyWx, trueEventInstant(ts, utcOff).getTime(), weather, nowMs);
    try {
      const result = await predictBusyness(venue, slotWeather, ts, options);
      // predictionMethod per entry (skew fix c): without it a strip silently
      // mixed ML hours and rule-engine hours — a baseline exists at 19:00 but
      // not at 03:00 — and no client could tell which bars were which.
      forecast.push({
        hour: labelFor(ts),
        score: result.score,
        label: result.label,
        predictionMethod: result.predictionMethod || null,
        // The ordering axis for this hour, carried per entry because
        // crowdEngine picks it for the whole candidate set at once and has to
        // be able to see that EVERY hour it is about to compare has one. Null
        // on any hour the rule engine answered, which is what makes a mixed
        // strip fall back to model ordering instead of ranking half the night
        // on one number and half on another.
        baselineScore: result.baselineScore ?? null,
        // WHETHER THIS HOUR'S EVENT LOOKUP HAPPENED. predictBusyness has
        // carried this since the contract landed and the strip dropped it, so
        // the one view that shows a whole night at once was the one view with
        // no way to tell an outage from a quiet street. Exhaust the
        // Ticketmaster budget for a venue that still has a usable baseline and
        // every hour is scored through the identical branch that runs when the
        // provider answered and listed nothing; without this field the bars
        // are indistinguishable.
        //
        // PER ENTRY, NOT PER STRIP, and that is the honest granularity rather
        // than the convenient one. Each hour is its own predictBusyness call
        // with its own event-cache key, and allowEventFetch is a running daily
        // ledger, so a 24-hour strip can and does drain the budget partway
        // through: the early hours are readings and the later ones are blanks.
        // A single strip-level flag would have to pick one of those and
        // publish it over hours it is false for. (It would also not survive
        // JSON.stringify, since this function returns an array.)
        eventsObserved: result.eventsObserved !== false,
        eventsUnavailableReason: result.eventsObserved === false
          ? (result.eventsUnavailableReason || 'unknown')
          : null,
      });
    } catch (err) {
      // Fallback for this hour
      const fallback = crowdEngine.calculateCrowdScore(venue, slotWeather, ts);
      forecast.push({
        hour: labelFor(ts),
        score: fallback.score,
        label: fallback.label,
        predictionMethod: 'rule_engine_fallback',
        // No baseline behind a rule-engine hour, and saying so explicitly is
        // what keeps `baselineScore` a field every entry has rather than one a
        // consumer has to test for existence.
        baselineScore: null,
        // predictBusyness threw, so this number came straight out of the crowd
        // engine and no event listing fed it. Same reason string the !useML
        // exit uses: nothing was attempted for this hour.
        eventsObserved: false,
        eventsUnavailableReason: 'not_attempted',
      });
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
  // The third Ticketmaster ledger's reader. routes/admin.js's cost panel had
  // meters for the other two and none for this one, so both the observed count
  // and the worst-case ceiling it published were short by a whole ledger.
  eventBudgetStatus,
  // What share of predictions the trained model actually produced. Same shape
  // and same contract as eventBudgetStatus: a non-consuming read for
  // routes/admin.js, never a gate. See the note above predictionCoverage.
  predictionCoverage,
  estimateCapacity,
  estimateWait,
  findBestTime,
  findPeakTime,
  findQuieterAlternatives,
  buildCalibrationAdjustment,
  storeGoogleBaselines,
  // Part of the serving API, not an internal: a caller that has already read a
  // venue's whole weekly curve hands it here and the per-hour loop that follows
  // costs no queries. services/advisorFacts.js fetchBaselineCurve is the caller
  // it was written for; see the header above primeBaselineCache.
  primeBaselineCache,
  getLabel,
  init,
  // Internals exported for backend/__tests__/mlPipeline.test.js — the
  // train/inference parity surface. Not part of the serving API.
  _internals: {
    // The Places-types -> venue_category mapper, for
    // __tests__/venueCategoryMapping.test.js. Exported because the test's whole
    // job is to pin that this function can reach every category the shipped
    // artifact was trained on -- a property no other test could observe, and
    // one that was silently false for nightclub, entertainment and park until
    // 2026-08-19.
    guessCategory,
    buildFeatureMap,
    buildFeatureVector,
    missingFeatureNames,
    evaluateShipGate,
    astronomyFeatures,
    groupWeatherCode,
    baselineFromPopularTimes,
    trueEventInstant,
    reconstructScore,
    // The unarmed dispersion quantile map (CROWD_QMAP_ENABLED). Exported so
    // __tests__/dispersionReconstruction.test.js can pin the table's shape,
    // its monotonicity and the composition order against reconstructScore
    // without the flag ever being on in a test run.
    applyScoreQuantileMap,
    QMAP_X,
    QMAP_Y,
    QMAP_FITTED_ON,
    QMAP_MEASURED,
    weatherForSlot,
    categoryGlobalMean,
    hasTempReading,
    climateNorm,
    monthClimateNorm,
    tempForFeature,
    estimateTmAttendance,
    getNearbyEvents,
    verifyModelShape,
    readServedAccuracy,
    boundedSet,
    PREDICTOR_CACHE_MAX,
    EVENT_CACHE_MAX,
    eventCacheSize: () => eventCache.size,
    // The event budget, for __tests__/crowdBatchAmplification.test.js. The two
    // ceilings are exported so a test can pin the inequalities the comment
    // above allowEventFetch declares load-bearing, rather than re-stating the
    // numbers and drifting from them.
    allowEventFetch,
    EVENT_DAILY_BUDGET,
    EVENT_USER_HOURLY,
    EVENT_USER_DAILY,
    eventBudgetRemaining: (userId) => eventUserBudget.remaining(userId),
    // Tests only. Production code must never reset a spending counter.
    eventInflightSize: () => eventInflight.size,
    __resetEventBudget: () => {
      eventUserBudget.reset();
      eventDayKey = new Date().toISOString().slice(0, 10);
      eventDayCount = 0;
      eventCache.clear();
    },
    // The neighbour cache, for __tests__/neighborCacheBucketing.test.js. The
    // whole point of the round-3 fix is that this cache is keyed on the
    // BUCKETED COORDINATES alone, so a test has to be able to count the range
    // scans two different place ids at the same bucket produce.
    getNeighborActivity,
    getSelfBaselines,
    // The round-5 sweep's finding: the three place-keyed Postgres caches, for
    // __tests__/venueLookupBudget.test.js. Exported rather than restated in the
    // test so the numbers cannot drift from the comment that argues for them.
    getBaseline,
    // The blend both baseline paths share, for __tests__/baselinePrime.test.js:
    // the query path and the whole-curve prime must agree slot for slot.
    blendBaselineRows,
    baselineNeighborSlots,
    baselineCacheEntry: (placeId, day, hour) => baselineCache.get(`${placeId}_${day}_${hour}`),
    // Baseline freshness, for __tests__/baselineFreshness.test.js.
    baselineProvenanceFor,
    // Which of the three zeros getBaseline just returned, for
    // __tests__/baselineFreshness.test.js. The tag predictBusyness publishes is
    // derived from this, and a coverage panel that reads `no_baseline` as
    // "go collect more venues" needs the other two to be distinguishable.
    baselineMissFor,
    baselineMeta,
    BASELINE_STALE_AFTER_MS,
    GOOGLE_BASELINE_REFRESH_DAYS,
    getUserFeedback,
    allowVenueLookup,
    isPlaceIdShaped,
    VENUE_LOOKUP_USER_HOURLY,
    VENUE_LOOKUP_USER_DAILY,
    venueLookupBudgetRemaining: (userId) => venueLookupBudget.remaining(userId),
    baselineCacheSize: () => baselineCache.size,
    feedbackCacheSize: () => feedbackCache.size,
    // Tests only. Production code must never reset a spending counter.
    __resetVenueLookupCaches: () => {
      baselineCache.clear();
      baselineMissCache.clear();
      feedbackCache.clear();
      selfBaselineCache.clear();
      venueLookupBudget.reset();
    },
    neighborCacheSize: () => neighborCache.size,
    selfBaselineCacheSize: () => selfBaselineCache.size,
    // The R4-I2 budget on neighbour range scans, for
    // __tests__/neighborCacheBucketing.test.js. Exported rather than restated
    // in the test so the numbers cannot drift from the comment that argues for
    // them.
    NEIGHBOR_USER_HOURLY,
    NEIGHBOR_USER_DAILY,
    neighborBudgetRemaining: (userId) => neighborUserBudget.remaining(userId),
    neighborInflightSize: () => neighborInflight.size,
    __resetNeighborCaches: () => {
      neighborCache.clear();
      selfBaselineCache.clear();
      // Tests only. Production code must never reset a spending counter.
      neighborUserBudget.reset();
    },
    getMetadata: () => metadata,
    getSession: () => session,
  },
};
