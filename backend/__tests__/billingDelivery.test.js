// Run: node --test  (from backend/)
//
// Round 16 — delivery and disclosure on the money + venue routes.
//
//   1. `bill_created` is the highest-value payload on any realtime surface:
//      every member's name paired with the exact amount they owe. It went to
//      `flock:{id}`, which is not a membership list — sockets/handlers.js
//      checks membership once at join_flock and then trusts the room for the
//      life of the connection.
//   2. Post-commit work (socket fan-out, push notifications) ran inside the
//      transaction's try block, so a push failure ran ROLLBACK on a committed
//      connection and answered 500 for a bill that exists.
//   3. Payment handles were interpolated raw into Venmo/Cash App deep links.
//   4. Venue vote tallies grouped by (venue_name, venue_id), which split one
//      venue across rows AND double counted guest votes, because the guest
//      counts are keyed by name.
//   5. A failed check-in insert burned the caller's 30-minute dedupe window.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'billing-delivery-test-secret';

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
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 120)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

// Both must be replaced BEFORE the routers are required — the routers
// destructure them at module load.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
// Indirection on purpose: billing.js captures this function reference once, so
// a test that wants a failing push has to change behaviour THROUGH it.
let pushBehaviour = async () => ({ skipped: true });
pushMod.pushIfOffline = (...args) => pushBehaviour(...args);
pushMod.pushIfOfflineDebounced = (...args) => pushBehaviour(...args);

const billingRouter = require('../routes/billing');
const venueRouter = require('../routes/venues');
const checkinRouter = require('../routes/checkin');

// Records every emit so a test can assert on the ROOM, not just the event.
let emits = [];
const io = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/billing', billingRouter);
app.use('/api/flocks', venueRouter);
app.use('/api/checkin', checkinRouter);

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
  pushBehaviour = async () => ({ skipped: true });
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  require('../routes/checkin').__test.tapCache.clear();
});

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

const THREE = [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }, { id: 3, name: 'Cy' }];

// `members` is who the flock ACTUALLY has at emit time; it can differ from the
// snapshot the bill was built from, which is the whole point of test 1.
function scriptBillCreate({ members = THREE, acceptedAtEmit = members } = {}) {
  handlers = [
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: acceptedAtEmit.map((m) => ({ user_id: m.id })) })],
    // bill_created is now built per recipient (2026-08-14 block audit), so the
    // fan-out reads the block table for the member set. Nobody blocks anybody
    // in this default world; takedownLeaks.test.js is where the filtering is
    // exercised.
    [/FROM user_blocks/, () => ({ rows: [] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] })],
    [/SELECT u\.id, u\.name FROM flock_members/, () => ({ rows: members })],
    [/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: 1 }] })],
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id, paid_by FROM bill_splits/, () => ({ rows: [] })],
    [/SELECT user_id, .*FROM bill_split_shares/, () => ({ rows: [] })],
    [/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] })],
    [/DELETE FROM bill_split_shares/, () => ({ rows: [], rowCount: 0 })],
    [/INSERT INTO bill_split_shares/, () => ({ rows: [] })],
  ];
}

// ---------------------------------------------------------------------------
// 1. Who can receive a share amount
// ---------------------------------------------------------------------------

test('bill_created goes to each member personally, never to the flock room', async () => {
  scriptBillCreate();

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90 });
  assert.strictEqual(res.status, 201);

  const created = emits.filter((e) => e.event === 'bill_created');
  assert.strictEqual(created.length, 3, 'one delivery per accepted member');
  assert.deepStrictEqual(
    created.map((e) => e.room).sort(),
    ['user:1', 'user:2', 'user:3'],
    'the flock room is not a membership list — it is whoever opened the screen and never closed the socket'
  );
  assert.ok(
    !emits.some((e) => /^flock:/.test(e.room)),
    'nothing carrying per-person amounts may go to flock:{id}'
  );
  // The payload is still the one the client expects.
  assert.ok(created[0].payload.bill.shares.some((s) => s.amount > 0));
});

