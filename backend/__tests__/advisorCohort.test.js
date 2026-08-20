// Run: node --test __tests__/advisorCohort.test.js   (from backend/)
//
// ===========================================================================
// THE COHORT ENGINE PUBLISHES A STREET, NEVER A NEIGHBOUR.
//
// services/advisorCohort.js is the one surface in Flock that aggregates other
// businesses' own numbers and shows the result to a competitor. Everything
// pinned below is a privacy or a truthfulness invariant, not a preference:
//
//   HALF A (typicals, frozen corpus)
//     1. A venue is placed inside its city and category cohort at its own
//        strongest slot, as a band, and every fact carries the corpus's frozen
//        date in its asOf AND in its words.
//     2. A thin cell refuses rather than stating a position, and the refusal
//        says why the cell stays thin.
//     3. A venue with no row on the measured map refuses with a path.
//
//   HALF B (same-night actuals, density-gated)
//     4. At or above the floor of five OTHER reporting venues, the payload is
//        a median and a count. No minimum, no maximum, no spread, no id, no
//        name, no per-venue value of any kind.
//     5. Below the floor, it refuses, the refusal names the floor and the
//        density path, and it never states how many venues actually reported.
//     6. THE DIFFERENCING ATTACK. A venue joining or leaving the reporting set
//        may not reveal an individual's reading. Pinned three ways: the
//        statistic is a median and not a mean, fifty-one different joiner
//        values produce one identical published payload, and a set that drops
//        under the floor refuses instead of publishing a thinner number.
//
//   BOTH
//     7. No venue name reaches a payload, and no query the cohort path issues
//        even selects one.
//     8. SLOP-AUDIT holds on every owner-visible string.
//     9. The route and the chip registry carry both halves, and the density
//        refusal survives /ask as the answer rather than being dropped as a
//        partial.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'advisor-cohort-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';

// ── pg fake ──────────────────────────────────────────────────────────────────
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

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 11, role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// The cards route builds every card, so the other builders' dependencies are
// stubbed to something inert. This suite is about the cohort card only.
const mlPredictor = require('../services/mlPredictor');
const weatherService = require('../services/weatherService');
mlPredictor.predictBusyness = async () => ({ score: 50, label: 'Steady', predictionMethod: 'ml', modelVersion: 'v-test' });
mlPredictor._internals.getNearbyEvents = async () => ({ hasEvent: false, nearestDistance: 0, nearestName: null, nearestType: null });
weatherService.getWeather = async () => ({ temp: 70, conditions: 'clear sky', isRaining: false });
weatherService.getForecast = async () => ([]);

const advisorFacts = require('../services/advisorFacts');
const advisorCohort = require('../services/advisorCohort');
const advisorPhrasing = require('../services/advisorPhrasing');
const advisorRouter = require('../routes/advisor');

const app = express();
app.use(express.json());
app.use('/api/venue/advisor', advisorRouter);
let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => { server.close(() => resolve()); }));

async function getJson(path, init) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const PLACE_ID = 'ChIJcohorttest000000000000000';

// Names that must never appear in any payload. They are seeded into the
// ml_venues fixture row precisely so a leak has something to leak.
const MY_NAME = 'The Test Taproom';
const NEIGHBOUR_NAMES = ['Rival Alehouse', 'Corner Public House', 'Third Street Bar'];

function profileRow(overrides = {}) {
  return {
    user_id: 11,
    google_place_id: PLACE_ID,
    verified: true,
    business_name: MY_NAME,
    updated_at: new Date('2026-08-18T12:00:00Z'),
    corpus_status: 'baselines',
    corpus_baseline_rows: 168,
    corpus_checked_at: new Date('2026-08-18T12:00:00Z'),
    ...overrides,
  };
}

// One row serves both getVenueContext's ml_venues read and the cohort key's.
const ML_VENUE = {
  name: MY_NAME, latitude: 40.6084, longitude: -75.4902,
  city: 'lehigh', venue_category: 'bar', google_types: ['bar'],
  price_level: 2, rating: 4.4, review_count: 120, timezone: 'America/New_York',
};

// The venue's own Google curve. Friday (5) 9 PM is its strongest slot at 40,
// which is what the cohort is queried at and what the standing is computed on.
function ownCurveRows() {
  const rows = [];
  for (let day = 0; day <= 6; day++) {
    for (const hour of [18, 19, 20, 21, 22]) {
      let baseline = 25;
      if (day === 5 && hour === 21) baseline = 40;
      else if (day === 5) baseline = 32;
      rows.push({ day_of_week: day, hour, baseline });
    }
  }
  return rows;
}

