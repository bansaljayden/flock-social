// Run: node --test  (from backend/)
//
// RECEIPTS, READ (services/receiptParsers.js).
//
// Every layout the money hub reads off a forwarded receipt, each fixture built
// from a real receipt with every personal detail replaced
// (__tests__/fixtures/receipts/index.json says what was replaced). What is
// pinned for each: the amount that left the account (tax in), the day it was
// paid, the period it covers where the receipt states one, how often it
// recurs, and what it was for. And what is not read: the payer's name,
// address, card digits and device never appear in anything a parser returns.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../services/receiptParsers');

const DIR = path.join(__dirname, 'fixtures', 'receipts');
const INDEX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const nyDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

function mail(name, over = {}) {
  const f = INDEX[name];
  assert.ok(f, `no fixture named ${name}`);
  return {
    fromAddress: f.from,
    fromName: f.fromName,
    subject: f.subject,
    html: f.html ? fs.readFileSync(path.join(DIR, f.html), 'utf8') : null,
    text: f.text ? fs.readFileSync(path.join(DIR, f.text), 'utf8') : null,
    dateYmd: nyDate(f.date),
    ...over,
  };
}
const read = (name, over) => P.parseReceipt(mail(name, over));

// ---------------------------------------------------------------------------
// Stripe, the layout most of the bills share
// ---------------------------------------------------------------------------

test('a Stripe subscription receipt: the amount paid with tax, the day, the period and the plan', () => {
  const r = read('stripe-subscription');
  assert.equal(r.kind, 'receipt');
  assert.equal(r.format, 'stripe');
  assert.equal(r.merchant, 'Example Labs, PBC');
  assert.equal(r.site, 'example-labs.test', 'the merchant links its own site above the receipt');
  assert.equal(r.paidOn, '2026-10-13');
  assert.equal(r.totalCents, 21200, '$200.00 plus $12.00 tax is what left the account');
  assert.equal(r.reference, '1000-4001');
  assert.deepEqual(r.bills, [{
    title: 'Example Labs, PBC', product: 'Max plan - 20x', amountCents: 21200, cadence: 'monthly',
    periodStart: '2026-10-13', periodEnd: '2026-11-13', renewsOn: null, inApp: false,
  }]);
});

test('Railway through Stripe: the total after the plan\'s included usage, for the usage period', () => {
  const r = read('stripe-railway');
  assert.equal(r.merchant, 'Railway Corporation');
  assert.equal(r.site, 'railway.com');
  assert.equal(r.paidOn, '2026-10-15');
  assert.equal(r.totalCents, 4299, 'Amount paid, after "-$20.00" of included usage, not the $62.99 subtotal');
  const [bill] = r.bills;
  // Two periods are printed: the usage just billed, then the plan paid
  // ahead. The bill is for the first, the way the cost model words it.
  assert.equal(bill.periodStart, '2026-09-15');
  assert.equal(bill.periodEnd, '2026-10-15');
  assert.equal(bill.cadence, 'monthly');
  assert.equal(bill.product, 'Pro plan', 'the plan names the bill, not its largest usage line');
});

test('a usage invoice through Stripe names the merchant\'s own site, so the brand can be found', () => {
  const r = read('stripe-usage');
  assert.equal(r.merchant, 'Nevercode Ltd');
  assert.equal(r.site, 'codemagic.io');
  assert.equal(r.totalCents, 13015);
  assert.equal(r.paidOn, '2026-10-02');
  assert.equal(r.bills[0].periodStart, '2026-09-02');
  assert.equal(r.bills[0].periodEnd, '2026-10-01');
  assert.equal(r.bills[0].product, 'macOS M2 minutes personal use (per minute)');
});

test('a Stripe receipt with no period is a one-time charge', () => {
  const r = read('stripe-one-time');
  assert.equal(r.totalCents, 9540);
  assert.equal(r.paidOn, '2026-10-09', '"Paid October 9, 2026", without "on"');
  assert.equal(r.reference, '1000-5001');
  assert.equal(r.bills[0].cadence, 'one_time');
  assert.equal(r.bills[0].periodStart, null);
});

