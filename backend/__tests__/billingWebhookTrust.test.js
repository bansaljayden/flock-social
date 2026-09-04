// Run: node --test  (from backend/)
//
// TRUST SWEEP OF THE PAYMENTS PLUMBING (audit 2026-08-14).
//
// routes/revenuecat.js is the ONLY writer of users.is_premium anywhere in this
// repo. There is no subscription table, no expiry column and no admin grant
// path: whatever this one handler decides is the entirety of "who has paid".
// The consumer paywall is dormant (PAYWALL_ENABLED and REVENUECAT_WEBHOOK_SECRET
// are both unset on Railway), so none of this decides anything today — which is
// exactly why it is pinned now. The flip is a config change made by one person
// on one evening, not a code review, so every property this file asserts has to
// already be true before that evening starts.
//
// The central question, asserted first and with a reproduction: with the secret
// UNSET, does an unsigned POST get anywhere? An open webhook is a one-curl
// premium grant for anyone who finds the URL.
//
// Everything is driven through the REAL Express router with a scripted pg fake,
// so each assertion is about the request the route actually issues, not about a
// helper it might stop calling. Where a property cannot be observed from
// outside (the compare being constant time; an accepted limit staying
// documented) it is pinned against the source, because the alternative is
// pinning it against nothing.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'billing-webhook-trust-test-secret';
delete process.env.PAYWALL_ENABLED;
delete process.env.REVENUECAT_WEBHOOK_SECRET;

const BACKEND = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

// Comments are allowed to NAME the thing that was removed; code is not allowed
// to be it. Same `codeOnly` idea __tests__/fieldBounds.test.js uses on this
// same file's constant-time pin.
const codeOnly = (src) => src.split('\n')
  .map((line) => { const at = line.indexOf('//'); return at === -1 ? line : line.slice(0, at); })
  .join('\n');

// ---------------------------------------------------------------------------
// Scripted pg fake.
//
// Unmatched queries answer empty rather than throwing, on purpose: almost every
// assertion below is "which statements were issued, with which parameters", and
// a test that dies on an unscripted SELECT tells you about the script instead of
// about the route. The status code is asserted alongside every one of them, so
// a route that genuinely needed a row it did not get still fails.
// ---------------------------------------------------------------------------
const pool = require('../config/database');
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || null });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), params: null });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

// Auth + push are stubbed BEFORE the routers are required — both are
// destructured at module load.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };
const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => {};
pushMod.pushAlways = async () => {};

const revenuecatRouter = require('../routes/revenuecat');
const billingRouter = require('../routes/billing');

const app = express();
app.use(express.json());
app.use('/api/revenuecat', revenuecatRouter);
app.use('/api/billing', billingRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
});

// A secret of a realistic shape. The floor asserted in section 3 is well below
// what `openssl rand -hex 32` produces, which is what PAYWALL.md step 3 tells
// the operator to paste.
const SECRET = 'trust-sweep-revenuecat-shared-secret-0123456789';