// percentile_cont(0.5), exactly as Postgres computes it, so the fixtures and
// the assertions agree on what a median is.
function pctCont(values, p = 0.5) {
  const sorted = [...values].sort((a, z) => a - z);
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const CONTEXT_HANDLERS = () => ([
  [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'pro' }] })],
  [/SELECT user_id, google_place_id, verified/, () => ({ rows: [profileRow()] })],
  [/SELECT city, venue_category FROM ml_venues/, () => ({ rows: [{ city: ML_VENUE.city, venue_category: ML_VENUE.venue_category }] })],
  [/FROM ml_venues WHERE google_place_id/, () => ({ rows: [ML_VENUE] })],
]);

/**
 * @param cell    half A's cohort cell: the OTHER venues' baselines at the slot.
 * @param night   half B: { night, hour, reading } the venue's own, or null.
 * @param peers   half B: the other venues' peak readings for the band.
 * @param typical half B's supplementary frozen typical, or null to leave thin.
 */
function scriptCohort({ cell = null, night = null, peers = null, typical = null } = {}) {
  handlers = [
    ...CONTEXT_HANDLERS(),
    // Half A's cell. Aggregated in SQL; the fake does the same arithmetic.
    [/AVG\(b\.baseline\)/, () => {
      if (!typical) return { rows: [{ venues: 0, median_baseline: null }] };
      return { rows: [{ venues: typical.length, median_baseline: pctCont(typical) }] };
    }],
    [/ml_venue_baselines b JOIN ml_venues v/, (params) => {
      if (!cell) return { rows: [{ venues: 0, median_baseline: null, below: 0, tied: 0 }] };
      const you = Number(params[4]);
      return {
        rows: [{
          venues: cell.length,
          median_baseline: pctCont(cell),
          below: cell.filter((b) => b < you).length,
          tied: cell.filter((b) => b === you).length,
        }],
      };
    }],
    [/SELECT day_of_week, hour, baseline FROM ml_venue_baselines/, () => ({ rows: ownCurveRows() })],
    // Half B's own-night read.
    [/AS night, EXTRACT\(HOUR/, () => ({
      rows: night ? [{ night: night.night, hour: night.hour, reading: night.reading }] : [],
    })],
    // Half B's cohort aggregate. Peers only, aggregated before it leaves SQL.
    [/WITH reporters AS/, () => ({
      rows: [{
        venues: peers ? peers.length : 0,
        median_peak: peers && peers.length ? pctCont(peers) : null,
      }],
    })],
    // Chip availability's EXISTS pair.
    [/SELECT EXISTS/, () => ({ rows: [{ readings: true, served: true }] })],
    // Card 4's two reads, inert here.
    [/FROM venue_owner_reports WHERE google_place_id = \$1 AND retracted = false AND created_at >= NOW\(\)/, () => ({ rows: [] })],
    [/FROM served_predictions/, () => ({ rows: [] })],
    [/FROM venue_owner_reports/, () => ({ rows: [] })],
  ];
}

async function ctx() {
  return advisorFacts.getVenueContext(11);
}

test.beforeEach(() => {
  handlers = [];
  queryLog = [];
  CURRENT_USER = { id: 11, role: 'venue_owner' };
  delete process.env.VENUE_BILLING_ENABLED;
  delete process.env.ADVISOR_PHRASING_ENABLED;
});

const strings = (entries) => {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(entries);
  return out;
};

// ═══ HALF A ═════════════════════════════════════════════════════════════════

test('half A places the venue in its cohort, as a band, dated to the frozen corpus', async () => {
  // 30 peers at the slot; the venue's own 40 beats 8 of them.
  const cell = [10, 12, 15, 18, 20, 25, 30, 35, 45, 50, 52, 55, 58, 60, 62, 65,
    66, 68, 70, 72, 74, 75, 78, 80, 82, 85, 88, 90, 92, 95];
  scriptCohort({ cell });
  const out = await advisorFacts.buildCohortStanding(await ctx(), { now: new Date('2026-08-20T15:00:00Z') });

  const ids = out.map((f) => f.id);
  assert.deepStrictEqual(ids, ['cohort_typical_at_your_peak', 'cohort_your_standing']);
  for (const f of out) {
    assert.strictEqual(f.source, 'corpus', 'half A is corpus sourced');
    assert.strictEqual(f.asOf, advisorFacts.CORPUS_AS_OF, 'every corpus fact carries the frozen date');
    assert.match(f.asOf, /2026-05-18/);
  }

  const standing = out[1];
  assert.strictEqual(standing.value.yourBaseline, 40);
  // 8 of 30 below, no ties: 27th percentile, the bottom third.
  assert.strictEqual(standing.value.percentile, 27);
  assert.strictEqual(standing.value.band, 'the bottom third');
  assert.strictEqual(standing.value.venues, 30);
  assert.match(standing.label, /bottom third/);

  // The tense rules. A frozen distribution may not be spoken as this week, and
  // a distribution of typicals may not be spoken as a night.
  const text = strings(out).join(' ');
  assert.match(text, /spring 2026/i, 'the collection window is stated in words, not only in asOf');
  assert.match(text, /2026-05-18/, 'the freeze date is stated in words');
  assert.ok(!/\b(tonight|last night|yesterday|right now|currently)\b/i.test(text),
    'half A never speaks a typical as a night or as now');
  assert.match(standing.note, /says nothing about any particular night/i);
});

test('half A refuses a thin cell instead of ranking inside an anecdote', async () => {
  scriptCohort({ cell: [10, 20, 30, 44, 50, 60] }); // six, under the floor of ten
  const out = await advisorFacts.buildCohortStanding(await ctx(), {});
  assert.strictEqual(out.length, 1);
  assert.ok(advisorFacts.isRefusal(out[0]));
  assert.strictEqual(out[0].id, 'refuse_cohort_cell_thin');
  assert.match(out[0].reason, new RegExp(String(advisorCohort.MIN_COHORT_CORPUS_VENUES)));
  // The path is honest about whose side it is on: the corpus is frozen.
  assert.match(out[0].whatWouldUnlock, /2026-05-18/);
  assert.match(out[0].whatWouldUnlock, /our side/i);
});

test('half A refuses a venue that is not on the measured map, with a path', async () => {
  handlers = [
    [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'pro' }] })],
    [/SELECT user_id, google_place_id, verified/, () => ({ rows: [profileRow()] })],
    [/SELECT city, venue_category FROM ml_venues/, () => ({ rows: [] })],
    [/FROM ml_venues WHERE google_place_id/, () => ({ rows: [] })],
  ];
  const out = await advisorFacts.buildCohortStanding(await ctx(), {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'refuse_no_cohort_membership');
  assert.ok(out[0].whatWouldUnlock.length > 0);
});

