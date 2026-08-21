'use strict';
// ---------------------------------------------------------------------------
// ONE QUERY FOR A WEEK, AND IT HAS TO GIVE THE SAME ANSWER AS SEVENTY.
// ---------------------------------------------------------------------------
//
// THE DEFECT. services/advisorFacts.js fetchBaselineCurve reads a venue's
// entire weekly baseline curve in one query. buildWeekAhead then threw it away
// and walked every open hour of all seven days calling
// mlPredictor.predictBusyness, and every one of those called getBaseline,
// which ran its own three-row query against the table the curve came from.
// A venue open ten hours a day cost seventy sequential round trips; one that
// never closes, a hundred and sixty-eight. GET /api/advisor/cards paid it
// twice (buildWeekAhead and buildListingReadBack), POST /api/advisor/ask pays
// it on every chip tap that reaches a week-shaped intent, and the Monday
// digest sweep pays it once per venue in a loop with no LIMIT on it.
//
// THE FIX is primeBaselineCache: hand the curve to the predictor and every one
// of those lookups is a cache hit.
//
// THE RISK, WHICH IS WHAT THIS FILE IS ACTUALLY FOR. A second way to compute a
// baseline is a second answer waiting to disagree with the first. The blend is
// not a plain average — the current hour is 60%, each neighbour 20%, a missing
// neighbour stands in as the current hour, and the neighbours cross weekday
// boundaries at 23:00 and 00:00 — and the cached entry also carries the
// PROVENANCE of the anchoring row, which is what the advisor publishes as the
// data's age. If the prime and the query ever disagreed on any of that, a
// venue's forecast would depend on which code path happened to warm the cache,
// and nothing in the product would say so.
//
// So this file pins them equal slot by slot, over a whole synthetic week
// including both wrap-around boundaries, a closed hour, and a venue whose rows
// carry different sources and ages.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');

const mlPredictor = require('../services/mlPredictor');
const {
  blendBaselineRows, baselineNeighborSlots, baselineCacheEntry,
} = mlPredictor._internals;

const PLACE = 'ChIJprimebaselinetest01';

// A week with a shape rather than a constant: a morning ramp, an evening peak,
// a dead hour in the middle of the run, and rows that stop before midnight on
// some days and run through it on others.
function syntheticCurve() {
  const rows = [];
  for (let day = 0; day <= 6; day += 1) {
    // Sunday closes early; Friday and Saturday run past midnight into the next
    // day's 00:00 and 01:00, which is what makes the neighbour wrap load-bearing.
    const hours = day === 0 ? [10, 11, 12, 13] : [8, 9, 10, 15, 18, 19, 20, 21, 22, 23];
    if (day === 5 || day === 6) hours.push(0, 1);
    for (const hour of hours) {
      rows.push({
        day_of_week: day,
        hour,
        // A shape, not a constant: a flat curve would hide a weighting bug.
        baseline: String(10 + ((day * 7 + hour * 3) % 80)),
        source: day % 2 === 0 ? 'collected' : 'google',
        updated_at: new Date(Date.UTC(2026, 7, 1 + day)).toISOString(),
      });
    }
  }
  return rows;
}

// What the single-slot query would have returned for one slot: the slot itself
// plus the two neighbours, and nothing else.
function queryRowsFor(curve, day, hour) {
  const { prevHour, nextHour, prevDay, nextDay } = baselineNeighborSlots(day, hour);
  const want = [[day, hour], [prevDay, prevHour], [nextDay, nextHour]];
  return curve.filter((r) => want.some(([d, h]) => r.day_of_week === d && r.hour === h));
}

test('the prime and the query agree on every slot, value and provenance', () => {
  const curve = syntheticCurve();
  const primed = mlPredictor.primeBaselineCache(PLACE, curve);
  assert.equal(primed, curve.length, 'every row in the curve must produce one cache entry');

  const disagreements = [];
  for (const row of curve) {
    const day = row.day_of_week;
    const hour = row.hour;
    // blendBaselineRows over the query's row set IS the query path: getBaseline
    // hands it exactly these rows and caches exactly what it returns.
    const fromQuery = blendBaselineRows(queryRowsFor(curve, day, hour), day, hour);
    const fromPrime = baselineCacheEntry(PLACE, day, hour);
    assert.ok(fromPrime, `slot ${day}_${hour} was not primed`);
    if (fromPrime.data !== fromQuery.data) {
      disagreements.push(`${day}_${hour}: primed ${fromPrime.data}, queried ${fromQuery.data}`);
    }
    assert.deepEqual(fromPrime.meta, fromQuery.meta,
      `slot ${day}_${hour} must carry the same provenance either way`);
  }
  assert.deepEqual(disagreements, [],
    'the whole-curve prime and the per-hour query must produce identical baselines');
});

