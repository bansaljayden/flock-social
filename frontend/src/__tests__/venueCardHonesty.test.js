// Five things the venue sheet said that were not so, from the consumer
// venue-card trace of 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('a free venue does not read as "$"', () => {
  expect(app).toMatch(/\{venueDetailModal\.price_level > 0 && \(/);
  expect(app).toMatch(/\{'\$'\.repeat\(venueDetailModal\.price_level\)\}/);
  expect(app).toMatch(/\{v\.price_level > 0 && <span/);
  expect(app).not.toMatch(/'\$'\.repeat\([^)]*\|\| 1\)/);
});

test('the review count is the server total', () => {
  expect(app).toMatch(/const \[venueDetailReviewTotal, setVenueDetailReviewTotal\] = useState\(null\);/);
  expect(app).toMatch(/setVenueDetailReviewTotal\(Number\.isFinite\(d\.total\) \? d\.total : null\)/);
  expect(app).toMatch(/Flock Reviews\{venueDetailReviews \? ` \(\$\{venueDetailReviewTotal \?\? venueDetailReviews\.length\}\)` : ''\}/);
});

test('the reality check thanks by what the report will do, and says when it did not send', () => {
  const rc = app.slice(app.indexOf('const CrowdRealityCheck = React.memo('), app.indexOf('const CrowdRealityCheck = React.memo(') + 5000);
  expect(rc).toMatch(/setSent\(saved && saved\.verified \? 'verified' : 'unverified'\);/);
  expect(rc).toMatch(/this one is noted\./);
  expect(rc).toMatch(/That did not send\. Try again\./);
});

test('the review gate is said before the form, not after it', () => {
  expect(app).toMatch(/showReviewForm && !flocks\.some\(f => String\(f\.venueId\) === String\(venueDetailModal\.place_id\) && \(f\.memberCount \|\| 0\) >= 2\)/);
  expect(app).toMatch(/You can review a venue after you have been there with a flock\./);
});

test("Birdie's meter is seeded from entitlements, not from the first reply", () => {
  expect(app).toMatch(/if \(typeof data\?\.birdie\?\.remaining === 'number'\) setAiRemaining\(data\.birdie\.remaining\);/);
});

// ---------------------------------------------------------------------------
// The sheet's buttons have to be ON the sheet.
//
// Measured in a real browser at three widths on 2026-09-12, before the fix:
// the sheet is maxHeight 92vh with overflow hidden, and its column held
// photo 220 + scroller 32 + promotions 130 + reviews 355 + footer 73 = 810
// against 776 of sheet. Promotions and reviews had been added as SIBLINGS of
// the one scrolling block, so they carried their own height with nothing to
// give and the footer was pushed out through the clip. At 390 wide the Get
// Directions and Add to Flock row was cut in half; at 320 it sat 321px below
// the sheet, so the sheet's primary action could not be reached at all.
//
// jsdom does no layout, so this pins the shape the measurement proved right:
// one scroll region, opened before the details block and closed after the
// reviews, with the minHeight that lets a column flex item shrink.
// ---------------------------------------------------------------------------
describe('the venue sheet fits its own buttons', () => {
  // Ends at the footer marker, not at the words "Get Directions": a comment
  // forty lines above the sheet names that button too, and slicing to it gave
  // every assertion below an empty string to pass against.
  const FOOTER = '{/* Bottom action buttons */}';
  const sheet = app.slice(app.indexOf('const footerHasDirections ='), app.indexOf(FOOTER));

  test('one scroll region wraps the details, the promotions and the reviews', () => {
    const open = sheet.indexOf("<div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>");
    expect(open).toBeGreaterThan(-1);
    // Everything the sheet scrolls is inside it, and the footer is not.
    const promos = sheet.indexOf('Deals & Promotions');
    const reviews = sheet.indexOf('Flock Reviews');
    const close = sheet.indexOf('end of the scrolling region');
    expect(promos).toBeGreaterThan(open);
    expect(reviews).toBeGreaterThan(promos);
    expect(close).toBeGreaterThan(reviews);
  });

  test('the scroll region can actually shrink', () => {
    // Without minHeight 0 a column flex item refuses to go below its content,
    // so the region would hold full height and push the footer back out.
    expect(sheet).toMatch(/flex: 1, minHeight: 0, overflowY: 'auto'/);
  });

  test('the footer still refuses to shrink, so it keeps its full height', () => {
    const at = app.indexOf(FOOTER);
    const footer = app.slice(at, app.indexOf('Get Directions', at));
    expect(footer).toMatch(/flexShrink: 0/);
  });

  test('promotions and reviews are no longer siblings of the scroller', () => {
    // The tell for the regression: a second element carrying overflowY auto
    // at this level would mean the column has more than one scrolling child
    // again, which is how the heights came to be additive.
    const scrollers = sheet.match(/overflowY: 'auto'/g) || [];
    expect(scrollers).toHaveLength(1);
  });
});
