'use strict';
// ---------------------------------------------------------------------------
// RECEIPTS FROM THE OWNER'S GMAIL (2026-11-05).
//
// The money hub used to learn about a bill only when somebody typed it in. A
// Gmail filter on the owner's account now forwards the receipts of the
// companies Flock pays to a receiving address at Resend; Resend posts
// email.received to /api/email-events (routes/emailWebhook.js), which hands
// the event here. This reads the forwarded receipt back from Resend, decides
// whether it is one, reads it (services/receiptParsers.js) and records what
// it paid in the hub, the way a person updating the dashboard would.
//
// THE SERVER NEVER SEES THE REST OF THE INBOX. Only mail the filter forwards
// reaches the address, and nothing here can reach Gmail.
//
// WHAT IS ACCEPTED. A received email counts only when all of these hold, and
// anything else is dropped with a counted log line and nothing stored:
//   * it was delivered to the receipts address (RECEIPTS_INBOX_ADDRESS, or
//     any address whose local part is "receipts" on a domain the Resend
//     account receives for);
//   * Gmail forwarded it from the owner's account. A Gmail filter's forward
//     carries X-Forwarded-For: <account> <destination> and X-Forwarded-To:
//     <destination>, and goes out with the account as its envelope sender
//     (<account>+caf_=<destination>@gmail.com). Those headers can be typed by
//     anybody, so the envelope must also pass SPF for gmail.com as Resend's
//     receiving server judged it: only Google's servers can do that;
//   * its original From is on the sender list below, and that sender's own
//     DKIM signature checked out (Resend's DKIM result), so the From was not
//     typed by somebody else;
//   * it was addressed to the owner in the first place, so a genuine receipt
//     somebody else was sent cannot be replayed into the hub.
//
// WHAT IS STORED. Only what the hub needs: the vendor, the product, amounts,
// dates, the subject, the sender, the Message-ID and Resend's id, in
// email_receipts (migration 134). Never the body. A receipt that cannot be
// read is kept by its sender and subject alone, for a person to check.
//
// WHAT A RECEIPT CHANGES. In this order:
//   1. The Railway or Google Cloud bill (a reconciled line): the line takes
//      the receipt's figure and date, with a note naming both, through the
//      same statement the dashboard's form uses, so the figure it replaces is
//      kept beside it for the "up on the last bill" check.
//   2. A bill already on the expense list (the same vendor, and the same
//      product and cadence where the vendor has several): its last charge and
//      amount move to the receipt's. A one-time charge from a vendor already
//      on the list is added as its own one-time bill.
//   3. Anything else waits for the owner on the dashboard and is counted in
//      no total until he adds it. The sender alone cannot say whether a new
//      charge is the company's (Apple and Google send personal receipts from
//      the same addresses), what kind of bill it is, or how often it comes,
//      and a wrong row would move the burn and every break-even without
//      anybody seeing why. A charge that waits costs nothing.
//   The App Store and Google send everybody's purchases from one address, so
//   an item there is read only when it is a bill already on the list (or, for
//   a one-time purchase, a vendor already on it), and nothing is stored about
//   the rest.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const pool = require('../config/database');
const costModel = require('./costModel');
const moneyHub = require('./moneyHub');
const { parseReceipt } = require('./receiptParsers');

const RESEND_RECEIVING_URL = 'https://api.resend.com/emails/receiving/';
const FETCH_TIMEOUT_MS = 10000;
const HUB_TZ = 'America/New_York';

// The receipts address. With RECEIPTS_INBOX_ADDRESS unset, any address whose
// local part is this one counts: only mail sent to a domain the Resend account
// receives for ever reaches the webhook, so the domain is already ours.
const DEFAULT_INBOX_LOCAL_PART = 'receipts';

// The owner's Gmail address, written as it is compared (lower case, no dots,
// no +tag) and kept as a SHA-256 digest so the published code does not carry
// it. RECEIPTS_FORWARDED_BY replaces it.
const OWNER_GMAIL_SHA256 = ['4ec494cb9a2cf478e40fde5dcb111ea284f9aef3d6456cfe395c36f329020225'];

// Whose receipts are read. A vendor already named in costModel.js is written
// out; a company tool the published code does not name is the SHA-256 of its
// lower-case address. `name`, where given, must match the sender's display
// name: FastSpring sends every merchant's receipts from one address.
// RECEIPT_SENDERS adds addresses (or @domains) without a deploy.
const SENDERS = [
  { address: 'invoice+statements+acct_1hnrvlcjopsrzqsd@stripe.com', label: 'Railway, through Stripe' },
  { address: 'invoice+statements+acct_1a7vyyjarfkv4rxk@stripe.com', label: 'Codemagic (Nevercode Ltd), through Stripe' },
  { address: 'payments-noreply@google.com', label: 'Google payments' },
  { address: 'no_reply@email.apple.com', label: 'the App Store' },
  { address: 'mailer@fastspring.com', name: /^maptiler\b/i, label: 'MapTiler, through FastSpring' },
  { address: 'noreply@notify.cloudflare.com', label: 'Cloudflare' },
  { address: 'sales@pololu.com', label: 'Pololu' },
  { address: 'hello@pcbartists.com', label: 'PCB Artists' },
  { sha256: '5621d2eab1e11b655624f8e5df74444c2b2edaebfca4d399d7e976e66ca56e1f', label: 'a development tool, through Stripe' },
];

