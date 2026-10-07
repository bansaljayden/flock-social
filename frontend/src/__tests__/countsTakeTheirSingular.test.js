// Counts that can be one take their singular: "1 reviews", "All 1 spots",
// "for 1 months", and the money hub's "Not reachable venues" (found
// 2026-10-07 after the You tab's "1 interests").
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the consumer screens', () => {
  expect(read('components/overlays/VenueDetailSheet.js')).toContain("review${Number(venueDetailModal.user_ratings_total) === 1 ? '' : 's'}");
  expect(read('components/SearchResultsOverlay.js')).toContain("allVenues.length === 1 ? \"The one spot here is above your group's budget, so it does not show. The search worked.\"");
  const friends = read('screens/AddFriends.js');
  expect(friends).toContain('numbers and it is not on Flock yet. Try the rest in an hour.');
  expect(friends).toContain("contactsResult.checked === 1 ? 'The number we checked is not on Flock yet.");
});

test('the money hub', () => {
  const hub = read('screens/RevenueScreen.js');
  expect(hub).toContain("venuesNeeded(be.roost)");
  expect(hub).not.toContain('${needed(be.roost)} venues');
  expect(hub).toContain("after.bills === 1 ? 'bill set to end has'");
  expect(hub).toContain("hubPlural(c.durationInMonths, 'month', 'months')");
  expect(hub).not.toMatch(/\$\{cachedAge\} seconds/);
  expect(hub).toContain("hubPlural(numVenues - breakEvenVenues, 'venue', 'venues')");
});
