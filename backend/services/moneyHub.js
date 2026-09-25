'use strict';
// ---------------------------------------------------------------------------
// THE OWNER'S MONEY HUB: every dollar in and out, read where it actually is.
//
// GET /api/admin/money (routes/admin.js) is the only caller. It answers seven
// questions on one screen, each from the system that holds the answer:
//
//   revenue  Stripe for everything sold on flockcorp.com (Flock Pro on the web
//            and Roost), RevenueCat for the App Store. Subscriptions by plan,
//            trials, recurring revenue, what was collected this month, refunds,
//            disputes, Stripe's fees and promotion code redemptions.
//   costs    the infrastructure lines in services/costModel.js, the reconciled
//            invoice in cost_reconciled (059), and every row of the expense
//            list in business_expenses (080), without counting a bill twice.
//   net      revenue less costs this month, the monthly burn, and how many
//            subscribers or venues would cover it.
//   pricing  every price Stripe will charge next to every price the code
//            writes down (services/statedPrices.js), with each disagreement
//            said in words.
//   crowd    the BestTime key's own report (services/besttimeAccount.js) and
//            the plan the code records beside it: what the paid crowd feed
//            allows, and what BestTime will and will not say about it.
//   model    which crowd model is serving, and how many of its served
//            forecasts landed within one crowd band of what the collector
//            then measured, against the goal.
//   health   whether the crowd-data collector is still landing rows.
//
// HONEST WHEN A SOURCE IS MISSING. Every block carries a status: 'ok',
// 'not_connected' (the key is not set, so nothing was asked) or 'error' (it was
// asked and did not answer). A block that is not ok carries no numbers at all,
// because a zero printed for an unread source is a claim that nothing was sold.
// A zero from a source that answered is a real zero and says so.
//
// CACHED, BECAUSE STRIPE, REVENUECAT AND BESTTIME ARE NOT OURS TO HAMMER. The
// three external reads are held for EXTERNAL_TTL_MS after a good answer and
// EXTERNAL_FAIL_TTL_MS after a failed one, a second request while one is in
// flight waits for it, and a manual refresh is honoured only once the held
// answer is MIN_FORCE_REFRESH_MS old. Each answer is held under the inputs it
// was read with (the month, and for RevenueCat the Pro accounts it was asked
// about), so a new month or a new subscriber is a new read rather than a stale
// one. The database reads (expenses, costs, health) are never cached: an edit
// shows on the next load. The one exception is the model's served-forecast
// check, a month of serves joined to the collector's readings, which is held
// for MODEL_TTL_MS (an hour): the readings it scores against land once an
// hour, so the hold costs at most one collector run of freshness. THE MODEL
// section below says why it is held here rather than precomputed.
//
// NOTHING PERSONAL LEAVES THIS FILE. Counts and sums only: no customer email,
// no customer name, no account id, no key. Price and promotion code ids are
// the operator's own configuration and are shown so a mismatch can be fixed.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../config/database');
const costModel = require('./costModel');
const billing = require('./proBilling');
const besttime = require('./besttimeAccount');
const { legacyRoostPrices } = require('./venueBilling');
const {
  STATED_PRICES, PRICE_ENV, APP_STORE_PRODUCTS, PRODUCT_LABEL, PLAN_INTERVAL,
} = require('./statedPrices');

// The business keeps New York time. "This month" starts at midnight there, the
// same rule routes/admin.js businessToday() applies to invoice dates.
const HUB_TZ = 'America/New_York';

const EXTERNAL_TTL_MS = 5 * 60 * 1000;
const EXTERNAL_FAIL_TTL_MS = 60 * 1000;
const MIN_FORCE_REFRESH_MS = 60 * 1000;

// Stripe. Short timeouts and one retry: this is a dashboard, and a slow vendor
// must cost a panel, not the whole page.
const STRIPE_REQUEST = { timeout: 10000, maxNetworkRetries: 1 };
const STRIPE_PAGE = 100;
const SUBSCRIPTION_MAX_PAGES = 10;
const BALANCE_MAX_PAGES = 20;
const INVOICE_MAX_PAGES = 10;
const DISPUTE_MAX_PAGES = 10;
// Stripe's invoice list filters on when an invoice was CREATED, not when it
// was paid, so the paid-this-month split asks for every paid invoice created
// up to this many days before the month began and keeps the ones paid inside
// it. Stripe retries a failed renewal for at most two months, so a renewal
// paid this month was created inside this window. An old invoice marked paid
// by hand later than that is the one case it can miss, and the payload says so.
const INVOICE_LOOKBACK_DAYS = 70;
const PRICE_MAX_PAGES = 3;
const COUPON_LOOKUP_MAX = 25;
const LIVE_SUB_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];
const OPEN_DISPUTE_STATUSES = new Set(['warning_needs_response', 'warning_under_review', 'needs_response', 'under_review']);

// RevenueCat. v2 for the project-wide overview, v1 for each Pro account's own
// subscriptions, which is the only read that splits the App Store out by plan.
const RC_V1 = 'https://api.revenuecat.com/v1';
const RC_V2 = 'https://api.revenuecat.com/v2';
const RC_TIMEOUT_MS = 8000;
const RC_SUBSCRIBER_CAP = 200;
const RC_CONCURRENCY = 5;
const RC_MIN_KEY_LENGTH = 16;

// Apple's cut, conservatively. The Small Business Program would make it 15,
// and nothing here can see whether the account is enrolled, so a net figure
// assumes the standard rate rather than flattering itself.
const APPLE_COMMISSION_PCT = costModel.RATES.stores.appleStandardPct;

const EXPENSE_KINDS = ['infrastructure', 'tooling', 'legal', 'other'];
const EXPENSE_CADENCES = ['monthly', 'yearly', 'usage', 'one_time'];
const EXPENSE_LIST_LIMIT = 500;
const RENEWAL_WINDOW_DAYS = 60;

// The collector runs hourly at :07 (collectRealtime.js on the Railway BESTTIME
// cron). Two and a half hours without a row means at least one run is missing.
const COLLECTOR_LATE_MINUTES = 150;
const COLLECTOR_STOPPED_HOURS = 26;

// Where each costModel line sits in the by-category table. Presentation only:
// the amounts still come from costModel.js.
const CODE_LINE_CATEGORY = {
  railway: 'Hosting',
  vercel: 'Hosting',
  'besttime-subscription': 'Crowd data',
  'besttime-corpus': 'Crowd data',
  sportsdb: 'Crowd data',
  'apple-developer': 'App Store',
  domain: 'Domain and email',
  'google-cloud': 'Google Cloud',
};

// A vendor name on the expense list that probably IS a code line. Used only to
// warn that a bill may be counted twice; nothing is linked on a guess. The
// owner links the row by choosing the line in its "Counts instead of" field.
const CODE_LINE_LOOKALIKE = {
  railway: /railway/i,
  vercel: /vercel/i,
  'besttime-subscription': /best ?time/i,
  sportsdb: /sports ?db/i,
  'apple-developer': /apple developer|developer program/i,
  domain: /flockcorp|porkbun|\bdomain\b/i,
  'google-cloud': /google cloud|\bgcp\b|cloud billing/i,
};

// ---------------------------------------------------------------------------
// Dates. Everything below works in YYYY-MM-DD strings in the business's own
// zone, so a bill dated the 1st is the 1st in Pennsylvania and not in UTC.
// ---------------------------------------------------------------------------

function ymdIn(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Milliseconds to add to a UTC instant to read the wall clock in `tz`.
function tzOffsetMs(tz, at) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

// The UTC instant of midnight at the start of `ymd` in `tz`.
function zonedMidnightMs(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(tz, new Date(guess));
  const again = guess - tzOffsetMs(tz, new Date(t));
  if (again !== t) t = again;
  return t;
}

const pad2 = (n) => String(n).padStart(2, '0');

function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

// Calendar months, clamped to the month's last day, always counted from the
// same base date so the 31st does not drift to the 28th after February.
function addMonthsYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = (m - 1) + n;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad2(month + 1)}-${pad2(Math.min(d, last))}`;
}

function monthOf(todayYmd, tz = HUB_TZ) {
  const [y, m] = todayYmd.split('-').map(Number);
  const startYmd = `${y}-${pad2(m)}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const endYmd = `${y}-${pad2(m)}-${pad2(daysInMonth)}`;
  const label = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, 1)));
  return {
    todayYmd,
    startYmd,
    endYmd,
    startUnix: Math.floor(zonedMidnightMs(startYmd, tz) / 1000),
    daysInMonth,
    dayOfMonth: Number(todayYmd.slice(8, 10)),
    label,
    tz,
  };
}

const inMonth = (ymd, month) => typeof ymd === 'string' && ymd >= month.startYmd && ymd <= month.endYmd;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const has = (obj, key) => obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);

