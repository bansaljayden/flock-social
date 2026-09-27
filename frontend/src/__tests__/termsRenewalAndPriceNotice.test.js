/**
 * WHAT THE TERMS PROMISE ABOUT RENEWALS AND PRICE CHANGES, AND WHAT BACKS IT.
 *
 * Terms 9.6 (Roost) and 10.2 (Flock Pro on flockcorp.com) said "Before a
 * yearly plan renews, we email you" and "we email you at least 30 days before
 * a new price applies". Nothing in this repo sends either email:
 *
 *   - the renewal reminder is Stripe's own ("Send emails about upcoming
 *     renewals" in the Stripe account, 30 days ahead), so the Terms name Stripe
 *     as the sender, and the note in TermsOfService.js says the sentence goes
 *     if that setting is ever switched off;
 *   - no code can change the price of a plan somebody already has: Stripe
 *     charges each subscription the price it was created with, and the only
 *     change the backend ever makes to a live subscription is
 *     cancel_at_period_end. So the price line is written as the condition it
 *     is (a new price applies only after the email), not as a sender that runs.
 *
 * The pins below fail when either fact moves: a sender of our own for the
 * reminder, or code that moves a subscription to a new price, means these
 * sentences have to be read again. api/marketing-page.js mirrors the rendered
 * Terms and aiCrawlerSurface.test.js holds the two equal.
 *
 * Also here, two comment-only items from the same review: the homepage's
 * "Live crowd levels" is for the public while the global switch is off, and
 * says so; and CreateScreen.js describes its rebuild instead of quoting the
 * TestFlight report that asked for it.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const TERMS = read('frontend', 'src', 'website', 'TermsOfService.js');
const MIRROR = read('frontend', 'api', 'marketing-page.js');

describe('the renewal reminder names the sender that exists', () => {
  test('9.6 and 10.2 both say Stripe sends it, and neither says we do', () => {
    const says = TERMS.match(/Before a yearly plan renews, Stripe emails you a reminder on our behalf\./g) || [];
    expect(says).toHaveLength(2);
    expect(TERMS).not.toMatch(/Before a yearly plan renews, we email you/);
    expect(MIRROR).not.toMatch(/Before a yearly plan renews, we email you/);
  });

  test('the note names the Stripe setting and what happens if it is switched off', () => {
    expect(TERMS).toMatch(/"Send emails about\s+upcoming renewals" in the Stripe account's billing settings/);
    expect(TERMS).toMatch(/if that setting is ever switched\s+off the sentence comes\s+out with it/);
  });

  test('no reminder sender of our own exists; if one is added, reread these lines', () => {
    const webhook = read('backend', 'routes', 'stripeWebhook.js');
    expect(webhook).not.toMatch(/invoice\.upcoming/);
  });
});

describe('the price-change line is a condition, not a sender', () => {
  test('both sections say a new price applies only after the email', () => {
    expect(TERMS).toContain('A new price applies to your plan only after we have emailed the address on the venue account about it, at least 30 days ahead, and you can cancel before it does.');
    expect(TERMS).toContain('a new price applies to your plan only after we have emailed you about it, at least 30 days ahead, and you can cancel before it does.');
    expect(TERMS).not.toMatch(/we email you at least 30 days before a new price applies/i);
  });

  test('the only change the backend makes to a live subscription is cancel_at_period_end', () => {
    const services = ['proBilling.js', 'venueBilling.js'].map((f) => read('backend', 'services', f)).join('\n');
    const updates = services.match(/subscriptions\.update\([^)]*\)/g) || [];
    expect(updates.length).toBeGreaterThan(0);
    for (const call of updates) expect(call).toMatch(/cancel_at_period_end/);
    expect(services).not.toMatch(/subscriptionSchedules|subscription_schedule/);
  });

  test('the Terms carry the new effective date, and so does the mirror', () => {
    // Moved on again to September 27, when section 12 gained the one plan an
    // account deletion hands on instead of deleting. The mirror moves with it.
    expect(TERMS).toContain("const EFFECTIVE_DATE = 'September 27, 2026';");
    const terms = MIRROR.slice(MIRROR.indexOf('  terms: ['));
    expect(terms).toContain('["p", "Effective September 27, 2026"],');
  });
});

describe('where Flock Pro is sold', () => {
  // No iOS build sells Flock Pro (the App Store one is built with
  // REACT_APP_PURCHASES=off), so the Terms no longer say it can be bought in
  // the app. The App Store terms in 10.1 stay whole, for a version that does.
  const BOTH = [['Terms', TERMS], ['mirror', MIRROR]];

  test('neither copy says Pro can be bought in the iOS app today', () => {
    for (const [, text] of BOTH) {
      expect(text).not.toMatch(/Buy it in the iOS app and you cancel through Apple/);
      expect(text).not.toMatch(/Flock Pro can be bought in two places/);
      expect(text).toContain('The iOS app does not currently sell it; if a version of the app does, a subscription bought there is cancelled through Apple.');
      expect(text).toContain('Flock Pro is sold on flockcorp.com, under 10.2. The iOS app does not currently sell it. If a version of the app offers it, 10.1 sets out how a subscription bought there works.');
      expect(text).toContain('10.1 If bought in the iOS app');
    }
  });

  test('every App Store disclosure in 10.1 is still there', () => {
    for (const [, text] of BOTH) {
      expect(text).toMatch(/renews automatically at the end of each term at the then-current price/);
      expect(text).toMatch(/you manage and cancel the subscription in your Apple ID settings, not in Flock/);
      expect(text).toMatch(/handled by Apple under its own policies/);
      expect(text).toMatch(/Deleting your Flock account does not cancel a store subscription\./);
    }
  });
});

describe('the homepage speaks to the public', () => {
  test('its "Live crowd levels" line says why the review list does not change it', () => {
    const landing = read('frontend', 'src', 'website', 'LandingPage.js');
    const at = landing.indexOf("<li>{proOffer ? 'Crowd levels for 30 venues a month' : 'Live crowd levels'}</li>");
    expect(at).toBeGreaterThan(-1);
    const note = landing.slice(landing.lastIndexOf('{/*', at), at);
    expect(note).toMatch(/PAYWALL_PREVIEW_USER_IDS/);
    expect(note).toMatch(/\/api\/pro-offer is asked without an account and answers for\s+the public/);
  });
});

describe('source comments describe changes instead of quoting the people who asked', () => {
  test('CreateScreen.js no longer quotes the TestFlight report', () => {
    const create = read('frontend', 'src', 'screens', 'CreateScreen.js');
    expect(create).not.toMatch(/TestFlight report: "/);
    expect(create).toMatch(/rebuilt after a TestFlight report, to be more\s+\* detailed and better looking/);
  });
});
