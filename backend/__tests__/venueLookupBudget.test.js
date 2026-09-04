// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE THREE PLACE-KEYED CACHES NOBODY METERED — found by the round-5 sweep
// ---------------------------------------------------------------------------
// Round 4 closed with a specific instruction: stop patching the reported
// instance and enumerate every cache key and every spend counter against "which
// part of this can the caller pick". Doing that turned up an instance no audit
// round had reported, sitting in the same file as the one that was.
//
//   baselineCache      key `${placeId}_${dow}_${hour}`   miss = 1 Postgres query
//   feedbackCache      key placeId                        miss = 1 Postgres query
//   selfBaselineCache  key placeId                        miss = 1 Postgres query
//
// `placeId` on POST /api/crowd/batch is `v.place_id.slice(0, 256)` and
// routes/crowd.js deliberately does not shape-check it — the comment arguing
// for that reasons about paid Google calls and about writes, and never about
// cache thrash against Postgres. So: an unbounded key space, three 2,000-entry
// FIFOs, and NOTHING metering the database leg. Twenty venues a request times
// three caches is up to sixty forced round trips per request that can never be
// served from memory, at apiLimiter's 3,000 requests per 15 minutes.
//
// That is R4-I2's arithmetic on a different set of maps, and it is worse in one
// respect: eventCache is protected by the pinned inequality
// EVENT_USER_DAILY(400) < EVENT_CACHE_MAX(500), so one account cannot flush
// what everybody else cached. These three had no equivalent, so the same loop
// evicted real venues' baselines and made THEIR next request pay a query too.
//
// WHAT THIS FILE PINS.
//
//   1. A place id that cannot match a row is refused for FREE — no query, no
//      cache entry, and no budget unit spent. Junk must not be able to consume
//      a real user's allowance.
//   2. Shaped-but-fabricated ids ARE metered, because shape alone is not a
//      control: `spoof-000001`, `spoof-000002`, ... are all well formed.
//   3. A refused miss writes nothing, so an account that cannot query also
//      cannot evict a real venue's cached baseline.
//   4. Each refusal degrades to the value a database ERROR already produces,
//      so no new failure mode reaches the model.
//   5. Real venues stay free: a hit is answered above the gate and costs
//      nothing, which is the "charge what you spend" rule placesBudget states.
//
// No database. pool.query dispatches on the clause under test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-venue-lookup-budget';

const pool = require('../config/database');
const { _internals } = require('../services/mlPredictor');
const { getBaseline, getUserFeedback, getSelfBaselines } = _internals;

const REAL = 'ChIJ_real_venue_0001';
const DOW = 3;
const HOUR = 20;

let baselineQueries = [];
let feedbackQueries = [];
let selfQueries = [];
let unknown = [];

const realQuery = pool.query;
pool.query = (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  if (/FROM ml_venue_baselines WHERE google_place_id = \$1/.test(sql)) {
    baselineQueries.push(params);
    if (params[0] !== REAL) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{ day_of_week: DOW, hour: HOUR, baseline: '55' }], rowCount: 1,
    });
  }
  // The avg-error read gained an alias and a NOT EXISTS on 2026-09-04 (an
  // owner-set card is not model error), so this must not pin the old text.
  if (/FROM venue_feedback(?: vf)?\s+WHERE (?:vf\.)?venue_place_id = \$1/.test(sql)) {
    feedbackQueries.push(params);
    return Promise.resolve({
      rows: [{ avg_crowd: '2.0', count: params[0] === REAL ? 4 : 0, avg_error_mapped: '1.0', avg_error_legacy: '1.0' }],
      rowCount: 1,
    });
  }
  if (/FROM ml_venues v/.test(sql) && /WHERE v\.google_place_id = \$1/.test(sql)) {
    selfQueries.push(params);
    if (params[0] !== REAL) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{ lat: '40.71', lng: '-74.01', dow: DOW, hour: HOUR, baseline: '55' }], rowCount: 1,
    });
  }
  unknown.push(sql);
  return Promise.resolve({ rows: [], rowCount: 0 });
};

test.after(() => {
  pool.query = realQuery;
  return pool.end().catch(() => {});
});
test.beforeEach(() => {
  _internals.__resetVenueLookupCaches();
  baselineQueries = [];
  feedbackQueries = [];
  selfQueries = [];
  unknown = [];
});

const totalQueries = () => baselineQueries.length + feedbackQueries.length + selfQueries.length;
const assertModelled = () =>
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the predictor ran');

