// Run: node --test __tests__/digestForecastMove.test.js  (from backend/)
//
// THE MONDAY EMAIL'S MONEY MOVE FOR A VENUE WITH NO CROWD HISTORY (2026-11-04).
//
// Roost's money-move chip answers a venue with no crowd history of its own
// from its dashboard's Week Ahead card (roostForecastMove.test.js), and the
// Monday email had no money move for that venue at all: its week refuses on
// the corpus gate, and the section was built from that week alone. Pinned
// here:
//   1. a no-history bar, cafe or bakery whose card reads gets the chip's own
//      money move in the email, line for line in the template's words, with
//      its source named in words (Flock's forecast for places like yours),
//      and (2026-11-05) a Week ahead section with the days Roost's own Week
//      ahead card shows, off the same read;
//   2. cost: the card is read once per venue per sweep, from the dashboard's
//      own cache entry when it is warm, never with more than one Places
//      lookup, and not at all for a venue already mailed that Monday;
//   3. a lookup that fails or is refused, or a card that does not read, leaves
//      the email exactly as it was: no section and no error text;
//   4. a venue with its own crowd history never reads the card, and its money
//      move is as it was;
//   5. the sweep makes no model call, with phrasing on.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// The clock, pinned before the services load, to a Monday morning in New York
// inside the email's window, in the middle of an hour and of a UTC day: the
// card's cache entry is keyed by the hour, so a run that crossed the top of
// one would build the card twice and fail the cost checks for the clock's
// sake, and a date in the current year is printed without its year.
const { pinClock } = require('./helpers/pinnedClock');

const pinnedClock = pinClock(Date.UTC(2026, 10, 9, 14, 20, 0));
test.after(() => pinnedClock.restore());

process.env.JWT_SECRET = 'digest-forecast-move-test-secret';
// Set BEFORE requiring the dashboard router: it captures the key at load.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.ROOST_PLAYBOOK_FIRST;
delete process.env.DIGEST_ENABLED;

// ── The database: venues by owner, the sweep's venue list, its markers ─────
const pool = require('../config/database');

const profiles = new Map();
let venueRows = [];
let markers = new Set();
pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, ' ');
  if (/FROM venue_profiles vp JOIN users u/.test(q)) return { rows: venueRows, rowCount: venueRows.length };
  if (/FROM venue_profiles WHERE user_id/.test(q)) {
    const p = profiles.get(Number(params[0]));
    return { rows: p ? [p] : [], rowCount: p ? 1 : 0 };
  }
  if (/SELECT 1 FROM venue_digest_sends/.test(q)) {
    const held = markers.has(`${params[0]}|${params[1]}`);
    return { rows: held ? [{ held: 1 }] : [], rowCount: held ? 1 : 0 };
  }
  if (/INSERT INTO venue_digest_sends/.test(q)) {
    const key = `${params[0]}|${params[1]}`;
    if (markers.has(key)) return { rows: [], rowCount: 0 };
    markers.add(key);
    return { rows: [], rowCount: 1 };
  }
  if (/roost_ai_consent_at FROM users/.test(q)) return { rows: [{ roost_ai_consent_at: '2026-10-01T00:00:00Z' }], rowCount: 1 };
  // No corpus row, no curve, no readings: a venue Flock has never collected.
  return { rows: [], rowCount: 0 };
};

function noHistoryVenue(userId, placeId, extra = {}) {
  return {
    id: userId,
    user_id: userId,
    google_place_id: placeId,
    verified: true,
    business_name: 'Thistle Room',
    category: null,
    updated_at: '2026-10-01T00:00:00Z',
    corpus_status: 'absent',
    corpus_baseline_rows: 0,
    corpus_checked_at: '2026-10-01T00:00:00Z',
    service_style: 'bar_standing',
    typical_spend_per_person: 28,
    // An intake answer, so the email has a section besides the money move.
    kitchen_last_order: '21:30',
    ...extra,
  };
}

// ── Sign-in (the owner named by a header), budgets, weather, email ─────────
const authMod = require('../middleware/auth');

authMod.authenticate = (req, _res, next) => {
  req.user = { id: Number(req.headers['x-test-user'] || 1), name: 'Owner', role: 'venue_owner' };
  next();
};
const placesBudget = require('../utils/placesBudget');

