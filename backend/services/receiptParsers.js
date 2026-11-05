'use strict';
// ---------------------------------------------------------------------------
// RECEIPTS, READ (2026-11-05).
//
// services/receiptInbox.js hands each forwarded receipt here and gets back
// what the bill was for, in figures the money hub can store. Nothing in this
// file touches the database or the network: every function takes the email
// as Resend returns it and answers with data.
//
// ONE PARSER PER FORMAT, NOT PER VENDOR. Most bills arrive in one of a few
// layouts that many vendors share: Stripe's receipt, the App Store receipt,
// Google's payment receipt, FastSpring's order receipt, Cloudflare's invoice
// notice and a shop's order email. Each parser reads its layout's own words
// ("Amount paid", "Renews", "Order total"), so a new vendor that bills
// through Stripe needs no code here at all.
//
// WHAT COMES BACK
//   { kind: 'receipt', format, merchant, site, paidOn, currency, totalCents,
//     reference, refund, bills: [{ title, product, amountCents, cadence,
//     periodStart, periodEnd, renewsOn, inApp }] }
//   { kind: 'not_receipt', why }  a notice from a billing address that is not
//                                 a charge: a failed payment, a shipped order,
//                                 a renewal reminder
//   { kind: 'unreadable', why }   it reads like a receipt and the figures could
//                                 not be found, so a person has to look
// Amounts are integer cents in the receipt's own currency, tax included,
// because a bill on the expense list is what left the account. A receipt with
// several items (the App Store) gives each item its share of the tax. Dates
// are YYYY-MM-DD as printed on the receipt.
//
// NOTHING PERSONAL IS READ. A receipt carries the payer's name, postal
// address, card digits and, on the App Store, the device's name. No field
// below is taken from those parts: the billing blocks are never parsed, and
// an App Store item's device line is skipped by its position.
// ---------------------------------------------------------------------------

// A receipt bigger than this is not one any vendor sends; reading less keeps
// the regular expressions below cheap on whatever arrives.
const MAX_BODY_CHARS = 1500000;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '\u2013', mdash: '\u2014', minus: '\u2212', bull: '\u2022', middot: '\u00b7', hellip: '\u2026',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d',
  ldquo: '\u201c', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', times: '\u00d7', rsaquo: '\u203a',
  lsaquo: '\u2039', raquo: '\u00bb', laquo: '\u00ab', shy: '', zwnj: '', zwj: '', lrm: '', rlm: '',
};

// Padding a mail puts in its preview line, and marks that are never text.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0]/g;

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

