'use strict';
// ---------------------------------------------------------------------------
// THE OWNER'S MONEY HUB: every dollar in and out, read where it actually is.
//
// GET /api/admin/money (routes/admin.js) is the only caller. It answers nine
// questions on one screen, each from the system that holds the answer:
//
//   revenue  Stripe for everything sold on flockcorp.com (Flock Pro on the web
//            and Roost), RevenueCat for the App Store. Subscriptions by plan,
//            trials, recurring revenue, what was collected this month, refunds,
//            disputes, Stripe's fees and promotion code redemptions.
//   costs    the infrastructure lines in services/costModel.js, the reconciled
//            Google Cloud and Railway bills in cost_reconciled (059), and
//            every row of the expense list in business_expenses (080),
//            without counting a bill twice.
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
//   people   signups by day, how many new accounts start or join a plan in
//            their first week, how many people used Flock this week, and
//            what happened to the plans they made (PEOPLE, below).
//   steps   what only the operator can do: a variable on the Railway
//            service, a key made in RevenueCat, an agreement with Apple.
//            Checked here where the server can see the answer, and marked
//            for the operator to check where it cannot (ONLY YOU CAN DO
//            THESE, below).
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
// one. The database reads (expenses, costs, health, people) are never cached: an edit
// shows on the next load. There are two exceptions. The model's served-forecast
// check, a month of serves joined to the collector's readings, is held for
// MODEL_TTL_MS (an hour), and so is the week's split of what answered each
// serve beside it: the readings the check scores against land once an hour, so
// the hold costs at most one collector run of freshness. THE MODEL section
// below says why it is held here rather than precomputed. And the one SELECT 1
// the steps block times is held like a vendor read, so reloading the page does
// not turn into a stream of pings against the database.
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
// The error-reporting step quotes the alert threshold, so it reads the numbers
// the alert uses rather than a copy of them.
const { SERVER_FAULT_ALERT_THRESHOLD, WINDOW_MS: FAULT_WINDOW_MS } = require('../utils/serverFault');
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
const APPLE_SMALL_BUSINESS_PCT = costModel.RATES.stores.appleSmallBusinessPct;

const EXPENSE_KINDS = ['infrastructure', 'tooling', 'legal', 'other'];
const EXPENSE_CADENCES = ['monthly', 'quarterly', 'yearly', 'usage', 'one_time'];
const EXPENSE_LIST_LIMIT = 500;
// A quarter ahead: a yearly bill shows up three months out, not two
// (2026-10-03, was 60).
const RENEWAL_WINDOW_DAYS = 90;
// The totals under the renewals list: what is due in the next week, month
// and quarter, in dollars.
const RENEWAL_BUCKETS_DAYS = [7, 30, 90];

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
  // Cloudflare is the registrar (RDAP, 2026-09-29); Porkbun stays for a row
  // typed before that was checked.
  domain: /flockcorp|porkbun|cloudflare|\bdomain\b/i,
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

