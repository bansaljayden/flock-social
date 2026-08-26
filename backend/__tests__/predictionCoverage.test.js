// ---------------------------------------------------------------------------
// HOW OFTEN THE TRAINED MODEL ACTUALLY ANSWERS (2026-08-26).
//
// The crowd number is the one differentiated claim the product makes, and until
// this counter landed nothing in the repo measured how often the trained model
// produced it. predictBusyness has five exits and four of them are honest
// refusals that return crowdEngine's category curve. The split is invisible in
// the payload (a client renders one card either way), invisible in the logs
// (nothing is written per prediction) and invisible in the database (nothing is
// stored), so an operator had no way to answer "is the model serving anybody".
//
// The dominant refusal is `rule_engine_no_baseline`. A delta model reconstructs
// score = baseline + clamp(delta), so a venue with no row in ml_venue_baselines
// cannot be scored by it at all, and the two ways a venue gets a row are both
// shut: BestTime collection is finished, and storeGoogleBaselines only fires on
// a venue carrying `popular_times`, which no route in this repo supplies.
//
// What this file pins is the counter's contract, not a coverage target. The
// target is Jayden's to set once the number is visible.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mlPredictor = require('../services/mlPredictor');

const WEATHER = { temp: 74, humidity: 50, windSpeed: 5, isRaining: false, conditionId: 800 };

function venueAt(placeId) {
  return {
    place_id: placeId,
    types: ['bar', 'restaurant', 'food'],
    rating: 4.3, price_level: 2, user_ratings_total: 700,
    location: { latitude: 40.6, longitude: -75.37 },
    utcOffsetMinutes: -240,
  };
}

test('predictionCoverage is a non-consuming read with a stable shape', () => {
  const a = mlPredictor.predictionCoverage();
  for (const key of ['since', 'total', 'ml', 'ruleEngine', 'modelShare', 'byMethod', 'modelVersion', 'modelLoaded', 'inMemory']) {
    assert.ok(key in a, `predictionCoverage must always carry ${key}`);
  }
  assert.equal(a.inMemory, true);
  assert.equal(typeof a.total, 'number');
  assert.equal(typeof a.byMethod, 'object');

  // Reading it twice must not move it. Same rule eventBudgetStatus states: a
  // status reader that charges is a status reader that lies.
  const b = mlPredictor.predictionCoverage();
  assert.equal(b.total, a.total);
  assert.equal(b.ml, a.ml);

  // The returned map is a copy, so a caller cannot edit the ledger by
  // mutating what it was handed.
  a.byMethod.__injected = 999;
  assert.ok(!('__injected' in mlPredictor.predictionCoverage().byMethod));
});

test('modelShare is null before anything is scored, never 0', () => {
  const c = mlPredictor.predictionCoverage();
  if (c.total === 0) {
    assert.equal(c.modelShare, null,
      '"nothing has been scored" and "the model never answers" are the two readings '
      + 'this panel exists to tell apart, so they must not print the same number');
  } else {
    assert.equal(typeof c.modelShare, 'number');
  }
});

test('every prediction is counted exactly once, under the exit it actually took', async () => {
  await mlPredictor.init();
  const before = mlPredictor.predictionCoverage();

  // No database in this suite, so getBaseline answers 0 and no route supplies
  // popular_times: this is the no-baseline exit, which is also the exit a real
  // venue outside the corpus takes on every request.
  const N = 4;
  const results = [];
  for (let i = 0; i < N; i++) {
    results.push(await mlPredictor.predictBusyness(venueAt(`coverage-test-${i}`), WEATHER, new Date(2026, 7, 21, 20, 0, 0)));
  }

  const after = mlPredictor.predictionCoverage();
  assert.equal(after.total - before.total, N, 'one prediction, one tally, no double counting');
  assert.equal(after.ml + after.ruleEngine, after.total, 'the ml and rule legs must partition the total');

  for (const r of results) {
    assert.ok(typeof r.predictionMethod === 'string' && r.predictionMethod,
      'every exit must name the engine that answered it');
    assert.ok((after.byMethod[r.predictionMethod] || 0) >= 1,
      `${r.predictionMethod} was returned to a caller but never counted`);
  }

  // The tally is keyed by the same strings the payload publishes, so a reader
  // of the admin panel and a reader of a response are looking at one vocabulary.
  const counted = Object.keys(after.byMethod);
  for (const method of counted) {
    assert.ok(method === 'ml' || method.startsWith('rule_engine') || method === 'unknown',
      `unexpected predictionMethod in the ledger: ${method}`);
  }

  assert.equal(after.modelShare, after.total > 0 ? after.ml / after.total : null);
});

test('the hourly strip counts each of its own hours, because each one is its own decision', async () => {
  await mlPredictor.init();
  const before = mlPredictor.predictionCoverage();
  const HOURS = 6;
  const strip = await mlPredictor.predictHourlyForecast(
    venueAt('coverage-strip'), WEATHER, 18, HOURS, new Date(2026, 7, 21, 18, 0, 0),
  );
  const after = mlPredictor.predictionCoverage();

  assert.equal(strip.length, HOURS);
  // A strip can genuinely mix engines (a baseline exists at 19:00 and not at
  // 03:00), which is exactly why the strip is counted per hour rather than once.
  assert.equal(after.total - before.total, HOURS);
});