function plain(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Monthly share of an amount billed every `recurring` interval.
function monthsPerCharge(recurring) {
  const count = recurring && Number.isFinite(recurring.interval_count) && recurring.interval_count > 0
    ? recurring.interval_count : 1;
  switch (recurring && recurring.interval) {
    case 'year': return 12 * count;
    case 'week': return (12 / 52) * count;
    case 'day': return (12 / 365.25) * count;
    case 'month':
    default: return count;
  }
}

// What a subscriber paying `grossMonthlyCents` a month leaves after Stripe's
// card and Billing shares and the fixed fee on each charge, per costModel's
// rate card. A charge of nothing costs nothing to process.
function stripeNetMonthlyCents(grossMonthlyCents, recurring) {
  if (!(grossMonthlyCents > 0)) return 0;
  const s = costModel.RATES.stripe;
  const pct = (s.percent + s.billingPercent) / 100;
  const fixed = (s.fixedUsd * 100) / monthsPerCharge(recurring);
  return Math.max(0, grossMonthlyCents * (1 - pct) - fixed);
}

// ---------------------------------------------------------------------------
// THE EXTERNAL CACHE
// ---------------------------------------------------------------------------

const externalCache = new Map();

// A key is `<source>:<inputs>`. The inputs are part of the key because the
// read depends on them: last month's Stripe balance is not this month's, and a
// RevenueCat tally taken before somebody subscribed does not count them. A
// request shares an answer, or a read in flight, only with a request that asked
// the same question.
const cacheSourceOf = (key) => {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(0, i);
};

function stripeCacheKey(month) {
  return `stripe:${month.startYmd}`;
}

function revenueCatCacheKey(month, premiumIds) {
  const digest = crypto.createHash('sha256').update(premiumIds.join(',')).digest('hex').slice(0, 16);
  return `revenuecat:${month.startYmd}:${premiumIds.length}:${digest}`;
}

// BestTime's key endpoint takes no input but the key itself, which is the
// server's own configuration and never part of a cache key.
function besttimeCacheKey() {
  return 'besttime:key';
}

// The served-forecast check depends on its window and on the band ladder it
// scores with, so both are in the key: a re-cut ladder is a new question.
function modelAccuracyCacheKey(windowDays, cuts) {
  return `model:${windowDays}d:${cuts.join('-')}`;
}

// ttlMs and failTtlMs default to the vendor holds; the model check passes its
// own hour. logMessage false logs only the error's name, for a read whose
// failure text is not ours to repeat.
async function cachedRead(key, read, {
  force = false, ttlMs = EXTERNAL_TTL_MS, failTtlMs = EXTERNAL_FAIL_TTL_MS, logMessage = true,
} = {}) {
  const hit = externalCache.get(key);
  if (hit && hit.pending) {
    const v = await hit.pending;
    return { ...v, cached: false, cachedAgeSeconds: 0 };
  }
  const now = Date.now();
  if (hit && hit.value) {
    const age = now - hit.at;
    const ttl = hit.value.status === 'ok' ? ttlMs : failTtlMs;
    const forced = force && age >= MIN_FORCE_REFRESH_MS;
    if (age < ttl && !forced) {
      return { ...hit.value, cached: true, cachedAgeSeconds: Math.round(age / 1000) };
    }
  }
  const pending = (async () => {
    try {
      return await read();
    } catch (err) {
      const what = logMessage ? (err && err.message ? err.message : err) : ((err && err.name) || 'unknown error');
      console.error(`[money] ${key} read failed:`, what);
      return { status: 'error', reason: 'The read failed before it could answer.' };
    }
  })();
  externalCache.set(key, { at: hit ? hit.at : 0, value: hit ? hit.value : null, pending });
  const value = await pending;
  externalCache.set(key, { at: Date.now(), value, pending: null });
  // One settled answer per source. An answer to an older question (last
  // month, an earlier list of Pro accounts) can never be served again, so it
  // goes; a read still in flight for another question is left to finish.
  const source = cacheSourceOf(key);
  for (const [k, v] of externalCache) {
    if (k !== key && cacheSourceOf(k) === source && !v.pending) externalCache.delete(k);
  }
  return { ...value, cached: false, cachedAgeSeconds: 0 };
}

// ---------------------------------------------------------------------------
// EXPENSES
// ---------------------------------------------------------------------------

// Every id a row's replaces_line may name: the fixed, annual and one-time
// lines, and the reconciled invoice line(s). Read from costModel so a line
// added there is linkable here without a second list.
function codeLineIds() {
  return [
    ...costModel.FIXED_MONTHLY.map((e) => e.id),
    ...costModel.FIXED_ANNUAL.map((e) => e.id),
    ...costModel.ONE_TIME.map((e) => e.id),
    ...costModel.RECONCILED.lines.map((l) => l.id),
  ];
}

function codeLineOptions() {
  const out = [];
  for (const e of costModel.FIXED_MONTHLY) out.push({ id: e.id, label: e.label, cadence: 'monthly' });
  for (const e of costModel.FIXED_ANNUAL) out.push({ id: e.id, label: e.label, cadence: 'yearly' });
  for (const e of costModel.ONE_TIME) out.push({ id: e.id, label: e.label, cadence: 'one_time' });
  for (const l of costModel.RECONCILED.lines) out.push({ id: l.id, label: l.label, cadence: 'usage' });
  return out;
}

// The columns every read of business_expenses returns. Dates come back as
// text: node-postgres turns a DATE into a JavaScript Date at LOCAL midnight,
// which is the day before in any zone west of the server.
function expenseFromRow(r) {
  return {
    id: Number(r.id),
    vendor: r.vendor,
    product: r.product || null,
    category: r.category || null,
    kind: r.kind,
    amountCents: Number(r.amount_cents),
    currency: r.currency,
    cadence: r.cadence,
    lastChargedOn: r.last_charged_on ? String(r.last_charged_on).slice(0, 10) : null,
    renewsOn: r.renews_on ? String(r.renews_on).slice(0, 10) : null,
    active: r.active === true,
    verified: r.verified === true,
    note: r.note || null,
    replacesLine: r.replaces_line || null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

async function readExpenses(db = pool) {
  const r = await db.query(
    `SELECT id, vendor, product, category, kind, amount_cents, currency, cadence,
            last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
            active, verified, note, replaces_line, updated_at
       FROM business_expenses
      ORDER BY active DESC, kind, lower(vendor), id
      LIMIT ${EXPENSE_LIST_LIMIT}`
  );
  return (r.rows || []).map(expenseFromRow);
}

// The words people type for a kind or a cadence, folded onto the four the
// table accepts. Anything else is left as typed so validation can name it.
const KIND_WORDS = {
  infrastructure: 'infrastructure', infra: 'infrastructure', hosting: 'infrastructure', running: 'infrastructure',
  tooling: 'tooling', tools: 'tooling', tool: 'tooling', building: 'tooling', development: 'tooling',
  legal: 'legal', company: 'legal',
  other: 'other',
};
const CADENCE_WORDS = {
  monthly: 'monthly', month: 'monthly', mo: 'monthly',
  yearly: 'yearly', year: 'yearly', annual: 'yearly', annually: 'yearly', yr: 'yearly',
  usage: 'usage', metered: 'usage',
  one_time: 'one_time', onetime: 'one_time', once: 'one_time', one_off: 'one_time',
};

function foldWord(value, map) {
  if (typeof value !== 'string') return value;
  const k = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return has(map, k) ? map[k] : value;
}

const BOOL_WORDS = { true: true, false: false, yes: true, no: false };

// Accept the snake_case spellings a pasted list may use, and the plain words
// above, before validation sees the object. Nothing here invents a value: a
// field the paste left out stays out and gets its default later.
function normalizeExpenseAliases(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out = { ...raw };
  const alias = (from, to) => {
    if (has(out, from) && !has(out, to)) out[to] = out[from];
    delete out[from];
  };
  alias('amount_cents', 'amountCents');
  alias('last_charged_on', 'lastChargedOn');
  alias('renews_on', 'renewsOn');
  alias('replaces_line', 'replacesLine');
  if (has(out, 'kind')) out.kind = foldWord(out.kind, KIND_WORDS);
  if (has(out, 'cadence')) out.cadence = foldWord(out.cadence, CADENCE_WORDS);
  if (typeof out.currency === 'string') out.currency = out.currency.trim().toUpperCase();
  for (const b of ['active', 'verified']) {
    if (typeof out[b] === 'string') {
      const k = out[b].trim().toLowerCase();
      if (has(BOOL_WORDS, k)) out[b] = BOOL_WORDS[k];
    }
  }
  for (const d of ['lastChargedOn', 'renewsOn', 'replacesLine', 'product', 'category', 'note', 'currency']) {
    if (typeof out[d] === 'string' && out[d].trim() === '') out[d] = null;
  }
  return out;
}

// Cents from either `amountCents` (an integer) or `amount` (dollars, as a
// number or a string with at most two decimals). Returns null when neither is
// usable, and the validators refuse that before this is ever trusted.
function centsFromInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.amountCents !== undefined && raw.amountCents !== null) {
    const n = raw.amountCents;
    return Number.isInteger(n) && n >= 0 && n <= 1000000000 ? n : null;
  }
  if (raw.amount === undefined || raw.amount === null) return null;
  let text;
  if (typeof raw.amount === 'number') {
    if (!Number.isFinite(raw.amount)) return null;
    text = String(raw.amount);
  } else if (typeof raw.amount === 'string') {
    text = raw.amount.trim().replace(/^\$/, '').replace(/,/g, '');
  } else {
    return null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return cents >= 0 && cents <= 1000000000 ? cents : null;
}

// The row as the table stores it, from input that has already passed the
// route's validators. Defaults live here and nowhere else.
function expenseRowFromInput(raw) {
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {
    vendor: text(raw.vendor, 80),
    product: text(raw.product, 120),
    category: text(raw.category, 60),
    kind: raw.kind,
    amountCents: centsFromInput(raw),
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : 'USD',
    cadence: raw.cadence,
    lastChargedOn: raw.lastChargedOn || null,
    renewsOn: raw.renewsOn || null,
    active: raw.active === undefined || raw.active === null ? true : raw.active === true,
    verified: raw.verified === true,
    note: text(raw.note, 500),
    replacesLine: raw.replacesLine || null,
  };
}

function expenseParams(row) {
  return [
    row.vendor, row.product, row.category, row.kind, row.amountCents, row.currency,
    row.cadence, row.lastChargedOn, row.renewsOn, row.active, row.verified, row.note,
    row.replacesLine,
  ];
}

const EXPENSE_INSERT_SQL = `INSERT INTO business_expenses
       (vendor, product, category, kind, amount_cents, currency, cadence,
        last_charged_on, renews_on, active, verified, note, replaces_line,
        updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)
     RETURNING id, vendor, product, category, kind, amount_cents, currency, cadence,
               last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
               active, verified, note, replaces_line, updated_at`;

// A whole-row write by id. The admin PUT route and the import both use it, so
// an edit on the screen and a corrected paste store a bill the same way.
const EXPENSE_UPDATE_SQL = `UPDATE business_expenses
        SET vendor = $2, product = $3, category = $4, kind = $5, amount_cents = $6,
            currency = $7, cadence = $8, last_charged_on = $9, renews_on = $10,
            active = $11, verified = $12, note = $13, replaces_line = $14,
            updated_at = NOW(), updated_by = $15
      WHERE id = $1
      RETURNING id, vendor, product, category, kind, amount_cents, currency, cadence,
                last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
                active, verified, note, replaces_line, updated_at`;

// The import's insert. The same vendor, product and cadence is the same bill,
// and migration 080 makes that a unique key (business_expenses_bill_key), so
// when a second import inserted the bill after this one looked for it, this
// insert waits for that one to commit and then does nothing, and the import
// reads the row again and merges into it instead of adding a copy.
const EXPENSE_IMPORT_INSERT_SQL = `INSERT INTO business_expenses
       (vendor, product, category, kind, amount_cents, currency, cadence,
        last_charged_on, renews_on, active, verified, note, replaces_line,
        updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)
     ON CONFLICT (lower(vendor), lower(COALESCE(product, '')), cadence) DO NOTHING
     RETURNING id, vendor, product, category, kind, amount_cents, currency, cadence,
               last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
               active, verified, note, replaces_line, updated_at`;

// The import's match: the same vendor, product and cadence, ignoring case,
// is the same bill, so pasting the list again updates rather than doubles it.
// Locked, because the merge below reads the row before it writes it.
const EXPENSE_MATCH_SQL = `SELECT id, vendor, product, category, kind, amount_cents, currency, cadence,
            last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
            active, verified, note, replaces_line, updated_at
       FROM business_expenses
      WHERE lower(vendor) = lower($1)
        AND lower(COALESCE(product, '')) = lower(COALESCE($2, ''))
        AND cadence = $3
      ORDER BY id
      FOR UPDATE`;

// Which stored field each pasted key sets. A key the paste left out keeps
// what is stored: a list pasted again without its renewal dates must not
// erase the dates typed in since.
const IMPORT_FIELD_KEYS = {
  category: ['category'],
  kind: ['kind'],
  amountCents: ['amount', 'amountCents'],
  currency: ['currency'],
  lastChargedOn: ['lastChargedOn'],
  renewsOn: ['renewsOn'],
  active: ['active'],
  verified: ['verified'],
  note: ['note'],
  replacesLine: ['replacesLine'],
};

function mergeIntoStored(stored, item) {
  const incoming = expenseRowFromInput(item);
  const merged = {
    vendor: stored.vendor,
    product: stored.product,
    category: stored.category,
    kind: stored.kind,
    amountCents: stored.amountCents,
    currency: stored.currency,
    cadence: stored.cadence,
    lastChargedOn: stored.lastChargedOn,
    renewsOn: stored.renewsOn,
    active: stored.active,
    verified: stored.verified,
    note: stored.note,
    replacesLine: stored.replacesLine,
  };
  for (const [field, keys] of Object.entries(IMPORT_FIELD_KEYS)) {
    if (keys.some((k) => has(item, k) && item[k] !== undefined)) merged[field] = incoming[field];
  }
  return merged;
}

// One transaction for the whole paste: either every row lands or none does,
// so a list that fails halfway cannot leave half of itself behind. `items`
// are the validated request objects, not rows, so the merge can tell a field
// the paste set from one it never mentioned.
//
// TWO IMPORTS AT ONCE. The match below locks a row that exists; it cannot lock
// one that does not exist yet, so two pastes of the same new bill would each
// find nothing. The unique key settles it: the second insert waits for the
// first to commit, does nothing, and this reads the bill again (a new statement
// sees the committed row) and merges into it.
async function importExpenses(items, userId, db = pool) {
  const client = await db.connect();
  const inserted = [];
  const updated = [];
  const mergeInto = async (rows, item) => {
    for (const r of rows) {
      const merged = mergeIntoStored(expenseFromRow(r), item);
      const u = await client.query(EXPENSE_UPDATE_SQL, [Number(r.id), ...expenseParams(merged), userId]);
      if (u.rows && u.rows[0]) updated.push(expenseFromRow(u.rows[0]));
    }
  };
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const row = expenseRowFromInput(item);
      const key = [row.vendor, row.product, row.cadence];
      const found = await client.query(EXPENSE_MATCH_SQL, key);
      if (found.rows && found.rows.length > 0) {
        await mergeInto(found.rows, item);
        continue;
      }
      const ins = await client.query(EXPENSE_IMPORT_INSERT_SQL, [...expenseParams(row), userId]);
      if (ins.rows && ins.rows[0]) {
        inserted.push(expenseFromRow(ins.rows[0]));
        continue;
      }
      const raced = await client.query(EXPENSE_MATCH_SQL, key);
      await mergeInto((raced.rows || []), item);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { inserted, updated };
}

// ---------------------------------------------------------------------------
// THE COST PICTURE
// ---------------------------------------------------------------------------
//
// Three sources, one rule each:
//   * costModel.js lines (monthly, annual, one-time): counted unless an active
//     expense row names the line in replaces_line.
//   * the reconciled invoice (cost_reconciled over costModel.RECONCILED): the
//     same, a usage bill read as this much a month.
//   * expense rows: counted while active and in USD.
//
// Two figures come out of every line:
//   perMonth   the run rate. Monthly and usage bills in full, yearly bills at
//              a twelfth, one-time bills never. The sum is the monthly burn.
//   thisMonth  what belongs to this calendar month: the run rate, plus any
//              one-time bill charged this month. Yearly bills are spread, so a
//              renewal does not make one month look eleven times worse; the
//              renewal list below is where the cash dates are.

const KIND_LABEL = {
  infrastructure: 'Running the app',
  tooling: 'Building it',
  legal: 'Legal and company',
  other: 'Other',
};

function perMonthCents(cadence, amountCents) {
  if (!Number.isFinite(amountCents)) return 0;
  switch (cadence) {
    case 'monthly':
    case 'usage':
      return amountCents;
    case 'yearly':
      return amountCents / 12;
    default:
      return 0;
  }
}

// The next charge date of a recurring expense, and whether it was typed or
// worked out from the last charge.
function nextChargeOn(x, todayYmd) {
  if (x.renewsOn && x.renewsOn >= todayYmd) return { on: x.renewsOn, estimated: false };
  const step = x.cadence === 'monthly' ? 1 : x.cadence === 'yearly' ? 12 : null;
  const base = x.renewsOn || x.lastChargedOn;
  if (!step || !base) return null;
  for (let k = 1; k <= 240; k += 1) {
    const next = addMonthsYmd(base, k * step);
    if (next >= todayYmd) return { on: next, estimated: true };
  }
  return null;
}

function codeCostLines(reconciled) {
  const lines = [];
  const add = (e, cadence) => lines.push({
    id: e.id,
    origin: 'code',
    label: e.label,
    kind: EXPENSE_KINDS.includes(e.kind) ? e.kind : 'infrastructure',
    category: CODE_LINE_CATEGORY[e.id] || 'Other',
    cadence,
    amountCents: Math.round(Number(e.usd) * 100),
    currency: 'USD',
    verified: !!e.verified,
    checked: e.checked || null,
  });
  for (const e of costModel.FIXED_MONTHLY) add(e, 'monthly');
  for (const e of costModel.FIXED_ANNUAL) add(e, 'yearly');
  for (const e of costModel.ONE_TIME) add(e, 'one_time');
  const recLines = reconciled && Array.isArray(reconciled.lines)
    ? reconciled.lines
    : costModel.RECONCILED.lines.map((l) => ({ ...l, asOf: costModel.RECONCILED.asOf, source: 'code' }));
  for (const l of recLines) {
    lines.push({
      id: l.id,
      origin: 'reconciled',
      label: l.label,
      kind: 'infrastructure',
      category: CODE_LINE_CATEGORY[l.id] || 'Google Cloud',
      cadence: 'usage',
      amountCents: Math.round(Number(l.usdPerMonth) * 100),
      currency: 'USD',
      verified: true,
      checked: l.asOf || null,
      recordedIn: l.source === 'dashboard' ? 'dashboard' : 'code',
    });
  }
  return lines;
}

function buildCostPicture({ expenses = [], reconciled = null, month }) {
  // Only a row that is itself counted may take a code line out of the total:
  // active, and in dollars. A euro bill linked to Railway would otherwise
  // remove the $20 and add nothing, since nothing here converts currencies.
  const replacedBy = new Map();
  for (const x of expenses) {
    if (x.active && x.currency === 'USD' && x.replacesLine) {
      if (!replacedBy.has(x.replacesLine)) replacedBy.set(x.replacesLine, []);
      replacedBy.get(x.replacesLine).push(x.id);
    }
  }

  const lines = [];
  for (const c of codeCostLines(reconciled)) {
    const by = replacedBy.get(c.id) || null;
    lines.push({ ...c, counted: !by, replacedBy: by });
  }
  for (const x of expenses) {
    const usd = x.currency === 'USD';
    lines.push({
      id: `expense-${x.id}`,
      origin: 'expense',
      expenseId: x.id,
      label: x.product ? `${x.vendor}, ${x.product}` : x.vendor,
      kind: x.kind,
      category: x.category || 'Uncategorised',
      cadence: x.cadence,
      amountCents: x.amountCents,
      currency: x.currency,
      verified: x.verified,
      lastChargedOn: x.lastChargedOn,
      renewsOn: x.renewsOn,
      replacesLine: x.replacesLine,
      counted: x.active && usd,
      inactive: !x.active,
      nonUsd: !usd,
    });
  }

  for (const l of lines) {
    const run = l.counted ? perMonthCents(l.cadence, l.amountCents) : 0;
    const once = l.counted && l.cadence === 'one_time' && inMonth(l.lastChargedOn, month) ? l.amountCents : 0;
    l.perMonthCents = Math.round(run);
    l.thisMonthCents = Math.round(run + once);
  }

  const byKind = {};
  for (const k of EXPENSE_KINDS) byKind[k] = { kind: k, label: KIND_LABEL[k], thisMonthCents: 0, perMonthCents: 0, lines: 0 };
  const byCategory = new Map();
  let thisMonthCents = 0;
  let perMonthTotal = 0;
  for (const l of lines) {
    if (!l.counted) continue;
    const k = byKind[l.kind] || byKind.other;
    k.thisMonthCents += l.thisMonthCents;
    k.perMonthCents += l.perMonthCents;
    k.lines += 1;
    if (!byCategory.has(l.category)) byCategory.set(l.category, { category: l.category, thisMonthCents: 0, perMonthCents: 0, lines: 0 });
    const c = byCategory.get(l.category);
    c.thisMonthCents += l.thisMonthCents;
    c.perMonthCents += l.perMonthCents;
    c.lines += 1;
    thisMonthCents += l.thisMonthCents;
    perMonthTotal += l.perMonthCents;
  }

  // Renewals in the window, from the expense list. Code lines carry no charge
  // dates, and the panel says so rather than guessing one.
  const horizon = addDaysYmd(month.todayYmd, RENEWAL_WINDOW_DAYS);
  const upcoming = [];
  for (const x of expenses) {
    if (!x.active || (x.cadence !== 'monthly' && x.cadence !== 'yearly')) continue;
    const next = nextChargeOn(x, month.todayYmd);
    if (!next || next.on > horizon) continue;
    upcoming.push({
      expenseId: x.id,
      label: x.product ? `${x.vendor}, ${x.product}` : x.vendor,
      on: next.on,
      estimated: next.estimated,
      amountCents: x.amountCents,
      currency: x.currency,
      cadence: x.cadence,
    });
  }
  upcoming.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.label.localeCompare(b.label)));

  // Probably the same bill twice: a code line still counted, and an active
  // expense row whose name looks like it and whose cadence fits.
  const possibleDoubles = [];
  const fits = (codeCadence, rowCadence) => codeCadence === rowCadence
    || (codeCadence === 'usage' && rowCadence === 'monthly')
    || (codeCadence === 'monthly' && rowCadence === 'usage');
  for (const c of lines) {
    if (c.origin === 'expense' || !c.counted || !has(CODE_LINE_LOOKALIKE, c.id)) continue;
    for (const x of expenses) {
      if (!x.active || x.replacesLine) continue;
      const name = `${x.vendor} ${x.product || ''}`;
      if (CODE_LINE_LOOKALIKE[c.id].test(name) && fits(c.cadence, x.cadence)) {
        possibleDoubles.push({ codeLineId: c.id, codeLabel: c.label, expenseId: x.id, expenseLabel: x.product ? `${x.vendor}, ${x.product}` : x.vendor });
      }
    }
  }

  const replaced = lines
    .filter((l) => l.origin !== 'expense' && !l.counted)
    .map((l) => ({ id: l.id, label: l.label, byExpenseIds: l.replacedBy || [] }));

  return {
    lines,
    byKind: EXPENSE_KINDS.map((k) => byKind[k]),
    byCategory: [...byCategory.values()].sort((a, b) => b.perMonthCents - a.perMonthCents || a.category.localeCompare(b.category)),
    totals: { thisMonthCents, perMonthCents: perMonthTotal },
    upcoming,
    upcomingWindowDays: RENEWAL_WINDOW_DAYS,
    possibleDoubles,
    replaced,
    nonUsd: lines.filter((l) => l.nonUsd && !l.inactive).map((l) => ({
      label: l.label,
      amountCents: l.amountCents,
      currency: l.currency,
      // Named so the screen can say the code line it points at still counts.
      replacesLine: l.replacesLine || null,
    })),
    undatedCodeYearly: lines.filter((l) => l.origin === 'code' && l.cadence === 'yearly' && l.counted).length,
  };
}

