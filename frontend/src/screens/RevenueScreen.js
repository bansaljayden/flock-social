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
 * The body below started as the old block verbatim, including its original
 * four-space indentation, so it could be diffed against the deleted lines
 * character for character. Its look was rebuilt in November 2026 (THE LOOK,
 * below): figures first, as tiles, bars and status chips, and every
 * explanation one tap away under the figure it explains. The arithmetic and
 * the words did not change.
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
  exportAdminExpenses,
  getAdminKeys,
  getAdminMoneyHub,
  importAdminExpenses,
  revokeAdminKey,
  updateAdminExpense,
} from '../services/api';
import {
  HUB_CARD,
  hubAgo,
  hubAnd,
  hubAttention,
  hubCapMoney,
  hubCount,
  hubDay,
  hubGaps,
  hubGapSentence,
  hubMoney,
  hubMonthTiles,
  hubNeeds,
  hubPlural,
  hubSummaryWords,
  hubTime,
} from '../lib/moneyHubSummary';

// Saves the expense list as a CSV file. The server sends the text inside its
// usual signed-in JSON answer, and the file is made here, so no file link
// has to carry a sign-in.
async function downloadExpensesCsv() {
  const r = await exportAdminExpenses();
  const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = r.filename || 'flock-expenses.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return r;
}

// One reconciled line's save form. Amount, date, and a note that is optional
// and short. Saving posts through the admin route and then the parent refetches
// the whole costs payload, so what the card shows afterwards is what the server
// merged, never what this form thinks it sent. There is one form per line the
// server lists (Google Cloud off its invoice, Railway off its own estimated
// bill), each dated on its own, and `readFrom` says where the figure is read.
// The device's own date, not the UTC date: after 8 PM Eastern the UTC day has
// already rolled, and the picker offered, and defaulted to, tomorrow.
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function ReconciledLineForm({ line, onSaved, colors }) {
  const [usd, setUsd] = React.useState(Number.isFinite(line.usdPerMonth) ? String(line.usdPerMonth) : '');
  const [asOf, setAsOf] = React.useState(localToday());
  // Starts empty rather than holding the line's current note: a note describes
  // one invoice, and saving a new amount under the old one's words is what put
  // the September explanation beside every later figure. Left empty, the saved
  // entry carries no note at all (costModel.readReconciled).
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await saveAdminReconciled({ id: line.id, usdPerMonth: Number(usd), asOf, note: note.trim() || undefined });
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
      <span style={small}>{line.label} <span style={{ color: 'var(--text-tertiary)' }}>({line.source === 'dashboard' ? `saved ${line.asOf}` : `from code as of ${line.asOf}, never recorded here`})</span></span>
      {line.readFrom && <span style={{ ...small, color: 'var(--text-tertiary)' }}>Read it from {line.readFrom}.</span>}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ ...small, display: 'flex', alignItems: 'center', gap: '6px' }}>
          $
          <input aria-label={`Monthly amount for ${line.label}`} type="number" min="0" step="0.01" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} style={{ ...input, width: '110px' }} />
        </label>
        <input aria-label={`Date read for ${line.label}`} type="date" value={asOf} max={localToday()} onChange={(e) => setAsOf(e.target.value)} style={input} />
        <input aria-label={`Note for ${line.label}`} type="text" maxLength={500} placeholder="Note, optional" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...input, flex: '1 1 160px' }} />
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
// which reads Stripe, RevenueCat, BestTime's key endpoint, the cost model, the
// expense list, the served forecasts and the collector's own rows, and checks
// the steps only the operator can take where the server can see them. Nothing
// here does arithmetic beyond formatting, for the reason the Costs tab gives:
// the sums belong next to the sources they read, where they cannot drift from
// them.
//
// A source that did not answer shows the server's words for why, and no
// number. A zero appears only when a source answered with zero.

// The last good payload, kept across a trip to another tab or screen so the
// hub paints at once on return while it reads again. The server holds the
// vendor answers for a few minutes, so reading again costs Stripe nothing.
const hubMemo = { data: null, subs: new Set() };
// Tells whoever is listening that the hub's figures changed, so a tab that
// was open before they arrived (Projections, seeding its operating cost)
// hears about them; a module object alone re-renders nothing.
function hubMemoChanged() {
  for (const fn of hubMemo.subs) {
    try { fn(); } catch (e) { /* a listener's failure is its own */ }
  }
}

const HUB_KIND_LABEL = {
  infrastructure: 'Running the app',
  tooling: 'Building it',
  legal: 'Legal and company',
  other: 'Other',
};
const HUB_CADENCE_LABEL = { monthly: 'a month', quarterly: 'a quarter', yearly: 'a year', usage: 'a month, usage', one_time: 'once' };
const HUB_PLAN_LABEL = { monthly: 'monthly', yearly: 'yearly', founding: 'founding rate', other: 'other plans' };
const HUB_STORE_LABEL = {
  app_store: 'App Store',
  promotional: 'Promotional grants',
  play_store: 'Google Play',
  rc_billing: 'RevenueCat web billing',
  other: 'Other stores',
};

