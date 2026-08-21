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
//     4. At or above the floor of five OTHER reporting OWNERS, the payload is a
//        rounded middle reading and a CONSTANT floor on the count. Never a
//        figure that tracks how many reported, no minimum, no maximum, no
//        spread, no id, no name, no per-venue value of any kind.
//     5. Below the floor, it refuses, the refusal names the floor and the
//        density path, and it never states how many venues actually reported.
//     6. THE DIFFERENCING ATTACK, where the attacker WATCHES a cohort. A venue
//        joining or leaving the reporting set may not reveal an individual's
//        reading. Pinned three ways: the statistic is an order statistic and
//        not a mean, a whole range of joiner values produces one identical
//        published payload, and a set that drops under the floor refuses
//        instead of publishing a thinner number.
//     6b. THE SANDWICH, where the attacker BUILDS the cohort. Four controlled
//        venues at the extremes and a fifth to ask from used to make the
//        published median equal the one honest venue's reading, for every
//        target value from 0 to 100. Pinned by sweeping all 101 of them and by
//        proving the refusal is identical with and without the target so the
//        on/off transition carries no bit.
//     6c. THE THREE FINDINGS OF 2026-08-20, each reproduced as the attack it
//        was before it is asserted closed:
//          A. the support gate refused the most anonymous distributions and
//             published the least anonymous ones, and its publish rate FELL as
//             a cohort grew.
//          B. rotating which controlled venue asks was the one-element set
//             difference the header called impossible. Five controlled venues,
//             five cards, eleven classes over the honest reading.
//          C. the shipped "median" was a MEAN whenever the reporter count was
//             even, so the target fell out as 2*published - known.
//          D. the bucketed reporter count disclosed one named venue's
//             participation exactly on a boundary crossing.
//     6d. THE PROMISE, searched rather than argued: over thousands of
//        controlled configurations, no observable outcome isolates an honest
//        reading to finer than half the publishing grid.
//     6e. HONEST AVAILABILITY, measured and pinned, so a future tightening
//        cannot quietly strangle the feature, and MONOTONE in cohort size.
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

// percentile_cont(0.5), exactly as Postgres computes it. Kept ONLY so the
// regression test for finding C can show what the shipped statistic used to do
// on an even reporter count. Nothing in the module calls this shape any more.
function pctCont(values, p = 0.5) {
  const sorted = [...values].sort((a, z) => a - z);
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// percentile_disc(0.5): the lower of the two middle readings on an even count,
// and always a value some reporter actually posted. Guard 1.
function pctDisc(values) {
  const sorted = [...values].sort((a, z) => a - z);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)];
}

// The asking owner's user id, which is now INSIDE the cohort rather than
// excluded from it. Guard 4.
const ASKING_OWNER = 11;

/**
 * What the reporters query computes, done the same way Postgres does it, so the
 * fixtures and the module agree on owners, middle reading and support.
 *
 * `peers` is either a list of numbers, one per OTHER owner, or a list of
 * { owner, peak } rows, which is how the owner-collapse cases are written.
 * `own` is the asking venue's own reading, which the query no longer excludes.
 */
