// A venue owner's first run, traced 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const onboarding = read('screens/VenueOnboarding.js');
const dash = read('screens/VenueDashboard.js');
const chat = read('components/VenueAdvisorChat.js');
const cards = read('components/VenueInsightCards.js');
const profile = read('screens/ProfileSettings.js');
const landing = read('website/LandingPage.js');
const api = read('services/api.js');

test('finishing onboarding hands the client its new role, the venue mode, and the dashboard', () => {
  expect(onboarding).toMatch(/created = await createVenueProfile\(venueOnboardingData\);/);
  expect(onboarding).toMatch(/if \(created\?\.role && typeof onUserPatch === 'function'\) onUserPatch\(\{ role: created\.role \}\);\s*setUserMode\('venue'\);/);
  expect(onboarding).toMatch(/localStorage\.setItem\('flockUserMode', 'venue'\)/);
  const props = app.slice(app.indexOf('const venueOnboardingProps = {'), app.indexOf('const venueOnboardingProps = {') + 400);
  expect(props).toMatch(/onUserPatch,\s*setShowModeSelection,/);
});

test('billing off is said as one sentence, not a plan the owner holds', () => {
  expect(app).toMatch(/setVenueBillingOn\(p\.billing_enabled !== false\);/);
  expect(dash).toMatch(/\{venueBillingOn && \(\s*<span style=\{\{ \.\.\.tierBadge\[venueData\.tier\]/);
  expect(dash).toMatch(/Every feature is on while venue plans are being set up\. Nothing is charged, and we will email you before anything is\./);
  expect(dash).toMatch(/\{venueBillingOn && venueTier === 'pro' \? <span/);
  expect(dash).toMatch(/\{venueBillingOn && venueTier === 'free' && <span/);
});

test('an unverified venue is not shown a zero for a feed the server withheld', () => {
  expect(app).toMatch(/incomingFlocksUnverified: unverified/);
  expect(dash).toMatch(/venueListErrors\.incomingFlocksUnverified\) /);
  expect(dash).toMatch(/This feed turns on once your venue is verified\./);
});

test('a claimed place is said at step one, with an address to write to', () => {
  expect(api).toMatch(/export async function checkVenueClaim\(placeId\)/);
  expect(onboarding).toMatch(/checkVenueClaim\(v\.place_id\)/);
  expect(onboarding).toMatch(/if \(r\?\.claimedByAnother\) setVenueSearchError\(/);
});

test('Roost shows the server\'s one reason instead of chips that all refuse', () => {
  expect(chat).toMatch(/setOffReason\(typeof data\?\.reason === 'string' \? data\.reason : ''\);/);
  expect(chat).toMatch(/\{offReason \|\| \(freeText \? LEAD_IN_FREE : LEAD_IN_CHIPS\)\}/);
});

test('the deal toast, the claim repair and the intelligence labels tell the truth', () => {
  expect(dash).toMatch(/venueIsVerified \? 'Deal posted\. It is on your venue card now\.' : 'Saved\. It goes on your card once your venue is verified\.'/);
  expect(app).not.toMatch(/applyVenue\(verifiedVenue, resolvedPlaceId, resolvedPlaceId !== savedPlaceId\)/);
  expect(app).toMatch(/applyVenue\(verifiedVenue, savedPlaceId, false\);/);
  expect(app).not.toMatch(/search by name for correct one/);
  expect(app).toMatch(/h\.open === 'Open 24 hours' \|\| \(h\.close && h\.open !== 'Closed'\)/);
  expect(dash).toMatch(/Flock rule engine: typical for a venue like yours, not measured here yet\./);
  expect(cards).toMatch(/Flock rule engine: typical for a venue like yours, not measured here yet\./);
  expect(dash).toMatch(/typical for your category/);
});

test('the promised door exists under You, and the website has one too', () => {
  expect(app).toMatch(/const openVenueDashboard = useCallback\(\(\) => \{\s*setUserMode\('venue'\);/);
  expect(app).toMatch(/>Change this later under You, then Venue dashboard<\/p>/);
  expect(app).not.toMatch(/You can switch modes anytime in your profile/);
  expect(profile).toMatch(/\{ l: 'Venue dashboard', s: 'venue', icon: Icons\.mapPin \}/);
  expect(profile).toMatch(/if \(m\.s === 'venue'\) \{ openVenueDashboard\(\); return; \}/);
  expect(landing).toMatch(/Already have a venue account\? <a href="\/app\?venue=true">Sign in<\/a>/);
  expect(app).toMatch(/get\('venue'\) === 'true'\) return 'venue-login';/);
  expect(onboarding).toMatch(/Pick all that apply\. You can change this later in Settings\./);
});
