// Run: node --test  (from backend/)
//
// Safety audit 2026-08-14 — "the takedown that didn't take anything down, and
// the blocks that leaked around it". Apple guideline 1.2 obligations on an app
// whose users are 15-22, so each of these is pinned rather than trusted:
//
//   1. A moderator-hidden DM stays hidden on EVERY path. PUT /dm/:id/read ran
//      `UPDATE ... RETURNING *` with no is_hidden predicate, so the recipient
//      of a taken-down message could re-read its text, image and venue card
//      whenever they liked, using an id their client already held. The REST
//      reply-target lookup had the same gap, which let a hidden message be
//      quoted back into the thread. Hidden content is also no longer reactable.
//   2. Blocks hold on the flock surfaces that carry a NAME and a FACE: member
//      previews, the roster, the members list and the activity feed.
//   3. Events that name an actor (flock_updated, flock_deleted,
//      flock_members_invited) fan out per member and skip blocked pairs
//      instead of hitting the `flock:{id}` room, which is not a membership
//      list. flock_deleted reads its recipients BEFORE the cascade.
//   4. bill_created names every member and what they owe, so it is rebuilt per
//      recipient — and GET /api/billing/:flockId applies the same rule, since a
//      leak that survives one refresh is not closed.
//   5. services/pushHelper.js canNotify FAILS CLOSED. It was the only block
//      enforcement point in the codebase that failed open.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'takedown-leaks-test-secret';

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
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 140)}`));
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

// Replaced BEFORE the routers are required — they destructure at module load.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'disabled' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'disabled' });

const messagesRouter = require('../routes/messages');
const flocksRouter = require('../routes/flocks');
const billingRouter = require('../routes/billing');

let emits = [];
const io = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
  socketsLeave() {},
  in() { return { socketsLeave() {} }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/billing', billingRouter);
app.use('/api/flocks', flocksRouter);
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  emits = [];
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
});

function on(re, fn) { handlers.push([re, fn]); }

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

function sqlOf(re) {
  const row = log.find((q) => re.test(q.sql));
  assert.ok(row, `expected a query matching ${re}`);
  return row.sql;
}

const BLOCKED_BETWEEN = /SELECT 1 FROM user_blocks/;         // isBlockedBetween
const INVISIBLE_IDS = /blocked_id AS id FROM user_blocks/;   // getInvisibleUserIds
const BLOCK_PAIRS = /SELECT blocker_id, blocked_id FROM user_blocks/; // billing map

// ---------------------------------------------------------------------------
// 1. The takedown
// ---------------------------------------------------------------------------

test('marking a hidden DM read is a 404, not a copy of the message', async () => {
  // The row exists and belongs to the caller; the PREDICATE is what refuses it.
  on(/UPDATE direct_messages SET read_status/, (_p, sql) => (
    /COALESCE\(is_hidden, false\) = false/.test(sql) ? { rows: [] } : { rows: [{
      id: 5, read_status: true, message_text: 'the taken-down text',
      image_url: 'data:image/png;base64,AAA', venue_data: { name: 'Bar' },
    }] }
  ));

  const res = await call('PUT', '/api/dm/5/read');

  assert.strictEqual(res.status, 404, 'a hidden message must not be servable to anyone');
  assert.ok(!/taken-down text/.test(res.text));
  const sql = sqlOf(/UPDATE direct_messages SET read_status/);
  assert.match(sql, /COALESCE\(is_hidden, false\) = false/);
  assert.ok(!/RETURNING \*/.test(sql), 'a route that flips a boolean must not also be a content read');
  assert.match(sql, /RETURNING id, read_status/);
});

test('marking a visible DM read still works, and answers with an ack only', async () => {
  on(/UPDATE direct_messages SET read_status/, () => ({ rows: [{ id: 5, read_status: true }] }));

  const res = await call('PUT', '/api/dm/5/read');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(res.body.message).sort(), ['id', 'read_status']);
});

test('a hidden DM cannot be quoted back into the thread over REST', async () => {
  on(BLOCKED_BETWEEN, () => ({ rows: [] }));
  on(/SELECT 1 WHERE EXISTS/, () => ({ rows: [{ '?column?': 1 }] })); // they are connected
  on(/SELECT id FROM direct_messages/, (_p, sql) => (
    /COALESCE\(is_hidden, false\) = false/.test(sql) ? { rows: [] } : { rows: [{ id: 5 }] }
  ));

  const res = await call('POST', '/api/dm/2', { message_text: 'look at this', reply_to_id: 5 });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid reply target');
  // The socket twin in sockets/handlers.js has always had this predicate; the
  // two transports must not drift apart again.
  assert.match(sqlOf(/SELECT id FROM direct_messages/), /COALESCE\(is_hidden, false\) = false/);
});

test('taken-down content is not reactable on either surface', async () => {
  on(/SELECT flock_id FROM messages WHERE id/, (_p, sql) => (
    /is_hidden IS NOT TRUE/.test(sql) ? { rows: [] } : { rows: [{ flock_id: 9 }] }
  ));
  const flockReact = await call('POST', '/api/messages/5/react', { emoji: '🔥' });
  assert.strictEqual(flockReact.status, 404);
  assert.match(sqlOf(/SELECT flock_id FROM messages WHERE id/), /is_hidden IS NOT TRUE/);

  log = [];
  handlers = [];
  on(/SELECT sender_id, receiver_id FROM direct_messages/, (_p, sql) => (
    /COALESCE\(is_hidden, false\) = false/.test(sql) ? { rows: [] } : { rows: [{ sender_id: 2, receiver_id: 1 }] }
  ));
  const dmReact = await call('POST', '/api/dm/messages/5/react', { emoji: '🔥' });
  assert.strictEqual(dmReact.status, 404);
  assert.match(sqlOf(/SELECT sender_id, receiver_id FROM direct_messages/), /COALESCE\(is_hidden, false\) = false/);
});

// ---------------------------------------------------------------------------
// 2. Blocks on the flock surfaces
// ---------------------------------------------------------------------------

const BLOCK_PREDICATE = /NOT EXISTS \(\s*SELECT 1 FROM user_blocks b/;

test('the flock list never builds a member preview out of a blocked user', async () => {
  on(/FROM flocks f/, () => ({ rows: [] }));
  await call('GET', '/api/flocks');
  const sql = sqlOf(/member_previews/);
  assert.match(sql.replace(/\s+/g, ' '), /NOT EXISTS \( SELECT 1 FROM user_blocks b/);
});

test('the activity feed narrates neither a blocked creator nor a blocked member', async () => {
  on(/happened_at/, () => ({ rows: [] }));
  await call('GET', '/api/flocks/activity');
  const sql = sqlOf(/happened_at/).replace(/\s+/g, ' ');
  const occurrences = sql.split('NOT EXISTS ( SELECT 1 FROM user_blocks b').length - 1;
  assert.strictEqual(occurrences, 2, 'both halves of the UNION name a person');
});

const ROSTER = [
  { id: 1, name: 'Ava', status: 'accepted' },
  { id: 2, name: 'Ben', status: 'accepted' },
  { id: 3, name: 'Mallory', status: 'accepted' },
];

function scriptFlockDetail() {
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'accepted' }] }));
  on(/FROM flocks f/, () => ({ rows: [{ id: 9, name: 'Dinner', status: 'planning', budget_enabled: false, event_time: null, venue_name: 'TBD', creator_name: 'Ava' }] }));
  on(/u\.reliability_score/, () => ({ rows: ROSTER }));
  on(/FROM guest_rsvps/, () => ({ rows: [] }));
  on(/FROM venue_votes/, () => ({ rows: [{ voters: '0' }] }));
  on(/FROM guest_votes/, () => ({ rows: [{ voters: '0' }] }));
  on(INVISIBLE_IDS, () => ({ rows: [{ id: 3 }] })); // Mallory is invisible to Ava
}

test('the flock roster withholds a blocked member without shrinking the head count', async () => {
  scriptFlockDetail();

  const res = await call('GET', '/api/flocks/9');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.members.map((m) => m.name), ['Ava', 'Ben']);
  assert.ok(!res.text.includes('Mallory'), 'no name, no avatar, nothing');
  // The head count is a fact about the plan, not about a person: if it moved,
  // two people looking at the same flock would read a different "going" number
  // and the list route's member_count would contradict this one on screen.
  assert.strictEqual(res.body.flock.member_count, 3);
  assert.strictEqual(res.body.momentum.accepted, 3);
});

test('the members list applies the same rule', async () => {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] }));
  on(/SELECT u\.id, u\.name, u\.profile_image_url, fm\.status/, () => ({ rows: ROSTER }));
  on(/FROM guest_rsvps/, () => ({ rows: [] }));
  on(INVISIBLE_IDS, () => ({ rows: [{ id: 3 }] }));

  const res = await call('GET', '/api/flocks/9/members');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.members.map((m) => m.name), ['Ava', 'Ben']);
  assert.strictEqual(res.body.going_count, 3);
});

// ---------------------------------------------------------------------------
// 3. Events that name an actor
// ---------------------------------------------------------------------------

test('flock_updated reaches members personally and skips the one who blocked the editor', async () => {
  on(/SELECT creator_id FROM flocks/, () => ({ rows: [{ creator_id: 1 }] }));
  on(/UPDATE flocks/, () => ({ rows: [{ id: 9, name: 'New name', status: 'planning', budget_ceiling: null }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(INVISIBLE_IDS, () => ({ rows: [{ id: 3 }] }));

  const res = await call('PUT', '/api/flocks/9', { name: 'New name' });

  assert.strictEqual(res.status, 200);
  const updated = emits.filter((e) => e.event === 'flock_updated');
  assert.deepStrictEqual(updated.map((e) => e.room), ['user:2']);
  assert.strictEqual(updated[0].payload.updatedBy, 'Ava', 'the payload is why this needs filtering');
  assert.ok(!emits.some((e) => /^flock:/.test(e.room)));
});

test('flock_deleted names the deleter, so it is filtered — and its recipients are read before the cascade', async () => {
  on(/SELECT creator_id FROM flocks/, () => ({ rows: [{ creator_id: 1 }] }));
  // Both delete paths refuse while anyone still owes money on the plan: the bill
  // and every share row are ON DELETE CASCADE, so a delete used to take them
  // with it and nothing could recreate any of it. Nothing is owed here.
  on(/FROM bill_split_shares bss/, () => ({ rows: [{ owed: false }] }));
  on(/SELECT name FROM flocks WHERE id/, () => ({ rows: [{ name: 'Dinner' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(INVISIBLE_IDS, () => ({ rows: [{ id: 3 }] }));
  on(/DELETE FROM flocks/, () => ({ rows: [], rowCount: 1 }));

  const res = await call('DELETE', '/api/flocks/9');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(emits.filter((e) => e.event === 'flock_deleted').map((e) => e.room), ['user:2']);
  assert.ok(!emits.some((e) => /^flock:/.test(e.room)));

  // DELETE FROM flocks cascades flock_members away: read the recipients late and
  // the event reaches nobody at all.
  const readAt = log.findIndex((q) => /SELECT user_id FROM flock_members/.test(q.sql));
  const deletedAt = log.findIndex((q) => /DELETE FROM flocks/.test(q.sql));
  assert.ok(readAt !== -1 && deletedAt !== -1 && readAt < deletedAt, 'recipients captured before the delete');
});

test('flock_members_invited does not hand the inviter name to someone who blocked them', async () => {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status/, () => ({ rows: [{ id: 1 }] }));
  on(/SELECT id, name FROM flocks WHERE id/, () => ({ rows: [{ id: 9, name: 'Dinner' }] }));
  on(/COUNT\(\*\)::int AS n FROM flock_members/, () => ({ rows: [{ n: 2 }] }));
  // The invite path's three reads are set-based now (2026-08-14). Same answers
  // as the per-row branches they replace: 5 has no row here, 5 is a real user
  // called Zed, and nobody has blocked the INVITER — the block this test is
  // about is member 3 blocking Ava, which is a separate lookup
  // (getInvisibleUserIds) driving the fan-out below.
  on(/SELECT user_id, status FROM flock_members WHERE flock_id = \$1 AND user_id = ANY\(\$2::int\[\]\)/, () => ({ rows: [] }));
  on(/SELECT id, name FROM users WHERE id = ANY\(\$1::int\[\]\)/, (p) => ({
    rows: (p[0] || []).map((id) => ({ id: Number(id), name: 'Zed' })),
  }));
  on(BLOCK_PAIRS, () => ({ rows: [] }));
  on(BLOCKED_BETWEEN, () => ({ rows: [] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 77 }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(INVISIBLE_IDS, () => ({ rows: [{ id: 3 }] }));

  const res = await call('POST', '/api/flocks/9/invite', { user_ids: [5] });

  assert.strictEqual(res.status, 200);
  const announced = emits.filter((e) => e.event === 'flock_members_invited');
  assert.deepStrictEqual(announced.map((e) => e.room), ['user:2']);
  assert.strictEqual(announced[0].payload.invitedBy.name, 'Ava');
  assert.ok(!emits.some((e) => /^flock:/.test(e.room)));
});

test('flock_members_invited names only the people who really got a row', async () => {
  // The payload is a list of user ids that every non-blocked member's client
  // renders. Built from the SUBMITTED list rather than the written one, it
  // announces to the whole flock which ids the inviter tried and failed on —
  // people who blocked them, ids with no account behind them, ids the budget or
  // the ceilings refused. None of that is the flock's business, and two of those
  // three are facts about somebody else's account.
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status/, () => ({ rows: [{ id: 1 }] }));
  on(/SELECT id, name FROM flocks WHERE id/, () => ({ rows: [{ id: 9, name: 'Dinner' }] }));
  on(/COUNT\(\*\)::int AS n FROM flock_members/, () => ({ rows: [{ n: 2 }] }));
  on(/SELECT user_id, status FROM flock_members WHERE flock_id = \$1 AND user_id = ANY\(\$2::int\[\]\)/, () => ({ rows: [] }));
  // 5 is a real account; 6 has none.
  on(/SELECT id, name FROM users WHERE id = ANY\(\$1::int\[\]\)/, (p) => ({
    rows: (p[0] || []).map(Number).filter((id) => id !== 6).map((id) => ({ id, name: 'Zed' })),
  }));
  // 7 blocked the inviter. One row, one direction — that is all a block ever is.
  on(BLOCK_PAIRS, () => ({ rows: [{ blocker_id: 7, blocked_id: 1 }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 77 }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }] }));
  on(INVISIBLE_IDS, () => ({ rows: [] }));

  const res = await call('POST', '/api/flocks/9/invite', { user_ids: [5, 6, 7] });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.invited.map((i) => i.user_id), [5]);

  const announced = emits.filter((e) => e.event === 'flock_members_invited');
  assert.deepStrictEqual(announced[0].payload.invitedUserIds, [5],
    'the fan-out must carry the ids that got a row, not the ids that were asked for');
  assert.deepStrictEqual(
    emits.filter((e) => e.event === 'flock_invite_received').map((e) => e.room), ['user:5'],
    'and the invite itself reaches only that person — never the blocker, never the ghost'
  );
});

test('no route in the audited files broadcasts to the flock room any more', () => {
  // The room is joined when a client opens the flock screen and is never
  // re-checked, so it is neither a membership list nor block-aware. A grep is
  // the only assertion that covers the routes this file does not exercise.
  for (const file of ['routes/flocks.js', 'routes/messages.js', 'routes/billing.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const hits = src.split('\n').filter((l) => /io\.to\(`flock:/.test(l));
    assert.deepStrictEqual(hits, [], `${file} still broadcasts to the flock room`);
  }
});