function aggregateFrom(peers, own = null) {
  const byOwner = new Map();
  if (own != null) byOwner.set(ASKING_OWNER, own);
  (peers || []).forEach((p, i) => {
    const owner = (p && typeof p === 'object') ? p.owner : 1000 + i;
    const peak = (p && typeof p === 'object') ? p.peak : p;
    const held = byOwner.get(owner);
    byOwner.set(owner, held === undefined ? peak : Math.max(held, peak));
  });
  const values = [...byOwner.values()];
  const median = values.length ? pctDisc(values) : null;
  const grid = advisorCohort.MEDIAN_ROUND_TO;
  const published = median == null ? null : Math.round(median / grid) * grid;
  return {
    owners: values.length,
    you: byOwner.has(ASKING_OWNER) ? 1 : 0,
    median_peak: median,
    // Bucket equality, which is what the SQL asks: does this reading round to
    // the number the card is about to print.
    at_value: published == null ? 0
      : values.filter((v) => Math.round(v / grid) * grid === published).length,
  };
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
    [/SELECT day_of_week, hour, baseline.* FROM ml_venue_baselines/, () => ({ rows: ownCurveRows() })],
    // Half B's own-night read.
    [/AS night, EXTRACT\(HOUR/, () => ({
      rows: night ? [{ night: night.night, hour: night.hour, reading: night.reading }] : [],
    })],
    // Half B's cohort aggregate, aggregated before it leaves SQL: one row per
    // OWNER, an order statistic over those, and a count of how many of them
    // posted a reading that rounds to the number that would be published. The
    // asking venue's own reading is one of the rows (guard 4), so the fake
    // feeds it in the way the query would find it.
    [/WITH reporters AS/, () => ({ rows: [aggregateFrom(peers, night ? night.reading : null)] })],
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

// ── Simulation helpers ──────────────────────────────────────────────────────
//
// Deterministic on purpose. A privacy bound measured with Math.random is a
// bound that passes on one run and fails on the next, and an availability floor
// measured that way flickers in CI until somebody deletes it.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One simulated night on one street: a level the whole block moves with, plus
 * per-venue noise. There are no real cohorts yet, so this is a model and it is
 * labelled as one. What it is used for is the SHAPE of the availability curve
 * and a floor under it, not a prediction.
 */
function street(rand, n, sigma) {
  const level = 15 + rand() * 70;
  return Array.from({ length: n }, () => (
    Math.max(0, Math.min(100, Math.round(level + gaussian(rand) * sigma)))
  ));
}

/**
 * The support rule that shipped on 2026-08-19 and was replaced on 2026-08-20,
 * ported so the attacks below can be shown landing on it: percentile_cont over
 * a set the asking venue is EXCLUDED from, a five point grid, a fifteen point
 * support window, and either a flank on each side or a globally tight set.
 */
function legacyDecide(set) {
  if (set.length < 5) return 'refused';
  const published = Math.round(pctCont(set) / 5) * 5;
  const near = set.filter((v) => Math.abs(v - published) <= 15);
  const below = near.filter((v) => (published - v) * 2 > 5).length;
  const above = near.filter((v) => (v - published) * 2 > 5).length;
  const atValue = near.filter((v) => Math.abs(v - published) * 2 <= 5).length;
  const tight = (Math.max(...set) - Math.min(...set)) <= 15;
  const ok = near.length >= 3 && ((below >= 1 && above >= 1) || (atValue >= 3 && tight));
  return ok ? `published:${published}` : 'refused';
}

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
const GRID = advisorCohort.MEDIAN_ROUND_TO;
const K = advisorCohort.MIN_MEDIAN_SUPPORT;
const FLOOR = advisorCohort.MIN_COHORT_REPORTERS;

// Six other owners which, together with the asking venue's own 20, put three
// readings inside one grid bucket. Guard 8 is the publishing condition now, so
// a fixture that is meant to publish has to satisfy it on purpose: 38, 41 and
// 43 all round to 40.
const PEERS_OK = [38, 41, 43, 55, 60, 65];

/** The decision the module makes, as one expression, over the WHOLE set. */
function decide(all) {
  if (all.length - 1 < FLOOR) return 'refused';
  const P = advisorCohort.roundToGrid(pctDisc(all));
  const atValue = all.filter((v) => advisorCohort.bucketOf(v) === P).length;
  return atValue >= K ? `published:${P}` : 'refused';
}

test('half B publishes a middle reading and a constant floor once the floor is cleared, and nothing else', async () => {
  scriptCohort({ night: NIGHT, peers: PEERS_OK });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });

  const median = out.find((f) => f.id === 'cohort_night_median');
  assert.ok(median, 'the cohort fact publishes above the floor');
  assert.strictEqual(median.source, 'cohort_reported');
  // Six others reported and the card says "at least five", which is the FLOOR
  // and not a figure that tracks the count. Guard 6.
  assert.strictEqual(median.value.otherVenuesAtLeast, FLOOR);
  assert.ok(!('reportingVenues' in median.value), 'the exact reporter count is not published');
  assert.match(median.label, /You and at least 5 other/);
  assert.ok(!/\b6\b/.test(median.label), 'the sentence does not print the exact count either');
  // The middle reading is an order statistic over the whole set, the asking
  // venue's own reading included, rounded to the publishing grid.
  const all = [NIGHT.reading, ...PEERS_OK];
  assert.strictEqual(median.value.medianReading, advisorCohort.roundToGrid(pctDisc(all)));
  assert.strictEqual(median.value.medianReading, 40);
  assert.strictEqual(median.value.yourReadingCounted, true);

  // The payload is a closed set of keys. Anything resembling an extreme, a
  // spread or an identity is a re-identification vector, so the shape is
  // pinned rather than merely reviewed.
  assert.deepStrictEqual(
    Object.keys(median.value).sort(),
    ['hourFrom', 'hourTo', 'medianReading', 'night', 'otherVenuesAtLeast', 'weekday', 'yourReadingCounted']
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
  // The night is a database value in `value` and a date in the sentence. Roost
  // prints "Aug 14" on every other card, so a raw ISO string here would be the
  // column name leaking into copy.
  assert.doesNotMatch(mine.label, /\d{4}-\d{2}-\d{2}/,
    'the cohort sentence must not print the column value');
  assert.match(mine.value.night, /^\d{4}-\d{2}-\d{2}$/, 'the machine field keeps the ISO form');
});

test('half B never publishes a minimum, a maximum, a spread, a mean or a total', async () => {
  scriptCohort({ night: NIGHT, peers: [5, 38, 40, 44, 62, 99] });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(out.some((f) => f.id === 'cohort_night_median'), 'this fixture is on the publishing branch');
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

  const floor = String(FLOOR);
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
  // Nor which of the two gates bit. See "one refusal, one sentence".
  assert.match(refusal.whatWouldUnlock, /which of those two conditions/i);
});

test('a DATE column arrives as a Date and still reads as the day it was', async () => {
  // pg hands back a Date at LOCAL midnight for a DATE column. String()ing it
  // yields "Thu Aug 14 2026 ..." and toISOString() rolls the day backwards
  // anywhere east of Greenwich, so both of the obvious readings are wrong.
  assert.strictEqual(advisorCohort.toDateStr(new Date(2026, 7, 14)), '2026-08-14');
  assert.strictEqual(advisorCohort.toDateStr('2026-08-14'), '2026-08-14');

  scriptCohort({ night: { ...NIGHT, night: new Date(2026, 7, 14) }, peers: PEERS_OK });
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
    [/WITH reporters AS/, () => ({ rows: [{ owners: 8, you: 1, median_peak: 33, at_value: 4 }] })],
  ];
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(out.some((f) => f.id === 'cohort_night_median'),
    'the half that grows with users does not wait on our collection runs');
});

