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
//                    switches in force shape a real answer
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
//   ... --model=NAME            a measurement: Birdie runs on this Gemini model
//                               in this process only (BIRDIE_MODEL is never
//                               changed anywhere else), with the same settings
//   ... --retry-probe=MS        a measurement: a model call still running at
//                               MS gets one identical request sent beside it,
//                               and how long that took, what it cost and
//                               whether it answered is recorded on the call
//                               (retryProbe). The route never sees it: this is
//                               what one retry after a stall would have done,
//                               without changing the rule that there is none
//   node scripts/birdie/birdieEval.js --fixtures [--as=persona]
//                               what every tool answers, at every clock, with
//                               no model and no key
//
// REPLAY: --replay=F answers every model call from run F's recorded replies,
// in order, with no key and no network, so a change to the checks, the tool
// code or the post-processing is scored on what the real model wrote. A call
// the recorded run never made (the route changed since) fails, and that item
// says so. The serving switches the recorded run saw are restored from F.
//   node scripts/birdie/birdieEval.js --replay=F [--out=G]
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
// keeps the Gemini key, the model name and the crowd serving switches (they
// change what Birdie is told), and removes every other credential and every
// way to a database before a single application module loads.
const KEEP = new Set(['GEMINI_API_KEY', 'BIRDIE_MODEL', 'CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_NO_CURVE_FALLBACK']);
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
  for (const k of ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_NO_CURVE_FALLBACK', 'BIRDIE_MODEL']) {
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
  if (/FROM venue_feedback/.test(q)) return { rows: [], rowCount: 0 };
  if (/fm\.user_id = \$2/.test(q)) {
    const f = persona && persona.flocks.find((x) => x.id === Number(params[0]));
    return f ? { rows: [{ name: f.name, status: f.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/FROM flocks f JOIN flock_members fm/.test(q)) {
    const rows = (persona ? persona.flocks : []).map((f) => ({ ...f, event_time: f.event_time ? new Date(f.event_time) : null }));
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
const nowcastOn = () => process.env.CROWD_NOWCAST_ENABLED === 'true';
const switchesOn = () => process.env.CROWD_SERVE_MODE === 'curve_offset' || nowcastOn() || mlPredictor.noCurveFallbackEnabled();
const methodOf = (v) => (v && v.corpus ? 'ml' : (mlPredictor.noCurveFallbackEnabled() ? crowdEngine.NO_CURVE_FALLBACK_METHOD : 'rule_engine'));
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
const MEASURED = (pct) => ({ status: 'measured', means: 'measured_accuracy', metric: 'within_15', population: 'realtime_served', populationRows: 4120, measuredPercent: pct, weatherPenalty: 0 });

mlPredictor.predictBusyness = async (venue, _weather, ts) => {
  const v = cases.byId.get(venue && venue.place_id);
  const at = new Date(ts);
  const day = at.getDay();
  const hour = at.getHours();
  const score = v ? cases.levelAt(v, day, hour) : 50;
  const method = methodOf(v);
  const out = {
    score, label: crowdEngine.getLabel(score), confidence: method === 'ml' ? 37 : 41, factors: {},
    dataSourcesUsed: method === 'ml' ? ['ml_model', 'baseline'] : ['category_table'],
    predictionMethod: method, modelVersion: '2.6.0-starling', baselineScore: method === 'ml' ? score : null,
    eventsObserved: true,
  };
  if (method === 'ml') out.confidenceMeasurement = MEASURED(37.4);
  else if (method === crowdEngine.NO_CURVE_FALLBACK_METHOD) out.confidenceMeasurement = MEASURED(41.2);
  const live = v && v.corpus && v.live && cases.openAt(v, day, hour, 30);
  if (live && nowcastOn()) {
    out.nowcast = { weight: v.live === '1h' ? 1 : 0.55, lagHours: 1 };
    out.usedLiveReadings = true;
    out.dataSourcesUsed.push('recent_live_readings');
  } else if (switchesOn()) {
    out.usedLiveReadings = false;
  }
  return out;
};

mlPredictor.predictHourlyForecast = async (venue, _weather, startHour, count, baseTimestamp) => {
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
    const live = Boolean(v && v.corpus && v.live && i <= 1 && cases.openAt(v, day, hour, 30) && nowcastOn());
    const entry = {
      hour: hourLabel(hour), score, label: crowdEngine.getLabel(score), predictionMethod: method,
      baselineScore: method === 'ml' ? score : null, eventsObserved: true, eventsUnavailableReason: null,
    };
    if (attributed) {
      const source = method === crowdEngine.NO_CURVE_FALLBACK_METHOD ? 'category_typical' : (live && i === 1 ? 'model_live' : null);
      if (source) entry.numberSource = source;
      entry.liveReadings = live;
    }
    out.push(entry);
  }
  return out;
};
mlPredictor.agreeWithStrip = async (headline) => headline;

// ── Gemini, watched (live) or replayed ──────────────────────────────────────

const genaiMod = require('@google/genai');
const RealGenAI = genaiMod.GoogleGenAI;
// --retry-probe=MS (a measurement; see the usage above). The probe gets a
// minute to answer, so a slow one is timed rather than cut.
const PROBE_AFTER_MS = !REPLAY && !RESCORE && Number(args['retry-probe']) > 0 ? Number(args['retry-probe']) : 0;
const PROBE_DEADLINE_MS = 60000;
const pendingProbes = [];
const stripSignatures = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === 'thoughtSignature' ? '[sig]' : v)));
genaiMod.GoogleGenAI = function EvalGenAI(opts) {
  const client = new RealGenAI(REPLAY ? { apiKey: 'replay-no-network' } : opts);
  const realGenerate = client.models.generateContent.bind(client.models);
  client.models.generateContent = async (req) => {
    const ctx = als.getStore();
    const contents = Array.isArray(req.contents) ? req.contents : [];
    const input = contents.length ? stripSignatures(contents[contents.length - 1]) : null;
    const system = req.config && req.config.systemInstruction;
    if (ctx && typeof system === 'string' && !ctx.systemPrompt) ctx.systemPrompt = system;
    const record = { input, ms: 0, tokens: null, response: null, error: null };
    if (ctx) ctx.calls.push(record);
    if (REPLAY) {
      const recorded = ctx && ctx.replayCalls ? ctx.replayCalls[ctx.calls.length - 1] : null;
      // A call the recorded run lost to the deadline is lost the same way
      // here, so the route's answer to a stall is replayed as well.
      if (recorded && !recorded.response && /abort|timed? ?out/i.test(String(recorded.error || ''))) {
        record.error = recorded.error;
        throw Object.assign(new Error('The operation was aborted (replayed)'), { name: 'AbortError' });
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

async function runTurn(item, persona, messages, turnIndex, replayTurn) {
  const key = `${item.id}#${turnIndex}#${crypto.randomUUID()}`;
  const ctx = { item, persona, turnIndex, calls: [], systemPrompt: null, replayCalls: replayTurn ? replayTurn.calls : null };
  turnContexts.set(key, ctx);
  const w = wallNow();
  const body = {
    messages,
    location: persona.location ? { lat: persona.location.lat, lng: persona.location.lng } : null,
    currentContext: item.ctx || null,
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
  for (let i = 0; i < item.turns.length; i++) {
    // The outage breaker is module state: one item's failure must not close
    // Birdie for the items after it.
    aiRouter.__resetBirdieOutage();
    const text = item.turns[i];
    messages.push({ role: 'user', text });
    userTexts.push(text);
    const turn = RESCORE
      ? recordedTurn(recorded.turns[i])
      : await runTurn(item, persona, messages.slice(-24), i, recorded ? recorded.turns[i] : null);
    if (!turn) break;
    const turnTokens = turn.calls.reduce((n, c) => n + ((c.tokens && c.tokens.total) || 0), 0);
    if (!source) tokensUsed += turnTokens;
    const expect = expectFor(item, i);
    const ctxVenueIds = item.ctx && item.ctx.venue && item.ctx.venue.place_id ? [item.ctx.venue.place_id] : [];
    const flockHours = persona.flocks.filter((f) => f.event_time).map((f) => wallNowAt(f.event_time));
    const graded = checks.checkAnswer({
      expect, ageBracket: ageBracketOf(persona.dob), status: turn.status, out: turn.out, tools: turn.tools, priorTools: [...priorTools],
      userTexts: [...userTexts], clock: turn.clock, systemPrompt: turn.systemPrompt, ctxVenueIds, venues: cases.VENUES,
      openIds: new Set(cases.VENUES.filter(openNow).map((v) => v.id)), flockHours,
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
    http: turns.reduce((m, t) => ({ ...m, [t.status]: (m[t.status] || 0) + 1 }), {}),
    lowercaseStarts: turns.filter((t) => t.info && t.info.lowercaseStart).length,
    blockedNetworkCalls: [...new Set(blocked)],
    unexpectedSql: [...unexpectedSql],
  };
  console.log('\n── Summary');
  console.log(`model ${meta.model} (${meta.mode}), switches ${JSON.stringify(meta.switches)}`);
  console.log(`items ${summary.items} (${summary.skipped} skipped), answers ${summary.turns}: passing ${summary.passing} (clean ${summary.clean}), failing ${summary.failing}`);
  console.log(`problems by check: ${JSON.stringify(byCheck)}`);
  console.log(`warnings by check: ${JSON.stringify(warnByCheck)}`);
  console.log(`tokens: ${summary.tokens.total} total (prompt ${summary.tokens.prompt}, cached ${summary.tokens.cached}, output ${summary.tokens.output}, thinking ${summary.tokens.thoughts}) over ${summary.modelCalls} model calls`);
  console.log(`latency per model call p50 ${summary.callLatencyMs.p50} ms, p90 ${summary.callLatencyMs.p90} ms, max ${summary.callLatencyMs.max} ms; per answer p50 ${summary.turnLatencyMs.p50} ms, p90 ${summary.turnLatencyMs.p90} ms`);
  console.log(`http: ${JSON.stringify(summary.http)}; model errors: ${summary.modelErrors}${summary.modelErrors ? ` (${summary.modelErrorSamples.join(' | ')})` : ''}`);
  console.log(`calls past the ${deadline} ms deadline: ${stalls.length} of ${calls.length}${probes.length ? `; retry probes ${probes.length}, answered inside the deadline ${summary.retryProbes.answeredInTime}, probe tokens ${summary.retryProbes.tokens}` : ''}`);
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
      const strip = (r.hourly_forecast || []).slice(0, 6).map((h) => `${h.hour}=${h.score}`).join(' ');
      console.log(`${v.key.padEnd(10)} open=${openNow(v) ? 'y' : 'n'} ${r.error ? `ERROR ${r.error}` : `score=${r.crowd_score} "${r.crowd_label}" src=${r.crowd_source}${r.crowd_method ? `/${r.crowd_method}` : ''} best="${r.best_time}" peak="${r.peak_hours}"${r.forecast_locked ? ' LOCKED' : ''}${r.clock ? ` clock=${r.clock}` : ''}${r.game_night ? ' game' : ''}`}`);
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
    switches: Object.fromEntries(['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_NO_CURVE_FALLBACK', 'BIRDIE_MODEL'].map((k) => [k, process.env[k] ?? null])),
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