let placesBudgetOpen = true;
placesBudget.allowPlacesSearch = () => placesBudgetOpen;
const weatherService = require('../services/weatherService');

weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });
// Patched BEFORE services/venueDigest.js takes its reference.
const emailService = require('../services/emailService');

let sentEmails = [];
emailService.sendEmail = async (msg) => { sentEmails.push(msg); return { sent: true, id: 'test-send' }; };

// ── The forecast: the card's numbers, by weekday ───────────────────────────
const CARD = { Sat: 74, Sun: 45, Mon: 48, Tue: 48, Wed: 48, Thu: 64, Fri: 66 };
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const label = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

const mlPredictor = require('../services/mlPredictor');

// What made each hour: a category prior, as for any venue with no curve.
let method = 'rule_engine_no_baseline';
let forecastRuns = 0;
mlPredictor.predictBusyness = async () => ({ score: 40, label: 'Moderate', predictionMethod: method, modelVersion: null });
mlPredictor.agreeWithStrip = async (scored) => scored;
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count, day) => {
  forecastRuns += 1;
  const peak = CARD[SHORT[new Date(day).getDay()]];
  const hours = [];
  for (let i = 0; i < count; i += 1) hours.push((startHour + i) % 24);
  // Each day peaks at the card's number for that weekday twice, at 8 AM and
  // at 9 PM, so a venue read by day and one read on the evening each find it.
  return hours.map((h) => ({
    hour: label(h),
    score: h === 21 || h === 8 ? peak : Math.max(1, peak - 12 - Math.min(Math.abs(21 - h), Math.abs(8 - h))),
    baselineScore: null,
    predictionMethod: method,
  }));
};

// ── Google Places: what each listing says, and whether it answers ──────────
const PLACES = 'https://places.googleapis.com/v1/places/';
// place id -> { answer: 'up' | 'error' | 'throw', types, primary, periods }
const listings = new Map();
let placesCalls = 0;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith(PLACES)) {
    placesCalls += 1;
    const id = decodeURIComponent(u.slice(PLACES.length));
    const l = listings.get(id) || { answer: 'up', types: ['bar'] };
    if (l.answer === 'throw') return Promise.reject(new Error('socket hang up'));
    return Promise.resolve({
      status: 200,
      json: async () => (l.answer === 'error' ? { error: { code: 503, message: 'unavailable' } } : {
        id,
        displayName: { text: 'Thistle Room' },
        rating: 4.4,
        userRatingCount: 320,
        types: l.types,
        ...(l.primary ? { primaryType: l.primary } : {}),
        location: { latitude: 39.95, longitude: -75.16 },
        currentOpeningHours: l.periods ? { openNow: true, periods: l.periods } : { openNow: true },
        utcOffsetMinutes: 0,
      }),
    });
  }
  return realFetch(url, opts);
};

// ── The model: on, and any call to it is counted ───────────────────────────
const advisorPhrasing = require('../services/advisorPhrasing');

let modelCalls = 0;
advisorPhrasing.__setGenAIForTests({
  models: { generateContent: async () => { modelCalls += 1; throw new Error('no model call belongs in this file'); } },
});

const advisorFacts = require('../services/advisorFacts');
const kindForecast = require('../services/kindForecast');
const roostPlaybook = require('../services/roostPlaybook');
const { BULLET } = require('../services/advisorAnswer');
const venueDashboardRouter = require('../routes/venueDashboard');
const advisorRouter = require('../routes/advisor');
const digest = require('../services/venueDigest');
const { renderDigestText, renderDigestHtml } = require('../templates/venueDigestEmail');

// Every read of the card from outside the dashboard's own route: Roost's
// chips and the email.
const realIntelligence = venueDashboardRouter.venueIntelligence;
let cardReads = 0;
venueDashboardRouter.venueIntelligence = async (...a) => { cardReads += 1; return realIntelligence(...a); };

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
  venueDashboardRouter.venueIntelligence = realIntelligence;
  digest._setCardLoaderForTests(null);
  server.close(resolve);
}));