test('the supplementary frozen typical is dated, hedged, and simply absent when thin', async () => {
  const typical = Array.from({ length: 14 }, (_, i) => 30 + i * 3);
  scriptCohort({ night: NIGHT, peers: PEERS_OK, typical });
  const withIt = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  const t = withIt.find((f) => f.id === 'cohort_band_typical');
  assert.ok(t);
  assert.strictEqual(t.source, 'corpus');
  assert.strictEqual(t.asOf, advisorFacts.CORPUS_AS_OF);
  assert.match(t.label, /spring 2026/i);
  assert.match(t.note, /not a measurement/i);

  scriptCohort({ night: NIGHT, peers: PEERS_OK, typical: null });
  const without = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(!without.some((f) => f.id === 'cohort_band_typical'),
    'a thin corpus cell drops the supplementary fact rather than refusing a card that answered');
});

// ═══ THE DIFFERENCING ATTACK ════════════════════════════════════════════════

test('differencing: fifty-one different joiner values produce one identical payload', async () => {
  // The attacker knows the set before the join and watches the published
  // number after it. If the statistic were a mean, the joiner's exact value
  // would be (n+1)*mean(n+1) - n*mean(n), with no error term. It is an order
  // statistic, rounded, so a whole range of joiner values is indistinguishable.
  const before = [38, 41, 43, 55, 60];

  scriptCohort({ night: NIGHT, peers: before });
  const baseline = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  const baseMedian = baseline.find((f) => f.id === 'cohort_night_median').value.medianReading;

  const observed = new Set();
  for (let joiner = 50; joiner <= 100; joiner++) {
    scriptCohort({ night: NIGHT, peers: [...before, joiner] });
    const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
    const f = out.find((x) => x.id === 'cohort_night_median');
    observed.add(JSON.stringify(f.value));
    assert.strictEqual(f.value.otherVenuesAtLeast, FLOOR,
      'the joiner does not move the published count either: the card names the floor, not the count');
  }
  assert.strictEqual(observed.size, 1,
    'every joiner from 50 to 100 yields the identical published payload: the observation does not identify the value');

  // And the one thing the observer does learn is bounded: the statistic moved
  // to the next reading in the sort, never to the joiner's own number.
  const after = JSON.parse([...observed][0]).medianReading;
  assert.notStrictEqual(after, 100);
  assert.ok(Math.abs(after - baseMedian) <= GRID * 2,
    'one arrival moves the published value by at most a bounded step, never by the joiner value');
});

test('differencing: a departure that drops the set under the floor refuses, it does not thin out', async () => {
  scriptCohort({ night: NIGHT, peers: [38, 41, 43, 55, 60] });
  const atFloor = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(atFloor.some((f) => f.id === 'cohort_night_median'), 'five others is the floor and it publishes');

  scriptCohort({ night: NIGHT, peers: [38, 41, 43, 55] });
  const under = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(!under.some((f) => f.id === 'cohort_night_median'));
  assert.ok(under.some((e) => advisorFacts.isRefusal(e) && e.id === 'refuse_cohort_thin_reporters'));
});