// Plain text as lines, each with its runs of space folded to one and the
// invisible padding taken out. Empty lines go.
function textLines(text) {
  return String(text || '').slice(0, MAX_BODY_CHARS).replace(INVISIBLE, '').split(/\r?\n/)
    .map((l) => l.replace(/[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim())
    .filter(Boolean);
}

// HTML as the lines a reader sees: every block (a cell, a row, a paragraph, a
// line break) ends a line, inline tags (a span, a link, bold) do not.
function htmlToLines(html) {
  const s = String(html || '').slice(0, MAX_BODY_CHARS)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|tr|td|th|li|ul|ol|h[1-6]|table|tbody|thead|tfoot|section|article|header|footer|blockquote|center|dt|dd|dl|pre|address|caption)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return textLines(decodeEntities(s));
}

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS = [
  ['US$', 'USD'], ['CA$', 'CAD'], ['C$', 'CAD'], ['AU$', 'AUD'], ['A$', 'AUD'], ['NZ$', 'NZD'],
  ['HK$', 'HKD'], ['S$', 'SGD'], ['$', 'USD'], ['\u20ac', 'EUR'], ['\u00a3', 'GBP'],
];
const SYMBOL = CURRENCY_SYMBOLS.map(([s]) => s.replace(/\$/g, '\\$')).join('|');
const AMOUNT = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?';
const MINUS = '[-\u2212\u2013]';
// "$42.99", "-$20.00", "$82.99 USD", "USD 42.99": the whole line is the amount.
const MONEY_LINE = new RegExp(`^(${MINUS})?\\s*(?:([A-Z]{3})\\s+)?(${SYMBOL})?\\s?${AMOUNT}(?:\\s*([A-Z]{3}))?$`);
// The same anywhere in a line: a symbol is required, so a quantity or a
// receipt number is never read as money.
const MONEY_IN = new RegExp(`(${MINUS})?\\s?(${SYMBOL})\\s?${AMOUNT}(?![\\d.])(?:\\s?([A-Z]{3})\\b)?`);

function toCents(whole, frac) {
  const units = Number(String(whole).replace(/,/g, ''));
  const part = frac === undefined ? 0 : Number(String(frac).padEnd(2, '0'));
  const cents = units * 100 + part;
  return Number.isSafeInteger(cents) ? cents : null;
}

function moneyLine(line) {
  const m = MONEY_LINE.exec(String(line || '').trim());
  if (!m) return null;
  const [, minus, codeBefore, symbol, whole, frac, codeAfter] = m;
  // A bare number is a quantity, not money: it needs a symbol or a code.
  if (!symbol && !codeBefore && !codeAfter) return null;
  const fromSymbol = symbol ? (CURRENCY_SYMBOLS.find(([s]) => s === symbol) || [null, null])[1] : null;
  const cents = toCents(whole, frac);
  if (cents === null) return null;
  return { cents, currency: codeAfter || codeBefore || fromSymbol || 'USD', negative: !!minus };
}

function moneyIn(text) {
  const m = MONEY_IN.exec(String(text || ''));
  if (!m) return null;
  const [, minus, symbol, whole, frac, code] = m;
  const cents = toCents(whole, frac);
  if (cents === null) return null;
  const fromSymbol = (CURRENCY_SYMBOLS.find(([s]) => s === symbol) || [null, 'USD'])[1];
  return { cents, currency: code || fromSymbol, negative: !!minus };
}

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};
const pad2 = (n) => String(n).padStart(2, '0');

function ymd(y, m, d) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const t = new Date(Date.UTC(year, month - 1, day));
  if (t.getUTCMonth() !== month - 1) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

const monthOf = (word) => MONTHS[String(word || '').toLowerCase().replace(/\.$/, '')] || null;

// "October 15, 2026", "Oct 19, 2026", "Oct. 19 2026", "Friday, 25 September
// 2026", "25 Sep 2026", "2026-11-02". The first date found in the text.
function dateIn(text) {
  const s = String(text || '');
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  const candidates = [];
  if (m) candidates.push({ at: m.index, v: ymd(m[1], m[2], m[3]) });
  const nameFirst = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
  while ((m = nameFirst.exec(s))) {
    const month = monthOf(m[1]);
    if (month) { candidates.push({ at: m.index, v: ymd(m[3], month, m[2]) }); break; }
  }
  const dayFirst = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g;
  while ((m = dayFirst.exec(s))) {
    const month = monthOf(m[2]);
    if (month) { candidates.push({ at: m.index, v: ymd(m[3], month, m[1]) }); break; }
  }
  const good = candidates.filter((c) => c.v).sort((a, b) => a.at - b.at);
  return good.length ? good[0].v : null;
}

// "Sep 15\u2013Oct 15, 2026", "Dec 15, 2026 \u2013 Jan 15, 2027": the period
// a charge covers, as Stripe prints it above the items it covers.
const RANGE = /^([A-Za-z]{3,9})\.?\s(\d{1,2})(?:,\s(\d{4}))?\s*[\u2013\u2014-]\s*([A-Za-z]{3,9})\.?\s(\d{1,2}),\s(\d{4})$/;

function rangeOf(line) {
  const m = RANGE.exec(String(line || '').trim());
  if (!m) return null;
  const m1 = monthOf(m[1]);
  const m2 = monthOf(m[4]);
  if (!m1 || !m2) return null;
  const y2 = Number(m[6]);
  const y1 = m[3] ? Number(m[3]) : (m1 > m2 ? y2 - 1 : y2);
  const start = ymd(y1, m1, m[2]);
  const end = ymd(y2, m2, m[5]);
  return start && end && start <= end ? { start, end } : null;
}

function daysBetween(a, b) {
  const t = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86400000);
}