// Raw header control: every auth test below needs to send something other than
// the one blessed spelling, including nothing at all.
async function post(body, headers = {}) {
  const res = await fetch(`${base}/api/revenuecat/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const signed = (body, secret = SECRET) => post(body, { Authorization: `Bearer ${secret}` });

// Statements that CHANGE anything. The whole file cares about this set and not
// about reads.
const writes = () => log.filter((q) => /^(UPDATE|INSERT|DELETE)/i.test(q.sql));
const premiumWrites = () => log.filter((q) => /UPDATE users SET is_premium/i.test(q.sql));

// ===========================================================================
// 1. THE CENTRAL QUESTION — an unsigned request with the secret unset
// ===========================================================================
//
// This is the production state today. If the answer were "accepted", the URL
// itself would be the credential and anyone who read a HAR file, a proxy log or
// this repo's own PAYWALL.md could POST themselves Flock Pro.

test('with the secret UNSET an unsigned request is refused and touches nothing', async () => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET;

  const res = await post({ event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } });

  assert.equal(res.status, 503, 'UNSET SECRET MUST FAIL CLOSED. A 200 here is a one-curl premium grant.');
  assert.deepEqual(writes(), [], 'an unconfigured webhook must not reach a write');
  assert.deepEqual(log, [], 'an unconfigured webhook must not reach the database at all');
});

test('with the secret UNSET no invented credential opens it either', async () => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
  const event = { event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } };

  for (const header of [
    {},
    { Authorization: 'Bearer ' },
    { Authorization: 'Bearer undefined' },
    { Authorization: 'Bearer null' },
    { Authorization: 'Bearer  ' },
    { Authorization: 'undefined' },
    { Authorization: '' },
    { 'X-RevenueCat-Signature': 'anything' },
  ]) {
    log = [];
    const res = await post(event, header);
    assert.equal(res.status, 503, `${JSON.stringify(header)} was not refused`);
    assert.deepEqual(log, [], `${JSON.stringify(header)} reached a query`);
  }
});

test('an empty or blank secret counts as unset, not as a secret equal to ""', async () => {
  // `if (!secret)` is true for '' and FALSE for ' '. A Railway variable someone
  // cleared by typing a space therefore read as configured, and the credential
  // it accepted was `Bearer ` plus that space: a webhook that looks locked in
  // the dashboard and is open to anyone who tries the obvious thing.
  const realError = console.error;
  console.error = () => {};
  try {
    for (const raw of ['', '   ', '\n', '\t', 'Bearer ', 'Bearer    ']) {
      process.env.REVENUECAT_WEBHOOK_SECRET = raw;
      log = [];
      // The exact header that WOULD match if the blank value were honoured.
      const res = await post(
        { event: { type: 'INITIAL_PURCHASE', app_user_id: '4242' } },
        { Authorization: `Bearer ${raw}` }
      );
      assert.equal(res.status, 503, `REVENUECAT_WEBHOOK_SECRET=${JSON.stringify(raw)} must read as unconfigured`);
      assert.deepEqual(log, [], `REVENUECAT_WEBHOOK_SECRET=${JSON.stringify(raw)} reached a query`);
    }
  } finally {
    console.error = realError;
  }
});

// ===========================================================================
// 2. Authentication once a secret IS configured
// ===========================================================================

test('a configured secret refuses every wrong credential and accepts the right one', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const event = { event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } };

  const wrong = [
    undefined,                                  // no header at all
    { Authorization: '' },
    { Authorization: 'Bearer not-the-secret' },
    // Same LENGTH as the real one, one byte different. timingSafeEqual throws
    // on unequal lengths, so the equal-length case is the one that proves the
    // guard is ordered correctly rather than accidentally never reached.
    { Authorization: `Bearer ${SECRET.slice(0, -1)}X` },
    { Authorization: `Bearer ${SECRET}extra` },  // a correct prefix is not a match
    { Authorization: `Bearer ${SECRET.slice(0, 10)}` },
    { Authorization: `Basic ${SECRET}` },
  ];
  for (const headers of wrong) {
    log = [];
    const res = await post(event, headers);
    assert.equal(res.status, 401, `${JSON.stringify(headers)} was not refused: ${res.text}`);
    assert.deepEqual(log, [], `${JSON.stringify(headers)} reached a query`);
  }

  log = [];
  const ok = await signed(event);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(premiumWrites().length, 1, 'the control: the right credential still works');
});

test('the header spellings an operator can actually produce all authenticate', async () => {
  // RevenueCat's dashboard field is free text: it sends whatever string you
  // typed, with no "Bearer" of its own. PAYWALL.md step 3 says to paste
  // `Bearer <secret>` there and the bare secret into Railway, and the two
  // fields are filled minutes apart by hand. Every combination of "did the
  // Bearer end up on the header, on the env var, on both, or on neither" has to
  // land on the same yes, or the failure mode is a webhook that 401s silently
  // while purchases succeed in the App Store and nobody gets what they paid for.
  const cases = [
    [SECRET, `Bearer ${SECRET}`],          // documented spelling
    [SECRET, SECRET],                      // bare secret in the dashboard field
    [`Bearer ${SECRET}`, `Bearer ${SECRET}`], // Bearer pasted into Railway too
    [`  ${SECRET}  `, `Bearer ${SECRET}`], // trailing whitespace on the env var
    [SECRET, `bearer ${SECRET}`],          // case of the scheme is not the secret
    [`${SECRET}\n`, `Bearer ${SECRET}`],   // a newline survived the paste
  ];
  for (const [envValue, header] of cases) {
    process.env.REVENUECAT_WEBHOOK_SECRET = envValue;
    log = [];
    const res = await post(
      { event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } },
      { Authorization: header }
    );
    assert.equal(res.status, 200,
      `env=${JSON.stringify(envValue)} header=${JSON.stringify(header)} -> ${res.status} ${res.text}`);
    assert.equal(premiumWrites().length, 1, `env=${JSON.stringify(envValue)} did not write`);
  }

  // And widening the accepted SPELLING did not widen the accepted SECRET.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  for (const header of ['Bearer Bearer wrong', 'Bearer', `${SECRET}x`, `Bearer ${SECRET} `.replace(SECRET, 'nope')]) {
    log = [];
    const res = await post({ event: { type: 'INITIAL_PURCHASE', app_user_id: '4242' } }, { Authorization: header });
    assert.equal(res.status, 401, `${JSON.stringify(header)} was accepted`);
    assert.deepEqual(log, []);
  }
});

test('the compare is constant time and length-guarded, pinned against the source', () => {
  // Not observable from outside, and /api/revenuecat is deliberately mounted
  // with NO rate limiter (webhook retries must never be throttled), so there is
  // nothing at all slowing down somebody timing this compare byte by byte.
  const src = codeOnly(read('routes/revenuecat.js'));
  assert.match(src, /crypto\.timingSafeEqual\(/,
    'the secret compare must be constant time');
  assert.match(src, /if \(a\.length !== b\.length\) return false;[\s\S]{0,80}?crypto\.timingSafeEqual\(a, b\)/,
    'timingSafeEqual THROWS on unequal lengths: the length guard has to come first and return false');
  assert.doesNotMatch(src, /header === `Bearer|=== secret|secret ===|\.includes\(secret\)|startsWith\(secret\)/,
    'a plain equality or substring compare on the secret has come back');
  // Every path that reads the configured value goes through one function, so
  // there is one place where "what counts as configured" is decided.
  assert.equal((src.match(/process\.env\.REVENUECAT_WEBHOOK_SECRET/g) || []).length, 1,
    'the env var must be read in exactly one place, or two answers to "is this configured" will drift');
});