// What GET /api/admin/costs carries for the Costs tab: the same arithmetic,
// reduced to the figures that panel shows. One function, so the two tabs
// cannot disagree about a total.
function costsLedger({ expenses, reconciled, month, readError = null }) {
  const pic = buildCostPicture({ expenses: expenses || [], reconciled, month });
  const usd = (c) => Math.round(c) / 100;
  const kind = (k) => usd((pic.byKind.find((x) => x.kind === k) || { perMonthCents: 0 }).perMonthCents);
  return {
    status: readError ? 'error' : 'ok',
    readError: readError || null,
    rows: (expenses || []).length,
    activeRows: (expenses || []).filter((x) => x.active).length,
    burnMonthlyUsd: usd(pic.totals.perMonthCents),
    infrastructureMonthlyUsd: kind('infrastructure'),
    toolingMonthlyUsd: kind('tooling'),
    legalMonthlyUsd: kind('legal'),
    otherMonthlyUsd: kind('other'),
    replacedLines: pic.replaced.map((r) => r.label),
  };
}

// ---------------------------------------------------------------------------
// STRIPE
// ---------------------------------------------------------------------------

function stripeMode() {
  const k = typeof process.env.STRIPE_SECRET_KEY === 'string' ? process.env.STRIPE_SECRET_KEY.trim() : '';
  if (/^(sk|rk)_live_/.test(k)) return 'live';
  if (/^(sk|rk)_test_/.test(k)) return 'test';
  return 'unknown';
}

// Each price variable read by its literal name, so the environment inventory
// test sees what this file depends on.
function configuredPriceIds() {
  return [
    { env: 'STRIPE_PRICE_PRO_MONTHLY', product: 'pro', plan: 'monthly', id: plain(process.env.STRIPE_PRICE_PRO_MONTHLY) },
    { env: 'STRIPE_PRICE_PRO_YEARLY', product: 'pro', plan: 'yearly', id: plain(process.env.STRIPE_PRICE_PRO_YEARLY) },
    { env: 'STRIPE_PRICE_ROOST_MONTHLY', product: 'roost', plan: 'monthly', id: plain(process.env.STRIPE_PRICE_ROOST_MONTHLY) },
    { env: 'STRIPE_PRICE_ROOST_YEARLY', product: 'roost', plan: 'yearly', id: plain(process.env.STRIPE_PRICE_ROOST_YEARLY) },
    { env: 'STRIPE_PRICE_ROOST_FOUNDING', product: 'roost', plan: 'founding', id: plain(process.env.STRIPE_PRICE_ROOST_FOUNDING) },
    // Retired prices still billed to existing venues. No plan of their own:
    // they count under Roost and are checked for existence, not against a
    // stated price.
    ...legacyRoostPrices().map((id) => ({ env: 'STRIPE_PRICE_ROOST_LEGACY', product: 'roost', plan: 'legacy', id })),
  ];
}

function priceRoleMap(configured) {
  const map = new Map();
  for (const c of configured) if (c.id) map.set(c.id, { product: c.product, plan: c.plan, env: c.env });
  return map;
}

// A failure in words a person can act on. Stripe's own message is never
// passed through: an authentication error quotes part of the key.
function stripeProblem(err) {
  const type = err && (err.type || err.rawType);
  const status = err && err.statusCode;
  if (type === 'StripeAuthenticationError' || status === 401) {
    return { code: 'auth', words: 'Stripe refused the key (401). STRIPE_SECRET_KEY needs replacing.' };
  }
  if (type === 'StripePermissionError' || status === 403) {
    return { code: 'permission', words: 'The key is not allowed to read this (403). A restricted key needs read access to it.' };
  }
  if (type === 'StripeRateLimitError' || status === 429) {
    return { code: 'rate', words: 'Stripe is rate limiting this account (429).' };
  }
  if (type === 'StripeConnectionError' || (err && /timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(String(err.message || '')))) {
    return { code: 'network', words: 'Stripe did not answer in time.' };
  }
  return { code: 'other', words: status ? `Stripe answered ${status}.` : 'The Stripe read failed.' };
}

async function listAll(fetchPage, params, maxPages) {
  const data = [];
  let after = null;
  for (let page = 0; page < maxPages; page += 1) {
    const r = await fetchPage({ ...params, limit: STRIPE_PAGE, ...(after ? { starting_after: after } : {}) });
    const rows = r && Array.isArray(r.data) ? r.data : [];
    data.push(...rows);
    if (!r || !r.has_more || rows.length === 0) return { data, truncated: false };
    after = rows[rows.length - 1].id;
  }
  return { data, truncated: true };
}

function classifySubscription(sub, roles) {
  const items = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data : [];
  for (const it of items) {
    const id = it && it.price && it.price.id;
    if (id && roles.has(id)) {
      const r = roles.get(id);
      return { product: r.product, plan: r.plan };
    }
  }
  const meta = (sub && sub.metadata) || {};
  const product = meta.kind === 'venue' ? 'roost' : (meta.app_user_id ? 'pro' : 'other');
  const rec = items[0] && items[0].price && items[0].price.recurring;
  const plan = rec && rec.interval === 'year' ? 'yearly' : rec && rec.interval === 'month' ? 'monthly' : 'other';
  return { product, plan };
}

function couponOf(discount, coupons) {
  if (!discount || typeof discount !== 'object') return undefined;
  const raw = (discount.source && discount.source.coupon !== undefined) ? discount.source.coupon : discount.coupon;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && coupons.has(raw)) return coupons.get(raw);
  return undefined;
}

// Recurring revenue from one subscription, in cents a month, after the
// discounts still running on it. `once` coupons are left out on purpose: they
// take one invoice off and are not part of what recurs.
function subscriptionMonthly(sub, coupons, nowSec) {
  const items = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data : [];
  let base = 0;
  let currency = null;
  let recurring = null;
  let unpriced = false;
  for (const it of items) {
    const p = (it && it.price) || {};
    if (!Number.isFinite(p.unit_amount)) { unpriced = true; continue; }
    const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
    base += (p.unit_amount * qty) / monthsPerCharge(p.recurring);
    currency = currency || p.currency || null;
    recurring = recurring || p.recurring || null;
  }
  let factor = 1;
  let amountOff = 0;
  let unreadableDiscount = false;
  for (const d of (sub && Array.isArray(sub.discounts) ? sub.discounts : [])) {
    if (typeof d === 'string') { unreadableDiscount = true; continue; }
    if (d && Number.isFinite(d.end) && d.end <= nowSec) continue;
    const c = couponOf(d, coupons);
    if (!c) { unreadableDiscount = true; continue; }
    if (c.duration === 'once') continue;
    if (Number.isFinite(c.percent_off)) factor *= Math.max(0, 1 - c.percent_off / 100);
    else if (Number.isFinite(c.amount_off)) amountOff += c.amount_off / monthsPerCharge(recurring);
  }
  const cents = Math.max(0, base * factor - amountOff);
  return { cents, currency: currency ? String(currency).toLowerCase() : null, recurring, unpriced, unreadableDiscount };
}

function emptyProductSummary() {
  const plan = () => ({ live: 0, trialing: 0, mrrCents: 0 });
  return {
    live: 0,
    pastDue: 0,
    trialing: 0,
    unpaid: 0,
    endingAtPeriodEnd: 0,
    freeViaCode: 0,
    notPriced: 0,
    mrrCents: 0,
    mrrNetCents: 0,
    byPlan: { monthly: plan(), yearly: plan(), founding: plan(), other: plan() },
  };
}

function summarizeSubscriptions(subs, { roles, coupons = new Map(), nowSec = Math.floor(Date.now() / 1000) }) {
  const out = { pro: emptyProductSummary(), roost: emptyProductSummary(), other: emptyProductSummary() };
  const seen = new Set();
  const webProAccounts = new Set();
  for (const sub of subs) {
    if (!sub || !sub.id || seen.has(sub.id)) continue;
    seen.add(sub.id);
    const { product, plan } = classifySubscription(sub, roles);
    const s = out[product] || out.other;
    const p = s.byPlan[plan] || s.byPlan.other;
    if (sub.status === 'trialing') {
      s.trialing += 1;
      p.trialing += 1;
    } else if (sub.status === 'unpaid') {
      s.unpaid += 1;
    } else if (sub.status === 'active' || sub.status === 'past_due') {
      s.live += 1;
      p.live += 1;
      if (sub.status === 'past_due') s.pastDue += 1;
      const m = subscriptionMonthly(sub, coupons, nowSec);
      if (m.unpriced || m.unreadableDiscount || (m.currency && m.currency !== 'usd')) {
        s.notPriced += 1;
      } else {
        const cents = Math.round(m.cents);
        s.mrrCents += cents;
        p.mrrCents += cents;
        s.mrrNetCents += stripeNetMonthlyCents(cents, m.recurring);
        if (cents === 0) s.freeViaCode += 1;
      }
    } else {
      continue;
    }
    if (sub.cancel_at_period_end) s.endingAtPeriodEnd += 1;
    if (product === 'pro' && sub.metadata && /^[1-9][0-9]{0,9}$/.test(String(sub.metadata.app_user_id || ''))) {
      webProAccounts.add(Number(sub.metadata.app_user_id));
    }
  }
  for (const key of Object.keys(out)) out[key].mrrNetCents = Math.round(out[key].mrrNetCents);
  return { ...out, webProAccounts };
}

