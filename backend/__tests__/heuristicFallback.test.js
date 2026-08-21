// The heuristic crowd fallback, characterized. Round 19's mutation sweep
// deliberately left the rule-engine half of services/crowdEngine.js unswept:
// its several hundred comparison thresholds are tuned constants, not
// invariants, and pinning them would freeze tuning. That was right for the
// VALUES — but it left the STRUCTURE around them (bounds, fallthroughs,
// day/hour handling, category dispatch, NaN paths) with zero behavioral
// coverage, and this is the code that answers whenever the ONNX model is
// unavailable, including every cold start until the model loads.
//
// So nothing in this file asserts a tuned number. It asserts the shapes the
// code's own comments claim: every score is an integer in 0..100 for every
// category at every (day, hour); no input can poison the arithmetic into NaN
// or a throw; the factor breakdown sums to the score; the categories the
// comments call peaks really score above the hours they call dead; dispatch
// precedence between overlapping type lists; and that the model/fallback
// boundary in mlPredictor is invisible to the caller except through the
// honest predictionMethod/modelVersion channel.
//
// Run: node --test  (from backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateCrowdScore,
  generateHourlyForecast,
  estimateCapacity,
  estimateWait,
  getLabel,
  getLevel,
  venueLocalNow,
} = require('../services/crowdEngine');

// ---------------------------------------------------------------------------
// The engine reads timestamp.getDay() and timestamp.getHours() — the LOCAL
// wall clock of the Date it is handed, which is the convention the whole
// venue-clock effort standardized on: crowdAlerts.venueWallClock constructs a
// Date whose getHours()/getDay() read back the VENUE's hour and day (pinned in
// venueClockConsistency.test.js), and routes/crowd.js hands that Date here.
// This subclass drives (day, hour) directly, which both makes the exhaustive
// sweep timezone-proof and pins the convention: if the engine ever switched to
// getUTCDay()/getUTCHours(), every test built on FakeClock goes red at once,
// because the underlying anchor instant's UTC fields do not match the
// sentinels.
// ---------------------------------------------------------------------------
class FakeClock extends Date {
  constructor(day, hour) {
    super(2026, 7, 12, 12, 0, 0, 0); // anchor: Wed Aug 12 2026, noon local
    this._day = day;
    this._hour = hour;
  }
  getDay() { return this._day; }
  getHours() { return this._hour; }
}

// One representative type list per dispatch branch in getVenueContextBonus /
// estimateCapacity / estimateWait, plus the type strings the frontend can
// produce that the engine has NO rule for (App.js activity categories:
// bowling, lounges, spas, pool halls, dance clubs, theaters, climbing gyms).
// Unknown types must fall through to the base time curve, not throw.
const CATEGORY_TYPES = {
  steakhouse: ['steak_house'],
  bbq: ['barbecue_restaurant'],
  fine_dining: ['french_restaurant'], // fine dining only with price_level >= 3
  sushi: ['sushi_restaurant'],
  seafood: ['seafood_restaurant'],
  mexican: ['mexican_restaurant'],
  pizza: ['pizza_restaurant'],
  asian: ['thai_restaurant'],
  korean: ['korean_restaurant'],
  dessert: ['ice_cream_shop'],
  bakery: ['bakery'],
  brunch: ['breakfast_restaurant'],
  diner: ['diner'],
  sports_bar: ['sports_bar'],
  brewery: ['brewery'],
  bar: ['bar'],
  night_club: ['night_club'],
  fast_food: ['fast_food_restaurant'],
  cafe: ['cafe'],
  restaurant: ['restaurant'],
  movie_theater: ['movie_theater'],
  shopping_mall: ['shopping_mall'],
  gym: ['gym'],
  library: ['library'],
  museum: ['museum'],
  park: ['park'],
  app_bowling: ['bowling_alley'],
  app_lounge: ['lounge'],
  app_pool_hall: ['pool_hall'],
  app_spa: ['spa'],
  app_dance_club: ['dance_club'],
  app_theater: ['performing_arts_theater'],
  app_concert_hall: ['concert_hall'],
  app_climbing: ['rock_climbing_gym'],
  untyped: [],
};

const WEATHERS = [
  null,
  { temp: 70, isRaining: false, windSpeed: 5 },
  { temp: 100, isRaining: true, windSpeed: 30 },
  { temp: 10, isRaining: false, windSpeed: 30 },
  {},
];

function sumFactors(f) {
  return f.time + f.popularity + f.rating + f.venueContext + f.weather;
}
const clamp100 = (n) => Math.max(0, Math.min(100, n));

// The intercept of the scoring formula, derived instead of hardcoded so this
// file pins the RELATIONSHIP (score = clamp(base + sum of published factors))
// without freezing the tuned base constant.
const SCORE_BASE = (() => {
  const r = calculateCrowdScore({ types: [] }, null, new FakeClock(1, 3));
  return r.score - sumFactors(r.factors);
})();

// ---------------------------------------------------------------------------
// 1. Bounds: exhaustive over every category at every (day, hour)
// ---------------------------------------------------------------------------

