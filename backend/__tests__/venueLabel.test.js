// Run: node --test  (from backend/)
//
// ===========================================================================
// THE ATTRIBUTION LABEL IS CATEGORY-DERIVED, COMPUTED ONCE, AND NEVER
// HARDCODED.
//
// Owner readings used to ship under a hardcoded "the bar says" on every
// surface, and Flock serves cafes, breakfast spots, restaurants and clubs. The
// fix is utils/venueLabel.js: category in, "the {venue-type} says" out, with
// "the venue says" as the only fallback. services/ownerReports.js attaches the
// computed words to the ownerReport block; clients render the field.
//
// Four things pinned here:
//   1. The mapping — all 13 trained categories, owner-typed prose, and the
//      fallback.
//   2. categoryFromTypes agrees with mlPredictor.guessCategory on every type
//      list it matches (same ordering rules), and returns null instead of
//      guessCategory's forced 'restaurant' when nothing matched.
//   3. applyOwnerReport ships the label on the payload, in BOTH outcomes
//      (owner applied, owner outranked), from venueTypes or an explicit
//      category.
//   4. The literal "bar says" no longer appears hardcoded anywhere outside
//      this helper's tests — a repo grep, so a new surface cannot quietly
//      reintroduce the string the helper exists to replace.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const venueLabel = require('../utils/venueLabel');
const { guessCategory } = require('../services/mlPredictor')._internals;
const ownerReports = require('../services/ownerReports');
const tpl = require('../templates/venueDigestEmail');

// ---------------------------------------------------------------------------
// 1. The mapping
// ---------------------------------------------------------------------------

test('every trained category maps to its human word; nothing em-dashed, nothing capitalized', () => {
  const expected = {
    bar: 'the bar says',
    brewery: 'the brewery says',
    nightclub: 'the club says',
    cafe: 'the cafe says',
    restaurant: 'the restaurant says',
    fast_food: 'the restaurant says',
    dessert: 'the shop says',
    gym: 'the gym says',
    mall: 'the mall says',
    museum: 'the museum says',
    movie_theater: 'the theater says',
    entertainment: 'the venue says',
    park: 'the park says',
  };
  // The table above IS the 13-token vocabulary — a category added to the
  // helper without a row here fails, and vice versa.
  assert.deepStrictEqual(
    Object.keys(venueLabel.NOUN_BY_CATEGORY).sort(),
    Object.keys(expected).sort()
  );
  for (const [category, label] of Object.entries(expected)) {
    assert.strictEqual(venueLabel.ownerAttribution(category), label);
    assert.match(venueLabel.ownerAttribution(category), /^the [a-z]+ says$/,
      'lowercase leading "the", one word, no punctuation');
  }
});

test('unknown, missing and junk categories all fall back to "the venue says"', () => {
  for (const junk of [undefined, null, '', '   ', 'casino', 'laundromat', 42, {}, []]) {
    assert.strictEqual(venueLabel.ownerAttribution(junk), 'the venue says');
    assert.strictEqual(venueLabel.venueNoun(junk), 'venue');
  }
});

test('owner-typed prose from venue_profiles.category resolves to the right word', () => {
  // These are the venue signup's own display strings plus the shapes owners
  // actually type.
  const cases = {
    'Bar / Nightclub': 'bar',       // first recognized word wins
    'Night Club': 'nightclub',
    'Cafe / Coffee': 'cafe',
    'Coffee shop': 'cafe',
    'Brewery / Winery': 'brewery',
    'Restaurant': 'restaurant',
    'Breakfast spot': 'restaurant',
    'Diner': 'restaurant',
    'Lounge': 'bar',
    'Nightlife': 'bar',
    'Food': 'restaurant',
    'Movie Theater': 'movie_theater',
    'MOVIE_THEATER': 'movie_theater', // canonical token, any case
  };
  for (const [raw, want] of Object.entries(cases)) {
    assert.strictEqual(venueLabel.normalizeCategory(raw), want, `normalizeCategory(${JSON.stringify(raw)})`);
  }
  assert.strictEqual(venueLabel.normalizeCategory('Bespoke Axe Throwing'), null);
});

// ---------------------------------------------------------------------------
// 2. Agreement with the model's own mapper
// ---------------------------------------------------------------------------

