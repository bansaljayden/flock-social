'use strict';
// Run: node --test __tests__/budgetBillIntegrity.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// THE BUDGET AND THE BILL, ON A REAL POSTGRES
// ---------------------------------------------------------------------------
//
// The budget and bill suites around this one script the database, and a
// scripted database cannot say what a DELETE with a NOT EXISTS removes, what a
// count over rows whose author left returns, or in what order two requests
// that cross on the flock's row lock tell the room. So these run the real
// routers against a migrated embedded Postgres:
//
//   1. A PAYER CANNOT HAND A BILL ON ONCE SOMEBODY HAS PAID THEM. The payments
//      on record went to the current payer; rewriting the bill around a new
//      one pointed them at the wrong person (the new payer's own payment was
//      dropped and the old payer was billed for money they had received). With
//      nothing paid the handoff still works.
//   2. TWO MEMBERS AND A GUEST CANNOT SETTLE, however many of them answer: a
//      guest's amount goes into the number and never counts toward the three.
//      The member count is on the wire so the app can say so.
//   3. A RESET TAKES THE GHOST-COMMIT SHELL WITH IT, so the next estimate is
//      the next number rather than the old cap. A payerless bill that records
//      a real payment is not an estimate and stays.
//   4. AN ANSWER CAN REACH THE ROOM AFTER THE ANSWER THAT SETTLED THE BUDGET,
//      carrying no number. The server cannot order two fan-outs that wait on
//      different reads, so the client has to ignore it
//      (frontend/src/lib/budgetStatus.js); this shows the event arrives.
//   5. A VIEWER WITH A SHARE HIDDEN BY A BLOCK GETS NO TOTAL, because the total
//      less the shares they can see is the hidden one. Nobody else loses it.
//   6. A SETTLED NUMBER DOES NOT MOVE WHEN A SHARER LEAVES, on any of the
//      readers that publish it. It used to vanish, which told the room the
//      person who left had shared an amount. A flock locked without three
//      shared amounts at all still publishes nothing.
//   7. A REAL BILL WHOSE PAYER DELETED THEIR ACCOUNT IS NOT AN ESTIMATE. It
//      reads paid_by NULL like a ghost-commit shell and can hold nothing but
//      unpaid commitments. A reset used to delete it, GET withheld its total
//      and every share, and a ghost commit could write the budget number into
//      it. bill_splits.had_payer (migration 086) tells the two apart.
//   8. MIGRATION 086 ON ROWS ALREADY THERE marks every bill a payer was
//      stored on, leaves every shell an estimate, and moves nothing on replay.
//   9. A BILL FROM BEFORE THE BUDGET SETTLED ONCE IS QUARANTINED WHOLE. The
//      early ghost commit put the raw budget minimum, one person's exact
//      answer, into any bill the flock had, and the figure travelled: into
//      another member's share, a settled flag a payer could probe, a banked
//      payment the rows subtract back to. Such a bill (migration 089) sends
//      no figure, flag or count to anybody, its own members included, in GET,
//      a payment link or the data export, refuses every write, and binds
//      nobody to the plan. A reset takes a quarantined shell whatever its rows
//      hold, so the reset cannot tell anybody which of them were settled. An
//      estimate shows the published number, never a number a row stored.
//  10. A BILL WHOSE PAYER DELETED THEIR ACCOUNT IS HANDED ON UNDER THE SAME
//      RULE as a live payer's: refused once a payment is on record.
//  11. MIGRATION 089 ON BILLS ALREADY THERE takes every bill from before the
//      cut-off in a flock that could have had a budget, and nothing else,
//      and moves nothing on replay.
//  12. A RESTORE FROM A DUMP TAKEN BEFORE 089 loads those bills without the
//      flag, after 089 was recorded against an empty database. The next boot
//      puts them back in quarantine before anybody reads one, and
//      scripts/verify-backup.js fails a restore that still has one out.
//  13. A PUSH CARRYING A QUARANTINED BILL'S FIGURE is never sent: not from the
//      outbox, where one queued before 089 kept its body, and not fresh. The
//      boot deletes such a push a restore brings back.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

// Synchronous and before config/database is required anywhere: that module
// builds its Pool from DATABASE_URL at require time, and backend/.env points at
// the live database.
const PG_PORT = pickEmbeddedPgPort('budgetBillIntegrity');
const DB_NAME = 'flock_budget_bill_integrity';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-budget-bill-integrity';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let seq = 0;

// Every socket event the routes send, by room, in the order they were sent.
const emits = [];
const io = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to(room) {
    const op = { except() { return op; }, emit(event, payload) { emits.push({ room, event, payload }); } };
    return op;
  },
  in() { return { socketsLeave() {}, disconnectSockets() {} }; },
  socketsLeave() {},
};

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-budget-bill-integrity-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'budgetBillIntegrity', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  ({ signUserToken } = require('../middleware/auth'));

  const app = express();
  app.use(express.json());
  app.set('io', io);
  app.use('/api/budget', require('../routes/budget'));
  app.use('/api/billing', require('../routes/billing'));
  app.use('/api/flocks', require('../routes/flocks'));
  app.use('/api/guest', require('../routes/guest').router);
  // The data export, which lists a person's bill shares (section 9).
  app.use('/api/users', require('../routes/users'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[budgetBillIntegrity] could not remove %s: %s', dataDir, err.message);
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

async function mkUser(name) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified)
     VALUES ($1, 'x', $2, true) RETURNING *`,
    [`u${seq}-${Date.now()}@budgetbill.test`, name]
  );
  return { ...rows[0], token: signUserToken(rows[0]) };
}

async function mkFlock(creator, members, { budget = true, ghost = true, status = 'confirmed' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO flocks (name, creator_id, status, event_time, budget_enabled, ghost_mode_enabled)
     VALUES ('Dinner', $1, $2, (NOW() AT TIME ZONE 'UTC') + INTERVAL '2 days', $3, $4) RETURNING id`,
    [creator.id, status, budget, ghost]
  );
  const flockId = rows[0].id;
  for (const m of [creator, ...members]) {
    await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')", [flockId, m.id]);
  }
  return flockId;
}

async function mkLink(flockId, creator) {
  seq += 1;
  const token = `BudgBill${seq}x${flockId}zzzz`.slice(0, 20);
  await pool.query('INSERT INTO flock_invite_links (token, flock_id, created_by) VALUES ($1, $2, $3)', [token, flockId, creator.id]);
  return token;
}

async function mkGuest(flockId, name) {
  const { rows } = await pool.query(
    "INSERT INTO guest_rsvps (flock_id, name, status) VALUES ($1, $2, 'in') RETURNING id, guest_token",
    [flockId, name]
  );
  return rows[0];
}

const submit = (flockId, user, amount) => call('POST', `/api/budget/${flockId}/submit`, {
  token: user.token, body: amount === 'skip' ? { amount: 0, skipped: true } : { amount },
});
const leave = (flockId, user) => pool.query('DELETE FROM flock_members WHERE flock_id = $1 AND user_id = $2', [flockId, user.id]);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i += 1) await sleep(5); };

// ═══════════════════════════════════════════════════════════════════════════
// 1. The payer handoff
// ═══════════════════════════════════════════════════════════════════════════