// ===========================================================================
// 3. A secret weak enough to guess is not a secret
// ===========================================================================

test('a trivially short secret is refused as unconfigured, loudly', async () => {
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    process.env.REVENUECAT_WEBHOOK_SECRET = 'x';
    const res = await post(
      { event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } },
      { Authorization: 'Bearer x' }
    );
    assert.equal(res.status, 503,
      'a one-character secret on a route with no rate limiter is a guessable premium grant');
    assert.deepEqual(log, []);
    assert.ok(errs.some((l) => /REVENUECAT_WEBHOOK_SECRET/.test(l)),
      'refusing silently would look exactly like "the webhook is broken" with no way to find out why');
  } finally {
    console.error = realError;
  }
});

test('a secret of a realistic length is accepted', async () => {
  // The floor is a floor, not a narrowing: what PAYWALL.md tells the operator to
  // generate clears it by a wide margin.
  process.env.REVENUECAT_WEBHOOK_SECRET = 'a'.repeat(16);
  const res = await post(
    { event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } },
    { Authorization: `Bearer ${'a'.repeat(16)}` }
  );
  assert.equal(res.status, 200, res.text);
  assert.equal(premiumWrites().length, 1);
});

// ===========================================================================
// 4. The event mapping table
// ===========================================================================

const GRANTS = ['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE'];
const REVOKES = ['EXPIRATION', 'SUBSCRIPTION_PAUSED'];
const NO_OPS = [
  'CANCELLATION',            // auto-renew off; access runs to the paid period's end
  'BILLING_ISSUE',           // grace period; EXPIRATION follows if it is never fixed
  'SUBSCRIPTION_EXTENDED',   // still active, just longer
  'TEMPORARY_ENTITLEMENT_GRANT',
  'NON_RENEWING_PURCHASE',   // no non-renewing Pro product exists
  'SUBSCRIBER_ALIAS',
  'INVOICE_ISSUANCE',
  'REFUND_REVERSED',
  'VIRTUAL_CURRENCY_TRANSACTION',
];

test('is_premium moves on exactly the events it should, and on no others', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;

  for (const type of GRANTS) {
    log = [];
    const res = await signed({ event: { type, app_user_id: '4242', entitlement_ids: ['pro'] } });
    assert.equal(res.status, 200, `${type} -> ${res.status} ${res.text}`);
    const w = premiumWrites();
    assert.equal(w.length, 1, `${type} did not write`);
    assert.deepEqual(w[0].params, [true, 4242], `${type} wrote ${JSON.stringify(w[0].params)}`);
  }

  for (const type of REVOKES) {
    log = [];
    const res = await signed({ event: { type, app_user_id: '4242', entitlement_ids: ['pro'] } });
    assert.equal(res.status, 200, `${type} -> ${res.status} ${res.text}`);
    const w = premiumWrites();
    assert.equal(w.length, 1, `${type} did not write`);
    assert.deepEqual(w[0].params, [false, 4242], `${type} wrote ${JSON.stringify(w[0].params)}`);
  }

  for (const type of NO_OPS) {
    log = [];
    const res = await signed({ event: { type, app_user_id: '4242', entitlement_ids: ['pro'] } });
    assert.equal(res.status, 200, `${type} -> ${res.status} ${res.text}`);
    assert.deepEqual(writes(), [], `${type} must not move is_premium`);
  }
});

