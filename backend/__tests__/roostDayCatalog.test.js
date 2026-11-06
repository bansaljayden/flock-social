// Run: node --test __tests__/roostDayCatalog.test.js  (from backend/)
//
// THE DAY A TYPED QUESTION ASKS ABOUT, CASE BY CASE (2026-11-06).
//
// Four review rounds of the weekend work on Roost (this weekend read from
// today, today's weekday from the card, closed today and closed weekends, the
// night still running in the small hours) each found new questions whose day
// came out wrong, and each fix to the day reader found more. This file holds
// every one of them, every question the weekend work put right that was wrong
// before it, and the controls the rounds used to catch an over-correction:
// 217 questions, 244 rows with the router up and down.
//
// Each case is asked through POST /api/venue/advisor/question at its own
// pinned instant (TZ=UTC; the venues below are on UTC), on its own venue,
// with the router's route as given or with the router down (the offline
// router), and with the phrasing and advice models failing, so the answer
// read is the template's or the playbook's. Each says which day the answer
// must read:
//   expect   a weekday ('Saturday'), with `date`: the answer leads with that
//              date;
//            'week': a ranking of the week, never one day's line (`lead`: the
//              date the ranking leads with; `orDay`: that day's own line is
//              right too);
//            'weekend': exactly `dates` (plus any `allowDates`), never one
//              day's line when the weekend holds more;
//            'both': every one of `dates` is in the answer (comparisons);
//            'past': says the day is past the seven days, names no day;
//            'closed': opens on the venue being shut;
//            'none': no forecast day at all (advice not about a day).
//   allowNone  advice: an answer with no forecast day is right too
//   alsoSays   a pattern the text must also hold
//
// grade() reads only the answer's sources (its dated peak facts, in the order
// it used them) and its first line, at three levels:
//   P  reads the day the case expects
//   S  names no wrong day: a ranking of the week or the weekend, a weekend
//      missing a day but holding no other, one side of a comparison, advice
//      with no day where a day was wanted
//   F  singles out a wrong day, collapses a weekend to one day, puts a day of
//      another weekend in it, refuses what it could answer, or leads with a
//      day where it must not
// Every row must be P but those in OPEN, which must hold the level given
// there or better. No answer may call another day's number today's.

process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { pinClock } = require('./helpers/pinnedClock');

process.env.JWT_SECRET = 'roost-day-catalog-test-secret';
// Set BEFORE requiring the dashboard router: it captures the key at load.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.ROOST_PLAYBOOK_FIRST;

// ── The database: one venue, scripted per case ─────────────────────────────
const pool = require('../config/database');

let profile = null;
// The corpus row and Google curve of a venue with crowd history; none for a
// venue Flock has never collected.
let mlVenueRow = null;
let baselineRows = [];
pool.query = async (sql) => {
  const q = String(sql).replace(/\s+/g, ' ');
  if (/FROM venue_profiles WHERE user_id/.test(q)) return { rows: profile ? [profile] : [], rowCount: profile ? 1 : 0 };
  if (/FROM ml_venues WHERE google_place_id/.test(q)) return { rows: mlVenueRow ? [mlVenueRow] : [], rowCount: mlVenueRow ? 1 : 0 };
  if (/FROM ml_venue_baselines/.test(q)) return { rows: baselineRows, rowCount: baselineRows.length };
  if (/roost_ai_consent_at FROM users/.test(q)) return { rows: [{ roost_ai_consent_at: '2026-10-01T00:00:00Z' }], rowCount: 1 };
  if (/INSERT INTO advisor_(?:venue_)?spend/.test(q)) return { rows: [{ tokens: 1 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};

// ── Sign-in, budgets, weather ───────────────────────────────────────────────
const authMod = require('../middleware/auth');

authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Owner', role: 'venue_owner' }; next(); };
const placesBudget = require('../utils/placesBudget');

placesBudget.allowPlacesSearch = () => true;
const weatherService = require('../services/weatherService');

weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });

// ── The forecast: the demo's card, by weekday ───────────────────────────────
const CARD = { Sat: 74, Sun: 45, Mon: 48, Tue: 48, Wed: 48, Thu: 64, Fri: 66 };
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const label = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

const mlPredictor = require('../services/mlPredictor');

mlPredictor.agreeWithStrip = async (scored) => scored;
// Each day peaks at the card's number for its weekday twice, at 8 AM and at
// 9 PM, so a venue read by day and one read on the evening each find it.
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count, day) => {
  const peak = CARD[SHORT[new Date(day).getDay()]];
  const hours = [];
  for (let i = 0; i < count; i += 1) hours.push((startHour + i) % 24);
  return hours.map((h) => ({
    hour: label(h),
    score: h === 21 || h === 8 ? peak : Math.max(1, peak - 12 - Math.min(Math.abs(21 - h), Math.abs(8 - h))),
    baselineScore: null,
    predictionMethod: 'rule_engine_no_baseline',
  }));
};
const noCurve = async () => ({ score: 40, label: 'Moderate', predictionMethod: 'rule_engine_no_baseline', modelVersion: null });
// A venue with crowd history: the night a small hour belongs to, peaking at
// 9 PM on the card's number for that night's weekday.
function ownScore(ts) {
  const d = new Date(ts);
  const h = d.getUTCHours();
  const night = new Date(d);
  if (h < 6) night.setUTCDate(night.getUTCDate() - 1);
  const top = CARD[SHORT[night.getUTCDay()]];
  const off = h >= 18 ? Math.abs(21 - h) : (h < 6 ? 3 + h : 10);
  return top - off;
}
const withCurve = async (_venue, _weather, ts) => ({ score: ownScore(ts), label: 'Moderate', predictionMethod: 'ml', modelVersion: 'test' });

// ── Google Places, for the card's one lookup ────────────────────────────────
let placeTypes = ['bar'];
let placePrimary = null;
let placePeriods = null;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    const id = decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length));
    return Promise.resolve({
      status: 200,
      json: async () => ({
        id,
        displayName: { text: 'Thistle Room' },
        rating: 4.4,
        userRatingCount: 320,
        types: placeTypes,
        ...(placePrimary ? { primaryType: placePrimary } : {}),
        location: { latitude: 39.95, longitude: -75.16 },
        currentOpeningHours: placePeriods ? { openNow: true, periods: placePeriods } : { openNow: true },
        utcOffsetMinutes: 0,
      }),
    });
  }
  return realFetch(url, opts);
};