test('membership is re-read at emit time, so a stale room member gets nothing', async () => {
  // Cy was in the flock when the bill screen was opened; by the time the bill
  // is created he has been removed. His socket may still sit in `flock:42`.
  scriptBillCreate({ members: THREE, acceptedAtEmit: [{ id: 1 }, { id: 2 }] });

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90 });
  assert.strictEqual(res.status, 201);

  const rooms = emits.filter((e) => e.event === 'bill_created').map((e) => e.room);
  assert.deepStrictEqual(rooms.sort(), ['user:1', 'user:2']);
  assert.ok(!rooms.includes('user:3'), 'a removed member must not receive the split');
});

test('share_settled and bill_fully_settled use the same per-member delivery', async () => {
  handlers = [
    // /settle takes the same flock-row lock /create holds, so a settle cannot
    // land inside /create's read-then-rewrite and be erased by it.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: [{ user_id: 1 }, { user_id: 2 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] })],
    [/SELECT id FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7 }] })],
    [/UPDATE bill_split_shares SET settled/, () => ({ rows: [{ id: 1 }] })],
    [/SELECT COUNT\(\*\) AS count FROM bill_split_shares/, () => ({ rows: [{ count: '0' }] })],
    // share_settled names the settler, so its recipient list is block-filtered
    // (2026-08-14). Nobody blocks anybody here; the actor stays a recipient.
    [/FROM user_blocks/, () => ({ rows: [] })],
  ];

  const res = await call('POST', '/api/billing/42/settle');
  assert.strictEqual(res.status, 200);

  assert.ok(!emits.some((e) => /^flock:/.test(e.room)), 'still no flock-room broadcasts');
  assert.deepStrictEqual(
    emits.filter((e) => e.event === 'share_settled').map((e) => e.room).sort(),
    ['user:1', 'user:2']
  );
  assert.strictEqual(emits.filter((e) => e.event === 'bill_fully_settled').length, 2);
});

test('the fully-settled check counts a NULL settled flag as unsettled', async () => {
  handlers = [
    // /settle takes the same flock-row lock /create holds, so a settle cannot
    // land inside /create's read-then-rewrite and be erased by it.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: [{ user_id: 1 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] })],
    [/SELECT id FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7 }] })],
    [/UPDATE bill_split_shares SET settled/, () => ({ rows: [{ id: 1 }] })],
    [/SELECT COUNT\(\*\) AS count FROM bill_split_shares/, () => ({ rows: [{ count: '1' }] })],
    [/FROM user_blocks/, () => ({ rows: [] })],
  ];

  await call('POST', '/api/billing/42/settle');

  const countQuery = log.find((q) => /SELECT COUNT\(\*\) AS count FROM bill_split_shares/.test(q.sql));
  assert.ok(
    /settled IS NOT TRUE/.test(countQuery.sql),
    `"settled = false" silently skips NULL rows: ${countQuery.sql}`
  );
});

// ---------------------------------------------------------------------------
// 2. A committed bill stays committed
// ---------------------------------------------------------------------------

test('a push notification that throws cannot turn a created bill into a 500', async () => {
  scriptBillCreate();
  pushBehaviour = async () => { throw new Error('FCM unreachable'); };

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90 });

  assert.strictEqual(res.status, 201, 'the bill was committed — saying otherwise makes the client rewrite it');
  assert.ok(res.body.bill.id);
  // And no ROLLBACK was issued after the COMMIT.
  const commit = log.findIndex((q) => /^COMMIT/i.test(q.sql));
  assert.ok(commit >= 0);
  assert.ok(
    !log.slice(commit).some((q) => /^ROLLBACK/i.test(q.sql)),
    'rolling back a committed connection is how the 500 used to happen'
  );
});

