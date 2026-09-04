// Run: node --test  (from backend/)
//
// Money-layer security regressions (audit 2026-08-13). Everything here is
// driven through the real Express routers with a scripted pg fake, so the
// assertions are about what the route actually sends and writes, not about a
// helper the route might stop calling.
//
// Covers:
//   1. Budget privacy — no endpoint or error path emits an individual member's
//      amount. Responses are scanned for the victim's number, not just for the
//      documented keys.
//   2. Bill-split integrity — payer changes cannot leave the former payer
//      settled, and a settled share cannot be erased by a rewrite.
//   3. Bill-split authorization — membership is required by every route that
//      settles a debt or discloses payment handles; ghost commit cannot write
//      into a finalized bill.
//   4. Purchase state — only a secret-authenticated RevenueCat webhook carrying
//      the Pro entitlement moves users.is_premium.
//   5. Venue tier — never writable by the client, enforced server-side, and
//      fail-closed.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'money-test-secret';

// ---------------------------------------------------------------------------
// Scripted pg fake. Handlers are [regex, fn(params, sql)] and match in order.
// Anything unmatched throws, so a route that grows a new query fails loudly
// instead of silently reading undefined.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).slice(0, 120)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: sql.trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

// Auth + push are stubbed BEFORE the routers are required, because the routers
// destructure both at module load.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => {};
pushMod.pushAlways = async () => {};

const budgetRouter = require('../routes/budget');
const billingRouter = require('../routes/billing');
const venueProfileRouter = require('../routes/venueProfile');
const revenuecatRouter = require('../routes/revenuecat');
const { requireVenueTier } = require('../services/venueEntitlements');

const app = express();
app.use(express.json());
app.use('/api/budget', budgetRouter);
app.use('/api/billing', billingRouter);
app.use('/api/venue-profile', venueProfileRouter);
app.use('/api/revenuecat', revenuecatRouter);
app.get('/gated', (req, _res, next) => { req.user = CURRENT_USER; next(); }, requireVenueTier('premium'), (_req, res) => res.json({ ok: true }));

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

test.beforeEach(() => { handlers = []; log = []; CURRENT_USER = { id: 1, name: 'Ava', role: 'user' }; });

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const isMember = () => ({ rows: [{ id: 9 }] });
const noMember = () => ({ rows: [] });
const inserts = (table) => log.filter((q) => q.sql.startsWith(`INSERT INTO ${table}`));
const deletes = (table) => log.filter((q) => q.sql.startsWith(`DELETE FROM ${table}`));

// ---------------------------------------------------------------------------
// 1. Budget privacy
// ---------------------------------------------------------------------------

// The hard invariant (CLAUDE.md): the client sees { ceiling, submissionCount,
// isReady, skipCount } and nothing else. VICTIM_AMOUNT is a value no aggregate
// in these fixtures can coincidentally equal, so finding it anywhere in a
// response body is proof of a leak.
const VICTIM_AMOUNT = 37.11;

// `locked` is the settle flag, and it is what decides whether a number is
// published at all. GET no longer recomputes a live MIN: a ceiling that a
// polling client can watch change is the differencing leak this route closed in
// round 22, so flocks.budget_ceiling is written only when the budget settles
// and this route serves that column or nothing. See settledCeiling in
// routes/budget.js.
function scriptBudgetStatus({ nonSkip, skip, ceiling, callerRow, locked = false }) {
  handlers = [
    [/SELECT id FROM flock_members/, isMember],
    [/SELECT budget_enabled, budget_context/, () => ({
      rows: [{
        budget_enabled: true, budget_context: 'dinner', budget_locked: locked,
        budget_ceiling: ceiling, ghost_mode_enabled: false,
      }],
    })],
    [/COUNT\(\*\) AS total_submissions/, () => ({
      rows: [{ total_submissions: String(nonSkip + skip), non_skip_count: String(nonSkip), skip_count: String(skip) }],
    })],
    [/COUNT\(\*\) AS total FROM flock_members/, () => ({ rows: [{ total: '4' }] })],
    [/SELECT amount, skipped FROM budget_submissions/, () => ({ rows: callerRow ? [callerRow] : [] })],
  ];
}

