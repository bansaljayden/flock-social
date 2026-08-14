/**
 * Flock Revenue Simulator - Finance Calculation Functions
 *
 * These are pure functions for calculating business metrics.
 * Pure functions: same input always produces same output, no side effects.
 *
 * ===========================================================================
 * WHAT THESE NUMBERS ARE
 * ===========================================================================
 * Every value produced by this file is a PROJECTION computed from whatever a
 * person typed into the simulator. None of it is a measurement, and none of it
 * is evidence that any of it has happened. Flock has never charged anyone and
 * has no venue partners, so the honest reading of every output here is
 * "if these inputs were true, the arithmetic would be this".
 *
 * Any screen showing these values must label them as a simulation. Presenting
 * one as a fact is the specific failure this project keeps having (see
 * SLOP-AUDIT.md); it is also the failure a DECA judge or an investor is most
 * likely to catch, because the numbers are round and the traction is zero.
 *
 * ===========================================================================
 * THE MODEL, AND WHAT IT ASSUMES
 * ===========================================================================
 * Two revenue streams:
 *   - venue subscriptions (recurring)
 *   - a take rate on group transactions (variable)
 *
 * The model is a single-month snapshot that is then annualised. It deliberately
 * has no time dimension, which means it assumes ALL of the following. These are
 * assumptions, not findings, and none of them are free:
 *
 *   1. ZERO CHURN. No venue cancels. Real venue SaaS at this price point loses
 *      a few percent of accounts a month; at 3%/month a year of "annual"
 *      revenue is roughly 82% of 12x the first month, not 100%.
 *   2. ZERO GROWTH. Venue count is fixed for the whole year. The same snapshot
 *      is charged twelve times.
 *   3. NO CONVERSION FUNNEL. "Number of venues" means venues already paying.
 *      Pipeline, trial-to-paid conversion and sales cycle are all outside the
 *      model.
 *   4. FIXED OPERATING COSTS. Costs do not scale with venue count, so the
 *      break-even point is optimistic by however much cost is actually
 *      marginal (support, payment processing, per-venue API spend).
 *   5. EVERY EVENT IS BILLABLE AND COLLECTED. Events per venue x average spend
 *      is treated as gross transaction volume with no refunds, no chargebacks,
 *      no payment-processing fee netted out of the take rate. The take rate is
 *      gross, not net.
 *
 * Because there is no compounding anywhere in the model, there is also no
 * double-counting: each input is consumed exactly once per stream, and the two
 * streams share no term. Annual revenue multiplies the unrounded monthly
 * figure, so display rounding never accumulates across the projection —
 * rounding happens only in formatCurrency, at the last possible moment.
 *
 * If a growth or churn curve is ever added, it must be added as an explicit
 * per-month series. Applying a growth rate to an already-annualised figure
 * would count it twelve times.
 */

/**
 * Coerce a simulator input to a usable finite number.
 *
 * Every entry point runs inputs through this. An empty text field, a pasted
 * "abc", or an Infinity produced upstream would otherwise flow through the
 * whole model and surface as "$NaN" in a card on screen during a pitch. A
 * non-finite input is treated as 0, which is visibly wrong in the right
 * direction (the number goes to zero) rather than invisibly wrong.
 *
 * It is applied to RESULTS as well as inputs. Two perfectly finite inputs can
 * still overflow to Infinity when multiplied, so checking only the inputs would
 * leave the guarantee to luck. With it applied on both sides the invariant is
 * total and can be stated: no function in this file ever returns a non-finite
 * number, with the single documented exception of calculateBreakEven, which
 * returns Infinity to mean "no number of venues covers the costs".
 *
 * @param {*} value
 * @returns {number} value if it is a finite number, otherwise 0
 */
function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Calculate Monthly Subscription Revenue
 *
 * This is the predictable, recurring revenue from venue subscriptions.
 * SaaS businesses love subscription revenue because it's stable and predictable.
 *
 * Formula: Number of Venues × Monthly Subscription Price
 *
 * Assumes every venue is on the same price. `subscriptionPrice` is therefore a
 * blended average across tiers, not a real price anybody pays.
 *
 * @param {number} numVenues - Total number of venues subscribed to Flock
 * @param {number} subscriptionPrice - Monthly fee each venue pays ($)
 * @returns {number} Monthly subscription revenue in dollars
 *
 * Example: 20 venues × $50/month = $1,000/month subscription revenue
 */
export function calculateSubscriptionRevenue(numVenues, subscriptionPrice) {
  return finite(finite(numVenues) * finite(subscriptionPrice));
}