test('every category at every (day, hour): score and confidence are integers in 0..100, label matches, factors sum to score', () => {
  const venueBase = { user_ratings_total: 12000, rating: 4.7, price_level: 3 };
  for (const [name, types] of Object.entries(CATEGORY_TYPES)) {
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        for (const weather of [null, WEATHERS[1]]) {
          const r = calculateCrowdScore({ ...venueBase, types }, weather, new FakeClock(day, hour));
          const at = `${name} day=${day} hour=${hour} weather=${!!weather}`;
          assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100,
            `score ${r.score} out of bounds at ${at}`);
          assert.ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100,
            `confidence ${r.confidence} out of bounds at ${at}`);
          assert.equal(r.label, getLabel(r.score), `label drifted from getLabel at ${at}`);
          // The published factor breakdown must BE the score: base + the five
          // factors, clamped. A dropped or double-counted term breaks this.
          assert.equal(r.score, clamp100(SCORE_BASE + sumFactors(r.factors)),
            `factors do not sum to score at ${at}`);
          // getLevel is documented as derived from the label bands.
          const level = getLevel(r.score);
          const expectLevel = (r.label === 'Quiet' || r.label === 'Not Busy') ? 'calm'
            : r.label === 'Moderate' ? 'moderate' : 'busy';
          assert.equal(level, expectLevel, `level/label band mismatch at ${at}`);
        }
      }
    }
  }
});

