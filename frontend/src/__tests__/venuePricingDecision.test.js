// ---------------------------------------------------------------------------
// Venue pricing: $99/mo Pro, $35/mo Premium. Re-priced 2026-08-25.
//
// $99 is VENUE-PRICING.md's call (2026-08-20), which supersedes the $75 Pro
// price this file used to pin. The re-price was not bookkeeping: the backend
// has held $99 since that memo (`VENUE_PRICE_USD` in backend/routes/admin.js)
// while three screens said $75, so the app disagreed with the only place in
// the product that has ever stored a venue price.
//
// Premium's $35 survives on purpose. VENUE-PRICING.md section 4 retires the
// rung and collapses to two tiers, but that also drops the `requirePremium`
// gates on promotions, events and incoming-flocks. Two cards over gates that
// still refuse would advertise features the backend denies, so the collapse is
// a commit that must include backend/routes, and this file needs rewriting
// again when it lands.
//
// This suite exists so that following a stale doc breaks the build instead of
// the price. Several older docs (README.md, MONEY-MODEL.md, SUBMIT-CHECKLIST.md)
// still say "fix the app to $49/$149"; that has been backwards since
// 2026-08-14 and is checked against below.
//
// If one of these fails because Jayden re-priced the tiers on purpose, update
// VENUE-BILLING.md's table and this file in the same commit. Nothing else
// counts as a reason to touch it.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const app = read('frontend', 'src', 'App.js');
const billing = read('VENUE-BILLING.md');

// Comments carry reasoning (including quotes of the superseded numbers) and
// are allowed any content. Only what can reach a screen is under test. Same
// stripping rule as landingPageClaims.test.js.
const visible = app
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the app renders the decided venue prices', () => {
  // The three screens that used to hold three separate copies of the number
  // now read one module constant, so the assertion moved with them: pin the
  // constant, not the string literals it renders into.
  test('one constant holds both prices, and it is the decided pair', () => {
    const m = app.match(/const VENUE_PLAN_PRICE = \{ premium: (\d+), pro: (\d+) \};/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(35);
    expect(Number(m[2])).toBe(99);
  });

  test('no screen hardcodes a venue price beside the constant', () => {
    // The whole point of the constant is that $75 cannot come back by hand in
    // one of the three places that used to carry it. $99 and $35 are equally
    // banned as literals: they belong in VENUE_PLAN_PRICE and nowhere else.
    for (const literal of ['$35/mo', '$75/mo', '$99/mo', '$35/month', '$75/month', '$99/month']) {
      expect(visible).not.toContain(literal);
    }
  });

  test('the LockedTab upsell and the plan cards read the constant', () => {
    expect(app).toContain("venuePlanPriceLabel('pro')");
    expect(app).toContain("venuePlanPriceLabel('premium')");
  });

  test('the superseded $49/$149 prices never reach a screen', () => {
    expect(visible).not.toMatch(/\$49\b/);
    expect(visible).not.toMatch(/\$149\b/);
  });

  // The venue settings screen printed "Pro Plan / $75/month / No end date" and
  // offered no way to change or cancel it (Jayden, TestFlight build 26). Both
  // halves are now pinned: the price is gone from the settings screen, and a
  // real route to a human is present.
  test('the settings screen offers a way out of the plan', () => {
    expect(app).toContain('Change or cancel this plan');
    expect(app).toContain('See plans and pricing');
  });

  // support@flockcorp.com is an unverified mailbox (SLOP-AUDIT section B) and
  // CommunityGuidelines.js routes every contact path to social@ for that
  // reason. A cancellation request is the worst thing to send to a mailbox
  // nobody has confirmed receives mail.
  test('every venue contact route uses the verified mailbox', () => {
    expect(visible).not.toContain('support@flockcorp.com');
    expect(app).toContain("const VENUE_SALES_EMAIL = 'social@flockcorp.com';");
  });
});

describe('VENUE-BILLING.md agrees with the app', () => {
  test('the pricing table rows are $35 Premium and $99 Pro', () => {
    expect(billing).toMatch(/\| Premium \(`premium`\) \| \*\*\$35\*\* \|/);
    expect(billing).toMatch(/\| Pro \(`pro`\) \| \*\*\$99\*\* \|/);
  });

  test('the doc records the re-price, with its date and its source', () => {
    expect(billing).toMatch(/Re-priced 2026-08-25: \$99\/mo Pro, per VENUE-PRICING\.md/);
  });

  test('the doc and the app agree on the Pro price', () => {
    const fromApp = app.match(/const VENUE_PLAN_PRICE = \{ premium: \d+, pro: (\d+) \};/);
    const fromDoc = billing.match(/\| Pro \(`pro`\) \| \*\*\$(\d+)\*\* \|/);
    expect(fromApp).not.toBeNull();
    expect(fromDoc).not.toBeNull();
    expect(fromApp[1]).toBe(fromDoc[1]);
  });

  test('the annual column is the recomputed two-months-free arithmetic', () => {
    // 2 mo free means annual = 10 x monthly. Recomputed, not left from a
    // superseded table: a stale $750 sitting beside a $99 Pro row is exactly
    // the drift this catches.
    const rows = {
      premium: billing.match(/\| Premium \(`premium`\) \| \*\*\$(\d+)\*\* \| \$(\d+) \|/),
      pro: billing.match(/\| Pro \(`pro`\) \| \*\*\$(\d+)\*\* \| \$(\d+) \|/),
    };
    for (const tier of Object.keys(rows)) {
      expect(rows[tier]).not.toBeNull();
      expect(Number(rows[tier][2])).toBe(10 * Number(rows[tier][1]));
    }
  });
});
