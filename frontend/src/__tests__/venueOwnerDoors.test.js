// Four things a venue owner hit on a phone, from the owner-flow trace of
// 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a saved Venue mode routes to the dashboard on a return visit', () => {
  const app = read('App.js');
  const effect = app.slice(app.indexOf('const venueBootRoutedRef = useRef(false);'), app.indexOf("}, [userMode, authUser?.role, venueLoginFlag]);"));
  expect(effect).toMatch(/if \(userMode !== 'venue'\) return;/);
  expect(effect).toMatch(/if \(venueLoginFlag\) return;/);
  expect(effect).toMatch(/setCurrentScreen\('venueDashboard'\);/);
  expect(effect).toMatch(/setShowVenueOnboarding\(true\)/);
});

test('a plan check that could not run is an error with a retry, not a lock', () => {
  const app = read('App.js');
  expect(app).toMatch(/const locked = err\?\.code === 'UPGRADE_REQUIRED' && err\?\.data\?\.reason !== 'ENTITLEMENT_UNAVAILABLE';/);
  const chat = read('components/VenueAdvisorChat.js');
  expect(chat).toMatch(/if \(err\?\.status === 403 && err\?\.data\?\.reason !== 'ENTITLEMENT_UNAVAILABLE'\) \{/);
});

test('the promotions tab says deals publish only once the venue is verified', () => {
  const dash = read('screens/VenueDashboard.js');
  expect(dash).toMatch(/Deals show on your venue card once your venue is verified\. Until then a deal you post stays here and nobody sees it\./);
  const promo = dash.slice(dash.indexOf("venueTab === 'promotions' && can.postDeals"), dash.indexOf('{/* Create New Promotion Button */}'));
  expect(promo).toMatch(/!venueIsVerified && \(/);
  expect(promo).toMatch(/renderVerificationAsk\(\)/);
});

test('a retired reply shows as retired and the Reply button comes back', () => {
  const dash = read('screens/VenueDashboard.js');
  expect(dash).toMatch(/replied: !!r\.venue_reply && !r\.reply_needs_review,/);
  expect(dash).toMatch(/replyRetired: !!r\.reply_needs_review,/);
  expect(dash).toMatch(/The review was edited after this, so it is off your card\. Reply again to publish a new one\./);
});

test('replying over a retired reply makes the new reply live without a reload', () => {
  // The reply route answers RETURNING * and never the computed flag, so the
  // handler rebuilds it from the two columns the list read derives it from.
  // Left alone, the row kept reply_needs_review = true under the new words
  // and the mapper showed the fresh reply as retired with a Reply button.
  const dash = read('screens/VenueDashboard.js');
  const handler = dash.slice(dash.indexOf('const handleReplyToReview = async (reviewId) => {'), dash.indexOf('// Everything on the analytics tab is now computed'));
  expect(handler).toMatch(/reply_needs_review: updated\.venue_reply != null && updated\.venue_replied_at == null,/);
});

test('the analytics tab waits for the plan instead of opening on the paywall', () => {
  // venueTier is 'free' in App.js until GET /api/venue-profile answers, and
  // the tab drew the Premium lock on that default, then snapped to the real
  // tab. venueProfile is null until the same response, so it is the signal.
  const dash = read('screens/VenueDashboard.js');
  expect(dash).toMatch(/const tierKnown = venueProfile != null;/);
  expect(dash).toMatch(/venueTab === 'analytics' && !tierKnown && \(/);
  expect(dash).toMatch(/venueTab === 'analytics' && !can\.analytics && tierKnown && \(/);
  expect(dash).toMatch(/venueTab === 'analytics' && can\.analytics && tierKnown && \(<>/);
});
