// ---------------------------------------------------------------------------
// Venue pricing is decided: $35/mo Premium, $75/mo Pro. FINAL as of 2026-08-14.
//
// The decision resolved a documented conflict IN THE APP'S FAVOR: the app had
// always displayed $35/$75 while VENUE-BILLING.md proposed $49/$149 and called
// itself authoritative. Several older docs (README.md, MONEY-MODEL.md,
// SUBMIT-CHECKLIST.md) were written during that conflict and say "fix the app
// to $49/$149". That instruction is now exactly backwards. This suite exists
// so that following a stale doc breaks the build instead of the price.
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
  test('the LockedTab upsell names both tiers at the final prices', () => {
    expect(app).toContain('Pro · $75/mo');
    expect(app).toContain('Premium · $35/mo');
  });

  test('the plan card and current-plan labels carry $35 and $75', () => {
    expect(app).toContain('$35/mo');
    expect(app).toContain('$75/mo');
    expect(app).toContain('$35/month');
    expect(app).toContain('$75/month');
  });

  test('the superseded $49/$149 prices never reach a screen', () => {
    expect(visible).not.toMatch(/\$49\b/);
    expect(visible).not.toMatch(/\$149\b/);
  });
});

describe('VENUE-BILLING.md agrees with the app', () => {
  test('the pricing table rows are $35 Premium and $75 Pro', () => {
    expect(billing).toMatch(/\| Premium \(`premium`\) \| \*\*\$35\*\* \|/);
    expect(billing).toMatch(/\| Pro \(`pro`\) \| \*\*\$75\*\* \|/);
  });

  test('the doc records the decision as final, with its date', () => {
    expect(billing).toMatch(/Decided 2026-08-14: \$35\/mo Premium and \$75\/mo Pro are FINAL/);
  });

  test('the annual column is the recomputed two-months-free arithmetic', () => {
    // 2 mo free means annual = 10 x monthly. Recomputed, not left from the
    // superseded table ($490/$1,490 would mean the prices drifted apart again).
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
