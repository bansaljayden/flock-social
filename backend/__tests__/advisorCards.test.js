// Run: node --test  (from backend/)
//
// ===========================================================================
// THE ADVISOR ONLY SAYS TRUE THINGS, AND REFUSING IS ITS DEFAULT.
//
// T0 of ADVISOR-GROUNDING.md: Layer B (services/advisorFacts.js) plus the
// card route (routes/advisor.js). Deterministic, zero LLM. Pinned here:
//
//   1. The fact-source invariant. A fact without a source, an id, a value or
//      an asOf is UNCONSTRUCTIBLE, and an owner assertion cannot be dressed
//      as a measurement. This is the structural guard that keeps the
//      fabricated Pro Tips box (deleted 2026-08-14) from being rebuilt.
//   2. Corpus gating, both ways: 'baselines' unlocks model-backed facts;
//      'venue_only', 'absent', 'unknown' and NULL all refuse WITH A PATH, and
//      no model call is spent discovering it. Absent is the MODAL case, so
//      the refusal screen is a designed screen.
//   3. The hard refusal classes: causal whys, competitor comparisons, flock
//      budgets, owner-belief-as-measurement, and strip orderings inside the
//      minimum gap (the 43.1%-backwards finding).
//   4. The four MVP cards compose as specced, in order, with the exact route
//      shape the frontend consumes: { cards: [{id, title, facts, status}] }.
//   5. Tier gates: route floor premium; week_ahead / listing_read_back /
//      readings_vs_estimates are pro, around_you is premium.
//   6. SLOP-AUDIT: no em dashes anywhere in owner-visible strings, and the
//      advisor has no write path at all.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'advisor-cards-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.TICKETMASTER_API_KEY = 'test-tm-key';

