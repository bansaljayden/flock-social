/**
 * "BIGGEST NIGHT AHEAD" READS THE WHOLE NIGHT AND NAMES IT FOR ITS EVENING.
 *
 * GET /api/venue-dashboard/intelligence scanned each evening from 5 PM to
 * 11 PM, so a club that peaks at 1 AM showed its 11 PM hour on this tile while
 * Roost named 1 AM (2026-11-03). Each evening now runs on into the small hours
 * its own curve keeps open, the night Roost's week uses, and an entry whose
 * peak falls after midnight carries `afterMidnight`. The tile keeps the
 * evening's day as its big word and says the hour belongs to that night, so
 * a Friday 1 AM peak never reads as Saturday's. The scan itself is pinned in
 * backend/__tests__/roostBiggestNightTile.test.js.
 *
 * Since 2026-11-04 each day is read on the venue's own listed hours, or the
 * window for its kind (backend routes/venueDashboard.js dayScanHours, pinned
 * in backend/__tests__/weekAheadWindow.test.js), and a week read by day, a
 * cafe's, makes this the "Biggest Day Ahead" (weekAheadDayWords.test.js
 * renders it).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern biggestNightTile
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const DASH = read('frontend', 'src', 'screens', 'VenueDashboard.js');
const ROUTE = read('backend', 'routes', 'venueDashboard.js');

function tile() {
  const start = DASH.indexOf("{weekByDay ? 'Biggest Day Ahead' : 'Biggest Night Ahead'}</p>");
  expect(start).toBeGreaterThan(-1);
  return DASH.slice(start, DASH.indexOf('</div>', start));
}

test('the tile names the evening and says a small-hours peak belongs to that night', () => {
  expect(tile()).toMatch(/\{weekPeak \? weekPeak\.weekday : '–'\}/);
  expect(tile()).toMatch(/at \$\{spokenHourLabel\(weekPeak\.peakHour\)\}\$\{weekPeak\.afterMidnight \? ' that night' : ''\}/);
});

test('the server reads each evening into the small hours its curve keeps open, and flags a peak there', () => {
  // With no hours on the listing, a bar's evening runs on into its curve's
  // small hours, marked as the next morning's clock.
  expect(ROUTE).toMatch(/nightTail = \(weekday\) => advisorFacts\.nightTailHours\(openByDay, \(weekday \+ 1\) % 7\)/);
  expect(ROUTE).toMatch(/\.\.\.curveTail\(weekday\)\.map\(\(h\) => \(\{ h, next: true \}\)\)/);
  // One run per day, over the hours it is read on.
  expect(ROUTE).toMatch(/const \{ start, count \} = scanRun\(scans\[i\]\);\s*return mlPredictor\.predictHourlyForecast\(venue, weather, start, count, day\);/);
  expect(ROUTE).toMatch(/\.\.\.\(peak && peak\.next \? \{ afterMidnight: true \} : \{\}\)/);
  // The night's own hours only, so a spring-forward strip's 5 AM is never it:
  // once the clock goes back past midnight, every bar after is the next day's.
  expect(ROUTE).toMatch(/if \(prev !== null && h < prev\) next = true;/);
});

test('a week the server read by day is the biggest DAY ahead, and a day with no number is never the biggest', () => {
  expect(DASH).toMatch(/const weekByDay = intelReady && venueIntel\.peakWindow === 'day';/);
  expect(DASH).toMatch(/venueIntel\.week\.filter\(\(d\) => Number\.isFinite\(d\.peakScore\)\)/);
});