// How often a charge recurs, from the period it covers. A period that is
// neither about a month, a quarter nor a year says nothing.
function cadenceOfPeriod(period) {
  if (!period) return null;
  const days = daysBetween(period.start, period.end);
  if (days >= 26 && days <= 33) return 'monthly';
  if (days >= 85 && days <= 95) return 'quarterly';
  if (days >= 360 && days <= 370) return 'yearly';
  return null;
}

// The words a product name carries about how often it renews.
function cadenceOfWords(text) {
  const s = String(text || '');
  if (/\b(annual|annually|yearly|1 year|per year|a year)\b/i.test(s)) return 'yearly';
  if (/\b(quarterly|3 months)\b/i.test(s)) return 'quarterly';
  if (/\b(monthly|1 month|per month|a month)\b/i.test(s)) return 'monthly';
  return null;
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The calendar month before the one a date falls in, as a period.
function monthBefore(ymdStr) {
  if (!ymdStr) return null;
  let y = Number(ymdStr.slice(0, 4));
  let m = Number(ymdStr.slice(5, 7)) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}` };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Hosts that carry a payment processor's own links, never the merchant's.
const PROCESSOR_HOST = /(^|\.)(stripe\.com|stripe-images\.s3\.amazonaws\.com|fastspring\.com|onfastspring\.com|apple\.com|mzstatic\.com|google\.com|gstatic\.com|googleusercontent\.com|paypal\.com|paypalobjects\.com|cloudflare\.com|example\.invalid)$/i;

// The merchant's own website: a Stripe receipt links its logo to it, before
// any of Stripe's own links.
function siteOf(html) {
  const re = /<a\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"'#?\s/]+)[^"']*["']/gi;
  let m;
  let seen = 0;
  while ((m = re.exec(String(html || '').slice(0, MAX_BODY_CHARS))) && seen < 40) {
    seen += 1;
    const host = m[1].replace(/^https?:\/\//i, '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
    if (!PROCESSOR_HOST.test(host)) return host;
  }
  return null;
}

// The line after the one that is exactly `label` (or that starts with it and
// carries the value on the same line), read as money.
function moneyAfter(lines, label, from = 0) {
  const re = new RegExp(`^${label}\\s*:?\\s*(.*)$`, 'i');
  for (let i = from; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const same = m[1] ? moneyLine(m[1]) || moneyIn(m[1]) : null;
    if (same) return { ...same, index: i };
    for (let j = i + 1; j <= i + 2 && j < lines.length; j += 1) {
      const next = moneyLine(lines[j]);
      if (next) return { ...next, index: j };
    }
  }
  return null;
}

function lineAfter(lines, label) {
  const re = new RegExp(`^${label}\\s*:?\\s*(.*)$`, 'i');
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    if (m[1]) return m[1].trim();
    if (i + 1 < lines.length) return lines[i + 1];
  }
  return null;
}

const clip = (s, n) => (s ? String(s).trim().slice(0, n) : null);

// Each item's share of the tax, in proportion to its price, rounded so the
// shares add up to the tax to the cent (largest remainder).
function shareTax(prices, taxCents) {
  const total = prices.reduce((s, p) => s + p, 0);
  if (!(taxCents > 0) || !(total > 0)) return prices.map(() => 0);
  const exact = prices.map((p) => (p * taxCents) / total);
  const shares = exact.map(Math.floor);
  let left = taxCents - shares.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares;
}

const receipt = (fields) => ({ kind: 'receipt', refund: false, site: null, reference: null, ...fields });
const notReceipt = (why) => ({ kind: 'not_receipt', why });
const unreadable = (why) => ({ kind: 'unreadable', why });

// ---------------------------------------------------------------------------
// STRIPE: "Receipt from <merchant>", the amount, "Paid on <date>", then the
// items under the period they cover, and "Amount paid" at the foot. One bill
// per receipt: what the receipt says was paid.
// ---------------------------------------------------------------------------

function looksLikeStripe(mail, lines) {
  return /\bst-Email\b/.test(mail.html || '')
    || lines.some((l) => /^(Receipt|Refund) from .+/i.test(l))
    || /^your (receipt|refund) from /i.test(mail.subject || '');
}

function stripeItems(lines) {
  const start = lines.findIndex((l) => /^Receipt #/i.test(l));
  if (start === -1) return [];
  const items = [];
  let cur = null;
  let period = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^(Subtotal|Total|Total excluding tax|Amount paid|Amount due|Amount refunded)$/i.test(l)) break;
    const r = rangeOf(l);
    if (r) { period = r; cur = null; continue; }
    if (/^Qty\s+[\d,.]+$/i.test(l)) continue;
    if (/\beach$/i.test(l)) continue;
    const money = moneyLine(l);
    if (money) {
      if (cur && cur.amountCents === null) cur.amountCents = (money.negative ? -1 : 1) * money.cents;
      continue;
    }
    cur = { description: l, amountCents: null, period };
    items.push(cur);
  }
  return items.filter((x) => x.amountCents !== null);
}

// The item that names what is being paid for: a plan or a subscription when
// there is one, otherwise the largest charge.
function mainItem(items) {
  const charged = items.filter((x) => x.amountCents > 0);
  const plan = charged.find((x) => /\b(plan|subscription|membership|licen[cs]e)\b/i.test(x.description));
  if (plan) return plan;
  return charged.sort((a, b) => b.amountCents - a.amountCents)[0] || null;
}

function parseStripe(mail) {
  const fromHtml = mail.html ? htmlToLines(mail.html) : [];
  const fromText = mail.text ? textLines(mail.text) : [];
  const lines = fromHtml.some((l) => /^Receipt from /i.test(l)) || !fromText.length ? fromHtml : fromText;
  const subject = String(mail.subject || '');
  const refund = /^your refund from /i.test(subject) || lines.some((l) => /^Refund from /i.test(l));
  if (/\b(unsuccessful|failed|declined|upcoming (invoice|payment)|payment due|past due|action required)\b/i.test(subject)) {
    return notReceipt('a payment notice, not a charge');
  }
  let merchant = null;
  for (const l of lines) {
    const m = /^(?:Receipt|Refund) from (.+)$/i.exec(l);
    if (m) { merchant = m[1].trim(); break; }
  }
  if (!merchant) {
    const m = /(?:receipt|refund) from (.+?)(?:\s+#[\w-]+)?\s*$/i.exec(subject);
    if (m) merchant = m[1].trim();
  }
  if (!merchant) merchant = mail.fromName || null;
  const head = lines.findIndex((l) => /^(?:Receipt|Refund) from /i.test(l));
  const total = moneyAfter(lines, 'Amount paid') || moneyAfter(lines, 'Amount refunded')
    || moneyAfter(lines, 'Total')
    || (head !== -1 ? (() => {
      for (let i = head + 1; i < Math.min(lines.length, head + 3); i += 1) {
        const v = moneyLine(lines[i]);
        if (v) return v;
      }
      return null;
    })() : null);
  let paidOn = null;
  for (const l of lines) {
    const m = /^(?:Paid|Refunded)(?: on)? (.+?)(?: with\b.*)?$/i.exec(l);
    if (m) { paidOn = dateIn(m[1]); if (paidOn) break; }
  }
  if (!paidOn) {
    const d = lineAfter(lines, 'Date paid');
    paidOn = d ? dateIn(d) : null;
  }
  const refLine = lines.find((l) => /^Receipt #\s?[\w-]+$/i.test(l));
  const reference = refLine ? refLine.replace(/^Receipt #\s?/i, '') : clip(lineAfter(lines, 'Receipt number'), 80);
  const items = stripeItems(lines);
  const period = (items.find((x) => x.period) || {}).period
    || lines.map(rangeOf).find(Boolean) || null;
  if (!total || !paidOn) {
    if (!merchant && !total) return notReceipt('no receipt figures');
    return unreadable(!total ? 'the amount paid could not be found' : 'the date paid could not be found');
  }
  const main = mainItem(items);
  return receipt({
    format: 'stripe',
    merchant: clip(merchant, 80),
    site: siteOf(mail.html),
    paidOn,
    currency: total.currency,
    totalCents: total.cents,
    reference: clip(reference, 80),
    refund,
    bills: [{
      title: clip(merchant, 80),
      product: clip(main ? main.description : merchant, 120),
      amountCents: total.cents,
      cadence: period ? cadenceOfPeriod(period) : 'one_time',
      periodStart: period ? period.start : null,
      periodEnd: period ? period.end : null,
      renewsOn: null,
      inApp: false,
    }],
  });
}

// ---------------------------------------------------------------------------
// THE APP STORE. Two layouts are in use. The older is a table with a copy of
// itself for phones further down (class aapl-mobile-div), so only the part
// before that copy is read. The newer puts each item in its own lockup table.
// Either way an item is its app's name, then its product ("Plus (Monthly)",
// "Usage Credits (50)"), then a renewal line, the type and the device, then
// its price. One bill per item, each with its share of the tax.
// ---------------------------------------------------------------------------

// Lines inside an item that are never its product.
const APPLE_META = /^(Renews|Renewal|Renewed|Expires|Expired|Ends|Ended|In-App Purchase|Report a Problem|Write a Review|Free Trial|Trial|Cancel|Manage)\b/i;

function appleItem(chunkLines) {
  if (!chunkLines.length) return null;
  const stop = chunkLines.findIndex((l) => /^(Subtotal|Billing and Payment|TOTAL)$/i.test(l));
  const lines = stop === -1 ? chunkLines : chunkLines.slice(0, stop);
  if (!lines.length) return null;
  const title = lines[0];
  const rest = lines.slice(1);
  const prices = rest.map(moneyLine).filter(Boolean);
  if (!prices.length) return null;
  const price = prices[prices.length - 1];
  const subtitle = rest.find((l) => !APPLE_META.test(l) && !moneyLine(l)) || null;
  const renewLine = rest.find((l) => /^Renews\b/i.test(l));
  const inApp = rest.some((l) => /^In-App Purchase$/i.test(l));
  return { title, subtitle, price, renewsOn: renewLine ? dateIn(renewLine) : null, inApp };
}

// "Example Chat Plus (Monthly)" is the product "Example Chat Plus"; "Annual"
// alone is how often the app's own name renews.
function appleProduct(title, subtitle) {
  const cleaned = String(subtitle || '')
    .replace(/\((monthly|annual|yearly|weekly|quarterly|1 month|1 year|3 months)\)/gi, ' ')
    .replace(/\s+-\s+(monthly|annual|yearly|weekly)\s*$/i, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!cleaned || /^(monthly|annual|yearly|weekly|quarterly)$/i.test(cleaned)) return title;
  return cleaned;
}

function parseApple(mail) {
  const html = String(mail.html || '').slice(0, MAX_BODY_CHARS);
  const subject = String(mail.subject || '');
  if (!/receipt/i.test(subject) && !/>\s*Receipt\s*</i.test(html)) return notReceipt('an App Store notice, not a receipt');
  let items = [];
  let lines;
  if (/aapl-desktop-div|aapl-mobile-div/i.test(html)) {
    const desk = html.split(/<div\b[^>]*class\s*=\s*["'][^"']*aapl-mobile-div/i)[0];
    lines = htmlToLines(desk);
    const parts = desk.split(/<span\b[^>]*class\s*=\s*["'][^"']*\btitle\b[^"']*["'][^>]*>/i).slice(1);
    items = parts.map((p) => appleItem(htmlToLines(`<span>${p}`))).filter(Boolean);
  } else {
    lines = htmlToLines(html);
    // Each lockup is one table holding one item, so an item ends where its
    // table does.
    const parts = html.split(/<table\b[^>]*class\s*=\s*["'][^"']*\blockup\b[^"']*["'][^>]*>/i).slice(1);
    items = parts.map((p) => appleItem(htmlToLines(p.split(/<\/table>/i)[0]))).filter(Boolean);
  }
  if (!items.length) return unreadable('no item could be read on the App Store receipt');
  const dateText = lineAfter(lines, 'DATE');
  let paidOn = dateText ? dateIn(dateText) : null;
  if (!paidOn) {
    const head = lines.findIndex((l) => /^Receipt$/i.test(l));
    for (let i = Math.max(0, head); i < Math.min(lines.length, head + 6); i += 1) {
      paidOn = dateIn(lines[i]);
      if (paidOn) break;
    }
  }
  const order = lineAfter(lines, 'ORDER ID') || lineAfter(lines, 'Order ID');
  const subtotal = moneyAfter(lines, 'Subtotal');
  const subIdx = subtotal ? subtotal.index : 0;
  const tax = moneyAfter(lines, 'Tax', subIdx);
  const labelled = moneyAfter(lines, 'TOTAL', subIdx);
  if (!paidOn) return unreadable('the date on the App Store receipt could not be found');
  const prices = items.map((x) => x.price.cents);
  const itemSum = prices.reduce((s, p) => s + p, 0);
  const taxCents = tax ? tax.cents : 0;
  const totalCents = labelled ? labelled.cents : itemSum + taxCents;
  if (subtotal && subtotal.cents !== itemSum) return unreadable('the App Store items do not add up to the subtotal');
  const shares = shareTax(prices, taxCents);
  return receipt({
    format: 'apple',
    merchant: 'Apple',
    paidOn,
    currency: items[0].price.currency,
    totalCents,
    reference: clip(order, 80),
    bills: items.map((x, i) => {
      const cadence = x.inApp ? 'one_time' : (cadenceOfWords(x.subtitle) || cadenceOfWords(x.title) || null);
      return {
        title: clip(x.title, 80),
        product: clip(appleProduct(x.title, x.subtitle), 120),
        amountCents: x.price.cents + shares[i],
        cadence,
        periodStart: null,
        periodEnd: null,
        renewsOn: x.renewsOn,
        inApp: x.inApp,
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// GOOGLE PAYMENTS. A Cloud payment reads "Your payment amount of $8.18 to
// Google was received on Nov 1, 2026. Payment for: Google Cloud". Google bills
// Cloud on the 1st for the month before, so that month is the period. Other
// Google purchases ("You've made a purchase from Google") are read too, and
// the inbox decides what they are.
// ---------------------------------------------------------------------------

function parseGooglePayment(mail) {
  const lines = mail.text ? textLines(mail.text) : htmlToLines(mail.html);
  const flat = lines.join(' ');
  const paid = /Your payment amount of (.+?) to Google was received on (.+?\d{4})/i.exec(flat);
  if (paid) {
    const money = moneyIn(paid[1]);
    const paidOn = dateIn(paid[2]);
    if (!money || !paidOn) return unreadable('the Google payment could not be read');
    const forWhat = /Payment for:\s*(.+?)(?:\s+Payment ID:|\s+Payment method:|$)/i.exec(flat);
    const ref = /Payment ID:\s*([A-Z]+\s+[A-Za-z0-9]+)/.exec(flat);
    const product = forWhat ? forWhat[1].trim() : 'Google';
    const cloud = /google cloud/i.test(product);
    const period = cloud ? monthBefore(paidOn) : null;
    return receipt({
      format: 'google',
      merchant: 'Google',
      paidOn,
      currency: money.currency,
      totalCents: money.cents,
      reference: clip(ref ? ref[1] : null, 80),
      bills: [{
        title: clip(product, 80),
        product: clip(product, 120),
        amountCents: money.cents,
        cadence: cloud ? 'usage' : null,
        periodStart: period ? period.start : null,
        periodEnd: period ? period.end : null,
        renewsOn: null,
        inApp: false,
      }],
    });
  }
  if (/You've made a purchase from Google/i.test(flat)) {
    const total = /Total\s*(\$[\d,]+\.\d{2})/i.exec(flat);
    const item = /Item Quantity Price (.+?) \d+ \$[\d,]+\.\d{2}/i.exec(flat);
    const money = total ? moneyIn(total[1]) : null;
    const paidOn = dateIn(flat) || mail.dateYmd || null;
    if (!money || !paidOn) return unreadable('the Google purchase could not be read');
    const product = item ? item[1].trim() : 'Google purchase';
    return receipt({
      format: 'google',
      merchant: 'Google',
      paidOn,
      currency: money.currency,
      totalCents: money.cents,
      bills: [{ title: clip(product, 80), product: clip(product, 120), amountCents: money.cents, cadence: 'one_time', periodStart: null, periodEnd: null, renewsOn: null, inApp: false }],
    });
  }
  // Google's own words for a payment, in a layout this does not know: a
  // person looks, rather than the payment being dropped as a notice.
  if (/payment received|received your payment/i.test(`${flat} ${mail.subject || ''}`)) {
    return unreadable('the Google payment could not be read');
  }
  return notReceipt('a Google payments notice, not a payment');
}

// ---------------------------------------------------------------------------
// FASTSPRING: "Your Order", each item as "<name> \u2013 $30.00 x 1", then
// "Tax:" and "Total:". The receipt carries no date, so the email's own date is
// the day it was paid.
// ---------------------------------------------------------------------------

function parseFastSpring(mail) {
  const lines = mail.text ? textLines(mail.text) : htmlToLines(mail.html);
  const flat = lines.join('\n');
  const total = moneyAfter(lines, 'Total');
  if (!total) return /order|receipt/i.test(mail.subject || '') ? unreadable('the FastSpring total could not be found') : notReceipt('a FastSpring notice, not a receipt');
  const items = [];
  for (const l of lines) {
    const m = new RegExp(`^(.+?)\\s+[\u2013\u2014-]\\s+(${SYMBOL})\\s?${AMOUNT}\\s*x\\s*(\\d+)$`).exec(l);
    if (m) items.push({ name: m[1].trim(), cents: toCents(m[3], m[4]) });
  }
  if (!items.length) {
    // The HTML puts the name in a heading and the price beside "x 1".
    const all = htmlToLines(mail.html);
    const at = all.findIndex((l) => /^Your Order$/i.test(l));
    if (at !== -1 && all[at + 1]) items.push({ name: all[at + 1], cents: null });
  }
  const ref = /Order Reference:\s*([\w-]+)/i.exec(flat);
  const statement = /appear on your bill as FS \*(\S+)/i.exec(flat);
  const merchant = clip(String(mail.fromName || '').trim() || (statement ? statement[1] : 'FastSpring'), 80);
  const product = items.length ? items[0].name : merchant;
  const subscription = /subscription/i.test(`${product} ${flat}`);
  const paidOn = mail.dateYmd || null;
  if (!paidOn) return unreadable('the FastSpring receipt has no date');
  return receipt({
    format: 'fastspring',
    merchant,
    paidOn,
    currency: total.currency,
    totalCents: total.cents,
    reference: clip(ref ? ref[1] : null, 80),
    bills: [{
      title: merchant,
      product: clip(product, 120),
      amountCents: total.cents,
      cadence: subscription ? (cadenceOfWords(product) || null) : 'one_time',
      periodStart: null,
      periodEnd: null,
      renewsOn: null,
      inApp: false,
    }],
  });
}

// ---------------------------------------------------------------------------
// CLOUDFLARE: "Your invoice is available", "Invoice ID", "Due date" and
// "Amount". The card on file is charged on the due date. The notice does not
// say what the invoice is for.
// ---------------------------------------------------------------------------

function parseCloudflare(mail) {
  const lines = mail.text ? textLines(mail.text) : htmlToLines(mail.html);
  const flat = lines.join(' ');
  if (!/invoice/i.test(flat)) return notReceipt('a Cloudflare notice, not an invoice');
  const amount = moneyAfter(lines, 'Amount');
  const due = /Due date:\s*(.+?\d{4})/i.exec(flat);
  const id = /Invoice ID:\s*([A-Z]{2}-\d+)/i.exec(flat);
  const paidOn = (due && dateIn(due[1])) || mail.dateYmd || null;
  if (!amount) return unreadable('the Cloudflare invoice amount could not be found');
  if (!paidOn) return unreadable('the Cloudflare invoice has no date');
  return receipt({
    format: 'cloudflare',
    merchant: 'Cloudflare',
    paidOn,
    currency: amount.currency,
    totalCents: amount.cents,
    reference: clip(id ? id[1] : null, 80),
    bills: [{ title: 'Cloudflare', product: 'Cloudflare invoice', amountCents: amount.cents, cadence: null, periodStart: null, periodEnd: null, renewsOn: null, inApp: false }],
  });
}

// ---------------------------------------------------------------------------
// A SHOP'S ORDER EMAIL, the fallback for every other sender on the list: an
// order total, an order date or the email's own date, an order number and the
// first item. A one-time charge. Shipping and delivery notices are not
// charges.
// ---------------------------------------------------------------------------

function parseShopOrder(mail) {
  const subject = String(mail.subject || '');
  if (/\b(shipped|on its way|out for delivery|delivered|tracking|shipment)\b/i.test(subject)) {
    return notReceipt('a shipping notice, not a charge');
  }
  const lines = mail.text ? textLines(mail.text) : htmlToLines(mail.html);
  const total = moneyAfter(lines, '(?:Order total|Grand total|Total paid|Amount paid|Total)');
  if (!total) {
    const anyMoney = lines.some((l) => moneyIn(l));
    return anyMoney && /\b(receipt|order|invoice|payment|paid)\b/i.test(subject)
      ? unreadable('the order total could not be found')
      : notReceipt('no order total');
  }
  const dated = lineAfter(lines, '(?:- )?Order date');
  const bracket = lines.map((l) => /\[Order #[\w-]+\]\s*\((.+?)\)/i.exec(l)).find(Boolean);
  const paidOn = (dated && dateIn(dated)) || (bracket && dateIn(bracket[1])) || mail.dateYmd || null;
  if (!paidOn) return unreadable('the order has no date');
  const refMatch = lines.map((l) => /(?:Salesorder|Order)\s*(?:#|number|no\.?)\s*:?\s*#?([A-Za-z0-9-]{3,})/i.exec(l)).find(Boolean);
  let product = null;
  for (const l of lines) {
    const m = /^\d+\s*x\s*(?:#\d+\s+)?(.+?)\s*=\s*\$?[\d,]+\.\d{2}$/i.exec(l);
    if (m) { product = m[1]; break; }
  }
  if (!product) {
    const head = lines.findIndex((l) => /^Price$/i.test(l));
    if (head !== -1 && lines[head + 1] && !moneyLine(lines[head + 1])) product = lines[head + 1];
  }
  const merchant = clip(String(mail.fromName || '').replace(/\s+(Sales|Store|Shop|Support|Orders)$/i, '').trim() || null, 80);
  return receipt({
    format: 'order',
    merchant,
    paidOn,
    currency: total.currency,
    totalCents: total.cents,
    reference: clip(refMatch ? refMatch[1] : null, 80),
    bills: [{ title: merchant, product: clip(product || subject || merchant, 120), amountCents: total.cents, cadence: 'one_time', periodStart: null, periodEnd: null, renewsOn: null, inApp: false }],
  });
}

// ---------------------------------------------------------------------------
// The dispatcher. The sender picks the layout where it is one company's own
// mail; Stripe's layout is recognised by its words, because merchants send it
// from their own domains too.
// ---------------------------------------------------------------------------

function parseReceipt(mail) {
  const m = mail || {};
  const from = String(m.fromAddress || '').toLowerCase();
  const domain = from.slice(from.lastIndexOf('@') + 1);
  try {
    if (/(^|\.)apple\.com$/.test(domain)) return parseApple(m);
    if (from === 'payments-noreply@google.com') return parseGooglePayment(m);
    if (/(^|\.)fastspring\.com$/.test(domain)) return parseFastSpring(m);
    if (/(^|\.)cloudflare\.com$/.test(domain)) return parseCloudflare(m);
    const htmlLines = m.html ? htmlToLines(m.html) : [];
    if (/(^|\.)stripe\.com$/.test(domain) || looksLikeStripe(m, htmlLines)) return parseStripe(m);
    return parseShopOrder(m);
  } catch (err) {
    return unreadable(`the receipt could not be read (${(err && err.name) || 'error'})`);
  }
}

module.exports = {
  parseReceipt,
  htmlToLines,
  textLines,
  decodeEntities,
  moneyLine,
  moneyIn,
  dateIn,
  rangeOf,
  cadenceOfPeriod,
  monthBefore,
  shareTax,
  siteOf,
  __testing: { parseStripe, parseApple, parseGooglePayment, parseFastSpring, parseCloudflare, parseShopOrder, appleProduct },
};
