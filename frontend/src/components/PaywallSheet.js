import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';
import { isPurchasesAvailable, getProOffering, purchase, restore } from '../services/purchases';
import { getProStatus, startProCheckout, trackPaywallShown, trackPurchaseCompleted } from '../services/api';
import { yearlySavingsPercent, planSavingsPercent, perMonthLabel, storePerMonthLabel } from '../lib/proPricing';
import { birdieBackText, forecastBackText } from '../lib/meterResets';

// Flock Pro paywall bottom sheet. Sheet mechanics mirror ModerationSheet.js
// (overlay, 440px max, 20px top radius, drag handle, fadeInUp).
//
// Props: { open, onClose, showToast, onUpgraded, trigger, birdieResetsAt, place }
//   trigger ∈ 'birdie' | 'forecast' | 'settings' | null: which limit opened it.
//   birdieResetsAt: the reset time the server sent with Birdie's refusal.
//   place: the venue a forecast was locked on, so the trip back from Stripe
//          reopens it.
//
// TWO STORES, ONE SHEET. Inside the iOS app Pro is Apple's in-app purchase,
// through RevenueCat, and the CTA only renders when an offering actually
// loaded (Apple 2.1). On the web the same sheet sells through Stripe: the
// plans and prices come from GET /api/pro/status, exactly what /pro shows,
// and the CTA goes to Stripe's hosted checkout.
//
// WHAT THE SCREEN DOES, AND THE EVIDENCE FOR EACH (the 2026-09-24 research
// pass; sources in the paywall research notes):
//   * The headline names the limit that was just hit and when it comes back,
//     then what Pro changes. A paywall at the moment of need converts better
//     than a generic upgrade screen, and the reset time keeps it honest.
//   * Three benefit lines at most, the one just hit first. Static: no video or
//     animation, which the data does not support for a screen this small.
//   * The billed price is the biggest price on each plan (Apple 3.1.2 wants
//     the amount charged most prominent). The yearly plan shows what it comes
//     to a month and the saving, both computed from the prices on screen, and
//     is labelled "Best value", never "Most popular", a claim nothing backs.
//   * Monthly stays preselected: the smaller commitment for an audience that
//     is often a teenager asking a parent. The first A/B test to run once real
//     buyers exist is which plan is preselected.
//   * The CTA states the charge, and one line under it says it renews, how to
//     cancel, and the refund window. Clear renewal terms raised conversion and
//     cut complaints in the published tests; California requires them anyway.
//   * No trial and no toggle at launch: the unmetered first week is the free
//     taste, and Apple has rejected trial toggles since January 2026. No
//     reviews, user counts or countdowns until any of them would be real.
//
// Never a dead button, never an Alert, never "coming soon". Natively the
// sheet never names the website: outside the US storefront that is steering
// under guideline 3.1.1.

// The limits Pro lifts. The same numbers /pro's table prints (website/ProPage.js)
// and the server enforces: FREE_DAILY_LIMIT / PREMIUM_DAILY_LIMIT in
// backend/services/birdieUsage.js, FREE_MONTHLY_FORECASTS in forecastUsage.js.
const BIRDIE_FREE_DAILY = 10;
const BIRDIE_PRO_DAILY = 150;
const FORECASTS_FREE_MONTHLY = 30;

const GENERIC_HEADLINE = 'Get more out of every night out';

// The headline and the line under it, for what opened the sheet.
function headlineFor(trigger, birdieResetsAt, now = new Date()) {
  if (trigger === 'forecast') {
    return {
      title: `You've checked ${FORECASTS_FREE_MONTHLY} venues this month`,
      sub: `Crowd levels for new venues come back ${forecastBackText(now)}. With Pro there is no monthly limit.`,
    };
  }
  if (trigger === 'birdie') {
    return {
      title: `You've used today's ${BIRDIE_FREE_DAILY} Birdie messages`,
      sub: `They come back ${birdieBackText(birdieResetsAt, now)}. Pro gives you ${BIRDIE_PRO_DAILY} a day.`,
    };
  }
  return { title: GENERIC_HEADLINE, sub: null };
}

const TERMS_URL = 'https://www.flockcorp.com/terms';
const PRIVACY_URL = 'https://www.flockcorp.com/privacy';
const CONTACT_EMAIL = 'social@flockcorp.com';

