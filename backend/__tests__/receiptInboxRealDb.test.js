// Run: node --test  (from backend/)
//
// RECEIPTS FROM THE OWNER'S GMAIL, ON A REAL DATABASE (2026-11-05).
//
// A Gmail filter forwards the receipts of the companies Flock pays to a
// receiving address at Resend, Resend posts email.received to the signed
// webhook, and services/receiptInbox.js reads each receipt back and records
// the bill. Every rule that decides what a receipt does is SQL or rides on it
// (the reconciled upsert, the expense list's bill key, the one-email-once
// key), so it is walked here through the real webhook route and admin routes
// on an embedded Postgres with every migration applied:
//
//   - the signature is checked before anything else, and Resend is not asked
//     about an event nobody signed;
//   - mail that is not the owner's forwarded receipt (not forwarded, forwarded
//     by another account or to another address, not handed over by Gmail, from
//     a sender off the list or with a failed signature, never addressed to the
//     owner, not sent to the receipts address) stores nothing and says why;
//   - one email is read once, however often it is delivered or forwarded;
//   - a Railway or Google Cloud receipt sets that line the way the dashboard's
//     form does, with the figure it replaces kept beside it, and never over a
//     newer figure; a second Google payment in a month waits for a person;
//   - each sender changes only what its list entry binds it to: no email's
//     words can set the Railway figure unless Railway's own account sent it;
//   - a receipt for a bill on the list moves that bill's last charge and
//     amount; a one-time charge from a vendor on the list is its own bill,
//     except a shop's order and an App Store purchase, which wait;
//   - the App Store's other purchases, a family's included, are never stored;
//   - a vendor the list has never seen waits, counted nowhere, until the
//     owner adds it or says it is not the company's;
//   - a receipt that cannot be read, or cannot be recorded, is kept by its
//     sender and subject alone, and the subject goes once it is checked.
//
// The Resend API is a stand-in that serves fixtures (__tests__/fixtures/
// receipts, real receipts with every personal detail replaced), with the
// headers Gmail puts on a filter's forward added here.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// "Today" is a fixed day after every fixture's date: a receipt dated after
// today is held back for a person, and the fixtures run from February to
// November 2026.
const { pinClock } = require('./helpers/pinnedClock');
pinClock(Date.parse('2026-11-20T17:00:00Z'));

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('receiptInboxRealDb');
const DB_NAME = 'flock_receipt_inbox_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-receipt-inbox';

// A signing secret of the shape Resend issues: 24 random bytes, enough of
// them different that the route takes it for a generated one.
let SVIX_KEY;
do { SVIX_KEY = crypto.randomBytes(24); } while (new Set(SVIX_KEY).size < 12);
process.env.RESEND_WEBHOOK_SECRET = `whsec_${SVIX_KEY.toString('base64')}`;
process.env.RESEND_API_KEY = 're_test_receipts_key';
// The fixtures' owner, written with dots the way Gmail lets an address be.
process.env.RECEIPTS_FORWARDED_BY = 'owneraccount@gmail.com';
delete process.env.RECEIPT_SENDERS;
delete process.env.RECEIPTS_INBOX_ADDRESS;

// The fixtures' Stripe senders stand in for the real ones the code lists, and
// are bound the same way: Railway's account sets the Railway line and nothing
// else, Codemagic's touches Codemagic's bills, the development tool's own
// billing address is matched by its merchant name.
const FIXTURE_SENDERS = [
  { address: 'invoice+statements+acct_1fixturerailway0@stripe.com', format: 'stripe', line: 'railway', label: 'Railway, through Stripe (fixture)' },
  { address: 'invoice+statements+acct_1fixturecodemag0@stripe.com', format: 'stripe', vendors: ['Codemagic', 'Nevercode'], label: 'Codemagic, through Stripe (fixture)' },
  { address: 'invoice+statements@mail.example-labs.test', format: 'stripe', label: 'a development tool, through Stripe (fixture)' },
];

const INBOX = 'receipts@fixture1105.resend.app';
const OWNER = 'owner.account@gmail.com';
const ENVELOPE = '<owneraccount+caf_=receipts=fixture1105.resend.app@gmail.com>';

const DIR = path.join(__dirname, 'fixtures', 'receipts');
const INDEX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const readFixture = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