// The reconciled lines a receipt can be, read off what the receipt says.
const RECONCILED_FROM = {
  railway: (parsed) => parsed.format === 'stripe' && /\brailway\b/i.test(`${parsed.merchant || ''} ${parsed.site || ''}`),
  'google-cloud': (parsed, bill) => parsed.format === 'google' && /google cloud/i.test(bill.product || ''),
};

// What each kind of dropped email is, for the log line and the dashboard.
const IGNORED_WORDS = {
  no_email_id: 'no email id in the event',
  gone: 'no longer at Resend',
  not_to_inbox: 'not sent to the receipts address',
  not_forwarded: 'not forwarded by a Gmail filter',
  forwarded_by_someone_else: 'forwarded by another Gmail account',
  forwarded_elsewhere: 'forwarded to another address',
  not_from_gmail: 'not handed over by Gmail',
  sender_not_listed: 'from a sender not on the list',
  sender_not_verified: "failed its sender's signature check",
  not_addressed_to_owner: 'never addressed to the owner',
  not_a_receipt: 'a notice, not a receipt',
  not_flock: 'a purchase that matches nothing on the list',
  dismissed_before: "a bill already marked as not Flock's",
};

// ---------------------------------------------------------------------------
// Counting what is dropped. Kept in memory on purpose: a dropped email stores
// nothing, and the count is only there to say the filter is reaching us.
// ---------------------------------------------------------------------------

const ignored = { since: new Date().toISOString(), total: 0, byReason: {} };

function countIgnored(reason, fromDomain) {
  ignored.total += 1;
  ignored.byReason[reason] = (ignored.byReason[reason] || 0) + 1;
  const tally = Object.entries(ignored.byReason).map(([k, n]) => `${k} ${n}`).join(', ');
  console.warn(`[receipts] dropped a received email, ${IGNORED_WORDS[reason] || reason}${fromDomain ? ` (from ${fromDomain})` : ''}, and stored nothing. Dropped since ${ignored.since}: ${ignored.total} (${tally}).`);
}