test('the cohort key has no knobs, and the cohort itself no longer has one either', async () => {
  scriptCohort({ night: NIGHT, peers: PEERS_OK });
  queryLog = [];
  await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });

  const agg = queryLog.find((q) => /WITH reporters AS/.test(q.sql));
  assert.ok(agg, 'the aggregate query ran');
  // FINDING B. The asking venue used to be excluded by place id and its owner
  // by user id, and that exclusion was the caller-selected one-element set
  // difference. Membership is now a pure function of the cell.
  assert.ok(!/r\.google_place_id <> /.test(agg.sql),
    'no place-id exclusion: the caller must not be able to choose which venue is missing');
  assert.ok(!/IS DISTINCT FROM/.test(agg.sql),
    'no owner exclusion either, for the same reason');
  assert.match(agg.sql, /vp\.verified = true/, 'only claimed and verified venues report');
  assert.match(agg.sql, /retracted = false/);
  assert.match(agg.sql, /GROUP BY vp\.user_id/, 'one row per owner, not one row per venue');
  // The asking owner is still COUNTED separately, so the floor can be stated in
  // owners other than you without changing who is in the set.
  assert.match(agg.sql, /FILTER \(WHERE owner IS NOT DISTINCT FROM \$7::int\)/);

  // City, category and the band are all server-derived.
  assert.deepStrictEqual(agg.params.slice(0, 2), ['lehigh', 'bar']);
  assert.deepStrictEqual(agg.params.slice(4, 6), [21, 23], 'the band is the fixed grid block, not a movable window');
  assert.strictEqual(agg.params[6], 11, 'the asking owner is identified so it can be counted, not removed');
  assert.strictEqual(agg.params[7], GRID, 'the support test runs on the same grid the card prints');
  assert.ok(!agg.params.includes(PLACE_ID), 'the asking place id is not a parameter of the cohort at all');

  // Only aggregates cross the SQL boundary: the projection is three counts and
  // one order statistic, so no per-venue reading exists in this process to
  // leak. FINDING C: percentile_disc, never percentile_cont.
  assert.match(agg.sql, /percentile_disc\(0\.5\) WITHIN GROUP \(ORDER BY peak\)/);
  assert.ok(!/percentile_cont/.test(agg.sql), 'an interpolating median is a mean on an even count');
  assert.match(agg.sql, /AS at_value/);
  assert.ok(!/AS support\b/.test(agg.sql), 'the windowed support total is gone');
  assert.ok(!/AS tight\b/.test(agg.sql), 'and so is the whole-set spread comparison');
  // The support count has to be measured around the number the owner actually
  // sees. round() on a double breaks ties to EVEN while roundToGrid, which is
  // Math.round, breaks them upward, so the cast is load-bearing.
  assert.match(agg.sql, /ROUND\(median_peak::numeric \/ \$8::numeric\)/,
    'the middle reading is cast to numeric before rounding, so the guard and the card agree on the value');
  assert.match(agg.sql, /ROUND\(n\.peak \/ \$8::numeric\) \* \$8::numeric = s\.grid/,
    'support is bucket equality, not a distance test');
});

// ═══ FINDING A: THE SUPPORT GATE WAS INVERTED ═══════════════════════════════
//
// The gate that shipped refused the distributions where the published number
// described the most reporters, and published the ones where it described one.
// Its concentration branch was `atValue >= 3 AND (MAX - MIN) <= 15` over ALL
// reporters, so a single quiet venue anywhere in the cell killed it, and
// everything rested on the flank branch instead.

async function publishesFor(own, peers) {
  scriptCohort({ night: { ...NIGHT, reading: own }, peers });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  const f = out.find((x) => x.id === 'cohort_night_median');
  return f ? f.value.medianReading : null;
}

test('finding A: the distribution eight of ten owners agree on is published, not refused', async () => {
  // Ten owners, eight of them sitting exactly on the published value, one dead
  // venue and one packed one. The old gate REFUSED this, because 95 - 20 is
  // more than fifteen. It is the most anonymous shape this cohort can have.
  const published = await publishesFor(70, [20, 70, 70, 70, 70, 70, 70, 70, 95]);
  assert.strictEqual(published, 70, 'eight owners on one number is exactly what k-anonymity looks like');

  // Seven owners, six of them on one number, one quiet. Refused before.
  const alsoPublished = await publishesFor(45, [10, 45, 45, 45, 45, 45]);
  assert.ok(alsoPublished != null, 'six owners on one number is not a privacy problem, it is the point');

  // And the inverse: six owners with exactly ONE reading in the published
  // bucket used to publish through the flank branch. It does not now.
  const thin = await publishesFor(60, [45, 52, 68, 75, 80]);
  assert.strictEqual(thin, null, 'a value only one reporter could have posted names that reporter');
});