// ---------------------------------------------------------------------------
// 4. The bill
// ---------------------------------------------------------------------------

const MEMBERS = [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }, { id: 3, name: 'Mallory' }];

function scriptBillCreate(blockRows, invisibleToCreator = []) {
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: MEMBERS.map((m) => ({ user_id: m.id })) }));
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] }));
  on(/SELECT u\.id, u\.name FROM flock_members/, () => ({ rows: MEMBERS }));
  on(/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: 1 }] }));
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/SELECT id, paid_by FROM bill_splits/, () => ({ rows: [] }));
  on(/SELECT user_id, .*FROM bill_split_shares/, () => ({ rows: [] }));
  on(/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] }));
  on(/DELETE FROM bill_split_shares/, () => ({ rows: [], rowCount: 0 }));
  on(/INSERT INTO bill_split_shares/, () => ({ rows: [] }));
  on(BLOCK_PAIRS, () => ({ rows: blockRows }));
  on(INVISIBLE_IDS, () => ({ rows: invisibleToCreator.map((id) => ({ id })) }));
}

test('the 201 body the creator gets back is filtered like every other view', async () => {
  // The creator picks share IDS; the server supplies the names. An unfiltered
  // 201 would show a blocked member's name once and lose it on the next GET —
  // and their own roster no longer contains that person at all.
  scriptBillCreate([], [3]);

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90 });

  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.name), ['Ava', 'Ben']);
  assert.ok(!res.text.includes('Mallory'));
  // Still committed, still a whole bill: only the names moved.
  assert.strictEqual(res.body.bill.totalAmount, 90);
  // ...and the fan-out still built Mallory her own copy from the full set.
  const toMallory = emits.find((e) => e.event === 'bill_created' && e.room === 'user:3');
  assert.strictEqual(toMallory.payload.bill.shares.length, 3);
});