test('half A refuses when the profile is outside the corpus gate, before any cohort query', async () => {
  handlers = [
    [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'pro' }] })],
    [/SELECT user_id, google_place_id, verified/, () => ({ rows: [profileRow({ corpus_status: 'absent', corpus_baseline_rows: 0 })] })],
    [/FROM ml_venues WHERE google_place_id/, () => ({ rows: [ML_VENUE] })],
  ];
  const c = await ctx();
  queryLog = [];
  const out = await advisorFacts.buildCohortStanding(c, {});
  assert.ok(advisorFacts.isRefusal(out[0]));
  assert.strictEqual(queryLog.length, 0, 'the gate is a field read: an absent venue costs zero cohort queries');
});

// ═══ HALF B ═════════════════════════════════════════════════════════════════

const NIGHT = { night: '2026-08-14', hour: 21, reading: 20 };
const NOW = new Date('2026-08-20T15:00:00Z');

test('half B publishes a median and a count once the floor is cleared, and nothing else', async () => {
  const peers = [30, 35, 40, 45, 50, 55];
  scriptCohort({ night: NIGHT, peers });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });

  const median = out.find((f) => f.id === 'cohort_night_median');
  assert.ok(median, 'the cohort fact publishes above the floor');
  assert.strictEqual(median.source, 'cohort_reported');
  assert.strictEqual(median.value.reportingVenues, 6);
  // percentile_cont over the six is 42.5, rounded to the published grid.
  assert.strictEqual(median.value.medianReading, advisorCohort.roundToGrid(42.5));

  // The payload is a closed set of keys. Anything resembling an extreme, a
  // spread or an identity is a re-identification vector, so the shape is
  // pinned rather than merely reviewed.
  assert.deepStrictEqual(
    Object.keys(median.value).sort(),
    ['hourFrom', 'hourTo', 'medianReading', 'night', 'reportingVenues', 'weekday']
  );

  // The band is the fixed three-hour grid block containing 9 PM, not a window
  // centered on anything a caller could move.
  assert.strictEqual(median.value.hourFrom, 21);
  assert.strictEqual(median.value.hourTo, 23);

  // Your own reading is your own, so it rides along attributed.
  const mine = out.find((f) => f.id === 'owner_night_peak');
  assert.strictEqual(mine.source, 'owner_report');
  assert.strictEqual(mine.attribution, 'owner_asserted');
  assert.strictEqual(mine.value.peakReading, 20);
});