test('finding A: the support gate is monotone in cohort size, which the old one was not', () => {
  // A gate whose publish rate FALLS as the population grows is the defect, and
  // it is not obvious from reading either rule. It is measured here so that a
  // future "stronger" condition, majority or supermajority or spread, cannot
  // reintroduce it quietly.
  const rate = (n) => {
    const rand = lcg(20260820 + n);
    let published = 0;
    for (let t = 0; t < 4000; t += 1) {
      published += decide(street(rand, n, 12)) === 'refused' ? 0 : 1;
    }
    return published / 4000;
  };
  const sizes = [6, 8, 10, 12, 15, 20, 30];
  const rates = sizes.map(rate);
  for (let i = 1; i < rates.length; i += 1) {
    assert.ok(rates[i] >= rates[i - 1] - 0.01,
      `publish rate fell from ${sizes[i - 1]} owners (${rates[i - 1].toFixed(3)}) to ${sizes[i]} (${rates[i].toFixed(3)})`);
  }
  assert.ok(rates[rates.length - 1] > 0.98, 'a full cohort answers essentially every night');
});

// ═══ FINDING B: ROTATING WHICH VENUE ASKS ═══════════════════════════════════
//
// Five verified venues under five accounts in one city and category. Each of
// them asks the same chip about the same night. The old cohort excluded the
// asking venue, so the five cards were five different set differences of the
// same reporting set, and the five-tuple of answers identified the one honest
// reading. The precondition is expensive and it is not out of reach: venue
// verification is admin-gated, which is a cost, not a wall.

/** The five cards a coalition of `jaws` sees, one per controlled venue. */
async function rotate(jaws, target) {
  const cards = [];
  for (let i = 0; i < jaws.length; i += 1) {
    const peers = [...jaws.filter((_, j) => j !== i)];
    if (target != null) peers.push(target);
    scriptCohort({ night: { ...NIGHT, reading: jaws[i] }, peers });
    const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
    const f = out.find((x) => x.id === 'cohort_night_median');
    cards.push(f ? `published:${f.value.medianReading}` : 'refused');
  }
  return cards;
}

test('finding B: rotating the asking venue no longer produces five different cohorts', async () => {
  // The brief's worked example, straight from a real Postgres against the old
  // build: jaws at 0, 20, 30, 40, 60 and a competitor reading of 25 answered
  // 30, 30, 25, 25, 25. Two of those five cards printed the competitor's own
  // number. The second set is one that PUBLISHES, so this is not passing on the
  // strength of five identical refusals.
  for (const jaws of [[0, 20, 30, 40, 60], [45, 45, 50, 55, 55]]) {
    for (const target of [25, 35, 50, 70]) {
      const cards = await rotate(jaws, target);
      assert.strictEqual(new Set(cards).size, 1,
        `rotating the asker produced ${new Set(cards).size} distinct answers for a target of ${target}`);
      assert.ok(!cards.includes(`published:${advisorCohort.roundToGrid(target)}`)
        || jaws.some((j) => advisorCohort.bucketOf(j) === advisorCohort.roundToGrid(target)),
        'and no card lands on the competitor\'s own bucket unless the coalition was already sitting in it');
    }
  }
  const publishing = await rotate([45, 45, 50, 55, 55], 25);
  assert.ok(publishing.every((c) => c.startsWith('published:')), 'this jaw set does answer');
});

test('finding B: the five-tuple no longer partitions the honest reading into eleven classes', async () => {
  // The attack itself first, run against the rule and the exclusion that
  // shipped, so what follows is a comparison rather than an assertion about
  // nothing. Five controlled venues, each one asking in turn, five answers.
  const legacyRotation = new Map();
  for (let target = 0; target <= 100; target += 1) {
    const jaws = [0, 20, 30, 40, 60];
    const key = jaws.map((_, i) => legacyDecide([...jaws.filter((_, j) => j !== i), target])).join(',');
    if (!legacyRotation.has(key)) legacyRotation.set(key, []);
    legacyRotation.get(key).push(target);
  }
  assert.strictEqual(legacyRotation.size, 11,
    'the design this replaced separated the honest reading into eleven classes');
  assert.ok(Math.min(...[...legacyRotation.values()].map((t) => t.length)) <= 3,
    'and the narrowest of them was three index points wide');

  for (const jaws of [[0, 20, 30, 40, 60], [45, 45, 50, 55, 55]]) {
    const classes = new Map();
    for (let target = 0; target <= 100; target += 1) {
      const key = (await rotate(jaws, target)).join(',');
      if (!classes.has(key)) classes.set(key, []);
      classes.get(key).push(target);
    }
    // Eleven before, several of them three to five points wide.
    assert.ok(classes.size <= 4,
      `the coalition can still separate the honest reading into ${classes.size} classes`);
    for (const [key, targets] of classes) {
      assert.ok(targets.length >= GRID / 2,
        `an observable outcome (${key}) isolates the honest reading to ${targets.length} index points`);
    }
  }
});

