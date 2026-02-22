/**
 * Flock Revenue Simulator - Finance Calculation Functions
 *
 * These are pure functions for calculating business metrics.
 * Pure functions: same input always produces same output, no side effects.
 *
 * Business Model Overview:
 * - Flock charges venues a monthly subscription fee
 * - Flock also takes a small percentage of each group transaction (take rate)
 * - Combined, these create two revenue streams: recurring + transactional
 */

/**
 * Calculate Monthly Subscription Revenue
 *
 * This is the predictable, recurring revenue from venue subscriptions.
 * SaaS businesses love subscription revenue because it's stable and predictable.
 *
 * Formula: Number of Venues × Monthly Subscription Price
 *
 * @param {number} numVenues - Total number of venues subscribed to Flock
 * @param {number} subscriptionPrice - Monthly fee each venue pays ($)
 * @returns {number} Monthly subscription revenue in dollars
 *
 * Example: 20 venues × $50/month = $1,000/month subscription revenue
 */
export function calculateSubscriptionRevenue(numVenues, subscriptionPrice) {
  return numVenues * subscriptionPrice;
}

/**
 * Calculate Monthly Transaction Revenue
 *
 * This is variable revenue from taking a percentage of each transaction.
 * Transaction revenue scales with platform activity (more events = more revenue).
 *
 * Formula: (Number of Venues × Events Per Venue × Average Spend) × (Take Rate / 100)
 *
 * The take rate is converted from percentage to decimal (e.g., 2.5% → 0.025)
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
  const totalTransactionVolume = numVenues * eventsPerVenue * avgSpend;
  const takeRateDecimal = takeRate / 100;
  return totalTransactionVolume * takeRateDecimal;
}

/**
 * Calculate Total Monthly Revenue
 *
 * Combined revenue from both streams. In business terms, this is your "top line."
 * Diversified revenue streams (subscription + transaction) reduce business risk.
 *
 * Formula: Subscription Revenue + Transaction Revenue
 *
 * @param {number} subscriptionRev - Monthly subscription revenue ($)
 * @param {number} transactionRev - Monthly transaction revenue ($)
 * @returns {number} Total monthly revenue in dollars
 */
export function calculateTotalMonthlyRevenue(subscriptionRev, transactionRev) {
  return subscriptionRev + transactionRev;
}

/**
 * Calculate Annual Revenue (ARR - Annual Recurring Revenue)
 *
 * Annualizing monthly revenue helps with yearly planning and investor communications.
 * ARR is a key metric for SaaS/subscription businesses.
 *
 * Formula: Monthly Revenue × 12 months
 *
 * @param {number} monthlyRevenue - Total monthly revenue ($)
 * @returns {number} Projected annual revenue in dollars
 */
export function calculateAnnualRevenue(monthlyRevenue) {
  return monthlyRevenue * 12;
}

/**
 * Calculate Monthly Profit (Net Income)
 *
 * Profit = what's left after paying all expenses.
 * This is the "bottom line" - the actual money the business keeps.
 *
 * Formula: Total Revenue - Operating Costs
 *
 * Note: Positive = profitable, Negative = losing money (burning cash)
 *
 * @param {number} totalRevenue - Total monthly revenue ($)
 * @param {number} operatingCosts - Monthly operating expenses ($)
 * @returns {number} Monthly profit (can be negative if losing money)
 */
export function calculateMonthlyProfit(totalRevenue, operatingCosts) {
  return totalRevenue - operatingCosts;
}

/**
 * Calculate Revenue Per Venue (Unit Economics)
 *
 * This metric shows how much revenue each venue generates on average.
 * Critical for understanding scalability - if this number is healthy,
 * adding more venues will proportionally grow revenue.
 *
 * Formula: Total Revenue / Number of Venues
 *
 * @param {number} totalRevenue - Total monthly revenue ($)
 * @param {number} numVenues - Number of venues
 * @returns {number} Average revenue per venue per month ($)
 */
export function calculateRevenuePerVenue(totalRevenue, numVenues) {
  if (numVenues === 0) return 0;
  return totalRevenue / numVenues;
}

/**
 * Calculate Break-Even Point
 *
 * Break-even = the minimum number of venues needed to cover operating costs.
 * Below this number, the business loses money. Above it, the business profits.
 *
 * This is crucial for business planning:
 * - Low break-even = less risky, easier to become profitable
 * - High break-even = need significant scale before profitability
 *
 * Formula: Operating Costs / Revenue Per Venue (rounded up)
 *
 * We round up because you can't have a fraction of a venue!
 *
 * @param {number} operatingCosts - Monthly operating expenses ($)
 * @param {number} subscriptionPrice - Monthly subscription price per venue ($)
 * @param {number} eventsPerVenue - Average events per venue per month
 * @param {number} avgSpend - Average spend per event ($)
 * @param {number} takeRate - Transaction take rate percentage
 * @returns {number} Number of venues needed to break even
 */
export function calculateBreakEven(operatingCosts, subscriptionPrice, eventsPerVenue, avgSpend, takeRate) {
  // Calculate revenue from a single venue
  const subscriptionPerVenue = subscriptionPrice;
  const transactionPerVenue = eventsPerVenue * avgSpend * (takeRate / 100);
  const revenuePerVenue = subscriptionPerVenue + transactionPerVenue;

  // Avoid division by zero
  if (revenuePerVenue === 0) return Infinity;

  // Round up - you need whole venues!
  return Math.ceil(operatingCosts / revenuePerVenue);
}

/**
 * Format Currency for Display
 *
 * Converts a number to a nicely formatted USD string.
 * Uses the browser's built-in internationalization API.
 *
 * @param {number} amount - Dollar amount to format
 * @returns {string} Formatted currency string (e.g., "$1,234.56")
 */
export function formatCurrency(amount) {
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
 * Higher margins = more efficient business, more room for growth investment.
 *
 * Industry benchmarks:
 * - <10% = tight margins, common in retail
 * - 10-20% = healthy for most businesses
 * - 20%+ = excellent, common in software/SaaS
 *
 * Formula: (Profit / Revenue) × 100
 *
 * @param {number} profit - Monthly profit ($)
 * @param {number} revenue - Total monthly revenue ($)
 * @returns {number} Profit margin as a percentage
 */
export function calculateProfitMargin(profit, revenue) {
  if (revenue === 0) return 0;
  return (profit / revenue) * 100;
}