test('a payer cannot hand the bill on once somebody has paid them, and the payment stays theirs', async () => {
  const alice = await mkUser('Alice');
  const bob = await mkUser('Bob');
  const carol = await mkUser('Carol');
  const flockId = await mkFlock(alice, [bob, carol]);

  let r = await call('POST', `/api/billing/${flockId}/create`, { token: alice.token, body: { totalAmount: 60 } });
  assert.equal(r.status, 201, r.text);
  r = await call('POST', `/api/billing/${flockId}/settle`, { token: bob.token });
  assert.equal(r.status, 200, r.text);

  // Alice names Bob as payer after Bob has paid her his $20.
  r = await call('POST', `/api/billing/${flockId}/create`, { token: alice.token, body: { totalAmount: 60, paidBy: bob.id } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.code, 'PAYMENTS_RECORDED');

  // Nothing moved: Alice is still the payer and Bob's payment is still his.
  const bill = await one('SELECT id, paid_by FROM bill_splits WHERE flock_id = $1', [flockId]);
  assert.equal(bill.paid_by, alice.id);
  const bobRow = await one('SELECT amount, paid_amount, settled FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2', [bill.id, bob.id]);
  assert.equal(bobRow.settled, true);
  assert.equal(Number(bobRow.amount), 20);
  const links = await call('GET', `/api/billing/${flockId}/payment-links`, { token: carol.token });
  assert.equal(links.status, 200, links.text);
  assert.equal(links.body.payTo, 'Alice', 'the links point at whoever really holds the bill');
  assert.equal(links.body.amount, 20);

  // A payment to Carol's credit blocks it the same way, and Alice can still
  // correct the total: Bob's $20 rides across as credit on his new $30.
  r = await call('POST', `/api/billing/${flockId}/create`, { token: alice.token, body: { totalAmount: 90 } });
  assert.equal(r.status, 201, r.text);
  const bobShare = r.body.bill.shares.find((s) => s.userId === bob.id);
  assert.deepEqual(
    { amount: bobShare.amount, paidAmount: bobShare.paidAmount, outstanding: bobShare.outstanding, settled: bobShare.settled },
    { amount: 30, paidAmount: 20, outstanding: 10, settled: false }
  );
  r = await call('POST', `/api/billing/${flockId}/create`, { token: alice.token, body: { totalAmount: 90, paidBy: carol.id } });
  assert.equal(r.status, 409, 'a carried credit is a payment on record too');
});

test('with nothing paid yet, the payer can still hand the bill on, and owes the new payer', async () => {
  const alice = await mkUser('Alice');
  const bob = await mkUser('Bob');
  const carol = await mkUser('Carol');
  const flockId = await mkFlock(alice, [bob, carol]);

  let r = await call('POST', `/api/billing/${flockId}/create`, { token: alice.token, body: { totalAmount: 60 } });
  assert.equal(r.status, 201, r.text);
  r = await call('POST', `/api/billing/${flockId}/create`, { token: alice.token, body: { totalAmount: 60, paidBy: bob.id } });
  assert.equal(r.status, 201, r.text);
  const by = Object.fromEntries(r.body.bill.shares.map((s) => [s.userId, s]));
  assert.equal(by[alice.id].settled, false, 'the former payer owes the new one');
  assert.equal(by[alice.id].outstanding, 20);
  assert.equal(by[bob.id].settled, true, 'the new payer is square with themselves');
  const links = await call('GET', `/api/billing/${flockId}/payment-links`, { token: alice.token });
  assert.equal(links.body.payTo, 'Bob');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Guests bind the number and never make three
// ═══════════════════════════════════════════════════════════════════════════

test('two members and a guest who all answer do not settle, and the member count on the wire says why', async () => {
  const ann = await mkUser('Ann');
  const ben = await mkUser('Ben');
  const flockId = await mkFlock(ann, [ben]);
  const link = await mkLink(flockId, ann);
  const gus = await mkGuest(flockId, 'Gus');

  assert.equal((await submit(flockId, ann, 40)).status, 200);
  emits.length = 0;
  const guestAnswer = await call('POST', `/api/guest/${link}/budget`, { body: { guestToken: gus.guest_token, amount: 35 } });
  assert.equal(guestAnswer.status, 200, guestAnswer.text);
  assert.equal(guestAnswer.body.budgetLocked, false);
  assert.ok(!('memberCount' in guestAnswer.body), 'the guest door\'s own reply is unchanged');
  // The room's copy of the guest's answer carries the member count.
  const toAnn = emits.filter((e) => e.event === 'budget_updated' && e.room === `user:${ann.id}`);
  assert.equal(toAnn.at(-1).payload.memberCount, 2);

  const last = await submit(flockId, ben, 50);
  assert.equal(last.status, 200, last.text);
  assert.equal(last.body.submissionCount, 3, 'three people answered');
  assert.equal(last.body.totalMembers, 3);
  assert.equal(last.body.memberCount, 2, 'two of them are members');
  assert.equal(last.body.isReady, false);
  assert.equal(last.body.budgetLocked, false, 'a guest made three and the budget settled');
  assert.equal(last.body.ceiling, null);

  const status = await call('GET', `/api/budget/${flockId}`, { token: ann.token });
  assert.equal(status.body.memberCount, 2);
  assert.equal(status.body.totalMembers, 3);
  assert.equal(status.body.isReady, false);
  const lock = await call('POST', `/api/budget/${flockId}/lock`, { token: ann.token });
  assert.equal(lock.status, 400, 'the creator cannot lock it either');
  const f = await one('SELECT budget_locked, budget_ceiling FROM flocks WHERE id = $1', [flockId]);
  assert.deepEqual({ locked: f.budget_locked, ceiling: f.budget_ceiling }, { locked: false, ceiling: null });

  // A third member makes three, and the guest's $35 is the number.
  const dee = await mkUser('Dee');
  await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')", [flockId, dee.id]);
  const settling = await submit(flockId, dee, 60);
  assert.equal(settling.body.budgetLocked, true);
  assert.equal(settling.body.ceiling, 35, 'a guest\'s amount binds the number');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The reset and the ghost-commit shell
// ═══════════════════════════════════════════════════════════════════════════

test('a reset takes the ghost-commit shell with it, so the next estimate is the next number', async () => {
  const a = await mkUser('Ava');
  const b = await mkUser('Bea');
  const c = await mkUser('Cal');
  const d = await mkUser('Dot');
  const flockId = await mkFlock(a, [b, c, d]);

  for (const [u, amt] of [[a, 40], [b, 50], [c, 60]]) assert.equal((await submit(flockId, u, amt)).status, 200);
  assert.equal((await submit(flockId, d, 70)).body.ceiling, 40);
  let r = await call('POST', `/api/billing/${flockId}/ghost-commit`, { token: a.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.estimatedShare, 40);
  const shell = await one('SELECT id, total_amount FROM bill_splits WHERE flock_id = $1 AND paid_by IS NULL', [flockId]);
  assert.equal(Number(shell.total_amount), 160, 'the ceiling times four members');

  r = await call('POST', `/api/budget/${flockId}/reset`, { token: a.token });
  assert.equal(r.status, 200, r.text);
  assert.equal((await pool.query('SELECT 1 FROM bill_splits WHERE flock_id = $1', [flockId])).rowCount, 0,
    'the shell estimated from the cleared number survived the reset');
  assert.equal((await pool.query('SELECT 1 FROM bill_split_shares WHERE bill_id = $1', [shell.id])).rowCount, 0);

  for (const [u, amt] of [[a, 30], [b, 50], [c, 60]]) assert.equal((await submit(flockId, u, amt)).status, 200);
  assert.equal((await submit(flockId, d, 70)).body.ceiling, 30);
  r = await call('POST', `/api/billing/${flockId}/ghost-commit`, { token: b.token });
  assert.equal(r.body.estimatedShare, 30);

  const bill = await call('GET', `/api/billing/${flockId}`, { token: a.token });
  assert.equal(bill.status, 200, bill.text);
  assert.equal(bill.body.bill.hasPayer, false);
  assert.equal(bill.body.bill.estimate, true, 'a bill nobody ever posted is an estimate');
  assert.deepEqual(bill.body.bill.shares.map((s) => [s.userId, s.amount]), [[b.id, 30]],
    'an old commitment at the old cap is still on the bill');
  // An estimate sends no total: the rows carry the published number, and the
  // stored total is the number times a head count, which on an old shell was
  // an unbanded minimum times the head count (section 9).
  assert.equal(bill.body.bill.totalAmount, null);
});

test('a reset leaves a payerless bill that records a real payment', async () => {
  // paid_by NULL is also a real bill whose payer deleted their account, and a
  // settled row on it is the record that somebody paid.
  const a = await mkUser('Ava');
  const b = await mkUser('Bea');
  const c = await mkUser('Cal');
  const flockId = await mkFlock(a, [b, c]);
  for (const [u, amt] of [[a, 40], [b, 50]]) assert.equal((await submit(flockId, u, amt)).status, 200);
  assert.equal((await submit(flockId, c, 60)).body.budgetLocked, true);
  const { rows: [bill] } = await pool.query(
    "INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent) VALUES ($1, 90, 'equal', NULL, 0) RETURNING id",
    [flockId]
  );
  await pool.query(
    'INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled) VALUES ($1, $2, 30, false, true), ($1, $3, 30, true, false)',
    [bill.id, b.id, c.id]
  );
  const r = await call('POST', `/api/budget/${flockId}/reset`, { token: a.token });
  assert.equal(r.status, 200, r.text);
  assert.equal((await pool.query('SELECT 1 FROM bill_split_shares WHERE bill_id = $1', [bill.id])).rowCount, 2,
    'a reset deleted a bill that records a payment');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Two answers that cross on the wire
// ═══════════════════════════════════════════════════════════════════════════

test('an earlier answer can reach the room after the answer that settled the budget, with no number', async () => {
  const a = await mkUser('Ava');
  const b = await mkUser('Bea');
  const c = await mkUser('Cal');
  const flockId = await mkFlock(a, [b, c]);
  assert.equal((await submit(flockId, a, 40)).status, 200);

  // Hold the NEXT fan-out roster read. Bea's answer commits and then waits on
  // it, exactly where a busy pool makes a real request wait.
  const ROSTER = /^\s*SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'\s*$/;
  const realQuery = pool.query;
  let armed = true;
  let held = false;
  let release;
  const gate = new Promise((r) => { release = r; });
  pool.query = function held_(text, params) {
    if (armed && typeof text === 'string' && ROSTER.test(text)) {
      armed = false;
      held = true;
      return gate.then(() => realQuery.call(pool, text, params));
    }
    return realQuery.call(pool, text, params);
  };
  emits.length = 0;
  let beaReply;
  try {
    const bea = submit(flockId, b, 50);
    await until(() => held);
    assert.ok(held, 'Bea\'s answer never reached its fan-out');
    // Bea's row is committed, so Cal's is the last answer and settles it.
    const cal = await submit(flockId, c, 60);
    assert.equal(cal.status, 200, cal.text);
    assert.equal(cal.body.budgetLocked, true);
    assert.equal(cal.body.ceiling, 40);
    release();
    beaReply = await bea;
  } finally {
    release();
    pool.query = realQuery;
  }
  assert.equal(beaReply.status, 200, beaReply.text);
  assert.equal(beaReply.body.ceiling, null, 'Bea\'s own reply carries no number either');
  assert.equal(beaReply.body.budgetLocked, false);

  const toAva = emits.filter((e) => e.event === 'budget_updated' && e.room === `user:${a.id}`).map((e) => e.payload);
  assert.equal(toAva.length, 2);
  assert.deepEqual([toAva[0].budgetLocked, toAva[0].ceiling], [true, 40], 'the settle reached Ava first');
  assert.deepEqual([toAva[1].budgetLocked, toAva[1].ceiling], [false, null],
    'and the earlier answer after it: a client that applies it verbatim loses the number');
  const status = await call('GET', `/api/budget/${flockId}`, { token: a.token });
  assert.deepEqual([status.body.budgetLocked, status.body.ceiling], [true, 40], 'while the budget is settled at 40');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The block rule on a bill's total
// ═══════════════════════════════════════════════════════════════════════════

test('a viewer with a share hidden by a block gets no total, and nobody else loses theirs', async () => {
  const ann = await mkUser('Ann');
  const ben = await mkUser('Ben');
  const mal = await mkUser('Mal');
  const flockId = await mkFlock(ann, [ben, mal]);
  await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [ben.id, mal.id]);

  emits.length = 0;
  const r = await call('POST', `/api/billing/${flockId}/create`, {
    token: ann.token,
    body: {
      totalAmount: 100,
      splitType: 'custom',
      customShares: [{ userId: ann.id, amount: 30 }, { userId: ben.id, amount: 30 }, { userId: mal.id, amount: 40 }],
    },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.bill.totalWithTip, 100, 'the payer, with nothing hidden, keeps the total');

  // The fan-out runs after the response, one copy per member.
  await until(() => emits.filter((e) => e.event === 'bill_created').length === 3);
  const copy = (u) => emits.find((e) => e.event === 'bill_created' && e.room === `user:${u.id}`).payload.bill;
  assert.deepEqual(copy(ben).shares.map((s) => s.amount), [30, 30]);
  assert.equal(copy(ben).totalWithTip, null, '$100 less the two rows Ben sees is Mal\'s $40');
  assert.equal(copy(ben).totalAmount, null);
  assert.equal(copy(mal).totalWithTip, null, 'both sides of a block, so neither copy says who blocked');
  assert.equal(copy(ann).totalWithTip, 100);

  const asBen = await call('GET', `/api/billing/${flockId}`, { token: ben.token });
  assert.equal(asBen.body.bill.totalWithTip, null);
  assert.equal(asBen.body.bill.totalAmount, null);
  assert.equal(asBen.body.bill.shareCount, 3, 'the count still says a row is hidden, as it did before');
  assert.equal(asBen.body.bill.shares.length, 2);
  const asAnn = await call('GET', `/api/billing/${flockId}`, { token: ann.token });
  assert.equal(asAnn.body.bill.totalWithTip, 100);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. A settled number and the people who leave after it
// ═══════════════════════════════════════════════════════════════════════════

test('a sharer leaving after the settle moves no reader of the number, exactly as a skipper leaving does not', async () => {
  const a = await mkUser('Ava');
  const b = await mkUser('Bea');
  const c = await mkUser('Cal');
  const d = await mkUser('Dot');
  const e = await mkUser('Eli');
  const flockId = await mkFlock(a, [b, c, d, e]);
  const link = await mkLink(flockId, a);
  const gus = await mkGuest(flockId, 'Gus');

  for (const [u, amt] of [[a, 60], [b, 'skip'], [c, 80], [d, 'skip']]) assert.equal((await submit(flockId, u, amt)).status, 200);
  const g = await call('POST', `/api/guest/${link}/budget`, { body: { guestToken: gus.guest_token, amount: 100 } });
  assert.equal(g.status, 200, g.text);
  const settling = await submit(flockId, e, 90);
  assert.equal(settling.body.budgetLocked, true, 'three members shared and all six answered');
  assert.equal(settling.body.ceiling, 60);

  const readers = async () => {
    const budget = await call('GET', `/api/budget/${flockId}`, { token: a.token });
    const list = await call('GET', '/api/flocks', { token: a.token });
    const detail = await call('GET', `/api/flocks/${flockId}`, { token: a.token });
    const updated = await call('PUT', `/api/flocks/${flockId}`, { token: a.token, body: { name: 'Dinner' } });
    const me = await call('POST', `/api/guest/${link}/me`, { body: { guestToken: gus.guest_token } });
    for (const res of [budget, list, detail, updated, me]) assert.equal(res.status, 200, res.text);
    return {
      budget: [budget.body.ceiling, budget.body.isReady, budget.body.budgetLocked],
      list: Number(list.body.flocks.find((f) => f.id === flockId).budget_ceiling),
      detail: Number(detail.body.flock.budget_ceiling),
      updated: Number(updated.body.flock.budget_ceiling),
      guest: [me.body.budget.ceiling, me.body.budget.isReady],
    };
  };
  const settled = { budget: [60, true, true], list: 60, detail: 60, updated: 60, guest: [60, true] };
  assert.deepEqual(await readers(), settled);

  await leave(flockId, c);   // Cal shared $80
  assert.deepEqual(await readers(), settled, 'a sharer leaving changed what the room reads, which names them');
  await leave(flockId, b);   // Bea skipped
  assert.deepEqual(await readers(), settled);

  // The two readers in billing agree: the estimate is still the number, and
  // the shell it writes is still readable.
  const ghost = await call('POST', `/api/billing/${flockId}/ghost-commit`, { token: a.token });
  assert.equal(ghost.status, 200, ghost.text);
  assert.equal(ghost.body.estimatedShare, 60);
  const shell = await call('GET', `/api/billing/${flockId}`, { token: d.token });
  assert.equal(shell.body.bill.shares.find((s) => s.userId === a.id).amount, 60);
});

test('a flock locked over fewer than three shared amounts publishes nothing on any reader', async () => {
  // The first version of the lock route had no floor, so a plan can be locked
  // with a number cached over one person's amount. Counting every member row,
  // present or not, it still has fewer than three.
  const a = await mkUser('Ava');
  const b = await mkUser('Bea');
  const c = await mkUser('Cal');
  const flockId = await mkFlock(a, [b, c]);
  await pool.query(
    "INSERT INTO budget_submissions (flock_id, user_id, amount, skipped) VALUES ($1, $2, 47.13, false), ($1, $3, NULL, true)",
    [flockId, a.id, b.id]
  );
  await pool.query('UPDATE flocks SET budget_locked = true, budget_ceiling = 47.13 WHERE id = $1', [flockId]);

  const budget = await call('GET', `/api/budget/${flockId}`, { token: c.token });
  const list = await call('GET', '/api/flocks', { token: c.token });
  const detail = await call('GET', `/api/flocks/${flockId}`, { token: c.token });
  const updated = await call('PUT', `/api/flocks/${flockId}`, { token: a.token, body: { name: 'Dinner' } });
  const ghost = await call('POST', `/api/billing/${flockId}/ghost-commit`, { token: c.token });
  assert.equal(budget.body.ceiling, null);
  assert.equal(budget.body.isReady, false);
  assert.equal(list.body.flocks.find((f) => f.id === flockId).budget_ceiling, null);
  assert.equal(detail.body.flock.budget_ceiling, null);
  assert.equal(updated.body.flock.budget_ceiling, null);
  assert.equal(ghost.status, 400, ghost.text);
  for (const res of [budget, list, detail, updated, ghost]) {
    assert.ok(!res.text.includes('47.13') && !res.text.includes('"45'), `a one-amount number reached the wire: ${res.text.slice(0, 200)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. A real bill whose payer deleted their account is not an estimate
// ═══════════════════════════════════════════════════════════════════════════
//
// bill_splits.paid_by is ON DELETE SET NULL, so a posted bill whose payer
// deletes their account reads paid_by NULL exactly like a ghost-commit shell.
// Posting over a shell copies `committed` onto the real rows, and the payer's
// own settled row cascades away with their account, so what is left can be
// nothing but unpaid commitments at real amounts.

// Ghost commitments from everyone, then the real bill posted over them by
// Pat, then Pat's account deleted. The DELETE is the account deletion's
// effect on these tables: the foreign keys do all of it.
async function postedOverShellThenPayerGone() {
  const host = await mkUser('Hana');
  const pat = await mkUser('Pat');
  const bea = await mkUser('Bea');
  const cal = await mkUser('Cal');
  const flockId = await mkFlock(host, [pat, bea, cal]);
  for (const [u, amt] of [[host, 40], [pat, 50], [bea, 60]]) assert.equal((await submit(flockId, u, amt)).status, 200);
  assert.equal((await submit(flockId, cal, 70)).body.ceiling, 40);
  for (const u of [host, pat, bea, cal]) {
    const r = await call('POST', `/api/billing/${flockId}/ghost-commit`, { token: u.token });
    assert.equal(r.status, 200, r.text);
  }
  const posted = await call('POST', `/api/billing/${flockId}/create`, { token: pat.token, body: { totalAmount: 180 } });
  assert.equal(posted.status, 201, posted.text);
  const bill = await one('SELECT id FROM bill_splits WHERE flock_id = $1', [flockId]);
  const rows = (await pool.query('SELECT user_id, amount, committed, settled FROM bill_split_shares WHERE bill_id = $1', [bill.id])).rows;
  assert.ok(rows.every((s) => s.committed === true), 'every real row carried the commitment across');
  await pool.query('DELETE FROM users WHERE id = $1', [pat.id]);
  const after = await one('SELECT paid_by FROM bill_splits WHERE id = $1', [bill.id]);
  assert.equal(after.paid_by, null, 'the foreign key cleared the payer');
  return { host, bea, cal, flockId, billId: bill.id };
}

test('a reset keeps a posted bill whose payer deleted their account, every row a commitment or not', async () => {
  const { host, flockId, billId } = await postedOverShellThenPayerGone();
  const r = await call('POST', `/api/budget/${flockId}/reset`, { token: host.token });
  assert.equal(r.status, 200, r.text);
  const bill = await one('SELECT total_amount FROM bill_splits WHERE id = $1', [billId]);
  assert.ok(bill, 'the reset deleted a bill somebody rang up');
  assert.equal(Number(bill.total_amount), 180);
  const rows = (await pool.query('SELECT amount FROM bill_split_shares WHERE bill_id = $1', [billId])).rows;
  assert.deepEqual(rows.map((s) => Number(s.amount)), [45, 45, 45]);
});

test('a posted bill whose payer deleted their account keeps its real figures on GET, whatever the budget says', async () => {
  const { host, bea, flockId } = await postedOverShellThenPayerGone();
  const read = async () => {
    const res = await call('GET', `/api/billing/${flockId}`, { token: bea.token });
    assert.equal(res.status, 200, res.text);
    return res.body.bill;
  };
  const expectReal = (bill, when) => {
    assert.equal(bill.hasPayer, false, when);
    assert.equal(bill.totalAmount, 180, `${when}: the total somebody rang up was withheld`);
    assert.equal(bill.totalWithTip, 180, when);
    assert.deepEqual(bill.shares.map((s) => [s.amount, s.outstanding]), [[45, 45], [45, 45], [45, 45]], when);
    assert.equal(bill.estimate, false, `${when}: a posted bill is not an estimate`);
  };
  expectReal(await read(), 'settled');
  assert.equal((await call('POST', `/api/budget/${flockId}/reset`, { token: host.token })).status, 200);
  expectReal(await read(), 'open again after a reset');
});

test('a bill with no budget behind it keeps its figures when its payer deletes their account', async () => {
  const pat = await mkUser('Pat');
  const bea = await mkUser('Bea');
  const cal = await mkUser('Cal');
  const flockId = await mkFlock(bea, [pat, cal], { budget: false, ghost: false });
  const posted = await call('POST', `/api/billing/${flockId}/create`, {
    token: pat.token,
    body: { totalAmount: 100, tipPercent: 20, splitType: 'custom', customShares: [{ userId: pat.id, amount: 40 }, { userId: bea.id, amount: 40 }, { userId: cal.id, amount: 40 }] },
  });
  assert.equal(posted.status, 201, posted.text);
  assert.equal((await call('POST', `/api/billing/${flockId}/settle`, { token: cal.token })).status, 200);
  await pool.query('DELETE FROM users WHERE id = $1', [pat.id]);
  const res = await call('GET', `/api/billing/${flockId}`, { token: bea.token });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.bill.totalWithTip, 120);
  assert.deepEqual(res.body.bill.shares.map((s) => [s.name, s.amount, s.settled]), [['Bea', 40, false], ['Cal', 40, true]]);
  assert.equal(res.body.bill.estimate, false);
});

test('a ghost commit cannot land on a posted bill whose payer deleted their account', async () => {
  const { flockId, billId } = await postedOverShellThenPayerGone();
  // Somebody with no row on the bill: they joined after it was posted.
  const dee = await mkUser('Dee');
  await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')", [flockId, dee.id]);
  const r = await call('POST', `/api/billing/${flockId}/ghost-commit`, { token: dee.token });
  assert.equal(r.status, 400, r.text);
  assert.equal((await pool.query('SELECT 1 FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2', [billId, dee.id])).rowCount, 0,
    'the budget number was written into a bill somebody rang up');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Migration 086 on the rows that were already there
// ═══════════════════════════════════════════════════════════════════════════

// Applies a migration again, the way a deploy meets rows written before it:
// its schema_migrations row goes and the real runner runs. Found by name
// rather than number so a renumbering does not break it.
async function reapplyMigration(nameRe, what) {
  const file = fs.readdirSync(path.join(__dirname, '..', 'migrations')).find((f) => nameRe.test(f));
  assert.ok(file, `the ${what} migration is missing`);
  await pool.query('DELETE FROM schema_migrations WHERE name = $1', [file]);
  const { migrate } = require('../db/migrate');
  await migrate(pool);
}
const applyHadPayerMigration = () => reapplyMigration(/^\d+_bill_had_payer\.sql$/, 'had_payer');

test('the had_payer backfill marks every bill a payer was stored on, and nothing else, and a second pass moves nothing', async () => {
  const ann = await mkUser('Ann');
  const ben = await mkUser('Ben');
  const cy = await mkUser('Cy');
  const billOf = async (flockId) => (await one('SELECT id FROM bill_splits WHERE flock_id = $1', [flockId])).id;
  const rawBill = async (flockId, { tip = 0, split = 'equal' } = {}) => (await one(
    'INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent) VALUES ($1, 120, $2, NULL, $3) RETURNING id',
    [flockId, split, tip]
  )).id;
  const rawShares = (billId, rows) => Promise.all(rows.map(([u, over = {}]) => pool.query(
    'INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled, paid_amount) VALUES ($1, $2, 40, $3, $4, $5)',
    [billId, u.id, over.committed ?? true, over.settled ?? false, over.paid ?? 0]
  )));

  // Real, and posted through the routes.
  const overShell = (await postedOverShellThenPayerGone()).billId;
  const freshFlock = await mkFlock(ann, [ben, cy], { budget: false, ghost: false });
  const pat = await mkUser('Pat');
  await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')", [freshFlock, pat.id]);
  assert.equal((await call('POST', `/api/billing/${freshFlock}/create`, { token: pat.token, body: { totalAmount: 80 } })).status, 201);
  const fresh = await billOf(freshFlock);
  await pool.query('DELETE FROM users WHERE id = $1', [pat.id]);
  const liveFlock = await mkFlock(ann, [ben, cy], { budget: false, ghost: false });
  assert.equal((await call('POST', `/api/billing/${liveFlock}/create`, { token: ben.token, body: { totalAmount: 60 } })).status, 201);
  const live = await billOf(liveFlock);

  // Payerless rows only POST /create could have written, in the shapes
  // older code left behind.
  const tipped = await rawBill(await mkFlock(ann, [ben, cy]), { tip: 15 });
  await rawShares(tipped, [[ben], [cy]]);
  const custom = await rawBill(await mkFlock(ann, [ben, cy]), { split: 'custom' });
  await rawShares(custom, [[ben], [cy]]);
  const credited = await rawBill(await mkFlock(ann, [ben, cy]));
  await rawShares(credited, [[ben, { paid: 10 }], [cy]]);

  // And what ghost commit writes: a shell, and a shell somebody marked paid
  // before /settle refused a payerless bill. Neither ever had a payer.
  const shell = await rawBill(await mkFlock(ann, [ben, cy]));
  await rawShares(shell, [[ben], [cy]]);
  const settledShell = await rawBill(await mkFlock(ann, [ben, cy]));
  await rawShares(settledShell, [[ben, { settled: true }], [cy]]);

  const ids = { overShell, fresh, live, tipped, custom, credited, shell, settledShell };
  // Back to the state before the column existed, then the deploy.
  await pool.query('UPDATE bill_splits SET had_payer = false WHERE id = ANY($1::int[])', [Object.values(ids)]);
  await applyHadPayerMigration();
  const flags = async () => Object.fromEntries(await Promise.all(Object.entries(ids).map(
    async ([k, id]) => [k, (await one('SELECT had_payer FROM bill_splits WHERE id = $1', [id])).had_payer]
  )));
  assert.deepEqual(await flags(), {
    overShell: true, fresh: true, live: true, tipped: true, custom: true, credited: true,
    shell: false, settledShell: false,
  });

  // The replay migrationBootSafety runs over every file: nothing moves.
  const everyRow = async () => (await pool.query('SELECT id, had_payer, paid_by, updated_at FROM bill_splits ORDER BY id')).rows;
  const before = await everyRow();
  await applyHadPayerMigration();
  assert.deepEqual(await everyRow(), before);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. A bill from before the budget settled once is quarantined whole
// ═══════════════════════════════════════════════════════════════════════════
//
// Until 2026-08-26 the ghost commit wrote the budget number into bills as it
// then stood: the live minimum of the answers, unbanded, and before 2026-08-12
// with no threshold, so one answer in, that person's exact amount. It went
// into whatever bill the flock had, a posted one included, until 2026-08-13.
// Each test below builds a bill the way the code of that time left it, dates
// it inside that window, and applies migration 089, which quarantines every
// bill made before 2026-08-27 (US Eastern) in a flock that could have had a
// budget. The bill then sends no figure, flag or count to anybody, its own
// members included, and every route that would read one or carry one forward
// refuses it.

// That handler's own statement, run against a bill somebody posted.
const plantFirstGhostShare = (billId, user, amount) => pool.query(
  `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled)
   VALUES ($1, $2, $3, true, false)
   ON CONFLICT (bill_id, user_id) DO UPDATE
   SET committed = true`,
  [billId, user.id, amount]
);

// A day inside the window the early ghost commit wrote in.
const LEGACY_DAY = '2026-08-20T20:00:00Z';

// Applies migration 089 the way a deploy meets the rows already written.
const quarantineLegacyBills = () => reapplyMigration(/^\d+_bill_quarantine\.sql$/, 'quarantine');

const readBill = async (flockId, viewer) => {
  const res = await call('GET', `/api/billing/${flockId}`, { token: viewer.token });
  assert.equal(res.status, 200, res.text);
  return res;
};

// Ann made the plan and answered the budget with 47.13, the only answer in,
// which the early ghost commit copied as it stood. Pat posted $90 over Pat,
// Ann and Bea. Eve joined after, so she had no row, and the ghost commit gave
// her one: Ann's answer, as Eve's share. With `eveSettles`, Eve then marked it
// paid, which /settle allowed while the bill had a payer.
async function legacyBillWithAnnsAnswer({ eveSettles = false } = {}) {
  const pat = await mkUser('Pat');
  const ann = await mkUser('Ann');
  const bea = await mkUser('Bea');
  const flockId = await mkFlock(ann, [pat, bea]);
  assert.equal((await submit(flockId, ann, 47.13)).status, 200);
  const posted = await call('POST', `/api/billing/${flockId}/create`, { token: pat.token, body: { totalAmount: 90 } });
  assert.equal(posted.status, 201, posted.text);
  const billId = (await one('SELECT id FROM bill_splits WHERE flock_id = $1', [flockId])).id;
  const eve = await mkUser('Eve');
  await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')", [flockId, eve.id]);
  await plantFirstGhostShare(billId, eve, 47.13);
  if (eveSettles) {
    await pool.query('UPDATE bill_split_shares SET settled = true, settled_at = NOW() WHERE bill_id = $1 AND user_id = $2', [billId, eve.id]);
  }
  await pool.query('UPDATE bill_splits SET created_at = $2 WHERE id = $1', [billId, LEGACY_DAY]);
  await quarantineLegacyBills();
  return { pat, ann, bea, eve, flockId, billId };
}

const shareRowsOf = async (billId) => (await pool.query(
  'SELECT user_id, amount, paid_amount, committed, settled, settled_at FROM bill_split_shares WHERE bill_id = $1 ORDER BY user_id',
  [billId]
)).rows;

test('a quarantined bill has no settled flag to probe, and no split to probe it with', async () => {
  const { pat, ann, bea, eve, flockId, billId } = await legacyBillWithAnnsAnswer({ eveSettles: true });
  const before = await shareRowsOf(billId);

  // The flag itself: before 089 a row whose figures were hidden still said
  // whether it was settled, to everybody, and the counts said the same.
  for (const viewer of [pat, ann, eve]) {
    const res = await readBill(flockId, viewer);
    const b = res.body.bill;
    const eveRow = b.shares.find((s) => s.userId === eve.id);
    assert.equal(eveRow.settled, null, `${viewer.name} read the settled flag of Eve's row`);
    for (const s of b.shares) {
      assert.deepEqual([s.amount, s.paidAmount, s.outstanding, s.settled, s.committed, s.settledAt],
        [null, null, null, null, null, null], `${viewer.name} read a figure or a flag on ${s.name}'s row`);
    }
    assert.deepEqual([b.settledCount, b.shareCount, b.fullySettled], [null, null, null], `${viewer.name} read the counts`);
    assert.ok(!res.text.includes('47.13'), res.text);
    assert.equal(b.quarantined, true);
  }

  // The probe: re-post with Eve in a custom split at a share of the payer's
  // choosing and read whether her carried payment covers it off her settled
  // flag, halving the gap each time. Every step is a write, and every write
  // is refused before it is made.
  for (const eveShare of [40, 50]) {
    const r = await call('POST', `/api/billing/${flockId}/create`, {
      token: pat.token,
      body: {
        totalAmount: 150,
        splitType: 'custom',
        customShares: [
          { userId: pat.id, amount: 90 - eveShare },
          { userId: ann.id, amount: 30 },
          { userId: bea.id, amount: 30 },
          { userId: eve.id, amount: eveShare },
        ],
      },
    });
    assert.equal(r.status, 409, `a probe at ${eveShare} went through: ${r.text}`);
    assert.equal(r.body.code, 'BILL_QUARANTINED');
    assert.ok(!r.text.includes('47.13') && !/\$/.test(r.body.error), r.text);
  }
  assert.deepEqual(await shareRowsOf(billId), before, 'a refused probe wrote something');
});

test('on a legacy split that banked a payment, neither half of the subtraction is sent', async () => {
  // What POST /create left before migration 088: Eve paid on her ghost share
  // and left the plan, the next edit of the $120 bill banked her 47.13 and
  // split the other 72.87 three ways, and her kept row went with her account.
  // The three rows left were written from a typed total, so 088 had to call
  // them posted, and $120 less three times 24.29 is Ann's answer again.
  const pat = await mkUser('Pat');
  const ann = await mkUser('Ann');
  const bea = await mkUser('Bea');
  const flockId = await mkFlock(ann, [pat, bea]);
  assert.equal((await submit(flockId, ann, 47.13)).status, 200);
  const billId = (await one(
    `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent, had_payer, created_at, updated_at)
     VALUES ($1, 120, 'equal', $2, 0, true, $3, $3) RETURNING id`,
    [flockId, pat.id, LEGACY_DAY]
  )).id;
  await pool.query(
    `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled, paid_amount, posted) VALUES
       ($1, $2, 24.29, false, true, 0, true), ($1, $3, 24.29, false, false, 0, true), ($1, $4, 24.29, false, false, 0, true)`,
    [billId, pat.id, ann.id, bea.id]
  );
  await quarantineLegacyBills();

  for (const viewer of [pat, ann, bea]) {
    const res = await readBill(flockId, viewer);
    const b = res.body.bill;
    const seen = b.shares.map((s) => s.amount).filter((a) => typeof a === 'number');
    assert.deepEqual([b.totalAmount, b.totalWithTip, b.tipPercent], [null, null, null], `${viewer.name} got the total`);
    assert.deepEqual(seen, [], `${viewer.name} got the rows to take from it`);
    assert.ok(!res.text.includes('47.13') && !res.text.includes('24.29'), res.text);
  }
});

// Eve's share on the bill below is Ann's only budget answer: a share owner
// reading their own row is reading another person's amount.
test('the member holding a ghost share of somebody else\'s answer does not read it on the bill', async () => {
  const { eve, flockId } = await legacyBillWithAnnsAnswer();
  const own = await readBill(flockId, eve);
  assert.equal(own.body.bill.shares.find((s) => s.userId === eve.id).amount, null, 'Eve read Ann\'s answer as her own share');
  assert.ok(!own.text.includes('47.13'), own.text);
  assert.equal(own.body.bill.quarantined, true);
});

test('nor in a payment link, which carries the caller\'s own share', async () => {
  const { eve, flockId } = await legacyBillWithAnnsAnswer();
  for (const route of ['payment-links', 'venmo-link']) {
    const r = await call('GET', `/api/billing/${flockId}/${route}`, { token: eve.token });
    assert.ok(!r.text.includes('47.13'), `${route} carried Ann's answer: ${r.text}`);
    assert.equal(r.status, 409, `${route}: ${r.text}`);
    assert.equal(r.body.code, 'BILL_QUARANTINED');
  }
});

test('nor in their data export, which lists the bill as withheld with no figure or flag, and the payer\'s has no total', async () => {
  const { pat, eve, flockId } = await legacyBillWithAnnsAnswer();
  // The export asks for the account password first.
  const password = 'export-proof-7';
  await pool.query('UPDATE users SET password = $2 WHERE id = ANY($1::int[])',
    [[eve.id, pat.id], await require('bcrypt').hash(password, 4)]);
  const proof = { 'x-export-password': password };
  const exp = await call('GET', '/api/users/export', { token: eve.token, headers: proof });
  assert.equal(exp.status, 200, exp.text.slice(0, 300));
  const mine = exp.body.bill_splits.filter((r) => r.flock_id === flockId);
  assert.equal(mine.length, 1, 'the bill is still listed');
  assert.equal(mine[0].your_share, null, 'Eve\'s export carried Ann\'s answer as her share');
  assert.ok(!exp.text.includes('47.13'), 'the export carried the answer');
  assert.deepEqual(
    [mine[0].withheld, mine[0].your_share, mine[0].committed, mine[0].settled, mine[0].settled_at, mine[0].total_amount],
    [true, null, null, null, null, null]
  );

  // The payer's copy has no total from it either.
  const payerExp = await call('GET', '/api/users/export', { token: pat.token, headers: proof });
  assert.equal(payerExp.status, 200, payerExp.text.slice(0, 300));
  const payerRow = payerExp.body.bill_splits.find((r) => r.flock_id === flockId);
  assert.deepEqual([payerRow.withheld, payerRow.your_share, payerRow.total_amount, payerRow.tip_percent], [true, null, null, null]);
});

test('every write that would carry a quarantined figure forward is refused, names no figure, and moves nothing', async () => {
  const { pat, ann, bea, eve, flockId, billId } = await legacyBillWithAnnsAnswer({ eveSettles: true });
  // The budget settles, so the ghost commit gets as far as the bill.
  for (const [u, amt] of [[pat, 60], [bea, 70], [eve, 80]]) assert.equal((await submit(flockId, u, amt)).status, 200);
  assert.equal((await one('SELECT budget_locked FROM flocks WHERE id = $1', [flockId])).budget_locked, true);
  const before = await shareRowsOf(billId);

  const attempts = [
    ['re-post', () => call('POST', `/api/billing/${flockId}/create`, { token: pat.token, body: { totalAmount: 90 } })],
    ['settle', () => call('POST', `/api/billing/${flockId}/settle`, { token: bea.token })],
    ['unsettle', () => call('POST', `/api/billing/${flockId}/unsettle`, { token: eve.token })],
    ['ghost commit', () => call('POST', `/api/billing/${flockId}/ghost-commit`, { token: ann.token })],
  ];
  for (const [what, go] of attempts) {
    const r = await go();
    assert.equal(r.status, 409, `${what}: ${r.text}`);
    assert.equal(r.body.code, 'BILL_QUARANTINED', what);
    assert.ok(!r.text.includes('47.13') && !/\$/.test(r.body.error), `${what} named a figure: ${r.text}`);
    assert.doesNotMatch(r.body.error, /—/);
  }
  assert.deepEqual(await shareRowsOf(billId), before);
  const bill = await one('SELECT total_amount, paid_by, quarantined FROM bill_splits WHERE id = $1', [billId]);
  assert.deepEqual([Number(bill.total_amount), bill.paid_by, bill.quarantined], [90, pat.id, true]);
});

test('nobody is held to a quarantined bill: a member who owes on it and the payer can leave, and the plan can be deleted', async () => {
  // A bill that can no longer be settled would otherwise keep them for good,
  // and the refusal would be the one place its settled flags still showed.
  const { pat, ann, bea, flockId } = await legacyBillWithAnnsAnswer();
  const bea_ = await call('POST', `/api/flocks/${flockId}/leave`, { token: bea.token });
  assert.equal(bea_.status, 200, `a member who owes on it: ${bea_.text}`);
  const pat_ = await call('POST', `/api/flocks/${flockId}/leave`, { token: pat.token });
  assert.equal(pat_.status, 200, `the payer everybody owes: ${pat_.text}`);
  const del = await call('DELETE', `/api/flocks/${flockId}`, { token: ann.token });
  assert.equal(del.status, 200, `the plan's creator: ${del.text}`);
});

test('a reset takes a quarantined shell whatever its rows hold, so whether it is gone says nothing about them', async () => {
  // A reset keeps a payerless bill with a settled row, as the record of a real
  // payment. On a quarantined shell that decision was the settled flag itself,
  // told to the creator by whether the bill was still there afterwards.
  const replies = [];
  for (const settledRow of [false, true]) {
    const ava = await mkUser('Ava');
    const bea = await mkUser('Bea');
    const cal = await mkUser('Cal');
    const flockId = await mkFlock(ava, [bea, cal]);
    for (const [u, amt] of [[ava, 40], [bea, 50]]) assert.equal((await submit(flockId, u, amt)).status, 200);
    assert.equal((await submit(flockId, cal, 60)).body.budgetLocked, true);
    // The shell the early ghost commit left in the window: nobody ever posted
    // it, every row is a commitment, and with `settledRow` Bea marked hers paid.
    const shellId = (await one(
      `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent, created_at, updated_at)
       VALUES ($1, 120, 'equal', NULL, 0, $2, $2) RETURNING id`,
      [flockId, LEGACY_DAY]
    )).id;
    await pool.query(
      'INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled) VALUES ($1, $2, 40, true, $4), ($1, $3, 40, true, false)',
      [shellId, bea.id, cal.id, settledRow]
    );
    await quarantineLegacyBills();
    const shell = await one('SELECT quarantined, had_payer FROM bill_splits WHERE id = $1', [shellId]);
    assert.deepEqual([shell.quarantined, shell.had_payer], [true, false], 'the shell is quarantined and was never posted');

    const r = await call('POST', `/api/budget/${flockId}/reset`, { token: ava.token });
    assert.equal(r.status, 200, r.text);
    replies.push(r.body);
    assert.equal((await pool.query('SELECT 1 FROM bill_splits WHERE id = $1', [shellId])).rowCount, 0,
      `a reset kept the quarantined shell ${settledRow ? 'over a settled row' : 'of commitments'}`);
    assert.equal((await pool.query('SELECT 1 FROM bill_split_shares WHERE bill_id = $1', [shellId])).rowCount, 0);
    assert.equal((await call('GET', `/api/billing/${flockId}`, { token: ava.token })).status, 404);
  }
  assert.deepEqual(replies[1], replies[0], 'the reset answered differently over a settled row');
});

test('a bill made since the cut-off, or before it in a flock that never had a budget, is an ordinary bill', async () => {
  // Made today in a budget flock.
  const pat = await mkUser('Pat');
  const ann = await mkUser('Ann');
  const today = await mkFlock(ann, [pat]);
  assert.equal((await call('POST', `/api/billing/${today}/create`, { token: pat.token, body: { totalAmount: 60 } })).status, 201);
  // Made on the legacy day in a flock with no budget.
  const plain = await mkFlock(ann, [pat], { budget: false, ghost: false });
  assert.equal((await call('POST', `/api/billing/${plain}/create`, { token: pat.token, body: { totalAmount: 60 } })).status, 201);
  await pool.query('UPDATE bill_splits SET created_at = $2 WHERE flock_id = $1', [plain, LEGACY_DAY]);
  await quarantineLegacyBills();
  for (const flockId of [today, plain]) {
    const b = (await readBill(flockId, ann)).body.bill;
    assert.notEqual(b.quarantined, true);
    assert.equal(b.totalWithTip, 60);
    assert.deepEqual(b.shares.map((s) => s.amount), [30, 30]);
    assert.deepEqual(b.shares.map((s) => s.settled), [true, false], 'the flags read as they are');
  }
});

test('an estimate shows the number being published now, never a number a shell row stored', async () => {
  // A shell row keeps the number that was published when its member
  // committed, and a shell left from before the budget was started over can
  // hold the old one beside a new number. Every row reads the number published
  // now, and no total is sent.
  const a = await mkUser('Ava');
  const b = await mkUser('Bea');
  const c = await mkUser('Cal');
  const d = await mkUser('Dot');
  const flockId = await mkFlock(a, [b, c, d]);
  const shellId = (await one(
    "INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent) VALUES ($1, 180, 'equal', NULL, 0) RETURNING id",
    [flockId]
  )).id;
  await plantFirstGhostShare(shellId, a, 45);

  // Open: no number, so nothing at all.
  let res = await readBill(flockId, b);
  assert.equal(res.body.bill.estimate, true);
  assert.deepEqual([res.body.bill.shares[0].amount, res.body.bill.totalWithTip], [null, null]);

  // Settled at 40: the row reads 40, and no total is sent.
  for (const [u, amt] of [[a, 40], [b, 50], [c, 60]]) assert.equal((await submit(flockId, u, amt)).status, 200);
  assert.equal((await submit(flockId, d, 70)).body.ceiling, 40);
  res = await readBill(flockId, b);
  assert.deepEqual(res.body.bill.shares.map((s) => [s.userId, s.amount, s.outstanding]), [[a.id, 40, 40]]);
  assert.deepEqual([res.body.bill.totalAmount, res.body.bill.totalWithTip], [null, null]);
  assert.ok(!res.text.includes('"amount":45'), res.text);
  // Its own member reads the number published now as well.
  res = await readBill(flockId, a);
  assert.equal(res.body.bill.shares[0].amount, 40);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. A bill whose payer deleted their account is handed on under the same rule
// ═══════════════════════════════════════════════════════════════════════════
//
// A payerless bill takes first-bill rules, so a remaining member could post it
// again naming themselves. The rewrite reads nothing on a payerless bill as a
// payment, so it dropped the paid rows of people outside the new split and
// billed everybody in it again, money already handed over included. Once a
// payment is on record it is refused, exactly as the payer would refuse it.

// Cal made the plan; Pat paid, Bea paid Pat back, then Pat deleted their
// account. With `credit`, Bea's payment rides on her row as a credit instead of
// a settled flag, because the bill went up after she paid.
async function payerGoneAfterAPayment({ credit = false } = {}) {
  const cal = await mkUser('Cal');
  const pat = await mkUser('Pat');
  const bea = await mkUser('Bea');
  const flockId = await mkFlock(cal, [pat, bea], { budget: false, ghost: false });
  let r = await call('POST', `/api/billing/${flockId}/create`, { token: pat.token, body: { totalAmount: credit ? 60 : 90 } });
  assert.equal(r.status, 201, r.text);
  assert.equal((await call('POST', `/api/billing/${flockId}/settle`, { token: bea.token })).status, 200);
  if (credit) {
    r = await call('POST', `/api/billing/${flockId}/create`, { token: pat.token, body: { totalAmount: 90 } });
    assert.equal(r.status, 201, r.text);
    const beaRow = r.body.bill.shares.find((s) => s.userId === bea.id);
    assert.deepEqual([beaRow.paidAmount, beaRow.settled], [20, false]);
  }
  await pool.query('DELETE FROM users WHERE id = $1', [pat.id]);
  const billId = (await one('SELECT id FROM bill_splits WHERE flock_id = $1', [flockId])).id;
  return { cal, bea, flockId, billId };
}

test('a bill whose payer deleted their account cannot be handed on once somebody has paid on it', async () => {
  for (const credit of [false, true]) {
    const { cal, bea, flockId, billId } = await payerGoneAfterAPayment({ credit });
    const rows = async () => (await pool.query(
      'SELECT user_id, amount, paid_amount, settled FROM bill_split_shares WHERE bill_id = $1 ORDER BY user_id', [billId]
    )).rows;
    const before = await rows();
    // A remaining member naming themselves, and the plan's creator naming them.
    for (const [who, body] of [[bea, { totalAmount: 90 }], [cal, { totalAmount: 90, paidBy: bea.id }]]) {
      const r = await call('POST', `/api/billing/${flockId}/create`, { token: who.token, body });
      assert.equal(r.status, 409, `${credit ? 'credit' : 'settled'}: ${r.text}`);
      assert.equal(r.body.code, 'PAYMENTS_RECORDED');
      assert.doesNotMatch(r.body.error, /—/);
    }
    const bill = await one('SELECT paid_by, total_amount, had_payer FROM bill_splits WHERE id = $1', [billId]);
    assert.deepEqual([bill.paid_by, Number(bill.total_amount), bill.had_payer], [null, 90, true]);
    assert.deepEqual(await rows(), before, 'a payment already made was wiped or billed again');
  }
});

test('with nothing paid on it, a bill whose payer has gone posts again as a first bill', async () => {
  const cal = await mkUser('Cal');
  const pat = await mkUser('Pat');
  const bea = await mkUser('Bea');
  const flockId = await mkFlock(cal, [pat, bea], { budget: false, ghost: false });
  assert.equal((await call('POST', `/api/billing/${flockId}/create`, { token: pat.token, body: { totalAmount: 90 } })).status, 201);
  await pool.query('DELETE FROM users WHERE id = $1', [pat.id]);
  const r = await call('POST', `/api/billing/${flockId}/create`, { token: bea.token, body: { totalAmount: 60 } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.bill.paidBy.id, bea.id);
  const byUser = Object.fromEntries(r.body.bill.shares.map((s) => [s.userId, [s.amount, s.settled]]));
  assert.deepEqual(byUser, { [cal.id]: [30, false], [bea.id]: [30, true] });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Migration 089 on the bills that were already there
// ═══════════════════════════════════════════════════════════════════════════

test('the quarantine takes every bill from before the cut-off in a flock that could have had a budget, and nothing else, and a second pass moves nothing', async () => {
  const ann = await mkUser('Ann');
  const ben = await mkUser('Ben');
  const billIn = async (flockId, createdAt) => (await one(
    `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent, created_at, updated_at)
     VALUES ($1, 60, 'equal', $2, 0, $3, $3) RETURNING id`,
    [flockId, ann.id, createdAt]
  )).id;
  const budgetFlock = () => mkFlock(ann, [ben]);
  const plainFlock = () => mkFlock(ann, [ben], { budget: false, ghost: false });

  // Before the cut-off, in a budget flock.
  const legacy = await billIn(await budgetFlock(), LEGACY_DAY);
  // One second before it, and at it.
  const lastSecond = await billIn(await budgetFlock(), '2026-08-27T03:59:59Z');
  const atCutoff = await billIn(await budgetFlock(), '2026-08-27T04:00:00Z');
  // Made today.
  const today = await billIn(await budgetFlock(), new Date().toISOString());
  // Before the cut-off, in a flock that never had a budget.
  const noBudget = await billIn(await plainFlock(), LEGACY_DAY);
  // A budget flock whose answers were all deleted since: a reset, an account
  // deletion, or the sweep that ran in 001 until 2026-08-26.
  const sweptFlock = await budgetFlock();
  await pool.query('INSERT INTO budget_submissions (flock_id, user_id, amount, skipped) VALUES ($1, $2, 40, false)', [sweptFlock, ann.id]);
  await pool.query('DELETE FROM budget_submissions WHERE flock_id = $1', [sweptFlock]);
  const swept = await billIn(sweptFlock, LEGACY_DAY);
  // A flock whose flag is NULL, and one whose flag says no but holds an answer.
  const nullFlock = await budgetFlock();
  await pool.query('UPDATE flocks SET budget_enabled = NULL WHERE id = $1', [nullFlock]);
  const nullFlag = await billIn(nullFlock, LEGACY_DAY);
  const oddFlock = await plainFlock();
  await pool.query('INSERT INTO budget_submissions (flock_id, user_id, amount, skipped) VALUES ($1, $2, 40, false)', [oddFlock, ann.id]);
  const answerNoFlag = await billIn(oddFlock, LEGACY_DAY);
  // A bill with no creation time at all.
  const undated = await billIn(await budgetFlock(), LEGACY_DAY);
  await pool.query('UPDATE bill_splits SET created_at = NULL WHERE id = $1', [undated]);

  const ids = { legacy, lastSecond, atCutoff, today, noBudget, swept, nullFlag, answerNoFlag, undated };
  // Back to the state before the column existed, then the deploy.
  await pool.query('UPDATE bill_splits SET quarantined = false WHERE id = ANY($1::int[])', [Object.values(ids)]);
  await quarantineLegacyBills();
  const flags = async () => Object.fromEntries(await Promise.all(Object.entries(ids).map(
    async ([k, id]) => [k, (await one('SELECT quarantined FROM bill_splits WHERE id = $1', [id])).quarantined]
  )));
  assert.deepEqual(await flags(), {
    legacy: true, lastSecond: true, atCutoff: false, today: false, noBudget: false,
    swept: true, nullFlag: true, answerNoFlag: true, undated: true,
  });

  // The replay migrationBootSafety runs over every file: nothing moves.
  const everyRow = async () => (await pool.query('SELECT id, quarantined, created_at FROM bill_splits ORDER BY id')).rows;
  const before = await everyRow();
  await quarantineLegacyBills();
  assert.deepEqual(await everyRow(), before);
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. A restore from a dump taken before 089
// ═══════════════════════════════════════════════════════════════════════════
//
// The restore runbook (BACKUP-AND-VERIFICATION.md, "Bringing Flock back from
// nothing") builds the schema with db/migrate.js on an empty database, which is
// what test.before did here: 089 is recorded as applied and matched nothing.
// Then it loads the dump, and scripts/dump-db.js writes every table as one
// INSERT naming the columns the SOURCE had, ON CONFLICT DO NOTHING, in one
// transaction in replica mode. A dump taken before 089 names no quarantined
// column, so its legacy bill lands at the default, false. Then the app boots.

// The rows the way the 2026-09-03 dump holds them: bill_splits from before 086
// and 089, bill_split_shares from before 061 and 088, ids the source's own and
// far above anything this suite's sequences reach. Pat posted $90 over Pat, Ann
// and Bea; Eve's row is the early ghost commit's, Ann's only answer as her
// share. Beside it, a bill from the same day in a plan with no budget, and one
// from after the cut-off, which no boot may touch.
async function loadDumpFromBefore089(base) {
  const id = (n) => base + n;
  const at = (day) => `'${day}T20:00:00.000Z'`;
  // A time relative to now, written the way the dump writes a timestamptz.
  const soon = (seconds) => `'${new Date(Date.now() + seconds * 1000).toISOString()}'`;
  const members = (flock) => [1, 2, 3, 4].map((u) => `(${id(10 * flock + u)}, ${id(flock)}, ${id(u)}, 'accepted')`).join(',\n  ');
  const client = await pool.connect();
  try {
    for (const sql of [
      'BEGIN;',
      'SET session_replication_role = replica;',
      `INSERT INTO "users" ("id", "email", "password", "name", "email_verified") VALUES
  (${id(1)}, 'pat${base}@restore.test', 'x', 'Pat', true),
  (${id(2)}, 'ann${base}@restore.test', 'x', 'Ann', true),
  (${id(3)}, 'bea${base}@restore.test', 'x', 'Bea', true),
  (${id(4)}, 'eve${base}@restore.test', 'x', 'Eve', true)
ON CONFLICT DO NOTHING;`,
      `INSERT INTO "flocks" ("id", "name", "creator_id", "status", "budget_enabled", "ghost_mode_enabled") VALUES
  (${id(100)}, 'Dinner', ${id(2)}, 'confirmed', true, true),
  (${id(200)}, 'Lunch', ${id(2)}, 'confirmed', false, false),
  (${id(300)}, 'Brunch', ${id(2)}, 'confirmed', true, true)
ON CONFLICT DO NOTHING;`,
      `INSERT INTO "flock_members" ("id", "flock_id", "user_id", "status") VALUES
  ${[100, 200, 300].map(members).join(',\n  ')}
ON CONFLICT DO NOTHING;`,
      `INSERT INTO "budget_submissions" ("id", "flock_id", "user_id", "amount", "skipped") VALUES
  (${id(5000)}, ${id(100)}, ${id(2)}, 47.13, false)
ON CONFLICT DO NOTHING;`,
      `INSERT INTO "bill_splits" ("id", "flock_id", "total_amount", "split_type", "paid_by", "tip_percent", "created_at", "updated_at") VALUES
  (${id(6100)}, ${id(100)}, 90.00, 'equal', ${id(1)}, 0.0, ${at('2026-08-20')}, ${at('2026-08-20')}),
  (${id(6200)}, ${id(200)}, 90.00, 'equal', ${id(1)}, 0.0, ${at('2026-08-20')}, ${at('2026-08-20')}),
  (${id(6300)}, ${id(300)}, 90.00, 'equal', ${id(1)}, 0.0, ${at('2026-09-01')}, ${at('2026-09-01')})
ON CONFLICT DO NOTHING;`,
      `INSERT INTO "bill_split_shares" ("id", "bill_id", "user_id", "amount", "committed", "settled", "settled_at") VALUES
  (${id(7101)}, ${id(6100)}, ${id(1)}, 30.00, false, true, ${at('2026-08-20')}),
  (${id(7102)}, ${id(6100)}, ${id(2)}, 30.00, false, false, NULL),
  (${id(7103)}, ${id(6100)}, ${id(3)}, 30.00, false, false, NULL),
  (${id(7104)}, ${id(6100)}, ${id(4)}, 47.13, true, false, NULL),
  (${id(7201)}, ${id(6200)}, ${id(1)}, 45.00, false, true, ${at('2026-08-20')}),
  (${id(7202)}, ${id(6200)}, ${id(2)}, 45.00, false, false, NULL),
  (${id(7301)}, ${id(6300)}, ${id(1)}, 45.00, false, true, ${at('2026-09-01')}),
  (${id(7302)}, ${id(6300)}, ${id(2)}, 45.00, false, false, NULL)
ON CONFLICT DO NOTHING;`,
      // Two pushes still waiting when the dump was taken, before 085 gave the
      // table token_ids: Eve's settle on the legacy bill, telling Pat the
      // figure on her ghost share, and Ann's on the bill from after the cut-off.
      `INSERT INTO "push_outbox" ("id", "user_id", "reason", "title", "body", "data", "attempts", "next_attempt_at", "expires_at", "created_at") VALUES
  (${id(8100)}, ${id(1)}, 'quiet', 'Marked as paid back', 'Eve says they paid you $47.13 for Dinner. Check your payment app.', '{"type": "bill_settled", "flockId": "${id(100)}", "fromUserId": "${id(4)}"}', 0, ${soon(-60)}, ${soon(3600)}, ${soon(-3600)}),
  (${id(8300)}, ${id(1)}, 'quiet', 'Marked as paid back', 'Ann says they paid you $45.00 for Brunch. Check your payment app.', '{"type": "bill_settled", "flockId": "${id(300)}", "fromUserId": "${id(2)}"}', 0, ${soon(-60)}, ${soon(3600)}, ${soon(-3600)})
ON CONFLICT DO NOTHING;`,
      'SET session_replication_role = DEFAULT;',
      'COMMIT;',
    ]) await client.query(sql);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const person = async (n) => {
    const row = await one('SELECT * FROM users WHERE id = $1', [id(n)]);
    return { ...row, token: signUserToken(row) };
  };
  return {
    pat: await person(1), ann: await person(2), bea: await person(3), eve: await person(4),
    flockId: id(100),
    bills: { legacy: id(6100), noBudget: id(6200), afterCutoff: id(6300) },
    queued: { legacy: id(8100), afterCutoff: id(8300) },
  };
}

const quarantineFlags = async (bills) => Object.fromEntries(await Promise.all(Object.entries(bills).map(
  async ([k, billId]) => [k, (await one('SELECT quarantined FROM bill_splits WHERE id = $1', [billId])).quarantined]
)));

test('a bill a dump from before 089 loads without its flag is back in quarantine when the app boots, before anybody reads it', async () => {
  const d = await loadDumpFromBefore089(970000);
  // The state the load leaves: 089 recorded against the empty database, and
  // the bill outside the quarantine.
  assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name LIKE '089\\_%'")).rowCount, 1);
  assert.deepEqual(await quarantineFlags(d.bills), { legacy: false, noBudget: false, afterCutoff: false });

  // The boot: runbook step 6, which is server.js awaiting this before listen().
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  assert.deepEqual(await quarantineFlags(d.bills), { legacy: true, noBudget: false, afterCutoff: false },
    'the boot left the restored bill outside the quarantine, or took in a bill it has no reason to');

  // And nobody reads a figure off it: not the payer, not Bea, and not Eve,
  // whose own share is Ann's answer.
  for (const viewer of [d.pat, d.bea, d.eve]) {
    const res = await readBill(d.flockId, viewer);
    const b = res.body.bill;
    assert.equal(b.quarantined, true, `${viewer.name}: ${res.text}`);
    assert.deepEqual([b.totalAmount, b.totalWithTip, b.settledCount, b.shareCount, b.fullySettled],
      [null, null, null, null, null], `${viewer.name} read a total or a count`);
    for (const s of b.shares) {
      assert.deepEqual([s.amount, s.paidAmount, s.outstanding, s.settled, s.committed],
        [null, null, null, null, null], `${viewer.name} read a figure or a flag on ${s.name}'s row`);
    }
    assert.ok(!res.text.includes('47.13'), `${viewer.name} read Ann's answer: ${res.text}`);
  }
  const link = await call('GET', `/api/billing/${d.flockId}/payment-links`, { token: d.eve.token });
  assert.equal(link.status, 409, link.text);
  assert.ok(!link.text.includes('47.13'), link.text);
});

test('verify-backup fails a restored database with a bill out of quarantine, and passes it once the boot it runs has put the bill back', async () => {
  const verify = require('../scripts/verify-backup');
  const quietly = async (fn) => {
    const log = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = log; }
  };
  const [name, sql] = verify.INVARIANTS.find(([n]) => /is in quarantine/.test(n)) || [];
  assert.ok(sql, 'verify-backup has no quarantine invariant');
  const d = await loadDumpFromBefore089(980000);
  const client = await pool.connect();
  try {
    const out = async () => Number((await client.query(sql)).rows[0].n);
    // Read the way scripts/verify-backup.js reads a restore it has not booted.
    assert.equal(await out(), 1, `${name}: the restored bill is not counted`);
    assert.equal(await quietly(() => verify.checkInvariants(client)), false,
      'a restored database with a bill out of quarantine passed the invariants');
    // Its own step 3: the app's first boot on the restore, then the checks.
    assert.equal(await quietly(() => verify.bootRestored(pool, client)), true);
    assert.equal(await out(), 0);
    assert.equal(await quietly(() => verify.checkInvariants(client)), true);
    assert.deepEqual(await quarantineFlags(d.bills), { legacy: true, noBudget: false, afterCutoff: false });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. A push that carries a quarantined bill's figure
// ═══════════════════════════════════════════════════════════════════════════
//
// bill_created ("You owe {payer} $X") and bill_settled ("{name} says they paid
// you $X") carry an amount in their body, and a push held for quiet hours or
// queued for a retry waits in push_outbox with that body verbatim. Delivery
// re-checked membership, blocks and bans, and never the quarantine, so a settle
// on a legacy bill before 089 ran could queue Eve's ghost share, which is Ann's
// answer, for Pat, and the sweep sent it after the bill had been quarantined.

const outboxRows = async (ids) => (await pool.query(
  'SELECT id FROM push_outbox WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]
)).rows.map((r) => Number(r.id));

test('a push queued with a legacy bill\'s figure is never sent once the bill is quarantined, and none is sent fresh', async () => {
  const firebaseService = require('../services/firebaseService');
  const pushHelper = require('../services/pushHelper');
  const { pat, eve, flockId } = await legacyBillWithAnnsAnswer();
  // An ordinary bill beside it, so the same sweep shows it still delivers.
  const cal = await mkUser('Cal');
  const dee = await mkUser('Dee');
  const plainFlock = await mkFlock(cal, [dee]);
  assert.equal((await call('POST', `/api/billing/${plainFlock}/create`, { token: cal.token, body: { totalAmount: 60 } })).status, 201);
  // One device each, with no time zone on record, so nothing waits for morning.
  for (const u of [pat, cal]) {
    await pool.query('INSERT INTO device_tokens (user_id, token) VALUES ($1, $2)', [u.id, `fcm-bbi-${u.id}-${'x'.repeat(40)}`]);
  }
  // The row a settle on the legacy bill queued before 089 ran and the purge
  // did not see: an instance still on older code mid-deploy queues its failed
  // send for a retry after the new boot has already cleared the outbox.
  const queue = async (userId, body, data) => (await one(
    `INSERT INTO push_outbox (user_id, reason, title, body, data, next_attempt_at, expires_at)
     VALUES ($1, 'retry', 'Marked as paid back', $2, $3::jsonb, NOW() - INTERVAL '1 second', NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [userId, body, JSON.stringify(data)]
  )).id;
  const legacyRow = Number(await queue(pat.id, 'Eve says they paid you $47.13 for Dinner. Check your payment app.',
    { type: 'bill_settled', flockId: String(flockId), fromUserId: String(eve.id) }));
  const plainRow = Number(await queue(cal.id, 'Dee says they paid you $30.00 for Dinner. Check your payment app.',
    { type: 'bill_settled', flockId: String(plainFlock), fromUserId: String(dee.id) }));

  const sent = [];
  pushHelper._resetDebounce();
  firebaseService.__setSenderForTests((message) => { sent.push(message); return 'ok'; });
  try {
    await pushHelper.sweepPushOutbox();
    const told = sent.map((m) => m.notification.body);
    assert.ok(!JSON.stringify(sent).includes('47.13'), `the sweep sent the legacy bill's figure: ${JSON.stringify(told)}`);
    assert.deepEqual(told, ['Dee says they paid you $30.00 for Dinner. Check your payment app.'],
      'the ordinary bill\'s push did not go out, so the sweep proves nothing');
    assert.deepEqual(await outboxRows([legacyRow, plainRow]), [], 'the refused row was kept to be tried again');

    // Fresh, both kinds: refused the same way before anything is sent.
    for (const type of ['bill_created', 'bill_settled']) {
      const r = await pushHelper.pushIfOffline(io, pat.id, 'Bill', 'You owe Pat $47.13 for Dinner',
        { type, flockId: String(flockId), fromUserId: String(eve.id) });
      assert.deepEqual([r.skipped, r.reason], [true, 'not-visible'], `${type}: ${JSON.stringify(r)}`);
    }
    // And a bill push that names no plan cannot be checked, so it is not sent.
    const unnamed = await pushHelper.pushIfOffline(io, pat.id, 'Bill', 'You owe Pat $47.13',
      { type: 'bill_settled', fromUserId: String(eve.id) });
    assert.equal(unnamed.skipped, true);
    assert.equal(sent.length, 1);
  } finally {
    firebaseService.__setSenderForTests(null);
    pushHelper._resetDebounce();
  }
});

test('a push a restore brings back for a quarantined bill is deleted by the boot, before the sweep can send it', async () => {
  const d = await loadDumpFromBefore089(990000);
  const queued = Object.values(d.queued);
  assert.deepEqual(await outboxRows(queued), queued.sort((a, b) => a - b), 'the load brought both pushes in');

  const { migrate } = require('../db/migrate');
  await migrate(pool); // the boot: 089's quarantine again, then the purge
  assert.deepEqual(await quarantineFlags(d.bills), { legacy: true, noBudget: false, afterCutoff: false });
  assert.deepEqual(await outboxRows(queued), [d.queued.afterCutoff],
    'the boot left the legacy bill\'s figure waiting to be sent, or took a push it had no reason to');
  const verify = require('../scripts/verify-backup');
  const [, sql] = verify.INVARIANTS.find(([n]) => /queued push/.test(n)) || [];
  assert.ok(sql, 'verify-backup has no invariant for queued pushes');
  assert.equal(Number((await one(sql)).n), 0);
});
