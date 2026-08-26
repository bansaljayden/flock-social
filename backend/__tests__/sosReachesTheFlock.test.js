// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// AN SOS THAT TOLD NOBODY IN THE ROOM
// ---------------------------------------------------------------------------
// routes/safety.js emails TRUSTED CONTACTS, who are external people with no
// Flock account. That is correct for them, and it was the whole of what an SOS
// did. This route sent no push and emitted nothing over a socket, so the people
// standing in the same bar, on the plan you are both confirmed for, learned
// nothing. A trusted contact is often a parent in another city reading an
// email; the flock is who can walk across a room.
//
// pushHelper has reserved 'sos', 'emergency_alert' and 'safety_alert' in
// RINGS_THROUGH_THE_NIGHT since it was written, exempting them from quiet
// hours, for a producer that did not exist. This is that producer.
//
// WHAT THESE PIN, and each is a way the feature could be quietly wrong:
//   * it reaches the right people, and only them
//   * a block is honoured in both directions
//   * the sender is never notified about themselves
//   * location travels only when it was shared
//   * the leg cannot fail the SOS it rides on
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'sos-flock-test-secret';

const pool = require('../config/database');
const pushHelper = require('../services/pushHelper');

let queries = [];
let memberRows = [];
let pushes = [];
let emitted = [];

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: flat, params: params || [] });
  if (/FROM flock_members fm/.test(flat)) {
    return Promise.resolve({ rows: memberRows, rowCount: memberRows.length });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

pushHelper.pushAlways = async (userId, title, body, data) => {
  pushes.push({ userId, title, body, data });
  return { sent: true };
};

const safety = require('../routes/safety');
const { __test } = safety;

const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
const USER = { id: 1, name: 'Ava' };

function reset() { queries = []; memberRows = []; pushes = []; emitted = []; }

// The helper is not exported today, so these drive it the way the route does:
// through the module's test seam if there is one, else by asserting the route
// source. Prefer the seam; fall back loudly rather than silently passing.
const alertFlockMembers = __test && __test.alertFlockMembers;

test('the flock alert helper is reachable from a test at all', () => {
  assert.strictEqual(typeof alertFlockMembers, 'function',
    'routes/safety.js does not expose alertFlockMembers, so nothing below is exercising the real code');
});

test('every accepted member of a confirmed plan happening now is told', async (t) => {
  if (!alertFlockMembers) return t.skip('no seam');
  reset();
  memberRows = [{ user_id: 2 }, { user_id: 3 }];
  const out = await alertFlockMembers(io, USER, { latitude: 40.6, longitude: -75.4 });
  assert.strictEqual(out.notified, 2);
  assert.deepStrictEqual(pushes.map((p) => p.userId).sort(), [2, 3]);
  assert.deepStrictEqual(emitted.map((e) => e.room).sort(), ['user:2', 'user:3']);
  assert.strictEqual(emitted[0].event, 'safety_alert');
});

test('the query excludes the sender, blocks in both directions, and banned accounts', async (t) => {
  if (!alertFlockMembers) return t.skip('no seam');
  // A stub returns whatever rows it was going to return regardless of the WHERE
  // clause, so the predicates are asserted against the statement itself. This
  // is the same doctrine friendDiscoveryBans.test.js writes out.
  reset();
  memberRows = [{ user_id: 2 }];
  await alertFlockMembers(io, USER, null);
  const q = queries.find((x) => /FROM flock_members fm/.test(x.sql));
  assert.ok(q, 'the member lookup never ran');
  assert.match(q.sql, /fm\.user_id <> \$1/, 'the sender would be told about their own SOS');
  assert.match(q.sql, /b\.blocker_id = \$1 AND b\.blocked_id = fm\.user_id/, 'somebody the sender blocked is still told');
  assert.match(q.sql, /b\.blocker_id = fm\.user_id AND b\.blocked_id = \$1/, 'somebody who blocked the sender is still told');
  assert.match(q.sql, /is_banned/, 'a banned account is still told');
  assert.match(q.sql, /f\.status = 'confirmed'/, 'a plan nobody confirmed would notify people who are not out');
  assert.match(q.sql, /event_time BETWEEN/, 'every plan ever joined would fire, not tonight');
});

test('the push carries the actor, which is what makes pushHelper block-check it', async (t) => {
  if (!alertFlockMembers) return t.skip('no seam');
  // canNotify refuses a push whose actor is blocked and does not check a
  // payload with no actor at all. That is the exact defect the batched RSVP
  // notification shipped with.
  reset();
  memberRows = [{ user_id: 2 }];
  await alertFlockMembers(io, USER, null);
  assert.strictEqual(pushes[0].data.fromUserId, '1');
  assert.strictEqual(pushes[0].data.type, 'safety_alert',
    'the type is what exempts this from quiet hours in pushHelper');
});

test('location travels only when it was shared, and is absent rather than null', async (t) => {
  if (!alertFlockMembers) return t.skip('no seam');
  reset();
  memberRows = [{ user_id: 2 }];
  await alertFlockMembers(io, USER, { latitude: 40.6, longitude: -75.4 });
  assert.strictEqual(pushes[0].data.latitude, 40.6);
  assert.match(pushes[0].body, /shared their location/i);

  reset();
  memberRows = [{ user_id: 2 }];
  await alertFlockMembers(io, USER, null);
  assert.ok(!('latitude' in pushes[0].data),
    'a null coordinate in the payload is indistinguishable from one at the equator');
  assert.ok(!/shared their location/i.test(pushes[0].body));
});

test('nobody on a qualifying plan means no push and no throw', async (t) => {
  if (!alertFlockMembers) return t.skip('no seam');
  reset();
  memberRows = [];
  const out = await alertFlockMembers(io, USER, null);
  assert.strictEqual(out.notified, 0);
  assert.strictEqual(pushes.length, 0);
  assert.strictEqual(emitted.length, 0);
});

test('the route never lets this leg change the answer the sender already got', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'safety.js'), 'utf8');
  const at = src.indexOf('alertFlockMembers(req.app.get');
  assert.ok(at > -1, 'the route no longer calls the flock leg');
  const before = src.slice(0, at);
  assert.ok(before.lastIndexOf('res.json({') > before.lastIndexOf('await alertFlockMembers'),
    'the flock leg runs before the response, so a push failure could turn a delivered SOS into an error');
  const call = src.slice(at, at + 400);
  assert.match(call, /\.catch\(/, 'an unhandled rejection here would take the process down on Node 18+');
});
