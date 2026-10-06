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
  runningRoostPlan,
  stripePlanLines,
  roostPlanDateLine,
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
    expect(DASH).toMatch(/venueProfile\?\.tier_notice_window === true\s*\? <VenueBillingStatus>\{\(\{ status \}\) => roostNoticeLine\(venueProfile, runningRoostPlan\(venueProfile, status\)\)\}<\/VenueBillingStatus>/);
    expect(DASH).toContain("'We will email you at least 30 days before this changes'");
  });

  test('a venue that subscribed inside its window is told a charge is coming, not that nothing is charged', () => {
    // It subscribed, so Stripe will charge on the day its notice named, and
    // the line used to say "Nothing is being charged" all the same.
    const profile = { tier_notice_window: true, tier_notice_until: '2026-10-25T04:00:00.000Z' };
    const plan = { status: 'trialing', trialEnd: '2026-10-25T04:00:00.000Z', currentPeriodEnd: '2026-10-25T04:00:00.000Z', cancelAt: null };
    const line = roostNoticeLine(profile, plan);
    expect(line).toBe('Everything you had stays on until your Roost plan starts billing.');
    expect(line).not.toMatch(/Nothing is being charged/);
    const named = new Date(plan.trialEnd).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    expect(roostPlanDateLine({ profile, plan, endsAt: null })).toBe(`First charge on ${named}`);
    // A plan set to end inside the window charges nothing, and says the old line.
    expect(roostNoticeLine(profile, { ...plan, cancelAt: '2026-10-25T04:00:00.000Z' }))
      .toBe('Everything you had stays on while the notice we emailed you runs. Nothing is being charged.');
  });
});

