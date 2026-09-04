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
