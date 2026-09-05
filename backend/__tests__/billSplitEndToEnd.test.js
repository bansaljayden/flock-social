// Run: node --test  (from backend/)
//
// THE BILL SPLIT, WALKED AS THE PEOPLE IN IT (audit 2026-08-26)
//
// Flock never touches this money. It hands a debtor off to Venmo, Cash App or
// Zelle and waits for somebody to come back and say they paid. That makes every
// defect in this area a defect about a real transfer between two friends, and
// it makes the wording of every string on the path a claim about a fact the
// server does not have.
//
// What this file pins, in the order the two sides meet it:
//
//   1. A bill with nobody on the paying end. bill_splits.paid_by is
//      ON DELETE SET NULL and a ghost commit opens a bill with it already NULL,
//      so "no payer" is a state both the sheet and the pay button have to
//      answer for. It used to be answered with 404 "Payer not found".
//   2. Settling a bill nobody has paid. Against a ghost shell this was a free
//      dinner: settle the estimate, and the real bill inherited the flag.
//   3. Settling twice. The timestamp moved and the payer was re-notified.
//   4. Taking a settlement back, which was impossible until this audit.
//   5. The arithmetic: shares sum to the total, exactly, in integer cents.
//   6. Honesty: no string on this path says Flock saw, held or checked money.
//   7. Authorisation: non-members read nothing, and nobody settles for anybody
//      else.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'bill-split-e2e-secret';