test('budget status below the anonymity threshold reveals no number at all', async () => {
  // Two people submitted; the victim's 37.11 is the MIN and therefore the
  // cached flocks.budget_ceiling. It must not reach the wire.
  scriptBudgetStatus({ nonSkip: 2, skip: 1, ceiling: VICTIM_AMOUNT, callerRow: null });

  const res = await call('GET', '/api/budget/42');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ceiling, null);
  assert.strictEqual(res.body.isReady, false);
  assert.strictEqual(res.body.userAmount, null);
  // Whole-body scan: no field, however named, carries the victim's amount.
  assert.ok(!res.text.includes('37.11'), `individual amount leaked: ${res.text}`);
});

test('budget status exposes only the four aggregate fields plus the caller own row', async () => {
  scriptBudgetStatus({ nonSkip: 3, skip: 1, ceiling: 55, callerRow: { amount: '80.00', skipped: false }, locked: true });

  const res = await call('GET', '/api/budget/42');

  assert.strictEqual(res.status, 200);
  // 55 is the cached MIN; 50 is the band it publishes. The reveal is rounded
  // down to the nearest $10 above $50 so that the number on the wire is never
  // one identifiable person's exact amount (audit finding M1). Down, never up:
  // a venue at $50 is still inside everyone's budget.
  assert.strictEqual(res.body.ceiling, 50);
  assert.strictEqual(res.body.isReady, true);
  assert.strictEqual(res.body.submissionCount, 4);
  // Withheld on every read, settled or not (round 23). The skip/share split is
  // published once, in the payload that settles the budget, for the reason the
  // ceiling is: read twice around somebody's answer, or around a departure, its
  // delta is a fact about one named person. See publishableSkipCount.
  assert.strictEqual(res.body.skipCount, null);
  // Only the CALLER's own amount comes back, and only theirs.
  assert.strictEqual(res.body.userAmount, 80);

  // Nothing else may appear. A new key here is a privacy review, not a merge.
  assert.deepStrictEqual(Object.keys(res.body).sort(), [
    'budgetContext', 'budgetEnabled', 'budgetLocked', 'ceiling', 'isReady',
    'skipCount', 'submissionCount', 'totalMembers', 'userAmount', 'userSkipped', 'userSubmitted',
  ]);
});

test('budget status publishes no number while the budget is still open', async () => {
  // Four members, three amounts shared, one person yet to answer. Everything
  // needed for a number exists and the number is still withheld, because the
  // next answer could move it and a member who watched both would know whose
  // answer moved it. isReady stays true: it says the group CAN settle, which
  // is what the creator's Lock button is gated on, not that here is the number.
  scriptBudgetStatus({ nonSkip: 3, skip: 0, ceiling: 55, callerRow: { amount: '80.00', skipped: false } });

  const res = await call('GET', '/api/budget/42');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ceiling, null);
  assert.strictEqual(res.body.isReady, true);
  assert.strictEqual(res.body.budgetLocked, false);
  assert.ok(!res.text.includes('55'), `an unsettled ceiling reached the wire: ${res.text}`);
});

test('a non-member gets 403 from budget status, not a redacted body it can diff', async () => {
  handlers = [[/SELECT id FROM flock_members/, noMember]];

  const res = await call('GET', '/api/budget/42');

  assert.strictEqual(res.status, 403);
  assert.ok(!('ceiling' in (res.body || {})));
  assert.ok(!('submissionCount' in (res.body || {})));
});

