/**
 * THE STRIP'S WORDS SAY WHICH HOURS ITS NUMBERS CAME FROM.
 *
 * GET /api/venue-dashboard/strip compares a venue with its own kind of place.
 * Bars, clubs and restaurants are ranked on the evening, 5 PM to midnight, and
 * any other kind of place on its whole day, because a coffee shop's strip is a
 * list of coffee shops and ranking them on hours they are shut draws a column
 * of near-empty bars. The answer carries `peakWindow` ('evening' or 'day'), and
 * the card has to follow it: a heading that says "Your Strip Tonight" over a
 * cafe's morning peaks, or "Projected busier than you tonight" under them, is
 * the same wrong claim the window change exists to stop.
 *
 * An answer with no peakWindow reads as an evening one, which is what every
 * answer was before the server had the choice.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern stripWindowWords
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const DASH = read('frontend', 'src', 'screens', 'VenueDashboard.js');
const ROUTE = read('backend', 'routes', 'venueDashboard.js');

/** The strip card, from its heading to the note under it. */
function stripCard() {
  const start = DASH.indexOf('{venueStrip?.available && (');
  expect(start).toBeGreaterThan(-1);
  const end = DASH.indexOf('points are too close to rank', start);
  expect(end).toBeGreaterThan(start);
  return DASH.slice(start, end);
}

describe('the card reads the window the server ranked on', () => {
  test("only a 'day' answer is read as the whole day", () => {
    expect(DASH).toMatch(/const stripAllDay = venueStrip\?\.peakWindow === 'day';/);
  });

  test('the heading says today for a whole-day strip and tonight otherwise', () => {
    expect(stripCard()).toMatch(/\{stripAllDay \? 'Your Strip Today' : 'Your Strip Tonight'\}<\/h3>/);
  });

  test('the ranking sentence under a row says the same', () => {
    expect(stripCard()).toMatch(/Projected \{v\.orderingClaim\} than you \{stripAllDay \? 'today' : 'tonight'\}/);
    expect(stripCard()).not.toMatch(/than you tonight\n/);
  });

  test('and so does the note under the card, whoever made the peaks', () => {
    const card = stripCard();
    const lines = card.match(/`Projected \$\{stripAllDay \? 'peaks today' : 'evening peaks'\} within 1\.5 km, from /g) || [];
    expect(lines).toHaveLength(2);
    expect(card).not.toMatch(/Projected evening peaks within/);
  });
});

describe('the server sends the window the card reads', () => {
  test("peakWindow is 'evening' or 'day', and the answer carries it", () => {
    const rule = ROUTE.slice(ROUTE.indexOf('function stripPeakWindow('));
    expect(rule).toMatch(/\? 'evening' : 'day';/);
    const route = ROUTE.slice(ROUTE.indexOf("router.get('/strip'"), ROUTE.indexOf('// ─── THE STRIP HEDGE'));
    expect(route).toMatch(/const peakWindow = stripPeakWindow\(includedTypes\);/);
    expect(route).toMatch(/\n\s+peakWindow,\n/);
  });
});