// ═══ FINDING C: THE "MEDIAN" WAS A MEAN ON AN EVEN COUNT ════════════════════

test('finding C: an even reporter count no longer interpolates between two real readings', async () => {
  // percentile_cont(0.5) over [0, 0, 62, 70, 72, 100] returns 66, the mean of
  // the two middle readings, verified against a real Postgres. A mean of two is
  // exactly invertible, which is the one thing guard 1 says a published
  // statistic may never be.
  const six = [0, 0, 62, 70, 72, 100];
  assert.strictEqual(pctCont(six), 66, 'this is what the shipped statistic did');
  assert.strictEqual(pctDisc(six), 62, 'and this is a reading somebody actually posted');

  // Worked inversion: five controlled readings and one target, an even count,
  // so the target and one jaw are the two middle values. Under the old
  // statistic the target falls out of the published number by arithmetic.
  const jaw = 100;
  const target = 44;
  const set = [36, 38, target, jaw, jaw, jaw];
  assert.strictEqual(2 * pctCont(set) - jaw, target,
    'the old statistic hands the target back exactly, given one of the two middles');

  // What ships now: the lower of the two middles, rounded to the grid, and no
  // arithmetic on it recovers anything.
  scriptCohort({ night: { ...NIGHT, reading: 36 }, peers: [38, target, jaw, jaw, jaw] });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  const f = out.find((x) => x.id === 'cohort_night_median');
  assert.ok(f, 'three readings round to 40, so this set is publishable');
  assert.strictEqual(f.value.medianReading, advisorCohort.roundToGrid(pctDisc(set)));
  assert.strictEqual(f.value.medianReading, 40);
  assert.notStrictEqual(f.value.medianReading, advisorCohort.roundToGrid(pctCont(set)));
  assert.notStrictEqual(2 * f.value.medianReading - jaw, target);
});

// ═══ FINDING D: THE COUNT BAND DISCLOSED PARTICIPATION ══════════════════════

test('finding D: one named venue joining a coalition-supplied cohort changes nothing on the card', async () => {
  // Nine controlled owners clustered at 45, 50 and 55, which guarantees support
  // whatever anybody else reports. With the honest neighbour the count is ten
  // and the old card said "at least 10"; without them it is nine and the old
  // card said "at least 5". That difference is that named venue's
  // participation, stated exactly, and no bucket width fixes it.
  const controlled = [45, 45, 50, 50, 50, 55, 55, 55];

  scriptCohort({ night: { ...NIGHT, reading: 50 }, peers: controlled });
  const without = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });

  scriptCohort({ night: { ...NIGHT, reading: 50 }, peers: [...controlled, 70] });
  const withThem = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });

  const cardOf = (o) => o.find((f) => f.id === 'cohort_night_median');
  assert.ok(cardOf(without) && cardOf(withThem), 'both sides of the comparison publish');
  assert.deepStrictEqual(cardOf(withThem).value, cardOf(without).value,
    'the payload does not move when one named venue joins');
  assert.strictEqual(cardOf(withThem).label, cardOf(without).label,
    'and neither does the sentence');
  assert.strictEqual(cardOf(withThem).value.otherVenuesAtLeast, FLOOR,
    'the count sentence is the floor, which is a constant');
});

// ═══ THE FIVE-VENUE SANDWICH ════════════════════════════════════════════════
//
// The differencing tests above all assume the attacker is WATCHING a cohort
// they do not control. This block assumes they built it. Five verified venues
// in one city and category is a high precondition and it is not an impossible
// one, and every guard against inversion is useless against positioning: an
// order statistic cannot be inverted, but it can be placed.