test('CANCELLATION does not revoke, because it is not a loss of access', async () => {
  // Round 4 of an earlier audit, re-pinned here because it is the single most
  // tempting line in the table to "fix": the word says cancelled, so surely the
  // subscriber loses Pro. They do not. CANCELLATION means auto-renew was
  // switched off and the customer keeps what they paid for until the period
  // ends, at which point EXPIRATION arrives and IS honoured above. Revoking on
  // CANCELLATION takes access away from someone who is still paid up, on the
  // day they were most annoyed at the product.
  //
  // Refunds are not the exception they look like: RevenueCat sends EXPIRATION
  // with expiration_reason CUSTOMER_SUPPORT for those, and EXPIRATION revokes.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({
    event: { type: 'CANCELLATION', app_user_id: '4242', entitlement_ids: ['pro'], cancel_reason: 'UNSUBSCRIBE' },
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(writes(), []);
});

test('an unknown event type is ignored, never defaulted', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const types = [
    'SOMETHING_REVENUECAT_ADDS_IN_2027',
    '',
    'initial_purchase',        // the table is case sensitive; RevenueCat shouts
    ' INITIAL_PURCHASE',
    'INITIAL_PURCHASE ',
    // A lookup table written as a plain object answers Object.prototype for
    // these, and `EFFECT[type]` would be a truthy function. The type is a
    // caller-supplied string on a route with no field validation, so this is
    // reachable, and "constructor" granting Pro is not a hypothetical shape of
    // bug.
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'valueOf',
  ];
  for (const type of types) {
    log = [];
    const res = await signed({ event: { type, app_user_id: '4242', entitlement_ids: ['pro'] } });
    assert.equal(res.status, 200, `${JSON.stringify(type)} -> ${res.status} ${res.text}`);
    assert.deepEqual(writes(), [], `type=${JSON.stringify(type)} moved is_premium`);
  }
});

test('a type that is not a string cannot be coerced into a match', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  for (const type of [['INITIAL_PURCHASE'], { toString: 'INITIAL_PURCHASE' }, 1, true, null]) {
    log = [];
    const res = await signed({ event: { type, app_user_id: '4242', entitlement_ids: ['pro'] } });
    assert.equal(res.status, 200, `${JSON.stringify(type)} -> ${res.status} ${res.text}`);
    assert.deepEqual(writes(), [], `type=${JSON.stringify(type)} moved is_premium`);
  }
});

test("RevenueCat's own dashboard test event is answered, not 400'd", async () => {
  // Step 3 of PAYWALL.md ends with the operator clicking "Send test webhook" in
  // the RevenueCat dashboard. That event's app_user_id is not a Flock user id,
  // so it fell through to the generic 400 and the dashboard showed the brand new
  // webhook as FAILING — at the exact moment somebody is deciding whether the
  // integration works. It is a no-op event either way; the only question is
  // whether the operator is told the truth about it.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  for (const id of ['test_app_user_id', undefined, '$RCAnonymousID:abcdef0123456789']) {
    log = [];
    const res = await signed({ event: { type: 'TEST', app_user_id: id, id: 'evt_test' } });
    assert.equal(res.status, 200, `TEST with app_user_id=${JSON.stringify(id)} -> ${res.status} ${res.text}`);
    assert.deepEqual(writes(), [], 'a TEST event must never write');
  }
});

// ===========================================================================
// 5. One event, one user
// ===========================================================================

test('an event for user A can never reach user B', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({ event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } });
  assert.equal(res.status, 200, res.text);

  const w = premiumWrites();
  assert.equal(w.length, 1);
  // Parameterized, single-row, and the id is a NUMBER — an id that arrives as a
  // string and is handed to Postgres as one is a 22P02 on an int4 column, which
  // the outer catch turns into a 500 and RevenueCat retries forever.
  assert.match(w[0].sql, /WHERE id = \$2/, 'the target must be a bound parameter, not interpolated');
  assert.doesNotMatch(w[0].sql, /4242/, 'the id must never appear in the SQL text');
  assert.equal(typeof w[0].params[1], 'number');
  assert.deepEqual(w[0].params, [true, 4242]);
});

