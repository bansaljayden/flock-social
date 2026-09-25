import React, { useEffect, useState } from 'react';
import { getVenueBillingStatus, startVenueCheckout, openVenuePortal } from '../../services/api';
import { isNativeShell } from '../../lib/nativeShell';

// ROOST'S BUY AND MANAGE BUTTONS, ON THE WEB ONLY.
//
// The venue dashboard ships inside the iOS binary (VENUE-BILLING.md finding
// 4), and a control there that offers a paid plan is an App Review 3.1.1
// question. So inside the native shell (lib/nativeShell.js, the same answer
// index.js boots on) this renders exactly what it was handed as `fallback`
// (the "email us" request the sheet has always had) and never asks the server
// anything. On the web it asks /api/venue-billing/status and shows the first
// true thing, in this order:
//
//   1. the venue has a Stripe subscription, now or before: Manage billing;
//   2. the venue is inside its notice window (an account from before Roost
//      had a price, Terms 9.6): it holds everything until a date, so it is
//      shown the plans that keep Roost after it, with that date;
//   3. the venue already holds this plan (a comp): nothing more to offer;
//   4. Roost is on sale and the venue is verified: the plans, from Stripe's
//      own prices, so the button can never name a number checkout will not
//      charge;
//   5. on sale, not verified: say what unlocks it, and keep the email route;
//   6. anything else, including a failed status read: the fallback.
//
// While the status is on its way the fallback stays up, under a line saying
// the plans are being checked, so a slow read never hides the one route that
// works without it.
//
// The component keeps its own state on purpose. screens/VenueDashboard.js
// holds none by design (its header says why), and this is a self-contained
// control with its own server round trip, not dashboard state. The dashboard's
// own lines about the plan (the price on the Roost card, how a paid plan is
// billed, how it ends) read the same status through VenueBillingStatus below.

// One read shared by every consumer that mounts while it is in flight: the
// plans sheet mounts two (its price and these buttons), and opening it asks
// once. Only while in flight. A settled answer is never reused, because a
// verification, a checkout or the end of a notice window can change it.
let statusInFlight = null;
function readVenueBillingStatus() {
  if (statusInFlight) return statusInFlight;
  const pending = Promise.resolve(getVenueBillingStatus());
  statusInFlight = pending;
  const settle = () => { if (statusInFlight === pending) statusInFlight = null; };
  pending.then(settle, settle);
  return pending;
}

// -> { native, status, failed }. status stays null natively, while loading and
// after a failed read, and a caller then says what it said before there was a
// status to read.
export function useVenueBillingStatus() {
  const native = isNativeShell();
  const [status, setStatus] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (native) return undefined;
    let live = true;
    readVenueBillingStatus()
      .then((s) => {
        if (!live) return;
        if (s && typeof s === 'object') setStatus(s);
        else setFailed(true);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [native]);
  return { native, status, failed };
}

// The same status for a line of dashboard copy, as a render prop, so the
// dashboard itself stays free of state.
export function VenueBillingStatus({ children }) {
  const billing = useVenueBillingStatus();
  return children(billing);
}

// The Roost price the plans sheet prints, from Stripe's own prices: the monthly
// one when it is on sale, otherwise the yearly one. Null when the status has no
// price to give, and the sheet keeps the figure it printed before.
export function roostPlanPriceLabel(status) {
  if (!status || !status.checkoutAvailable || !Array.isArray(status.plans)) return null;
  const monthly = status.plans.find((p) => p && p.interval === 'month' && p.label);
  if (monthly) return `${monthly.label}/mo`;
  const yearly = status.plans.find((p) => p && p.interval === 'year' && p.label);
  return yearly ? `${yearly.label}/yr` : null;
}

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

function longDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;
}

export default function VenueBillingControl({ current = false, fallback = null }) {
  const { native, status, failed } = useVenueBillingStatus();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  if (native) return current ? null : fallback;
  if (failed) return current ? null : fallback;
  // Still asking. This used to render nothing, which took the email request
  // off the sheet for as long as the read took. The current plan's card has
  // no request to keep, so it waits for the answer as before.
  if (!status) {
    if (current) return null;
    return (
      <>
        <p role="status" style={noteStyle}>Checking Roost plans…</p>
        {fallback}
      </>
    );
  }

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

  // Inside the notice window the venue holds everything, so the card it is
  // shown on reads as its current plan; the plans still have to be here, or
  // there is no way to keep Roost once the window closes.
  const windowUntil = status.inNoticeWindow ? longDate(status.freeUntil) : null;
  if (current && !windowUntil) return null;

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
        {windowUntil && (
          <p style={noteStyle}>Your venue keeps everything until {windowUntil}. Subscribe to keep Roost after that; nothing is charged before then.</p>
        )}
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
              : windowUntil
                ? `Free until ${windowUntil}, then ${perInterval(plan)}`
                : `${trial ? `Try free for ${status.trialDays} days, then` : 'Subscribe,'} ${perInterval(plan)}`}
          </button>
        ))}
        <p style={noteStyle}>
          {trial || windowUntil ? 'Card required. ' : ''}Renews until you cancel{status.taxAdded ? ', plus tax' : ''}. Cancel any time from Manage billing.
        </p>
        {error && <p role="alert" style={noteStyle}>{error}</p>}
      </>
    );
  }

  return fallback;
}