test('the blend is the documented weighting, not an average', () => {
  // current 60%, each neighbour 20%. 100/50/50 -> 60 + 10 + 10 = 80.
  const rows = [
    { day_of_week: 3, hour: 20, baseline: '100' },
    { day_of_week: 3, hour: 19, baseline: '50' },
    { day_of_week: 3, hour: 21, baseline: '50' },
  ];
  assert.equal(blendBaselineRows(rows, 3, 20).data, 80);

  // A missing neighbour stands in as the current hour rather than as zero, so
  // an hour at the edge of the venue's run is not dragged down by the closure.
  assert.equal(blendBaselineRows([
    { day_of_week: 3, hour: 20, baseline: '100' },
    { day_of_week: 3, hour: 19, baseline: '50' },
  ], 3, 20).data, 90);

  // No neighbours at all: the current hour, untouched.
  assert.equal(blendBaselineRows([{ day_of_week: 3, hour: 20, baseline: '73' }], 3, 20).data, 73);

  // No row for the slot itself: zero, and no provenance to publish.
  assert.deepEqual(blendBaselineRows([{ day_of_week: 3, hour: 19, baseline: '50' }], 3, 20),
    { data: 0, meta: null });
});

test('the neighbour of midnight belongs to the day before', () => {
  assert.deepEqual(baselineNeighborSlots(3, 0), { prevHour: 23, nextHour: 1, prevDay: 2, nextDay: 3 });
  assert.deepEqual(baselineNeighborSlots(3, 23), { prevHour: 22, nextHour: 0, prevDay: 3, nextDay: 4 });
  assert.deepEqual(baselineNeighborSlots(0, 0), { prevHour: 23, nextHour: 1, prevDay: 6, nextDay: 0 });
  assert.deepEqual(baselineNeighborSlots(6, 23), { prevHour: 22, nextHour: 0, prevDay: 6, nextDay: 0 });
});

test('a slot the curve has no row for is left unprimed, not primed as zero', () => {
  const place = `${PLACE}_sparse`;
  mlPredictor.primeBaselineCache(place, [
    { day_of_week: 2, hour: 18, baseline: '40', source: 'collected', updated_at: null },
  ]);
  assert.ok(baselineCacheEntry(place, 2, 18), 'the slot with a row is primed');
  assert.equal(baselineCacheEntry(place, 2, 19), undefined,
    'an hour nobody has data for must stay a miss, so getBaseline answers it honestly');
});

test('the prime refuses inputs that would poison the cache', () => {
  assert.equal(mlPredictor.primeBaselineCache('', [{ day_of_week: 1, hour: 1, baseline: '1' }]), 0);
  assert.equal(mlPredictor.primeBaselineCache(PLACE, []), 0);
  assert.equal(mlPredictor.primeBaselineCache(PLACE, null), 0);
  // A row with a non-integer slot is skipped rather than keyed as NaN.
  const place = `${PLACE}_junk`;
  assert.equal(mlPredictor.primeBaselineCache(place, [
    { day_of_week: 'Friday', hour: 20, baseline: '40' },
    { day_of_week: 4, hour: null, baseline: '40' },
  ]), 0);
});

test('advisorFacts reads the provenance columns the prime needs', () => {
  // fetchBaselineCurve used to select only (day_of_week, hour, baseline).
  // Priming from that curve would cache a null provenance for every slot and
  // the advisor would report every venue's data as of unknown age.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'advisorFacts.js'), 'utf8');
  const curveQuery = /SELECT ([^;]*?)\s+FROM ml_venue_baselines/.exec(src);
  assert.ok(curveQuery, 'fetchBaselineCurve must still read ml_venue_baselines');
  for (const col of ['day_of_week', 'hour', 'baseline', 'source', 'updated_at']) {
    assert.match(curveQuery[1], new RegExp(`\\b${col}\\b`),
      `fetchBaselineCurve must select ${col} or the primed cache entry loses it`);
  }
  assert.match(src, /mlPredictor\.primeBaselineCache\(placeId, rows\)/,
    'fetchBaselineCurve must hand the rows it just read to the predictor cache');
});