test('an app_user_id that is not exactly a Flock id reaches no query', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const bad = [
    '4242junk',        // parseInt() would have said 4242 and flipped a REAL user
    'junk',
    '99999999999',     // past int4: a 22003 dressed as a 500, retried on their schedule
    '2147483648',
    '-5',
    '0',
    '4.2',
    '',
    ' ',
    '1e3',
    '0x10',
    '+7',
    null,
    true,
    ['4242'],          // an array coerces to "4242" through String()
    { id: 4242 },
    { toString: () => '4242' },
  ];
  for (const id of bad) {
    log = [];
    const res = await signed({ event: { type: 'INITIAL_PURCHASE', app_user_id: id, entitlement_ids: ['pro'] } });
    assert.equal(res.status, 400, `app_user_id=${JSON.stringify(id)} -> ${res.status} ${res.text}`);
    assert.deepEqual(log, [], `app_user_id=${JSON.stringify(id)} reached a query`);
  }
});

test('an anonymous subscriber is a 200 with a reason, not a retried 400', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({
    event: { type: 'INITIAL_PURCHASE', app_user_id: '$RCAnonymousID:0123456789abcdef', entitlement_ids: ['pro'] },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ignored, 'anonymous');
  assert.deepEqual(log, [], 'there is no Flock account behind an anonymous id');
});

test('the largest id the column can hold is still accepted', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({ event: { type: 'INITIAL_PURCHASE', app_user_id: '2147483647', entitlement_ids: ['pro'] } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(premiumWrites()[0].params, [true, 2147483647], 'this is a range check, not a narrowing');
});

// ===========================================================================
// 6. Only the Pro entitlement moves Pro
// ===========================================================================

test('an event for somebody else’s entitlement is ignored', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  for (const event of [
    { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['venue_premium'] },
    { type: 'EXPIRATION', app_user_id: '4242', entitlement_ids: ['venue_premium'] },
    { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_id: 'basic' },
    { type: 'RENEWAL', app_user_id: '4242', entitlement_ids: ['basic', 'plus'] },
  ]) {
    log = [];
    const res = await signed({ event });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ignored, 'entitlement');
    assert.deepEqual(writes(), [],
      'the first non-Pro product added to the project would otherwise have sold Flock Pro at its price');
  }

  // Pro among others still counts, and an event carrying no identifiers at all
  // still acts (RevenueCat omits them on some payloads, and dropping a real
  // entitlement event is a paying subscriber who silently gets nothing).
  for (const event of [
    { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['basic', 'pro'] },
    { type: 'INITIAL_PURCHASE', app_user_id: '4242' },
    { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: [] },
  ]) {
    log = [];
    const res = await signed({ event });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(premiumWrites()[0].params, [true, 4242]);
  }
});

// ===========================================================================
// 7. TRANSFER
// ===========================================================================

test('TRANSFER moves the entitlement between the ids it names and no others', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({
    event: { type: 'TRANSFER', transferred_from: ['11', '12'], transferred_to: ['13'] },
  });
  assert.equal(res.status, 200, res.text);
  const revoke = log.filter((q) => /UPDATE users SET is_premium = false/i.test(q.sql));
  const grant = log.filter((q) => /UPDATE users SET is_premium = true/i.test(q.sql));
  assert.equal(revoke.length, 1);
  assert.equal(grant.length, 1);
  // Both sides present, so both halves ride in ONE statement: the revoke set
  // is $1 and the grant set is $2, and the same log entry answers both filters.
  assert.strictEqual(revoke[0], grant[0], 'a two-sided transfer is a single statement');
  assert.deepEqual(revoke[0].params[0], [11, 12]);
  assert.deepEqual(revoke[0].params[1], [13]);
  assert.match(revoke[0].sql, /ANY\(\$1::int\[\]\)/, 'the set must be a bound int[] parameter');
  assert.match(revoke[0].sql, /ANY\(\$2::int\[\]\)/);
});

test('a two-sided TRANSFER cannot commit the revoke without the grant', async () => {
  // The interleaving window (an id on both sides) was closed earlier by
  // excluding overlapping ids from the revoke set. The FAILURE window was not:
  // two autocommits meant a revoke that landed followed by a grant that threw
  // left the receiving ids non-premium until RevenueCat retried, and every
  // entitlement check is a fresh read. One statement, or nothing.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({
    event: { type: 'TRANSFER', transferred_from: ['21'], transferred_to: ['22'] },
  });
  assert.equal(res.status, 200, res.text);
  const touching = log.filter((q) => /is_premium/i.test(q.sql));
  assert.equal(touching.length, 1, 'exactly one statement touches is_premium');
  assert.match(touching[0].sql, /WITH revoked AS/);
  assert.match(touching[0].sql, /is_premium = false/);
  assert.match(touching[0].sql, /is_premium = true/);
});

