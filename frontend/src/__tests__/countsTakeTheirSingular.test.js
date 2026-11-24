// Counts that can be one take their singular: "1 reviews", "All 1 spots",
// "for 1 months", and the money hub's "Not reachable venues" (found
// 2026-10-07 after the You tab's "1 interests").
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the consumer screens', () => {
  expect(read('components/overlays/VenueDetailSheet.js')).toContain("review${Number(venueDetailModal.user_ratings_total) === 1 ? '' : 's'}");
  expect(read('components/SearchResultsOverlay.js')).toContain("allVenues.length === 1 ? \"The one spot here is above your group's budget, so it does not show. The search worked.\"");
  // Add Friends' contacts counts (rebuilt 2026-11-23): every count in the
  // summary line can be one. addFriendsScreen.test.js renders both forms.
  const friends = read('screens/AddFriends.js');
  expect(friends).toContain("${count(checked)} ${checked === 1 ? 'number' : 'numbers'}.");
  expect(friends).toContain("${count(total)} ${total === 1 ? 'number' : 'numbers'}.");
  expect(friends).toContain("couldn't be read as ${unreadable === 1 ? 'a phone number' : 'phone numbers'}.");
  expect(friends).toContain("${count(sharedCount)} ${sharedCount === 1 ? 'contact' : 'contacts'} with Flock.");
});

test('the money hub', () => {
  const hub = read('screens/RevenueScreen.js');
  // The hub's words about the payload (hubSummaryWords among them) live in
  // lib/moneyHubSummary.js, which the screen and the admin tool share.
  const words = read('lib/moneyHubSummary.js');
  expect(hub).toContain("venuesNeeded(be.roost)");
  expect(hub).not.toContain('${needed(be.roost)} venues');
  expect(words).toContain("after.bills === 1 ? 'bill set to end has'");
  expect(hub).toContain("hubPlural(c.durationInMonths, 'month', 'months')");
  expect(hub).not.toMatch(/\$\{cachedAge\} seconds/);
  expect(hub).toContain("hubPlural(numVenues - breakEvenVenues, 'venue', 'venues')");
});