// ── pg fake: scripted per test via `handlers`; every statement is logged ────
const pool = require('../config/database');
let handlers = [];
let queryLog = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 160)}`));
};

// ── auth stub, before any router is required ─────────────────────────────────
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 7, role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// ── model / weather / events stubs (called through the module objects) ──────
const mlPredictor = require('../services/mlPredictor');
const crowdEngine = require('../services/crowdEngine');
const weatherService = require('../services/weatherService');

let predictCalls = 0;
// Peak at 21:00 by construction so the tests can assert exact arithmetic.
mlPredictor.predictBusyness = async (_venue, _weather, ts) => {
  predictCalls += 1;
  const h = new Date(ts).getHours();
  return { score: 90 - Math.abs(21 - h) * 5, label: 'Busy', predictionMethod: 'ml', modelVersion: 'v-test' };
};

let eventCalls = [];
// `observed: true` is the stub saying the listing call REACHED Ticketmaster.
// advisorFacts reads that flag fail-closed, so a stub without it is a stub for
// an outage, not for a quiet street.
let eventAnswer = () => ({ hasEvent: false, observed: true, nearestDistance: 0, nearestName: null, nearestType: null });
mlPredictor._internals.getNearbyEvents = async (lat, lng, instant, userId) => {
  eventCalls.push({ lat, lng, instant: new Date(instant), userId });
  return eventAnswer(eventCalls.length);
};

weatherService.getWeather = async () => ({ temp: 72, conditions: 'clear sky', isRaining: false });
// 2026-08-22 is a Saturday, 2026-08-23 a Sunday, 2026-08-24 a Monday.
weatherService.getForecast = async () => ([
  { date: '2026-08-22', temp: 78.4, conditions: 'clear sky' },
  { date: '2026-08-23', temp: 80.1, conditions: 'light rain' },
  { date: '2026-08-24', temp: 75.0, conditions: 'clear sky' },
]);

const advisorFacts = require('../services/advisorFacts');
const advisorRouter = require('../routes/advisor');

// ── HTTP harness ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/venue/advisor', advisorRouter);
let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => { server.close(() => resolve()); }));

async function getCards() {
  const res = await fetch(`${base}/api/venue/advisor/cards`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const PLACE_ID = 'ChIJadvisortest0000000000000';

function profileRow(overrides = {}) {
  return {
    user_id: 7,
    google_place_id: PLACE_ID,
    verified: true,
    business_name: 'Test Bar',
    updated_at: new Date('2026-08-18T12:00:00Z'),
    corpus_status: 'baselines',
    corpus_baseline_rows: 168,
    corpus_checked_at: new Date('2026-08-18T12:00:00Z'),
    capacity: 120,
    kitchen_last_order: '21:00',
    owner_busy_nights: ['thursday'],
    owner_busy_nights_present: true,
    ...overrides,
  };
}

const ML_VENUE = {
  name: 'Test Bar', latitude: 40.6084, longitude: -75.4902,
  venue_category: 'bar', google_types: ['bar'], price_level: 2,
  rating: 4.4, review_count: 120, timezone: 'America/New_York',
};

// The venue's Google curve: open 18:00-22:00 every day (5 hours), hour 21 the
// in-day maximum, Thursday (4) and Friday (5) the strong days. Roost scans the
// venue's OWN hours, so this fixture decides exactly which hours are scored.
const SCAN_HOURS = [18, 19, 20, 21, 22];
function curveRows({ hours = SCAN_HOURS, bases = { 4: 80, 5: 82, 6: 60 } } = {}) {
  const rows = [];
  for (let day = 0; day <= 6; day++) {
    const base = bases[day] !== undefined ? bases[day] : 40;
    for (const hour of hours) rows.push({ day_of_week: day, hour, baseline: base + (hour === 21 ? 2 : 0) });
  }
  return rows;
}

function scriptHappyPath({ profile = profileRow(), mlVenue = ML_VENUE, tier = 'pro' } = {}) {
  handlers = [
    [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier }] })],
    [/SELECT user_id, google_place_id, verified/, () => ({ rows: profile ? [profile] : [] })],
    [/FROM ml_venues WHERE google_place_id/, () => ({ rows: mlVenue ? [mlVenue] : [] })],
    [/FROM ml_venue_baselines/, () => ({ rows: curveRows() })],
    [/FROM venue_owner_reports/, () => ({
      rows: [{ day: '2026-08-15', peak_reading: 62, readings: 3 }],
    })],
    [/FROM served_predictions/, () => ({
      rows: [{ day: '2026-08-15', serves: 12, median_score: 48 }],
    })],
  ];
}

test.beforeEach(() => {
  handlers = [];
  queryLog = [];
  predictCalls = 0;
  eventCalls = [];
  eventAnswer = () => ({ hasEvent: false, observed: true, nearestDistance: 0, nearestName: null, nearestType: null });
  CURRENT_USER = { id: 7, role: 'venue_owner' };
  delete process.env.VENUE_BILLING_ENABLED;
});

// ── 1. The fact-source invariant ─────────────────────────────────────────────

test('a fact without a source is unconstructible, whatever else it carries', () => {
  const ok = { id: 'peak_x', value: 42, source: 'model_holdout', asOf: '2026-08-19T00:00:00Z' };
  assert.ok(advisorFacts.makeFact(ok));
  assert.throws(() => advisorFacts.makeFact({ ...ok, source: undefined }), /without a known source/);
  assert.throws(() => advisorFacts.makeFact({ ...ok, source: 'vibes' }), /without a known source/);
  assert.throws(() => advisorFacts.makeFact({ ...ok, id: undefined }), /id required/);
  assert.throws(() => advisorFacts.makeFact({ ...ok, value: undefined }), /value required/);
  assert.throws(() => advisorFacts.makeFact({ ...ok, asOf: undefined }), /asOf required/);
});

test('arithmetic facts need provenance; owner assertions cannot wear a measurement source', () => {
  assert.throws(
    () => advisorFacts.makeFact({ id: 'derived', value: 1, source: 'arithmetic', asOf: 'now' }),
    /non-empty `from` list/
  );
  const withFrom = advisorFacts.makeFact({
    id: 'derived', value: 1, source: 'arithmetic', asOf: 'now', from: ['intake_capacity', 'peak_2026-08-21'],
  });
  assert.deepStrictEqual(withFrom.from, ['intake_capacity', 'peak_2026-08-21']);

  // Refusal class: owner beliefs restated as measurement.
  assert.throws(
    () => advisorFacts.makeFact({ id: 'intake_owner_busy_nights', value: ['friday'], source: 'model_holdout', asOf: 'now' }),
    /may not be restated as measurement/
  );
  assert.throws(
    () => advisorFacts.makeFact({ id: 'owner_reading_2026-08-15', value: 62, source: 'user_reports', asOf: 'now' }),
    /may not be restated as measurement/
  );
  // The legitimate construction stamps its attribution.
  const belief = advisorFacts.makeFact({ id: 'intake_capacity', value: 120, source: 'intake', asOf: 'owner-set 2026-08-18' });
  assert.strictEqual(belief.attribution, 'owner_asserted');
});

test('facts are frozen: nothing downstream can edit a number after construction', () => {
  const f = advisorFacts.makeFact({ id: 'peak_x', value: 42, source: 'model_holdout', asOf: 'now' });
  assert.throws(() => { 'use strict'; f.value = 99; }, TypeError);
});

// ── 2. Corpus gating, both ways ──────────────────────────────────────────────

test('corpus_status=baselines with rows unlocks; everything else refuses with a path', () => {
  assert.strictEqual(advisorFacts.corpusGate({ corpus_status: 'baselines', corpus_baseline_rows: 168 }), null);
  for (const status of ['venue_only', 'absent', 'unknown', null, undefined]) {
    const refusal = advisorFacts.corpusGate({ corpus_status: status, corpus_baseline_rows: 0 });
    assert.ok(advisorFacts.isRefusal(refusal), `status=${status} must refuse`);
    assert.ok(refusal.reason.length > 0);
    assert.ok(refusal.whatWouldUnlock.length > 0, 'a refusal without a path is a dead end');
  }
  // 'baselines' claimed but zero rows is not permission either.
  assert.ok(advisorFacts.isRefusal(advisorFacts.corpusGate({ corpus_status: 'baselines', corpus_baseline_rows: 0 })));
});

test('an absent-corpus venue costs zero model calls: the gate is a field read', async () => {
  const ctx = { profile: profileRow({ corpus_status: 'absent', corpus_baseline_rows: 0 }), mlVenue: null };
  const facts = await advisorFacts.buildWeekAhead(ctx, { userId: 7 });
  assert.strictEqual(facts.length, 1);
  assert.ok(advisorFacts.isRefusal(facts[0]));
  assert.strictEqual(predictCalls, 0, 'no prediction may be attempted for an ungated venue');
});

test('a baselines venue gets model-backed peak facts carrying method, gate and source', async () => {
  handlers = [[/FROM ml_venue_baselines/, () => ({ rows: curveRows() })]];
  const ctx = { profile: profileRow(), mlVenue: ML_VENUE };
  const facts = await advisorFacts.buildWeekAhead(ctx, { userId: 7 });
  const peaks = facts.filter((f) => !advisorFacts.isRefusal(f));
  assert.strictEqual(peaks.length, 7, 'seven days, seven peak facts');
  const expectedBasis = crowdEngine.describePredictionSupport('ml', 0).basis;
  for (const f of peaks) {
    assert.match(f.id, /^peak_\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(f.predictionMethod, 'ml');
    assert.strictEqual(f.gate, 'corpus_status=baselines');
    assert.strictEqual(f.source, expectedBasis);
    assert.strictEqual(f.value.peakHour, 21, 'stubbed model peaks at 21:00');
    assert.strictEqual(f.value.peakScore, 90);
    assert.ok(f.asOf);
  }
  assert.strictEqual(predictCalls, 7 * SCAN_HOURS.length,
    'the scan covers exactly the hours the venue\'s own curve says it runs');
});

test('a morning venue peaks in the morning: the scan is never an evening window', async () => {
  // A breakfast cafe: open 06:00-11:00, curve maximum at 08:00. Roost serves
  // any venue type, so the peak must surface at 8 AM, not be missed by a
  // hardcoded evening scan.
  handlers = [[/FROM ml_venue_baselines/, () => ({
    rows: (() => {
      const rows = [];
      for (let day = 0; day <= 6; day++) {
        for (const hour of [6, 7, 8, 9, 10, 11]) {
          rows.push({ day_of_week: day, hour, baseline: 70 - Math.abs(8 - hour) * 10 + 5 });
        }
      }
      return rows;
    })(),
  })]];
  const realPredict = mlPredictor.predictBusyness;
  mlPredictor.predictBusyness = async (_v, _w, ts) => {
    predictCalls += 1;
    const h = new Date(ts).getHours();
    return { score: 85 - Math.abs(8 - h) * 7, label: 'Busy', predictionMethod: 'ml', modelVersion: 'v-test' };
  };
  try {
    const ctx = { profile: profileRow(), mlVenue: ML_VENUE };
    const facts = await advisorFacts.buildWeekAhead(ctx, { userId: 7 });
    const peaks = facts.filter((f) => !advisorFacts.isRefusal(f));
    assert.strictEqual(peaks.length, 7);
    for (const f of peaks) {
      assert.strictEqual(f.value.peakHour, 8, 'a cafe peak at 8 AM surfaces');
      assert.match(f.label, /8 AM/);
      assert.ok(!/night|evening|bar\b/i.test(f.label), 'no nightlife vocabulary in the label');
    }
    assert.strictEqual(predictCalls, 7 * 6, 'only the cafe\'s own six open hours are scored per day');
  } finally {
    mlPredictor.predictBusyness = realPredict;
  }
});

test('a day the curve shows dark refuses instead of projecting a peak for a closed room', async () => {
  // Open Tuesday-Sunday; Monday (1) has no curve rows at all.
  handlers = [[/FROM ml_venue_baselines/, () => ({
    rows: curveRows().filter((r) => r.day_of_week !== 1),
  })]];
  const ctx = { profile: profileRow(), mlVenue: ML_VENUE };
  const facts = await advisorFacts.buildWeekAhead(ctx, { userId: 7 });
  const refusals = facts.filter((f) => advisorFacts.isRefusal(f));
  assert.strictEqual(refusals.length, 1);
  assert.match(refusals[0].reason, /no activity on Monday/);
  assert.strictEqual(facts.filter((f) => !advisorFacts.isRefusal(f)).length, 6);
});

test('rule-engine days are refused, never dressed as the venue forecast', async () => {
  handlers = [[/FROM ml_venue_baselines/, () => ({ rows: curveRows() })]];
  mlPredictor.predictBusyness = async () => ({ score: 55, label: 'Moderate', predictionMethod: 'rule_engine', modelVersion: null });
  try {
    const ctx = { profile: profileRow(), mlVenue: ML_VENUE };
    const facts = await advisorFacts.buildWeekAhead(ctx, { userId: 7 });
    assert.strictEqual(facts.length, 7);
    for (const f of facts) {
      assert.ok(advisorFacts.isRefusal(f), 'a category prior is not this venue\'s forecast');
      assert.match(f.reason, /category rules/);
    }
  } finally {
    mlPredictor.predictBusyness = async (_v, _w, ts) => {
      predictCalls += 1;
      const h = new Date(ts).getHours();
      return { score: 90 - Math.abs(21 - h) * 5, label: 'Busy', predictionMethod: 'ml', modelVersion: 'v-test' };
    };
  }
});

// ── 2b. A null result may not wear a fact's clothes ─────────────────────────
//
// The strongest-days band had a floor (85% of the best day) and no ceiling, so
// a venue whose week is level cleared it on every day and the card published
// all seven as "your Google profile's strongest days". That sentence is
// unfalsifiable, it is identical to the one a venue with a real Friday spike
// gets, and the agreement line under it then congratulated the owner for
// matching a curve that matched everything.

test('a flat curve says no day stands out, and the agreement line is not computed at all', async () => {
  // Every day and hour the same baseline: there is no strongest day here.
  handlers = [[/FROM ml_venue_baselines/, () => ({ rows: curveRows({ bases: {} }) })]];
  const ctx = { profile: profileRow(), mlVenue: ML_VENUE };
  const out = await advisorFacts.buildListingReadBack(ctx, [], { now: new Date('2026-08-20T18:00:00Z') });

  const curve = out.find((f) => f.id === 'google_baseline_busy_days');
  assert.ok(curve, 'the curve fact still renders: the null result IS the answer');
  assert.match(curve.label, /^No day stands out in your Google curve\./);
  assert.deepStrictEqual(curve.value.days, [], 'no day is named in the value either');
  assert.strictEqual(out.find((f) => f.id === 'busy_days_agreement'), undefined,
    'agreeing with a curve that agrees with every day is not a finding');
  // The owner's own answer is still read back, attributed to them.
  const belief = out.find((f) => f.id === 'intake_owner_busy_nights');
  assert.ok(belief && belief.source === 'intake');
});

test('a curve with real peaks still names them and still checks the owner against them', async () => {
  handlers = [[/FROM ml_venue_baselines/, () => ({ rows: curveRows() })]];
  const ctx = { profile: profileRow(), mlVenue: ML_VENUE };
  const out = await advisorFacts.buildListingReadBack(ctx, [], { now: new Date('2026-08-20T18:00:00Z') });

  const curve = out.find((f) => f.id === 'google_baseline_busy_days');
  assert.match(curve.label, /strongest days in the spring 2026 corpus: friday, thursday\.$/);
  const agreement = out.find((f) => f.id === 'busy_days_agreement');
  assert.ok(agreement, 'two strong days out of seven is a finding, and it is stated');
  assert.deepStrictEqual(agreement.value.sharedDays, ['thursday']);
});

// ── 3. The hard refusal classes ──────────────────────────────────────────────

test('causal whys, competitor comparisons, flock budgets and belief-as-measurement all refuse', () => {
  for (const name of ['causalWhy', 'competitorComparison', 'flockBudgets', 'ownerBeliefAsMeasurement']) {
    const refusal = advisorFacts.HARD_REFUSALS[name]();
    assert.strictEqual(refusal.status, 'refused', name);
    assert.ok(refusal.reason.length > 0, name);
    assert.ok(refusal.whatWouldUnlock.length > 0, name);
    // FTC rule: refusals never carry an upsell.
    assert.ok(!/upgrade|plan|tier|subscribe/i.test(refusal.reason + ' ' + refusal.whatWouldUnlock),
      `${name} refusal must not pitch an upgrade`);
  }
});

test('strip orderings inside the minimum gap refuse; a clear gap yields a fact', () => {
  // The hedge is defined ONCE, on the dashboard router (a parallel change). In
  // a tree where it has not landed yet, the advisor must fail CLOSED: every
  // ordering refuses. Both halves are pinned here.
  const hedge = require('../routes/venueDashboard').__test || {};
  const you = { name: 'Mine', peakScore: 60, method: 'ml' };
  const ruled = { name: 'Theirs', peakScore: 99, method: 'rule_engine' };
  assert.ok(advisorFacts.isRefusal(advisorFacts.stripOrderingFact(you, ruled)),
    'rule-engine side: refuse whatever the gap');

  if (typeof hedge.stripOrderingClaim !== 'function') {
    const far = { name: 'Theirs', peakScore: 99, method: 'ml' };
    assert.ok(advisorFacts.isRefusal(advisorFacts.stripOrderingFact(you, far)),
      'no hedge in this build: every ordering refuses, whatever the gap');
    return;
  }

  const { STRIP_ORDERING_MIN_GAP } = hedge;
  const close = { name: 'Theirs', peakScore: 60 + STRIP_ORDERING_MIN_GAP - 1, method: 'ml' };
  const far = { name: 'Theirs', peakScore: 60 + STRIP_ORDERING_MIN_GAP, method: 'ml' };
  assert.ok(advisorFacts.isRefusal(advisorFacts.stripOrderingFact(you, close)), 'inside the gap: refuse');
  const fact = advisorFacts.stripOrderingFact(you, far);
  assert.ok(!advisorFacts.isRefusal(fact));
  assert.strictEqual(fact.value.claim, 'busier');
  assert.strictEqual(fact.value.minGap, STRIP_ORDERING_MIN_GAP);
  assert.strictEqual(fact.source, 'model_holdout');
});

// ── 4. The four cards compose, in the route's exact shape ────────────────────

test('GET /cards leads with the verdict, then the four MVP cards, in the pinned shape', async () => {
  scriptHappyPath();
  eventAnswer = (n) => (n === 5
    ? { hasEvent: true, observed: true, nearestDistance: 0.62, nearestName: 'Arena Show', nearestType: 'concert', nearestAttendance: 4000 }
    : { hasEvent: false, observed: true, nearestDistance: 0, nearestName: null, nearestType: null });

  const { status, body } = await getCards();
  assert.strictEqual(status, 200);
  assert.strictEqual(body.available, true);
  // Card order is a product decision, pinned here. The verdict is FIRST:
  // "how did we just do" is the question operators actually open a tool to ask
  // (Toast prompt telemetry, 125,000+ locations; explicit forecasting was one
  // percent, the least asked category measured), and everything under it is a
  // forecast or a read-back.
  // The cohort card sits last because it is the only one that can be empty for
  // a reason nothing on the owner's side fixes: it needs five OTHER venues
  // reporting before its same-night half says anything (services/
  // advisorCohort.js). Its typicals half answers from the frozen corpus today.
  assert.deepStrictEqual(body.cards.map((c) => c.id),
    ['last_night_verdict', 'week_ahead', 'around_you', 'listing_read_back', 'readings_vs_estimates', 'cohort']);
  for (const card of body.cards) {
    assert.ok(typeof card.title === 'string' && card.title.length > 0);
    assert.ok(Array.isArray(card.facts));
    assert.ok(['ok', 'refused', 'locked'].includes(card.status));
    for (const f of card.facts) {
      if (f.status === 'refused') {
        assert.ok(f.reason && f.whatWouldUnlock, 'refusals are data with a path');
      } else {
        assert.ok(f.id && f.source && f.asOf && f.value !== undefined,
          `every fact carries id/value/source/asOf (${f.id})`);
      }
    }
  }

  const [verdict, week, around, listing, readings] = body.cards;
  // No reading for the venue's yesterday in this fixture, so the verdict card
  // is the refusal screen, and the refusal names the one tap that fixes it.
  assert.strictEqual(verdict.status, 'refused');
  assert.ok(verdict.facts.every((f) => f.status === 'refused'));
  assert.match(verdict.facts[0].whatWouldUnlock, /busy slider/);
  assert.strictEqual(week.status, 'ok');
  assert.strictEqual(week.facts.filter((f) => f.predictionMethod === 'ml').length, 7);

  // Card 2: the event fact carries distance and name, and NO attendance guess.
  assert.strictEqual(around.status, 'ok');
  const eventFact = around.facts.find((f) => f.id && f.id.startsWith('event_'));
  assert.ok(eventFact, 'the listed event surfaced');
  assert.strictEqual(eventFact.value.distanceKm, 0.6);
  assert.strictEqual(eventFact.value.name, 'Arena Show');
  assert.ok(!('attendance' in eventFact.value) && !('nearestAttendance' in eventFact.value),
    'attendance is a vendor heuristic and never surfaces');
  const weekendWeather = around.facts.filter((f) => f.id && f.id.startsWith('weather_'));
  assert.deepStrictEqual(weekendWeather.map((f) => f.value.date), ['2026-08-22', '2026-08-23'],
    'weather facts are the weekend line, Monday excluded');

  // Card 3: intake arithmetic traces to its parent facts.
  assert.strictEqual(listing.status, 'ok');
  const kitchen = listing.facts.find((f) => f.id === 'kitchen_vs_peak');
  assert.ok(kitchen, 'kitchen_last_order x peak fired');
  assert.strictEqual(kitchen.source, 'arithmetic');
  assert.ok(kitchen.from.includes('intake_kitchen_last_order'));
  assert.ok(kitchen.from.some((id) => id.startsWith('peak_')));
  assert.strictEqual(kitchen.value.peakAtOrAfterLastOrder, true, '21:00 kitchen, 21:00 peak: they touch');
  // THE VALUE IS THE COLUMN, THE LABEL IS THE SENTENCE. A stored time printed
  // straight into prose put "your last orders at 21:00" in the same breath as
  // "around 9 PM", which is one room described in two vocabularies, and the
  // vocabulary that leaked is the database's. advisorPhrasing.clock12 had
  // already fixed this for the phrased answer; the fact labels it phrases from
  // were still carrying the raw column, so every card and the template twin
  // printed it.
  assert.strictEqual(kitchen.value.kitchenLastOrder, '21:00', 'the value keeps the column exactly as stored');
  assert.doesNotMatch(kitchen.label, /\d{1,2}:\d{2}/, 'no database clock reaches the sentence');
  assert.match(kitchen.label, /9 PM/);
  const kitchenIntake = listing.facts.find((f) => f.id === 'intake_kitchen_last_order');
  assert.strictEqual(kitchenIntake.value, '21:00');
  assert.strictEqual(kitchenIntake.label, 'You told us the kitchen takes last orders at 9 PM.');
  const capacity = listing.facts.find((f) => f.id === 'capacity_at_projected_peak');
  assert.ok(capacity);
  assert.strictEqual(capacity.value.approxPeople, Math.round((120 * 90) / 100),
    'people figure is arithmetic on the owner capacity and the peak fact, nothing invented');
  const agreement = listing.facts.find((f) => f.id === 'busy_days_agreement');
  assert.ok(agreement);
  assert.deepStrictEqual(agreement.value.sharedDays, ['thursday']);
  const curve = listing.facts.find((f) => f.id === 'google_baseline_busy_days');
  assert.match(curve.asOf, /2026-05-18/, 'frozen-corpus facts carry their as-of date forever');

  // Card 4: owner testimony attributed, served predictions labeled as serves.
  assert.strictEqual(readings.status, 'ok');
  const ownerFact = readings.facts.find((f) => f.id === 'owner_reading_2026-08-15');
  assert.ok(ownerFact);
  assert.strictEqual(ownerFact.source, 'owner_report');
  assert.strictEqual(ownerFact.attribution, 'owner_asserted');
  const servedFact = readings.facts.find((f) => f.id === 'served_2026-08-15');
  assert.ok(servedFact);
  assert.strictEqual(servedFact.source, 'served_prediction');
  assert.strictEqual(servedFact.value.serves, 12);
});

test('the modal case: an absent-corpus venue gets refusal cards that name the missing data', async () => {
  scriptHappyPath({
    profile: profileRow({ corpus_status: 'absent', corpus_baseline_rows: 0, kitchen_last_order: null, owner_busy_nights: null, capacity: null }),
    mlVenue: null,
  });
  const { status, body } = await getCards();
  assert.strictEqual(status, 200);
  assert.strictEqual(body.cards.length, 6, 'the refusal screen is the main screen, every card renders');
  // The cohort card refuses twice over for this venue and both refusals carry
  // a path: no row on the measured map means no city and category group to
  // place it in, and the corpus gate answers the typicals half.
  const cohort = body.cards.find((c) => c.id === 'cohort');
  assert.strictEqual(cohort.status, 'refused');
  assert.ok(cohort.facts.every((f) => f.status === 'refused' && f.whatWouldUnlock.length > 0));
  // The verdict card is the one card an absent-corpus venue can still fill in:
  // it reads no baseline curve and no model, only the venue's own readings.
  const verdict = body.cards.find((c) => c.id === 'last_night_verdict');
  assert.strictEqual(verdict.status, 'refused', 'no reading yesterday, so no verdict');
  assert.ok(verdict.facts[0].reason.length > 0 && verdict.facts[0].whatWouldUnlock.length > 0);
  const week = body.cards.find((c) => c.id === 'week_ahead');
  assert.strictEqual(week.status, 'refused');
  assert.strictEqual(week.facts.length, 1);
  assert.match(week.facts[0].reason, /no crowd history/i);
  assert.ok(week.facts[0].whatWouldUnlock.length > 0);
  const around = body.cards.find((c) => c.id === 'around_you');
  assert.strictEqual(around.status, 'refused', 'no corpus row means no coordinates to look around');
  // Empty intake renders prompts, not guesses.
  const listing = body.cards.find((c) => c.id === 'listing_read_back');
  assert.strictEqual(listing.status, 'refused');
  assert.ok(listing.facts.every((f) => f.status === 'refused'));
  assert.strictEqual(predictCalls, 0, 'the whole modal screen costs zero model calls');
});

test('missing profile and unverified claims answer available:false, cards empty', async () => {
  handlers = [[/SELECT user_id, google_place_id, verified/, () => ({ rows: [] })]];
  let r = await getCards();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.available, false);
  assert.deepStrictEqual(r.body.cards, []);

  scriptHappyPath({ profile: profileRow({ verified: false }) });
  r = await getCards();
  assert.strictEqual(r.body.available, false);
  assert.strictEqual(r.body.unverified, true);
});

// ── 5. Tier gates ────────────────────────────────────────────────────────────

test('billing on: free tier is refused at the door with the standard contract', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  scriptHappyPath({ tier: 'free' });
  const { status, body } = await getCards();
  assert.strictEqual(status, 403);
  assert.strictEqual(body.code, 'UPGRADE_REQUIRED');
  assert.strictEqual(body.requiredTier, 'premium');
});

test('billing on: premium sees around_you built and the three pro cards locked', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  scriptHappyPath({ tier: 'premium' });
  const { status, body } = await getCards();
  assert.strictEqual(status, 200);
  const byId = Object.fromEntries(body.cards.map((c) => [c.id, c]));
  for (const id of ['last_night_verdict', 'week_ahead', 'listing_read_back', 'readings_vs_estimates']) {
    assert.strictEqual(byId[id].status, 'locked', id);
    assert.strictEqual(byId[id].requiredTier, 'pro', id);
    assert.deepStrictEqual(byId[id].facts, [], 'a locked card leaks no facts');
  }
  assert.notStrictEqual(byId.around_you.status, 'locked');
  assert.strictEqual(predictCalls, 0, 'locked pro cards spend no model calls');
});

test('billing on: pro sees all four cards built; billing off behaves like pro', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  scriptHappyPath({ tier: 'pro' });
  let { body } = await getCards();
  assert.ok(body.cards.every((c) => c.status !== 'locked'));

  delete process.env.VENUE_BILLING_ENABLED;
  scriptHappyPath();
  ({ body } = await getCards());
  assert.ok(body.cards.every((c) => c.status !== 'locked'));
});

// ── 6. SLOP-AUDIT and the no-write pin ───────────────────────────────────────

function everyString(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => everyString(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => everyString(v, out));
  return out;
}

test('no owner-visible string carries an em dash or class words, and the guard itself bites', async () => {
  scriptHappyPath();
  const { body } = await getCards();
  for (const s of everyString(body)) {
    assert.ok(!s.includes('—'), `em dash in owner-visible copy: "${s}"`);
    assert.ok(!/seamless|effortless|unlock deeper/i.test(s), `class word in copy: "${s}"`);
  }
  assert.throws(() => advisorFacts.assertCleanCopy('busy — tonight', 'test'), /SLOP-AUDIT/);
  assert.throws(() => advisorFacts.assertCleanCopy('a seamless evening', 'test'), /SLOP-AUDIT/);
});

const factsSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'advisorFacts.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'advisor.js'), 'utf8');

test('the fact engine has no write path, and the cards surface is GET', () => {
  // Two POSTs, and both of them only read. /ask takes a closed intent id;
  // /question takes one typed question and answers it from the same fact
  // engine. Neither writes to a product table, and everything else must be
  // GET. Mutating verbs would make the advisor a surface that can act, which
  // is a different and unapproved product.
  assert.ok(!/router\.(put|patch|delete)\(/.test(routeSrc),
    'routes/advisor.js declares a mutating route');
  const posts = [...routeSrc.matchAll(/router\.post\('([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(posts.sort(), ['/ask', '/question'],
    'the advisor POSTs are the chip endpoint and the typed one, and nothing else');
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(factsSrc.replace(/\/\/[^\n]*/g, '')),
    'services/advisorFacts.js issues a write');
});

test('the advisor never touches flock budgets, in any form or aggregate', () => {
  // Comments may NAME the invariant; code may not touch the tables.
  const stripped = (src) => src.replace(/\/\/[^\n]*/g, '');
  for (const banned of ['budget_submissions', 'bill_split', 'bill_splits']) {
    assert.ok(!stripped(factsSrc).includes(banned) && !stripped(routeSrc).includes(banned),
      `the advisor reads ${banned}; the budget-privacy invariant has no venue-side exception`);
  }
});

test('the route shape is pinned: /cards under the premium floor, cards array present', () => {
  assert.match(routeSrc, /router\.get\('\/cards', authenticate, requirePremium,/,
    'the route floor is requireVenueTier(premium), the dashboard idiom');
  assert.match(routeSrc, /requireVenueTier\('premium'\)/);
});

// ── Ordering claims, and the two plans that refuse to make one ──────────────
//
// These drive the route plans directly. A plan is a pure function from the
// memoised builder to the entries a chip answers with, so a fake builder is a
// complete fixture, and reaching them through the endpoint would mean standing
// up a whole database to test a sort.

const { __INTENT_PLANS: PLANS } = require('../routes/advisor');
const { HOUR_ORDERING_MIN_GAP } = require('../services/crowdEngine');

const peakFact = (date, weekday, peakScore) => ({
  id: `peak_${date}`,
  value: { date, weekday, peakHour: 20, peakScore },
  source: 'model_holdout',
  asOf: '2026-08-20T00:00:00.000Z',
  label: `${weekday} projects busiest around 8 PM, at ${peakScore} on our 0 to 100 index.`,
});
const readingFact = (date, peakReading) => ({
  id: `owner_reading_${date}`,
  value: { date, peakReading, readings: 1 },
  source: 'owner_report',
  asOf: date,
  label: `Your highest reading on ${date} was ${peakReading}.`,
});
const planBuilder = ({ week = [], readings = [], around = [] }) => ({
  week: async () => week,
  readings: async () => readings,
  around: async () => around,
});

test('a level week has no quiet night, and quiet_nights says so instead of naming the lowest number', async () => {
  // The live preview projected 90, 88, 85, 89, 89, 90, 89 and this chip called
  // Saturday the quietest at 85: five points off the busiest day of the same
  // week, which is inside the noise. Commit 3782777 refused to name a strongest
  // day when the Google curve was level, and 1d1b92b's HOUR_ORDERING_MIN_GAP is
  // the measured floor for the same claim on the same 0 to 100 index.
  const flat = [
    peakFact('2026-08-20', 'Thursday', 90), peakFact('2026-08-21', 'Friday', 88),
    peakFact('2026-08-22', 'Saturday', 85), peakFact('2026-08-23', 'Sunday', 89),
    peakFact('2026-08-24', 'Monday', 89), peakFact('2026-08-25', 'Tuesday', 90),
    peakFact('2026-08-26', 'Wednesday', 89),
  ];
  const out = await PLANS.quiet_nights(planBuilder({ week: flat }));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].status, 'refused', 'a five point spread names no day');
  assert.strictEqual(out[0].id, 'refuse_quiet_nights_flat_week');
  assert.match(out[0].reason, /No day stands out as quiet/);
  assert.ok(!/Saturday|Friday|Thursday/.test(out[0].reason + out[0].whatWouldUnlock),
    'and it names no weekday at all, because naming one is the defect');

  // The floor is the measured constant, not a literal copied beside it.
  assert.strictEqual(HOUR_ORDERING_MIN_GAP, 10);
  assert.match(out[0].reason, new RegExp(`${HOUR_ORDERING_MIN_GAP} points`));
});

test('a week that actually separates is still ranked, and the facts still say which end they are', async () => {
  const spread = [
    peakFact('2026-08-20', 'Thursday', 90), peakFact('2026-08-21', 'Friday', 88),
    peakFact('2026-08-22', 'Saturday', 62), peakFact('2026-08-23', 'Sunday', 71),
    peakFact('2026-08-24', 'Monday', 89), peakFact('2026-08-25', 'Tuesday', 90),
    peakFact('2026-08-26', 'Wednesday', 89),
  ];
  const out = await PLANS.quiet_nights(planBuilder({ week: spread }));
  assert.strictEqual(out.length, 2, 'the two quietest, lowest first');
  assert.strictEqual(out[0].value.weekday, 'Saturday');
  assert.strictEqual(out[1].value.weekday, 'Sunday');
  assert.match(out[0].note, /LOWEST projected day/);
  assert.match(out[1].note, /second lowest/);
  // Exactly at the floor is not below it: 90 minus 80 is ten, and ten stands.
  const atFloor = await PLANS.quiet_nights(planBuilder({
    week: [peakFact('2026-08-20', 'Thursday', 90), peakFact('2026-08-21', 'Friday', 80)],
  }));
  assert.ok(!atFloor.some((e) => e.status === 'refused'), 'the floor is a minimum gap, not a threshold to clear');
});

test('slow_night answers about the slow day, not about the whole week and next weekend', async () => {
  // It used to hand over both builders whole and the template twin printed
  // fourteen lines: seven readings, a served estimate, three weather days and
  // the street facts. Most of it was about the wrong day, because the weather
  // feed starts at tomorrow and a slow day is in the past.
  const readings = [
    readingFact('2026-08-20', 82), readingFact('2026-08-19', 58), readingFact('2026-08-18', 81),
    readingFact('2026-08-17', 66), readingFact('2026-08-16', 49), readingFact('2026-08-15', 88),
    readingFact('2026-08-14', 71),
    { id: 'served_2026-08-16', value: { date: '2026-08-16', serves: 9 }, source: 'served_prediction', asOf: '2026-08-16', label: 'served nine' },
    { id: 'served_2026-08-20', value: { date: '2026-08-20', serves: 15 }, source: 'served_prediction', asOf: '2026-08-20', label: 'served fifteen' },
  ];
  const around = [
    { id: 'no_listed_events', value: {}, source: 'events', asOf: '2026-08-20', label: 'nothing listed' },
    { id: 'weather_2026-08-21', value: { date: '2026-08-21' }, source: 'weather', asOf: '2026-08-20', label: 'tomorrow' },
    { id: 'weather_2026-08-16', value: { date: '2026-08-16' }, source: 'weather', asOf: '2026-08-16', label: 'the slow day' },
  ];
  const out = await PLANS.slow_night(planBuilder({ readings, around }));
  const ids = out.map((e) => e.id);

  assert.strictEqual(out[0].id, 'owner_reading_2026-08-16', 'the lowest reading is the slow day, and it leads');
  assert.match(out[0].note, /LOWEST of the 7 days/, 'and it travels saying which end of the window it came from');
  assert.ok(ids.includes('served_2026-08-16'), 'what we served THAT day stays');
  assert.ok(!ids.includes('served_2026-08-20'), 'what we served a different day goes');
  assert.ok(ids.includes('weather_2026-08-16'), 'conditions on the slow day stay');
  assert.ok(!ids.includes('weather_2026-08-21'), 'next weekend has nothing to do with last Saturday');
  assert.ok(ids.includes('no_listed_events'), 'undated street context is about the street itself and stays');
  assert.ok(!ids.some((id) => /^owner_reading_/.test(id) && id !== 'owner_reading_2026-08-16'),
    'the six days that were not slow are not the answer to why one day was');
  assert.ok(out.length <= 5, `tightened to the length the other templates run, got ${out.length}`);

  // The memoised builders hand the same fact object to other plans in the same
  // request, so the note is added to a copy.
  assert.strictEqual(readings[4].note, undefined, 'the shared fact was not mutated');
});

test('slow_night with no readings at all falls back to the builder rather than inventing a slow day', async () => {
  const refusal = { id: 'refuse_no_readings', status: 'refused', reason: 'no readings', whatWouldUnlock: 'post one' };
  const out = await PLANS.slow_night(planBuilder({ readings: [refusal] }));
  assert.deepStrictEqual(out, [refusal], 'the refusal speaks for itself');
});