// A Monday, 9 AM in New York, inside the Monday email's window.
const MONDAY_9AM_ET = new Date('2026-11-09T14:00:00Z');
const MONDAY_10AM_ET = new Date('2026-11-09T15:00:00Z');

// One owner, one listing. Phrasing is off for a chip read as a template and
// on for the sweep, so a model call from the email would show.
function setUp(userId, placeId, { extra = {}, listing = {}, phrasing = false } = {}) {
  profiles.set(userId, noHistoryVenue(userId, placeId, extra));
  listings.set(placeId, { answer: 'up', types: ['bar'], ...listing });
  process.env.ADVISOR_PHRASING_ENABLED = phrasing ? 'true' : 'false';
  advisorPhrasing.__resetAdvisorSpend();
  method = 'rule_engine_no_baseline';
  placesBudgetOpen = true;
  return profiles.get(userId);
}

async function call(userId, path, body = null) {
  const headers = { 'x-test-user': String(userId), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const res = await fetch(`${base}${path}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  return { status: res.status, body: await res.json() };
}

// The card as the dashboard serves it, and its quietest and busiest open days
// (each the first of its kind in date order, the way the tile reads it).
async function cardWeek(userId) {
  const r = await call(userId, '/api/venue-dashboard/intelligence');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.available, true, JSON.stringify(r.body));
  const open = r.body.week.filter((d) => !d.closed);
  const low = open.reduce((a, b) => (b.peakScore < a.peakScore ? b : a));
  const top = open.reduce((a, b) => (b.peakScore > a.peakScore ? b : a));
  return { intel: r.body, low, top };
}

// The chip's answer, as the chat shows it: the lead, then each point.
async function chipLines(userId) {
  const r = await call(userId, '/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  return { lines: r.body.text.split('\n').map((l) => (l.startsWith(BULLET) ? l.slice(BULLET.length) : l)), sources: r.body.sources };
}

const emailCards = (userId) => digest.buildDigestCards(advisorFacts, { userId, tier: 'pro', now: MONDAY_9AM_ET });
const moneyCard = (cards) => (cards || []).find((c) => c.id === 'money_move') || null;
const renderInput = (cards) => ({ businessName: 'Thistle Room', cards, tier: 'pro', optOutUrl: 'https://api.example.com/opt-out?token=t', weekLabel: 'Nov 2 to Nov 8' });

// The email's text, section by section: a title in capitals, then its lines.
function emailSection(text, title) {
  const at = text.indexOf(`${title}\n`);
  if (at === -1) return null;
  const rest = text.slice(at + title.length + 1).split('\n\n')[0];
  return rest.split('\n').map((l) => l.replace(/^ {2}/, ''));
}
const MONEY_TITLE = "THIS WEEK'S MONEY MOVE";
const SOURCE_CHIP = (asOf) => `(Flock's forecast for places like yours, ${advisorFacts.shortDate(asOf.slice(0, 10))})`;
const NO_YOUR_RANKING = /\byour (?:quietest|busiest|slowest)\b/i;

// ── 1. The money move, in the chip's own words ─────────────────────────────

test('a no-history bar\'s Monday email carries the chip\'s money move, line for line, framed, with its source in words', async () => {
  const userId = 101;
  setUp(userId, 'ChIJdigestBar00000000000');
  const { intel, low, top } = await cardWeek(userId);
  const chip = await chipLines(userId);
  assert.strictEqual(chip.lines[0], `Fill ${LONG[low.weekday]}. In Flock's forecast for places like yours, it is the quietest day this week, with its peak around 9 PM at ${low.peakScore} on our 0 to 100 index, against ${top.peakScore} on ${LONG[top.weekday]}.`);
  const before = { places: placesCalls, runs: forecastRuns, reads: cardReads };

  const cards = await emailCards(userId);
  const money = moneyCard(cards);
  assert.ok(money, `no money move in ${cards.map((c) => c.id).join(', ')}`);
  // The chip's lead, its move and its money, word for word.
  assert.deepStrictEqual(money.facts.map((f) => f.label), chip.lines);
  assert.strictEqual(money.facts.length, 3);
  assert.match(money.facts[1].label, new RegExp(`^Give ${LONG[low.weekday]} one recurring reason to visit`));
  assert.strictEqual(money.facts[2].label, `At your $28 a head, every 10 extra covers on ${LONG[low.weekday]} is $280 a week, about $14,560 a year.`);
  // Its sources: the card's forecast as of the card's own timestamp, the
  // playbook, the owner's spend; the same three the chip names.
  assert.deepStrictEqual(money.facts.map((f) => [f.source, f.asOf]), [
    ['category_pattern', intel.generatedAt],
    ['roost_playbook', null],
    ['intake', 'owner-set 2026-10-01'],
  ]);
  assert.deepStrictEqual([...new Set(chip.sources.map((s) => s.source))], ['category_pattern', 'roost_playbook', 'intake']);
  assert.ok(chip.sources.filter((s) => s.source === 'category_pattern').every((s) => s.asOf === intel.generatedAt));
  // Read once, from the dashboard's own cache entry: no lookup, no forecast run.
  assert.deepStrictEqual({ places: placesCalls, runs: forecastRuns, reads: cardReads }, { ...before, reads: before.reads + 1 });

  // The email: second only to the verdict, the source said in words.
  const text = renderDigestText(renderInput(cards));
  const lines = emailSection(text, MONEY_TITLE);
  assert.deepStrictEqual(lines, [
    `${chip.lines[0]} ${SOURCE_CHIP(intel.generatedAt)}`,
    `${chip.lines[1]} (Roost playbook)`,
    `${chip.lines[2]} (from your intake, owner-set ${advisorFacts.shortDate('2026-10-01')})`,
  ]);
  // The rest of the email is there too, below it.
  assert.ok(text.includes('You told us the kitchen takes last orders at 9:30 PM.'), text);
  assert.ok(text.indexOf(MONEY_TITLE) < text.indexOf('You told us the kitchen'), text);
  assert.ok(!/category[_ ]pattern|typical_peak_/.test(text), text);
  assert.ok(!NO_YOUR_RANKING.test(lines.join('\n')), lines.join('\n'));
  assert.ok(!text.includes('—'), 'an em dash in the email');
  const html = renderDigestHtml(renderInput(cards)).replace(/&#39;/g, "'");
  assert.ok(html.includes("This week's money move"), html);
  assert.ok(html.includes(`${chip.lines[0]} ${SOURCE_CHIP(intel.generatedAt)}`), html);
  // The Week ahead section comes off the same read (the next test).
  assert.strictEqual(cards.find((c) => c.id === 'week_ahead').status, 'ok');
  assert.strictEqual(modelCalls, 0);
});

// ── 1b. The Week ahead section, as Roost's own Week ahead card shows it ────

const WEEK_TITLE = 'WEEK AHEAD';
// A fact's line in the email: its sentence, its note, then its source in words.
const emailLine = (f) => `${[f.label, f.note].filter(Boolean).join(' ')} ${SOURCE_CHIP(f.asOf)}`;
const jsonOf = (v) => JSON.parse(JSON.stringify(v));

async function roostWeekCard(userId) {
  const r = await call(userId, '/api/venue/advisor/cards');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const card = (r.body.cards || []).find((c) => c.id === 'week_ahead');
  assert.ok(card && card.status === 'ok', JSON.stringify(card));
  return card;
}

test('a no-history bar\'s Week ahead section shows the days Roost\'s own Week ahead card shows, framed, off the money move\'s read', async () => {
  const userId = 105;
  setUp(userId, 'ChIJdigestWeekBar0000000');
  const app = await roostWeekCard(userId);
  // Every day on the card, with its number, said as Flock's forecast for
  // places like this one, as of the card's own timestamp.
  assert.strictEqual(app.facts.length, 6, JSON.stringify(app.facts));
  for (const f of app.facts) {
    assert.strictEqual(f.source, 'category_pattern');
    assert.match(f.label, /^\w+ projects busiest around 9 PM, at \d+ on our 0 to 100 index, in Flock's forecast for places like yours\.$/);
  }
  const before = { places: placesCalls, reads: cardReads };

  const cards = await emailCards(userId);
  const week = cards.find((c) => c.id === 'week_ahead');
  assert.strictEqual(week.status, 'ok');
  assert.strictEqual(week.title, 'Week ahead');
  assert.deepStrictEqual(jsonOf(week.facts), app.facts, 'the email\'s week is not the card Roost shows');
  // One read for the money move and the week, from the cache entry the card
  // just made: no second read and no lookup.
  assert.deepStrictEqual({ places: placesCalls - before.places, reads: cardReads - before.reads }, { places: 0, reads: 1 });
  assert.ok(moneyCard(cards), 'the money move rides the same read');

  const text = renderDigestText(renderInput(cards));
  const lines = emailSection(text, WEEK_TITLE);
  assert.deepStrictEqual(lines, app.facts.map(emailLine));
  assert.ok(text.indexOf(MONEY_TITLE) < text.indexOf(WEEK_TITLE), 'the week ahead sits below the money move, with the heads-up');
  assert.ok(!NO_YOUR_RANKING.test(lines.join('\n')), lines.join('\n'));
  assert.ok(!/category[_ ]pattern|typical_peak_/.test(text), text);
  const html = renderDigestHtml(renderInput(cards)).replace(/&#39;/g, "'");
  assert.ok(html.includes('>Week ahead</h2>'), html);
  for (const f of app.facts) assert.ok(html.includes(`<li style="margin: 0 0 8px 0;">${emailLine(f)}</li>`), emailLine(f));
  assert.strictEqual(modelCalls, 0);
});

test('a no-history cafe\'s email names its morning, from the card read by day, and the dashboard then reads the same entry', async () => {
  const userId = 102;
  setUp(userId, 'ChIJdigestCafe0000000000', {
    extra: { service_style: 'counter_order', typical_spend_per_person: 11 },
    listing: { types: ['cafe', 'food'], primary: 'cafe' },
  });
  // Cold: nothing has read this venue's card this hour.
  const before = { places: placesCalls, reads: cardReads };
  const cards = await emailCards(userId);
  assert.deepStrictEqual({ places: placesCalls - before.places, reads: cardReads - before.reads }, { places: 1, reads: 1 },
    'one read of the card and one Places lookup');
  const money = moneyCard(cards);
  assert.ok(money, cards.map((c) => c.id).join(', '));

  // The dashboard reads the entry the email made, and its card agrees.
  const { intel, low, top } = await cardWeek(userId);
  assert.strictEqual(placesCalls - before.places, 1, 'the dashboard paid a second lookup');
  assert.strictEqual(intel.scanFrom, 'kind');
  assert.strictEqual(intel.peakWindow, 'day');
  assert.strictEqual(money.facts[0].label, `Fill ${LONG[low.weekday]}. In Flock's forecast for places like yours, it is the quietest day this week, with its peak around 8 AM at ${low.peakScore} on our 0 to 100 index, against ${top.peakScore} on ${LONG[top.weekday]}.`);
  assert.strictEqual(money.facts[2].label, `At your $11 a head, every 10 extra covers on ${LONG[low.weekday]} is $110 a week, about $5,720 a year.`);
  // And the chip says the same.
  const chip = await chipLines(userId);
  assert.deepStrictEqual(money.facts.map((f) => f.label), chip.lines);
  const lines = emailSection(renderDigestText(renderInput(cards)), MONEY_TITLE);
  assert.strictEqual(lines[0], `${chip.lines[0]} ${SOURCE_CHIP(intel.generatedAt)}`);
  assert.ok(!NO_YOUR_RANKING.test(lines.join('\n')), lines.join('\n'));
  assert.strictEqual(modelCalls, 0);
});

// Google's periods: one window per listed weekday (0 is Sunday).
const periodsOf = (byDay) => Object.entries(byDay).map(([day, [open, close]]) => ({
  open: { day: Number(day), hour: open, minute: 0 }, close: { day: Number(day), hour: close, minute: 0 },
}));

test('whatever shape the card\'s week takes, the email says what the chip and Roost\'s own Week ahead card say', async () => {
  // A bakery read on its listed hours with a day it is shut, and a level week
  // in which no day stands out and the money is in each check.
  const shut = new Date().getUTCDay() === 0 ? 1 : 0;
  const shapes = [
    [103, 'ChIJdigestBakery00000000', {
      extra: { service_style: 'counter_order', typical_spend_per_person: 9 },
      listing: { types: ['bakery', 'food', 'store'], primary: 'bakery', periods: periodsOf(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== shut).map((d) => [d, [6, 14]]))) },
    }, null],
    [104, 'ChIJdigestLevel000000000', {}, { Sat: 52, Sun: 45, Mon: 48, Tue: 48, Wed: 48, Thu: 50, Fri: 51 }],
  ];
  const saved = { ...CARD };
  try {
    for (const [userId, placeId, opts, card] of shapes) {
      if (card) Object.assign(CARD, card);
      setUp(userId, placeId, opts);
      const chip = await chipLines(userId);
      const app = await roostWeekCard(userId);
      const before = placesCalls;
      const cards = await emailCards(userId);
      const money = moneyCard(cards);
      assert.ok(money, placeId);
      assert.deepStrictEqual(money.facts.map((f) => f.label), chip.lines, placeId);
      assert.deepStrictEqual(jsonOf(cards.find((c) => c.id === 'week_ahead').facts), app.facts, placeId);
      assert.deepStrictEqual(emailSection(renderDigestText(renderInput(cards)), WEEK_TITLE), app.facts.map(emailLine), placeId);
      // The bakery's shut day is on neither, the way the card leaves it out.
      if (!card) assert.ok(app.facts.length === 5 && !app.facts.some((f) => f.value.weekday === LONG[SHORT[shut]]), JSON.stringify(app.facts));
      assert.strictEqual(placesCalls, before, `${placeId}: the email paid a second lookup within the hour`);
      assert.match(chip.lines[0], /^(?:Fill \w+\. )?In Flock's forecast for places like yours, /, placeId);
      if (card) assert.match(chip.lines[0], /no day stands out this week, so the money is in each check/, chip.lines[0]);
      else assert.ok(!chip.lines.join(' ').includes(LONG[SHORT[shut]]), 'a day the listing has it shut was named');
      Object.assign(CARD, saved);
    }
  } finally {
    Object.assign(CARD, saved);
  }
});

// ── 2. The sweep: cost, and no model call ──────────────────────────────────

function sweepRow(userId, placeId) {
  return {
    id: userId,
    user_id: userId,
    business_name: 'Thistle Room',
    tier: 'pro',
    google_place_id: placeId,
    verified: true,
    notification_prefs: { weekly: true },
    email: `owner${userId}@thistle.example.com`,
    email_verified: true,
    is_banned: false,
    timezone: 'America/New_York',
  };
}

test('the Monday sweep mails each no-history venue its money move for one Places lookup each, and a venue already mailed costs none', async () => {
  setUp(201, 'ChIJdigestSweepBar000000', { phrasing: true });
  setUp(202, 'ChIJdigestSweepCafe00000', {
    phrasing: true,
    extra: { service_style: 'counter_order', typical_spend_per_person: 11 },
    listing: { types: ['cafe', 'food'], primary: 'cafe' },
  });
  // A third no-history venue whose owner has the Monday email off: the sweep
  // passes it by before anything is built, so its card is never read.
  setUp(203, 'ChIJdigestSweepOff000000', { phrasing: true });
  venueRows = [
    sweepRow(201, 'ChIJdigestSweepBar000000'),
    sweepRow(202, 'ChIJdigestSweepCafe00000'),
    { ...sweepRow(203, 'ChIJdigestSweepOff000000'), notification_prefs: { weekly: false } },
  ];
  markers = new Set();
  sentEmails = [];
  process.env.DIGEST_ENABLED = 'true';
  const before = { places: placesCalls, reads: cardReads, model: modelCalls };
  try {
    const first = await digest.runVenueDigestSweep(MONDAY_9AM_ET);
    assert.strictEqual(first.sent, 2, JSON.stringify(first));
    assert.strictEqual(sentEmails.length, 2);
    assert.deepStrictEqual({ places: placesCalls - before.places, reads: cardReads - before.reads }, { places: 2, reads: 2 },
      'one read of the card and one lookup per venue');
    for (const [i, hour] of [[0, '9 PM'], [1, '8 AM']]) {
      const lines = emailSection(sentEmails[i].text, MONEY_TITLE);
      assert.ok(lines, sentEmails[i].text);
      assert.match(lines[0], new RegExp(`^Fill \\w+\\. In Flock's forecast for places like yours, it is the quietest day this week, with its peak around ${hour} at \\d+ on our 0 to 100 index, against \\d+ on \\w+\\. \\(Flock's forecast for places like yours, \\w+ \\d+\\)$`), lines[0]);
      assert.ok(sentEmails[i].html.includes('This week&#39;s money move'), sentEmails[i].html);
      // The Week ahead section, off the same read: six days, each framed.
      const week = emailSection(sentEmails[i].text, WEEK_TITLE);
      assert.ok(week && week.length === 6, sentEmails[i].text);
      for (const line of week) {
        assert.match(line, new RegExp(`^\\w+ projects busiest around ${hour}, at \\d+ on our 0 to 100 index, in Flock's forecast for places like yours\\. \\(Flock's forecast for places like yours, \\w+ \\d+\\)$`), line);
      }
      assert.ok(sentEmails[i].html.includes('>Week ahead</h2>'), sentEmails[i].html);
    }

    // An hour later the same Monday: both are already mailed, and neither
    // reads its card again.
    const second = await digest.runVenueDigestSweep(MONDAY_10AM_ET);
    assert.strictEqual(second.alreadySent, 2, JSON.stringify(second));
    assert.strictEqual(sentEmails.length, 2);
    assert.deepStrictEqual({ places: placesCalls - before.places, reads: cardReads - before.reads }, { places: 2, reads: 2 });
    assert.strictEqual(modelCalls - before.model, 0, 'the sweep called the model');
  } finally {
    delete process.env.DIGEST_ENABLED;
    venueRows = [];
  }
});

test('a venue off Roost gets no cards, and its card is never read for them', async () => {
  setUp(204, 'ChIJdigestFree0000000000');
  const before = { places: placesCalls, reads: cardReads };
  assert.deepStrictEqual(await digest.buildDigestCards(advisorFacts, { userId: 204, tier: 'free', now: MONDAY_9AM_ET }), []);
  assert.deepStrictEqual({ places: placesCalls, reads: cardReads }, before);
});

// ── 3. No card: the email exactly as it was ────────────────────────────────

test('a lookup that fails or is refused, or a card that does not read, leaves the email exactly as it was', async () => {
  const cases = [
    ['Google answers an error', 'ChIJdigestDown0000000000', () => { listings.get('ChIJdigestDown0000000000').answer = 'error'; }, 1],
    ['the lookup throws', 'ChIJdigestThrow000000000', () => { listings.get('ChIJdigestThrow000000000').answer = 'throw'; }, 1],
    ['the Places budget says no', 'ChIJdigestBudget00000000', () => { placesBudgetOpen = false; }, 0],
    ['a kind with no window of its own and no hours', 'ChIJdigestGym00000000000', () => { Object.assign(listings.get('ChIJdigestGym00000000000'), { types: ['gym'], primary: 'gym' }); }, 1],
    ['a model number on the card', 'ChIJdigestModel000000000', () => { method = 'ml'; }, 1],
  ];
  // The email as it was before the card was read for it: the same engine
  // with no card to read.
  const asBefore = { ...advisorFacts, buildWeekProjection: undefined };
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [why, placeId, arrange, lookups] of cases) {
      const userId = 300 + cases.findIndex((c) => c[1] === placeId);
      setUp(userId, placeId);
      arrange();
      const before = { places: placesCalls, reads: cardReads };
      const cards = await emailCards(userId);
      assert.deepStrictEqual({ places: placesCalls - before.places, reads: cardReads - before.reads }, { places: lookups, reads: 1 }, why);
      assert.strictEqual(moneyCard(cards), null, `${why}: a money move with no card`);
      const was = await digest.buildDigestCards(asBefore, { userId, tier: 'pro', now: MONDAY_9AM_ET });
      assert.deepStrictEqual(cards, was, why);
      const text = renderDigestText(renderInput(cards));
      assert.strictEqual(text, renderDigestText(renderInput(was)), why);
      assert.strictEqual(renderDigestHtml(renderInput(cards)), renderDigestHtml(renderInput(was)), why);
      assert.ok(!/places like yours|could not|lookup|unavailable|error/i.test(text), `${why}: ${text}`);
      assert.strictEqual(cardReads - before.reads, 1, `${why}: the card was read again for the email that was`);
    }
  } finally {
    console.warn = warn;
    placesBudgetOpen = true;
    method = 'rule_engine_no_baseline';
  }
});

// ── 4. A venue with its own crowd history ──────────────────────────────────

test('a venue with its own crowd history never reads the card, and its money move and week ahead are as they were', async () => {
  const userId = 401;
  setUp(userId, 'ChIJdigestCorpus00000000', { extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 } });
  const own = [
    advisorFacts.makeFact({ id: 'peak_2026-11-10', value: { date: '2026-11-10', weekday: 'Tuesday', peakHour: 18, peakScore: 38 }, source: 'model_holdout', asOf: '2026-11-09T14:00:00Z', unit: '0-100 index', label: 'Tuesday projects busiest around 6 PM, at 38 on our 0 to 100 index.' }),
    advisorFacts.makeFact({ id: 'peak_2026-11-14', value: { date: '2026-11-14', weekday: 'Saturday', peakHour: 20, peakScore: 88 }, source: 'model_holdout', asOf: '2026-11-09T14:00:00Z', unit: '0-100 index', label: 'Saturday projects busiest around 8 PM, at 88 on our 0 to 100 index.' }),
  ];
  const realWeek = advisorFacts.buildWeekAhead;
  const realProjection = advisorFacts.buildWeekProjection;
  let projectionReads = 0;
  advisorFacts.buildWeekAhead = async () => own.map((f) => ({ ...f }));
  advisorFacts.buildWeekProjection = async (...a) => { projectionReads += 1; return realProjection(...a); };
  const before = { places: placesCalls, reads: cardReads };
  try {
    const cards = await emailCards(userId);
    const money = moneyCard(cards);
    assert.ok(money);
    // Its week ahead is its own forecast, as it was.
    assert.deepStrictEqual(cards.find((c) => c.id === 'week_ahead').facts, own);
    assert.strictEqual(money.facts[0].label, 'Fill Tuesday. It is your quietest day this week, with its peak around 6 PM at 38 on our 0 to 100 index, against 88 on Saturday.');
    // The playbook's own words for the venue's own week.
    const move = roostPlaybook.moveFor('money_move', { facts: own }, roostPlaybook.venueOf({ profile: profiles.get(userId) }));
    assert.strictEqual(money.facts[1].label, move.move);
    assert.match(money.facts[1].label, /^Give your slowest day /);
    assert.deepStrictEqual(money.facts.map((f) => f.source), ['model_holdout', 'roost_playbook', 'intake']);
    assert.strictEqual(projectionReads, 0, 'a venue with its own history asked for the card');
    assert.deepStrictEqual({ places: placesCalls, reads: cardReads }, before);
  } finally {
    advisorFacts.buildWeekAhead = realWeek;
    advisorFacts.buildWeekProjection = realProjection;
  }
});

// ── 5. The one function both read ──────────────────────────────────────────

test('the chip and the email show a move through one function: the card\'s quiet day beside the card, the playbook\'s words beside the venue\'s own week', () => {
  const intel = {
    available: true,
    scanFrom: 'kind',
    generatedAt: '2026-11-04T12:00:00Z',
    week: [['2026-11-07', 'Sat', 74, '10 PM'], ['2026-11-08', 'Sun', 45, '8 PM'], ['2026-11-09', 'Mon', 48, '9 PM']]
      .map(([date, weekday, peakScore, peakHour]) => ({ date, weekday, peakScore, peakHour, method: 'rule_engine_no_baseline' })),
  };
  const card = advisorFacts.projectionFacts(intel, { hourOf: venueDashboardRouter.hourOfLabel });
  assert.strictEqual(kindForecast.besideCard('Give your slowest day one recurring reason to visit.', card), 'Give Sunday one recurring reason to visit.');
  const own = card.map((f) => ({ ...f, id: f.id.replace('typical_', ''), source: 'model_holdout' }));
  assert.strictEqual(kindForecast.besideCard('Give your slowest day one recurring reason to visit.', own), 'Give your slowest day one recurring reason to visit.');
  assert.strictEqual(kindForecast.besideCard('Give your slowest day one recurring reason to visit.', null), 'Give your slowest day one recurring reason to visit.');
});