test('half B never publishes a minimum, a maximum, a spread, a mean or a total', async () => {
  scriptCohort({ night: NIGHT, peers: [5, 30, 40, 45, 50, 99] });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  const json = JSON.stringify(out);
  for (const banned of ['min', 'max', 'lowest', 'highest', 'range', 'spread', 'stddev', 'average', 'mean', 'total', 'sum']) {
    assert.ok(!new RegExp(`"[^"]*${banned}[^"]*"\\s*:`, 'i').test(json), `payload carries a ${banned} field`);
  }
  // The extremes ARE individual venues' readings, so neither may appear as a
  // value anywhere in the block.
  const numbers = [];
  const walk = (v) => {
    if (typeof v === 'number') numbers.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(out.map((f) => f.value));
  assert.ok(!numbers.includes(99), 'the cohort maximum never reaches a payload');
});

test('below the floor half B refuses, names the floor and the path, and never states the count', async () => {
  scriptCohort({ night: NIGHT, peers: [30, 40, 50, 60] }); // four others
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });

  const refusal = out.find((e) => advisorFacts.isRefusal(e));
  assert.ok(refusal, 'under the floor there is a refusal');
  assert.strictEqual(refusal.id, 'refuse_cohort_thin_reporters');
  assert.ok(!out.some((f) => f.id === 'cohort_night_median'), 'no thinned-out number is published instead');

  const floor = String(advisorCohort.MIN_COHORT_REPORTERS);
  assert.match(refusal.reason, new RegExp(floor), 'the reason names the floor');
  // The refusal IS the growth loop: it says what would clear it.
  assert.match(refusal.whatWouldUnlock, new RegExp(floor));
  assert.match(refusal.whatWouldUnlock, /posting readings/i);
  assert.match(refusal.whatWouldUnlock, /category/i);

  // And it must not leak how close the venue is. "Three more would unlock
  // this" tells an owner who can read a map that two named neighbours
  // reported. The refusal says so, in place of the number.
  const text = `${refusal.reason} ${refusal.whatWouldUnlock}`;
  assert.ok(!/\b(4|four)\b/i.test(text), 'the current reporter count never appears');
  assert.match(refusal.whatWouldUnlock, /do not say how many/i);
});

test('a DATE column arrives as a Date and still reads as the day it was', async () => {
  // pg hands back a Date at LOCAL midnight for a DATE column. String()ing it
  // yields "Thu Aug 14 2026 ..." and toISOString() rolls the day backwards
  // anywhere east of Greenwich, so both of the obvious readings are wrong.
  assert.strictEqual(advisorCohort.toDateStr(new Date(2026, 7, 14)), '2026-08-14');
  assert.strictEqual(advisorCohort.toDateStr('2026-08-14'), '2026-08-14');

  scriptCohort({ night: { ...NIGHT, night: new Date(2026, 7, 14) }, peers: [30, 35, 40, 45, 50, 55] });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  const median = out.find((f) => f.id === 'cohort_night_median');
  assert.strictEqual(median.value.night, '2026-08-14');
  assert.strictEqual(median.value.weekday, 'Friday');
});

test('half B refuses with the owner-side path when the venue posted nothing itself', async () => {
  scriptCohort({ night: null, peers: [30, 40, 50, 60, 70, 80] });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'refuse_no_reading_of_your_own');
  assert.match(out[0].whatWouldUnlock, /slider/i);
});