const FONT = "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif";

// Minimal 18px stroke icons (in-app SVG language, no emoji as UI icons).
const BenefitIcon = ({ path, color }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
    {path}
  </svg>
);

const ICON_PATHS = {
  birdie: <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
  forecast: <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></>,
  alerts: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
};

// Every line here must name something that actually ships (DESIGN-STANDARD.md C1).
// Birdie cap: backend/services/birdieUsage.js. Crowd levels: forecastUsage.js.
// Alerts: crowdAlerts.js cron sends to Pro users when the flag is on.
const BENEFIT = {
  forecast: { icon: 'forecast', label: 'Crowd levels and forecasts for every venue' },
  alerts: { icon: 'alerts', label: 'A heads-up push before your spot gets packed' },
  birdie: { icon: 'birdie', label: `${BIRDIE_PRO_DAILY} Birdie messages a day, up from ${BIRDIE_FREE_DAILY}` },
};

// The one just hit first, then the push, then the rest.
function benefitsFor(trigger) {
  if (trigger === 'birdie') return [BENEFIT.birdie, BENEFIT.alerts, BENEFIT.forecast];
  return [BENEFIT.forecast, BENEFIT.alerts, BENEFIT.birdie];
}

function isNativeShell() {
  try {
    return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

// Match RevenueCat packages to our two plans by packageType / identifier.
const pickPackage = (packages, kind) => {
  if (!Array.isArray(packages)) return null;
  const wantType = kind === 'yearly' ? 'ANNUAL' : 'MONTHLY';
  const wantId = kind === 'yearly' ? '$rc_annual' : '$rc_monthly';
  return (
    packages.find((p) => p?.packageType === wantType) ||
    packages.find((p) => p?.identifier === wantId) ||
    null
  );
};

// A free trial is only named when the store product really carries one. This
// sheet used to promise "7-day free trial" on the yearly plan in three places
// whatever the product said, and the App Store products are created without
// an introductory offer (PAYWALL.md 1c), so the promise would have been false
// on the day it could first be read.
const UNIT_WORDS = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
function freeTrialLabel(pkg) {
  const intro = pkg?.product?.introPrice;
  if (!intro || Number(intro.price) !== 0) return null;
  const n = Number(intro.periodNumberOfUnits);
  const unit = UNIT_WORDS[String(intro.periodUnit || '').toUpperCase()];
  if (!Number.isFinite(n) || n <= 0 || !unit) return null;
  return `${n}-${unit} free trial`;
}

const PaywallSheet = ({ open, onClose, showToast, onUpgraded, trigger, birdieResetsAt, place }) => {
  const { isDark } = useTheme();
  const accent = isDark ? '#6d9ac3' : '#2d5a87';
  const native = isNativeShell();

  // Monthly first: it is the smaller commitment, and the web checkout
  // (website/ProPage.js) opens on it too. Which plan is preselected is the
  // first A/B test to run once there are real buyers to run it on.
  const [selected, setSelected] = useState('monthly');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // Native: 'loading' | 'ready' | 'unavailable'
  // Web:    'web-loading' | 'web-ready' | 'web-off' | 'web-pro' | 'web-error'
  const [loadState, setLoadState] = useState('loading');
  const [packages, setPackages] = useState(null);
  const [webStatus, setWebStatus] = useState(null);
  const [actionError, setActionError] = useState('');

  // One paywall_shown per opening, and what opened it (services/api.js, THE
  // PAYWALL FUNNEL). Its own effect so a change of trigger while open counts
  // as the new reason it is on screen.
  useEffect(() => {
    if (open) trackPaywallShown(trigger);
  }, [open, trigger]);

  // The web half: the same answer /pro renders, from the same route. A sheet
  // that is open with a failed read offers to ask again rather than a price.
  const loadWeb = useCallback(() => {
    let live = true;
    setLoadState('web-loading');
    setActionError('');
    getProStatus()
      .then((data) => {
        if (!live) return;
        setWebStatus(data);
        const plans = Array.isArray(data?.plans) ? data.plans : [];
        if (data?.isPremium) setLoadState('web-pro');
        else if (data?.checkoutAvailable && plans.length) {
          if (!plans.some((p) => p.id === 'monthly')) setSelected(plans[0].id);
          setLoadState('web-ready');
        } else setLoadState('web-off');
      })
      .catch(() => { if (live) setLoadState('web-error'); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setSelected('monthly');
    setBusy(false);
    setRestoring(false);
    setActionError('');
    if (!native) return loadWeb();
    if (!isPurchasesAvailable()) {
      setLoadState('unavailable');
      setPackages(null);
      return undefined;
    }
    setLoadState('loading');
    getProOffering().then((pkgs) => {
      if (cancelled) return;
      if (pkgs && (pickPackage(pkgs, 'yearly') || pickPackage(pkgs, 'monthly'))) {
        setPackages(pkgs);
        setLoadState('ready');
      } else {
        setPackages(null);
        setLoadState('unavailable');
      }
    });
    return () => { cancelled = true; };
    // `native` is fixed for the life of the page; loadWeb is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Dialog behavior. This sheet had none of it: no role, no label, no focus
  // move, no Escape, and no close control of any kind. The only way out was a
  // tap on the backdrop, which is a div, so on a keyboard or with VoiceOver
  // there was no way out at all. It is also `position: absolute; inset: 0` over
  // the app, so a screen reader landing behind it read the screen underneath a
  // sheet the user could not see and could not leave.
  //
  // Third copy of this block in components/. ModerationSheet.js and
  // safety/EmergencySheet.js carry the same one for the same stated reason:
  // App.js's DialogBehavior is defined inside App.js and is not exported.
  // stopImmediatePropagation matches those two, so Escape here does not also
  // dismiss whatever opened this.
  //
  // MOUNT AND UNMOUNT ONLY, which this block was not. The dep array read
  // [open, busy, restoring, onClose], and onClose arrives from the mount site
  // as an inline arrow (onClose={() => setPaywallTrigger(null)}), so it is a
  // new function on every render of the host. The effect therefore tore down
  // and re-added the document capture listener and re-armed the 0 ms focus
  // timer on every one of those renders, and that timer moves focus to the
  // sheet's first button: somebody reading the plan cards, or sitting on
  // Monthly with the keyboard, loses their place for a reason that has nothing
  // to do with this sheet. busy and restoring did the same thing twice per
  // purchase attempt. The live values reach the handler through refs instead,
  // which is how the other two copies of this block already hold it
  // (FlockProfileSheet's useSheetDialog says it outright: re-running the trap
  // on every prop change is how DialogBehavior once grabbed focus back on each
  // render). Dep array is [open], so the listener and the timer belong to the
  // open, not to the render.
  const sheetRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const restoringRef = useRef(restoring);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  restoringRef.current = restoring;
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Read at event time rather than closure time. The three locals keep the
      // names of the props and state they mirror, so the rule below still says
      // exactly what it said when the handler closed over them.
      const busy = busyRef.current;
      const restoring = restoringRef.current;
      const onClose = onCloseRef.current;
      // Never mid-purchase: closing the sheet under a running transaction is
      // how someone ends up charged with no confirmation on screen.
      if (!busy && !restoring) onClose?.();
    };
    document.addEventListener('keydown', onKeyDown, true);
    const t = setTimeout(() => {
      // Focus already inside the sheet stays where the user put it. The same
      // guard sits ahead of EmergencySheet's focus move, for the same reason:
      // a focus() on a re-run is a focus() the user did not ask for.
      if (sheetRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      const first = sheetRef.current?.querySelector('button');
      try { first?.focus({ preventScroll: true }); } catch { /* detached */ }
    }, 0);
    return () => { document.removeEventListener('keydown', onKeyDown, true); clearTimeout(t); };
  }, [open]);

  if (!open) return null;

  // ---- native (App Store) ----
  const yearlyPkg = pickPackage(packages, 'yearly');
  const monthlyPkg = pickPackage(packages, 'monthly');
  // The saving is worked out from the two store prices on screen, never typed
  // in: a typed-in percentage outlived the price pair it was true for.
  const numericPrice = (pkg) => (typeof pkg?.product?.price === 'number' ? pkg.product.price : null);
  const nativeSavePct = yearlySavingsPercent(numericPrice(monthlyPkg), numericPrice(yearlyPkg));
  const yearlyTrial = freeTrialLabel(yearlyPkg);
  const monthlyTrial = freeTrialLabel(monthlyPkg);
  const selectedTrial = selected === 'yearly' ? yearlyTrial : monthlyTrial;
  const selectedPkg = selected === 'yearly' ? yearlyPkg : monthlyPkg;

  // ---- web (Stripe) ----
  const webPlans = Array.isArray(webStatus?.plans) ? webStatus.plans : [];
  const webMonthly = webPlans.find((p) => p.id === 'monthly');
  const webYearly = webPlans.find((p) => p.id === 'yearly');
  const webSelected = webPlans.find((p) => p.id === selected) || webPlans[0] || null;
  const webTrialDays = Number(webStatus?.trialDays) > 0 ? Number(webStatus.trialDays) : 0;
  const webTax = webStatus?.taxAdded ? ' plus tax' : '';

  const savePct = native ? nativeSavePct : planSavingsPercent(webMonthly, webYearly);
  const { title: headline, sub: subline } = headlineFor(trigger, birdieResetsAt);
  const benefits = benefitsFor(trigger);

  const periodOf = (kind) => (kind === 'yearly' ? 'year' : 'month');

  const handlePurchase = async () => {
    if (!selectedPkg || busy || restoring) return;
    setBusy(true);
    try {
      const { success, isPro } = await purchase(selectedPkg);
      if (success && isPro) {
        trackPurchaseCompleted('app_store', selected);
        showToast?.('Welcome to Flock Pro', 'success');
        onUpgraded?.();
        onClose?.();
      }
      // Cancelled / failed purchases stay quiet: the sheet remains usable.
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (busy || restoring) return;
    setRestoring(true);
    try {
      const { success, isPro } = await restore();
      if (success && isPro) {
        showToast?.('Welcome to Flock Pro', 'success');
        onUpgraded?.();
        onClose?.();
      } else if (success) {
        showToast?.('No previous purchases found', 'error');
      } else {
        showToast?.('Could not restore purchases', 'error');
      }
    } finally {
      setRestoring(false);
    }
  };

  // Web: to Stripe's hosted checkout, carrying what opened the sheet so the
  // trip back lands on it. busy stays on through the redirect, so Escape
  // cannot close the sheet between the click and the page change.
  const handleWebCheckout = async () => {
    if (busy || !webSelected) return;
    setBusy(true);
    setActionError('');
    try {
      const from = ['forecast', 'birdie', 'settings'].includes(trigger) ? trigger : undefined;
      const { url } = await startProCheckout(webSelected.id, {
        from,
        place: from === 'forecast' && typeof place === 'string' ? place : undefined,
      });
      if (!url) throw new Error('Could not start checkout. Try again.');
      window.location.assign(url);
    } catch (err) {
      setBusy(false);
      if (err?.code === 'ALREADY_PRO' || err?.code === 'ALREADY_SUBSCRIBED' || err?.code === 'CHECKOUT_OFF') loadWeb();
      setActionError(err?.message || 'Could not start checkout. Try again.');
    }
  };

  // One plan. The billed price is the biggest thing on it; the yearly plan
  // adds what it comes to a month and the saving, smaller, underneath. A free
  // trial is named on the card of the plan that carries one (there is none at
  // launch; freeTrialLabel says when there would be).
  const planCard = ({ kind, price, perMonth, trial }) => {
    const active = selected === kind;
    const yearly = kind === 'yearly';
    return (
      <button
        key={kind}
        type="button"
        onClick={() => setSelected(kind)}
        disabled={busy || restoring}
        aria-pressed={active}
        style={{
          flex: 1,
          minWidth: 0,
          padding: '12px',
          textAlign: 'left',
          borderRadius: '14px',
          border: active ? `2px solid ${accent}` : '1px solid var(--border-subtle)',
          backgroundColor: active ? (isDark ? 'rgba(109,154,195,0.10)' : 'rgba(45,90,135,0.06)') : 'var(--bg-card-solid)',
          cursor: 'pointer',
          fontFamily: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>{yearly ? 'Yearly' : 'Monthly'}</span>
          {yearly && (
            <span style={{ fontSize: '10px', fontWeight: '700', color: accent, border: `1px solid ${accent}`, borderRadius: '999px', padding: '1px 7px', whiteSpace: 'nowrap' }}>Best value</span>
          )}
        </div>
        <div style={{ color: 'var(--text-primary)', marginBottom: '3px', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: '20px', fontWeight: '800', letterSpacing: '-0.3px' }}>{price}</span>
          <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)' }}>/{periodOf(kind)}</span>
        </div>
        <div style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-secondary)' }}>
          {yearly ? (
            <>
              {perMonth ? <span>{perMonth}/mo</span> : null}
              {perMonth && savePct ? ' · ' : null}
              {savePct ? <span>Save {savePct}%</span> : null}
            </>
          ) : 'Billed monthly'}
        </div>
        {trial ? <div style={{ fontSize: '11px', fontWeight: '700', color: accent, marginTop: '3px' }}>{trial}</div> : null}
      </button>
    );
  };

  const quiet = { fontSize: '13px', fontWeight: '500', color: 'var(--text-secondary)', textAlign: 'center', margin: '4px 0', lineHeight: 1.45 };
  const smallPrint = { fontSize: '11px', fontWeight: '500', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.5, margin: '10px 0 0' };
  const linkButton = { border: 'none', background: 'none', padding: 0, fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textDecoration: 'underline', cursor: 'pointer', fontFamily: FONT };
  const legalLinks = (
    <>
      <button type="button" onClick={() => window.open(TERMS_URL, '_blank', 'noopener,noreferrer')} style={linkButton}>Terms</button>
      {' '}·{' '}
      <button type="button" onClick={() => window.open(PRIVACY_URL, '_blank', 'noopener,noreferrer')} style={linkButton}>Privacy</button>
    </>
  );
  const cta = { width: '100%', padding: '15px', borderRadius: '14px', fontSize: '15px', fontWeight: '700', fontFamily: FONT };

  // The CTA says what it charges, and follows the plan selected.
  const nativePrice = selectedPkg?.product?.priceString || '';
  const nativeCta = busy
    ? (selectedTrial ? 'Starting trial…' : 'Subscribing…')
    : (selectedTrial ? `Start ${selectedTrial}` : `Get Pro, ${nativePrice}/${periodOf(selected)}`);
  const webCta = busy
    ? 'Opening checkout…'
    : (webTrialDays > 0 ? `Start ${webTrialDays}-day free trial` : `Get Pro, ${webSelected?.label || ''}/${periodOf(webSelected?.id)}`);

  return (
    <div
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 200, backgroundColor: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Flock Pro"
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'relative', width: '100%', maxWidth: '440px', backgroundColor: 'var(--bg-card-solid)', borderTopLeftRadius: '20px', borderTopRightRadius: '20px', overflow: 'hidden', boxShadow: '0 -8px 30px rgba(0,0,0,0.25)', animation: 'fadeInUp 0.25s ease-out', fontFamily: FONT }}
      >
        <div aria-hidden="true" style={{ width: '38px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-default)', margin: '10px auto 4px' }} />
        {/* A real exit, visible from the first frame. The drag handle above is
            paint: it looks like a way out and it is not focusable, not
            labelled and has no handler. This is the only control that can
            dismiss the sheet without a pointer. */}
        <button
          type="button"
          className="hit44"
          onClick={onClose}
          disabled={busy || restoring}
          aria-label="Close"
          style={{ position: 'absolute', top: '10px', right: '12px', width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '15px', border: 'none', background: 'none', color: 'var(--text-secondary)', cursor: busy || restoring ? 'default' : 'pointer', padding: 0 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <div style={{ padding: '6px 20px 20px' }}>
          <p style={{ fontSize: '12px', fontWeight: '700', color: accent, letterSpacing: '0.4px', textTransform: 'uppercase', margin: '4px 0 4px' }}>Flock Pro</p>
          <h3 style={{ fontSize: '20px', fontWeight: '800', letterSpacing: '-0.3px', color: 'var(--text-primary)', margin: subline ? '0 36px 6px 0' : '0 36px 14px 0' }}>{headline}</h3>
          {subline && (
            <p style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text-secondary)', lineHeight: 1.45, margin: '0 0 14px' }}>{subline}</p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
            {benefits.map((b) => (
              <div key={b.icon} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <BenefitIcon path={ICON_PATHS[b.icon]} color={accent} />
                <span style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)' }}>{b.label}</span>
              </div>
            ))}
          </div>

          {/* ---------------- native: App Store ---------------- */}
          {native && loadState === 'ready' && (
            <>
              <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
                {yearlyPkg && planCard({ kind: 'yearly', price: yearlyPkg.product?.priceString || '', perMonth: storePerMonthLabel(yearlyPkg.product), trial: yearlyTrial })}
                {monthlyPkg && planCard({ kind: 'monthly', price: monthlyPkg.product?.priceString || '', trial: monthlyTrial })}
              </div>
              <button className="glass-btn glass-primary" onClick={handlePurchase} disabled={busy || restoring || !selectedPkg} style={cta}>
                {nativeCta}
              </button>
              <p style={smallPrint}>
                {selectedTrial
                  ? `The ${selected} plan starts with a ${selectedTrial}, then renews at ${nativePrice} every ${periodOf(selected)} until you cancel in your App Store settings. Cancel before the trial ends and you are not charged. `
                  : `Renews at ${nativePrice} every ${periodOf(selected)} until you cancel in your App Store settings. `}
                {legalLinks}
              </p>
              <button
                type="button"
                onClick={handleRestore}
                disabled={busy || restoring}
                style={{ display: 'block', width: '100%', marginTop: '6px', padding: '8px', border: 'none', background: 'none', fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: FONT }}
              >
                {restoring ? 'Restoring…' : 'Restore purchases'}
              </button>
            </>
          )}

          {native && loadState === 'loading' && (
            <p style={quiet} role="status">Loading plans…</p>
          )}

          {/* Inside the app, with no App Store product to sell. One plain
              sentence, and no pointer anywhere else (see the header). */}
          {native && loadState === 'unavailable' && (
            <p style={quiet}>Flock Pro can't be bought in the app yet.</p>
          )}

          {/* ---------------- web: Stripe ---------------- */}
          {!native && loadState === 'web-loading' && (
            <p style={quiet} role="status">Loading plans…</p>
          )}

          {!native && loadState === 'web-ready' && (
            <>
              {webPlans.length > 1 && (
                <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
                  {webYearly && planCard({ kind: 'yearly', price: webYearly.label, perMonth: perMonthLabel(webYearly), trial: webTrialDays > 0 ? `${webTrialDays}-day free trial` : null })}
                  {webMonthly && planCard({ kind: 'monthly', price: webMonthly.label, trial: webTrialDays > 0 ? `${webTrialDays}-day free trial` : null })}
                </div>
              )}
              <button
                className="glass-btn glass-primary"
                onClick={handleWebCheckout}
                disabled={busy}
                aria-busy={busy || undefined}
                style={cta}
              >
                {webCta}
              </button>
              {actionError && <p role="alert" style={{ ...quiet, color: 'var(--accent-red-text)', marginTop: '8px' }}>{actionError}</p>}
              {/* The terms a web buyer reads before paying, in the same words
                  as /pro's "Before you pay" and Terms 10.2. */}
              <p style={smallPrint}>
                {webTrialDays > 0 ? `Free for ${webTrialDays} days, then it ` : 'It '}
                renews at {webSelected?.label}{webTax} every {periodOf(webSelected?.id)} until you cancel. Cancel any time in You, Flock Pro. Full refund within 14 days of your first payment: {CONTACT_EMAIL}. Under 18? A parent or guardian needs to buy it.{' '}
                {legalLinks}
              </p>
            </>
          )}

          {!native && loadState === 'web-off' && (
            <p style={quiet}>Flock Pro is not on sale on the web yet.</p>
          )}

          {!native && loadState === 'web-pro' && (
            <p style={quiet}>You already have Flock Pro on this account.</p>
          )}

          {!native && loadState === 'web-error' && (
            <div role="alert" style={{ textAlign: 'center' }}>
              <p style={quiet}>Could not load Flock Pro just now.</p>
              <button
                type="button"
                onClick={loadWeb}
                style={{ marginTop: '6px', padding: '8px 14px', borderRadius: '12px', border: '1px solid var(--border-subtle)', background: 'var(--bg-card-solid)', fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: FONT }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PaywallSheet;
