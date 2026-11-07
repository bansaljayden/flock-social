#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BIRDIE EVAL: the whole answer path against the real model, scored.
//
// Drives POST /api/ai/chat in process, through the real router: the real
// system prompt, the real tool loop and tool code (promptSafe, the locked
// forecast, best time, the UTC note, the owner's reading, the cards), and the
// real post-processing (cards, fallbacks, staged plans and votes). Every tool
// is answered from birdieEvalCases.js instead of the world:
//
//   Google Places    text search answered by a fixture fetch; place details
//                    by a fixture fetchPlaceDetails
//   the predictor    each venue's fixture curve, shaped the way the serving
//                    switches in force and the artifact serving loads (or
//                    --artifact) shape a real answer, confidence figure too
//   weather, game    fixtures; the owner's reading and table counts too
//   the database     no connection is ever opened (the PG variables are
//                    removed before anything loads); every query is answered
//                    from the persona asking
//   meters           open: the eval is not a test of the meters
//
// Any other outbound request is refused and reported. Only Gemini is real,
// and only in a live run.
//
// Usage, from backend/ (the key comes from the Railway service, never a file):
//   railway run --service "Flock-app-" node scripts/birdie/birdieEval.js --out=F
//   ... --only=P01,B03          those items
//   ... --q=thistle|ramen       items whose text contains one of these
//   ... --concurrency=4         conversations in flight at once (default 4)
//   ... --max-tokens=1000000    stop starting items past this many tokens
//   ... --quiet                 the grade lines and the summary, no answers
//   ... --gemini-deadline=MS    a measurement: Birdie's per-call deadline is
//                               replaced in this process only, to see how long
//                               a call the real one cuts off would have taken
//                               (in a replay, the deadline the recorded calls
//                               are held to: see REPLAY below)
//   ... --model=NAME           a measurement: Birdie runs on this Gemini model
//                               in this process only (BIRDIE_MODEL is never
//                               changed anywhere else), with the same settings
//   ... --artifact=F            the crowd model answers as the artifact whose
//                               metadata is F (a retrain's model_metadata.json)
//                               instead of the one serving loads, so its
//                               answers reach Birdie before it ships; works
//                               with --fixtures too (THE ARTIFACT, below)
//   ... --retry-probe=MS        a measurement: a model call still running at
//                               MS gets one identical request sent beside it,
//                               and how long that took, what it cost and
//                               whether it answered is recorded on the call
//                               (retryProbe). The route never sees it. Since
//                               2026-11-03 the route retries a stall itself
//                               (routes/ai.js ONE RETRY AFTER A STALL), so a
//                               probe at the real deadline would be a second
//                               retry beside the route's: it needs
//                               --gemini-deadline lifted past its mark
//   node scripts/birdie/birdieEval.js --fixtures [--as=persona]
//                               what every tool answers, at every clock, with
//                               no model and no key
//
// THE ROUTE'S OWN RETRY. A call the route sends again after a stall has the
// same contents as the one that stalled, and is recorded with `retryOf`, the
// index of that call in the turn; the summary counts them and what they got.
//
// REPLAY: --replay=F answers every model call from run F's recorded replies,
// in order, with no key and no network, so a change to the checks, the tool
// code or the post-processing is scored on what the real model wrote. A call
// the recorded run never made (the route changed since) fails, and that item
// says so. The serving switches the recorded run saw are restored from F, and
// so is its --artifact when it named one.
//   node scripts/birdie/birdieEval.js --replay=F [--out=G] [--gemini-deadline=MS]
// A call F lost to the deadline is lost again, and the route's retry of it is
// answered from F: by F's own retry when F has one (a run since 2026-11-03),
// else by what F knew. A run that timed its stalls to the end
// (--gemini-deadline lifted) and probed them (--retry-probe) answers the retry
// with the stalled call's own reply when the probe answered inside the
// deadline, at the probe's token count; any other retry stalls again. With
// --gemini-deadline=MS a replay holds F's calls to MS: a reply F took longer
// than MS to get is lost to the deadline, the way a run at MS would have lost
// it. Without it, F's slow replies are served as F served them.
//
// RESCORE: --rescore=F scores run F's recorded answers exactly as they were,
// with today's checks and no route at all. Replay re-drives the route with
// today's code; rescore is the one for comparing two runs.
//   node scripts/birdie/birdieEval.js --rescore=F [--out=G]
// ---------------------------------------------------------------------------

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const B = path.resolve(__dirname, '..', '..');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const REPLAY = args.replay ? JSON.parse(fs.readFileSync(path.resolve(String(args.replay)), 'utf8')) : null;
// --rescore=F: today's checks over run F's recorded answers exactly as they
// were, with no route and no model. Replay re-drives the route with today's
// code; this is the one to compare two runs with.
const RESCORE = args.rescore ? JSON.parse(fs.readFileSync(path.resolve(String(args.rescore)), 'utf8')) : null;

// ── The environment: the model key and the serving switches, nothing else ──
//
// `railway run` hands this process every variable the service has. The eval
// keeps the Gemini key, the model name, the crowd serving switches and the
// quantile map's (they change what Birdie is told, the confidence figure
// included), and removes every other credential and every way to a database
// before a single application module loads.
const KEEP = new Set(['GEMINI_API_KEY', 'BIRDIE_MODEL', 'CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_NO_CURVE_FALLBACK', 'CROWD_QMAP_ENABLED']);
const SENSITIVE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE|^PG|URL|DSN|PRIVATE|CREDENTIAL|WEBHOOK|RAILWAY|SENTRY|POSTHOG|RESEND|STRIPE|FIREBASE|APPLE|REVENUECAT|TICKETMASTER|WEATHER|VISION|PLACES|GOOGLE|BESTTIME|ADMIN|NFC|SMTP|TWILIO|AWS|CLOUDFLARE|PAYWALL|BIRDIE|CROWD|NODE_ENV)/i;
const kept = {};
for (const k of KEEP) if (process.env[k] !== undefined) kept[k] = process.env[k];
for (const k of Object.keys(process.env)) if (SENSITIVE.test(k)) delete process.env[k];
Object.assign(process.env, kept);
// --model: this process only, set before the route reads it at load.
if (args.model && !REPLAY && !RESCORE) process.env.BIRDIE_MODEL = String(args.model);
if (REPLAY) {
  // The recorded run's switches, so the prompt and the tool results are the
  // ones its replies were written against.
  for (const k of ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_NO_CURVE_FALLBACK', 'CROWD_QMAP_ENABLED', 'BIRDIE_MODEL']) {
    const v = REPLAY.meta && REPLAY.meta.switches ? REPLAY.meta.switches[k] : undefined;
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  process.env.GEMINI_API_KEY = 'replay-no-network';
}
// Unreachable on purpose: a query that escapes the stub below fails here, on
// this machine, instead of reaching anything.
process.env.PGHOST = '127.0.0.1';
process.env.PGPORT = '9';
process.env.PGDATABASE = 'birdie_eval_none';
process.env.PGUSER = 'birdie_eval_none';
process.env.JWT_SECRET = 'birdie-eval-not-a-secret';
// Search runs only with a key set; the fetch below answers it.
process.env.GOOGLE_PLACES_API_KEY = 'birdie-eval-fixtures-no-network';

if (!REPLAY && !RESCORE && !args.fixtures && !process.env.GEMINI_API_KEY) {
  console.error('No GEMINI_API_KEY in the environment. Run it through `railway run --service "Flock-app-"`, or use --replay.');
  process.exit(1);
}

// ── The clock ───────────────────────────────────────────────────────────────
//
// Every item is asked at a fixed moment (a Friday evening, late that night,
// Saturday morning) so "tonight" means the same thing on every run. Time
// still moves from there; only the starting point is moved.
const RealDate = Date;
let clockOffset = 0;
global.Date = new Proxy(RealDate, {
  construct(target, a, newTarget) {
    return a.length ? Reflect.construct(target, a, newTarget) : Reflect.construct(target, [target.now() + clockOffset], newTarget);
  },
  apply(target) { return new target(target.now() + clockOffset).toString(); },
  get(target, prop, receiver) {
    if (prop === 'now') return () => target.now() + clockOffset;
    return Reflect.get(target, prop, receiver);
  },
});
const setClock = (iso) => { clockOffset = RealDate.parse(iso) - RealDate.now(); };

const cases = require('./birdieEvalCases');
const checks = require('./birdieEvalChecks');

// ── The network ─────────────────────────────────────────────────────────────

const als = new AsyncLocalStorage();
const blocked = [];
const realFetch = global.fetch;

// The venue's wall clock now: { day, hour, minute } in its zone.
function wallNow(zone = cases.ZONE) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(Date.now())) parts[p.type] = p.value;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}
const openNow = (v) => {
  const w = wallNow();
  return cases.openAt(v, w.day, w.hour, w.minute);
};