test('half B needs no corpus: a collected-but-unmodelled venue still gets the street', async () => {
  handlers = [
    ...CONTEXT_HANDLERS().map(([re, fn]) => (String(re).includes('user_id, google_place_id')
      ? [re, () => ({ rows: [profileRow({ corpus_status: 'venue_only', corpus_baseline_rows: 0 })] })]
      : [re, fn])),
    [/AVG\(b\.baseline\)/, () => ({ rows: [{ venues: 0, median_baseline: null }] })],
    [/AS night, EXTRACT\(HOUR/, () => ({ rows: [{ ...NIGHT }] })],
    [/WITH reporters AS/, () => ({ rows: [{ venues: 7, median_peak: 33 }] })],
  ];
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(out.some((f) => f.id === 'cohort_night_median'),
    'the half that grows with users does not wait on our collection runs');
});

test('the supplementary frozen typical is dated, hedged, and simply absent when thin', async () => {
  const typical = Array.from({ length: 14 }, (_, i) => 30 + i * 3);
  scriptCohort({ night: NIGHT, peers: [30, 35, 40, 45, 50, 55], typical });
  const withIt = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  const t = withIt.find((f) => f.id === 'cohort_band_typical');
  assert.ok(t);
  assert.strictEqual(t.source, 'corpus');
  assert.strictEqual(t.asOf, advisorFacts.CORPUS_AS_OF);
  assert.match(t.label, /spring 2026/i);
  assert.match(t.note, /not a measurement/i);

  scriptCohort({ night: NIGHT, peers: [30, 35, 40, 45, 50, 55], typical: null });
  const without = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(!without.some((f) => f.id === 'cohort_band_typical'),
    'a thin corpus cell drops the supplementary fact rather than refusing a card that answered');
});

// ═══ THE DIFFERENCING ATTACK ════════════════════════════════════════════════

test('differencing: fifty-one different joiner values produce one identical payload', async () => {
  // The attacker knows the set before the join and watches the published
  // number after it. If the statistic were a mean, the joiner's exact value
  // would be (n+1)*mean(n+1) - n*mean(n), with no error term. It is a median,
  // rounded, so a whole range of joiner values is indistinguishable.
  const before = [20, 30, 40, 50, 60];

  scriptCohort({ night: NIGHT, peers: before });
  const baseline = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  const baseMedian = baseline.find((f) => f.id === 'cohort_night_median').value.medianReading;

  const observed = new Set();
  for (let joiner = 50; joiner <= 100; joiner++) {
    scriptCohort({ night: NIGHT, peers: [...before, joiner] });
    const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
    const f = out.find((x) => x.id === 'cohort_night_median');
    observed.add(JSON.stringify(f.value));
    assert.strictEqual(f.value.reportingVenues, 6);
  }
  assert.strictEqual(observed.size, 1,
    'every joiner from 50 to 100 yields the identical published payload: the observation does not identify the value');

  // And the one thing the observer does learn is bounded: the median moved to
  // the next order statistic, never to the joiner's own number.
  const after = JSON.parse([...observed][0]).medianReading;
  assert.notStrictEqual(after, 100);
  assert.ok(Math.abs(after - baseMedian) <= advisorCohort.MEDIAN_ROUND_TO * 2,
    'one arrival moves the published median by at most a bounded step, never by the joiner value');
});

test('differencing: a departure that drops the set under the floor refuses, it does not thin out', async () => {
  scriptCohort({ night: NIGHT, peers: [20, 30, 40, 50, 60] });
  const atFloor = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(atFloor.some((f) => f.id === 'cohort_night_median'), 'five others is the floor and it publishes');

  scriptCohort({ night: NIGHT, peers: [20, 30, 40, 50] });
  const under = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(!under.some((f) => f.id === 'cohort_night_median'));
  assert.ok(under.some((e) => advisorFacts.isRefusal(e) && e.id === 'refuse_cohort_thin_reporters'));
});

test('differencing: the asking venue is excluded from its own cohort, and the cohort key has no knobs', async () => {
  scriptCohort({ night: NIGHT, peers: [30, 35, 40, 45, 50, 55] });
  queryLog = [];
  await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });

  const agg = queryLog.find((q) => /WITH reporters AS/.test(q.sql));
  assert.ok(agg, 'the aggregate query ran');
  assert.match(agg.sql, /r\.google_place_id <> \$3/, 'the asking venue is excluded, so no value in the median is one it already knows');
  assert.match(agg.sql, /vp\.verified = true/, 'only claimed and verified venues report');
  assert.match(agg.sql, /retracted = false/);
  // City, category and the band are all server-derived. The exclusion id is
  // the caller's own place id, which is not a knob either.
  assert.deepStrictEqual(agg.params.slice(0, 3), ['lehigh', 'bar', PLACE_ID]);
  assert.deepStrictEqual(agg.params.slice(5), [21, 23], 'the band is the fixed grid block, not a movable window');

  // Only aggregates cross the SQL boundary: the projection is a count and a
  // percentile, so no per-venue reading exists in this process to leak.
  assert.match(agg.sql, /SELECT COUNT\(\*\)::int AS venues, percentile_cont/);
  assert.ok(!/SELECT r\.google_place_id AS pid, MAX\(r\.busy_percent\)[^)]*\)\s*$/.test(agg.sql));
});