function ignoredSinceStart() {
  return {
    since: ignored.since,
    total: ignored.total,
    byReason: Object.entries(ignored.byReason).map(([reason, count]) => ({ reason, count, words: IGNORED_WORDS[reason] || reason })),
  };
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Lower case, and for Gmail the address Gmail itself delivers to: dots and a
// +tag do not change a Gmail mailbox, and googlemail.com is gmail.com.
function canonicalAddress(raw) {
  const a = String(raw || '').trim().toLowerCase().replace(/^mailto:/, '').replace(/^<|>$/g, '');
  const at = a.lastIndexOf('@');
  if (at < 1 || at === a.length - 1) return null;
  let local = a.slice(0, at);
  let domain = a.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return local ? `${local}@${domain}` : null;
}

const ADDRESS = /[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+\.[a-z]{2,}/gi;

function addressesIn(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    for (const m of v.match(ADDRESS) || []) out.push(m.toLowerCase());
  }
  return out;
}

// '"Railway Corporation" <invoice@stripe.com>' -> { name, address }.
function parseFrom(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  const address = (addressesIn(v)[0] || '').toLowerCase() || null;
  let name = v.includes('<') ? v.slice(0, v.indexOf('<')) : '';
  name = name.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').trim();
  return { name: name || null, address };
}

function ownerHashes() {
  const set = String(process.env.RECEIPTS_FORWARDED_BY || '').split(/[\s,]+/).map(canonicalAddress).filter(Boolean);
  return set.length ? set.map(sha256) : OWNER_GMAIL_SHA256;
}

function isOwner(address) {
  const c = canonicalAddress(address);
  return !!c && ownerHashes().includes(sha256(c));
}

function inboxAddress() {
  const v = String(process.env.RECEIPTS_INBOX_ADDRESS || '').trim().toLowerCase();
  return v && v.includes('@') ? v : null;
}

function isInbox(address) {
  const a = String(address || '').trim().toLowerCase();
  const exact = inboxAddress();
  if (exact) return a === exact;
  return a.slice(0, a.lastIndexOf('@')) === DEFAULT_INBOX_LOCAL_PART;
}

function extraSenders() {
  return String(process.env.RECEIPT_SENDERS || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
}

function senderAllowed(address, name) {
  const a = String(address || '').toLowerCase();
  if (!a) return false;
  const digest = sha256(a);
  const listed = SENDERS.find((s) => (s.address ? s.address === a : s.sha256 === digest));
  if (listed) return listed.name ? listed.name.test(String(name || '')) : true;
  const domain = a.slice(a.lastIndexOf('@'));
  return extraSenders().some((s) => s === a || (s.startsWith('@') && s === domain));
}

// ---------------------------------------------------------------------------
// The received email, from Resend
// ---------------------------------------------------------------------------

function headerOf(headers, name) {
  if (!headers) return null;
  let v = null;
  if (Array.isArray(headers)) {
    const hit = headers.find((h) => h && String(h.name || h.key || '').toLowerCase() === name);
    v = hit ? (hit.value ?? null) : null;
  } else if (typeof headers === 'object') {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    v = key ? headers[key] : null;
  }
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v.trim() : null;
}

function nyDate(when) {
  const t = Date.parse(when);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: HUB_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

const cleanMessageId = (v) => {
  const s = typeof v === 'string' ? v.trim().replace(/^<|>$/g, '').trim() : '';
  return s ? s.slice(0, 300) : null;
};

async function fetchReceivedEmail(id) {
  const key = typeof process.env.RESEND_API_KEY === 'string' ? process.env.RESEND_API_KEY.trim() : '';
  if (!key) return { ok: false, retry: true, why: 'RESEND_API_KEY is not set' };
  let res;
  try {
    res = await fetch(`${RESEND_RECEIVING_URL}${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, retry: true, why: `Resend did not answer (${(err && err.name) || 'error'})` };
  }
  if (res.status === 404) return { ok: false, retry: false, why: 'gone' };
  if (!res.ok) return { ok: false, retry: true, why: `Resend answered ${res.status}` };
  try {
    return { ok: true, email: await res.json() };
  } catch {
    return { ok: false, retry: true, why: 'Resend answered with something other than JSON' };
  }
}

// Every address the email was delivered or forwarded to, from the event and
// the headers Gmail adds.
function deliveredTo(data, email) {
  const h = email.headers;
  const fwdFor = addressesIn(headerOf(h, 'x-forwarded-for'));
  return [
    ...addressesIn(data.to), ...addressesIn(data.received_for),
    ...addressesIn(email.to), ...addressesIn(email.received_for), ...addressesIn(email.cc), ...addressesIn(email.bcc),
    ...addressesIn(headerOf(h, 'x-forwarded-to')), ...fwdFor.slice(1),
    ...addressesIn(headerOf(h, 'delivered-to')), ...addressesIn(headerOf(h, 'x-original-to')),
  ];
}

// The checks in the header of this file, in order. Returns null when the
// email may be read, or the reason it may not.
function refusal(data, email) {
  const h = email.headers;
  if (!deliveredTo(data, email).some(isInbox)) return 'not_to_inbox';
  const fwdFor = addressesIn(headerOf(h, 'x-forwarded-for'));
  if (fwdFor.length === 0) return 'not_forwarded';
  if (!isOwner(fwdFor[0])) return 'forwarded_by_someone_else';
  if (fwdFor[1] && !isInbox(fwdFor[1])) return 'forwarded_elsewhere';
  const fwdTo = addressesIn(headerOf(h, 'x-forwarded-to'));
  if (fwdTo.length && !fwdTo.some(isInbox)) return 'forwarded_elsewhere';
  const envelope = canonicalAddress(addressesIn(headerOf(h, 'return-path'))[0]);
  const auth = email.authentication && typeof email.authentication === 'object' ? email.authentication : null;
  if (!envelope || !envelope.endsWith('@gmail.com') || !isOwner(envelope) || !auth || auth.spf !== 'pass') return 'not_from_gmail';
  const from = parseFrom(headerOf(h, 'from') || email.from);
  if (!senderAllowed(from.address || email.from, from.name)) return 'sender_not_listed';
  if (auth.dkim !== 'pass' || auth.dmarc === 'fail') return 'sender_not_verified';
  const original = [...addressesIn(headerOf(h, 'to')), ...addressesIn(headerOf(h, 'cc')), ...addressesIn(email.to)];
  if (!original.some((a) => isOwner(a) || /@flockcorp\.com$/.test(a))) return 'not_addressed_to_owner';
  return null;
}

// ---------------------------------------------------------------------------
// Matching a receipt to a bill on the expense list
// ---------------------------------------------------------------------------

// Words that say nothing about which company or product a name is.
const NOISE = new Set(['inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'pbc', 'gmbh', 'ag', 'sa', 'plc', 'bv', 'pty', 'opc', 'pvt', 'private', 'the', 'via', 'app', 'store', 'and', 'of', 'for', 'a', 'an', 'to', 'by', 'on', 'sales', 'support', 'team', 'official']);
const RENEWAL_WORDS = new Set(['monthly', 'month', 'annual', 'annually', 'yearly', 'year', 'plan', 'subscription', 'membership', 'weekly', 'quarterly', 'renewal', 'per', 'usage']);

function words(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !NOISE.has(w));
}

// The label of a website's own name: railway.com -> railway.
function siteWord(site) {
  const labels = String(site || '').toLowerCase().split('.').filter(Boolean);
  return labels.length >= 2 ? labels[labels.length - 2] : null;
}

// A row's vendor is the receipt's when every word of the vendor's name is in
// what the receipt calls the merchant (its name, its website, and on the App
// Store the app's own name, where "Apple" itself names no vendor).
function vendorFits(row, parsed, bill) {
  const rowWords = words(row.vendor);
  if (!rowWords.length) return false;
  let pool;
  if (parsed.format === 'apple') {
    if (rowWords.length === 1 && rowWords[0] === 'apple') return false;
    pool = new Set([...words(bill.title), ...words(bill.product)]);
  } else {
    pool = new Set([...words(parsed.merchant), ...words(bill.title)]);
    const sw = siteWord(parsed.site);
    if (sw) for (const w of words(sw)) pool.add(w);
  }
  return rowWords.every((w) => pool.has(w));
}

// How much of a row's product name the receipt's item names, 0 to 1, leaving
// out the words that only say how often it renews.
function productScore(row, bill) {
  const rowWords = words(row.product).filter((w) => !RENEWAL_WORDS.has(w));
  if (!rowWords.length) return 0;
  const pool = new Set([...words(bill.product), ...words(bill.title)]);
  return rowWords.filter((w) => pool.has(w)).length / rowWords.length;
}

function cadenceFits(rowCadence, billCadence) {
  if (rowCadence === 'one_time') return false;
  if (!billCadence) return true;
  if (rowCadence === billCadence) return true;
  const monthly = ['monthly', 'usage'];
  return monthly.includes(rowCadence) && monthly.includes(billCadence);
}

const labelOf = (row) => (row.product ? `${row.vendor}, ${row.product}` : row.vendor);

// What the receipt's bill is on the expense list. `rows` is every row.
function planExpense(parsed, bill, rows) {
  const apple = parsed.format === 'apple';
  const oneTime = bill.inApp || bill.cadence === 'one_time';
  const vendorRows = rows.filter((r) => vendorFits(r, parsed, bill));
  if (!oneTime) {
    let fits = (apple ? rows : vendorRows).filter((r) => cadenceFits(r.cadence, bill.cadence));
    if (apple) fits = fits.filter((r) => productScore(r, bill) === 1);
    const live = fits.filter((r) => r.active);
    if (live.length === 1) return { kind: 'update', row: live[0] };
    if (live.length > 1) {
      const scored = live.map((r) => ({ r, s: productScore(r, bill) })).sort((a, b) => b.s - a.s);
      if (scored[0].s > 0 && scored[0].s > scored[1].s) return { kind: 'update', row: scored[0].r };
      return { kind: 'ambiguous', rows: live };
    }
    if (fits.length) return { kind: 'stopped', row: fits[0] };
    // The App Store sends every purchase on the account. A subscription that
    // is no bill on the list is somebody's own.
    if (apple) return { kind: 'drop' };
  }
  if (apple && vendorRows.length === 0) return { kind: 'drop' };
  if (vendorRows.length === 0) return { kind: 'new', alongside: [] };
  if (oneTime || vendorRows.every((r) => r.cadence === 'one_time')) {
    const like = [...vendorRows].sort((a, b) => String(b.lastChargedOn || '').localeCompare(String(a.lastChargedOn || '')) || b.id - a.id)[0];
    return { kind: 'add_one_time', like, vendorRows };
  }
  return { kind: 'new', alongside: vendorRows.filter((r) => r.active && r.cadence !== 'one_time') };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const money = (cents, currency = 'USD') => {
  const n = (Math.abs(cents) / 100).toFixed(2);
  return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
};

function dayWords(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

// "November 2026" for any day in it.
function monthWords(ymd) {
  const [y, m] = String(ymd).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

function periodWords(bill) {
  if (!bill.periodStart || !bill.periodEnd) return null;
  const [y1, m1, d1] = bill.periodStart.split('-').map(Number);
  const [y2, m2, d2] = bill.periodEnd.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y2, m2, 0)).getUTCDate();
  if (d1 === 1 && y1 === y2 && m1 === m2 && d2 === lastDay) return monthWords(bill.periodStart);
  const short = (y, m, d, withYear) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${short(y1, m1, d1, y1 !== y2)} to ${short(y2, m2, d2, true)}`;
}

const sentence = (s) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}` : null);

// ---------------------------------------------------------------------------
// Deciding and writing, inside one transaction per email
// ---------------------------------------------------------------------------

const RECEIPT_INSERT_SQL = `INSERT INTO email_receipts
       (message_id, line_no, resend_email_id, sender, subject, vendor, product, amount_cents, currency,
        paid_on, period_start, period_end, cadence, reference, status, reconciled_line, expense_id,
        previous_cents, previous_on, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12::date, $13, $14, $15, $16, $17,
             $18, $19::date, $20)`;

const SEEN_SQL = `SELECT 1 FROM email_receipts WHERE message_id = $1 OR resend_email_id = $2 LIMIT 1`;

// The same receipt sent again as a new email ("resend receipt" in a vendor's
// dashboard) has a new Message-ID and the same receipt number. Where the
// number is one per charge it says the charge is already read. FastSpring is
// left out: a subscription's renewals may carry the order they renew.
const ONE_NUMBER_PER_CHARGE = new Set(['stripe', 'apple', 'google', 'cloudflare', 'order']);
const SAME_RECEIPT_SQL = `SELECT 1 FROM email_receipts WHERE sender = $1 AND reference = $2 LIMIT 1`;

const EXPENSE_ROWS_SQL = `SELECT id, vendor, product, category, kind, amount_cents, currency, cadence,
            last_charged_on::text AS last_charged_on, renews_on::text AS renews_on,
            active, verified, note, replaces_line, is_credit, ends_on::text AS ends_on, updated_at
       FROM business_expenses
      WHERE is_credit = false
      ORDER BY id`;

const ADDED_FROM_EMAIL_SQL = `SELECT expense_id FROM email_receipts WHERE status = 'added' AND expense_id IS NOT NULL`;

const DISMISSED_SQL = `SELECT product FROM email_receipts WHERE status = 'dismissed' AND sender = $1`;

// What a receipt does to a bill on the list: its newest charge and amount,
// checked against a receipt. Nothing else on the row moves.
const EXPENSE_CHARGED_SQL = `UPDATE business_expenses
        SET amount_cents = $2, last_charged_on = $3::date, verified = true, updated_at = NOW(), updated_by = NULL
      WHERE id = $1`;

async function decideReconciled(client, parsed, bill, lineId, today) {
  const block = await costModel.readReconciled(client);
  if (block.readError) throw new Error('the reconciled lines could not be read');
  const line = block.lines.find((l) => l.id === lineId);
  const code = costModel.RECONCILED.lines.find((l) => l.id === lineId);
  if (!line || !code) return { status: 'to_check', reason: `The ${lineId} line is no longer in the cost model.` };
  const nowCents = Math.round(Number(line.usdPerMonth) * 100);
  const base = { reconciledLine: lineId, previousCents: nowCents, previousOn: line.asOf };
  const name = lineId === 'railway' ? 'Railway' : 'Google Cloud';
  if (bill.currency !== 'USD') return { ...base, status: 'to_check', reason: `Paid in ${bill.currency}, and the ${name} figure is in dollars.` };
  if (bill.paidOn > today) return { ...base, status: 'to_check', reason: 'Dated after today.' };
  if (line.asOf > bill.paidOn) return { ...base, status: 'older', reason: `The hub already holds a newer ${name} figure, from ${dayWords(line.asOf)}.` };
  if (line.asOf === bill.paidOn && nowCents === bill.amountCents) return { ...base, status: 'already' };
  // Google bills Cloud once a month, on the 1st, for the month before. A
  // second payment in the same month is prepaid credit or a retried bill, and
  // only the invoice can say which (a $20 prepayment followed the bill on
  // 2026-11-02).
  if (lineId === 'google-cloud' && line.asOf.slice(0, 7) === bill.paidOn.slice(0, 7)) {
    return { ...base, status: 'to_check', reason: `A second Google Cloud payment in ${monthWords(bill.paidOn)}: prepaid credit or a retried bill. The Google Cloud figure was left as it is.` };
  }
  const usd = bill.amountCents / 100;
  const period = periodWords(bill);
  const note = lineId === 'railway'
    ? `Railway's receipt of ${bill.paidOn}: ${money(bill.amountCents)}${period ? ` for ${period}` : ''}, read from the forwarded receipt.`
    : `Google's payment receipt of ${bill.paidOn}: ${money(bill.amountCents)}${period ? ` for ${period}` : ''}, read from the forwarded receipt. Google states the amount, not the line items.`;
  return {
    ...base,
    status: 'applied',
    write: (c) => c.query(costModel.RECONCILED_SAVE_SQL, [lineId, Math.round(usd * 100) / 100, bill.paidOn, note, null, code.usdPerMonth, code.asOf]),
  };
}

async function insertOneTime(client, plan, parsed, bill) {
  const like = plan.like;
  const when = periodWords(bill) || dayWords(bill.paidOn);
  const base = String(bill.product || bill.title || like.product || like.vendor).slice(0, 96);
  for (let n = 1; n <= 9; n += 1) {
    const product = `${base}, ${when}${n > 1 ? ` (${n})` : ''}`.slice(0, 120);
    const row = moneyHub.expenseRowFromInput({
      vendor: like.vendor,
      product,
      category: like.category,
      kind: like.kind,
      cadence: 'one_time',
      amountCents: bill.amountCents,
      currency: bill.currency,
      lastChargedOn: bill.paidOn,
      verified: true,
      note: `From the forwarded receipt of ${bill.paidOn}: ${money(bill.amountCents, bill.currency)}.`,
    });
    const r = await client.query(moneyHub.EXPENSE_IMPORT_INSERT_SQL, [...moneyHub.expenseParams(row), null]);
    if (r.rows && r.rows[0]) return Number(r.rows[0].id);
  }
  throw new Error('no free product name for a one-time bill');
}

async function decideExpense(client, parsed, bill, rows, today, addedFromEmail) {
  const plan = planExpense(parsed, bill, rows);
  if (plan.kind === 'drop') return { drop: 'not_flock' };
  if (bill.paidOn > today) return { status: 'to_check', reason: 'Dated after today.' };
  if (plan.kind === 'update') {
    const row = plan.row;
    const base = { expenseId: row.id, previousCents: row.amountCents, previousOn: row.lastChargedOn };
    if (row.currency !== bill.currency) return { ...base, status: 'to_check', reason: `Paid in ${bill.currency}, and ${labelOf(row)} is in ${row.currency}.` };
    if (row.lastChargedOn && row.lastChargedOn > bill.paidOn) return { ...base, status: 'older', reason: `${labelOf(row)} was already charged later, on ${dayWords(row.lastChargedOn)}.` };
    if (row.lastChargedOn === bill.paidOn && row.amountCents === bill.amountCents) return { ...base, status: 'already' };
    return { ...base, status: 'applied', write: (c) => c.query(EXPENSE_CHARGED_SQL, [row.id, bill.amountCents, bill.paidOn]) };
  }
  if (plan.kind === 'ambiguous') {
    return { status: 'to_check', reason: `It could be more than one bill on the list: ${plan.rows.map(labelOf).join('; ')}.` };
  }
  if (plan.kind === 'stopped') {
    return { expenseId: plan.row.id, status: 'to_check', reason: `It is ${labelOf(plan.row)}, which is marked stopped. If it is charged again, mark it as charged again.` };
  }
  if (plan.kind === 'add_one_time') {
    const same = plan.vendorRows.find((r) => r.cadence === 'one_time' && r.amountCents === bill.amountCents
      && r.lastChargedOn === bill.paidOn && !addedFromEmail.has(r.id));
    if (same) return { expenseId: same.id, status: 'already' };
    const decision = { status: 'added' };
    decision.write = async (c) => { decision.expenseId = await insertOneTime(c, plan, parsed, bill); };
    return decision;
  }
  // A new bill waits for the owner.
  const alongside = plan.alongside || [];
  return {
    status: 'new',
    reason: alongside.length
      ? `${alongside[0].vendor} already has ${alongside.map((r) => r.product || r.vendor).join(' and ')} on the list. If this replaces it, mark that one stopped.`
      : null,
  };
}

async function decide(client, ctx, parsed, bill, state) {
  if (parsed.refund) return { status: 'to_check', reason: 'A refund. Record it on the expense list as money back.' };
  for (const [lineId, test] of Object.entries(RECONCILED_FROM)) {
    if (test(parsed, bill)) return decideReconciled(client, parsed, bill, lineId, ctx.today);
  }
  if (parsed.format === 'google') return { drop: 'not_flock' };
  if (parsed.format === 'cloudflare') {
    return { status: 'to_check', reason: `Cloudflare's invoice does not say what it pays for. The code already counts the flockcorp.com renewal at ${money(Math.round(Number((costModel.FIXED_ANNUAL.find((l) => l.id === 'domain') || { usd: 0 }).usd) * 100))} a year; anything else belongs on the expense list.` };
  }
  if (state.dismissed.has(words(bill.product).join(' '))) return { drop: 'dismissed_before' };
  return decideExpense(client, parsed, bill, state.rows, ctx.today, state.addedFromEmail);
}

// One email, one transaction, under one lock, so two deliveries of the same
// email (Resend retries) cannot both write: the second waits, then finds the
// first one's rows.
async function storeReceipt(db, ctx, parsed) {
  const client = await db.connect();
  const statuses = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('email_receipts'))");
    const seen = await client.query(SEEN_SQL, [ctx.messageId, ctx.resendId]);
    const again = !(seen.rows && seen.rows.length) && parsed.kind === 'receipt' && parsed.reference && ONE_NUMBER_PER_CHARGE.has(parsed.format)
      ? await client.query(SAME_RECEIPT_SQL, [ctx.sender, parsed.reference])
      : null;
    if ((seen.rows && seen.rows.length) || (again && again.rows && again.rows.length)) {
      await client.query('ROLLBACK');
      return { duplicate: true, statuses };
    }
    const insert = (lineNo, f) => client.query(RECEIPT_INSERT_SQL, [
      ctx.messageId, lineNo, ctx.resendId, ctx.sender, ctx.subject, f.vendor || null, f.product || null,
      Number.isInteger(f.amountCents) ? f.amountCents : null, f.currency || null, f.paidOn || null,
      f.periodStart || null, f.periodEnd || null, f.cadence || null, f.reference || null, f.status,
      f.reconciledLine || null, f.expenseId || null, Number.isInteger(f.previousCents) ? f.previousCents : null,
      f.previousOn || null, f.reason ? String(f.reason).slice(0, 300) : null,
    ]);
    if (parsed.kind === 'unreadable') {
      await insert(0, { status: 'to_check', vendor: ctx.fromName || ctx.fromDomain, reason: sentence(parsed.why) });
      statuses.push('to_check');
    } else {
      const state = {
        rows: ((await client.query(EXPENSE_ROWS_SQL)).rows || []).map(moneyHub.expenseFromRow),
        addedFromEmail: new Set(((await client.query(ADDED_FROM_EMAIL_SQL)).rows || []).map((r) => Number(r.expense_id))),
        dismissed: new Set(((await client.query(DISMISSED_SQL, [ctx.sender])).rows || []).map((r) => words(r.product).join(' '))),
      };
      let lineNo = 0;
      for (const item of parsed.bills) {
        // Each bill carries the receipt's day and currency, which the
        // decisions below compare with the hub's.
        const bill = { ...item, paidOn: item.paidOn || parsed.paidOn, currency: item.currency || parsed.currency };
        const d = await decide(client, ctx, parsed, bill, state);
        if (d.drop) {
          countIgnored(d.drop, ctx.fromDomain);
          continue;
        }
        if (d.write) await d.write(client);
        await insert(lineNo, {
          ...d,
          vendor: d.reconciledLine ? (d.reconciledLine === 'railway' ? 'Railway' : 'Google Cloud') : (parsed.format === 'apple' ? bill.title : parsed.merchant),
          product: bill.product,
          amountCents: bill.amountCents,
          currency: bill.currency || parsed.currency,
          paidOn: bill.paidOn || parsed.paidOn,
          periodStart: bill.periodStart,
          periodEnd: bill.periodEnd,
          cadence: bill.cadence || null,
          reference: parsed.reference,
        });
        lineNo += 1;
        statuses.push(d.status);
      }
    }
    await client.query('COMMIT');
    return { duplicate: false, statuses };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505' && /email_receipts/.test(String(err.constraint || ''))) return { duplicate: true, statuses: [] };
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The webhook's entry point
// ---------------------------------------------------------------------------

// Answers { retry: true } only for a failure a second delivery could fix (Resend
// or the database did not answer); every other outcome is final and the route
// answers 200 so Resend stops sending it.
async function handleReceived(data, { db = pool, fetchEmail = fetchReceivedEmail, now = new Date() } = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const emailId = typeof d.email_id === 'string' && d.email_id.trim() ? d.email_id.trim() : null;
  if (!emailId) {
    countIgnored('no_email_id');
    return { outcome: 'ignored', reason: 'no_email_id' };
  }
  try {
    const early = cleanMessageId(d.message_id);
    const seen = await db.query(SEEN_SQL, [early || `resend:${emailId}`, emailId]);
    if (seen.rows && seen.rows.length) return { outcome: 'duplicate' };
  } catch (err) {
    console.error('[receipts] could not check for a duplicate:', (err && err.message) || err);
    return { outcome: 'failed', retry: true };
  }
  const got = await fetchEmail(emailId);
  if (!got.ok) {
    if (!got.retry) {
      countIgnored('gone');
      return { outcome: 'ignored', reason: 'gone' };
    }
    console.error(`[receipts] could not read received email ${emailId} from Resend: ${got.why}`);
    return { outcome: 'failed', retry: true };
  }
  const email = got.email && typeof got.email === 'object' ? got.email : {};
  const from = parseFrom(headerOf(email.headers, 'from') || email.from || d.from);
  const fromAddress = from.address || addressesIn(email.from || d.from)[0] || null;
  const fromDomain = fromAddress ? fromAddress.slice(fromAddress.lastIndexOf('@') + 1) : null;
  const why = refusal(d, email);
  if (why) {
    countIgnored(why, fromDomain);
    return { outcome: 'ignored', reason: why };
  }
  const subject = String(email.subject || d.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const parsed = parseReceipt({
    fromAddress,
    fromName: from.name,
    subject,
    html: typeof email.html === 'string' ? email.html : null,
    text: typeof email.text === 'string' ? email.text : null,
    dateYmd: nyDate(headerOf(email.headers, 'date')) || nyDate(email.created_at) || nyDate(now.toISOString()),
  });
  if (parsed.kind === 'not_receipt') {
    countIgnored('not_a_receipt', fromDomain);
    return { outcome: 'ignored', reason: 'not_a_receipt' };
  }
  const ctx = {
    messageId: cleanMessageId(email.message_id || d.message_id || headerOf(email.headers, 'message-id')) || `resend:${emailId}`,
    resendId: emailId,
    sender: fromAddress,
    fromName: from.name,
    fromDomain,
    subject,
    today: nyDate(now.toISOString()),
  };
  try {
    const out = await storeReceipt(db, ctx, parsed);
    if (out.duplicate) return { outcome: 'duplicate' };
    if (out.statuses.length) {
      console.log(`[receipts] a receipt from ${fromDomain} was read: ${out.statuses.join(', ')}.`);
      return { outcome: 'stored', statuses: out.statuses };
    }
    return { outcome: 'ignored', reason: 'not_flock' };
  } catch (err) {
    console.error('[receipts] could not record a receipt:', (err && err.message) || err);
    return { outcome: 'failed', retry: true };
  }
}

// ---------------------------------------------------------------------------
// The dashboard: what came in, and the owner's two answers to a new bill
// ---------------------------------------------------------------------------

const HUB_READ_SQL = `SELECT r.id, r.sender, r.subject, r.vendor, r.product, r.amount_cents, r.currency,
            r.paid_on::text AS paid_on, r.period_start::text AS period_start, r.period_end::text AS period_end,
            r.cadence, r.status, r.reconciled_line, r.expense_id, r.previous_cents,
            r.previous_on::text AS previous_on, r.reason, r.received_at,
            e.vendor AS expense_vendor, e.product AS expense_product
       FROM email_receipts r
       LEFT JOIN business_expenses e ON e.id = r.expense_id
      ORDER BY r.received_at DESC, r.id DESC
      LIMIT 60`;

const RECENT_SHOWN = 12;

function itemView(r) {
  const lineLabel = r.reconciled_line ? ((costModel.RECONCILED.lines.find((l) => l.id === r.reconciled_line) || {}).label || r.reconciled_line) : null;
  const expenseLabel = r.expense_vendor ? (r.expense_product ? `${r.expense_vendor}, ${r.expense_product}` : r.expense_vendor) : null;
  const view = {
    id: Number(r.id),
    vendor: r.vendor || null,
    product: r.product || null,
    amountCents: r.amount_cents === null || r.amount_cents === undefined ? null : Number(r.amount_cents),
    currency: r.currency || null,
    paidOn: r.paid_on || null,
    periodStart: r.period_start || null,
    periodEnd: r.period_end || null,
    cadence: r.cadence || null,
    status: r.status,
    reconciledLine: r.reconciled_line || null,
    lineLabel,
    expenseId: r.expense_id === null || r.expense_id === undefined ? null : Number(r.expense_id),
    expenseLabel,
    previousCents: r.previous_cents === null || r.previous_cents === undefined ? null : Number(r.previous_cents),
    previousOn: r.previous_on || null,
    reason: r.reason || null,
    receivedAt: r.received_at ? new Date(r.received_at).toISOString() : null,
  };
  // A receipt that could not be read is shown by its sender and subject,
  // which is all that was kept of it.
  if (r.status === 'to_check') {
    view.sender = r.sender || null;
    view.subject = r.subject || null;
  }
  return view;
}

async function readForHub(db = pool, now = new Date()) {
  const inbox = { address: inboxAddress(), localPart: inboxAddress() ? null : DEFAULT_INBOX_LOCAL_PART };
  try {
    const { rows } = await db.query(HUB_READ_SQL);
    const items = (rows || []).map(itemView);
    const month = nyDate(now.toISOString()).slice(0, 7);
    return {
      status: 'ok',
      inbox,
      pending: items.filter((x) => x.status === 'new'),
      toCheck: items.filter((x) => x.status === 'to_check'),
      recent: items.filter((x) => x.status !== 'new' && x.status !== 'to_check').slice(0, RECENT_SHOWN),
      thisMonth: items.filter((x) => x.status !== 'dismissed' && x.receivedAt && nyDate(x.receivedAt).slice(0, 7) === month).length,
      lastReceivedAt: items.length ? items[0].receivedAt : null,
      ignored: ignoredSinceStart(),
    };
  } catch (err) {
    console.error('[money] receipts from email read failed:', (err && err.message) || err);
    return { status: 'error', reason: 'The receipts from email could not be read.', inbox, pending: [], toCheck: [], recent: [], thisMonth: null, lastReceivedAt: null, ignored: ignoredSinceStart() };
  }
}

// Adds a new bill to the expense list, as the kind the owner picked. The same
// bill already on the list (vendor, product, cadence) takes the receipt's
// charge instead of being added twice.
async function confirmReceipt(id, { kind = 'tooling', userId = null } = {}, db = pool) {
  if (!moneyHub.EXPENSE_KINDS.includes(kind)) return { status: 400, error: `kind must be one of ${moneyHub.EXPENSE_KINDS.join(', ')}` };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('email_receipts'))");
    const found = await client.query(
      `SELECT id, vendor, product, amount_cents, currency, paid_on::text AS paid_on, cadence, status
         FROM email_receipts WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const r = found.rows && found.rows[0];
    if (!r) { await client.query('ROLLBACK'); return { status: 404, error: 'Receipt not found' }; }
    if (r.status !== 'new') { await client.query('ROLLBACK'); return { status: 409, error: 'That receipt is not waiting for an answer any more.' }; }
    const row = moneyHub.expenseRowFromInput({
      vendor: r.vendor || 'Unknown vendor',
      product: r.product,
      kind,
      cadence: r.cadence && moneyHub.EXPENSE_CADENCES.includes(r.cadence) ? r.cadence : 'monthly',
      amountCents: Number(r.amount_cents),
      currency: r.currency || 'USD',
      lastChargedOn: r.paid_on,
      verified: true,
      note: `Added from the forwarded receipt of ${r.paid_on}: ${money(Number(r.amount_cents), r.currency || 'USD')}.`,
    });
    let expense;
    const ins = await client.query(moneyHub.EXPENSE_IMPORT_INSERT_SQL, [...moneyHub.expenseParams(row), userId]);
    if (ins.rows && ins.rows[0]) {
      expense = ins.rows[0];
    } else {
      const same = await client.query(
        `SELECT id FROM business_expenses
          WHERE lower(vendor) = lower($1) AND lower(COALESCE(product, '')) = lower(COALESCE($2, ''))
            AND cadence = $3 AND is_credit = false
          ORDER BY id LIMIT 1 FOR UPDATE`,
        [row.vendor, row.product, row.cadence]
      );
      const existing = same.rows && same.rows[0];
      if (!existing) throw new Error('the bill was neither added nor found');
      await client.query(EXPENSE_CHARGED_SQL, [existing.id, row.amountCents, row.lastChargedOn]);
      expense = { id: existing.id };
    }
    await client.query(
      `UPDATE email_receipts SET status = 'confirmed', expense_id = $2, resolved_at = NOW() WHERE id = $1`,
      [id, Number(expense.id)]
    );
    await client.query('COMMIT');
    return { status: 200, expenseId: Number(expense.id) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// "Not a Flock bill" for a new one (later receipts for the same product from
// the same sender are then dropped), "Done" for one that was checked.
async function dismissReceipt(id, db = pool) {
  const r = await db.query(
    `UPDATE email_receipts
        SET status = CASE status WHEN 'new' THEN 'dismissed' ELSE 'checked' END, resolved_at = NOW()
      WHERE id = $1 AND status IN ('new', 'to_check')
      RETURNING status`,
    [id]
  );
  if (r.rows && r.rows[0]) return { status: 200, now: r.rows[0].status };
  const exists = await db.query('SELECT 1 FROM email_receipts WHERE id = $1', [id]);
  return exists.rows && exists.rows.length
    ? { status: 409, error: 'That receipt is not waiting for an answer any more.' }
    : { status: 404, error: 'Receipt not found' };
}

module.exports = {
  handleReceived,
  readForHub,
  confirmReceipt,
  dismissReceipt,
  ignoredSinceStart,
  DEFAULT_INBOX_LOCAL_PART,
  __testing: {
    canonicalAddress,
    isOwner,
    isInbox,
    senderAllowed,
    refusal,
    planExpense,
    vendorFits,
    productScore,
    fetchReceivedEmail,
    periodWords,
    SENDERS,
    resetIgnored: () => { ignored.total = 0; ignored.byReason = {}; ignored.since = new Date().toISOString(); },
  },
};