// A venue as Places v1 sends it.
function placePayload(v, { details = false } = {}) {
  const p = {
    id: v.id,
    displayName: { text: v.name, languageCode: 'en' },
    formattedAddress: v.address,
    rating: v.rating,
    userRatingCount: v.reviews,
    priceLevel: v.price,
    types: v.types,
    location: { latitude: v.lat, longitude: v.lng },
    currentOpeningHours: { openNow: openNow(v), periods: cases.periodsFor(v) },
  };
  if (details && !v.clockless) {
    p.utcOffsetMinutes = -300;
    p.timeZone = { id: cases.ZONE };
  }
  return p;
}

global.fetch = async (url, opts = {}) => {
  const u = String(url && url.url ? url.url : url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')) {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* an unreadable body searches nothing */ }
    const c = body.locationBias && body.locationBias.circle && body.locationBias.circle.center;
    const center = c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude) ? { lat: c.latitude, lng: c.longitude } : null;
    const places = cases.searchVenues(body.textQuery, center).map((v) => placePayload(v));
    return { ok: true, status: 200, json: async () => ({ places }) };
  }
  if (u.startsWith('https://generativelanguage.googleapis.com/') && !REPLAY) return realFetch(url, opts);
  let host = u;
  try { host = new URL(u).host; } catch { /* keep the string */ }
  blocked.push(host);
  throw new Error(`birdie eval: refused a network call to ${host}`);
};

// ── The database, answered from the persona asking ─────────────────────────

