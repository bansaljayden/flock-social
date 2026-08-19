// Run: node --test  (from backend/)
//
// EVERY CATEGORY THE MODEL WAS TRAINED ON MUST BE REACHABLE AT SERVE TIME.
//
// guessCategory maps Google Places types to the venue_category the model uses
// as a feature. If it cannot emit a category, that category's learned curve is
// dead weight in the artifact and every venue that should have used it is
// scored as something else.
//
// Until 2026-08-19 it could emit 10 of the model's 13 categories. nightclub,
// entertainment and park had encodings in category_encoding AND their own
// curves in category_baselines, and nothing live could select them.
//
// night_club was the expensive one, because it was routed to 'bar'. Those
// curves are not close. Friday, from the shipped artifact:
//
//     bar        peaks 20:00 at 52.6, and reads 40.5 at 23:00
//     nightclub  peaks 23:00 at 34.9, and reads 25.1 at 20:00
//
// A nightclub was told 52.6 at 8pm where its own cohort says 25.1. That is a
// 27-point error from the category label alone, against a model whose entire
// realtime MAE is 29.4 -- the mis-mapping was worth about as much error as the
// rest of the model combined, on the venue category most likely to pay for a
// dashboard.
//
// It was also a straight train/serve skew rather than a judgement call. The
// corpus labels nightclubs correctly: scripts/ml/discoverBestTime.js:84
// mapCategory() emits 'nightclub' by name, and scripts/ml/config.js assigns
// 'entertainment' to bowling alleys, arcades and amusement parks. Training knew
// about all three. Only inference did not.
//
// The last test here is the one that matters in a year: it reads the shipped
// metadata and asserts every encoded category is reachable, so a retrain that
// introduces a category cannot quietly ship an unreachable one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { guessCategory } = require('../services/mlPredictor')._internals;

const METADATA_PATH = path.join(
  __dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json'
);
const hasArtifact = fs.existsSync(METADATA_PATH);
const metadata = hasArtifact
  ? JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'))
  : null;

test('a nightclub is a nightclub, not a bar', () => {
  // Google returns both types on most clubs, so ordering is the fix: night_club
  // must be tested before bar or the first match wins and we are back to 2026.
  assert.strictEqual(guessCategory(['night_club', 'bar']), 'nightclub');
  assert.strictEqual(guessCategory(['bar', 'night_club']), 'nightclub');
  assert.strictEqual(guessCategory(['night_club']), 'nightclub');
});

test('the bar and nightclub curves are far enough apart to have mattered', () => {
  if (!hasArtifact) return; // a clone without the artifact cannot check this
  const cb = metadata.category_baselines;
  const at = (cat, hour) => cb[`${cat}_4_${hour}`]; // 4 = Friday

  const barAt20 = at('bar', 20);
  const clubAt20 = at('nightclub', 20);
  assert.ok(Number.isFinite(barAt20) && Number.isFinite(clubAt20));

  // The error a nightclub used to be served at its own quiet hour. Pinned as an
  // inequality rather than a constant so a retrain moves it without failing.
  assert.ok(
    barAt20 - clubAt20 > 15,
    `bar Fri 20:00 (${barAt20}) should sit far above nightclub (${clubAt20}); ` +
    'if these converge the mis-mapping stopped mattering and this test can go'
  );

  // And they peak at different times, which is the shape of the bug.
  const peakHour = (cat) => {
    let best = -1; let bestVal = -Infinity;
    for (let h = 12; h < 24; h += 1) {
      const v = at(cat, h);
      if (Number.isFinite(v) && v > bestVal) { bestVal = v; best = h; }
    }
    return best;
  };
  assert.ok(
    peakHour('nightclub') > peakHour('bar'),
    'a nightclub must peak later on a Friday than a bar'
  );
});

test('park and entertainment are reachable', () => {
  assert.strictEqual(guessCategory(['park']), 'park');
  assert.strictEqual(guessCategory(['national_park']), 'park');
  assert.strictEqual(guessCategory(['bowling_alley']), 'entertainment');
  assert.strictEqual(guessCategory(['video_arcade']), 'entertainment');
  assert.strictEqual(guessCategory(['amusement_park']), 'entertainment');
});

test('an amusement park is entertainment, not a park', () => {
  // Google returns 'park' on many amusement parks, and config.js counted those
  // as entertainment when the corpus was built. Inference has to agree.
  assert.strictEqual(guessCategory(['amusement_park', 'park']), 'entertainment');
  assert.strictEqual(guessCategory(['park', 'amusement_park']), 'entertainment');
});

test('the categories that already worked still work', () => {
  const unchanged = [
    [['bar'], 'bar'],
    [['pub'], 'bar'],
    [['cafe'], 'cafe'],
    [['coffee_shop'], 'cafe'],
    [['gym'], 'gym'],
    [['fitness_center'], 'gym'],
    [['shopping_mall'], 'mall'],
    [['museum'], 'museum'],
    [['movie_theater'], 'movie_theater'],
    [['fast_food_restaurant'], 'fast_food'],
    [['meal_takeaway'], 'fast_food'],
    [['bakery'], 'dessert'],
    [['ice_cream_shop'], 'dessert'],
    [['brewery'], 'brewery'],
  ];
  for (const [types, expected] of unchanged) {
    assert.strictEqual(guessCategory(types), expected, `${types[0]} -> ${expected}`);
  }
});

test('an unknown or empty type list still falls back to restaurant', () => {
  assert.strictEqual(guessCategory([]), 'restaurant');
  assert.strictEqual(guessCategory(null), 'restaurant');
  assert.strictEqual(guessCategory(undefined), 'restaurant');
  assert.strictEqual(guessCategory(['point_of_interest', 'establishment']), 'restaurant');
});

test('every category the shipped model encodes is reachable from some type list', () => {
  if (!hasArtifact) return;
  const encoded = Object.keys(metadata.category_encoding);

  // The types a real Places payload could carry for each encoded category. If a
  // retrain adds a category, this map must gain a row or the test fails, which
  // is the point: an unreachable category is a dead curve.
  const probes = {
    bar: ['bar'],
    brewery: ['brewery'],
    cafe: ['cafe'],
    dessert: ['bakery'],
    entertainment: ['bowling_alley'],
    fast_food: ['fast_food_restaurant'],
    gym: ['gym'],
    mall: ['shopping_mall'],
    movie_theater: ['movie_theater'],
    museum: ['museum'],
    nightclub: ['night_club'],
    park: ['park'],
    restaurant: ['restaurant'],
  };

  const unreachable = [];
  for (const cat of encoded) {
    const probe = probes[cat];
    if (!probe) {
      unreachable.push(`${cat} (no probe defined - add one to this test)`);
      continue;
    }
    if (guessCategory(probe) !== cat) {
      unreachable.push(`${cat} (probe ${JSON.stringify(probe)} gave ${guessCategory(probe)})`);
    }
  }

  assert.deepStrictEqual(
    unreachable, [],
    'every category the model encodes must be reachable at serve time, or its ' +
    'learned curve is dead and those venues are scored as something else'
  );
});