test('the sandwich: readings at the extremes cannot make the published number follow the target', async () => {
  // Before guard 8 existed, the published median WAS the target's reading for
  // every target in 0..100: sorted, [0, 0, t, 100, 100] has t in the middle and
  // the card printed it rounded to the grid. The assertion is not "it refuses",
  // it is stronger: what the card shows does not depend on the target at all.
  const seen = new Set();
  for (let target = 0; target <= 100; target += 1) {
    scriptCohort({ night: { ...NIGHT, reading: 0 }, peers: [0, 0, 100, 100, target] });
    const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
    const f = out.find((x) => x.id === 'cohort_night_median');
    seen.add(f ? `published:${f.value.medianReading}` : 'refused');
  }
  assert.strictEqual(seen.size, 1,
    'all 101 targets produce one observable outcome, so the probe returns no bits');
});

test('the sandwich: the on/off transition tells the attacker nothing about participation', async () => {
  // The refusal has to be identical whether or not the honest venue reported.
  // Otherwise the attacker reads the transition instead of the number: the old
  // shape answered with the target present and refused without it, which is
  // participation disclosure of one named neighbour.
  scriptCohort({ night: { ...NIGHT, reading: 0 }, peers: [0, 100, 100, 100, 60] });
  const withTarget = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  scriptCohort({ night: { ...NIGHT, reading: 0 }, peers: [0, 100, 100, 100] });
  const withoutTarget = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });

  const refusalOf = (entries) => entries.find((e) => advisorFacts.isRefusal(e));
  const a = refusalOf(withTarget);
  const b = refusalOf(withoutTarget);
  assert.ok(a && b, 'both refuse');
  assert.deepStrictEqual({ ...a }, { ...b },
    'the refusal is byte for byte the same, so the transition carries no bit');

  // And it does not say which of the two gates bit, which would be the same
  // leak one level up: "there were enough of you" is a fact about the set.
  const text = `${a.reason} ${a.whatWouldUnlock}`;
  assert.ok(!/\b(too few|only|enough of you)\b/i.test(text),
    'the refusal does not report which condition failed');
});

// ═══ THE PROMISE, SEARCHED RATHER THAN ARGUED ═══════════════════════════════

test('no coalition configuration resolves an honest reading finer than half the grid', async () => {
  // The one property this module promises. A coalition supplies every reading
  // in the cell but one, sweeps every value the honest reporter could have
  // posted, and records what the card shows. Every observable outcome, refusal
  // included, has to cover a run of index points at least half a grid step
  // wide. The design this replaced pins a reading to ONE index point, and the
  // second half of this test shows that by running the old rule over the same
  // configurations.
  const rand = lcg(4242);
  const pick = () => Math.round(rand() * 20) * 5;
  let worstNew = Infinity;
  let worstOld = Infinity;
  for (let trial = 0; trial < 400; trial += 1) {
    const size = 5 + Math.floor(rand() * 6);
    const jaws = Array.from({ length: size }, pick);
    const newClasses = new Map();
    const oldClasses = new Map();
    for (let target = 0; target <= 100; target += 1) {
      const asNew = decide([...jaws, target]);
      // The shipped-and-broken rule, ported: percentile_cont over a set the
      // asking venue is excluded from, a fifteen point window, a flank each
      // side or a globally tight set, and a five point grid. Rotation is what
      // made it worst, so it is rotated here too.
      const asOld = jaws.map((_, i) => legacyDecide([...jaws.filter((_, j) => j !== i), target])).join(',');
      if (!newClasses.has(asNew)) newClasses.set(asNew, 0);
      if (!oldClasses.has(asOld)) oldClasses.set(asOld, 0);
      newClasses.set(asNew, newClasses.get(asNew) + 1);
      oldClasses.set(asOld, oldClasses.get(asOld) + 1);
    }
    worstNew = Math.min(worstNew, ...newClasses.values());
    worstOld = Math.min(worstOld, ...oldClasses.values());
  }
  assert.ok(worstNew >= GRID / 2,
    `a coalition isolated an honest reading to ${worstNew} index points, finer than the ${GRID / 2} the card publishes`);
  assert.ok(worstOld < GRID / 2,
    'this search is supposed to break the design that shipped; if it does not, the port is wrong');
});

test('the search port agrees with the module it is standing in for', async () => {
  // The search above runs a one-line port for speed. It is only worth anything
  // if it decides the same way the real builder does, so a sample of the same
  // configurations is put through the actual query path and compared.
  const rand = lcg(99);
  for (let trial = 0; trial < 40; trial += 1) {
    const size = 5 + Math.floor(rand() * 6);
    const values = Array.from({ length: size + 1 }, () => Math.floor(rand() * 101));
    const own = values[0];
    const peers = values.slice(1);
    scriptCohort({ night: { ...NIGHT, reading: own }, peers });
    const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
    const f = out.find((x) => x.id === 'cohort_night_median');
    const actual = f ? `published:${f.value.medianReading}` : 'refused';
    assert.strictEqual(actual, decide(values),
      `port and module disagree on ${JSON.stringify(values)}`);
  }
});