const pool = require(path.join(B, 'config', 'database'));
const unexpectedSql = new Set();
pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  const ctx = als.getStore();
  const persona = ctx && ctx.persona;
  if (/^SELECT birdie_ai_consent_at, birdie_ai_consent_copy FROM users WHERE id = \$1$/.test(q)) {
    const yes = persona && persona.client !== 'ios_legacy';
    return { rows: [{ birdie_ai_consent_at: yes ? new Date('2026-10-20T15:00:00Z') : null, birdie_ai_consent_copy: yes ? 2 : null }], rowCount: 1 };
  }
  if (/SELECT name, date_of_birth FROM users WHERE id/.test(q)) {
    return { rows: persona ? [{ name: persona.name, date_of_birth: persona.dob ? new Date(`${persona.dob}T00:00:00Z`) : null }] : [], rowCount: persona ? 1 : 0 };
  }
  if (/SELECT timezone FROM ml_venues WHERE google_place_id/.test(q)) {
    const v = cases.byId.get(params[0]);
    return v && v.corpus ? { rows: [{ timezone: cases.ZONE }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  // The group's plan (services/birdiePlan.js), from the persona's own flock:
  // the plan row for a member (every flock a persona lists is theirs), nobody
  // hidden from them, and the vote's tally as routes/venues.js reads it.
  if (/AS going_member_ids/.test(q)) {
    const f = persona && persona.flocks.find((x) => x.id === Number(params[0]));
    if (!f || !['planning', 'confirmed'].includes(f.status)) return { rows: [], rowCount: 0 };
    const going = f.plan && Number.isInteger(f.plan.going) ? f.plan.going : f.member_count;
    const members = Math.min(going, f.member_count);
    return {
      rows: [{
        status: f.status, venue_name: f.venue_name || null, venue_id: f.venue_id || null,
        going_member_ids: Array.from({ length: members }, (_, i) => 80000 + i), guests_going: going - members,
      }],
      rowCount: 1,
    };
  }
  if (/FROM user_blocks WHERE blocker_id/.test(q)) return { rows: [], rowCount: 0 };
  if (/FROM venue_votes vv JOIN users u/.test(q)) {
    const f = persona && persona.flocks.find((x) => x.id === Number(params[0]));
    const picks = (f && f.plan && f.plan.picks) || [];
    const rows = picks.map(([key, votes], i) => ({
      venue_name: cases.byKey.get(key).name, venue_id: cases.byKey.get(key).id, member_count: votes,
      voter_rows: Array.from({ length: votes }, (_, j) => ({ id: 81000 + i * 20 + j, name: `Voter ${i}.${j}` })),
    }));
    return { rows, rowCount: rows.length };
  }
  if (/FROM guest_votes gv JOIN guest_rsvps gr/.test(q)) return { rows: [], rowCount: 0 };
  if (/FROM venue_feedback/.test(q)) return { rows: [], rowCount: 0 };
  if (/fm\.user_id = \$2/.test(q)) {
    const f = persona && persona.flocks.find((x) => x.id === Number(params[0]));
    return f ? { rows: [{ name: f.name, status: f.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/FROM flocks f JOIN flock_members fm/.test(q)) {
    // The columns get_user_flocks selects, and no others: a flock's `plan`
    // fixture is what the plan read answers, not a column of this statement.
    const rows = (persona ? persona.flocks : []).map((f) => ({
      id: f.id, name: f.name, venue_name: f.venue_name, event_time: f.event_time ? new Date(f.event_time) : null,
      status: f.status, member_count: f.member_count,
    }));
    return { rows, rowCount: rows.length };
  }
  if (/FROM friendships fr/.test(q)) {
    const rows = (persona ? persona.friends : []).map((name, i) => ({ id: 9000 + i, name }));
    return { rows, rowCount: rows.length };
  }
  unexpectedSql.add(q.slice(0, 120));
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => { throw new Error('birdie eval: no database connections'); };

// ── Sign-in, meters and the paywall ─────────────────────────────────────────

const authMod = require(path.join(B, 'middleware', 'auth'));
const turnContexts = new Map();
authMod.authenticate = (req, res, next) => {
  const ctx = turnContexts.get(String(req.headers['x-eval-turn'] || ''));
  if (!ctx) return res.status(401).json({ error: 'no eval turn' });
  req.user = { id: ctx.persona.userId, name: ctx.persona.name };
  return als.run(ctx, next);
};

const personaByUser = new Map(Object.values(cases.PERSONAS).map((p) => [p.userId, p]));
const entitlements = require(path.join(B, 'services', 'entitlements'));
entitlements.paywallEnabled = (userId) => (personaByUser.get(userId) || {}).tier === 'free_spent';
entitlements.getPremiumState = async () => ({ known: true, premium: false, inGrace: false });

const birdieUsage = require(path.join(B, 'services', 'birdieUsage'));
birdieUsage.checkUserRateLimit = () => ({ allowed: true, remaining: 140, chargeDay: '2026-11-07', day: '2026-11-07' });
birdieUsage.allowGeminiCall = () => true;
birdieUsage.settleGeminiCall = () => {};
birdieUsage.refundTurn = () => {};

const placesBudget = require(path.join(B, 'utils', 'placesBudget'));
placesBudget.allowPlacesSearch = () => true;

const placeDetails = require(path.join(B, 'services', 'placeDetailsCache'));
placeDetails.willCostUpstreamCall = () => false;
placeDetails.isGonePlace = () => false;
placeDetails.fetchPlaceDetails = async (placeId) => {
  const v = cases.byId.get(placeId);
  if (!v) return { ok: false, kind: 'not_found' };
  if (v.detailsFail) return { ok: false, kind: 'upstream' };
  return { ok: true, place: placePayload(v, { details: true }) };
};

const weatherService = require(path.join(B, 'services', 'weatherService'));
weatherService.getWeather = async (lat, lon) => {
  const city = cases.cityOfPoint({ lat: Number(lat), lng: Number(lon) });
  return cases.WEATHER[city] ? { ...cases.WEATHER[city], fetchedAt: Date.now() } : null;
};

// The forecast allowance: open with the paywall off (production today); for a
// free account whose month is spent, open only for the venues it already
// opened this month.
const crowdRoute = require(path.join(B, 'routes', 'crowd'));
crowdRoute.forecastAccess = async (userId, { premium, placeId } = {}) => {
  const p = personaByUser.get(userId);
  if (!p || p.tier !== 'free_spent' || premium) return { locked: false, remaining: null, limit: null };
  if ((p.viewed || []).includes(placeId)) return { locked: false, remaining: 0, limit: 30 };
  return { locked: true, remaining: 0, limit: 30 };
};

const ownerReports = require(path.join(B, 'services', 'ownerReports'));
ownerReports.getLiveOwnerReports = async (ids) => {
  const out = {};
  for (const id of ids || []) {
    const v = cases.byId.get(id);
    // An owner reports from a room that is open.
    if (v && v.owner && openNow(v)) {
      out[id] = { id: null, busy_percent: v.owner.percent, created_at: new Date(Date.now() - v.owner.minutesAgo * 60000), retracted: false, diverged: false, profile_category: null };
    }
  }
  return out;
};

const gameNights = require(path.join(B, 'services', 'gameNights'));
gameNights.gameNightFor = async (lat, lon) => {
  if (cases.cityOfPoint({ lat, lng: lon }) !== cases.GAME_NIGHT.city) return null;
  const h = cases.GAME_NIGHT.home;
  return {
    teams: [...cases.GAME_NIGHT.teams],
    homeGame: { team: h.team, venueName: h.venueName, distanceKm: Math.round(cases.kmBetween({ lat, lng: lon }, h) * 10) / 10 },
  };
};

const tableHistory = require(path.join(B, 'services', 'tableHistory'));
tableHistory.publicSummaries = async (ids) => {
  const out = {};
  for (const id of ids || []) {
    const v = cases.byId.get(id);
    if (v && v.tables) out[id] = { ...v.tables, party: 2, busy_hours: [], updated_at: new Date().toISOString(), stale: false };
  }
  return out;
};

// ── The predictor, from each venue's curve ─────────────────────────────────

const crowdEngine = require(path.join(B, 'services', 'crowdEngine'));
const mlPredictor = require(path.join(B, 'services', 'mlPredictor'));
// The serving switches, read by the serving code's own readers (mlPredictor
// serveMode, nowcastEnabled, switchedArithmeticOn, hourlyAttributionOn) and
// never restated here: a CROWD_SERVE_MODE value serving knows (SERVE_MODES,
// model_when_fresh among them) is one this eval knows, and a value it does not
// know is 'model' here as it is there.
const serving = mlPredictor._internals;
const nowcastOn = () => serving.nowcastEnabled();
const switchesOn = () => serving.hourlyAttributionOn();
const methodOf = (v) => (v && v.corpus ? 'ml' : (mlPredictor.noCurveFallbackEnabled() ? crowdEngine.NO_CURVE_FALLBACK_METHOD : 'rule_engine'));
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
const MEASURED = (pct) => ({ status: 'measured', means: 'measured_accuracy', metric: 'within_15', population: 'realtime_served', populationRows: 4120, measuredPercent: pct, weatherPenalty: 0 });

// THE ARTIFACT THE MODEL SIDE ANSWERS AS. The fixture curve stands in for the
// graph's output, and everything predictBusyness decides from the artifact
// itself is decided here from its metadata, by the serving code's readers:
// its version (the quantile map and the model-table nowcast were fitted on
// one, QMAP_FITTED_ON and nowcastBaseKey), whether it reads the live features
// (liveFeaturesUsedReadings) and its measured accuracy (readServedAccuracy).
// By default the file serving loads (META_PATH), so once the November retrain
// lands there the eval answers as it; --artifact=F names another, a candidate
// before it ships. A replay answers as the artifact its run named.
const recordedArtifact = REPLAY && REPLAY.meta && REPLAY.meta.artifact ? REPLAY.meta.artifact.file : null;
const ARTIFACT_FILE = args.artifact ? path.resolve(String(args.artifact))
  : (recordedArtifact ? path.resolve(B, recordedArtifact) : serving.META_PATH);
const ARTIFACT = JSON.parse(fs.readFileSync(ARTIFACT_FILE, 'utf8'));
const VERSION = ARTIFACT.model_version || '2.1.0';
const ACCURACY = serving.readServedAccuracy(ARTIFACT);
if (ACCURACY.status === 'malformed') {
  console.error(`${ARTIFACT_FILE}: serving refuses this artifact (${ACCURACY.reason}).`);
  process.exit(1);
}

// A fixture's live reading is an hour old (`live` in birdieEvalCases.js).
// Whether that is fresh is serving's own test (isFreshReading), asked about
// the bucket an hour-old reading is picked in.
const HOUR_OLD = { lagHours: 1, bucket: serving.nowcastBucket(1) };
// Whether the curve_offset side answers a model-path number: every one under
// curve_offset, and under model_when_fresh every one without a fresh reading,
// the choice predictBusyness makes per number. The rule engine and the
// category table answer before any serve mode is read.
const curveSide = (method, reading) => {
  if (method !== 'ml') return false;
  const mode = serving.serveMode();
  return mode === 'curve_offset' || (mode === 'model_when_fresh' && !(reading && serving.isFreshReading(HOUR_OLD)));
};
// The curve_offset side's own account of its number, as predictBusyness gives
// it: the venue's curve, with an hour-old reading carried at that table's
// weight while the nowcast is on, and the confidence figure servedConfidence
// publishes for that arithmetic (measured on the curve and offset, or on
// their nowcast at that lag), never the model's. The fixture keeps no
// trailing offset, so nothing else of a live reading reaches it.
function curveAnswer(reading, weather, ladder) {
  const weight = serving.NOWCAST_WEIGHTS.curve_offset[HOUR_OLD.bucket];
  const nowcast = reading && nowcastOn() && weight > 0
    ? { base: 'curve_offset', bucket: HOUR_OLD.bucket, lagHours: HOUR_OLD.lagHours, weight }
    : null;
  return {
    predictionMethod: 'ml',
    serveMode: 'curve_offset',
    nowcast,
    dataSourcesUsed: nowcast ? ['venue_data', 'recent_live_readings'] : ['venue_data'],
    modelVersion: serving.servedModelVersion(VERSION, true, nowcast),
    usedLiveReadings: Boolean(nowcast),
    ...serving.servedConfidence({
      accuracy: ACCURACY, qmapApplied: false, hasWeather: serving.hasTempReading(weather), curveOffset: true, nowcast, ladder,
    }),
  };
}

// The model side's own account of its number, as predictBusyness gives it
// for the artifact above. The quantile map and the model-table nowcast run
// only on the version they were fitted on, so for a retrained artifact the
// hour-old reading moves nothing after the graph: it is one of the graph's
// inputs when the artifact reads the live features, and the number then says
// it used live readings with no crowd_method of its own, the shape a fresh
// venue carries under the mix once the November retrain ships. The nowcast's
// weight is the fixture's (`live` in birdieEvalCases.js), and the confidence
// figure is the one servedConfidence publishes for the arithmetic that ran.
function modelAnswer(v, reading, weather, ladder) {
  const qmapApplied = serving.qmapEnabled() && VERSION === serving.QMAP_FITTED_ON;
  const base = serving.nowcastBaseKey(false, qmapApplied, VERSION);
  const nowcast = reading && nowcastOn() && base
    ? { base, bucket: HOUR_OLD.bucket, lagHours: HOUR_OLD.lagHours, weight: v.live === '1h' ? 1 : 0.55 }
    : null;
  const inputs = serving.artifactReadsLiveFeatures(ARTIFACT)
    ? serving.liveFeaturesUsedReadings(reading ? { ...serving.LIVE_FEATURE_DEFAULTS, last_live_age_h: HOUR_OLD.lagHours } : serving.LIVE_FEATURE_DEFAULTS, ARTIFACT)
    : null;
  const out = {
    modelVersion: serving.servedModelVersion(VERSION, false, nowcast),
    ...serving.servedConfidence({
      accuracy: ACCURACY, qmapApplied, hasWeather: serving.hasTempReading(weather), curveOffset: false, nowcast, ladder,
    }),
  };
  if (nowcast) out.dataSourcesUsed = ['ml_model', 'baseline', 'recent_live_readings'];
  if (inputs !== null) out.liveFeaturesUsedReadings = inputs;
  // The switches' own account, only while one is on, as predictBusyness
  // gives it.
  if (serving.switchedArithmeticOn()) {
    out.serveMode = 'model';
    out.nowcast = nowcast;
    out.usedLiveReadings = Boolean(nowcast || inputs);
  }
  return out;
}

mlPredictor.predictBusyness = async (venue, weather, ts) => {
  const v = cases.byId.get(venue && venue.place_id);
  const at = new Date(ts);
  const day = at.getDay();
  const hour = at.getHours();
  const score = v ? cases.levelAt(v, day, hour) : 50;
  const method = methodOf(v);
  const out = {
    score, label: crowdEngine.getLabel(score), confidence: 41, factors: {},
    dataSourcesUsed: method === 'ml' ? ['ml_model', 'baseline'] : ['category_table'],
    predictionMethod: method, modelVersion: method === 'ml' ? VERSION : null, baselineScore: method === 'ml' ? score : null,
    eventsObserved: true,
  };
  if (method === crowdEngine.NO_CURVE_FALLBACK_METHOD) out.confidenceMeasurement = MEASURED(41.2);
  const live = Boolean(v && v.corpus && v.live && cases.openAt(v, day, hour, 30));
  const ladder = () => crowdEngine.calculateCrowdScore(venue, weather, ts).confidence;
  const curve = curveSide(method, live);
  if (curve) Object.assign(out, curveAnswer(live, weather, ladder));
  else if (method === 'ml') Object.assign(out, modelAnswer(v, live, weather, ladder));
  else if (switchesOn()) out.usedLiveReadings = false;
  // Under model_when_fresh, which side answered and the age of the reading
  // that decided it, as predictBusyness says (freshMix).
  if (method === 'ml' && serving.serveMode() === 'model_when_fresh') {
    out.freshMix = { answered: curve ? 'curve_offset' : 'model', readingLagHours: live ? HOUR_OLD.lagHours : null };
  }
  return out;
};

mlPredictor.predictHourlyForecast = async (venue, weather, startHour, count, baseTimestamp) => {
  const v = cases.byId.get(venue && venue.place_id);
  const base = new Date(baseTimestamp || Date.now());
  base.setHours(startHour, 0, 0, 0);
  const method = methodOf(v);
  const attributed = switchesOn();
  const out = [];
  for (let i = 0; i < (count || 12); i++) {
    const ts = new Date(base.getTime() + i * 3600000);
    const day = ts.getDay();
    const hour = ts.getHours();
    const score = v ? cases.levelAt(v, day, hour) : 50;
    const reading = Boolean(v && v.corpus && v.live && i <= 1 && cases.openAt(v, day, hour, 30));
    // Each hour takes its own side, as the strip's hours do under
    // model_when_fresh: only the hours with an hour-old reading run the model.
    // Whether a live reading reached the hour is read off that side's answer
    // the way serving reads it for the strip (liveReadingsReached).
    const ladder = () => crowdEngine.calculateCrowdScore(venue, weather, ts).confidence;
    const curve = curveSide(method, reading) ? curveAnswer(reading, weather, ladder) : null;
    const model = method === 'ml' && !curve ? modelAnswer(v, reading, weather, ladder) : null;
    const live = curve || model ? mlPredictor.liveReadingsReached(curve || model) : false;
    const entry = {
      hour: hourLabel(hour), score, label: crowdEngine.getLabel(score), predictionMethod: method,
      baselineScore: method === 'ml' ? score : null, eventsObserved: true, eventsUnavailableReason: null,
    };
    if (attributed) {
      let source = null;
      if (method === crowdEngine.NO_CURVE_FALLBACK_METHOD) source = 'category_typical';
      else if (curve) source = crowdEngine.describeServedArithmetic(curve);
      else if (model && model.nowcast && i === 1) source = 'model_live';
      if (source) entry.numberSource = source;
      entry.liveReadings = live;
    }
    out.push(entry);
  }
  return out;
};
mlPredictor.agreeWithStrip = async (headline) => headline;
// A later day's usual night (routes/ai.js A LATER DAY), from the fixture's
// curve and hours: the venue's own for a venue with a curve, the same curve
// standing in for the category table's for one without while the table is
// on, and nothing otherwise, as usualDayCurve chooses. The night runs 6 AM to
// 5 AM, open hours only.
mlPredictor.usualDayCurve = async (venue, weekday) => {
  const v = cases.byId.get(venue && venue.place_id);
  const method = v ? methodOf(v) : null;
  const source = method === 'ml' ? 'venue_pattern' : method === crowdEngine.NO_CURVE_FALLBACK_METHOD ? 'category_typical' : null;
  if (!source) return null;
  const hours = [];
  for (let i = 0; i < 24; i++) {
    const hour = (6 + i) % 24;
    const day = (weekday + (6 + i >= 24 ? 1 : 0)) % 7;
    if (cases.openAt(v, day, hour, 30)) hours.push({ day, hour, score: cases.levelAt(v, day, hour) });
  }
  return { source, weekday, hours };
};

// ── Gemini, watched (live) or replayed ──────────────────────────────────────

const genaiMod = require('@google/genai');
const RealGenAI = genaiMod.GoogleGenAI;
// --retry-probe=MS (a measurement; see the usage above). The probe gets a
// minute to answer, so a slow one is timed rather than cut.
const PROBE_AFTER_MS = !REPLAY && !RESCORE && Number(args['retry-probe']) > 0 ? Number(args['retry-probe']) : 0;
const PROBE_DEADLINE_MS = 60000;
// The route retries a stall at its deadline itself now, so a probe that fires
// before that deadline is a second retry beside the route's, bought twice.
if (PROBE_AFTER_MS > 0 && !(Number(args['gemini-deadline']) > PROBE_AFTER_MS)) {
  console.error('--retry-probe needs --gemini-deadline past its mark: the route retries a stall at its deadline itself (routes/ai.js ONE RETRY AFTER A STALL).');
  process.exit(1);
}
// The deadline a replay holds the recorded calls to (REPLAY, above), and the
// one a probe must have answered inside for a replayed retry to answer.
const REAL_DEADLINE_MS = require(path.join(B, 'utils', 'upstream')).UPSTREAM_TIMEOUT_MS.gemini;
const REPLAY_DEADLINE_MS = REPLAY && Number(args['gemini-deadline']) > 0 ? Number(args['gemini-deadline']) : null;
const pendingProbes = [];
const stripSignatures = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === 'thoughtSignature' ? '[sig]' : v)));
const replayedStall = () => Object.assign(new Error('The operation was aborted (replayed)'), { name: 'AbortError' });
// Our own deadline, read the way the route reads it (routes/ai.js
// geminiStalled): an abort, carrying no HTTP status.
const ownDeadline = (err) => Boolean(err) && err.status == null
  && /abort|timed? ?out/i.test(`${err.name || ''} ${err.message || ''}`);
genaiMod.GoogleGenAI = function EvalGenAI(opts) {
  const client = new RealGenAI(REPLAY ? { apiKey: 'replay-no-network' } : opts);
  const realGenerate = client.models.generateContent.bind(client.models);
  client.models.generateContent = async (req) => {
    const ctx = als.getStore();
    const contents = Array.isArray(req.contents) ? req.contents : [];
    const input = contents.length ? stripSignatures(contents[contents.length - 1]) : null;
    const system = req.config && req.config.systemInstruction;
    if (ctx && typeof system === 'string' && !ctx.systemPrompt) ctx.systemPrompt = system;
    // The route's retry of a stall: the same contents, straight after it.
    const key = ctx ? JSON.stringify(contents) : null;
    const stall = ctx && ctx.lastStall && ctx.lastStall.key === key ? ctx.lastStall : null;
    if (ctx) ctx.lastStall = null;
    const record = { input, ms: 0, tokens: null, response: null, error: null };
    if (stall) record.retryOf = stall.index;
    if (ctx) ctx.calls.push(record);
    const index = ctx ? ctx.calls.length - 1 : -1;
    const noteStall = (recorded) => { if (ctx) ctx.lastStall = { key, index, recorded: recorded || null }; };
    if (REPLAY) {
      const recordedCalls = (ctx && ctx.replayCalls) || [];
      if (ctx && ctx.replayCursor === undefined) ctx.replayCursor = 0;
      const recordedRetry = ctx && recordedCalls[ctx.replayCursor] && recordedCalls[ctx.replayCursor].retryOf != null;
      if (stall && !recordedRetry) {
        // A retry the recorded run never made, answered from what it knew
        // (see REPLAY above). It takes no recorded call of its own.
        const was = stall.recorded;
        const probe = was && was.retryProbe;
        if (was && was.response && probe && probe.answered && probe.ms <= (REPLAY_DEADLINE_MS || REAL_DEADLINE_MS)) {
          record.response = was.response;
          record.tokens = probe.tokens || null;
          return JSON.parse(JSON.stringify(was.response));
        }
        record.error = 'AbortError replay: stalled again (the recorded run has no reply for a retry)';
        noteStall(null);
        throw replayedStall();
      }
      let recorded = null;
      if (ctx) {
        // A retry the recorded run made and this route does not is passed over.
        if (!stall) while (recordedCalls[ctx.replayCursor] && recordedCalls[ctx.replayCursor].retryOf != null) ctx.replayCursor++;
        recorded = recordedCalls[ctx.replayCursor] || null;
        ctx.replayCursor++;
      }
      // A call the recorded run lost to the deadline is lost the same way
      // here, so the route's answer to a stall is replayed as well.
      if (recorded && !recorded.response && /abort|timed? ?out/i.test(String(recorded.error || ''))) {
        record.error = recorded.error;
        noteStall(recorded);
        throw replayedStall();
      }
      // --gemini-deadline in a replay: a reply the recorded run waited longer
      // than the deadline for is lost to it.
      if (recorded && recorded.response && REPLAY_DEADLINE_MS && recorded.ms > REPLAY_DEADLINE_MS) {
        record.error = `AbortError replay: past the ${REPLAY_DEADLINE_MS} ms deadline (the recorded call took ${recorded.ms} ms)`;
        // Google bills a request we hang up on, so the stalled attempt keeps
        // the cost the recorded call had, and the totals count both attempts.
        record.tokens = recorded.tokens;
        noteStall(recorded);
        throw replayedStall();
      }
      if (!recorded || !recorded.response) {
        record.error = 'replay: the recorded run made no such call';
        throw Object.assign(new Error(record.error), { status: 400 });
      }
      record.response = recorded.response;
      record.tokens = recorded.tokens;
      return JSON.parse(JSON.stringify(recorded.response));
    }
    const t0 = RealDate.now();
    // --retry-probe: a call still running at the mark gets one identical
    // request beside it, on a deadline of its own, and the route never sees
    // it. What it took, cost and answered is recorded on this call.
    const probeTimer = PROBE_AFTER_MS > 0 ? setTimeout(() => {
      const p0 = RealDate.now();
      const probe = { atMs: PROBE_AFTER_MS, ms: null, tokens: null, answered: null, error: null };
      record.retryProbe = probe;
      const probeReq = { ...req, config: { ...(req.config || {}), abortSignal: AbortSignal.timeout(PROBE_DEADLINE_MS) } };
      pendingProbes.push(realGenerate(probeReq).then((resp) => {
        probe.ms = RealDate.now() - p0;
        const u = resp && resp.usageMetadata ? resp.usageMetadata : {};
        probe.tokens = { prompt: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0, total: u.totalTokenCount || 0 };
        const parts = (resp && resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts) || [];
        probe.answered = parts.some((x) => x.text || x.functionCall);
      }, (err) => {
        probe.ms = RealDate.now() - p0;
        probe.error = `${err.status || err.name || ''} ${String(err.message || '').slice(0, 160)}`.trim();
      }));
    }, PROBE_AFTER_MS) : null;
    try {
      const resp = await realGenerate(req);
      record.ms = RealDate.now() - t0;
      const u = resp && resp.usageMetadata ? resp.usageMetadata : {};
      record.tokens = {
        prompt: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0,
        cached: u.cachedContentTokenCount || 0, total: u.totalTokenCount || 0,
      };
      record.response = stripSignatures({ candidates: resp.candidates, promptFeedback: resp.promptFeedback, usageMetadata: resp.usageMetadata });
      return resp;
    } catch (err) {
      record.ms = RealDate.now() - t0;
      record.error = `${err.status || err.name || ''} ${String(err.message || '').slice(0, 200)}`.trim();
      // The route may send this call once more (THE ROUTE'S OWN RETRY, above).
      if (ownDeadline(err)) noteStall(null);
      throw err;
    } finally {
      if (probeTimer) clearTimeout(probeTimer);
    }
  };
  return client;
};

// --gemini-deadline=MS: a measurement, never a setting. Birdie's per-call
// deadline (UPSTREAM_TIMEOUT_MS.gemini) is replaced in this process only, so a
// run can see how long a call that the real deadline cuts off would have
// taken. Patched before the route loads, which is when it takes the function.
if (args['gemini-deadline']) {
  const upstream = require(path.join(B, 'utils', 'upstream'));
  const realSignal = upstream.upstreamSignal;
  const ms = Number(args['gemini-deadline']);
  upstream.upstreamSignal = (kind) => (kind === 'gemini' ? AbortSignal.timeout(ms) : realSignal(kind));
}

// ── The route, in process ───────────────────────────────────────────────────

const express = require('express');
const http = require('http');
const aiRouter = require(path.join(B, 'routes', 'ai'));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/ai', aiRouter);
const server = http.createServer(app);

const { instantForWallClock } = require(path.join(B, 'utils', 'venueZone'));

function ageBracketOf(dob) {
  if (!dob) return null;
  const age = Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000));
  return age < 18 ? 'minor' : age < 21 ? 'under21' : 'adult';
}

function clockFacts() {
  const w = wallNow();
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: cases.ZONE, day: 'numeric', year: 'numeric' }).formatToParts(Date.now())) parts[p.type] = p.value;
  return { hour24: w.hour, minute: w.minute, day: Number(parts.day), year: Number(parts.year), weekday: w.day };
}