test('submitting a budget echoes aggregates only, never a neighbour amount', async () => {
  handlers = [
    [/SELECT id FROM flock_members WHERE flock_id/, isMember],
    [/SELECT budget_enabled, budget_locked FROM flocks/, () => ({ rows: [{ budget_enabled: true, budget_locked: false }] })],
    [/SELECT skipped FROM budget_submissions/, () => ({ rows: [] })],
    [/INSERT INTO budget_submissions/, () => ({ rows: [] })],
    [/SELECT MIN\(amount\) AS ceiling/, () => ({ rows: [{ ceiling: String(VICTIM_AMOUNT) }] })],
    [/UPDATE flocks SET budget_ceiling/, () => ({ rows: [] })],
    [/user_id != \$2/, () => ({ rows: [{ n: 1 }] })],
    [/COUNT\(\*\) AS total_submissions/, () => ({ rows: [{ total_submissions: '2', non_skip_count: '2', skip_count: '0' }] })],
    [/COUNT\(\*\) AS total FROM flock_members/, () => ({ rows: [{ total: '4' }] })],
  ];

  const res = await call('POST', '/api/budget/42/submit', { amount: 90 });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.isReady, false);
  assert.strictEqual(res.body.ceiling, null);
  assert.ok(!res.text.includes('37.11'), `individual amount leaked on submit: ${res.text}`);
});

test('the budget lock refuses to publish a ceiling backed by fewer than three people', async () => {
  handlers = [
    // The membership gate /lock now runs first, so that a stranger's refusal
    // cannot be used to tell a real flock id from a fake one. The creator is
    // always an accepted member.
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT creator_id, budget_enabled, budget_locked FROM flocks/, () => ({ rows: [{ creator_id: 1, budget_enabled: true, budget_locked: false }] })],
    [/COUNT\(\*\)::int AS n FROM budget_submissions/, () => ({ rows: [{ n: 2 }] })],
    [/SELECT MIN\(amount\)/, () => ({ rows: [{ ceiling: String(VICTIM_AMOUNT) }] })],
  ];

  const res = await call('POST', '/api/budget/42/lock');

  assert.strictEqual(res.status, 400);
  assert.ok(!res.text.includes('37.11'));
  // It must bail out BEFORE the MIN is even read.
  assert.ok(!log.some((q) => /MIN\(amount\)/.test(q.sql)));
});

// ---------------------------------------------------------------------------
// 2 + 3. Bill-split integrity and authorization
// ---------------------------------------------------------------------------

function scriptBillCreate({ existingBill, existingShares, members, creatorId = 1 }) {
  handlers = [
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT u\.id, u\.name FROM flock_members/, () => ({ rows: members })],
    // Every view of a bill is block-filtered (2026-08-14): the 201 body, the
    // socket fan-out and the GET all drop shares belonging to someone the
    // reader cannot see. Nobody blocks anybody in these fixtures.
    [/FROM user_blocks/, () => ({ rows: [] })],
    [/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: creatorId }] })],
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id, paid_by FROM bill_splits/, () => ({ rows: existingBill ? [existingBill] : [] })],
    // `amount` joined this SELECT so that owesMore can fire at all; before it
    // did, Number(row.amount) was NaN and every settled row survived every
    // increase. The pattern is loose on the column list on purpose - it exists
    // to answer the share lookup, not to pin its SELECT list.
    [/SELECT user_id, .*FROM bill_split_shares/, () => ({ rows: existingShares || [] })],
    [/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] })],
    [/DELETE FROM bill_split_shares/, () => ({ rows: [], rowCount: 0 })],
    [/INSERT INTO bill_split_shares/, () => ({ rows: [] })],
  ];
}

const THREE = [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }, { id: 3, name: 'Cy' }];

test('changing the payer does not leave the former payer marked settled', async () => {
  // Ava opened the bill, so her share was auto-settled as the payer. She now
  // rewrites it with Ben as payer. If her settled flag survives she owes Ben
  // nothing while Cy still owes — a free meal, one API call.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBillCreate({
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date() },
      { user_id: 2, committed: false, settled: false, settled_at: null },
      { user_id: 3, committed: false, settled: false, settled_at: null },
    ],
    members: THREE,
  });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90, paidBy: 2 });

  assert.strictEqual(res.status, 201);
  const ava = res.body.bill.shares.find((s) => s.userId === 1);
  const ben = res.body.bill.shares.find((s) => s.userId === 2);
  assert.strictEqual(ava.settled, false, 'the former payer must owe the new payer');
  assert.strictEqual(ben.settled, true, 'the new payer is the one who fronted the money');

  // And the DB write agrees with the response.
  const avaRow = inserts('bill_split_shares').find((q) => q.params[1] === 1);
  assert.strictEqual(avaRow.params[4], false);
});