test('a settle whose fan-out fails is still reported as settled', async () => {
  // The UPDATE has already landed. Answering 500 here makes the user pay twice.
  handlers = [
    // /settle takes the same flock-row lock /create holds, so a settle cannot
    // land inside /create's read-then-rewrite and be erased by it.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => { throw new Error('replica down'); }],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] })],
    [/SELECT id FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7 }] })],
    [/UPDATE bill_split_shares SET settled/, () => ({ rows: [{ id: 1 }] })],
  ];

  const res = await call('POST', '/api/billing/42/settle');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.settled, true);
  assert.ok(log.some((q) => /UPDATE bill_split_shares SET settled/.test(q.sql)), 'and it really did settle');
});

test('the created bill reports money as numbers, like the GET route does', async () => {
  scriptBillCreate();

  // isFloat() accepts the string, so this is a request the validator lets past.
  const res = await call('POST', '/api/billing/42/create', { totalAmount: '90', tipPercent: '10' });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(typeof res.body.bill.totalAmount, 'number', 'the client calls ?.toFixed(2) on these');
  assert.strictEqual(typeof res.body.bill.tipPercent, 'number');
  assert.strictEqual(typeof res.body.bill.totalWithTip, 'number');
  assert.strictEqual(res.body.bill.totalWithTip, 99);
});

// ---------------------------------------------------------------------------
// 2b. A bill that does not add up
// ---------------------------------------------------------------------------

test('a custom split always sums to the bill, to the cent', async () => {
  scriptBillCreate();

  // The classic third-of-a-hundred. The raw sum is 99.999999, which the old
  // plus-or-minus-two-cents check accepted; each share was only rounded to
  // cents afterwards, storing 33.33 three times and quietly losing a cent.
  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 100,
    splitType: 'custom',
    customShares: [
      { userId: 1, amount: 33.333333 },
      { userId: 2, amount: 33.333333 },
      { userId: 3, amount: 33.333333 },
    ],
  });

  assert.strictEqual(res.status, 201);
  const cents = res.body.bill.shares.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  assert.strictEqual(cents, 10000, `shares summed to $${(cents / 100).toFixed(2)}, not $100.00`);

  // And the rows written agree with the response.
  const written = log
    .filter((q) => /INSERT INTO bill_split_shares/.test(q.sql))
    .reduce((sum, q) => sum + Math.round(q.params[2] * 100), 0);
  assert.strictEqual(written, 10000);
});

test('the remainder lands on the largest share, not spread or dropped', async () => {
  scriptBillCreate();

  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 100,
    splitType: 'custom',
    customShares: [
      { userId: 1, amount: 50 },
      { userId: 2, amount: 24.99 },
      { userId: 3, amount: 24.99 },
    ],
  });

  assert.strictEqual(res.status, 201);
  const byUser = Object.fromEntries(res.body.bill.shares.map((s) => [s.userId, s.amount]));
  assert.strictEqual(byUser[1], 50.02, 'the biggest share absorbs the two odd cents');
  assert.strictEqual(byUser[2], 24.99);
  assert.strictEqual(byUser[3], 24.99);
  const cents = res.body.bill.shares.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  assert.strictEqual(cents, 10000);
});

test('a split that is genuinely wrong is still refused', async () => {
  scriptBillCreate();

  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 100,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 10 }, { userId: 2, amount: 10 }],
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /add up to \$100\.00/);
  assert.ok(!log.some((q) => /INSERT INTO bill_splits/.test(q.sql)));
});

test('a NaN share is rejected before it can poison the sum', async () => {
  scriptBillCreate();

  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 100,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 'not money' }, { userId: 2, amount: 100 }],
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /non-negative/);
});

test('a malformed customShares element is a 400, not a 500', async () => {
  scriptBillCreate();

  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 90,
    splitType: 'custom',
    customShares: [null, { userId: 1, amount: 90 }],
  });

  assert.strictEqual(res.status, 400, 'reading .amount off null used to throw straight into the 500 handler');
  assert.ok(!log.some((q) => /INSERT INTO bill_splits/.test(q.sql)), 'and nothing was written');
});