// Money that moved through the Stripe balance this month, by what it was.
// Payouts and transfers move money that was already counted, so they are
// left out; anything unrecognised is kept, added at its net, and named.
function summarizeBalance(transactions) {
  const agg = { grossCents: 0, refundsCents: 0, disputesCents: 0, feesCents: 0, otherCents: 0, otherCategories: [], charges: 0, refunds: 0, nonUsd: 0 };
  const other = new Map();
  for (const bt of transactions) {
    if (!bt || typeof bt !== 'object') continue;
    if (String(bt.currency || '').toLowerCase() !== 'usd') { agg.nonUsd += 1; continue; }
    const amount = Number(bt.amount) || 0;
    const fee = Number(bt.fee) || 0;
    switch (bt.reporting_category) {
      case 'charge':
        agg.grossCents += amount;
        agg.feesCents += fee;
        agg.charges += 1;
        break;
      case 'refund':
      case 'refund_failure':
      case 'partial_capture_reversal':
        agg.refundsCents += amount;
        agg.feesCents += fee;
        agg.refunds += 1;
        break;
      case 'dispute':
      case 'dispute_reversal':
        agg.disputesCents += amount;
        agg.feesCents += fee;
        break;
      case 'fee':
        agg.feesCents += -amount + fee;
        break;
      case 'payout':
      case 'payout_reversal':
      case 'transfer':
      case 'transfer_reversal':
      case 'topup':
      case 'topup_reversal':
        break;
      default: {
        agg.otherCents += Number(bt.net) || 0;
        const cat = String(bt.reporting_category || bt.type || 'unknown').slice(0, 40);
        other.set(cat, (other.get(cat) || 0) + 1);
      }
    }
  }
  agg.otherCategories = [...other.entries()].map(([category, count]) => ({ category, count }));
  agg.netCents = agg.grossCents + agg.refundsCents + agg.disputesCents - agg.feesCents + agg.otherCents;
  return agg;
}

function invoiceProduct(inv, roles) {
  const meta = inv && inv.parent && inv.parent.subscription_details ? inv.parent.subscription_details.metadata : null;
  if (meta && meta.kind === 'venue') return 'roost';
  if (meta && meta.app_user_id) return 'pro';
  const lines = inv && inv.lines && Array.isArray(inv.lines.data) ? inv.lines.data : [];
  for (const l of lines) {
    const pd = l && l.pricing && l.pricing.price_details;
    const id = pd ? (typeof pd.price === 'string' ? pd.price : pd.price && pd.price.id) : null;
    if (id && roles.has(id)) return roles.get(id).product;
  }
  return 'other';
}

function summarizeInvoices(invoices, { roles, month }) {
  const byProduct = {
    pro: { paidCents: 0, invoices: 0, zeroInvoices: 0 },
    roost: { paidCents: 0, invoices: 0, zeroInvoices: 0 },
    other: { paidCents: 0, invoices: 0, zeroInvoices: 0 },
  };
  let nonUsd = 0;
  for (const inv of invoices) {
    if (!inv || inv.status !== 'paid') continue;
    const paidAt = inv.status_transitions && inv.status_transitions.paid_at;
    if (!Number.isFinite(paidAt) || paidAt < month.startUnix) continue;
    if (String(inv.currency || '').toLowerCase() !== 'usd') { nonUsd += 1; continue; }
    const b = byProduct[invoiceProduct(inv, roles)];
    const paid = Number(inv.amount_paid) || 0;
    b.paidCents += paid;
    b.invoices += 1;
    if (paid === 0) b.zeroInvoices += 1;
  }
  return { byProduct, nonUsd };
}

function summarizePromotionCodes(codes, coupons) {
  return codes.slice(0, 50).map((pc) => {
    const raw = pc && pc.promotion && pc.promotion.coupon !== undefined ? pc.promotion.coupon : pc && pc.coupon;
    const c = raw && typeof raw === 'object' ? raw : (typeof raw === 'string' && coupons.has(raw) ? coupons.get(raw) : null);
    return {
      code: String(pc.code || ''),
      active: pc.active === true,
      timesRedeemed: Number.isFinite(pc.times_redeemed) ? pc.times_redeemed : null,
      maxRedemptions: Number.isFinite(pc.max_redemptions) ? pc.max_redemptions : null,
      expiresAt: Number.isFinite(pc.expires_at) ? new Date(pc.expires_at * 1000).toISOString() : null,
      coupon: c ? {
        percentOff: Number.isFinite(c.percent_off) ? c.percent_off : null,
        amountOffCents: Number.isFinite(c.amount_off) ? c.amount_off : null,
        currency: c.currency ? String(c.currency).toUpperCase() : null,
        duration: c.duration || null,
        durationInMonths: Number.isFinite(c.duration_in_months) ? c.duration_in_months : null,
      } : null,
    };
  });
}

function priceView(p, roles) {
  const product = p && p.product;
  const role = roles.get(p.id) || null;
  return {
    id: p.id,
    productName: product && typeof product === 'object' ? (product.name || null) : null,
    unitAmountCents: Number.isFinite(p.unit_amount) ? p.unit_amount : null,
    currency: p.currency ? String(p.currency).toUpperCase() : null,
    interval: p.recurring ? p.recurring.interval : null,
    intervalCount: p.recurring && Number.isFinite(p.recurring.interval_count) ? p.recurring.interval_count : null,
    lookupKey: p.lookup_key || null,
    nickname: p.nickname || null,
    active: p.active !== false,
    env: role ? role.env : null,
    product: role ? role.product : null,
    plan: role ? role.plan : null,
  };
}

async function readStripePrices(client, configured, roles) {
  const list = await listAll((p) => client.prices.list(p, STRIPE_REQUEST), { active: true, expand: ['data.product'] }, PRICE_MAX_PAGES);
  const live = list.data.map((p) => priceView(p, roles));
  const byId = new Map(live.map((p) => [p.id, p]));
  const envs = [];
  for (const c of configured) {
    if (!c.id) { envs.push({ env: c.env, product: c.product, plan: c.plan, set: false }); continue; }
    let found = byId.get(c.id) || null;
    if (!found) {
      try {
        const p = await client.prices.retrieve(c.id, { expand: ['product'] }, STRIPE_REQUEST);
        found = p ? priceView(p, roles) : null;
      } catch (err) {
        const missing = err && (err.statusCode === 404 || err.code === 'resource_missing');
        envs.push({ env: c.env, product: c.product, plan: c.plan, set: true, id: c.id, found: false, reason: missing ? 'Stripe has no price with that id.' : stripeProblem(err).words });
        continue;
      }
    }
    envs.push({ env: c.env, product: c.product, plan: c.plan, set: true, id: c.id, found: !!found, price: found });
  }
  return { status: 'ok', live, envs, truncated: list.truncated };
}

async function readStripe(month) {
  const client = billing.stripeClient();
  if (!client) {
    return { status: 'not_connected', reason: 'STRIPE_SECRET_KEY is not set on the server, so nothing here can read Stripe.' };
  }
  const configured = configuredPriceIds();
  const roles = priceRoleMap(configured);
  const nowSec = Math.floor(Date.now() / 1000);

  const readSubs = async () => {
    const lists = await Promise.all(LIVE_SUB_STATUSES.map((status) => listAll(
      (p) => client.subscriptions.list(p, STRIPE_REQUEST),
      { status, expand: ['data.discounts'] },
      SUBSCRIPTION_MAX_PAGES
    )));
    return { data: lists.flatMap((l) => l.data), truncated: lists.some((l) => l.truncated) };
  };

  const [subsR, btR, invR, dispR, promoR, priceR] = await Promise.allSettled([
    readSubs(),
    listAll((p) => client.balanceTransactions.list(p, STRIPE_REQUEST), { created: { gte: month.startUnix } }, BALANCE_MAX_PAGES),
    listAll((p) => client.invoices.list(p, STRIPE_REQUEST), { status: 'paid', created: { gte: month.startUnix - INVOICE_LOOKBACK_DAYS * 86400 } }, INVOICE_MAX_PAGES),
    // No status filter exists on this list, so every page is read and the
    // open ones are picked out below.
    listAll((p) => client.disputes.list(p, STRIPE_REQUEST), {}, DISPUTE_MAX_PAGES),
    client.promotionCodes.list({ limit: STRIPE_PAGE }, STRIPE_REQUEST),
    readStripePrices(client, configured, roles),
  ]);

  const settled = [subsR, btR, invR, dispR, promoR, priceR];
  if (settled.every((r) => r.status === 'rejected')) {
    return { status: 'error', reason: stripeProblem(settled[0].reason).words, mode: stripeMode() };
  }

  // Coupons the subscriptions and promotion codes point at, fetched once each.
  const couponIds = new Set();
  const collect = (raw) => { if (typeof raw === 'string') couponIds.add(raw); };
  if (subsR.status === 'fulfilled') {
    for (const s of subsR.value.data) {
      for (const d of (Array.isArray(s.discounts) ? s.discounts : [])) {
        if (d && typeof d === 'object') collect(d.source && d.source.coupon !== undefined ? d.source.coupon : d.coupon);
      }
    }
  }
  if (promoR.status === 'fulfilled') {
    for (const pc of (promoR.value && promoR.value.data) || []) {
      collect(pc && pc.promotion && pc.promotion.coupon !== undefined ? pc.promotion.coupon : pc && pc.coupon);
    }
  }
  const coupons = new Map();
  await mapLimit([...couponIds].slice(0, COUPON_LOOKUP_MAX), 5, async (id) => {
    try {
      const c = await client.coupons.retrieve(id, {}, STRIPE_REQUEST);
      if (c) coupons.set(id, c);
    } catch { /* the subscription reads as not priced rather than full price */ }
  });

  const block = (r, build) => (r.status === 'fulfilled'
    ? { status: 'ok', ...build(r.value) }
    : { status: 'error', reason: stripeProblem(r.reason).words });

  const subscriptions = block(subsR, (v) => {
    const s = summarizeSubscriptions(v.data, { roles, coupons, nowSec });
    const { webProAccounts, ...rest } = s;
    return { ...rest, truncated: v.truncated, webProAccountCount: webProAccounts.size, _webProAccounts: webProAccounts };
  });
  const balance = block(btR, (v) => ({ ...summarizeBalance(v.data), truncated: v.truncated }));
  const invoices = block(invR, (v) => ({
    ...summarizeInvoices(v.data, { roles, month }),
    truncated: v.truncated,
    lookbackDays: INVOICE_LOOKBACK_DAYS,
  }));
  // Dollars only in the sum: a dispute in another currency is counted apart
  // rather than added to cents it is not measured in.
  const disputes = block(dispR, (v) => {
    const open = ((v && v.data) || []).filter((d) => d && OPEN_DISPUTE_STATUSES.has(d.status));
    const usd = open.filter((d) => String(d.currency || '').toLowerCase() === 'usd');
    return {
      open: usd.length,
      openAmountCents: usd.reduce((sum, d) => sum + (Number(d.amount) || 0), 0),
      openOtherCurrency: open.length - usd.length,
      truncated: v.truncated,
    };
  });
  const promotionCodes = block(promoR, (v) => ({ codes: summarizePromotionCodes((v && v.data) || [], coupons) }));
  const prices = priceR.status === 'fulfilled' ? priceR.value : { status: 'error', reason: stripeProblem(priceR.reason).words };

  return {
    status: 'ok',
    mode: stripeMode(),
    asOf: new Date().toISOString(),
    subscriptions,
    balance,
    invoices,
    disputes,
    promotionCodes,
    prices,
  };
}

// ---------------------------------------------------------------------------
// REVENUECAT
// ---------------------------------------------------------------------------

function rcKey() {
  const raw = typeof process.env.REVENUECAT_SECRET_API_KEY === 'string' ? process.env.REVENUECAT_SECRET_API_KEY.trim() : '';
  return raw.length >= RC_MIN_KEY_LENGTH ? raw : null;
}