test('a payer who stays the payer keeps their settled row', async () => {
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBillCreate({
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [{ user_id: 1, committed: false, settled: true, settled_at: new Date() }],
    members: THREE,
  });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90 });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.bill.shares.find((s) => s.userId === 1).settled, true);
});

test('a settled share survives a rewrite that drops it from the split', async () => {
  // The re-issue exploit: rewrite once with custom shares that omit Cy (who
  // already paid), rewrite again including him, and he is billed twice with no
  // record of the first payment. The delete must spare settled rows.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBillCreate({
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date() },
      { user_id: 3, committed: false, settled: true, settled_at: new Date() },
    ],
    members: THREE,
  });

  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 60,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 30 }, { userId: 2, amount: 30 }],
  });

  assert.strictEqual(res.status, 201);

  const dels = deletes('bill_split_shares');
  assert.strictEqual(dels.length, 2, 'expected a scoped delete plus an unsettled-only delete');

  // First delete only touches users still in the split.
  assert.ok(/user_id = ANY/.test(dels[0].sql));
  assert.deepStrictEqual(dels[0].params[1], [1, 2]);

  // Second delete removes dropped users ONLY when they never settled. Cy is
  // settled and not in [1,2], so this statement cannot reach him.
  assert.ok(/settled = false/.test(dels[1].sql), dels[1].sql);
  assert.ok(/user_id <> ALL/.test(dels[1].sql), dels[1].sql);
  assert.deepStrictEqual(dels[1].params[1], [1, 2]);

  // No unconditional "DELETE ... WHERE bill_id = $1" remains.
  assert.ok(!dels.some((d) => /WHERE bill_id = \$1$/.test(d.sql)), 'blanket share delete is back');
});

test('a bill revised upward un-settles whoever now owes more than they paid', async () => {
  // THE GUARD WAS DEAD. `owesMore` is computed from existingAmounts, and the
  // SELECT that fills existingAmounts did not include `amount`. Number(undefined)
  // is NaN, `typeof NaN === 'number'` passes, and every comparison against NaN
  // is false - so owesMore was false for every share on every edit and a settled
  // row survived any increase. The push loop only notifies UNSETTLED shares, so
  // the person who had paid $30 was not told the bill had trebled either.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBillCreate({
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date(), amount: '30.00' },
      { user_id: 2, committed: false, settled: true, settled_at: new Date(), amount: '30.00' },
      { user_id: 3, committed: false, settled: false, settled_at: null, amount: '30.00' },
    ],
    members: THREE,
  });

  // $90 becomes $300: each share goes from $30 to $100.
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 300, paidBy: 1 });

  assert.strictEqual(res.status, 201, res.text);
  const ben = res.body.bill.shares.find((sh) => sh.userId === 2);
  assert.strictEqual(ben.settled, false,
    'Ben paid $30 against a $100 share and is still marked settled');
  const benRow = inserts('bill_split_shares').find((q) => q.params[1] === 2);
  assert.strictEqual(benRow.params[4], false, 'the response and the row disagree');

  // AND THE COLUMN THE RULE READS IS ACTUALLY SELECTED. The fake above answers
  // the share lookup out of a fixture object, so it hands back `amount` whether
  // or not the SQL asked for it - Postgres does not. That is exactly how the
  // original defect survived: the guard read row.amount, the SELECT never listed
  // it, and no assertion about behaviour could tell the difference. Pin the
  // statement, because the statement is the thing that was wrong.
  const shareSelect = log.find((q) => /SELECT user_id.*FROM bill_split_shares/.test(q.sql));
  assert.ok(shareSelect, 'the existing shares were never read');
  assert.match(shareSelect.sql, /SELECT user_id, amount,/,
    'amount is missing from the share SELECT, so Number(row.amount) is NaN and ' +
    'owesMore can never be true - a settled share survives any increase');

  // The payer keeps their flag: it records having fronted the money, not a debt.
  assert.strictEqual(res.body.bill.shares.find((sh) => sh.userId === 1).settled, true);
});