test('the band grid is fixed and shared, so two venues bands are identical or disjoint', () => {
  for (let h = 0; h < 24; h++) {
    const b = advisorCohort.bandFor(h);
    assert.strictEqual(b.from % advisorCohort.BAND_HOURS, 0, 'every band starts on the grid');
    assert.strictEqual(b.to - b.from, advisorCohort.BAND_HOURS - 1);
    assert.ok(h >= b.from && h <= b.to);
  }
  // Two different peak hours inside one block share the block exactly; two in
  // different blocks share nothing. A window that could slide by one hour
  // would isolate whoever reported in that hour.
  assert.deepStrictEqual(advisorCohort.bandFor(21), advisorCohort.bandFor(23));
  assert.notDeepStrictEqual(advisorCohort.bandFor(20), advisorCohort.bandFor(21));
});

test('the floor is higher than the house floor for people, and the reason is venues are identifiable', () => {
  const crowdEngine = require('../services/crowdEngine');
  assert.ok(advisorCohort.MIN_COHORT_REPORTERS > crowdEngine.MIN_CALIBRATION_REPORTERS,
    'a statistic over an enumerable population needs a higher floor than one over an anonymous one');
  assert.strictEqual(advisorCohort.MIN_COHORT_REPORTERS, 5);
});

// ═══ NO NAMES, ANYWHERE ═════════════════════════════════════════════════════

test('no venue name reaches a payload, and no cohort query even selects one', async () => {
  scriptCohort({
    cell: Array.from({ length: 20 }, (_, i) => 5 + i * 4),
    night: NIGHT,
    peers: [30, 35, 40, 45, 50, 55],
    typical: Array.from({ length: 12 }, (_, i) => 20 + i * 4),
  });
  const c = await ctx();
  queryLog = [];
  const out = [
    ...await advisorFacts.buildCohortSameNight(c, { now: NOW }),
    ...await advisorFacts.buildCohortStanding(c, { now: NOW }),
  ];

  const text = JSON.stringify(out);
  for (const n of NEIGHBOUR_NAMES) assert.ok(!text.includes(n), `a neighbour name leaked: ${n}`);
  assert.ok(!text.includes(MY_NAME), 'not even the asking venue is named: nothing here needs a name');
  assert.ok(!text.includes(PLACE_ID), 'no place id in a payload either');

  for (const q of queryLog) {
    assert.ok(!/\bname\b/i.test(q.sql), `a cohort query selects a name column: ${q.sql.slice(0, 120)}`);
  }
});

test('the cohort engine reads only: no write path, and no ranking of venues', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'advisorCohort.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(code), 'the cohort engine writes nothing');
  // An ORDER BY inside a percentile is the aggregate's own ordering. An ORDER
  // BY that leaves the query with rows attached is a leaderboard.
  assert.ok(!/ORDER BY peak\)?\s*(DESC|ASC)?\s*LIMIT/i.test(code), 'no ranked list of venues');
});

// ═══ SLOP-AUDIT ═════════════════════════════════════════════════════════════

test('no owner-visible cohort string carries an em dash or a class word', async () => {
  scriptCohort({
    cell: Array.from({ length: 20 }, (_, i) => 5 + i * 4),
    night: NIGHT,
    peers: [30, 35, 40, 45, 50, 55],
    typical: Array.from({ length: 12 }, (_, i) => 20 + i * 4),
  });
  const c = await ctx();
  const all = [
    ...await advisorFacts.buildCohortSameNight(c, { now: NOW }),
    ...await advisorFacts.buildCohortStanding(c, { now: NOW }),
  ];
  // And the refusal branches, which carry the most copy.
  scriptCohort({ cell: [10, 20, 30], night: NIGHT, peers: [10, 20] });
  all.push(...await advisorFacts.buildCohortSameNight(c, { now: NOW }));
  all.push(...await advisorFacts.buildCohortStanding(c, { now: NOW }));
  all.push({ chip: advisorPhrasing.ADVISOR_INTENTS.cohort_same_night.chip });
  all.push({ chip: advisorPhrasing.ADVISOR_INTENTS.cohort_typical.chip });

  for (const s of strings(all)) {
    assert.ok(!s.includes('—'), `em dash in cohort copy: "${s}"`);
    assert.ok(!/seamless|effortless|unlock deeper|personalize your experience/i.test(s), `class word: "${s}"`);
  }
});