// The tool calls a turn made and what each returned, read off the model
// calls: a call's function calls, answered in the next call's input.
function toolsOf(calls) {
  const out = [];
  calls.forEach((c, i) => {
    const parts = (c.response && c.response.candidates && c.response.candidates[0] && c.response.candidates[0].content && c.response.candidates[0].content.parts) || [];
    const fcs = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const next = calls[i + 1];
    const frs = ((next && next.input && next.input.parts) || []).filter((p) => p.functionResponse).map((p) => p.functionResponse);
    fcs.forEach((fc, j) => {
      const fr = frs.find((r) => fc.id && r.id === fc.id) || frs[j] || null;
      out.push({ name: fc.name, args: fc.args || {}, result: fr ? fr.response : null });
    });
  });
  return out;
}

let base = null;
const prompts = {};

// The venues an answer carded, as the app sends them back with the next
// question (frontend App.js toAiCarded): each card's place id, name, types,
// price, rating and deal, at most four.
function cardedOf(venues) {
  return (Array.isArray(venues) ? venues : []).slice(0, 4).filter((v) => v && typeof v.name === 'string' && v.name).map((v) => ({
    name: v.name,
    ...(typeof v.place_id === 'string' && v.place_id ? { place_id: v.place_id } : {}),
    ...(Array.isArray(v.types) ? { types: v.types.filter((t) => typeof t === 'string' && t).slice(0, 5) } : {}),
    ...(Number.isInteger(v.price_level) ? { price_level: v.price_level } : {}),
    ...(typeof v.rating === 'number' && Number.isFinite(v.rating) ? { rating: v.rating } : {}),
    ...(v.deal && typeof v.deal.title === 'string' ? { deal: { title: v.deal.title, time_slot: v.deal.time_slot || null, days: v.deal.days || null } } : {}),
  }));
}