test('a bill revised downward leaves a settled share alone', async () => {
  // The other half of the same rule, and the reason owesMore is a comparison
  // rather than a blanket reset: somebody who paid $50 against a share that is
  // now $20 is square or ahead, and un-settling them would invent a debt.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBillCreate({
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date(), amount: '50.00' },
      { user_id: 2, committed: false, settled: true, settled_at: new Date(), amount: '50.00' },
      { user_id: 3, committed: false, settled: false, settled_at: null, amount: '50.00' },
    ],
    members: THREE,
  });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 60, paidBy: 1 });

  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.bill.shares.find((sh) => sh.userId === 2).settled, true,
    'a smaller share un-settled somebody who had already overpaid it');
});

test('the flock creator cannot move an existing bill onto themselves', async () => {
  // The creator is allowed to correct a bill they did not pay, because someone
  // has to be able to fix a typed total. `paid_by` is a different thing: it is
  // what GET /payment-links turns into a Venmo, Cash App and Zelle handle.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBillCreate({
    existingBill: { id: 7, paid_by: 2 },
    existingShares: [
      { user_id: 1, committed: false, settled: false, settled_at: null, amount: '30.00' },
      { user_id: 2, committed: false, settled: true, settled_at: new Date(), amount: '30.00' },
      { user_id: 3, committed: false, settled: false, settled_at: null, amount: '30.00' },
    ],
    members: THREE,
    creatorId: 1,
  });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90, paidBy: 1 });

  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(inserts('bill_splits').length, 0, 'the payer was rewritten anyway');
});

test('the flock creator may still correct the total on a bill they did not pay', async () => {
  // The guard above must not cost the creator the edit itself.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBillCreate({
    existingBill: { id: 7, paid_by: 2 },
    existingShares: [
      { user_id: 1, committed: false, settled: false, settled_at: null, amount: '30.00' },
      { user_id: 2, committed: false, settled: true, settled_at: new Date(), amount: '30.00' },
      { user_id: 3, committed: false, settled: false, settled_at: null, amount: '30.00' },
    ],
    members: THREE,
    creatorId: 1,
  });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 120, paidBy: 2 });

  assert.strictEqual(res.status, 201, res.text);
});

test('a plain member cannot open the first bill in someone else name', async () => {
  CURRENT_USER = { id: 3, name: 'Cy', role: 'user' };
  scriptBillCreate({ existingBill: null, members: THREE, creatorId: 1 });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90, paidBy: 2 });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(inserts('bill_splits').length, 0);
});

test('a member who is not the payer cannot rewrite an existing bill', async () => {
  CURRENT_USER = { id: 3, name: 'Cy', role: 'user' };
  scriptBillCreate({ existingBill: { id: 7, paid_by: 2 }, members: THREE, creatorId: 1 });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 5, paidBy: 3 });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(inserts('bill_splits').length, 0);
});

test('custom shares cannot assign debt to someone outside the flock', async () => {
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBillCreate({ existingBill: null, members: THREE, creatorId: 1 });

  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 60,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 30 }, { userId: 999, amount: 30 }],
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(inserts('bill_split_shares').length, 0);
});

test('settling requires flock membership, not merely a leftover share row', async () => {
  handlers = [
    [/SELECT id FROM flock_members/, noMember],
    [/SELECT id FROM bill_splits/, () => ({ rows: [{ id: 7 }] })],
    [/UPDATE bill_split_shares SET settled/, () => ({ rows: [{ id: 1 }] })],
  ];

  const res = await call('POST', '/api/billing/42/settle');

  assert.strictEqual(res.status, 403);
  assert.ok(!log.some((q) => /UPDATE bill_split_shares/.test(q.sql)), 'settle wrote despite 403');
});