// The Subscription card named tier_expires_at, which for a Stripe plan was
// the period end plus three days of grace: a trial read "Runs until" three
// days after Stripe charged at its end, and so did a renewing plan and one set
// to end. It now names Stripe's own date, the one it means.
describe('a Stripe plan names its real date, never the grace', () => {
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const TRIAL_END = '2026-11-02T15:00:00.000Z';
  const PERIOD_END = '2026-12-02T15:00:00.000Z';
  const GRACE_END = '2026-12-05T15:00:00.000Z';

  test('a trial names the day it is charged', () => {
    const lines = stripePlanLines({ status: 'trialing', trialEnd: TRIAL_END, currentPeriodEnd: TRIAL_END, cancelAt: null });
    expect(lines.line).toBe('On the free trial.');
    expect(lines.date).toBe(`First charge on ${day(TRIAL_END)}`);
  });

  test('a renewing plan names the day it renews', () => {
    const lines = stripePlanLines({ status: 'active', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: null });
    expect(lines.line).toBe('Billed through Stripe.');
    expect(lines.date).toBe(`Renews on ${day(PERIOD_END)}`);
  });

  test('a plan set to end names the day it ends, trial or not', () => {
    expect(stripePlanLines({ status: 'active', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: PERIOD_END }).date).toBe(`Ends on ${day(PERIOD_END)}`);
    const trial = stripePlanLines({ status: 'trialing', trialEnd: TRIAL_END, currentPeriodEnd: TRIAL_END, cancelAt: TRIAL_END });
    expect(trial.line).toBe('On the free trial. It ends without a charge.');
    expect(trial.date).toBe(`Ends on ${day(TRIAL_END)}`);
  });

  test('a failed payment is said, with no date that suggests all is well', () => {
    expect(stripePlanLines({ status: 'past_due', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: null }))
      .toEqual({ line: 'The last payment did not go through. Update your card in Manage billing.', date: null });
  });

  test('the date line takes the plan\'s date over the grace-carrying end the profile also sends', () => {
    const plan = { status: 'active', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: null };
    expect(roostPlanDateLine({ profile: {}, plan, endsAt: GRACE_END })).toBe(`Renews on ${day(PERIOD_END)}`);
    // A plan we set up by hand keeps "Runs until" its own date.
    expect(roostPlanDateLine({ profile: {}, plan: null, endsAt: GRACE_END })).toBe(`Runs until ${day(GRACE_END)}`);
    expect(roostPlanDateLine({ profile: {}, plan: null, endsAt: null })).toBe('No end date');
  });

  test('the running plan comes from the status on the web, and from the profile inside the app', () => {
    const profile = {
      tier_source: 'stripe', tier_status: 'trialing', tier_trial_end: TRIAL_END,
      tier_current_period_end: TRIAL_END, tier_cancel_at: null,
    };
    expect(runningRoostPlan(profile, null)).toEqual({ status: 'trialing', trialEnd: TRIAL_END, currentPeriodEnd: TRIAL_END, cancelAt: null });
    const status = { subscriptionStatus: 'active', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: null };
    expect(runningRoostPlan(profile, status)).toEqual({ status: 'active', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: null });
    // The status read Stripe a moment ago: nothing running is nothing running.
    expect(runningRoostPlan(profile, { subscriptionStatus: null })).toBeNull();
    // A comp, or a plan that has ended, is not a running Stripe plan.
    expect(runningRoostPlan({ ...profile, tier_source: 'comp' }, null)).toBeNull();
    expect(runningRoostPlan({ ...profile, tier_status: 'canceled' }, null)).toBeNull();
  });

  test('the card reads both lines from the plan', () => {
    expect(DASH).toContain('<VenueBillingStatus>{({ status }) => roostPlanDateLine({ profile: venueProfile, plan: runningRoostPlan(venueProfile, status), endsAt: venueTierEndsAt })}</VenueBillingStatus>');
  });

  test('no line carries an em dash', () => {
    const plans = [
      { status: 'trialing', trialEnd: TRIAL_END, currentPeriodEnd: TRIAL_END, cancelAt: null },
      { status: 'trialing', trialEnd: TRIAL_END, currentPeriodEnd: TRIAL_END, cancelAt: TRIAL_END },
      { status: 'active', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: null },
      { status: 'active', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: PERIOD_END },
      { status: 'past_due', trialEnd: null, currentPeriodEnd: PERIOD_END, cancelAt: null },
    ];
    for (const p of plans) {
      const { line, date } = stripePlanLines(p);
      expect(line).not.toMatch(/—/);
      if (date) expect(date).not.toMatch(/—/);
    }
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

  // Three since 2026-10-03: Venue Information merges its answer too, so a
  // rename reaches the header the dashboard reads.
  test('every Settings save merges rather than replaces', () => {
    expect(DASH).not.toMatch(/setVenueProfile\(saved\)/);
    expect((DASH.match(/setVenueProfile\(\(prev\) => mergeSavedProfile\(prev, saved\)\)/g) || []).length).toBe(3);
    expect(DASH).toMatch(/const saved = await updateVenueProfile\(\{ businessName: venueInfo\.name, location: venueInfo\.address, phone: venueInfo\.phone \}\);\s*setVenueProfile\(\(prev\) => mergeSavedProfile\(prev, saved\)\);/);
  });
});

describe('the Monday email has one name, and the This Week card another', () => {
  // The switch said "Weekly reports", the email footer "weekly reports are
  // turned on", the unsubscribe page "Turn off the Monday digest?" and then
  // "the Weekly reports switch", the Terms "the Monday digest" and the Privacy
  // Policy "weekly digest". Beside it the plan list sold "The weekly summary",
  // which is the This Week card on the Analytics tab and not the email at all,
  // so an owner turning off weekly reports could not tell which one they had
  // turned off. Every surface that names either now uses one name for each.
  const strip = (s) => s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const SURFACES = [
    ['VenueDashboard.js', strip(DASH)],
    ['TermsOfService.js', strip(read('frontend', 'src', 'website', 'TermsOfService.js'))],
    ['PrivacyPolicy.js', strip(read('frontend', 'src', 'website', 'PrivacyPolicy.js'))],
    ['marketing-page.js', strip(read('frontend', 'api', 'marketing-page.js'))],
    ['venueDigest.js', strip(read('backend', 'routes', 'venueDigest.js'))],
    ['venueDigestEmail.js', strip(read('backend', 'templates', 'venueDigestEmail.js'))],
    ['roostNoticeEmail.js', strip(read('backend', 'templates', 'roostNoticeEmail.js'))],
    ['venueDashboard.js (route)', strip(read('backend', 'routes', 'venueDashboard.js'))],
  ];
  const OLD_NAMES = [
    /weekly reports?/i,
    /Monday (venue )?digest/i,
    /weekly digest/i,
    /digest (email|sends)/i,
    /venue digest send/i,
    /weekly summary/i,
  ];

  test('no surface uses an old name for either', () => {
    const hits = [];
    for (const [name, text] of SURFACES) {
      for (const re of OLD_NAMES) {
        const m = text.replace(/\s+/g, ' ').match(re);
        if (m) hits.push(`${name}: "${m[0]}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('the switch, its toast and the plan list say the new names', () => {
    expect(DASH).toContain('Monday email</h3>');
    expect(DASH).toContain('aria-label="Monday email"');
    expect(DASH).toContain("showToast(weekly ? 'Monday email on. The first one comes Monday morning.' : 'Monday email off.');");
    expect(DASH).toContain("'This Week: what your venue did over the last 7 days',");
    expect(DASH).toContain('>This Week</h3>');
  });

  test('the Terms and the Privacy Policy name the email the way the switch does', () => {
    const terms = strip(read('frontend', 'src', 'website', 'TermsOfService.js')).replace(/\s+/g, ' ');
    const privacy = strip(read('frontend', 'src', 'website', 'PrivacyPolicy.js')).replace(/\s+/g, ' ');
    expect(terms).toContain('the week view and the Monday email.');
    expect(privacy).toContain('Turning off the Monday email switches off a setting on your venue account');
    expect(privacy).toContain('The Monday email is off by default and only sends if a venue owner switches it on.');
  });
});
