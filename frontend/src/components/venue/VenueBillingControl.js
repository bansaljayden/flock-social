import React, { useEffect, useState } from 'react';
import { getVenueBillingStatus, startVenueCheckout, openVenuePortal } from '../../services/api';

// ROOST'S BUY AND MANAGE BUTTONS, ON THE WEB ONLY.
//
// The venue dashboard ships inside the iOS binary (VENUE-BILLING.md finding
// 4), and a control there that offers a paid plan is an App Review 3.1.1
// question. So inside the native shell this renders exactly what it was handed
// as `fallback` (the "email us" request the sheet has always had) and never
// asks the server anything. On the web it asks /api/venue-billing/status and
// shows the first true thing, in this order:
//
//   1. the venue has a Stripe subscription, now or before: Manage billing;
//   2. the venue already holds this plan (a comp): nothing more to offer;
//   3. Roost is on sale and the venue is verified: the plans, from Stripe's
//      own prices, so the button can never name a number checkout will not
//      charge;
//   4. on sale, not verified: say what unlocks it, and keep the email route;
//   5. anything else, including a failed status read: the fallback.
//
// The component keeps its own state on purpose. screens/VenueDashboard.js
// holds none by design (its header says why), and this is a self-contained
// control with its own server round trip, not dashboard state.

const isNativeShell = () => typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;

const buttonStyle = (primary) => ({
  width: '100%',
  padding: '8px',
  borderRadius: '8px',
  border: primary ? 'none' : '1px solid #2d5a87',
  background: primary ? '#2d5a87' : 'var(--bg-card-solid)',
  color: primary ? 'white' : '#2d5a87',
  fontWeight: '600',
  fontSize: 'var(--t-meta)',
  cursor: 'pointer',
  marginTop: '8px',
});

const noteStyle = { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '8px 0 0', lineHeight: 1.5, textAlign: 'center' };

function perInterval(plan) {
  return plan.interval === 'year' ? `${plan.label} a year` : `${plan.label} a month`;
}

export default function VenueBillingControl({ current = false, fallback = null }) {
  const native = isNativeShell();
  const [status, setStatus] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (native) return undefined;
    let live = true;
    getVenueBillingStatus()
      .then((s) => { if (live) setStatus(s); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [native]);

  if (native) return current ? null : fallback;
  if (failed) return current ? null : fallback;
  if (!status) return null;

  const go = async (key, action) => {
    setBusy(key);
    setError(null);
    try {
      const { url } = await action();
      if (url) window.location.assign(url);
      else setBusy(null);
    } catch (err) {
      setError(err?.message || 'Could not reach billing. Try again.');
      setBusy(null);
    }
  };

  if (status.canManage) {
    return (
      <>
        <button className="hit44" disabled={!!busy} onClick={() => go('portal', openVenuePortal)} style={buttonStyle(!current)}>
          {busy === 'portal' ? 'Opening billing…' : 'Manage billing'}
        </button>
        {error && <p role="alert" style={noteStyle}>{error}</p>}
      </>
    );
  }

  if (current) return null;

  if (status.checkoutAvailable && status.plans?.length) {
    if (!status.verified) {
      return (
        <>
          <p style={noteStyle}>Roost can be bought once your venue is verified. Settings has the request.</p>
          {fallback}
        </>
      );
    }
    // Yearly first: VENUE-PRICING.md shows the annual option selected.
    const plans = [...status.plans].sort((a, b) => (a.interval === 'year' ? -1 : 0) - (b.interval === 'year' ? -1 : 0));
    const trial = status.trialDays > 0;
    return (
      <>
        {plans.map((plan, i) => (
          <button
            key={plan.id}
            className="hit44"
            disabled={!!busy}
            onClick={() => go(plan.id, () => startVenueCheckout(plan.id))}
            style={buttonStyle(i === 0)}
          >
            {busy === plan.id
              ? 'Opening checkout…'
              : `${trial ? `Try free for ${status.trialDays} days, then` : 'Subscribe,'} ${perInterval(plan)}`}
          </button>
        ))}
        <p style={noteStyle}>
          {trial ? 'Card required. ' : ''}Renews until you cancel{status.taxAdded ? ', plus tax' : ''}. Cancel any time from Manage billing.
        </p>
        {error && <p role="alert" style={noteStyle}>{error}</p>}
      </>
    );
  }

  return fallback;
}
