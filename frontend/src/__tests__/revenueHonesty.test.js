// ---------------------------------------------------------------------------
// Honesty pins for the numbers shown to venue owners and admins (TASKS.md B2).
//
// Three failures used to live on these screens, all of the class DESIGN-STANDARD
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

// The revenue simulator and the whole admin console left App.js on 2026-08-27
// for screens/RevenueScreen.js and its own lazily loaded chunk. The simulator
// state (the seeds this suite pins) stayed in FlockAppInner, so App.js still
// carries it; the render, the labels and the break-even copy moved. Both files
// are read and joined so every string this suite pins is in view, in the order
// they used to be one file.
const app = fs.readFileSync(path.resolve(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.resolve(__dirname, '..', 'screens', 'RevenueScreen.js'), 'utf8');

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

  test('the simulator seed is the one venue price there is', () => {
    // Roost at $99 is the only venue plan since the tiers collapsed to a free
    // account and Roost. Three seeds have been wrong here: 50 captioned "the
    // average", which it was not, then 55, the midpoint of a retired $75 Pro,
    // then 67, the midpoint of Roost and the retired $35 middle plan. A seed
    // off a price no venue can be charged opens the simulator on fiction, so
    // this pin moves whenever the plans do.
    expect(app).toContain('const [subscriptionPrice, setSubscriptionPrice] = useState(99)');
    expect(app).toMatch(/const VENUE_PLAN_PRICE = \{ pro: 99 \};/);
  });

  test('demo research data is labelled demo on screen', () => {
    expect(visible).toContain('Demo data · Tap for live');
  });
});

describe('break-even: impossible inputs read as a sentence, not Infinity', () => {
  test('the render is gated on Number.isFinite', () => {
    expect(app).toContain('const breakEvenReachable = Number.isFinite(breakEvenVenues)');
    expect(app).toContain("breakEvenReachable ? hubPlural(breakEvenVenues, 'venue', 'venues') : 'Not reachable'");
  });

  test('arithmetic on the figure is behind the same gate', () => {
    // "Need Infinity more venues" was the worse half of the bug.
    expect(app).toContain('const isAboveBreakEven = breakEvenReachable && numVenues >= breakEvenVenues');
    expect(visible).toContain('A venue brings in nothing at these inputs, so there is no break-even point.');
  });
});

// ---------------------------------------------------------------------------
// THE RESEARCH TAB SAYS WHAT EACH FIGURE COUNTS.
//
// Three of its figures read as something they were not. "Completion Rate" was
// every plan that ended, closed by a host or by the sweep once its time
// passed, while "Where Flocks Stall" beside it counts only the plans a host
// closed by hand, so the two disagreed without saying why. "Time to Confirm"
// printed the minutes from creation to the host closing a plan after the
// night, with an "m" after it. And both user counts counted venue owners and
// admins. The time now comes from flocks.confirmed_at (migration 102) and
// waits, in words, for enough plans confirmed since it was recorded.
// ---------------------------------------------------------------------------
jest.mock('../services/api', () => ({
  __esModule: true,
  saveAdminReconciled: jest.fn(),
  getAdminMoneyHub: jest.fn(() => new Promise(() => {})),
  createAdminExpense: jest.fn(),
  updateAdminExpense: jest.fn(),
  deleteAdminExpense: jest.fn(),
  importAdminExpenses: jest.fn(),
}));