async function runTurn(item, persona, messages, turnIndex, replayTurn, carded = []) {
  const key = `${item.id}#${turnIndex}#${crypto.randomUUID()}`;
  const ctx = { item, persona, turnIndex, calls: [], systemPrompt: null, replayCalls: replayTurn ? replayTurn.calls : null };
  turnContexts.set(key, ctx);
  const w = wallNow();
  const body = {
    messages,
    location: persona.location ? { lat: persona.location.lat, lng: persona.location.lng } : null,
    // The app's context, with the venues its most recent carded answer showed.
    currentContext: carded.length ? { ...(item.ctx || {}), carded } : (item.ctx || null),
    localHour: w.hour,
    localDay: w.day,
  };
  // How old the location is, from a client that knows (fixAgeSec in the cases).
  if (persona.location && Number.isInteger(persona.fixAgeSec)) body.locationAgeSec = persona.fixAgeSec;
  if (persona.client === 'ios' || persona.client === 'ios_legacy') body.purchases = 'off';
  if (persona.client !== 'ios_legacy') {
    body.consentFlow = 'ask';
    body.timeZone = cases.ZONE;
  }
  const clock = clockFacts();
  const t0 = RealDate.now();
  let status = 0;
  let out = null;
  try {
    const res = await realFetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-eval-turn': key },
      body: JSON.stringify(body),
    });
    status = res.status;
    out = await res.json();
  } catch (err) {
    out = { error: `request failed: ${err.message}` };
  }
  turnContexts.delete(key);
  const hash = ctx.systemPrompt ? crypto.createHash('sha256').update(ctx.systemPrompt).digest('hex').slice(0, 12) : null;
  if (hash && !prompts[hash]) prompts[hash] = ctx.systemPrompt;
  return { status, out, ms: RealDate.now() - t0, calls: ctx.calls, tools: toolsOf(ctx.calls), promptHash: hash, systemPrompt: ctx.systemPrompt, clock };
}