test('payment handles are not readable by an ex-member holding a stale share', async () => {
  for (const path of ['/api/billing/42/venmo-link', '/api/billing/42/payment-links']) {
    handlers = [
      [/SELECT id FROM flock_members/, noMember],
      [/FROM bill_splits bs/, () => ({ rows: [{ id: 7, paid_by: 2, flock_id: 42, flock_name: 'Dinner' }] })],
      [/SELECT amount FROM bill_split_shares/, () => ({ rows: [{ amount: '30.00' }] })],
      [/venmo_username/, () => ({ rows: [{ name: 'Ben', venmo_username: 'ben-v', cashapp_cashtag: 'benc', zelle_identifier: 'ben@x.com' }] })],
    ];

    const res = await call('GET', path);

    assert.strictEqual(res.status, 403, path);
    assert.ok(!res.text.includes('ben-v'), `${path} leaked a payment handle`);
    assert.ok(!res.text.includes('ben@x.com'), `${path} leaked a payment handle`);
  }
});

test('ghost commit cannot write a share into a bill that is already finalized', async () => {
  // Without this, a member left out of a custom split could INSERT themselves a
  // share at the budget ceiling, flip `committed` on the payer's finalized
  // rows, and unlock /payment-links (which discloses the payer's handles).
  handlers = [
    [/SELECT id FROM flock_members/, isMember],
    [/SELECT budget_ceiling, budget_locked, status, ghost_mode_enabled/, () => ({ rows: [{ budget_ceiling: '40.00', budget_locked: true, status: 'confirmed', ghost_mode_enabled: true }] })],
    [/COUNT\(\*\)::int AS n FROM budget_submissions/, () => ({ rows: [{ n: 3 }] })],
    [/COUNT\(\*\) AS count FROM flock_members/, () => ({ rows: [{ count: '3' }] })],
    [/SELECT id, paid_by FROM bill_splits/, () => ({ rows: [{ id: 7, paid_by: 2 }] })],
    [/INSERT INTO bill_split_shares/, () => ({ rows: [] })],
  ];

  const res = await call('POST', '/api/billing/42/ghost-commit');

  assert.strictEqual(res.status, 400);
  assert.strictEqual(inserts('bill_split_shares').length, 0);
});

test('ghost commit still works against an unclaimed placeholder bill', async () => {
  handlers = [
    [/SELECT id FROM flock_members/, isMember],
    [/SELECT budget_ceiling, budget_locked, status, ghost_mode_enabled/, () => ({ rows: [{ budget_ceiling: '40.00', budget_locked: true, status: 'confirmed', ghost_mode_enabled: true }] })],
    [/COUNT\(\*\)::int AS n FROM budget_submissions/, () => ({ rows: [{ n: 3 }] })],
    [/COUNT\(\*\) AS count FROM flock_members/, () => ({ rows: [{ count: '3' }] })],
    [/SELECT id, paid_by FROM bill_splits/, () => ({ rows: [{ id: 7, paid_by: null }] })],
    [/INSERT INTO bill_split_shares/, () => ({ rows: [] })],
  ];

  const res = await call('POST', '/api/billing/42/ghost-commit');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.committed, true);
});

test('ghost commit stays below the anonymity threshold and inside DECIMAL(8,2)', async () => {
  handlers = [
    [/SELECT id FROM flock_members/, isMember],
    [/SELECT budget_ceiling, budget_locked, status, ghost_mode_enabled/, () => ({ rows: [{ budget_ceiling: '9999.00', budget_locked: true, status: 'confirmed', ghost_mode_enabled: true }] })],
    [/COUNT\(\*\)::int AS n FROM budget_submissions/, () => ({ rows: [{ n: 2 }] })],
  ];
  const blocked = await call('POST', '/api/billing/42/ghost-commit');
  assert.strictEqual(blocked.status, 400);
  assert.ok(!blocked.text.includes('9999'), 'ghost commit leaked the ceiling below the threshold');

  // Same ceiling, threshold met, an oversized roster: the placeholder total is
  // clamped rather than overflowing the column into a 500.
  handlers = [
    [/SELECT id FROM flock_members/, isMember],
    [/SELECT budget_ceiling, budget_locked, status, ghost_mode_enabled/, () => ({ rows: [{ budget_ceiling: '9999.00', budget_locked: true, status: 'confirmed', ghost_mode_enabled: true }] })],
    [/COUNT\(\*\)::int AS n FROM budget_submissions/, () => ({ rows: [{ n: 3 }] })],
    [/COUNT\(\*\) AS count FROM flock_members/, () => ({ rows: [{ count: '500' }] })],
    [/SELECT id, paid_by FROM bill_splits/, () => ({ rows: [] })],
    [/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] })],
    [/INSERT INTO bill_split_shares/, () => ({ rows: [] })],
  ];
  const ok = await call('POST', '/api/billing/42/ghost-commit');
  assert.strictEqual(ok.status, 200);
  assert.ok(inserts('bill_splits')[0].params[1] <= 999999.99);
});