const uid = (() => { let n = 700000; return () => ++n; })();

// ── 1. Junk is refused for free ─────────────────────────────────────────────

test('a place id that cannot match a row runs no query and spends no allowance', async () => {
  const user = uid();
  // Everything routes/crowd.js will pass through that a Google place id is not:
  // too short, too long, and characters outside the shape.
  const JUNK = [
    'abc',                       // under the 6-char floor
    'a'.repeat(129),             // over the 128-char ceiling
    'a'.repeat(256),             // the batch route's own slice() ceiling
    'has spaces here',
    'semi;colon;injection',
    "quote'and\"quote",
    '../../etc/passwd',
    '%00nullish',
    'emoji-\u{1F600}-id',
  ];
  for (const bad of JUNK) {
    assert.strictEqual(await getBaseline(bad, DOW, HOUR, user), 0, `${bad} got a baseline`);
    assert.deepStrictEqual(await getUserFeedback(bad, user),
      { avgCrowd: 0, count: 0, avgErrorMapped: 0, avgErrorLegacy: 0 }, `${bad} got feedback`);
    assert.strictEqual(await getSelfBaselines(bad, user), null, `${bad} got self baselines`);
  }

  assert.strictEqual(totalQueries(), 0,
    `${totalQueries()} Postgres round trips were spent on ids that cannot match a row`);
  // FREE is the load-bearing half: if junk consumed units, an attacker could
  // starve a real user's allowance without ever touching the database.
  assert.deepStrictEqual(
    _internals.venueLookupBudgetRemaining(user),
    { hourly: _internals.VENUE_LOOKUP_USER_HOURLY, daily: _internals.VENUE_LOOKUP_USER_DAILY },
    'a shape refusal spent budget, so junk can starve a real caller');
  assertModelled();
});

// ── 2. Shape alone is not the control ───────────────────────────────────────

test('shaped-but-fabricated ids are metered, because shape alone is trivial to satisfy', async () => {
  const attacker = uid();
  const ceiling = _internals.VENUE_LOOKUP_USER_HOURLY;

  // The attack routes/crowd.js permits: a fresh, perfectly well-formed place id
  // per venue, twenty a request. Shape-gating alone would not touch this.
  for (let i = 0; i < ceiling + 200; i++) {
    await getUserFeedback(`spoof-${String(i).padStart(8, '0')}`, attacker);
  }

  assert.strictEqual(feedbackQueries.length, ceiling,
    `an account ran ${feedbackQueries.length} uncached lookups against a ceiling of ${ceiling}`);
  assert.strictEqual(_internals.venueLookupBudgetRemaining(attacker).hourly, 0);
  assertModelled();
});

test('the three caches share ONE budget, so the walk cannot be tripled by rotating caches', async () => {
  const attacker = uid();
  const ceiling = _internals.VENUE_LOOKUP_USER_HOURLY;

  // A cold venue costs three lookups. Rotating between them must not buy three
  // separate allowances — that would be the "budget the route, not the class"
  // mistake all over again.
  for (let i = 0; i < ceiling; i++) {
    const id = `spoof-${String(i).padStart(8, '0')}`;
    await getBaseline(id, DOW, HOUR, attacker);
    await getUserFeedback(id, attacker);
    await getSelfBaselines(id, attacker);
  }
  assert.strictEqual(totalQueries(), ceiling,
    `rotating between the three caches bought ${totalQueries()} lookups against one ceiling of ${ceiling}`);
  assertModelled();
});

// ── 3. A refused miss must not evict ────────────────────────────────────────

test('a refused miss writes no cache entry, so it cannot evict a real venue', async () => {
  const attacker = uid();
  const ceiling = _internals.VENUE_LOOKUP_USER_HOURLY;
  for (let i = 0; i < ceiling; i++) {
    await getUserFeedback(`spoof-${String(i).padStart(8, '0')}`, attacker);
  }
  const sizeAtCeiling = _internals.feedbackCacheSize();

  for (let i = 0; i < 500; i++) {
    await getUserFeedback(`after-${String(i).padStart(8, '0')}`, attacker);
  }
  assert.strictEqual(_internals.feedbackCacheSize(), sizeAtCeiling,
    'a refused caller still wrote cache entries, so it can still churn real venues out');
  assertModelled();
});

// ── 4. Refusal is the failure value the file already documents ──────────────

