// ---------------------------------------------------------------------------
// Honesty pins for the numbers shown to venue owners and admins (TASKS.md B2).
//
// Three failures used to live on these screens, all of the class SLOP-AUDIT
// bans hardest (H13: invented metrics):
//   1. The promotions tab shipped invented statistics ("Happy Hour promos get
//      3x more engagement") that nothing in Flock measures. Cut 2026-08-14.
//   2. The revenue simulator labelled monthly-total-times-twelve "Annual
//      (ARR)". It folds in one-time transaction revenue and assumes zero
//      churn, so ARR is exactly the wrong word. Relabelled and caveated.
//   3. Break-even rendered raw: zeroing the subscription price put "Infinity
//      venues" and "Need Infinity more venues" on screen.
//
// This suite exists so none of them can come back quietly. Half of it pins
// App.js source (same visible-text stripping rule as venuePricingDecision
// .test.js: comments carry reasoning and may quote the banned strings; only
// what can reach a screen is under test). The other half unit-tests
// lib/finance.js on the edge inputs that used to render Infinity and NaN.
//
// If a test here fails, the honest fix is almost never to edit this file.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

import {
  calculateSubscriptionRevenue,
  calculateTransactionRevenue,
  calculateTotalMonthlyRevenue,
  calculateAnnualRevenue,
  calculateRevenuePerVenue,
  calculateBreakEven,
  calculateProfitMargin,
  formatCurrency,
} from '../lib/finance';

const app = fs.readFileSync(path.resolve(__dirname, '..', 'App.js'), 'utf8');

// Strip JSX comments, block comments and line comments: what remains is what
// can reach a screen.
const visible = app
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('promotions tab: no invented statistics', () => {
  test('the "3x more engagement" claim never reaches a screen', () => {
    expect(visible).not.toContain('3x');
    expect(visible).not.toMatch(/\d+\s*x\s+more/i);
  });

  test('no "Pro Tips" box of unmeasured advice comes back', () => {
    expect(visible).not.toContain('Pro Tip');
  });
});

describe('revenue simulator: projections labelled as projections', () => {
  test('the annual figure is labelled a run rate, never ARR', () => {
    expect(visible).toContain('Annualised run rate');
    // "ARR" is Annual RECURRING Revenue and this figure is not that: it folds
    // in transaction fees and assumes zero churn (see lib/finance.js).
    expect(visible).not.toMatch(/\bARR\b/);
  });

  test('the annual figure carries its caveat sentence', () => {
    expect(visible).toContain(
      'This month times twelve. It includes transaction fees, which are not recurring, and assumes no venue cancels.'
    );
  });

  test('the outputs column says these are not measurements', () => {
    expect(visible).toContain('Arithmetic on the numbers you typed, not measurements.');
  });

  test('the simulator seed stays the honest $55 tier midpoint', () => {
    // Midpoint of $35 Premium and $75 Pro. The old seed of 50 was captioned
    // "the average", which it is not.
    expect(app).toContain('const [subscriptionPrice, setSubscriptionPrice] = useState(55)');
  });

  test('demo research data is labelled demo on screen', () => {
    expect(visible).toContain('Demo data · Tap for live');
  });
});

describe('break-even: impossible inputs read as a sentence, not Infinity', () => {
  test('the render is gated on Number.isFinite', () => {
    expect(app).toContain('const breakEvenReachable = Number.isFinite(breakEvenVenues)');
    expect(app).toContain('breakEvenReachable ? `${breakEvenVenues} venues` : \'Not reachable\'');
  });

  test('arithmetic on the figure is behind the same gate', () => {
    // "Need Infinity more venues" was the worse half of the bug.
    expect(app).toContain('const isAboveBreakEven = breakEvenReachable && numVenues >= breakEvenVenues');
    expect(visible).toContain('A venue brings in nothing at these inputs, so there is no break-even point.');
  });
});

describe('lib/finance.js: edge inputs never surface as Infinity or NaN', () => {
  test('zeroing every revenue input makes break-even Infinity, the documented sentinel', () => {
    expect(calculateBreakEven(2000, 0, 0, 0, 0)).toBe(Infinity);
  });

  test('zero subscription price alone still has a finite break-even from transactions', () => {
    // 12 events x $120 x 2.5% = $36/venue; ceil(2000 / 36) = 56.
    expect(calculateBreakEven(2000, 0, 12, 120, 2.5)).toBe(56);
  });

  test('negative per-venue revenue is Infinity, not a negative venue count', () => {
    expect(calculateBreakEven(2000, -10, 0, 0, 0)).toBe(Infinity);
  });

  test('zero operating costs means break-even at 0 venues', () => {
    expect(calculateBreakEven(0, 55, 12, 120, 2.5)).toBe(0);
  });

  test('the default seeds produce the arithmetic the screen shows', () => {
    // Seeds: 20 venues, $55, 12 events, $120, 2.5%, $2000 costs.
    const sub = calculateSubscriptionRevenue(20, 55);
    const txn = calculateTransactionRevenue(20, 12, 120, 2.5);
    const monthly = calculateTotalMonthlyRevenue(sub, txn);
    expect(sub).toBe(1100);
    expect(txn).toBe(720);
    expect(monthly).toBe(1820);
    expect(calculateAnnualRevenue(monthly)).toBe(21840);
    // $91 per venue; ceil(2000 / 91) = 22.
    expect(calculateBreakEven(2000, 55, 12, 120, 2.5)).toBe(22);
  });

  test('formatCurrency renders broken numbers as missing data, not "$Infinity"', () => {
    expect(formatCurrency(Infinity)).toBe('n/a');
    expect(formatCurrency(-Infinity)).toBe('n/a');
    expect(formatCurrency(NaN)).toBe('n/a');
    expect(formatCurrency(-0)).toBe('$0');
    expect(formatCurrency(1234.6)).toBe('$1,235');
  });

  test('non-numeric inputs collapse to 0 instead of propagating NaN', () => {
    expect(calculateSubscriptionRevenue(NaN, 55)).toBe(0);
    expect(calculateTransactionRevenue('12', 12, 120, 2.5)).toBe(0);
    expect(calculateAnnualRevenue(undefined)).toBe(0);
  });

  test('undefined ratios return the documented 0 sentinel, never NaN', () => {
    expect(calculateRevenuePerVenue(1820, 0)).toBe(0);
    expect(calculateProfitMargin(-2000, 0)).toBe(0);
  });
});