test('categoryFromTypes matches guessCategory wherever it matches at all', () => {
  const lists = [
    ['night_club', 'bar'],          // ordering: club before bar
    ['bar'], ['pub'],
    ['cafe'], ['coffee_shop'],
    ['gym'], ['fitness_center'],
    ['shopping_mall'], ['museum'], ['movie_theater'],
    ['fast_food_restaurant'], ['meal_takeaway'],
    ['bakery'], ['ice_cream_shop'], ['brewery'],
    ['bowling_alley'], ['video_arcade'],
    ['amusement_park', 'park'],     // ordering: amusement_park before park
    ['park'], ['national_park'], ['state_park'],
    ['restaurant'], ['italian_restaurant', 'food'],
    ['breakfast_restaurant'],
  ];
  for (const types of lists) {
    const mine = venueLabel.categoryFromTypes(types);
    assert.notStrictEqual(mine, null, `expected a match for ${types}`);
    assert.strictEqual(mine, guessCategory(types),
      `label mapper and model mapper disagree on ${types}`);
  }
});

test('categoryFromTypes refuses to guess where guessCategory must', () => {
  // The model needs a category for every venue, so guessCategory falls back
  // to 'restaurant'. A LABEL saying "the restaurant says" about a casino is a
  // wrong public claim, so the label mapper returns null and the caller says
  // "the venue says".
  for (const types of [[], null, undefined, ['casino'], ['point_of_interest', 'establishment']]) {
    assert.strictEqual(venueLabel.categoryFromTypes(types), null);
  }
});

// ---------------------------------------------------------------------------
// 3. The serve payload carries the computed words
// ---------------------------------------------------------------------------

function freshOwnerRow(percent = 80) {
  return { id: 1, busy_percent: percent, retracted: false, created_at: new Date() };
}

test('an applied owner reading ships attribution and noun from the payload venueTypes', () => {
  const out = ownerReports.applyOwnerReport(
    { score: 40, label: 'Moderate', venueTypes: ['cafe', 'food'] },
    freshOwnerRow(80)
  );
  assert.strictEqual(out.ownerReport.applied, true);
  assert.strictEqual(out.ownerReport.noun, 'cafe');
  assert.strictEqual(out.ownerReport.attribution, 'the cafe says');
});

test('an outranked owner reading carries the same words beside the number', () => {
  const out = ownerReports.applyOwnerReport(
    {
      score: 40,
      rawEngineScore: 40,
      venueTypes: ['night_club', 'bar'],
      calibration: { feedbackUsed: true, reportCount: 5, predictionDrift: 0 },
    },
    freshOwnerRow(45)
  );
  assert.strictEqual(out.ownerReport.applied, false);
  assert.strictEqual(out.ownerReport.noun, 'club');
  assert.strictEqual(out.ownerReport.attribution, 'the club says');
});

test('an explicit options.category outranks the types, and no category means "the venue says"', () => {
  const withCategory = ownerReports.applyOwnerReport(
    { score: 40, venueTypes: ['bar'] },
    freshOwnerRow(),
    { category: 'Brewery / Winery' }
  );
  assert.strictEqual(withCategory.ownerReport.attribution, 'the brewery says');

  const withNothing = ownerReports.applyOwnerReport({ score: 40 }, freshOwnerRow());
  assert.strictEqual(withNothing.ownerReport.noun, 'venue');
  assert.strictEqual(withNothing.ownerReport.attribution, 'the venue says');
});

// ---------------------------------------------------------------------------
// 4. The digest speaks to the owner, and the literal is gone everywhere
// ---------------------------------------------------------------------------

test('the digest attributes owner readings in second person, never with the consumer label', () => {
  const text = tpl.renderDigestText({
    businessName: 'Test Cafe',
    tier: 'pro',
    cards: [{
      id: 'readings_vs_estimates',
      title: 'Your readings',
      status: 'ok',
      facts: [{ id: 'x', status: 'ok', label: 'Your peak reading was 80.', source: 'owner_report', asOf: '2026-08-17T00:00:00Z' }],
    }],
  });
  assert.match(text, /your reading/);
  assert.doesNotMatch(text, /bar says/i);
});

test('the literal "bar says" appears hardcoded nowhere outside the helper tests', () => {
  const roots = [
    path.join(__dirname, '..'),                              // backend/
    path.join(__dirname, '..', '..', 'frontend', 'src'),     // frontend/src/
  ];
  const skipDirs = new Set(['node_modules', '__tests__', 'build', 'dist', 'coverage', '.git']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(js|jsx|ts|tsx|sql|ejs|html)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // The helper is the one place allowed to know the words.
      if (full === path.join(__dirname, '..', 'utils', 'venueLabel.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/\bbar says\b/i.test(src)) offenders.push(full);
    }
  };
  for (const root of roots) walk(root);
  assert.deepStrictEqual(offenders, [],
    'a surface is hardcoding the attribution again — render the ownerReport ' +
    'attribution/noun fields, or use utils/venueLabel.js');
});
