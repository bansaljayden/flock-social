import React, { useState, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';
import { isPurchasesAvailable, getProOffering, purchase, restore } from '../services/purchases';

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

const FALLBACK_PLANS = {
  yearly: { price: '$24.99/yr' },
  monthly: { price: '$3.99/mo' },
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

// Every line here must name something that actually ships (SLOP-AUDIT.md C1).
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

  const [selected, setSelected] = useState('yearly');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // 'loading' | 'ready' | 'web' | 'unavailable'
  const [loadState, setLoadState] = useState('loading');
  const [packages, setPackages] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSelected('yearly');
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

  if (!open) return null;

  const yearlyPkg = pickPackage(packages, 'yearly');
  const monthlyPkg = pickPackage(packages, 'monthly');
  const yearlyPrice = yearlyPkg?.product?.priceString ? `${yearlyPkg.product.priceString}/yr` : FALLBACK_PLANS.yearly.price;
  const monthlyPrice = monthlyPkg?.product?.priceString ? `${monthlyPkg.product.priceString}/mo` : FALLBACK_PLANS.monthly.price;

  const headline = HEADLINES[trigger] || HEADLINES.settings;

  const handlePurchase = async () => {
    const pkg = selected === 'yearly' ? yearlyPkg : monthlyPkg;
    if (!pkg || busy || restoring) return;
    setBusy(true);
    try {
      const { success, isPro } = await purchase(pkg);
      if (success && isPro) {
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
          {kind === 'yearly' && (
            <span style={{ fontSize: '10px', fontWeight: '700', color: accent, border: `1px solid ${accent}`, borderRadius: '999px', padding: '1px 7px' }}>Save 48%</span>
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
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '440px', backgroundColor: 'var(--bg-card-solid)', borderTopLeftRadius: '20px', borderTopRightRadius: '20px', overflow: 'hidden', boxShadow: '0 -8px 30px rgba(0,0,0,0.25)', animation: 'fadeInUp 0.25s ease-out', fontFamily: FONT }}
      >
        <div style={{ width: '38px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-default)', margin: '10px auto 4px' }} />

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