test('customShares has a maximum length', async () => {
  scriptBillCreate();
  // Comfortably inside the 1mb body limit the real server allows, and still
  // far past any real flock.
  const huge = Array.from({ length: 500 }, () => ({ userId: 1, amount: 0.01 }));

  const res = await call('POST', '/api/billing/42/create', {
    totalAmount: 50,
    splitType: 'custom',
    customShares: huge,
  });

  assert.strictEqual(res.status, 400);
  assert.ok(!log.some((q) => /INSERT INTO bill_split/.test(q.sql)));
});

// ---------------------------------------------------------------------------
// 3. Payment handles cannot rewrite the link they sit in
// ---------------------------------------------------------------------------

function scriptPaymentLinks(payer) {
  handlers = [
    // /settle takes the same flock-row lock /create holds, so a settle cannot
    // land inside /create's read-then-rewrite and be erased by it.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] })],
    [/FROM bill_splits bs\s+JOIN flocks f/, () => ({ rows: [{ id: 7, paid_by: 2, flock_id: 42, flock_name: 'Dinner' }] })],
    // These routes hand over the payer's payment handles, so they refuse a
    // blocked payer (2026-08-14). Nobody blocks anybody in this fixture.
    [/SELECT 1 FROM user_blocks/, () => ({ rows: [] })],
    [/SELECT amount, .*FROM bill_split_shares/, () => ({ rows: [{ amount: '30.00' }] })],
    [/FROM users WHERE id = \$1/, () => ({ rows: [payer] })],
  ];
}

test('a payer cannot smuggle a second amount into their own Venmo link', async () => {
  // users.js accepts any 50 characters for a handle, so this is storable today.
  scriptPaymentLinks({ name: 'Ben', venmo_username: 'ben&amount=500' });

  const res = await call('GET', '/api/billing/42/venmo-link');

  assert.strictEqual(res.status, 200);
  assert.ok(!/recipients=ben&amount=500/.test(res.body.deepLink), res.body.deepLink);
  assert.strictEqual(
    (res.body.deepLink.match(/[?&]amount=/g) || []).length,
    1,
    'exactly one amount parameter, and it is the one the server computed'
  );
  assert.ok(/amount=30(\D|$)/.test(res.body.deepLink), res.body.deepLink);
});

test('the same rule covers every method on /payment-links', async () => {
  scriptPaymentLinks({
    name: 'Ben',
    venmo_username: 'ben&amount=500',
    cashapp_cashtag: 'ben?amount=500',
    zelle_identifier: 'ben@example.com',
  });

  const res = await call('GET', '/api/billing/42/payment-links');
  assert.strictEqual(res.status, 200);

  for (const m of res.body.methods) {
    for (const link of [m.deepLink, m.webLink]) {
      if (!link) continue;
      assert.ok(
        (link.match(/[?&]amount=/g) || []).length <= 1,
        `${m.method} link carries a smuggled parameter: ${link}`
      );
    }
  }
  // The human-readable handle is still readable — it is rendered as text.
  assert.strictEqual(res.body.methods.find((m) => m.method === 'venmo').handle, '@ben&amount=500');
});

// ---------------------------------------------------------------------------
// 4. Vote tallies
// ---------------------------------------------------------------------------