test('each refusal degrades to exactly what a query ERROR already returns', async () => {
  const attacker = uid();
  for (let i = 0; i < _internals.VENUE_LOOKUP_USER_HOURLY; i++) {
    await getUserFeedback(`spoof-${String(i).padStart(8, '0')}`, attacker);
  }

  // getBaseline -> 0, so predictBusyness falls back to the venue's own
  // popular_times or hands the whole prediction to the rule engine.
  assert.strictEqual(await getBaseline(REAL, DOW, HOUR, attacker), 0);
  // getUserFeedback -> noFeedback, the documented empty aggregate.
  assert.deepStrictEqual(await getUserFeedback(REAL, attacker),
    { avgCrowd: 0, count: 0, avgErrorMapped: 0, avgErrorLegacy: 0 });
  // getSelfBaselines -> null, so nothing is subtracted and the neighbour count
  // is one too HIGH rather than wrong in the model's favour. That direction is
  // the one the file's own comment commits to.
  assert.strictEqual(await getSelfBaselines(REAL, attacker), null);
  assertModelled();
});

// ── 5. Real use stays free ──────────────────────────────────────────────────

test('cache hits are answered above the gate and cost nothing', async () => {
  const user = uid();
  const first = await getBaseline(REAL, DOW, HOUR, user);
  assert.ok(first > 0, 'fixture broken: the real venue must have a baseline');
  const afterFirst = _internals.venueLookupBudgetRemaining(user).hourly;

  for (let i = 0; i < 50; i++) {
    assert.strictEqual(await getBaseline(REAL, DOW, HOUR, user), first);
  }
  assert.strictEqual(baselineQueries.length, 1, 'a cached baseline re-queried');
  assert.strictEqual(_internals.venueLookupBudgetRemaining(user).hourly, afterFirst,
    'cache hits were charged — charging for a query you did not run masks the real burn rate');
  assertModelled();
});

test('the unmetered callers (crowdAlerts, the public demo) keep their old behaviour', async () => {
  // `!allow(undefined)` would have refused every background producer, because
  // createUserBudget.allow fails closed on anything that is not an id. The
  // guard has to be `userId != null && !allow(userId)`, the same shape
  // allowEventFetch uses.
  for (let i = 0; i < 400; i++) {
    await getUserFeedback(`nouser-${String(i).padStart(8, '0')}`);
  }
  assert.strictEqual(feedbackQueries.length, 400,
    'a caller with no account was refused, which would break crowdAlerts and the demo');
  assertModelled();
});

test('a supplied-but-malformed userId is refused rather than given a free lane', async () => {
  let n = 0;
  for (const bad of ['', 0, -1, 1.5, 'abc', true, [9], {}, NaN]) {
    n += 1;
    await getUserFeedback(`badid-${String(n).padStart(8, '0')}`, bad);
  }
  assert.strictEqual(feedbackQueries.length, 0,
    'a malformed userId bought unmetered lookups — createUserBudget must fail closed here');
  assertModelled();
});

// ── 6. Pinned against the source ────────────────────────────────────────────

test('all three place-keyed lookups gate BEFORE their query, and none writes on refusal', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'services', 'mlPredictor.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  for (const fn of ['async function getBaseline', 'async function getUserFeedback',
    'async function getSelfBaselines']) {
    const start = source.indexOf(fn);
    assert.notStrictEqual(start, -1, `${fn} is gone from mlPredictor.js`);
    const rest = source.slice(start);
    const body = rest.slice(0, rest.indexOf('\n}\n') + 2);

    const gate = body.indexOf('allowVenueLookup(');
    const query = body.indexOf('pool.query');
    const write = body.indexOf('boundedSet(');
    assert.notStrictEqual(gate, -1, `${fn} lost its allowVenueLookup gate`);
    assert.ok(gate < query,
      `${fn} charges the budget AFTER its query, so the query it exists to prevent still runs`);
    if (write !== -1) {
      assert.ok(gate < write,
        `${fn} can still write a cache entry on a refused miss, so a refused caller can still evict`);
    }
  }

  // The gate itself: free shape refusal first, charged budget second. If the
  // order were reversed, junk would spend a real user's allowance.
  const gs = source.indexOf('function allowVenueLookup');
  const gate = source.slice(gs, source.indexOf('\n}\n', gs));
  assert.ok(gate.indexOf('isPlaceIdShaped(') < gate.indexOf('venueLookupBudget.allow'),
    'the shape check must come FIRST and be free, or junk consumes real callers\' units');
  assert.match(gate, /userId != null && !venueLookupBudget\.allow\(userId\)/,
    'the identity guard must be `userId != null && !allow(userId)`, matching allowEventFetch');
});
