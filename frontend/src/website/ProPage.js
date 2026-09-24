import React, { useCallback, useEffect, useState } from 'react';
import './PrivacyPolicy.css';
import './ProPage.css';
import SiteFooter from './SiteFooter';
import { cancelProSubscription, getProStatus, getToken, openProPortal, resumeProSubscription, startProCheckout, trackPaywallShown } from '../services/api';
import { perMonthLabel, planSavingsPercent } from '../lib/proPricing';
import { rememberReturnAfterSignIn } from '../lib/returnAfterSignIn';

/* /pro: Flock Pro on the web.

   WEB ONLY. index.js never routes here inside the native shell, and the check
   below repeats that in case it ever does: Apple does not allow an app to
   point a buyer at a web price outside the US, and storefront gating does not
   exist yet, so inside the app this page renders nothing.

   EVERY PRICE ON THIS PAGE COMES FROM THE SERVER, which reads it from Stripe
   (backend/services/proBilling.js describePrice): GET /api/pro/status when
   signed in, and signed out the public GET /api/pro-offer, the same numbers
   the homepage's Pro card shows. There is no price literal in this file, and
   the tests fail the build on one. With checkout switched off neither route
   sends plans, and the page says so in one plain sentence instead of showing
   a button that cannot work.

   THE TABLE LISTS ONLY WHAT THE SERVER ENFORCES. Birdie: FREE_DAILY_LIMIT and
   PREMIUM_DAILY_LIMIT in backend/services/birdieUsage.js. Forecasts:
   FREE_MONTHLY_FORECASTS in backend/services/forecastUsage.js, with no meter
   at all for Pro. If either number moves there, it moves here, and nothing
   else goes in the table until the code enforces it (DESIGN-STANDARD C1). */

const CONTACT_EMAIL = 'social@flockcorp.com';
const API = process.env.REACT_APP_API_URL || 'https://api.flockcorp.com';
const BIRDIE_FREE_DAILY = 10;
const BIRDIE_PRO_DAILY = 150;
const FORECASTS_FREE_MONTHLY = 30;

const DESCRIPTION = 'Flock Pro lifts the Birdie limit and the monthly limit on crowd levels and forecasts. What it costs, what changes, and how to cancel.';

const READABLE = { color: 'var(--pp-ink-2)' };