// ---------------------------------------------------------------------------
// Scripted pg fake, same contract as money.test.js: [regex, fn(params, sql)],
// matched in order, and anything unmatched throws so a route that grows a query
// fails loudly rather than silently reading undefined.
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
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 160)}`));
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

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
let pushCalls = [];
pushMod.pushIfOffline = async (_io, userId, title, body, data) => {
  pushCalls.push({ userId, title, body, data });
};
pushMod.pushAlways = async () => {};
// The settle route skips every query behind the payer notification when push is
// not configured, so the delivery cases need it on.
let pushConfigured = true;
pushMod.isPushConfigured = () => pushConfigured;

const billingRouter = require('../routes/billing');

// Socket fan-out is recorded, never asserted on for its own sake here; the
// delivery rules have their own suite (billingDelivery.test.js).
let emits = [];
const io = {
  to: (room) => ({ emit: (event, payload) => { emits.push({ room, event, payload }); } }),
};

const app = express();
app.use(express.json());
app.set('io', io);
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
  emits = [];
  pushCalls = [];
  pushConfigured = true;
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
});

async function call(method, path_, body) {
  const res = await fetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

// Everything after the response is awaited by the route but not by fetch, so a
// tick is needed before asserting on pushes and emits.
const drain = () => new Promise((r) => setImmediate(r));

const isMember = () => ({ rows: [{ id: 9 }] });
const noMember = () => ({ rows: [] });
const noBlocks = [/FROM user_blocks/, () => ({ rows: [] })];

// ═══════════════════════════════════════════════════════════════════════════
// 1. A bill with nobody on the paying end
//
// Two ways in, one state. The payer deleted their account (paid_by is
// ON DELETE SET NULL, so the bill survives with nobody on it while every other
// share row survives too), or nobody has claimed the bill yet because it is a
// ghost-commit shell whose total is this server's estimate off the group
// budget. Neither is a missing row and neither is a server fault.
// ═══════════════════════════════════════════════════════════════════════════

function scriptPayerlessBill() {
  handlers = [
    // The settle now serialises against POST /:flockId/create on the flock row,
    // because one statement was not enough: /create reads the shares, then
    // deletes and re-inserts them from that snapshot, and a settle landing in
    // between was committed, acknowledged, pushed - and then erased.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/FROM bill_splits bs\s+JOIN flocks f/, () => ({ rows: [{ id: 7, paid_by: null, flock_id: 42, flock_name: 'Dinner' }] })],
    [/SELECT amount, .*FROM bill_split_shares/, () => ({ rows: [{ amount: '25.00' }] })],
    noBlocks,
  ];
}

test('the pay button on a bill whose payer deleted their account explains itself', async () => {
  // THE DEFECT THIS AUDIT STARTED FROM. paid_by went NULL, the payer lookup
  // returned no rows, and everybody who still owed money got
  // 404 "Payer not found" when they tapped Pay. The client turns a failed
  // payment-link lookup into "Could not load payment links. Use Mark as Paid
  // after paying", which is advice to go and pay somebody who is gone.
  scriptPayerlessBill();
  const res = await call('GET', '/api/billing/42/payment-links');

  assert.strictEqual(res.status, 409, `a missing counterparty is a conflict, not a missing bill: ${res.text}`);
  assert.strictEqual(res.body.reason, 'no_payer', 'the client needs to tell this apart from a real failure');
  assert.ok(!/payer not found/i.test(res.text), 'that message reads like the server lost something');
  assert.match(res.body.error, /no one to pay/i);
  assert.match(res.body.error, /add the bill again/i, 'a dead end with no way out is still a dead end');
});

test('the venmo link route answers the payerless bill the same way', async () => {
  // Two routes disclose the payer's handles and they must not disagree about
  // whether there IS a payer.
  scriptPayerlessBill();
  const res = await call('GET', '/api/billing/42/venmo-link');

  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.reason, 'no_payer');
  assert.ok(!/payer not found/i.test(res.text));
});

test('neither payment route reaches the users table when there is no payer', async () => {
  // The refusal has to come BEFORE the lookup, or a future schema where paid_by
  // survives its user row quietly starts answering with somebody else's
  // handles. Nothing in the handler list below answers a users SELECT, so a
  // route that ran one would reject as an unscripted query.
  scriptPayerlessBill();
  await call('GET', '/api/billing/42/payment-links');
  assert.ok(!log.some((q) => /FROM users/.test(q.sql)), 'the payer lookup ran on a bill with no payer');
});

test('GET /:flockId says outright that nobody is recorded as having paid', async () => {
  // Without this the client renders a ghost estimate and an abandoned bill
  // exactly like a finished one: "Paid by Unknown" over a dollar total, with
  // Settle Up and Mark as Paid both live under it.
  handlers = [
    // /settle serialises against /create on the flock row now: one statement
    // was not enough, because /create reads the shares then deletes and
    // re-inserts them from that snapshot.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT bs\.\*, u\.name AS payer_name/, () => ({
      rows: [{
        id: 7, flock_id: 42, total_amount: '75.00', tip_percent: '0.0',
        split_type: 'equal', paid_by: null, payer_name: null, created_at: 'now',
      }],
    })],
    [/SELECT bss\.\*, u\.name FROM bill_split_shares/, () => ({
      rows: [{ user_id: 1, name: 'Ava', amount: '25.00', committed: true, settled: false, settled_at: null }],
    })],
    // The reveal re-check the payerless branch runs. Three present sharers, so
    // the numbers stay on the wire.
    [/COUNT\(\*\)::int AS n FROM budget_submissions/, () => ({ rows: [{ n: 3 }] })],
    noBlocks,
  ];

  const res = await call('GET', '/api/billing/42');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.bill.hasPayer, false, 'the one field the sheet has to branch on');
  assert.strictEqual(res.body.bill.paidBy.id, null);
});

test('a finished bill reports hasPayer true from both the GET and the create', async () => {
  handlers = [
    // /settle serialises against /create on the flock row now: one statement
    // was not enough, because /create reads the shares then deletes and
    // re-inserts them from that snapshot.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT bs\.\*, u\.name AS payer_name/, () => ({
      rows: [{
        id: 7, flock_id: 42, total_amount: '75.00', tip_percent: '0.0',
        split_type: 'equal', paid_by: 2, payer_name: 'Ben', created_at: 'now',
      }],
    })],
    [/SELECT bss\.\*, u\.name FROM bill_split_shares/, () => ({ rows: [] })],
    noBlocks,
  ];

  const res = await call('GET', '/api/billing/42');
  assert.strictEqual(res.body.bill.hasPayer, true);
  // And no reveal re-check was run: a real bill's total is what somebody spent,
  // not a budget submission, and the ceiling rules have no claim on it.
  assert.ok(!log.some((q) => /budget_submissions/.test(q.sql)), 'a real bill was gated on the budget threshold');
});

test('a ghost estimate stops being readable once the sharers it hid in have left', async () => {
  // A payerless bill's numbers ARE the banded budget ceiling: ghost-commit
  // writes the ceiling into every share and ceiling * memberCount into the
  // total. routes/budget.js re-asks the three-sharer reveal threshold on EVERY
  // read, because members leave and a band around the last person left is a
  // band around one person's budget. This route read a cached row and never
  // re-asked, so it was the second door out of the leak budget.js closed.
  handlers = [
    // /settle serialises against /create on the flock row now: one statement
    // was not enough, because /create reads the shares then deletes and
    // re-inserts them from that snapshot.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT bs\.\*, u\.name AS payer_name/, () => ({
      rows: [{
        id: 7, flock_id: 42, total_amount: '90.00', tip_percent: '0.0',
        split_type: 'equal', paid_by: null, payer_name: null, created_at: 'now',
      }],
    })],
    [/SELECT bss\.\*, u\.name FROM bill_split_shares/, () => ({
      rows: [{ user_id: 1, name: 'Ava', amount: '30.00', committed: true, settled: false, settled_at: null }],
    })],
    [/COUNT\(\*\)::int AS n FROM budget_submissions/, () => ({ rows: [{ n: 1 }] })],
    noBlocks,
  ];

  const res = await call('GET', '/api/billing/42');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.bill.totalAmount, null, 'the estimate is derived from the withheld ceiling');
  assert.strictEqual(res.body.bill.totalWithTip, null);
  assert.strictEqual(res.body.bill.shares[0].amount, null, 'a share on a shell IS the ceiling, verbatim');
  assert.ok(!res.text.includes('30'), `the ceiling reached the wire anyway: ${res.text}`);
  // The row itself is still described, so the client can say what state it is
  // in rather than pretending there is no bill.
  assert.strictEqual(res.body.bill.shares[0].committed, true);
});

test('the reveal count billing asks is the member-joined one budget.js asks', async () => {
  // A budget submission row outlives its author's membership on purpose. Any
  // reader that counts those rows without joining flock_members counts people
  // who are not in the room, and publishes a reveal the budget route has
  // already closed.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');
  const counts = src.match(/COUNT\(\*\)::int AS n FROM \$\{MEMBER_SUBMISSIONS\}/g) || [];
  assert.ok(counts.length >= 2, 'both the ghost commit and the bill read must use MEMBER_SUBMISSIONS');
  assert.ok(
    !/FROM budget_submissions\s+WHERE/.test(src),
    'an unjoined budget_submissions count is a reveal the budget route does not grant'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Settling a bill nobody has paid
// ═══════════════════════════════════════════════════════════════════════════

test('a share cannot be settled while the bill has no payer', async () => {
  handlers = [
    // /settle serialises against /create on the flock row now: one statement
    // was not enough, because /create reads the shares then deletes and
    // re-inserts them from that snapshot.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT id FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7 }] })],
    // The EXISTS in the WHERE clause is what refuses it; a real Postgres
    // returns no rows, which is what this models.
    [/UPDATE bill_split_shares SET settled = true/, () => ({ rows: [] })],
    [/SELECT bss\.settled, bs\.paid_by/, () => ({ rows: [{ settled: false, paid_by: null }] })],
  ];

  const res = await call('POST', '/api/billing/42/settle');
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.reason, 'no_payer');
  assert.match(res.body.error, /nothing to settle/i);
});

test('the settle UPDATE refuses a payerless bill in SQL, not only in the branch above it', async () => {
  // Written into the statement rather than checked first, because a
  // check-then-write here races the payer's own POST /create.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');
  const stmt = src.slice(src.indexOf('UPDATE bill_split_shares SET settled = true'));
  const clause = stmt.slice(0, stmt.indexOf('RETURNING'));
  assert.match(clause, /settled IS NOT TRUE/, 'a repeat settle must not rewrite settled_at or re-notify');
  assert.match(clause, /paid_by IS NOT NULL/, 'settling means paid the payer back; there has to be a payer');
});

test('a settled flag on a payerless shell is not carried onto the real bill', async () => {
  // THE FREE DINNER. Ghost-commit opens a shell with paid_by NULL, the member
  // settles their estimated share, and when the payer finally posts the real
  // bill the rewrite preserves settled rows. The member is inserted settled,
  // the payer is never told they owe (the notification loop skips settled
  // shares), the sheet shows them paid, and they were never billed.
  const inserted = [];
  handlers = [
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT u\.id, u\.name FROM flock_members fm/, () => ({ rows: [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }] })],
    [/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: 1 }] })],
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    // The shell: a bill row exists and nobody has claimed it.
    [/SELECT id, paid_by FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7, paid_by: null }] })],
    [/SELECT user_id, .*FROM bill_split_shares/, () => ({
      rows: [
        { user_id: 2, committed: true, settled: true, settled_at: 'earlier' }, // Ben settled the estimate
        { user_id: 1, committed: true, settled: false, settled_at: null },
      ],
    })],
    [/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] })],
    [/DELETE FROM bill_split_shares/, () => ({ rows: [] })],
    [/INSERT INTO bill_split_shares/, (p) => { inserted.push({ userId: p[1], settled: p[4], committed: p[3] }); return { rows: [] }; }],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: [{ user_id: 1 }, { user_id: 2 }] })],
    noBlocks,
  ];

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 100, tipPercent: 0 });
  assert.strictEqual(res.status, 201, res.text);
  await drain();

  const ben = inserted.find((r) => Number(r.userId) === 2);
  assert.strictEqual(ben.settled, false, 'a debt settled against an estimate is not a debt that was paid');
  // The pre-commitment itself IS carried: that is what a ghost commit is for.
  assert.strictEqual(ben.committed, true, 'the ghost pre-commitment is a real thing the member did');
  // And the payer is told about the debt, which the stale flag was suppressing.
  assert.ok(pushCalls.some((p) => Number(p.userId) === 2 && /You owe/.test(p.body)), 'Ben was never billed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Settling twice
// ═══════════════════════════════════════════════════════════════════════════

function scriptSettle({ updated }) {
  handlers = [
    // The settle now serialises against POST /:flockId/create on the flock row,
    // because one statement was not enough: /create reads the shares, then
    // deletes and re-inserts them from that snapshot, and a settle landing in
    // between was committed, acknowledged, pushed - and then erased.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT id FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7 }] })],
    [/UPDATE bill_split_shares SET settled = true/, () => ({ rows: updated ? [{ id: 1, amount: '12.50' }] : [] })],
    [/SELECT bss\.settled, bs\.paid_by/, () => ({ rows: [{ settled: true, paid_by: 2 }] })],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: [{ user_id: 1 }, { user_id: 2 }] })],
    [/SELECT COUNT\(\*\) AS count FROM bill_split_shares/, () => ({ rows: [{ count: '0' }] })],
    [/SELECT bs\.paid_by, f\.name AS flock_name/, () => ({ rows: [{ paid_by: 2, flock_name: 'Dinner' }] })],
    noBlocks,
  ];
}

test('settling a share that is already settled is a no-op, not a second notification', async () => {
  // "Mark as Paid (cash or other)" is one tap deep on the bill sheet with no
  // confirmation in front of it. Every tap used to move settled_at forward and
  // push the payer again, so any member could tell the person who fronted the
  // money that they had been paid back as many times as they liked.
  scriptSettle({ updated: false });
  const res = await call('POST', '/api/billing/42/settle');
  await drain();

  assert.strictEqual(res.status, 200, 'the caller asked for a state that is already true');
  assert.strictEqual(res.body.settled, true);
  assert.strictEqual(res.body.alreadySettled, true);
  assert.strictEqual(pushCalls.length, 0, 'the payer was told again about a debt cleared once');
});

test('the first settle does notify the payer, and says who claims what', async () => {
  scriptSettle({ updated: true });
  const res = await call('POST', '/api/billing/42/settle');
  await drain();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.alreadySettled, undefined);
  const paid = pushCalls.filter((p) => p.data.type === 'bill_settled');
  assert.strictEqual(paid.length, 1);
  assert.strictEqual(paid[0].userId, 2, 'one push, to the person who fronted the money');
});

test('the settle really takes the flock lock, in order, inside the transaction', async () => {
  // scriptSettle has answered the FOR UPDATE statement since the lock was
  // added, and nothing checked that the route ever asked. A scripted handler
  // the route never reaches is a comment, not a test (adversarial audit
  // 2026-09-04): the fake does not complain about handlers left unused. So
  // the logged SQL is read back, the way money.test.js pins statements.
  scriptSettle({ updated: true });
  const res = await call('POST', '/api/billing/42/settle');
  assert.strictEqual(res.status, 200, res.text);

  const first = (re) => log.findIndex((q) => re.test(q.sql));
  const begin = first(/^BEGIN/);
  const lock = first(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/);
  const update = first(/UPDATE bill_split_shares SET settled = true/);
  const commit = first(/^COMMIT/);
  assert.ok(lock >= 0, 'the lock handler was scripted but the statement was never issued');
  assert.deepStrictEqual(log[lock].params, [42], 'it must lock THIS flock');
  assert.ok(begin >= 0 && begin < lock, 'the lock has to be taken inside the transaction');
  assert.ok(lock < update, 'the UPDATE ran before the lock');
  assert.ok(update < commit, 'the UPDATE has to commit under the lock');
});

test('a settle asked for on a bill the caller has no share of is still a 404', async () => {
  handlers = [
    // /settle serialises against /create on the flock row now: one statement
    // was not enough, because /create reads the shares then deletes and
    // re-inserts them from that snapshot.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT id FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7 }] })],
    [/UPDATE bill_split_shares SET settled = true/, () => ({ rows: [] })],
    [/SELECT bss\.settled, bs\.paid_by/, () => ({ rows: [] })],
  ];
  const res = await call('POST', '/api/billing/42/settle');
  assert.strictEqual(res.status, 404, res.text);
  assert.match(res.body.error, /no share found/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Taking a settlement back
//
// Until this audit there was no way to. A thumb landing an inch low on "Mark as
// Paid (cash or other)" erased a real debt permanently, told the payer they had
// been paid, and took the person out of the loop that would have chased them.
// Reposting the bill does not help: /create preserves settled rows on purpose,
// because the alternative is re-billing somebody who really did pay.
// ═══════════════════════════════════════════════════════════════════════════

function scriptUnsettle({ paidBy = 2, updated = true, existing = { settled: true } } = {}) {
  handlers = [
    // The settle now serialises against POST /:flockId/create on the flock row,
    // because one statement was not enough: /create reads the shares, then
    // deletes and re-inserts them from that snapshot, and a settle landing in
    // between was committed, acknowledged, pushed - and then erased.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT id, paid_by FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7, paid_by: paidBy }] })],
    [/UPDATE bill_split_shares SET settled = false/, () => ({ rows: updated ? [{ id: 1, amount: '12.50' }] : [] })],
    [/SELECT settled, .*FROM bill_split_shares/, () => ({ rows: existing ? [existing] : [] })],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: [{ user_id: 1 }, { user_id: 2 }] })],
    noBlocks,
  ];
}

test('a debtor can take back a settlement they reported by mistake', async () => {
  scriptUnsettle();
  const res = await call('POST', '/api/billing/42/unsettle');
  await drain();

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.settled, false);
  const upd = log.find((q) => /UPDATE bill_split_shares SET settled = false/.test(q.sql));
  assert.match(upd.sql, /settled_at = NULL/, 'a debt that is owed again has no settlement time');
  assert.match(upd.sql, /user_id = \$2/, 'you may only take back your OWN report');
  assert.ok(emits.some((e) => e.event === 'share_unsettled'), 'an open bill sheet has to correct itself');
});

test('the person who paid cannot mark their own share unpaid', async () => {
  // The payer's share is settled as an artifact of having paid the venue, not
  // as a debt they cleared. Clearing it puts them in debt to themselves and
  // takes the bill out of "all settled up" for everybody.
  scriptUnsettle({ paidBy: 1 });
  const res = await call('POST', '/api/billing/42/unsettle');
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.reason, 'payer');
  assert.ok(!log.some((q) => /UPDATE bill_split_shares SET settled = false/.test(q.sql)), 'it wrote anyway');
});

test('unsettling a share that was never settled is not an error', async () => {
  scriptUnsettle({ updated: false, existing: { settled: false } });
  const res = await call('POST', '/api/billing/42/unsettle');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.alreadyUnsettled, true);
});

test('unsettling without a share on the bill is a 404', async () => {
  scriptUnsettle({ updated: false, existing: null });
  const res = await call('POST', '/api/billing/42/unsettle');
  assert.strictEqual(res.status, 404, res.text);
});

test('unsettle needs membership, like every other route that touches this bill', async () => {
  handlers = [[/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, noMember]];
  const res = await call('POST', '/api/billing/42/unsettle');
  assert.strictEqual(res.status, 403, res.text);
});

test('taking a settlement back holds the flock lock /create holds, and really issues it', async () => {
  // THE WRITE WITH NOTHING AROUND IT (adversarial audit 2026-09-04). The
  // unsettle UPDATE ran on the pool, no transaction, no lock, so it could land
  // inside /create's read-then-rewrite: /create locks the flock, reads the
  // shares into a snapshot, the unsettle commits and answers 200, and /create
  // writes the person back settled = true out of the rows it read before the
  // tap. The correction vanished and the payer's sheet said they had been
  // paid. scriptUnsettle answered the FOR UPDATE statement all along, which
  // proved nothing, because the fake does not notice a handler that is never
  // reached. The logged SQL is what is checked.
  scriptUnsettle();
  const res = await call('POST', '/api/billing/42/unsettle');
  assert.strictEqual(res.status, 200, res.text);

  const first = (re) => log.findIndex((q) => re.test(q.sql));
  const begin = first(/^BEGIN/);
  const lock = first(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/);
  const update = first(/UPDATE bill_split_shares SET settled = false/);
  const commit = first(/^COMMIT/);
  assert.ok(lock >= 0, 'the lock handler was scripted but the statement was never issued');
  assert.deepStrictEqual(log[lock].params, [42], 'it must lock THIS flock');
  assert.ok(begin >= 0 && begin < lock, 'the lock has to be taken inside a transaction');
  assert.ok(lock < update, 'the UPDATE ran before the lock');
  assert.ok(update < commit, 'the UPDATE has to commit under the lock');
});

test('a share that carried credit already covers cannot be marked unpaid', async () => {
  // Ben paid $50, the bill was corrected and his share is $20. His row is
  // settled by the edit that carried the $50 across (migration 061), not by a
  // tap, so there is no report to take back, and clearing the flag would put
  // a person who has paid in full back on the sheet as owing.
  scriptUnsettle({ updated: false, existing: { settled: true, amount: '20.00', paid_amount: '50.00' } });
  const res = await call('POST', '/api/billing/42/unsettle');
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.reason, 'credit');
  assert.ok(!emits.some((e) => e.event === 'share_unsettled'));

  // The rule is in the statement, not only in the branch above it, for the
  // reason the settle statement carries its own guard: a check-then-write
  // races the payer's /create.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');
  const stmt = src.slice(src.indexOf('UPDATE bill_split_shares SET settled = false'));
  const clause = stmt.slice(0, stmt.indexOf('RETURNING'));
  assert.match(clause, /paid_amount < amount/, 'the unsettle UPDATE must refuse a share the carried credit covers');
  // And the fallback read asks for the two columns it decides that from.
  const sel = log.find((q) => /SELECT settled, .*FROM bill_split_shares/.test(q.sql));
  assert.match(sel.sql, /SELECT settled, amount, paid_amount FROM bill_split_shares/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The arithmetic
//
// Everything here works in integer cents, which is the only representation in
// which "these shares equal that total" has an exact answer. These cases assert
// the SUM, because a per-share assertion passes on a split that quietly loses a
// cent and the person who fronted the money is the one who eats it.
// ═══════════════════════════════════════════════════════════════════════════

function scriptCreate(members, { existingBill = null, existingShares = [] } = {}) {
  handlers = [
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT u\.id, u\.name FROM flock_members fm/, () => ({ rows: members })],
    [/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: 1 }] })],
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id, paid_by FROM bill_splits WHERE flock_id/, () => ({ rows: existingBill ? [existingBill] : [] })],
    // Only read when a bill is already on the table. Loose on the column list
    // on purpose: money.test.js is where the SELECT itself is pinned.
    [/SELECT user_id, .*FROM bill_split_shares/, () => ({ rows: existingShares })],
    [/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] })],
    [/DELETE FROM bill_split_shares/, () => ({ rows: [] })],
    [/INSERT INTO bill_split_shares/, () => ({ rows: [] })],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: members.map((m) => ({ user_id: m.id })) })],
    noBlocks,
  ];
}

const THREE = [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }, { id: 3, name: 'Cy' }];

test('an equal split that does not divide evenly still sums to the total, to the cent', async () => {
  scriptCreate(THREE);
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 100, tipPercent: 0 });
  assert.strictEqual(res.status, 201, res.text);

  const shares = res.body.bill.shares;
  const cents = shares.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  assert.strictEqual(cents, 10000, `three ways on $100 came to ${cents} cents`);
  // The leftover is deterministic and bounded: lowest user id carries it, and
  // no share is more than a cent above the even split.
  assert.deepStrictEqual(shares.map((s) => s.amount), [33.34, 33.33, 33.33]);
});

test('the same holds once a tip is folded in', async () => {
  scriptCreate(THREE);
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 87.65, tipPercent: 18 });
  assert.strictEqual(res.status, 201, res.text);

  const total = res.body.bill.totalWithTip;
  const cents = res.body.bill.shares.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  assert.strictEqual(cents, Math.round(total * 100), `shares came to ${cents} against a total of ${total}`);
});

test('a one-member bill gives that member the whole total and nothing is stranded', async () => {
  scriptCreate([{ id: 1, name: 'Ava' }]);
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 41.67, tipPercent: 0 });
  assert.strictEqual(res.status, 201, res.text);
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), [41.67]);
  // And they are the payer, so the sheet does not tell them they owe themselves.
  assert.strictEqual(res.body.bill.shares[0].settled, true);
});

test('custom shares that do not add up are refused rather than absorbed by the payer', async () => {
  scriptCreate(THREE);
  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 100,
    tipPercent: 0,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 30 }, { userId: 2, amount: 30 }, { userId: 3, amount: 30 }],
  });
  assert.strictEqual(res.status, 400, res.text);
  assert.match(res.body.error, /add up to \$100\.00/);
});

test('a member who has left the flock is not on the new split at all', async () => {
  // The roster is read at create time from accepted members only, so a rewrite
  // after somebody leaves divides between the people still there. No bill has
  // been posted yet here, so there is nothing the departed member left behind;
  // the case where they left something behind is the test underneath.
  scriptCreate([{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }]);
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 60, tipPercent: 0 });
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.userId), [1, 2]);
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), [30, 30]);
});

test('what a member who left already paid comes off the total, so the sheet still sums', async () => {
  // The four friends from the note at the DELETE in routes/billing.js, walked
  // as they lived it. A $100 dinner four ways is $25 each. Bob pays his $25 and
  // leaves the flock. The payer then finds the receipt and corrects the total
  // to $120.
  //
  // Bob's settled row stays, because it is the only record that he paid, and
  // until this audit nothing took it off the new total: the three who were left
  // were handed $120 three ways at $40 each, Bob's $25 sat there beside them,
  // and the bill's rows came to $145 for a $120 dinner. Carol and Dave were
  // each out $8.33 and the payer collected more than they had spent.
  //
  // $120 less the $25 already paid is $95 over three, and the leftover two
  // cents go to the lowest ids, exactly as they do on any other equal split.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptCreate([{ id: 1, name: 'Ava' }, { id: 3, name: 'Carol' }, { id: 4, name: 'Dave' }], {
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date(), amount: '25.00' },
      { user_id: 2, committed: false, settled: true, settled_at: new Date(), amount: '25.00' }, // Bob: paid, gone
      { user_id: 3, committed: false, settled: false, settled_at: null, amount: '25.00' },
      { user_id: 4, committed: false, settled: false, settled_at: null, amount: '25.00' },
    ],
  });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 120, tipPercent: 0 });
  assert.strictEqual(res.status, 201, res.text);

  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.userId), [1, 3, 4]);
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), [31.67, 31.67, 31.66],
    'the three who are left were divided the whole $120 as though Bob had paid nothing');

  // The SUM is the assertion, over every row the bill still has: the three
  // rewritten shares plus Bob's retained $25.
  const cents = res.body.bill.shares.reduce((sum, s) => sum + Math.round(s.amount * 100), 0) + 2500;
  assert.strictEqual(cents, 12000, `the bill's rows come to ${cents} cents against a $120 total`);
});