test('a Stripe refund is marked a refund, and a failed or upcoming payment is no receipt', () => {
  const m = mail('stripe-one-time');
  const refund = P.parseReceipt({ ...m, subject: 'Your refund from Example Labs, PBC #1000-5001', html: m.html.replace('Receipt from Example Labs', 'Refund from Example Labs') });
  assert.equal(refund.kind, 'receipt');
  assert.equal(refund.refund, true);
  for (const subject of ['Your payment to Railway Corporation was unsuccessful', 'Upcoming invoice from Example Labs, PBC']) {
    assert.equal(P.parseReceipt({ ...m, subject }).kind, 'not_receipt', subject);
  }
});

test('a Stripe receipt whose figures are gone is for a person to check, not dropped', () => {
  const m = mail('stripe-subscription');
  const r = P.parseReceipt({ ...m, html: m.html.replace(/\$\d[\d,]*\.\d{2}/g, 'see attached') });
  assert.equal(r.kind, 'unreadable');
  assert.match(r.why, /amount/);
});

// ---------------------------------------------------------------------------
// The App Store: one bill per item, each with its share of the tax
// ---------------------------------------------------------------------------

test('the older App Store table: each item once (not again from the phone copy), with its tax share', () => {
  const r = read('apple-table');
  assert.equal(r.format, 'apple');
  assert.equal(r.paidOn, '2026-10-19');
  assert.equal(r.reference, 'MTESTORDR01');
  assert.equal(r.totalCents, 6889);
  assert.equal(r.bills.length, 2, 'the hidden phone copy repeats both items and must not count them twice');
  const [sub, credits] = r.bills;
  assert.deepEqual(sub, {
    title: 'Example Chat', product: 'Example Chat Plus', amountCents: 2119, cadence: 'monthly',
    periodStart: null, periodEnd: null, renewsOn: '2026-11-17', inApp: false,
  });
  // $45.00 plus its share of the $3.90 tax: $2.70, so $47.70.
  assert.deepEqual(credits, {
    title: 'Example Assistant by Example Labs', product: 'Usage Credits (50)', amountCents: 4770, cadence: 'one_time',
    periodStart: null, periodEnd: null, renewsOn: null, inApp: true,
  });
  assert.equal(sub.amountCents + credits.amountCents, r.totalCents, 'the shares add up to the total to the cent');
});

test('the newer App Store lockups: two subscriptions, $49.99 and $3.00 tax shared in proportion', () => {
  const r = read('apple-lockup');
  assert.equal(r.paidOn, '2026-09-20');
  assert.deepEqual(r.bills.map((b) => [b.title, b.product, b.amountCents, b.cadence, b.renewsOn]), [
    ['Example Chat', 'Example Chat Plus', 2119, 'monthly', '2026-10-17'],
    ['Example Answers', 'Example Answers Pro', 3180, 'monthly', '2026-10-20'],
  ]);
  assert.equal(r.totalCents, 5299);
});

test('an annual App Store item whose subtitle only says "Annual" is named by its title', () => {
  const r = read('apple-lockup-annual');
  assert.deepEqual(r.bills.map((b) => [b.product, b.amountCents, b.cadence, b.renewsOn]), [
    ['Apple Developer Program', 10493, 'yearly', '2027-06-15'],
  ]);
});

test('an App Store notice that is not a receipt is no receipt', () => {
  const m = mail('apple-lockup');
  const r = P.parseReceipt({ ...m, subject: 'Your subscription is expiring', html: '<html><body><p>Your subscription to Example Chat Plus expires on October 20, 2026.</p></body></html>' });
  assert.equal(r.kind, 'not_receipt');
});

// ---------------------------------------------------------------------------
// Google, FastSpring, Cloudflare and shops
// ---------------------------------------------------------------------------

test('a Google Cloud payment is the month before it, as a usage bill', () => {
  const r = read('google-cloud-bill');
  assert.equal(r.format, 'google');
  assert.equal(r.paidOn, '2026-11-01');
  assert.equal(r.totalCents, 818);
  assert.equal(r.reference, 'CLOUD TEST01');
  assert.deepEqual(r.bills[0], {
    title: 'Google Cloud', product: 'Google Cloud', amountCents: 818, cadence: 'usage',
    periodStart: '2026-10-01', periodEnd: '2026-10-31', renewsOn: null, inApp: false,
  });
  assert.equal(read('google-notice').kind, 'not_receipt', 'a payment-method notice is no payment');
  const odd = mail('google-cloud-bill');
  assert.equal(P.parseReceipt({ ...odd, text: odd.text.replace('Your payment amount of', 'You paid') }).kind, 'unreadable',
    'a payment worded in a way this does not know is for a person to check, not dropped as a notice');
});