const hubStyle = {
  // scrollMarginTop so a card the attention list jumps to lands with a gap
  // above it rather than flush against the tab bar.
  card: { backgroundColor: 'var(--bg-card-solid)', border: '1px solid var(--border-default)', borderRadius: '14px', padding: '14px', boxShadow: 'var(--card-shadow-sm)', minWidth: 0, scrollMarginTop: '12px' },
  sub: { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.45 },
  // A heading inside a card, in sentence case. It used to be the type scale's
  // uppercase eyebrow, a role the scale keeps to twice a screen, and the hub
  // drew it more than forty times.
  kicker: { fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '16px 0 4px', lineHeight: 1.3 },
  big: { fontSize: 'var(--t-display)', fontWeight: '600', margin: '2px 0 0', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
  note: { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.45, overflowWrap: 'anywhere' },
  foot: { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.45, overflowWrap: 'anywhere' },
  input: { padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', minWidth: 0, width: '100%', boxSizing: 'border-box' },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: 'var(--t-micro)', fontWeight: '600', color: 'var(--text-secondary)', flex: '1 1 130px', minWidth: 0 },
  // A quiet button with an outline, the Nest's ghost button.
  textButton: { display: 'inline-flex', alignItems: 'center', gap: '5px', border: '1px solid var(--border-default)', background: 'transparent', borderRadius: '8px', padding: '6px 10px', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)', cursor: 'pointer' },
  // A command to paste. One tap selects all of it, and it wraps rather than
  // scrolling sideways on a narrow phone.
  command: { display: 'block', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--t-meta)', color: 'var(--text-primary)', background: 'var(--bg-tertiary)', borderRadius: '8px', padding: '8px', margin: '6px 0 2px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'all', WebkitUserSelect: 'all' },
  link: { display: 'inline-block', marginTop: '4px', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)', textDecoration: 'underline', textUnderlineOffset: '2px' },
};

const HUB_TONE = {
  good: 'var(--accent-green-text)',
  bad: 'var(--accent-red-text)',
  warn: 'var(--accent-amber-text)',
  muted: 'var(--text-tertiary)',
};
// The wash each tone's text is designed against (index.css), in both themes.
const HUB_TONE_BG = {
  good: 'var(--accent-green-bg)',
  bad: 'var(--accent-red-bg)',
  warn: 'var(--accent-amber-bg)',
  muted: 'var(--bg-tertiary)',
};

// A short status word beside a label: Optional, Unverified, Stated. Sentence
// case at the meta size, on its tone's own wash.
function hubTag(tone) {
  return {
    display: 'inline-block',
    fontSize: 'var(--t-meta)',
    fontWeight: '600',
    color: HUB_TONE[tone] || 'var(--text-secondary)',
    backgroundColor: HUB_TONE_BG[tone] || 'var(--bg-tertiary)',
    borderRadius: '999px',
    padding: '0 7px',
    marginLeft: '6px',
    lineHeight: 1.6,
    whiteSpace: 'nowrap',
  };
}

// A whole-percent share from the server. One that rounds to 0 reads as under
// 1%, never as a 0% that looks free.
const hubShare = (pct) => (Number.isFinite(pct) ? (pct < 1 ? 'Under 1%' : `${pct}%`) : 'An unknown share');

// ===========================================================================
// THE LOOK: the parts every card here is built from.
// ===========================================================================
//
// The hub used to be cards of sentences. Every figure carried where it came
// from in a paragraph under it, which kept each number honest and made the
// page slow to read: the month alone was taller than a phone screen. Now the
// figures come first, as tiles, bars and status chips, and each explanation
// sits one tap away under the figure it explains: the row itself opens, or a
// "How this is counted" line does. Nothing was deleted. Every sentence is
// still on the page, inside a native <details>, so the keyboard opens it, a
// screen reader says whether it is open, and nothing has to remember which
// ones are.
//
// The stylesheet holds only what an inline style cannot say: the disclosure's
// own marker hidden, the chevron turning, the grids changing shape between a
// phone and the wide console, and hover. Its class names start with hub- so
// nothing else in the app can match them, and it ships in this lazily loaded
// screen, so it costs the rest of the app nothing. Colours are the theme's
// tokens, which index.css redefines for dark, so both themes are the same
// stylesheet.
const HUB_CSS = `
.hub-root { --hub-c1: #2d5a87; --hub-c2: #a3bfdc; --hub-c3: #586376; --hub-c4: #d8d2c6; }
[data-theme="dark"] .hub-root { --hub-c1: #6d9ac3; --hub-c2: #c8c3b2; --hub-c3: #7c8aa0; --hub-c4: #3f5068; }
.hub-root details > summary { list-style: none; cursor: pointer; }
.hub-root details > summary::-webkit-details-marker { display: none; }
.hub-root details > summary::marker { content: ''; }
.hub-chev { display: inline-flex; align-items: center; flex-shrink: 0; align-self: center; color: var(--text-tertiary); transition: transform 0.15s ease; }
.hub-disclose[open] > summary .hub-chev { transform: rotate(90deg); }
.hub-disclose > summary { border-radius: 8px; margin: 0 -6px; padding: 0 6px; }
@media (hover: hover) { .hub-disclose > summary:hover { background-color: var(--bg-hover); } }

.hub-card { background-color: var(--bg-card-solid); border: 1px solid var(--border-default); border-radius: 14px; padding: 14px; box-shadow: var(--card-shadow-sm); min-width: 0; scroll-margin-top: 12px; }
.hub-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin: 0 0 6px; }
.hub-card-title { font-size: var(--t-title); font-weight: 700; color: var(--text-primary); margin: 0; line-height: 1.25; }
.hub-card-sub { font-size: var(--t-meta); color: var(--text-secondary); margin: 3px 0 0; line-height: 1.45; }
.hub-chips { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; flex-shrink: 0; max-width: 60%; }
.hub-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: var(--t-meta); font-weight: 600; line-height: 1.5; white-space: nowrap; font-variant-numeric: tabular-nums; }

.hub-row { border-top: 1px solid var(--border-light); }
.hub-row-head { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 0; box-sizing: border-box; }
.hub-row-label { flex: 1 1 auto; min-width: 0; font-size: var(--t-meta); color: var(--text-secondary); overflow-wrap: anywhere; line-height: 1.4; }
.hub-row-value { flex-shrink: 0; font-size: var(--t-meta); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hub-row-sub { font-size: var(--t-meta); color: var(--text-tertiary); margin: -4px 0 0; padding: 0 0 8px; line-height: 1.4; }
.hub-row-more { padding: 0 0 10px; }
.hub-note { font-size: var(--t-meta); color: var(--text-secondary); margin: 0 0 4px; line-height: 1.5; overflow-wrap: anywhere; }

.hub-why { margin-top: 6px; }
.hub-why > summary { display: block; }
.hub-why-row { display: inline-flex; align-items: center; gap: 4px; font-size: var(--t-meta); font-weight: 600; color: var(--text-secondary); min-height: 32px; }
.hub-why-body p { font-size: var(--t-meta); color: var(--text-secondary); margin: 2px 0 8px; line-height: 1.5; overflow-wrap: anywhere; }
.hub-why-body p:last-child { margin-bottom: 2px; }

.hub-month { margin: 0 0 12px; }
.hub-month-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 2px 2px 10px; }
.hub-month-title { font-family: var(--font-display); font-size: var(--t-display); font-weight: 600; letter-spacing: -0.005em; line-height: 1.1; color: var(--text-primary); margin: 0; }
.hub-month-sub { font-size: var(--t-meta); color: var(--text-secondary); margin: 5px 0 0; line-height: 1.4; }
.hub-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; align-items: start; }
.hub-tile { background-color: var(--bg-card-solid); border: 1px solid var(--border-default); border-radius: 14px; padding: 12px; box-shadow: var(--card-shadow-sm); min-width: 0; }
.hub-tile-label { font-size: var(--t-label); font-weight: 600; color: var(--text-secondary); margin: 0; line-height: 1.3; }
.hub-tile-value { font-size: var(--t-display); font-weight: 600; margin: 6px 0 0; line-height: 1.1; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.hub-tile-sub { font-size: var(--t-meta); color: var(--text-tertiary); margin: 5px 0 0; line-height: 1.4; }
@media (min-width: 760px) { .hub-tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; } .hub-tile { padding: 14px; } .hub-tiles.hub-tiles-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 359px) { .hub-tile { padding: 10px; } .hub-tile-value { font-size: var(--t-title); } }

.hub-pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; margin: 0 0 12px; }
.hub-halves { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px 20px; }
@media (min-width: 900px) { .hub-pair { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .hub-halves { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }

.hub-need { border-top: 1px solid var(--border-light); }
.hub-need-head { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 0; box-sizing: border-box; }
.hub-need-icon { display: inline-flex; flex-shrink: 0; }
.hub-need-label { flex: 1 1 auto; min-width: 0; font-size: var(--t-label); font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; line-height: 1.35; }
.hub-need-more { padding: 0 0 12px 26px; }

.hub-track { position: relative; height: 8px; border-radius: 4px; background-color: var(--bg-tertiary); overflow: hidden; }
.hub-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
.hub-bar { padding: 9px 0 7px; border-top: 1px solid var(--border-light); }
.hub-bar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 0 0 6px; }
.hub-bar-label { font-size: var(--t-meta); color: var(--text-secondary); min-width: 0; overflow-wrap: anywhere; line-height: 1.4; }
.hub-bar-value { font-size: var(--t-meta); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hub-bar-note { font-size: var(--t-meta); color: var(--text-tertiary); margin: 5px 0 0; line-height: 1.4; }

.hub-meter { position: relative; height: 10px; margin: 8px 0 6px; border-radius: 5px; background-color: var(--bg-tertiary); }
.hub-meter-band { position: absolute; top: 0; bottom: 0; border-radius: 5px; }
.hub-meter-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; }
.hub-meter-mark { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background-color: var(--text-secondary); }

.hub-stack { display: flex; gap: 2px; height: 12px; border-radius: 6px; overflow: hidden; background-color: var(--bg-tertiary); }
.hub-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0 0; font-size: var(--t-meta); color: var(--text-secondary); }
.hub-legend > span { display: inline-flex; align-items: center; gap: 6px; }
.hub-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }

.hub-minis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 2px 0 10px; }
.hub-mini { border-radius: 10px; background-color: var(--bg-hover); padding: 8px 10px; min-width: 0; }
.hub-mini-label { font-size: var(--t-meta); color: var(--text-tertiary); margin: 0; line-height: 1.3; }
.hub-mini-value { font-size: var(--t-label); font-weight: 700; color: var(--text-primary); margin: 2px 0 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

.hub-tl { margin: 4px 0 6px; }
.hub-tl-track { position: relative; }
.hub-tl-axis { position: absolute; left: 0; right: 0; height: 2px; border-radius: 1px; background-color: var(--border-default); }
.hub-tl-tick { position: absolute; width: 2px; height: 8px; margin-left: -1px; border-radius: 1px; background-color: var(--border-default); }
.hub-tl-dot { position: absolute; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; box-sizing: border-box; }
.hub-tl-labels { position: relative; height: 1.5em; font-size: var(--t-meta); line-height: 1.5; color: var(--text-tertiary); margin-top: 4px; }
.hub-tl-labels > span { position: absolute; top: 0; white-space: nowrap; }
.hub-tl-mid { transform: translateX(-50%); }
.hub-tl-end { right: 0; }

.hub-sim { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; margin: 0 0 12px; }
.hub-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (min-width: 900px) { .hub-sim { grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); } }
@media (max-width: 359px) { .hub-fields { grid-template-columns: minmax(0, 1fr); } }
.hub-stack-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.hub-stack-col:empty { display: none; }
.hub-pair > :only-child, .hub-halves > :only-child { grid-column: 1 / -1; }
@media (min-width: 900px) { .hub-pair:has(> .hub-stack-col:empty) { grid-template-columns: minmax(0, 1fr); } }
.hub-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 2px 0 8px; }
@media (min-width: 760px) { .hub-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.hub-stat { border-radius: 10px; background-color: var(--bg-hover); padding: 10px 12px; min-width: 0; }
.hub-stat-label { font-size: var(--t-meta); font-weight: 600; color: var(--text-secondary); margin: 0; line-height: 1.3; }
.hub-stat-value { font-size: var(--t-title); font-weight: 700; color: var(--text-primary); margin: 4px 0 0; line-height: 1.15; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.hub-stat-note { font-size: var(--t-meta); color: var(--text-tertiary); margin: 4px 0 0; line-height: 1.4; overflow-wrap: anywhere; }
`;

// A status word on its tone's wash, for a card's header or a row's value.
function HubChip({ tone = 'muted', children, icon = null }) {
  return (
    <span className="hub-chip" style={{ color: HUB_TONE[tone] || 'var(--text-secondary)', backgroundColor: HUB_TONE_BG[tone] || 'var(--bg-tertiary)' }}>
      {icon}{children}
    </span>
  );
}

// The chevron on everything that opens. Decorative: the disclosure itself
// tells assistive tech whether it is open.
const hubChevron = () => <span className="hub-chev">{Icons.chevronRight('currentColor', 14)}</span>;

// A card: a heading, an optional line under it, and a chip or two on the
// right that answer the card's question before anything inside it is read.
// data-hub-card marks the card for the jumps and the tests alike.
function HubCard({ id, title, sub, chips = null, children, style, className = '' }) {
  return (
    <section id={id} data-hub-card="" className={`hub-card ${className}`.trim()} style={style}>
      {(title || chips) && (
        <div className="hub-card-head">
          <div style={{ minWidth: 0 }}>
            {title && <h3 className="hub-card-title">{title}</h3>}
            {sub && <p className="hub-card-sub">{sub}</p>}
          </div>
          {chips && <div className="hub-chips">{chips}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

// "How this is counted": the sentences that explain a figure, behind one tap.
// Each string is its own paragraph; anything else is drawn as it comes.
function HubWhy({ children, label = 'How this is counted' }) {
  const parts = (Array.isArray(children) ? children : [children]).filter((c) => c !== null && c !== undefined && c !== false && c !== '');
  if (parts.length === 0) return null;
  return (
    <details className="hub-disclose hub-why">
      <summary className="hit44"><span className="hub-why-row">{label}{hubChevron()}</span></summary>
      <div className="hub-why-body">
        {parts.map((p, i) => (typeof p === 'string' ? <p key={`why-${i}`}>{p}</p> : <React.Fragment key={`why-${i}`}>{p}</React.Fragment>))}
      </div>
    </details>
  );
}

// One labelled figure in a card. The label and the value are always on the
// line; the note that says where the figure came from, and anything that goes
// with it (a command, a link out), is behind a tap on the row itself, so a
// card of twelve figures reads as twelve lines. `sub` is a short line that
// stays visible under the label, for what the figure means at a glance.
// `chip` draws the value on its tone's wash, for a state rather than an amount.
// data-hub-fig marks the row for the tests, the way data-hub-card marks a card.
function HubRow({ label, value, note, tone, tag, navy, children, sub, chip = false }) {
  const shown = value !== undefined && value !== null && value !== '';
  const valueNode = !shown ? null : chip
    ? <HubChip tone={tone}>{value}</HubChip>
    : <span className="hub-row-value" style={{ color: HUB_TONE[tone] || navy }}>{value}</span>;
  const more = !!note || React.Children.toArray(children).length > 0;
  const head = (
    <div className="hub-row-head">
      <span className="hub-row-label">
        {label}
        {tag && <span style={hubTag(tag.tone)}>{tag.text}</span>}
      </span>
      {valueNode}
      {more && hubChevron()}
    </div>
  );
  const subLine = sub ? <div className="hub-row-sub">{sub}</div> : null;
  if (!more) {
    return <div className="hub-row" data-hub-fig="">{head}{subLine}</div>;
  }
  return (
    <details className="hub-row hub-disclose" data-hub-fig="">
      <summary className="hit44">{head}{subLine}</summary>
      <div className="hub-row-more">
        {note && <p className="hub-note">{note}</p>}
        {children}
      </div>
    </details>
  );
}

// A big figure on a tile of its own: what it is, the number, a short line on
// what the number means, and how it is counted one tap below. `wash` tints the
// tile with the accent background its tone's text is designed against.
function HubTile({ label, value, tone, sub, why, navy, wash }) {
  return (
    <div className="hub-tile" data-hub-fig="" style={wash ? { backgroundColor: wash } : undefined}>
      <p className="hub-tile-label">{label}</p>
      <p className="hub-tile-value" style={{ color: HUB_TONE[tone] || navy }}>{value}</p>
      {sub && <p className="hub-tile-sub">{sub}</p>}
      {why && <HubWhy>{why}</HubWhy>}
    </div>
  );
}

// A row of figures as horizontal bars on one scale, the largest full width,
// or on a scale given as `max` (100 for shares of a whole). The bars are drawn
// from the server's own figures and never add anything up; each row's words
// carry the number, so the bars are hidden from assistive tech and a screen
// reader reads the list as text.
function HubBarList({ rows, color, max: scale }) {
  const max = Number.isFinite(scale) && scale > 0 ? scale : rows.reduce((m, r) => (Number.isFinite(r.value) && r.value > m ? r.value : m), 0);
  return (
    <div>
      {rows.map((r) => (
        <div key={r.key} className="hub-bar" data-hub-fig="">
          <div className="hub-bar-head">
            <span className="hub-bar-label">{r.label}</span>
            <span className="hub-bar-value" style={{ color: r.valueColor || 'var(--text-primary)' }}>{r.valueText}</span>
          </div>
          <div className="hub-track" aria-hidden="true">
            {Number.isFinite(r.value) && max > 0 && r.value > 0 && (
              <div className="hub-fill" style={{ width: `${Math.max(2, Math.min(100, (r.value / max) * 100))}%`, backgroundColor: r.color || color }} />
            )}
          </div>
          {r.note && <p className="hub-bar-note">{r.note}</p>}
        </div>
      ))}
    </div>
  );
}

// A count against a target: how far along, with the target as a mark or, for
// a target that is a range, a shaded band from its low end to its high end.
// Decorative like the bars: the line beside it says the numbers.
function HubMeter({ value, low, high, color }) {
  const top = Math.max(Number.isFinite(high) ? high : 0, Number.isFinite(low) ? low : 0, Number.isFinite(value) ? value : 0);
  if (!(top > 0)) return null;
  const scale = top * 1.08;
  const at = (n) => `${Math.min(100, Math.max(0, (n / scale) * 100))}%`;
  const range = Number.isFinite(low) && Number.isFinite(high) && high > low;
  return (
    <div className="hub-meter" aria-hidden="true">
      {range && <div className="hub-meter-band" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})`, backgroundColor: 'var(--border-default)' }} />}
      {Number.isFinite(value) && value > 0 && <div className="hub-meter-fill" style={{ width: at(value), minWidth: '6px', backgroundColor: color }} />}
      {Number.isFinite(low) && <span className="hub-meter-mark" style={{ left: at(low) }} />}
      {range && <span className="hub-meter-mark" style={{ left: at(high) }} />}
    </div>
  );
}

// The words for a source that gave no numbers. `not_connected` means nothing
// was asked because the key is not set; anything else means it was asked.
function HubNotice({ status, reason }) {
  const word = status === 'not_connected' ? 'Not connected' : status === 'refused' ? 'Key cannot read this' : 'Could not load';
  return (
    <p style={{ ...hubStyle.note, margin: '6px 0 4px', color: 'var(--text-secondary)' }}>
      <span style={{ ...hubTag(status === 'not_connected' ? 'muted' : 'warn'), marginLeft: 0, marginRight: '6px' }}>{word}</span>
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

// THE MONTH: the four figures the owner opens the console for, as tiles, on
// the page itself under the month's name, the way the Nest puts its greeting.
// Two across on a phone, so all four are on the first screen with the tab bar
// above them, and four across on the wide console.
function HubMonth({ h, colors, loading, onRefresh }) {
  const w = hubSummaryWords(h);
  const { costsMissing, netMissing } = w;
  const m = h.month || {};
  const navy = colors.navy;
  const at = hubTime(h.generatedAt);
  const holdMinutes = Math.round(((h.cache && h.cache.ttlSeconds) || 300) / 60);
  // Each tile's figure, the short line under it and its tone come from
  // lib/moneyHubSummary.js, which the admin tool prints as well. The sentences
  // behind each tile's tap are the screen's own.
  const why = {
    in: [
      w.revenueNote,
      `Stripe and RevenueCat answers are held for ${holdMinutes} minutes${w.cachedAge !== null ? `, and this one is ${hubPlural(w.cachedAge, 'second', 'seconds')} old` : ''}.`,
    ],
    costs: costsMissing.length > 0
      ? 'The expense list could not be read, so costs are not totalled here. The Costs card below shows what could be read.'
      : 'Monthly bills in full, quarterly bills at a third, yearly bills at a twelfth, and one-time charges dated this month. Credits and refunds are taken off.',
    net: `Revenue this month less costs this month. Revenue is cash as it arrived, so a yearly plan lands whole in the month it was bought; costs are yearly and quarterly bills spread by month, so a $99 yearly bill counts as $8.25 in every month.${netMissing.length > 0 ? ` ${hubGapSentence(netMissing)}` : ''}`,
    burn: costsMissing.length > 0
      ? 'Not totalled, because the expense list could not be read.'
      : `The burn: every recurring cost at its monthly rate. One-time charges are left out.${w.endingWords}`,
  };
  return (
    <section className="hub-month" data-hub-card="" aria-labelledby="hub-month-title">
      <div className="hub-month-head">
        <div style={{ minWidth: 0 }}>
          <h2 id="hub-month-title" className="hub-month-title">{m.label || 'This month'}</h2>
          <p className="hub-month-sub">Day {m.dayOfMonth} of {m.daysInMonth}, New York time.{at ? ` Read at ${at}.` : ''}</p>
        </div>
        <button className="hit44" type="button" disabled={loading} onClick={onRefresh} style={{ ...hubStyle.textButton, cursor: loading ? 'default' : 'pointer', flexShrink: 0 }}>
          {Icons.repeat('currentColor', 12)}{loading ? 'Reading' : 'Refresh'}
        </button>
      </div>
      <div className="hub-tiles">
        {hubMonthTiles(h).map((t) => (
          <HubTile key={t.key} navy={navy} label={t.label} value={t.value} tone={t.tone} sub={t.sub} why={why[t.key]} />
        ))}
      </div>
    </section>
  );
}

// DO SUBSCRIBERS COVER THE BILLS? The month's bills beside what subscribers
// pay each month, on one scale, then how many subscribers or venues would
// cover the bills on their own, against how many pay now. The chip answers the
// title in a word before any of it is read.
function HubCover({ h, colors }) {
  const w = hubSummaryWords(h);
  const { n, be, netBurnMissing, burnMissing } = w;
  const navy = colors.navy;
  const burn = n.burnCents;
  const recurring = n.recurringNetCents;
  const netBurn = n.netBurnCents;
  const recurringMissing = hubGaps(n.recurringMissing);
  let chip = <HubChip tone="muted">Not known yet</HubChip>;
  if (Number.isFinite(netBurn)) chip = netBurn <= 0 ? <HubChip tone="good">Yes</HubChip> : <HubChip tone="warn">Not yet</HubChip>;
  const pro = be.proWeb || null;
  const proApp = be.proAppStore || null;
  const roost = be.roost || null;
  const payingPro = Number.isFinite(be.payingPro) ? be.payingPro : null;
  const payingRoost = Number.isFinite(be.payingRoost) ? be.payingRoost : null;
  const range = burnMissing.length === 0 && pro && Number.isFinite(pro.needed);
  return (
    <HubCard id="hub-cover" title="Do subscribers cover the bills?" chips={chip}>
      <HubBarList
        color={colors.steel}
        rows={[
          {
            key: 'bills',
            label: 'Monthly bills',
            value: burn,
            valueText: Number.isFinite(burn) ? `${hubMoney(burn)} a month` : 'Not read',
            color: 'var(--text-tertiary)',
          },
          {
            key: 'subscribers',
            label: 'Subscribers pay',
            value: recurring,
            valueText: Number.isFinite(recurring) ? `${hubMoney(recurring)} a month` : hubNeeds(recurringMissing),
            color: colors.steel,
            note: "After Stripe's fees and Apple's cut.",
          },
        ]}
      />
      <HubRow
        navy={navy}
        label="Still to cover each month"
        value={Number.isFinite(netBurn) ? hubMoney(netBurn) : hubNeeds(netBurnMissing)}
        tone={Number.isFinite(netBurn) && netBurn <= 0 ? 'good' : undefined}
        note={Number.isFinite(netBurn)
          ? (netBurn <= 0
            ? 'Subscribers already pay for the monthly costs, after Stripe fees and Apple’s cut.'
            : 'The burn less what subscribers pay each month, after Stripe fees and Apple’s cut.')
          : `The burn less what subscribers pay each month. ${hubGapSentence(netBurnMissing)}`}
      />
      <p style={hubStyle.kicker}>Subscribers needed to cover the bills</p>
      <HubRow
        navy={navy}
        label="Flock Pro subscribers needed"
        value={burnMissing.length > 0 ? 'Not read' : `${w.needed(pro)} web, ${w.needed(proApp)} App Store`}
        sub={(
          <>
            {range && <HubMeter value={payingPro} low={pro.needed} high={proApp && Number.isFinite(proApp.needed) ? proApp.needed : null} color={colors.steel} />}
            {payingPro !== null ? `${hubPlural(payingPro, 'subscriber pays', 'subscribers pay')} now.` : 'How many pay now is not known.'}
          </>
        )}
        note={`Subscribers needed to cover the burn on their own, at ${w.priceWords(pro)} on the web and ${w.appPriceWords(proApp)}. After Stripe fees on the web, after Apple's ${n.appleCommissionPct}% in the App Store${proApp && proApp.smallBusiness && Number.isFinite(proApp.smallBusiness.needed) ? ` (${proApp.smallBusiness.needed} at the ${proApp.smallBusiness.commissionPct}% Apple takes under the Small Business Program)` : ''}.${burnMissing.length > 0 ? ` ${hubGapSentence(burnMissing)}` : ''} Paying now: ${w.payingWords(be.payingPro, be.payingProMissing)}.`}
      />
      <HubRow
        navy={navy}
        label="Roost venues needed"
        value={burnMissing.length > 0 ? 'Not read' : w.venuesNeeded(be.roost)}
        sub={(
          <>
            {burnMissing.length === 0 && roost && Number.isFinite(roost.needed) && <HubMeter value={payingRoost} low={roost.needed} color={colors.steel} />}
            {payingRoost !== null ? `${hubPlural(payingRoost, 'venue pays', 'venues pay')} now.` : 'How many pay now is not known.'}
          </>
        )}
        note={`At ${w.priceWords(roost)}, after Stripe fees. Paying now: ${w.payingWords(be.payingRoost, be.payingRoostMissing)}.`}
      />
      {h.unitCosts && h.unitCosts.status === 'ok' && (
        <HubRow
          navy={navy}
          label="Cost per active person"
          value={Number.isFinite(h.unitCosts.perActivePersonCents) ? `${hubMoney(h.unitCosts.perActivePersonCents)}/mo` : 'Too few to say'}
          note={Number.isFinite(h.unitCosts.perActivePersonCents)
            ? `The monthly burn over the ${hubCount(h.unitCosts.activeLast7)} people active in the last 7 days.${Number.isFinite(h.unitCosts.perPlanCents) ? ` At last week's pace of ${hubCount(h.unitCosts.plansMadeLast7)} plans, each plan costs ${hubMoney(h.unitCosts.perPlanCents)}.` : ''}`
            : `Shown from ${h.unitCosts.minPeople} active people a week; ${hubCount(h.unitCosts.activeLast7)} were active in the last 7 days.`}
        />
      )}
    </HubCard>
  );
}

// ONLY YOU CAN DO THESE: the steps the code cannot take for itself
// (backend/services/moneyHub.js, ONLY YOU CAN DO THESE). The server checks the
// ones it can see and sends each as done, to do or not read, in its own
// words, with the fix as a command where there is one. The ones it cannot see
// arrive with no state, and this card marks them Check yourself rather than
// guessing. No step carries a variable's value, only whether it is set, and
// the database step names its network, private or public, never its host.
const HUB_STEP_STATE = {
  done: { text: 'Done', tone: 'good' },
  todo: { text: 'To do', tone: 'warn' },
  unknown: { text: 'Not read', tone: 'muted' },
};
const HUB_CHECK_YOURSELF = { text: 'Check yourself', tone: 'muted' };
const HUB_NETWORK_TAG = {
  private: { tone: 'good', text: 'Private network' },
  public: { tone: 'warn', text: 'Public proxy' },
};

// Only an https link is drawn. The hrefs are the server's own constants, and
// this keeps anything else from becoming a link on an admin screen.
const hubHttps = (href) => (typeof href === 'string' && /^https:\/\/\S+$/.test(href) ? href : null);

// A round trip to the precision it deserves: hundredths under a millisecond,
// tenths under ten, whole milliseconds above.
function hubMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms).toLocaleString('en-US')} ms`;
}

function hubStepSummary(counts) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const c = counts || {};
  const todo = n(c.todo);
  const optional = n(c.optionalTodo);
  const unknown = n(c.unknown);
  const done = n(c.done);
  if (todo === 0 && optional === 0 && unknown === 0) return `All ${hubCount(done)} done.`;
  const parts = [];
  if (todo > 0) parts.push(`${hubCount(todo)} to do`);
  if (optional > 0) parts.push(`${hubPlural(optional, 'optional step', 'optional steps')} not done`);
  if (unknown > 0) parts.push(`${hubCount(unknown)} not read`);
  if (done > 0) parts.push(`${hubCount(done)} done`);
  return `${parts.join(', ')}.`;
}

// MapTiler's usage this billing period, in one line, from the hub's
// costs.maptilerUsage (services/maptilerUsage.js, judged in moneyHub.js). The
// Overview's Costs card and the Costs tab's MapTiler row both print it, so the
// two cannot word the same reading differently. A meter that was not read says
// why and prints no number.
function hubMaptilerLine(u) {
  if (!u) return null;
  if (u.status === 'unset') return 'Not read yet: needs MAPTILER_SERVICE_TOKEN.';
  if (u.status !== 'read') return `Not read: ${u.reason || 'MapTiler did not answer.'}`;
  const inc = u.included || {};
  const parts = [
    `Sessions ${hubCount(u.sessions)} of ${hubCount(inc.sessions)}`,
    `Requests ${hubCount(u.requests)} of ${hubCount(inc.requests)}`,
  ];
  if (u.searchSessions > 0) parts.push(`Search sessions ${hubCount(u.searchSessions)} of ${hubCount(inc.searchSessions)}`);
  const capText = `the ${hubCapMoney(u.cap)} spending limit`;
  let pace;
  if (Number.isFinite(u.overProjectedCents)) {
    pace = `on pace for ${hubMoney(u.overProjectedCents)} over`;
  } else {
    pace = `too early in the billing period for a pace, ${hubMoney(u.overSoFarCents)} over so far`;
  }
  parts.push(pace);
  const renews = (u.period && hubDay(u.period.renewsOn)) || null;
  const until = renews || 'the next billing period';
  if (Number.isFinite(u.headroomCents) && u.headroomCents > 0) {
    return `${parts.join(' · ')}, ${hubMoney(u.headroomCents)} under ${capText}.${renews ? ` The period renews ${renews}.` : ''}`;
  }
  const where = u.capReached
    ? `at ${capText}, so every Flock map is stopped until ${until}`
    : `which reaches ${capText} before the period ends, and at the limit every Flock map stops until ${until}`;
  return `${parts.join(' · ')}, ${where}.`;
}

// Resend's email usage today and this month, in one line, from the hub's
// costs.resendUsage (services/resendUsage.js, judged in moneyHub.js). The
// Overview's Costs card and the Costs tab's Resend row both print it. A meter
// that was not read says so and prints no number, never a zero.
function hubResendLine(u) {
  if (!u) return null;
  if (u.status === 'unset') return 'Not read yet: needs RESEND_API_KEY.';
  if (u.status !== 'read') return `Not read yet: ${u.reason || 'Resend did not answer.'}`;
  const part = (w, when) => {
    if (!w || !Number.isFinite(w.used)) return `${when} not reported`;
    return Number.isFinite(w.limit) ? `${when} ${hubCount(w.used)} of ${hubCount(w.limit)}` : `${when} ${hubCount(w.used)}, no cap`;
  };
  return `Email ${part(u.daily, 'today')} · ${part(u.monthly, 'this month')}.`;
}

function HubOwnerStep({ step, navy }) {
  const checked = step.checkedBy === 'server';
  const state = checked ? (HUB_STEP_STATE[step.state] || HUB_STEP_STATE.unknown) : HUB_CHECK_YOURSELF;
  let tag = null;
  if (checked && HUB_NETWORK_TAG[step.network]) tag = HUB_NETWORK_TAG[step.network];
  else if (checked && step.lastRead === 'refused') tag = { tone: 'bad', text: 'Refused' };
  else if (checked && step.lastRead === 'failed') tag = { tone: 'warn', text: 'Not read' };
  else if (step.optional) tag = { tone: 'muted', text: 'Optional' };
  const rt = checked ? step.roundTrip : null;
  const ms = rt && rt.status === 'ok' ? hubMs(rt.ms) : null;
  const at = rt ? hubTime(rt.asOf) : null;
  const href = step.link ? hubHttps(step.link.href) : null;
  return (
    <HubRow navy={navy} label={step.label} tag={tag} value={state.text} tone={state.tone} chip note={step.words}>
      {rt && (ms
        ? <p style={hubStyle.note}>One SELECT 1 round trip took {ms}{at ? `, timed at ${at}` : ''}.</p>
        : <p style={hubStyle.note}>{rt.reason || 'The round trip was not timed, so there is no time to show.'}</p>)}
      {step.fix && <code style={hubStyle.command}>{step.fix}</code>}
      {href && (
        <a className="hit44" href={href} target="_blank" rel="noopener noreferrer" style={hubStyle.link}>
          Open {step.link.text || href}
        </a>
      )}
    </HubRow>
  );
}

function HubOwnerActions({ h, colors }) {
  const oa = h.ownerActions;
  // A server from before this block sends none of it: no card, not an empty one.
  if (!oa || !Array.isArray(oa.items)) return null;
  const navy = colors.navy;
  const checked = oa.items.filter((s) => s.checkedBy === 'server');
  const yours = oa.items.filter((s) => s.checkedBy !== 'server');
  const holdMinutes = Math.round(((h.cache && h.cache.ttlSeconds) || 300) / 60);
  const todo = oa.counts && Number.isFinite(oa.counts.todo) ? oa.counts.todo : 0;
  return (
    <HubCard
      id={HUB_CARD.steps.id}
      title="Only you can do these"
      sub="Steps the code cannot take for itself. Tap one for how it is done."
      chips={todo > 0 ? <HubChip tone="warn">{`${hubCount(todo)} to do`}</HubChip> : null}
    >
      {checked.length > 0 && (
        <>
          <p style={{ ...hubStyle.kicker, marginTop: '8px' }}>Checked by the server</p>
          <p style={{ ...hubStyle.note, margin: '0 0 4px' }}>{hubStepSummary(oa.counts)}</p>
          {checked.map((s) => <HubOwnerStep key={s.id} step={s} navy={navy} />)}
        </>
      )}
      {yours.length > 0 && (
        <>
          <p style={hubStyle.kicker}>The server cannot see these</p>
          {yours.map((s) => <HubOwnerStep key={s.id} step={s} navy={navy} />)}
        </>
      )}
      <HubWhy label="How these are checked">
        {'The server checks the ones it can see each time this page is read. The rest are marked Check yourself, with a link to where each one is done.'}
        {`Checked at ${hubTime(h.generatedAt)}. No check sends a variable's value, only whether it is set, and the database is named by its network, never by its host. The round trip is held for ${holdMinutes} minutes, like the Stripe and RevenueCat answers.`}
      </HubWhy>
    </HubCard>
  );
}

function HubRevenue({ h, colors }) {
  const r = h.revenue || {};
  const s = r.stripe || {};
  const rc = r.revenuecat || {};
  const db = r.database || {};
  const flags = r.flags || {};
  const navy = colors.navy;
  const subs = s.subscriptions || null;
  const bal = s.balance || null;
  const inv = s.invoices || null;
  const rcSubs = rc.subscribers || null;
  const overview = rc.overview || null;
  const stripeReady = s.status === 'ok';

  // What each subscription bills a month, named for what it is rather than as
  // "recurring revenue": the note under it gives the year and the fees.
  const recurringRows = (summary, prefix) => (
    <HubRow
      navy={navy}
      label={`${prefix} subscriptions bring in`}
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
  // What is switched on, as chips: green for on, quiet for off.
  const flag = (on, name) => <HubChip key={name} tone={on ? 'good' : 'muted'}>{`${name} ${on ? 'on' : 'off'}`}</HubChip>;

  return (
    <HubCard id={HUB_CARD.revenue.id} title="Revenue" sub="flockcorp.com sells through Stripe; the iOS app sells through the App Store, which RevenueCat reads.">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '2px 0 4px' }}>
        {flag(flags.paywallEnabled, 'Paywall')}
        {flag(flags.proWebCheckoutEnabled, 'Web checkout')}
        {flag(flags.venueBillingEnabled, 'Venue billing')}
      </div>
      {stripeReady && s.mode === 'test' && (
        <p style={{ ...hubStyle.note, color: 'var(--text-secondary)' }}><span style={{ ...hubTag('warn'), marginLeft: 0, marginRight: '6px' }}>Test mode</span>The Stripe key is a test key, so every Stripe figure below is test money.</p>
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
              label="App Store subscriptions bring in"
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
            {rcSubs.sandbox > 0 && <HubRow navy={navy} label="Test purchases" value={hubCount(rcSubs.sandbox)} note="Sandbox purchases by allowed accounts. No money moves." />}
            {rcSubs.premiumWithNothingLive > 0 && (
              <HubRow navy={navy} tone="warn" label="Pro with nothing live" value={hubCount(rcSubs.premiumWithNothingLive)} note="Pro in the database, and RevenueCat shows no live subscription for them. The next webhook or sync should switch them off." />
            )}
            {rcSubs.complete === false && (
              <p style={{ ...hubStyle.foot, color: 'var(--accent-amber-text)' }}>These App Store figures are incomplete, so the totals at the top leave the App Store out rather than add a part of it.</p>
            )}
            <HubWhy>
              <p>
                Read from each Pro account's own record in RevenueCat: {hubCount(rcSubs.checked)} of {hubCount(db.proAccountsCheckedWithRevenueCat)} checked{rcSubs.failed > 0 ? `, ${hubCount(rcSubs.failed)} could not be read` : ''}.
                {Number.isFinite(db.proAccounts) && db.proAccounts > db.proAccountsCheckedWithRevenueCat ? ` Only the first ${hubCount(db.proAccountsCheckedWithRevenueCat)} of ${hubCount(db.proAccounts)} Pro accounts are checked.` : ''}
              </p>
            </HubWhy>
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
      <HubRow navy={navy} label="Paying venues in Flock" value={Number.isFinite(db.payingVenues) ? hubCount(db.payingVenues) : 'Not read'} note="venue_subscriptions granted as paid and still running. A venue on a trial is not counted until it pays." />

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
          <HubRow navy={navy} label="Left after fees and refunds" value={hubMoney(bal.netCents)} tone={bal.netCents < 0 ? 'bad' : undefined} note="What the month's charges came to once refunds, disputes and Stripe's fees were taken off. Payouts to the bank are movement, not revenue, and are left out." />
          {bal.truncated && <p style={{ ...hubStyle.foot, color: 'var(--accent-amber-text)' }}>Stripe had more balance entries this month than this read pages through, so these figures are incomplete, and with refunds and disputes in them they could be off in either direction. The revenue at the top is withheld for the same reason.</p>}
          {bal.nonUsd > 0 && <p style={hubStyle.foot}>{hubPlural(bal.nonUsd, 'entry was', 'entries were')} not in US dollars and {bal.nonUsd === 1 ? 'is' : 'are'} not added.</p>}
        </>
      )}
      {stripeReady && inv && inv.status === 'ok' && (
        <>
          <HubRow navy={navy} label="Paid invoices, Flock Pro" value={hubMoney(inv.byProduct.pro.paidCents)} note={`${hubPlural(inv.byProduct.pro.invoices, 'invoice', 'invoices')}${inv.byProduct.pro.zeroInvoices > 0 ? `, ${hubCount(inv.byProduct.pro.zeroInvoices)} of them at $0 through a code` : ''}.`} />
          <HubRow navy={navy} label="Paid invoices, Roost" value={hubMoney(inv.byProduct.roost.paidCents)} note={`${hubPlural(inv.byProduct.roost.invoices, 'invoice', 'invoices')}.`} />
          {inv.byProduct.other.invoices > 0 && <HubRow navy={navy} label="Paid invoices, other" value={hubMoney(inv.byProduct.other.paidCents)} note="Invoices that name neither product, such as one made by hand in Stripe." />}
          {inv.truncated && <p style={{ ...hubStyle.foot, color: 'var(--accent-amber-text)' }}>There were more paid invoices than this read pages through, so these sums are a floor.</p>}
          <HubWhy>
            {`Paid this month, from invoices created ${Number.isFinite(inv.lookbackDays) ? `up to ${hubCount(inv.lookbackDays)} days before the month began` : 'shortly before the month began'}: Stripe's list filters on the day an invoice was made, not the day it was paid, and a failed renewal is retried for at most two months. An older invoice marked paid by hand this month would be missed.`}
          </HubWhy>
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
            const how = c && c.duration ? (c.duration === 'repeating' && c.durationInMonths ? `for ${hubPlural(c.durationInMonths, 'month', 'months')}` : c.duration === 'forever' ? 'for as long as they subscribe' : 'on the first payment') : '';
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
    </HubCard>
  );
}

// The colour each kind of bill takes on the split bar. Kinds are categories,
// not states, so none of the status colours: the chart palette in HUB_CSS,
// told apart by the legend's words as well as by colour.
function hubKindColors() {
  return { infrastructure: 'var(--hub-c1)', tooling: 'var(--hub-c2)', legal: 'var(--hub-c3)', other: 'var(--hub-c4)' };
}

function HubCosts({ h, colors }) {
  const c = h.costs || {};
  const navy = colors.navy;
  const grid = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', columnGap: '12px', alignItems: 'baseline' };
  const head = { fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-tertiary)', textAlign: 'right', paddingBottom: '4px' };
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
  const truncated = !!(h.expenses && h.expenses.truncated);
  const biggest = c.biggest && Array.isArray(c.biggest.lines) ? c.biggest : null;
  const kinds = (Array.isArray(c.byKind) ? c.byKind : []).filter((k) => Number.isFinite(k.perMonthCents));
  const kindColor = hubKindColors();
  // The split bar draws each kind's share of the month's bills. A credit can
  // take a kind below zero, and a bar cannot be drawn below zero, so the
  // widths are of the kinds above it; the legend prints every kind's figure.
  const drawn = kinds.filter((k) => k.perMonthCents > 0);
  const drawnTotal = drawn.reduce((sum, k) => sum + k.perMonthCents, 0);
  const whole = c.status === 'ok' && !truncated && Number.isFinite(totals.perMonthCents);
  const mtu = c.maptilerUsage;
  const rsu = c.resendUsage;
  // A meter against its allowance, for the MapTiler and Resend lines below.
  // Drawn only from a reading, never from a meter that was not asked.
  const allowanceBar = (key, label, used, included) => (Number.isFinite(used) && Number.isFinite(included) && included > 0 ? (
    <div key={key} style={{ margin: '8px 0 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginBottom: '5px' }}>
        <span>{label}</span>
        <span style={{ fontWeight: '600', color: navy, fontVariantNumeric: 'tabular-nums' }}>{`${hubCount(used)} of ${hubCount(included)}`}</span>
      </div>
      <div className="hub-track" aria-hidden="true">
        <div className="hub-fill" style={{ width: `${Math.max(2, Math.min(100, (used / included) * 100))}%`, backgroundColor: used >= included ? 'var(--accent-red-text)' : used >= included * 0.8 ? 'var(--accent-amber-text)' : colors.steel }} />
      </div>
    </div>
  ) : null);
  return (
    <HubCard
      id={HUB_CARD.costs.id}
      title="Costs"
      sub="Where the money goes each month, every bill counted once."
      chips={whole ? <HubChip tone="muted">{`${hubMoney(totals.perMonthCents)} a month`}</HubChip> : null}
    >
      {c.status === 'error' && <HubNotice status="error" reason={c.reason} />}
      {/* A list cut short at the limit is missing bills, so its totals are a
          smaller number that looks whole: the tables are withheld, as the
          headline burn is (review 2026-10-03). An unreadable list still shows
          the code lines, labelled by the notice above. */}
      {truncated ? (
        <p style={hubStyle.note}>Totals withheld until the expense list fits: the bills past the first {h.expenses.limit || 500} are not in them.</p>
      ) : (
        <>
          {/* Every bill in the burn, largest first (moneyHub.js, THE BIGGEST
              BILLS): the code's lines and the expense list in one ranking,
              as bars on one scale. */}
          {biggest && biggest.lines.length > 0 && (
            <>
              <p style={{ ...hubStyle.kicker, marginTop: '6px' }}>Biggest bills</p>
              <HubBarList
                color={colors.steel}
                rows={biggest.lines.map((b) => ({
                  key: `big-${b.id}`,
                  label: b.label,
                  value: b.perMonthCents,
                  valueText: `${hubMoney(b.perMonthCents)} a month`,
                  color: kindColor[b.kind] || colors.steel,
                  note: `${hubShare(b.pct)} of ${biggest.beforeCredits ? 'the bills before credits' : 'the burn'}.${b.cadence === 'yearly' ? ' A yearly bill, at a twelfth.' : b.cadence === 'quarterly' ? ' A quarterly bill, at a third.' : ''}`,
                }))}
              />
              {biggest.restBills > 0 && (
                <p style={hubStyle.foot}>{hubPlural(biggest.restBills, 'smaller bill', 'smaller bills')}, {hubMoney(biggest.restPerMonthCents)} a month in all.</p>
              )}
            </>
          )}
          {kinds.length > 0 && (
            <>
              <p style={hubStyle.kicker}>By kind</p>
              {drawnTotal > 0 && (
                <div className="hub-stack" aria-hidden="true">
                  {drawn.map((k) => (
                    <div key={`seg-${k.kind}`} style={{ width: `${(k.perMonthCents / drawnTotal) * 100}%`, backgroundColor: kindColor[k.kind] || colors.steel }} />
                  ))}
                </div>
              )}
              <div className="hub-legend">
                {kinds.map((k) => (
                  <span key={`key-${k.kind}`}>
                    <span className="hub-swatch" style={{ backgroundColor: kindColor[k.kind] || colors.steel }} />
                    {`${k.label || HUB_KIND_LABEL[k.kind] || k.kind} ${hubMoney(k.perMonthCents)}`}
                  </span>
                ))}
              </div>
              <HubWhy label="See the tables">
                <>
                  <p style={{ ...hubStyle.kicker, marginTop: '6px' }}>By kind</p>
                  {table(c.byKind || [], (k) => k.kind, (k) => k.label || HUB_KIND_LABEL[k.kind] || k.kind)}
                  <p style={hubStyle.kicker}>By category</p>
                  {table(c.byCategory || [], (k) => `cat-${k.category}`, (k) => k.category)}
                </>
              </HubWhy>
            </>
          )}
        </>
      )}

      {Array.isArray(c.jumps) && c.jumps.length > 0 && (
        <>
          <p style={hubStyle.kicker}>Up on the last bill</p>
          {c.jumps.map((j) => (
            <HubRow
              key={`jump-${j.id}`}
              navy={navy}
              label={j.label}
              tone="warn"
              chip
              value={`up ${j.pct}%`}
              note={`${hubMoney(j.fromCents)}${j.fromPeriod ? ` for ${j.fromPeriod}` : ''}, now ${hubMoney(j.toCents)}${j.toAsOf ? ` as of ${j.toAsOf}` : ''}.`}
            />
          ))}
        </>
      )}

      {c.licence && Array.isArray(c.licence.items) && c.licence.items.length > 0 && (
        <>
          <p style={hubStyle.kicker}>Plans outside their terms</p>
          {c.licence.items.map((i) => (
            <HubRow
              key={`lic-${i.id}`}
              navy={navy}
              label={`${i.vendor}, ${i.plan}`}
              value={i.fixCentsPerMonth > 0 ? `+${hubMoney(i.fixCentsPerMonth)}/mo` : 'No cost'}
              note={`${i.why} Fix: ${i.fix}. Checked ${i.checked}.`}
            />
          ))}
          <p style={hubStyle.foot}>{c.status === 'ok'
            ? `With every plan licensed for commercial use, the monthly burn would be ${hubMoney(c.licence.licensedPerMonthCents)}.`
            : `Licensing them adds ${hubMoney(c.licence.toComplyPerMonthCents)} a month.`} Recording the paid plan on the expense list clears its line here.</p>
        </>
      )}

      {(mtu || rsu) && <p style={hubStyle.kicker}>Usage against the plans</p>}
      {mtu && (
        <div style={{ padding: '2px 0 6px' }}>
          {mtu.status === 'read' && allowanceBar('mt-sessions', 'MapTiler map sessions', mtu.sessions, mtu.included && mtu.included.sessions)}
          {mtu.status === 'read' && allowanceBar('mt-requests', 'MapTiler requests', mtu.requests, mtu.included && mtu.included.requests)}
          <p style={hubStyle.foot}>
            MapTiler this billing period: {hubMaptilerLine(mtu)} The Flex fee is the MapTiler row on the expense list; this is the use on top of it.
          </p>
        </div>
      )}
      {rsu && (
        <div style={{ padding: '2px 0 6px' }}>
          {rsu.status === 'read' && rsu.daily && allowanceBar('rs-daily', 'Email today', rsu.daily.used, rsu.daily.limit)}
          {rsu.status === 'read' && rsu.monthly && allowanceBar('rs-monthly', 'Email this month', rsu.monthly.used, rsu.monthly.limit)}
          <p style={hubStyle.foot}>
            Resend, live: {hubResendLine(rsu)}
          </p>
        </div>
      )}

      {(c.possibleDoubles || []).map((d) => (
        <p key={`dbl-${d.codeLineId}-${d.expenseId}`} style={{ ...hubStyle.foot, color: 'var(--accent-amber-text)' }}>
          Possibly counted twice: {d.expenseLabel} on the expense list and {d.codeLabel} in the code. Edit the row and choose the code line under Counts instead of, and it is counted once.
        </p>
      ))}
      {c.reconciledReadError && <p style={{ ...hubStyle.foot, color: 'var(--accent-amber-text)' }}>{c.reconciledReadError}</p>}
      <HubWhy>
        {'The infrastructure bills in backend/services/costModel.js, the reconciled Google Cloud and Railway bills, and the expense list, each bill counted once. The Costs tab has the meters behind them.'}
        {(c.replaced || []).length > 0 && `Counted from the expense list instead of the code: ${c.replaced.map((x) => x.label).join(', ')}.`}
        {(c.nonUsd || []).length > 0 && `Not added, because nothing here converts currencies: ${c.nonUsd.map((x) => `${x.label} (${hubExpenseAmount(x)}${x.replacesLine ? ', and the code line it names still counts' : ''})`).join(', ')}.`}
        {c.undatedCodeYearly > 0 && `${hubPlural(c.undatedCodeYearly, 'yearly bill in the code has', 'yearly bills in the code have')} no charge date, so ${c.undatedCodeYearly === 1 ? 'it counts' : 'they count'} at a twelfth every month. Add ${c.undatedCodeYearly === 1 ? 'it' : 'them'} to the expense list with a renewal date to see the renewal coming.`}
        {c.googleMeteredThisMonth && Number.isFinite(c.googleMeteredThisMonth.photosBought)
          && `Google photos bought this month: ${hubCount(c.googleMeteredThisMonth.photosBought)}${Number.isFinite(c.googleMeteredThisMonth.photosUsd) ? `, ${hubMoney(Math.round(c.googleMeteredThisMonth.photosUsd * 100))}` : ''}, from places_photo_spend. That spend arrives on the Google Cloud invoice above and is not added twice.`}
      </HubWhy>
    </HubCard>
  );
}

// How far off a day is, as a person says it.
const hubWhen = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`);

// COMING UP: what the dated bills on the expense list charge next, on a line a
// month long, with the bills set to end beside them. A renewal is something to
// know, not something that went wrong, so none of this is in Needs you. Dated
// bills only: the code's own monthly lines carry no charge day, so they are
// named under the line with what they come to, and never drawn on a day they
// may not fall on (moneyHub.js, MONTHLY BILLS THE RENEWAL TOTALS CANNOT DATE).
const HUB_TIMELINE_DAYS = 30;

function HubTimeline({ items, todayYmd, colors }) {
  // Bills within a day and a half of each other share a spot, so they stack.
  const lanes = [];
  const placed = items.map((it) => {
    let lane = 0;
    while (lanes[lane] !== undefined && it.inDays - lanes[lane] < 1.5) lane += 1;
    lanes[lane] = it.inDays;
    return { ...it, lane };
  });
  const rows = Math.max(1, lanes.length);
  const height = 14 + rows * 16;
  const axisTop = height - 10;
  const at = (d) => `${Math.min(100, Math.max(0, (d / HUB_TIMELINE_DAYS) * 100))}%`;
  const dayLabel = (n) => {
    if (typeof todayYmd !== 'string') return null;
    const [y, m, d] = todayYmd.split('-').map(Number);
    return new Date(y, m - 1, d + n).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  return (
    <div className="hub-tl" aria-hidden="true">
      <div className="hub-tl-track" style={{ height: `${height}px` }}>
        <div className="hub-tl-axis" style={{ top: `${axisTop}px` }} />
        {[0, 7, 14, 21, 30].map((d) => <span key={`tick-${d}`} className="hub-tl-tick" style={{ left: at(d), top: `${axisTop - 3}px` }} />)}
        {placed.map((it) => (
          <span
            key={it.key}
            title={it.title}
            className="hub-tl-dot"
            style={{
              left: at(it.inDays),
              top: `${axisTop - 5 - it.lane * 16}px`,
              backgroundColor: it.kind === 'end' ? 'var(--bg-card-solid)' : colors.steel,
              border: `2px solid ${it.kind === 'end' ? 'var(--text-secondary)' : colors.steel}`,
            }}
          />
        ))}
      </div>
      <div className="hub-tl-labels">
        <span style={{ left: 0 }}>Today</span>
        <span className="hub-tl-mid" style={{ left: at(14) }}>{dayLabel(14)}</span>
        <span className="hub-tl-end">{dayLabel(HUB_TIMELINE_DAYS)}</span>
      </div>
    </div>
  );
}

function HubComingUp({ h, colors }) {
  const c = h.costs || {};
  const navy = colors.navy;
  const today = h.month && h.month.todayYmd;
  // A list cut short leaves the burn moves out, as the Costs card does.
  const truncated = !!(h.expenses && h.expenses.truncated);
  const upcoming = (Array.isArray(c.upcoming) ? c.upcoming : [])
    .map((u) => ({ ...u, inDays: hubDaysUntil(today, u.on) }));
  const ending = (Array.isArray(c.ending) ? c.ending : [])
    .map((e) => ({ ...e, inDays: hubDaysUntil(today, e.endsOn), burnMove: hubBurnMove(e, truncated) }));
  const totals = Array.isArray(c.upcomingTotals) ? c.upcomingTotals : [];
  const showTotals = totals.some((t) => t.bills > 0) && !truncated;
  const month = totals.find((t) => t.days === HUB_TIMELINE_DAYS);
  const undated = c.undatedMonthly && Array.isArray(c.undatedMonthly.lines) ? c.undatedMonthly : null;
  const inWindow = (d) => d !== null && d >= 0 && d <= HUB_TIMELINE_DAYS;
  const dots = [
    ...upcoming.filter((u) => inWindow(u.inDays)).map((u) => ({ key: `dot-r-${u.expenseId}-${u.on}`, inDays: u.inDays, kind: 'renew', title: `${hubDay(u.on)}: ${u.label}` })),
    ...ending.filter((e) => inWindow(e.inDays)).map((e) => ({ key: `dot-e-${e.expenseId}`, inDays: e.inDays, kind: 'end', title: `${hubDay(e.endsOn)}: ${e.label} ends` })),
  ].sort((a, b) => a.inDays - b.inDays);
  const jump = (
    <a className="hit44" href={`#${HUB_CARD.expenses.id}`} onClick={hubJump(HUB_CARD.expenses.id)} style={{ ...hubStyle.link, marginTop: 0, whiteSpace: 'nowrap' }}>{HUB_CARD.expenses.link}</a>
  );
  return (
    <HubCard
      id="hub-coming-up"
      title="Coming up"
      sub="Renewals and bills ending, from the dated bills on the expense list."
      chips={showTotals && month ? <HubChip tone="muted">{`${hubMoney(month.cents)} in ${HUB_TIMELINE_DAYS} days`}</HubChip> : null}
    >
      {showTotals && (
        <div className="hub-minis">
          {totals.map((t) => (
            <div key={`total-${t.days}`} className="hub-mini" data-hub-fig="">
              <p className="hub-mini-label">{`Next ${t.days} days`}</p>
              <p className="hub-mini-value">{hubMoney(t.cents)}</p>
            </div>
          ))}
        </div>
      )}
      {dots.length > 0 && (
        <>
          <HubTimeline items={dots} todayYmd={today} colors={colors} />
          <div className="hub-legend" aria-hidden="true">
            <span><span className="hub-swatch" style={{ borderRadius: '50%', backgroundColor: colors.steel }} />Renews</span>
            {dots.some((d) => d.kind === 'end') && <span><span className="hub-swatch" style={{ borderRadius: '50%', border: '2px solid var(--text-secondary)', boxSizing: 'border-box' }} />Ends</span>}
          </div>
        </>
      )}

      <p style={hubStyle.kicker}>Renewals in the next {c.upcomingWindowDays || 90} days</p>
      {upcoming.length === 0 ? (
        <p style={hubStyle.note}>None dated. A bill on the expense list shows here once it has a renewal or last-charge date; the code's lines carry no dates.</p>
      ) : upcoming.map((u) => (
        <HubRow
          key={`renew-${u.expenseId}-${u.on}`}
          navy={navy}
          label={u.label}
          sub={u.inDays === null ? `Renews ${hubDay(u.on)}` : `Renews ${hubWhen(u.inDays)}, ${hubDay(u.on)}`}
          value={u.currency === 'USD' ? hubMoney(u.amountCents) : `${(u.amountCents / 100).toFixed(2)} ${u.currency}`}
        >
          <p className="hub-note">{u.estimated ? 'Worked out from the last charge date.' : 'The renewal date on the expense list.'}{' '}{jump}</p>
        </HubRow>
      ))}

      {ending.length > 0 && (
        <>
          <p style={hubStyle.kicker}>Set to end</p>
          {ending.map((e) => (
            <HubRow
              key={`end-${e.expenseId}`}
              navy={navy}
              label={e.label}
              sub={e.inDays === null || e.inDays < 0 ? `Ends ${hubDay(e.endsOn)}` : `Ends ${hubWhen(e.inDays)}, ${hubDay(e.endsOn)}`}
              value={`${hubExpenseAmount(e)} ${HUB_CADENCE_LABEL[e.cadence] || e.cadence}`}
            >
              <p className="hub-note">{hubEndingWords(e, truncated)}{' '}{jump}</p>
            </HubRow>
          ))}
        </>
      )}

      {/* The monthly bills the renewals cannot date (moneyHub.js, MONTHLY
          BILLS THE RENEWAL TOTALS CANNOT DATE). The totals above count dated
          bills only, and read as everything going out while the code's own
          monthly bills were in none of them. Withheld with the totals when
          the list is cut short. */}
      {undated && undated.lines.length > 0 && !truncated && (
        <>
          <p style={hubStyle.kicker}>Monthly bills with no date</p>
          <p style={hubStyle.note}>Charged every month on a day nothing here records, so they are in none of the renewals above: {hubMoney(undated.perMonthCents)} a month in all.</p>
          {undated.lines.map((l) => (
            <HubRow
              key={`undated-${l.id}`}
              navy={navy}
              label={l.label}
              value={`${hubMoney(l.perMonthCents)} a month`}
              note={l.cadence === 'usage' ? 'Billed by use, at its latest figure.' : null}
            />
          ))}
        </>
      )}
      {showTotals && (
        <HubWhy>{'The totals count every charge each dated dollar bill on the expense list makes in the window.'}</HubWhy>
      )}
    </HubCard>
  );
}

// An expense row's amount as the list shows it. A credit (a refund, a vendor
// credit) is stored as a positive amount with isCredit set, and shown with a
// minus sign so it reads as money coming back.
function hubExpenseAmount(x) {
  const cents = x.isCredit ? -x.amountCents : x.amountCents;
  if (x.currency === 'USD') return hubMoney(cents);
  return `${x.isCredit ? '−' : ''}${(x.amountCents / 100).toFixed(2)} ${x.currency}`;
}

// What the burn does on the day a bill set to end stops (moneyHub.js, THE END
// OF A BILL), as the server works it out: a bill that stood in for a code line
// gives that line back, so a $149 bill in place of a $119 line takes $30 off,
// not $149 (review 2026-10-06). A payload from before burnChangeCents has only
// the bill's own share. null for a bill in another currency, which was never
// in the dollar burn. null too when the expense list was cut short at the
// limit: a bill past the first 500 can stand in for the same code line, so a
// change worked from the partial list is withheld with the totals (review
// 2026-10-06: $30 quoted where the burn would fall by $149).
function hubBurnMove(e, listCutShort) {
  if (listCutShort) return null;
  const change = Number.isFinite(e.burnChangeCents) ? e.burnChangeCents
    : (Number.isFinite(e.perMonthCents) ? -e.perMonthCents : null);
  if (!Number.isFinite(change) || change === 0) return null;
  return `the burn ${change < 0 ? 'falls' : 'rises'} by ${hubMoney(Math.abs(change))} a month`;
}

// A usage bill is billed after the use, so its last bill comes after the day
// it ends (moneyHub.js, THE END OF A BILL), and "no charge on or after this
// day" would be wrong for it.
function hubEndingWords(e, listCutShort) {
  const move = hubBurnMove(e, listCutShort);
  const back = Array.isArray(e.restores) && e.restores.length > 0
    ? `, as the code's ${hubAnd(e.restores)} ${e.restores.length === 1 ? 'counts' : 'count'} again`
    : '';
  if (e.cadence === 'usage' && !e.isCredit) {
    return `Use stops on this day, and its last bill comes after.${move ? ` From this day ${move}${back}.` : ''}`;
  }
  return `No ${e.isCredit ? 'credit' : 'charge'} on or after this day.${move ? ` Then ${move}${back}.` : ''}`;
}

const HUB_EMPTY_EXPENSE = {
  vendor: '', product: '', category: '', kind: 'tooling', amount: '', currency: 'USD', cadence: 'monthly',
  lastChargedOn: '', renewsOn: '', endsOn: '', replacesLine: '', verified: false, active: true, isCredit: false, note: '',
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
    endsOn: x.endsOn || '',
    replacesLine: x.replacesLine || '',
    verified: !!x.verified,
    active: x.active !== false,
    isCredit: !!x.isCredit,
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
    // A one-time charge has nothing to end; the server refuses the pair.
    endsOn: f.cadence === 'one_time' ? null : (f.endsOn || null),
    // A credit never stands in for a code line; the server refuses the pair.
    replacesLine: f.isCredit ? null : (f.replacesLine || null),
    verified: !!f.verified,
    active: !!f.active,
    isCredit: !!f.isCredit,
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
            {cadences.map((c) => <option key={c} value={c}>{c === 'one_time' ? 'once' : c === 'usage' ? 'usage, monthly' : c === 'quarterly' ? 'every three months' : c}</option>)}
          </select>
        ))}
        {field('lastChargedOn', 'Last charged', <input id={`${uid}-lastChargedOn`} style={I} type="date" max={localToday()} value={form.lastChargedOn} onChange={set('lastChargedOn')} />)}
        {field('renewsOn', 'Renews', <input id={`${uid}-renewsOn`} style={I} type="date" value={form.renewsOn} onChange={set('renewsOn')} />)}
        {field('endsOn', 'Ends on', <input id={`${uid}-endsOn`} style={I} type="date" value={form.cadence === 'one_time' ? '' : form.endsOn} onChange={set('endsOn')} disabled={form.cadence === 'one_time'} />)}
        {field('replacesLine', 'Counts instead of', (
          <select id={`${uid}-replacesLine`} style={I} value={form.isCredit ? '' : form.replacesLine} onChange={set('replacesLine')} disabled={form.isCredit}>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={form.isCredit} onChange={set('isCredit')} />Money back: a refund or credit
        </label>
      </div>
      {form.isCredit && <p style={hubStyle.note}>Type the amount as a plain number. It is taken off the totals instead of added.</p>}
      {/* A usage bill is billed after the use, so its last bill comes after
          the day it ends (moneyHub.js, THE END OF A BILL). */}
      {form.endsOn && form.cadence !== 'one_time' && (
        <p style={hubStyle.note}>
          {form.cadence === 'usage'
            ? 'For a usage bill that stops on that day. Its last bill comes after, for the use up to then, and the hub stops counting it on that day, so leave Still being charged ticked.'
            : 'For a bill whose renewal is turned off. Nothing is charged on or after that day and the hub stops counting it then, so leave Still being charged ticked.'}
        </p>
      )}
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
  const amount = hubExpenseAmount(x);
  // Where the row stands against its end date, as the server read it today
  // (moneyHub.js, THE END OF A BILL). A renewal on or after the end date
  // never comes, so the end is said in its place. A charge that outran the
  // date keeps a row running only while it is marked as charged: a stopped
  // row is out of the burn either way (review 2026-10-06). A usage bill's
  // last bill comes after its end date, so one outran it only by a charge
  // after the day the server expected that bill by, and its row says that:
  // "on or after its end date" would make the last bill of an ended usage
  // row read as a renewal (second review 2026-10-06). The dates cannot say
  // what that later charge paid for, use after the end date or a last bill
  // paid late, so a usage row sends the owner to the invoice (review
  // 2026-10-06).
  const end = x.endState || null;
  const stops = (end === 'ending' || end === 'ended') && x.endsOn;
  const running = x.active && end !== 'ended';
  let outran = null;
  let runs = ', so it counts as running until the date is cleared';
  if (end === 'renewed') {
    if (x.cadence !== 'usage') outran = `charged on or after its end date of ${hubDay(x.endsOn)}`;
    else {
      outran = x.lastBillBy
        ? `after the last bill expected by ${hubDay(x.lastBillBy)} for its end date of ${hubDay(x.endsOn)}`
        : `later than the last bill for its end date of ${hubDay(x.endsOn)}`;
      runs = ', so it counts as running until the charge is checked against its invoice';
    }
  }
  const facts = [
    HUB_KIND_LABEL[x.kind] || x.kind,
    x.category,
    x.renewsOn && !(stops && x.renewsOn >= x.endsOn) ? `renews ${hubDay(x.renewsOn)}` : null,
    x.lastChargedOn ? `last charged ${hubDay(x.lastChargedOn)}` : null,
    end === 'ending' ? `ends ${hubDay(x.endsOn)}` : null,
    end === 'ended' ? `ended ${hubDay(x.endsOn)}` : null,
    outran ? `${outran}${x.active ? runs : ''}` : null,
    line ? `counts instead of ${line} in the code` : null,
  ].filter(Boolean).join(', ');
  return (
    <div className="hub-row" data-hub-fig="" style={{ padding: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
        <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: running ? colors.navy : 'var(--text-tertiary)', minWidth: 0, overflowWrap: 'anywhere' }}>
          {label}
          {x.isCredit && <span style={hubTag('good')}>Credit</span>}
          {!x.verified && <span style={hubTag('warn')}>Unverified</span>}
          {x.active && end === 'ending' && <span style={hubTag('muted')}>Ending</span>}
          {x.active && end === 'ended' && <span style={hubTag('muted')}>Ended</span>}
          {!x.active && <span style={hubTag('muted')}>Stopped</span>}
        </span>
        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: running ? colors.navy : 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {amount} {HUB_CADENCE_LABEL[x.cadence] || x.cadence}
        </span>
      </div>
      <p style={hubStyle.note}>{facts.charAt(0).toUpperCase() + facts.slice(1)}.{x.note ? ` ${x.note}` : ''}</p>
      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        {/* Named for the bill, since every row's buttons read the same. */}
        <button className="hit44" type="button" aria-label={`Edit ${label}`} onClick={onEdit} style={hubStyle.textButton}>Edit</button>
        <button className="hit44" type="button" aria-label={busy ? undefined : `${x.active ? 'Mark as stopped' : 'Mark as charged again'}: ${label}`} disabled={busy} onClick={toggle} style={hubStyle.textButton}>
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
            One object per bill. Required: vendor, kind (infrastructure, tooling, legal or other), cadence (monthly, quarterly, yearly, usage or one_time) and amount in dollars. Optional: product, category, currency, lastChargedOn, renewsOn, endsOn for a bill whose renewal is turned off, verified, note, replacesLine to count a bill instead of a code line, and isCredit: true for a refund or credit, with the amount still a plain number. A bill already on the list with the same vendor, product, cadence and isCredit is updated, and a field left out keeps what is stored. Up to 200 at a time; one bad row saves nothing.
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
  const [exportNote, setExportNote] = React.useState('');
  const done = () => { setEditing(null); onChanged(); };
  const exportCsv = async () => {
    setExportNote('');
    try {
      const r = await downloadExpensesCsv();
      setExportNote(`Saved ${r.filename}, ${hubPlural(r.rows, 'bill', 'bills')}.`);
    } catch (err) {
      setExportNote((err && err.message) || 'The list could not be exported.');
    }
  };
  return (
    <HubCard
      id={HUB_CARD.expenses.id}
      title="Expense list"
      sub="Bills the code does not carry, from your own invoices."
      chips={(
        <>
          {e.status === 'ok' && rows.length > 0 && !e.truncated && (
            <button className="hit44" type="button" onClick={exportCsv} style={{ ...hubStyle.textButton, flexShrink: 0 }}>{Icons.download('currentColor', 12)}Download CSV</button>
          )}
          {editing !== 'new' && (
            <button className="hit44" type="button" onClick={() => setEditing('new')} style={{ ...hubStyle.textButton, flexShrink: 0 }}>{Icons.plus('currentColor', 12)}Add a bill</button>
          )}
        </>
      )}
    >
      {exportNote && <p role="status" style={hubStyle.foot}>{exportNote}</p>}
      {e.status === 'error' && <HubNotice status="error" reason="The list could not be read. The costs above count the code lines and the reconciled bills only." />}
      {e.truncated && <HubNotice status="error" reason={`The list has more than ${e.limit || 500} bills. These are the first ${e.limit || 500}, and the totals above are left unread because bills are missing from them.`} />}
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
      <HubWhy label="What goes on this list">
        {'The tools the app is built with, company and legal costs, anything else the code does not carry. Stored in the database, never in the published source.'}
      </HubWhy>
    </HubCard>
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

// Every bill and rate card in one list, oldest check first (moneyHub.js
// buildPriceSheet).
function HubPriceSheet({ h, colors }) {
  const ps = h.priceSheet;
  if (!ps || !Array.isArray(ps.rows) || ps.rows.length === 0) return null;
  const navy = colors.navy;
  return (
    <HubCard
      id={HUB_CARD.priceSheet.id}
      title="Price sheet"
      sub="Every bill and rate card Flock pays, with the day each was last checked against its source. Never checked and oldest first."
      chips={<HubChip tone={ps.stale > 0 ? 'warn' : 'good'}>{ps.stale > 0 ? `${hubPlural(ps.stale, 'price', 'prices')} due for a check` : 'Every price is within its check'}</HubChip>}
    >
      {ps.rows.map((r) => (
        <HubRow
          key={r.id}
          navy={navy}
          label={r.label}
          tag={r.stale ? { tone: 'warn', text: 'Due' } : null}
          tone={r.stale ? 'warn' : undefined}
          value={Number.isFinite(r.priceCents)
            ? `${hubMoney(r.priceCents)} ${r.unit}`
            : (Number.isFinite(r.amountCents) && r.currency ? `${(r.amountCents / 100).toFixed(2)} ${r.currency} ${r.unit}` : r.unit)}
          note={`${r.checkedOn ? `Checked ${r.checkedOn}${Number.isFinite(r.ageDays) ? `, ${hubPlural(r.ageDays, 'day', 'days')} ago` : ''}` : 'Never checked against a receipt or a pricing page'}${r.source ? `, from ${r.source}` : ''}.`}
        />
      ))}
      <HubWhy label="When a price is due">
        {`A price read off a vendor's page or bill is due again after ${ps.staleAfterDays} days; a bill on the expense list is due once its next charge should have landed, so a yearly one after a year; a one-time charge never is.`}
      </HubWhy>
    </HubCard>
  );
}

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
    <HubCard
      id={HUB_CARD.prices.id}
      title="Prices"
      sub="What Stripe and the App Store charge, next to every price written down in the code and the decision documents."
      chips={(
        <HubChip tone={count > 0 ? 'bad' : s.status === 'ok' ? 'good' : 'muted'}>
          {count > 0 ? `${hubPlural(count, 'disagreement', 'disagreements')} to fix` : s.status === 'ok' ? 'No disagreements found' : 'Not checked against Stripe'}
        </HubChip>
      )}
    >
      {s.status !== 'ok' && <HubNotice status={s.status} reason={s.reason} />}

      {Array.isArray(h.planNets) && h.planNets.length > 0 && (
        <>
          <p style={hubStyle.kicker}>What each plan leaves you, a month</p>
          {h.planNets.map((x) => (
            <HubRow
              key={`net-${x.product}-${x.plan}`}
              navy={navy}
              label={`${x.product === 'pro' ? 'Flock Pro' : 'Roost'}, ${HUB_PLAN_LABEL[x.plan] || x.plan}`}
              value={`${hubMoney(x.web.netPerMonthCents)} web`}
              note={`${hubMoney(x.priceCents)} ${every(x.interval)}${x.source === 'stripe' ? ', the price Stripe charges' : ', the price the code states'}, so ${hubMoney(x.grossPerMonthCents)} a month before ${hubMoney(x.web.feesPerMonthCents)} of Stripe fees.${x.appStore ? ` In the App Store (${hubMoney(x.appStore.priceCents)} ${every(x.interval)}, ${x.appStore.source === 'app_store' ? 'the price RevenueCat reports' : x.appStore.source === 'app_store_charge' ? 'the newest App Store charge' : 'the price the code states, because no App Store price was read'}), ${hubMoney(x.appStore.netPerMonthCents)} after Apple's ${x.appStore.standardPct}%, or ${hubMoney(x.appStore.netPerMonthSmallBusinessCents)} at the ${x.appStore.smallBusinessPct}% of the Small Business Program and a subscriber's second year.` : ''}`}
            />
          ))}
        </>
      )}

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
        <HubNotice status={p.offering && (p.offering.status === 'error' || p.offering.status === 'not_connected') ? p.offering.status : 'refused'} reason={(p.offering && p.offering.reason) || 'The offering could not be read with this key.'} />
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
      {p.paywallNote && <HubWhy label="Where the paywall gets its prices">{p.paywallNote}</HubWhy>}
    </HubCard>
  );
}

function HubHealth({ h, colors }) {
  const c = (h.health && h.health.collector) || {};
  const navy = colors.navy;
  const STATE = { fresh: { text: 'Landing', tone: 'good' }, late: { text: 'Late', tone: 'warn' }, stopped: { text: 'Stopped', tone: 'bad' } };
  const st = STATE[c.state] || { text: 'Not read', tone: 'muted' };
  const ago = hubAgo;
  return (
    <HubCard id={HUB_CARD.health.id} title="Health" sub="The paid data feed, read from the rows it writes rather than from the job.">
      {c.status === 'error' ? (
        <HubNotice status="error" reason={c.reason} />
      ) : (
        <HubRow
          navy={navy}
          label="Crowd data collector"
          value={st.text}
          tone={st.tone}
          chip
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
    </HubCard>
  );
}

// ACCESS KEYS: the keys a tool on the owner's computer uses to call these
// admin routes (backend/middleware/adminKeys.js, tools/flock-admin/admin.mjs).
// Read from GET /api/admin/keys on its own, so it does not wait on the hub's
// vendor reads, and it holds metadata only: the server keeps a fingerprint of
// each key, so no key can be shown here. Revoke is the one control, because it
// is a safety control. Minting is not on the page: a key is minted from the
// browser console or the admin tool. A key minted from a session older than
// fifteen minutes is Pending until its owner taps Approve in the email it sent,
// and a pending key whose link ran out reads as Expired, since it can never work.
const HUB_KEY_STATE = {
  active: { text: 'Active', tone: 'good' },
  pending: { text: 'Pending', tone: 'warn' },
  expired: { text: 'Expired', tone: 'muted' },
  revoked: { text: 'Revoked', tone: 'muted' },
  ended: { text: 'Ended', tone: 'warn' },
};
const HUB_KEY_REFUSED = {
  route: 'refused, not a route a key may use',
  pending: 'refused, waiting for approval',
  unapproved: 'refused, never approved',
  expired: 'refused, expired',
  revoked: 'refused, revoked',
  ended: 'refused, ended',
};
const HUB_KEY_REVOKED_HOW = { key: ' by the key itself', email: " from the email's link" };
// Under this many days left, the card says when the soonest key runs out.
const HUB_KEY_EXPIRY_WARN_DAYS = 14;

// "Nov 5", or "Nov 5, 2027" in another year, from an ISO time, in the
// browser's own zone.
function hubIsoDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}
const hubIsoWhen = (iso) => (iso ? `${hubIsoDay(iso)} at ${hubTime(iso)}` : null);
function hubSince(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(min)) return null;
  return min < 1 ? 'just now' : `${hubAgo(min)} ago`;
}

function HubKeyRow({ k, navy, onRevoked }) {
  const [confirm, setConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const state = HUB_KEY_STATE[k.state] || { text: 'Not read', tone: 'muted' };
  const live = k.state === 'active';
  // A pending key can be revoked too: that is the answer to one nobody asked for.
  const revocable = live || k.state === 'pending';
  const neverApproved = !k.approvedAt;
  const uses = Array.isArray(k.recentUses) ? k.recentUses : [];
  const revoke = async () => {
    setBusy(true);
    setErr('');
    try {
      await revokeAdminKey(k.id);
      setConfirm(false);
      onRevoked();
    } catch (e) {
      setErr((e && e.message) || 'The key could not be revoked. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const facts = [
    `Made ${hubIsoDay(k.createdAt)}${k.createdIp ? ` from ${k.createdIp}` : ''}`,
    k.state === 'pending' && k.approvalExpiresAt ? `waiting for approval from the email until ${hubTime(k.approvalExpiresAt)}` : null,
    k.state === 'revoked' && k.revokedAt ? `revoked ${hubIsoDay(k.revokedAt)}${HUB_KEY_REVOKED_HOW[k.revokedVia] || ''}` : null,
    k.state === 'expired' && neverApproved ? 'never approved' : null,
    k.state === 'expired' && !neverApproved ? `expired ${hubIsoDay(k.expiresAt)}` : null,
    k.state !== 'expired' ? `expires ${hubIsoDay(k.expiresAt)}` : null,
    k.lastUsedAt ? `last used ${hubSince(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` : 'never used',
  ].filter(Boolean).join(', ');
  return (
    <div className="hub-row" data-hub-fig="" data-hub-key={k.id} style={{ padding: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
        <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: live ? navy : 'var(--text-tertiary)', minWidth: 0, overflowWrap: 'anywhere' }}>
          {k.name}
        </span>
        <HubChip tone={state.tone}>{state.text}</HubChip>
      </div>
      <p style={hubStyle.note}>{`${facts}.`}</p>
      {k.state === 'ended' && (
        <p style={hubStyle.note}>The account signed out everywhere, changed its password, or stopped being an admin after this key was made, so it no longer works.</p>
      )}
      {k.state === 'pending' && (
        <p style={hubStyle.note}>It does nothing until Approve is tapped in the email sent to this account. If nobody here asked for it, revoke it.</p>
      )}
      {uses.length > 0 && (
        <HubWhy label="Recent uses">
          {uses.map((u, i) => (
            <p key={`use-${k.id}-${i}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {`${u.method} ${u.route}, ${u.refused ? HUB_KEY_REFUSED[u.refused] || 'refused' : (u.status ? `answered ${u.status}` : 'no answer')}, ${hubIsoWhen(u.at)}`}
            </p>
          ))}
        </HubWhy>
      )}
      {revocable && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
          {!confirm ? (
            <button className="hit44" type="button" aria-label={`Revoke ${k.name}`} onClick={() => setConfirm(true)} style={hubStyle.textButton}>Revoke</button>
          ) : (
            <button className="hit44" type="button" aria-label={busy ? undefined : `Revoke ${k.name} for good`} disabled={busy} onClick={revoke} style={{ ...hubStyle.textButton, color: 'var(--accent-red-text)', cursor: busy ? 'default' : 'pointer' }}>
              {busy ? 'Revoking' : 'Revoke for good'}
            </button>
          )}
        </div>
      )}
      {confirm && <p style={hubStyle.note}>Anything using this key stops on its next request. A revoked key cannot be turned back on.</p>}
      {err && <p style={{ ...hubStyle.note, color: 'var(--accent-red-text)' }}>{err}</p>}
    </div>
  );
}

function HubAccessKeys({ colors }) {
  const [read, setRead] = React.useState({ status: 'loading', keys: [], reason: '' });
  const load = React.useCallback(async () => {
    try {
      const r = await getAdminKeys();
      setRead({ status: 'ok', keys: Array.isArray(r && r.keys) ? r.keys : [], reason: '' });
    } catch (e) {
      setRead({ status: 'error', keys: [], reason: (e && e.message) || 'The keys could not be read.' });
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);
  const live = read.keys.filter((k) => k.state === 'active');
  const pending = read.keys.filter((k) => k.state === 'pending');
  const soonest = live
    .map((k) => Math.floor((new Date(k.expiresAt).getTime() - Date.now()) / 86400000))
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b)[0];
  let chip = null;
  if (read.status === 'ok') {
    if (pending.length > 0) chip = <HubChip tone="warn">{`${hubCount(pending.length)} waiting for approval`}</HubChip>;
    else if (Number.isFinite(soonest) && soonest <= HUB_KEY_EXPIRY_WARN_DAYS) {
      chip = <HubChip tone="warn">{soonest < 1 ? 'Expires today' : `Expires in ${hubPlural(soonest, 'day', 'days')}`}</HubChip>;
    } else chip = <HubChip tone="muted">{live.length > 0 ? `${hubCount(live.length)} active` : 'None active'}</HubChip>;
  }
  return (
    <HubCard
      id="hub-keys"
      title="Access keys"
      sub="Keys a tool on your computer uses to call these admin routes as you."
      chips={chip}
    >
      {read.status === 'loading' && <p style={hubStyle.note}>Reading the keys.</p>}
      {read.status === 'error' && <HubNotice status="error" reason={read.reason} />}
      {read.status === 'ok' && read.keys.length === 0 && (
        <p style={hubStyle.note}>No keys yet. A key is minted from the browser console or the admin tool, never from this page.</p>
      )}
      {read.keys.map((k) => <HubKeyRow key={`key-${k.id}`} k={k} navy={colors.navy} onRevoked={load} />)}
      <HubWhy label="What a key can do">
        {'A key is minted once, from a browser where you are signed in or with the admin tool, and shown only then. The server keeps a fingerprint of it, so it cannot be shown here or anywhere again.'}
        {'A key minted within fifteen minutes of signing in works at once. One minted from an older session is Pending until you tap Approve in the email it sends, which works from your phone with no sign-in; its link lasts fifteen minutes. Every key made, approved or revoked is emailed to you.'}
        {'It can read this console and keep the books: the money hub, the costs, the expense list, the waitlist launch email, the research numbers, and the moderation and verification queues to read. It cannot mint or list keys, make a moderation decision, open reported content, verify a venue or change its tier, change a password, an email or a session, delete an account, or act as you anywhere else in the app.'}
        {'Every use is logged with its route, its answer and the address it came from. A key stops at its expiry, when it is revoked, and when you sign out everywhere or change your password. The steps are in tools/flock-admin/README.md.'}
      </HubWhy>
    </HubCard>
  );
}

// CROWD DATA: what BestTime's key endpoint says, beside the plan the code
// records. The endpoint reports the key's health and two undocumented counters,
// and no plan, admission count or cycle date (backend/services/besttimeAccount.js).
// So the plan rows are the code's and tagged as stated or worked out, the
// admissions used and left say Not reported instead of showing a number, and
// the counters appear under BestTime's own names with what they are not. The
// collector's rows are the Health card's read, shown here as well because they
// are what the plan pays for.
const HUB_STATED_TAG = { tone: 'muted', text: 'Stated' };
const HUB_WORKED_OUT_TAG = { tone: 'muted', text: 'Worked out' };

function HubCrowdData({ h, colors }) {
  const cd = h.crowdData;
  // A server from before this block sends none of it: no card, not an empty one.
  if (!cd) return null;
  const b = cd.besttime || {};
  const plan = cd.plan || null;
  const c = (h.health && h.health.collector) || {};
  const navy = colors.navy;
  const ready = b.status === 'ok';
  const key = b.key || {};
  const counters = b.counters || {};
  const reported = Array.isArray(b.reported) ? b.reported : [];
  const cachedAge = ready && b.cached && Number.isFinite(b.cachedAgeSeconds) ? b.cachedAgeSeconds : null;
  const holdMinutes = Math.round(((h.cache && h.cache.ttlSeconds) || 300) / 60);
  const counterValue = (n) => (Number.isFinite(n) ? hubCount(n) : 'Not reported');
  return (
    <HubCard id={HUB_CARD.crowd.id} title="Crowd data" sub="BestTime, the paid feed behind Flock's crowd numbers. Only its key endpoint is asked, which admits no venue and spends nothing.">
      {!ready && <HubNotice status={b.status} reason={b.reason} />}
      <div className="hub-halves">
      <div>
      {ready && (
        <HubRow
          navy={navy}
          label="BestTime key"
          value={key.healthy ? 'Working' : 'Not working'}
          tone={key.healthy ? 'good' : 'bad'}
          chip
          note={key.healthy
            ? 'BestTime says the key is valid and active.'
            : `BestTime says status ${key.status === null || key.status === undefined ? 'none' : key.status}, valid ${String(key.valid)}, active ${String(key.active)}.`}
        />
      )}
      {plan && (
        <>
          <HubRow
            navy={navy}
            label="Plan"
            tag={HUB_STATED_TAG}
            value={plan.name || 'Not recorded'}
            note={`BestTime's key endpoint does not report the plan. This is the plan the cost model records${Number.isFinite(plan.usdPerMonth) ? `, at ${hubMoney(Math.round(plan.usdPerMonth * 100))} a month` : ''}${plan.checked ? `, checked ${hubDay(plan.checked)}` : ''}.`}
          />
          <HubRow
            navy={navy}
            label="New venues admitted this month"
            value="Not reported"
            tone="muted"
            note="BestTime's key endpoint does not count admissions. The besttime.app dashboard does."
          />
          <HubRow
            navy={navy}
            label="Admission cap"
            tag={HUB_STATED_TAG}
            value={`${hubCount(plan.newVenuesPerMonth)} a month`}
            note="New venues the plan admits each calendar month, as the code records it. Live and by-id calls on venues already admitted do not count against it."
          />
          <HubRow
            navy={navy}
            label="Admissions left"
            value="Not reported"
            tone="muted"
            note="Needs the count used, which BestTime does not report. Nothing is subtracted from a count nobody read."
          />
          <HubRow
            navy={navy}
            label="Cycle ends"
            tag={HUB_WORKED_OUT_TAG}
            value={hubDay(plan.cycleEndsOn) || 'Not worked out'}
            note={`BestTime does not report the cycle. Package allowances run by calendar month, so the count starts again on ${hubDay(plan.resetsOn) || 'the 1st'}.`}
          />
        </>
      )}
      </div>
      <div>
      {ready && (
        <>
          <HubRow
            navy={navy}
            label="Forecast credits"
            value={counterValue(counters.creditsForecast)}
            note="credits_forecast, as BestTime reports it. BestTime does not document it, and it has read 1 on two accounts with very different use, so it is not shown as forecasts used."
          />
          <HubRow
            navy={navy}
            label="Query credits"
            value={counterValue(counters.creditsQuery)}
            note="credits_query, as BestTime reports it. Undocumented in the same way, so it is not shown as venue searches used."
          />
          {reported.length > 0 && (
            <p style={hubStyle.foot}>
              Also reported by BestTime, under its own names: {reported.map((f) => `${f.name} ${f.withheld ? '(withheld, it carried key material)' : String(f.value)}`).join('; ')}.
            </p>
          )}
        </>
      )}
      <HubRow
        navy={navy}
        label="Crowd readings, last 24 hours"
        value={c.status === 'ok' ? hubCount(c.rows24h) : 'Not read'}
        tone={c.status === 'ok' ? undefined : 'muted'}
        note={c.status === 'ok'
          ? `Rows the hourly collector wrote, across ${hubPlural(c.hours24h, 'hour', 'hours')}. From ml_training_data, the same read as the Health card below.`
          : (c.reason || 'The collector\'s rows could not be read.')}
      />
      </div>
      </div>
      <HubWhy label="Where these come from">
        {ready
          ? `Read from BestTime's key endpoint at ${hubTime(b.asOf)} and held for ${holdMinutes} minutes${cachedAge !== null ? `; this answer is ${hubPlural(cachedAge, 'second', 'seconds')} old` : ''}. The key itself never reaches this page.`
          : 'Nothing was read from BestTime, so no counter is shown. The plan rows come from the code either way.'}
      </HubWhy>
    </HubCard>
  );
}

// THE MODEL: what makes the crowd numbers now, and how the served ones did
// against the goal. The share is the server's (backend/services/moneyHub.js,
// THE MODEL): forecasts made from a venue's own data (prediction_method ml)
// served in the window, each paired with the collector's live reading of the
// same venue in the same hour of the same day, one pair per venue and hour,
// counted when its crowd band is the reading's or the next one over, and
// beside that when it is the reading's own. Under the minimum the server
// sends no share at all, and this card says there are not enough
// observations yet rather than printing a noisy one.
//
// prediction_method ml is the venue's own curve and live readings in
// curve_offset mode, where no model runs, and the trained model's number in
// model mode. The server counts which from each row's version, so the card
// names what made the numbers and never calls the curve's the model's.
const hubPct = (n) => `${n.toFixed(1)}%`;

// What answered a forecast, in words, keyed by the prediction_method
// services/mlPredictor.js and routes/crowd.js write on each serve. A method
// not listed here is shown by its own name rather than guessed at. ml is
// named by what made it where the server counted that (hubMadeBy).
const HUB_METHOD_WORDS = {
  ml: "a venue's own data",
  rule_engine: 'no model was loaded on the server',
  rule_engine_no_baseline: 'the venue has no baseline yet',
  rule_engine_baseline_refused: "the person's venue lookups for the moment were used up",
  rule_engine_baseline_error: "the venue's baseline could not be read",
  rule_engine_no_weather_norm: 'there was no weather reading and no usual weather to stand in',
  rule_engine_fallback: 'an error on the request',
  // The server's no-curve fallback (CROWD_NO_CURVE_FALLBACK): a venue with no
  // baseline and 200+ reviews, given its category's typical level instead of
  // the rule engine. Named by what it is, never as the venue's own data. Its
  // method starts with rule_engine for older app builds' sake, so it has words
  // of its own here, keyed on the exact name.
  rule_engine_category_table: "the venue has no baseline yet, so its category's typical level for the hour",
  owner_report: "the venue owner's live report",
  unknown: 'not recorded',
};
const hubMethodWords = (m) => HUB_METHOD_WORDS[m] || m;
// The two fallbacks for a venue with no baseline, both of which end once the
// collector has read the venue.
const HUB_NO_BASELINE_METHODS = ['rule_engine_no_baseline', 'rule_engine_category_table'];

// The two things that make a forecast from a venue's own data.
const HUB_FROM_CURVE = "the venue's own curve and live readings";
const HUB_FROM_MODEL = 'the trained model';

// What made `total` forecasts from a venue's own data, given how many of them
// the venue's curve made; the rest the trained model made. Read after "Of
// those, ". Null when the split is not known, so nothing is claimed.
function hubMadeBy(fromCurve, total) {
  if (!Number.isFinite(fromCurve) || !Number.isFinite(total) || total <= 0) return null;
  const curve = Math.min(Math.max(fromCurve, 0), total);
  if (curve === total) return `all came from ${HUB_FROM_CURVE}`;
  if (curve === 0) return `all came from ${HUB_FROM_MODEL}`;
  return `${hubCount(curve)} came from ${HUB_FROM_CURVE}, ${hubCount(total - curve)} from ${HUB_FROM_MODEL}`;
}

// The forecasts that were not from a venue's own data, read after "N of M
// forecasts.": the rule engine's, and, when the server's no-curve fallback
// answered any (mlPredictor predictionCoverage categoryCurve), the category's
// typical level for the hour. None of those, or a server from before the
// count, keeps the sentence this panel has always had.
function hubRestWords(total, ml, categoryCurve) {
  const typical = Number.isFinite(categoryCurve) && categoryCurve > 0 ? categoryCurve : 0;
  if (typical === 0) return 'The rest came from the rule engine.';
  const rule = Math.max(0, total - ml - typical);
  const words = `${hubCount(typical)} came from the typical level for the venue's category at that hour, at venues with no baseline yet`;
  return rule > 0 ? `${words}, and the rest from the rule engine.` : `${words}.`;
}

// The no-curve fallback's switch, set while the category table is not being
// served. The server calls the fallback on only while its gate can serve the
// table (mlPredictor noCurveFallbackState: the switch, a loaded model, and
// the artifact the table was measured on), and otherwise says why not. A
// reason this screen does not know is not guessed at.
function hubFallbackNotServedWords(p) {
  const lead = 'The no-curve fallback switch is set, but the category table is not being served';
  if (p.noCurveFallbackOff === 'model_not_loaded') return `${lead}: no model is loaded.`;
  if (p.noCurveFallbackOff === 'model_version') {
    const found = typeof p.modelVersion === 'string' && p.modelVersion
      ? `the loaded model is ${p.modelVersion}`
      : 'the loaded model names no version';
    return typeof p.noCurveFallbackFittedOn === 'string' && p.noCurveFallbackFittedOn
      ? `${lead}: it was measured on ${p.noCurveFallbackFittedOn}, and ${found}.`
      : `${lead}: ${found}, and the table was measured on another.`;
  }
  return `${lead}.`;
}

// What makes the numbers, in a few words for the row, by the serve mode the
// server reports (mlPredictor). model_when_fresh is the mix the November
// retrain brought: the trained model where the venue was read live in the
// hour before, the venue's own curve everywhere else. A mode this screen does
// not know reads as not read rather than as a guess.
function hubServeModeLabel(mode) {
  if (mode === 'curve_offset') return "Venue's own curve";
  if (mode === 'model') return 'Trained model';
  if (mode === 'model_when_fresh') return 'Mix of model and curve';
  return 'Not read';
}

// The serve mode in words, for the Overview and the Costs tab alike.
function hubServeModeWords(mode, nowcast) {
  let words = null;
  if (mode === 'curve_offset') words = "Serve mode is curve_offset: each venue's own weekly curve plus its live offset, with no model run.";
  else if (mode === 'model') words = "Serve mode is model: the trained model makes each venue's number.";
  else if (mode === 'model_when_fresh') words = "Serve mode is model_when_fresh, a mix: the trained model makes the number where the venue has a live reading from the hour before, and the venue's own weekly curve plus its live offset makes it everywhere else.";
  if (!words) return null;
  return nowcast === true
    ? `${words} The nowcast is on: a venue read live in an earlier hour has that reading blended into its number.`
    : words;
}

function HubModel({ h, colors }) {
  const m = h.model;
  if (!m) return null;
  const v = m.version || {};
  const a = m.accuracy || {};
  // A server from before the coverage read sends none: no rows, not empty ones.
  const cov = m.coverage || null;
  // Likewise the serve mode: no row from a server that does not send it.
  const serving = m.serving || null;
  const servingWords = serving ? hubServeModeWords(serving.mode, serving.nowcast) : null;
  const goal = m.goal || {};
  const navy = colors.navy;
  const ready = a.status === 'ok';
  // Within one band alone flatters a forecast that always names the same
  // level (scripts/ml/MODEL-METRICS.md, "Within one band on live readings"),
  // so the share is drawn only with the exact-level share beside it. A server
  // that sends the first without the second gets neither, and no gap.
  const shareArrived = ready && a.enough === true && Number.isFinite(a.percent);
  const measured = shareArrived && Number.isFinite(a.exactPercent);
  const gap = m.gapPoints;
  const bands = Array.isArray(m.bands) ? m.bands : [];
  const ladder = bands.map((b) => (Number.isFinite(b.upTo) ? `${b.label} up to ${b.upTo}` : `${b.label} above`)).join(', ');
  const versions = ready && Array.isArray(a.versions) ? a.versions : [];
  const holdMinutes = Math.round(((m.cache && m.cache.ttlSeconds) || 3600) / 60);
  const cachedAge = ready && a.cached && Number.isFinite(a.cachedAgeSeconds) ? a.cachedAgeSeconds : null;
  const age = cachedAge === null ? '' : `; this answer is ${cachedAge < 120 ? hubPlural(cachedAge, 'second', 'seconds') : `${Math.round(cachedAge / 60)} minutes`} old`;
  let versionNote;
  if (v.status !== 'ok') versionNote = v.reason || 'The version could not be read.';
  else if (v.loaded) {
    versionNote = serving && serving.mode === 'curve_offset'
      ? "The version this server loaded, from its model_metadata.json. Serve mode curve_offset does not run it. A venue's own data answers only while it is loaded."
      : serving && serving.mode === 'model_when_fresh'
        ? 'The version this server loaded, from its model_metadata.json. Serve mode model_when_fresh runs it where a venue has a live reading from the hour before.'
        : 'The version this server loaded, from its model_metadata.json.';
  } else versionNote = 'No model is loaded in this server process yet, so this is the version of the artifact on disk, scripts/ml/models/model_metadata.json.';
  // What made the venue-hours scored below: the venue's curve, the trained
  // model, or some of each, as the server counted them.
  const scoredMadeBy = ready && Number.isFinite(a.matched) ? hubMadeBy(a.fromCurve, a.matched) : null;
  let gapValue = 'Not measured yet';
  let gapTone = 'muted';
  let gapNote = 'Waits for the check above to answer.';
  if (shareArrived) gapNote = 'Waits for both shares above.';
  else if (ready) gapNote = 'Waits for enough observations to measure the shares.';
  // Only beside a share this card draws: a gap from a sample under the
  // minimum would be the noisy percentage by another name.
  if (measured && Number.isFinite(gap)) {
    gapValue = gap > 0 ? `${gap.toFixed(1)} points` : 'Met';
    gapTone = gap > 0 ? 'warn' : 'good';
    gapNote = gap > 0 ? 'The goal less the within-one share, in percentage points.' : 'The within-one share is at or above the goal.';
  }
  return (
    <HubCard id={HUB_CARD.model.id} title="Model" sub="What makes Flock's crowd numbers now, and how the served ones held up against what the collector measured in the same hour.">
      <div className="hub-halves">
        <div style={{ minWidth: 0 }}>
          {serving && (
            <HubRow
              navy={navy}
              label="Made by"
              value={hubServeModeLabel(serving.mode)}
              tone={servingWords ? undefined : 'muted'}
              note={servingWords || 'The server did not say which serve mode it runs.'}
            />
          )}
          <HubRow
            navy={navy}
            label="Model version"
            tag={v.status === 'ok' && v.loaded === false ? { tone: 'warn', text: 'Not loaded' } : null}
            value={v.status === 'ok' ? v.value : 'Not read'}
            tone={v.status === 'ok' ? undefined : 'muted'}
            note={versionNote}
          />
          <p style={hubStyle.kicker}>Against the live reading, last {Number.isFinite(a.windowDays) ? a.windowDays : 30} days</p>
          {!ready && <HubNotice status={a.status} reason={a.reason} />}
          {measured && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px', marginTop: '4px' }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ ...hubStyle.big, color: navy }}>{hubPct(a.exactPercent)}</p>
                  <p style={hubStyle.note}>named the exact crowd level of the reading</p>
                </div>
                <div style={{ minWidth: 0 }}>
                  <p style={{ ...hubStyle.big, color: navy }}>{hubPct(a.percent)}</p>
                  <p style={hubStyle.note}>landed within one level, the reading&apos;s or the one next to it</p>
                </div>
              </div>
              {/* Both shares on one 0 to 100 scale, the exact one darker inside
                  the within-one one, with the goal as a mark. The words above and
                  the goal row below carry every number. */}
              <div className="hub-meter" aria-hidden="true" style={{ marginTop: '12px' }}>
                <div className="hub-meter-fill" style={{ width: `${Math.min(100, Math.max(0, a.percent))}%`, backgroundColor: 'var(--hub-c2)' }} />
                <div className="hub-meter-fill" style={{ width: `${Math.min(100, Math.max(0, a.exactPercent))}%`, backgroundColor: colors.steel }} />
                {Number.isFinite(goal.percent) && <span className="hub-meter-mark" style={{ left: `${Math.min(100, Math.max(0, goal.percent))}%` }} />}
              </div>
            </>
          )}
          {shareArrived && !measured && (
            <>
              <p style={{ fontSize: 'var(--t-title)', fontWeight: '600', color: navy, margin: '2px 0 0', lineHeight: 1.25 }}>Not shown alone</p>
              <p style={hubStyle.note}>
                This server sent the within-one share without the exact level beside it. Within one alone would flatter a forecast that always named the same level, so neither is shown until both arrive.
              </p>
            </>
          )}
          {ready && !shareArrived && (
            <>
              <p style={{ fontSize: 'var(--t-title)', fontWeight: '600', color: navy, margin: '2px 0 0', lineHeight: 1.25 }}>Not enough observations yet</p>
              <p style={hubStyle.note}>
                {hubCount(a.matched)} venue-hours over {hubPlural(a.days, 'day', 'days')} so far, from {hubPlural(a.served, 'forecast', 'forecasts')} served. The shares show from {hubCount(a.minSample)} venue-hours across at least {hubPlural(a.minDays, 'day', 'days')}; below that they mostly measure chance.
              </p>
            </>
          )}
          <div style={{ marginTop: '8px' }}>
            <HubRow
              navy={navy}
              label="Goal"
              value={Number.isFinite(goal.percent) ? `${goal.percent}%` : 'Not set'}
              note="Of served forecasts within one crowd level. Not the blended training figure, which mostly scores rows whose answer was known in advance."
            />
            <HubRow navy={navy} label="Gap to goal" value={gapValue} tone={gapTone} note={gapNote} />
          </div>
          <HubWhy>
            {measured && (
              <p>
                Of forecasts made from a venue&apos;s own data. n&nbsp;=&nbsp;{hubCount(a.matched)} venue-hours over {hubPlural(a.days, 'day', 'days')}{Number.isFinite(a.exactBand) && Number.isFinite(a.withinOneBand) ? `, ${hubCount(a.exactBand)} at the exact level and ${hubCount(a.withinOneBand)} within one` : ''}, from {hubPlural(a.served, 'forecast', 'forecasts')} served in the window. Within one alone would flatter a forecast that always named the same level, so the exact share sits beside it.
              </p>
            )}
            {versions.length > 1 && `This window mixes ${versions.length} served versions: ${versions.join(', ')}. A +curve_offset or +nowcast ending names a switch that changed the number.`}
            <p>
              Counts forecasts made from a venue&apos;s own data (served_predictions, prediction_method ml) on the venue card and the vote list.{scoredMadeBy ? ` Of the ${hubPlural(a.matched, 'venue-hour', 'venue-hours')} scored, ${scoredMadeBy}.` : ''} Each is paired with the collector&apos;s live reading of the same venue in the same hour of the same day (ml_training_data), one pair per venue and hour, and scored on the crowd levels the app prints{ladder ? `: ${ladder}` : ''}. Checked on the server and held for {holdMinutes === 60 ? 'an hour' : `${holdMinutes} minutes`}{age}.
            </p>
          </HubWhy>
        </div>
        {/* WHAT ANSWERED. The shares above score forecasts made from a venue's
            own data only, so on their own they cannot say whether those were most
            of what people saw or almost none of it, the rest coming from the
            rule engine. This is that split, from the same table, beside it, as
            bars on one scale. */}
        {cov && (
          <div style={{ minWidth: 0 }}>
            <p style={hubStyle.kicker}>What answered, last {Number.isFinite(cov.windowDays) ? cov.windowDays : 7} days</p>
            {cov.status !== 'ok' && <HubNotice status={cov.status} reason={cov.reason} />}
            {cov.status === 'ok' && cov.total === 0 && (
              <HubRow navy={navy} label="Forecasts from a venue's own data" value="None served" tone="muted" note="No forecast was served to a signed-in person in this window." />
            )}
            {cov.status === 'ok' && cov.total > 0 && (() => {
              const madeBy = hubMadeBy(cov.mlFromCurve, cov.ml);
              // The ml count named by what made it, where the server split it.
              const pairs = cov.byMethod.flatMap((x) => {
                if (x.method !== 'ml' || !Number.isFinite(cov.mlFromCurve)) return [[hubMethodWords(x.method), x.served, x.method === 'ml']];
                const curve = Math.min(Math.max(cov.mlFromCurve, 0), x.served);
                return [[HUB_FROM_CURVE, curve, true], [HUB_FROM_MODEL, x.served - curve, true]]
                  .filter(([, n]) => n > 0);
              });
              const parts = pairs.map(([words, n]) => `${words} ${hubCount(n)}`);
              return (
                <>
                  <HubRow
                    navy={navy}
                    label="Forecasts from a venue's own data"
                    value={`${Math.round(cov.mlPercent)}% of ${hubCount(cov.total)}`}
                    note={`${hubCount(cov.ml)} of ${hubPlural(cov.total, 'forecast', 'forecasts')} served to signed-in people, counted once per card served, from served_predictions.${madeBy ? ` Of those, ${madeBy}.` : ''} The Costs tab counts forecast hours since the last deploy instead, so the two differ.`}
                  />
                  {cov.topFallback && (
                    <HubRow
                      navy={navy}
                      label="Most common fallback"
                      value={hubCount(cov.topFallback.served)}
                      note={`${hubMethodWords(cov.topFallback.method).replace(/^./, (ch) => ch.toUpperCase())}, across ${hubPlural(cov.topFallback.venues, 'venue', 'venues')}.${HUB_NO_BASELINE_METHODS.includes(cov.topFallback.method) ? ' A venue gets numbers from its own data once the collector has read it.' : ''}`}
                    />
                  )}
                  <HubBarList
                    color={colors.steel}
                    rows={pairs.map(([words, n, own], i) => ({
                      key: `answered-${i}`,
                      label: words.replace(/^./, (ch) => ch.toUpperCase()),
                      value: n,
                      valueText: hubCount(n),
                      color: own ? colors.steel : 'var(--text-tertiary)',
                    }))}
                  />
                  <HubWhy>{`By what answered: ${parts.join('; ')}. Held for an hour with the check above.`}</HubWhy>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </HubCard>
  );
}

// PEOPLE: who signed up, whether new accounts start anything, how many people
// used Flock this week, and what became of the plans they made. Every figure
// is the server's count (backend/services/moneyHub.js, PEOPLE), of people
// accounts only, and each row says what it counts. A share under the server's
// floor arrives as null and is drawn as its two counts, never as a percentage.

// The fortnight of signups as one plain bar per New York day. Bars rise from
// one baseline with rounded tops, a day with nobody new is a flat stub so the
// strip always reads as fourteen days, and today, which is still filling,
// is drawn lighter and labelled. The label on the strip lists every day's
// count, so a screen reader gets the numbers the bars stand for.
function HubSignupBars({ days, navy }) {
  const peak = days.reduce((m, d) => Math.max(m, d.n), 0);
  const H = 48;
  const words = days.map((d, i) => `${i === days.length - 1 ? 'today' : hubDay(d.day)} ${hubCount(d.n)}`).join(', ');
  return (
    <div>
      <div role="img" aria-label={`Signups each day: ${words}.`} style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: `${H}px`, borderBottom: '1px solid var(--border-default)' }}>
        {days.map((d, i) => {
          const today = i === days.length - 1;
          const h = d.n === 0 || peak === 0 ? 2 : Math.max(4, Math.round((d.n / peak) * H));
          return (
            <div
              key={d.day}
              title={`${today ? 'Today so far' : hubDay(d.day)}: ${hubCount(d.n)}`}
              style={{ flex: '1 1 0', minWidth: 0, height: `${h}px`, borderRadius: d.n === 0 ? '1px' : '4px 4px 0 0', backgroundColor: d.n === 0 ? 'var(--border-default)' : navy, opacity: today && d.n > 0 ? 0.55 : 1 }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '4px', fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
        <span>{hubDay(days[0].day)}</span>
        <span>{peak > 0 ? `Busiest day ${hubCount(peak)}` : 'Nobody new'}</span>
        <span>Today so far</span>
      </div>
    </div>
  );
}

function HubPeople({ h, colors }) {
  const p = h.people;
  // A server from before this block sends none of it: no card, not an empty one.
  if (!p) return null;
  const navy = colors.navy;
  const pct = (x) => `${Math.round(x)}%`;
  // The server withholds a share under its floor; this is the screen's own
  // half of that rule, so an older or broken server cannot put one here.
  const shown = (share, whole, floor) => Number.isFinite(share) && Number.isFinite(floor) && whole >= floor;
  let body;
  if (p.status !== 'ok') {
    body = <HubNotice status="error" reason={p.reason} />;
  } else {
    const s = p.signups;
    const a = p.activation;
    const act = p.active;
    const pl = p.plans;
    const fortnight = s.days.reduce((sum, d) => sum + d.n, 0);
    let activationValue;
    let activationNote;
    if (a.cohort === 0) {
      activationValue = 'None yet';
      activationNote = `No people account is ${a.fromDays} to ${a.toDays} days old, so no first week has finished inside the window.`;
    } else {
      const share = shown(a.percent, a.cohort, a.minForShare);
      activationValue = share ? pct(a.percent) : `${hubCount(a.activated)} of ${hubCount(a.cohort)}`;
      activationNote = `${hubCount(a.activated)} of the ${hubPlural(a.cohort, 'account', 'accounts')} made ${a.fromDays} to ${a.toDays} days ago made a plan or accepted one within ${a.windowDays} days of signing up.${share ? '' : ` The share shows from ${hubCount(a.minForShare)} accounts.`}`;
    }
    let confirmedValue;
    let confirmedNote;
    if (pl.passedLast7 === 0) {
      confirmedValue = 'None';
      confirmedNote = 'No plan made by a people account had its time come in the last 7 days.';
    } else {
      const share = shown(pl.confirmedPercent, pl.passedLast7, pl.minForShare);
      confirmedValue = share ? pct(pl.confirmedPercent) : `${hubCount(pl.confirmedLast7)} of ${hubCount(pl.passedLast7)}`;
      confirmedNote = `Of the ${hubPlural(pl.passedLast7, 'plan', 'plans')} whose time came in the last 7 days, ${hubCount(pl.confirmedLast7)} had been confirmed.${share ? '' : ` The share shows from ${hubCount(pl.minForShare)} plans.`}`;
    }
    body = (
      <>
        <p style={{ ...hubStyle.kicker, marginTop: '4px' }}>Signups, last 14 days</p>
        <HubSignupBars days={s.days} navy={colors.steel} />
        {fortnight === 0 && <p style={hubStyle.note}>Nobody signed up in the last 14 days.</p>}
        <div style={{ marginTop: '8px' }}>
          {/* The week before is on the line under each weekly count, so the
              trend reads without opening anything; what each count counts is
              behind the row. */}
          <HubRow
            navy={navy}
            label="Signups, last 7 days"
            value={hubCount(s.last7)}
            sub={`${hubCount(s.prior7)} in the 7 days before`}
            note="Both count back from now, so a morning never reads as a drop. The bars are New York days."
          />
          <HubRow navy={navy} label="Made or accepted a plan in their first week" value={activationValue} note={activationNote} />
          <HubRow
            navy={navy}
            label="Used Flock, last 7 days"
            value={hubCount(act.last7)}
            sub={`${hubCount(act.prior7)} in the 7 days before`}
            note="Each person once, for a message or DM, a venue vote, a plan made or accepted, or a crowd forecast opened while signed in."
          />
          <HubRow navy={navy} label="Plans made, last 7 days" value={hubCount(pl.madeLast7)} sub={`${hubCount(pl.madePrior7)} in the 7 days before`} />
          <HubRow navy={navy} label="Confirmed before their time" value={confirmedValue} note={confirmedNote} />
          <HubRow
            navy={navy}
            label="Guest answers from share links"
            value={hubCount(pl.guestAnswersLast7)}
            sub={`${hubCount(pl.guestAnswersPrior7)} in the 7 days before`}
            note="Someone without an account answering a plan's link, in or out."
          />
        </div>
      </>
    );
  }
  return (
    <HubCard
      id={HUB_CARD.people.id}
      title="People"
      sub={`People accounts only: not venue owners, admins or banned accounts. Counts from the database${p.status === 'ok' ? `, read at ${hubTime(p.asOf)}` : ''}.`}
    >
      {body}
    </HubCard>
  );
}

// The picture beside each problem, by what it is about rather than how bad
// it is: the chip beside it carries the tone, in words.
const HUB_NEED_ICON = {
  collector: 'activity',
  besttime: 'zap',
  prices: 'tag',
  stripe: 'creditCard',
  'stripe-part': 'creditCard',
  'stripe-test': 'creditCard',
  disputes: 'flag',
  revenuecat: 'users',
  'pro-nothing-live': 'users',
  model: 'barChart',
  steps: 'checkCircle',
  doubles: 'layers',
  'past-end': 'calendar',
  expenses: 'fileText',
  jumps: 'trendingUp',
  'price-sheet': 'repeat',
  maptiler: 'map',
  'maptiler-cap': 'map',
  'maptiler-near': 'map',
  licence: 'fileText',
};
const hubNeedIcon = (key) => HUB_NEED_ICON[key]
  || (/^(past-due|unpaid)-/.test(key) ? 'clock' : /^resend/.test(key) ? 'mail' : 'alertCircle');

// Whole calendar days from one YYYY-MM-DD to another, or null. Both are New
// York dates from the server, so no zone is involved.
function hubDaysUntil(fromYmd, toYmd) {
  const utc = (ymd) => {
    if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const a = utc(fromYmd);
  const b = utc(toYmd);
  return a === null || b === null ? null : Math.round((b - a) / 86400000);
}

// Moves the Overview to a card without touching the address bar, where a hash
// would ride along on every refresh and every copied link afterwards.
function hubJump(id) {
  return (e) => {
    e.preventDefault();
    const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const still = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    // And focus follows, so a keyboard or screen reader user lands on the card
    // the link named instead of staying on the link with the page moved under
    // them (money hub audit 2026-10-03).
    if (typeof el.focus === 'function') {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    }
  };
}

// One problem per line: a picture for what it is about, its name, and a chip
// with the count or the state in its tone. A tap opens the sentence the card
// below would say, with the jump to that card at its end.
function HubAttention({ h }) {
  const { problems } = hubAttention(h);
  const at = hubTime(h.generatedAt);
  const checked = at ? `Checked at ${at}.` : '';
  // The quiet morning is one line, and says when it was true.
  if (problems.length === 0) {
    return (
      <HubCard id="hub-needs">
        <p style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--accent-green-text)', margin: 0 }}>
          {Icons.checkCircle('currentColor', 16)}{`Nothing needs you. ${checked}`.trim()}
        </p>
      </HubCard>
    );
  }
  return (
    <HubCard
      id="hub-needs"
      title={hubPlural(problems.length, 'thing needs you', 'things need you')}
      sub={[checked, 'Tap one for the detail and where to fix it.'].filter(Boolean).join(' ')}
    >
      {problems.map((r) => {
        const icon = Icons[hubNeedIcon(r.key)] || Icons.alertCircle;
        return (
          <details key={r.key} className="hub-need hub-disclose" data-hub-fig="" data-hub-need={r.key}>
            <summary className="hit44">
              <div className="hub-need-head">
                <span className="hub-need-icon" style={{ color: HUB_TONE[r.tone] || 'var(--text-secondary)' }}>{icon('currentColor', 16)}</span>
                <span className="hub-need-label">{r.label}</span>
                <HubChip tone={r.tone}>{r.value}</HubChip>
                {hubChevron()}
              </div>
            </summary>
            {/* The jump sits at the end of the sentence rather than on a line
                of its own. */}
            <div className="hub-need-more">
              <p className="hub-note">
                {r.note}{' '}
                <a className="hit44" href={`#${r.card.id}`} onClick={hubJump(r.card.id)} style={{ ...hubStyle.link, marginTop: 0, whiteSpace: 'nowrap' }}>{r.card.link}</a>
              </p>
            </div>
          </details>
        );
      })}
    </HubCard>
  );
}

function MoneyHub({ colors, onExpensesChanged }) {
  const [data, setData] = React.useState(hubMemo.data);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const load = React.useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const d = await getAdminMoneyHub({ refresh });
      hubMemo.data = d;
      hubMemoChanged();
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
      <>
      <div role="status">
        <div style={{ ...hubStyle.card, border: `1px dashed ${colors.creamDark}` }}>
          <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' }}>
            {loading ? 'Reading Stripe, RevenueCat, BestTime and the database' : error ? 'The money hub did not load' : 'Nothing read yet'}
          </h3>
          <p style={hubStyle.sub}>
            {loading ? 'The first read asks each vendor and can take a few seconds.' : error ? `${error} Nothing is shown rather than a guess.` : 'The hub has not been read yet.'}
          </p>
          {!loading && (
            <button className="hit44" type="button" onClick={() => load(false)}
              style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>
              {error ? 'Try again' : 'Read it'}
            </button>
          )}
        </div>
        {/* Where the tiles are about to land, while the first read is out. A
            shape and never a number: a figure nobody read is the one thing
            this screen must not paint. */}
        {loading && (
          <div className="hub-tiles" aria-hidden="true" style={{ marginTop: '12px' }}>
            {[0, 1, 2, 3].map((i) => <div key={`tile-skeleton-${i}`} className="skeleton" style={{ height: '96px', borderRadius: '14px' }} />)}
          </div>
        )}
      </div>
      {/* Revoking a key never waits on the hub: a hub that did not load still
          lists the keys, each with its Revoke. Outside the status region, so
          it is not read out as part of the failure. */}
      {error && !loading && <div style={{ marginTop: '12px' }}><HubAccessKeys colors={colors} /></div>}
      </>
    );
  }

  // The month's four tiles first: on a phone they and the top of Needs you are
  // the first screen under the console's header and tabs. Then two pairs that
  // sit side by side on the wide console and stack on a phone, in the order
  // written here: what needs the owner beside whether subscribers cover the
  // bills, then what is about to be charged beside where the money goes.
  //
  // The cards after them sit in bands of two stacks on the wide console
  // (App.js consoleContainer) and in one column on a phone, where the order
  // is the one written here. Stacks rather than one grid: a grid row is as
  // tall as its taller card, and "Only you can do these" beside People left
  // most of a screen blank; CSS columns balanced the tall Revenue card into
  // the first column and left the second half empty. Each stack runs on its
  // own, paired so the two come out close in height: Health, short, rides
  // under the steps, since both say what is working, and the access keys,
  // also short, under Health. The expense list, crowd data and the model read
  // across a row, so they take the full width.
  const full = { margin: '0 0 12px', minWidth: 0 };
  return (
    <div>
      <HubMonth h={data} colors={colors} loading={loading} onRefresh={() => load(true)} />
      <div className="hub-pair">
        <HubAttention h={data} />
        <HubCover h={data} colors={colors} />
      </div>
      <div className="hub-pair">
        <HubComingUp h={data} colors={colors} />
        <HubCosts h={data} colors={colors} />
      </div>
      <div className="hub-pair">
        <div className="hub-stack-col">
          <HubPeople h={data} colors={colors} />
          <HubOwnerActions h={data} colors={colors} />
          <HubHealth h={data} colors={colors} />
          <HubAccessKeys colors={colors} />
        </div>
        <div className="hub-stack-col">
          <HubRevenue h={data} colors={colors} />
        </div>
      </div>
      {/* An expense saved here is also in the Costs tab's all-in figure and
          the Projections burn, which read the separate costs payload. That
          payload was fetched once per session, so after adding a bill here
          Costs still showed the old total while its own comment says the two
          tabs cannot disagree (money hub audit 2026-10-03). Both reload. */}
      <div style={full}><HubExpenses h={data} colors={colors} onChanged={() => { load(false); if (onExpensesChanged) onExpensesChanged(); }} /></div>
      <div className="hub-pair">
        <div className="hub-stack-col">
          <HubPrices h={data} colors={colors} />
        </div>
        <div className="hub-stack-col">
          <HubPriceSheet h={data} colors={colors} />
        </div>
      </div>
      <div style={full}><HubCrowdData h={data} colors={colors} /></div>
      <div style={full}><HubModel h={data} colors={colors} /></div>
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
  operatingCostsSource,
  researchDemoMode,
  researchError,
  researchLiveData,
  researchLoading,
  setAdminTab,
  setAvgSpend,
  setEventsPerVenue,
  setNumVenues,
  setOperatingCosts,
  setOperatingCostsSource,
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

    // The simulator's operating cost starts at the hub's real monthly burn
    // once the Overview has read it, instead of a round $2,000 nobody chose.
    // Only while it still holds the placeholder, and only once, so a figure
    // typed in is never overwritten.
    // Where the operating cost came from lives in FlockAppInner with the value
    // ('placeholder', 'seeded' or 'typed'), so leaving the console and coming
    // back cannot forget that a figure was typed (review 2026-10-03). The
    // seed waits on hubTick, which moves when the hub's figures arrive, so a
    // burn that lands after Projections opened still seeds it.
    const [hubTick, setHubTick] = React.useState(0);
    React.useEffect(() => {
      const fn = () => setHubTick((t) => t + 1);
      hubMemo.subs.add(fn);
      return () => { hubMemo.subs.delete(fn); };
    }, []);
    React.useEffect(() => {
      if (operatingCostsSource !== 'placeholder' || activeTab !== 'projections') return;
      const burn = hubMemo.data && hubMemo.data.net ? hubMemo.data.net.burnCents : null;
      if (!Number.isFinite(burn)) return;
      // Rounded up to the whole dollar the field holds, so the seeded cost
      // is never below the real burn.
      setOperatingCosts(Math.max(0, Math.ceil(burn / 100)));
      setOperatingCostsSource('seeded');
    }, [activeTab, hubTick, operatingCostsSource, setOperatingCosts, setOperatingCostsSource]);

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
      margin: '3px 0 0',
      lineHeight: 1.4,
    };

    return (
      <div key="revenue-screen-container" className="hub-root" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        <style>{HUB_CSS}</style>
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
        <div style={{ display: 'flex', backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', flexShrink: 0, padding: '6px', gap: '4px' }}>
          {adminTabs.map(tab => (
            <button className="hit44" key={tab.id} aria-pressed={activeTab === tab.id} onClick={() => setAdminTab(tab.id)} style={{ flex: 1, minWidth: 0, padding: '8px 4px', border: 'none', backgroundColor: activeTab === tab.id ? colors.navyBg : 'transparent', borderRadius: '10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', transition: 'background-color 0.15s ease' }}>
              {tab.icon(activeTab === tab.id ? 'white' : 'var(--text-secondary)', 18)}
              <span style={{ fontSize: 'var(--t-meta)', fontWeight: activeTab === tab.id ? '600' : '500', color: activeTab === tab.id ? 'white' : 'var(--text-secondary)' }}>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* OVERVIEW TAB: the money hub, defined above this component. */}
          {activeTab === 'overview' && (
            <MoneyHub colors={colors} onExpensesChanged={() => fetchCosts(true)} />
          )}

          {/* THE WHAT-IF SIMULATOR, at the top of the Projections tab. It was
              the Revenue tab until 2026-09-25, when real revenue got a tab of
              its own; it is arithmetic on typed inputs, which is what the
              Projections tab is for. The inputs still live in FlockAppInner. */}
          {activeTab === 'projections' && (<>
          <div className="hub-month-head">
            <div style={{ minWidth: 0 }}>
              <h2 className="hub-month-title">What-if simulator</h2>
              <p className="hub-month-sub">Type a venue count and a price and read what they would add up to. Real subscribers and revenue are on the Overview tab.</p>
            </div>
          </div>
          <div className="hub-sim">

            {/* INPUTS */}
            <HubCard title="Inputs">
              <div className="hub-fields">
                {/* Number of Venues */}
                <div>
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
                <div>
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
                <div>
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
                <div>
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
                <div>
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
                  <p style={helperStyle}>% of each transaction. Flock takes none today; this is a what-if.</p>
                </div>

                {/* Operating Costs */}
                <div>
                  <label style={labelStyle} htmlFor="rev-costs">Monthly Operating Costs</label>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>$</span>
                    <input id="rev-costs"
                      type="number"
                      value={operatingCosts}
                      onChange={(e) => { setOperatingCostsSource('typed'); setOperatingCosts(Math.max(0, parseInt(e.target.value) || 0)); }}
                      style={{ ...inputStyle, paddingLeft: '28px' }}
                      min="0"
                    />
                  </div>
                  <p style={helperStyle}>Starts at the monthly burn the Overview reads; type over it to try another.</p>
                </div>
              </div>
            </HubCard>

            {/* OUTPUTS: what the typed numbers come to, as tiles, then the
                same money as bars on one scale, then the working. */}
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 2px 8px', lineHeight: '1.4' }}>
                Arithmetic on the numbers you typed, not measurements. The real numbers are on the Overview tab.
              </p>
              <div className="hub-tiles" style={{ marginBottom: '12px' }}>
                <HubTile navy={colors.navy} label="Revenue a month" value={formatCurrency(totalMonthlyRevenue)} sub="Subscriptions and transactions" />
                {/* Profitability: the accent tokens' text on the accent wash
                    it is designed against, and both flip with the theme. A
                    hardcoded light mint here once read about 1.7:1 in dark
                    mode. */}
                <HubTile navy={colors.navy} label="Profit a month" value={`${monthlyProfit >= 0 ? '+' : ''}${formatCurrency(monthlyProfit)}`} tone={isProfitable ? 'good' : 'bad'} wash={isProfitable ? 'var(--accent-green-bg)' : 'var(--accent-red-bg)'} sub={isProfitable ? 'Profitable' : 'Not Profitable'} />
                <HubTile
                  navy={colors.navy}
                  label="Break-even point"
                  value={breakEvenReachable ? hubPlural(breakEvenVenues, 'venue', 'venues') : 'Not reachable'}
                  tone={!breakEvenReachable ? 'muted' : isAboveBreakEven ? 'good' : undefined}
                  sub={!breakEvenReachable
                    ? 'A venue brings in nothing at these inputs, so there is no break-even point.'
                    : isAboveBreakEven
                      ? `${hubPlural(numVenues - breakEvenVenues, 'venue', 'venues')} above break-even`
                      : `Need ${hubPlural(breakEvenVenues - numVenues, 'more venue', 'more venues')}`}
                />
                <HubTile navy={colors.navy} label="Revenue per venue" value={revenuePerVenueDefined ? `${formatCurrency(revenuePerVenue)}/mo` : 'n/a'} sub="Each venue, a month" />
              </div>
              <HubCard title="Projected Revenue" style={{ marginBottom: '12px' }}>
                <HubBarList
                  color={colors.steel}
                  rows={[
                    { key: 'sim-subs', label: 'Subscriptions', value: subscriptionRevenue, valueText: formatCurrency(subscriptionRevenue), color: colors.steel },
                    { key: 'sim-txn', label: 'Transactions', value: transactionRevenue, valueText: formatCurrency(transactionRevenue), color: 'var(--hub-c2)' },
                    { key: 'sim-costs', label: 'Operating costs', value: operatingCosts, valueText: formatCurrency(operatingCosts), color: 'var(--hub-c3)' },
                  ]}
                />
                <HubRow navy={colors.navy} label="Monthly Total" value={formatCurrency(totalMonthlyRevenue)} />
                {/* Not ARR. ARR may only count the recurring stream; this is
                    the monthly total times twelve, so it folds in transaction
                    revenue and assumes no venue ever cancels. */}
                <HubRow
                  navy={colors.navy}
                  label="Annualised run rate"
                  value={formatCurrency(annualRevenue)}
                  note="This month times twelve. It includes transaction fees, which are not recurring, and assumes no venue cancels."
                />
                <HubRow navy={colors.navy} label="Profit Margin" value={marginDefined ? `${profitMargin.toFixed(1)}%` : 'n/a'} tone={isProfitable ? 'good' : 'bad'} />
              </HubCard>

              {/* Business Model Info */}
              <HubCard title="The plan behind these numbers">
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.5' }}>
                  Two streams: a monthly <strong>venue subscription</strong> (Roost), which recurs, and a
                  cut of <strong>group transactions</strong>, which would not. Roost billing is built and
                  switched off, and no transaction fee exists in the product, so every figure above is what the
                  arithmetic would say if the inputs on the left were real.
                </p>
              </HubCard>
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

            // The Overview's parts, so the two tabs read as one console: a
            // bordered card, each headline figure in a box of its own, and
            // every row's note behind a tap on the row (THE LOOK, above).
            const card = hubStyle.card;
            const h3 = { fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' };
            const sub = { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.45 };
            const big = { fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '4px 0 0', lineHeight: 1.15, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' };
            const kicker = { fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.3 };
            const foot = { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.45 };

            const row = (key, left, right, note) => (
              <HubRow key={key} navy={colors.navy} label={left} value={right} note={note} />
            );

            // The mark on a figure nobody has seen on an invoice. It sits
            // beside the LABEL rather than the amount because the amount is
            // the part that has to stay scannable, and a reader who takes the
            // number without the tag has still read a marked row.
            const unverifiedTag = hubTag('warn');

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
              <details key={e.id} className="hub-row hub-disclose" data-hub-fig="">
                <summary className="hit44">
                  <div className="hub-row-head">
                    <span className="hub-row-label">
                      {e.label}
                      {!e.verified && <span style={unverifiedTag}>Unverified</span>}
                    </span>
                    <span className="hub-row-value" style={{ color: colors.navy }}>{moneyOr(e.usd, 'No figure')}{period}</span>
                    {hubChevron()}
                  </div>
                </summary>
                <div className="hub-row-more">
                  <p className="hub-note">
                    {e.verified
                      ? `Seen on an invoice. Checked ${e.checked}.`
                      : `Not seen on an invoice. This is a published price or an assumption, counted in the totals anyway. Checked ${e.checked}.`}
                    {e.note ? ` ${e.note}` : ''}
                    {e.source ? ` ${e.source}` : ''}
                  </p>
                </div>
              </details>
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
            // Railway's row joins the reconciled block rather than the fixed
            // one: its bill is the plan fee plus usage past the credit, so the
            // figure is the one recorded on the Reconciled card above.
            const reconciledById = Object.fromEntries((d.reconciled?.lines || []).map((l) => [l.id, l]));

            const depLine = { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 4px', lineHeight: 1.5 };

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
              if (e.reconciledId && reconciledById[e.reconciledId]) {
                const r = reconciledById[e.reconciledId];
                return Number.isFinite(r.usdPerMonth) ? `${money(r.usdPerMonth)}/mo` : 'No figure';
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

            const depBlock = (e) => {
              const w = e.watchlistId ? watchById[e.watchlistId] : null;
              return (
                <details key={e.id} className="hub-row hub-disclose" data-hub-fig="">
                  <summary className="hit44">
                    <div className="hub-row-head">
                      <span className="hub-row-label" style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{e.label}</span>
                      <span className="hub-row-value" style={{ color: colors.navy }}>{depCost(e)}</span>
                      {hubChevron()}
                    </div>
                  </summary>
                  <div className="hub-row-more">
                  <p style={depLine}>{e.what} Lives in {e.where}.</p>
                  <p style={depLine}>
                    Price: {e.unitPrice || (e.unpriceable ? 'no published rate on file for this model id' : 'no published unit price')}.
                    {e.freeTier ? ` Free tier: ${e.freeTier}.` : ''}
                  </p>
                  <p style={depLine}>Usage: {depUsage(e)} {depConfigured(e)}</p>
                  {/* MapTiler's reading lives on the money hub's payload
                      (costs.maptilerUsage), which this tab already reads for
                      the break-evens; hubTick re-renders it when that lands. */}
                  {e.id === 'maptiler' && (
                    <p style={depLine}>
                      {hubMemo.data && hubMemo.data.costs && hubMemo.data.costs.maptilerUsage
                        ? `This billing period: ${hubMaptilerLine(hubMemo.data.costs.maptilerUsage)}`
                        : 'This billing period\'s sessions and requests are read with the money hub, on the Overview tab.'}
                    </p>
                  )}
                  {/* Resend's whole count, transactional mail included, from
                      the same payload (costs.resendUsage). */}
                  {e.id === 'resend' && (
                    <p style={depLine}>
                      {hubMemo.data && hubMemo.data.costs && hubMemo.data.costs.resendUsage
                        ? `Live from Resend: ${hubResendLine(hubMemo.data.costs.resendUsage)}`
                        : 'Today\'s and this month\'s emails are read from Resend with the money hub, on the Overview tab.'}
                    </p>
                  )}
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
                </details>
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
            // A list cut short at the limit is missing bills: no all-in figure,
            // rather than the code's bills alone under the all-in label.
            const listCutShort = !!(d.expenses && d.expenses.truncated);
            const allInMonthly = ledger
              ? ledger.burnMonthlyUsd
              : (!listCutShort && Number.isFinite(fixed.effectiveMonthlyUsd) ? fixed.effectiveMonthlyUsd + reconciledTotal : null);

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

                {/* 1. THE ONE NUMBER THAT IS A BILL */}
                <div style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                    <div>
                      <h3 style={h3}>What this actually costs</h3>
                      <p style={sub}>Fixed bills plus the usage bills a human has read off each vendor's own billing page.</p>
                    </div>
                    <button className="hit44" disabled={costsLoading} onClick={() => fetchCosts()}
                      style={{ ...hubStyle.textButton, cursor: costsLoading ? 'default' : 'pointer', flexShrink: 0 }}>
                      {Icons.repeat('currentColor', 12)}{costsLoading ? 'Reading' : 'Refresh'}
                    </button>
                  </div>
                  <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                    <div className="hub-stat">
                      <p style={kicker}>All in, monthly</p>
                      <p style={big}>{moneyOr(allInMonthly, 'Not measured', 0)}</p>
                      <p className="hub-stat-note">
                        {ledger
                          ? `The code's fixed bills, the reconciled bills, and ${ledger.activeRows} ${ledger.activeRows === 1 ? 'bill' : 'bills'} from the expense list, each counted once.`
                          : `${moneyOr(fixed.effectiveMonthlyUsd, 'no fixed total', 0)} of fixed bills, plus ${moneyOr(reconciledTotal, 'nothing', 0)} of reconciled usage bills. ${d.expenses && d.expenses.readError ? d.expenses.readError : 'The expense list was not read.'}`}
                      </p>
                    </div>
                    <div className="hub-stat">
                      <p style={kicker}>Reconciled</p>
                      <p style={big}>{moneyOr(reconciledTotal, 'None on file', 0)}</p>
                      <HubWhy><p>
                        Read off each vendor's own bill by hand{d.reconciled?.oldestAsOf ? `, the oldest figure on ${d.reconciled.oldestAsOf}` : ''}. Nothing in the app can verify it, so the total is only as current as its oldest line.
                      </p></HubWhy>
                    </div>
                  </div>
                  {/* RECORD A PAID INVOICE HERE, NOT IN CODE. Until 2026-09-01
                      this figure was a constant in services/costModel.js, and
                      recording a bill meant editing that file and deploying.
                      Each line below saves to cost_reconciled through the
                      admin route; the panel, the cost heartbeat and the DECA
                      financial model all read the saved entry. A line marked
                      "from code" has never been recorded here. Railway joined
                      Google Cloud here on 2026-09-28, recorded from the
                      estimated bill `railway usage` prints for the period. */}
                  {d.reconciled && Array.isArray(d.reconciled.lines) && (
                    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-default)' }}>
                      <p style={kicker}>Record a bill</p>
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
                    // Withheld with the all-in figure when the list is cut
                    // short: its infrastructure bills are missing from it too.
                    const infra = ledger
                      ? ledger.infrastructureMonthlyUsd
                      : (!listCutShort && Number.isFinite(fixed.infrastructureMonthlyUsd) ? fixed.infrastructureMonthlyUsd + reconciledTotal : null);
                    const tooling = ledger ? ledger.toolingMonthlyUsd : null;
                    const listPrice = Number.isFinite(d.venues?.priceUsd) && d.venues.priceUsd > 0 ? d.venues.priceUsd : null;
                    // What a venue leaves after Stripe's fees, from the hub the
                    // Overview loaded, so this and the Overview agree; the list
                    // price until it has.
                    const roostBe = hubMemo.data && hubMemo.data.net && hubMemo.data.net.breakEven && hubMemo.data.net.breakEven.roost;
                    const roostCents = roostBe ? (Number.isFinite(roostBe.netPerUnitExactCents) ? roostBe.netPerUnitExactCents : roostBe.netPerUnitCents) : null;
                    const roostNet = Number.isFinite(roostCents) && roostCents > 0 ? roostCents / 100 : null;
                    const price = roostNet || listPrice;
                    const venuesFor = (usd) => (price && Number.isFinite(usd) ? Math.max(0, Math.ceil(usd / price)) : null);
                    const infraVenues = venuesFor(infra);
                    const allVenues = venuesFor(allInMonthly);
                    const plural = (n) => (n === 1 ? 'venue' : 'venues');
                    return (
                      <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-default)' }}>
                        <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                          <div className="hub-stat">
                            <p style={kicker}>Serving venues</p>
                            <p style={big}>{moneyOr(infra, 'Not measured', 0)}</p>
                            <HubWhy><p>Hosting, data vendors and the reconciled Google Cloud and Railway bills. This is the number to quote as what it costs to serve.</p></HubWhy>
                          </div>
                          <div className="hub-stat">
                            <p style={kicker}>Development tooling</p>
                            <p style={big}>{moneyOr(tooling, 'Not read', 0)}</p>
                            <HubWhy><p>
                              {ledger
                                ? 'Real bills that no user causes, from the expense list on the Overview tab. In the all-in total, and not in the cost of service.'
                                : 'The expense list, where tooling bills live, could not be read, so this is not shown rather than shown as zero.'}
                            </p></HubWhy>
                          </div>
                        </div>
                        {Number.isFinite(infra) && Number.isFinite(tooling) && infra + tooling > 0 && (
                          <>
                            <div className="hub-stack" aria-hidden="true" style={{ marginTop: '10px' }}>
                              {infra > 0 && <div style={{ width: `${(infra / (infra + tooling)) * 100}%`, backgroundColor: colors.steel }} />}
                              {tooling > 0 && <div style={{ width: `${(tooling / (infra + tooling)) * 100}%`, backgroundColor: 'var(--hub-c2)' }} />}
                            </div>
                            <div className="hub-legend" aria-hidden="true">
                              <span><span className="hub-swatch" style={{ backgroundColor: colors.steel }} />Serving venues</span>
                              <span><span className="hub-swatch" style={{ backgroundColor: 'var(--hub-c2)' }} />Development tooling</span>
                            </div>
                          </>
                        )}
                        {price ? (
                          <p style={{ ...sub, margin: '10px 0 0' }}>
                            At {moneyOr(roostNet && roostBe && Number.isFinite(roostBe.priceCents) ? roostBe.priceCents / 100 : (listPrice || price), '', 0)} a venue{roostNet ? `, ${moneyOr(roostNet, '', 2)} after Stripe's fees` : ', before Stripe’s fees'}, {infraVenues === null ? 'an unknown number of' : infraVenues} {plural(infraVenues)} covers serving and {allVenues === null ? 'an unknown number of' : allVenues} {plural(allVenues)} covers everything including tooling. Computed from the bills above, so it moves when they do.
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
                    <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                      <div className="hub-stat">
                        <p style={kicker}>Dependencies</p>
                        <p style={big}>{dep.total}</p>
                        <p className="hub-stat-note">
                          {dep.groups.map((g) => `${g.entries.length} ${g.short || g.id}`).join(', ')}.
                        </p>
                      </div>
                      <div className="hub-stat">
                        <p style={kicker}>Without a meter</p>
                        <p style={big}>{(dep.unmeteredIds || []).length}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {dep.total}</span></p>
                        <HubWhy><p>
                          Nothing here counts their usage, so those rows read as not measured. A zero meaning no meter and a zero meaning no spend are different facts.
                        </p></HubWhy>
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
                  <div key={g.id} style={card}>
                    <h3 style={h3}>{g.label}</h3>
                    <p style={{ ...sub, margin: '0 0 4px' }}>{g.note}</p>
                    {g.entries.map(depBlock)}
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
                  <p style={sub}>Maintained by hand in backend/services/costModel.js. Tap a bill for the day a person last checked it.</p>
                  <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                    <div className="hub-stat">
                      <p style={kicker}>Recurring monthly</p>
                      <p style={big}>{moneyOr(fixed.monthlyUsd, 'None on file', 0)}</p>
                      <p className="hub-stat-note">
                        {(fixed.monthly || []).length} {(fixed.monthly || []).length === 1 ? 'bill' : 'bills'} that arrive every month.
                      </p>
                    </div>
                    <div className="hub-stat">
                      <p style={kicker}>Committed annually</p>
                      <p style={big}>{moneyOr(fixed.annualUsd, 'None on file', 0)}</p>
                      <p className="hub-stat-note">
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
                  <HubWhy label="How these are kept">
                    {'Every line carries the date a human last checked it and whether the figure came off an invoice or a pricing page. Update the file when a bill changes. Railway and Google Cloud bill by usage, so they sit on the reconciled card above rather than here. Bills the code does not carry are on the expense list on the Overview tab.'}
                  </HubWhy>
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
                  <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                    <div className="hub-stat">
                      <p style={kicker}>Today so far</p>
                      <p style={big}>
                        {moneyOr(obs.todayUsd, 'Not measured')}
                        {Number.isFinite(obs.todayUsdHigh) && obs.todayUsdHigh > obs.todayUsd && (
                          <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> to {money(obs.todayUsdHigh)}</span>
                        )}
                      </p>
                      <HubWhy><p>A band where a meter counted calls without recording which SKU they were.</p></HubWhy>
                    </div>
                    <div className="hub-stat">
                      <p style={kicker}>Coverage</p>
                      <p style={big}>{(obs.lines || []).length - (obs.unmeasuredLines || []).length}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {(obs.lines || []).length}</span></p>
                      <p className="hub-stat-note">
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
                      <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                        <div className="hub-stat">
                          <p style={kicker}>This month</p>
                          <p style={big}>
                            {count(pb.monthUsed)}
                            <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {count(lim.fetchesPerMonth)}</span>
                          </p>
                          <p className="hub-stat-note">
                            {moneyOr(pb.monthUsd, 'nothing yet')} so far. The first {count(lim.freePerMonth)} photos a month are free.
                          </p>
                        </div>
                        <div className="hub-stat">
                          <p style={kicker}>Budget</p>
                          <p style={big}>{moneyOr(lim.budgetUsdPerYear, 'Not set', 0)}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/yr</span></p>
                          <HubWhy><p>
                            Set in backend/services/photoStore.js, or by PHOTO_BUDGET_USD_PER_YEAR on Railway. Every other photo limit is derived from it.
                          </p></HubWhy>
                        </div>
                      </div>
                      {monthPct !== null && (
                        <div className="hub-track" aria-hidden="true" style={{ margin: '10px 0 2px' }}>
                          <div className="hub-fill" style={{ width: `${Math.max(2, monthPct)}%`, backgroundColor: tight ? 'var(--accent-amber-text)' : colors.steel }} />
                        </div>
                      )}
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
                      <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                        <div className="hub-stat">
                          <p style={kicker}>Caps the month at</p>
                          <p style={big}>{moneyOr(q.perMonthUsdAfterFree, 'Not priced', 0)}</p>
                          <HubWhy><p>
                            {moneyOr(q.perMonthUsdGross, 'nothing', 0)} before each SKU keeps its own free allowance, which is named on its row below. Every quota spent every day, which nothing has ever done.
                          </p></HubWhy>
                        </div>
                        <div className="hub-stat">
                          <p style={kicker}>Budget alert</p>
                          <p style={big}>{moneyOr(q.budget?.usdPerMonth, 'None', 0)}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/mo</span></p>
                          <HubWhy><p>
                            Named {q.budget?.name}. It emails at {(q.budget?.alertsAtPct || []).join(', ')} percent. {q.budget?.note}
                          </p></HubWhy>
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
                      <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                        <div className="hub-stat">
                          <p style={kicker}>Provider</p>
                          <p style={big}>{headline}</p>
                          <HubWhy><p>
                            {vp.configured === false
                              ? 'No VISION_API_KEY on this server.'
                              : `Asked Google directly, with zero images, so the check bought nothing. Key from ${vp.keyVar}.`}
                            {vp.detail ? ` ${vp.detail}` : ''}
                          </p></HubWhy>
                        </div>
                        <div className="hub-stat">
                          <p style={kicker}>Uploads</p>
                          <p style={big}>{uploads}</p>
                          <HubWhy><p>
                            {uploads === 'Unscreened'
                              ? 'Screening is not required on this server, so an image that cannot be screened is stored anyway. That is the dev default and it must never be the production one.'
                              : uploads === 'Refused'
                                ? 'Screening is required and the provider is not usable, so every image upload in the app is being rejected right now.'
                                : uploads === 'Screened'
                                  ? 'Screening is required and the provider answers, which is the correct production setting.'
                                  : 'Screening is required and the probe could not reach Google, which says nothing either way. Check again before concluding anything from it.'}
                          </p></HubWhy>
                        </div>
                      </div>
                      {row('vision-last', 'Last real screen',
                        vp.lastOutcome ? (vp.lastOutcome.ok ? 'Answered' : 'Failed') : 'None yet',
                        vp.lastOutcome
                          ? `${new Date(vp.lastOutcome.at).toLocaleString()}.${vp.lastOutcome.detail ? ` ${vp.lastOutcome.detail}` : ''} Counted in this container's memory, so it resets on every deploy.`
                          : 'No image has been screened since this container started. That is normal on a quiet day and says nothing either way.')}
                      {/* The dated note says where to look when the probe
                          fails. Beside a provider that answers it only
                          contradicts the live reading above it. */}
                      {broken && visionDep && visionDep.finding && <p style={foot}>{visionDep.finding}</p>}
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
                      <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                        <div className="hub-stat">
                          <p style={kicker}>Landed</p>
                          <p style={big}>{count(t.delivered) || 'Not measured'}</p>
                          <HubWhy><p>
                            {attempts === null
                              ? 'The ledger could not be read, which says nothing either way.'
                              : attempts === 0
                                ? 'Nothing has been attempted in this window at all. On a product with no users that is the expected reading, and it is not evidence that delivery works.'
                                : `${count(reached)} device${reached === 1 ? '' : 's'} reached across ${count(attempts)} attempt${attempts === 1 ? '' : 's'}.`}
                          </p></HubWhy>
                        </div>
                        <div className="hub-stat">
                          <p style={kicker}>Provider</p>
                          <p style={big}>{p.configured === false ? 'Switched off' : 'Configured'}</p>
                          <HubWhy><p>
                            {p.configured === false
                              ? 'FIREBASE_SERVICE_ACCOUNT is not set on this server, so every notification in the app is a no-op and no row below can be anything but a skip.'
                              : 'FIREBASE_SERVICE_ACCOUNT is set, so a count of zero below means nothing was sent rather than that sending is off.'}
                          </p></HubWhy>
                        </div>
                      </div>
                      {ordered.length === 0
                        ? <p style={foot}>No push has been attempted in the last {p.days} days.</p>
                        : <HubBarList rows={ordered.map((k) => ({ key: `push-${k}`, label: WORDS[k] || k, value: byOutcome[k], valueText: count(byOutcome[k]), color: k === 'delivered' ? colors.steel : k === 'failed' ? 'var(--accent-red-text)' : 'var(--text-tertiary)' }))} />}
                    </div>
                  );
                })()}

                {/* WHAT ANSWERED THE FORECASTS.
                    routes/admin.js has served this block since 2026-08-26 and
                    nothing rendered it, which is the same half-finished shape
                    the push ledger above was in: the number that answers "is
                    a venue's own data actually doing the work" was computed,
                    carried across the wire, pinned by two server tests, and
                    shown to nobody.
                    It answers whether a venue's own data or the rule engine
                    made each forecast, and of the first, whether the venue's
                    curve (serve mode curve_offset, no model run) or the ONNX
                    model did; mlPredictor counts both under ml on purpose.
                    services/crowdEngine.js is the rule-based fallback and it
                    is used whenever the model files are missing, the ship gate
                    fails, features mismatch, a venue has no baseline, or the
                    request throws. Every one of those is silent. A server that
                    loaded and then served nothing looks identical, from
                    outside, to one that is working. */}
                {d.predictionCoverage && (() => {
                  const p = d.predictionCoverage;
                  const total = Number.isFinite(p.total) ? p.total : null;
                  const ml = Number.isFinite(p.ml) ? p.ml : 0;
                  const share = Number.isFinite(p.modelShare) ? Math.round(p.modelShare * 100) : null;
                  // The curve made curveOffsetAnswers of the ml answers and
                  // the trained model the rest; unsplit from an older server.
                  const madeBy = hubMadeBy(p.curveOffsetAnswers, ml);
                  const modeWords = hubServeModeWords(p.serveMode, p.nowcastEnabled);
                  return (
                    <div key="prediction-coverage" style={{ ...card, border: p.modelLoaded === false ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>What answered the forecasts</h3>
                      <p style={sub}>
                        Whether a venue&apos;s own data or the rule engine made each forecast. This counter lives in the server&apos;s memory, so it starts again from nothing on every deploy and reads the time since the last restart rather than all time. A small number here is not evidence that a venue&apos;s own data goes unused.
                      </p>
                      <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                        <div className="hub-stat">
                          <p style={kicker}>From a venue&apos;s own data</p>
                          <p style={big}>{share === null ? 'Not measured' : `${share}%`}</p>
                          <HubWhy><p>
                            {total === null
                              ? 'The meter could not be read, which says nothing either way.'
                              : total === 0
                                ? 'Nothing has asked for a forecast since the last deploy, so nothing has answered.'
                                : `${count(ml)} of ${count(total)} forecast${total === 1 ? '' : 's'}. ${hubRestWords(total, ml, p.categoryCurve)}${madeBy ? ` Of the ${count(ml)}, ${madeBy}.` : ''}`}
                          </p></HubWhy>
                        </div>
                        <div className="hub-stat">
                          <p style={kicker}>Model file</p>
                          <p style={big}>{p.modelLoaded ? (p.modelVersion || 'Loaded') : 'Not loaded'}</p>
                          <HubWhy><p>
                            {p.modelLoaded
                              ? (p.serveMode === 'curve_offset'
                                ? "The ONNX model is in memory. Serve mode curve_offset does not run it. A venue's own data answers only while it is loaded."
                                : p.serveMode === 'model_when_fresh'
                                  ? 'The ONNX model is in memory and answers where a venue has a live reading from the hour before.'
                                  : 'The ONNX model is in memory and available to serve.')
                              : "Every forecast is coming from the rule engine. That is the designed fallback and the product still works, but no forecast is made from a venue's own data."}
                          </p></HubWhy>
                        </div>
                      </div>
                      {modeWords && (
                        <p style={{ ...sub, margin: '10px 0 0' }}>{modeWords}</p>
                      )}
                      {p.noCurveFallback === true && (
                        <p style={{ ...sub, margin: '10px 0 0' }}>The no-curve fallback is on: a venue with no baseline and 200 or more Google reviews gets its category&apos;s typical level for the hour instead of the rule engine.</p>
                      )}
                      {p.noCurveFallback !== true && p.noCurveFallbackSwitch === true && (
                        <p style={{ ...sub, margin: '10px 0 0' }}>{hubFallbackNotServedWords(p)}</p>
                      )}
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
                  <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                    <div className="hub-stat">
                      <p style={kicker}>Costs at most</p>
                      <p style={big}>{moneyOr(v.ceilingMonthlyUsdHigh, 'Not priced')}</p>
                      <p className="hub-stat-note">
                        {Number.isFinite(v.ceilingMonthlyUsdLow) ? `From ${money(v.ceilingMonthlyUsdLow)} if every token were input.` : 'No rate on file for this model.'}
                      </p>
                    </div>
                    <div className="hub-stat">
                      <p style={kicker}>Gross margin</p>
                      <p style={big}>{Number.isFinite(v.ceilingMarginPct) ? `${v.ceilingMarginPct}%` : 'Not priced'}</p>
                      <p className="hub-stat-note">Against the dear end of the band, before any payment processing.</p>
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
                  <div className="hub-stat">
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
                    <div style={{ ...hubStyle.card, border: `1px dashed ${colors.creamDark}` }}>
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
                // code's bills, the reconciled bills and the expense list,
                // each counted once. The list below stays the code's own lines.
                // Without the list, the fallback still adds the reconciled
                // lines, the same way the Costs tab's does: Railway and Google
                // Cloud live there, and leaving them out would drop both.
                const ledger = costsData.expenses && costsData.expenses.status === 'ok' ? costsData.expenses : null;
                const reconciledMonthly = (costsData.reconciled?.lines || []).reduce((s2, l) => s2 + (Number.isFinite(l.usdPerMonth) ? l.usdPerMonth : 0), 0);
                const listCutShort = !!(costsData.expenses && costsData.expenses.truncated);
                const effectiveMonthly = ledger ? ledger.burnMonthlyUsd : (listCutShort ? null : fixed.effectiveMonthlyUsd + reconciledMonthly);
                // What one subscriber actually leaves, from the hub the Overview
                // loaded (Stripe's fees on the web, Apple's cut in the App
                // Store), so this tile and the Overview give one answer. Before
                // the Overview has loaded, the plain price is used and the line
                // under the figure says so.
                const hubBe = hubMemo.data && hubMemo.data.net && hubMemo.data.net.breakEven;
                // Unrounded where the hub sends it: dividing the burn by a
                // per-subscriber figure already rounded to the cent gave 100
                // where the Overview, from the same burn, said 101.
                const perUnit = (b) => {
                  const c = b && Number.isFinite(b.netPerUnitExactCents) ? b.netPerUnitExactCents : (b ? b.netPerUnitCents : null);
                  return Number.isFinite(c) && c > 0 ? c / 100 : null;
                };
                const webNet = perUnit(hubBe && hubBe.proWeb);
                // In whole cents of burn over unrounded cents per subscriber,
                // the operands the Overview divides: in dollars, $7,979.31
                // over $3.546 rounded up one subscriber past the Overview.
                const burnCents = Number.isFinite(effectiveMonthly) ? Math.round(effectiveMonthly * 100) : null;
                const centsOf = (b, fallbackUsd) => (b && Number.isFinite(b.netPerUnitExactCents) && b.netPerUnitExactCents > 0
                  ? b.netPerUnitExactCents
                  : (b && Number.isFinite(b.netPerUnitCents) && b.netPerUnitCents > 0 ? b.netPerUnitCents : (fallbackUsd ? fallbackUsd * 100 : null)));
                const webCents = centsOf(hubBe && hubBe.proWeb, PRO_MONTHLY_USD);
                const appCents = centsOf(hubBe && hubBe.proAppStore, null);
                const subsToBreakEven = burnCents === null ? null : (burnCents > 0 ? Math.ceil(burnCents / webCents) : 0);
                const appSubsToBreakEven = appCents && burnCents > 0 ? Math.ceil(burnCents / appCents) : null;
                const usd0 = (n) => `$${Math.round(n).toLocaleString()}`;
                const row = (name, amount, sub) => (
                  <HubRow key={name} navy={colors.navy} label={name} value={`${amount}${sub}`} />
                );
                return (
                  <>
                  <HubCard title="Burn and break-even">
                    <div className="hub-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                      <div className="hub-stat" data-hub-fig="">
                        <p className="hub-stat-label">Monthly burn</p>
                        <p className="hub-stat-value">{effectiveMonthly === null ? 'Not read' : usd0(effectiveMonthly)}</p>
                        <p className="hub-stat-note">What the repeating bills cost a month</p>
                      </div>
                      <div className="hub-stat" data-hub-fig="">
                        <p className="hub-stat-label">Target to cover it</p>
                        <p className="hub-stat-value">{subsToBreakEven === null ? 'Not read' : subsToBreakEven}</p>
                        <p className="hub-stat-note">Flock Pro subscribers on the web</p>
                      </div>
                    </div>
                    <HubWhy>
                      {listCutShort ? 'The expense list has more bills than the hub reads at once, so the burn would leave some out and is not shown.' : ledger
                        ? 'Every recurring bill at its monthly rate: the code’s fixed bills, the reconciled bills and the expense list.'
                        : `${usd0(monthlyTotal)}/mo recurring plus ${usd0(annualTotal)}/yr spread over twelve months, plus ${usd0(reconciledMonthly)}/mo of reconciled usage bills. The expense list could not be read, so its bills are not in this.`}
                      {webNet
                        ? `Flock Pro subscriptions at $${(hubBe && hubBe.proWeb && Number.isFinite(hubBe.proWeb.priceCents) ? hubBe.proWeb.priceCents / 100 : PRO_MONTHLY_USD).toFixed(2)}/mo on the web, after Stripe's fees ($${webNet.toFixed(2)} each).${appSubsToBreakEven !== null ? ` ${appSubsToBreakEven} if they all came through the App Store, after Apple's cut.` : ''}`
                        : `Flock Pro subscriptions at $${PRO_MONTHLY_USD.toFixed(2)}/mo, before Stripe's fees and Apple's cut. Open the Overview tab for the figure after fees.`}
                      {`${subsToBreakEven === null ? 'Break-even' : subsToBreakEven} is what break-even would take at this price, not a count of anything. Subscribers and revenue are counted on the Overview tab.`}
                    </HubWhy>
                  </HubCard>
                  <HubCard
                    title="Fixed expenses in the code"
                    chips={<HubChip tone="muted">{`${usd0(fixed.effectiveMonthlyUsd)}/mo effective`}</HubChip>}
                  >
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
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px', padding: '8px 0 0', borderTop: '1px solid var(--border-default)' }}>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)' }}>Recurring {usd0(monthlyTotal)}/mo plus {usd0(annualTotal)}/yr</span>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)' }}>One-time invested: {usd0(fixed.oneTimeUsd)}</span>
                    </div>
                    <HubWhy>
                      {(fixed.unverifiedLines || []).length > 0 && `${fixed.unverifiedLines.length} ${fixed.unverifiedLines.length === 1 ? 'line is' : 'lines are'} a published price or an assumption rather than an invoice, marked above and counted in the burn anyway. The Costs tab says what each one assumes and where to confirm it.`}
                      {'Vendors on free tiers, and what each meter has actually spent, are on the Costs tab. Railway and Google Cloud bill by usage, so they are recorded on the Costs tab\'s Reconciled card rather than listed here, and are in the burn above. Bills the code does not carry, such as the tools the app is built with, are on the Overview tab\'s expense list and in the burn above.'}
                    </HubWhy>
                  </HubCard>
                  </>
                );
              })()}

              {/* Growth Levers: judgements, not measurements, so they come
                  after every figure on the tab. */}
              <HubCard title="Growth Levers" sub="How much each could move, and the work it would take.">
                {[
                  { lever: 'Venue Acquisition', impact: 'High', effort: 'Medium', icon: Icons.building },
                  { lever: 'User Referrals', impact: 'High', effort: 'Low', icon: Icons.users },
                  { lever: 'City Expansion', impact: 'Very High', effort: 'High', icon: Icons.globe },
                  { lever: 'Premium Upsells', impact: 'Medium', effort: 'Low', icon: Icons.sparkles },
                ].map(item => (
                  <div key={item.lever} className="hub-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', minHeight: '40px', padding: '6px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      {item.icon('var(--text-secondary)', 14)}
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.navy }}>{item.lever}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <span className="hub-chip" style={{ backgroundColor: item.impact === 'Very High' ? 'var(--accent-green-bg)' : item.impact === 'High' ? 'var(--accent-blue-bg)' : 'var(--accent-amber-bg)', color: item.impact === 'Very High' ? 'var(--accent-green-text)' : item.impact === 'High' ? 'var(--accent-blue-text)' : 'var(--accent-amber-text)' }}>
                        {`${item.impact} impact`}
                      </span>
                      <span className="hub-chip" style={{ backgroundColor: 'var(--icon-bg)', color: 'var(--text-secondary)' }}>
                        {`${item.effort} effort`}
                      </span>
                    </div>
                  </div>
                ))}
              </HubCard>

              {/* Where the projection charts used to be. An honest empty state
                  beats a plausible-looking fake. */}
              <div style={{ ...hubStyle.card, border: `1px dashed ${colors.creamDark}`, boxShadow: 'none' }}>
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
              totalFlocks: 2340, completionRate: 78, endedPlans: 2104, avgGroupSize: 4.8, budgetAdoptionRate: 72,
              timeToConfirm: { medianHours: 5.2, plans: 1210, minPlans: 10 }, totalUsers: 8500, newUsersThisWeek: 247,
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
                style={{ ...hubStyle.textButton, alignSelf: 'center', flexShrink: 0, cursor: researchLoading ? 'default' : 'pointer' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '3px', background: demoMode ? '#D97706' : colors.steel }} />
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)' }}>{researchLoading ? 'Reading the database...' : demoMode ? 'Demo data · Tap for live' : 'Live data · Tap for demo'}</span>
              </button>
            );

            // Nothing has been measured: the read is in flight, it failed, or
            // it has not happened. None of those is a zero, and printing them
            // as zeros under a "Live data" label is inventing a measurement.
            if (!data) {
              return (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                  <div style={{ ...hubStyle.card, width: '100%', boxSizing: 'border-box', padding: '20px 14px', textAlign: 'center' }} role="status">
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
            const stallCount = (data.stallPointDistribution || []).reduce((s, p) => s + parseInt(p.count), 0);
            const stallTotal = stallCount || 1;
            // A field the response did not carry is not a zero either, so it
            // says so rather than rendering one.
            const has = (v) => typeof v === 'number' && Number.isFinite(v);
            const stat = (v, render) => (has(v) ? render(v) : 'No data');
            const plans = (n) => `${n.toLocaleString()} ${n === 1 ? 'plan' : 'plans'}`;
            // WHAT EACH OF THESE COUNTS, under its figure. "Completion Rate" and
            // "Where Flocks Stall" sat side by side and counted different plans:
            // the rate is every plan that ended, closed by a host or by the
            // sweep once its time passed (services/flockSweep.js), and the stall
            // split is research_analytics, which only a host closing a plan by
            // hand writes. "Time to Confirm" printed the minutes from creation
            // to that closing, after the night, in the thousands. The time now
            // comes from flocks.confirmed_at (migration 102), which only plans
            // confirmed since it existed carry, so it waits for enough of them;
            // the server withholds the median under its floor and so does this.
            const ttc = data.timeToConfirm;
            const ttcShown = !!ttc && has(ttc.medianHours) && has(ttc.plans) && has(ttc.minPlans) && ttc.plans >= ttc.minPlans;
            const hoursWords = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);
            let ttcNote = null;
            if (ttcShown) ttcNote = `median from making a plan to confirming it, over ${plans(ttc.plans)}`;
            else if (ttc && has(ttc.plans) && has(ttc.minPlans)) ttcNote = `Not enough plans confirmed since this was recorded: ${ttc.plans.toLocaleString()} of ${ttc.minPlans.toLocaleString()}.`;
            let endedNote = null;
            if (has(data.endedPlans)) {
              endedNote = data.endedPlans === 0
                ? 'No plan has ended yet.'
                : `of ${plans(data.endedPlans)} that ended, including ones closed automatically once their time passed`;
            }
            const statCards = [
              { label: 'Total Flocks', value: stat(data.totalFlocks, (v) => v.toLocaleString()), color: colors.navy },
              { label: 'Confirmed before it ended', value: stat(data.completionRate, (v) => `${v}%`), color: colors.steel, note: endedNote },
              { label: 'Avg Group Size', value: stat(data.avgGroupSize, (v) => v), color: colors.navy },
              { label: 'Budget Adoption', value: stat(data.budgetAdoptionRate, (v) => `${v}%`), color: colors.steel },
              { label: 'Time to Confirm', value: ttcShown ? hoursWords(ttc.medianHours) : ttc ? 'Not yet' : 'No data', color: colors.navy, note: ttcNote },
              { label: 'Total Users', value: stat(data.totalUsers, (v) => v.toLocaleString()), color: colors.navy, note: 'people accounts, not venue owners, admins or banned accounts' },
            ];
            // Who keeps their plans, by how often they turn up. The bar's
            // widths are each group's share of the four; the numbers beside
            // the swatches are the server's.
            const reliability = [
              { key: 'reliable', label: '80%+', value: data.reliabilityDistribution?.reliable || 0, color: colors.steel },
              { key: 'moderate', label: '50-79%', value: data.reliabilityDistribution?.moderate || 0, color: '#F59E0B' },
              { key: 'flaky', label: '<50%', value: data.reliabilityDistribution?.flaky || 0, color: '#EF4444' },
              { key: 'unscored', label: 'New', value: data.reliabilityDistribution?.unscored || 0, color: 'var(--border-mid)' },
            ];
            const reliabilityWhole = reliability.reduce((sum, r) => sum + (parseInt(r.value) || 0), 0);
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="hub-month-head" style={{ marginBottom: 0 }}>
                  <div style={{ minWidth: 0 }}>
                    <h2 className="hub-month-title">Research</h2>
                    <p className="hub-month-sub">How plans move from made to confirmed.</p>
                  </div>
                  {modeToggle}
                </div>
                {/* Two across on a phone and three on the wide console, so a
                    label and the line under it saying what it counts have room. */}
                <div className="hub-tiles hub-tiles-3">
                  {statCards.map(s => (
                    <div key={s.label} className="hub-tile">
                      <p className="hub-tile-label">{s.label}</p>
                      <p className="hub-tile-value" style={{ color: s.color }}>{s.value}</p>
                      {s.note && <p className="hub-tile-sub">{s.note}</p>}
                    </div>
                  ))}
                </div>
                <div className="hub-pair" style={{ margin: 0 }}>
                  <HubCard title="Where Flocks Stall" sub={`Plans a host closed by hand: ${plans(stallCount)}. A plan closed automatically once its time passed is not in this.`}>
                    <HubBarList
                      max={100}
                      rows={(data.stallPointDistribution || []).map((p) => ({
                        key: p.stall_point,
                        label: p.stall_point === 'rsvp' ? 'RSVP' : String(p.stall_point).replace(/^./, (ch) => ch.toUpperCase()),
                        value: Math.round((parseInt(p.count) / stallTotal) * 100),
                        valueText: `${p.count} (${Math.round((parseInt(p.count) / stallTotal) * 100)}%)`,
                        color: stallColors[p.stall_point] || colors.navy,
                      }))}
                    />
                  </HubCard>
                  <div className="hub-stack-col">
                    <HubCard title="User Reliability" sub="People by how often they turn up to plans they said yes to.">
                      {reliabilityWhole > 0 && (
                        <div className="hub-stack" aria-hidden="true" style={{ marginTop: '4px' }}>
                          {reliability.filter((r) => (parseInt(r.value) || 0) > 0).map((r) => (
                            <div key={`rel-${r.key}`} style={{ width: `${((parseInt(r.value) || 0) / reliabilityWhole) * 100}%`, backgroundColor: r.color }} />
                          ))}
                        </div>
                      )}
                      <div className="hub-stats" style={{ marginTop: '10px' }}>
                        {reliability.map((item) => (
                          <div key={item.label} className="hub-stat">
                            <p className="hub-stat-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span className="hub-swatch" style={{ backgroundColor: item.color }} />{item.label}</p>
                            <p className="hub-stat-value">{item.value}</p>
                          </div>
                        ))}
                      </div>
                    </HubCard>
                    <HubCard title="New Users This Week">
                      <p style={{ ...hubStyle.big, color: colors.steel, margin: 0 }}>
                        {has(data.newUsersThisWeek) ? `+${data.newUsersThisWeek.toLocaleString()}` : 'No data'}
                      </p>
                      <p style={{ ...hubStyle.note, marginTop: '4px' }}>People accounts made in the last 7 days.</p>
                    </HubCard>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );
}