test('the push after an upward edit names what is still owed, not the new share', async () => {
  // "You owe Ava $100.00" to somebody who had paid $30 is the sentence that
  // had Ben paying $130 for a $100 share.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptCreate(THREE, {
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date(), amount: '30.00', paid_amount: '0.00' },
      { user_id: 2, committed: false, settled: true, settled_at: new Date(), amount: '30.00', paid_amount: '0.00' },
      { user_id: 3, committed: false, settled: false, settled_at: null, amount: '30.00', paid_amount: '0.00' },
    ],
  });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 300, tipPercent: 0 });
  assert.strictEqual(res.status, 201, res.text);
  await drain();

  const toBen = pushCalls.find((p) => Number(p.userId) === 2 && p.data.type === 'bill_created');
  assert.ok(toBen, 'Ben owes $70 more and was not told the bill moved');
  assert.match(toBen.body, /\$70\.00/, `the push asks for the wrong figure: ${toBen.body}`);
  assert.ok(!/\$100\.00/.test(toBen.body), `the push asks for the whole share: ${toBen.body}`);
  const toCy = pushCalls.find((p) => Number(p.userId) === 3 && p.data.type === 'bill_created');
  assert.match(toCy.body, /\$100\.00/, 'Cy paid nothing and owes the whole share');
});