async function rcGet(url, key) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(RC_TIMEOUT_MS),
  });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok) {
    const err = new Error(`RevenueCat answered ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

function rcProblem(err) {
  const s = err && err.status;
  if (s === 401) return 'RevenueCat refused the key (401).';
  if (s === 403) return 'The key is not allowed to read this (403).';
  if (s === 429) return 'RevenueCat is rate limiting this key (429).';
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'RevenueCat did not answer in time.';
  return s ? `RevenueCat answered ${s}.` : 'The RevenueCat read failed.';
}

function micros(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (/micros$/i.test(k) && Number.isFinite(v)) return v;
  }
  return null;
}

const RC_V2_KEY_WORDS = 'The project-wide figures need a RevenueCat API v2 secret key that can read the project and its charts.';

// WHICH PROJECT. REVENUECAT_PROJECT_ID names it when set. Unset, the hub uses
// the one project the key can see, and refuses to pick when it can see more
// than one: figures from somebody else's project under Flock's name would be
// worse than no figures.
async function rcProjectFor(key) {
  const configured = plain(process.env.REVENUECAT_PROJECT_ID);
  if (configured) return { id: configured, name: null };
  const list = await rcGet(`${RC_V2}/projects?limit=5`, key);
  const items = list && Array.isArray(list.items) ? list.items : [];
  if (items.length === 0) return { problem: 'RevenueCat listed no project for this key.' };
  if (items.length > 1) {
    return {
      problem: 'This key can read more than one RevenueCat project, so the hub will not guess which is Flock\'s. Set REVENUECAT_PROJECT_ID to its project id.',
    };
  }
  return { id: String(items[0].id), name: typeof items[0].name === 'string' ? items[0].name.slice(0, 80) : null };
}

async function readRcOverview(key, month) {
  let project;
  try {
    project = await rcProjectFor(key);
  } catch (err) {
    const refused = err && (err.status === 401 || err.status === 403);
    return { status: refused ? 'refused' : 'error', reason: `${rcProblem(err)} ${RC_V2_KEY_WORDS}` };
  }
  if (project.problem) return { status: 'error', reason: project.problem };
  const base = `${RC_V2}/projects/${encodeURIComponent(String(project.id))}`;

  let metrics = null;
  let metricsReason = null;
  let metricsRefused = false;
  try {
    const o = await rcGet(`${base}/metrics/overview?currency=USD`, key);
    metrics = (o && Array.isArray(o.metrics) ? o.metrics : []).slice(0, 12).map((m) => ({
      id: String(m.id || ''),
      name: String(m.name || m.id || ''),
      value: Number.isFinite(m.value) ? m.value : null,
      unit: typeof m.unit === 'string' ? m.unit : null,
      period: typeof m.period === 'string' ? m.period : null,
    }));
  } catch (err) {
    metricsRefused = !!err && (err.status === 401 || err.status === 403);
    metricsReason = metricsRefused ? `${rcProblem(err)} ${RC_V2_KEY_WORDS}` : rcProblem(err);
  }

  let monthRevenueUsd = null;
  try {
    const r = await rcGet(`${base}/metrics/revenue?start_date=${month.startYmd}&end_date=${month.todayYmd}&currency=USD&revenue_type=revenue`, key);
    if (r && Number.isFinite(r.value)) monthRevenueUsd = r.value;
  } catch { /* optional: the overview still stands without it */ }

  // Products (with the App Store price RevenueCat holds, when it holds one)
  // and the current offering's packages, for the pricing panel.
  let products = null;
  try {
    let body;
    try {
      body = await rcGet(`${base}/products?limit=50&expand=items.app&expand=items.indicative_price`, key);
    } catch (err) {
      if (err && err.status === 400) body = await rcGet(`${base}/products?limit=50`, key);
      else throw err;
    }
    products = (body && Array.isArray(body.items) ? body.items : []).map((p) => {
      const ip = p.indicative_price || null;
      const m = micros(ip);
      return {
        id: String(p.id || ''),
        storeIdentifier: p.store_identifier || null,
        store: p.app && p.app.type ? String(p.app.type) : null,
        duration: p.subscription && p.subscription.duration ? p.subscription.duration : null,
        trialDuration: p.subscription && p.subscription.trial_duration ? p.subscription.trial_duration : null,
        state: p.state || null,
        indicativeCents: Number.isFinite(m) ? Math.round(m / 10000) : null,
        indicativeCurrency: ip && ip.currency ? String(ip.currency).toUpperCase() : null,
      };
    });
  } catch { products = null; }

  // Without the product list a package's products are bare ids, and checking
  // them would report every package as wrong. Say it could not be checked.
  let offering = products === null
    ? { status: 'error', reason: 'RevenueCat would not list the products for this key, so the offering could not be checked.' }
    : null;
  if (offering === null) {
    try {
      const list = await rcGet(`${base}/offerings?limit=20`, key);
      const items = list && Array.isArray(list.items) ? list.items : [];
      const current = items.find((o) => o && o.is_current) || null;
      if (!current) {
        offering = { status: 'ok', identifier: null, packages: [] };
      } else {
        const pk = await rcGet(`${base}/offerings/${encodeURIComponent(String(current.id))}/packages?limit=20`, key);
        const byId = new Map(products.map((p) => [p.id, p]));
        const packages = (pk && Array.isArray(pk.items) ? pk.items : []).map((p) => {
          const assoc = p.products && Array.isArray(p.products.items) ? p.products.items : [];
          return {
            lookupKey: p.lookup_key || null,
            products: assoc.map((a) => {
              const id = a && a.product && typeof a.product === 'object' ? a.product.id : a && a.product_id;
              const prod = byId.get(String(id)) || (a && a.product && typeof a.product === 'object' ? {
                id: String(a.product.id),
                storeIdentifier: a.product.store_identifier || null,
                store: null,
                duration: a.product.subscription ? a.product.subscription.duration : null,
              } : null);
              return prod
                ? { storeIdentifier: prod.storeIdentifier, store: prod.store, duration: prod.duration }
                : { storeIdentifier: null, store: null, duration: null };
            }),
          };
        });
        offering = { status: 'ok', identifier: current.lookup_key || null, packages };
      }
    } catch (err) {
      offering = { status: 'error', reason: rcProblem(err) };
    }
  }

  return {
    status: metrics ? 'ok' : (metricsRefused ? 'refused' : 'error'),
    reason: metrics ? null : metricsReason,
    projectName: project.name,
    metrics: metrics || [],
    monthRevenueUsd,
    products,
    offering,
  };
}

function storeBucket(store) {
  const s = String(store || '').toLowerCase();
  if (s === 'app_store' || s === 'mac_app_store') return 'app_store';
  if (s === 'stripe' || s === 'promotional' || s === 'play_store' || s === 'rc_billing') return s;
  return 'other';
}

function planOfProduct(productId, s) {
  if (has(APP_STORE_PRODUCTS, productId)) return APP_STORE_PRODUCTS[productId].plan;
  if (/year|annual/i.test(productId)) return 'yearly';
  if (/month/i.test(productId)) return 'monthly';
  const start = s && s.purchase_date ? Date.parse(s.purchase_date) : NaN;
  const end = s && s.expires_date ? Date.parse(s.expires_date) : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && s.period_type !== 'trial') {
    const days = (end - start) / 86400000;
    if (days >= 300) return 'yearly';
    if (days >= 25 && days <= 35) return 'monthly';
  }
  return 'other';
}

function emptyStoreTally() {
  const plan = () => ({ live: 0, trialing: 0 });
  return {
    live: 0,
    trialing: 0,
    unpriced: 0,
    // The unpriced ones whose latest purchase or renewal is dated this month:
    // each is a charge this month of an amount nobody here can read.
    unpricedThisMonth: 0,
    mrrCents: 0,
    monthChargedCents: 0,
    byPlan: { monthly: plan(), yearly: plan(), other: plan() },
  };
}

// Tally every Pro account's live subscriptions by store, from RevenueCat's
// record of each one. Only the counts and sums leave this function.
function tallySubscribers(bodies, { month, nowMs }) {
  const stores = {};
  const tally = (name) => { if (!stores[name]) stores[name] = emptyStoreTally(); return stores[name]; };
  let sandbox = 0;
  let premiumWithNothingLive = 0;
  const appStorePrices = {};
  for (const body of bodies) {
    const subs = body && body.subscriber && body.subscriber.subscriptions && typeof body.subscriber.subscriptions === 'object'
      ? body.subscriber.subscriptions : {};
    let anyLive = false;
    for (const [productId, s] of Object.entries(subs)) {
      if (!s || typeof s !== 'object' || s.refunded_at) continue;
      const exp = s.expires_date ? Date.parse(s.expires_date) : null;
      const grace = s.grace_period_expires_date ? Date.parse(s.grace_period_expires_date) : null;
      const live = s.expires_date === null || s.expires_date === undefined
        || (Number.isFinite(exp) && exp > nowMs) || (Number.isFinite(grace) && grace > nowMs);
      if (!live) continue;
      anyLive = true;
      if (s.is_sandbox === true) { sandbox += 1; continue; }
      const store = storeBucket(s.store);
      const t = tally(store);
      const plan = planOfProduct(productId, s);
      const trial = s.period_type === 'trial';
      if (trial) { t.trialing += 1; t.byPlan[plan].trialing += 1; continue; }
      t.live += 1;
      t.byPlan[plan].live += 1;
      // Number(null) is 0, so an absent amount has to be refused before it
      // is read as a purchase that cost nothing.
      const rawAmount = s.price ? s.price.amount : null;
      const amount = rawAmount !== null && rawAmount !== undefined && rawAmount !== '' && Number.isFinite(Number(rawAmount))
        ? Number(rawAmount) : null;
      const currency = s.price && s.price.currency ? String(s.price.currency).toUpperCase() : null;
      const boughtMs = s.purchase_date ? Date.parse(s.purchase_date) : NaN;
      const bought = Number.isFinite(boughtMs) ? ymdIn(HUB_TZ, new Date(boughtMs)) : null;
      // Counted, and kept out of the sums: buildNet reads these counts and
      // withholds every total they would have made smaller.
      if (amount === null || currency !== 'USD') {
        t.unpriced += 1;
        if (inMonth(bought, month)) t.unpricedThisMonth += 1;
        continue;
      }
      const cents = Math.round(amount * 100);
      t.mrrCents += plan === 'yearly' ? cents / 12 : cents;
      if (inMonth(bought, month)) t.monthChargedCents += cents;
      // THE PRICE AN APP STORE PRODUCT CHARGES, from full-price periods only:
      // an introductory offer is a different price on purpose. The newest
      // purchase is the one kept, and every distinct live price is kept too,
      // because two subscribers paying different amounts for one product is
      // itself a finding.
      if (store === 'app_store' && (!s.period_type || s.period_type === 'normal')) {
        const seen = appStorePrices[productId] || { amountCents: null, currency, purchasedAtMs: -Infinity, amounts: new Set() };
        seen.amounts.add(cents);
        const at = Number.isFinite(boughtMs) ? boughtMs : -Infinity;
        if (seen.amountCents === null || at >= seen.purchasedAtMs) {
          seen.amountCents = cents;
          seen.purchasedAtMs = at;
        }
        appStorePrices[productId] = seen;
      }
    }
    if (!anyLive) premiumWithNothingLive += 1;
  }
  for (const t of Object.values(stores)) t.mrrCents = Math.round(t.mrrCents);
  const prices = {};
  for (const [productId, seen] of Object.entries(appStorePrices)) {
    prices[productId] = {
      amountCents: seen.amountCents,
      currency: seen.currency,
      purchasedAt: Number.isFinite(seen.purchasedAtMs) ? new Date(seen.purchasedAtMs).toISOString() : null,
      distinctAmountsCents: [...seen.amounts].sort((a, b) => a - b),
    };
  }
  return { stores, sandbox, premiumWithNothingLive, appStorePrices: prices };
}

async function readRcSubscribers(key, premiumIds, month) {
  if (premiumIds.length === 0) {
    return { status: 'ok', checked: 0, failed: 0, ...tallySubscribers([], { month, nowMs: Date.now() }) };
  }
  const results = await mapLimit(premiumIds, RC_CONCURRENCY, async (id) => {
    try {
      return { ok: true, body: await rcGet(`${RC_V1}/subscribers/${encodeURIComponent(String(id))}`, key) };
    } catch (err) {
      return { ok: false, err };
    }
  });
  const ok = results.filter((r) => r.ok).map((r) => r.body);
  const failed = results.filter((r) => !r.ok);
  if (ok.length === 0) {
    return { status: 'error', reason: rcProblem(failed[0] && failed[0].err), checked: 0, failed: failed.length };
  }
  return { status: 'ok', checked: ok.length, failed: failed.length, ...tallySubscribers(ok, { month, nowMs: Date.now() }) };
}

async function readRevenueCat(month, premiumIds) {
  const key = rcKey();
  if (!key) {
    return { status: 'not_connected', reason: 'REVENUECAT_SECRET_API_KEY is not set on the server, so nothing here can read RevenueCat.' };
  }
  const [overview, subscribers] = await Promise.all([
    readRcOverview(key, month).catch((err) => ({ status: 'error', reason: rcProblem(err) })),
    readRcSubscribers(key, premiumIds, month).catch((err) => ({ status: 'error', reason: rcProblem(err) })),
  ]);
  return {
    status: overview.status === 'ok' || subscribers.status === 'ok' ? 'ok' : 'error',
    reason: overview.status === 'ok' || subscribers.status === 'ok' ? null : (subscribers.reason || overview.reason),
    asOf: new Date().toISOString(),
    overview,
    subscribers,
  };
}

// ---------------------------------------------------------------------------
// PRICING: what Stripe and RevenueCat will charge, beside what the code says
// ---------------------------------------------------------------------------

const money = (cents, currency = 'USD') => {
  if (!Number.isFinite(cents)) return 'no amount';
  const dollars = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${dollars}` : `${dollars} ${currency}`;
};

const PER = { month: 'a month', year: 'a year', week: 'a week', day: 'a day' };
const planWords = (plan) => (plan === 'founding' ? 'founding monthly' : plan);

function buildPricing({ stripe, revenuecat, venuePriceUsd }) {
  const stripeOk = stripe && stripe.status === 'ok' && stripe.prices && stripe.prices.status === 'ok';
  const envByRole = new Map();
  if (stripeOk) for (const e of stripe.prices.envs) envByRole.set(`${e.product}/${e.plan}`, e);

  const stated = STATED_PRICES.map((s) => {
    const usd = s.runtime === 'VENUE_PRICE_USD' && Number.isFinite(venuePriceUsd) ? venuePriceUsd : s.usd;
    const statedCents = Math.round(usd * 100);
    const label = PRODUCT_LABEL[s.product] || s.product;
    const base = {
      id: s.id, product: s.product, productLabel: label, plan: s.plan, statedCents, file: s.file, what: s.what, kind: s.kind,
    };
    const envName = PRICE_ENV[s.product] && PRICE_ENV[s.product][s.plan];
    if (!envName) {
      return { ...base, verdict: 'unsold', words: `${s.file} states ${money(statedCents)} ${PER[PLAN_INTERVAL[s.plan]] || ''} for ${label}, and nothing in Stripe sells it.` };
    }
    if (!stripe || stripe.status !== 'ok') {
      return { ...base, verdict: 'unchecked', words: 'Stripe is not connected, so this price cannot be checked.' };
    }
    if (!stripeOk) {
      return { ...base, verdict: 'unchecked', words: `Stripe's prices could not be read: ${stripe.prices ? stripe.prices.reason : 'no answer'}` };
    }
    const e = envByRole.get(`${s.product}/${s.plan}`);
    if (!e || !e.set) {
      return { ...base, verdict: 'unset', env: envName, words: `${envName} is not set, so there is no Stripe price to compare with the ${money(statedCents)} in ${s.file}.` };
    }
    if (!e.found || !e.price) {
      return { ...base, verdict: 'missing', env: envName, words: `${envName} names ${e.id}. ${e.reason || 'Stripe has no price with that id.'}` };
    }
    const p = e.price;
    const want = PLAN_INTERVAL[s.plan];
    const problems = [];
    if (p.active === false) problems.push(`the price ${p.id} is archived in Stripe, so checkout cannot use it`);
    if (p.currency !== 'USD') problems.push(`Stripe charges in ${p.currency}`);
    if (p.interval !== want || (p.intervalCount && p.intervalCount !== 1)) {
      problems.push(`Stripe bills it every ${p.intervalCount && p.intervalCount !== 1 ? `${p.intervalCount} ` : ''}${p.interval || 'once'}, not every ${want}`);
    }
    if (p.unitAmountCents !== statedCents) {
      problems.push(`Stripe charges ${money(p.unitAmountCents, p.currency || 'USD')} and ${s.file} says ${money(statedCents)}`);
    }
    if (problems.length === 0) {
      return { ...base, verdict: 'match', env: envName, liveCents: p.unitAmountCents, priceId: p.id, words: `Matches Stripe (${envName}).` };
    }
    const sentence = problems.join('; ');
    return {
      ...base,
      verdict: 'mismatch',
      env: envName,
      liveCents: p.unitAmountCents,
      priceId: p.id,
      words: `${label} ${planWords(s.plan)}: ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`,
    };
  });

  // The code against itself: two places stating different amounts for the
  // same thing is a discrepancy whether or not Stripe can be read.
  const internal = [];
  const byRole = new Map();
  for (const s of stated) {
    const k = `${s.product}/${s.plan}`;
    if (!byRole.has(k)) byRole.set(k, []);
    byRole.get(k).push(s);
  }
  for (const [, group] of byRole) {
    const amounts = [...new Set(group.map((g) => g.statedCents))];
    if (amounts.length > 1) {
      internal.push({
        product: group[0].product,
        plan: group[0].plan,
        words: `The code disagrees with itself about ${group[0].productLabel} ${planWords(group[0].plan)}: ${group.map((g) => `${g.file} says ${money(g.statedCents)}`).join(', ')}.`,
      });
    }
  }

  // Live Stripe prices nothing in the app points at: a price a customer could
  // be on that no plan here knows about.
  const unreferenced = stripeOk
    ? stripe.prices.live.filter((p) => !p.env).map((p) => ({
      id: p.id,
      productName: p.productName,
      unitAmountCents: p.unitAmountCents,
      currency: p.currency,
      interval: p.interval,
      lookupKey: p.lookupKey,
    }))
    : [];

  // The App Store side. RevenueCat's API does not always carry Apple's list
  // price, so each line says where its number came from.
  const rcOk = revenuecat && revenuecat.status === 'ok';
  const products = rcOk && revenuecat.overview && Array.isArray(revenuecat.overview.products) ? revenuecat.overview.products : [];
  const charged = rcOk && revenuecat.subscribers && revenuecat.subscribers.status === 'ok'
    ? revenuecat.subscribers.appStorePrices || {} : {};
  const appStore = Object.entries(APP_STORE_PRODUCTS).map(([productId, meta]) => {
    const statedEntry = STATED_PRICES.find((s) => s.product === 'pro' && s.plan === meta.plan);
    const statedCents = statedEntry ? Math.round(statedEntry.usd * 100) : null;
    const product = products.find((p) => p.storeIdentifier === productId && (p.store === null || p.store === 'app_store')) || null;
    const listCents = product && Number.isFinite(product.indicativeCents) && product.indicativeCurrency === 'USD' ? product.indicativeCents : null;
    const chargedEntry = has(charged, productId) ? charged[productId] : null;
    const lastCharged = chargedEntry ? chargedEntry.amountCents : null;
    const liveAmounts = chargedEntry && Array.isArray(chargedEntry.distinctAmountsCents) ? chargedEntry.distinctAmountsCents : [];
    const seen = listCents !== null ? listCents : lastCharged;
    let verdict = 'unchecked';
    let words;
    if (!rcOk) {
      words = revenuecat && revenuecat.status === 'not_connected'
        ? 'RevenueCat is not connected, so the App Store price cannot be read here.'
        : 'RevenueCat could not be read, so the App Store price cannot be checked.';
    } else if (liveAmounts.length > 1) {
      verdict = 'mismatch';
      words = `Live App Store subscribers of ${productId} pay different full prices: ${liveAmounts.map((c) => money(c)).join(', ')}. The newest purchase charged ${money(lastCharged)}, and PAYWALL.md says ${money(statedCents)}.`;
    } else if (seen === null) {
      words = 'Apple sets this price in App Store Connect, RevenueCat reported none, and no live App Store purchase carries one yet.';
    } else if (seen === statedCents) {
      verdict = 'match';
      words = listCents !== null ? 'RevenueCat reports the same App Store price.' : 'The newest App Store purchase charged the same price.';
    } else {
      verdict = 'mismatch';
      words = listCents !== null
        ? `RevenueCat reports an App Store price of ${money(seen)} for ${productId}, and PAYWALL.md says ${money(statedCents)}.`
        : `The newest App Store purchase of ${productId} charged ${money(seen)}, and PAYWALL.md says ${money(statedCents)}.`;
    }
    return { productId, plan: meta.plan, statedCents, listCents, lastChargedCents: lastCharged, verdict, words };
  });

  // The offering the app sells from: each package should carry the App Store
  // product meant for it, at the length its name promises.
  let offering = { status: rcOk ? 'unchecked' : 'unavailable', identifier: null, findings: [] };
  const off = rcOk && revenuecat.overview ? revenuecat.overview.offering : null;
  if (off && off.status === 'ok') {
    const findings = [];
    for (const [productId, meta] of Object.entries(APP_STORE_PRODUCTS)) {
      const pkg = (off.packages || []).find((p) => p.lookupKey === meta.packageKey);
      if (!pkg) {
        findings.push({ ok: false, words: `The current offering has no ${meta.packageKey} package, so the paywall cannot show the ${meta.plan} plan.` });
        continue;
      }
      const hit = (pkg.products || []).find((p) => p.storeIdentifier === productId);
      if (!hit) {
        findings.push({ ok: false, words: `${meta.packageKey} does not carry ${productId}.` });
      } else if (hit.duration && hit.duration !== meta.duration) {
        findings.push({ ok: false, words: `${productId} in ${meta.packageKey} lasts ${hit.duration}, not ${meta.duration}.` });
      } else {
        findings.push({ ok: true, words: `${meta.packageKey} carries ${productId}.` });
      }
    }
    offering = { status: 'ok', identifier: off.identifier, findings };
  } else if (off && off.status === 'error') {
    offering = { status: 'error', identifier: null, findings: [], reason: off.reason };
  } else if (rcOk && revenuecat.overview && revenuecat.overview.status !== 'ok') {
    offering = { status: 'unavailable', identifier: null, findings: [], reason: revenuecat.overview.reason };
  }

  const mismatches = stated.filter((s) => s.verdict === 'mismatch' || s.verdict === 'missing').length
    + internal.length
    + appStore.filter((a) => a.verdict === 'mismatch').length
    + (offering.findings || []).filter((f) => !f.ok).length;

  return {
    stated,
    internal,
    unreferenced,
    appStore,
    offering,
    mismatches,
    paywallNote: 'The paywall reads its prices from the store at run time: from Stripe on the web, and from the App Store through RevenueCat in the iOS app. No Pro price is typed into it.',
  };
}

// ---------------------------------------------------------------------------
// HEALTH
// ---------------------------------------------------------------------------

async function readHealth(db = pool, now = new Date()) {
  let collector;
  try {
    const latest = await db.query(
      `SELECT collected_at FROM ml_training_data
        WHERE collection_mode = 'realtime'
        ORDER BY collected_at DESC
        LIMIT 1`
    );
    const window = await db.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(DISTINCT date_trunc('hour', collected_at))::int AS hours
         FROM ml_training_data
        WHERE collection_mode = 'realtime'
          AND collected_at > NOW() - INTERVAL '24 hours'`
    );
    const alert = await db.query(
      `SELECT MAX(sent_on)::text AS last FROM ops_alert_ledger WHERE alert_key = 'collection_heartbeat'`
    );
    const at = latest.rows[0] && latest.rows[0].collected_at ? new Date(latest.rows[0].collected_at) : null;
    const minutes = at ? Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000)) : null;
    const state = minutes === null
      ? 'stopped'
      : minutes <= COLLECTOR_LATE_MINUTES ? 'fresh' : minutes <= COLLECTOR_STOPPED_HOURS * 60 ? 'late' : 'stopped';
    collector = {
      status: 'ok',
      state,
      latestAt: at ? at.toISOString() : null,
      minutesSinceLatest: minutes,
      rows24h: Number(window.rows[0] && window.rows[0].n) || 0,
      hours24h: Number(window.rows[0] && window.rows[0].hours) || 0,
      lastAlertOn: alert.rows[0] && alert.rows[0].last ? String(alert.rows[0].last).slice(0, 10) : null,
      lateAfterMinutes: COLLECTOR_LATE_MINUTES,
    };
  } catch (err) {
    collector = { status: 'error', reason: 'The collector tables could not be read.' };
    console.error('[money] collector read failed:', err && err.message ? err.message : err);
  }
  return {
    collector,
    // Nothing in this database records a backup or a restore point. Saying so
    // is the whole block: a status here would be invented.
    backups: { recorded: false },
  };
}

// ---------------------------------------------------------------------------
// CROWD DATA: what BestTime's key endpoint says, and the plan the code records
// ---------------------------------------------------------------------------
//
// services/besttimeAccount.js makes the one read-only request, the same one
// scripts/ml/besttimeAccountStatus.js makes, and screens BestTime's answer for
// the two keys it echoes. What this adds is the block: not_connected when
// BESTTIME_API_KEY is unset (nothing is asked), error with a reason in our own
// words when BestTime did not answer usefully, and ok with the key's health,
// the two undocumented counters under BestTime's own names, and any other plan
// or quota field it reported. Never the key, and never BestTime's text about a
// failure: the reason is built from the HTTP status or the error code alone.
//
// The endpoint reports no plan, no admission count and no cycle date, so the
// plan terms beside it come from the code (statedBestTimePlan) and are labelled
// as stated. The admissions used, and so the admissions left, are not shown as
// numbers at all: nothing here can read them, and the besttime.app dashboard
// can. The collector's own rows are the Health block's read, which the screen
// shows beside this one rather than this block reading them a second time.

const BESTTIME_TIMEOUT_MS = 10000;
const BESTTIME_REPORTED_MAX = 20;
const BESTTIME_NAME_MAX = 60;
const BESTTIME_VALUE_MAX = 80;

// A failure in our words. BestTime's body is never read on a failure, so none
// of its text can reach the screen, and a network error is named by its code.
function besttimeProblem(answer) {
  if (answer.kind === 'network') {
    return answer.code === 'TimeoutError' || answer.code === 'AbortError'
      ? 'BestTime did not answer in time.'
      : `The request to BestTime failed (${answer.code}).`;
  }
  if (answer.kind === 'http') {
    const s = answer.httpStatus;
    if (s === 401) return 'BestTime refused the key (401). BESTTIME_API_KEY needs checking.';
    if (s === 403) return 'BestTime refused the key (403): a rejected key or account, or its guard after a burst of calls.';
    if (s === 429) return 'BestTime is rate limiting this key (429).';
    if (Number.isInteger(s) && s >= 500) return `BestTime answered ${s}, a fault on its side.`;
    return Number.isInteger(s) ? `BestTime answered ${s}.` : 'BestTime answered with an error.';
  }
  if (answer.kind === 'not_json') return 'BestTime answered, but not with the JSON its key endpoint sends.';
  return 'The BestTime read failed.';
}

async function readBestTime() {
  const key = besttime.configuredKey();
  if (!key) {
    return { status: 'not_connected', reason: 'BESTTIME_API_KEY is not set on the server, so nothing here can read BestTime.' };
  }
  const answer = await besttime.fetchKeyStatus(key, { timeoutMs: BESTTIME_TIMEOUT_MS });
  if (!answer.ok) return { status: 'error', reason: besttimeProblem(answer) };
  const s = besttime.readKeyStatus(answer.body, { secrets: [key] });
  return {
    status: 'ok',
    asOf: new Date().toISOString(),
    key: { healthy: s.healthy, status: s.status, valid: s.valid, active: s.active },
    counters: { creditsForecast: s.creditsForecast, creditsQuery: s.creditsQuery },
    // Already screened for key material in full; cut to size only afterwards,
    // so a cut can never split a key past the screen.
    reported: s.reported.slice(0, BESTTIME_REPORTED_MAX).map((f) => (f.withheld
      ? { name: f.name.slice(0, BESTTIME_NAME_MAX), withheld: true }
      : {
        name: f.name.slice(0, BESTTIME_NAME_MAX),
        value: typeof f.value === 'string' ? f.value.slice(0, BESTTIME_VALUE_MAX) : f.value,
      })),
  };
}

// The plan as the code records it, for the rows the endpoint cannot fill. The
// name and price are costModel.js's own line, the allowance and cycle are
// services/besttimeAccount.js STATED_PLAN, and the dates are worked out from
// the calendar month the allowance runs on, the rule the command-line check
// prints too. None of it is read from BestTime, and the payload says where
// each part came from.
function statedBestTimePlan(now = new Date()) {
  const terms = besttime.STATED_PLAN;
  const line = costModel.FIXED_MONTHLY.find((e) => e.id === terms.costLineId) || null;
  const label = line && typeof line.label === 'string' ? line.label : null;
  return {
    label,
    name: label ? label.replace(/^BestTime(\.app)?\s+/i, '') : null,
    usdPerMonth: line && Number.isFinite(line.usd) ? line.usd : null,
    checked: line && line.checked ? line.checked : null,
    newVenuesPerMonth: terms.newVenuesPerMonth,
    cycle: terms.cycle,
    cycleEndsOn: besttime.calendarMonthEnd(now),
    resetsOn: besttime.nextCalendarMonthStart(now),
    source: 'backend/services/costModel.js',
  };
}

// ---------------------------------------------------------------------------
// THE MODEL: which one is serving, and how its served forecasts are doing
// ---------------------------------------------------------------------------
//
// THE METRIC. The share of served forecasts within one crowd band of what was
// then observed, scored the way scripts/ml/MODEL-METRICS.md scores its band
// table: a score lands in the band crowdEngine.getLabel prints for it (Quiet,
// Not Busy, Steady, Busy, Packed), and a forecast counts when its band is the
// observed band or the one next to it (band_off_by_one in
// train/eval_two_head.py). The goal is 85% of them. That is NOT the blended
// 85% training figure MODEL-METRICS.md section 2 retires, which mostly scores
// weekly rows whose label equals the baseline by construction; nothing here
// reads that figure.
//
// WHAT COUNTS. A served_predictions row the model produced (prediction_method
// 'ml'), from the venue card or the vote list, paired with the collector's
// live reading (ml_training_data, realtime, label_source 'live') of the same
// venue at the same venue-local weekday and hour, taken within
// MODEL_PAIR_WINDOW_HOURS of the serve. The same weekday and hour recur only a
// week apart, so inside that window the reading can only be that hour on that
// day. That keeps a vote-list serve honest too: its clock came from the caller
// (migration 038). A clock off by more than the window names an hour whose
// reading is not inside it, so the serve pairs with nothing; one off by less
// names the hour the forecast was actually scored for, and meets that hour's
// reading, which is still a forecast checked against its own hour. Its venue
// facts came from the caller as well; a caller who skews their own serves can
// only move this figure, which is an operator's read and feeds no
// calibration. ONE PAIR PER VENUE AND HOUR: the vote list records a serve on
// every scroll, and forty serves of one venue-hour are one forecast checked
// once, not forty. The newest serve in the hour stands for it.
//
// THE MINIMUM. Below MODEL_MIN_SAMPLE venue-hours, or across fewer than
// MODEL_MIN_DAYS days, the share is withheld, count and all, and the screen
// says there are not enough observations yet. They are the floors the offline
// evaluation keeps (train/quick_eval.py): fewer than 100 rows is too few to be
// meaningful, and fewer than five days is too few date blocks for an interval
// anyone should trust, because one night's weather or event moves every
// reading taken that night.
//
// WHY HELD FOR AN HOUR RATHER THAN PRECOMPUTED. The join reads a month of
// serves against the live readings, more than a dashboard should run on every
// load, and the readings it needs land once an hour, from the collector on the
// Railway BESTTIME service at :07. That collector is the existing hourly job,
// and it is a separate service with its own deploys; the in-process heartbeat
// (services/collectionHeartbeat.js) watches the rows, not the model. Either
// would have to write the figure somewhere this process reads, so an hour's
// hold in the hub's own cache gives the same freshness with no new table and
// costs a query only when somebody opens the Overview.

const MODEL_TTL_MS = 60 * 60 * 1000;
const MODEL_WINDOW_DAYS = 30;
const MODEL_PAIR_WINDOW_HOURS = 3;
const MODEL_MIN_SAMPLE = 100;
const MODEL_MIN_DAYS = 5;
const MODEL_GOAL_PCT = 85;
const MODEL_META_PATH = path.join(__dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json');

// The band ladder, read off crowdEngine.getLabel rather than restated, so a
// re-cut of the ladder (the last was 2026-08-28) moves this metric with it. A
// cut is the last score of a band, and a score's band is how many cuts it
// exceeds, exactly as band_of in train/eval_two_head.py counts it. Scores are
// whole numbers from 0 to 100 in both tables this is applied to.
function crowdBandLadder() {
  const { getLabel } = require('./crowdEngine');
  const cuts = [];
  const bands = [];
  for (let s = 0; s < 100; s += 1) {
    if (getLabel(s) !== getLabel(s + 1)) {
      cuts.push(s);
      bands.push({ label: getLabel(s), upTo: s });
    }
  }
  bands.push({ label: getLabel(100), upTo: null });
  return { cuts, bands };
}

// The ladder, or the reason there is none. A ladder with fewer than two cuts
// would score almost any forecast as near enough, so it is refused rather
// than trusted.
function safeLadder() {
  try {
    const ladder = crowdBandLadder();
    if (ladder.cuts.length < 2) {
      return { ok: false, cuts: [], bands: [], reason: 'The crowd band ladder has fewer than three bands, so a forecast cannot be scored against it.' };
    }
    return { ok: true, ...ladder };
  } catch (err) {
    console.error('[money] crowd band ladder unavailable:', err && err.message ? err.message : err);
    return { ok: false, cuts: [], bands: [], reason: 'The crowd band ladder could not be read, so no forecast was scored.' };
  }
}

// $1 the window in days, $2 the ladder's cuts, $3 the pairing window in hours.
// Postgres pairs and counts; four counts and the model versions seen are all
// that leave the database.
const SERVED_BAND_ACCURACY_SQL = `WITH served AS MATERIALIZED (
       SELECT sp.id, sp.venue_place_id, sp.score, sp.model_version,
              sp.local_day, sp.local_hour, sp.served_at
         FROM served_predictions sp
        WHERE sp.served_at >= NOW() - make_interval(days => $1::int)
          AND sp.prediction_method = 'ml'
          AND sp.local_day IS NOT NULL
          AND sp.local_hour IS NOT NULL
     ),
     paired AS (
       SELECT DISTINCT ON (t.venue_id, t.observed_date, t.hour)
              s.score AS served_score,
              t.busyness_pct AS observed,
              t.observed_date,
              s.model_version
         FROM served s
         JOIN ml_venues v ON v.google_place_id = s.venue_place_id
         JOIN ml_training_data t
           ON t.venue_id = v.id
          AND t.collection_mode = 'realtime'
          AND t.label_source = 'live'
          AND t.observed_date IS NOT NULL
          AND t.day_of_week = s.local_day
          AND t.hour = s.local_hour
          AND t.observed_date BETWEEN (s.served_at AT TIME ZONE 'UTC')::date - 1
                                  AND (s.served_at AT TIME ZONE 'UTC')::date + 1
          AND t.collected_at BETWEEN s.served_at - make_interval(hours => $3::int)
                                 AND s.served_at + make_interval(hours => $3::int)
        ORDER BY t.venue_id, t.observed_date, t.hour, s.served_at DESC, s.id DESC
     )
     SELECT (SELECT COUNT(*) FROM served)::int AS served,
            COUNT(*)::int AS matched,
            COUNT(DISTINCT p.observed_date)::int AS days,
            COUNT(*) FILTER (WHERE abs(b.served_band - b.observed_band) <= 1)::int AS within_one_band,
            COALESCE(array_remove(array_agg(DISTINCT p.model_version), NULL), '{}'::text[]) AS versions
       FROM paired p
      CROSS JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE p.served_score > c.cut)::int AS served_band,
               COUNT(*) FILTER (WHERE p.observed > c.cut)::int AS observed_band
          FROM unnest($2::int[]) AS c(cut)
      ) b`;

async function readServedBandAccuracy(db = pool, { windowDays = MODEL_WINDOW_DAYS, cuts } = {}) {
  let row;
  try {
    const r = await db.query(SERVED_BAND_ACCURACY_SQL, [windowDays, cuts, MODEL_PAIR_WINDOW_HOURS]);
    row = (r && r.rows && r.rows[0]) || {};
  } catch (err) {
    console.error('[money] served forecast check failed:', err && err.message ? err.message : err);
    return { status: 'error', reason: 'The database did not finish the check of served forecasts against the collector\'s readings, so there is no figure to show.' };
  }
  const count = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  const matched = count(row.matched);
  const days = count(row.days);
  const within = Math.min(count(row.within_one_band), matched);
  const enough = matched >= MODEL_MIN_SAMPLE && days >= MODEL_MIN_DAYS;
  return {
    status: 'ok',
    asOf: new Date().toISOString(),
    windowDays,
    served: count(row.served),
    matched,
    days,
    enough,
    minSample: MODEL_MIN_SAMPLE,
    minDays: MODEL_MIN_DAYS,
    // Withheld below the minimum, the count as well as the share, so nothing
    // downstream can print the noisy percentage the floor exists to stop.
    withinOneBand: enough ? within : null,
    percent: enough ? Math.round((within / matched) * 1000) / 10 : null,
    versions: Array.isArray(row.versions)
      ? row.versions.filter((v) => typeof v === 'string' && v).slice(0, 5).map((v) => v.slice(0, 60))
      : [],
  };
}

// The version serving now. The predictor's own loaded metadata when it has
// loaded a model (mlPredictor.predictionCoverage, the read the Costs tab uses);
// otherwise the artifact the server would load, model_metadata.json on disk,
// labelled as not loaded. Read on every build, not held: it is one in-memory
// read, and a hold would keep saying "not loaded" for an hour after the model
// warmed up.
async function readModelVersion({ predictor = null, metaPath = MODEL_META_PATH } = {}) {
  let coverage = null;
  try {
    const p = predictor || require('./mlPredictor');
    coverage = p && typeof p.predictionCoverage === 'function' ? p.predictionCoverage() : null;
  } catch (err) {
    console.error('[money] model coverage read failed:', err && err.message ? err.message : err);
  }
  if (coverage && coverage.modelLoaded === true && typeof coverage.modelVersion === 'string' && coverage.modelVersion.trim()) {
    return { status: 'ok', value: coverage.modelVersion.trim().slice(0, 60), source: 'loaded', loaded: true };
  }
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    const v = meta && typeof meta.model_version === 'string' && meta.model_version.trim()
      ? meta.model_version.trim().slice(0, 60) : null;
    if (!v) {
      return { status: 'error', value: null, source: 'artifact', loaded: false, reason: 'No model is loaded, and model_metadata.json names no version.' };
    }
    return { status: 'ok', value: v, source: 'artifact', loaded: false };
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return {
      status: 'error',
      value: null,
      source: 'artifact',
      loaded: false,
      reason: missing
        ? 'No model is loaded, and this server has no model_metadata.json to read a version from.'
        : 'No model is loaded, and model_metadata.json could not be read.',
    };
  }
}

function buildModelBlock({ version, accuracy, ladder }) {
  const measured = !!accuracy && accuracy.status === 'ok' && accuracy.enough === true && Number.isFinite(accuracy.percent);
  return {
    version,
    accuracy,
    goal: { percent: MODEL_GOAL_PCT, metric: 'within_one_band' },
    // Points short of the goal; zero or less means the goal is met. Only ever
    // from a measured share, never from a withheld one.
    gapPoints: measured ? Math.round((MODEL_GOAL_PCT - accuracy.percent) * 10) / 10 : null,
    bands: ladder.bands,
    cache: { ttlSeconds: MODEL_TTL_MS / 1000 },
  };
}

// ---------------------------------------------------------------------------
// NET AND BREAK-EVEN
// ---------------------------------------------------------------------------

// WHY A FIGURE IS MISSING, in codes the screen turns into words:
//   stripe             Stripe was not read: no key, or it did not answer
//   stripe_partial     Stripe answered with more entries than the hub pages
//                      through, and a missing page can move a total either way
//   app_store          RevenueCat was not read
//   app_store_partial  RevenueCat answered for some Pro accounts and not for
//                      others, or there were more Pro accounts than it is asked
//                      about
//   stripe_unpriced    a live Stripe subscription has a price or a discount the
//                      read could not work out, or bills in another currency,
//                      so recurring revenue would be short by what it pays
//   app_store_unpriced a live App Store subscription carries no dollar price
//                      in RevenueCat: recurring revenue waits for it, and so
//                      does this month's App Store part when it was charged
//                      this month
//   expenses           the expense list could not be read
// A figure with a source missing is null, never a smaller number that looks
// whole. The one exception is revenueThisMonthCents, which carries Stripe alone
// when only the App Store is missing, because the screen says so beside it.
// A subscription nobody could price was the same kind of hole: it was tallied
// as a count and left out of every sum, and nothing said a total was short.
//
// WHERE THE APP STORE FIGURES COME FROM (appStoreFrom). They are read from each
// account that is Pro in this database now (readRcSubscribers), the only read
// that splits RevenueCat's record by store. An account that paid through Apple
// this month and has since been deleted, or whose Pro has since ended, is not
// in them, and with no Pro account left the read asks nothing and the App
// Store part is zero. RevenueCat's project revenue (overview.monthRevenueUsd)
// does count them, but it is every store at once, web sales included, and
// those are already in the Stripe half, so it cannot stand in for the App
// Store part without counting the web twice. The screen shows it apart as a
// cross-check, and labels the App Store part as what it is wherever it adds it
// in: current Pro accounts only, never the month's complete App Store revenue.
function buildNet({ stripe, revenuecat, costs, costsComplete = true, appStoreComplete = null, pricing }) {
  const stripeOk = stripe && stripe.status === 'ok';
  const balance = stripeOk && stripe.balance && stripe.balance.status === 'ok' ? stripe.balance : null;
  const subs = stripeOk && stripe.subscriptions && stripe.subscriptions.status === 'ok' ? stripe.subscriptions : null;
  const rcSubs = revenuecat && revenuecat.status === 'ok' && revenuecat.subscribers && revenuecat.subscribers.status === 'ok'
    ? revenuecat.subscribers : null;
  const appComplete = rcSubs !== null
    && (appStoreComplete === null ? !(rcSubs.failed > 0) : appStoreComplete === true);
  const appStore = rcSubs && rcSubs.stores ? rcSubs.stores.app_store || null : null;
  const keep = (1 - APPLE_COMMISSION_PCT / 100);

  const balanceGap = !balance ? 'stripe' : (balance.truncated ? 'stripe_partial' : null);
  const subsGap = !subs ? 'stripe' : (subs.truncated ? 'stripe_partial' : null);
  const appGap = rcSubs === null ? 'app_store' : (appComplete ? null : 'app_store_partial');
  const costGap = costsComplete ? null : 'expenses';
  const gaps = (...list) => [...new Set(list.filter(Boolean))];

  // Unpriced subscriptions are missing data, not subscriptions paying zero.
  // The App Store's own gap, where it has one, already covers them.
  const stripeUnpriced = subs ? (subs.pro.notPriced || 0) + (subs.roost.notPriced || 0) + (subs.other.notPriced || 0) : 0;
  const subsPriceGap = stripeUnpriced > 0 ? 'stripe_unpriced' : null;
  const appRevenueGap = appGap || (appStore && appStore.unpricedThisMonth > 0 ? 'app_store_unpriced' : null);
  const appRecurringGap = appGap || (appStore && appStore.unpriced > 0 ? 'app_store_unpriced' : null);

  const stripeNetCents = balanceGap ? null : balance.netCents;
  const appStoreNetCents = appRevenueGap ? null : Math.round((appStore ? appStore.monthChargedCents : 0) * keep);
  const revenueCents = stripeNetCents === null ? null : stripeNetCents + (appStoreNetCents || 0);
  const missing = gaps(balanceGap, appRevenueGap);

  const costsThisMonthCents = costGap ? null : costs.totals.thisMonthCents;
  const burnCents = costGap ? null : costs.totals.perMonthCents;

  const recurringMissing = gaps(subsGap, subsPriceGap, appRecurringGap);
  const recurringCents = recurringMissing.length > 0
    ? null
    : subs.pro.mrrNetCents + subs.roost.mrrNetCents + subs.other.mrrNetCents
      + Math.round((appStore ? appStore.mrrCents : 0) * keep);

  // The price a break-even is worked from: Stripe's, when Stripe answered,
  // otherwise the price the code states, and the payload says which.
  const priceFor = (product, plan) => {
    const live = (pricing.stated || []).find((s) => s.product === product && s.plan === plan && Number.isFinite(s.liveCents));
    if (live) return { cents: live.liveCents, source: 'stripe' };
    const stated = STATED_PRICES.find((s) => s.product === product && s.plan === plan);
    return stated ? { cents: Math.round(stated.usd * 100), source: 'stated' } : null;
  };
  // No burn, no break-even: a count worked from a partial burn would be a
  // smaller number that looks whole.
  const need = (netPerUnit) => (burnCents !== null && netPerUnit > 0 ? Math.ceil(burnCents / netPerUnit) : null);
  const proPrice = priceFor('pro', 'monthly');
  const roostPrice = priceFor('roost', 'monthly');
  const proWebNet = proPrice ? stripeNetMonthlyCents(proPrice.cents, { interval: 'month', interval_count: 1 }) : null;
  const proAppNet = proPrice ? proPrice.cents * keep : null;
  const roostNet = roostPrice ? stripeNetMonthlyCents(roostPrice.cents, { interval: 'month', interval_count: 1 }) : null;

  // Paying Pro subscribers live in two stores, so the count needs both.
  const payingProMissing = gaps(subsGap, appGap);
  const payingRoostMissing = gaps(subsGap);

  return {
    revenueThisMonthCents: revenueCents,
    revenueParts: { stripeNetCents, appStoreNetCents },
    revenueMissing: missing,
    // See WHERE THE APP STORE FIGURES COME FROM above.
    appStoreFrom: 'current_pro_accounts',
    costsThisMonthCents,
    costsMissing: gaps(costGap),
    netThisMonthCents: revenueCents === null || costsThisMonthCents === null ? null : revenueCents - costsThisMonthCents,
    netMissing: gaps(...missing, costGap),
    burnCents,
    recurringNetCents: recurringCents,
    recurringMissing,
    netBurnCents: recurringCents === null || burnCents === null ? null : burnCents - recurringCents,
    netBurnMissing: gaps(...recurringMissing, costGap),
    appleCommissionPct: APPLE_COMMISSION_PCT,
    breakEven: {
      proWeb: proPrice ? { priceCents: proPrice.cents, source: proPrice.source, netPerUnitCents: Math.round(proWebNet), needed: need(proWebNet) } : null,
      proAppStore: proPrice ? { priceCents: proPrice.cents, source: proPrice.source, netPerUnitCents: Math.round(proAppNet), needed: need(proAppNet) } : null,
      roost: roostPrice ? { priceCents: roostPrice.cents, source: roostPrice.source, netPerUnitCents: Math.round(roostNet), needed: need(roostNet) } : null,
      burnMissing: gaps(costGap),
      payingPro: payingProMissing.length > 0 ? null : subs.pro.live - subs.pro.freeViaCode + (appStore ? appStore.live : 0),
      payingProMissing,
      payingRoost: payingRoostMissing.length > 0 ? null : subs.roost.live - subs.roost.freeViaCode,
      payingRoostMissing,
    },
  };
}

// ---------------------------------------------------------------------------
// THE HUB
// ---------------------------------------------------------------------------

// predictor and modelMetaPath are seams for the suite: the route passes
// neither, so the live mlPredictor and the artifact on disk are what answer.
async function buildMoneyHub({
  db = pool, venuePriceUsd = null, force = false, now = new Date(), predictor = null, modelMetaPath = MODEL_META_PATH,
} = {}) {
  const today = ymdIn(HUB_TZ, now);
  const month = monthOf(today);

  const safe = async (fn, label) => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      console.error(`[money] ${label} read failed:`, err && err.message ? err.message : err);
      return { ok: false };
    }
  };

  const ladder = safeLadder();

  const [expensesR, reconciled, premiumR, venuesR, photoR, health, besttimeRead, modelAccuracy, modelVersion] = await Promise.all([
    safe(() => readExpenses(db), 'expenses'),
    costModel.readReconciled(db),
    safe(async () => {
      const r = await db.query(
        `SELECT id FROM users WHERE is_premium = true ORDER BY id LIMIT ${RC_SUBSCRIBER_CAP + 1}`
      );
      const c = await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE is_premium = true`);
      return { ids: (r.rows || []).map((x) => Number(x.id)), total: Number(c.rows[0] && c.rows[0].n) || 0 };
    }, 'premium accounts'),
    safe(async () => {
      const r = await db.query(
        `SELECT COUNT(*)::int AS n FROM venue_subscriptions
          WHERE granted_reason = 'paid'
            AND status IN ('active', 'trialing', 'past_due')
            AND (expires_at IS NULL OR expires_at > NOW())`
      );
      return Number(r.rows[0] && r.rows[0].n) || 0;
    }, 'paying venues'),
    safe(() => require('./photoStore').photoSpendStatus(), 'photo ledger'),
    readHealth(db, now),
    // BestTime's answer names no customer, but its failure text could quote
    // the request, and the request carries the key: only the error's name is
    // ever logged for it.
    cachedRead(besttimeCacheKey(), () => readBestTime(), { force, logMessage: false }),
    ladder.ok
      ? cachedRead(
        modelAccuracyCacheKey(MODEL_WINDOW_DAYS, ladder.cuts),
        () => readServedBandAccuracy(db, { windowDays: MODEL_WINDOW_DAYS, cuts: ladder.cuts }),
        { force, ttlMs: MODEL_TTL_MS }
      )
      : Promise.resolve({ status: 'error', reason: ladder.reason }),
    readModelVersion({ predictor, metaPath: modelMetaPath }),
  ]);

  const premiumIds = premiumR.ok ? premiumR.value.ids.slice(0, RC_SUBSCRIBER_CAP) : [];
  // More Pro accounts than RevenueCat is asked about means the App Store tally
  // is a partial one, and nothing below may add it into a total as if whole.
  const premiumCapped = premiumR.ok && premiumR.value.ids.length > RC_SUBSCRIBER_CAP;
  const [stripeRaw, revenuecatRaw] = await Promise.all([
    cachedRead(stripeCacheKey(month), () => readStripe(month), { force }),
    premiumR.ok
      ? cachedRead(revenueCatCacheKey(month, premiumIds), () => readRevenueCat(month, premiumIds), { force })
      : Promise.resolve({ status: 'error', reason: 'The Pro accounts could not be read from the database, so RevenueCat was not asked.' }),
  ]);

  // Whether the App Store tally covers every Pro account: every read answered
  // and none was left off the list. A copy, so the cached answer is untouched.
  let revenuecat = revenuecatRaw;
  if (revenuecatRaw && revenuecatRaw.subscribers && revenuecatRaw.subscribers.status === 'ok') {
    const s = revenuecatRaw.subscribers;
    revenuecat = { ...revenuecatRaw, subscribers: { ...s, capped: premiumCapped, complete: !(s.failed > 0) && !premiumCapped } };
  }

  // The web subscribers' account ids stay on the server: only the overlap
  // with the database's Pro accounts goes out, as a count.
  const stripe = { ...stripeRaw };
  let webProInDatabase = null;
  if (stripe.subscriptions && stripe.subscriptions._webProAccounts) {
    const web = stripe.subscriptions._webProAccounts;
    if (premiumR.ok && premiumR.value.ids.length <= RC_SUBSCRIBER_CAP) {
      webProInDatabase = premiumR.value.ids.filter((id) => web.has(id)).length;
    }
    const subs = { ...stripe.subscriptions };
    delete subs._webProAccounts;
    stripe.subscriptions = subs;
  }

  const expenses = expensesR.ok ? expensesR.value : [];
  const costs = buildCostPicture({ expenses, reconciled, month });
  const pricing = buildPricing({ stripe, revenuecat, venuePriceUsd });
  // A list that could not be read leaves the Costs card showing what could be
  // read, labelled, and leaves every net figure null: a total missing the
  // tooling and company bills would read as the real one.
  const net = buildNet({
    stripe,
    revenuecat,
    costs,
    costsComplete: expensesR.ok,
    appStoreComplete: !!(revenuecat && revenuecat.subscribers && revenuecat.subscribers.complete === true),
    pricing,
  });
  const { boolFlag } = require('./entitlements');

  return {
    generatedAt: new Date().toISOString(),
    month: { label: month.label, startYmd: month.startYmd, todayYmd: month.todayYmd, daysInMonth: month.daysInMonth, dayOfMonth: month.dayOfMonth, tz: HUB_TZ },
    cache: { ttlSeconds: EXTERNAL_TTL_MS / 1000, minRefreshSeconds: MIN_FORCE_REFRESH_MS / 1000 },
    revenue: {
      stripe,
      revenuecat,
      database: {
        status: premiumR.ok ? 'ok' : 'error',
        proAccounts: premiumR.ok ? premiumR.value.total : null,
        proAccountsCheckedWithRevenueCat: premiumIds.length,
        proAccountsWithWebSubscription: webProInDatabase,
        payingVenues: venuesR.ok ? venuesR.value : null,
      },
      flags: {
        paywallEnabled: boolFlag('PAYWALL_ENABLED'),
        venueBillingEnabled: boolFlag('VENUE_BILLING_ENABLED'),
        proWebCheckoutEnabled: boolFlag('PRO_WEB_CHECKOUT_ENABLED'),
      },
    },
    costs: {
      status: expensesR.ok ? 'ok' : 'error',
      reason: expensesR.ok ? null : 'The expense list could not be read, so only the code lines and the reconciled invoice are counted.',
      ...costs,
      reconciledReadError: reconciled && reconciled.readError ? 'The saved invoice figure could not be read; the code figure stands in.' : null,
      googleMeteredThisMonth: photoR.ok && photoR.value ? {
        photosBought: Number.isFinite(photoR.value.monthUsed) ? photoR.value.monthUsed : null,
        photosUsd: Number.isFinite(photoR.value.monthUsd) ? photoR.value.monthUsd : null,
      } : null,
    },
    expenses: {
      status: expensesR.ok ? 'ok' : 'error',
      rows: expenses,
      limit: EXPENSE_LIST_LIMIT,
      kinds: EXPENSE_KINDS,
      cadences: EXPENSE_CADENCES,
      codeLines: codeLineOptions(),
    },
    net,
    pricing,
    // The collector's own rows are health.collector, which the screen shows
    // beside this block; they are not read a second time here.
    crowdData: {
      besttime: besttimeRead,
      plan: statedBestTimePlan(now),
    },
    model: buildModelBlock({ version: modelVersion, accuracy: modelAccuracy, ladder }),
    health,
  };
}