test('a TRANSFER naming more ids than one person could own is refused whole', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));

  const at = await signed({ event: { type: 'TRANSFER', transferred_from: ids(50), transferred_to: ids(50, 1000) } });
  assert.equal(at.status, 200, at.text);

  log = [];
  const over = await signed({ event: { type: 'TRANSFER', transferred_to: ids(51) } });
  assert.equal(over.status, 400, 'one webhook rewriting is_premium on an unbounded set of rows');
  assert.deepEqual(log, []);

  // Counted on the RAW array, so a huge list of junk costs nothing to refuse.
  log = [];
  const junk = await signed({ event: { type: 'TRANSFER', transferred_from: Array.from({ length: 5000 }, () => 'nope') } });
  assert.equal(junk.status, 400, junk.text);
  assert.deepEqual(log, []);
});

test('unusable ids inside a TRANSFER are dropped before the int[] parameter', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({
    event: { type: 'TRANSFER', transferred_to: ['7', '2147483648', 'junk', '-3', '0', null, ['9']] },
  });
  assert.equal(res.status, 200, res.text);
  const grant = log.filter((q) => /UPDATE users SET is_premium = true/i.test(q.sql));
  assert.deepEqual(grant[0].params[0], [7]);
});

test('an id on BOTH sides of a TRANSFER is never briefly revoked', async () => {
  // A subscriber's alias set is "every app_user_id this SDK has been logged in
  // as", so an id appearing on both sides is ordinary rather than exotic. The
  // two UPDATEs are separate statements in separate transactions: between them
  // that account reads is_premium = false, and every entitlement check in
  // services/entitlements.js is a fresh read with no cache. A request landing in
  // that window shows a paying subscriber the upgrade sheet. The net result was
  // always right; the window is the bug.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({
    event: { type: 'TRANSFER', transferred_from: ['11', '12'], transferred_to: ['12', '13'] },
  });
  assert.equal(res.status, 200, res.text);
  const revoke = log.filter((q) => /UPDATE users SET is_premium = false/i.test(q.sql));
  assert.deepEqual(revoke[0].params[0], [11],
    'an id that is also on the receiving side must not be revoked on the way through');

  // And a TRANSFER whose every from-id is also a to-id issues no revocation.
  log = [];
  const same = await signed({ event: { type: 'TRANSFER', transferred_from: ['12'], transferred_to: ['12'] } });
  assert.equal(same.status, 200, same.text);
  assert.equal(log.filter((q) => /is_premium = false/i.test(q.sql)).length, 0);
});

test('a TRANSFER of somebody else’s entitlement does not move Flock Pro', async () => {
  // The safe direction of a gap that cannot be closed from here. RevenueCat's
  // TRANSFER payload normally carries no entitlement identifiers at all, so this
  // route cannot tell which entitlement moved and moves Pro on every transfer —
  // fine while `pro` is the only entitlement in the project, wrong the day it is
  // not. When identifiers ARE present they are honoured, which is at least the
  // half of it that can be honoured.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({
    event: {
      type: 'TRANSFER', entitlement_ids: ['venue_premium'],
      transferred_from: ['11'], transferred_to: ['12'],
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ignored, 'entitlement');
  assert.deepEqual(writes(), []);
});

// ===========================================================================
// 7b. Payload shapes that are not the shape the route expects
// ===========================================================================

test('a body that is not the expected shape writes nothing and never 500s', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const bodies = [
    {},
    { event: null },
    { event: 'INITIAL_PURCHASE' },
    { event: [] },
    { event: ['INITIAL_PURCHASE'] },
    { event: 42 },
    [],
    [{ event: { type: 'INITIAL_PURCHASE', app_user_id: '4242' } }],
    'INITIAL_PURCHASE',
    null,
    // JSON.parse puts `__proto__` on the object as an OWN property rather than
    // walking the prototype, so this cannot smuggle a type in. Asserted rather
    // than assumed, because "it cannot" is exactly the claim that changes when a
    // parser is swapped.
    { event: { __proto__: { type: 'INITIAL_PURCHASE', app_user_id: '4242' } } },
    { event: { type: 'INITIAL_PURCHASE', app_user_id: { valueOf: () => 4242 } } },
  ];
  for (const body of bodies) {
    log = [];
    const res = await signed(body);
    assert.ok(res.status === 400 || res.status === 200,
      `${JSON.stringify(body)} -> ${res.status} ${res.text}: a malformed body is a client error, never a 500 RevenueCat retries`);
    assert.deepEqual(writes(), [], `${JSON.stringify(body)} moved is_premium`);
  }
});