test('GET /:flockId shows the credit and what is still owed on every share', async () => {
  // The sheet after a refresh has to say the same thing the 201 body said,
  // or the $30 credit exists only until the app is reopened.
  handlers = [
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT bs\.\*, u\.name AS payer_name/, () => ({
      rows: [{
        id: 7, flock_id: 42, total_amount: '300.00', tip_percent: '0.0',
        split_type: 'equal', paid_by: 1, payer_name: 'Ava', created_at: 'now',
      }],
    })],
    [/SELECT bss\.\*, u\.name FROM bill_split_shares/, () => ({
      rows: [
        { user_id: 1, name: 'Ava', amount: '100.00', paid_amount: '0.00', committed: false, settled: true, settled_at: 'now' },
        { user_id: 2, name: 'Ben', amount: '100.00', paid_amount: '30.00', committed: false, settled: false, settled_at: null },
        { user_id: 3, name: 'Cy', amount: '20.00', paid_amount: '50.00', committed: false, settled: true, settled_at: 'then' },
      ],
    })],
    noBlocks,
  ];

  const res = await call('GET', '/api/billing/42');
  assert.strictEqual(res.status, 200, res.text);
  const by = Object.fromEntries(res.body.bill.shares.map((s) => [s.userId, s]));
  assert.strictEqual(by[2].paidAmount, 30);
  assert.strictEqual(by[2].outstanding, 70);
  assert.strictEqual(by[3].paidAmount, 50, 'the overpayment is the record of what Cy is owed back');
  assert.strictEqual(by[3].outstanding, 0);
  assert.strictEqual(by[1].outstanding, 0);
  assert.strictEqual(res.body.bill.fullySettled, false);
});