module.exports = {
  buildMoneyHub,
  buildCostPicture,
  buildPricing,
  buildNet,
  costsLedger,
  readExpenses,
  readHealth,
  readBestTime,
  statedBestTimePlan,
  readServedBandAccuracy,
  readModelVersion,
  crowdBandLadder,
  SERVED_BAND_ACCURACY_SQL,
  importExpenses,
  expenseFromRow,
  expenseRowFromInput,
  expenseParams,
  normalizeExpenseAliases,
  centsFromInput,
  codeLineIds,
  isYmd,
  monthOf,
  ymdIn,
  EXPENSE_KINDS,
  EXPENSE_CADENCES,
  EXPENSE_LIST_LIMIT,
  EXPENSE_INSERT_SQL,
  EXPENSE_UPDATE_SQL,
  HUB_TZ,
  __test: {
    resetCache: () => externalCache.clear(),
    summarizeSubscriptions,
    summarizeBalance,
    summarizeInvoices,
    subscriptionMonthly,
    tallySubscribers,
    nextChargeOn,
    addMonthsYmd,
    zonedMidnightMs,
    stripeNetMonthlyCents,
    readStripe,
    readRevenueCat,
    stripeCacheKey,
    revenueCatCacheKey,
    besttimeCacheKey,
    modelAccuracyCacheKey,
    cacheKeys: () => [...externalCache.keys()],
    // Ages every held answer by ms, as if that much time had passed, so the
    // suite can cross a hold without waiting it out.
    ageCache: (ms) => {
      for (const v of externalCache.values()) if (!v.pending) v.at -= ms;
    },
    EXTERNAL_TTL_MS,
    EXTERNAL_FAIL_TTL_MS,
    MIN_FORCE_REFRESH_MS,
    RC_SUBSCRIBER_CAP,
    BALANCE_MAX_PAGES,
    INVOICE_LOOKBACK_DAYS,
    DISPUTE_MAX_PAGES,
    MODEL_TTL_MS,
    MODEL_WINDOW_DAYS,
    MODEL_PAIR_WINDOW_HOURS,
    MODEL_MIN_SAMPLE,
    MODEL_MIN_DAYS,
    MODEL_GOAL_PCT,
    MODEL_META_PATH,
  },
};
