import React, { useState, useEffect, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { isPurchasesAvailable, getProOffering, purchase, restore } from '../services/purchases';
import { trackPaywallShown, trackPurchaseCompleted } from '../services/api';
import { yearlySavingsPercent } from '../lib/proPricing';

// Flock Pro paywall bottom sheet. Sheet mechanics mirror ModerationSheet.js
// (overlay, 440px max, 20px top radius, drag handle, fadeInUp).
//
// Props: { open, onClose, showToast, onUpgraded, trigger }
//   trigger ∈ 'birdie' | 'forecast' | 'settings' | null — picks the headline.
//
// Purchase availability (Apple 2.1): the CTA only renders when RevenueCat
// offerings actually loaded. On web we show a single quiet line pointing to the
// iOS app; on native with no offerings we say purchases are unavailable.
// Never a dead button, never an Alert, never "coming soon".
//
// Prices come from the RevenueCat offering (pkg.product.priceString) when
// available; the hardcoded strings are only the skeleton/fallback while loading.

const HEADLINES = {
  birdie: "Birdie's got more to say",
  forecast: 'See the whole night before it happens',
  settings: 'Get more out of every night out',
};

// Shown only while the offering loads. The amounts are here so the savings
// figure below can be computed for the skeleton too; once the App Store
// offering arrives, both the prices and the saving come from it instead.
const FALLBACK_PLANS = {
  yearly: { price: '$29.99/yr', amount: 29.99 },
  monthly: { price: '$3.99/mo', amount: 3.99 },
};

const TERMS_URL = 'https://www.flockcorp.com/terms';
const PRIVACY_URL = 'https://www.flockcorp.com/privacy';

const FONT = "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif";

// Minimal 18px stroke icons (in-app SVG language — no emoji as UI icons).
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
// Birdie cap: backend/services/birdieUsage.js. Forecast meter: forecastUsage.js.
// Alerts: crowdAlerts.js cron sends to Pro users when the flag is on.
// "Pro badge" was listed here once but never rendered anywhere, so it was cut.
const BENEFITS = [
  { icon: 'birdie', label: '150 Birdie messages a day, up from 10' },
  { icon: 'forecast', label: 'Unlimited crowd forecasts and best times' },
  { icon: 'alerts', label: 'A heads-up push before your spot gets packed' },
];

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

const PaywallSheet = ({ open, onClose, showToast, onUpgraded, trigger }) => {
  const { isDark } = useTheme();
  const accent = isDark ? '#6d9ac3' : '#2d5a87';

  // Monthly first: it is the smaller commitment, and the web checkout
  // (website/ProPage.js) opens on it too.
  const [selected, setSelected] = useState('monthly');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // 'loading' | 'ready' | 'web' | 'unavailable'
  const [loadState, setLoadState] = useState('loading');
  const [packages, setPackages] = useState(null);

  // One paywall_shown per opening, and what opened it (services/api.js, THE
  // PAYWALL FUNNEL). Its own effect so a change of trigger while open counts
  // as the new reason it is on screen.
  useEffect(() => {
    if (open) trackPaywallShown(trigger);
  }, [open, trigger]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSelected('monthly');
    setBusy(false);
    setRestoring(false);
    if (!isPurchasesAvailable()) {
      setLoadState('web');
      setPackages(null);
      return;
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

  const yearlyPkg = pickPackage(packages, 'yearly');
  const monthlyPkg = pickPackage(packages, 'monthly');
  const yearlyPrice = yearlyPkg?.product?.priceString ? `${yearlyPkg.product.priceString}/yr` : FALLBACK_PLANS.yearly.price;
  const monthlyPrice = monthlyPkg?.product?.priceString ? `${monthlyPkg.product.priceString}/mo` : FALLBACK_PLANS.monthly.price;
  // The saving is worked out from the two prices on screen, never typed in:
  // a typed-in percentage outlived the price pair it was true for. A store
  // package's numeric price is used when it has one; otherwise the fallback
  // pair, and only when BOTH prices on screen are fallbacks, so a real price is
  // never compared with a made-up one.
  const numericPrice = (pkg) => (typeof pkg?.product?.price === 'number' ? pkg.product.price : null);
  const bothFallback = !yearlyPkg?.product?.priceString && !monthlyPkg?.product?.priceString;
  const savePct = bothFallback
    ? yearlySavingsPercent(FALLBACK_PLANS.monthly.amount, FALLBACK_PLANS.yearly.amount)
    : yearlySavingsPercent(numericPrice(monthlyPkg), numericPrice(yearlyPkg));

  const headline = HEADLINES[trigger] || HEADLINES.settings;

  const handlePurchase = async () => {
    const pkg = selected === 'yearly' ? yearlyPkg : monthlyPkg;
    if (!pkg || busy || restoring) return;
    setBusy(true);
    try {
      const { success, isPro } = await purchase(pkg);
      if (success && isPro) {
        trackPurchaseCompleted('app_store', selected);
        showToast?.('Welcome to Flock Pro', 'success');
        onUpgraded?.();
        onClose?.();
      }
      // Cancelled / failed purchases stay quiet — the sheet remains usable.
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

  const planCard = (kind, title, price, note) => {
    const active = selected === kind;
    return (
      <button
        key={kind}
        onClick={() => setSelected(kind)}
        disabled={busy || restoring}
        style={{
          flex: 1,
          padding: '14px 12px',
          textAlign: 'left',
          borderRadius: '14px',
          border: active ? `1px solid ${accent}` : '1px solid var(--border-subtle)',
          backgroundColor: active ? (isDark ? 'rgba(109,154,195,0.10)' : 'rgba(45,90,135,0.06)') : 'var(--bg-card-solid)',
          cursor: 'pointer',
          fontFamily: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>{title}</span>
          {kind === 'yearly' && savePct && (
            <span style={{ fontSize: '10px', fontWeight: '700', color: accent, border: `1px solid ${accent}`, borderRadius: '999px', padding: '1px 7px' }}>Save {savePct}%</span>
          )}
        </div>
        <div style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '2px' }}>{price}</div>
        <div style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-secondary)' }}>{note}</div>
      </button>
    );
  };

  const ctaLabel = busy
    ? (selected === 'yearly' ? 'Starting trial…' : 'Subscribing…')
    : (selected === 'yearly' ? 'Start free trial' : 'Subscribe');

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
        {/* A real exit. The drag handle above is paint: it looks like a way out
            and it is not focusable, not labelled and has no handler. This is
            the only control that can dismiss the sheet without a pointer. */}
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
          <h3 style={{ fontSize: '20px', fontWeight: '800', letterSpacing: '-0.3px', color: 'var(--text-primary)', margin: '0 0 14px' }}>{headline}</h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
            {BENEFITS.map((b) => (
              <div key={b.icon} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <BenefitIcon path={ICON_PATHS[b.icon]} color={accent} />
                <span style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)' }}>{b.label}</span>
              </div>
            ))}
          </div>

          {(loadState === 'ready' || loadState === 'loading') && (
            <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
              {planCard('yearly', 'Yearly', yearlyPrice, '7-day free trial')}
              {planCard('monthly', 'Monthly', monthlyPrice, 'Billed monthly')}
            </div>
          )}

          {loadState === 'ready' && (
            <button
              className="glass-btn glass-primary"
              onClick={handlePurchase}
              disabled={busy || restoring}
              style={{ width: '100%', padding: '15px', borderRadius: '14px', fontSize: '15px', fontWeight: '700', fontFamily: FONT }}
            >
              {ctaLabel}
            </button>
          )}

          {loadState === 'loading' && (
            <p style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text-secondary)', textAlign: 'center', margin: '4px 0' }}>
              Loading plans…
            </p>
          )}

          {loadState === 'web' && (
            <p style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text-secondary)', textAlign: 'center', margin: '4px 0' }}>
              Flock Pro is available in the iOS app
            </p>
          )}

          {loadState === 'unavailable' && (
            <p style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text-secondary)', textAlign: 'center', margin: '4px 0' }}>
              Purchases unavailable right now
            </p>
          )}

          {loadState === 'ready' && (
            <button
              onClick={handleRestore}
              disabled={busy || restoring}
              style={{ display: 'block', width: '100%', marginTop: '10px', padding: '8px', border: 'none', background: 'none', fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: FONT }}
            >
              {restoring ? 'Restoring…' : 'Restore purchases'}
            </button>
          )}

          <p style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.5, margin: '10px 0 0' }}>
            Subscriptions auto-renew until cancelled in your App Store settings. The yearly plan starts with a 7-day free trial; cancel anytime before it ends and you won't be charged.{' '}
            <button onClick={() => window.open(TERMS_URL, '_blank', 'noopener,noreferrer')} style={{ border: 'none', background: 'none', padding: 0, fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textDecoration: 'underline', cursor: 'pointer', fontFamily: FONT }}>Terms</button>
            {' '}·{' '}
            <button onClick={() => window.open(PRIVACY_URL, '_blank', 'noopener,noreferrer')} style={{ border: 'none', background: 'none', padding: 0, fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textDecoration: 'underline', cursor: 'pointer', fontFamily: FONT }}>Privacy</button>
          </p>
        </div>
      </div>
    </div>
  );
};

export default PaywallSheet;
