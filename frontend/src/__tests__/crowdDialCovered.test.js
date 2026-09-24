/**
 * THE DIAL IS COVERED ONCE A FREE MONTH IS SPENT (2026-09-24).
 *
 * The server withholds every crowd number for a venue a spent account has not
 * opened this month (backend/routes/crowd.js lockedCard, crowdVisibility), and
 * the backend tests pin that. These pin the client half: nothing on screen
 * invents a number the server did not send. The card is read as source, the
 * way venueDashboardMapTab.test.js reads it, because it is mounted only as a
 * lazy chunk with forty props from App.js.
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const CARD = read('components', 'venue', 'ConsumerVenueCard.js');
const APP = read('App.js');
const MAP = read('components', 'map', 'MapLibreMapView.js');
const SEARCH = read('components', 'SearchResultsOverlay.js');

describe('the venue card with its crowd reading withheld', () => {
  const lockedAt = CARD.indexOf("cdTagged.forecastAccess?.locked === true && !Number.isFinite(cdTagged.score)");

  test('returns its own block before any code can fall back to a score of zero', () => {
    expect(lockedAt).toBeGreaterThan(-1);
    // The fallback that turns a missing score into 0, and the client-side chart
    // generated from it, both come after the early return.
    expect(lockedAt).toBeLessThan(CARD.indexOf('const score = cd ? cd.score : (activeVenue.crowd || 0);'));
    expect(lockedAt).toBeLessThan(CARD.indexOf('const genHourly = () => {'));
  });

  test('says what is behind it, and only a consumer account is offered Pro', () => {
    const block = CARD.slice(lockedAt, CARD.indexOf('</m.div>', lockedAt));
    expect(block).toMatch(/Crowd level is part of Flock Pro/);
    expect(block).toMatch(/Places you already opened stay open\./);
    expect(block).toMatch(/\{!venueOwnerView && \(/);
    // The card names the venue, so the trip back from Stripe reopens it.
    expect(block).toMatch(/if \(!venueOwnerView\) setPaywallTrigger\('forecast', activeVenue && activeVenue\.place_id\)/);
    // No ring, no percentage, no chart in the covered block.
    expect(block).not.toMatch(/%/);
    expect(block).not.toMatch(/AnimatedDial|hourlyData|chartBars/);
  });
});

describe('lists and pins with a withheld number', () => {
  test('a withheld row takes back a number an earlier read left on the venue', () => {
    expect(APP).toMatch(/if \(p && p\.crowdLocked && \(v\.crowd != null \|\| v\.crowdLabel != null\)\) \{\s*changed = true;\s*return \{ \.\.\.v, crowd: null, crowdLabel: null \};/);
  });

  test('a covered card does not ask for a quieter-nearby list', () => {
    expect(APP).toMatch(/if \(data && !data\.forecastAccess\?\.locked && !\(typeof data\.score === 'number' && data\.score <= 39\)\) getCrowdAlternatives\(pid\)/);
  });

  test('a pin with no number prints none and adds nothing to the heatmap', () => {
    // App.js hands the pins null, never a number made up from the place id.
    expect(APP).toMatch(/const crowd = prediction \? prediction\.score : null;/);
    expect(MAP).toMatch(/aria-label', Number\.isFinite\(venue\.crowd\)/);
    expect(MAP).toMatch(/if \(shown && typeof v\.crowd === 'number'\)/);
  });

  test('a search row with no number shows no crowd badge', () => {
    expect(SEARCH).toMatch(/const crowdScore = prediction \? prediction\.score : venue\.crowd;/);
    expect(SEARCH).toMatch(/\{crowdScore != null && \(/);
  });
});