test('an empty body is answered without reaching the database', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await fetch(`${base}/api/revenuecat/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(log, []);
});

test('the webhook is POST only', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    log = [];
    const res = await fetch(`${base}/api/revenuecat/webhook`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.status, 404, `${method} reached something`);
    assert.deepEqual(log, []);
  }
});

// ===========================================================================
// 8. Idempotence — RevenueCat retries deliveries
// ===========================================================================

test('a duplicate delivery cannot double-apply', async () => {
  // The property that makes this safe is structural, not defensive: the write is
  // an ABSOLUTE assignment of a boolean, never a toggle and never a delta, so
  // applying it twice lands on the same state as applying it once. Asserted as
  // the shape of the statement, because "we happened not to see a double" is not
  // the same claim.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const body = { event: { id: 'evt_dup_1', type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } };

  const first = await signed(body);
  const firstWrite = premiumWrites()[0];
  log = [];
  const second = await signed(body);
  const secondWrite = premiumWrites()[0];

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'a retry must be answered 200 or RevenueCat keeps retrying it');
  assert.deepEqual(firstWrite.params, secondWrite.params);
  assert.equal(firstWrite.sql, secondWrite.sql);
  assert.match(firstWrite.sql, /SET is_premium = \$1/,
    'an absolute assignment is what makes redelivery a no-op; a toggle or a NOT would not be');
  assert.doesNotMatch(firstWrite.sql, /NOT is_premium|is_premium \+|COALESCE\(is_premium/i);
});

test('a redelivery that changes nothing updates no row', async () => {
  // The row is only rewritten when the value actually differs. RevenueCat
  // retries at 5, 10, 20, 40 and 80 minutes, and a monthly RENEWAL for every
  // subscriber is the highest-volume event this route will ever see: rewriting
  // a row to the value it already holds is pure dead-tuple churn on the users
  // table. It is also the assertion that makes idempotence observable — the
  // second delivery reports rowCount 0.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const res = await signed({ event: { type: 'RENEWAL', app_user_id: '4242', entitlement_ids: ['pro'] } });
  assert.equal(res.status, 200, res.text);
  assert.match(premiumWrites()[0].sql, /is_premium IS DISTINCT FROM \$1/,
    'the guard has to be IS DISTINCT FROM, not `<>`: the column is nullable and `<> true` skips NULL');
});

test('a failed write is a 500, so RevenueCat retries it', async () => {
  // The other half of idempotence. Answering 200 on a failed write marks the
  // event delivered and it is never sent again, which leaves the entitlement
  // permanently stale — a customer who paid and never got Pro, with no event
  // left in the world to fix it.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  handlers = [[/UPDATE users SET is_premium/i, () => new Error('deadlock detected')]];
  const res = await signed({ event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } });
  assert.equal(res.status, 500, 'a swallowed write error is a permanently stale entitlement');
});

// ===========================================================================
// 9. Replay and ordering — the accepted limit
// ===========================================================================

test('a stale delivery replayed after a newer one wins, and that is documented', async () => {
  // REPRODUCTION OF AN ACCEPTED LIMIT, not of a fixed bug.
  //
  // Deliveries are applied in ARRIVAL order. There is nowhere to record an
  // event id or an event timestamp: users.is_premium is a bare boolean, there is
  // no subscription table, and this route may not add a column. So an
  // INITIAL_PURCHASE whose delivery was retried for 80 minutes can land after
  // the EXPIRATION that superseded it, and the account is left premium.
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  const purchase = {
    event: {
      id: 'evt_A', type: 'INITIAL_PURCHASE', app_user_id: '4242',
      entitlement_ids: ['pro'], event_timestamp_ms: 1_700_000_000_000,
    },
  };
  const expiration = {
    event: {
      id: 'evt_B', type: 'EXPIRATION', app_user_id: '4242',
      entitlement_ids: ['pro'], event_timestamp_ms: 1_700_000_600_000,
    },
  };

  await signed(purchase);
  log = [];
  await signed(expiration);
  assert.deepEqual(premiumWrites()[0].params, [false, 4242]);
  log = [];
  const replay = await signed(purchase);
  assert.equal(replay.status, 200);
  assert.deepEqual(premiumWrites()[0].params, [true, 4242],
    'the older event wins on arrival order — this is the documented limit, not a passing grade');

  // It stays a KNOWN limit rather than becoming a forgotten one. If somebody
  // adds the watermark this needs, they delete this pin along with the comment.
  const src = read('routes/revenuecat.js');
  assert.match(src, /REPLAY AND ORDERING/,
    'the accepted limit has to be recorded where the next reader of this route will find it');
  assert.match(src, /arrival order/i);
});

test('replaying a captured request is not a separate hole from holding the secret', () => {
  // Worth stating because it is the intuition this route most often gets
  // audited against: RevenueCat authenticates with a STATIC shared secret in an
  // Authorization header, not with a signature over the body. There is no body
  // integrity to break. Anyone able to replay a captured request necessarily
  // captured the header too, and with the header they can forge any body they
  // like — so a nonce cache or a timestamp window would bound nothing that the
  // secret does not already bound. The secret staying secret IS the boundary.
  const src = read('routes/revenuecat.js');
  assert.match(src, /static shared secret/i,
    'the auth model has to be stated, or the next reader adds a replay window that protects nothing');
});

// ===========================================================================
// 10. routes/billing.js — no client claim of premium, anywhere
// ===========================================================================

test('routes/billing.js reads no premium claim off the request', () => {
  // This file is the BILL SPLIT (who owes whom for dinner), not the paywall. It
  // holds no premium gate at all today, which is why the rule is worth pinning
  // rather than checking: the moment somebody adds a Pro-only bill feature, the
  // cheapest way to write it is `if (req.body.isPremium)`, and frontend gating
  // is cosmetic. users.is_premium is the only answer to that question.
  const src = codeOnly(read('routes/billing.js'));
  assert.doesNotMatch(src, /req\.(body|query|params|headers|user)\s*(\.|\[)\s*['"`]?(is_?premium|premium|isPro|entitlement|tier|plan|subscription)/i,
    'a premium claim must never be read off the request');
  assert.doesNotMatch(src, /['"]x-(premium|pro|tier|entitlement)/i,
    'a premium claim must never be read off a header');
  // If a gate is ever added it must consult the column, through the one service
  // that reads it.
  if (/premium/i.test(src)) {
    assert.match(src, /require\('\.\.\/services\/entitlements'\)/,
      'any premium-gated behaviour in this file must come from services/entitlements.js, which reads users.is_premium');
  }
});