/**
 * Calculate Monthly Transaction Revenue
 *
 * This is variable revenue from taking a percentage of each transaction.
 * Transaction revenue scales with platform activity (more events = more revenue).
 *
 * Formula: (Number of Venues × Events Per Venue × Average Spend) × (Take Rate / 100)
 *
 * The take rate is converted from percentage to decimal (e.g., 2.5% → 0.025).
 * It is a GROSS take: payment-processing fees are not netted out of it, so
 * treating this as margin overstates it by roughly the processor's cut.
 *
 * @param {number} numVenues - Total number of venues on platform
 * @param {number} eventsPerVenue - Average events/bookings per venue per month
 * @param {number} avgSpend - Average group spend per event ($)
 * @param {number} takeRate - Percentage of transaction Flock keeps (e.g., 2.5 for 2.5%)
 * @returns {number} Monthly transaction fee revenue in dollars
 *
 * Example: 20 venues × 12 events × $120 avg spend × 2.5% = $720/month
 */
export function calculateTransactionRevenue(numVenues, eventsPerVenue, avgSpend, takeRate) {
  const totalTransactionVolume = finite(numVenues) * finite(eventsPerVenue) * finite(avgSpend);
  const takeRateDecimal = finite(takeRate) / 100;
  return finite(totalTransactionVolume * takeRateDecimal);
}

/**
 * Calculate Total Monthly Revenue
 *
 * Combined revenue from both streams. In business terms, this is your "top line."
 * The two streams share no input term, so adding them does not double-count:
 * subscription revenue depends on price, transaction revenue on volume.
 *
 * Formula: Subscription Revenue + Transaction Revenue
 *
 * @param {number} subscriptionRev - Monthly subscription revenue ($)
 * @param {number} transactionRev - Monthly transaction revenue ($)
 * @returns {number} Total monthly revenue in dollars
 */
export function calculateTotalMonthlyRevenue(subscriptionRev, transactionRev) {
  return finite(finite(subscriptionRev) + finite(transactionRev));
}

/**
 * Calculate Annualised Revenue Run-Rate
 *
 * Formula: Monthly Revenue × 12
 *
 * NAMING WARNING — this is NOT ARR.
 * "ARR" means Annual RECURRING Revenue, and it may only include the recurring
 * stream. This figure annualises the total, so it folds in transaction revenue,
 * which recurs only as long as the activity does. It also assumes zero churn
 * and zero growth for twelve months (see the file header).
 *
 * The correct label for this number in any UI or deck is "annualised run rate"
 * or "annualised revenue", never "ARR". If a true ARR figure is ever wanted,
 * annualise calculateSubscriptionRevenue on its own.
 *
 * The multiplication is applied to the unrounded monthly figure on purpose, so
 * no display rounding is multiplied by twelve.
 *
 * @param {number} monthlyRevenue - Total monthly revenue ($)
 * @returns {number} Projected annual revenue in dollars at this month's run-rate
 */
export function calculateAnnualRevenue(monthlyRevenue) {
  return finite(finite(monthlyRevenue) * 12);
}

/**
 * Calculate Monthly Profit (Net Income)
 *
 * Profit = what's left after paying all expenses.
 * This is the "bottom line" - the actual money the business keeps.
 *
 * Formula: Total Revenue - Operating Costs
 *
 * Note: Positive = profitable, Negative = losing money (burning cash).
 * This is a cash-in-minus-cash-out figure, not accounting net income: no tax,
 * no depreciation, no cost of goods beyond the operating-costs input.
 *
 * @param {number} totalRevenue - Total monthly revenue ($)
 * @param {number} operatingCosts - Monthly operating expenses ($)
 * @returns {number} Monthly profit (can be negative if losing money)
 */
export function calculateMonthlyProfit(totalRevenue, operatingCosts) {
  return finite(finite(totalRevenue) - finite(operatingCosts));
}

/**
 * Calculate Revenue Per Venue (Unit Economics)
 *
 * Formula: Total Revenue / Number of Venues
 *
 * ZERO-VENUE CONVENTION: with no venues there is no per-venue figure, and this
 * returns 0. That is a placeholder, not an economic claim — the revenue a venue
 * would generate if one existed is unchanged, and calculateBreakEven still uses
 * that non-zero per-venue figure. A caller that shows both at once should
 * render this as "n/a" when numVenues is 0 rather than "$0/mo", which reads as
 * "venues are worthless" instead of "there are no venues".
 *
 * @param {number} totalRevenue - Total monthly revenue ($)
 * @param {number} numVenues - Number of venues
 * @returns {number} Average revenue per venue per month ($), or 0 if no venues
 */
export function calculateRevenuePerVenue(totalRevenue, numVenues) {
  const venues = finite(numVenues);
  if (venues <= 0) return 0;
  // A subnormal denominator can still overflow the quotient to Infinity even
  // though the zero case is handled. Checking the RESULT is what actually makes
  // a non-finite return impossible, rather than reasoning about which inputs
  // are plausible.
  return finite(finite(totalRevenue) / venues);
}