// ---------------------------------------------------------------------------
// The Resend API, standing in: received emails by id, a count of the reads
// and the key each one carried, and a switch that makes the next reads fail.
// ---------------------------------------------------------------------------
const realFetch = global.fetch;
const resendStore = new Map();
let resendCalls = [];
let resendFailures = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.resend.com/')) return realFetch(url, opts);
  resendCalls.push({ url: u, auth: opts.headers && opts.headers.Authorization });
  if (resendFailures > 0) {
    resendFailures -= 1;
    return new Response(JSON.stringify({ name: 'internal_server_error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  const prefix = 'https://api.resend.com/emails/receiving/';
  const email = u.startsWith(prefix) ? resendStore.get(decodeURIComponent(u.slice(prefix.length))) : null;
  if (!email) return new Response(JSON.stringify({ name: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(email), { status: 200, headers: { 'content-type': 'application/json' } });
};

let pg;
let pool;
let dataDir;
let server;
let base;
let adminId;
let moneyHub;
let costModel;
let receiptInbox;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-receipt-inbox-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'receiptInboxRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  const { rows: [admin] } = await pool.query(
    "INSERT INTO users (email, password, name, email_verified, role) VALUES ('admin.receipts@example.com', 'x', 'Admin', true, 'admin') RETURNING id"
  );
  adminId = admin.id;
  const authMod = require('../middleware/auth');
  authMod.authenticate = (req, _res, next) => { req.user = { id: adminId, role: 'admin' }; next(); };
  moneyHub = require('../services/moneyHub');
  costModel = require('../services/costModel');
  receiptInbox = require('../services/receiptInbox');
  receiptInbox.__testing.addSenders(FIXTURE_SENDERS);
  const app = express();
  // The webhook gets the raw-body parser server.js gives it, so the signature
  // is checked against the bytes that were signed.
  app.use('/api/email-events', express.json({ limit: '256kb', verify: (req, _res, buf) => { req.rawBody = buf; } }), require('../routes/emailWebhook'));
  app.use(express.json());
  app.use('/api/admin', require('../routes/admin'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  global.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'receiptInboxRealDb');
});

test.beforeEach(async () => {
  await pool.query('DELETE FROM email_receipts WHERE id > 0');
  await pool.query('DELETE FROM business_expenses WHERE id > 0');
  await pool.query("DELETE FROM cost_reconciled WHERE line_id <> ''");
  resendStore.clear();
  resendCalls = [];
  resendFailures = 0;
  receiptInbox.__testing.resetIgnored();
});

// ---------------------------------------------------------------------------
// Building and posting
// ---------------------------------------------------------------------------
let seq = 0;

// A fixture as Resend serves it after Gmail forwarded it: the original From,
// To, Subject, Date and Message-ID, and the headers a filter's forward adds.
// `headers` entries replace those, and undefined removes one.
function forwarded(name, over = {}) {
  const f = INDEX[name];
  assert.ok(f, `no fixture named ${name}`);
  seq += 1;
  const id = `fixture-${seq}-${name}`;
  const messageId = over.messageId || `<fixture-${seq}-${name}@mail.example>`;
  const headers = {
    from: `"${f.fromName}" <${f.from}>`,
    to: f.to,
    subject: f.subject,
    date: f.date,
    'message-id': messageId,
    'delivered-to': INBOX,
    'x-forwarded-to': INBOX,
    'x-forwarded-for': `${OWNER} ${INBOX}`,
    'return-path': ENVELOPE,
    ...(over.headers || {}),
  };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  return {
    object: 'email',
    id,
    to: over.to || [f.to],
    from: over.from || f.from,
    created_at: '2026-11-20T16:00:00.000Z',
    subject: over.subject || f.subject,
    html: over.html !== undefined ? over.html : (f.html ? readFixture(f.html) : null),
    text: over.text !== undefined ? over.text : (f.text ? readFixture(f.text) : null),
    html_format: 'data_uri',
    headers,
    bcc: [],
    cc: [],
    reply_to: [],
    received_for: over.receivedFor || [INBOX],
    authentication: over.authentication === undefined ? { spf: 'pass', dkim: 'pass', dmarc: 'pass' } : over.authentication,
    message_id: messageId,
    raw: null,
    attachments: [],
  };
}

function eventFor(email) {
  return JSON.stringify({
    type: 'email.received',
    created_at: '2026-11-20T16:00:01.000Z',
    data: {
      email_id: email.id,
      created_at: email.created_at,
      from: email.from,
      to: email.to,
      bcc: [],
      cc: [],
      received_for: email.received_for,
      message_id: email.message_id,
      subject: email.subject,
      attachments: [],
    },
  });
}

function signedHeaders(body, key = SVIX_KEY) {
  const id = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

async function postEvent(body, headers) {
  const res = await realFetch(`${base}/api/email-events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// Serves the email at Resend and posts its signed event, the way a delivery
// arrives.
async function deliver(email) {
  resendStore.set(email.id, email);
  const body = eventFor(email);
  return postEvent(body, signedHeaders(body));
}

async function admin(method, url, body) {
  const res = await realFetch(`${base}/api/admin${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const receipts = () => q(`SELECT *, paid_on::text AS paid_on, period_start::text AS period_start, period_end::text AS period_end, previous_on::text AS previous_on FROM email_receipts ORDER BY id`);
const expenses = () => q(`SELECT *, last_charged_on::text AS last_charged_on, renews_on::text AS renews_on FROM business_expenses ORDER BY id`);
const reconciled = (id) => q(`SELECT line_id, usd_per_month::text AS usd, as_of::text AS as_of, note, updated_by, previous_usd_per_month::text AS prev_usd, previous_as_of::text AS prev_as_of FROM cost_reconciled WHERE line_id = $1`, [id]).then((r) => r[0] || null);

async function setReconciled(id, usd, asOf, note = 'set by the test') {
  await pool.query(
    `INSERT INTO cost_reconciled (line_id, usd_per_month, as_of, note, updated_at) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (line_id) DO UPDATE SET usd_per_month = EXCLUDED.usd_per_month, as_of = EXCLUDED.as_of, note = EXCLUDED.note`,
    [id, usd, asOf, note]
  );
}

async function bill(fields) {
  const row = moneyHub.expenseRowFromInput({ kind: 'tooling', verified: true, ...fields });
  const r = await pool.query(moneyHub.EXPENSE_INSERT_SQL, [...moneyHub.expenseParams(row), null]);
  return moneyHub.expenseFromRow(r.rows[0]);
}

const okay = (res, what) => assert.equal(res.status, 200, `${what || 'the delivery'} answered ${res.status} ${JSON.stringify(res.json)}`);

// ---------------------------------------------------------------------------
// The signature comes first
// ---------------------------------------------------------------------------

test('an unsigned or badly signed received event is refused before Resend is asked anything', async () => {
  const email = forwarded('stripe-railway');
  resendStore.set(email.id, email);
  const body = eventFor(email);
  assert.equal((await postEvent(body, {})).status, 400);
  assert.equal((await postEvent(body, signedHeaders(body, crypto.randomBytes(24)))).status, 401);
  const tampered = body.replace(email.id, `${email.id}x`);
  assert.equal((await postEvent(tampered, signedHeaders(body))).status, 401);
  assert.equal(resendCalls.length, 0, 'Resend was asked about an event nobody signed');
  assert.deepEqual(await receipts(), []);
});

// ---------------------------------------------------------------------------
// The reconciled lines
// ---------------------------------------------------------------------------

test('a Railway receipt sets the Railway figure the way the dashboard form does, keeping the one it replaces', async () => {
  await setReconciled('railway', 30.0, '2026-10-01', 'an estimate for the period');
  okay(await deliver(forwarded('stripe-railway')));
  const line = await reconciled('railway');
  assert.equal(line.usd, '42.99');
  assert.equal(line.as_of, '2026-10-15');
  assert.equal(line.prev_usd, '30.00', 'the figure it replaced is kept for the "up on the last bill" check');
  assert.equal(line.prev_as_of, '2026-10-01');
  assert.equal(line.updated_by, null, 'no person saved it');
  // costReconciled.test.js holds every line's note to the amount it shows.
  assert.ok(line.note.includes('$42.99'), line.note);
  assert.match(line.note, /Sep 15 to Oct 15, 2026/);
  const [r] = await receipts();
  assert.equal(r.status, 'applied');
  assert.equal(r.reconciled_line, 'railway');
  assert.equal(r.vendor, 'Railway');
  assert.equal(r.amount_cents, 4299);
  assert.equal(r.paid_on, '2026-10-15');
  assert.equal(r.period_start, '2026-09-15');
  assert.equal(r.period_end, '2026-10-15');
  assert.equal(r.previous_cents, 3000);
  assert.equal(r.previous_on, '2026-10-01');
  assert.equal(r.sender, 'invoice+statements+acct_1fixturerailway0@stripe.com');
  assert.equal(r.reference, '1000-2001');
  assert.equal(r.subject, null, 'a receipt that was read keeps no subject');
  assert.equal(resendCalls.length, 1);
  assert.equal(resendCalls[0].auth, 'Bearer re_test_receipts_key', 'the server key reads the received email');
  // The merged block the hub reads shows the receipt, and compares it with
  // the figure before it.
  const block = await costModel.readReconciled(pool);
  const rail = block.lines.find((l) => l.id === 'railway');
  assert.equal(rail.source, 'dashboard');
  assert.equal(rail.usdPerMonth, 42.99);
  assert.deepEqual(moneyHub.billJumps(block).find((j) => j.id === 'railway'), {
    id: 'railway', label: rail.label, fromCents: 3000, fromPeriod: null, toCents: 4299, toAsOf: '2026-10-15', pct: 43,
  });
});

test('the first save of a line keeps the code\'s figure as the one it replaced', async () => {
  // No saved row: a receipt newer than the code's figure is recorded over
  // it, and the code's figure becomes the one before, as on the form's first
  // save. November's bill, paid on the 15th.
  const code = costModel.RECONCILED.lines.find((l) => l.id === 'railway');
  const html = readFixture('stripe-railway.html').replace('October 15, 2026', 'November 15, 2026')
    .replace('Sep 15\u2013Oct 15, 2026', 'Oct 15\u2013Nov 15, 2026').replace(/1000-2001/g, '1000-2002');
  okay(await deliver(forwarded('stripe-railway', { html })));
  const line = await reconciled('railway');
  const [r] = await receipts();
  if (code.asOf <= '2026-11-15') {
    assert.equal(r.status, 'applied');
    assert.equal(line.usd, '42.99');
    assert.equal(line.as_of, '2026-11-15');
    assert.equal(line.prev_usd, code.usdPerMonth.toFixed(2));
    assert.equal(line.prev_as_of, code.asOf);
    assert.match(line.note, /for Oct 15 to Nov 15, 2026/);
  } else {
    // The code was moved on past this receipt since this test was written.
    assert.equal(r.status, 'older');
    assert.equal(line, null);
  }
});

test('a receipt older than the figure on the hub moves nothing', async () => {
  await setReconciled('railway', 33.4, '2026-11-05', 'estimate');
  okay(await deliver(forwarded('stripe-railway')));
  const line = await reconciled('railway');
  assert.equal(line.usd, '33.40');
  assert.equal(line.as_of, '2026-11-05');
  const [r] = await receipts();
  assert.equal(r.status, 'older');
  assert.match(r.reason, /newer Railway figure, from Nov 5, 2026/);
});

test('Google Cloud: the month\'s bill sets the line, a second payment that month waits for a person', async () => {
  await setReconciled('google-cloud', 18.63, '2026-10-01');
  okay(await deliver(forwarded('google-cloud-bill')));
  let line = await reconciled('google-cloud');
  assert.equal(line.usd, '8.18');
  assert.equal(line.as_of, '2026-11-01');
  assert.equal(line.prev_usd, '18.63');
  assert.ok(line.note.includes('$8.18'), line.note);
  assert.match(line.note, /for October 2026/);
  okay(await deliver(forwarded('google-cloud-second')));
  line = await reconciled('google-cloud');
  assert.equal(line.usd, '8.18', 'prepaid credit in the same month must not replace the bill');
  const rows = await receipts();
  assert.deepEqual(rows.map((r) => r.status), ['applied', 'to_check']);
  assert.match(rows[1].reason, /second Google Cloud payment in November 2026/);
  assert.equal(rows[1].amount_cents, 2000);
  // Any other Google payment is somebody's own: nothing is kept of it.
  const personal = readFixture('google-cloud-bill.txt').replace(/Google Cloud( Platform)?/g, 'Google One').replace(/CLOUD TEST01/g, 'ONE TEST09');
  okay(await deliver(forwarded('google-cloud-bill', { text: personal })));
  assert.equal((await receipts()).length, 2);
  assert.ok(receiptInbox.ignoredSinceStart().byReason.some((x) => x.reason === 'not_flock'));
});

test('only Railway\'s own account sets the Railway figure, and only with a month\'s bill', async () => {
  await setReconciled('railway', 30.0, '2026-10-01');
  // A shop's email carrying Stripe's words for Railway in its address lines
  // is read as that shop's order, which is all that sender can send.
  const shopHtml = readFixture('shop-order.html').replace('</body>', '<p>Receipt from Railway</p><p>Paid on November 19, 2026</p><p>Amount paid</p><p>$999.00</p></body>');
  okay(await deliver(forwarded('shop-order', { html: shopHtml })));
  // A Stripe receipt that says Railway from an address added in
  // RECEIPT_SENDERS can be a bill on the list at most, never the line.
  process.env.RECEIPT_SENDERS = 'invoice+statements+acct_1unlistedrailway@stripe.com';
  try {
    okay(await deliver(forwarded('stripe-railway', {
      from: 'invoice+statements+acct_1unlistedrailway@stripe.com',
      headers: { from: '"Railway Corporation" <invoice+statements+acct_1unlistedrailway@stripe.com>' },
    })));
  } finally {
    delete process.env.RECEIPT_SENDERS;
  }
  assert.equal((await reconciled('railway')).usd, '30.00', 'the Railway figure moved');
  assert.deepEqual((await receipts()).map((r) => [r.status, r.vendor, r.reconciled_line, r.amount_cents]), [
    ['new', 'PCB Artists', null, 8299],
    ['new', 'Railway Corporation', null, 4299],
  ]);
  // Railway's own account with a charge that covers no month: a person looks.
  const noPeriod = readFixture('stripe-railway.html').replace(/[A-Z][a-z]{2} \d{1,2}\u2013[A-Z][a-z]{2} \d{1,2}, \d{4}/g, '').replace(/1000-2001/g, '1000-2007');
  okay(await deliver(forwarded('stripe-railway', { html: noPeriod })));
  const last = (await receipts()).pop();
  assert.equal(last.status, 'to_check');
  assert.match(last.reason, /Railway charge with no billing period, so not the month's bill/);
  assert.equal((await reconciled('railway')).usd, '30.00');
});

// ---------------------------------------------------------------------------
// The expense list
// ---------------------------------------------------------------------------

test('a receipt for a bill on the list moves its last charge and amount, and nothing else on the row', async () => {
  const monthly = await bill({ vendor: 'Example Labs', product: 'Max (20x)', category: 'ai_tools', cadence: 'monthly', amountCents: 20000, lastChargedOn: '2026-09-13', renewsOn: '2026-10-13', note: 'typed by hand', verified: false });
  const once = await bill({ vendor: 'Example Labs', product: 'Prepaid extra usage', category: 'ai_tools', cadence: 'one_time', amountCents: 9540, lastChargedOn: '2026-09-06' });
  okay(await deliver(forwarded('stripe-subscription')));
  const [m, o] = await expenses();
  assert.equal(m.id, monthly.id);
  assert.equal(m.amount_cents, 21200);
  assert.equal(m.last_charged_on, '2026-10-13');
  assert.equal(m.verified, true, 'seen on a receipt now');
  assert.equal(m.renews_on, '2026-10-13', 'the renewal date is left to the hub, which steps it on');
  assert.equal(m.note, 'typed by hand');
  assert.equal(m.updated_by, null);
  assert.equal(o.last_charged_on, once.lastChargedOn, 'the one-time bill was not the monthly one');
  const [r] = await receipts();
  assert.equal(r.status, 'applied');
  assert.equal(r.expense_id, monthly.id);
  assert.equal(r.previous_cents, 20000);
  assert.equal(r.previous_on, '2026-09-13');
  // The same charge forwarded again under a new Message-ID is already on it.
  okay(await deliver(forwarded('stripe-subscription', { html: readFixture('stripe-subscription.html').replace(/1000-4001/g, '1000-4009') })));
  assert.deepEqual((await receipts()).map((x) => x.status), ['applied', 'already']);
});

test('a one-time charge from a vendor on the list is its own one-time bill, and one receipt number is one charge', async () => {
  await bill({ vendor: 'Example Labs', product: 'Max (20x)', category: 'ai_tools', cadence: 'monthly', amountCents: 21200, lastChargedOn: '2026-10-13' });
  await bill({ vendor: 'Example Labs', product: 'Prepaid extra usage', category: 'ai_tools', cadence: 'one_time', amountCents: 9540, lastChargedOn: '2026-09-06' });
  okay(await deliver(forwarded('stripe-one-time')));
  let rows = await expenses();
  assert.equal(rows.length, 3);
  const added = rows[2];
  assert.equal(added.vendor, 'Example Labs', 'filed under the vendor as the list names it');
  assert.equal(added.product, 'Prepaid extra usage, Individual plan, Oct 9, 2026');
  assert.equal(added.cadence, 'one_time');
  assert.equal(added.amount_cents, 9540);
  assert.equal(added.last_charged_on, '2026-10-09');
  assert.equal(added.kind, 'tooling', 'the kind and category of the vendor\'s other bill');
  assert.equal(added.category, 'ai_tools');
  assert.equal(added.active, true);
  assert.equal(added.verified, true);
  assert.ok(added.note.includes('$95.40'));
  assert.deepEqual((await receipts()).map((r) => [r.status, r.expense_id]), [['added', added.id]]);
  // A second top-up the same day is a second charge.
  okay(await deliver(forwarded('stripe-one-time', { html: readFixture('stripe-one-time.html').replace(/1000-5001/g, '1000-5002') })));
  rows = await expenses();
  assert.equal(rows.length, 4);
  assert.equal(rows[3].product, 'Prepaid extra usage, Individual plan, Oct 9, 2026 (2)');
  // The first receipt sent again as a new email has its receipt number, and
  // adds nothing.
  okay(await deliver(forwarded('stripe-one-time')));
  assert.equal((await expenses()).length, 4);
  assert.equal((await receipts()).length, 2);
  // A name too long for the list is cut before its date, so the date and the
  // number still tell two charges apart.
  const long = `Prepaid extra usage for the team ${'and more '.repeat(14)}`;
  for (const ref of ['1000-5003', '1000-5004']) {
    okay(await deliver(forwarded('stripe-one-time', { html: readFixture('stripe-one-time.html').replace(/1000-5001/g, ref).replace('Prepaid extra usage, Individual plan', long) })));
  }
  const [a, b] = (await expenses()).slice(4);
  assert.ok(a.product.length <= 120 && b.product.length <= 120, `${a.product.length}, ${b.product.length}`);
  assert.match(a.product, /, Oct 9, 2026$/);
  assert.match(b.product, /, Oct 9, 2026 \(2\)$/);
});

test('a charge with no period from a vendor whose only bills recur is for a person, not added beside them', async () => {
  // Stripe prints a subscription's period, so a receipt without one is a
  // one-time charge, unless the period was printed in words this could not
  // read. Where the vendor has only a monthly bill, adding a one-time copy
  // would count that bill twice.
  const monthly = await bill({ vendor: 'Example Labs', product: 'Max (20x)', category: 'ai_tools', cadence: 'monthly', amountCents: 21200, lastChargedOn: '2026-10-13' });
  okay(await deliver(forwarded('stripe-one-time')));
  const [r] = await receipts();
  assert.equal(r.status, 'to_check');
  assert.match(r.reason, /names no billing period, so it may be Example Labs, Max \(20x\), or a separate charge/);
  assert.equal(r.subject, 'Your receipt from Example Labs, PBC #1000-5001', 'kept so it can be found in Gmail');
  const list = await expenses();
  assert.equal(list.length, 1);
  assert.equal(list[0].last_charged_on, monthly.lastChargedOn);
  // The period in a day-first locale is read, so the monthly bill is matched.
  const dayFirst = readFixture('stripe-subscription.html').replace('Oct 13\u2013Nov 13, 2026', '13 Oct \u2013 13 Nov 2026');
  okay(await deliver(forwarded('stripe-subscription', { html: dayFirst })));
  assert.equal((await receipts())[1].status, 'already', 'the bill already holds the Oct 13 charge of $212.00');
});

test('a usage vendor billed one invoice at a time keeps getting one-time bills', async () => {
  await bill({ vendor: 'Codemagic', product: 'iOS builds, August usage', category: 'developer', cadence: 'one_time', amountCents: 5000, lastChargedOn: '2026-09-02' });
  okay(await deliver(forwarded('stripe-usage')));
  const rows = await expenses();
  assert.equal(rows.length, 2, 'filed under Codemagic, which the sender\'s list entry names, though the receipt is from Nevercode Ltd');
  assert.equal(rows[1].vendor, 'Codemagic');
  assert.equal(rows[1].cadence, 'one_time');
  assert.equal(rows[1].product, 'macOS M2 minutes personal use (per minute), Sep 2 to Oct 1, 2026');
  assert.equal(rows[1].amount_cents, 13015);
  assert.equal(rows[1].category, 'developer');
});

test('the App Store: a bill on the list is updated, a purchase in a listed maker\'s app waits, and nothing else is kept', async () => {
  const chat = await bill({ vendor: 'Example Chat Co (via App Store)', product: 'Example Chat Plus', category: 'ai_tools', cadence: 'monthly', amountCents: 2119, lastChargedOn: '2026-09-17', renewsOn: '2026-10-17' });
  await bill({ vendor: 'Example Labs', product: 'Max (20x)', category: 'ai_tools', cadence: 'monthly', amountCents: 21200, lastChargedOn: '2026-10-13' });
  okay(await deliver(forwarded('apple-table')));
  let rows = await receipts();
  assert.deepEqual(rows.map((r) => [r.line_no, r.status, r.vendor, r.product, r.amount_cents]), [
    [0, 'applied', 'Example Chat', 'Example Chat Plus', 2119],
    [1, 'new', 'Example Labs', 'Usage Credits (50)', 4770],
  ]);
  assert.match(rows[1].reason, /A purchase in Example Assistant by Example Labs, made by Example Labs, which is on the list\. The App Store sends every purchase on the account/);
  let list = await expenses();
  assert.equal(list.find((x) => x.id === chat.id).last_charged_on, '2026-10-19');
  assert.equal(list.length, 2, 'the purchase is in no total until the owner adds it');
  const hub = await receiptInbox.readForHub(pool, new Date('2026-11-20T17:00:00Z'));
  assert.deepEqual(hub.pending.map((x) => [x.vendor, x.knownVendor, x.suggestedKind]), [['Example Labs', true, 'tooling']]);
  // Added, it is filed with the maker's other bills, under the date it was
  // bought.
  const yes = await admin('POST', `/email-receipts/${rows[1].id}/confirm`, { kind: 'tooling' });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  list = await expenses();
  const credits = list.find((x) => x.cadence === 'one_time');
  assert.equal(credits.vendor, 'Example Labs');
  assert.equal(credits.product, 'Usage Credits (50), Oct 19, 2026');
  assert.equal(credits.category, 'ai_tools');
  assert.equal(credits.amount_cents, 4770, '$45.00 and its share of the tax');
  // A receipt for somebody's own app on the same Apple account stores
  // nothing at all.
  okay(await deliver(forwarded('apple-lockup-personal')));
  assert.equal((await receipts()).length, 2);
  assert.ok(receiptInbox.ignoredSinceStart().byReason.some((x) => x.reason === 'not_flock'));
  // September's receipt: the chat bill was charged later already, and the
  // other subscription on it is no bill on the list, so only one line is kept.
  okay(await deliver(forwarded('apple-lockup')));
  rows = await receipts();
  assert.deepEqual(rows.slice(2).map((r) => [r.status, r.vendor]), [['older', 'Example Chat']]);
  // And nothing of the personal purchase reached the table at all.
  assert.ok(!rows.some((r) => /Photos/.test(`${r.vendor} ${r.product}`)));
});

test('an App Store item matches a bill only by a name that says which product it is', async () => {
  // "Max (20x)" is one word to match on. Another app's "Max Basic With Ads",
  // bought by somebody on the same account, carries that word too.
  const max = await bill({ vendor: 'Example Labs', product: 'Max (20x)', category: 'ai_tools', cadence: 'monthly', amountCents: 21200, lastChargedOn: '2026-10-13' });
  const html = readFixture('apple-lockup.html').replace(/Example Answers Pro/g, 'Max Basic With Ads').replace(/Example Answers/g, 'Example Video').replace(/MTESTORDR02/g, 'MTESTORDR09');
  okay(await deliver(forwarded('apple-lockup', { html })));
  assert.deepEqual(await receipts(), [], 'neither item is a bill on the list');
  const [row] = await expenses();
  assert.equal(row.last_charged_on, max.lastChargedOn);
  assert.equal(row.amount_cents, 21200);
  // A one-word product is matched when the item is named exactly that.
  const { appStoreItemIs } = receiptInbox.__testing;
  const item = (product, title = 'Example App') => ({ product, title });
  assert.equal(appStoreItemIs({ product: 'Max (20x)' }, item('Max (20x)')), true);
  assert.equal(appStoreItemIs({ product: 'Max (20x)' }, item('Max Basic With Ads')), false);
  assert.equal(appStoreItemIs({ product: 'SuperThing' }, item('SuperThing (Monthly)')), true);
  assert.equal(appStoreItemIs({ product: 'Example Chat Plus' }, item('Example Chat Plus Business')), true, 'three words named are enough');
  assert.equal(appStoreItemIs({ product: 'Example Chat Plus' }, item('Example Chat Pro')), false);
});

// ---------------------------------------------------------------------------
// New bills, and the owner's answers
// ---------------------------------------------------------------------------

test('a vendor the list has never seen waits, counted nowhere, until the owner adds it', async () => {
  okay(await deliver(forwarded('shop-order')));
  const [r] = await receipts();
  assert.equal(r.status, 'new');
  assert.equal(r.vendor, 'PCB Artists');
  assert.equal(r.amount_cents, 8299);
  assert.deepEqual(await expenses(), [], 'nothing is on the list, so nothing is in any total');
  assert.equal(r.subject, null);
  const hub = await receiptInbox.readForHub(pool, new Date('2026-11-20T17:00:00Z'));
  assert.equal(hub.status, 'ok');
  assert.deepEqual(hub.pending.map((x) => [x.id, x.vendor, x.product, x.amountCents, x.paidOn, x.cadence, x.knownVendor]), [
    [r.id, 'PCB Artists', 'I2C Decibel Sound Level Meter Module - PRO', 8299, '2026-10-08', 'one_time', false],
  ]);
  assert.equal(hub.pending[0].sender, undefined, 'a readable receipt is shown by what it paid, not by its sender');
  assert.equal(hub.pending[0].subject, undefined);

  assert.equal((await admin('POST', `/email-receipts/${r.id}/confirm`, { kind: 'nonsense' })).status, 400);
  const yes = await admin('POST', `/email-receipts/${r.id}/confirm`, { kind: 'other' });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  const [row] = await expenses();
  assert.equal(row.id, yes.json.expenseId);
  assert.equal(row.vendor, 'PCB Artists');
  assert.equal(row.product, 'I2C Decibel Sound Level Meter Module - PRO, Oct 8, 2026', 'a one-time bill is named by when it was paid');
  assert.equal(row.cadence, 'one_time');
  assert.equal(row.kind, 'other');
  assert.equal(row.amount_cents, 8299);
  assert.equal(row.last_charged_on, '2026-10-08');
  assert.equal(row.verified, true);
  assert.equal(row.updated_by, adminId);
  const [after] = await receipts();
  assert.equal(after.status, 'confirmed');
  assert.equal(after.expense_id, row.id);
  assert.equal((await admin('POST', `/email-receipts/${r.id}/confirm`, {})).status, 409, 'an answered receipt cannot be added twice');
  assert.equal((await admin('POST', '/email-receipts/999999/confirm', {})).status, 404);
});

test('a shop\'s order waits even from a shop on the list, and two orders of one part stay two bills', async () => {
  // Anybody can order from a shop with the owner's email address, and the
  // shop's genuine order email then reaches his inbox.
  const earlier = await bill({ vendor: 'Pololu', product: 'Sensor carrier, Sep 1, 2026', category: 'hardware', kind: 'other', cadence: 'one_time', amountCents: 1500, lastChargedOn: '2026-09-01' });
  okay(await deliver(forwarded('pololu-order')));
  okay(await deliver(forwarded('pololu-order', { text: readFixture('pololu-order.txt').replace(/1TEST0001/g, '1TEST0002').replace('25 September 2026', '27 September 2026') })));
  const rows = await receipts();
  assert.deepEqual(rows.map((r) => [r.status, r.vendor, r.amount_cents, r.paid_on]), [
    ['new', 'Pololu', 3805, '2026-09-25'],
    ['new', 'Pololu', 3805, '2026-09-27'],
  ]);
  assert.match(rows[0].reason, /^Pololu is on the list\. A shop takes an order in anybody's name/);
  assert.equal((await expenses()).length, 1, 'nothing counted before the owner says so');
  const hub = await receiptInbox.readForHub(pool, new Date('2026-11-20T17:00:00Z'));
  assert.deepEqual(hub.pending.map((x) => [x.knownVendor, x.suggestedKind]), [[true, 'other'], [true, 'other']]);
  for (const r of rows) {
    const yes = await admin('POST', `/email-receipts/${r.id}/confirm`, { kind: 'other' });
    assert.equal(yes.status, 200, JSON.stringify(yes.json));
  }
  const list = await expenses();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, earlier.id);
  assert.deepEqual(list.slice(1).map((x) => [x.vendor, x.category, x.cadence, x.amount_cents, x.last_charged_on]), [
    ['Pololu', 'hardware', 'one_time', 3805, '2026-09-25'],
    ['Pololu', 'hardware', 'one_time', 3805, '2026-09-27'],
  ]);
  assert.match(list[1].product, /, Sep 25, 2026$/);
  assert.match(list[2].product, /, Sep 27, 2026$/);
});

test('confirming a stale receipt never winds a bill back', async () => {
  // The bill waits; meanwhile the owner types it in by hand with a newer
  // charge. Adding the old receipt then links it and changes nothing.
  okay(await deliver(forwarded('stripe-subscription')));
  const [r] = await receipts();
  assert.equal(r.status, 'new');
  const typed = await bill({ vendor: r.vendor, product: r.product, category: 'ai_tools', cadence: 'monthly', amountCents: 22000, lastChargedOn: '2026-11-13' });
  const yes = await admin('POST', `/email-receipts/${r.id}/confirm`, { kind: 'tooling' });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  assert.equal(yes.json.expenseId, typed.id);
  const [row] = await expenses();
  assert.equal(row.amount_cents, 22000);
  assert.equal(row.last_charged_on, '2026-11-13');
  assert.equal((await receipts())[0].status, 'confirmed');
});

test('"Not a Flock bill" sets a new bill aside, and the next receipt for it stores nothing', async () => {
  okay(await deliver(forwarded('pololu-order')));
  const [r] = await receipts();
  assert.equal(r.status, 'new');
  const no = await admin('POST', `/email-receipts/${r.id}/dismiss`);
  assert.equal(no.status, 200);
  assert.equal(no.json.status, 'dismissed');
  okay(await deliver(forwarded('pololu-order', { text: readFixture('pololu-order.txt').replace(/1TEST0001/g, '1TEST0002') })));
  assert.equal((await receipts()).length, 1, 'the second order of the same part was stored');
  assert.ok(receiptInbox.ignoredSinceStart().byReason.some((x) => x.reason === 'dismissed_before'));
  assert.equal((await admin('POST', `/email-receipts/${r.id}/dismiss`)).status, 409);
});

test('a bill set aside, then put on the list by hand, is matched again', async () => {
  okay(await deliver(forwarded('stripe-subscription')));
  const [r] = await receipts();
  assert.equal(r.status, 'new');
  assert.equal((await admin('POST', `/email-receipts/${r.id}/dismiss`)).json.status, 'dismissed');
  // The owner changes his mind and adds the bill himself. The next month's
  // receipt is that bill's, and "Not a Flock bill" no longer applies.
  const typed = await bill({ vendor: 'Example Labs', product: 'Max plan - 20x', category: 'ai_tools', cadence: 'monthly', amountCents: 21200, lastChargedOn: '2026-10-13' });
  const html = readFixture('stripe-subscription.html').replace(/1000-4001/g, '1000-4002').replace('October 13, 2026', 'November 13, 2026')
    .replace('Oct 13\u2013Nov 13, 2026', 'Nov 13\u2013Dec 13, 2026');
  okay(await deliver(forwarded('stripe-subscription', { html })));
  const rows = await receipts();
  assert.deepEqual(rows.map((x) => x.status), ['dismissed', 'applied']);
  assert.equal(rows[1].expense_id, typed.id);
  assert.equal((await expenses())[0].last_charged_on, '2026-11-13');
});

test('a receipt that cannot be read is kept by its sender and subject alone, and Done clears it', async () => {
  const html = readFixture('stripe-subscription.html').replace(/\$\d[\d,]*\.\d{2}/g, 'see the attachment');
  okay(await deliver(forwarded('stripe-subscription', { html })));
  const [r] = await receipts();
  assert.equal(r.status, 'to_check');
  assert.equal(r.amount_cents, null);
  assert.equal(r.product, null);
  assert.equal(r.vendor, 'Example Labs, PBC');
  assert.equal(r.subject, 'Your receipt from Example Labs, PBC #1000-4001');
  assert.equal(r.sender, 'invoice+statements@mail.example-labs.test');
  assert.match(r.reason, /amount paid could not be found/);
  const hub = await receiptInbox.readForHub(pool);
  assert.deepEqual(hub.toCheck.map((x) => [x.sender, x.subject]), [[r.sender, r.subject]]);
  const done = await admin('POST', `/email-receipts/${r.id}/dismiss`);
  assert.equal(done.json.status, 'checked');
  assert.deepEqual((await receiptInbox.readForHub(pool)).toCheck, []);
  assert.equal((await receipts())[0].subject, null, 'the subject was kept only to find the email by');
});

test('a receipt the database will not take is kept for a person, not asked for again forever', async () => {
  // $20,000,000.00 is past the ten million dollar ceiling migration 134 holds
  // every amount to. The same email would fail the same way on every
  // delivery, so it is answered, and a person gets it.
  const html = readFixture('stripe-one-time.html').replace(/\$95\.40/g, '$20,000,000.00');
  const res = await deliver(forwarded('stripe-one-time', { html }));
  okay(res);
  const [r] = await receipts();
  assert.equal(r.status, 'to_check');
  assert.equal(r.amount_cents, null);
  assert.match(r.reason, /database would not record it \(23514\)/);
  assert.equal(r.subject, 'Your receipt from Example Labs, PBC #1000-5001');
  assert.deepEqual(await expenses(), []);
  // And the same email again is the duplicate it is.
  okay(await deliver(forwarded('stripe-one-time', { html, messageId: r.message_id })));
  assert.equal((await receipts()).length, 1);
});

test('every receipt waiting for the owner is on the card, however many came after it', async () => {
  // Seventy new bills and one to check, all older than twenty read receipts.
  const ins = (status, minutesAgo, n) => pool.query(
    `INSERT INTO email_receipts (message_id, line_no, resend_email_id, sender, subject, vendor, product, amount_cents, currency, paid_on, status, received_at)
     VALUES ($1, 0, $2, 'sales@shop.example', $3, 'A Shop', $4, 1000, 'USD', '2026-10-01', $5, NOW() - ($6 || ' minutes')::interval)`,
    [`<seed-${status}-${n}@mail.example>`, `seed-${status}-${n}`, status === 'to_check' ? 'An order to check' : null, `Part ${n}`, status, String(minutesAgo)]
  );
  for (let n = 0; n < 70; n += 1) await ins('new', 1000 + n, n);
  await ins('to_check', 5000, 0);
  for (let n = 0; n < 20; n += 1) await ins('already', n, n);
  const hub = await receiptInbox.readForHub(pool, new Date());
  assert.equal(hub.pending.length, 70);
  assert.equal(hub.toCheck.length, 1);
  assert.equal(hub.recent.length, 12, 'the newest twelve of the rest');
  assert.equal(hub.thisMonth >= 20, true);
  assert.ok(hub.lastReceivedAt);
});

test('the table keeps no part of an email\'s body', async () => {
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'email_receipts'`)).map((c) => c.column_name).sort();
  assert.deepEqual(cols, [
    'amount_cents', 'cadence', 'currency', 'expense_id', 'id', 'line_no', 'message_id', 'paid_on', 'period_end',
    'period_start', 'previous_cents', 'previous_on', 'product', 'reason', 'received_at', 'reconciled_line',
    'reference', 'resend_email_id', 'resolved_at', 'sender', 'status', 'subject', 'vendor',
  ]);
});

// ---------------------------------------------------------------------------
// Once, and only the owner's forwarded receipts
// ---------------------------------------------------------------------------

test('the same receipt delivered twice, or forwarded twice, is read once', async () => {
  await setReconciled('railway', 30.0, '2026-10-01');
  const email = forwarded('stripe-railway');
  okay(await deliver(email));
  const body = eventFor(email);
  okay(await postEvent(body, signedHeaders(body)), 'the redelivery');
  assert.equal(resendCalls.length, 1, 'a redelivered event is known before Resend is asked again');
  const again = forwarded('stripe-railway', { messageId: email.message_id });
  okay(await deliver(again), 'the second forward');
  assert.equal((await receipts()).length, 1);
  assert.equal((await reconciled('railway')).prev_usd, '30.00', 'the line was written once');
});

test('Resend not answering asks for the event again, and the retry is read', async () => {
  await setReconciled('railway', 30.0, '2026-10-01');
  const email = forwarded('stripe-railway');
  resendFailures = 1;
  const first = await deliver(email);
  assert.equal(first.status, 500);
  assert.deepEqual(await receipts(), []);
  okay(await deliver(email), 'the retry');
  assert.equal((await receipts())[0].status, 'applied');
});

test('mail that is not the owner\'s forwarded receipt stores nothing, changes nothing, and says why', async () => {
  await setReconciled('railway', 30.0, '2026-10-01');
  const other = 'other@fixture1105.resend.app';
  const cases = [
    ['not_forwarded', {}, { headers: { 'x-forwarded-for': undefined, 'x-forwarded-to': undefined } }],
    ['forwarded_by_someone_else', {}, { headers: { 'x-forwarded-for': `someone.else@gmail.com ${INBOX}`, 'return-path': '<someoneelse+caf_=receipts=fixture1105.resend.app@gmail.com>' } }],
    ['forwarded_elsewhere', {}, { headers: { 'x-forwarded-for': `${OWNER} ${other}`, 'x-forwarded-to': other } }],
    ['not_from_gmail', {}, { headers: { 'return-path': '<bounce@mailer.example>' } }],
    ['not_from_gmail', {}, { authentication: { spf: 'fail', dkim: 'pass', dmarc: 'pass' } }],
    ['not_from_gmail', {}, { authentication: null }],
    ['sender_not_listed', {}, { from: 'receipts+acct_1PERSONALSTORE00@stripe.com', headers: { from: '"A Shop" <receipts+acct_1PERSONALSTORE00@stripe.com>' } }],
    ['sender_not_verified', {}, { authentication: { spf: 'pass', dkim: 'fail', dmarc: 'fail' } }],
    ['sender_not_verified', {}, { authentication: { spf: 'pass', dkim: 'gray', dmarc: 'gray' } }],
    // DKIM passed, and DMARC did not: the signature was not the From domain's
    // own, and the vendor's domain publishes a policy that says so.
    ['sender_not_verified', {}, { authentication: { spf: 'pass', dkim: 'pass', dmarc: 'gray' } }],
    ['sender_not_verified', {}, { authentication: { spf: 'pass', dkim: 'pass', dmarc: 'unknown' } }],
    ['not_addressed_to_owner', {}, { to: ['stranger@example.com'], headers: { to: 'stranger@example.com' } }],
    ['not_to_inbox', {}, { receivedFor: [other], headers: { 'delivered-to': other, 'x-forwarded-to': other, 'x-forwarded-for': `${OWNER} ${other}` } }],
  ];
  for (const [reason, , over] of cases) {
    const before = resendCalls.length;
    okay(await deliver(forwarded('stripe-railway', over)), reason);
    if (reason === 'sender_not_listed') assert.equal(resendCalls.length, before, 'a sender off the list is dropped before Resend is asked');
  }
  assert.deepEqual(await receipts(), []);
  assert.equal((await reconciled('railway')).usd, '30.00');
  const counted = Object.fromEntries(receiptInbox.ignoredSinceStart().byReason.map((x) => [x.reason, x.count]));
  assert.deepEqual(counted, {
    not_forwarded: 1, forwarded_by_someone_else: 1, forwarded_elsewhere: 1, not_from_gmail: 3,
    sender_not_listed: 1, sender_not_verified: 4, not_addressed_to_owner: 1, not_to_inbox: 1,
  });
});

test('a shop whose domain publishes no DMARC policy is taken on its own DKIM signature alone', async () => {
  // pcbartists.com publishes p=none, so Resend's DMARC result is "gray" even
  // for its own signed mail. Its list entry says so; nobody else's does.
  okay(await deliver(forwarded('shop-order', { authentication: { spf: 'pass', dkim: 'pass', dmarc: 'gray' } })));
  assert.deepEqual((await receipts()).map((r) => r.status), ['new']);
  okay(await deliver(forwarded('shop-order', { authentication: { spf: 'pass', dkim: 'gray', dmarc: 'gray' } })));
  okay(await deliver(forwarded('pololu-order', { authentication: { spf: 'pass', dkim: 'pass', dmarc: 'gray' } })));
  assert.equal((await receipts()).length, 1);
  assert.equal(receiptInbox.ignoredSinceStart().byReason.find((x) => x.reason === 'sender_not_verified').count, 2);
});

test('an event without an email id Resend could have issued is dropped before Resend is asked', async () => {
  for (const emailId of ['', 'x'.repeat(81), '../emails/other', 'id with spaces']) {
    const body = JSON.stringify({ type: 'email.received', created_at: '2026-11-20T16:00:01.000Z', data: { email_id: emailId, from: 'payments-noreply@google.com', to: [INBOX] } });
    okay(await postEvent(body, signedHeaders(body)), JSON.stringify(emailId));
  }
  assert.equal(resendCalls.length, 0);
  assert.equal(receiptInbox.ignoredSinceStart().byReason.find((x) => x.reason === 'no_email_id').count, 4);
});

test('notices from a listed sender are not receipts and store nothing', async () => {
  for (const name of ['fastspring-activated', 'pololu-shipped', 'google-notice']) okay(await deliver(forwarded(name)), name);
  assert.deepEqual(await receipts(), []);
  assert.equal(receiptInbox.ignoredSinceStart().byReason.find((x) => x.reason === 'not_a_receipt').count, 3);
});

test('the money hub carries what came in from email', async () => {
  okay(await deliver(forwarded('shop-order')));
  const hub = await moneyHub.buildMoneyHub({ db: pool, now: new Date('2026-11-20T17:00:00Z') });
  assert.equal(hub.emailReceipts.status, 'ok');
  assert.equal(hub.emailReceipts.pending.length, 1);
  assert.equal(hub.emailReceipts.inbox.localPart, 'receipts');
  assert.ok(Array.isArray(hub.emailReceipts.recent));
});

test('the code lists the real senders and the owner without publishing who they are', () => {
  const { senderAllowed, isOwner, SENDERS } = receiptInbox.__testing;
  assert.equal(senderAllowed('invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com', 'Railway Corporation'), true, 'Railway\'s Stripe receipts');
  assert.equal(senderAllowed('payments-noreply@google.com', 'Google Payments'), true);
  assert.equal(senderAllowed('no_reply@email.apple.com', 'Apple'), true);
  assert.equal(senderAllowed('mailer@fastspring.com', 'MapTiler AG'), true);
  assert.equal(senderAllowed('mailer@fastspring.com', 'Another Merchant'), false, 'FastSpring sends for every merchant');
  assert.equal(senderAllowed('failed-payments+acct_1HNrvlCJoPsRzQsd@stripe.com', 'Railway Corporation'), false, 'a failed payment is not a receipt address');
  assert.ok(SENDERS.every((s) => (s.address && !s.sha256) || (/^[0-9a-f]{64}$/.test(s.sha256) && !s.address)));
  // Each sender reads in its one layout, and only Railway's own account and
  // Google's payments are bound to a reconciled line.
  const { FORMATS } = require('../services/receiptParsers');
  assert.ok(SENDERS.every((s) => FORMATS.includes(s.format)), 'every sender names a layout');
  assert.deepEqual(SENDERS.filter((s) => s.line).map((s) => [s.address, s.line]), [
    ['invoice+statements+acct_1hnrvlcjopsrzqsd@stripe.com', 'railway'],
    ['payments-noreply@google.com', 'google-cloud'],
  ]);
  assert.deepEqual(SENDERS.filter((s) => s.waits).map((s) => s.address), ['sales@pololu.com', 'hello@pcbartists.com']);
  assert.deepEqual(SENDERS.filter((s) => s.dmarc).map((s) => [s.address, s.dmarc]), [['hello@pcbartists.com', 'none']]);
  // RECEIPT_SENDERS takes exact addresses: a whole domain would let in every
  // merchant a payment processor sends for.
  process.env.RECEIPT_SENDERS = '@stripe.com, billing@vendor.example';
  try {
    assert.equal(senderAllowed('receipts+acct_1anymerchant@stripe.com', 'Any Merchant'), false);
    const extra = receiptInbox.__testing.senderEntry('Billing@Vendor.example', 'Vendor');
    assert.equal(extra.format, null);
    assert.equal(extra.line, undefined, 'an added sender never sets a reconciled line');
    assert.equal(extra.waits, 'unlisted');
  } finally {
    delete process.env.RECEIPT_SENDERS;
  }
  // The owner check takes Gmail's own rules: dots and a +tag change nothing.
  assert.equal(isOwner('Owner.Account+receipts@googlemail.com'), true);
  assert.equal(isOwner('owner.accounts@gmail.com'), false);
});