test('a client-supplied premium claim changes nothing a billing route does', async () => {
  handlers = [
    [/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/FROM flock_members fm JOIN users u/, () => ({ rows: [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }], rowCount: 2 })],
    [/FROM user_blocks/, () => ({ rows: [], rowCount: 0 })],
    [/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: 1 }], rowCount: 1 })],
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 5 }], rowCount: 1 })],
    [/SELECT id, paid_by FROM bill_splits/, () => ({ rows: [], rowCount: 0 })],
    [/INSERT INTO bill_splits/, () => ({ rows: [{ id: 99 }], rowCount: 1 })],
  ];
  const res = await fetch(`${base}/api/billing/5/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Premium': 'true', 'X-Tier': 'pro' },
    body: JSON.stringify({
      totalAmount: 40,
      isPremium: true,
      premium: true,
      is_premium: true,
      tier: 'premium',
      entitlement: 'pro',
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  assert.deepEqual(log.filter((q) => /is_premium/i.test(q.sql)), [],
    'a billing route must never read or write the premium column');
  assert.doesNotMatch(text, /"(isPremium|premium|is_premium|tier|entitlement)"/,
    'and must never echo a client premium claim back as though the server agreed with it');
});

test('every statement routes/billing.js issues is parameterized', () => {
  const src = codeOnly(read('routes/billing.js'));
  // A template literal inside a query string is how interpolation gets in. The
  // only ones in this file are the socket room names, which are not SQL.
  const queries = src.match(/(?:pool|client)\.query\(\s*`[\s\S]*?`/g) || [];
  assert.ok(queries.length > 10, 'the scan found no queries, so it is not scanning anything');

  // ONE narrow exception, and it is narrowed by proof rather than by name.
  //
  // routes/budget.js exports MEMBER_SUBMISSIONS, a fixed FROM fragment that
  // joins budget_submissions to flock_members, so the reveal threshold is
  // counted over people who are still in the room. routes/billing.js asks the
  // same threshold in two places and has to ask it the same way, or the two
  // routes disagree about when a budget ceiling may be published (they did,
  // until 2026-08-26). Retyping the join here to satisfy a scanner would put a
  // second copy of the rule in the codebase, which is the failure the shared
  // constant exists to prevent.
  //
  // What makes it safe is not that it is a constant, it is that its VALUE is
  // checked below: the fragment itself is scanned for interpolation and for a
  // placeholder, so it cannot become a channel for anything a request carries.
  const { MEMBER_SUBMISSIONS } = require('../routes/budget');
  assert.strictEqual(typeof MEMBER_SUBMISSIONS, 'string', 'the exception has to name something real');
  assert.doesNotMatch(MEMBER_SUBMISSIONS, /\$\{|\$\d/, 'the shared fragment is a fixed FROM clause, nothing else');

  for (const q of queries) {
    const interpolations = q.match(/\$\{[^}]*\}/g) || [];
    for (const i of interpolations) {
      assert.strictEqual(i, '${MEMBER_SUBMISSIONS}', `interpolated SQL: ${q.slice(0, 120)}`);
    }
  }
});
