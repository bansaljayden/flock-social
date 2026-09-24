// Flock Pro price arithmetic, shared by the web page (website/ProPage.js) and
// the native sheet (components/PaywallSheet.js).
//
// A savings figure is a price claim, so it is computed from the two prices the
// buyer is actually shown and never typed in. The sheet once carried a literal
// "Save 48%" that was right for one pair of prices and stayed on screen after
// the yearly price moved. Rounded DOWN, so the page can understate a saving but
// never overstate one.

// Whole percent saved by paying yearly instead of twelve months of monthly.
// Both amounts in the same unit (cents, or dollars; the ratio does not care).
// null when either amount is unusable or there is no saving to speak of.
export function yearlySavingsPercent(monthlyAmount, yearlyAmount) {
  const m = Number(monthlyAmount);
  const y = Number(yearlyAmount);
  if (!Number.isFinite(m) || !Number.isFinite(y) || m <= 0 || y <= 0) return null;
  const pct = Math.floor((1 - y / (12 * m)) * 100);
  return pct > 0 ? pct : null;
}

// The saving between two /api/pro/status plans, or null. Plans in different
// currencies are not compared at all.
export function planSavingsPercent(monthlyPlan, yearlyPlan) {
  if (!monthlyPlan || !yearlyPlan) return null;
  if (String(monthlyPlan.currency || '').toLowerCase() !== String(yearlyPlan.currency || '').toLowerCase()) return null;
  return yearlySavingsPercent(monthlyPlan.unitAmount, yearlyPlan.unitAmount);
}