// ---------------------------------------------------------------------------
// 4. Purchase state
// ---------------------------------------------------------------------------

const RC_SECRET = 'rc-shared-secret-value';

async function rcPost(headers, body) {
  const res = await fetch(base + '/api/revenuecat/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test('premium is never granted without the shared secret', async () => {
  handlers = [[/UPDATE users SET is_premium/, () => ({ rows: [] })]];

  delete process.env.REVENUECAT_WEBHOOK_SECRET;
  const unconfigured = await rcPost({}, { event: { type: 'INITIAL_PURCHASE', app_user_id: '1' } });
  assert.strictEqual(unconfigured.status, 503, 'no secret configured must fail closed');

  process.env.REVENUECAT_WEBHOOK_SECRET = RC_SECRET;
  const anon = await rcPost({}, { event: { type: 'INITIAL_PURCHASE', app_user_id: '1' } });
  assert.strictEqual(anon.status, 401);

  const wrong = await rcPost({ Authorization: 'Bearer not-the-secret-value' }, { event: { type: 'INITIAL_PURCHASE', app_user_id: '1' } });
  assert.strictEqual(wrong.status, 401);

  assert.strictEqual(log.filter((q) => /UPDATE users SET is_premium/.test(q.sql)).length, 0);
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
});

test('only the Pro entitlement moves is_premium', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = RC_SECRET;
  handlers = [[/UPDATE users SET is_premium/, () => ({ rows: [] })]];
  const auth = { Authorization: `Bearer ${RC_SECRET}` };

  // A different product in the same RevenueCat project must not grant Pro...
  const foreign = await rcPost(auth, { event: { type: 'INITIAL_PURCHASE', app_user_id: '5', entitlement_ids: ['venue_boost'] } });
  assert.strictEqual(foreign.status, 200);
  assert.strictEqual(log.filter((q) => /UPDATE users SET is_premium/.test(q.sql)).length, 0);

  // ...nor may its expiry revoke Pro from a paying subscriber.
  const foreignExpiry = await rcPost(auth, { event: { type: 'EXPIRATION', app_user_id: '5', entitlement_id: 'venue_boost' } });
  assert.strictEqual(foreignExpiry.status, 200);
  assert.strictEqual(log.filter((q) => /UPDATE users SET is_premium/.test(q.sql)).length, 0);

  // The real thing still provisions.
  const real = await rcPost(auth, { event: { type: 'INITIAL_PURCHASE', app_user_id: '5', entitlement_ids: ['pro'] } });
  assert.strictEqual(real.status, 200);
  const writes = log.filter((q) => /UPDATE users SET is_premium/.test(q.sql));
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(writes[0].params, [true, 5]);

  delete process.env.REVENUECAT_WEBHOOK_SECRET;
});