// ═══ THE HONEST SPARSE COHORT STILL ANSWERS, AND BY HOW OFTEN ═══════════════

test('a genuine sparse cohort of six unrelated venues still gets its street number', async () => {
  // The point of the guards is to withhold a number that names somebody, not to
  // withhold the product. Six separate businesses on an ordinary Friday, with
  // the readings a real street produces, answer at the floor.
  const nights = [
    [38, 41, 43, 55, 60],
    [18, 19, 22, 30, 35],
    [40, 40, 40, 40, 40],   // a flat street: ties support their own middle
    [25, 28, 30, 33, 36],
    [58, 62, 64, 80, 90],
  ];
  for (const peers of nights) {
    scriptCohort({ night: NIGHT, peers });
    const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
    const median = out.find((f) => f.id === 'cohort_night_median');
    assert.ok(median, `an honest cohort of ${peers.join(',')} was refused`);
    assert.strictEqual(median.value.otherVenuesAtLeast, FLOOR);
    assert.strictEqual(median.value.medianReading,
      advisorCohort.roundToGrid(pctDisc([NIGHT.reading, ...peers])));
  }
});

test('the measured honest-night publish rate, so a future tightening cannot strangle this quietly', () => {
  // Simulated street: one night level the whole block moves with, plus
  // per-venue noise. There are no real cohorts yet to measure, so this is a
  // model and it is written down as one. What it is for is the SHAPE of the
  // curve and a floor under it: if somebody tightens guard 8 and these numbers
  // fall, the suite says so instead of the feature silently going quiet.
  //
  // Measured for the rule that shipped on 2026-08-20, noise of 12 points:
  //   6 owners 50%, 8 owners 71%, 10 owners 84%, 15 owners 97%.
  // The design this replaced published 75%, 89%, 96% and 100% on the same
  // draws, and pinned an honest reading to one index point while doing it.
  const measure = (n, sigma, seed) => {
    const rand = lcg(seed);
    let published = 0;
    for (let t = 0; t < 8000; t += 1) {
      if (decide(street(rand, n, sigma)) !== 'refused') published += 1;
    }
    return published / 8000;
  };
  const expected = [[6, 0.42], [8, 0.63], [10, 0.78], [15, 0.93]];
  for (const [n, floorRate] of expected) {
    const got = measure(n, 12, 5150 + n);
    assert.ok(got >= floorRate,
      `honest availability at ${n} owners fell to ${(got * 100).toFixed(1)}%, under the ${(floorRate * 100).toFixed(0)}% this suite pins`);
  }
  // A tight street answers nearly always, which is the case the product is for.
  assert.ok(measure(10, 8, 777) > 0.9, 'a street whose venues move together answers almost every night');
});

// ═══ ONE OWNER IS NOT A COHORT ══════════════════════════════════════════════

test('one owner cannot constitute a cohort: their venues collapse to a single value', async () => {
  // venue_profiles.user_id is UNIQUE today, so this configuration is not
  // reachable through the product yet. It is pinned because the floor is
  // written in owners on purpose, and a multi-venue operator is a product
  // decision away.
  const oneOwnerFiveVenues = [
    { owner: 900, peak: 0 }, { owner: 900, peak: 0 }, { owner: 900, peak: 100 },
    { owner: 900, peak: 100 }, { owner: 901, peak: 60 },
  ];
  assert.strictEqual(aggregateFrom(oneOwnerFiveVenues, NIGHT.reading).owners, 3,
    'five venues under two accounts, plus the asking one, are three reporters');
  scriptCohort({ night: NIGHT, peers: oneOwnerFiveVenues });
  const out = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(!out.some((f) => f.id === 'cohort_night_median'));
  assert.ok(out.some((e) => advisorFacts.isRefusal(e) && e.id === 'refuse_cohort_thin_reporters'));

  // And five separate owners, same readings, are a cohort by count.
  const fiveOwners = [38, 41, 43, 55, 60].map((peak, i) => ({ owner: 900 + i, peak }));
  scriptCohort({ night: NIGHT, peers: fiveOwners });
  const ok = await advisorFacts.buildCohortSameNight(await ctx(), { now: NOW });
  assert.ok(ok.some((f) => f.id === 'cohort_night_median'));
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
    peers: PEERS_OK,
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
    peers: PEERS_OK,
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
    peers: PEERS_OK,
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
    peers: PEERS_OK,
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
  scriptCohort({ night: NIGHT, peers: PEERS_OK });
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