test('the 201 body and the bill_created payload carry the three tallies GET carries', async () => {
  // billTally in ChatDetail.js reads fullySettled, settledCount and shareCount
  // beside a `shares` array that has anyone the viewer blocked removed, so the
  // denominator has to come from the server. GET sent all three and this route
  // sent none: straight after posting a bill, or on receiving bill_created, a
  // viewer who had blocked one of three sharers counted the two rows they
  // could see, and once the other one paid the sheet read "All settled up"
  // over the blocked person's open share. Fails without the fix: all three
  // fields are undefined on both the body and the payload.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptCreate(THREE);
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90, tipPercent: 0 });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.bill.shareCount, 3);
  assert.strictEqual(res.body.bill.settledCount, 1, 'the payer is settled as an artifact of having paid the venue');
  assert.strictEqual(res.body.bill.fullySettled, false);
  await drain();

  const toBen = emits.find((e) => e.event === 'bill_created' && e.room === 'user:2');
  assert.ok(toBen, 'Ben was not sent the bill');
  assert.strictEqual(toBen.payload.bill.shareCount, 3);
  assert.strictEqual(toBen.payload.bill.settledCount, 1);
  assert.strictEqual(toBen.payload.bill.fullySettled, false);
});

test('the tallies range over the rows kept for people who paid and left', async () => {
  // The four friends from the retained-credit case: Bob paid $25 and left,
  // then the total was corrected. His row stays, settled, and is not in the
  // roster the sheet lists, so a count over `shares` alone would say 3 rows
  // with 1 settled while GET says 4 with 2. The two have to agree, or the
  // header changes its mind on the first refresh after a rewrite.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptCreate([{ id: 1, name: 'Ava' }, { id: 3, name: 'Carol' }, { id: 4, name: 'Dave' }], {
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date(), amount: '25.00' },
      { user_id: 2, committed: false, settled: true, settled_at: new Date(), amount: '25.00' },
      { user_id: 3, committed: false, settled: false, settled_at: null, amount: '25.00' },
      { user_id: 4, committed: false, settled: false, settled_at: null, amount: '25.00' },
    ],
  });
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 120, tipPercent: 0 });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.bill.shares.length, 3, 'Bob is not on the roster the sheet lists');
  assert.strictEqual(res.body.bill.shareCount, 4, 'but his retained row is a row on the bill');
  assert.strictEqual(res.body.bill.settledCount, 2, 'Ava as payer, Bob by his payment');
  assert.strictEqual(res.body.bill.fullySettled, false);
});

