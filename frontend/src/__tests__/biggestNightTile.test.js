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
  const start = DASH.indexOf('Biggest Night Ahead</p>');
  expect(start).toBeGreaterThan(-1);
  return DASH.slice(start, DASH.indexOf('</div>', start));
}

test('the tile names the evening and says a small-hours peak belongs to that night', () => {
  expect(tile()).toMatch(/\{weekPeak \? weekPeak\.weekday : '–'\}/);
  expect(tile()).toMatch(/at \$\{spokenHourLabel\(weekPeak\.peakHour\)\}\$\{weekPeak\.afterMidnight \? ' that night' : ''\}/);
});

test('the server scans each evening into the small hours its curve keeps open, and flags a peak there', () => {
  expect(ROUTE).toMatch(/predictHourlyForecast\(venue, weather, 17, EVENING_HOURS \+ nightTail\(day\)\.length, day\)/);
  expect(ROUTE).toMatch(/advisorFacts\.nightTailHours\(openByDay, \(day\.getDay\(\) \+ 1\) % 7\)/);
  expect(ROUTE).toMatch(/\.\.\.\(afterMidnight \? \{ afterMidnight: true \} : \{\}\)/);
  // The night's own hours only, so a spring-forward strip's 5 AM is never it.
  expect(ROUTE).toMatch(/h >= 17 \|\| h <= advisorFacts\.NIGHT_TAIL_LAST_HOUR/);
});