function expectFor(item, turnIndex) {
  const last = turnIndex === item.turns.length - 1;
  const e = { ...((item.expectTurns && item.expectTurns[turnIndex]) || (last ? item.expect : {})) };
  if (e.draft && e.draft.local) {
    const m = e.draft.local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    const ms = instantForWallClock({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, cases.ZONE, Date.now());
    e.draft = { ...e.draft, utc: new RealDate(ms).toISOString() };
  }
  return e;
}

let tokensUsed = 0;
const maxTokens = Number(args['max-tokens'] || 1000000);

// A recorded turn, as --rescore scores it: what the run answered, with the
// prompt it was answered under.
function recordedTurn(t) {
  if (!t) return null;
  return {
    status: t.status, out: t.out, ms: t.ms, calls: t.calls || [], tools: t.tools || [], promptHash: t.promptHash,
    systemPrompt: ((RESCORE.meta && RESCORE.meta.prompts) || {})[t.promptHash] || null, clock: clockFacts(),
  };
}

async function runItem(item) {
  const persona = cases.PERSONAS[item.persona];
  const source = REPLAY || RESCORE;
  const recorded = source ? (source.items || []).find((r) => r.id === item.id) : null;
  const result = { id: item.id, persona: item.persona, clock: item.clock, turns: [] };
  if (source && (!recorded || recorded.skipped)) {
    result.skipped = 'not in the recorded run';
    return result;
  }
  if (!source && tokensUsed >= maxTokens) {
    result.skipped = `token ceiling (${maxTokens}) reached`;
    return result;
  }
  const messages = [];
  const priorTools = [];
  const userTexts = [];
  // The cards of the most recent answer that carried any (toAiCarded).
  let carded = [];
  for (let i = 0; i < item.turns.length; i++) {
    // The outage breaker is module state: one item's failure must not close
    // Birdie for the items after it.
    aiRouter.__resetBirdieOutage();
    const text = item.turns[i];
    messages.push({ role: 'user', text });
    userTexts.push(text);
    const turn = RESCORE
      ? recordedTurn(recorded.turns[i])
      : await runTurn(item, persona, messages.slice(-24), i, recorded ? recorded.turns[i] : null, carded);
    if (turn && turn.out && Array.isArray(turn.out.venues) && turn.out.venues.length) carded = cardedOf(turn.out.venues);
    if (!turn) break;
    const turnTokens = turn.calls.reduce((n, c) => n + ((c.tokens && c.tokens.total) || 0), 0);
    if (!source) tokensUsed += turnTokens;
    const expect = expectFor(item, i);
    const ctxVenueIds = item.ctx && item.ctx.venue && item.ctx.venue.place_id ? [item.ctx.venue.place_id] : [];
    const flockHours = persona.flocks.filter((f) => f.event_time).map((f) => wallNowAt(f.event_time));
    // The plan the server read for this persona, when the item asks from a
    // flock: its picks and its locked venue are places Birdie may name.
    const plan = item.ctx && item.ctx.flock && item.ctx.flock.id ? cases.planOf(persona, item.ctx.flock.id) : null;
    const graded = checks.checkAnswer({
      expect, ageBracket: ageBracketOf(persona.dob), status: turn.status, out: turn.out, tools: turn.tools, priorTools: [...priorTools],
      userTexts: [...userTexts], clock: turn.clock, systemPrompt: turn.systemPrompt, ctxVenueIds, venues: cases.VENUES,
      openIds: new Set(cases.VENUES.filter(openNow).map((v) => v.id)), flockHours,
      planPickIds: plan ? plan.pickIds : [], planLockedId: plan ? plan.lockedId : null,
    });
    result.turns.push({
      user: text, status: turn.status, out: turn.out, ms: turn.ms, tokens: turnTokens, promptHash: turn.promptHash,
      calls: turn.calls, tools: turn.tools, problems: graded.problems, warnings: graded.warnings, info: graded.info,
    });
    priorTools.push(...turn.tools);
    if (turn.status === 200 && turn.out && typeof turn.out.text === 'string') messages.push({ role: 'assistant', text: turn.out.text });
    else break;
  }
  return result;
}

function wallNowAt(iso) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: cases.ZONE, hour: 'numeric', hourCycle: 'h23' }).formatToParts(RealDate.parse(iso))) parts[p.type] = p.value;
  return Number(parts.hour) % 24;
}

