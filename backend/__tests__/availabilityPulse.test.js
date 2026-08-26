// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE PULSE HAD NO TESTS AT ALL.
// ---------------------------------------------------------------------------
// routes/availability.js is four endpoints, a free-text note written by one
// person and delivered to every friend they have, and two process-local
// cooldowns that are the only thing standing between a Friday night and thirty
// notifications. Until this file it had zero coverage. Not thin coverage. None.
// The route's own header spells out four rules it is careful to enforce, and
// nothing anywhere could tell if one of them stopped being true.
//
// WHAT THESE PIN, AND WHY EACH SHAPE IS THE SHAPE IT IS.
//
//   The block and ban predicates are asserted against the SOURCE, not through
//   the fixture, for the reason friendDiscoveryBans.test.js writes out: a stub
//   pool hands back whatever rows it was going to hand back regardless of the
//   WHERE clause, so a fixture cannot prove a WHERE clause exists. Delete a
//   predicate and the matching assertion here goes red. That is the only
//   version of this test worth having.
//
//   The four push rules are asserted through real HTTP against a stubbed
//   pushHelper, because those ARE behaviour: what matters is how many times a
//   phone buzzes, and only running the handler can answer that.
//
// WHY THE BLOCK PREDICATES ARE HERE AT ALL. Blocking deletes the friendship
// (routes/moderation.js), and for a while that was this route's ONLY protection
// against showing a blocked person's name and note to the person who blocked
// them. A derived invariant is not an enforced one. Every comparable list in
// the app filters user_blocks directly; this route trusted a side effect of a
// different route instead, and that side effect was a second statement whose
// failure was swallowed.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'availability-pulse-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// pushHelper is patched BEFORE routes/availability is required, because that
// module destructures both functions at require time. Patching afterwards would
// leave the route holding the originals and every push assertion below would be
// measuring nothing.
const pushHelper = require('../services/pushHelper');
let pushes = [];
pushHelper.pushIfOffline = async (io, userId, title, body, data) => {
  pushes.push({ userId, title, body, data });
  return { sent: true };
};
pushHelper.isPushConfigured = () => true;

const availabilityRouter = require('../routes/availability');

const ME = {
  id: 1, email: 'ava@example.com', name: 'Ava', role: 'user',
  profile_image_url: null, email_verified: true, is_banned: false, token_version: 0,
};

let friendIds;      // ids the friends query is allowed to return
let priorStatus;    // existing pulse status, or null
let emitted;        // [{ room, event, payload }]
let statements;
let lastExpiry;     // the expiry actually bound into the upsert

const AUTH_SQL = /^SELECT id, email, name, role,.*FROM users WHERE id = \$1$/i;

function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) return Promise.resolve({ rows: [ME], rowCount: 1 });
  statements.push(sql);

  if (/^SELECT status FROM availability_pulses/i.test(sql)) {
    return Promise.resolve({
      rows: priorStatus ? [{ status: priorStatus }] : [],
      rowCount: priorStatus ? 1 : 0,
    });
  }
  if (/^INSERT INTO availability_pulses/i.test(sql)) {
    lastExpiry = params[3];
    return Promise.resolve({
      rows: [{
        status: params[1], note: params[2],
        set_at: new Date('2026-08-26T20:00:00Z'), expires_at: params[3],
      }],
      rowCount: 1,
    });
  }
  // Both the fan-out query and GET /friends. The fixture answers with the ids
  // in `friendIds` whatever the WHERE says, which is exactly why the block and
  // ban clauses are pinned against the source instead of through here.
  if (/FROM friendships/i.test(sql)) {
    if (/AS friend_id/i.test(sql)) {
      return Promise.resolve({
        rows: friendIds.map((id) => ({ friend_id: id })),
        rowCount: friendIds.length,
      });
    }
    return Promise.resolve({
      rows: friendIds.map((id) => ({
        id, name: 'Friend ' + id, profile_image_url: null,
        status: 'down', note: null,
        set_at: new Date('2026-08-26T20:00:00Z'),
        expires_at: new Date('2026-08-27T08:00:00Z'),
      })),
      rowCount: friendIds.length,
    });
  }
  if (/^DELETE FROM availability_pulses/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 });
  if (/FROM availability_pulses/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({ query: (t, p) => dispatch(t, p), release: () => {} });

const io = {
  to(room) {
    return { emit: (event, payload) => emitted.push({ room, event, payload }) };
  },
};

const app = express();
app.use(express.json({ limit: '1mb' }));
app.set('io', io);
app.use('/api/availability', availabilityRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; r(); });
}));
test.after(() => new Promise((r) => server.close(() => r())));

