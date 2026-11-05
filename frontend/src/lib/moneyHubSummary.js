// ---------------------------------------------------------------------------
// THE MONEY HUB IN WORDS: what the admin console's Overview says about the
// payload GET /api/admin/money returns, worked out without drawing anything.
// ---------------------------------------------------------------------------
//
// The Overview (screens/RevenueScreen.js) draws these, and the admin tool
// (tools/flock-admin/admin.mjs) prints the same lines in a terminal: the
// month as four figures and one line per thing that needs the owner. Both
// read this one file, so the screen and the terminal cannot word the same
// payload two ways.
//
// Plain JavaScript with no imports and no JSX, so the tool can load it in
// Node without a build step. Nothing here adds or divides a figure: the
// server's arithmetic arrives finished, and this file turns it into words.

// Cents to dollars, or null when there is no number to print. The minus sign
// is the typographic one, so a loss lines up with a gain in a column.
export function hubMoney(cents, { sign = false } = {}) {
  if (!Number.isFinite(cents)) return null;
  const text = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (cents < 0) return `−$${text}`;
  return `${sign && cents > 0 ? '+' : ''}$${text}`;
}

export const hubCount = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : null);
export const hubPlural = (n, one, many) => `${hubCount(n)} ${n === 1 ? one : many}`;
export const hubTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null);
// A stretch of minutes in the unit a person would say it in.
export const hubAgo = (min) => (min < 60 ? hubPlural(min, 'minute', 'minutes') : min < 48 * 60 ? hubPlural(Math.round(min / 60), 'hour', 'hours') : hubPlural(Math.round(min / 1440), 'day', 'days'));

// A YYYY-MM-DD date read as that calendar day wherever the browser is.
export function hubDay(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('en-US', opts);
}