describe('research tab: each figure says what it counts', () => {
  const React = require('react');
  const { render, screen, within } = require('@testing-library/react');
  const RevenueScreen = require('../screens/RevenueScreen').default;
  const LIVE = {
    totalFlocks: 60, completionRate: 64, endedPlans: 42, avgGroupSize: 3.8, budgetAdoptionRate: 20,
    timeToConfirm: { medianHours: 5.24, plans: 12, minPlans: 10 },
    stallPointDistribution: [{ stall_point: 'completed', count: '9' }, { stall_point: 'venue', count: '4' }],
    totalUsers: 118, newUsersThisWeek: 9,
    reliabilityDistribution: { reliable: '10', moderate: '3', flaky: '1', unscored: '104' },
  };
  const show = (data) => {
    const fn = () => jest.fn();
    render(React.createElement(RevenueScreen, {
      adminTab: 'research', avgSpend: 1, colors: { navy: '#1f2a44', navyBg: '#1f2a44', creamDark: '#ddd', steel: '#4a7ba7' },
      costsData: null, costsError: false, costsLoading: false, eventsPerVenue: 1, fetchCosts: fn(), fetchResearchLive: fn(),
      numVenues: 1, operatingCosts: 1, researchDemoMode: false, researchError: false, researchLiveData: data, researchLoading: false,
      setAdminTab: fn(), setAvgSpend: fn(), setEventsPerVenue: fn(), setNumVenues: fn(), setOperatingCosts: fn(),
      setResearchDemoMode: fn(), setSubscriptionPrice: fn(), setTakeRate: fn(), styles: { gradientButton: {} },
      subscriptionPrice: 99, switchMode: fn(), takeRate: 2.5,
    }));
  };
  const statCard = (label) => screen.getByText(label).parentElement;

  test('the rate is named for what it counts, with the plans it counts under it', () => {
    show(LIVE);
    expect(screen.queryByText('Completion Rate')).toBeNull();
    const card = statCard('Confirmed before it ended');
    expect(within(card).getByText('64%')).toBeInTheDocument();
    expect(card.textContent).toMatch(/of 42 plans that ended, including ones closed automatically once their time passed/);
    // And the stall split beside it says it counts a different set.
    expect(screen.getByText(/^Plans a host closed by hand: 13 plans\. A plan closed automatically once its time passed is not in this\.$/)).toBeInTheDocument();
  });

  test('time to confirm is a median in hours over the plans it names', () => {
    show(LIVE);
    const card = statCard('Time to Confirm');
    expect(within(card).getByText('5.2h')).toBeInTheDocument();
    expect(card.textContent).toMatch(/median from making a plan to confirming it, over 12 plans/);
    expect(card.textContent).not.toMatch(/\dm\b/);
  });

  test('under the floor it waits in words, and a median that arrives anyway is not drawn', () => {
    show({ ...LIVE, timeToConfirm: { medianHours: 0.4, plans: 3, minPlans: 10 } });
    const card = statCard('Time to Confirm');
    expect(within(card).getByText('Not yet')).toBeInTheDocument();
    expect(card.textContent).toMatch(/Not enough plans confirmed since this was recorded: 3 of 10\./);
    expect(card.textContent).not.toMatch(/24m|0\.4/);
  });

  test('a server from before the change shows no number for the old closing time', () => {
    const { timeToConfirm, endedPlans, ...older } = LIVE;
    expect(timeToConfirm && endedPlans).toBeTruthy();
    show({ ...older, avgTimeToConfirmation: 2880 });
    const card = statCard('Time to Confirm');
    expect(within(card).getByText('No data')).toBeInTheDocument();
    expect(screen.queryByText(/2880/)).toBeNull();
  });

  test('no ended plan is no rate, said in words', () => {
    show({ ...LIVE, completionRate: null, endedPlans: 0 });
    const card = statCard('Confirmed before it ended');
    expect(within(card).getByText('No data')).toBeInTheDocument();
    expect(card.textContent).toMatch(/No plan has ended yet\./);
  });

  test('the user counts say they are people accounts', () => {
    show(LIVE);
    expect(statCard('Total Users').textContent).toMatch(/people accounts, not venue owners, admins or banned accounts/);
    expect(screen.getByText('People accounts made in the last 7 days.')).toBeInTheDocument();
  });

  test('none of it prints an em dash', () => {
    expect(visible).toContain('Confirmed before it ended');
    expect(visible).not.toMatch(/avgTimeToConfirmation/);
    const research = visible.slice(visible.indexOf("activeTab === 'research'"));
    expect(research).not.toMatch(/—/);
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