// The database round trip takes no input: it times the pool this process
// already holds, and the host that pool dials is never part of a key.
function databaseRoundTripCacheKey() {
  return 'database:roundtrip';
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
// lines, and the reconciled bill lines. Read from costModel so a line
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
    // Migration 096. A credit is money back (a refund, a vendor credit): the
    // amount is stored positive like every other row and subtracted from
    // every total it lands in.
    isCredit: r.is_credit === true,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

async function readExpenses(db = pool) {
  const r = await db.query(
    `SELECT id, vendor, product, category, kind, amount_cents, currency, cadence,
            last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
            active, verified, note, replaces_line, is_credit, updated_at
       FROM business_expenses
      ORDER BY active DESC, kind, lower(vendor), id
      LIMIT ${EXPENSE_LIST_LIMIT + 1}`
  );
  // One row past the limit is read so a longer list is KNOWN to be longer.
  // The list shown stops at the limit, and `truncated` tells the hub its
  // totals would be missing bills (review 2026-10-03: 501 rows used to
  // total as 500 with nothing said).
  const all = (r.rows || []).map(expenseFromRow);
  const rows = all.slice(0, EXPENSE_LIST_LIMIT);
  Object.defineProperty(rows, 'truncated', { value: all.length > EXPENSE_LIST_LIMIT, enumerable: false });
  return rows;
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
  quarterly: 'quarterly', quarter: 'quarterly', qtr: 'quarterly', every_3_months: 'quarterly', every_three_months: 'quarterly',
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
  alias('is_credit', 'isCredit');
  alias('credit', 'isCredit');
  if (has(out, 'kind')) out.kind = foldWord(out.kind, KIND_WORDS);
  if (has(out, 'cadence')) out.cadence = foldWord(out.cadence, CADENCE_WORDS);
  if (typeof out.currency === 'string') out.currency = out.currency.trim().toUpperCase();
  for (const b of ['active', 'verified', 'isCredit']) {
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
    isCredit: raw.isCredit === true,
  };
}

function expenseParams(row) {
  return [
    row.vendor, row.product, row.category, row.kind, row.amountCents, row.currency,
    row.cadence, row.lastChargedOn, row.renewsOn, row.active, row.verified, row.note,
    row.replacesLine, row.isCredit === true,
  ];
}

const EXPENSE_INSERT_SQL = `INSERT INTO business_expenses
       (vendor, product, category, kind, amount_cents, currency, cadence,
        last_charged_on, renews_on, active, verified, note, replaces_line, is_credit,
        updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), $15)
     RETURNING id, vendor, product, category, kind, amount_cents, currency, cadence,
               last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
               active, verified, note, replaces_line, is_credit, updated_at`;

// A whole-row write by id. The admin PUT route and the import both use it, so
// an edit on the screen and a corrected paste store a bill the same way.
const EXPENSE_UPDATE_SQL = `UPDATE business_expenses
        SET vendor = $2, product = $3, category = $4, kind = $5, amount_cents = $6,
            currency = $7, cadence = $8, last_charged_on = $9, renews_on = $10,
            active = $11, verified = $12, note = $13, replaces_line = $14,
            is_credit = $15, updated_at = NOW(), updated_by = $16
      WHERE id = $1
      RETURNING id, vendor, product, category, kind, amount_cents, currency, cadence,
                last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
                active, verified, note, replaces_line, is_credit, updated_at`;

// The import's insert. The same vendor, product, cadence and charge-or-credit
// is the same bill, and migrations 080 and 096 make that a unique key
// (business_expenses_bill_key), so when a second import inserted the bill
// after this one looked for it, this insert waits for that one to commit and
// then does nothing, and the import reads the row again and merges into it
// instead of adding a copy.
const EXPENSE_IMPORT_INSERT_SQL = `INSERT INTO business_expenses
       (vendor, product, category, kind, amount_cents, currency, cadence,
        last_charged_on, renews_on, active, verified, note, replaces_line, is_credit,
        updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), $15)
     ON CONFLICT (lower(vendor), lower(COALESCE(product, '')), cadence, is_credit) DO NOTHING
     RETURNING id, vendor, product, category, kind, amount_cents, currency, cadence,
               last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
               active, verified, note, replaces_line, is_credit, updated_at`;

// The import's match: the same vendor, product and cadence, ignoring case, and
// the same side (a charge or a credit), is the same bill, so pasting the list
// again updates rather than doubles it, and a refund pasted beside the charge
// it refunds never overwrites that charge. Locked, because the merge below
// reads the row before it writes it.
const EXPENSE_MATCH_SQL = `SELECT id, vendor, product, category, kind, amount_cents, currency, cadence,
            last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
            active, verified, note, replaces_line, is_credit, updated_at
       FROM business_expenses
      WHERE lower(vendor) = lower($1)
        AND lower(COALESCE(product, '')) = lower(COALESCE($2, ''))
        AND cadence = $3
        AND is_credit = $4
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
    // Part of the key the row was matched on, like vendor and cadence, so it
    // is never changed by a merge.
    isCredit: stored.isCredit,
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
      const key = [row.vendor, row.product, row.cadence, row.isCredit];
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
//   * the reconciled bills (cost_reconciled over costModel.RECONCILED, today
//     Google Cloud and Railway): the same, each a usage bill read as this much
//     a month.
//   * expense rows: counted while active and in USD.
//
// Two figures come out of every line:
//   perMonth   the run rate. Monthly and usage bills in full, quarterly bills
//              at a third, yearly bills at a twelfth, one-time bills never.
//              The sum is the monthly burn.
//   thisMonth  what belongs to this calendar month: the run rate, plus any
//              one-time bill charged this month. Quarterly and yearly bills
//              are spread, so a renewal does not make one month look several
//              times worse; the renewal list below is where the cash dates are.
//
// A credit row (is_credit, migration 096) is the same arithmetic with the sign
// turned over: a quarterly credit takes a third of itself off the burn, a
// one-time refund dated this month comes off this month. Its kind and category
// totals fall by the same figures, so every table still adds up to the total.

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
    case 'quarterly':
      return amountCents / 3;
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
  const step = { monthly: 1, quarterly: 3, yearly: 12 }[x.cadence] || null;
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
    : costModel.RECONCILED.lines.map((l) => ({ ...l, source: 'code' }));
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

// WHAT EACH PLAN LEAVES, a month, after the fees (2026-10-03). Break-even
// works out the monthly plans only, to count subscribers; this is every plan,
// so a yearly plan's discount and the founding rate are on the page too. From
// the stated prices (which the Prices card checks against Stripe and the App
// Store), through the same Stripe fee arithmetic the break-even uses, and both
// of Apple's rates for the App Store, since nothing here can see which applies.
const PLAN_NET_SHAPES = [
  { product: 'pro', plan: 'monthly', recurring: { interval: 'month', interval_count: 1 }, appStore: true },
  { product: 'pro', plan: 'yearly', recurring: { interval: 'year', interval_count: 1 }, appStore: true },
  { product: 'roost', plan: 'monthly', recurring: { interval: 'month', interval_count: 1 }, appStore: false },
  { product: 'roost', plan: 'yearly', recurring: { interval: 'year', interval_count: 1 }, appStore: false },
  { product: 'roost', plan: 'founding', recurring: { interval: 'month', interval_count: 1 }, appStore: false },
];

// At the prices the hub reads, the way break-even takes them (review
// 2026-10-03: this used the stated prices while the Overview used Stripe's
// and the App Store's, so the two cards could disagree). The web price is
// Stripe's when it bills in dollars on that plan's period; the App Store's
// is what RevenueCat reports, then the newest charge; each falls back to the
// stated price and says so.
function buildPlanNets(pricing = {}) {
  const out = [];
  for (const shape of PLAN_NET_SHAPES) {
    const stated = STATED_PRICES.find((s) => s.product === shape.product && s.plan === shape.plan);
    // A live price of $0 is a price (break-even takes it), so only a missing
    // one falls back to the stated price.
    const live = (pricing.stated || []).find((s) => s.product === shape.product && s.plan === shape.plan
      && Number.isFinite(s.liveCents) && s.liveCents >= 0 && s.liveUsable === true);
    const webCents = live ? live.liveCents : (stated && stated.usd > 0 ? Math.round(stated.usd * 100) : null);
    if (webCents === null) continue;
    const months = monthsPerCharge(shape.recurring);
    const grossPerMonth = webCents / months;
    const webNet = stripeNetMonthlyCents(grossPerMonth, shape.recurring);
    let appStore = null;
    if (shape.appStore) {
      const row = (pricing.appStore || []).find((a) => a.plan === shape.plan);
      const appCents = row && row.listCents > 0 ? row.listCents
        : (row && row.lastChargedCents > 0 ? row.lastChargedCents : (stated && stated.usd > 0 ? Math.round(stated.usd * 100) : null));
      if (appCents) {
        const appPerMonth = appCents / months;
        appStore = {
          priceCents: appCents,
          source: row && row.listCents > 0 ? 'app_store' : (row && row.lastChargedCents > 0 ? 'app_store_charge' : 'stated'),
          standardPct: APPLE_COMMISSION_PCT,
          netPerMonthCents: Math.round(appPerMonth * (1 - APPLE_COMMISSION_PCT / 100)),
          smallBusinessPct: APPLE_SMALL_BUSINESS_PCT,
          netPerMonthSmallBusinessCents: Math.round(appPerMonth * (1 - APPLE_SMALL_BUSINESS_PCT / 100)),
        };
      }
    }
    out.push({
      product: shape.product,
      plan: shape.plan,
      priceCents: webCents,
      source: live ? 'stripe' : 'stated',
      interval: shape.recurring.interval,
      grossPerMonthCents: Math.round(grossPerMonth),
      // Fees as the difference of the two rounded figures, so the line reads
      // gross minus fees equals net to the cent.
      web: { netPerMonthCents: Math.round(webNet), feesPerMonthCents: Math.round(grossPerMonth) - Math.round(webNet) },
      appStore,
    });
  }
  return out;
}

// What the business costs per person using it and per plan made, from the
// burn and the last seven days. Withheld below the same floor every share on
// the hub uses, where one person more or less swings the figure by double
// digits, and withheld while the burn is incomplete.
function buildUnitCosts({ burnCents, people }) {
  if (!Number.isFinite(burnCents) || !people || people.status !== 'ok') {
    return { status: 'unavailable', reason: !Number.isFinite(burnCents) ? 'burn' : 'people' };
  }
  const active = people.active ? people.active.last7 : 0;
  const plans = people.plans ? people.plans.madeLast7 : 0;
  const plansPerMonth = plans * (30.4375 / 7);
  return {
    status: 'ok',
    minPeople: PEOPLE_MIN_FOR_SHARE,
    activeLast7: active,
    plansMadeLast7: plans,
    perActivePersonCents: active >= PEOPLE_MIN_FOR_SHARE ? Math.round(burnCents / active) : null,
    perPlanCents: plans >= PEOPLE_MIN_FOR_SHARE ? Math.round(burnCents / plansPerMonth) : null,
  };
}

// Rounds rows[i][field] to whole cents so they sum to `total` exactly:
// floor every row, then give the cents left over to the rows that lost the
// most to the floor. `total` is the rounded sum of the exact values.
function roundRowsToTotal(rows, field, total) {
  const floors = rows.map((r) => Math.floor(r[field]));
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = rows.map((r, i) => ({ i, rem: r[field] - floors[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; k < order.length && left > 0; k += 1, left -= 1) floors[order[k].i] += 1;
  rows.forEach((r, i) => { r[field] = floors[i] || 0; });
}

// BILLS THAT JUMPED (2026-10-03). A reconciled bill (Railway, Google Cloud)
// carries the bill before it from its receipt; one running more than a
// quarter above that is said out loud. Railway went from $24.52 to an
// estimated $44.97 and nothing on the hub said so.
const BILL_JUMP_PCT = 25;

function billJumps(reconciled) {
  const lines = reconciled && Array.isArray(reconciled.lines) ? reconciled.lines : costModel.RECONCILED.lines;
  const out = [];
  for (const l of lines) {
    const prev = l.previous;
    if (!prev || !(prev.usdPerMonth > 0) || !Number.isFinite(Number(l.usdPerMonth))) continue;
    const now = Number(l.usdPerMonth);
    // Compared unrounded and rounded only for the words: 25.49% read as 25
    // and stayed quiet (review 2026-10-03).
    const exactPct = ((now - prev.usdPerMonth) / prev.usdPerMonth) * 100;
    if (exactPct <= BILL_JUMP_PCT) continue;
    const pct = Math.round(exactPct);
    out.push({
      id: l.id,
      label: l.label,
      fromCents: Math.round(prev.usdPerMonth * 100),
      fromPeriod: prev.period || null,
      toCents: Math.round(now * 100),
      toAsOf: l.asOf || null,
      pct,
    });
  }
  return out;
}

// THE PRICE SHEET (2026-10-03): every bill and rate card Flock pays, in one
// list, each with the date it was last checked against its source, oldest
// first, so what needs a fresh look is at the top. The code's lines carry
// their own checked dates (costModel.js); a reconciled bill, the date it was
// read; a rate card, the date its pricing page was read; a bill on the
// expense list, its last charge when it is marked checked against a receipt,
// and no date when it is not.
const PRICE_SHEET_STALE_DAYS = 60;
const RATE_LABEL = {
  gemini: 'Google Gemini (Birdie)', places: 'Google Places', vision: 'Google Cloud Vision',
  weather: 'OpenWeatherMap', ticketmaster: 'Ticketmaster', resend: 'Resend (email)',
  maptiler: 'MapTiler', posthog: 'PostHog', sentry: 'Sentry', revenuecat: 'RevenueCat',
  stripe: 'Stripe fees', push: 'Firebase push', stores: 'App Store commission',
};

function daysBetweenYmd(a, b) {
  if (!isYmd(a) || !isYmd(b)) return null;
  return Math.round((Date.UTC(...b.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))
    - Date.UTC(...a.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))) / 86400000);
}

function buildPriceSheet({ expenses = [], reconciled = null, todayYmd }) {
  const rows = [];
  // A line an active dollar bill stands in for is not a price paid: the bill
  // is, and it is on the sheet in its place (the rule buildCostPicture uses).
  const replaced = new Set(expenses.filter((x) => x.active && x.currency === 'USD' && x.replacesLine && !x.isCredit).map((x) => x.replacesLine));
  const unitOf = { monthly: 'a month', yearly: 'a year', one_time: 'once', quarterly: 'a quarter', usage: 'a month, metered' };
  for (const [list, cadence] of [[costModel.FIXED_MONTHLY, 'monthly'], [costModel.FIXED_ANNUAL, 'yearly'], [costModel.ONE_TIME, 'one_time']]) {
    for (const e of list) {
      if (replaced.has(e.id)) continue;
      rows.push({ id: `code-${e.id}`, label: e.label, priceCents: Math.round(Number(e.usd) * 100), unit: unitOf[cadence], checkedOn: e.checked || null, source: e.source || null, from: 'code' });
    }
  }
  const recLines = reconciled && Array.isArray(reconciled.lines) ? reconciled.lines : costModel.RECONCILED.lines;
  for (const l of recLines) {
    if (replaced.has(l.id)) continue;
    rows.push({ id: `rec-${l.id}`, label: l.label, priceCents: Math.round(Number(l.usdPerMonth) * 100), unit: 'a month, from the bill', checkedOn: l.asOf || null, source: l.readFrom || null, from: 'reconciled' });
  }
  for (const [key, r] of Object.entries(costModel.RATES || {})) {
    rows.push({ id: `rate-${key}`, label: RATE_LABEL[key] || key, priceCents: null, unit: 'rate card', checkedOn: r.checked || null, source: r.source || null, from: 'rate' });
  }
  for (const x of expenses) {
    if (!x.active) continue;
    rows.push({
      id: `expense-${x.id}`,
      label: x.product ? `${x.vendor}, ${x.product}` : x.vendor,
      priceCents: x.currency === 'USD' ? (x.isCredit ? -1 : 1) * x.amountCents : null,
      // A bill in another currency keeps its own amount, shown as typed.
      amountCents: (x.isCredit ? -1 : 1) * x.amountCents,
      currency: x.currency,
      unit: unitOf[x.cadence] || x.cadence,
      checkedOn: x.verified && x.lastChargedOn ? x.lastChargedOn : null,
      source: x.verified ? 'a receipt' : null,
      from: 'expense',
    });
  }
  for (const r of rows) {
    r.ageDays = r.checkedOn ? daysBetweenYmd(r.checkedOn, todayYmd) : null;
    r.stale = r.ageDays === null || r.ageDays > PRICE_SHEET_STALE_DAYS;
  }
  // Never checked first, then the oldest check.
  rows.sort((a, b) => (a.checkedOn === null) - (b.checkedOn === null) === 0
    ? (a.checkedOn || '').localeCompare(b.checkedOn || '') || a.label.localeCompare(b.label)
    : (a.checkedOn === null ? -1 : 1));
  return { staleAfterDays: PRICE_SHEET_STALE_DAYS, rows, stale: rows.filter((r) => r.stale).length };
}

// THE EXPENSE LIST AS A SPREADSHEET, for an accountant or a tax return
// (2026-10-03). Every row, stopped ones included, since a stopped bill was
// still paid. Amounts in dollars with two decimals; dates as typed.
//
// Every cell is quoted, and a cell that a spreadsheet would read as a
// formula (one starting with =, +, -, @, a tab or a carriage return) gets a
// leading apostrophe, so a vendor name typed as "=HYPERLINK(...)" opens as
// text and never runs (CSV injection, OWASP).
const EXPENSE_CSV_COLUMNS = [
  ['Vendor', (x) => x.vendor],
  ['Product', (x) => x.product],
  ['Kind', (x) => KIND_LABEL[x.kind] || x.kind],
  ['Category', (x) => x.category],
  ['How often', (x) => x.cadence],
  // Made here from integer cents, never typed, so it is the one column the
  // formula guard leaves alone: a credit's -5.00 stays a number.
  ['Amount', (x) => (Number.isFinite(x.amountCents) ? ((x.isCredit ? -1 : 1) * x.amountCents / 100).toFixed(2) : ''), { number: true }],
  ['Currency', (x) => x.currency],
  ['Last charged', (x) => x.lastChargedOn],
  ['Renews', (x) => x.renewsOn],
  ['Still charged', (x) => (x.active ? 'yes' : 'no')],
  ['Checked against a receipt', (x) => (x.verified ? 'yes' : 'no')],
  ['Counts instead of', (x) => x.replacesLine],
  ['Note', (x) => x.note],
];

function csvCell(v, opts = {}) {
  let s = v === null || v === undefined ? '' : String(v);
  if (!opts.number && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function expensesCsv(rows) {
  const lines = [EXPENSE_CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
  for (const x of rows || []) lines.push(EXPENSE_CSV_COLUMNS.map(([, f, opts]) => csvCell(f(x), opts)).join(','));
  // CRLF, the line ending RFC 4180 names and Excel expects.
  return `${lines.join('\r\n')}\r\n`;
}

// What licensing every plan for commercial use would add (costModel
// LICENCE_EXPOSURES), with the exposures a recorded bill has already fixed
// left out. A code line is fixed when its own figure is above $0 or an active
// bill above $0 stands in for it; a vendor fix, when an active bill above $0
// names the vendor.
function licenceExposures({ lines, expenses, perMonthCents }) {
  const items = [];
  // A bill that fixes an exposure is one in the dollar run rate: active, in
  // dollars, recurring, above $0 and not a credit. A euro row, a one-time
  // charge or a stopped row is not a plan being paid for (review 2026-10-03).
  const paying = (x) => x.active && !x.isCredit && x.currency === 'USD' && x.amountCents > 0
    && ['monthly', 'quarterly', 'yearly', 'usage'].includes(x.cadence);
  const vendorIs = (x, needle) => String(x.vendor || '').toLowerCase().includes(String(needle).toLowerCase());
  for (const e of costModel.LICENCE_EXPOSURES || []) {
    const by = e.resolvedBy || {};
    let fixed = false;
    if (by.codeLine) {
      const line = lines.find((l) => l.origin !== 'expense' && l.id === by.codeLine);
      // The code line's own figure fixes it only while that figure is what
      // counts: a line a $0 or one-time row stands in for is out of the burn.
      fixed = !!(line && line.counted && line.amountCents > 0) || expenses.some((x) => paying(x) && x.replacesLine === by.codeLine);
    }
    // By the vendor's name as well: a Vercel Pro bill recorded without
    // "counts instead of" is already in the burn, and adding Vercel's $20 to
    // the licensed figure on top of it counted the plan twice.
    if (!fixed && by.expenseVendor) fixed = expenses.some((x) => paying(x) && vendorIs(x, by.expenseVendor));
    if (fixed) continue;
    items.push({
      id: e.id,
      vendor: e.vendor,
      plan: e.plan,
      why: e.why,
      fix: e.fix,
      fixCentsPerMonth: Math.round(Number(e.fixUsdPerMonth || 0) * 100),
      source: e.source,
      checked: e.checked,
    });
  }
  const toComplyCents = items.reduce((sum, i) => sum + i.fixCentsPerMonth, 0);
  return { items, toComplyPerMonthCents: toComplyCents, licensedPerMonthCents: perMonthCents + toComplyCents };
}

// What falls due in the next week, month and quarter, in dollars. Every
// charge inside each window counts, so a monthly bill is three charges in the
// next 90 days, not one. Dollars only: a euro bill has no dollar figure to
// add, and is named as left out (nonUsd) beside it.
function renewalTotals(expenses, todayYmd) {
  return RENEWAL_BUCKETS_DAYS.map((days) => {
    const until = addDaysYmd(todayYmd, days);
    let cents = 0;
    let charges = 0;
    const bills = new Set();
    for (const x of expenses) {
      if (!x.active || x.isCredit || x.currency !== 'USD') continue;
      const step = { monthly: 1, quarterly: 3, yearly: 12 }[x.cadence];
      if (!step) continue;
      // Stepped from the bill's own anchor, the way nextChargeOn steps:
      // stepping from a month-end date already clamped into a short month
      // (Mar 31 -> Apr 30) put every later charge on the 30th and counted
      // one too many in a window (review 2026-10-03).
      const anchor = x.renewsOn || x.lastChargedOn;
      if (!anchor) continue;
      // A renewal date is a charge still to come, so it counts itself; a last
      // charge date is one already paid, so counting starts a step after it
      // (review 2026-10-03: a bill charged today read as due this week).
      for (let k = x.renewsOn ? 0 : 1; k <= 240; k += 1) {
        const on = addMonthsYmd(anchor, k * step);
        if (on < todayYmd) continue;
        if (on > until) break;
        cents += x.amountCents;
        charges += 1;
        bills.add(x.id);
      }
    }
    return { days, cents, charges, bills: bills.size };
  });
}

function buildCostPicture({ expenses = [], reconciled = null, month }) {
  // Only a row that is itself counted may take a code line out of the total:
  // active, and in dollars. A euro bill linked to Railway would otherwise
  // remove the Railway figure and add nothing, since nothing here converts
  // currencies.
  // Nor may a credit: it has no code figure to stand in for (096 refuses the
  // pair in the table as well).
  const replacedBy = new Map();
  for (const x of expenses) {
    if (x.active && x.currency === 'USD' && x.replacesLine && !x.isCredit) {
      if (!replacedBy.has(x.replacesLine)) replacedBy.set(x.replacesLine, []);
      replacedBy.get(x.replacesLine).push(x.id);
    }
  }

  const lines = [];
  // Code lines whose month is already paid by a stopped row that replaced
  // them (see THIS MONTH IS WHAT WAS PAID below).
  const coveredThisMonth = new Set();
  // Code lines an active bill really pays for each month: dollars, not a
  // credit, above $0, recurring. Only such a row carries the month in place
  // of a stopped one; a $0 row or a one-time charge linked to the same line
  // left the stopped bill's real charge in neither figure (review 2026-10-03).
  const payingReplacers = new Set(expenses
    .filter((x) => x.active && x.currency === 'USD' && !x.isCredit && x.amountCents > 0
      && ['monthly', 'quarterly', 'yearly', 'usage'].includes(x.cadence) && x.replacesLine)
    .map((x) => x.replacesLine));
  for (const c of codeCostLines(reconciled)) {
    const by = replacedBy.get(c.id) || null;
    lines.push({ ...c, counted: !by, replacedBy: by });
  }
  for (const x of expenses) {
    const usd = x.currency === 'USD';
    // A bill marked stopped still cost money in the month it was last charged:
    // a $500 one-time bill paid on the 10th and then marked "no longer
    // charged" dropped out of this month's costs. It counts toward THIS month
    // when its last charge falls inside it, and toward the monthly run rate
    // only while it is active. A stopped row that had replaced a code line is
    // the exception: that code line is back in the totals and covers the month.
    // The exception holds only for a RECURRING code line: a one-time code line
    // carries no charge date and adds nothing to this month, so it covers none.
    //
    // THIS MONTH IS WHAT WAS PAID (review 2026-10-03). A stopped row that had
    // replaced a recurring code line used to drop out of this month and leave
    // the code line's figure in its place: a $149 BestTime bill paid on the
    // 1st and then stopped read as the code's $119. Now the row's own charge
    // counts this month, the code line adds nothing to this month, and the
    // code line still comes back for the run rate from here on.
    // Two limits (review 2026-10-03): a $0 stopped row pays for nothing, so
    // it covers nothing; and when an active row already stands in for the
    // same recurring line, that row carries this month, and the stopped one
    // adding its charge as well counted the line's month twice.
    const replaced = x.replacesLine ? lines.find((l) => l.origin !== 'expense' && l.id === x.replacesLine) : null;
    const superseded = !x.active && !!replaced && replaced.cadence !== 'one_time' && payingReplacers.has(x.replacesLine);
    const stoppedButPaidThisMonth = !x.active && inMonth(x.lastChargedOn, month) && !superseded;
    if (stoppedButPaidThisMonth && usd && !x.isCredit && x.amountCents > 0 && replaced && replaced.cadence !== 'one_time') {
      coveredThisMonth.add(replaced.id);
    }
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
      isCredit: x.isCredit === true,
      counted: usd && (x.active || stoppedButPaidThisMonth),
      recurring: usd && x.active,
      inactive: !x.active,
      nonUsd: !usd,
    });
  }

  for (const l of lines) {
    const sign = l.isCredit ? -1 : 1;
    const run = l.counted ? perMonthCents(l.cadence, l.amountCents) : 0;
    const once = l.counted && l.cadence === 'one_time' && inMonth(l.lastChargedOn, month) ? l.amountCents : 0;
    // The run rate is what keeps coming: a stopped expense row adds nothing
    // to it, only to the month it was paid in. Code lines always run.
    const forward = l.origin === 'expense' && !l.recurring ? 0 : run;
    const month0 = l.origin !== 'expense' && coveredThisMonth.has(l.id);
    // Rounded before the sign goes on, so a credit and a charge of the same
    // amount cancel to exactly zero (Math.round(-0.5) is 0, not -1).
    l.perMonthCents = sign * Math.round(forward) || 0;
    l.thisMonthCents = month0 ? 0 : (sign * Math.round(run + once) || 0);
    // The unrounded shares, which the totals sum and round once: twelve $100
    // yearly bills are $100.00 a month, not twelve roundings of $8.33.
    l.perMonthExact = sign * forward || 0;
    l.thisMonthExact = month0 ? 0 : (sign * (run + once) || 0);
  }

  const byKind = {};
  for (const k of EXPENSE_KINDS) byKind[k] = { kind: k, label: KIND_LABEL[k], thisMonthCents: 0, perMonthCents: 0, lines: 0 };
  const byCategory = new Map();
  let thisMonthCents = 0;
  let perMonthTotal = 0;
  for (const l of lines) {
    if (!l.counted) continue;
    const k = byKind[l.kind] || byKind.other;
    k.thisMonthCents += l.thisMonthExact;
    k.perMonthCents += l.perMonthExact;
    k.lines += 1;
    if (!byCategory.has(l.category)) byCategory.set(l.category, { category: l.category, thisMonthCents: 0, perMonthCents: 0, lines: 0 });
    const c = byCategory.get(l.category);
    c.thisMonthCents += l.thisMonthExact;
    c.perMonthCents += l.perMonthExact;
    c.lines += 1;
    thisMonthCents += l.thisMonthExact;
    perMonthTotal += l.perMonthExact;
  }
  const r0 = (v) => Math.round(v) || 0;
  thisMonthCents = r0(thisMonthCents);
  perMonthTotal = r0(perMonthTotal);
  // Each table's rows are rounded so they add up to the total they sit under
  // (largest remainder): rounded one by one, twelve $8.33 rows sat under a
  // $100.00 total.
  const kinds = Object.values(byKind);
  const cats = [...byCategory.values()];
  for (const [rows, field, total] of [
    [kinds, 'perMonthCents', perMonthTotal], [kinds, 'thisMonthCents', thisMonthCents],
    [cats, 'perMonthCents', perMonthTotal], [cats, 'thisMonthCents', thisMonthCents],
  ]) roundRowsToTotal(rows, field, total);
  for (const l of lines) { delete l.perMonthExact; delete l.thisMonthExact; }

  // Renewals in the window, from the expense list. Code lines carry no charge
  // dates, and the panel says so rather than guessing one. A credit is money
  // coming back, not a charge to plan for, so it is not listed.
  const horizon = addDaysYmd(month.todayYmd, RENEWAL_WINDOW_DAYS);
  const upcoming = [];
  for (const x of expenses) {
    if (!x.active || x.isCredit || !['monthly', 'quarterly', 'yearly'].includes(x.cadence)) continue;
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
  const countedExpenseIds = new Set(lines.filter((l) => l.origin === 'expense' && l.counted).map((l) => l.expenseId));
  const fits = (codeCadence, rowCadence) => codeCadence === rowCadence
    || (codeCadence === 'usage' && rowCadence === 'monthly')
    || (codeCadence === 'monthly' && rowCadence === 'usage');
  for (const c of lines) {
    if (c.origin === 'expense' || !c.counted || !has(CODE_LINE_LOOKALIKE, c.id)) continue;
    for (const x of expenses) {
      // Every row counted this month, a stopped one paid this month included.
      if (!countedExpenseIds.has(x.id)) continue;
      // Skipped only when it replaces THIS line. A row linked to the wrong
      // code line (a BestTime bill tied to the corpus line) left the real
      // BestTime line counted beside it with no warning.
      if (x.replacesLine === c.id || x.isCredit) continue;
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
    upcomingTotals: renewalTotals(expenses, month.todayYmd),
    possibleDoubles,
    replaced,
    nonUsd: lines.filter((l) => l.nonUsd && !l.inactive).map((l) => ({
      label: l.label,
      amountCents: l.amountCents,
      currency: l.currency,
      // Named so the screen can say the code line it points at still counts.
      replacesLine: l.replacesLine || null,
      isCredit: l.isCredit === true,
    })),
    undatedCodeYearly: lines.filter((l) => l.origin === 'code' && l.cadence === 'yearly' && l.counted).length,
    licence: licenceExposures({ lines, expenses, perMonthCents: perMonthTotal }),
    jumps: billJumps(reconciled),
  };
}

// What GET /api/admin/costs carries for the Costs tab: the same arithmetic,
// reduced to the figures that panel shows. One function, so the two tabs
// cannot disagree about a total.
function costsLedger({ expenses, reconciled, month, readError = null }) {
  const pic = buildCostPicture({ expenses: expenses || [], reconciled, month });
  const usd = (c) => Math.round(c) / 100;
  const kind = (k) => usd((pic.byKind.find((x) => x.kind === k) || { perMonthCents: 0 }).perMonthCents);
  // A list past the limit is partial (see readExpenses), so it is withheld
  // here as it is on the Overview, instead of totalling the first 500.
  const truncated = !!(expenses && expenses.truncated);
  return {
    status: readError || truncated ? 'error' : 'ok',
    readError: readError || (truncated ? `The expense list has more than ${EXPENSE_LIST_LIMIT} rows, so its totals would leave bills out.` : null),
    truncated,
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
  // Stacked discounts apply one after another in the order Stripe lists
  // them (review 2026-10-03: $20 off then 50% off a $100 plan is $40, and
  // this used to take every percentage first and read $30). A discount on a
  // single item is not modelled, so a subscription carrying one is counted
  // as unpriced rather than at a figure that ignores it.
  let unreadableDiscount = items.some((it) => it && Array.isArray(it.discounts) && it.discounts.length > 0);
  let cents = base;
  for (const d of (sub && Array.isArray(sub.discounts) ? sub.discounts : [])) {
    if (typeof d === 'string') { unreadableDiscount = true; continue; }
    if (d && Number.isFinite(d.end) && d.end <= nowSec) continue;
    const c = couponOf(d, coupons);
    if (!c) { unreadableDiscount = true; continue; }
    if (c.duration === 'once') continue;
    if (Number.isFinite(c.percent_off)) cents *= Math.max(0, 1 - c.percent_off / 100);
    else if (Number.isFinite(c.amount_off)) cents -= c.amount_off / monthsPerCharge(recurring);
    cents = Math.max(0, cents);
  }
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
        // Summed unrounded and rounded once below: 1,000 yearly plans at
        // $29.99 are $2,499.17 a month, not 1,000 roundings of $2.50.
        s.mrrCents += m.cents;
        p.mrrCents += m.cents;
        s.mrrNetCents += stripeNetMonthlyCents(m.cents, m.recurring);
        if (m.cents < 0.5) s.freeViaCode += 1;
      }
    } else {
      continue;
    }
    if (sub.cancel_at_period_end) s.endingAtPeriodEnd += 1;
    if (product === 'pro' && sub.metadata && /^[1-9][0-9]{0,9}$/.test(String(sub.metadata.app_user_id || ''))) {
      webProAccounts.add(Number(sub.metadata.app_user_id));
    }
  }
  for (const key of Object.keys(out)) {
    out[key].mrrNetCents = Math.round(out[key].mrrNetCents);
    out[key].mrrCents = Math.round(out[key].mrrCents);
    for (const p of Object.values(out[key].byPlan)) p.mrrCents = Math.round(p.mrrCents);
  }
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

// Sales tax on an invoice, in cents, whichever shape the API version gives it
// (total_taxes on current versions, total_tax_amounts or tax on older ones).
// With STRIPE_AUTOMATIC_TAX on, checkout charges price plus tax, and the
// charge's balance amount carries that tax: it is owed to the state, not
// revenue.
function invoiceTaxCents(inv) {
  const sumOf = (list) => list.reduce((t, x) => t + (Number(x && (x.amount !== undefined ? x.amount : x.tax_amount)) || 0), 0);
  if (Array.isArray(inv.total_taxes)) return sumOf(inv.total_taxes);
  if (Array.isArray(inv.total_tax_amounts)) return sumOf(inv.total_tax_amounts);
  return Number(inv.tax) || 0;
}

function summarizeInvoices(invoices, { roles, month }) {
  const byProduct = {
    pro: { paidCents: 0, invoices: 0, zeroInvoices: 0 },
    roost: { paidCents: 0, invoices: 0, zeroInvoices: 0 },
    other: { paidCents: 0, invoices: 0, zeroInvoices: 0 },
  };
  let nonUsd = 0;
  let outOfBand = 0;
  let taxCents = 0;
  for (const inv of invoices) {
    if (!inv || inv.status !== 'paid') continue;
    const paidAt = inv.status_transitions && inv.status_transitions.paid_at;
    if (!Number.isFinite(paidAt) || paidAt < month.startUnix) continue;
    if (String(inv.currency || '').toLowerCase() !== 'usd') { nonUsd += 1; continue; }
    // Marked paid outside Stripe: the money never entered the balance this
    // revenue is read from, so subtracting its tax took tax that was never
    // added (review 2026-10-03: a $108 invoice paid by check read as -$8).
    if (inv.paid_out_of_band === true) { outOfBand += 1; continue; }
    const b = byProduct[invoiceProduct(inv, roles)];
    const paid = Number(inv.amount_paid) || 0;
    b.paidCents += paid;
    b.invoices += 1;
    if (paid === 0) b.zeroInvoices += 1;
    taxCents += invoiceTaxCents(inv);
  }
  return { byProduct, nonUsd, outOfBand, taxCents };
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

function rcKeyFrom(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.length >= RC_MIN_KEY_LENGTH ? raw : null;
}

// TWO KEYS, BECAUSE REVENUECAT HAS TWO APIS. The per-account reads below go
// through API v1 with REVENUECAT_SECRET_API_KEY, the same key the entitlement
// check uses (services/proBilling.js). The project-wide figures, products and
// offering go through API v2, which RevenueCat says a v1 key does not work
// with: that is the 403 this panel used to show. They read
// REVENUECAT_V2_SECRET_API_KEY, a separate read-only v2 key, so turning the
// panel on never means swapping out the key that grants Pro.
const rcKey = () => rcKeyFrom(process.env.REVENUECAT_SECRET_API_KEY);
const rcV2Key = () => rcKeyFrom(process.env.REVENUECAT_V2_SECRET_API_KEY);

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

const RC_V2_KEY_WORDS = 'REVENUECAT_V2_SECRET_API_KEY must be a RevenueCat API v2 secret key with read access to charts and metrics and to project configuration.';
const RC_V2_UNSET_WORDS = 'REVENUECAT_V2_SECRET_API_KEY is not set, so RevenueCat\'s project-wide figures and the offering are not read. They need a RevenueCat API v2 secret key with read access to charts and metrics and to project configuration. REVENUECAT_SECRET_API_KEY stays the v1 key the entitlement check uses.';

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
  const v2Key = rcV2Key();
  const [overview, subscribers] = await Promise.all([
    v2Key
      ? readRcOverview(v2Key, month).catch((err) => ({ status: 'error', reason: rcProblem(err) }))
      : { status: 'not_connected', reason: RC_V2_UNSET_WORDS },
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
      return { ...base, verdict: 'match', env: envName, liveCents: p.unitAmountCents, liveUsable: true, priceId: p.id, words: `Matches Stripe (${envName}).` };
    }
    const sentence = problems.join('; ');
    return {
      ...base,
      verdict: 'mismatch',
      env: envName,
      liveCents: p.unitAmountCents,
      // What Stripe charges is only a price per plan period when it bills in
      // dollars on that period: a yearly price behind the monthly variable read
      // as $29.99 a month made the break-even 8 subscribers instead of 57.
      liveUsable: p.currency === 'USD' && p.interval === want && (!p.intervalCount || p.intervalCount === 1),
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
    // With no v2 key nothing was asked, which is not the same as a key that
    // was asked and refused, and the panel says which one it is.
    offering = {
      status: revenuecat.overview.status === 'not_connected' ? 'not_connected' : 'unavailable',
      identifier: null,
      findings: [],
      reason: revenuecat.overview.reason,
    };
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
// PEOPLE: signups, first-week activation, weekly active, plans
// ---------------------------------------------------------------------------
//
// The Overview had no user numbers at all, and the two the Research tab shows
// count every role, so a venue owner or an admin read as a user. These count
// people accounts only: role 'user', not banned. Every figure is a count; no
// id, name or email leaves the database, per NOTHING PERSONAL above.
//
// WHY NOT POSTHOG. Capture there waits on analytics consent
// (frontend/src/services/api.js), so its funnels only see the people who said
// yes. The database holds every signup and every action.
//
// THE TIMES. users.created_at, flocks.created_at and event_time, messages,
// direct messages, votes and flock_members.joined_at are naive TIMESTAMP
// columns holding UTC wall time (the pool pins TimeZone=UTC,
// config/database.js), so each window compares them with `now` read as UTC
// wall time. served_predictions.served_at and guest_rsvps.created_at are
// TIMESTAMPTZ and compare with `now` directly. `now` is a parameter, not the
// database's NOW(), so the hub's own clock decides every window.
//
// ROLLING WEEKS. "Last 7 days" is counted back from now, and "the 7 before"
// from there, rather than by calendar day: at nine in the morning a calendar
// week holds six days and a morning, and would read as a drop every day. The
// daily bars are New York calendar days, today so far, and say so.
//
// Held nowhere: like the other database reads, a new signup shows on the next
// load. The five statements run side by side, and each is static SQL, so the
// sqlParameterTypes suite prepares every one against the real schema.

const PEOPLE_DAYS = 14;
// First-week activation: accounts from 8 to 37 days old, so each has had a
// whole week to start or join a plan, and the group is the last month's.
const PEOPLE_ACTIVATION_WINDOW_DAYS = 7;
const PEOPLE_COHORT_FROM_DAYS = 8;
const PEOPLE_COHORT_TO_DAYS = 37;
// Under this many, a share is withheld and the two counts stand alone: one
// account either way would move it ten points or more.
const PEOPLE_MIN_FOR_SHARE = 10;

// $1 the time zone, $2 the UTC instant the first day began there.
const PEOPLE_SIGNUPS_BY_DAY_SQL = `SELECT to_char(((u.created_at AT TIME ZONE 'UTC') AT TIME ZONE $1::text)::date, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS n
         FROM users u
        WHERE u.role = 'user'
          AND u.is_banned IS NOT TRUE
          AND u.created_at >= ($2::timestamptz AT TIME ZONE 'UTC')
        GROUP BY 1
        ORDER BY 1`;

// $1 now. The last 7 days, and the 7 before them.
const PEOPLE_SIGNUPS_WEEKS_SQL = `SELECT COUNT(*) FILTER (WHERE u.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '7 days')::int AS last_7,
              COUNT(*) FILTER (WHERE u.created_at < ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '7 days')::int AS prior_7
         FROM users u
        WHERE u.role = 'user'
          AND u.is_banned IS NOT TRUE
          AND u.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
          AND u.created_at < ($1::timestamptz AT TIME ZONE 'UTC')`;

// $1 now, $2 the youngest age in days, $3 the oldest, $4 the first-week
// window in days. An account counts once it created a plan, or accepted one,
// inside that window after it signed up. A plan's creator is also its first
// accepted member, so either path alone would do; both are asked so a plan
// made by one route that skipped the member row still counts.
const PEOPLE_ACTIVATION_SQL = `SELECT COUNT(*)::int AS cohort,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM flocks f
                 WHERE f.creator_id = u.id
                   AND f.created_at >= u.created_at
                   AND f.created_at < u.created_at + make_interval(days => $4::int)
              ) OR EXISTS (
                SELECT 1 FROM flock_members fm
                 WHERE fm.user_id = u.id
                   AND fm.status = 'accepted'
                   AND fm.joined_at >= u.created_at
                   AND fm.joined_at < u.created_at + make_interval(days => $4::int)
              ))::int AS activated
         FROM users u
        WHERE u.role = 'user'
          AND u.is_banned IS NOT TRUE
          AND u.created_at <= ($1::timestamptz AT TIME ZONE 'UTC') - make_interval(days => $2::int)
          AND u.created_at > ($1::timestamptz AT TIME ZONE 'UTC') - make_interval(days => $3::int + 1)`;

// $1 now. Anyone who did one of these in the window: sent a flock message or
// a DM, voted on a venue in a plan or a DM, made a plan or accepted one, or
// was served a crowd forecast (a venue card or the vote list, signed in).
// Counted once however many they did.
const PEOPLE_ACTIVE_SQL = `WITH acts AS (
       SELECT m.sender_id AS user_id, m.created_at AS at FROM messages m
        WHERE m.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
       UNION ALL
       SELECT d.sender_id, d.created_at FROM direct_messages d
        WHERE d.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
       UNION ALL
       SELECT v.user_id, v.created_at FROM venue_votes v
        WHERE v.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
       UNION ALL
       SELECT dv.user_id, dv.created_at FROM dm_venue_votes dv
        WHERE dv.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
       UNION ALL
       SELECT f.creator_id, f.created_at FROM flocks f
        WHERE f.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
       UNION ALL
       SELECT fm.user_id, fm.joined_at FROM flock_members fm
        WHERE fm.status = 'accepted'
          AND fm.joined_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
       UNION ALL
       SELECT sv.user_id, sv.served_at AT TIME ZONE 'UTC' FROM served_predictions sv
        WHERE sv.served_at >= $1::timestamptz - INTERVAL '14 days'
     )
     SELECT COUNT(DISTINCT a.user_id) FILTER (WHERE a.at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '7 days')::int AS last_7,
            COUNT(DISTINCT a.user_id) FILTER (WHERE a.at < ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '7 days')::int AS prior_7
       FROM acts a
       JOIN users u ON u.id = a.user_id
      WHERE u.role = 'user'
        AND u.is_banned IS NOT TRUE
        AND a.at < ($1::timestamptz AT TIME ZONE 'UTC')`;

// $1 now. Plans people made; plans whose time came in the last 7 days and how
// many of them had been confirmed (the sweep turns a confirmed plan whose time
// has passed into a completed one, and an unconfirmed one into a cancelled
// one); and guests answering a plan's share link without an account. Plans
// are counted when a people account made them.
//
// A plan the host called off after confirming it is cancelled, so its status
// alone reads as never confirmed; confirmed_at (migration 102) says it was.
// A guest answer a moderator took down (is_hidden, migration 005) is not
// counted, the filter every guest read and broadcast uses.
const PEOPLE_PLANS_SQL = `WITH plans AS (
       SELECT f.id, f.created_at, f.event_time, f.status, f.confirmed_at
         FROM flocks f
         JOIN users u ON u.id = f.creator_id
        WHERE u.role = 'user'
          AND u.is_banned IS NOT TRUE
          AND (f.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
               OR f.event_time >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days')
     )
     SELECT COUNT(*) FILTER (WHERE p.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '7 days'
                               AND p.created_at < ($1::timestamptz AT TIME ZONE 'UTC'))::int AS made_last_7,
            COUNT(*) FILTER (WHERE p.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 days'
                               AND p.created_at < ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '7 days')::int AS made_prior_7,
            COUNT(*) FILTER (WHERE p.event_time >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '7 days'
                               AND p.event_time < ($1::timestamptz AT TIME ZONE 'UTC'))::int AS passed_last_7,
            COUNT(*) FILTER (WHERE p.event_time >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '7 days'
                               AND p.event_time < ($1::timestamptz AT TIME ZONE 'UTC')
                               AND (p.status IN ('confirmed', 'completed') OR p.confirmed_at IS NOT NULL))::int AS confirmed_last_7,
            (SELECT COUNT(*)::int FROM guest_rsvps g JOIN plans gp ON gp.id = g.flock_id
              WHERE COALESCE(g.is_hidden, false) = false
                AND g.created_at >= $1::timestamptz - INTERVAL '7 days'
                AND g.created_at < $1::timestamptz) AS guests_last_7,
            (SELECT COUNT(*)::int FROM guest_rsvps g JOIN plans gp ON gp.id = g.flock_id
              WHERE COALESCE(g.is_hidden, false) = false
                AND g.created_at >= $1::timestamptz - INTERVAL '14 days'
                AND g.created_at < $1::timestamptz - INTERVAL '7 days') AS guests_prior_7
       FROM plans p`;

// A share, or null under the minimum: the counts go either way.
function peopleShare(part, whole) {
  return whole >= PEOPLE_MIN_FOR_SHARE ? Math.round((part / whole) * 1000) / 10 : null;
}

async function readPeople(db = pool, now = new Date()) {
  const count = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  const today = ymdIn(HUB_TZ, now);
  const firstDay = addDaysYmd(today, -(PEOPLE_DAYS - 1));
  const from = new Date(zonedMidnightMs(firstDay, HUB_TZ));
  try {
    const [byDay, weeks, activation, active, plans] = await Promise.all([
      db.query(PEOPLE_SIGNUPS_BY_DAY_SQL, [HUB_TZ, from]),
      db.query(PEOPLE_SIGNUPS_WEEKS_SQL, [now]),
      db.query(PEOPLE_ACTIVATION_SQL, [now, PEOPLE_COHORT_FROM_DAYS, PEOPLE_COHORT_TO_DAYS, PEOPLE_ACTIVATION_WINDOW_DAYS]),
      db.query(PEOPLE_ACTIVE_SQL, [now]),
      db.query(PEOPLE_PLANS_SQL, [now]),
    ]);
    // Every day of the strip, a day with nobody new as a real zero.
    const seen = new Map((byDay.rows || []).map((r) => [String(r.day), count(r.n)]));
    const days = [];
    for (let i = 0; i < PEOPLE_DAYS; i += 1) {
      const day = addDaysYmd(firstDay, i);
      days.push({ day, n: seen.get(day) || 0 });
    }
    const w = (weeks.rows && weeks.rows[0]) || {};
    const a = (activation.rows && activation.rows[0]) || {};
    const act = (active.rows && active.rows[0]) || {};
    const p = (plans.rows && plans.rows[0]) || {};
    const cohort = count(a.cohort);
    const activated = Math.min(count(a.activated), cohort);
    const passed = count(p.passed_last_7);
    const confirmed = Math.min(count(p.confirmed_last_7), passed);
    return {
      status: 'ok',
      asOf: now.toISOString(),
      signups: {
        days,
        todayYmd: today,
        last7: count(w.last_7),
        prior7: count(w.prior_7),
      },
      activation: {
        cohort,
        activated,
        percent: peopleShare(activated, cohort),
        fromDays: PEOPLE_COHORT_FROM_DAYS,
        toDays: PEOPLE_COHORT_TO_DAYS,
        windowDays: PEOPLE_ACTIVATION_WINDOW_DAYS,
        minForShare: PEOPLE_MIN_FOR_SHARE,
      },
      active: { last7: count(act.last_7), prior7: count(act.prior_7) },
      plans: {
        madeLast7: count(p.made_last_7),
        madePrior7: count(p.made_prior_7),
        passedLast7: passed,
        confirmedLast7: confirmed,
        confirmedPercent: peopleShare(confirmed, passed),
        guestAnswersLast7: count(p.guests_last_7),
        guestAnswersPrior7: count(p.guests_prior_7),
        minForShare: PEOPLE_MIN_FOR_SHARE,
      },
    };
  } catch (err) {
    console.error('[money] people read failed:', err && err.message ? err.message : err);
    return { status: 'error', reason: 'The account and plan tables could not be read, so there are no people figures to show.' };
  }
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

// HOW OFTEN THE MODEL ANSWERS. The share above scores only forecasts the model
// made, so it cannot say whether that is nine in ten of the forecasts people
// see or one in twenty. served_predictions records what answered every card it
// served to a signed-in person (routes/crowd.js recordServedPredictions), so
// the split is one GROUP BY over the rows it already keeps, on its served_at
// index. The Costs tab's counter (mlPredictor.predictionCoverage) answers a
// different question: it counts every hour of a forecast strip, in memory,
// since the last deploy. This counts cards served, over a week that survives a
// deploy, and the screen says which is which. Held for MODEL_TTL_MS with the
// check above, for the same reason: it is a dashboard read over a week of rows.
const MODEL_COVERAGE_DAYS = 7;
const MODEL_COVERAGE_METHODS_MAX = 20;

// $1 the window in days, $2 the most methods to name. A method nobody wrote
// down is named 'unknown' rather than dropped, so the parts add up to the
// whole. Counts, and how many venues each touched, are all that leave.
const MODEL_COVERAGE_SQL = `SELECT COALESCE(sv.prediction_method, 'unknown') AS method,
              COUNT(*)::int AS served,
              COUNT(DISTINCT sv.venue_place_id)::int AS venues
         FROM served_predictions sv
        WHERE sv.served_at >= NOW() - make_interval(days => $1::int)
        GROUP BY 1
        ORDER BY 2 DESC, 1
        LIMIT $2::int`;

function modelCoverageCacheKey(windowDays) {
  return `model-coverage:${windowDays}d`;
}

async function readModelCoverage(db = pool, { windowDays = MODEL_COVERAGE_DAYS } = {}) {
  let rows;
  try {
    const r = await db.query(MODEL_COVERAGE_SQL, [windowDays, MODEL_COVERAGE_METHODS_MAX]);
    rows = (r && r.rows) || [];
  } catch (err) {
    console.error('[money] model coverage read failed:', err && err.message ? err.message : err);
    return { status: 'error', reason: 'The database did not finish counting what answered each forecast served, so there is no split to show.' };
  }
  const count = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  const byMethod = rows
    .map((row) => ({ method: String(row.method || 'unknown').slice(0, 60), served: count(row.served), venues: count(row.venues) }))
    .filter((m) => m.served > 0);
  const total = byMethod.reduce((sum, m) => sum + m.served, 0);
  const ml = (byMethod.find((m) => m.method === 'ml') || { served: 0 }).served;
  // A fallback is the rule engine standing in for the model. The owner's own
  // live report is not one (it outranks the model on purpose), and neither is
  // a serve whose method was not recorded.
  const fallbacks = byMethod.filter((m) => !['ml', 'owner_report', 'unknown'].includes(m.method));
  return {
    status: 'ok',
    asOf: new Date().toISOString(),
    windowDays,
    total,
    ml,
    mlPercent: total > 0 ? Math.round((ml / total) * 1000) / 10 : null,
    byMethod,
    topFallback: fallbacks.length > 0 ? fallbacks[0] : null,
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

function buildModelBlock({ version, accuracy, ladder, coverage = null }) {
  const measured = !!accuracy && accuracy.status === 'ok' && accuracy.enough === true && Number.isFinite(accuracy.percent);
  return {
    version,
    accuracy,
    // What answered the forecasts people were served, over the last week.
    coverage,
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
//   stripe_tax         automatic tax is on and this month's invoices were not
//                      read, so the tax inside the charges is unknown
//   stripe_tax_refunded  taxed charges and refunds in the same month: a refund
//                      takes its tax back out, and which charges it hit is not read
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

  // Sales tax collected this month is subtracted: the balance counts what the
  // customer paid, tax included. With automatic tax on and the invoices
  // unread, the tax is unknown, so the revenue is too.
  const invoicesRead = stripeOk && stripe.invoices && stripe.invoices.status === 'ok' && !stripe.invoices.truncated ? stripe.invoices : null;
  const taxOn = String(process.env.STRIPE_AUTOMATIC_TAX || '').toLowerCase() === 'true';
  // A refund in the month takes the tax back out of the balance too, and the
  // hub cannot tell which refunded charges carried tax, so subtracting every
  // invoice's tax would take refunded tax out twice: then it is unknown.
  // With tax on, ANY refund this month can return tax from an earlier
  // month's charge, which this month's invoices do not show.
  const taxRefunded = !!(balance && balance.refunds > 0 && (taxOn || (invoicesRead && (invoicesRead.taxCents || 0) > 0)));
  // Only said when the balance itself was read: with Stripe unread, that is
  // the reason, not the tax.
  const taxGap = balanceGap ? null : (taxOn && !invoicesRead ? 'stripe_tax' : (taxRefunded ? 'stripe_tax_refunded' : null));
  const taxCollectedCents = invoicesRead ? (invoicesRead.taxCents || 0) : 0;
  const stripeNetCents = balanceGap || taxGap ? null : balance.netCents - taxCollectedCents;
  const appStoreNetCents = appRevenueGap ? null : Math.round((appStore ? appStore.monthChargedCents : 0) * keep);
  const revenueCents = stripeNetCents === null ? null : stripeNetCents + (appStoreNetCents || 0);
  const missing = gaps(balanceGap, taxGap, appRevenueGap);

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
    const live = (pricing.stated || []).find((s) => s.product === product && s.plan === plan
      && Number.isFinite(s.liveCents) && s.liveUsable === true);
    if (live) return { cents: live.liveCents, source: 'stripe' };
    const stated = STATED_PRICES.find((s) => s.product === product && s.plan === plan);
    // Why the code's price: Stripe or its price list was not read, or it was
    // and has no monthly dollar price set for this plan.
    const record = (pricing.stated || []).find((s) => s.product === product && s.plan === plan);
    const statedBecause = !record || record.verdict === 'unchecked' ? 'stripe_prices_unread' : 'no_monthly_price';
    return stated ? { cents: Math.round(stated.usd * 100), source: 'stated', statedBecause } : null;
  };
  // No burn, no break-even: a count worked from a partial burn would be a
  // smaller number that looks whole.
  // Credits can put a month's burn below zero, and no count below zero is
  // needed to cover it.
  const need = (netPerUnit) => (burnCents !== null && netPerUnit > 0 ? Math.max(0, Math.ceil(burnCents / netPerUnit)) : null);
  // The App Store price, which Apple sets apart from the web one: the price
  // RevenueCat reports, else the newest App Store charge, else the code's
  // stated price (review 2026-10-03: the App Store count was worked from the
  // web price, which would be wrong the day the two differ).
  const appPriceFor = (plan) => {
    const row = (pricing.appStore || []).find((a) => a.plan === plan);
    if (row && Number.isFinite(row.listCents) && row.listCents > 0) return { cents: row.listCents, source: 'app_store' };
    if (row && Number.isFinite(row.lastChargedCents) && row.lastChargedCents > 0) return { cents: row.lastChargedCents, source: 'app_store_charge' };
    const stated = STATED_PRICES.find((s) => s.product === 'pro' && s.plan === plan);
    return stated ? { cents: Math.round(stated.usd * 100), source: 'stated', statedBecause: 'app_store_price_unread' } : null;
  };
  const proPrice = priceFor('pro', 'monthly');
  const proAppPrice = appPriceFor('monthly');
  const roostPrice = priceFor('roost', 'monthly');
  const proWebNet = proPrice ? stripeNetMonthlyCents(proPrice.cents, { interval: 'month', interval_count: 1 }) : null;
  const proAppNet = proAppPrice ? proAppPrice.cents * keep : null;
  // Apple takes 15% under the Small Business Program, and from a
  // subscriber's second year on either way. Nothing here can see which
  // applies, so the conservative 30% leads and this sits beside it.
  const keepSmall = 1 - APPLE_SMALL_BUSINESS_PCT / 100;
  const proAppNetSmall = proAppPrice ? proAppPrice.cents * keepSmall : null;
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
    appleSmallBusinessPct: APPLE_SMALL_BUSINESS_PCT,
    breakEven: {
      proWeb: proPrice ? { priceCents: proPrice.cents, source: proPrice.source, statedBecause: proPrice.statedBecause || null, netPerUnitCents: Math.round(proWebNet), netPerUnitExactCents: proWebNet, needed: need(proWebNet) } : null,
      proAppStore: proAppPrice ? {
        priceCents: proAppPrice.cents,
        source: proAppPrice.source,
        statedBecause: proAppPrice.statedBecause || null,
        netPerUnitCents: Math.round(proAppNet),
        netPerUnitExactCents: proAppNet,
        needed: need(proAppNet),
        smallBusiness: { commissionPct: APPLE_SMALL_BUSINESS_PCT, netPerUnitCents: Math.round(proAppNetSmall), needed: need(proAppNetSmall) },
      } : null,
      roost: roostPrice ? { priceCents: roostPrice.cents, source: roostPrice.source, statedBecause: roostPrice.statedBecause || null, netPerUnitCents: Math.round(roostNet), netPerUnitExactCents: roostNet, needed: need(roostNet) } : null,
      burnMissing: gaps(costGap),
      payingPro: payingProMissing.length > 0 ? null : subs.pro.live - subs.pro.freeViaCode + (appStore ? appStore.live : 0),
      payingProMissing,
      payingRoost: payingRoostMissing.length > 0 ? null : subs.roost.live - subs.roost.freeViaCode,
      payingRoostMissing,
    },
  };
}

// ---------------------------------------------------------------------------
// ONLY YOU CAN DO THESE: the operator's own steps, checked where the server can
// ---------------------------------------------------------------------------
//
// Some of what this page depends on is a switch no code here can throw: a
// variable on the Railway service, a key made in RevenueCat's dashboard, an
// agreement signed with Apple. This block lists those steps. Where the server
// can see the answer it checks it on every build of the hub and says done or
// to do, with the fix. Where it cannot, because Apple and BestTime keep the
// answer behind their own sign-ins, the step carries no state at all and the
// screen marks it for the operator to check.
//
// NOTHING SECRET LEAVES. A check reads a variable and sends back whether it is
// set, never what it holds. The database step sends which network the pool's
// host is on and the NAME of the variable that chose it, never the host, the
// port, the user or the password, and its fix is a fixed string. Its round
// trip is one SELECT 1 on a pooled connection, held under the vendor reads'
// rules (cachedRead).

const PRIVATE_DB_HOST_SUFFIX = '.railway.internal';
const DB_PRIVATE_NETWORK_FIX = 'railway variables --service Flock-app- --set PGHOST=postgres.railway.internal --set PGPORT=5432';
const DB_ROUND_TRIP_SQL = 'SELECT 1';
const REVENUECAT_DASHBOARD_URL = 'https://app.revenuecat.com/';

// Which network the pool dials, by config/database.js's own rule: it hands
// DATABASE_URL to node-postgres as the connection string, a host in that
// string wins, and PGHOST is read only when DATABASE_URL is unset. A value that
// will not parse counts as public, so the step never reads done on a guess.
// Only the verdict and the variable's name leave this function.
function databaseNetwork(env = process.env) {
  const url = plain(env.DATABASE_URL);
  let host = null;
  if (url) {
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
  } else {
    host = plain(env.PGHOST);
  }
  const onPrivate = typeof host === 'string' && host.toLowerCase().endsWith(PRIVATE_DB_HOST_SUFFIX);
  return { network: onPrivate ? 'private' : 'public', via: url ? 'DATABASE_URL' : 'PGHOST' };
}

// One SELECT 1 on a pooled connection, timed from the moment the query goes
// out to the moment its answer is back. The checkout is not timed: opening a
// connection costs far more than a query does, and the per-query trip is what
// the private network changes. A failure is logged by its code alone, because
// a connection error's message names the host and the user.
async function measureDatabaseRoundTrip(db = pool) {
  const code = (err) => (err && (err.code || err.name)) || 'unknown error';
  const noConnection = { status: 'error', reason: 'The server could not get a database connection to time, so there is no round trip to show.' };
  // The route always passes the pool. A db seam with no connect() has no
  // connection to lend, which is the same answer, and not an error to log.
  if (!db || typeof db.connect !== 'function') return noConnection;
  let client;
  try {
    client = await db.connect();
  } catch (err) {
    console.error('[money] database round trip: no connection:', code(err));
    return noConnection;
  }
  let broken;
  try {
    const started = process.hrtime.bigint();
    await client.query(DB_ROUND_TRIP_SQL);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { status: 'ok', ms: Math.round(ms * 100) / 100, asOf: new Date().toISOString() };
  } catch (err) {
    broken = err;
    console.error('[money] database round trip failed:', code(err));
    return { status: 'error', reason: 'The database did not answer SELECT 1, so there is no round trip to show.' };
  } finally {
    // A connection whose SELECT 1 failed goes back marked broken, so the pool
    // closes it instead of lending it to the next request.
    if (client && typeof client.release === 'function') client.release(broken);
  }
}

// The webhook route's own answer to "is the secret configured": trimmed,
// without a Bearer prefix, and at least 16 characters, or it refuses every
// event. Asked rather than restated, so the step and the route cannot
// disagree, and required at call time, as services/entitlements.js does, so
// this service does not load a router when it loads. null when the route
// could not be asked.
function revenueCatWebhookConfigured() {
  try {
    return !!require('../routes/revenuecat').configuredSecret();
  } catch (err) {
    console.error('[money] webhook secret check failed:', (err && err.name) || 'unknown error');
    return null;
  }
}

// What the last RevenueCat read did with the v2 key, from the block the hub
// already built. The step is done once the key is set; this says whether
// RevenueCat took it, so a refused key is never shown as simply done.
function rcV2LastRead(revenuecat) {
  if (!revenuecat || revenuecat.status === 'not_connected') return 'not_asked';
  const o = revenuecat.overview;
  if (!o) return null;
  if (o.status === 'ok') return 'answered';
  if (o.status === 'refused') return 'refused';
  if (o.status === 'error') return 'failed';
  return null;
}

const RC_V2_HOWTO = 'In RevenueCat, open Project settings, then API keys, and make a secret key for API v2 with read access to charts and metrics and to project configuration. Set it on the server as REVENUECAT_V2_SECRET_API_KEY, and leave REVENUECAT_SECRET_API_KEY as it is.';

// expensesRead is { ok, rows }: whether the list was read, and how many bills
// it returned. roundTrip is the cached SELECT 1 answer. revenuecat is the
// block the hub built, read only for what it did with the v2 key.
function buildOwnerActions({ roundTrip, expensesRead, revenuecat }) {
  const { network, via } = databaseNetwork();
  const onPrivate = network === 'private';
  let dbWords;
  if (onPrivate) {
    dbWords = `${via} names a railway.internal address, so every query stays on Railway's private network.`;
  } else if (via === 'DATABASE_URL') {
    dbWords = 'DATABASE_URL names no railway.internal address, so every query travels through Railway\'s public proxy. The pool takes its host from DATABASE_URL ahead of PGHOST, so point DATABASE_URL at the private address, or remove it and let PGHOST decide.';
  } else {
    dbWords = 'PGHOST names no railway.internal address, so every query travels through Railway\'s public proxy. The fix is one command, and Railway redeploys the service when its variables change.';
  }

  const rcV2Set = rcV2Key() !== null;
  const lastRead = rcV2Set ? rcV2LastRead(revenuecat) : null;
  let rcV2Words;
  if (!rcV2Set) {
    rcV2Words = plain(process.env.REVENUECAT_V2_SECRET_API_KEY)
      ? `REVENUECAT_V2_SECRET_API_KEY is too short to be a RevenueCat secret key, so the hub does not use it. ${RC_V2_HOWTO}`
      : `REVENUECAT_V2_SECRET_API_KEY is not set, so RevenueCat's project-wide figures and the offering are not read. ${RC_V2_HOWTO}`;
  } else if (lastRead === 'not_asked') {
    rcV2Words = 'REVENUECAT_V2_SECRET_API_KEY is set. The hub asks RevenueCat nothing until REVENUECAT_SECRET_API_KEY is set as well, so it is not used yet.';
  } else if (lastRead === 'refused') {
    rcV2Words = 'REVENUECAT_V2_SECRET_API_KEY is set, and RevenueCat refused it on the last read. It must be a secret key for API v2 with read access to charts and metrics and to project configuration.';
  } else {
    rcV2Words = 'REVENUECAT_V2_SECRET_API_KEY is set, so the hub reads RevenueCat\'s project-wide figures and the offering with it.';
  }

  const webhookSet = revenueCatWebhookConfigured();
  let webhookState = 'unknown';
  let webhookWords = 'The server could not ask the webhook route whether its secret is set, so this step cannot be checked right now.';
  if (webhookSet === true) {
    webhookState = 'done';
    webhookWords = 'REVENUECAT_WEBHOOK_SECRET is set on the server. RevenueCat\'s webhook, under Integrations, then Webhooks, must send the same value as its Authorization header, with or without Bearer in front. The server cannot see RevenueCat\'s side, so that half is yours to check.';
  } else if (webhookSet === false) {
    webhookState = 'todo';
    webhookWords = 'REVENUECAT_WEBHOOK_SECRET is not set to a usable value, 16 characters or more, so the server refuses every webhook RevenueCat sends. Set a long random one on the server (openssl rand -hex 32 makes one), and put the same value in the Authorization header of RevenueCat\'s webhook, under Integrations, then Webhooks. The server cannot see RevenueCat\'s side.';
  }

  let expensesState = 'unknown';
  let expensesWords = 'The expense list could not be read, so this step cannot be checked right now.';
  if (expensesRead && expensesRead.ok && expensesRead.rows > 0) {
    expensesState = 'done';
    expensesWords = 'The expense list has bills on it, so the costs on this page count them.';
  } else if (expensesRead && expensesRead.ok) {
    expensesState = 'todo';
    expensesWords = 'The expense list is empty, so the costs on this page count only the code\'s own lines and the reconciled bills. Paste the list into Import a list, at the bottom of the Expense list card.';
  }

  // instrument.js's own test, so this step and the boot log line agree.
  const sentrySet = Boolean(process.env.SENTRY_DSN);
  // The checkouts' own switch, so this step and what a buyer is charged agree.
  const taxOn = billing.taxEnabled();

  const server = [
    {
      id: 'database_private_network',
      label: 'Database on Railway\'s private network',
      state: onPrivate ? 'done' : 'todo',
      network,
      via,
      words: dbWords,
      // The command sets PGHOST, which decides nothing while DATABASE_URL is
      // set, so it is offered only when PGHOST is what the pool reads.
      fix: !onPrivate && via === 'PGHOST' ? DB_PRIVATE_NETWORK_FIX : null,
      roundTrip,
    },
    {
      id: 'revenuecat_project_figures',
      label: 'RevenueCat project figures',
      state: rcV2Set ? 'done' : 'todo',
      lastRead,
      words: rcV2Words,
      link: { href: REVENUECAT_DASHBOARD_URL, text: 'RevenueCat' },
    },
    {
      id: 'revenuecat_webhook',
      label: 'RevenueCat webhook',
      state: webhookState,
      words: webhookWords,
      link: { href: REVENUECAT_DASHBOARD_URL, text: 'RevenueCat' },
    },
    {
      id: 'expense_list',
      label: 'Company expense list',
      state: expensesState,
      words: expensesWords,
    },
    {
      id: 'error_reporting',
      label: 'Error reporting',
      state: sentrySet ? 'done' : 'todo',
      optional: true,
      // Both sentences describe what utils/serverFault.js actually does: every
      // route's own caught 500 goes to Sentry with its stack when the DSN is
      // set, and a burst of them raises an ops alert either way.
      words: sentrySet
        ? 'SENTRY_DSN is set, so server errors are collected in Sentry with their stack, including the ones a route catches and answers with a 500.'
        : `SENTRY_DSN is not set. Server errors reach the Railway logs, and ${SERVER_FAULT_ALERT_THRESHOLD} of them in ${Math.round(FAULT_WINDOW_MS / 60000)} minutes, or a background job that stops, raises an ops alert. What is missing is a stack trace for each error. Setting it needs no code change.`,
    },
    {
      // Optional because whether a subscription is taxable, and where, is a
      // question for the states and an accountant, not something the code
      // can decide. What the server can say is whether checkout adds tax.
      id: 'sales_tax',
      label: 'Sales tax on web checkouts',
      state: taxOn ? 'done' : 'todo',
      optional: true,
      words: taxOn
        ? 'STRIPE_AUTOMATIC_TAX is on, so Stripe Tax works out sales tax at each web checkout, for Flock Pro and Roost, wherever the account has a registration. It adds nothing where there is none.'
        : 'STRIPE_AUTOMATIC_TAX is off, so web checkouts for Flock Pro and Roost charge the list price and add no sales tax. Once the company is registered to collect it, add the registration in Stripe under Tax, then set STRIPE_AUTOMATIC_TAX=true. Checkouts then add tax on top of the price. The App Store collects its own.',
      link: { href: 'https://dashboard.stripe.com/tax', text: 'Stripe Tax' },
    },
  ].map((s) => ({ optional: false, fix: null, link: null, ...s, checkedBy: 'server' }));

  // The steps the server cannot see. Each goes out with no state, so nothing
  // downstream can print a done or a to do for it. The Apple rates are the
  // cost model's, the same ones the App Store break-even is worked from.
  const { appleStandardPct, appleSmallBusinessPct } = costModel.RATES.stores;
  const yours = [
    {
      id: 'paid_apps_agreement',
      label: 'Paid Apps Agreement',
      words: 'Apple sells no in-app purchase until the Account Holder signs it, in App Store Connect under Business, then Agreements.',
      link: { href: 'https://appstoreconnect.apple.com/', text: 'App Store Connect' },
    },
    {
      id: 'small_business_program',
      label: 'App Store Small Business Program',
      words: `Enrolling takes Apple's cut from ${appleStandardPct}% to ${appleSmallBusinessPct}%. The App Store break-even on this page assumes ${appleStandardPct}%, because the server cannot see whether the account is enrolled. Once it is, each App Store subscriber covers more of the burn. Apple asks for the Paid Apps Agreement first.`,
      link: { href: 'https://developer.apple.com/app-store/small-business-program/', text: 'Small Business Program' },
    },
    {
      id: 'subscription_review_screenshot',
      label: 'Review screenshot on each subscription',
      words: 'Each subscription needs a screenshot under Review Information before Apple will review it. Without one, App Store Connect shows it as Missing Metadata. Open the app, then Monetization, then Subscriptions.',
      link: { href: 'https://appstoreconnect.apple.com/apps', text: 'App Store Connect apps' },
    },
    {
      id: 'apple_organization_account',
      label: 'Apple developer account under the company',
      words: 'Moving the developer account to the company\'s organization account is a request to Apple Developer Support. Apple verifies the company through its D-U-N-S Number.',
      link: { href: 'https://developer.apple.com/contact/', text: 'Apple Developer Support' },
    },
    {
      id: 'besttime_admissions',
      label: 'BestTime new-venue admissions this month',
      words: 'BestTime\'s key endpoint does not report them, so the server cannot count them. BestTime\'s settings page shows how many are left this month.',
      link: { href: 'https://besttime.app/settings', text: 'BestTime settings' },
    },
    {
      id: 'vercel_plan',
      label: 'A Vercel plan that allows a business',
      words: 'Vercel\'s free Hobby plan is for non-commercial, personal use only, and the website sells Flock Pro. The plan that fits is Pro, $20 a month per developer seat, under Settings, then Billing. The Vercel line under Costs says which plan the cost figures assume.',
      link: { href: 'https://vercel.com/dashboard', text: 'Vercel' },
    },
  ].map((s) => ({ ...s, checkedBy: 'you', state: null, optional: false, fix: null }));

  return {
    items: [...server, ...yours],
    // A required step left to do and an optional one are counted apart, so
    // the screen can say which without doing arithmetic of its own.
    counts: {
      todo: server.filter((s) => s.state === 'todo' && !s.optional).length,
      optionalTodo: server.filter((s) => s.state === 'todo' && s.optional).length,
      done: server.filter((s) => s.state === 'done').length,
      unknown: server.filter((s) => s.state === 'unknown').length,
      checkYourself: yours.length,
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

  // Timed before the other reads start, so the SELECT 1 does not wait behind
  // their answers on the event loop and time their work along with its own.
  // Held like a vendor read; a failure is logged by its code alone.
  const roundTrip = await cachedRead(
    databaseRoundTripCacheKey(),
    () => measureDatabaseRoundTrip(db),
    { force, logMessage: false }
  );

  const [expensesR, reconciled, premiumR, venuesR, photoR, health, besttimeRead, modelAccuracy, modelVersion, people, modelCoverage] = await Promise.all([
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
      // PAYING, so not on trial: the same line break-even's "Paying now"
      // draws (live = active or past_due, trials counted apart). This count
      // took trials in, so during a Roost trial the Overview and break-even
      // gave two different numbers for paying venues (money hub audit
      // 2026-10-03).
      const r = await db.query(
        `SELECT COUNT(*)::int AS n FROM venue_subscriptions
          WHERE granted_reason = 'paid'
            AND status IN ('active', 'past_due')
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
    // Never held, like the other database reads, and never throws: a failed
    // read comes back as a block with a reason.
    readPeople(db, now),
    // Held for the hour with the served-forecast check beside it.
    cachedRead(
      modelCoverageCacheKey(MODEL_COVERAGE_DAYS),
      () => readModelCoverage(db, { windowDays: MODEL_COVERAGE_DAYS }),
      { force, ttlMs: MODEL_TTL_MS }
    ),
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
    // A list longer than the limit is a partial list, so the totals are
    // missing bills and say so rather than read as whole.
    costsComplete: expensesR.ok && !expensesR.value.truncated,
    appStoreComplete: !!(revenuecat && revenuecat.subscribers && revenuecat.subscribers.complete === true),
    pricing,
  });
  const ownerActions = buildOwnerActions({
    roundTrip,
    expensesRead: { ok: expensesR.ok, rows: expenses.length },
    revenuecat,
  });
  const planNets = buildPlanNets(pricing);
  const priceSheet = buildPriceSheet({ expenses, reconciled, todayYmd: month.todayYmd });
  const unitCosts = buildUnitCosts({ burnCents: net.burnCents, people });
  const { boolFlag } = require('./entitlements');

  return {
    generatedAt: new Date().toISOString(),
    month: { label: month.label, startYmd: month.startYmd, todayYmd: month.todayYmd, daysInMonth: month.daysInMonth, dayOfMonth: month.dayOfMonth, tz: HUB_TZ },
    planNets,
    unitCosts,
    priceSheet,
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
      status: expensesR.ok && !expensesR.value.truncated ? 'ok' : 'error',
      reason: !expensesR.ok
        ? 'The expense list could not be read, so only the code lines and the reconciled bills are counted.'
        : (expensesR.value.truncated ? `The expense list has more than ${EXPENSE_LIST_LIMIT} rows, so only the first ${EXPENSE_LIST_LIMIT} are counted and the totals are left unread.` : null),
      ...costs,
      reconciledReadError: reconciled && reconciled.readError ? 'The saved reconciled figures could not be read, so the code figures stand in.' : null,
      googleMeteredThisMonth: photoR.ok && photoR.value ? {
        photosBought: Number.isFinite(photoR.value.monthUsed) ? photoR.value.monthUsed : null,
        photosUsd: Number.isFinite(photoR.value.monthUsd) ? photoR.value.monthUsd : null,
      } : null,
    },
    expenses: {
      status: expensesR.ok ? 'ok' : 'error',
      rows: expenses,
      truncated: !!(expensesR.ok && expensesR.value.truncated),
      limit: EXPENSE_LIST_LIMIT,
      kinds: EXPENSE_KINDS,
      cadences: EXPENSE_CADENCES,
      codeLines: codeLineOptions(),
    },
    net,
    pricing,
    // Counts only, of people accounts. See PEOPLE above.
    people,
    // The collector's own rows are health.collector, which the screen shows
    // beside this block; they are not read a second time here.
    crowdData: {
      besttime: besttimeRead,
      plan: statedBestTimePlan(now),
    },
    model: buildModelBlock({ version: modelVersion, accuracy: modelAccuracy, ladder, coverage: modelCoverage }),
    health,
    // See ONLY YOU CAN DO THESE above. Whether each variable is set, never
    // its value.
    ownerActions,
  };
}

module.exports = {
  buildMoneyHub,
  buildCostPicture,
  buildPricing,
  buildNet,
  buildPlanNets,
  buildUnitCosts,
  expensesCsv,
  buildPriceSheet,
  billJumps,
  costsLedger,
  readExpenses,
  readHealth,
  readPeople,
  PEOPLE_SIGNUPS_BY_DAY_SQL,
  PEOPLE_SIGNUPS_WEEKS_SQL,
  PEOPLE_ACTIVATION_SQL,
  PEOPLE_ACTIVE_SQL,
  PEOPLE_PLANS_SQL,
  readBestTime,
  statedBestTimePlan,
  readServedBandAccuracy,
  readModelCoverage,
  MODEL_COVERAGE_SQL,
  readModelVersion,
  crowdBandLadder,
  SERVED_BAND_ACCURACY_SQL,
  buildOwnerActions,
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
  EXPENSE_IMPORT_INSERT_SQL,
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
    modelCoverageCacheKey,
    databaseRoundTripCacheKey,
    databaseNetwork,
    measureDatabaseRoundTrip,
    DB_PRIVATE_NETWORK_FIX,
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
    MODEL_COVERAGE_DAYS,
  },
};