// A list of words as a person says it: "a", "a and b", "a, b and c".
export function hubAnd(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// The spending limit in whole dollars when it is whole ($20, not $20.00), as
// it is set on MapTiler's account page.
export function hubCapMoney(cap) {
  if (!cap || !Number.isFinite(cap.cents)) return 'account';
  return cap.cents % 100 === 0 ? `$${(cap.cents / 100).toLocaleString('en-US')}` : hubMoney(cap.cents);
}

// The cards the attention list at the top can send the owner to, by the id
// each one carries. `link` is the words on the jump, named after the card's
// own heading so it reads as where it lands.
export const HUB_CARD = {
  steps: { id: 'hub-steps', link: 'Go to the steps' },
  revenue: { id: 'hub-revenue', link: 'Go to Revenue' },
  costs: { id: 'hub-costs', link: 'Go to Costs' },
  expenses: { id: 'hub-expenses', link: 'Go to the expense list' },
  prices: { id: 'hub-prices', link: 'Go to Prices' },
  priceSheet: { id: 'hub-price-sheet', link: 'Go to the price sheet' },
  crowd: { id: 'hub-crowd', link: 'Go to Crowd data' },
  model: { id: 'hub-model', link: 'Go to Model' },
  health: { id: 'hub-health', link: 'Go to Health' },
  people: { id: 'hub-people', link: 'Go to People' },
};

// WHY A FIGURE IS EMPTY, in the codes backend/services/moneyHub.js buildNet
// sends. A figure missing a source arrives null rather than smaller, and the
// screen says which source it is waiting for.
export const HUB_GAP_SOURCE = {
  stripe: 'Stripe',
  stripe_partial: 'a full Stripe read',
  stripe_unpriced: 'a price for every Stripe subscription',
  stripe_tax: "this month's Stripe invoices, for the sales tax in the charges",
  stripe_tax_refunded: 'which refunded charges carried sales tax',
  app_store: 'RevenueCat',
  app_store_partial: 'every Pro account in RevenueCat',
  app_store_unpriced: 'a price for every App Store subscription',
  expenses: 'the expense list',
};
export const HUB_GAP_WORDS = {
  stripe: 'Stripe was not read',
  stripe_partial: 'Stripe had more entries this month than the hub reads, and a missing page could move a total either way',
  stripe_unpriced: 'some live Stripe subscriptions carry a price or a discount this read could not work out in dollars',
  stripe_tax: "automatic tax is on and this month's invoices could not be read, so the sales tax inside the charges is unknown",
  stripe_tax_refunded: "some of this month's charges carried sales tax and some charges were refunded, and a refund takes its tax back out too, so the tax to subtract is not known",
  app_store: 'the App Store is not in it, because RevenueCat was not read',
  app_store_partial: 'the App Store is not in it, because RevenueCat answered for only some Pro accounts',
  app_store_unpriced: 'the App Store is not in it, because some live App Store subscriptions carry no dollar price in RevenueCat',
  expenses: 'the expense list could not be read',
};
// The gaps that are the App Store's alone. This month's revenue and the net
// carry Stripe without it and say so; they never wait on one of these.
export const HUB_APP_STORE_GAPS = ['app_store', 'app_store_partial', 'app_store_unpriced'];
export const hubGaps = (list) => (Array.isArray(list) ? list : []);
export const hubNeeds = (gaps) => `Needs ${[...new Set(gaps.map((g) => HUB_GAP_SOURCE[g] || g))].join(' and ')}`;
export function hubGapSentence(gaps) {
  if (gaps.length === 0) return '';
  const text = gaps.map((g) => HUB_GAP_WORDS[g] || g).join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// The sentences behind the month's figures and the break-evens, worked out
// once from the payload for the tiles and the card under them. Every one says
// a server figure in words; nothing here adds or divides a figure.
export function hubSummaryWords(h) {
  const n = h.net || {};
  const be = n.breakEven || {};
  const stripe = (h.revenue && h.revenue.stripe) || {};
  const revenueMissing = hubGaps(n.revenueMissing);
  const costsMissing = hubGaps(n.costsMissing);
  const netMissing = hubGaps(n.netMissing);
  const netBurnMissing = hubGaps(n.netBurnMissing);
  const burnMissing = hubGaps(be.burnMissing);
  const revenueWithheld = revenueMissing.includes('stripe_partial');
  const appGap = revenueMissing.find((g) => HUB_APP_STORE_GAPS.includes(g));
  const taxGap = revenueMissing.includes('stripe_tax') || revenueMissing.includes('stripe_tax_refunded');
  let revenueNote;
  // The short line on the tile, under the figure: which sources it holds, or
  // why there is no figure.
  let revenueSub;
  if (n.revenueThisMonthCents === null || n.revenueThisMonthCents === undefined) {
    revenueNote = revenueWithheld
      ? 'Stripe had more balance entries this month than the hub reads. A missing page could move the total either way, so it is withheld rather than shown short.'
      : taxGap
        ? `${hubGapSentence(revenueMissing.filter((g) => g === 'stripe_tax' || g === 'stripe_tax_refunded'))} So there is no revenue figure after tax to show.`
        : stripe.status === 'not_connected' ? 'Stripe is not connected, so there is no revenue figure to show.' : 'Stripe could not be read, so there is no revenue figure to show.';
    revenueSub = revenueWithheld ? 'Stripe was read in part'
      : taxGap ? 'The sales tax in it is not known'
        : stripe.status === 'not_connected' ? 'Stripe is not connected' : 'Stripe did not answer';
  } else if (appGap) {
    revenueNote = `Stripe, after refunds, disputes and fees. ${hubGapSentence([appGap])}`;
    revenueSub = 'Stripe only, after fees';
  } else {
    // The App Store part is read from the accounts that are Pro now, which is
    // not every App Store sale this month (backend/services/moneyHub.js,
    // WHERE THE APP STORE FIGURES COME FROM), so it is never shown as that.
    // Apple's cut is an assumption: the standard rate, because the hub cannot
    // see the Small Business Program or how long each subscriber has stayed.
    revenueNote = `Stripe after refunds, disputes and fees, plus App Store charges after Apple's ${n.appleCommissionPct}%, an estimate: Apple takes ${n.appleSmallBusinessPct || 15}% under the Small Business Program and from a subscriber's second year.${n.appStoreFrom === 'current_pro_accounts' ? ' The App Store part counts current Pro accounts only: a subscriber who deleted their account is not in it.' : ''}`;
    revenueSub = 'Stripe and the App Store, after fees';
  }
  // A figure that is null is waiting for a source; the App Store alone never
  // empties the net, which carries Stripe and says so.
  const netNeeds = hubNeeds(netMissing.filter((g) => !HUB_APP_STORE_GAPS.includes(g)));
  const needed = (b) => (b && Number.isFinite(b.needed) ? hubCount(b.needed) : 'Not reachable');
  // The Roost tile said "Not reachable venues" when break-even could not be
  // reached, and "1 venues" at one.
  const venuesNeeded = (b) => (b && Number.isFinite(b.needed) ? hubPlural(b.needed, 'venue', 'venues') : 'Not reachable');
  // The App Store price is Apple's, read through RevenueCat, and can differ
  // from the web price, so it is named on its own.
  const appPriceWords = (b) => (b ? `${hubMoney(b.priceCents)} a month in the App Store, ${b.source === 'app_store'
    ? 'the price RevenueCat reports'
    : b.source === 'app_store_charge'
      ? 'the newest App Store charge'
      : 'the price the code states, because no App Store price was read'}` : 'no App Store price');
  const priceWords = (b) => (b ? `${hubMoney(b.priceCents)} a month, ${b.source === 'stripe'
    ? 'the price Stripe charges'
    : b.statedBecause === 'no_monthly_price'
      ? 'the price the code states, because Stripe has no monthly dollar price for it'
      : stripe.status !== 'ok'
        ? 'the price the code states, because Stripe was not read'
        : "the price the code states, because Stripe's prices were not read"}` : 'no price');
  const payingWords = (count, missing) => (Number.isFinite(count)
    ? hubCount(count)
    : `not known, waiting on ${[...new Set(hubGaps(missing).map((g) => HUB_GAP_SOURCE[g] || g))].join(' and ') || 'a read'}`);
  // Where the burn goes once the bills set to end have ended (moneyHub.js,
  // THE END OF A BILL), worked out on the server from the same lines.
  const after = h.costs && h.costs.afterEnding;
  const moves = Number.isFinite(n.burnCents) && after && Number.isFinite(after.burnCents) && after.changeCents;
  const endingWords = moves
    ? ` It ${after.changeCents < 0 ? 'falls' : 'rises'} to ${hubMoney(after.burnCents)} ${after.bills === 1 && after.label
      ? `on ${hubDay(after.by)}, when ${after.label} ends`
      : `by ${hubDay(after.by)}, once the ${after.bills === 1 ? 'bill set to end has' : `${hubCount(after.bills)} bills set to end have`} ended`}.`
    : '';
  // The same move, short enough for the tile.
  const endingSub = moves
    ? `${after.changeCents < 0 ? 'Falls' : 'Rises'} to ${hubMoney(after.burnCents)} ${after.bills === 1 && after.label ? 'on' : 'by'} ${hubDay(after.by)}`
    : null;
  const cachedAge = stripe.cached && Number.isFinite(stripe.cachedAgeSeconds) ? stripe.cachedAgeSeconds : null;
  return {
    n, be, revenueMissing, costsMissing, netMissing, netBurnMissing, burnMissing, revenueWithheld,
    revenueNote, revenueSub, netNeeds, needed, venuesNeeded, appPriceWords, priceWords, payingWords,
    endingWords, endingSub, cachedAge,
  };
}

// THE MONTH'S FOUR FIGURES: what each of the Overview's tiles says, and what
// the admin tool prints for the month. The figure, or the words for why there
// is none, the short line under it, and the tone a profit or a loss takes.
// The longer "How this is counted" sentences stay with the tiles that draw
// them.
export function hubMonthTiles(h) {
  const w = hubSummaryWords(h);
  const { n, costsMissing } = w;
  const net = n.netThisMonthCents;
  const expensesUnread = costsMissing.length > 0 ? 'The expense list was not read' : null;
  return [
    {
      key: 'in',
      label: 'Money in',
      value: hubMoney(n.revenueThisMonthCents) || (w.revenueWithheld ? 'Withheld' : 'Not read'),
      sub: w.revenueSub,
    },
    {
      key: 'costs',
      label: 'Costs',
      value: hubMoney(n.costsThisMonthCents) || 'Not read',
      sub: expensesUnread || "This month's share of every bill",
    },
    {
      key: 'net',
      label: 'Profit or loss',
      value: Number.isFinite(net) ? hubMoney(net, { sign: true }) : w.netNeeds,
      sub: 'Money in minus costs',
      tone: Number.isFinite(net) ? (net < 0 ? 'bad' : 'good') : 'muted',
    },
    {
      key: 'burn',
      label: 'Monthly bills',
      value: hubMoney(n.burnCents) || 'Not read',
      sub: expensesUnread || w.endingSub || 'Every repeating bill, a month',
    },
  ];
}

// NEEDS YOU: every live problem the payload already carries, in one list
// straight under the month's tiles. Each of these sits inside a long card
// further down: a stopped collector in Health, which is the last card; an open
// dispute near the end of Revenue; a price disagreement in Prices; the steps
// still to do behind a summary line. Nothing here is read a second time. Each
// row is built from a field another card draws, and jumps to that card.
//
// A source that was asked and did not answer is a row too, because "nothing
// needs you" is a claim about what was checked, and a Stripe that did not
// answer checked no dispute. A source that is not connected is not a row: with
// no Stripe key nothing is sold through Stripe, so there is no dispute to
// miss, and connecting one is a step the steps card already counts.
//
// Renewals and bills set to end are never a problem: a bill due Tuesday is
// something to know, not something that went wrong. They are on Coming up.
export const HUB_SEVERITY = { bad: 0, warn: 1 };

export function hubAttention(h) {
  const problems = [];
  const add = (row) => problems.push(row);
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const revenue = h.revenue || {};
  const s = revenue.stripe || {};
  const rc = revenue.revenuecat || {};
  const flags = revenue.flags || {};

  // The collector, from the Health card's own read.
  const c = h.health && h.health.collector;
  if (c && c.status === 'error') {
    add({ key: 'collector', tone: 'warn', label: 'Crowd collector', value: 'Not read', note: c.reason || "The collector's rows could not be read.", card: HUB_CARD.health });
  } else if (c && c.status === 'ok' && (c.state === 'late' || c.state === 'stopped')) {
    const since = Number.isFinite(c.minutesSinceLatest)
      ? `No live crowd row for ${hubAgo(c.minutesSinceLatest)}.`
      : 'No live crowd row has landed yet.';
    add({
      key: 'collector',
      tone: c.state === 'stopped' ? 'bad' : 'warn',
      label: 'Crowd collector',
      value: c.state === 'stopped' ? 'Stopped' : 'Late',
      note: `${since} It runs every hour.`,
      card: HUB_CARD.health,
    });
  }

  // BestTime's key endpoint. Not connected is the API server without the key,
  // which changes nothing but the Crowd data card.
  const b = h.crowdData && h.crowdData.besttime;
  if (b && b.status === 'error') {
    add({ key: 'besttime', tone: 'warn', label: 'BestTime', value: 'Not read', note: b.reason || 'BestTime did not answer.', card: HUB_CARD.crowd });
  } else if (b && b.status === 'ok' && b.key && b.key.healthy === false) {
    const k = b.key;
    add({
      key: 'besttime',
      tone: 'bad',
      label: 'BestTime',
      value: 'Key not working',
      note: `BestTime says status ${k.status === null || k.status === undefined ? 'none' : k.status}, valid ${String(k.valid)}, active ${String(k.active)}.`,
      card: HUB_CARD.crowd,
    });
  }

  const p = h.pricing || {};
  if (n(p.mismatches) > 0) {
    add({ key: 'prices', tone: 'bad', label: 'Price disagreements', value: hubCount(p.mismatches), note: "A store's price, the RevenueCat offering and what the code states do not all agree.", card: HUB_CARD.prices });
  }

  // Stripe. A key that did not answer, or answered for only some lists, left
  // disputes and failed renewals unchecked, and the list says so.
  if (s.status === 'error') {
    add({ key: 'stripe', tone: 'warn', label: 'Stripe', value: 'Not read', note: `${s.reason || 'Stripe did not answer.'} Disputes, failed renewals and prices were not checked.`, card: HUB_CARD.revenue });
  }
  if (s.status === 'ok') {
    const subs = s.subscriptions && s.subscriptions.status === 'ok' ? s.subscriptions : null;
    const disputes = s.disputes && s.disputes.status === 'ok' ? s.disputes : null;
    const unread = [];
    if (!subs) unread.push('subscriptions');
    if (!disputes) unread.push('disputes');
    if (!s.prices || s.prices.status !== 'ok') unread.push('prices');
    if (unread.length > 0) {
      add({ key: 'stripe-part', tone: 'warn', label: 'Stripe', value: 'Read in part', note: `Stripe answered, but its ${hubAnd(unread)} could not be read, so ${unread.length === 1 ? 'that was' : 'those were'} not checked.`, card: HUB_CARD.revenue });
    }
    const open = disputes ? n(disputes.open) + n(disputes.openOtherCurrency) : 0;
    if (open > 0) {
      add({
        key: 'disputes',
        tone: 'bad',
        label: 'Disputes to answer',
        value: hubCount(open),
        note: `${hubMoney(n(disputes.openAmountCents))} at stake in dollars${n(disputes.openOtherCurrency) > 0 ? `, and ${hubPlural(disputes.openOtherCurrency, 'more', 'more')} in another currency` : ''}. Each has a deadline in the Stripe dashboard.`,
        card: HUB_CARD.revenue,
      });
    }
    for (const [key, name] of [['pro', 'Flock Pro'], ['roost', 'Roost']]) {
      const sum = subs && subs[key];
      if (!sum) continue;
      if (n(sum.pastDue) > 0) {
        add({ key: `past-due-${key}`, tone: 'warn', label: `Past due, ${name}`, value: hubCount(sum.pastDue), note: 'A renewal failed and Stripe is retrying it.', card: HUB_CARD.revenue });
      }
      if (n(sum.unpaid) > 0) {
        add({ key: `unpaid-${key}`, tone: 'bad', label: `Unpaid, ${name}`, value: hubCount(sum.unpaid), note: 'Stripe stopped retrying a failed renewal, so these are not counted as active.', card: HUB_CARD.revenue });
      }
    }
    // A test key while something is on sale: a buyer would pay in test money.
    const selling = [
      flags.paywallEnabled && 'the paywall',
      flags.proWebCheckoutEnabled && 'web checkout',
      flags.venueBillingEnabled && 'venue billing',
    ].filter(Boolean);
    if (s.mode === 'test' && selling.length > 0) {
      const list = hubAnd(selling);
      add({
        key: 'stripe-test',
        tone: 'bad',
        label: 'Stripe test key',
        value: 'Selling',
        note: `${list.charAt(0).toUpperCase()}${list.slice(1)} ${selling.length === 1 ? 'is' : 'are'} on while the Stripe key is a test key, so anything bought through Stripe is paid in test money.`,
        card: HUB_CARD.revenue,
      });
    }
  }

  // RevenueCat, and the Pro accounts it finds nothing live for.
  const rcSubs = rc.subscribers;
  if (rc.status === 'error' || (rc.status === 'ok' && rcSubs && rcSubs.status !== 'ok')) {
    const why = rc.status === 'error' ? rc.reason : rcSubs.reason;
    add({ key: 'revenuecat', tone: 'warn', label: 'RevenueCat', value: 'Not read', note: `${why || 'RevenueCat did not answer.'} Pro accounts with nothing live were not checked.`, card: HUB_CARD.revenue });
  } else if (rc.status === 'ok' && rcSubs && n(rcSubs.premiumWithNothingLive) > 0) {
    add({ key: 'pro-nothing-live', tone: 'warn', label: 'Pro accounts with nothing live', value: hubCount(rcSubs.premiumWithNothingLive), note: 'Pro in the database while RevenueCat shows no live subscription for them.', card: HUB_CARD.revenue });
  }

  // The model loads on the first forecast after a deploy, so a quiet morning
  // after one reads as not loaded until somebody asks for a forecast.
  const v = h.model && h.model.version;
  if (v && v.loaded === false) {
    add({
      key: 'model',
      tone: 'warn',
      label: 'Crowd model',
      value: 'Not loaded',
      note: v.status === 'ok'
        ? 'No model is loaded in this server process. It loads on the first forecast after a deploy; if it stays like this, every forecast is coming from the rule engine.'
        : (v.reason || 'The model version could not be read.'),
      card: HUB_CARD.model,
    });
  }

  const oa = h.ownerActions;
  const todo = oa && Array.isArray(oa.items) ? oa.items.filter((x) => x.checkedBy === 'server' && x.state === 'todo' && !x.optional) : [];
  if (todo.length > 0) {
    add({ key: 'steps', tone: 'warn', label: 'Steps only you can take', value: `${hubCount(todo.length)} to do`, note: `${todo.map((x) => x.label).join('; ')}.`, card: HUB_CARD.steps });
  }

  const costs = h.costs || {};
  const doubles = Array.isArray(costs.possibleDoubles) ? costs.possibleDoubles : [];
  if (doubles.length > 0) {
    add({ key: 'doubles', tone: 'warn', label: 'Bills possibly counted twice', value: hubCount(doubles.length), note: `${doubles.map((d) => `${d.expenseLabel} on the list and ${d.codeLabel} in the code`).join('; ')}.`, card: HUB_CARD.costs });
  }
  // A bill charged after the day it was set to end is listed here
  // (moneyHub.js, THE END OF A BILL), and the hub counts it as running. A
  // bill paid ahead renewed if it was charged on or after that day, so the
  // date on its row is wrong. A usage bill's last bill comes after it, so the
  // server lists one only for a charge after the day that bill was expected
  // by, and each kind is said on its own: the paid-ahead rule stated alone
  // would make the last bill of an ended usage row read as a renewal (second
  // review 2026-10-06). The hub holds only the day a usage charge was paid,
  // so its words stop at what the dates show and send the owner to the
  // invoice: an August invoice paid on Oct 2 on a bill set to end Sep 1 is
  // later than its last bill was expected, with no use after the end date
  // (review 2026-10-06). Each kind carries its own next step. A payload from
  // before the cadence was sent lists only bills paid ahead.
  const pastEnd = Array.isArray(costs.chargedPastEnd) ? costs.chargedPastEnd : [];
  if (pastEnd.length > 0) {
    const ahead = pastEnd.filter((x) => x.cadence !== 'usage');
    const byUse = pastEnd.filter((x) => x.cadence === 'usage');
    const listed = (rows) => rows.map((x) => {
      const lastBill = x.cadence === 'usage' && x.lastBillBy ? `, its last bill expected by ${hubDay(x.lastBillBy)},` : '';
      return `${x.label}, set to end ${hubDay(x.endsOn)}${lastBill} and charged ${hubDay(x.lastChargedOn)}`;
    }).join('; ');
    add({
      key: 'past-end',
      tone: 'warn',
      label: 'Charged after the end date',
      value: hubCount(pastEnd.length),
      note: [
        ahead.length > 0 ? `${listed(ahead)}. For a bill paid ahead, a charge on or after the end date means it renewed, so it counts as running. Clear the end date, or set the new one.` : null,
        byUse.length > 0 ? `${listed(byUse)}. For a usage bill, a charge later than its last bill was expected counts as running. Check it against the invoice. If the invoice covers use after the end date, clear the end date or set the new one. If it was the last bill, mark its row stopped.` : null,
      ].filter(Boolean).join(' '),
      card: HUB_CARD.expenses,
    });
  }
  if (h.expenses && h.expenses.status === 'error') {
    add({ key: 'expenses', tone: 'warn', label: 'Expenses', value: 'Not read', note: 'The expense list could not be read, so renewals and bills counted twice were not checked.', card: HUB_CARD.expenses });
  }
  const jumps = Array.isArray(costs.jumps) ? costs.jumps : [];
  if (jumps.length > 0) {
    add({
      key: 'jumps',
      tone: 'warn',
      label: 'Bills up on the last one',
      value: hubCount(jumps.length),
      note: `${jumps.map((j) => `${j.label}: ${hubMoney(j.fromCents)}${j.fromPeriod ? ` for ${j.fromPeriod}` : ''}, now ${hubMoney(j.toCents)}${j.toAsOf ? ` as of ${j.toAsOf}` : ''} (up ${j.pct}%)`).join('; ')}.`,
      card: HUB_CARD.costs,
    });
  }
  const ps = h.priceSheet;
  if (ps && ps.stale > 0) {
    add({ key: 'price-sheet', tone: 'warn', label: 'Prices to re-check', value: hubCount(ps.stale), note: `Due for a check against a receipt or a pricing page: ${ps.rows.filter((r) => r.stale).map((r) => r.label).join('; ')}.`, card: HUB_CARD.priceSheet });
  }
  // MapTiler (moneyHub.js, THE MAPTILER READING, JUDGED). A meter that was
  // asked and did not answer is a row, like Stripe; one with no token is not,
  // because the steps card already counts the token. Reaching the spending
  // limit outranks being near an allowance, and only one of the two is shown.
  const mtu = costs.maptilerUsage;
  if (mtu && mtu.status === 'failed') {
    add({ key: 'maptiler', tone: 'warn', label: 'MapTiler usage', value: 'Not read', note: `${mtu.reason || 'MapTiler did not answer.'} The Flex allowances and the spending limit were not checked.`, card: HUB_CARD.costs });
  } else if (mtu && mtu.status === 'read') {
    const until = (mtu.period && hubDay(mtu.period.renewsOn)) || 'the next billing period';
    const capMoney = hubCapMoney(mtu.cap);
    const near = Array.isArray(mtu.near) ? mtu.near : [];
    if (mtu.reachesCap) {
      add({
        key: 'maptiler-cap',
        tone: 'bad',
        label: mtu.capReached ? 'MapTiler at the spending limit' : 'MapTiler would reach the spending limit',
        value: mtu.capReached ? hubMoney(mtu.overSoFarCents) : `${hubMoney(mtu.overProjectedCents)} on pace`,
        note: `${mtu.capReached
          ? `${hubMoney(mtu.overSoFarCents)} over the Flex allowance so far`
          : `On pace for ${hubMoney(mtu.overProjectedCents)} over the Flex allowance this billing period`}, against a ${capMoney} spending limit. At the limit every Flock map stops until ${until}. The limit is in MapTiler's account settings.`,
        card: HUB_CARD.costs,
      });
    } else if (near.length > 0) {
      const top = Math.max(...near.map((x) => x.pct));
      add({
        key: 'maptiler-near',
        tone: 'warn',
        // 80% and up warns; a pace or a reading past 100% says so in the label.
        label: top >= 100 ? 'MapTiler past its allowance' : 'MapTiler near its allowance',
        value: `${top}%`,
        note: `${near.map((x) => `${x.label.charAt(0).toUpperCase()}${x.label.slice(1)} ${hubCount(x.used)} of ${hubCount(x.included)}${Number.isFinite(x.projected) ? `, on pace for ${hubCount(x.projected)}` : ''}`).join('; ')}. Past the allowance, extra use bills automatically up to the ${capMoney} spending limit, where every Flock map stops until ${until}.`,
        card: HUB_CARD.costs,
      });
    }
  }
  // Resend (moneyHub.js, THE RESEND READING, JUDGED). A meter that was asked
  // and did not answer is a row, like MapTiler's; one with no key is not. Each
  // cap is its own row: near it at 80%, at it from 100%, when Resend sends
  // nothing more until the window resets. The server words the reset in New
  // York time.
  const rsu = costs.resendUsage;
  if (rsu && rsu.status === 'failed') {
    add({ key: 'resend', tone: 'warn', label: 'Email usage', value: 'Not read', note: `${rsu.reason || 'Resend did not answer.'} The daily and monthly email caps were not checked.`, card: HUB_CARD.costs });
  } else if (rsu && rsu.status === 'read') {
    for (const a of Array.isArray(rsu.alerts) ? rsu.alerts : []) {
      const daily = a.window === 'daily';
      const span = daily ? 'today' : 'this month';
      const cap = daily ? 'daily' : 'monthly';
      const until = a.resetsWords || hubTime(a.resetsAt) || 'the reset';
      const what = 'signup verifications and password resets included';
      if (a.level === 'at') {
        add({
          key: `resend-${a.window}-at`,
          tone: 'bad',
          label: `Email at its ${cap} limit`,
          value: `${hubCount(a.used)} of ${hubCount(a.limit)}`,
          note: `Resend has counted ${hubCount(a.used)} emails ${span}, and the plan allows ${hubCount(a.limit)}. No more mail goes out, ${what}, until ${until}.`,
          card: HUB_CARD.costs,
        });
      } else if (a.level === 'near') {
        add({
          key: `resend-${a.window}-near`,
          tone: 'warn',
          label: `Email near its ${cap} limit`,
          value: `${a.pct}%`,
          note: `${hubCount(a.used)} of ${hubCount(a.limit)} emails ${span}. At ${hubCount(a.limit)} Resend sends nothing more, ${what}, until ${until}.`,
          card: HUB_CARD.costs,
        });
      }
    }
  }

  const lic = costs.licence;
  if (lic && Array.isArray(lic.items) && lic.items.length > 0) {
    add({
      key: 'licence',
      tone: 'warn',
      label: 'Plans outside their terms',
      value: hubCount(lic.items.length),
      note: `${lic.items.map((i) => `${i.vendor} ${i.plan}`).join('; ')}. ${costs.status === 'ok'
        ? `Licensed for commercial use, the burn is ${hubMoney(lic.licensedPerMonthCents)} a month (${hubMoney(lic.toComplyPerMonthCents)} more).`
        : `Licensing them adds ${hubMoney(lic.toComplyPerMonthCents)} a month.`}`,
      card: HUB_CARD.costs,
    });
  }

  // Worst first; the order each was added in breaks a tie.
  problems.sort((x, y) => (HUB_SEVERITY[x.tone] ?? 2) - (HUB_SEVERITY[y.tone] ?? 2));
  return { problems };
}