test('a FastSpring receipt: the total with tax, paid on the day the email left, in New York', () => {
  const r = read('fastspring-order');
  assert.equal(r.format, 'fastspring');
  assert.equal(r.merchant, 'MapTiler AG');
  assert.equal(r.totalCents, 3180);
  assert.equal(r.reference, 'TEST000000-0000-00001');
  assert.equal(r.paidOn, '2026-10-07', '03:10 UTC on Oct 8 is the evening of Oct 7 in New York');
  assert.equal(r.bills[0].product, 'MapTiler Cloud: Flex subscription');
  assert.equal(r.bills[0].cadence, null, 'a subscription whose interval the receipt does not say');
  const htmlOnly = read('fastspring-order', { text: null });
  assert.equal(htmlOnly.totalCents, 3180, 'the HTML part alone reads the same total');
  assert.equal(read('fastspring-activated').kind, 'not_receipt');
});

test('a Cloudflare invoice notice: the amount, charged on its due date', () => {
  const r = read('cloudflare-invoice');
  assert.equal(r.format, 'cloudflare');
  assert.equal(r.totalCents, 1046);
  assert.equal(r.paidOn, '2026-02-28');
  assert.equal(r.reference, 'IN-10000001');
});

test('shop orders: the order total and date, and a shipping notice is no second charge', () => {
  const pololu = read('pololu-order');
  assert.equal(pololu.format, 'order');
  assert.equal(pololu.merchant, 'Pololu');
  assert.equal(pololu.totalCents, 3805, 'the order total, shipping and tax in');
  assert.equal(pololu.paidOn, '2026-09-25', '"Friday, 25 September 2026"');
  assert.equal(pololu.reference, '1TEST0001');
  assert.match(pololu.bills[0].product, /^VL53L8CX Time-of-Flight/);
  assert.equal(pololu.bills[0].cadence, 'one_time');
  assert.equal(read('pololu-shipped').kind, 'not_receipt');
  const shop = read('shop-order');
  assert.equal(shop.merchant, 'PCB Artists');
  assert.equal(shop.totalCents, 8299);
  assert.equal(shop.paidOn, '2026-10-08');
  assert.equal(shop.reference, '7000');
  assert.equal(shop.bills[0].product, 'I2C Decibel Sound Level Meter Module - PRO');
});

// ---------------------------------------------------------------------------
// What is never read
// ---------------------------------------------------------------------------

test('nothing a parser returns carries the payer\'s name, address, card digits, device or account', () => {
  const personal = ['Account Holder', 'Account  Holder', 'Example Street', 'Example Town', '4242', 'Owner phone', 'owner@example.com', '0000000000'];
  for (const name of Object.keys(INDEX).filter((k) => !k.startsWith('_'))) {
    const out = JSON.stringify(read(name));
    for (const p of personal) assert.ok(!out.includes(p), `${name} returned "${p}"`);
  }
});

test('the fixtures carry no real personal details or tool names', () => {
  // The fixtures ship in the repository, so every word in them is checked
  // against what was replaced: the real payer's names, street and town, and
  // the vendor names the published code keeps out. Listed as SHA-256 digests
  // of the lower-case word, so this file does not publish them either.
  const crypto = require('node:crypto');
  const BANNED = new Set([
    'aebab271c16787051fe3e816237c07dabd04f02a6957f36a74276a990ce2fcb8',
    'eb98b8beb084708e2a363e755cb81d7273efd15d3130e296993f5e6a0f80bad5',
    '9f6717712ab6dd4cc1d86055e5eb210c13fed3e78c1d8eabd8736ebb055a9924',
    '484e2ea9a1d48fe08ad3dc3d927a86f72b62b2b01206c7ae8a23d4e37cd3b3e4',
    '05c5f6ef21bb02be3db6d066c4e822e07ef75b2f85241333a7cba5dec74e2d33',
    'c5156f39a155dc85b08f47cc4181d75f21af40420e2c54283156c06c1d48e04c',
    'c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d',
    'c70eca6b0f88f44d81a41311647e50fda1ac454ec04ffd442b0eb4743a993131',
    '60965168ce762e949600281ba6d01fee136e5b6e8257b1f216f9025ed324474c',
    '7d3194f79e645c42e4396dda38be04766810ec6a00d00aced3ffc2a0a1f1a9ef',
    'add92b9cde2bdbf3daaf65a0db79e9b1a7fa428b71b4d6ce38c742eb6dca0c1c',
    '782faac2e1aff56f344451429f660d818aa3ca5ac13bb8d095f1249cd7a9a1f7',
  ]);
  const digest = (w) => crypto.createHash('sha256').update(w).digest('hex');
  for (const file of fs.readdirSync(DIR)) {
    const body = fs.readFileSync(path.join(DIR, file), 'utf8').toLowerCase();
    for (const w of new Set(body.split(/[^a-z0-9]+/).filter(Boolean))) {
      assert.ok(!BANNED.has(digest(w)), `${file} carries a word that was supposed to be replaced`);
    }
  }
});

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