test('cancellation and billing issues keep access that was paid for', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = RC_SECRET;
  handlers = [[/UPDATE users SET is_premium/, () => ({ rows: [] })]];
  const auth = { Authorization: `Bearer ${RC_SECRET}` };

  for (const type of ['CANCELLATION', 'BILLING_ISSUE']) {
    await rcPost(auth, { event: { type, app_user_id: '5', entitlement_ids: ['pro'] } });
  }
  assert.strictEqual(log.filter((q) => /UPDATE users SET is_premium/.test(q.sql)).length, 0);

  await rcPost(auth, { event: { type: 'EXPIRATION', app_user_id: '5', entitlement_ids: ['pro'] } });
  const writes = log.filter((q) => /UPDATE users SET is_premium/.test(q.sql));
  assert.deepStrictEqual(writes[0].params, [false, 5]);

  delete process.env.REVENUECAT_WEBHOOK_SECRET;
});

test('the dormant paywall is env-only: no request can turn it on', async () => {
  // PAYWALL_ENABLED is read from the environment on every call, never from the
  // request, so there is no header, body or query that flips it.
  delete require.cache[require.resolve('../services/entitlements')];
  const ent = require('../services/entitlements');

  delete process.env.PAYWALL_ENABLED;
  assert.strictEqual(ent.paywallEnabled(), false);
  for (const v of ['1', 'yes', 'TRUE', 'true ', '']) {
    process.env.PAYWALL_ENABLED = v;
    assert.strictEqual(ent.paywallEnabled(), false, `PAYWALL_ENABLED=${JSON.stringify(v)} must not enable the paywall`);
  }
  process.env.PAYWALL_ENABLED = 'true';
  assert.strictEqual(ent.paywallEnabled(), true);
  delete process.env.PAYWALL_ENABLED;
});

// ---------------------------------------------------------------------------
// 5. Venue tier
// ---------------------------------------------------------------------------

test('a venue cannot promote itself by sending a tier', async () => {
  handlers = [[/UPDATE venue_profiles SET/, () => ({ rows: [{ id: 3, tier: 'free' }] })]];

  const res = await call('PUT', '/api/venue-profile', { businessName: 'Bar', tier: 'pro' });

  assert.strictEqual(res.status, 200);
  const update = log.find((q) => /UPDATE venue_profiles SET/.test(q.sql));
  assert.ok(!/\btier\s*=/.test(update.sql), 'the update writes a tier column');
  assert.ok(!update.params.includes('pro'), 'the client tier reached the query parameters');
});

test('venue onboarding never downgrades an existing privileged role', async () => {
  handlers = [
    [/SELECT 1 FROM venue_profiles WHERE google_place_id/, () => ({ rows: [] })],
    [/UPDATE users SET role/, () => ({ rows: [] })],
    // The saved row must carry the place id: the self-promotion gate
    // (venueOwner.test.js section 2b) only reaches the role write for a
    // stored, place-id-backed claim.
    [/INSERT INTO venue_profiles/, () => ({ rows: [{ id: 3, google_place_id: 'place_money1' }] })],
  ];

  const res = await call('POST', '/api/venue-profile', { businessName: 'Bar', googlePlaceId: 'place_money1' });

  assert.strictEqual(res.status, 201);
  const roleWrite = log.find((q) => /UPDATE users SET role/.test(q.sql));
  // An admin who opens venue onboarding must not lose the admin role — nothing
  // in the codebase grants it back.
  assert.ok(/role NOT IN/.test(roleWrite.sql), roleWrite.sql);
  assert.ok(/'admin'/.test(roleWrite.sql), roleWrite.sql);
});

test('the paid venue boundary is enforced server-side and fails closed', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';

  handlers = [[/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'free' }] })]];
  const free = await call('GET', '/gated');
  assert.strictEqual(free.status, 403);
  assert.strictEqual(free.body.code, 'UPGRADE_REQUIRED');

  // An unknown/garbage tier is treated as free, not as a bypass.
  handlers = [[/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'enterprise' }] })]];
  assert.strictEqual((await call('GET', '/gated')).status, 403);

  // A lookup failure denies rather than admits.
  handlers = [[/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => { throw new Error('db down'); }]];
  assert.strictEqual((await call('GET', '/gated')).status, 403);

  handlers = [[/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'pro' }] })]];
  assert.strictEqual((await call('GET', '/gated')).status, 200);

  delete process.env.VENUE_BILLING_ENABLED;
});