test('bill_created is rebuilt per recipient — nobody is told what a blocked user owes', async () => {
  scriptBillCreate([{ blocker_id: 2, blocked_id: 3 }]); // Ben and Mallory cannot see each other

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90 });
  assert.strictEqual(res.status, 201);

  const byRoom = Object.fromEntries(
    emits.filter((e) => e.event === 'bill_created').map((e) => [e.room, e.payload.bill])
  );
  assert.deepStrictEqual(Object.keys(byRoom).sort(), ['user:1', 'user:2', 'user:3']);
  assert.deepStrictEqual(byRoom['user:1'].shares.map((s) => s.name).sort(), ['Ava', 'Ben', 'Mallory']);
  assert.deepStrictEqual(byRoom['user:2'].shares.map((s) => s.name).sort(), ['Ava', 'Ben']);
  assert.deepStrictEqual(byRoom['user:3'].shares.map((s) => s.name).sort(), ['Ava', 'Mallory']);
  // The table's total is a fact about the table, not about a person.
  assert.strictEqual(byRoom['user:2'].totalAmount, 90);
});

test('a recipient who blocked the payer is not handed the payer name', async () => {
  scriptBillCreate([{ blocker_id: 3, blocked_id: 1 }]); // Mallory blocked Ava, who is paying

  await call('POST', '/api/billing/42/create', { totalAmount: 60 });

  const toMallory = emits.find((e) => e.event === 'bill_created' && e.room === 'user:3').payload.bill;
  assert.strictEqual(toMallory.paidBy.name, null, 'client renders its own "Unknown" fallback');
  assert.strictEqual(toMallory.paidBy.id, 1);
  assert.ok(!emits.filter((e) => e.room === 'user:3').some((e) => JSON.stringify(e.payload).includes('Ava')));

  const toBen = emits.find((e) => e.event === 'bill_created' && e.room === 'user:2').payload.bill;
  assert.strictEqual(toBen.paidBy.name, 'Ava', 'everyone else is unaffected');
});