const advisorFacts = require('../services/advisorFacts');
const advisorPhrasing = require('../services/advisorPhrasing');
const { CLASSIFIER_PROMPT } = require('../services/advisorPrompt');
const venueDashboardRouter = require('../routes/venueDashboard');
const advisorRouter = require('../routes/advisor');

// Nothing around the venue: no event or weather line stands between the
// answer and the day it reads.
advisorFacts.buildAroundYou = async () => [];

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);
app.use('/api/venue/advisor', advisorRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  global.fetch = realFetch;
  advisorPhrasing.__setGenAIForTests(null);
  server.close(resolve);
}));

// ── The models, scripted: the router answers with the case's route, or is
// down; the phrasing and advice models always fail ───────────────────────────
let route = null;
let routerDown = false;
advisorPhrasing.__setGenAIForTests({
  models: {
    generateContent: async (req) => {
      if (req.config.systemInstruction === CLASSIFIER_PROMPT) {
        if (routerDown) throw new Error('router down');
        return { text: JSON.stringify(route) };
      }
      throw new Error('no draft scripted');
    },
  },
});

// ── The venues ──────────────────────────────────────────────────────────────
//   card     no crowd history and no hours on its listing: the card's week
//   cardL    the same, listed shut Mondays, Tue-Thu 4 PM to midnight, Fri-Sat
//            4 PM to 4 AM, Sun noon to 10 PM
//   own      crowd history, its curve 6 PM to 11 PM and on to 3 AM
//   cafeSun  a cafe with no crowd history, 7 AM to 3 PM, shut Sundays
//   office   the same cafe open Monday to Friday only
const LISTED = [
  { open: { day: 0, hour: 12, minute: 0 }, close: { day: 0, hour: 22, minute: 0 } },
  { open: { day: 2, hour: 16, minute: 0 }, close: { day: 3, hour: 0, minute: 0 } },
  { open: { day: 3, hour: 16, minute: 0 }, close: { day: 4, hour: 0, minute: 0 } },
  { open: { day: 4, hour: 16, minute: 0 }, close: { day: 5, hour: 0, minute: 0 } },
  { open: { day: 5, hour: 16, minute: 0 }, close: { day: 6, hour: 4, minute: 0 } },
  { open: { day: 6, hour: 16, minute: 0 }, close: { day: 0, hour: 4, minute: 0 } },
];
function curveRows() {
  const rows = [];
  for (let day = 0; day <= 6; day += 1) {
    for (let hour = 18; hour <= 23; hour += 1) rows.push({ day_of_week: day, hour, baseline: 40 + hour, source: 'google', updated_at: '2026-10-01T00:00:00Z' });
    for (const hour of [0, 1, 2, 3]) rows.push({ day_of_week: (day + 1) % 7, hour, baseline: 60, source: 'google', updated_at: '2026-10-01T00:00:00Z' });
  }
  return rows;
}
// Each case's venue has a place id of its own, so no cache entry made at one
// pinned instant is read at another.
function setVenue(venue, key) {
  const own = venue === 'own';
  profile = {
    id: 1,
    user_id: 1,
    google_place_id: `ChIJdayCatalog${venue}${key}`,
    verified: true,
    business_name: 'Thistle Room',
    category: null,
    updated_at: '2026-10-01T00:00:00Z',
    corpus_status: own ? 'baselines' : 'absent',
    corpus_baseline_rows: own ? 168 : 0,
    corpus_checked_at: '2026-10-01T00:00:00Z',
    service_style: 'bar_standing',
    typical_spend_per_person: 28,
    kitchen_last_order: '21:30',
  };
  process.env.ADVISOR_PHRASING_ENABLED = 'true';
  advisorPhrasing.__resetAdvisorSpend();
  mlVenueRow = own ? {
    name: 'Thistle Room', latitude: 39.95, longitude: -75.16, venue_category: 'bar', google_types: ['bar'],
    price_level: 2, rating: 4.4, review_count: 320, timezone: 'UTC',
  } : null;
  baselineRows = own ? curveRows() : [];
  mlPredictor.predictBusyness = own ? withCurve : noCurve;
  placeTypes = ['bar'];
  placePrimary = null;
  placePeriods = venue === 'cardL' ? LISTED : null;
  if (venue === 'cafeSun' || venue === 'office') {
    placeTypes = ['cafe', 'food', 'store'];
    placePrimary = 'cafe';
    const days = venue === 'cafeSun' ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
    placePeriods = days.map((d) => ({ open: { day: d, hour: 7, minute: 0 }, close: { day: d, hour: 15, minute: 0 } }));
  }
}

async function ask(question) {
  const res = await fetch(`${base}/api/venue/advisor/question`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }),
  });
  return { status: res.status, body: await res.json() };
}

// ── The cases ───────────────────────────────────────────────────────────────
const CLOCKS = {
  FRI10: '2026-11-06T10:00:00Z',
  FRI13: '2026-11-06T13:00:00Z',
  FRI16: '2026-11-06T16:00:00Z',
  SAT0030: '2026-11-07T00:30:00Z',
  SAT0330: '2026-11-07T03:30:00Z',
  SAT16: '2026-11-07T16:00:00Z',
  SUN0030: '2026-11-08T00:30:00Z',
  SUN16: '2026-11-08T16:00:00Z',
  SUN20: '2026-11-08T20:00:00Z',
  MON0030: '2026-11-09T00:30:00Z',
  MON16: '2026-11-09T16:00:00Z',
  TUE16: '2026-11-10T16:00:00Z',
  WED15: '2026-11-11T15:00:00Z',
  WED16: '2026-11-11T16:00:00Z',
  THU16: '2026-11-12T16:00:00Z',
  SAT1121: '2026-11-21T16:00:00Z',
  SUN1122: '2026-11-22T16:00:00Z',
};
// Fri 11-06 to Wed 11-18; Thanksgiving is Thu 11-26 and Black Friday 11-27.
const G = (intentId) => ({ mode: 'grounded', intentId });
const A = (intentId = null) => ({ mode: 'advice', intentId });