test('money: symbols, codes and signs, and a unit price or a quantity is not an amount', () => {
  assert.deepEqual(P.moneyLine('$42.99'), { cents: 4299, currency: 'USD', negative: false });
  assert.deepEqual(P.moneyLine('-$20.00'), { cents: 2000, currency: 'USD', negative: true });
  assert.deepEqual(P.moneyLine('$82.99 USD'), { cents: 8299, currency: 'USD', negative: false });
  assert.deepEqual(P.moneyLine('$1,234.50'), { cents: 123450, currency: 'USD', negative: false });
  assert.deepEqual(P.moneyLine('\u20ac12.50'), { cents: 1250, currency: 'EUR', negative: false });
  assert.deepEqual(P.moneyLine('CA$5.00'), { cents: 500, currency: 'CAD', negative: false });
  assert.equal(P.moneyLine('$0.000015 each'), null);
  assert.equal(P.moneyLine('Qty 1,370'), null);
  assert.equal(P.moneyLine('1370'), null, 'a bare number is a quantity');
  assert.deepEqual(P.moneyIn('Your payment amount of $8.18 to Google'), { cents: 818, currency: 'USD', negative: false });
});

test('dates as receipts print them, and the period a charge covers', () => {
  assert.equal(P.dateIn('Paid on October 15, 2026 with'), '2026-10-15');
  assert.equal(P.dateIn('Oct 19, 2026'), '2026-10-19');
  assert.equal(P.dateIn('Friday, 25 September 2026'), '2026-09-25');
  assert.equal(P.dateIn('received on Nov 2, 2026.'), '2026-11-02');
  assert.equal(P.dateIn('2026-11-02'), '2026-11-02');
  assert.equal(P.dateIn('Smarch 40, 2026'), null);
  assert.deepEqual(P.rangeOf('Sep 15\u2013Oct 15, 2026'), { start: '2026-09-15', end: '2026-10-15' });
  assert.deepEqual(P.rangeOf('Dec 15\u2013Jan 15, 2027'), { start: '2026-12-15', end: '2027-01-15' }, 'a period across New Year');
  assert.deepEqual(P.rangeOf('Dec 15, 2026 \u2013 Jan 15, 2027'), { start: '2026-12-15', end: '2027-01-15' });
  assert.equal(P.cadenceOfPeriod({ start: '2026-09-02', end: '2026-10-01' }), 'monthly');
  assert.equal(P.cadenceOfPeriod({ start: '2026-06-15', end: '2027-06-15' }), 'yearly');
  assert.deepEqual(P.monthBefore('2026-01-01'), { start: '2025-12-01', end: '2025-12-31' });
});

test('tax shares add up to the tax to the cent', () => {
  assert.deepEqual(P.shareTax([1999, 4500], 390), [120, 270]);
  assert.deepEqual(P.shareTax([100, 100, 100], 100), [34, 33, 33]);
  assert.deepEqual(P.shareTax([500], 0), [0]);
  const shares = P.shareTax([333, 333, 334], 7);
  assert.equal(shares.reduce((a, b) => a + b, 0), 7);
});

test('HTML becomes the lines a reader sees: styles out, entities decoded, padding gone', () => {
  const lines = P.htmlToLines('<style>p{color:red}</style><div>Total&nbsp;</div><td>$4.20</td><span>A&amp;B</span> \u034f \u034f<br>Caf&#233; &mdash; ok<!-- hidden -->');
  assert.deepEqual(lines, ['Total', '$4.20', 'A&B', 'Caf\u00e9 \u2014 ok']);
});