test('bounds hold across review tiers, price levels and every weather shape', () => {
  const timepoints = [[0, 10], [2, 12], [4, 17], [5, 2], [5, 22], [6, 23]];
  for (const [, types] of Object.entries(CATEGORY_TYPES)) {
    for (const [day, hour] of timepoints) {
      for (const weather of WEATHERS) {
        for (const reviews of [0, 60, 300, 1500, 15000]) {
          for (const price of [undefined, 0, 1, 2, 3, 4]) {
            const r = calculateCrowdScore(
              { types, user_ratings_total: reviews, rating: 4.4, price_level: price },
              weather, new FakeClock(day, hour)
            );
            assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100,
              `score ${r.score}: types=${types} d=${day} h=${hour} reviews=${reviews} price=${price}`);
            assert.ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100,
              `confidence ${r.confidence}: types=${types} reviews=${reviews}`);
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Poison: no optional field can produce NaN, and none can throw
// ---------------------------------------------------------------------------

test('no garbage in any optional field yields NaN, a throw, or an out-of-bounds score', () => {
  const garbage = [undefined, null, NaN, 'abc', '', 0, -5, {}, [], true, Infinity];
  const clock = new FakeClock(5, 20);
  const weather = { temp: 70, isRaining: true, windSpeed: 10 };
  const base = { types: ['restaurant'], user_ratings_total: 800, rating: 4.4, price_level: 2 };
  const check = (venue, wx, ts, what) => {
    const r = calculateCrowdScore(venue, wx, ts);
    assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100,
      `${what}: score ${r.score}`);
    assert.ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100,
      `${what}: confidence ${r.confidence}`);
    assert.equal(typeof r.label, 'string');
    const cap = estimateCapacity(venue, r.score);
    assert.ok(Number.isInteger(cap.current) && Number.isInteger(cap.max)
      && cap.current >= 0 && cap.current <= cap.max,
      `${what}: capacity ${JSON.stringify(cap)}`);
    const wait = estimateWait(r.score, venue.types, venue.price_level);
    assert.ok(typeof wait === 'string' && wait.length > 0, `${what}: wait ${wait}`);
  };

  for (const field of ['rating', 'user_ratings_total', 'price_level', 'types']) {
    for (const g of garbage) {
      check({ ...base, [field]: g }, weather, clock, `${field}=${String(g)}`);
      check({ ...base, [field]: g }, null, clock, `${field}=${String(g)} no weather`);
    }
  }
  // Garbage weather fields.
  for (const g of garbage) {
    check(base, { temp: g, isRaining: g, windSpeed: g }, clock, `weather fields=${String(g)}`);
  }
  // Garbage timestamps: the engine accepts Date, ISO string, or nothing.
  for (const ts of [undefined, null, 'garbage', new Date('nope'), 0, '2026-08-14T20:00:00Z']) {
    check(base, weather, ts, `timestamp=${String(ts)}`);
  }
  // The all-garbage venue.
  check({}, null, clock, 'empty venue');
  check({ types: 'bar', rating: 'abc', user_ratings_total: {}, price_level: 'x' },
    weather, clock, 'all-garbage venue');
});

test('a numeric-string rating counts; an unreadable one is a missing rating, not poison', () => {
  const clock = new FakeClock(2, 19);
  const venue = (rating) => ({ types: [], user_ratings_total: 150, rating });
  const asNumber = calculateCrowdScore(venue(4.5), null, clock);
  const asString = calculateCrowdScore(venue('4.5'), null, clock);
  assert.equal(asString.factors.rating, asNumber.factors.rating,
    'a DECIMAL rating read back as text must score like the number');
  const missing = calculateCrowdScore(venue(undefined), null, clock);
  for (const bad of ['abc', NaN, {}, true]) {
    const r = calculateCrowdScore(venue(bad), null, clock);
    assert.equal(r.factors.rating, missing.factors.rating,
      `rating=${String(bad)} must score as "no rating"`);
    assert.ok(Number.isInteger(r.score), `rating=${String(bad)} poisoned the score to ${r.score}`);
  }
});

test('the documented rating anchors hold, and the factor is monotone in rating', () => {
  // getRatingFactor's own comment: 3.0 -> 0, 4.0 -> 6, 4.5 -> 9, 5.0 -> 12.
  const clock = new FakeClock(2, 19);
  const factorFor = (rating) =>
    calculateCrowdScore({ types: [], user_ratings_total: 150, rating }, null, clock).factors.rating;
  assert.equal(factorFor(3.0), 0);
  assert.equal(factorFor(4.0), 6);
  assert.equal(factorFor(4.5), 9);
  assert.equal(factorFor(5.0), 12);
  let prev = -1;
  for (const rating of [1, 2, 2.5, 3, 3.4, 3.8, 4.1, 4.4, 4.7, 5]) {
    const f = factorFor(rating);
    assert.ok(f >= prev, `rating factor fell from ${prev} to ${f} at rating ${rating}`);
    assert.ok(f >= 0 && f <= 12, `rating factor ${f} outside its own 0..12 band`);
    prev = f;
  }
});

// ---------------------------------------------------------------------------
// 3. Day and hour handling
// ---------------------------------------------------------------------------

test('the engine scores on getDay()/getHours() — the venue wall clock convention', () => {
  // A real local Friday-evening Date and a FakeClock claiming the same (day,
  // hour) must score identically: nothing but getDay() and getHours() may
  // influence the time inputs. Find a real Friday near the anchor so the test
  // does not hardcode a weekday that depends on the machine's calendar.
  let friday = null;
  for (let d = 10; d <= 16; d++) {
    const cand = new Date(2026, 7, d, 22, 0, 0, 0);
    if (cand.getDay() === 5) { friday = cand; break; }
  }
  const venue = { types: ['bar'], user_ratings_total: 800, rating: 4.4, price_level: 2 };
  const real = calculateCrowdScore(venue, null, friday);
  const fake = calculateCrowdScore(venue, null, new FakeClock(5, 22));
  assert.deepEqual(real, fake,
    'a real Date and a synthetic clock with the same local (day, hour) must be one prediction');
});

test('two timestamps with the same weekday and hour are the same prediction', () => {
  // (day, hour) are the only time inputs — the calendar date itself must not
  // leak in. Three weeks apart, same weekday and hour, identical output.
  const venue = { types: ['restaurant'], user_ratings_total: 2000, rating: 4.5, price_level: 2 };
  for (const [d, h] of [[12, 9], [14, 20], [15, 23]]) {
    const a = new Date(2026, 7, d, h, 0, 0, 0);
    const b = new Date(2026, 7, d + 21, h, 0, 0, 0);
    assert.equal(a.getDay(), b.getDay());
    assert.deepEqual(
      calculateCrowdScore(venue, null, a),
      calculateCrowdScore(venue, null, b),
      `same weekday+hour diverged for ${a} vs ${b}`
    );
  }
});

test('the weekday numbering is venueLocalNow\'s numbering: 0=Sunday, 5=Friday', () => {
  // venueLocalNow (pinned in venueClockConsistency.test.js) emits getUTCDay()
  // numbering; the engine's weekend rules must live on the same axis. July 3
  // 2026 12:00 UTC is a Friday.
  const fridayInstant = new Date(Date.UTC(2026, 6, 3, 12, 0, 0));
  assert.equal(venueLocalNow(0, fridayInstant).day, 5);
  // And day 5 really is treated as a weekend night by the scoring: a bar at
  // 11 PM scores above the same bar on day 2 (Tuesday) at 11 PM.
  const venue = { types: ['bar'], user_ratings_total: 800, rating: 4.4 };
  const fri = calculateCrowdScore(venue, null, new FakeClock(5, 23)).score;
  const tue = calculateCrowdScore(venue, null, new FakeClock(2, 23)).score;
  assert.ok(fri > tue, `Friday-night bar ${fri} not above Tuesday-night ${tue}`);
});

test('no category scores its own 2 AM above its own 10 PM on the same Friday', () => {
  // What the rules claim: every category's small-hours branches are penalties
  // or wind-downs (bars -5 at 0-5, clubs' 0-2 bonus is below their 22-23
  // bonus, everything else is "closed"/"dead" at 2 AM), and the base time
  // curve gives 2 AM its floor. So 2 AM <= 10 PM must hold for EVERY category
  // — including night_club, whose after-midnight bonus is deliberately
  // smaller than its prime-time one.
  for (const [name, types] of Object.entries(CATEGORY_TYPES)) {
    for (const price of [undefined, 0, 2, 4]) {
      for (const reviews of [200, 3000]) {
        const venue = { types, user_ratings_total: reviews, rating: 4.5, price_level: price };
        const at2am = calculateCrowdScore(venue, null, new FakeClock(5, 2)).score;
        const at10pm = calculateCrowdScore(venue, null, new FakeClock(5, 22)).score;
        assert.ok(at2am <= at10pm,
          `${name} (price=${price}, reviews=${reviews}) scores ${at2am} at 2 AM > ${at10pm} at 10 PM`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Category dispatch: the peaks the comments claim, above the hours they
//    call dead. All threshold-agnostic orderings — retuning a bonus keeps
//    these green; deleting a branch, dropping a `return`, or reordering the
//    dispatch does not.
// ---------------------------------------------------------------------------

// Context bonus in isolation: reviews 150 sits in the multiplier-1.0 tier and
// below every price/popularity threshold, and a null rating zeroes the rating
// factor, so factors.venueContext IS the raw category bonus.
function ctx(types, day, hour, price) {
  return calculateCrowdScore(
    { types, user_ratings_total: 150, rating: null, price_level: price },
    null, new FakeClock(day, hour)
  ).factors.venueContext;
}

test('each category peaks where its comment says it peaks', () => {
  const claims = [
    // [name, higher [types, day, hour, price?], lower [types, day, hour, price?]]
    ['steakhouse prime dinner beats dead afternoon', [['steak_house'], 6, 20], [['steak_house'], 6, 15]],
    ['fine dining prime dinner beats dead afternoon', [['french_restaurant'], 5, 20, 4], [['french_restaurant'], 5, 15, 4]],
    ['sushi dinner beats afternoon', [['sushi_restaurant'], 6, 19], [['sushi_restaurant'], 6, 15]],
    ['"Friday seafood" outranks Thursday seafood', [['seafood_restaurant'], 5, 19], [['seafood_restaurant'], 4, 19]],
    ['mexican Thursday happy hour beats Tuesday 5 PM', [['mexican_restaurant'], 4, 17], [['mexican_restaurant'], 2, 17]],
    ['late-night weekend pizza beats a weekday 10 PM', [['pizza_restaurant'], 6, 22], [['pizza_restaurant'], 2, 22]],
    ['cheap asian lunch is packed vs pricey', [['thai_restaurant'], 3, 12, 1], [['thai_restaurant'], 3, 12, 3]],
    ['korean weekend dinner is "an EVENT" above generic asian', [['korean_restaurant'], 6, 19], [['thai_restaurant'], 6, 19]],
    ['morning bakery rule exists', [['bakery'], 2, 8], [['ice_cream_shop'], 2, 8]],
    ['dessert weekend afternoon beats weekday', [['ice_cream_shop'], 6, 15], [['ice_cream_shop'], 2, 15]],
    ['Sunday brunch is the brunch peak', [['breakfast_restaurant'], 0, 10], [['breakfast_restaurant'], 2, 10]],
    ['sports bar Sunday football beats Tuesday 2 PM', [['sports_bar'], 0, 14], [['sports_bar'], 2, 14]],
    ['sports bar Thursday night beats Monday night', [['sports_bar'], 4, 20], [['sports_bar'], 1, 20]],
    ['brewery weekend afternoon hang beats weekday', [['brewery'], 6, 15], [['brewery'], 2, 15]],
    ['bar weekend late night beats weekday late night', [['bar'], 6, 23], [['bar'], 2, 23]],
    ['nightclub prime beats its own dead afternoon', [['night_club'], 6, 23], [['night_club'], 6, 16]],
    ['nightclub weekend late night beats weekday late night', [['night_club'], 6, 23], [['night_club'], 2, 23]],
    ['fast food weekDAY lunch rush beats weekend lunch', [['fast_food_restaurant'], 2, 12], [['fast_food_restaurant'], 6, 12]],
    ['cafe weekDAY morning rush beats weekend morning', [['cafe'], 2, 8], [['cafe'], 6, 8]],
    ['restaurant weekend dinner beats weekday dinner', [['restaurant'], 6, 19], [['restaurant'], 2, 19]],
    ['restaurant FRIDAY dinner counts as weekend', [['restaurant'], 5, 19], [['restaurant'], 2, 19]],
    ['movie theater weekend evening beats weekday', [['movie_theater'], 6, 20], [['movie_theater'], 2, 20]],
    ['mall weekend afternoon beats weekday afternoon', [['shopping_mall'], 6, 14], [['shopping_mall'], 2, 14]],
    ['gym weekday evening beats weekday lunch', [['gym'], 2, 18], [['gym'], 2, 13]],
    ['gym weekend morning rule exists', [['gym'], 6, 10], [['gym'], 2, 10]],
    ['library weekend midday beats its evening', [['library'], 6, 13], [['library'], 6, 20]],
    ['park weekend midday beats weekday midday', [['park'], 6, 12], [['park'], 2, 12]],
  ];
  for (const [name, hi, lo] of claims) {
    const a = ctx(...hi);
    const b = ctx(...lo);
    assert.ok(a > b, `${name}: expected ${a} > ${b}`);
  }
});

test('dead hours the comments name are penalties, not merely smaller bonuses', () => {
  assert.ok(ctx(['steak_house'], 6, 15) < 0, 'steakhouse "Dead afternoon" must be negative');
  assert.ok(ctx(['french_restaurant'], 5, 15, 4) < 0, 'fine dining off-hours must be negative');
  assert.ok(ctx(['night_club'], 6, 10) < 0, 'a nightclub at 10 AM must be negative');
  assert.ok(ctx(['cafe'], 2, 23) < 0, 'a cafe at 11 PM must be negative');
  assert.ok(ctx(['breakfast_restaurant'], 2, 23) < 0, 'a brunch spot at 11 PM must be negative');
});

test('fine dining is gated on price: a cheap bistro has no fine-dining rule', () => {
  // isFineDining requires price_level >= 3. Below the gate the same types fall
  // through the whole dispatch chain to zero — french_restaurant matches no
  // other category.
  assert.equal(ctx(['french_restaurant'], 5, 20, 1), 0);
  assert.ok(ctx(['french_restaurant'], 5, 20, 4) > 0);
});

test('unknown and app-side activity types fall through to zero context, never throw', () => {
  const unknown = ['bowling_alley', 'lounge', 'pool_hall', 'spa', 'dance_club',
    'performing_arts_theater', 'concert_hall', 'batting_cage', 'rock_climbing_gym',
    'liquor_store', 'not_a_real_type'];
  for (const t of unknown) {
    for (const [day, hour] of [[0, 10], [2, 12], [5, 20], [6, 23]]) {
      assert.equal(ctx([t], day, hour), 0,
        `unhandled type ${t} at (${day},${hour}) must ride the base time curve only`);
    }
  }
});

test('dispatch precedence over overlapping type lists is stable', () => {
  // These pin WHICH branch wins when Google returns several types.
  const at = [6, 23];
  // In the context bonus, the bar branch is checked BEFORE night_club, so a
  // venue Google types as both scores as a bar...
  assert.equal(ctx(['bar', 'night_club'], ...at), ctx(['bar'], ...at));
  // ...capacity used to test night_club FIRST and hand that same venue a
  // nightclub room. It no longer does: bar wins there too.
  assert.deepEqual(
    estimateCapacity({ types: ['bar', 'night_club'], user_ratings_total: 1500 }, 80),
    estimateCapacity({ types: ['bar'], user_ratings_total: 1500 }, 80)
  );
  // ...and in wait, bar is first, as it always was.
  assert.equal(estimateWait(80, ['bar', 'night_club'], 2), estimateWait(80, ['bar'], 2));
  // A steakhouse that is also a plain restaurant is a steakhouse.
  assert.equal(ctx(['steak_house', 'restaurant'], 6, 20, 2), ctx(['steak_house'], 6, 20, 2));
  // A cafe that is also a restaurant is a cafe.
  assert.equal(ctx(['cafe', 'restaurant'], 2, 8), ctx(['cafe'], 2, 8));
  // A sushi restaurant that also carries the generic tag is sushi.
  assert.equal(ctx(['sushi_restaurant', 'restaurant'], 6, 19, 2), ctx(['sushi_restaurant'], 6, 19, 2));
});

// ---------------------------------------------------------------------------
// One card, one room.
//
// A venue Google types both `bar` and `night_club` is scored, sized and
// wait-estimated by three different functions in services/crowdEngine.js, and
// until 2026-08-20 estimateCapacity was the only one of the three that tested
// night_club first. The card read bar, bar, NIGHTCLUB: 300 heads on a
// 1,500-review room where the bar ladder says 200, published next to a bar
// score and a bar wait.
//
// What these tests pin is the agreement, not the rungs. Whatever room the
// score decides it is in, the capacity and the wait must be in that same room,
// and a tuning pass can move any number here without breaking them.
// ---------------------------------------------------------------------------

test('a venue typed both bar and night_club is a BAR everywhere on the card', () => {
  const reviews = 1500;
  const both = { types: ['bar', 'night_club'], user_ratings_total: reviews };
  const barOnly = { types: ['bar'], user_ratings_total: reviews };

  // Three surfaces, one venue.
  assert.deepEqual(estimateCapacity(both, 80), estimateCapacity(barOnly, 80),
    'capacity must read the both-typed room the way the score and the wait do');
  assert.equal(ctx(['bar', 'night_club'], 6, 23), ctx(['bar'], 6, 23),
    'the score already reads it as a bar');
  assert.equal(estimateWait(80, ['bar', 'night_club'], 2), estimateWait(80, ['bar'], 2),
    'the wait already reads it as a bar');

  // Not a vacuous agreement: the two ladders really do differ at this review
  // count, so landing on the wrong one is a visible, published error.
  assert.notDeepEqual(
    estimateCapacity({ types: ['night_club'], user_ratings_total: reviews }, 80),
    estimateCapacity(barOnly, 80),
    'bar and nightclub capacity must differ here, or this test proves nothing'
  );
});

test('a room typed night_club ALONE keeps the nightclub ladder', () => {
  // The fix is only about the both-typed case. A club carrying no bar tag
  // matches none of the bar-family branches and lands on its own rungs, which
  // are the pre-fix nightclub numbers exactly.
  for (const [reviews, max] of [[2500, 400], [1500, 300], [700, 200], [120, 100]]) {
    assert.deepEqual(
      estimateCapacity({ types: ['night_club'], user_ratings_total: reviews }, 100),
      { current: max, max },
      `a ${reviews}-review nightclub must still size to ${max}`
    );
  }
  // And it is still scored and waited as a nightclub, not as a bar.
  assert.notEqual(ctx(['night_club'], 6, 23), ctx(['bar'], 6, 23));
  assert.notEqual(estimateWait(80, ['night_club'], 2), estimateWait(80, ['bar'], 2));
});

test('the bar-before-night_club ordering in estimateCapacity is pinned in source', () => {
  // The behavioral tests above would also pass if someone deleted the
  // night_club branch outright, and they say nothing about the ORDER that
  // produced the agreement. This one reads the file: inside estimateCapacity
  // the bar-family branches must all appear before the night_club branch, so
  // the ordering cannot silently flip back the way it stood before.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'crowdEngine.js'), 'utf8'
  );

  const start = src.indexOf('function estimateCapacity(');
  assert.ok(start > 0, 'estimateCapacity must still be a named function in crowdEngine.js');
  const end = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, end > 0 ? end : undefined);

  const nightClub = body.indexOf("hasType(types, 'night_club')");
  assert.ok(nightClub > 0, 'estimateCapacity must still have a night_club branch');
  for (const guard of ['isSportsBar(types)', 'isBreweryLike(types)', 'isBarLike(types)']) {
    const idx = body.indexOf(guard);
    assert.ok(idx > 0, `estimateCapacity must still test ${guard}`);
    assert.ok(idx < nightClub,
      `${guard} must be tested BEFORE night_club in estimateCapacity, or a venue `
      + 'typed both gets a room its own score and wait disagree with');
  }
});

test('popularity really amplifies the context bonus, in both directions', () => {
  // "Popular venues get these bonuses AMPLIFIED by their popularity
  // multiplier" — so the published venueContext factor of a landmark venue
  // must sit strictly outside the raw bonus of a multiplier-1.0 venue at the
  // same (types, day, hour): further above zero at a peak, further below at a
  // dead hour. Dropping the multiplication makes them equal.
  const landmark = (types, day, hour) => calculateCrowdScore(
    { types, user_ratings_total: 12000, rating: null },
    null, new FakeClock(day, hour)
  ).factors.venueContext;
  assert.ok(landmark(['bar'], 6, 23) > ctx(['bar'], 6, 23),
    'a landmark bar\'s peak bonus must be amplified above the raw bonus');
  assert.ok(landmark(['steak_house'], 6, 15) < ctx(['steak_house'], 6, 15),
    'a landmark steakhouse\'s dead-afternoon penalty must be amplified below the raw penalty');
});

// ---------------------------------------------------------------------------
// 5. Weather: clamped, and signed the way its comments claim
// ---------------------------------------------------------------------------

test('the weather factor never leaves its own ±15 clamp, whatever the reading', () => {
  const extremes = [
    { temp: 120, isRaining: true, windSpeed: 80 },
    { temp: -40, isRaining: true, windSpeed: 80 },
    { temp: 72, isRaining: false, windSpeed: 0 },
    { temp: 90, isRaining: false, windSpeed: 0 },
    { isRaining: true },
    {},
  ];
  for (const [, types] of Object.entries(CATEGORY_TYPES)) {
    for (const wx of extremes) {
      const f = calculateCrowdScore(
        { types, user_ratings_total: 500, rating: 4.2 }, wx, new FakeClock(6, 15)
      ).factors.weather;
      assert.ok(Number.isInteger(f) && f >= -15 && f <= 15,
        `weather factor ${f} for ${types} under ${JSON.stringify(wx)}`);
    }
  }
});

test('rain helps indoor venues and hurts parks; heat helps dessert; wind hurts outdoor', () => {
  const wf = (types, wx) => calculateCrowdScore(
    { types, user_ratings_total: 500, rating: 4.2 }, wx, new FakeClock(6, 15)
  ).factors.weather;
  const rain = { temp: 55, isRaining: true, windSpeed: 5 };
  assert.ok(wf(['park'], rain) < 0, 'rain must penalize a park');
  assert.ok(wf(['restaurant'], rain) > 0, 'rain must nudge people indoors');
  assert.ok(wf(['ice_cream_shop'], { temp: 90, isRaining: false, windSpeed: 0 })
          > wf(['ice_cream_shop'], { temp: 70, isRaining: false, windSpeed: 0 }),
    'hot weather must boost dessert above merely-nice weather');
  assert.ok(wf(['park'], { temp: 70, isRaining: false, windSpeed: 30 })
          < wf(['park'], { temp: 70, isRaining: false, windSpeed: 5 }),
    'high wind must penalize an outdoor venue');
});

// ---------------------------------------------------------------------------
// 6. Confidence: honest structure
// ---------------------------------------------------------------------------

test('a live weather reading is worth exactly 15 confidence points', () => {
  // Load-bearing across files: predictBusyness subtracts this same 15 when the
  // model runs without weather, "so a degraded prediction cannot report an
  // undegraded number". If the rule engine's weather bonus moves, that
  // compensation in mlPredictor.js must move with it.
  const clock = new FakeClock(5, 20);
  const venues = [
    { types: ['bar'], user_ratings_total: 800, rating: 4.4, price_level: 2 },
    { types: [], user_ratings_total: 0 },
    { types: ['restaurant', 'bar', 'cafe'], user_ratings_total: 20000, rating: 4.9, price_level: 3 },
  ];
  for (const venue of venues) {
    const withWx = calculateCrowdScore(venue, { temp: 70, isRaining: false }, clock).confidence;
    const withoutWx = calculateCrowdScore(venue, null, clock).confidence;
    assert.equal(withWx - withoutWx, 15,
      `weather moved confidence by ${withWx - withoutWx}, not 15`);
  }
});

test('confidence never falls as the venue\'s data gets richer', () => {
  const clock = new FakeClock(5, 20);
  let prev = -1;
  for (const reviews of [0, 10, 60, 120, 250, 600, 1200, 2500, 6000]) {
    const c = calculateCrowdScore(
      { types: ['restaurant'], user_ratings_total: reviews, rating: 4.4, price_level: 2 },
      null, clock
    ).confidence;
    assert.ok(c >= prev, `confidence fell from ${prev} to ${c} at ${reviews} reviews`);
    prev = c;
  }
});

test('the fallback never claims model provenance', () => {
  // The rule engine's data sources are Google + time patterns (+ weather when
  // it has a reading) — never 'ml_model'. The honest signal that the model
  // did NOT run is the predictionMethod/modelVersion pair, which mlPredictor
  // attaches at the boundary (pinned below).
  const clock = new FakeClock(5, 20);
  const venue = { types: ['bar'], user_ratings_total: 800, rating: 4.4 };
  const withWx = calculateCrowdScore(venue, { temp: 70 }, clock);
  const withoutWx = calculateCrowdScore(venue, null, clock);
  assert.deepEqual(withoutWx.dataSourcesUsed, ['google_places', 'time_patterns']);
  assert.deepEqual(withWx.dataSourcesUsed, ['google_places', 'time_patterns', 'weather']);
});

// ---------------------------------------------------------------------------
// 7. Forecast, capacity, wait: derived surfaces stay coherent
// ---------------------------------------------------------------------------

test('the hourly forecast is 1-hour steps of the same scoring function, labels included', () => {
  const venue = { types: ['bar'], user_ratings_total: 800, rating: 4.4, price_level: 2 };
  const wx = { temp: 70, isRaining: false };
  const base = new Date(2026, 7, 14, 0, 0, 0, 0); // local midnight, real Date
  const start = 20;
  const f = generateHourlyForecast(venue, wx, start, 8, base);
  assert.equal(f.length, 8);
  const expectedLabels = ['8 PM', '9 PM', '10 PM', '11 PM', '12 AM', '1 AM', '2 AM', '3 AM'];
  for (let i = 0; i < f.length; i++) {
    assert.equal(f[i].hour, expectedLabels[i], `label at index ${i}`);
    const ts = new Date(base);
    ts.setHours(start, 0, 0, 0);
    const direct = calculateCrowdScore(venue, wx, new Date(ts.getTime() + i * 3600000));
    assert.equal(f[i].score, direct.score, `forecast entry ${i} diverged from the scorer`);
    assert.equal(f[i].label, getLabel(f[i].score), `forecast label ${i} drifted from getLabel`);
  }
});

test('forecast defaults: 12 entries when count is omitted, every entry in bounds', () => {
  const venue = { types: ['restaurant'], user_ratings_total: 2000, rating: 4.5 };
  const f = generateHourlyForecast(venue, null, 9, null, new Date(2026, 7, 14, 0, 0, 0, 0));
  assert.equal(f.length, 12);
  for (const entry of f) {
    assert.ok(Number.isInteger(entry.score) && entry.score >= 0 && entry.score <= 100);
    assert.ok(typeof entry.hour === 'string' && /(AM|PM)$/.test(entry.hour));
  }
});

test('capacity: empty at 0, full at 100, monotone in between, for every category', () => {
  for (const [name, types] of Object.entries(CATEGORY_TYPES)) {
    for (const reviews of [0, 300, 1500, 8000]) {
      const venue = { types, user_ratings_total: reviews };
      const { max } = estimateCapacity(venue, 50);
      assert.ok(Number.isInteger(max) && max > 0, `${name}/${reviews}: max ${max}`);
      assert.equal(estimateCapacity(venue, 0).current, 0, `${name}: score 0 must mean empty`);
      assert.equal(estimateCapacity(venue, 100).current, max, `${name}: score 100 must mean full`);
      let prev = -1;
      for (const s of [0, 25, 50, 75, 100]) {
        const { current } = estimateCapacity(venue, s);
        assert.ok(current >= prev && current <= max, `${name}: capacity not monotone at score ${s}`);
        prev = current;
      }
    }
  }
});

test('every category yields a non-empty wait string at every score', () => {
  for (const [name, types] of Object.entries(CATEGORY_TYPES)) {
    for (let s = 0; s <= 100; s += 5) {
      for (const price of [undefined, 1, 4]) {
        const w = estimateWait(s, types, price);
        assert.ok(typeof w === 'string' && w.length > 0, `${name} score ${s} price ${price}`);
      }
    }
  }
});

test('fine dining at peak says reservations, not a generic table wait', () => {
  // Regression pin for the unreachable branch: estimateWait accepted a
  // priceLevel parameter but never forwarded it to isFineDining, so
  // `undefined >= 3` kept every fine-dining venue on the generic strings.
  assert.equal(estimateWait(95, ['french_restaurant'], 4), 'Reservation needed');
  assert.equal(estimateWait(20, ['french_restaurant'], 4), 'Walk-in likely');
  // Below the price gate the same types are a normal restaurant.
  assert.equal(estimateWait(95, ['french_restaurant'], 1), '35+ min');
  // Steakhouses keep their own reservation culture (dispatched before fine dining).
  assert.match(estimateWait(95, ['steak_house'], 4), /reserve/i);
});

// ---------------------------------------------------------------------------
// 8. The model/fallback boundary, from the caller's seat
// ---------------------------------------------------------------------------

test('with no model on disk, predictBusyness IS the rule engine plus an honest method tag', async () => {
  // Force the cold-start / model-missing path without touching the real model
  // files: mlPredictor checks fs.existsSync before anything else, so a fresh
  // module registry plus a patched existsSync exercises exactly the branch
  // that runs on every boot until the model loads.
  const fs = require('fs');
  const realExists = fs.existsSync;
  fs.existsSync = (p) => (/crowd_model\.onnx|model_metadata\.json/.test(String(p)) ? false : realExists(p));
  let ml;
  try {
    delete require.cache[require.resolve('../services/mlPredictor')];
    ml = require('../services/mlPredictor');

    const venue = { types: ['bar'], user_ratings_total: 800, rating: 4.4, price_level: 2, place_id: 'pin' };
    const wx = { temp: 70, isRaining: false };
    const ts = new Date(2026, 7, 15, 22, 0, 0, 0);

    const r = await ml.predictBusyness(venue, wx, ts);
    const direct = calculateCrowdScore(venue, wx, ts);

    // Identical numbers: the fallback is the rule engine, not a variant of it.
    assert.equal(r.score, direct.score);
    assert.equal(r.label, direct.label);
    assert.equal(r.confidence, direct.confidence);
    assert.deepEqual(r.factors, direct.factors);
    assert.deepEqual(r.dataSourcesUsed, direct.dataSourcesUsed);

    // The one honest difference: the method channel says the model did not run.
    assert.equal(r.predictionMethod, 'rule_engine');
    assert.equal(r.modelVersion, null);

    // Same response shape the ML path publishes, so no caller can tell the
    // difference structurally, because routes read these exact keys. The two event
    // fields are part of that shape rather than an ML-only extra: a caller
    // reads their ABSENCE as a street that was checked, so the exit that never
    // checks one is the exit that most needs to say so.
    assert.deepEqual(Object.keys(r).sort(), [
      'confidence', 'dataSourcesUsed', 'eventsObserved', 'eventsUnavailableReason',
      'factors', 'label', 'modelVersion', 'predictionMethod', 'score',
    ]);
    assert.equal(r.eventsObserved, false);
    assert.equal(r.eventsUnavailableReason, 'not_attempted');

    // And the forecast surface falls back to the same generator, same shape.
    const f = await ml.predictHourlyForecast(venue, wx, 20, 4, ts);
    assert.deepEqual(f, generateHourlyForecast(venue, wx, 20, 4, ts));
    for (const entry of f) {
      // predictionMethod joined every hourly entry in the skew fixes of
      // 2026-08-19: a strip must never mix ML hours and rule-engine hours
      // without saying so. On this rung every entry is the rule engine, and
      // the deepEqual above already pinned that the ML-path forecast and
      // generateHourlyForecast agree entry for entry.
      assert.deepEqual(Object.keys(entry).sort(),
        ['baselineScore', 'eventsObserved', 'eventsUnavailableReason',
          'hour', 'label', 'predictionMethod', 'score']);
      assert.equal(entry.predictionMethod, 'rule_engine');
      // The event pair joined every hourly entry on 2026-08-20. predictBusyness
      // had carried it since the contract landed and the strip copied five
      // fields out of the result and dropped it, so the one surface that shows
      // a whole night at once was the one with no way to tell a Ticketmaster
      // outage from a genuinely quiet street. On this rung no lookup is ever
      // attempted, and that is what the entry says rather than staying silent.
      assert.equal(entry.eventsObserved, false);
      assert.equal(entry.eventsUnavailableReason, 'not_attempted');
      // baselineScore joined every hourly entry on 2026-08-20, when the
      // best-time and peak lines moved off model deltas and onto the
      // popular-times curve for ORDERING (see crowdEngine.orderingAxis and
      // HOUR_ORDERING_MIN_GAP). On this rung there is no curve — the category
      // prior is answering — and null is what makes crowdEngine fall the whole
      // candidate set back to model scores instead of ranking a mixed strip on
      // two different numbers. A non-null here would be the rule engine
      // claiming a baseline it does not have.
      assert.equal(entry.baselineScore, null);
    }
  } finally {
    fs.existsSync = realExists;
    // Leave no half-initialized module for any later require in this process.
    delete require.cache[require.resolve('../services/mlPredictor')];
  }
});