// A small pool: `n` conversations in flight, each one's turns in order.
async function inParallel(list, n, fn) {
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, list.length)) }, async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i]);
      process.stdout.write('.');
    }
  });
  await Promise.all(workers);
  return results;
}

function pick(list) {
  let out = list;
  if (args.only) {
    const ids = new Set(String(args.only).split(',').map((s) => s.trim()).filter(Boolean));
    out = out.filter((i) => ids.has(i.id));
  }
  if (args.q) {
    const qs = String(args.q).toLowerCase().split('|').filter(Boolean);
    out = out.filter((i) => i.turns.some((t) => qs.some((q) => t.toLowerCase().includes(q))));
  }
  return out;
}

function printItem(r) {
  if (r.skipped) {
    console.log(`skip ${r.id} ${r.persona}: ${r.skipped}`);
    return;
  }
  r.turns.forEach((t, i) => {
    const toolText = t.tools.map((x) => x.name).join(', ') || 'no tools';
    const extra = `[${toolText}] ${t.calls.length} call(s) ${(t.ms / 1000).toFixed(1)}s ${(t.tokens / 1000).toFixed(1)}k tok`;
    console.log(checks.gradeLine(`${r.id}${r.turns.length > 1 ? `.${i + 1}` : ''}`, r.persona, t.user, t, extra));
    if (!args.quiet) {
      for (const line of String((t.out && (t.out.text || t.out.error)) || '').split('\n')) console.log(`       > ${line}`);
      const cards = (t.out && t.out.venues) || [];
      if (cards.length) console.log(`       cards: ${cards.map((c) => `${cases.byId.get(c.place_id)?.key || c.name}${c.crowd != null ? ` (${c.crowd})` : ''}`).join(', ')}`);
      if (t.out && t.out.navigate) console.log(`       navigate: ${JSON.stringify(t.out.navigate)}`);
      if (t.out && t.out.flock_draft) console.log(`       plan card: ${JSON.stringify(t.out.flock_draft)}`);
      if (t.out && t.out.vote_stage) console.log(`       vote card: ${JSON.stringify({ flock_id: t.out.vote_stage.flock_id, venue: t.out.vote_stage.venue && t.out.vote_stage.venue.name })}`);
    }
    for (const p of t.problems) console.log(`       ! ${p}`);
    for (const w of t.warnings) console.log(`       ~ ${w}`);
  });
}

function summarize(results, meta) {
  const turns = results.flatMap((r) => r.turns || []);
  const failing = turns.filter((t) => t.problems.length);
  const warned = turns.filter((t) => !t.problems.length && t.warnings.length);
  const byCheck = {};
  for (const t of turns) for (const p of t.problems) {
    const k = p.split(':')[0];
    byCheck[k] = (byCheck[k] || 0) + 1;
  }
  const warnByCheck = {};
  for (const t of turns) for (const w of t.warnings) {
    const k = w.split(':')[0];
    warnByCheck[k] = (warnByCheck[k] || 0) + 1;
  }
  const calls = turns.flatMap((t) => t.calls);
  const sum = (f) => calls.reduce((n, c) => n + ((c.tokens && c.tokens[f]) || 0), 0);
  // Calls past Birdie's real per-call deadline (a stall, which production
  // cuts off), and what the retry probes, if any, did about them.
  const deadline = require(path.join(B, 'utils', 'upstream')).UPSTREAM_TIMEOUT_MS.gemini;
  const stalls = calls.filter((c) => c.ms > deadline || (c.error && /abort|timed? ?out/i.test(c.error) && c.ms >= deadline - 50));
  const probes = calls.map((c) => c.retryProbe).filter(Boolean);
  // Calls lost to the deadline, replayed ones included, and the route's own
  // retries of them (THE ROUTE'S OWN RETRY, above).
  const lostToDeadline = (c) => !c.response && /abort|timed? ?out/i.test(String(c.error || ''));
  const retries = calls.filter((c) => c.retryOf != null);
  const retryAnswered = retries.filter((c) => c.response).length;
  const retryStalled = retries.filter(lostToDeadline).length;
  const ms = calls.filter((c) => c.ms).map((c) => c.ms).sort((a, z) => a - z);
  const turnMs = turns.map((t) => t.ms).sort((a, z) => a - z);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0);
  const errors = calls.filter((c) => c.error).map((c) => c.error);
  const summary = {
    items: results.length,
    skipped: results.filter((r) => r.skipped).length,
    turns: turns.length,
    passing: turns.length - failing.length,
    clean: turns.length - failing.length - warned.length,
    failing: failing.length,
    problemsByCheck: byCheck,
    warningsByCheck: warnByCheck,
    tokens: { total: sum('total'), prompt: sum('prompt'), output: sum('output'), thoughts: sum('thoughts'), cached: sum('cached') },
    modelCalls: calls.length,
    callLatencyMs: { p50: pct(ms, 0.5), p90: pct(ms, 0.9), max: ms[ms.length - 1] || 0 },
    turnLatencyMs: { p50: pct(turnMs, 0.5), p90: pct(turnMs, 0.9), max: turnMs[turnMs.length - 1] || 0 },
    modelErrors: errors.length,
    modelErrorSamples: [...new Set(errors)].slice(0, 4),
    stalls: { deadlineMs: deadline, calls: stalls.length },
    retryProbes: {
      count: probes.length,
      answeredInTime: probes.filter((p) => p.answered && p.ms <= deadline).length,
      tokens: probes.reduce((n, p) => n + ((p.tokens && p.tokens.total) || 0), 0),
    },
    stallRetries: {
      lostToDeadline: calls.filter(lostToDeadline).length,
      count: retries.length,
      answered: retryAnswered,
      stalledAgain: retryStalled,
      failed: retries.length - retryAnswered - retryStalled,
      tokens: retries.reduce((n, c) => n + ((c.tokens && c.tokens.total) || 0), 0),
    },
    http: turns.reduce((m, t) => ({ ...m, [t.status]: (m[t.status] || 0) + 1 }), {}),
    lowercaseStarts: turns.filter((t) => t.info && t.info.lowercaseStart).length,
    blockedNetworkCalls: [...new Set(blocked)],
    unexpectedSql: [...unexpectedSql],
  };
  console.log('\n── Summary');
  console.log(`model ${meta.model} (${meta.mode}), switches ${JSON.stringify(meta.switches)}${meta.artifact ? `, artifact ${meta.artifact.modelVersion}${meta.artifact.file ? ` (${meta.artifact.file})` : ''}` : ''}`);
  console.log(`items ${summary.items} (${summary.skipped} skipped), answers ${summary.turns}: passing ${summary.passing} (clean ${summary.clean}), failing ${summary.failing}`);
  console.log(`problems by check: ${JSON.stringify(byCheck)}`);
  console.log(`warnings by check: ${JSON.stringify(warnByCheck)}`);
  console.log(`tokens: ${summary.tokens.total} total (prompt ${summary.tokens.prompt}, cached ${summary.tokens.cached}, output ${summary.tokens.output}, thinking ${summary.tokens.thoughts}) over ${summary.modelCalls} model calls`);
  console.log(`latency per model call p50 ${summary.callLatencyMs.p50} ms, p90 ${summary.callLatencyMs.p90} ms, max ${summary.callLatencyMs.max} ms; per answer p50 ${summary.turnLatencyMs.p50} ms, p90 ${summary.turnLatencyMs.p90} ms`);
  console.log(`http: ${JSON.stringify(summary.http)}; model errors: ${summary.modelErrors}${summary.modelErrors ? ` (${summary.modelErrorSamples.join(' | ')})` : ''}`);
  console.log(`calls past the ${deadline} ms deadline: ${stalls.length} of ${calls.length}${probes.length ? `; retry probes ${probes.length}, answered inside the deadline ${summary.retryProbes.answeredInTime}, probe tokens ${summary.retryProbes.tokens}` : ''}`);
  const sr = summary.stallRetries;
  console.log(`calls lost to the deadline: ${sr.lostToDeadline}; the route's stall retries: ${sr.count} (answered ${sr.answered}, stalled again ${sr.stalledAgain}, failed ${sr.failed}), retry tokens ${sr.tokens}`);
  console.log(`answers starting lowercase: ${summary.lowercaseStarts} of ${summary.turns}`);
  if (summary.blockedNetworkCalls.length) console.log(`REFUSED network calls: ${summary.blockedNetworkCalls.join(', ')}`);
  if (summary.unexpectedSql.length) console.log(`unanswered queries: ${summary.unexpectedSql.length}`);
  return summary;
}

