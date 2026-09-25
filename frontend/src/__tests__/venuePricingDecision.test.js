// ---------------------------------------------------------------------------
// Venue pricing: two plans, a free venue account and Roost at $99/mo.
//
// VENUE-PRICING.md section 4 collapsed the venue tiers to two. The $35 middle
// plan is retired, its server-side gates went with it (promotions, events and
// the incoming-flocks feed are free, backend/routes/venueDashboard.js), and
// nothing on a screen may offer it. Roost is $99 a month or $990 a year per
// location: the number backend/routes/admin.js bills against
// (`VENUE_PRICE_USD`), Terms 9.6 publishes and Stripe charges.
//
// This suite exists so that following a stale doc breaks the build instead of
// the price. The retired figures ($35 and $75, and the $49/$149 of an older
// proposal) are checked against everything that can reach a screen.
//
// If one of these fails because the plans were re-priced on purpose, update
// VENUE-BILLING.md's table, backend/services/statedPrices.js and this file in
// the same commit. Nothing else counts as a reason to touch it.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js). The app source is simply in two
// files, so both are read, in the order they used to be one.
const app = read('frontend', 'src', 'App.js') + read('frontend', 'src', 'screens', 'VenueDashboard.js');
const billing = read('VENUE-BILLING.md');

// Comments carry reasoning (including quotes of the retired numbers) and are
// allowed any content. Only what can reach a screen is under test. Same
// stripping rule as landingPageClaims.test.js.
const visible = app
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// The plan cards' own copy, the one place a feature is sold by name.
const features = (() => {
  const at = visible.indexOf('const features = {');
  return at === -1 ? '' : visible.slice(at, visible.indexOf('};', at));
})();

describe('the app renders the decided venue price', () => {
  // One module constant, read by the Roost card and every lock whenever
  // Stripe's own price is not available: pin the constant, not the strings it
  // renders into.
  test('one constant holds the Roost price, and nothing else', () => {
    const m = app.match(/const VENUE_PLAN_PRICE = \{ pro: (\d+) \};/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(99);
  });

  test('no screen hardcodes a venue price beside the constant', () => {
    for (const literal of ['$35/mo', '$75/mo', '$99/mo', '$35/month', '$75/month', '$99/month']) {
      expect(visible).not.toContain(literal);
    }
  });

  test('the retired prices never reach a screen', () => {
    // $35 was the middle plan, $75 the Pro price it sat under, and $49/$149 a
    // proposal older than both.
    expect(visible).not.toMatch(/\$35\b/);
    expect(visible).not.toMatch(/\$75\b/);
    expect(visible).not.toMatch(/\$49\b/);
    expect(visible).not.toMatch(/\$149\b/);
  });

  test('two plan cards, and the paid one is called Roost, never Pro', () => {
    expect(features).toMatch(/free: \[/);
    expect(features).toMatch(/roost: \[/);
    expect(features).not.toMatch(/\b(premium|pro): \[/);
    expect(app).toContain('features.free.map');
    expect(app).toContain('features.roost.map');
    expect(app).not.toMatch(/features\.(premium|pro)\b/);
    expect(visible).toContain('Email us about Roost');
    expect(visible).not.toMatch(/Email us about (Premium|Pro)\b/);
    expect(visible).not.toContain('Everything in Premium');
  });

  test('every lock names Roost and the price the Roost card prints', () => {
    expect(app).toContain("Requires Roost · <VenueBillingStatus>{({ status }) => roostPlanPriceLabel(status) || venuePlanPriceLabel('pro')}</VenueBillingStatus>");
    expect(visible).not.toMatch(/Requires (Pro|Premium)\b/);
    expect(visible).not.toMatch(/Upgrade to (Pro|Premium)\b/);
    expect(app).not.toContain("venuePlanPriceLabel('premium')");
  });

  test('no plan card sells a feature nothing builds', () => {
    // Nothing reads a venue's plan when the map is drawn, a vote list is ranked
    // or a push goes out, and there are no bookings (DESIGN-STANDARD.md C1).
    expect(features.length).toBeGreaterThan(0);
    expect(features).not.toMatch(/visibilit|sponsor|placement|push|booking|book a /i);
  });

  test('the capability flags for features nobody built are gone', () => {
    for (const flag of ['enhancedVisibility', 'sponsoredPlacement', 'aiRecommendations', 'pushNotifications', 'detailedInsights']) {
      expect(app).not.toContain(`${flag}:`);
    }
    expect(app).not.toMatch(/\bbooking: venueTier/);
  });

  // The venue settings screen printed "Pro Plan / $75/month / No end date" and
  // offered no way to change or cancel it (TestFlight build 26). Both halves
  // are pinned: the price is gone from the settings screen, and a real route to
  // a human is present.
  test('the settings screen offers a way out of the plan', () => {
    expect(app).toContain('Change or cancel this plan');
    expect(app).toContain('See plans and pricing');
  });

  // support@flockcorp.com is an unverified mailbox (DESIGN-STANDARD section B) and
  // CommunityGuidelines.js routes every contact path to social@ for that
  // reason. A cancellation request is the worst thing to send to a mailbox
  // nobody has confirmed receives mail.
  test('every venue contact route uses the verified mailbox', () => {
    expect(visible).not.toContain('support@flockcorp.com');
    expect(app).toContain("const VENUE_SALES_EMAIL = 'social@flockcorp.com';");
  });
});

describe('VENUE-BILLING.md agrees with the app', () => {
  const roostRow = () => billing.match(/\| Roost \(`pro`\) \| \*\*\$(\d+)\*\* \| \$(\d+) \|/);

  test('the plan table is the free venue account and Roost, and nothing between', () => {
    expect(billing).toMatch(/\| Venue account \(`free`\) \| \*\*\$0\*\* \| \$0 \|/);
    expect(roostRow()).not.toBeNull();
    expect(billing).not.toMatch(/\| Premium \(`premium`\) \|/);
  });

  test('the doc records the two-plan decision and where it was made', () => {
    // The decision itself lives in VENUE-PRICING.md section 4, a private
    // memo; the tracked doc has to point at it, which is what this pins.
    expect(billing).toMatch(/Two plans since 2026-09-25: a free venue account and Roost at \$99\/month or\s+\$990\/year, per VENUE-PRICING\.md section 4/);
  });

  test('the doc and the app agree on the Roost price', () => {
    const fromApp = app.match(/const VENUE_PLAN_PRICE = \{ pro: (\d+) \};/);
    expect(fromApp).not.toBeNull();
    expect(roostRow()).not.toBeNull();
    expect(fromApp[1]).toBe(roostRow()[1]);
  });

  test('the annual column is the two-months-free arithmetic', () => {
    // 2 mo free means annual = 10 x monthly. Recomputed, not left from a
    // superseded table: a stale annual figure beside a new monthly one is
    // exactly the drift this catches.
    const row = roostRow();
    expect(row).not.toBeNull();
    expect(Number(row[2])).toBe(10 * Number(row[1]));
  });
});
