/**
 * A settings save drops the Roost cards' held answer (venue audit 2026-10-03).
 * The cards hold their payload for a minute and most refuse by asking for a
 * value in Settings; the card file says the dashboard clears it on a save, and
 * nothing did, so an owner who entered the value came back to the same refusal.
 * FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const DASH = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');

test('the dashboard imports the clear and calls it after each settings save that changes what a card reads', () => {
  expect(DASH).toContain("import VenueInsightCards, { clearAdvisorCards } from '../components/VenueInsightCards';");
  expect((DASH.match(/clearAdvisorCards\(\);/g) || []).length).toBe(3);
  expect(DASH).toMatch(/updateVenueProfile\(venueIntakeDraft\);\s*setVenueProfile\(\(prev\) => mergeSavedProfile\(prev, saved\)\);\s*clearAdvisorCards\(\);/);
  expect(DASH).toMatch(/await updateVenueProfile\(\{ operatingHours \}\);\s*clearAdvisorCards\(\);/);
});