// --fixtures: what the tools answer, with no model. Every venue's crowd
// result at every clock, as the persona named by --as (default marcus_22)
// would get it, and a search or two, so the world the battery runs in can be
// read before a token is spent.
async function previewFixtures() {
  const { executeTool } = aiRouter.__testables;
  const persona = cases.PERSONAS[String(args.as || 'marcus_22')];
  const zoned = persona.client !== 'ios_legacy';
  console.log(`artifact ${VERSION} (${path.relative(B, ARTIFACT_FILE)})`);
  for (const [name, iso] of Object.entries(cases.CLOCKS)) {
    setClock(iso);
    const w = wallNow();
    console.log(`\n── ${name} (${new RealDate(Date.now()).toISOString()}, ${cases.ZONE} day ${w.day} ${w.hour}:${String(w.minute).padStart(2, '0')})`);
    for (const v of cases.VENUES) {
      const access = await crowdRoute.forecastAccess(persona.userId, { placeId: v.id });
      const r = await als.run({ persona, calls: [] }, () => executeTool('get_crowd_prediction', { place_id: v.id }, persona.userId, {
        includeForecast: !access.locked, salesOff: persona.client !== 'web', searchedPlaces: new Map(),
        timeZone: zoned ? cases.ZONE : null, ...(zoned ? { localHour: w.hour, localDay: w.day } : {}),
      }));
      // Each hour's own attribution while a switch is on: /crowd_method, and
      // +live or -live for its live_readings yes or no.
      const strip = (r.hourly_forecast || []).slice(0, 6).map((h) => `${h.hour}=${h.score}${h.crowd_method ? `/${h.crowd_method}` : ''}${typeof h.live_readings === 'boolean' ? (h.live_readings ? '+live' : '-live') : ''}`).join(' ');
      // The confidence figure Birdie is handed, and what confidence_measurement
      // says it is: the measured percent and its metric, or its status.
      const cm = r.confidence_measurement;
      const conf = cm ? ` conf=${r.confidence}(${cm.status === 'measured' ? `${cm.measuredPercent} ${cm.metric}` : cm.status})` : '';
      console.log(`${v.key.padEnd(10)} open=${openNow(v) ? 'y' : 'n'} ${r.error ? `ERROR ${r.error}` : `score=${r.crowd_score} "${r.crowd_label}" src=${r.crowd_source}${r.crowd_method ? `/${r.crowd_method}` : ''} best="${r.best_time}" peak="${r.peak_hours}"${r.forecast_locked ? ' LOCKED' : ''}${r.clock ? ` clock=${r.clock}` : ''}${r.game_night ? ' game' : ''}${conf}`}`);
      if (strip) console.log(`           ${strip}`);
    }
  }
  setClock(cases.CLOCKS.fri_evening);
  for (const [q, at] of [['pizza', cases.PLACES.centerCity], ['fun things to do', cases.PLACES.allentown], ['bars', cases.PLACES.fishtown], ['restaurants', null]]) {
    const r = await als.run({ persona, calls: [] }, () => executeTool('search_venues', { query: q, ...(at ? { location: `${at.lat.toFixed(2)},${at.lng.toFixed(2)}` } : {}) }, persona.userId, {}));
    console.log(`search "${q}"${at ? '' : ' (no location)'}: ${(r.venues || []).map((x) => `${cases.byId.get(x.place_id)?.key}${x.is_open ? '' : '(closed)'}${x.tables ? '[tables]' : ''}`).join(', ') || r.error}`);
  }
}

(async () => {
  if (args.fixtures) {
    await previewFixtures();
    process.exit(0);
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const items = pick(cases.BATTERY);
  const meta = RESCORE ? {
    ...RESCORE.meta,
    mode: `rescore of ${path.basename(String(args.rescore))}`,
    startedAt: new RealDate().toISOString(),
  } : {
    model: process.env.BIRDIE_MODEL || 'gemini-3.5-flash-lite (code default)',
    mode: REPLAY ? `replay of ${path.basename(String(args.replay))}` : 'live',
    startedAt: new RealDate().toISOString(),
    clocks: cases.CLOCKS,
    switches: Object.fromEntries(['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_NO_CURVE_FALLBACK', 'CROWD_QMAP_ENABLED', 'BIRDIE_MODEL'].map((k) => [k, process.env[k] ?? null])),
    // The artifact the crowd tool answered as; `file` only when --artifact
    // named one (THE ARTIFACT), so a replay answers as it again.
    artifact: { file: args.artifact ? path.relative(B, ARTIFACT_FILE) : recordedArtifact, modelVersion: VERSION },
    concurrency: Number(args.concurrency || 4),
  };
  delete meta.summary;
  delete meta.prompts;
  const results = [];
  for (const clock of Object.keys(cases.CLOCKS)) {
    const group = items.filter((i) => i.clock === clock);
    if (!group.length) continue;
    setClock(cases.CLOCKS[clock]);
    results.push(...await inParallel(group, meta.concurrency, runItem));
  }
  // Every retry probe has its answer before anything is counted or written.
  await Promise.all(pendingProbes);
  process.stdout.write('\n\n');
  const order = new Map(items.map((i, n) => [i.id, n]));
  results.sort((a, z) => order.get(a.id) - order.get(z.id));
  for (const r of results) printItem(r);
  const summary = summarize(results, meta);
  if (args.out) {
    const file = path.resolve(String(args.out));
    fs.writeFileSync(file, JSON.stringify({ meta: { ...meta, summary, prompts }, items: results }, null, 2));
    console.log(`wrote ${file}`);
  }
  server.close();
  process.exit(summary.failing ? 1 : 0);
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(2);
});
