const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// The public demo warms the photos its own answer named.
//
// A browser only fetches the pins it paints, so venues below the fold and
// cards nobody taps stay uncached, and the first request for one of those is
// the one that can fail and fall back to a letter or the placeholder bird.
// Warming them after the response closes that window.
//
// This file exists because the warm SPENDS MONEY. Every assertion below is a
// bound on that, and they are asserted against the source because the failure
// they guard against is a future edit removing a guard, not a wrong value at
// runtime. A behavioural suite would not notice a deleted budget check until
// the bill arrived.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'publicCrowd.js'), 'utf8');
const VENUE_SEARCH = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueSearch.js'), 'utf8');

const warmBlock = SRC.slice(SRC.indexOf('async function warmDemoPhotos'), SRC.indexOf('const PLACE_FIELDS'));

test('the warm never runs while the day budget is nearly spent', () => {
  // A warm must never be the thing that exhausts a ceiling a real viewer
  // needs. The number itself can move; the guard cannot disappear.
  assert.match(SRC, /const WARM_MIN_DAY_REMAINING = \d+;/);
  assert.match(warmBlock, /photoProxyStatus\(\)/);
  assert.match(warmBlock, /dayRemaining < WARM_MIN_DAY_REMAINING\) return;/);
});

test('it asks for one width, the same one the pin and the card share', () => {
  // Two widths meant two cache keys, two rows and two billable fetches for one
  // photograph, which is the defect the demo was carrying before.
  const widths = [...warmBlock.matchAll(/warmPhoto\([^,]+,\s*(\d+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(widths, ['400']);
  assert.match(SRC, /maxwidth=400/);
  assert.ok(!/maxwidth=160/.test(SRC), 'the 160 pin width is gone, so a photo is bought once');
});

test('it walks venues one at a time and never overlaps another run', () => {
  // Filling a cache quietly, not opening eight sockets to Google the moment
  // somebody loads a marketing page.
  assert.match(warmBlock, /for \(const ref of refs\)/);
  assert.ok(!/Promise\.all/.test(warmBlock), 'a parallel warm would burst the upstream');
  assert.match(SRC, /let warmInFlight = false;/);
  assert.match(warmBlock, /if \(warmInFlight\) return;/);
  assert.match(warmBlock, /finally \{\s*warmInFlight = false;\s*\}/);
});

test('it runs after the response and can never make a visitor wait', () => {
  const at = SRC.indexOf('res.json(presentArea(result, req));');
  const warmCall = SRC.indexOf('warmDemoPhotos(result.venues, req);');
  assert.ok(at > -1 && warmCall > at, 'the warm is fired after the answer is sent');
  // Not awaited, and the route does not become async on its account.
  assert.ok(!/await warmDemoPhotos/.test(SRC), 'awaiting it would delay the response');
});

test('every failure inside the warm is swallowed', () => {
  // Opportunistic by definition: a visitor must never see a worse answer
  // because a warm did not work.
  assert.match(warmBlock, /catch \{ \/\* opportunistic \*\/ \}/);
  assert.match(warmBlock, /catch \(err\) \{[\s\S]*console\.warn/);
});

test('the warm reuses the photo route rather than reimplementing the spend', () => {
  // fetchPhotoOnce is where the Postgres cache is read, the dead-name memo is
  // consulted, the charge is made and both tiers are written. A warmer with
  // its own copy of any of that would be a second opinion on money.
  assert.match(VENUE_SEARCH, /module\.exports\.warmPhoto = \(photoRef, maxWidth, req\) =>\s*\n\s*fetchPhotoOnce\(photoRef, maxWidth, photoCacheKey\(photoRef, maxWidth\), req\);/);
  assert.match(warmBlock, /require\('\.\/venueSearch'\)/);
  assert.ok(!/places\.googleapis\.com/.test(warmBlock), 'the warm never calls Google directly');
});
