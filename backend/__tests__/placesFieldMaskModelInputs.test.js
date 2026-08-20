// Run: node --test  (from backend/)
//
// THE THREE FIELDS A COST-CUTTING PASS WILL TRY TO DELETE, AND WHY IT MUST NOT.
//
// Google prices a Places (New) request at the tier of the most expensive field
// in its mask. `rating`, `userRatingCount`, `priceLevel` and
// `currentOpeningHours` are all ENTERPRISE fields, so every venue-shaped Places
// call in this repo bills at Text Search $35/1,000 and Place Details $20/1,000
// rather than the Pro $32 and $17 — and draws on a 1,000-call monthly free
// allowance instead of 5,000. That is a real and correctly-identified cost
// (services/costModel.js states it in its header), and the obvious saving is to
// strike the four fields from the masks.
//
// THREE OF THEM ARE MODEL INPUTS. services/mlPredictor.js buildFeatureMap reads:
//
//     const rating      = venue.rating || metadata.median_rating || 4.0;
//     const priceLevel  = venue.price_level != null ? venue.price_level
//                                                   : (metadata.median_price_level || 2);
//     const reviewCount = venue.user_ratings_total || venue.review_count || 0;
//
// and emits them as the trained columns `rating`, `price_level`, `review_count`
// and `log_review_count`, plus the `pt`/`pop` interaction terms. The training
// rows carry the real Google values (scripts/ml/discoverVenues.js writes them
// into ml_venues). So dropping a field does NOT raise an error and does not
// blank the feature — IT SUBSTITUTES THE CORPUS MEDIAN. Every venue silently
// becomes a 4.0-star, mid-priced, zero-review venue, `log_review_count` collapses
// from a real spread to a constant 0, and the model answers confidently on a row
// shape it was never trained on. That is train/serve skew, the failure class
// __tests__/serveTrainSkew.test.js exists for and the one this repo has now paid
// for twice.
//
// It has also already happened here, twice, and both times it was caught as a
// product bug rather than by a test:
//   * routes/badge.js round 10 — "rating/userRatingCount/priceLevel are all
//     consumed by the ML feature vector AND the rule fallback. Dropping them
//     made the public badge disagree with the in-app number for the same venue."
//   * routes/venueDashboard.js round 20 — the file had no priceLevel converter
//     at all, so both of its venue shapes omitted `price_level` and the owner's
//     own venue was scored at the corpus median; and `userRatingCount` was
//     missing from the searchNearby mask, so `review_count` read 0 for every
//     competitor.
//
// This test is the guard neither of those had. __tests__/venueSearchOffset.test.js
// pins something weaker and for a different reason — that SOME Enterprise field
// survives in the two venueSearch masks, so the note about utcOffsetMinutes being
// free stays true. It would stay green if `rating` and `priceLevel` were struck
// and only `currentOpeningHours` remained. This one names the three model inputs
// and checks EVERY venue-shaped mask in routes/ AND services/, including the ones
// reached through a constant.
//
// currentOpeningHours is deliberately NOT asserted here. It is not a model input
// — it drives the closed-hours zeroing, `isOpen`, the "Closed right now" badge
// and the hours list — so removing it is a visible product regression, not a
// silent numeric one, and a screen will say so. It is also load-bearing enough
// that dropping it alone would not move either SKU down a tier while rating and
// priceLevel remain.
//
// WHAT THIS TEST DOES NOT SAY: that the masks can never shrink. It says that
// shrinking one is a MODEL change, not a billing change, and has to be made on
// both sides of the pipeline at once — retrain without the column, or source the
// value from ml_venues, and then update this test in the same commit.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// routes/ AND services/. The sweep was routes-only until 2026-08-20, when the
// duplicate Place Details call on the venue detail screen was collapsed: the
// details mask moved out of routes/venueSearch.js into
// services/placeDetailsCache.js, which is now the single owner of that payload
// for BOTH the detail card and the crowd card. A routes-only sweep would have
// gone quietly from covering ten masks to covering eight, including losing
// sight of the one that feeds the model's serving path — which is the exact
// failure mode the floor assertion below exists to catch. A mask is covered by
// where it IS, not by which directory it started in.
const MASK_DIRS = [
  path.join(__dirname, '..', 'routes'),
  path.join(__dirname, '..', 'services'),
];

// The three trained columns, in the spelling Google's mask uses.
const MODEL_INPUTS = ['rating', 'userRatingCount', 'priceLevel'];

// A mask is "venue-shaped" if it asks Google for a venue's name. Every such
// call in this repo shapes a venue object that reaches predictBusyness, either
// directly or by being handed to the client and posted back to
// POST /api/crowd/batch (which whitelists rating / user_ratings_total /
// price_level off each body item for exactly that purpose). Masks that are not
// venue-shaped — scripts/ml/validateBusinessStatus.js asks for
// `id,businessStatus` — are none of this test's business.
const VENUE_SHAPED = 'displayName';