/**
 * Calculate Break-Even Point
 *
 * Break-even = the minimum number of venues needed to cover operating costs.
 * Below this number, the business loses money. Above it, the business profits.
 *
 * Formula: ceil(Operating Costs / Revenue Per Venue)
 *
 * Rounded up because you cannot have a fraction of a venue.
 *
 * Assumes operating costs are entirely FIXED. Any cost that scales with venue
 * count (support, per-venue API spend, payment fees) is not in the denominator,
 * so the real break-even is higher than this by that amount.
 *
 * UNREACHABLE BREAK-EVEN: if a venue generates no revenue (all of subscription
 * price, events, spend and take rate at zero) or negative revenue, no number of
 * venues ever covers costs, and this returns Infinity. That is the truthful
 * answer and it is reachable from ordinary inputs — someone zeroing the
 * subscription price to model a free tier gets it immediately. A caller must
 * render a non-finite result as "not reachable" or similar; printing it raw
 * puts "Infinity venues" on screen, and arithmetic on it ("need Infinity more
 * venues") is worse. Use Number.isFinite() on the result before doing either.
 *
 * @param {number} operatingCosts - Monthly operating expenses ($)
 * @param {number} subscriptionPrice - Monthly subscription price per venue ($)
 * @param {number} eventsPerVenue - Average events per venue per month
 * @param {number} avgSpend - Average spend per event ($)
 * @param {number} takeRate - Transaction take rate percentage
 * @returns {number} Whole number of venues needed to break even, or Infinity
 */
export function calculateBreakEven(operatingCosts, subscriptionPrice, eventsPerVenue, avgSpend, takeRate) {
  // Revenue from a single venue. This is deliberately the same expression that
  // calculateSubscriptionRevenue + calculateTransactionRevenue produce for one
  // venue, so break-even and revenue-per-venue can never disagree.
  const subscriptionPerVenue = finite(subscriptionPrice);
  const transactionPerVenue = finite(eventsPerVenue) * finite(avgSpend) * (finite(takeRate) / 100);
  const revenuePerVenue = subscriptionPerVenue + transactionPerVenue;

  // `> 0` rather than `!== 0`: a zero denominator is not the only broken case.
  // A negative per-venue revenue used to produce Math.ceil of a negative
  // number, i.e. a negative break-even, which reads as "you are already past
  // break-even" when in fact every venue added loses more money.
  if (!(revenuePerVenue > 0)) return Infinity;

  const costs = finite(operatingCosts);
  if (costs <= 0) return 0;

  return Math.ceil(costs / revenuePerVenue);
}

/**
 * Format Currency for Display
 *
 * Converts a number to a nicely formatted USD string, rounded to whole dollars.
 *
 * Rounding happens HERE and nowhere else, so it never feeds back into the
 * model. Note that independently rounded line items can differ from a rounded
 * total by a dollar when the parts have fractional cents; show the total from
 * the unrounded sum (which this does) rather than by adding the displayed
 * parts.
 *
 * Non-finite input renders as "n/a" rather than "$NaN" or "$∞". A broken input
 * should look like missing data, not like a number. (The placeholder is not a
 * dash: em dashes are banned in user-visible text, SLOP-AUDIT.md rule 1.)
 *
 * @param {number} amount - Dollar amount to format
 * @returns {string} Formatted currency string (e.g., "$1,234"), or "n/a"
 */
export function formatCurrency(amount) {
  if (!Number.isFinite(amount)) return 'n/a';
  // Negative zero formats as "-$0", which reads as a rendering bug rather than
  // as nothing. `amount === 0` is true for -0, so this normalises it.
  if (amount === 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Calculate Profit Margin Percentage
 *
 * Profit margin shows what percentage of revenue becomes profit.
 *
 * Formula: (Profit / Revenue) × 100
 *
 * ZERO-REVENUE CONVENTION: margin is undefined with no revenue, because the
 * denominator is zero. This returns 0 to keep the return type a finite number
 * for callers that format it directly. 0 here means "undefined", NOT
 * "break-even" — with no revenue and any operating cost the business is losing
 * 100% of what it spends, and a caller that prints "0.0%" next to a red "Not
 * Profitable" header is contradicting itself. Callers should check
 * `revenue > 0` and render "n/a" instead.
 *
 * Industry reference points for the returned percentage:
 * - <10% = tight margins, common in retail
 * - 10-20% = healthy for most businesses
 * - 20%+ = typical of software/SaaS
 *
 * @param {number} profit - Monthly profit ($)
 * @param {number} revenue - Total monthly revenue ($)
 * @returns {number} Profit margin as a percentage, or 0 when revenue is 0
 */
export function calculateProfitMargin(profit, revenue) {
  const rev = finite(revenue);
  if (rev === 0) return 0;
  // Result-checked, not input-checked: a non-zero but subnormal revenue still
  // overflows the quotient. Callers format this directly (.toFixed), so an
  // Infinity escaping here would print "Infinity%" on screen.
  return finite((finite(profit) / rev) * 100);
}