test('fullySettled on the 201 body is true only when every row is covered', async () => {
  // Three people paid $30 each, then the payer corrects the bill DOWN to $60.
  // Every $20 share is covered by the $30 credit on its row, so the bill is
  // square the moment it is posted and the response has to say so, or the
  // header reads "1/3 settled" over three settled rows until a refresh.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptCreate(THREE, {
    existingBill: { id: 7, paid_by: 1 },
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date(), amount: '30.00', paid_amount: '0.00' },
      { user_id: 2, committed: false, settled: true, settled_at: new Date(), amount: '30.00', paid_amount: '30.00' },
      { user_id: 3, committed: false, settled: true, settled_at: new Date(), amount: '30.00', paid_amount: '30.00' },
    ],
  });
  const res = await call('POST', '/api/billing/42/create', { totalAmount: 60, tipPercent: 0 });
  assert.strictEqual(res.status, 201, res.text);
  assert.ok(res.body.bill.shares.every((s) => s.settled), res.text);
  assert.strictEqual(res.body.bill.shareCount, 3);
  assert.strictEqual(res.body.bill.settledCount, 3);
  assert.strictEqual(res.body.bill.fullySettled, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Honesty
//
// Flock takes no payment. It hands people off to Venmo, Cash App or Zelle and
// settlement is self-reported. Nothing on this path may state a transfer as
// something the app saw, processed, held, guaranteed or checked.
// ═══════════════════════════════════════════════════════════════════════════

test('no string in the bill route claims Flock handled, held or verified money', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');
  // Comments are stripped FIRST, so the reasoning that describes these bugs is
  // free to quote the words the strings themselves may not use.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const strings = (code.match(/'[^'\n]*'|`[^`]*`|"[^"\n]*"/g) || []).join('\n');
  const banned = [
    /payment (received|processed|confirmed|complete)/i,
    /we (received|processed|collected|hold|holds|verified) your/i,
    /transaction (complete|successful)/i,
    /\bguarantee(d|s)?\b/i,
    /\brefund(ed|s)?\b/i,
    /you got paid back/i,
    /flock (has )?(paid|charged|collected)/i,
  ];
  for (const re of banned) {
    assert.ok(!re.test(strings), `a bill string implies Flock handled the money: ${re}`);
  }
});