test('one venue is one row even when members voted for it with different place ids', async () => {
  handlers = [
    // /settle takes the same flock-row lock /create holds, so a settle cannot
    // land inside /create's read-then-rewrite and be erased by it.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] })],
    [/FROM user_blocks/, () => ({ rows: [] })],
    [/FROM venue_votes vv/, () => ({
      rows: [{ venue_name: "Joe's Bar", venue_id: 'abc', member_count: 2, voter_rows: [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }] }],
    })],
    [/FROM guest_votes gv/, () => ({ rows: [{ venue_name: "Joe's Bar", guest_count: 2 }] })],
  ];

  const res = await call('GET', '/api/flocks/42/votes');
  assert.strictEqual(res.status, 200);

  const tally = log.find((q) => /FROM venue_votes vv/.test(q.sql));
  assert.ok(
    /GROUP BY venue_name(?!\s*,)/.test(tally.sql),
    `grouping by (name, id) splits a venue and re-adds the guest count to each half: ${tally.sql}`
  );

  // With one group, the guest count is applied exactly once.
  assert.strictEqual(res.body.votes.length, 1);
  assert.strictEqual(res.body.votes[0].vote_count, 4);
  assert.strictEqual(res.body.votes[0].guest_count, 2);
});

// ---------------------------------------------------------------------------
// 5. A failed check-in does not cost the caller their window
// ---------------------------------------------------------------------------

test('a check-in whose insert fails can be retried immediately', async () => {
  let attempt = 0;
  handlers = [
    // /settle takes the same flock-row lock /create holds, so a settle cannot
    // land inside /create's read-then-rewrite and be erased by it.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/INSERT INTO venue_checkins/, () => {
      attempt++;
      if (attempt === 1) throw new Error('deadlock detected');
      return { rows: [{ created_at: '2026-08-14T00:00:00Z' }] };
    }],
    [/UPDATE flock_members SET attendance/, () => ({ rows: [], rowCount: 0 })],
  ];

  const first = await call('POST', '/api/checkin/ChIJqwertyuiop');
  assert.strictEqual(first.status, 500);

  const second = await call('POST', '/api/checkin/ChIJqwertyuiop');
  assert.strictEqual(second.status, 200, 'the failed attempt must not have claimed the 30-minute window');
  assert.ok(!second.body.deduped, 'and the retry must be a real check-in, not a dedupe stub');
  assert.strictEqual(attempt, 2);
});

test('crossing the dedupe bound evicts a handful, not the whole cache', async () => {
  const { tapCache, tapIsDuplicate } = require('../routes/checkin').__test;
  tapCache.clear();

  // Fill to exactly the bound.
  for (let i = 0; i < 10000; i++) tapIsDuplicate(i + 1, 'ChIJvenue', '1.1.1.1');
  assert.strictEqual(tapCache.size, 10000);

  // Five more. `clear()` collapsed the cache to a single entry here, which
  // re-opened the 30-minute window for every one of the other ten thousand
  // people at the same instant — and someone spraying fabricated place ids
  // could choose that instant.
  for (let i = 0; i < 5; i++) tapIsDuplicate(null, `ChIJspam${i}`, `10.0.0.${i}`);

  assert.strictEqual(tapCache.size, 10000, 'still bounded, and still full');

  // The five oldest lost their window; everyone after them kept theirs.
  assert.strictEqual(tapIsDuplicate(1, 'ChIJvenue', '1.1.1.1'), false, 'the oldest is the one evicted');
  assert.strictEqual(tapIsDuplicate(9000, 'ChIJvenue', '1.1.1.1'), true, 'recent taps are untouched');
});

test('a check-in that SUCCEEDS still holds the window', async () => {
  handlers = [
    // /settle takes the same flock-row lock /create holds, so a settle cannot
    // land inside /create's read-then-rewrite and be erased by it.
    [/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] })],
    [/INSERT INTO venue_checkins/, () => ({ rows: [{ created_at: '2026-08-14T00:00:00Z' }] })],
    [/UPDATE flock_members SET attendance/, () => ({ rows: [], rowCount: 0 })],
  ];

  const first = await call('POST', '/api/checkin/ChIJqwertyuiop');
  const second = await call('POST', '/api/checkin/ChIJqwertyuiop');

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.body.deduped, true);
  assert.strictEqual(log.filter((q) => /INSERT INTO venue_checkins/.test(q.sql)).length, 1);
});