test.beforeEach(() => {
  friendIds = [2, 3];
  priorStatus = null;
  emitted = [];
  statements = [];
  pushes = [];
  lastExpiry = null;
  availabilityRouter.__resetPulseWindows();
});

async function callAs(user, method, pathname, payload) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signUserToken(user) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, body };
}
const call = (method, pathname, payload) => callAs(ME, method, pathname, payload);

// The push fan-out runs AFTER the response is written, deliberately (the route
// says so). Awaiting the fetch is therefore not enough to observe it.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'availability.js'), 'utf8');
const MOD_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'moderation.js'), 'utf8');

// Every SQL literal in the route that reads friendships. Three of them do: the
// fan-out in POST /, the clear-pulse fan-out in DELETE /, and the list in
// GET /friends.
function friendshipStatements() {
  return ROUTE_SRC.split('pool.query(').slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('`,')))
    .filter((sql) => /FROM friendships/i.test(sql));
}

// ---------------------------------------------------------------------------
// 1. Neither surface that names a person trusts another route to have cleaned up
// ---------------------------------------------------------------------------

test('both queries that carry a name and a note filter blocks in BOTH directions', () => {
  const selects = friendshipStatements();
  // Three, not two, and the count is asserted rather than assumed. When this
  // was written it said two, because two fan-outs were obvious and the third
  // (the clear-pulse broadcast in DELETE /) was not. The count assertion is the
  // only reason that was found instead of shipped: a loop over whatever it
  // happened to match would have passed over an unfiltered statement and read
  // as coverage.
  assert.strictEqual(selects.length, 3,
    'expected the two pulse fan-outs and the friends list to read friendships; found '
    + selects.length + ', so a statement has been added or removed and this guard is no longer scanning all of them');

  for (const sql of selects) {
    const flat = sql.replace(/\s+/g, ' ');
    assert.match(flat, /NOT EXISTS \(\s*SELECT 1 FROM user_blocks/i,
      'this statement hands a name and free-text note out without excluding blocked accounts: ' + flat.slice(0, 120));
    assert.match(flat, /b\.blocker_id = \$1 AND b\.blocked_id = u\.id/i,
      'the outgoing direction is not excluded: somebody I blocked still reaches me');
    assert.match(flat, /b\.blocker_id = u\.id AND b\.blocked_id = \$1/i,
      'the incoming direction is not excluded: somebody who blocked me still hears from me');
  }
});

test('both queries drop banned accounts, the way every other list in the app does', () => {
  for (const sql of friendshipStatements()) {
    assert.match(sql.replace(/\s+/g, ' '), /COALESCE\(u\.is_banned, FALSE\) = FALSE/i,
      'a banned account still appears here, with a face and a note, to everyone it was friends with');
  }
});

test('blocking places the block and drops the friendship in ONE statement', () => {
  // This was an INSERT and then a separate DELETE carrying .catch(() => {}), so
  // any failure of the second half left a block and a friendship coexisting,
  // silently. The friendship is what the two queries above read, so that state
  // is precisely the one that leaks a name and a note to somebody who blocked.
  const from = MOD_SRC.indexOf('INSERT INTO user_blocks');
  assert.ok(from > 0, 'the block route no longer inserts into user_blocks');
  const stmt = MOD_SRC.slice(from, MOD_SRC.indexOf('`,', from));
  assert.match(stmt.replace(/\s+/g, ' '), /INSERT INTO user_blocks[\s\S]*DELETE FROM friendships/i,
    'the block and the un-friend are separate statements again, so half a block can succeed on its own');

  const tail = MOD_SRC.slice(from, MOD_SRC.indexOf('invalidateBlockCache', from));
  assert.ok(!/\.catch\(\(\) => \{\}\)/.test(tail),
    'a failure between placing the block and dropping the friendship is being swallowed again');
});

// ---------------------------------------------------------------------------
// 2. The four push rules the route header promises
// ---------------------------------------------------------------------------

test('rule 1: maybe and not do not buzz anybody', async () => {
  for (const status of ['maybe', 'not']) {
    availabilityRouter.__resetPulseWindows();
    pushes = [];
    const res = await call('POST', '/api/availability', { status });
    assert.strictEqual(res.status, 200, res.text);
    await settle();
    assert.deepStrictEqual(pushes, [],
      '"' + status + '" is an answer to a question, not an invitation, and it woke somebody up');
  }
});

test('rule 2: editing a pulse that is already down does not buzz again', async () => {
  priorStatus = 'down';
  const res = await call('POST', '/api/availability', { status: 'down', note: 'fixed a typo' });
  assert.strictEqual(res.status, 200, res.text);
  await settle();
  assert.deepStrictEqual(pushes, [], 'fixing a typo in a note re-notified every friend');
});

test('rule 3: one push per sender, however many times they toggle', async () => {
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.strictEqual(pushes.length, 2, 'the first pulse should reach both friends');

  // Toggle away and back. wasAlreadyDown is false each time, so only the sender
  // cooldown stands between this and a second round of buzzing.
  priorStatus = 'not';
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.strictEqual(pushes.length, 2,
    'a friend who toggles down, not, down buzzed everyone twice');
});

test('rule 4: a recipient hears from the first friend who is free, not the tenth', async () => {
  friendIds = [2];
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.strictEqual(pushes.length, 1);

  // A different sender, same recipient, inside the hour. Only the per-recipient
  // window can stop this one; the sender window belongs to somebody else.
  const OTHER = Object.assign({}, ME, { id: 9, name: 'Bo' });
  const res = await callAs(OTHER, 'POST', '/api/availability', { status: 'down' });
  assert.strictEqual(res.status, 200, res.text);
  await settle();
  assert.strictEqual(pushes.length, 1,
    'the second friend to say they are free buzzed a phone that had already been told');
});

test('the note is the push body, and its absence is not the string undefined', async () => {
  await call('POST', '/api/availability', { status: 'down', note: 'anyone want food' });
  await settle();
  assert.strictEqual(pushes[0].body, '"anyone want food"');

  availabilityRouter.__resetPulseWindows();
  pushes = [];
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.strictEqual(pushes[0].body, 'Tap to make a plan.');
});

test('the push carries fromUserId, which is what makes canNotify block-aware', async () => {
  // services/pushHelper.js reads the actor out of the payload (senderId,
  // fromUserId or actorId) and refuses the send if the pair is blocked. Drop
  // this key and the push silently stops being block-checked while every other
  // test here still passes.
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.strictEqual(pushes[0].data.fromUserId, String(ME.id),
    'without an actor in the payload, pushHelper cannot tell that the recipient blocked the sender');
});

test('the live socket payload goes only to the ids the filtered query returned', async () => {
  friendIds = [2];
  await call('POST', '/api/availability', { status: 'down', note: 'out back' });
  const rooms = emitted.filter((e) => e.event === 'availability_updated').map((e) => e.room);
  assert.deepStrictEqual(rooms, ['user:2'],
    'the fan-out addressed somebody the friends query did not return');
  assert.strictEqual(emitted[0].payload.note, 'out back',
    'the note travels in the socket payload, which is why that query has to filter blocks');
});

// ---------------------------------------------------------------------------
// 3. The shape guards, which exist because each one was once a 500
// ---------------------------------------------------------------------------

test('a one-element array for status is a 400, not a database error', async () => {
  const res = await call('POST', '/api/availability', { status: ['down'] });
  assert.strictEqual(res.status, 400, res.text);
});

test('an explicit null note clears it rather than being refused', async () => {
  const res = await call('POST', '/api/availability', { status: 'down', note: null });
  assert.strictEqual(res.status, 200, res.text);
});

test('a note past the limit is refused', async () => {
  const res = await call('POST', '/api/availability', { status: 'down', note: 'x'.repeat(81) });
  assert.strictEqual(res.status, 400, res.text);
});

// ---------------------------------------------------------------------------
// 4. Expiry is clamped, so a client cannot park a pulse in the calendar
// ---------------------------------------------------------------------------

test('a client cannot park a pulse past the 36 hour cap', async () => {
  const far = new Date(Date.now() + 90 * 60 * 60 * 1000).toISOString();
  await call('POST', '/api/availability', { status: 'maybe', expires_at: far });
  assert.ok(lastExpiry instanceof Date, 'no expiry was bound into the upsert');
  assert.ok(lastExpiry.getTime() <= Date.now() + 36 * 60 * 60 * 1000 + 5000,
    'a client parked a pulse further out than the cap the route documents');
});

test('an expiry in the past is pushed forward rather than stored already dead', async () => {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await call('POST', '/api/availability', { status: 'maybe', expires_at: past });
  assert.ok(lastExpiry.getTime() > Date.now(),
    'a pulse was stored already expired, so it is invisible the moment it is set');
});

test('no expiry at all still lands in the future', async () => {
  await call('POST', '/api/availability', { status: 'maybe' });
  assert.ok(lastExpiry.getTime() > Date.now(), 'the default expiry is not in the future');
});
