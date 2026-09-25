/**
 * ADMIN COSTS AND REVENUE CONSOLE
 *
 * This screen was 1,387 lines of `App.js`, declared as an arrow function
 * inside `FlockAppInner` and mounted as an element rather than called. It is
 * the founder-facing admin console: four tabs, Overview (the money hub, which
 * it opens on), Costs, Projections (with the what-if simulator that used to be
 * the Revenue tab) and Research, behind `authUser.role === 'admin'` and
 * reachable by nobody else. The admin routes enforce that on the server.
 * It is the largest single-screen block that was still bundled into the boot
 * chunk for every teenager who opened Flock to vote on a bar, and none of them
 * can reach it.
 *
 * WHY THIS ONE IS LAZY
 *
 * The far end of the same scale the flock chat screen sits at the near end of.
 * Chat is the screen the product exists to show, every user opens it, so it is
 * a static import and pays for itself in the boot chunk. This console is the
 * opposite: it is admin only, it is opened by one account, and almost nobody
 * loads it. So it is `React.lazy` from `App.js`, its own chunk fetched the
 * first time an admin opens it and costs nothing at all to everyone else, the
 * same call the venue owner dashboard already made and for the same reason.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 27 names in `FlockAppInner`: the six
 * revenue-simulator fields and their setters, the research and costs state and
 * their loaders, `switchMode`, and `colors` and `styles`. A context would have
 * had to enumerate exactly the same 27 names into a provider value, so it buys
 * nothing here and hides the dependency surface behind a hook. They are
 * parameters instead, so this file's entire dependency surface is its
 * parameter list plus its imports, and a name this component reads and does not
 * receive is an undefined identifier that `no-undef` fails the build on, rather
 * than a prop that is silently `undefined` at runtime and renders as nothing.
 * The twelve module-level names it also read are all imports (the finance math,
 * the birds and the icon set), so they are imported here directly rather than
 * threaded through the props object.
 *
 * The 27 names were not read off the page. They came from a Babel scope walk of
 * the block, every `ReferencedIdentifier` whose binding resolves outside it,
 * and the parameter list below and the props object at the call site were both
 * generated from that one array, so they cannot drift apart.
 *
 * The state behind these props deliberately did NOT move. It lives in
 * `FlockAppInner`, which does not unmount when the admin leaves the console, so
 * the six simulator fields, the research pull and the costs pull survive a trip
 * to another screen exactly as they did before. It was hoisted up there in the
 * first place because this screen used to remount on every unrelated render;
 * moving to module scope fixes the remount, and keeping the state in
 * `FlockAppInner` is now the same choice the other extracted screens made.
 *
 * The body below is the old block verbatim, including its original four-space
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed, reformatted or improved on the way across.
 */
import React from 'react';
import { BirdieStill, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';
import {
  calculateAnnualRevenue,
  calculateBreakEven,
  calculateMonthlyProfit,
  calculateProfitMargin,
  calculateRevenuePerVenue,
  calculateSubscriptionRevenue,
  calculateTotalMonthlyRevenue,
  calculateTransactionRevenue,
  formatCurrency,
} from '../lib/finance';
import { saveAdminReconciled } from '../services/api';
import {
  createAdminExpense,
  deleteAdminExpense,
  getAdminMoneyHub,
  importAdminExpenses,
  updateAdminExpense,
} from '../services/api';

// One reconciled line's save form. Amount and date only; the note is optional
// and short. Saving posts through the admin route and then the parent refetches
// the whole costs payload, so what the card shows afterwards is what the server
// merged, never what this form thinks it sent.
// The device's own date, not the UTC date: after 8 PM Eastern the UTC day has
// already rolled, and the picker offered, and defaulted to, tomorrow.
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function ReconciledLineForm({ line, onSaved, colors }) {
  const [usd, setUsd] = React.useState(Number.isFinite(line.usdPerMonth) ? String(line.usdPerMonth) : '');
  const [asOf, setAsOf] = React.useState(localToday());
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await saveAdminReconciled({ id: line.id, usdPerMonth: Number(usd), asOf });
      if (onSaved) onSaved();
    } catch (e) {
      setErr((e && e.message) || 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const small = { fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' };
  const input = { padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', minWidth: 0 };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 0' }}>
      <span style={small}>{line.label} <span style={{ color: 'var(--text-tertiary)' }}>({line.source === 'dashboard' ? `saved ${line.asOf}` : 'from code, never recorded here'})</span></span>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ ...small, display: 'flex', alignItems: 'center', gap: '6px' }}>
          $
          <input aria-label={`Paid amount for ${line.label}`} type="number" min="0" step="0.01" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} style={{ ...input, width: '110px' }} />
        </label>
        <input aria-label={`Invoice date for ${line.label}`} type="date" value={asOf} max={localToday()} onChange={(e) => setAsOf(e.target.value)} style={input} />
        <button className="hit44" type="button" disabled={busy || usd === ''} onClick={save} style={{ padding: '8px 14px', borderRadius: '8px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: busy ? 'default' : 'pointer' }}>{busy ? 'Saving' : 'Save'}</button>
      </div>
      {err && <span style={{ ...small, color: 'var(--accent-red-text, #EF4444)' }}>{err}</span>}
    </div>
  );
}

// ===========================================================================
// THE MONEY HUB: the Overview tab, and the tab the console opens on.
// ===========================================================================
//
// Every figure comes from GET /api/admin/money (backend/services/moneyHub.js),
// which reads Stripe, RevenueCat, the cost model, the expense list and the
// collector's own rows. Nothing here does arithmetic beyond formatting, for
// the reason the Costs tab gives: the sums belong next to the sources they
// read, where they cannot drift from them.
//
// A source that did not answer shows the server's words for why, and no
// number. A zero appears only when a source answered with zero.

// The last good payload, kept across a trip to another tab or screen so the
// hub paints at once on return while it reads again. The server holds the
// vendor answers for a few minutes, so reading again costs Stripe nothing.
const hubMemo = { data: null };

const HUB_KIND_LABEL = {
  infrastructure: 'Running the app',
  tooling: 'Building it',
  legal: 'Legal and company',
  other: 'Other',
};
const HUB_CADENCE_LABEL = { monthly: 'a month', yearly: 'a year', usage: 'a month, usage', one_time: 'once' };
const HUB_PLAN_LABEL = { monthly: 'monthly', yearly: 'yearly', founding: 'founding rate', other: 'other plans' };
const HUB_STORE_LABEL = {
  app_store: 'App Store',
  promotional: 'Promotional grants',
  play_store: 'Google Play',
  rc_billing: 'RevenueCat web billing',
  other: 'Other stores',
};

const hubStyle = {
  card: { backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)', minWidth: 0 },
  sub: { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.4 },
  kicker: { fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '14px 0 4px', textTransform: 'uppercase', letterSpacing: '0.5px' },
  big: { fontSize: 'var(--t-display)', fontWeight: '600', margin: '2px 0 0', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
  note: { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.35, overflowWrap: 'anywhere' },
  foot: { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.4, overflowWrap: 'anywhere' },
  input: { padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', minWidth: 0, width: '100%', boxSizing: 'border-box' },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: 'var(--t-micro)', fontWeight: '600', color: 'var(--text-secondary)', flex: '1 1 130px', minWidth: 0 },
  textButton: { border: 'none', background: 'transparent', padding: '4px 0', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)', cursor: 'pointer' },
};

const HUB_TONE = {
  good: 'var(--accent-green-text)',
  bad: 'var(--accent-red-text)',
  warn: 'var(--accent-amber-text)',
  muted: 'var(--text-tertiary)',
};

function hubTag(tone) {
  const bg = tone === 'bad' ? 'var(--accent-red-bg)' : tone === 'good' ? 'var(--accent-green-bg)' : tone === 'warn' ? 'var(--accent-amber-bg)' : 'var(--bg-tertiary)';
  return {
    fontSize: 'var(--t-micro)',
    fontWeight: '700',
    color: HUB_TONE[tone] || 'var(--text-secondary)',
    backgroundColor: bg,
    borderRadius: '6px',
    padding: '1px 5px',
    marginLeft: '6px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    whiteSpace: 'nowrap',
  };
}

// Cents to dollars, or null when there is no number to print. The minus sign
// is the typographic one, so a loss lines up with a gain in a column.
function hubMoney(cents, { sign = false } = {}) {
  if (!Number.isFinite(cents)) return null;
  const text = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (cents < 0) return `−$${text}`;
  return `${sign && cents > 0 ? '+' : ''}$${text}`;
}

const hubCount = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : null);
const hubPlural = (n, one, many) => `${hubCount(n)} ${n === 1 ? one : many}`;
const hubTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null);

// A YYYY-MM-DD date read as that calendar day wherever the browser is.
function hubDay(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('en-US', opts);
}

function HubRow({ label, value, note, tone, tag, navy }) {
  return (
    <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-light)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
        <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', minWidth: 0, overflowWrap: 'anywhere' }}>
          {label}
          {tag && <span style={hubTag(tag.tone)}>{tag.text}</span>}
        </span>
        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: HUB_TONE[tone] || navy, whiteSpace: 'nowrap', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </div>
      {note && <p style={hubStyle.note}>{note}</p>}
    </div>
  );
}

// The words for a source that gave no numbers. `not_connected` means nothing
// was asked because the key is not set; anything else means it was asked.
function HubNotice({ status, reason }) {
  const word = status === 'not_connected' ? 'Not connected' : status === 'refused' ? 'Key cannot read this' : 'Could not load';
  return (
    <p style={{ ...hubStyle.note, margin: '4px 0 2px' }}>
      <span style={{ ...hubTag('warn'), marginLeft: 0, marginRight: '6px' }}>{word}</span>
      {reason || 'No reason was given.'}
    </p>
  );
}

function hubPlanRows(summary, prefix, navy) {
  const rows = [];
  for (const plan of ['monthly', 'yearly', 'founding', 'other']) {
    const p = summary.byPlan && summary.byPlan[plan];
    if (!p || (p.live === 0 && p.trialing === 0 && plan !== 'monthly' && plan !== 'yearly')) continue;
    rows.push(
      <HubRow
        key={`${prefix}-${plan}`}
        navy={navy}
        label={`${prefix}, ${HUB_PLAN_LABEL[plan]}`}
        value={`${hubCount(p.live)} active`}
        note={p.trialing > 0 ? `${hubPlural(p.trialing, 'more on a trial', 'more on trials')}, not yet paying.` : null}
      />
    );
  }
  return rows;
}

// WHY A FIGURE IS EMPTY, in the codes backend/services/moneyHub.js buildNet
// sends. A figure missing a source arrives null rather than smaller, and the
// screen says which source it is waiting for.
const HUB_GAP_SOURCE = {
  stripe: 'Stripe',
  stripe_partial: 'a full Stripe read',
  stripe_unpriced: 'a price for every Stripe subscription',
  app_store: 'RevenueCat',
  app_store_partial: 'every Pro account in RevenueCat',
  app_store_unpriced: 'a price for every App Store subscription',
  expenses: 'the expense list',
};
const HUB_GAP_WORDS = {
  stripe: 'Stripe was not read',
  stripe_partial: 'Stripe had more entries this month than the hub reads, and a missing page could move a total either way',
  stripe_unpriced: 'some live Stripe subscriptions carry a price or a discount this read could not work out in dollars',
  app_store: 'the App Store is not in it, because RevenueCat was not read',
  app_store_partial: 'the App Store is not in it, because RevenueCat answered for only some Pro accounts',
  app_store_unpriced: 'the App Store is not in it, because some live App Store subscriptions carry no dollar price in RevenueCat',
  expenses: 'the expense list could not be read',
};
// The gaps that are the App Store's alone. This month's revenue and the net
// carry Stripe without it and say so; they never wait on one of these.
const HUB_APP_STORE_GAPS = ['app_store', 'app_store_partial', 'app_store_unpriced'];
const hubGaps = (list) => (Array.isArray(list) ? list : []);
const hubNeeds = (gaps) => `Needs ${[...new Set(gaps.map((g) => HUB_GAP_SOURCE[g] || g))].join(' and ')}`;
function hubGapSentence(gaps) {
  if (gaps.length === 0) return '';
  const text = gaps.map((g) => HUB_GAP_WORDS[g] || g).join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function HubSummary({ h, colors, loading, onRefresh }) {
  const n = h.net || {};
  const m = h.month || {};
  const be = n.breakEven || {};
  const stripe = (h.revenue && h.revenue.stripe) || {};
  const navy = colors.navy;
  const revenueMissing = hubGaps(n.revenueMissing);
  const costsMissing = hubGaps(n.costsMissing);
  const netMissing = hubGaps(n.netMissing);
  const netBurnMissing = hubGaps(n.netBurnMissing);
  const burnMissing = hubGaps(be.burnMissing);
  const revenueWithheld = revenueMissing.includes('stripe_partial');
  const appGap = revenueMissing.find((g) => HUB_APP_STORE_GAPS.includes(g));
  let revenueNote;
  if (n.revenueThisMonthCents === null || n.revenueThisMonthCents === undefined) {
    revenueNote = revenueWithheld
      ? 'Stripe had more balance entries this month than the hub reads. A missing page could move the total either way, so it is withheld rather than shown short.'
      : stripe.status === 'not_connected' ? 'Stripe is not connected, so there is no revenue figure to show.' : 'Stripe could not be read, so there is no revenue figure to show.';
  } else if (appGap) {
    revenueNote = `Stripe, after refunds, disputes and fees. ${hubGapSentence([appGap])}`;
  } else {
    // The App Store part is read from the accounts that are Pro now, which is
    // not every App Store sale this month (backend/services/moneyHub.js,
    // WHERE THE APP STORE FIGURES COME FROM), so it is never shown as that.
    revenueNote = `Stripe after refunds, disputes and fees, plus App Store charges after Apple's ${n.appleCommissionPct}%.${n.appStoreFrom === 'current_pro_accounts' ? ' The App Store part counts current Pro accounts only: a subscriber who deleted their account is not in it.' : ''}`;
  }
  const net = n.netThisMonthCents;
  const netBurn = n.netBurnCents;
  // A figure that is null is waiting for a source; the App Store alone never
  // empties the net, which carries Stripe and says so.
  const netNeeds = hubNeeds(netMissing.filter((g) => !HUB_APP_STORE_GAPS.includes(g)));
  const needed = (b) => (b && Number.isFinite(b.needed) ? hubCount(b.needed) : 'Not reachable');
  const priceWords = (b) => (b ? `${hubMoney(b.priceCents)} a month, ${b.source === 'stripe' ? 'the price Stripe charges' : 'the price the code states, because Stripe was not read'}` : 'no price');
  const payingWords = (count, missing) => (Number.isFinite(count)
    ? hubCount(count)
    : `not known, waiting on ${[...new Set(hubGaps(missing).map((g) => HUB_GAP_SOURCE[g] || g))].join(' and ') || 'a read'}`);
  const cachedAge = stripe.cached && Number.isFinite(stripe.cachedAgeSeconds) ? stripe.cachedAgeSeconds : null;
  return (
    <div style={hubStyle.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 2px' }}>{m.label || 'This month'}</h3>
          <p style={hubStyle.sub}>Day {m.dayOfMonth} of {m.daysInMonth}, New York time. Each figure says where it came from.</p>
        </div>
        <button className="hit44" type="button" disabled={loading} onClick={onRefresh} style={{ ...hubStyle.textButton, cursor: loading ? 'default' : 'pointer', flexShrink: 0 }}>
          {loading ? 'Reading' : 'Refresh'}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ ...hubStyle.kicker, margin: 0 }}>Revenue this month</p>
          <p style={{ ...hubStyle.big, color: navy }}>{hubMoney(n.revenueThisMonthCents) || (revenueWithheld ? 'Withheld' : 'Not read')}</p>
          <p style={hubStyle.note}>{revenueNote}</p>
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ ...hubStyle.kicker, margin: 0 }}>Costs this month</p>
          <p style={{ ...hubStyle.big, color: navy }}>{hubMoney(n.costsThisMonthCents) || 'Not read'}</p>
          <p style={hubStyle.note}>
            {costsMissing.length > 0
              ? 'The expense list could not be read, so costs are not totalled here. The Costs card below shows what could be read.'
              : 'Monthly bills in full, yearly bills at a twelfth, and one-time charges dated this month.'}
          </p>
        </div>
      </div>
      <div style={{ marginTop: '10px' }}>
        <HubRow
          navy={navy}
          label="Net this month"
          value={Number.isFinite(net) ? hubMoney(net, { sign: true }) : netNeeds}
          tone={Number.isFinite(net) ? (net < 0 ? 'bad' : 'good') : 'muted'}
          note={`Revenue this month less costs this month.${netMissing.length > 0 ? ` ${hubGapSentence(netMissing)}` : ''}`}
        />
        <HubRow
          navy={navy}
          label="Burn a month"
          value={hubMoney(n.burnCents) || 'Not read'}
          note={costsMissing.length > 0
            ? 'Not totalled, because the expense list could not be read.'
            : 'Every recurring cost at its monthly rate. One-time charges are left out.'}
        />
        <HubRow
          navy={navy}
          label="Burn after recurring revenue"
          value={Number.isFinite(netBurn) ? hubMoney(netBurn) : hubNeeds(netBurnMissing)}
          tone={Number.isFinite(netBurn) && netBurn <= 0 ? 'good' : undefined}
          note={Number.isFinite(netBurn)
            ? (netBurn <= 0
              ? 'Subscribers already pay for the monthly costs, after Stripe fees and Apple’s cut.'
              : 'The burn less what subscribers pay each month, after Stripe fees and Apple’s cut.')
            : `The burn less what subscribers pay each month. ${hubGapSentence(netBurnMissing)}`}
        />
        <HubRow
          navy={navy}
          label="Break-even, Flock Pro"
          value={burnMissing.length > 0 ? 'Not read' : `${needed(be.proWeb)} web, ${needed(be.proAppStore)} App Store`}
          note={`Subscribers needed to cover the burn on their own, at ${priceWords(be.proWeb)}. After Stripe fees on the web, after Apple's ${n.appleCommissionPct}% in the App Store.${burnMissing.length > 0 ? ` ${hubGapSentence(burnMissing)}` : ''} Paying now: ${payingWords(be.payingPro, be.payingProMissing)}.`}
        />
        <HubRow
          navy={navy}
          label="Break-even, Roost"
          value={burnMissing.length > 0 ? 'Not read' : `${needed(be.roost)} venues`}
          note={`At ${priceWords(be.roost)}, after Stripe fees. Paying now: ${payingWords(be.payingRoost, be.payingRoostMissing)}.`}
        />
      </div>
      <p style={hubStyle.foot}>
        Read at {hubTime(h.generatedAt)}. Stripe and RevenueCat answers are held for {Math.round(((h.cache && h.cache.ttlSeconds) || 300) / 60)} minutes{cachedAge !== null ? `, and this one is ${cachedAge} seconds old` : ''}.
      </p>
    </div>
  );
}

