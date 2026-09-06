/**
 * BILL SHARE ARITHMETIC.
 *
 * This lived at the top of screens/ChatDetail.js, and App.js imported it from
 * there as a named export. That one static named import was enough to pin the
 * entire 3,700-line chat screen into the boot chunk, because a module cannot
 * be code-split while something reads a value out of it synchronously. Five
 * lines of arithmetic were holding ~20 KB gzipped on the critical path of
 * every app launch.
 *
 * It belongs here anyway. src/lib is where the app's pure math lives, it has
 * no React in it, and both readers of this function are reducers rather than
 * anything to do with drawing a chat.
 */

/**
 * What a share still owes once its settlement is taken back: the share, less
 * the credit carried on it, never below zero.
 *
 * GET serves every settled row with `outstanding: 0`, and the socket reducers
 * that flipped the settled flag alone left that zero in place, so a $100 share
 * whose settlement was withdrawn read "Settle Up - $0.00" (adversarial audit
 * round 2, 2026-09-05). Both reducers, in ChatDetail and in App.js, now
 * recompute through this one function so they cannot drift apart again.
 *
 * A share with no numeric `amount` is not something this can compute, so it
 * hands back whatever the server said rather than inventing a number.
 */
export const owedOn = (s) => {
  if (typeof s?.amount !== 'number') return s?.outstanding;
  const paid = Number(s.paidAmount) > 0 ? Number(s.paidAmount) : 0;
  return Math.max(0, Math.round((s.amount - paid) * 100)) / 100;
};
