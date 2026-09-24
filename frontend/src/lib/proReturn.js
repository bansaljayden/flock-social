// The trip back from Stripe.
//
// Stripe sends a buyer to /app?pro=success&session_id=cs_... after paying, and
// a web subscriber to /app?pro=manage after the billing portal
// (backend/services/proBilling.js). App.js reads that once, at module
// evaluation, and takes it off the address bar in the same step, for the same
// reason readEmailVerifiedOutcome() does: StrictMode runs initialisers twice,
// and a refresh or a bookmark must not replay a purchase confirmation.

const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

// -> { kind: 'success', sessionId } | { kind: 'manage' } | null
export function readProReturn(win = typeof window === 'undefined' ? undefined : window) {
  if (!win || !win.location) return null;
  try {
    const params = new URLSearchParams(win.location.search || '');
    const pro = params.get('pro');
    if (!pro) return null;
    const sessionId = params.get('session_id');
    params.delete('pro');
    params.delete('session_id');
    const query = params.toString();
    if (win.history && typeof win.history.replaceState === 'function') {
      win.history.replaceState({}, '', `${win.location.pathname}${query ? `?${query}` : ''}${win.location.hash || ''}`);
    }
    if (pro === 'success' && sessionId && SESSION_ID.test(sessionId)) return { kind: 'success', sessionId };
    if (pro === 'manage') return { kind: 'manage' };
    return null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Confirms the session, then asks /api/pro/status every intervalMs until it
// reads Pro or timeoutMs runs out. The confirm call already tells RevenueCat,
// so the first answer is usually Pro; the polling covers the webhook arriving
// second. Resolves to 'pro'; 'pending' (Stripe says paid, Pro not showing
// yet); 'unknown' (confirm never answered and Pro never showed); or
// 'incomplete' (Stripe says the checkout has not finished). isCancelled stops
// it quietly with 'cancelled'.
export async function settleProCheckout({
  sessionId,
  confirm,
  getStatus,
  isCancelled = () => false,
  intervalMs = 2000,
  timeoutMs = 30000,
  wait = sleep,
}) {
  let confirmed = null;
  try {
    confirmed = await confirm(sessionId);
  } catch {
    // Not fatal: the webhook still arrives, so keep asking /status.
  }
  if (isCancelled()) return 'cancelled';
  if (confirmed && confirmed.complete === false) return 'incomplete';
  if (confirmed && confirmed.isPremium) return 'pro';
  const tries = Math.max(1, Math.floor(timeoutMs / intervalMs));
  for (let i = 0; i < tries; i += 1) {
    await wait(intervalMs);
    if (isCancelled()) return 'cancelled';
    try {
      const status = await getStatus();
      if (status && status.isPremium) return 'pro';
    } catch {
      // A failed read is one missed tick, not the end of the wait.
    }
  }
  return confirmed && confirmed.complete ? 'pending' : 'unknown';
}