// [id, question, route, clock, venue, expect, extra]
const CASES = [
  // ── 1. TODAY'S WORDS BESIDE ANOTHER DAY OR THE WEEK ─────────────────────────
  [101, 'Will tomorrow be busier than tonight?', G('peak_hours'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07', routers: ['model', 'offline'] }],
  [102, 'Is tomorrow going to be busier than today?', G('peak_hours'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07' }],
  [103, 'How busy will tomorrow be compared to tonight?', G('peak_hours'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07' }],
  [104, 'Will tomorrow be busier than tonight?', G('peak_hours'), 'FRI16', 'own', 'Saturday', { date: '2026-11-07' }],
  [105, 'How does the rest of the week look after today?', G('peak_hours'), 'FRI16', 'card', 'week', { lead: '2026-11-07' }],
  [106, 'Besides tonight, which day is busiest this week?', G('peak_hours'), 'FRI16', 'card', 'week', { lead: '2026-11-07' }],
  [107, 'Besides tonight, which day is busiest this week?', G('peak_hours'), 'FRI16', 'own', 'week', { lead: '2026-11-07' }],
  [108, 'Other than today, which nights are quiet?', G('quiet_nights'), 'FRI16', 'card', 'week', { lead: '2026-11-08' }],
  [109, 'Which day is busiest this week, starting today?', G('peak_hours'), 'FRI16', 'card', 'week', { lead: '2026-11-07' }],
  [110, 'Which day will be busiest this week? Tonight looks slow.', G('peak_hours'), 'FRI16', 'card', 'week', { lead: '2026-11-07' }],
  [111, 'Which nights are quiet this week? We\'re dead tonight.', G('quiet_nights'), 'FRI16', 'card', 'week', { lead: '2026-11-08' }],
  [112, 'What are the slowest days this week, including today?', G('quiet_nights'), 'FRI16', 'card', 'week', { lead: '2026-11-08' }],
  [113, 'Besides tonight, which nights this week will be slow?', G('quiet_nights'), 'FRI16', 'card', 'week', { lead: '2026-11-08' }],
  [114, 'We were slow today, how do I fill tomorrow?', A('quiet_nights'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07', allowNone: true }],
  [115, 'We were slow today, how do I fill tomorrow?', A('peak_hours'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07', allowNone: true }],
  [116, 'We were slow today, how do I fill tomorrow?', A('quiet_nights'), 'FRI16', 'own', 'Saturday', { date: '2026-11-07', allowNone: true }],
  [117, 'How should I staff this week? We\'re short tonight', A('peak_hours'), 'FRI16', 'card', 'week', { allowNone: true }],
  [118, 'How do I fill the slow nights this week, starting tonight?', A('quiet_nights'), 'FRI16', 'card', 'week', { lead: '2026-11-08', allowNone: true }],

  // ── 2. A WEEKDAY ON THE WEEKEND'S ROUTE, AND THE SMALL HOURS ────────────────
  [201, 'How busy will Friday be?', G('weekend_outlook'), 'SAT16', 'card', 'Friday', { date: '2026-11-13' }],
  [202, 'How busy will Friday be?', G('weekend_outlook'), 'SAT16', 'own', 'Friday', { date: '2026-11-13' }],
  [203, 'How busy will Friday be?', G('weekend_outlook'), 'SUN16', 'card', 'Friday', { date: '2026-11-13' }],
  [204, 'How busy will Friday be?', G('weekend_outlook'), 'SUN16', 'own', 'Friday', { date: '2026-11-13' }],
  [205, 'How busy will Saturday be?', G('weekend_outlook'), 'SUN16', 'card', 'Saturday', { date: '2026-11-14' }],
  [206, 'How busy will Saturday be?', G('weekend_outlook'), 'SUN16', 'own', 'Saturday', { date: '2026-11-14' }],
  [207, 'How busy will next Saturday be?', G('weekend_outlook'), 'SAT16', 'card', 'past', { note: 'next Saturday on a Saturday is Nov 14, today+7' }],
  [208, 'How busy will next Saturday be?', G('weekend_outlook'), 'SAT16', 'own', 'past'],
  [211, 'How busy will next Saturday be?', G('weekend_outlook'), 'SUN0030', 'own', 'Saturday', { date: '2026-11-14' }],
  [212, 'How busy will Saturday be?', G('weekend_outlook'), 'SUN0030', 'own', 'Saturday', { date: '2026-11-14', note: 'Saturday night is still running at 12:30 AM; the coming Saturday is the answer, as before' }],
  [213, 'How busy will Friday be?', G('weekend_outlook'), 'SAT0030', 'own', 'Friday', { date: '2026-11-13' }],
  [214, 'How busy will this weekend be?', G('weekend_outlook'), 'MON0030', 'own', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'], note: 'a Sunday night still running ends the weekend: at 12:30 AM on a Monday this weekend is the coming one' }],
  [215, 'How busy will Sunday be?', G('weekend_outlook'), 'MON0030', 'own', 'Sunday', { date: '2026-11-15' }],
  [216, 'How busy will Saturday be?', G('weekend_outlook'), 'MON0030', 'own', 'Saturday', { date: '2026-11-14' }],
  [217, 'How busy will next Saturday be?', G('weekend_outlook'), 'MON0030', 'own', 'Saturday', { date: '2026-11-14' }],
  [221, 'How busy will Saturday be? It\'s Thanksgiving weekend.', G('weekend_outlook'), 'SUN1122', 'card', 'Saturday', { date: '2026-11-28' }],
  [222, 'How busy will Saturday be? It\'s Thanksgiving weekend.', G('weekend_outlook'), 'SUN1122', 'own', 'Saturday', { date: '2026-11-28' }],
  [223, 'How busy will Friday be? It\'s Black Friday weekend.', G('weekend_outlook'), 'SAT1121', 'card', 'Friday', { date: '2026-11-27' }],
  [224, 'Long weekend coming up. How busy will Saturday be?', G('weekend_outlook'), 'SUN1122', 'card', 'Saturday', { date: '2026-11-28' }],
  [225, 'Weekends are our bread and butter. What does Saturday look like?', G('weekend_outlook'), 'SUN1122', 'card', 'Saturday', { date: '2026-11-28' }],
  [226, 'Will Saturday be busy? Big weekend for us.', G('weekend_outlook'), 'SUN16', 'card', 'Saturday', { date: '2026-11-14' }],

  // ── 3. TWO DAYS COMPARED ────────────────────────────────────────────────────
  [301, 'How busy will Saturday be compared to Friday?', G('peak_hours'), 'FRI16', 'card', 'both', { dates: ['2026-11-06', '2026-11-07'] }],
  [302, 'Is Saturday busier than Friday?', G('peak_hours'), 'FRI16', 'card', 'both', { dates: ['2026-11-06', '2026-11-07'], routers: ['model', 'offline'] }],
  [303, 'Is Thursday busier than Friday?', G('peak_hours'), 'FRI16', 'card', 'both', { dates: ['2026-11-06', '2026-11-12'] }],
  [304, 'Which is busier, Saturday or Sunday?', G('peak_hours'), 'SUN20', 'card', 'both', { dates: ['2026-11-08', '2026-11-14'], routers: ['model', 'offline'] }],
  [305, 'Is Sunday or Saturday busier?', G('peak_hours'), 'SAT16', 'card', 'both', { dates: ['2026-11-07', '2026-11-08'] }],
  [306, 'Fri or Sat?', G('peak_hours'), 'SAT16', 'card', 'both', { dates: ['2026-11-07', '2026-11-13'] }],
  [307, 'How do I fill tuesdays when saturdays are packed?', A('quiet_nights'), 'SAT16', 'card', 'Tuesday', { date: '2026-11-10', allowNone: true, note: 'the day to fill is the subject of fill, not the day in the when-clause' }],
  [308, 'Will tonight be busier than Saturday?', G('peak_hours'), 'WED15', 'card', 'both', { dates: ['2026-11-11', '2026-11-14'] }],

  // ── 4. THE QUIET DAYS, AND TODAY SHUT, ASKED BY NAME ────────────────────────
  [401, 'Is tonight going to be quiet?', G('quiet_nights'), 'FRI16', 'own', 'Friday', { date: '2026-11-06' }],
  [402, 'How quiet will Friday be?', G('quiet_nights'), 'WED16', 'card', 'Friday', { date: '2026-11-13' }],
  [403, 'Is Saturday going to be slow?', G('quiet_nights'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07' }],
  [404, 'Is tomorrow going to be slow?', G('quiet_nights'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07' }],
  [405, 'How busy will Sunday be?', G('peak_hours'), 'SUN16', 'cafeSun', 'closed'],
  [406, 'How busy will we be tonight?', G('peak_hours'), 'SUN16', 'cafeSun', 'closed'],
  [407, 'Is tonight going to be slow?', G('quiet_nights'), 'SUN16', 'cafeSun', 'closed'],

  // ── 5. A DATE, A NAME OR NEXT WEEKEND BESIDE A WEEKDAY ──────────────────────
  [501, 'How busy will Saturday be next weekend?', G('peak_hours'), 'FRI16', 'card', 'past', { note: 'next weekend on a Friday is Nov 13-15; Saturday Nov 14 is today+8' }],
  [502, 'How busy will Saturday of next weekend be?', G('peak_hours'), 'FRI16', 'card', 'past'],
  [503, 'How busy will Saturday be next weekend?', G('peak_hours'), 'SAT16', 'own', 'past'],
  [504, 'How busy will Saturday be next weekend?', G('peak_hours'), 'TUE16', 'card', 'Saturday', { date: '2026-11-14' }],
  [505, 'How busy will Sat Nov 21 be?', G('peak_hours'), 'MON16', 'card', 'past'],
  [506, 'How busy will Saturday the 21st be?', G('peak_hours'), 'MON16', 'card', 'past'],
  [507, 'How busy will Black Friday be?', G('peak_hours'), 'MON16', 'card', 'past', { note: 'Black Friday 2026 is Nov 27' }],
  [508, 'How busy will Black Friday be?', G('peak_hours'), 'FRI16', 'card', 'past'],
  [509, 'Ruby Tuesday next door is closing, how busy will we be tonight?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],

  // ── 6. TOMORROW IN PASSING, THE DAY AFTER, HABITS, LATER TODAY ──────────────
  [601, 'After tonight\'s rush, will it stay busy?', G('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06' }],
  [602, 'after tonight\'s rush, how should I prep for tomorrow?', A('peak_hours'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07', allowNone: true }],
  [603, 'How busy will tonight be? I\'m off tomorrow.', G('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06', routers: ['model', 'offline'] }],
  [604, 'How busy will tonight be? I\'m off tomorrow.', G('peak_hours'), 'FRI16', 'own', 'Friday', { date: '2026-11-06' }],
  [605, 'Should I staff up tonight ahead of tomorrow’s game?', G('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06', routers: ['model', 'offline'] }],
  [606, 'Should I staff up tonight ahead of tomorrow\'s game?', A('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06', allowNone: true }],
  [607, 'Is tonight going to be slow? Thinking of closing early to prep for tomorrow.', G('quiet_nights'), 'FRI16', 'card', 'Friday', { date: '2026-11-06', routers: ['model', 'offline'] }],
  [608, 'How busy will the day after tomorrow be?', G('peak_hours'), 'FRI16', 'card', 'Sunday', { date: '2026-11-08', routers: ['model', 'offline'] }],
  [609, 'How busy will the day after tomorrow be?', G('peak_hours'), 'FRI16', 'own', 'Sunday', { date: '2026-11-08' }],
  [610, 'How do I fill the day after tomorrow?', A('quiet_nights'), 'FRI16', 'card', 'Sunday', { date: '2026-11-08', allowNone: true }],
  [611, 'How should I staff tonight? We get slammed each night at 9.', G('peak_hours'), 'SUN16', 'card', 'Sunday', { date: '2026-11-08', routers: ['model', 'offline'] }],
  [612, 'How should I staff tonight? We get slammed each night at 9.', G('peak_hours'), 'SUN16', 'own', 'Sunday', { date: '2026-11-08' }],
  [613, 'We\'ve been dead every night this week, will tonight pick up?', G('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06' }],
  [614, 'How busy will tonight be? The whole week has been slow.', G('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06' }],
  [615, 'Every day this week has been slow. Is tonight going to be quiet too?', G('quiet_nights'), 'FRI16', 'card', 'Friday', { date: '2026-11-06' }],
  [616, 'Will it get busier after this afternoon?', G('peak_hours'), 'FRI13', 'card', 'Friday', { date: '2026-11-06' }],
  [617, 'Will it pick up after this morning?', G('peak_hours'), 'FRI10', 'own', 'Friday', { date: '2026-11-06' }],
  [618, 'Is tomorrow night going to be dead?', G('tonight_outlook'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07' }],
  [619, 'How busy will tomorrow be?', G('tonight_outlook'), 'FRI16', 'card', 'Saturday', { date: '2026-11-07' }],
  [620, 'Is tonight the busiest night this week?', G('peak_hours'), 'SAT16', 'card', 'week', { lead: '2026-11-07', orDay: true, routers: ['model', 'offline'], note: 'today (74) is the week\'s high; a card\'s week starts tomorrow, so the week without today leads with Friday (66)' }],
  [621, 'Which day is busiest this week, including today?', G('peak_hours'), 'SAT16', 'card', 'week', { lead: '2026-11-07' }],
  [622, 'What are the slowest days this week, including today?', G('quiet_nights'), 'SUN16', 'card', 'week', { lead: '2026-11-08' }],
  [623, 'Is tonight the quietest night this week?', G('quiet_nights'), 'SUN16', 'card', 'week', { lead: '2026-11-08', orDay: true, routers: ['model', 'offline'] }],
  [631, 'Thursday was slow, will this weekend be better?', G('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'] }],
  [632, 'We\'re closed Mondays, how busy will this weekend be?', G('weekend_outlook'), 'MON16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'] }],
  [633, 'We\'re closed Mondays, how busy will this weekend be?', G('weekend_outlook'), 'WED16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'] }],
  [634, 'Will this weekend be busier than Thursday?', G('weekend_outlook'), 'WED16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'], routers: ['model', 'offline'] }],
  [635, 'Our Tuesday trivia is packed, how does this weekend look?', G('weekend_outlook'), 'TUE16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'] }],
  [636, 'Friday was great, how does the rest of this weekend look?', G('weekend_outlook'), 'SAT16', 'card', 'weekend', { dates: ['2026-11-07', '2026-11-08'] }],
  [637, 'Saturday was packed, how is the rest of the weekend looking?', G('weekend_outlook'), 'SUN16', 'card', 'weekend', { dates: ['2026-11-08'] }],
  [638, 'We have a wedding next Saturday, so how does the rest of this weekend look?', G('weekend_outlook'), 'SAT16', 'card', 'weekend', { dates: ['2026-11-07', '2026-11-08'], routers: ['model', 'offline'] }],
  [639, 'We were slow on Tuesday, what does the weekend look like?', G('weekend_outlook'), 'WED16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'], routers: ['model', 'offline'] }],
  [640, 'Monday Night Football was huge, how does the rest of this weekend look?', G('weekend_outlook'), 'SAT16', 'card', 'weekend', { dates: ['2026-11-07', '2026-11-08'] }],
  [641, 'How busy will Ruby Tuesday be this weekend?', G('weekend_outlook'), 'THU16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'] }],
  [642, 'How\'s the rest of the weekend after Saturday\'s rush?', G('weekend_outlook'), 'SUN16', 'card', 'weekend', { dates: ['2026-11-08'], routers: ['model', 'offline'] }],
  [643, 'We run trivia on Wednesdays. How busy will this weekend be?', G('weekend_outlook'), 'MON16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'], routers: ['model', 'offline'] }],
  [644, 'We were slow on Tuesday, how do I make the most of this weekend?', A('weekend_outlook'), 'WED16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'], allowNone: true }],

  // ── 7. "SAT" AND "SUN" AS WORDS ─────────────────────────────────────────────
  [701, 'we sat 40 covers last night, how do I get more tonight?', A('tonight_outlook'), 'WED15', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [702, 'we sat 40 covers last night, how do I get more tonight?', A('tonight_outlook'), 'WED15', 'own', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [703, 'sat 4 tables by 7, should I call in another server tonight?', A('tonight_outlook'), 'WED15', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [704, 'we sat 30 for lunch, how should I staff dinner tonight?', A('tonight_outlook'), 'WED15', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [705, 'Tickets sat 20 minutes in the window tonight, how do I fix the line?', A('kitchen_vs_peak'), 'WED15', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [706, 'Guests sat 3 hrs on one drink, how do I turn tables tonight?', A('tables_service'), 'WED15', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [707, 'we sat 45 covers. is this weekend going to be better?', G('weekend_outlook'), 'WED15', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'], routers: ['model', 'offline'] }],
  [708, 'We sat 12 tables last night. How does this weekend look?', G('weekend_outlook'), 'WED15', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'] }],
  [709, 'we only sat 9 tables, which nights are quiet this week?', G('quiet_nights'), 'SAT0330', 'card', 'week', { lead: '2026-11-08', routers: ['model', 'offline'] }],
  [710, 'We sat 20 people for brunch today, how do I fill tomorrow?', A('quiet_nights'), 'WED15', 'card', 'Thursday', { date: '2026-11-12', allowNone: true }],
  [711, 'We sat 20 people for brunch today, how do I fill tomorrow?', A('quiet_nights'), 'SUN20', 'card', 'Monday', { date: '2026-11-09', allowNone: true }],
  [712, 'We only sat 12 tables tonight. How busy will tomorrow be?', G('peak_hours'), 'WED15', 'card', 'Thursday', { date: '2026-11-12' }],
  [713, 'We only sat 15 covers yesterday, how do I fill the slow nights this week?', A('quiet_nights'), 'WED16', 'card', 'week', { lead: '2026-11-15', allowNone: true }],
  [714, 'We sat 12 tables by 8 last night, how busy will tonight be?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [715, 'We sat 40 covers last night, how does the rest of the week look?', G('peak_hours'), 'WED16', 'card', 'week', { lead: '2026-11-14' }],
  [716, 'We sat dinner at 6 and then it died. How busy will tonight be?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [717, 'the sun rush on the patio was nice, how busy will tonight be?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [718, 'We sat 2nd seating at 8:30, how should I staff tonight?', A('tonight_outlook'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [719, 'sat 1st turn by 6:30, how busy will tonight be?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [720, 'we sat 2 tops all night, how do I fill the weekend?', A('weekend_outlook'), 'WED15', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'], allowNone: true }],
  [721, 'We sat 22 covers last night. What\'s tonight looking like?', G('tonight_outlook'), 'WED15', 'card', 'Wednesday', { date: '2026-11-11' }],
  [722, 'Our host sat 2 parties at once, how busy will tonight be?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [723, 'We got sun 10 minutes ago, how busy will the patio be tonight?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [724, 'We sat 30 by 7, so how should I staff tomorrow?', A('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12', allowNone: true }],

  // ── 8. TOMORROW AS A REASON, A CONDITION OR "WHETHER"; NO QUESTION MARK ─────
  [801, 'How busy will tonight be since tomorrow is a holiday?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11', routers: ['model', 'offline'] }],
  [802, 'How busy will tonight be if it rains tomorrow?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [803, 'Should I expect a crowd tonight since we\'re closed tomorrow?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [804, 'We\'re closed tomorrow. How busy will tonight be', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11', routers: ['model', 'offline'] }],
  [805, 'It\'s been slow this week. How busy will tonight be', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [806, 'How should I staff tonight since we\'re closed tomorrow?', A('tonight_outlook'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [807, 'How many staff do I need tonight if tomorrow is slow?', A('tonight_outlook'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [808, 'Tonight was dead so I\'m wondering if tomorrow will pick up', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12', routers: ['model', 'offline'] }],
  [809, 'Tonight was dead so I\'m wondering if tomorrow will pick up', G('peak_hours'), 'WED16', 'own', 'Thursday', { date: '2026-11-12' }],
  [810, 'tonight is slow, let me know if tomorrow will be busy', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [811, 'Not sure if tomorrow will be busy, tonight was dead', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [812, 'Tonight was rough, need to know if tomorrow will be slammed', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [813, 'Slow tonight. Not sure if tomorrow will be any better.', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [814, 'Tonight was slow. Wondering if tomorrow will be better', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [815, 'Tonight was slow, wondering if I should add staff tomorrow', A('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12', allowNone: true }],
  [816, 'What a dead night tonight. Tomorrow gonna be any better', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [817, 'tonight was quiet, can you check if tomorrow looks busier', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [818, 'We\'re dead tonight, trying to figure out if tomorrow is worth opening early', A('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12', allowNone: true }],
  [819, 'Tonight was dead so I\'m wondering if tomorrow will pick up', G('quiet_nights'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [820, 'How do I fill tomorrow since tonight was dead?', A('quiet_nights'), 'WED16', 'card', 'Thursday', { date: '2026-11-12', allowNone: true }],
  [821, 'How busy will tomorrow be if it rains?', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [822, 'Tonight is slow, any idea if tomorrow will be busier', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [823, 'wondering if tomorrow will pick up', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [824, 'Should I close early tonight if tomorrow is a holiday?', A('tonight_outlook'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11', allowNone: true }],
  [825, 'Tonight we have a band. what should I expect', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [826, 'What a slow week. Which day this week will be busiest', G('peak_hours'), 'WED16', 'card', 'week', { lead: '2026-11-14' }],
  [827, 'Is it me or is this week dead. tonight gonna be any better', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],

  // ── 9. THE WEEKEND COLLAPSED TO ONE DAY, AND THIS BESIDE NEXT WEEKEND ───────
  [901, 'Happy Friday! How busy will this weekend be?', G('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'], routers: ['model', 'offline'] }],
  [902, 'It\'s Friday, how\'s the weekend looking?', G('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'] }],
  [903, 'Friday already. Is the weekend going to be busy?', G('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'] }],
  [904, 'Friday lunch was dead. How does the rest of the weekend look?', G('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'], note: 'the rest of the weekend from Friday afternoon still holds Friday night' }],
  [905, 'TGIF! What does the weekend look like for us?', G('weekend_outlook'), 'FRI16', 'cardL', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'] }],
  [906, 'It\'s Friday and we\'re short a cook. How should I staff the weekend?', A('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'], allowNone: true }],
  [907, 'Happy Friday! How busy will this weekend be?', G('weekend_outlook'), 'FRI10', 'own', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'] }],
  [911, 'how does this weekend compare to next weekend?', G('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'] }],
  [912, 'how does this weekend compare to next weekend?', G('weekend_outlook'), 'FRI16', 'own', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'] }],
  [913, 'Is next weekend going to be busier than this weekend?', G('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'] }],
  [914, 'how busy will this weekend be compared to next weekend', G('weekend_outlook'), 'SAT0330', 'card', 'weekend', { dates: ['2026-11-07', '2026-11-08'], allowDates: ['2026-11-13'], note: 'next Friday may be added; this weekend may not be dropped' }],

  // ── 10. WHAT THE WEEKEND WORK PUT RIGHT ─────────────────────────────────────
  [1001, 'How does this weekend look?', G('weekend_outlook'), 'FRI16', 'card', 'weekend', { dates: ['2026-11-06', '2026-11-07', '2026-11-08'], routers: ['model', 'offline'] }],
  [1002, 'How does this weekend look?', G('weekend_outlook'), 'SAT16', 'card', 'weekend', { dates: ['2026-11-07', '2026-11-08'] }],
  [1003, 'How does this weekend look?', G('weekend_outlook'), 'SUN16', 'card', 'weekend', { dates: ['2026-11-08'] }],
  [1004, 'How does this weekend look?', G('weekend_outlook'), 'SAT16', 'own', 'weekend', { dates: ['2026-11-07', '2026-11-08'] }],
  [1005, 'How does this weekend look?', G('weekend_outlook'), 'SUN16', 'own', 'weekend', { dates: ['2026-11-08'] }],
  [1006, 'whats the busiest day this weekend', G('weekend_outlook'), 'SAT16', 'card', 'weekend', { dates: ['2026-11-07', '2026-11-08'] }],
  [1007, 'What does next weekend look like?', G('weekend_outlook'), 'FRI16', 'card', 'past'],
  [1008, 'What does next weekend look like?', G('weekend_outlook'), 'SAT16', 'card', 'weekend', { dates: ['2026-11-13'], alsoSays: /past the seven days/i }],
  [1009, 'What does next weekend look like?', G('weekend_outlook'), 'SUN16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14'], alsoSays: /past the seven days/i }],
  [1010, 'What does next weekend look like?', G('weekend_outlook'), 'WED16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'] }],
  [1011, 'How does the weekend after next look?', G('weekend_outlook'), 'WED16', 'card', 'past'],
  [1012, 'what about the following weekend', G('weekend_outlook'), 'WED16', 'card', 'past'],
  [1013, 'How busy will Friday be?', G('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06', routers: ['model', 'offline'] }],
  [1014, 'How busy will Wednesday be?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [1015, 'How do I fill a slow Monday?', A('quiet_nights'), 'MON16', 'card', 'Monday', { date: '2026-11-09', note: 'it led with no number at all until 2026-11-06' }],
  [1016, 'How busy will we be tonight?', G('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06' }],
  [1017, 'Is tonight going to be slow?', G('quiet_nights'), 'FRI16', 'card', 'Friday', { date: '2026-11-06' }],
  [1018, 'How busy will tonight be?', G('peak_hours'), 'SAT0030', 'own', 'Friday', { date: '2026-11-06', note: 'Friday night is still running at 00:30 for a bar open to 3 AM' }],
  [1019, 'How busy will Sat be?', G('peak_hours'), 'WED16', 'card', 'Saturday', { date: '2026-11-14', routers: ['model', 'offline'] }],
  [1020, 'fri night busy?', G('peak_hours'), 'WED16', 'card', 'Friday', { date: '2026-11-13' }],
  [1021, 'Sun brunch, how busy will it be?', G('peak_hours'), 'WED16', 'card', 'Sunday', { date: '2026-11-15' }],
  [1022, 'next sat busy?', G('peak_hours'), 'WED15', 'card', 'Saturday', { date: '2026-11-14' }],
  [1023, 'is Tues slow', G('quiet_nights'), 'WED16', 'card', 'Tuesday', { date: '2026-11-17' }],
  [1024, 'Sun?', G('peak_hours'), 'WED15', 'card', 'Sunday', { date: '2026-11-15' }],
  [1025, 'how about sun', G('peak_hours'), 'WED15', 'card', 'Sunday', { date: '2026-11-15', note: 'lower-case sun at the end with no day word around it' }],
  [1026, 'How busy will next Monday be?', G('peak_hours'), 'MON16', 'card', 'past'],
  [1027, 'How busy will Friday be next week?', G('peak_hours'), 'MON16', 'card', 'past', { note: 'the week after this one runs from Mon 11-16; its Friday is 11-20' }],
  [1028, 'How busy will the Friday after next be?', G('peak_hours'), 'MON16', 'card', 'past'],
  [1029, 'How busy will tomorrow be?', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12', routers: ['model', 'offline'] }],
  [1030, 'how busy tmrw', G('peak_hours'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [1031, 'How busy will the day after tomorrow be?', G('peak_hours'), 'WED16', 'card', 'Friday', { date: '2026-11-13' }],
  [1032, 'How does today look?', G('tonight_outlook'), 'SUN16', 'cafeSun', 'closed'],
  [1033, 'How does this weekend look?', G('weekend_outlook'), 'SAT16', 'office', 'closed'],
  [1034, 'How busy will Saturday be?', G('peak_hours'), 'SAT16', 'card', 'Saturday', { date: '2026-11-07' }],
  [1035, 'How busy will Sunday be?', G('peak_hours'), 'SUN16', 'card', 'Sunday', { date: '2026-11-08' }],
  [1036, 'How busy will next Saturday be?', G('peak_hours'), 'SAT16', 'card', 'past'],
  [1037, 'monday night football tonight, how busy?', G('tonight_outlook'), 'MON16', 'card', 'Monday', { date: '2026-11-09' }],
  [1038, 'is sunday funday gonna be busy', G('peak_hours'), 'FRI16', 'card', 'Sunday', { date: '2026-11-08' }],
  [1039, 'how busy will friday\'s happy hour be', G('peak_hours'), 'FRI16', 'card', 'Friday', { date: '2026-11-06' }],
  [1040, 'Sunday Funday is this weekend, how busy will it be?', G('weekend_outlook'), 'FRI16', 'card', 'Sunday', { date: '2026-11-08', note: '"it" is Sunday Funday' }],

  // ── 11. CONTROLS ────────────────────────────────────────────────────────────
  [1101, 'My bartender quit this morning, what do I do?', A('tonight_outlook'), 'FRI16', 'card', 'none'],
  [1102, 'Got a 1 star review today, how should I respond?', A('tonight_outlook'), 'FRI16', 'card', 'none'],
  [1103, 'How busy will Friday be?', G('peak_hours'), 'WED16', 'card', 'Friday', { date: '2026-11-13', routers: ['model', 'offline'] }],
  [1104, 'How do I fill Thursdays?', A('quiet_nights'), 'WED16', 'card', 'Thursday', { date: '2026-11-12' }],
  [1105, 'Saturdays are packed, how do I fill Tuesdays?', A('quiet_nights'), 'WED16', 'card', 'Tuesday', { date: '2026-11-17' }],
  [1106, 'How busy will tonight be?', G('tonight_outlook'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [1107, 'when are we busiest this week', G('peak_hours'), 'WED16', 'card', 'week', { lead: '2026-11-14' }],
  [1108, 'which nights are quiet', G('quiet_nights'), 'WED16', 'card', 'week', { lead: '2026-11-15' }],
  [1109, 'Sun Devils game tonight, how busy will we be?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [1110, 'We sat down to plan the week. When are we busiest?', G('peak_hours'), 'WED16', 'card', 'week', { lead: '2026-11-14' }],
  [1111, 'We\'re open Mon-Fri, how busy will Wed be?', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
  [1112, 'how busy will this weekend be', G('weekend_outlook'), 'WED16', 'card', 'weekend', { dates: ['2026-11-13', '2026-11-14', '2026-11-15'], routers: ['model', 'offline'] }],
  [1113, 'How busy will next Saturday be?', G('peak_hours'), 'MON16', 'card', 'Saturday', { date: '2026-11-14' }],
  [1114, 'How busy will Friday be compared to next week?', G('peak_hours'), 'MON16', 'card', 'Friday', { date: '2026-11-13' }],
  [1115, 'what time does the rush start today', G('peak_hours'), 'WED16', 'card', 'Wednesday', { date: '2026-11-11' }],
];

// ── Grading ─────────────────────────────────────────────────────────────────
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PEAK_ID = /^(?:typical_)?peak_(\d{4}-\d{2}-\d{2})$/;
const KIND_OPEN = /^In Flock's forecast for places like yours, /;
// One day's own line: "Friday peaks around 9 PM", "Saturday night projects
// busiest around midnight", "next Friday peaks", "today peaks", "Saturday of
// the coming weekend, Nov 13 to 15, peaks".
const DAY_LINE = new RegExp(`^(?:next )?(?:${WEEKDAYS.join('|')}|today|tonight)(?: night)?(?: of the coming weekend, [^,]+,)? (?:peaks|projects busiest)\\b`, 'i');
// A ranking: "the busiest day this week is", "the quietest day this weekend
// is", "the busiest day of the coming weekend", "No day stands out", and the
// advice lead "Saturday projects as the busiest day this week".
const RANKING = /\b(?:busiest|quietest|slowest) day (?:of )?(?:this|the coming|next) week(?:end)?\b|No day stands out|projects as (?:the|your) (?:busiest|quietest) day\b/i;
const PAST = /past the seven days/i;
const RANK = { F: 0, S: 1, P: 2 };
const uniq = (xs) => [...new Set(xs)];
const datesOf = (answer) => answer.sources.map((s) => (PEAK_ID.exec(String(s)) || [])[1]).filter(Boolean);

/** Grade one answer ({ mode, text, sources: [id] }) against case `c`: { level, why }. */
function grade(c, answer) {
  const text = String(answer.text || '');
  const first = text.split('\n')[0].replace(KIND_OPEN, '');
  const dates = datesOf(answer);
  const got = uniq(dates);
  const refused = answer.mode === 'refusal';
  const dayLine = DAY_LINE.test(first);
  const ranking = RANKING.test(first);
  const out = (level, why) => ({ level, why });
  const noDay = () => {
    if (c.allowNone) return out('P', 'no day (allowed)');
    return refused ? out('F', 'refused') : out('S', 'no day');
  };
  if (WEEKDAYS.includes(c.expect)) {
    if (!dates.length) return noDay();
    if (dates[0] === c.date) return out('P', `led ${dates[0]}`);
    return ranking && !dayLine ? out('S', `ranking led ${dates[0]}, wanted ${c.date}`) : out('F', `led ${dates[0]}, wanted ${c.date}`);
  }
  switch (c.expect) {
    case 'week': {
      if (!dates.length) return noDay();
      if (dayLine) {
        if (c.lead && dates[0] === c.lead) return c.orDay ? out('P', `day line ${dates[0]}`) : out('S', `day line ${dates[0]}, no ranking`);
        return out('F', `one day's line (${dates[0]})`);
      }
      if (ranking || got.length >= 3) {
        return c.lead && dates[0] !== c.lead ? out('F', `ranking led ${dates[0]}, wanted ${c.lead}`) : out('P', `week led ${dates[0]}`);
      }
      return out('S', `no ranking (${got.join(',')})`);
    }
    case 'weekend': {
      if (!got.length) return noDay();
      const missing = c.dates.filter((d) => !got.includes(d));
      const extra = got.filter((d) => !c.dates.includes(d) && !(c.allowDates || []).includes(d));
      const said = `weekend ${got.join(',')}${missing.length ? ` missing ${missing.join(',')}` : ''}${extra.length ? ` extra ${extra.join(',')}` : ''}`;
      if (extra.length) return out('F', said);
      if (missing.length) return dayLine && got.length === 1 && c.dates.length > 1 ? out('F', `${said} (one day)`) : out('S', said);
      if (c.alsoSays && !c.alsoSays.test(text)) return out('S', `${said}; does not say ${c.alsoSays}`);
      return out('P', said);
    }
    case 'both': {
      const missing = c.dates.filter((d) => !got.includes(d));
      if (!missing.length) return out('P', `both ${c.dates.join(',')}`);
      return missing.length < c.dates.length ? out('S', `one side; missing ${missing.join(',')}`) : out('F', `neither; has ${got.join(',') || 'no day'}`);
    }
    case 'past':
      if (dates.length) return out('F', `answered ${dates[0]}`);
      if (PAST.test(text)) return out('P', 'past the forecast');
      return out('S', refused ? 'refused, not as past' : 'no day, not said past');
    case 'closed':
      if (/\bclosed\b/i.test(first)) return out('P', 'closed');
      if (refused) return out('F', 'refused, not as closed');
      if (!dates.length) return out('S', 'no closed line');
      return ranking && !dayLine ? out('S', `ranking ${dates[0]}, not closed`) : out('F', `answered ${dates[0]}`);
    case 'none':
      return dates.length ? out('F', `led ${dates[0]}`) : out('P', 'no day');
    default:
      return out('F', `unknown expect ${c.expect}`);
  }
}

// An answer that opens on "today peaks" or "tonight projects busiest" must
// lead with today's own number: the night in progress, in the small hours,
// or the calendar's today. The grading above reads dates, not this label.
const TODAY_LINE = /^(?:today|tonight)(?: night)? (?:peaks|projects)/i;
function todayOverAnotherDay(at, answer) {
  const first = String(answer.text || '').split('\n')[0].replace(KIND_OPEN, '');
  if (!TODAY_LINE.test(first)) return null;
  const [date] = datesOf(answer);
  if (!date) return null;
  const day = (back) => new Date(Date.parse(at) - back * 86400000).toISOString().slice(0, 10);
  const today = [day(0), ...(new Date(at).getUTCHours() < 6 ? [day(1)] : [])];
  return today.includes(date) ? null : date;
}

// The rows not yet read right, each with the level it must hold or better.
// Every other row must read its day (P).
const OPEN = {
  // A date or a holiday beside a weekday ("Sat Nov 21", "Saturday the 21st",
  // "Black Friday") is answered as the coming weekday.
  '505/model': 'F', '506/model': 'F', '507/model': 'F', '508/model': 'F',
  // Tomorrow after "if", which can mean "whether", is answered with both days.
  '802/model': 'S', '810/model': 'S',
  // A day given as the reason, or said in the past, is answered with both.
  '801/model': 'S', '801/offline': 'S', '803/model': 'S', '808/model': 'S', '808/offline': 'S',
  '809/model': 'S', '811/model': 'S', '812/model': 'S', '819/model': 'S',
  // No short form is read as a day: the week is ranked.
  '306/model': 'S', '1019/offline': 'S', '1020/model': 'S', '1021/model': 'S', '1023/model': 'S',
  '1024/model': 'S', '1025/model': 'S', '1111/model': 'S',
};

const ROWS = CASES.map(([id, q, route, clock, venue, expect, extra = {}]) => ({
  id, q, route, clock, at: CLOCKS[clock], venue, expect, routers: extra.routers || ['model'], ...extra,
}));

test('the catalog holds each case once, each at a known instant, and OPEN names only its rows', () => {
  assert.strictEqual(new Set(ROWS.map((c) => c.id)).size, ROWS.length);
  for (const c of ROWS) assert.ok(c.at, `${c.id}: no clock ${c.clock}`);
  const keys = new Set(ROWS.flatMap((c) => c.routers.map((r) => `${c.id}/${r}`)));
  for (const k of Object.keys(OPEN)) assert.ok(keys.has(k), `${k} is no row`);
});

for (const c of ROWS) {
  for (const router of c.routers) {
    const key = `${c.id}/${router}`;
    test(`${key}, ${c.venue} at ${c.at}: ${c.q}`, async () => {
      const clock = pinClock(Date.parse(c.at));
      try {
        setVenue(c.venue, `${c.id}${router}`);
        route = c.route;
        routerDown = router === 'offline';
        const r = await ask(c.q);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const answer = { mode: r.body.mode, text: r.body.text, sources: (r.body.sources || []).map((s) => s.id) };
        const { level, why } = grade(c, answer);
        const want = OPEN[key] || 'P';
        assert.ok(RANK[level] >= RANK[want], `${level} (${why}), wanted ${want} or better:\n${answer.text}`);
        const other = todayOverAnotherDay(c.at, answer);
        assert.strictEqual(other, null, `today's line over ${other}'s number:\n${answer.text}`);
      } finally {
        clock.restore();
      }
    });
  }
}