function HubRevenue({ h, colors }) {
  const r = h.revenue || {};
  const s = r.stripe || {};
  const rc = r.revenuecat || {};
  const db = r.database || {};
  const flags = r.flags || {};
  const navy = colors.navy;
  const onOff = (v) => (v ? 'on' : 'off');
  const subs = s.subscriptions || null;
  const bal = s.balance || null;
  const inv = s.invoices || null;
  const rcSubs = rc.subscribers || null;
  const overview = rc.overview || null;
  const stripeReady = s.status === 'ok';

  const recurringRows = (summary, prefix) => (
    <HubRow
      navy={navy}
      label={`${prefix} recurring revenue`}
      value={`${hubMoney(summary.mrrCents)} a month`}
      note={`${hubMoney(summary.mrrCents * 12)} a year as annual recurring revenue. ${hubMoney(summary.mrrNetCents)} a month after Stripe fees.`}
    />
  );

  const metricValue = (mt) => {
    if (!Number.isFinite(mt.value)) return 'No value';
    if (mt.unit === '$') return `$${mt.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return mt.value.toLocaleString('en-US');
  };
  const periodWords = (p) => (p === 'P0D' || !p ? 'now' : p === 'P28D' ? 'the last 28 days' : p);

  return (
    <div style={hubStyle.card}>
      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 2px' }}>Revenue</h3>
      <p style={hubStyle.sub}>
        flockcorp.com sells through Stripe; the iOS app sells through the App Store, which RevenueCat reads. Paywall {onOff(flags.paywallEnabled)}, web checkout {onOff(flags.proWebCheckoutEnabled)}, venue billing {onOff(flags.venueBillingEnabled)}.
      </p>
      {stripeReady && s.mode === 'test' && (
        <p style={hubStyle.note}><span style={{ ...hubTag('warn'), marginLeft: 0, marginRight: '6px' }}>Test mode</span>The Stripe key is a test key, so every Stripe figure below is test money.</p>
      )}

      <p style={hubStyle.kicker}>Flock Pro on the web</p>
      {!stripeReady && <HubNotice status={s.status} reason={s.reason} />}
      {stripeReady && subs && subs.status !== 'ok' && <HubNotice status="error" reason={subs.reason} />}
      {stripeReady && subs && subs.status === 'ok' && (
        <>
          {hubPlanRows(subs.pro, 'Web', navy)}
          <HubRow navy={navy} label="On a free code" value={hubCount(subs.pro.freeViaCode)} note="Active at 100% off, so counted as subscribers and not as revenue." />
          {subs.pro.pastDue > 0 && <HubRow navy={navy} tone="warn" label="Past due" value={hubCount(subs.pro.pastDue)} note="A renewal failed and Stripe is retrying. Still counted as active." />}
          {subs.pro.endingAtPeriodEnd > 0 && <HubRow navy={navy} label="Set to end" value={hubCount(subs.pro.endingAtPeriodEnd)} note="Cancelled, running to the end of the paid period." />}
          {subs.pro.notPriced > 0 && <HubRow navy={navy} tone="warn" label="Not priced" value={hubCount(subs.pro.notPriced)} note="A discount or price this read could not work out, so these are left out of the recurring revenue." />}
          {recurringRows(subs.pro, 'Web')}
          {subs.truncated && <p style={hubStyle.foot}>Stripe had more subscriptions than this read pages through, so these counts are a floor.</p>}
        </>
      )}

      <p style={hubStyle.kicker}>Flock Pro in the App Store</p>
      {rc.status !== 'ok' && <HubNotice status={rc.status} reason={rc.reason} />}
      {rc.status === 'ok' && rcSubs && rcSubs.status !== 'ok' && <HubNotice status="error" reason={rcSubs.reason} />}
      {rc.status === 'ok' && rcSubs && rcSubs.status === 'ok' && (() => {
        const stores = rcSubs.stores || {};
        const app = stores.app_store || { live: 0, trialing: 0, mrrCents: 0, monthChargedCents: 0, unpriced: 0, unpricedThisMonth: 0, byPlan: { monthly: { live: 0, trialing: 0 }, yearly: { live: 0, trialing: 0 } } };
        const sentences = (...parts) => parts.filter(Boolean).join(' ');
        const currentOnly = (h.net || {}).appStoreFrom === 'current_pro_accounts'
          && 'Counted from current Pro accounts only: a subscriber who deleted their account is not in it.';
        return (
          <>
            {hubPlanRows(app, 'App Store', navy)}
            <HubRow
              navy={navy}
              label="App Store recurring revenue"
              value={`${hubMoney(app.mrrCents)} a month`}
              note={sentences(
                "Before Apple's cut.",
                app.unpriced > 0 && `${hubPlural(app.unpriced, 'subscription carries', 'subscriptions carry')} no dollar price in RevenueCat and ${app.unpriced === 1 ? 'is' : 'are'} left out, so the recurring total at the top waits for ${app.unpriced === 1 ? 'it' : 'them'}.`,
                currentOnly
              )}
            />
            <HubRow
              navy={navy}
              label="App Store charged this month"
              value={hubMoney(app.monthChargedCents)}
              note={sentences(
                "Latest purchase or renewal dated this month, before Apple's cut.",
                app.unpricedThisMonth > 0 && `${hubPlural(app.unpricedThisMonth, 'of these charges has', 'of these charges have')} no dollar price in RevenueCat, so the revenue at the top leaves the App Store out.`,
                currentOnly
              )}
            />
            {Object.keys(stores).filter((k) => k !== 'app_store' && k !== 'stripe').map((k) => (
              <HubRow key={`store-${k}`} navy={navy} label={HUB_STORE_LABEL[k] || k} value={hubCount(stores[k].live)} note={k === 'promotional' ? 'Granted by hand in RevenueCat. Nobody pays for these.' : null} />
            ))}
            {rcSubs.sandbox > 0 && <HubRow navy={navy} label="Sandbox" value={hubCount(rcSubs.sandbox)} note="Test purchases by allowed accounts. No money moves." />}
            {rcSubs.premiumWithNothingLive > 0 && (
              <HubRow navy={navy} tone="warn" label="Pro with nothing live" value={hubCount(rcSubs.premiumWithNothingLive)} note="Pro in the database, and RevenueCat shows no live subscription for them. The next webhook or sync should switch them off." />
            )}
            <p style={hubStyle.foot}>
              Read from each Pro account's own record in RevenueCat: {hubCount(rcSubs.checked)} of {hubCount(db.proAccountsCheckedWithRevenueCat)} checked{rcSubs.failed > 0 ? `, ${hubCount(rcSubs.failed)} could not be read` : ''}.
              {Number.isFinite(db.proAccounts) && db.proAccounts > db.proAccountsCheckedWithRevenueCat ? ` Only the first ${hubCount(db.proAccountsCheckedWithRevenueCat)} of ${hubCount(db.proAccounts)} Pro accounts are checked.` : ''}
              {rcSubs.complete === false ? ' These App Store figures are incomplete, so the totals at the top leave the App Store out rather than add a part of it.' : ''}
            </p>
          </>
        );
      })()}

      <p style={hubStyle.kicker}>RevenueCat, every store</p>
      {rc.status !== 'ok' && <HubNotice status={rc.status} reason={rc.reason} />}
      {rc.status === 'ok' && overview && overview.status !== 'ok' && <HubNotice status={overview.status} reason={overview.reason} />}
      {rc.status === 'ok' && overview && overview.status === 'ok' && (
        <>
          {(overview.metrics || []).map((mt) => (
            <HubRow key={`rc-${mt.id}`} navy={navy} label={mt.name} value={metricValue(mt)} note={`RevenueCat's own figure, ${periodWords(mt.period)}.`} />
          ))}
          {Number.isFinite(overview.monthRevenueUsd) && (
            <HubRow navy={navy} label="Revenue this month, every store" value={`$${overview.monthRevenueUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} note="RevenueCat's figure before store fees. It includes web sales, so it is a cross-check and is not added to anything." />
          )}
        </>
      )}
      <HubRow
        navy={navy}
        label="Pro accounts in Flock"
        value={Number.isFinite(db.proAccounts) ? hubCount(db.proAccounts) : 'Not read'}
        note={`users.is_premium, which only RevenueCat writes.${Number.isFinite(db.proAccountsWithWebSubscription) ? ` ${hubCount(db.proAccountsWithWebSubscription)} of them hold a web subscription.` : ''}`}
      />

      <p style={hubStyle.kicker}>Roost</p>
      {!stripeReady && <HubNotice status={s.status} reason={s.reason} />}
      {stripeReady && subs && subs.status === 'ok' && (
        <>
          {!flags.venueBillingEnabled && <p style={{ ...hubStyle.note, margin: '0 0 4px' }}>Venue billing is off (VENUE_BILLING_ENABLED), so no venue can buy Roost yet and a zero here is the expected reading.</p>}
          {hubPlanRows(subs.roost, 'Roost', navy)}
          {subs.roost.freeViaCode > 0 && <HubRow navy={navy} label="On a free code" value={hubCount(subs.roost.freeViaCode)} />}
          {subs.roost.pastDue > 0 && <HubRow navy={navy} tone="warn" label="Past due" value={hubCount(subs.roost.pastDue)} />}
          {subs.roost.notPriced > 0 && <HubRow navy={navy} tone="warn" label="Not priced" value={hubCount(subs.roost.notPriced)} note="A discount or price this read could not work out, so these are left out of the recurring revenue." />}
          {recurringRows(subs.roost, 'Roost')}
        </>
      )}
      <HubRow navy={navy} label="Paying venues in Flock" value={Number.isFinite(db.payingVenues) ? hubCount(db.payingVenues) : 'Not read'} note="venue_subscriptions granted as paid and still running." />

      <p style={hubStyle.kicker}>Collected this month, whole Stripe account</p>
      {!stripeReady && <HubNotice status={s.status} reason={s.reason} />}
      {stripeReady && bal && bal.status !== 'ok' && <HubNotice status="error" reason={bal.reason} />}
      {stripeReady && bal && bal.status === 'ok' && (
        <>
          <HubRow navy={navy} label="Charges" value={hubMoney(bal.grossCents)} note={`${hubPlural(bal.charges, 'charge', 'charges')}.`} />
          <HubRow navy={navy} label="Refunds" value={hubMoney(bal.refundsCents)} />
          <HubRow navy={navy} label="Disputes" value={hubMoney(bal.disputesCents)} tone={bal.disputesCents < 0 ? 'bad' : undefined} />
          <HubRow navy={navy} label="Stripe fees" value={hubMoney(-bal.feesCents)} note="Card fees, dispute fees, and Billing or Tax fees Stripe charges on their own." />
          {bal.otherCents !== 0 && (
            <HubRow navy={navy} label="Other balance moves" value={hubMoney(bal.otherCents)} note={`Stripe reported: ${(bal.otherCategories || []).map((c) => `${c.category} (${c.count})`).join(', ')}.`} />
          )}
          <HubRow navy={navy} label="Net" value={hubMoney(bal.netCents)} tone={bal.netCents < 0 ? 'bad' : undefined} note="Payouts to the bank are movement, not revenue, and are left out." />
          {bal.truncated && <p style={{ ...hubStyle.foot, color: 'var(--accent-amber-text)' }}>Stripe had more balance entries this month than this read pages through, so these figures are incomplete, and with refunds and disputes in them they could be off in either direction. The revenue at the top is withheld for the same reason.</p>}
          {bal.nonUsd > 0 && <p style={hubStyle.foot}>{hubPlural(bal.nonUsd, 'entry was', 'entries were')} not in US dollars and {bal.nonUsd === 1 ? 'is' : 'are'} not added.</p>}
        </>
      )}
      {stripeReady && inv && inv.status === 'ok' && (
        <>
          <HubRow navy={navy} label="Paid invoices, Flock Pro" value={hubMoney(inv.byProduct.pro.paidCents)} note={`${hubPlural(inv.byProduct.pro.invoices, 'invoice', 'invoices')}${inv.byProduct.pro.zeroInvoices > 0 ? `, ${hubCount(inv.byProduct.pro.zeroInvoices)} of them at $0 through a code` : ''}.`} />
          <HubRow navy={navy} label="Paid invoices, Roost" value={hubMoney(inv.byProduct.roost.paidCents)} note={`${hubPlural(inv.byProduct.roost.invoices, 'invoice', 'invoices')}.`} />
          {inv.byProduct.other.invoices > 0 && <HubRow navy={navy} label="Paid invoices, other" value={hubMoney(inv.byProduct.other.paidCents)} note="Invoices that name neither product, such as one made by hand in Stripe." />}
          <p style={hubStyle.foot}>
            Paid this month, from invoices created {Number.isFinite(inv.lookbackDays) ? `up to ${hubCount(inv.lookbackDays)} days before the month began` : 'shortly before the month began'}: Stripe&apos;s list filters on the day an invoice was made, not the day it was paid, and a failed renewal is retried for at most two months. An older invoice marked paid by hand this month would be missed.
            {inv.truncated ? ' There were more paid invoices than this read pages through, so these sums are a floor.' : ''}
          </p>
        </>
      )}
      {stripeReady && s.disputes && s.disputes.status === 'ok' && (s.disputes.open > 0 || s.disputes.openOtherCurrency > 0 || s.disputes.truncated) && (
        <HubRow
          navy={navy}
          tone={s.disputes.open > 0 || s.disputes.openOtherCurrency > 0 ? 'bad' : undefined}
          label="Open disputes"
          value={hubCount(s.disputes.open + (s.disputes.openOtherCurrency || 0))}
          note={`${hubMoney(s.disputes.openAmountCents)} at stake in dollars.${s.disputes.openOtherCurrency > 0 ? ` ${hubPlural(s.disputes.openOtherCurrency, 'more is', 'more are')} in another currency and not added.` : ''}${s.disputes.truncated ? ' There were more disputes than this read pages through, so there may be more.' : ''} Answer them in the Stripe dashboard before the deadline.`}
        />
      )}

      <p style={hubStyle.kicker}>Promotion codes</p>
      {!stripeReady && <HubNotice status={s.status} reason={s.reason} />}
      {stripeReady && s.promotionCodes && s.promotionCodes.status !== 'ok' && <HubNotice status="error" reason={s.promotionCodes.reason} />}
      {stripeReady && s.promotionCodes && s.promotionCodes.status === 'ok' && (
        (s.promotionCodes.codes || []).length === 0
          ? <p style={hubStyle.note}>No promotion codes exist in Stripe.</p>
          : s.promotionCodes.codes.map((pc) => {
            const c = pc.coupon;
            const off = c ? (Number.isFinite(c.percentOff) ? `${c.percentOff}% off` : Number.isFinite(c.amountOffCents) ? `${hubMoney(c.amountOffCents)} off` : 'a discount') : 'a discount';
            const how = c && c.duration ? (c.duration === 'repeating' && c.durationInMonths ? `for ${c.durationInMonths} months` : c.duration === 'forever' ? 'for as long as they subscribe' : 'on the first payment') : '';
            return (
              <HubRow
                key={`code-${pc.code}`}
                navy={navy}
                label={pc.code}
                tag={pc.active ? null : { tone: 'muted', text: 'Inactive' }}
                value={`${hubCount(pc.timesRedeemed) || '0'} used`}
                note={`${off} ${how}.${Number.isFinite(pc.maxRedemptions) ? ` Limit ${hubCount(pc.maxRedemptions)}.` : ''}${pc.expiresAt ? ` Expires ${new Date(pc.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.` : ''}`}
              />
            );
          })
      )}
      {stripeReady && <p style={hubStyle.foot}>Stripe read at {hubTime(s.asOf)}{s.mode === 'live' ? ', live mode' : ''}.</p>}
    </div>
  );
}

function HubCosts({ h, colors }) {
  const c = h.costs || {};
  const navy = colors.navy;
  const grid = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', columnGap: '12px', alignItems: 'baseline' };
  const head = { fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', textAlign: 'right', paddingBottom: '4px' };
  const cell = { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', padding: '5px 0', borderTop: '1px solid var(--border-light)', minWidth: 0, overflowWrap: 'anywhere' };
  const num = { ...cell, textAlign: 'right', fontWeight: '600', color: navy, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  const totals = c.totals || {};
  const table = (rows, keyOf, labelOf) => (
    <div style={grid}>
      <span />
      <span style={head}>This month</span>
      <span style={head}>A month</span>
      {rows.map((row) => (
        <React.Fragment key={keyOf(row)}>
          <span style={cell}>{labelOf(row)}</span>
          <span style={num}>{hubMoney(row.thisMonthCents)}</span>
          <span style={num}>{hubMoney(row.perMonthCents)}</span>
        </React.Fragment>
      ))}
      <span style={{ ...cell, fontWeight: '700', color: navy, borderTop: '1px solid var(--border-default)' }}>Total</span>
      <span style={{ ...num, borderTop: '1px solid var(--border-default)' }}>{hubMoney(totals.thisMonthCents)}</span>
      <span style={{ ...num, borderTop: '1px solid var(--border-default)' }}>{hubMoney(totals.perMonthCents)}</span>
    </div>
  );
  const upcoming = c.upcoming || [];
  return (
    <div style={hubStyle.card}>
      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 2px' }}>Costs</h3>
      <p style={hubStyle.sub}>
        The infrastructure bills in backend/services/costModel.js, the reconciled Google invoice, and the expense list below, each bill counted once. The Costs tab has the meters behind them.
      </p>
      {c.status === 'error' && <HubNotice status="error" reason={c.reason} />}
      <p style={{ ...hubStyle.kicker, marginTop: '4px' }}>By kind</p>
      {table(c.byKind || [], (k) => k.kind, (k) => k.label || HUB_KIND_LABEL[k.kind] || k.kind)}
      <p style={hubStyle.kicker}>By category</p>
      {table(c.byCategory || [], (k) => `cat-${k.category}`, (k) => k.category)}

      <p style={hubStyle.kicker}>Renewals in the next {c.upcomingWindowDays || 60} days</p>
      {upcoming.length === 0 ? (
        <p style={hubStyle.note}>None dated. A bill on the expense list shows here once it has a renewal or last-charge date; the code's lines carry no dates.</p>
      ) : upcoming.map((u) => (
        <HubRow
          key={`renew-${u.expenseId}-${u.on}`}
          navy={navy}
          label={`${hubDay(u.on)}, ${u.label}`}
          value={u.currency === 'USD' ? hubMoney(u.amountCents) : `${(u.amountCents / 100).toFixed(2)} ${u.currency}`}
          note={u.estimated ? 'Worked out from the last charge date.' : null}
        />
      ))}

      {(c.replaced || []).length > 0 && (
        <p style={hubStyle.foot}>Counted from the expense list instead of the code: {c.replaced.map((x) => x.label).join(', ')}.</p>
      )}
      {(c.possibleDoubles || []).map((d) => (
        <p key={`dbl-${d.codeLineId}-${d.expenseId}`} style={{ ...hubStyle.foot, color: 'var(--accent-amber-text)' }}>
          Possibly counted twice: {d.expenseLabel} on the expense list and {d.codeLabel} in the code. Edit the row and choose the code line under Counts instead of, and it is counted once.
        </p>
      ))}
      {(c.nonUsd || []).length > 0 && (
        <p style={hubStyle.foot}>Not added, because nothing here converts currencies: {c.nonUsd.map((x) => `${x.label} (${(x.amountCents / 100).toFixed(2)} ${x.currency}${x.replacesLine ? ', and the code line it names still counts' : ''})`).join(', ')}.</p>
      )}
      {c.undatedCodeYearly > 0 && (
        <p style={hubStyle.foot}>{hubPlural(c.undatedCodeYearly, 'yearly bill in the code has', 'yearly bills in the code have')} no charge date, so {c.undatedCodeYearly === 1 ? 'it counts' : 'they count'} at a twelfth every month. Add {c.undatedCodeYearly === 1 ? 'it' : 'them'} to the expense list with a renewal date to see the renewal coming.</p>
      )}
      {c.googleMeteredThisMonth && Number.isFinite(c.googleMeteredThisMonth.photosBought) && (
        <p style={hubStyle.foot}>
          Google photos bought this month: {hubCount(c.googleMeteredThisMonth.photosBought)}{Number.isFinite(c.googleMeteredThisMonth.photosUsd) ? `, ${hubMoney(Math.round(c.googleMeteredThisMonth.photosUsd * 100))}` : ''}, from places_photo_spend. That spend arrives on the Google Cloud invoice above and is not added twice.
        </p>
      )}
      {c.reconciledReadError && <p style={hubStyle.foot}>{c.reconciledReadError}</p>}
    </div>
  );
}

const HUB_EMPTY_EXPENSE = {
  vendor: '', product: '', category: '', kind: 'tooling', amount: '', currency: 'USD', cadence: 'monthly',
  lastChargedOn: '', renewsOn: '', replacesLine: '', verified: false, active: true, note: '',
};

function hubFormFromExpense(x) {
  return {
    vendor: x.vendor || '',
    product: x.product || '',
    category: x.category || '',
    kind: x.kind || 'other',
    amount: Number.isFinite(x.amountCents) ? (x.amountCents / 100).toFixed(2) : '',
    currency: x.currency || 'USD',
    cadence: x.cadence || 'monthly',
    lastChargedOn: x.lastChargedOn || '',
    renewsOn: x.renewsOn || '',
    replacesLine: x.replacesLine || '',
    verified: !!x.verified,
    active: x.active !== false,
    note: x.note || '',
  };
}

// What the expense routes take. Blank optional fields go as null, so the
// server stores nothing rather than an empty string.
function hubBodyFromForm(f) {
  return {
    vendor: f.vendor,
    product: f.product.trim() ? f.product : null,
    category: f.category.trim() ? f.category : null,
    kind: f.kind,
    amount: String(f.amount).trim(),
    currency: f.currency.trim() ? f.currency.trim().toUpperCase() : null,
    cadence: f.cadence,
    lastChargedOn: f.lastChargedOn || null,
    renewsOn: f.renewsOn || null,
    replacesLine: f.replacesLine || null,
    verified: !!f.verified,
    active: !!f.active,
    note: f.note.trim() ? f.note : null,
  };
}

function HubExpenseForm({ expense, kinds, cadences, codeLines, colors, onDone, onCancel }) {
  const uid = React.useId();
  const [form, setForm] = React.useState(() => (expense ? hubFormFromExpense(expense) : { ...HUB_EMPTY_EXPENSE }));
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      if (expense) await updateAdminExpense(expense.id, hubBodyFromForm(form));
      else await createAdminExpense(hubBodyFromForm(form));
      onDone();
    } catch (e) {
      setErr((e && e.message) || 'Could not save');
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setErr('');
    try {
      await deleteAdminExpense(expense.id);
      onDone();
    } catch (e) {
      setErr((e && e.message) || 'Could not delete');
      setBusy(false);
    }
  };
  const I = hubStyle.input;
  // Label and control side by side rather than nested, so a select's label is
  // its own words and not its words plus every option's.
  const field = (key, label, control, wide = false) => (
    <div key={key} style={{ ...hubStyle.fieldLabel, ...(wide ? { flexBasis: '100%' } : null) }}>
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      {control}
    </div>
  );
  return (
    <div style={{ padding: '10px 0', borderTop: '1px solid var(--border-light)' }}>
      <p style={{ ...hubStyle.kicker, margin: '0 0 6px' }}>{expense ? `Edit ${expense.vendor}` : 'Add a bill'}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {field('vendor', 'Vendor', <input id={`${uid}-vendor`} style={I} value={form.vendor} onChange={set('vendor')} maxLength={80} />)}
        {field('product', 'Product', <input id={`${uid}-product`} style={I} value={form.product} onChange={set('product')} maxLength={120} />)}
        {field('category', 'Category', <input id={`${uid}-category`} style={I} value={form.category} onChange={set('category')} maxLength={60} placeholder="Hosting, Legal" />)}
        {field('kind', 'Kind', (
          <select id={`${uid}-kind`} style={I} value={form.kind} onChange={set('kind')}>
            {kinds.map((k) => <option key={k} value={k}>{HUB_KIND_LABEL[k] || k}</option>)}
          </select>
        ))}
        {field('amount', 'Amount, dollars', <input id={`${uid}-amount`} style={I} type="number" min="0" step="0.01" inputMode="decimal" value={form.amount} onChange={set('amount')} />)}
        {field('currency', 'Currency', <input id={`${uid}-currency`} style={I} value={form.currency} onChange={set('currency')} maxLength={3} />)}
        {field('cadence', 'How often', (
          <select id={`${uid}-cadence`} style={I} value={form.cadence} onChange={set('cadence')}>
            {cadences.map((c) => <option key={c} value={c}>{c === 'one_time' ? 'once' : c === 'usage' ? 'usage, monthly' : c}</option>)}
          </select>
        ))}
        {field('lastChargedOn', 'Last charged', <input id={`${uid}-lastChargedOn`} style={I} type="date" max={localToday()} value={form.lastChargedOn} onChange={set('lastChargedOn')} />)}
        {field('renewsOn', 'Renews', <input id={`${uid}-renewsOn`} style={I} type="date" value={form.renewsOn} onChange={set('renewsOn')} />)}
        {field('replacesLine', 'Counts instead of', (
          <select id={`${uid}-replacesLine`} style={I} value={form.replacesLine} onChange={set('replacesLine')}>
            <option value="">No code line</option>
            {codeLines.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        ))}
        {field('note', 'Note', <input id={`${uid}-note`} style={I} value={form.note} onChange={set('note')} maxLength={500} />, true)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginTop: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={form.verified} onChange={set('verified')} />Seen on an invoice
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={form.active} onChange={set('active')} />Still being charged
        </label>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginTop: '10px' }}>
        <button className="hit44" type="button" disabled={busy || !form.vendor.trim() || String(form.amount).trim() === ''} onClick={save}
          style={{ padding: '8px 14px', borderRadius: '8px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: busy ? 'default' : 'pointer' }}>
          {busy ? 'Saving' : 'Save'}
        </button>
        <button className="hit44" type="button" disabled={busy} onClick={onCancel} style={hubStyle.textButton}>Cancel</button>
        {expense && !confirmDelete && (
          <button className="hit44" type="button" disabled={busy} onClick={() => setConfirmDelete(true)} style={{ ...hubStyle.textButton, marginLeft: 'auto' }}>Delete</button>
        )}
        {expense && confirmDelete && (
          <button className="hit44" type="button" disabled={busy} onClick={remove} style={{ ...hubStyle.textButton, marginLeft: 'auto', color: 'var(--accent-red-text)' }}>Delete for good</button>
        )}
      </div>
      {confirmDelete && <p style={hubStyle.note}>For a bill entered by mistake. A bill that stopped is better marked as no longer charged, which keeps it on the list.</p>}
      {err && <p style={{ ...hubStyle.note, color: 'var(--accent-red-text)' }}>{err}</p>}
    </div>
  );
}

function HubExpenseRow({ x, codeLines, colors, onEdit, onChanged }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const toggle = async () => {
    setBusy(true);
    setErr('');
    try {
      await updateAdminExpense(x.id, { ...hubBodyFromForm(hubFormFromExpense(x)), active: !x.active });
      onChanged();
    } catch (e) {
      setErr((e && e.message) || 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const label = x.product ? `${x.vendor}, ${x.product}` : x.vendor;
  const line = x.replacesLine ? (codeLines.find((l) => l.id === x.replacesLine) || {}).label || x.replacesLine : null;
  const amount = x.currency === 'USD' ? hubMoney(x.amountCents) : `${(x.amountCents / 100).toFixed(2)} ${x.currency}`;
  const facts = [
    HUB_KIND_LABEL[x.kind] || x.kind,
    x.category,
    x.renewsOn ? `renews ${hubDay(x.renewsOn)}` : null,
    x.lastChargedOn ? `last charged ${hubDay(x.lastChargedOn)}` : null,
    line ? `counts instead of ${line} in the code` : null,
  ].filter(Boolean).join(', ');
  return (
    <div style={{ padding: '8px 0', borderTop: '1px solid var(--border-light)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: x.active ? colors.navy : 'var(--text-tertiary)', minWidth: 0, overflowWrap: 'anywhere' }}>
          {label}
          {!x.verified && <span style={hubTag('warn')}>Unverified</span>}
          {!x.active && <span style={hubTag('muted')}>Stopped</span>}
        </span>
        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: x.active ? colors.navy : 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {amount} {HUB_CADENCE_LABEL[x.cadence] || x.cadence}
        </span>
      </div>
      <p style={hubStyle.note}>{facts.charAt(0).toUpperCase() + facts.slice(1)}.{x.note ? ` ${x.note}` : ''}</p>
      <div style={{ display: 'flex', gap: '16px' }}>
        <button className="hit44" type="button" onClick={onEdit} style={hubStyle.textButton}>Edit</button>
        <button className="hit44" type="button" disabled={busy} onClick={toggle} style={hubStyle.textButton}>
          {busy ? 'Saving' : x.active ? 'Mark as stopped' : 'Mark as charged again'}
        </button>
      </div>
      {err && <p style={{ ...hubStyle.note, color: 'var(--accent-red-text)' }}>{err}</p>}
    </div>
  );
}

const HUB_IMPORT_EXAMPLE = '[\n  { "vendor": "Example Host", "product": "Pro plan", "kind": "infrastructure",\n    "cadence": "monthly", "amount": 20, "renewsOn": "2026-10-16" }\n]';

function HubExpenseImport({ colors, onImported }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const run = async () => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      setResult({ ok: false, text: 'That is not valid JSON. Paste a list in square brackets, one object per bill.' });
      return;
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.expenses) ? parsed.expenses : null);
    if (!list) {
      setResult({ ok: false, text: 'Paste a list: square brackets around one object per bill.' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const r = await importAdminExpenses(list);
      setResult({ ok: true, text: `${hubPlural(r.inserted, 'bill', 'bills')} added and ${hubCount(r.updated)} updated.` });
      setText('');
      onImported();
    } catch (e) {
      const errors = e && e.data && Array.isArray(e.data.errors) ? e.data.errors : [];
      setResult({ ok: false, text: (e && e.message) || 'The import failed, and nothing was saved.', errors });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--border-default)' }}>
      <button className="hit44" type="button" onClick={() => setOpen((o) => !o)} style={hubStyle.textButton} aria-expanded={open}>
        {open ? 'Close the import' : 'Import a list'}
      </button>
      {open && (
        <div style={{ marginTop: '6px' }}>
          <p style={hubStyle.note}>
            One object per bill. Required: vendor, kind (infrastructure, tooling, legal or other), cadence (monthly, yearly, usage or one_time) and amount in dollars. Optional: product, category, currency, lastChargedOn, renewsOn, verified, note, and replacesLine to count a bill instead of a code line. A bill already on the list with the same vendor, product and cadence is updated, and a field left out keeps what is stored. Up to 200 at a time; one bad row saves nothing.
          </p>
          <pre style={{ ...hubStyle.note, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', background: 'var(--bg-tertiary)', borderRadius: '8px', padding: '8px', margin: '6px 0' }}>{HUB_IMPORT_EXAMPLE}</pre>
          <textarea
            aria-label="Expense list to import"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            style={{ ...hubStyle.input, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
            <button className="hit44" type="button" disabled={busy || !text.trim()} onClick={run}
              style={{ padding: '8px 14px', borderRadius: '8px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: busy ? 'default' : 'pointer' }}>
              {busy ? 'Importing' : 'Import'}
            </button>
          </div>
          {result && (
            <div role="status" style={{ marginTop: '6px' }}>
              <p style={{ ...hubStyle.note, color: result.ok ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>{result.text}</p>
              {(result.errors || []).slice(1).map((line) => <p key={line} style={{ ...hubStyle.note, color: 'var(--accent-red-text)' }}>{line}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HubExpenses({ h, colors, onChanged }) {
  const e = h.expenses || {};
  const rows = Array.isArray(e.rows) ? e.rows : [];
  const kinds = Array.isArray(e.kinds) ? e.kinds : Object.keys(HUB_KIND_LABEL);
  const cadences = Array.isArray(e.cadences) ? e.cadences : Object.keys(HUB_CADENCE_LABEL);
  const codeLines = Array.isArray(e.codeLines) ? e.codeLines : [];
  const [editing, setEditing] = React.useState(null);
  const done = () => { setEditing(null); onChanged(); };
  return (
    <div style={hubStyle.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' }}>Expense list</h3>
          <p style={hubStyle.sub}>Bills the code does not carry, from your own invoices: the tools the app is built with, company and legal costs, anything else. Stored in the database, never in the published source.</p>
        </div>
        {editing !== 'new' && (
          <button className="hit44" type="button" onClick={() => setEditing('new')} style={{ ...hubStyle.textButton, flexShrink: 0 }}>Add a bill</button>
        )}
      </div>
      {e.status === 'error' && <HubNotice status="error" reason="The list could not be read. The costs above count the code lines and the reconciled invoice only." />}
      {editing === 'new' && (
        <HubExpenseForm kinds={kinds} cadences={cadences} codeLines={codeLines} colors={colors} onDone={done} onCancel={() => setEditing(null)} />
      )}
      {e.status === 'ok' && rows.length === 0 && editing !== 'new' && (
        <p style={hubStyle.note}>Nothing on the list yet. Add a bill, or import the whole list at once.</p>
      )}
      {rows.map((x) => (editing === x.id ? (
        <HubExpenseForm key={`form-${x.id}`} expense={x} kinds={kinds} cadences={cadences} codeLines={codeLines} colors={colors} onDone={done} onCancel={() => setEditing(null)} />
      ) : (
        <HubExpenseRow key={`row-${x.id}`} x={x} codeLines={codeLines} colors={colors} onEdit={() => setEditing(x.id)} onChanged={onChanged} />
      )))}
      <HubExpenseImport colors={colors} onImported={onChanged} />
    </div>
  );
}

const HUB_VERDICT = {
  match: { text: 'Matches', tone: 'good' },
  mismatch: { text: 'Disagrees', tone: 'bad' },
  missing: { text: 'Missing', tone: 'bad' },
  unset: { text: 'Not set', tone: 'warn' },
  unsold: { text: 'Not sold', tone: 'muted' },
  unchecked: { text: 'Not checked', tone: 'muted' },
};
const HUB_VERDICT_ORDER = ['mismatch', 'missing', 'unset', 'unchecked', 'unsold', 'match'];

function HubPrices({ h, colors }) {
  const p = h.pricing || {};
  const s = (h.revenue && h.revenue.stripe) || {};
  const rc = (h.revenue && h.revenue.revenuecat) || {};
  const navy = colors.navy;
  const stated = [...(p.stated || [])].sort((a, b) => HUB_VERDICT_ORDER.indexOf(a.verdict) - HUB_VERDICT_ORDER.indexOf(b.verdict));
  const live = s.status === 'ok' && s.prices && s.prices.status === 'ok' ? s.prices.live || [] : null;
  const count = Number.isFinite(p.mismatches) ? p.mismatches : 0;
  const every = (iv) => (iv === 'year' ? 'a year' : iv === 'month' ? 'a month' : iv ? `every ${iv}` : 'once');
  return (
    <div style={hubStyle.card}>
      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 2px' }}>Prices</h3>
      <p style={hubStyle.sub}>What Stripe and the App Store charge, next to every price written down in the code and the decision documents.</p>
      <p style={{ fontSize: 'var(--t-label)', fontWeight: '700', margin: '0 0 4px', color: count > 0 ? 'var(--accent-red-text)' : s.status === 'ok' ? 'var(--accent-green-text)' : 'var(--text-secondary)' }}>
        {count > 0 ? `${hubPlural(count, 'disagreement', 'disagreements')} to fix` : s.status === 'ok' ? 'No disagreements found' : 'Not checked against Stripe'}
      </p>
      {s.status !== 'ok' && <HubNotice status={s.status} reason={s.reason} />}

      <p style={hubStyle.kicker}>Written in the code</p>
      {stated.map((x) => {
        const v = HUB_VERDICT[x.verdict] || HUB_VERDICT.unchecked;
        return (
          <HubRow
            key={x.id}
            navy={navy}
            label={`${x.productLabel}, ${HUB_PLAN_LABEL[x.plan] || x.plan}`}
            tag={v}
            value={hubMoney(x.statedCents)}
            tone={v.tone === 'bad' ? 'bad' : undefined}
            note={`${x.file}, ${x.what}. ${x.words}`}
          />
        );
      })}
      {(p.internal || []).map((i) => (
        <p key={`int-${i.product}-${i.plan}`} style={{ ...hubStyle.foot, color: 'var(--accent-red-text)' }}>{i.words}</p>
      ))}

      <p style={hubStyle.kicker}>App Store</p>
      {(p.appStore || []).map((a) => {
        const v = HUB_VERDICT[a.verdict] || HUB_VERDICT.unchecked;
        const seen = Number.isFinite(a.listCents) ? a.listCents : a.lastChargedCents;
        return (
          <HubRow key={a.productId} navy={navy} label={a.productId} tag={v} value={Number.isFinite(seen) ? hubMoney(seen) : 'Not read'} tone={v.tone === 'bad' ? 'bad' : undefined} note={a.words} />
        );
      })}

      <p style={hubStyle.kicker}>RevenueCat offering</p>
      {p.offering && p.offering.status === 'ok' ? (
        (p.offering.findings || []).map((f) => (
          <HubRow key={f.words} navy={navy} label={f.words} value={f.ok ? 'Right' : 'Wrong'} tone={f.ok ? 'good' : 'bad'} />
        ))
      ) : rc.status !== 'ok' ? (
        <HubNotice status={rc.status} reason={rc.reason} />
      ) : (
        <HubNotice status={p.offering && p.offering.status === 'error' ? 'error' : 'refused'} reason={(p.offering && p.offering.reason) || 'The offering could not be read with this key.'} />
      )}

      <p style={hubStyle.kicker}>Live in Stripe</p>
      {live === null && <HubNotice status={s.status === 'ok' ? 'error' : s.status} reason={s.status === 'ok' && s.prices ? s.prices.reason : s.reason} />}
      {live && live.length === 0 && <p style={hubStyle.note}>Stripe has no active prices.</p>}
      {live && live.map((pr) => (
        <HubRow
          key={pr.id}
          navy={navy}
          label={`${pr.productName || 'Unnamed product'}${pr.nickname ? `, ${pr.nickname}` : ''}`}
          tag={pr.env ? null : { tone: 'warn', text: 'Unused' }}
          value={`${pr.currency === 'USD' ? hubMoney(pr.unitAmountCents) : `${(pr.unitAmountCents / 100).toFixed(2)} ${pr.currency}`} ${every(pr.interval)}`}
          note={pr.env ? `${pr.env} points here (${pr.id}).` : `${pr.id}. Active in Stripe, and no price variable points at it, so the app never sells it.`}
        />
      ))}
      {p.paywallNote && <p style={hubStyle.foot}>{p.paywallNote}</p>}
    </div>
  );
}

function HubHealth({ h, colors }) {
  const c = (h.health && h.health.collector) || {};
  const navy = colors.navy;
  const STATE = { fresh: { text: 'Landing', tone: 'good' }, late: { text: 'Late', tone: 'warn' }, stopped: { text: 'Stopped', tone: 'bad' } };
  const st = STATE[c.state] || { text: 'Not read', tone: 'muted' };
  const ago = (min) => (min < 60 ? hubPlural(min, 'minute', 'minutes') : min < 48 * 60 ? hubPlural(Math.round(min / 60), 'hour', 'hours') : hubPlural(Math.round(min / 1440), 'day', 'days'));
  return (
    <div style={hubStyle.card}>
      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: navy, margin: '0 0 2px' }}>Health</h3>
      <p style={hubStyle.sub}>The paid data feed, read from the rows it writes rather than from the job.</p>
      {c.status === 'error' ? (
        <HubNotice status="error" reason={c.reason} />
      ) : (
        <HubRow
          navy={navy}
          label="Crowd data collector"
          value={st.text}
          tone={st.tone}
          note={`${c.latestAt ? `Last row ${ago(c.minutesSinceLatest)} ago, at ${hubTime(c.latestAt)}.` : 'No live crowd row has landed yet.'} ${hubPlural(c.rows24h, 'row', 'rows')} across ${hubPlural(c.hours24h, 'hour', 'hours')} of the last day. It runs hourly, so ${Math.round(((c.lateAfterMinutes || 150) / 60) * 10) / 10} hours without a row reads as late. Last heartbeat alert: ${c.lastAlertOn ? hubDay(c.lastAlertOn) : 'none'}. From ml_training_data.`}
        />
      )}
      <HubRow
        navy={navy}
        label="Backups"
        value="Not recorded here"
        tone="muted"
        note="Nothing in this database records a backup or a restore point, so this panel has nothing to report. Railway's dashboard holds both."
      />
    </div>
  );
}

function MoneyHub({ colors }) {
  const [data, setData] = React.useState(hubMemo.data);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const load = React.useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const d = await getAdminMoneyHub({ refresh });
      hubMemo.data = d;
      setData(d);
    } catch (e) {
      // A failed read shows no numbers rather than the last ones under a live
      // label, the same rule the Costs tab keeps.
      hubMemo.data = null;
      setData(null);
      setError((e && e.message) || 'The money hub did not load.');
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { load(false); }, [load]);

  if (!data) {
    return (
      <div style={{ ...hubStyle.card, border: `1px dashed ${colors.creamDark}` }} role="status">
        <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' }}>
          {loading ? 'Reading Stripe, RevenueCat and the database' : error ? 'The money hub did not load' : 'Nothing read yet'}
        </h3>
        <p style={hubStyle.sub}>
          {loading ? 'The first read asks both vendors and can take a few seconds.' : error ? `${error} Nothing is shown rather than a guess.` : 'The hub has not been read yet.'}
        </p>
        {!loading && (
          <button className="hit44" type="button" onClick={() => load(false)}
            style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>
            {error ? 'Try again' : 'Read it'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <HubSummary h={data} colors={colors} loading={loading} onRefresh={() => load(true)} />
      <HubRevenue h={data} colors={colors} />
      <HubCosts h={data} colors={colors} />
      <HubExpenses h={data} colors={colors} onChanged={() => load(false)} />
      <HubPrices h={data} colors={colors} />
      <HubHealth h={data} colors={colors} />
    </div>
  );
}

export default function RevenueScreen({
  adminTab,
  avgSpend,
  colors,
  costsData,
  costsError,
  costsLoading,
  eventsPerVenue,
  fetchCosts,
  fetchResearchLive,
  numVenues,
  operatingCosts,
  researchDemoMode,
  researchError,
  researchLiveData,
  researchLoading,
  setAdminTab,
  setAvgSpend,
  setEventsPerVenue,
  setNumVenues,
  setOperatingCosts,
  setResearchDemoMode,
  setSubscriptionPrice,
  setTakeRate,
  styles,
  subscriptionPrice,
  switchMode,
  takeRate,
}) {
    // adminTab state is now at App level to persist across re-renders

    // Admin tabs definition.
    //
    // Two of these three tabs used to carry the IDENTICAL Icons.barChart, so a
    // three-tab bar offered two tabs you could not tell apart without reading,
    // and the labels did not help either: "Revenue" and "Money" are the same
    // word twice. The tab whose id is already `projections` is now labelled
    // Projections and carries trendingUp, which is what it actually shows.
    // Three tabs, three glyphs, three distinct meanings.
    // Costs landed 2026-08-20 as the fourth. It carries creditCard, which is
    // the only glyph in the set that says "a bill arrived" rather than "a
    // number went up", and the label is the one word used for it.
    //
    // Overview replaced Revenue as the first tab on 2026-09-25. Revenue was a
    // what-if simulator under a word that now belongs to real money, and the
    // money hub (real revenue, real costs, prices, health) is what the owner
    // opens the console for. The simulator moved under Projections, which is
    // what it always was, so the bar keeps four tabs, four glyphs and four
    // meanings. Overview takes dollar, the glyph Revenue carried.
    const adminTabs = [
      { id: 'overview', label: 'Overview', icon: Icons.dollar },
      { id: 'costs', label: 'Costs', icon: Icons.creditCard },
      { id: 'projections', label: 'Projections', icon: Icons.trendingUp },
      { id: 'research', label: 'Research', icon: Icons.barChart }
    ];
    // A tab id this screen does not know, including 'revenue' from before the
    // rename, opens the hub rather than a blank body.
    const activeTab = adminTabs.some((t) => t.id === adminTab) ? adminTab : 'overview';

    // Revenue simulator state lives at FlockAppInner level, next to adminTab
    // and for the same reason. See the note there.

    // Calculate all metrics
    const subscriptionRevenue = calculateSubscriptionRevenue(numVenues, subscriptionPrice);
    const transactionRevenue = calculateTransactionRevenue(numVenues, eventsPerVenue, avgSpend, takeRate);
    const totalMonthlyRevenue = calculateTotalMonthlyRevenue(subscriptionRevenue, transactionRevenue);
    const annualRevenue = calculateAnnualRevenue(totalMonthlyRevenue);
    const monthlyProfit = calculateMonthlyProfit(totalMonthlyRevenue, operatingCosts);
    const revenuePerVenue = calculateRevenuePerVenue(totalMonthlyRevenue, numVenues);
    const breakEvenVenues = calculateBreakEven(operatingCosts, subscriptionPrice, eventsPerVenue, avgSpend, takeRate);
    const profitMargin = calculateProfitMargin(monthlyProfit, totalMonthlyRevenue);
    const isProfitable = monthlyProfit >= 0;
    // calculateBreakEven returns Infinity when a venue generates no revenue,
    // which you reach just by zeroing the subscription price. Rendering it raw
    // put "Infinity venues" and "Need Infinity more venues" on screen.
    const breakEvenReachable = Number.isFinite(breakEvenVenues);
    const isAboveBreakEven = breakEvenReachable && numVenues >= breakEvenVenues;
    // Margin is undefined with no revenue, and revenue per venue is undefined
    // with no venues. Both return 0 from lib/finance.js to keep the type finite,
    // so the screen has to say "n/a" rather than print the placeholder.
    const marginDefined = totalMonthlyRevenue > 0;
    const revenuePerVenueDefined = numVenues > 0;

    // Input field style
    const inputStyle = {
      width: '100%',
      padding: '10px 12px',
      borderRadius: '8px',
      border: `1px solid ${colors.creamDark}`,
      fontSize: 'var(--t-body)',
      fontWeight: '600',
      color: colors.navy,
      backgroundColor: 'var(--bg-card-solid)',
      outline: 'none',
      boxSizing: 'border-box',
    };

    const labelStyle = {
      fontSize: 'var(--t-meta)',
      fontWeight: '500',
      color: colors.navy,
      marginBottom: '4px',
      display: 'block',
    };

    const helperStyle = {
      fontSize: 'var(--t-meta)',
      color: 'var(--text-tertiary)',
      marginTop: '2px',
    };

    const cardStyle = {
      backgroundColor: 'var(--bg-card-solid)',
      borderRadius: '12px',
      padding: '12px',
      marginBottom: '10px',
      boxShadow: 'var(--card-shadow-sm)',
    };

    return (
      <div key="revenue-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        {/* Header */}
        <div style={{ padding: '16px', background: colors.navyBg, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button aria-label="Switch mode" title="Switch mode" className="hit44" onClick={switchMode} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            {/* Cobalt Birdie, still. This slot held a generic briefcase glyph,
                which said "office software" on the one screen that is purely
                ours. 44px is a brand mark, not an icon; the photo carries its
                own light against the navy. Eager because the header is the
                first paint of this screen — a lazy image here pops in. */}
            <BirdieStill size={44} eager style={{ flexShrink: 0 }} />
            <div>
              <h1 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'white', margin: 0 }}>Admin Dashboard</h1>
              <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)', margin: 0 }}>Analytics, revenue and moderation</p>
            </div>
          </div>
          {/* Where the reports queue actually lives. /admin/moderation is a
              PAGES route index.js matches BEFORE the native-shell fallback,
              so navigating the WebView there IN PLACE renders the
              authenticated console with the app's own localStorage token, and
              the console's Back to Flock link boots the app again. The
              previous iOS branch printed the URL in a span that could be
              neither tapped nor copied, on the strength of a comment claiming
              the admin would be stranded there; that premise was wrong, and
              the routing above is why. What WOULD strand the token is an
              external open into Safari (different origin, no token), which is
              why the native branch navigates in place instead of using
              target="_blank". */}
          {(() => {
            const isNative = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
            const boxStyle = { marginTop: '12px', padding: '10px 12px', borderRadius: '10px', backgroundColor: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', gap: '8px' };
            if (isNative) {
              return (
                <button type="button" className="hit44" onClick={() => window.location.assign('/admin/moderation')} style={{ ...boxStyle, width: '100%', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
                  {Icons.shield('white', 16)}
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'white' }}>Moderation console</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)', marginLeft: 'auto' }}>Reports and takedowns</span>
                </button>
              );
            }
            return (
              <a href="/admin/moderation" target="_blank" rel="noopener noreferrer" className="hit44" style={{ ...boxStyle, textDecoration: 'none', cursor: 'pointer' }}>
                {Icons.shield('white', 16)}
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'white' }}>Moderation console</span>
                <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)', marginLeft: 'auto' }}>Reports and takedowns</span>
              </a>
            );
          })()}
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', flexShrink: 0, padding: '8px 4px', gap: '4px' }}>
          {adminTabs.map(tab => (
            <button className="hit44" key={tab.id} aria-pressed={activeTab === tab.id} onClick={() => setAdminTab(tab.id)} style={{ flex: 1, minWidth: 0, padding: '12px 4px', border: 'none', backgroundColor: activeTab === tab.id ? colors.navyBg : 'var(--bg-card-solid)', borderRadius: '10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', transition: 'opacity 0.2s' }}>
              {tab.icon(activeTab === tab.id ? 'white' : colors.navy, 18)}
              <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: activeTab === tab.id ? 'white' : colors.navy }}>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* OVERVIEW TAB: the money hub, defined above this component. */}
          {activeTab === 'overview' && <MoneyHub colors={colors} />}

          {/* THE WHAT-IF SIMULATOR, at the top of the Projections tab. It was
              the Revenue tab until 2026-09-25, when real revenue got a tab of
              its own; it is arithmetic on typed inputs, which is what the
              Projections tab is for. The inputs still live in FlockAppInner. */}
          {activeTab === 'projections' && (<>
          <div style={{ marginBottom: '8px' }}>
            <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' }}>What-if simulator</h3>
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>Type a venue count and a price and read what they would add up to. Real subscribers and revenue are on the Overview tab.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>

            {/* LEFT COLUMN - INPUTS */}
            <div>
              <h3 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: colors.navy, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Inputs</h3>

              {/* Number of Venues */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-venues">Number of Venues</label>
                <input id="rev-venues"
                  type="number"
                  value={numVenues}
                  onChange={(e) => setNumVenues(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Venues subscribed to Flock</p>
              </div>

              {/* Subscription Price */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-subscription">Monthly Subscription</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>$</span>
                  <input id="rev-subscription"
                    type="number"
                    value={subscriptionPrice}
                    onChange={(e) => setSubscriptionPrice(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Monthly fee per venue</p>
              </div>

              {/* Events Per Venue */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-events">Events Per Venue/Month</label>
                <input id="rev-events"
                  type="number"
                  value={eventsPerVenue}
                  onChange={(e) => setEventsPerVenue(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Avg bookings per venue</p>
              </div>

              {/* Average Spend */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-spend">Avg Group Spend</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>$</span>
                  <input id="rev-spend"
                    type="number"
                    value={avgSpend}
                    onChange={(e) => setAvgSpend(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Per event transaction</p>
              </div>

              {/* Take Rate */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-takerate">Transaction Take Rate</label>
                <div style={{ position: 'relative' }}>
                  <input id="rev-takerate"
                    type="number"
                    value={takeRate}
                    onChange={(e) => setTakeRate(Math.max(0, parseFloat(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingRight: '28px' }}
                    min="0"
                    step="0.1"
                  />
                  <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>%</span>
                </div>
                <p style={helperStyle}>% of each transaction</p>
              </div>

              {/* Operating Costs */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-costs">Monthly Operating Costs</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>$</span>
                  <input id="rev-costs"
                    type="number"
                    value={operatingCosts}
                    onChange={(e) => setOperatingCosts(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Fixed monthly expenses</p>
              </div>
            </div>

            {/* RIGHT COLUMN - OUTPUTS */}
            <div>
              <h3 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: colors.navy, margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Projections</h3>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 10px', lineHeight: '1.4' }}>
                Arithmetic on the numbers you typed, not measurements. The real numbers are on the Overview tab.
              </p>

              {/* Revenue Breakdown */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '0 0 8px', textTransform: 'uppercase' }}>Projected Revenue</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Subscriptions</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{formatCurrency(subscriptionRevenue)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Transactions</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{formatCurrency(transactionRevenue)}</span>
                </div>
                <div style={{ borderTop: `1px solid ${colors.creamDark}`, paddingTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>Monthly Total</span>
                    <span style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy }}>{formatCurrency(totalMonthlyRevenue)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Annualised run rate</span>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navyMid }}>{formatCurrency(annualRevenue)}</span>
                  </div>
                  {/* Not ARR. ARR may only count the recurring stream; this is
                      the monthly total times twelve, so it folds in transaction
                      revenue and assumes no venue ever cancels. */}
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '4px 0 0', lineHeight: '1.4' }}>
                    This month times twelve. It includes transaction fees, which are not recurring, and assumes no venue cancels.
                  </p>
                </div>
              </div>

              {/* Profitability.
                  The background used to be a hardcoded light mint gradient (or
                  the light red pair) while every piece of text on it uses the
                  accent TOKENS, which flip to a light green and a light red in
                  dark mode. Light on light, about 1.7:1: the profit headline
                  and the margin were unreadable in dark mode, and this is the
                  one card on the screen whose whole job is a single number.
                  --accent-green-bg / --accent-red-bg are the tokens those text
                  colours are already designed against and they flip together,
                  so the pair stays legible in both themes. Flat rather than a
                  gradient, which is also what the design rules ask for. */}
              <div style={{ ...cardStyle, background: isProfitable ? 'var(--accent-green-bg)' : 'var(--accent-red-bg)' }}>
                <h4 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)', margin: '0 0 8px', textTransform: 'uppercase' }}>
                  {isProfitable ? 'Profitable' : 'Not Profitable'}
                </h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>Monthly Profit</span>
                  <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>
                    {monthlyProfit >= 0 ? '+' : ''}{formatCurrency(monthlyProfit)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>Profit Margin</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>
                    {marginDefined ? `${profitMargin.toFixed(1)}%` : 'n/a'}
                  </span>
                </div>
              </div>

              {/* Unit Economics */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '0 0 8px', textTransform: 'uppercase' }}>Unit Economics</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Revenue/Venue</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{revenuePerVenueDefined ? `${formatCurrency(revenuePerVenue)}/mo` : 'n/a'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Break-Even Point</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{breakEvenReachable ? `${breakEvenVenues} venues` : 'Not reachable'}</span>
                </div>
                <div style={{ padding: '8px', borderRadius: '8px', backgroundColor: isAboveBreakEven ? 'var(--accent-green-bg)' : 'var(--accent-amber-bg)', textAlign: 'center' }}>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: isAboveBreakEven ? 'var(--accent-green-text)' : 'var(--accent-amber-text)' }}>
                    {!breakEvenReachable
                      ? 'A venue brings in nothing at these inputs, so there is no break-even point.'
                      : isAboveBreakEven
                        ? `${numVenues - breakEvenVenues} venues above break-even`
                        : `Need ${breakEvenVenues - numVenues} more venues`}
                  </span>
                </div>
              </div>

              {/* Business Model Info */}
              <div style={{ ...cardStyle, backgroundColor: 'var(--bg-card-solid)', border: `1px solid ${colors.creamDark}` }}>
                <h4 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 6px' }}>The plan behind these numbers</h4>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
                  Two streams: a monthly <strong>venue subscription</strong> (Roost), which recurs, and a
                  cut of <strong>group transactions</strong>, which would not. Roost billing is built and
                  switched off, and no transaction fee exists in the product, so every figure above is what the
                  arithmetic would say if the inputs on the left were real.
                </p>
              </div>
            </div>
          </div>
          </>)}

          {/* The Users, Venues, Cities and Txns tabs were deleted 2026-08-13.
              All four were wall-to-wall invented metrics with no demo label:
              3,200 total users, named fake people, per-venue revenues,
              '4 Active Cities', '$44.8K Total Revenue', a transactions feed.
              Flock has roughly zero users, no venue partners and no revenue,
              which the burn panel three cards down says out loud. Admin-only
              softens the damage but a judge or a reviewer looking over your
              shoulder sees invented traction. The revenue simulator (clearly a
              simulator, driven by inputs) and the burn panel are honest and
              stay. Same call as the fake venue analytics tab on 2026-08-12. */}

          {/* PROJECTIONS TAB */}
          {/* COSTS TAB
              ------------------------------------------------------------
              What Flock costs, in the three kinds of number
              backend/services/costModel.js keeps apart, kept apart here too.

              THE RULE THIS SCREEN EXISTS TO HOLD. A ceiling is not a bill.
              The panels below are ordered by how much they are worth
              trusting, and the two that are not measurements say so in their
              own headings rather than in a footnote: "If every ceiling were
              hit" is a dashed box, and it never sits next to a dollar figure
              that came off a meter.

              Nothing here is computed in the browser. Every number arrives
              from GET /api/admin/costs already priced, because the rate card
              and the arithmetic belong next to the meters that feed them and
              a second copy in JSX is how the old hand-typed expense array
              went five vendors out of date. */}
          {activeTab === 'costs' && (() => {
            const d = costsData;

            // Money, or an honest word when there is no number. A null here
            // means nobody measured, which is not the same as zero, and
            // printing "$0.00" for an absent meter would claim coverage the
            // panel does not have.
            const money = (n, dp = 2) =>
              (Number.isFinite(n) ? `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}` : null);
            const moneyOr = (n, fallback = 'Not measured', dp = 2) => money(n, dp) || fallback;
            const count = (n) => (Number.isFinite(n) ? n.toLocaleString() : null);

            const card = {
              backgroundColor: 'var(--bg-card-solid)',
              borderRadius: '12px',
              padding: '12px',
              boxShadow: 'var(--card-shadow-sm)',
            };
            const h3 = { fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' };
            const sub = { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.4 };
            const big = { fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '2px 0 0', lineHeight: 1.1 };
            const kicker = { fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' };
            const foot = { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.4 };

            const row = (key, left, right, note) => (
              <div key={key} style={{ padding: '6px 0', borderTop: '1px solid var(--border-light)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{left}</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, whiteSpace: 'nowrap' }}>{right}</span>
                </div>
                {note && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.35 }}>{note}</p>}
              </div>
            );

            // The mark on a figure nobody has seen on an invoice. It sits
            // beside the LABEL rather than the amount because the amount is
            // the part that has to stay scannable, and a reader who takes the
            // number without the tag has still read a marked row.
            const unverifiedTag = {
              fontSize: 'var(--t-micro)',
              fontWeight: '700',
              color: 'var(--accent-amber-text)',
              backgroundColor: 'var(--accent-amber-bg)',
              borderRadius: '6px',
              padding: '1px 5px',
              marginLeft: '6px',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              whiteSpace: 'nowrap',
            };

            // A FIXED BILL, WITH THE TWO FACTS THE OLD ROW THREW AWAY.
            //
            // It printed a label and a number, showed the note only when the
            // line was unverified, and showed the checked date never. So the
            // panel's own copy said "every line carries the date it was last
            // checked" above eight rows that carried no date at all, Vercel's
            // assumed $0 read exactly like a confirmed free tier, and the note
            // on every verified line was invisible, which is where the reason
            // for a bill lives. All three are on the row now.
            //
            // `verified` means a human has seen this exact number on an
            // invoice or a dashboard, not on a vendor's public pricing page.
            // An unverified line is still counted in the totals, and the panel
            // says so rather than dropping it.
            const fixedRow = (e, period) => (
              <div key={e.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border-light)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
                    {e.label}
                    {!e.verified && <span style={unverifiedTag}>Unverified</span>}
                  </span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, whiteSpace: 'nowrap' }}>{moneyOr(e.usd, 'No figure')}{period}</span>
                </div>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.35 }}>
                  {e.verified
                    ? `Seen on an invoice. Checked ${e.checked}.`
                    : `Not seen on an invoice. This is a published price or an assumption, counted in the totals anyway. Checked ${e.checked}.`}
                  {e.note ? ` ${e.note}` : ''}
                  {e.source ? ` ${e.source}` : ''}
                </p>
              </div>
            );

            if (!d) {
              return (
                <div style={{ ...card, border: `1px dashed ${colors.creamDark}` }}>
                  {!costsLoading && <BirdieStill size={64} style={{ marginBottom: '8px' }} />}
                  <h3 style={h3}>{costsLoading ? 'Reading the meters' : costsError ? 'These numbers did not load' : 'Nothing read yet'}</h3>
                  <p style={sub}>
                    {costsLoading
                      ? 'Fetching the ledgers and the rate card.'
                      : costsError
                        ? 'The cost panel could not be read. Nothing is shown rather than showing the last numbers under a live label.'
                        : 'The cost panel has not been asked for yet.'}
                  </p>
                  {!costsLoading && (
                    <button className="hit44 glass-btn glass-primary" onClick={() => fetchCosts()} style={{ ...styles.gradientButton, padding: '12px', marginTop: '4px' }}>
                      {costsError ? 'Try again' : 'Read the meters'}
                    </button>
                  )}
                </div>
              );
            }

            const reconciledTotal = (d.reconciled?.lines || []).reduce((s2, l) => s2 + (Number.isFinite(l.usdPerMonth) ? l.usdPerMonth : 0), 0);
            const v = d.venueUnitEconomics || {};
            const obs = d.observed || {};
            const worst = d.worstCase || {};
            const fixed = d.fixed || {};
            const dep = d.dependencies || {};

            // THE INVENTORY RESOLVES, IT DOES NOT RESTATE. Every figure on an
            // inventory row is looked up from the block that owns it: usage
            // from the observed lines, flat bills from the fixed lines, the
            // long-form exposure note from the watchlist. So a price exists
            // once in this payload and this list cannot drift from the
            // arithmetic, which is exactly how the hand-typed expense array
            // that used to live in this file went five vendors out of date.
            const allDeps = (dep.groups || []).flatMap((g) => g.entries);
            const obsById = Object.fromEntries((obs.lines || []).map((l) => [l.id, l]));
            const watchById = Object.fromEntries((d.watchlist || []).map((w) => [w.id, w]));

            // THE WATCHLIST'S OWN THREE WORDS, which reached no screen at all.
            // The panel rendered a watchlist entry's note and dropped its
            // severity and its figure, so seven exposures read as ordinary
            // prose on an ordinary row. They are not the same kind of thing:
            // a cap somebody else enforces, a bill that arrives per use with
            // nothing counting the uses, and a line that grows on its own are
            // three different problems with three different responses.
            const SEVERITY_WORDS = {
              watch: 'a cap or a licence somebody else enforces',
              usage: 'billed per use, and nothing here counts the uses',
              growth: 'grows on its own as the app gets used',
            };
            // A watchlist figure of null is the whole point of the list: no
            // number can be defended, so it must read as unknown. Printing $0
            // for it would say the opposite of what is known.
            const watchCost = (w) => (
              Number.isFinite(w.usd)
                ? (w.usd === 0 ? 'nothing on a bill today' : `${money(w.usd)} today`)
                : 'no figure that can be defended, so it reads as unknown rather than as free'
            );
            const fixedById = {};
            for (const e of (fixed.monthly || [])) fixedById[e.id] = { ...e, period: '/mo' };
            for (const e of (fixed.annual || [])) fixedById[e.id] = { ...e, period: '/yr' };
            for (const e of (fixed.oneTime || [])) fixedById[e.id] = { ...e, period: ', once' };

            const depLine = { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.4 };
            const groupLabel = { fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '2px 0 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' };
            const groupNote = { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 6px 2px', lineHeight: 1.4 };

            // Four different facts share the right-hand slot on an inventory
            // row and they must not be allowed to look alike: a measured
            // figure, a flat bill, a zero that has a reason, and no number at
            // all. The last one is the reason this is a function and not a
            // template: printing $0.00 for something nobody counted would
            // claim coverage this panel does not have.
            const depCost = (e) => {
              if (e.fixedId && fixedById[e.fixedId]) {
                const f = fixedById[e.fixedId];
                return Number.isFinite(f.usd) ? `${money(f.usd, 0)}${f.period}` : 'No figure';
              }
              if (e.unknownCost) return 'Unknown';
              const o = e.observedLineId ? obsById[e.observedLineId] : null;
              if (o && Number.isFinite(o.usd)) {
                if (o.usd === 0) return '$0';
                return `${money(o.usd, 4)}${Number.isFinite(o.usdHigh) && o.usdHigh > o.usd ? ` to ${money(o.usdHigh, 4)}` : ''}`;
              }
              if (o) return o.unpriceable ? 'No rate on file' : 'Not measured';
              if (e.group === 'free') return '$0';
              return 'Not measured';
            };

            const depUsage = (e) => {
              const o = e.observedLineId ? obsById[e.observedLineId] : null;
              if (!o) return e.usageNote || 'Not measured. Nothing in this repo counts it.';
              if (o.count === null) return `Not measured. The meter did not report.`;
              return `${count(o.count)} ${o.unit}, ${o.window}.`;
            };

            const depConfigured = (e) => {
              if (e.configured === true) return `Configured, ${e.configuredVia} is set.`;
              if (e.configured === false) {
                const names = (e.configuredEnv || []).join(' or ');
                return names ? `Not configured. ${names} is unset on the server.` : 'Not configured.';
              }
              return e.configuredNote || 'The server cannot see whether this is configured.';
            };

            const depBlock = (e, i) => {
              const w = e.watchlistId ? watchById[e.watchlistId] : null;
              return (
                <div key={e.id} style={{ padding: i === 0 ? '0 0 9px' : '9px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                    <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{e.label}</span>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, whiteSpace: 'nowrap' }}>{depCost(e)}</span>
                  </div>
                  <p style={depLine}>{e.what} Lives in {e.where}.</p>
                  <p style={depLine}>
                    Price: {e.unitPrice || (e.unpriceable ? 'no published rate on file for this model id' : 'no published unit price')}.
                    {e.freeTier ? ` Free tier: ${e.freeTier}.` : ''}
                  </p>
                  <p style={depLine}>Usage: {depUsage(e)} {depConfigured(e)}</p>
                  {e.costsNothingBecause && <p style={depLine}>{e.costsNothingBecause}</p>}
                  {e.unknownAction && <p style={depLine}>{e.unknownAction}</p>}
                  {e.note && <p style={depLine}>{e.note}</p>}
                  {w && (
                    <p style={depLine}>
                      On the watchlist, {SEVERITY_WORDS[w.severity] || w.severity}: {watchCost(w)}. {w.note}
                    </p>
                  )}
                  {e.source && <p style={depLine}>{e.source}, checked {e.checked}.</p>}
                </div>
              );
            };

            // Two totals a person actually wants: what leaves the account every
            // month regardless of use, and what the usage on top of it is
            // running at. They are added only where both are real.
            //
            // THE EXPENSE LIST IS PART OF THE ALL-IN FIGURE (2026-09-25). No
            // tooling bill is written into costModel.js any more; those bills,
            // and the company's other costs, are rows in business_expenses, and
            // a row can stand in for a code line. d.expenses carries the same
            // arithmetic the Overview tab uses (moneyHub.js costsLedger), each
            // bill counted once, so the two tabs cannot disagree. A list that
            // could not be read falls back to the code figures and says so.
            const ledger = d.expenses && d.expenses.status === 'ok' ? d.expenses : null;
            const allInMonthly = ledger
              ? ledger.burnMonthlyUsd
              : (Number.isFinite(fixed.effectiveMonthlyUsd) ? fixed.effectiveMonthlyUsd + reconciledTotal : null);

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

                {/* 1. THE ONE NUMBER THAT IS A BILL */}
                <div style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                    <div>
                      <h3 style={h3}>What this actually costs</h3>
                      <p style={sub}>Fixed bills plus the metered spend a human has reconciled against a vendor invoice.</p>
                    </div>
                    <button className="hit44" disabled={costsLoading} onClick={() => fetchCosts()}
                      style={{ border: 'none', background: 'transparent', cursor: costsLoading ? 'default' : 'pointer', padding: '4px', flexShrink: 0 }}>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>{costsLoading ? 'Reading' : 'Refresh'}</span>
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div>
                      <p style={kicker}>All in, monthly</p>
                      <p style={big}>{moneyOr(allInMonthly, 'Not measured', 0)}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {ledger
                          ? `The code's fixed bills, the reconciled invoice, and ${ledger.activeRows} ${ledger.activeRows === 1 ? 'bill' : 'bills'} from the expense list, each counted once.`
                          : `${moneyOr(fixed.effectiveMonthlyUsd, 'no fixed total', 0)} of fixed bills, plus ${moneyOr(reconciledTotal, 'nothing', 0)} of metered vendor spend. ${d.expenses && d.expenses.readError ? d.expenses.readError : 'The expense list was not read.'}`}
                      </p>
                    </div>
                    <div>
                      <p style={kicker}>Reconciled</p>
                      <p style={big}>{moneyOr(reconciledTotal, 'None on file', 0)}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        Read off vendor billing pages by hand{d.reconciled?.asOf ? ` on ${d.reconciled.asOf}` : ''}. Nothing in the app can verify it, so it is only as current as that date.
                      </p>
                    </div>
                  </div>
                  {/* RECORD A PAID INVOICE HERE, NOT IN CODE. Until 2026-09-01
                      this figure was a constant in services/costModel.js, and
                      recording a bill meant editing that file and deploying.
                      Each line below saves to cost_reconciled through the
                      admin route; the panel, the cost heartbeat and the DECA
                      financial model all read the saved entry. A line marked
                      "from code" has never been recorded here. */}
                  {d.reconciled && Array.isArray(d.reconciled.lines) && (
                    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-default)' }}>
                      <p style={kicker}>Record a paid invoice</p>
                      {d.reconciled.lines.map((l) => (
                        <ReconciledLineForm key={l.id} line={l} colors={colors} onSaved={() => fetchCosts()} />
                      ))}
                      {d.reconciled.readError && (
                        <p style={foot}>The saved entries could not be read ({d.reconciled.readError}), so the figures above are the code fallback.</p>
                      )}
                    </div>
                  )}
                  {/* WHICH NUMBER IS THE COST OF SERVICE. The all-in figure
                      above carries the tools the app is built with, which no
                      user causes. Those bills come from the expense list now
                      (kind 'tooling'), not from costModel.js. Quoting the
                      all-in figure as what a venue costs to serve is the wrong
                      number, so the two halves are named here and the
                      break-even is computed at render time rather than typed
                      in, so it cannot drift when a bill changes. */}
                  {(() => {
                    const infra = ledger
                      ? ledger.infrastructureMonthlyUsd
                      : (Number.isFinite(fixed.infrastructureMonthlyUsd) ? fixed.infrastructureMonthlyUsd + reconciledTotal : null);
                    const tooling = ledger ? ledger.toolingMonthlyUsd : null;
                    const price = Number.isFinite(d.venues?.priceUsd) && d.venues.priceUsd > 0 ? d.venues.priceUsd : null;
                    const venuesFor = (usd) => (price && Number.isFinite(usd) ? Math.ceil(usd / price) : null);
                    const infraVenues = venuesFor(infra);
                    const allVenues = venuesFor(allInMonthly);
                    const plural = (n) => (n === 1 ? 'venue' : 'venues');
                    return (
                      <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-default)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                          <div>
                            <p style={kicker}>Serving venues</p>
                            <p style={big}>{moneyOr(infra, 'Not measured', 0)}</p>
                            <p style={{ ...sub, margin: '3px 0 0' }}>Hosting, data vendors and the reconciled Google bill. This is the number to quote as what it costs to serve.</p>
                          </div>
                          <div>
                            <p style={kicker}>Development tooling</p>
                            <p style={big}>{moneyOr(tooling, 'Not read', 0)}</p>
                            <p style={{ ...sub, margin: '3px 0 0' }}>
                              {ledger
                                ? 'Real bills that no user causes, from the expense list on the Overview tab. In the all-in total, and not in the cost of service.'
                                : 'The expense list, where tooling bills live, could not be read, so this is not shown rather than shown as zero.'}
                            </p>
                          </div>
                        </div>
                        {price ? (
                          <p style={{ ...sub, margin: '10px 0 0' }}>
                            At {moneyOr(price, '', 0)} a venue, {infraVenues === null ? 'an unknown number of' : infraVenues} {plural(infraVenues)} covers serving and {allVenues === null ? 'an unknown number of' : allVenues} {plural(allVenues)} covers everything including tooling. Computed from the bills above, so it moves when they do.
                          </p>
                        ) : (
                          <p style={{ ...sub, margin: '10px 0 0' }}>Break-even in venues needs a venue price on the payload, and none was served.</p>
                        )}
                      </div>
                    );
                  })()}
                  {(d.reconciled?.lines || []).map((l) => row(l.id, l.label, `${moneyOr(l.usdPerMonth)}/mo`, l.note))}
                  {(fixed.unverifiedLines || []).length > 0 && (
                    <p style={foot}>
                      {moneyOr(fixed.unverifiedMonthlyUsd, '$0', 2)} a month and {moneyOr(fixed.unverifiedAnnualUsd, '$0', 2)} a year of that total sits on {fixed.unverifiedLines.length} {fixed.unverifiedLines.length === 1 ? 'line nobody' : 'lines nobody'} has seen on an invoice. They are counted rather than dropped, and every one is marked unverified where it is listed below.
                    </p>
                  )}
                  {fixed.oldestChecked && (
                    <p style={foot}>
                      The hand-maintained half of this was last checked between {fixed.oldestChecked} and {fixed.newestChecked}. A stale date means unverified rather than wrong.
                    </p>
                  )}
                </div>

                {/* 1b. THE INVENTORY.
                    ------------------------------------------------------------
                    The ask was for every API on this screen, including the
                    ones that cost nothing, and that turned out to be a
                    different question from the one the panel answered. The
                    blocks here are ordered by how far a number can be trusted,
                    so a vendor that charges nothing appeared in whichever of
                    them happened to mention it, and six appeared in none at
                    all: PostHog, Sentry, RevenueCat, push, Google Sign-In and
                    Sign in with Apple were on the rate card and on no screen.

                    A dependency that costs $0 is still a dependency. It is
                    still an account somebody can lock, still a terms of
                    service, still a thing that breaks. So each one gets a row
                    saying so, and the row says WHICH kind of $0 it is: inside
                    a free tier, unused, or covered by a flat fee already
                    counted somewhere else. Those are three different facts and
                    a bare zero hides which one applies.

                    Grouped rather than listed, because thirty-four identical
                    rows is unnavigable (DESIGN-STANDARD section S). Group labels sit
                    outside their container for the same reason. */}
                {dep.groups && (
                  <div style={card}>
                    <h3 style={h3}>Every API and service</h3>
                    <p style={sub}>
                      Everything Flock reaches outside itself, priced where there is a price and named where there is not. The rows resolve against the meters, the fixed bills and the watchlist rather than holding their own copy of a number.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                      <div>
                        <p style={kicker}>Dependencies</p>
                        <p style={big}>{dep.total}</p>
                        <p style={{ ...sub, margin: '3px 0 0' }}>
                          {dep.groups.map((g) => `${g.entries.length} ${g.short || g.id}`).join(', ')}.
                        </p>
                      </div>
                      <div>
                        <p style={kicker}>Without a meter</p>
                        <p style={big}>{(dep.unmeteredIds || []).length}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {dep.total}</span></p>
                        <p style={{ ...sub, margin: '3px 0 0' }}>
                          Nothing here counts their usage, so those rows read as not measured. A zero meaning no meter and a zero meaning no spend are different facts.
                        </p>
                      </div>
                    </div>
                    {(dep.unknownCostIds || []).length > 0 && (
                      <p style={foot}>
                        {dep.unknownCostIds.length} of them have no defensible figure at all and read as unknown rather than as free: {dep.unknownCostIds.map((id) => (allDeps.find((e) => e.id === id) || {}).label || id).join(', ')}. Each one says where to go and find the number.
                      </p>
                    )}
                    {(d.watchlist || []).length > 0 && (
                      <p style={foot}>
                        {d.watchlist.length} of them are on the watchlist: not on a bill today, and each one could be. The exposure and how it would arrive are on that vendor's own row rather than in a second list of the same vendors.
                      </p>
                    )}
                  </div>
                )}

                {(dep.groups || []).map((g) => (
                  <div key={g.id}>
                    <p style={groupLabel}>{g.label}</p>
                    <p style={groupNote}>{g.note}</p>
                    <div style={card}>
                      {g.entries.map(depBlock)}
                    </div>
                  </div>
                ))}

                {/* 2. FIXED.
                    ------------------------------------------------------------
                    THE WHOLE STANDING BILL, in the three periods it actually
                    arrives in. Monthly and annual used to be one undifferentiated
                    stack of rows under a single spread figure, so the two
                    questions a person asks here, what leaves the account this
                    month and what is committed for the year, could only be
                    answered by adding rows up by hand.

                    Both totals are shown, and the annual one is shown twice on
                    purpose: as the yearly figure, which is what the invoice
                    says, and as its monthly twelfth, which is the only form
                    that can be added to the monthly figure. The sum of those
                    two is the effective monthly burn on the row below. */}
                <div style={card}>
                  <h3 style={h3}>Fixed, whether anyone uses it or not</h3>
                  <p style={sub}>
                    Maintained by hand in backend/services/costModel.js. Every line below carries the date a human last checked it and whether the figure came off an invoice or a pricing page. Update the file when a bill changes. Bills the code does not carry are on the expense list on the Overview tab.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '4px' }}>
                    <div>
                      <p style={kicker}>Recurring monthly</p>
                      <p style={big}>{moneyOr(fixed.monthlyUsd, 'None on file', 0)}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {(fixed.monthly || []).length} {(fixed.monthly || []).length === 1 ? 'bill' : 'bills'} that arrive every month.
                      </p>
                    </div>
                    <div>
                      <p style={kicker}>Committed annually</p>
                      <p style={big}>{moneyOr(fixed.annualUsd, 'None on file', 0)}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {(fixed.annual || []).length} {(fixed.annual || []).length === 1 ? 'bill' : 'bills'} that arrive once a year, which is {moneyOr(fixed.annualPerMonthUsd, 'nothing')} a month once spread.
                      </p>
                    </div>
                  </div>
                  {(fixed.monthly || []).map((e) => fixedRow(e, '/mo'))}
                  {(fixed.annual || []).map((e) => fixedRow(e, '/yr'))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', marginTop: '4px', borderTop: '1px solid var(--border-default)' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>Monthly bills plus the annual ones spread over twelve months</span>
                    <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{moneyOr(fixed.effectiveMonthlyUsd)}<span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/mo</span></span>
                  </div>
                  {/* One-time spend sits below that line and never inside it.
                      Money already spent and money that arrives again next
                      month are different facts, and the only way to keep them
                      apart on one panel is to keep the one-time figure out of
                      every monthly total on it. */}
                  {(fixed.oneTime || []).map((e) => fixedRow(e, ', once'))}
                  {Number.isFinite(fixed.oneTimeUsd) && fixed.oneTimeUsd > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', marginTop: '4px', borderTop: '1px solid var(--border-default)' }}>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>Spent once, and in no monthly figure above</span>
                      <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{moneyOr(fixed.oneTimeUsd, 'None on file', 0)}</span>
                    </div>
                  )}
                  {(fixed.unverifiedLines || []).length > 0 && (
                    <p style={foot}>
                      {fixed.unverifiedLines.length} {fixed.unverifiedLines.length === 1 ? 'line is' : 'lines are'} a published vendor price or an assumption rather than an invoice you have seen: {fixed.unverifiedLines.join(', ')}. They are counted in every total above, marked unverified on their own row, and worth {moneyOr(fixed.unverifiedMonthlyUsd, '$0', 2)} a month and {moneyOr(fixed.unverifiedAnnualUsd, '$0', 2)} a year between them.
                    </p>
                  )}
                </div>

                {/* 2b. PLANS AND TIERS. Nobody could answer, from any
                    screen, what the tiers are or who is on them. Every figure
                    here is read from the payload rather than typed in, and a
                    zero is always printed next to the flag that explains it,
                    because nobody on a paid tier while enforcement is off is a
                    different fact from nobody wanting one. */}
                {d.plans && (() => {
                  const pl = d.plans;
                  const vt = pl.venueTiers || null;
                  const onOff = (v) => (v ? 'on' : 'off');
                  const n = (v) => (Number.isFinite(v) ? v : 'unknown');
                  return (
                    <div style={card}>
                      <h3 style={h3}>Plans and tiers</h3>
                      <p style={sub}>What each tier is, what it gates, and how many accounts sit on it right now.</p>

                      <p style={{ ...kicker, marginTop: '10px' }}>Venue side</p>
                      <p style={{ ...sub, margin: '2px 0 8px' }}>
                        Two plans: a free venue account, and Roost at {moneyOr(pl.venuePriceUsd, 'an unset price', 0)} a location a month, stored as tier pro. Tier enforcement is <strong>{onOff(pl.venueBillingEnforced)}</strong>{pl.venueBillingEnforced ? '' : ', so the counts below describe what is written on each profile, not what anyone is being charged for'}.
                      </p>
                      {vt ? (
                        <>
                          {row('tier-pro', 'Roost', `${n(vt.pro)} ${vt.pro === 1 ? 'venue' : 'venues'}`, 'The paid plan. Gates the routes listed below.')}
                          {row('tier-premium', 'Roost, older value', `${n(vt.premium)} ${vt.premium === 1 ? 'venue' : 'venues'}`, 'Stored as premium, the word a retired middle plan left behind. The gates read it as Roost and nothing sells it.')}
                          {row('tier-free', 'Free', `${n(vt.free)} ${vt.free === 1 ? 'venue' : 'venues'}`, 'The listing, reviews and replies, the live number, deals, events and the incoming-flocks feed.')}
                          {row('tier-total', 'Venue profiles', `${n(vt.total)}`, 'Every profile with any tier value.')}
                        </>
                      ) : (
                        <p style={foot}>Tier counts could not be read.</p>
                      )}
                      {row('tier-paying', 'Paying venues', `${n(d.venues?.paying)}`, 'Active, trialing or past due subscriptions granted as paid. The only row here that is money.')}
                      {Array.isArray(pl.proGates) && pl.proGates.length > 0 && (
                        <p style={{ ...foot, marginTop: '8px' }}>
                          Roost gates exactly these routes and nothing else: {pl.proGates.join(', ')}. Promoted placement and slow-night offers were cut and are not gated by anything, because they do not exist.
                        </p>
                      )}

                      <p style={{ ...kicker, marginTop: '14px' }}>Consumer side</p>
                      <p style={{ ...sub, margin: '2px 0 8px' }}>
                        The paywall is <strong>{onOff(pl.consumerPaywallEnabled)}</strong>{pl.consumerPaywallEnabled ? '' : ', so nobody can buy premium and a zero below means the door is shut, not that nobody knocked'}. RevenueCat webhook is <strong>{pl.revenuecatConfigured ? 'configured' : 'not configured'}</strong>{pl.revenuecatConfigured ? '' : ', and it is the only writer of the premium flag, so it cannot be set right now'}.
                      </p>
                      {row('consumer-premium', 'Premium users', `${n(pl.consumerPremium)}`, 'users.is_premium, written only by the RevenueCat webhook.')}
                    </div>
                  );
                })()}

                {/* 3. OBSERVED */}
                <div style={card}>
                  <h3 style={h3}>What the meters counted</h3>
                  <p style={sub}>
                    Real usage, priced at the rate card. This is an estimate of a bill and not a bill. Lines marked as this process only live in one container's memory, so they read zero after every deploy and do not add up across a month.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '4px' }}>
                    <div>
                      <p style={kicker}>Today so far</p>
                      <p style={big}>
                        {moneyOr(obs.todayUsd, 'Not measured')}
                        {Number.isFinite(obs.todayUsdHigh) && obs.todayUsdHigh > obs.todayUsd && (
                          <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> to {money(obs.todayUsdHigh)}</span>
                        )}
                      </p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>A band where a meter counted calls without recording which SKU they were.</p>
                    </div>
                    <div>
                      <p style={kicker}>Coverage</p>
                      <p style={big}>{(obs.lines || []).length - (obs.unmeasuredLines || []).length}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {(obs.lines || []).length}</span></p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {(obs.unmeasuredLines || []).length === 0 ? 'Every meter reported.' : `Not reporting: ${obs.unmeasuredLines.join(', ')}.`}
                      </p>
                    </div>
                  </div>
                  {(obs.lines || []).map((l) => row(
                    l.id,
                    l.label,
                    l.usd === null
                      ? (l.unpriceable ? 'No rate on file' : 'Not measured')
                      : `${money(l.usd, 4)}${Number.isFinite(l.usdHigh) && l.usdHigh > l.usd ? ` to ${money(l.usdHigh, 4)}` : ''}`,
                    `${count(l.count) === null ? 'Nothing reported' : `${count(l.count)} ${l.unit}`}, ${l.window}.${l.freeTier ? ' Inside a free tier.' : ''}`
                  ))}
                  {(obs.unpriceableLines || []).length > 0 && (
                    <p style={foot}>
                      A model id with no published rate on file reads as unpriced rather than free. BIRDIE_MODEL and ADVISOR_MODEL are switchable from Railway with no deploy, so a swap changes what a token costs without changing any ceiling.
                    </p>
                  )}
                </div>

                {/* 3b. THE PHOTO BUDGET.
                    Its own panel rather than another row in the observed list,
                    for one reason: it is the only ceiling on this screen that a
                    person is expected to RAISE. Every other number here is a
                    thing to watch. This one is a decision, and if it is ever
                    reached the right response is usually to buy more photos
                    rather than to show fewer. It is also the line that has
                    historically taken almost the whole Google bill, and until
                    2026-08-20 its meter lived in memory, so it read zero after
                    every deploy and understated the spend by the most on
                    exactly the days there was the most of it. */}
                {d.photoBudget && (() => {
                  const pb = d.photoBudget;
                  const lim = pb.limits || {};
                  const monthPct = lim.fetchesPerMonth
                    ? Math.min(100, Math.round((pb.monthUsed / lim.fetchesPerMonth) * 100))
                    : null;
                  const tight = monthPct !== null && monthPct >= 80;
                  return (
                    <div key="photo-budget" style={{ ...card, border: tight ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>Venue photos</h3>
                      <p style={sub}>
                        Google charges for each photo Flock buys, and Flock keeps every one it buys for thirty days in Postgres, so this counts venues photographed rather than cards viewed. A photo already bought costs nothing to show again, however many people look at it.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>This month</p>
                          <p style={big}>
                            {count(pb.monthUsed)}
                            <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {count(lim.fetchesPerMonth)}</span>
                          </p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {moneyOr(pb.monthUsd, 'nothing yet')} so far. The first {count(lim.freePerMonth)} photos a month are free.
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Budget</p>
                          <p style={big}>{moneyOr(lim.budgetUsdPerYear, 'Not set', 0)}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/yr</span></p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            Set in backend/services/photoStore.js, or by PHOTO_BUDGET_USD_PER_YEAR on Railway. Every other photo limit is derived from it.
                          </p>
                        </div>
                      </div>
                      {row('photo-day', 'Bought today', `${count(pb.dayUsed)} of ${count(lim.burstPerDay)}`,
                        'A daily brake at three times the even pace, so one bad day cannot spend the month.')}
                      {row('photo-month-left', 'Left this month', count(pb.monthRemaining),
                        tight
                          ? 'Close to the ceiling. Photos already bought keep showing. A venue nobody has looked at this month would have no picture until the 1st, so this is the moment to raise the budget.'
                          : 'Reaching this stops new venues being bought. It never blanks a photo that is already cached.')}
                    </div>
                  );
                })()}

                {/* 3c. THE QUOTA CAPS.
                    ------------------------------------------------------------
                    Every other ceiling on this screen is one this repo wrote for
                    itself and can raise with a deploy. These four are Google's.
                    They were set by hand in the Cloud console on 2026-08-20,
                    they refuse the call rather than slowing it down, and only a
                    person with console access can move one. That makes hitting
                    a quota a real failure mode with a shape a user can see: a
                    venue card with no picture, a search that finds nothing, an
                    owner dashboard with no competitors. */}
                {d.googleQuotas && (() => {
                  const q = d.googleQuotas;
                  const pb = d.photoBudget;
                  return (
                    <div key="google-quotas" style={card}>
                      <h3 style={h3}>Google quota caps</h3>
                      <p style={sub}>
                        Set by hand in the Cloud console on {q.checked}, on project {q.project}. A quota refuses the call. It does not slow it down and it does not queue it.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>Caps the month at</p>
                          <p style={big}>{moneyOr(q.perMonthUsdAfterFree, 'Not priced', 0)}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {moneyOr(q.perMonthUsdGross, 'nothing', 0)} before each SKU keeps its own free allowance, which is named on its row below. Every quota spent every day, which nothing has ever done.
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Budget alert</p>
                          <p style={big}>{moneyOr(q.budget?.usdPerMonth, 'None', 0)}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/mo</span></p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            Named {q.budget?.name}. It emails at {(q.budget?.alertsAtPct || []).join(', ')} percent. {q.budget?.note}
                          </p>
                        </div>
                      </div>
                      {(q.lines || []).map((l) => {
                        const isPhotos = l.id === 'photos';
                        const observed = isPhotos && pb && Number.isFinite(pb.dayUsed)
                          ? `${count(pb.dayUsed)} bought today.`
                          : 'Per SKU usage is not measured, because the shared Places ledger counts calls without recording which SKU each one was.';
                        const binding = l.bindingDaily === 'google' && Number.isFinite(l.repoDailyBrake)
                          ? ` Flock's own daily brake is ${count(l.repoDailyBrake)}, so Google refuses first.`
                          : l.bindingDaily === 'repo' && Number.isFinite(l.repoDailyBrake)
                            ? ` Flock's own daily brake is ${count(l.repoDailyBrake)}, so it refuses before Google does.`
                            : '';
                        return row(
                          `quota-${l.id}`,
                          l.label,
                          `${count(l.perDay)} a day`,
                          `${moneyOr(l.perMonthUsdAfterFree, 'no figure', 2)} a month at this cap, after the first ${count(l.freePerMonth)} free. ${observed}${binding}`
                        );
                      })}
                      {q.agreesWithBudget === false && (
                        <p style={foot}>
                          The four quotas no longer price at the budget beside them. One of them, or one of the rates, has been edited since they were set together. Redo the arithmetic before trusting either number.
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* 3d. CAN IMAGES BE SCREENED AT ALL.
                    ------------------------------------------------------------
                    This is the one row on the screen where $0 is ambiguous in a
                    way that matters. Every upload is screened by Cloud Vision
                    before it is stored, and moderateImage fails CLOSED: an image
                    that cannot be screened is refused. So a Vision bill of zero
                    means either that nobody uploaded anything, or that nothing
                    works and every upload in the app is being rejected. A cost
                    panel that cannot tell those apart is reporting the least
                    useful true thing available, so the server probes the
                    provider (with zero images, so it buys nothing) and reports
                    what it found rather than what it assumed. */}
                {d.visionProvider && (() => {
                  const vp = d.visionProvider;
                  const visionDep = allDeps.find((e) => e.statusKey === 'vision');
                  const headline = vp.configured === false
                    ? 'No key set'
                    : vp.reachable === true
                      ? 'Answering'
                      : vp.reachable === false
                        ? 'Refusing'
                        : 'Unknown';
                  const broken = vp.configured === false || vp.reachable === false;
                  const refusing = vp.required && broken;
                  // Four states, not two. "Screening is required and the
                  // provider did not answer the probe" is not the same as
                  // "the provider said no", and neither is the same as
                  // screening being switched off, which is the one state that
                  // puts unscreened photos in front of a thirteen year old.
                  const uploads = !vp.required
                    ? 'Unscreened'
                    : broken
                      ? 'Refused'
                      : vp.reachable === true
                        ? 'Screened'
                        : 'Unknown';
                  return (
                    <div key="vision-provider" style={{ ...card, border: refusing ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>Image screening</h3>
                      <p style={sub}>
                        Every photo is screened by Cloud Vision before it is stored, and an image that cannot be screened is refused rather than kept. That makes a Vision bill of zero two different things, so this is measured rather than assumed.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>Provider</p>
                          <p style={big}>{headline}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {vp.configured === false
                              ? 'No VISION_API_KEY on this server.'
                              : `Asked Google directly, with zero images, so the check bought nothing. Key from ${vp.keyVar}.`}
                            {vp.detail ? ` ${vp.detail}` : ''}
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Uploads</p>
                          <p style={big}>{uploads}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {uploads === 'Unscreened'
                              ? 'Screening is not required on this server, so an image that cannot be screened is stored anyway. That is the dev default and it must never be the production one.'
                              : uploads === 'Refused'
                                ? 'Screening is required and the provider is not usable, so every image upload in the app is being rejected right now.'
                                : uploads === 'Screened'
                                  ? 'Screening is required and the provider answers, which is the correct production setting.'
                                  : 'Screening is required and the probe could not reach Google, which says nothing either way. Check again before concluding anything from it.'}
                          </p>
                        </div>
                      </div>
                      {row('vision-last', 'Last real screen',
                        vp.lastOutcome ? (vp.lastOutcome.ok ? 'Answered' : 'Failed') : 'None yet',
                        vp.lastOutcome
                          ? `${new Date(vp.lastOutcome.at).toLocaleString()}.${vp.lastOutcome.detail ? ` ${vp.lastOutcome.detail}` : ''} Counted in this container's memory, so it resets on every deploy.`
                          : 'No image has been screened since this container started. That is normal on a quiet day and says nothing either way.')}
                      {visionDep && visionDep.finding && <p style={foot}>{visionDep.finding}</p>}
                    </div>
                  );
                })()}

                {/* PUSH DELIVERY. The one subsystem whose failure is completely
                    silent: an invite that never left the building and one that
                    landed on a lock screen look identical from every other
                    screen in this app, and the user-visible symptom of a dead
                    push system ("nobody answered") is the same as the product
                    simply being quiet. Migration 050 built push_sends to answer
                    it and nothing read the table, which is the same amount of
                    evidence as not having built it. This is the reader.

                    Suppressions are listed rather than summed into one number
                    because they are not one thing. "Everyone was already
                    looking" is the system working; "nobody has a device
                    registered" is the whole feature being off for that person;
                    "held until morning" is a notification that still exists.
                    A single Suppressed count would hide all three behind each
                    other. */}
                {d.pushDelivery && (() => {
                  const p = d.pushDelivery;
                  const t = p.totals || {};
                  const byOutcome = {};
                  for (const r of (p.byTypeAndOutcome || [])) {
                    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + r.pushes;
                  }
                  // Every outcome services/pushHelper.js can write, in the
                  // order a person reads them: what landed, then what did not
                  // and why. A key that arrives without an entry here still
                  // renders, under its own raw name, because an unexplained
                  // count is better than a count silently dropped.
                  const WORDS = {
                    delivered: 'Reached at least one device',
                    failed: 'The provider refused or timed out',
                    'no-device': 'Nobody had a device registered',
                    online: 'Every device was already looking',
                    debounced: 'Same conversation, inside 30 seconds',
                    'not-visible': 'Left the plan, blocked, or banned',
                    'opted-out': 'Crowd alerts switched off',
                    'quiet-held': 'Held for the morning',
                    'quiet-dropped': 'Dropped, because a crowd alert at 3am is about last night',
                    expired: 'Given up on before it could be sent',
                  };
                  const ORDER = ['delivered', 'failed', 'quiet-held', 'expired', 'no-device', 'online', 'debounced', 'not-visible', 'opted-out', 'quiet-dropped'];
                  const seen = Object.keys(byOutcome);
                  const ordered = [
                    ...ORDER.filter((k) => seen.includes(k)),
                    ...seen.filter((k) => !ORDER.includes(k)).sort(),
                  ];
                  const attempts = Number.isFinite(t.attempts) ? t.attempts : null;
                  // A number the sentence below interpolates, so it has to be a
                  // number. count() answers null for anything unmeasured, and
                  // "null devices reached" reads as a bug rather than as an
                  // absence.
                  const reached = Number.isFinite(t.devicesReached) ? t.devicesReached : 0;
                  return (
                    <div key="push-delivery" style={{ ...card, border: p.configured === false ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>Push delivery</h3>
                      <p style={sub}>
                        Every notification this app sends passes through one place and writes a row there, so this is the whole record for the last {p.days} days. It holds no titles, no message bodies and no device tokens. Rows are kept for 30 days and then deleted.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>Landed</p>
                          <p style={big}>{count(t.delivered) || 'Not measured'}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {attempts === null
                              ? 'The ledger could not be read, which says nothing either way.'
                              : attempts === 0
                                ? 'Nothing has been attempted in this window at all. On a product with no users that is the expected reading, and it is not evidence that delivery works.'
                                : `${count(reached)} device${reached === 1 ? '' : 's'} reached across ${count(attempts)} attempt${attempts === 1 ? '' : 's'}.`}
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Provider</p>
                          <p style={big}>{p.configured === false ? 'Switched off' : 'Configured'}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {p.configured === false
                              ? 'FIREBASE_SERVICE_ACCOUNT is not set on this server, so every notification in the app is a no-op and no row below can be anything but a skip.'
                              : 'FIREBASE_SERVICE_ACCOUNT is set, so a count of zero below means nothing was sent rather than that sending is off.'}
                          </p>
                        </div>
                      </div>
                      {ordered.length === 0
                        ? <p style={foot}>No push has been attempted in the last {p.days} days.</p>
                        : ordered.map((k) => row(`push-${k}`, WORDS[k] || k, count(byOutcome[k])))}
                    </div>
                  );
                })()}

                {/* THE MODEL VERSUS THE FALLBACK.
                    routes/admin.js has served this block since 2026-08-26 and
                    nothing rendered it, which is the same half-finished shape
                    the push ledger above was in: the number that answers "is
                    the trained model actually doing the work" was computed,
                    carried across the wire, pinned by two server tests, and
                    shown to nobody.
                    It answers the one question the ONNX model exists to be
                    judged on. services/crowdEngine.js is the rule-based
                    fallback and it is used whenever the model files are
                    missing, the ship gate fails, features mismatch, a venue has
                    no baseline, or inference throws. Every one of those is
                    silent. A model that loaded and then served nothing looks
                    identical, from outside, to a model that is working. */}
                {d.predictionCoverage && (() => {
                  const p = d.predictionCoverage;
                  const total = Number.isFinite(p.total) ? p.total : null;
                  const ml = Number.isFinite(p.ml) ? p.ml : 0;
                  const share = Number.isFinite(p.modelShare) ? Math.round(p.modelShare * 100) : null;
                  return (
                    <div key="prediction-coverage" style={{ ...card, border: p.modelLoaded === false ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>Crowd model versus the fallback</h3>
                      <p style={sub}>
                        Which engine actually answered. This counter lives in the server's memory, so it starts again from nothing on every deploy and reads the time since the last restart rather than all time. A small number here is not evidence the model is unused.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>Answered by the model</p>
                          <p style={big}>{share === null ? 'Not measured' : `${share}%`}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {total === null
                              ? 'The meter could not be read, which says nothing either way.'
                              : total === 0
                                ? 'Nothing has asked for a forecast since the last deploy, so neither engine has run.'
                                : `${count(ml)} of ${count(total)} forecast${total === 1 ? '' : 's'}. The rest came from the rule engine.`}
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Model file</p>
                          <p style={big}>{p.modelLoaded ? (p.modelVersion || 'Loaded') : 'Not loaded'}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {p.modelLoaded
                              ? 'The ONNX model is in memory and available to serve.'
                              : 'Every forecast is coming from the rule engine. That is the designed fallback and the product still works, but the trained model is earning nothing.'}
                          </p>
                        </div>
                      </div>
                      {p.since && (
                        <p style={{ ...sub, margin: '10px 0 0' }}>Counting since {new Date(p.since).toLocaleString()}.</p>
                      )}
                    </div>
                  );
                })()}

                {/* 4. ONE VENUE */}
                <div style={card}>
                  <h3 style={h3}>One venue at {moneyOr(v.priceUsd, 'the list price', 0)} a month</h3>
                  <p style={sub}>
                    Gemini is the only per-venue cost that scales with use. The ceiling below is that venue's own daily token cap, spent in full every day of the month, which is the most one venue can possibly cost.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div>
                      <p style={kicker}>Costs at most</p>
                      <p style={big}>{moneyOr(v.ceilingMonthlyUsdHigh, 'Not priced')}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {Number.isFinite(v.ceilingMonthlyUsdLow) ? `From ${money(v.ceilingMonthlyUsdLow)} if every token were input.` : 'No rate on file for this model.'}
                      </p>
                    </div>
                    <div>
                      <p style={kicker}>Gross margin</p>
                      <p style={big}>{Number.isFinite(v.ceilingMarginPct) ? `${v.ceilingMarginPct}%` : 'Not priced'}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>Against the dear end of the band, before any payment processing.</p>
                    </div>
                  </div>
                  {Number.isFinite(v.laterCeilingMonthlyUsd) && v.laterFrom && row(
                    'later',
                    `Same ceiling from ${v.laterFrom}`,
                    `${moneyOr(v.laterCeilingMonthlyUsd)}/mo`,
                    `${v.model} is on promotional pricing that doubles on that date. Margin becomes ${v.laterCeilingMarginPct}%.`
                  )}
                  {row(
                    'observed-venue',
                    'Busiest venue this month, actual',
                    v.observedMonthlyUsd === null ? 'Not measured' : money(v.observedMonthlyUsd, 4),
                    v.observedTokensMonth === null
                      ? 'No venue has spent a Roost token this month, so there is nothing to price. This stays empty until one does.'
                      : `${count(v.observedTokensMonth)} tokens. Margin ${v.observedMarginPct}%.`
                  )}
                  {row(
                    'paying',
                    'Venues paying today',
                    Number.isFinite(d.venues?.paying) ? String(d.venues.paying) : 'Not measured',
                    'From venue_subscriptions. Venue billing is built and stays off until VENUE_BILLING_ENABLED is set; the Overview tab reads Stripe directly.'
                  )}
                </div>

                {/* 5. CEILINGS. Dashed, and it never touches an observed figure. */}
                <div style={{ ...card, boxShadow: 'none', border: `1px dashed ${colors.creamDark}` }}>
                  <h3 style={h3}>If every ceiling were hit, every day</h3>
                  <p style={sub}>
                    Not spend. Not a forecast. This is what the limits written into the code permit before something refuses, and nothing has ever come close to one of them. It is here so the worst case is a number rather than a worry.
                  </p>
                  <div>
                    <p style={kicker}>Would cost, monthly</p>
                    <p style={big}>
                      {moneyOr(worst.perMonthUsd, 'Not priced', 0)}
                      {Number.isFinite(worst.perMonthUsdHigh) && worst.perMonthUsdHigh > worst.perMonthUsd && (
                        <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> to {money(worst.perMonthUsdHigh, 0)}</span>
                      )}
                    </p>
                  </div>
                  {(worst.lines || []).map((l) => row(
                    l.id,
                    l.label,
                    l.perMonthUsd === null
                      ? 'Not priced'
                      : `${money(l.perMonthUsd, 0)}${Number.isFinite(l.perMonthUsdHigh) && l.perMonthUsdHigh > l.perMonthUsd ? ` to ${money(l.perMonthUsdHigh, 0)}` : ''}/mo`,
                    `${count(l.ceiling) === null ? 'No ceiling on file' : `${count(l.ceiling)} ${l.ceilingUnit}`}.${l.note ? ` ${l.note}` : ''}`
                  ))}
                </div>

                {/* 6. The watchlist used to be its own panel here, listing
                    eight vendors that all appear on the inventory above. Two
                    lists of the same vendors on one screen is worse than one:
                    the reader has to work out whether the second list is a
                    subset, a contradiction or an update. The long-form note on
                    each watchlist entry is now rendered inside that vendor's
                    inventory row, so the prose still has exactly one home and
                    the screen has one list. costModel.WATCHLIST is unchanged
                    and is still what the row resolves against. */}

                {/* 7. PROVENANCE */}
                <div style={{ ...card, boxShadow: 'none', backgroundColor: 'transparent', padding: '0 2px' }}>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.5 }}>
                    {Object.keys(d.rates?.checked || {}).length} groups on the rate card, each one named on its own row above with its own source and date. The oldest was checked {Object.values(d.rates?.checked || {}).sort()[0] || 'never'}.
                    {' '}Vendors change published prices without telling anyone, so a stale date means unverified, not wrong.
                    {d.generatedAt ? ` Read at ${new Date(d.generatedAt).toLocaleString()}.` : ''}
                  </p>
                </div>
              </div>
            );
          })()}

          {activeTab === 'projections' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Deleted 2026-08-13, all three fabricated:
                    • "12-Month Projection" — $18K/$28K/$38K/$46K quarters and
                      Y1 $130K / Y2 $435K / Y3 $1.14M, with a bar chart whose
                      heights were literally `40 + i * 20` pixels.
                    • "EOY Targets" — a current column reading 8,500 users,
                      167 venue partners, 4 cities, $10.8K monthly revenue,
                      and progress bars derived from those.
                    • "Key Insights" — Austin saturation, 24% Pro conversion,
                      acquisition cost down 15% MoM.
                  Flock has roughly zero users, no venue partners, no cities,
                  no revenue and a paywall that has never been switched on, so
                  every one of those was invented. They sat directly above the
                  real hand-maintained expense figures and borrowed credibility
                  from them. Inventing metrics is banned outright (DESIGN-STANDARD
                  H13), and the fake venue analytics tab went the same way on
                  2026-08-12. What replaces them is burn and break-even, which
                  are computed from the expense arrays below. */}

              {/* Growth Levers */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Growth Levers</h3>
                {[
                  { lever: 'Venue Acquisition', impact: 'High', effort: 'Medium', icon: Icons.building },
                  { lever: 'User Referrals', impact: 'High', effort: 'Low', icon: Icons.users },
                  { lever: 'City Expansion', impact: 'Very High', effort: 'High', icon: Icons.globe },
                  { lever: 'Premium Upsells', impact: 'Medium', effort: 'Low', icon: Icons.sparkles },
                ].map(item => (
                  <div key={item.lever} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {item.icon(colors.navy, 14)}
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{item.lever}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: item.impact === 'Very High' ? 'var(--accent-green-bg)' : item.impact === 'High' ? 'var(--accent-blue-bg)' : 'var(--accent-amber-bg)', color: item.impact === 'Very High' ? 'var(--accent-green-text)' : item.impact === 'High' ? 'var(--accent-blue-text)' : 'var(--accent-amber-text)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                        {item.impact}
                      </span>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                        {item.effort}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Burn and break-even.
                  ------------------------------------------------------------
                  These used to be computed from a MONTHLY / ANNUAL / ONE_TIME
                  array typed into this file. That array was the real
                  spend and it was five vendors out of date: it knew about
                  Railway, the two developer tools, the Apple fee and the
                  BestTime corpus, and had never heard of Gemini, Google Places, Cloud
                  Vision, MapTiler or the domain. It also sat two tabs away
                  from a set of API ceilings nobody had ever priced.

                  The arrays now live in backend/services/costModel.js, which
                  is where the rate card and the meters are, and this panel
                  reads the same payload the Costs tab does. One source, so a
                  changed bill changes both. The full picture, including what
                  the meters have actually spent and what the ceilings would
                  permit, is on the Costs tab; this is the two-number version
                  the projections need.

                  Still true of everything below: nothing here is a
                  measurement of anything that has happened. */}
              {(() => {
                const fixed = costsData && costsData.fixed;
                // Flock Pro, monthly plan, as the code states it. The money hub
                // sets this beside the price Stripe charges
                // (backend/services/statedPrices.js), so a change on either
                // side shows as a disagreement on the Overview tab.
                const PRO_MONTHLY_USD = 3.99;

                if (!fixed) {
                  return (
                    <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}`, marginBottom: '12px' }}>
                      <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Burn and break-even</h4>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                        {costsLoading
                          ? 'Reading the cost model.'
                          : costsError
                            ? 'The cost model did not load, so there is no burn figure to show. Nothing is guessed in its place.'
                            : 'The cost model has not been read yet.'}
                      </p>
                      {!costsLoading && (
                        <button className="hit44 glass-btn glass-primary" onClick={() => fetchCosts()} style={{ ...styles.gradientButton, padding: '12px', marginTop: '10px' }}>
                          {costsError ? 'Try again' : 'Read the cost model'}
                        </button>
                      )}
                    </div>
                  );
                }

                const monthlyTotal = fixed.monthlyUsd;
                const annualTotal = fixed.annualUsd;
                // The burn is the same figure the Costs tab calls all in: the
                // code's bills, the reconciled invoice and the expense list,
                // each counted once. The list below stays the code's own lines.
                const ledger = costsData.expenses && costsData.expenses.status === 'ok' ? costsData.expenses : null;
                const effectiveMonthly = ledger ? ledger.burnMonthlyUsd : fixed.effectiveMonthlyUsd;
                const subsToBreakEven = effectiveMonthly > 0 ? Math.ceil(effectiveMonthly / PRO_MONTHLY_USD) : 0;
                const usd0 = (n) => `$${Math.round(n).toLocaleString()}`;
                const row = (name, amount, sub) => (
                  <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', borderTop: '1px solid var(--border-light)' }}>
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{name}</span>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{amount}<span style={{ fontWeight: '500', color: 'var(--text-tertiary)' }}>{sub}</span></span>
                  </div>
                );
                return (
                  <>
                  <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)', marginBottom: '12px' }}>
                    <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Burn and break-even</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                      <div>
                        <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Monthly burn</p>
                        <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '2px 0 0', lineHeight: 1.1 }}>{usd0(effectiveMonthly)}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '3px 0 0' }}>
                          {ledger
                            ? 'Every recurring bill at its monthly rate: the code’s fixed bills, the reconciled invoice and the expense list.'
                            : `${usd0(monthlyTotal)}/mo recurring plus ${usd0(annualTotal)}/yr spread over twelve months. The expense list could not be read, so its bills are not in this.`}
                        </p>
                      </div>
                      <div>
                        <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Target to cover it</p>
                        <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '2px 0 0', lineHeight: 1.1 }}>{subsToBreakEven}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '3px 0 0' }}>Flock Pro subscriptions at ${PRO_MONTHLY_USD.toFixed(2)}/mo, before Apple's cut.</p>
                      </div>
                    </div>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '10px 0 0', paddingTop: '8px', borderTop: '1px solid var(--border-light)' }}>
                      {subsToBreakEven} is what break-even would take at this price, not a count of anything. Subscribers and revenue are counted on the Overview tab, after fees.
                    </p>
                  </div>
                  <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                      <h4 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>Fixed expenses in the code</h4>
                      <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{usd0(fixed.effectiveMonthlyUsd)}<span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/mo effective</span></span>
                    </div>
                    {/* A LINE NOBODY HAS SEEN ON AN INVOICE SAYS SO HERE TOO.
                        This list printed a label and a number and nothing
                        else, so Vercel's assumed $0 read as a confirmed free
                        tier and the domain's $12 placeholder read as a bill.
                        The Costs tab carries the reason for each one; this tab
                        carries the mark, because a figure that is marked on one
                        screen and bare on the next is not marked. */}
                    {(fixed.monthly || []).map((e) => row(e.verified ? e.label : `${e.label} (unverified)`, `$${e.usd}`, '/mo'))}
                    {(fixed.annual || []).map((e) => row(e.verified ? e.label : `${e.label} (unverified)`, `$${e.usd}`, '/yr'))}
                    {(fixed.oneTime || []).map((e) => row(e.verified ? e.label : `${e.label} (unverified)`, `$${e.usd.toLocaleString()}`, ' once'))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0 0', marginTop: '3px', borderTop: '1px solid var(--border-default)' }}>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>Recurring {usd0(monthlyTotal)}/mo plus {usd0(annualTotal)}/yr</span>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>One-time invested: {usd0(fixed.oneTimeUsd)}</span>
                    </div>
                    {(fixed.unverifiedLines || []).length > 0 && (
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '7px 0 0', lineHeight: 1.4 }}>
                        {fixed.unverifiedLines.length} {fixed.unverifiedLines.length === 1 ? 'line is' : 'lines are'} a published price or an assumption rather than an invoice, marked above and counted in the burn anyway. The Costs tab says what each one assumes and where to confirm it.
                      </p>
                    )}
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '7px 0 0', lineHeight: 1.4 }}>
                      Vendors on free tiers, and what each meter has actually spent, are on the Costs tab. Bills the code does not carry, such as the tools the app is built with, are on the Overview tab&apos;s expense list and in the burn above.
                    </p>
                  </div>
                  </>
                );
              })()}

              {/* Where the projection charts used to be. An honest empty state
                  beats a plausible-looking fake. */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}`, marginBottom: '12px' }}>
                <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Revenue and growth</h4>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>
                  No chart here. Real revenue, subscribers and recurring revenue are on the Overview tab, read from Stripe and RevenueCat. A chart waits until those numbers have a history worth drawing.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'research' && (() => {
            const demoMode = researchDemoMode;
            const data = demoMode ? {
              totalFlocks: 2340, completionRate: 78, avgGroupSize: 4.8, budgetAdoptionRate: 72,
              avgTimeToConfirmation: 5, totalUsers: 8500, newUsersThisWeek: 247,
              stallPointDistribution: [
                { stall_point: 'completed', count: 1825 }, { stall_point: 'venue', count: 198 },
                { stall_point: 'rsvp', count: 164 }, { stall_point: 'confirmation', count: 98 },
                { stall_point: 'budget', count: 55 },
              ],
              reliabilityDistribution: { reliable: 3240, moderate: 1870, flaky: 390, unscored: 3000 },
            } : researchLiveData;

            // The toggle, in one place so the two directions stay symmetrical.
            const modeToggle = (
              <button className="hit44" disabled={researchLoading} onClick={() => { if (demoMode) fetchResearchLive(); else setResearchDemoMode(true); }}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '6px', width: '100%', border: 'none', background: 'transparent', cursor: researchLoading ? 'default' : 'pointer' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '3px', background: demoMode ? '#D97706' : colors.steel }} />
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>{researchLoading ? 'Reading the database...' : demoMode ? 'Demo data · Tap for live' : 'Live data · Tap for demo'}</span>
              </button>
            );

            // Nothing has been measured: the read is in flight, it failed, or
            // it has not happened. None of those is a zero, and printing them
            // as zeros under a "Live data" label is inventing a measurement.
            if (!data) {
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '20px 14px', textAlign: 'center', boxShadow: 'var(--card-shadow-sm)' }} role="status">
                    {!researchLoading && <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />}
                    <h3 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 6px' }}>
                      {researchLoading ? 'Reading the database' : researchError ? 'These numbers did not load' : 'Nothing read yet'}
                    </h3>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                      {researchLoading
                        ? 'One moment.'
                        : researchError
                          ? 'The analytics request failed, so there is nothing here to show. This is not a reading of zero.'
                          : 'Tap below to read the live numbers, or switch to demo data.'}
                    </p>
                    {!researchLoading && (
                      <button className="hit44 glass-btn glass-primary" onClick={() => fetchResearchLive()} style={{ ...styles.gradientButton, padding: '12px', marginTop: '14px' }}>
                        {researchError ? 'Try again' : 'Read live numbers'}
                      </button>
                    )}
                  </div>
                  {modeToggle}
                </div>
              );
            }

            const stallColors = { completed: colors.steel, venue: '#F59E0B', rsvp: '#EF4444', confirmation: '#4a7ba7', budget: '#3B82F6' };
            const stallTotal = (data.stallPointDistribution || []).reduce((s, p) => s + parseInt(p.count), 0) || 1;
            // A field the response did not carry is not a zero either, so it
            // says so rather than rendering one.
            const has = (v) => typeof v === 'number' && Number.isFinite(v);
            const stat = (v, render) => (has(v) ? render(v) : 'No data');
            const statCards = [
              { label: 'Total Flocks', value: stat(data.totalFlocks, (v) => v.toLocaleString()), color: colors.navy },
              { label: 'Completion Rate', value: stat(data.completionRate, (v) => `${v}%`), color: colors.steel },
              { label: 'Avg Group Size', value: stat(data.avgGroupSize, (v) => v), color: colors.navy },
              { label: 'Budget Adoption', value: stat(data.budgetAdoptionRate, (v) => `${v}%`), color: colors.steel },
              { label: 'Time to Confirm', value: stat(data.avgTimeToConfirmation, (v) => `${v}m`), color: colors.navy },
              { label: 'Total Users', value: stat(data.totalUsers, (v) => v.toLocaleString()), color: colors.navy },
            ];
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                  {statCards.map(s => (
                    <div key={s.label} style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: 'var(--card-shadow-sm)' }}>
                      <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: s.color, margin: '0 0 2px' }}>{s.value}</p>
                      <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{s.label}</p>
                    </div>
                  ))}
                </div>
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                  <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Where Flocks Stall</h3>
                  {(data.stallPointDistribution || []).map(p => {
                    const pct = Math.round((parseInt(p.count) / stallTotal) * 100);
                    return (
                      <div key={p.stall_point} style={{ marginBottom: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                          <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, textTransform: 'capitalize' }}>{p.stall_point}</span>
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{p.count} ({pct}%)</span>
                        </div>
                        <div style={{ height: '8px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, backgroundColor: stallColors[p.stall_point] || colors.navy, borderRadius: '4px' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                  <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>User Reliability</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                    {[
                      { label: '80%+', value: data.reliabilityDistribution?.reliable || 0, color: colors.steel },
                      { label: '50-79%', value: data.reliabilityDistribution?.moderate || 0, color: '#F59E0B' },
                      { label: '<50%', value: data.reliabilityDistribution?.flaky || 0, color: '#EF4444' },
                      { label: 'New', value: data.reliabilityDistribution?.unscored || 0, color: 'var(--text-secondary)' },
                    ].map(item => (
                      <div key={item.label} style={{ textAlign: 'center', padding: '8px 4px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)' }}>
                        <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: item.color, margin: '0 0 2px' }}>{item.value}</p>
                        <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', margin: 0 }}>{item.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)', textAlign: 'center' }}>
                  <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', margin: '0 0 4px' }}>New Users This Week</p>
                  <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.steel, margin: 0 }}>
                    {has(data.newUsersThisWeek) ? `+${data.newUsersThisWeek.toLocaleString()}` : 'No data'}
                  </p>
                </div>
                {modeToggle}
              </div>
            );
          })()}
        </div>
      </div>
    );
}