test('the paid-back notification reports a claim and names who made it', async () => {
  scriptSettle({ updated: true });
  await call('POST', '/api/billing/42/settle');
  await drain();

  const paid = pushCalls.find((p) => p.data.type === 'bill_settled');
  assert.match(paid.body, /says they paid you/i, 'the server knows a claim was made, not that money moved');
  assert.match(paid.body, /check your payment app/i, 'the payer is the only one who can confirm it');
  assert.ok(/\$12\.50/.test(paid.body), 'and the figure they have to check against is in it');
});

test('the settle-up refusals point at the way out instead of stopping dead', async () => {
  // Every 4xx a person can meet while trying to pay somebody names what to do
  // next. While paid_by is NULL, POST /create applies first-bill rules, so any
  // member can post the bill naming who really paid.
  scriptPayerlessBill();
  const links = await call('GET', '/api/billing/42/payment-links');
  assert.match(links.body.error, /add the bill again with who paid/i);

  handlers = [
    // /settle serialises against /create on the flock row now: one statement
    // was not enough, because /create reads the shares then deletes and
    // re-inserts them from that snapshot.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, isMember],
    [/SELECT id FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7 }] })],
    [/UPDATE bill_split_shares SET settled = true/, () => ({ rows: [] })],
    [/SELECT bss\.settled, bs\.paid_by/, () => ({ rows: [{ settled: false, paid_by: null }] })],
  ];
  const settleRes = await call('POST', '/api/billing/42/settle');
  assert.match(settleRes.body.error, /add the bill again with who paid/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Authorisation
// ═══════════════════════════════════════════════════════════════════════════

test('a non-member reads nothing and settles nothing', async () => {
  for (const [method, route] of [
    ['GET', '/api/billing/42'],
    ['POST', '/api/billing/42/settle'],
    ['POST', '/api/billing/42/unsettle'],
    ['GET', '/api/billing/42/payment-links'],
    ['GET', '/api/billing/42/venmo-link'],
    ['POST', '/api/billing/42/create'],
    ['POST', '/api/billing/42/ghost-commit'],
  ]) {
    handlers = [
      [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, noMember],
      // /create opens its transaction and locks the flock row BEFORE it reads
      // membership, so that who is in the flock and who the money goes to are
      // decided under the lock rather than before it (adversarial audit
      // 2026-09-04). The refusal is a ROLLBACK and then the 403, and the lock
      // is what has to be answered for the refusal to be reached.
      [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    ];
    const res = await call(method, route, method === 'POST' && route.endsWith('create') ? { totalAmount: 10 } : undefined);
    assert.strictEqual(res.status, 403, `${method} ${route} answered ${res.status}: ${res.text}`);
    assert.ok(!log.some((q) => /^(INSERT|UPDATE|DELETE)/.test(q.sql)), `${method} ${route} wrote something for a non-member`);
  }
});

test('nobody can settle or unsettle on behalf of anybody else', async () => {
  // Neither route reads a target user from the request. The share is always the
  // caller's own, chosen by req.user.id, so there is no id to tamper with and
  // no body field to send.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');
  for (const marker of ["router.post('/:flockId/settle'", "router.post('/:flockId/unsettle'"]) {
    const start = src.indexOf(marker);
    assert.ok(start > 0, `${marker} is gone`);
    const body = src.slice(start, src.indexOf('\n);', start));
    assert.ok(!/req\.body\.userId|body\('userId'\)|req\.params\.userId/.test(body),
      `${marker} reads a target user from the request`);
    assert.ok(/const userId = req\.user\.id/.test(body), `${marker} must settle the caller's own share`);
  }
});

test('the settle and unsettle routes are ignored when the caller sends a body', async () => {
  // Sending {"userId": 2} must not reach a column. Same script as the ordinary
  // settle, so anything the body changed would show up in the parameters.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptSettle({ updated: true });
  await call('POST', '/api/billing/42/settle', { userId: 2, settled: true, amount: 0 });
  const upd = log.find((q) => /UPDATE bill_split_shares SET settled = true/.test(q.sql));
  assert.deepStrictEqual(upd.params, [7, 1], 'the bill id and the CALLER, nothing off the body');
});