// Resolve the mask text at one `X-Goog-FieldMask` header site.
//
// Two forms appear in routes/: an inline string literal, and a reference to a
// module-level constant. The constant form is the one a naive grep misses, and
// it is where two of the masks live (routes/venueSearch.js SEARCH_FIELD_MASK and
// services/placeDetailsCache.js PLACE_DETAILS_FIELD_MASK, both built by
// .join(',') over an array), so resolving it is the difference between this test
// covering the files it most needs to and passing vacuously over them.
function resolveMask(src, rawValue) {
  const literal = rawValue.match(/^['"`]([^'"`]*)['"`]/);
  if (literal) return literal[1];

  // `PLACE_FIELDS` or `PLACE_FIELDS.replaceAll('places.', '')` — the base
  // identifier is what carries the field names either way.
  const ident = rawValue.match(/^([A-Za-z_$][\w$]*)/);
  if (!ident) return null;

  // Slice from the declaration to its terminating semicolon and take every
  // quoted fragment inside. That covers `= 'a,b,c';` and
  // `= ['a', 'b'].join(',');` with one rule.
  //
  // A plain `;\n` anchor, which is only safe because collectMasks strips CRLF
  // at the read. This repo is cloned with core.autocrlf=true and has no
  // .gitattributes, so git keeps LF in the object database and writes CRLF into
  // the working tree on every checkout: every tracked text file is CRLF on disk
  // here. Anchoring on `;\n` against those raw bytes matched nothing, which made
  // resolveMask return null for exactly the two masks it exists to resolve (the
  // ones behind a constant) and turned this file red about masks that were
  // perfectly fine. Normalizing once at the read fixes that for every pattern in
  // the file instead of one regex at a time.
  const decl = new RegExp(`const\\s+${ident[1]}\\s*=([\\s\\S]*?);\\n`);
  const body = src.match(decl);
  if (!body) return null;
  return (body[1].match(/['"`]([^'"`]*)['"`]/g) || [])
    .map((q) => q.slice(1, -1))
    .join(',');
}

function collectMasks() {
  const found = [];
  const files = MASK_DIRS.flatMap((dir) => fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: `${path.basename(dir)}/${f}`, full: path.join(dir, f) })));
  for (const { file, full } of files) {
    // LF-normalized at the read so every pattern below can anchor on a plain
    // `\n`. See resolveMask for what the CRLF working tree did to this file.
    const src = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    // Capture to end of line, NOT to the first comma: a mask literal is one
    // long comma-separated string, so a comma-terminated capture stops after
    // its first field and every assertion below then passes on a one-field
    // fragment. Both forms this file resolves fit on a single line.
    const re = /['"]X-Goog-FieldMask['"]\s*:\s*(.+)$/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
      const mask = resolveMask(src, m[1].trim());
      const line = src.slice(0, m.index).split('\n').length;
      found.push({ file, line, mask });
    }
  }
  return found;
}

test('every Places field mask in routes/ and services/ resolves — an unresolved one is an untested one', () => {
  const masks = collectMasks();

  // TEN today, and the one that went is a saving rather than a gap. It was
  // ELEVEN: ai.js x2, badge.js, crowd.js x2, publicCrowd.js x2,
  // venueDashboard.js x2, venueSearch.js x2. (The floor here used to read 10
  // against a real count of 11 — a floor one below the truth is a floor that
  // lets exactly one mask disappear unnoticed, so it is set to the real number
  // now.) On 2026-08-20 the two Place Details masks that were fetching the SAME
  // place id in the SAME tick — venueSearch's DETAILS_FIELD_MASK and crowd's
  // inline one, the second a strict subset of the first — became one mask in
  // services/placeDetailsCache.js, halving that SKU. Two masks became one; the
  // field list did not change. The floor is also what stops a broken regex from
  // turning this whole file green by finding nothing.
  assert.ok(masks.length >= 10,
    `expected at least 10 Places field masks under routes/ and services/, found ${masks.length}`);

  for (const { file, line, mask } of masks) {
    assert.ok(mask, `${file}:${line} — could not resolve the mask; extend resolveMask()`);
    assert.ok(mask.includes('places.id') || mask.includes('id'),
      `${file}:${line} — resolved to something that is not a field mask: ${mask}`);
  }
});

test('every venue-shaped mask still asks for the three model inputs', () => {
  const venueShaped = collectMasks().filter((m) => m.mask && m.mask.includes(VENUE_SHAPED));

  assert.ok(venueShaped.length >= 10,
    `expected at least 10 venue-shaped masks, found ${venueShaped.length}`);

  // The shared one is named explicitly. It is the mask the crowd model's serving
  // path now eats from, and it is the only one that lives outside routes/, so a
  // future sweep that quietly narrows the directory list fails here rather than
  // passing with one fewer mask.
  assert.ok(venueShaped.some((m) => m.file === 'services/placeDetailsCache.js'),
    'the shared Place Details mask must still be swept — it feeds both the detail card and the crowd card');

  for (const { file, line, mask } of venueShaped) {
    for (const field of MODEL_INPUTS) {
      // `places.rating` in a searchText/searchNearby mask, bare `rating` in a
      // Place Details one. Word-boundary so `rating` does not match inside
      // `userRatingCount`.
      const present = new RegExp(`(^|,)(places\\.)?${field}(,|$)`).test(mask);
      assert.ok(present,
        `${file}:${line} dropped '${field}' from its Places field mask.\n` +
        `  It is a TRAINED MODEL COLUMN, not a display field. buildFeatureMap\n` +
        `  falls back to the corpus median rather than erroring, so this change\n` +
        `  produces confidently wrong crowd numbers with nothing in the logs.\n` +
        `  If the field really is going away, retrain without the column (or read\n` +
        `  it from ml_venues) and update this test in the SAME commit.\n` +
        `  Mask was: ${mask}`);
    }
  }
});