function isNative() {
  try {
    return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

// "$3.99 USD". The server's label is already "$3.99" for USD and "3.99 EUR"
// for anything else, so the currency is only appended where it is missing.
function priceText(plan) {
  if (!plan || !plan.label) return '';
  return String(plan.currency || '').toUpperCase() === 'USD' ? `${plan.label} USD` : plan.label;
}

function periodWord(plan) {
  return plan?.interval === 'year' ? 'year' : 'month';
}

function planName(plan) {
  return plan?.id === 'yearly' ? 'yearly' : 'monthly';
}

// A promotion code from a shared link (/pro?code=FLOCKFRIENDS). Letters and
// digits only; the server looks it up and applies it only if it is live.
// Kept for half an hour in this tab, so signing in on the way does not lose it.
const CODE_RE = /^[A-Za-z0-9]{3,32}$/;
const CODE_KEY = 'flock_pro_code';
const CODE_TTL_MS = 30 * 60 * 1000;

function readCode() {
  try {
    const fromUrl = new URLSearchParams(window.location.search || '').get('code');
    if (fromUrl && CODE_RE.test(fromUrl)) {
      try { window.sessionStorage.setItem(CODE_KEY, JSON.stringify({ code: fromUrl, at: Date.now() })); } catch { /* storage refused */ }
      return fromUrl.toUpperCase();
    }
    const raw = window.sessionStorage.getItem(CODE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const fresh = v && CODE_RE.test(v.code) && Date.now() - Number(v.at) < CODE_TTL_MS;
    return fresh ? String(v.code).toUpperCase() : null;
  } catch {
    return null;
  }
}

function longDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

function cancelledReturn() {
  try {
    return new URLSearchParams(window.location.search || '').get('checkout') === 'cancelled';
  } catch {
    return false;
  }
}

export default function ProPage() {
  const native = isNative();
  const [signedIn] = useState(() => !!getToken());
  // 'loading' | 'ready' | 'error'. Signed out never leaves 'ready' with no status.
  const [phase, setPhase] = useState(signedIn ? 'loading' : 'ready');
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState('monthly');
  // Which action is in flight: 'checkout' | 'portal' | 'renewal'. One at a
  // time, and only the button doing it says so ("Opening billing" under a
  // cancel that is still running was a false statement).
  const [pending, setPending] = useState(null);
  const busy = pending !== null;
  const [actionError, setActionError] = useState('');
  const [cancelled] = useState(cancelledReturn);
  const [code] = useState(readCode);
  // The cancel step asks once before it acts.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // Signed out: the public offer, so a visitor sees what Pro costs before
  // being asked to sign in (the homepage already prints the same prices).
  const [offer, setOffer] = useState(null);

  useEffect(() => {
    if (native) return;
    trackPaywallShown('pro_page');
    document.title = 'Flock Pro | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
  }, [native]);

  const load = useCallback(() => {
    if (!signedIn) return undefined;
    let live = true;
    setPhase('loading');
    getProStatus()
      .then((data) => {
        if (!live) return;
        setStatus(data);
        const plans = Array.isArray(data?.plans) ? data.plans : [];
        if (plans.length && !plans.some((p) => p.id === 'monthly')) setSelected(plans[0].id);
        setPhase('ready');
      })
      .catch((err) => {
        if (!live) return;
        setLoadError(err?.message || 'Could not load Flock Pro just now.');
        setPhase('error');
      });
    return () => { live = false; };
  }, [signedIn]);

  useEffect(() => {
    if (native) return undefined;
    return load();
  }, [native, load]);

  useEffect(() => {
    if (native || signedIn || typeof fetch !== 'function') return undefined;
    let live = true;
    fetch(`${API}/api/pro-offer`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d && d.available && Array.isArray(d.plans) && d.plans.length) setOffer(d); })
      .catch(() => {});
    return () => { live = false; };
  }, [native, signedIn]);

  if (native) return null;

  const plans = Array.isArray(status?.plans) ? status.plans : [];
  const checkoutOn = !!status?.checkoutAvailable && plans.length > 0;
  const plan = plans.find((p) => p.id === selected) || plans[0] || null;
  const monthly = plans.find((p) => p.id === 'monthly');
  const yearly = plans.find((p) => p.id === 'yearly');
  const savings = planSavingsPercent(monthly, yearly);
  const trialDays = Number(status?.trialDays) > 0 ? Number(status.trialDays) : 0;
  const tax = status?.taxAdded ? ' plus tax' : '';

  const buy = async () => {
    if (busy || !plan) return;
    setPending('checkout');
    setActionError('');
    try {
      const { url } = await startProCheckout(plan.id, { from: 'pro_page', code: code || undefined });
      if (!url) throw new Error('Could not start checkout. Try again.');
      window.location.assign(url);
    } catch (err) {
      setPending(null);
      if (err?.code === 'ALREADY_PRO' || err?.code === 'ALREADY_SUBSCRIBED' || err?.code === 'CHECKOUT_OFF') load();
      setActionError(err?.message || 'Could not start checkout. Try again.');
    }
  };

  // Flock's own cancel, and taking it back. Stripe's portal is for people 18
  // and over, and much of the audience is younger, so these do not go there.
  const changeRenewal = async (cancel) => {
    if (busy) return;
    setPending('renewal');
    setActionError('');
    try {
      const result = cancel ? await cancelProSubscription() : await resumeProSubscription();
      setStatus((s) => (s ? { ...s, hasWebSubscription: true, cancelAtPeriodEnd: !!result?.cancelAtPeriodEnd, periodEnd: result?.periodEnd || s.periodEnd } : s));
      setConfirmingCancel(false);
    } catch (err) {
      setActionError(err?.message || (cancel ? 'Could not cancel just now. Try again.' : 'Could not keep Pro just now. Try again.'));
    } finally {
      setPending(null);
    }
  };

  const manage = async () => {
    if (busy) return;
    setPending('portal');
    setActionError('');
    try {
      const { url } = await openProPortal();
      if (!url) throw new Error('Could not open billing. Try again.');
      window.location.assign(url);
    } catch (err) {
      setPending(null);
      setActionError(err?.message || 'Could not open billing. Try again.');
    }
  };

  let purchase;
  if (!signedIn) {
    const offerPlans = Array.isArray(offer?.plans) ? offer.plans : [];
    const offerSavings = planSavingsPercent(offerPlans.find((p) => p.id === 'monthly'), offerPlans.find((p) => p.id === 'yearly'));
    const offerTax = offer?.taxAdded ? ' plus tax' : '';
    purchase = (
      <>
        {offerPlans.length > 0 && (
          <ul className="pro-prices">
            {offerPlans.map((p) => (
              <li key={p.id}>
                <strong>{p.id === 'yearly' ? 'Yearly' : 'Monthly'}</strong>
                {p.id === 'yearly' && <span className="pro-tag">Best value</span>}
                {', '}
                {priceText(p)}{offerTax} a {periodWord(p)}
                {p.id === 'yearly' && perMonthLabel(p) ? `, ${perMonthLabel(p)} a month` : ''}
                {p.id === 'yearly' && offerSavings ? `. ${offerSavings}% less than 12 months of monthly.` : ''}
              </li>
            ))}
          </ul>
        )}
        <BeforeYouPay plan={null} />
        {/* Back to this page after signing in (lib/returnAfterSignIn.js). */}
        <a className="pro-cta" href="/app" onClick={() => rememberReturnAfterSignIn('/pro')}>Log in to continue</a>
      </>
    );
  } else if (phase === 'loading') {
    purchase = <p className="pro-note" role="status">Checking your account.</p>;
  } else if (phase === 'error') {
    purchase = (
      <div role="alert">
        <p className="pro-note">{loadError}</p>
        <button type="button" className="pro-cta pro-cta-quiet" onClick={load}>Try again</button>
      </div>
    );
  } else if (status?.isPremium) {
    purchase = (
      <>
        <p className="pro-note">You already have Flock Pro on this account.</p>
        {status.hasWebSubscription && (
          <RenewalControls
            status={status}
            busy={busy}
            working={pending === 'renewal'}
            confirming={confirmingCancel}
            onAskCancel={() => setConfirmingCancel(true)}
            onNever={() => setConfirmingCancel(false)}
            onCancel={() => changeRenewal(true)}
            onResume={() => changeRenewal(false)}
          />
        )}
        {status.canManageWeb && (
          <button type="button" className="pro-cta pro-cta-quiet" onClick={manage} disabled={busy} aria-busy={busy || undefined}>
            {pending === 'portal' ? 'Opening billing' : 'Payment method and invoices'}
          </button>
        )}
        {/* Shown either way: an account can be Pro through Apple and still
            carry an old web purchase, and the Apple half is managed in Apple's
            settings, never in Stripe's portal. */}
        <p className="pro-note">If you pay for Flock Pro through Apple, manage it in your iPhone&apos;s Settings, under your Apple ID and Subscriptions.</p>
      </>
    );
  } else if (!checkoutOn) {
    purchase = <p className="pro-note">Flock Pro is not on sale on the web yet.</p>;
  } else {
    purchase = (
      <>
        {plans.length > 1 && (
          <fieldset className="pro-plans">
            <legend>Choose a plan</legend>
            {plans.map((p) => (
              <label key={p.id} className="pro-plan">
                <input
                  type="radio"
                  name="pro-plan"
                  value={p.id}
                  checked={plan?.id === p.id}
                  onChange={() => setSelected(p.id)}
                  disabled={busy}
                />
                <span>
                  <strong>{p.id === 'yearly' ? 'Yearly' : 'Monthly'}</strong>
                  {p.id === 'yearly' && <span className="pro-tag">Best value</span>}
                  {', '}
                  {priceText(p)} a {periodWord(p)}
                  {p.id === 'yearly' && perMonthLabel(p) ? `, ${perMonthLabel(p)} a month` : ''}
                  {p.id === 'yearly' && savings ? `. ${savings}% less than 12 months of monthly.` : ''}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {/* "Before you pay" names the full price; a code lowers it on Stripe's
            page, which is the price actually charged. */}
        {code && <p className="pro-note">Code {code} is applied at checkout if it is still active. The price on the checkout page already includes it.</p>}
        <BeforeYouPay plan={plan} trialDays={trialDays} tax={tax} />
        {/* The button says what it charges (the research notes: a CTA that
            states the price, and the billed amount as the plainest number). */}
        <button type="button" className="pro-cta" onClick={buy} disabled={busy} aria-busy={busy || undefined}>
          {pending === 'checkout' ? 'Opening checkout' : (trialDays > 0 ? `Start ${trialDays}-day free trial` : `Get Pro, ${plan?.label}/${periodWord(plan)}`)}
        </button>
      </>
    );
  }

  return (
    <main className="pp pro">
      <a className="pp-skip" href="#pp-content">Skip to the main content</a>

      <a href="/" className="pp-back" style={READABLE}>
        <span aria-hidden="true">&larr;</span> flockcorp.com
      </a>

      <header className="pp-header" id="pp-content" tabIndex={-1}>
        <h1>Flock Pro</h1>
        <p className="pp-meta" style={READABLE}>
          More Birdie, and crowd levels for every venue, for the person in the group who does the planning.
        </p>
      </header>

      {cancelled && (
        <p className="pro-note" role="status">Checkout was cancelled. You were not charged.</p>
      )}

      <section aria-labelledby="pro-compare">
        <h2 id="pro-compare">Free and Pro</h2>
        <table className="pro-table">
          <thead>
            <tr>
              <th scope="col"><span className="pp-sr-only">Limit</span></th>
              <th scope="col">Free</th>
              <th scope="col">Pro</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Birdie messages a day</th>
              <td>{BIRDIE_FREE_DAILY}</td>
              <td>{BIRDIE_PRO_DAILY}</td>
            </tr>
            <tr>
              <th scope="row">Venues with crowd levels and forecasts, a month</th>
              <td>{FORECASTS_FREE_MONTHLY}</td>
              <td>No limit</td>
            </tr>
          </tbody>
        </table>
        <p className="pro-small">
          Starting a flock, voting, budgets, chat and bill splits cost nothing on either plan.
        </p>
      </section>

      <section aria-labelledby="pro-buy">
        <h2 id="pro-buy">Get Pro</h2>
        {purchase}
        {/* A WEB SUBSCRIPTION THAT IS NOT PRO RIGHT NOW STILL HAS A DOOR. A
            payment that failed, a card that needs a 3-D Secure step, or a
            subscription RevenueCat has not reported yet all leave the account
            not Pro while Stripe is still billing it, and checkout answers
            "already subscribed". Without this the Terms' own cancel path had
            nowhere to go. It also serves somebody whose old subscription ended
            and who wants their invoices. */}
        {signedIn && status && !status.isPremium && status.hasWebSubscription && (
          <RenewalControls
            status={status}
            busy={busy}
            working={pending === 'renewal'}
            confirming={confirmingCancel}
            onAskCancel={() => setConfirmingCancel(true)}
            onNever={() => setConfirmingCancel(false)}
            onCancel={() => changeRenewal(true)}
            onResume={() => changeRenewal(false)}
          />
        )}
        {signedIn && status && !status.isPremium && status.canManageWeb && (
          <button type="button" className="pro-cta pro-cta-quiet" onClick={manage} disabled={busy} aria-busy={busy || undefined}>
            {pending === 'portal' ? 'Opening billing' : 'Payment method and invoices'}
          </button>
        )}
        {actionError && <p className="pro-error" role="alert">{actionError}</p>}
      </section>

      <section aria-labelledby="pro-questions">
        <h2 id="pro-questions">Questions</h2>
        <h3>I already have Pro on my iPhone.</h3>
        <p>
          Pro belongs to your Flock account, so it already works here. Manage it in your
          iPhone&apos;s Settings, under your Apple ID and Subscriptions. Do not buy it a second time on the web.
        </p>
        <h3>How do I cancel?</h3>
        <p>
          Sign in to Flock on the web, open You, then Flock Pro, then Cancel subscription, or use
          the same button on this page. You keep Pro until the end of the period you already paid
          for, and you can take the cancel back before then. You can also email{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will cancel it for you.
        </p>
        <h3>Can I get a refund?</h3>
        <p>
          Yes, within 14 days of your first payment. Email{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address on your account.
        </p>
        <h3>What happens to my flocks if I cancel?</h3>
        <p>Nothing. Your flocks, chats and friends stay as they are. Only the limits in the table go back to Free.</p>
      </section>

      <SiteFooter className="pp-footer" linkStyle={READABLE}>
        <p>
          Sold by Flock Social LLC, 2610 Long Ridge Dr, Hellertown, PA 18055.{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} style={READABLE}>{CONTACT_EMAIL}</a>
        </p>
      </SiteFooter>
    </main>
  );
}

// Cancel, or take a cancel back. With the subscription set to end, the page
// says when and offers Keep Pro; otherwise Cancel subscription, which asks
// once before it acts.
function RenewalControls({ status, busy, working, confirming, onAskCancel, onNever, onCancel, onResume }) {
  const until = longDate(status.periodEnd);
  if (status.cancelAtPeriodEnd) {
    return (
      <div className="pro-renewal">
        <p className="pro-note">{until ? `Flock Pro ends on ${until}. Nothing more will be charged.` : 'Flock Pro ends at the end of the paid period. Nothing more will be charged.'}</p>
        <button type="button" className="pro-cta" onClick={onResume} disabled={busy} aria-busy={working || undefined}>Keep Pro</button>
      </div>
    );
  }
  if (confirming) {
    return (
      <div className="pro-renewal" role="group" aria-label="Cancel Flock Pro">
        <p className="pro-note">{until ? `Cancel Flock Pro? You keep it until ${until}, then the free limits apply.` : 'Cancel Flock Pro? You keep it until the paid period ends, then the free limits apply.'}</p>
        <button type="button" className="pro-cta" onClick={onCancel} disabled={busy} aria-busy={working || undefined}>Yes, cancel</button>
        <button type="button" className="pro-cta pro-cta-quiet" onClick={onNever} disabled={busy}>Keep Pro</button>
      </div>
    );
  }
  return (
    <div className="pro-renewal">
      {until && <p className="pro-note">Renews on {until}.</p>}
      <button type="button" className="pro-cta pro-cta-quiet" onClick={onAskCancel} disabled={busy}>Cancel subscription</button>
    </div>
  );
}

// The terms, in the sentences a person reads right before paying. With no plan
// (signed out) the first line is left out rather than written without a price.
function BeforeYouPay({ plan, trialDays = 0, tax = '' }) {
  const period = periodWord(plan);
  let first = null;
  if (plan) {
    first = trialDays > 0
      ? `Flock Pro, ${planName(plan)}. Free for ${trialDays} days, then ${priceText(plan)}${tax} every ${period} until you cancel. Cancel before the free days end and you pay nothing.`
      : `Flock Pro, ${planName(plan)}. ${priceText(plan)}${tax} today, then every ${period} on this date until you cancel.`;
  }
  return (
    <div className="pro-panel" aria-labelledby="pro-before">
      <h3 id="pro-before">Before you pay</h3>
      <ul>
        {first && <li>{first}</li>}
        <li>Cancel any time in your Flock account (You, Flock Pro, Cancel subscription). You keep Pro until the paid {plan ? period : 'period'} ends.</li>
        <li>Changed your mind? Full refund within 14 days of your first payment: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</li>
        <li>Under 18? A parent or guardian needs to buy it.</li>
      </ul>
    </div>
  );
}
