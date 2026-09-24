import React, { useCallback, useEffect, useState } from 'react';
import './PrivacyPolicy.css';
import './ProPage.css';
import SiteFooter from './SiteFooter';
import { getProStatus, getToken, openProPortal, startProCheckout, trackPaywallShown } from '../services/api';
import { planSavingsPercent } from '../lib/proPricing';
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

const DESCRIPTION = 'Flock Pro raises the Birdie and crowd forecast limits. What it costs, what changes, and how to cancel.';

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
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [cancelled] = useState(cancelledReturn);
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
    setBusy(true);
    setActionError('');
    try {
      const { url } = await startProCheckout(plan.id);
      if (!url) throw new Error('Could not start checkout. Try again.');
      window.location.assign(url);
    } catch (err) {
      setBusy(false);
      if (err?.code === 'ALREADY_PRO' || err?.code === 'ALREADY_SUBSCRIBED' || err?.code === 'CHECKOUT_OFF') load();
      setActionError(err?.message || 'Could not start checkout. Try again.');
    }
  };

  const manage = async () => {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      const { url } = await openProPortal();
      if (!url) throw new Error('Could not open billing. Try again.');
      window.location.assign(url);
    } catch (err) {
      setBusy(false);
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
                {', '}
                {priceText(p)}{offerTax} a {periodWord(p)}
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
        {status.canManageWeb && (
          <button type="button" className="pro-cta" onClick={manage} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Opening billing' : 'Manage web subscription'}
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
                  {', '}
                  {priceText(p)} a {periodWord(p)}
                  {p.id === 'yearly' && savings ? `. ${savings}% less than 12 months of monthly.` : ''}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <BeforeYouPay plan={plan} trialDays={trialDays} tax={tax} />
        <button type="button" className="pro-cta" onClick={buy} disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Opening checkout' : 'Continue to payment'}
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
          More Birdie and more crowd forecasts, for the person in the group who does the planning.
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
              <th scope="row">Crowd forecasts a month</th>
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
        {signedIn && status && !status.isPremium && status.canManageWeb && (
          <button type="button" className="pro-cta pro-cta-quiet" onClick={manage} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Opening billing' : 'Manage your web subscription'}
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
          Sign in to Flock on the web, open You, then Flock Pro, then Manage subscription. You keep
          Pro until the end of the period you already paid for.
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
        <li>Cancel any time in your Flock account (You, Flock Pro, Manage). You keep Pro until the paid {plan ? period : 'period'} ends.</li>
        <li>Changed your mind? Full refund within 14 days of your first payment: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</li>
        <li>Under 18? A parent or guardian needs to buy it.</li>
      </ul>
    </div>
  );
}