test('the same rule survives a refresh — GET filters the bill too', async () => {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] }));
  on(/FROM bill_splits bs/, () => ({ rows: [{ id: 7, flock_id: 42, total_amount: '90.00', tip_percent: '0', split_type: 'equal', paid_by: 3, payer_name: 'Mallory', created_at: 'now' }] }));
  on(/FROM bill_split_shares bss/, () => ({ rows: [
    { user_id: 1, name: 'Ava', amount: '30.00', committed: false, settled: false, settled_at: null },
    { user_id: 3, name: 'Mallory', amount: '30.00', committed: false, settled: true, settled_at: 'now' },
  ] }));
  on(INVISIBLE_IDS, () => ({ rows: [{ id: 3 }] }));

  const res = await call('GET', '/api/billing/42');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.name), ['Ava']);
  assert.strictEqual(res.body.bill.paidBy.name, null);
  assert.ok(!res.text.includes('Mallory'));
  assert.strictEqual(res.body.bill.totalAmount, 90);
});

// ---------------------------------------------------------------------------
// 5. The push gate
// ---------------------------------------------------------------------------

test('canNotify fails CLOSED when the block lookup cannot answer', async () => {
  on(BLOCKED_BETWEEN, () => Promise.reject(new Error('connection terminated')));

  const allowed = await pushMod.canNotify(1, { type: 'dm_message', senderId: 2 });

  assert.strictEqual(allowed, false,
    'a push lands on a lock screen — an unanswerable block check must not be resolved in favour of sending');
});

test('canNotify fails CLOSED when the visibility lookup cannot answer', async () => {
  on(BLOCKED_BETWEEN, () => ({ rows: [] }));
  on(/FROM users u/, () => Promise.reject(new Error('connection terminated')));

  assert.strictEqual(await pushMod.canNotify(1, { type: 'flock_invite', flockId: 7, fromUserId: 2 }), false);
});

test('canNotify still says yes on a clean lookup', async () => {
  on(BLOCKED_BETWEEN, () => ({ rows: [] }));
  on(/FROM users u/, () => ({ rows: [{ is_banned: false, can_see: true }] }));

  assert.strictEqual(await pushMod.canNotify(1, { type: 'flock_invite', flockId: 7, fromUserId: 2 }), true);
});
