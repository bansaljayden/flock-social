/**
 * THE BUDGET STATUS, WHATEVER ORDER THE ANSWERS ARRIVE IN.
 *
 * Two answers can cross on their way back. The server commits a non-settling
 * answer and then looks up who to tell; the settling answer commits behind it,
 * finds its recipients first and goes out first, carrying the group number.
 * The earlier answer's `budget_updated` then lands after it with
 * `ceiling: null`, and so can that answer's own HTTP reply. Assigning either
 * straight into the status took the number off an open sheet, and because the
 * lock flag was kept, the sheet then said the number was not being shown with
 * every amount still in.
 *
 * A settled budget does not unsettle except by a reset, and a reset says so
 * (`reset: true`). So once the status on screen is locked, an update that is
 * neither locked nor a reset is older than what is on screen and none of it is
 * applied. And a null ceiling on an update only clears the number when the
 * budget is open on both sides, which is the only state in which there is no
 * number to show.
 *
 * Both readers use this: the socket handler in App.js and the answer buttons
 * in screens/ChatDetail.js. It lives here rather than in the screen so App.js
 * can import it without pulling the chat screen into the boot chunk (see
 * lib/billShares.js for why that matters).
 */

// The aggregate fields an update may carry. Anything else on the payload
// (flockId, submitted, userSubmitted) is not the status's business here.
const AGGREGATE = ['submissionCount', 'totalMembers', 'memberCount', 'isReady', 'skipCount'];

function aggregateOf(data) {
  const out = {};
  for (const key of AGGREGATE) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

export function mergeBudgetUpdate(prev, data) {
  if (!data || typeof data !== 'object') return prev;
  const base = prev || {};
  if (data.reset) {
    return {
      ...base,
      ...aggregateOf(data),
      ceiling: null,
      budgetLocked: false,
      userSubmitted: false,
      userAmount: null,
      userSkipped: false,
    };
  }
  const locked = data.budgetLocked === true;
  // Older than the settle already on screen.
  if (base.budgetLocked === true && !locked) return prev;
  const hasNumber = data.ceiling !== null && data.ceiling !== undefined;
  return {
    ...base,
    ...aggregateOf(data),
    ceiling: hasNumber ? data.ceiling : (locked ? (base.ceiling ?? null) : null),
    budgetLocked: locked || base.budgetLocked === true,
  };
}

/**
 * How many people can make the three: accepted members only. A guest's
 * answer binds the number and never counts toward three (routes/budget.js),
 * so "a flock this size" is judged on this, not on totalMembers, which counts
 * guests who said they are going. An older server that does not send
 * memberCount falls back to the old reading rather than to nothing.
 */
export function budgetCrowdSize(status) {
  const members = Number(status?.memberCount);
  if (status && status.memberCount != null && Number.isFinite(members)) return members;
  return Number(status?.totalMembers) || 0;
}
