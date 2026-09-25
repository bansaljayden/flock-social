// The trip back from Stripe for a venue buying Roost.
//
// Stripe sends the owner to /app?venue_billing=success&session_id=cs_... after
// checkout, /app?venue_billing=manage after the billing portal, and
// /app?venue_billing=cancelled if they backed out (backend/services/venueBilling.js).
// Read once at module evaluation and taken off the address bar in the same
// step, for the reason lib/proReturn.js gives: a refresh or a bookmark must not
// replay a purchase confirmation.

const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

// -> { kind: 'success', sessionId } | { kind: 'manage' } | { kind: 'cancelled' } | null
export function readVenueBillingReturn(win = typeof window === 'undefined' ? undefined : window) {
  if (!win || !win.location) return null;
  try {
    const params = new URLSearchParams(win.location.search || '');
    const value = params.get('venue_billing');
    if (!value) return null;
    const sessionId = params.get('session_id');
    params.delete('venue_billing');
    params.delete('session_id');
    const query = params.toString();
    if (win.history && typeof win.history.replaceState === 'function') {
      win.history.replaceState({}, '', `${win.location.pathname}${query ? `?${query}` : ''}${win.location.hash || ''}`);
    }
    if (value === 'success' && sessionId && SESSION_ID.test(sessionId)) return { kind: 'success', sessionId };
    if (value === 'manage') return { kind: 'manage' };
    if (value === 'cancelled') return { kind: 'cancelled' };
    return null;
  } catch {
    return null;
  }
}

// The confirm call writes the subscription on the server before it answers,
// so one call is normally enough. The webhook covers the rest: if the confirm
// fails, the dashboard still reloads its plan, and the tier arrives when
// Stripe's event does.
// Resolves to 'roost' | 'pending' | 'incomplete' | 'unknown'. Only 'pending'
// and 'roost' mean Stripe called the checkout complete. 'unknown' is anything
// this call could not confirm, a confirm that threw included (a session that
// belongs to another account answers 404), so a caller must not say on it that
// a payment went through.
export async function settleVenueCheckout({ sessionId, confirm }) {
  try {
    const r = await confirm(sessionId);
    if (r && r.complete === false) return 'incomplete';
    if (r && r.tier && r.tier !== 'free') return 'roost';
    if (r && r.complete) return 'pending';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