test('cohort copy states covariation, never causation', async () => {
  scriptCohort({
    cell: Array.from({ length: 20 }, (_, i) => 5 + i * 4),
    night: NIGHT,
    peers: [30, 35, 40, 45, 50, 55],
    typical: Array.from({ length: 12 }, (_, i) => 20 + i * 4),
  });
  const c = await ctx();
  const all = [
    ...await advisorFacts.buildCohortSameNight(c, { now: NOW }),
    ...await advisorFacts.buildCohortStanding(c, { now: NOW }),
  ];
  // The refusal branches carry the most prose, so they are scanned too.
  scriptCohort({ cell: [10, 20, 30], night: NIGHT, peers: [10, 20] });
  all.push(...await advisorFacts.buildCohortSameNight(c, { now: NOW }));
  all.push(...await advisorFacts.buildCohortStanding(c, { now: NOW }));
  scriptCohort({ cell: null, night: null, peers: null });
  all.push(...await advisorFacts.buildCohortSameNight(c, { now: NOW }));
  for (const s of strings(all)) {
    assert.ok(!/\b(because|due to|caused|thanks to|explains|driven by)\b/i.test(s), `causal verb in cohort copy: "${s}"`);
  }
});

// ═══ THE ROUTE AND THE REGISTRY ═════════════════════════════════════════════

test('GET /cards carries the cohort card, with both halves on it', async () => {
  scriptCohort({
    cell: Array.from({ length: 20 }, (_, i) => 5 + i * 4),
    night: NIGHT,
    peers: [30, 35, 40, 45, 50, 55],
  });
  const r = await getJson('/api/venue/advisor/cards');
  assert.strictEqual(r.status, 200);
  const card = r.body.cards.find((cd) => cd.id === 'cohort');
  assert.ok(card, 'the cohort card is served');
  assert.strictEqual(card.status, 'ok');
  const ids = card.facts.map((f) => f.id);
  assert.ok(ids.includes('cohort_night_median'), 'half B is on the card');
  assert.ok(ids.includes('cohort_your_standing'), 'half A is on the card');
});

test('GET /questions offers both cohort chips, and the same-night one leads', async () => {
  scriptCohort({ night: NIGHT, peers: [30, 35, 40, 45, 50, 55] });
  const r = await getJson('/api/venue/advisor/questions');
  assert.strictEqual(r.status, 200);
  const served = [...r.body.lead.map((q) => q.id), ...r.body.groups.flatMap((g) => g.questions.map((q) => q.id))];
  assert.ok(served.includes('cohort_same_night'));
  assert.ok(served.includes('cohort_typical'));
  assert.ok(r.body.lead.some((q) => q.id === 'cohort_same_night'),
    'the highest engagement question in the category is inside the visible four');
});

test('POST /ask keeps the density refusal as the answer instead of dropping it as a partial', async () => {
  scriptCohort({ night: NIGHT, peers: [30, 40, 50, 60] }); // under the floor
  const r = await getJson('/api/venue/advisor/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentId: 'cohort_same_night' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.mode || r.body.mode, 'refusal');
  assert.match(r.body.text, new RegExp(String(advisorCohort.MIN_COHORT_REPORTERS)));
  assert.match(r.body.text, /posting readings/i);
  assert.ok(!/\b20\b/.test(r.body.text), "the owner's own reading is not passed off as an answer to a question about the street");
});

test('POST /ask on the typicals chip answers today, dated, from the frozen corpus', async () => {
  scriptCohort({ cell: Array.from({ length: 20 }, (_, i) => 5 + i * 4) });
  const r = await getJson('/api/venue/advisor/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentId: 'cohort_typical' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mode, 'template');
  assert.match(r.body.text, /2026-05-18/);
  assert.ok(r.body.sources.every((s) => s.source === 'corpus'));
});
