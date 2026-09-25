/**
 * WHAT THE VENUE DASHBOARD PROMISES, ON EACH PLAN AND IN BOTH BILLING STATES.
 *
 * Two plans exist (VENUE-PRICING.md section 4): a free venue account, and
 * Roost. While VENUE_BILLING_ENABLED is off every venue gets everything, and
 * the dashboard reads that as Roost (`onRoost`). Once it is on, a free venue is
 * refused the forecast, the strip, the weekly summary and the advisor by
 * requirePro. Three sentences on the Settings tab were written for the first
 * state only:
 *
 *   * Verification said "your own forecast" turns on, which a verified free
 *     venue does not get.
 *   * The Monday email switch promised an email every Monday on every plan,
 *     while the sweep mails only a verified Roost venue with a linked listing,
 *     and only when DIGEST_ENABLED is on, and its description offered "new
 *     ratings" the email does not carry.
 *   * The Roost notice line said the notice "we emailed you" was running for
 *     a venue whose notice had not been sent.
 *
 * Each is a pure function of state now, so every combination is asserted
 * rather than argued.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venuePlanPromises --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const {
  verificationLine,
  roostNoticeLine,
  weeklyDigestOffered,
  WEEKLY_DIGEST_DESCRIPTION,
  mergeSavedProfile,
} = require('../screens/VenueDashboard');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const DASH = read('frontend', 'src', 'screens', 'VenueDashboard.js');

const STATES = [
  { verified: true, pending: false },
  { verified: false, pending: true },
  { verified: false, pending: false },
];

describe('what verification turns on, per plan', () => {
  test.each(STATES)('on a free plan (%o) the forecast is never promised by verification', (s) => {
    const line = verificationLine({ ...s, onRoost: false });
    expect(line).toMatch(/replies to reviews/i);
    expect(line).toMatch(/your live number/);
    expect(line).toMatch(/deals on your venue card/);
    // The forecast is named only as what Roost brings.
    expect(line).toMatch(/Your own forecast comes with Roost\./);
    expect(line.replace('Your own forecast comes with Roost.', '')).not.toMatch(/forecast/i);
    expect(line).not.toMatch(/Nothing more is needed from you/);
  });

  test.each(STATES)('on Roost, or with billing off (%o), the forecast is part of it', (s) => {
    const line = verificationLine({ ...s, onRoost: true });
    expect(line).toMatch(/your own forecast/);
    expect(line).not.toMatch(/comes with Roost/);
  });

  test('each state reads as that state', () => {
    expect(verificationLine({ verified: true, pending: false, onRoost: true })).toMatch(/ are on\.$/);
    expect(verificationLine({ verified: false, pending: true, onRoost: true })).toMatch(/once that clears/);
    expect(verificationLine({ verified: false, pending: false, onRoost: true })).toMatch(/^We confirm you own this venue by hand before/);
  });

  test('no line carries an em dash', () => {
    for (const s of STATES) {
      for (const onRoost of [true, false]) expect(verificationLine({ ...s, onRoost })).not.toMatch(/—/);
    }
  });

  test('the Settings card reads the plan', () => {
    expect(DASH).toMatch(/\{verificationLine\(\{\s*verified: venueIsVerified,\s*pending: !!\(venueVerificationPending \|\| verificationRequestNote\),\s*onRoost,\s*\}\)\}/);
    expect(DASH).not.toMatch(/your live number and your own forecast are on/);
  });
});

describe('the Roost notice line says only what has happened', () => {
  test('outside the window there is no line', () => {
    expect(roostNoticeLine(null)).toBeNull();
    expect(roostNoticeLine({ tier_notice_window: false, tier_notice_until: '2026-10-25T04:00:00.000Z' })).toBeNull();
  });

  test('before the notice is sent it does not point at an email', () => {
    const line = roostNoticeLine({ tier_notice_window: true, tier_notice_until: null });
    expect(line).toBe('Everything you had stays on, and nothing is being charged.');
    expect(line).not.toMatch(/email/i);
  });

  test('once it is sent, it names the notice', () => {
    expect(roostNoticeLine({ tier_notice_window: true, tier_notice_until: '2026-10-25T04:00:00.000Z' }))
      .toBe('Everything you had stays on while the notice we emailed you runs. Nothing is being charged.');
  });

  test('the Subscription card uses it, and the line under it still names the date or the email to come', () => {
    expect(DASH).toMatch(/venueProfile\?\.tier_notice_window === true\s*\? roostNoticeLine\(venueProfile\)/);
    expect(DASH).toContain("'We will email you at least 30 days before this changes'");
  });
});

describe('the Monday email switch shows only where the email goes', () => {
  const all = { digestEnabled: true, verified: true, onRoost: true, hasListing: true };

  test('every gate the sweep applies has to hold', () => {
    expect(weeklyDigestOffered(all)).toBe(true);
    for (const k of Object.keys(all)) {
      expect(weeklyDigestOffered({ ...all, [k]: false })).toBe(false);
    }
    // A profile from a server that does not say is not a yes.
    expect(weeklyDigestOffered({ ...all, digestEnabled: undefined })).toBe(false);
  });

  test('the switch is wrapped in that gate, fed by the profile the server sends', () => {
    expect(DASH).toMatch(/\{weeklyDigestOffered\(\{\s*digestEnabled: venueProfile\?\.digest_enabled,\s*verified: venueIsVerified,\s*onRoost,\s*hasListing: !!venueProfile\?\.google_place_id,\s*\}\) && \(/);
    const profileRoute = read('backend', 'routes', 'venueProfile.js');
    expect(profileRoute).toMatch(/digest_enabled: digestEnabled\(\),/);
    expect(profileRoute).toMatch(/const \{ digestEnabled \} = require\('\.\.\/services\/venueDigest'\);/);
  });

  test('the description names what the email carries, and no ratings', () => {
    expect(WEEKLY_DIGEST_DESCRIPTION).not.toMatch(/rating/i);
    expect(WEEKLY_DIGEST_DESCRIPTION).not.toMatch(/—/);
    expect(DASH).toContain('{WEEKLY_DIGEST_DESCRIPTION}');
    expect(DASH).not.toMatch(/new ratings/);
    // Every card the email sends is one the sentence describes.
    const digest = read('backend', 'services', 'venueDigest.js');
    const ids = [...digest.matchAll(/\{ id: '([a-z_]+)', title: '[^']*', tier: 'pro' \}/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(['around_you', 'last_night_verdict', 'listing_read_back', 'readings_vs_estimates', 'week_ahead']);
    const described = {
      last_night_verdict: /yesterday against your own numbers/,
      readings_vs_estimates: /your readings beside our estimates/,
      listing_read_back: /your listing read back/,
      week_ahead: /the week ahead/,
      around_you: /what is on around you/,
    };
    for (const id of ids) expect(WEEKLY_DIGEST_DESCRIPTION).toMatch(described[id]);
  });
});

describe('a save does not forget what the server worked out', () => {
  test('the PUT answer merges into the GET answer', () => {
    const fromGet = {
      business_name: 'Old', digest_enabled: true, billing_enabled: true,
      tier_notice_window: true, tier_notice_until: '2026-10-25T04:00:00.000Z',
      notification_prefs: { weekly: false },
    };
    const fromPut = { business_name: 'New', notification_prefs: { weekly: true } };
    const merged = mergeSavedProfile(fromGet, fromPut);
    expect(merged.business_name).toBe('New');
    expect(merged.notification_prefs.weekly).toBe(true);
    expect(merged.digest_enabled).toBe(true);
    expect(merged.tier_notice_window).toBe(true);
    expect(merged.tier_notice_until).toBe('2026-10-25T04:00:00.000Z');
    expect(mergeSavedProfile(fromGet, null)).toBe(fromGet);
  });

  test('both Settings saves merge rather than replace', () => {
    expect(DASH).not.toMatch(/setVenueProfile\(saved\)/);
    expect((DASH.match(/setVenueProfile\(\(prev\) => mergeSavedProfile\(prev, saved\)\)/g) || []).length).toBe(2);
  });
});
