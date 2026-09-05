// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE TWO DOORS THAT WERE BUILT AND NEVER CONNECTED TO THE DOORBELL
// ---------------------------------------------------------------------------
//
// This file pins the WIRING of two notification paths, not the helpers behind
// them. Both helpers were already correct and already tested; both had a caller
// that skipped them, and a helper with a missing caller is a feature that does
// not exist.
//
// PART A. POST /api/flocks with `invited_user_ids`.
//   The Create Flock screen sends the friends you picked on the create request
//   itself, so for most plans this is the ONLY invite call that ever runs. It
//   emitted the `flock_invite_received` socket event and stopped there.
//   `pushIfOffline` only fires for someone with no live socket, which is
//   precisely the friend who is not looking at the app, so the people this
//   product exists to reach were the exact people it did not reach. The two
//   other invite doors (POST /:id/invite and POST /:id/rerun) have always
//   called pushInvitesToOffline. This one did not, and it is the busiest.
//
// PART B. POST /api/guest/:token/rsvp.
//   routes/flocks.js has a 60-second RSVP digest so a plan filling up is one
//   notification instead of nine, and the header on claimRsvpPush says it is
//   shared by two doors: accepting an invite and joining through a share link.
//   A GUEST answering the same share link is the same event to the host and
//   pushed straight past the window. That is the likeliest burst in the whole
//   product, because "no account needed" is what the link is FOR: several
//   people answer within a minute, every push carries the same collapse id, and
//   all but the last are destroyed on the lock screen after interrupting the
//   host once each.
//
// WHAT MAKES THESE REAL TESTS RATHER THAN SOURCE GREPS. Both drive the actual
// express routers over HTTP against a fixture-backed pool, with the REAL
// pushHelper, the REAL debounce and the REAL digest window. The only thing
// replaced below Firebase's front door is firebaseService.sendPushToUser, so a
// recorded push is one that survived the online check, the ban and block gate,
// the debounce and the digest. Both were written RED against the code as it
// stood: Part A recorded zero pushes, Part B recorded two.
//
// House rule inherited from the other fixture files: an unrecognised statement
// is RECORDED and reported, never answered with an empty result. A fake that
// answers everything with `{ rows: [] }` cannot tell a query on the right thing
// from a query on the wrong thing, and a push test whose debounce claim silently
// answers rowCount 0 reads as "another instance already sent it" and suppresses
// every push in the file for the wrong reason.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'rsvp-notification-doors-test-secret';

const pool = require('../config/database');

// ── Fixture plumbing ────────────────────────────────────────────────────────
let handlers = [];
let log = [];
let unknownSql = [];

function dispatch(sql, params) {
  // Matched against the COLLAPSED sql: these statements are written across
  // several lines in the routers, so a pattern spanning two of them would
  // otherwise depend on where the source happens to wrap.
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  unknownSql.push(flat);
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

function on(re, fn) { handlers.push([re, fn]); }
function ran(re) { return log.filter((q) => re.test(q.sql)); }

// The statements every push passes through on its way to Firebase. Modelled
// rather than left to the zero-rows default for the reason in the header.
function scriptPushMachinery() {
  on(/INSERT INTO push_debounce/, (params) => ({ rows: [{ debounce_key: params[0] }], rowCount: 1 }));
  on(/DELETE FROM push_debounce/, () => ({ rows: [], rowCount: 1 }));
  on(/INSERT INTO push_sends/, () => ({ rows: [], rowCount: 1 }));
  on(/INSERT INTO push_outbox/, () => ({ rows: [], rowCount: 1 }));
  on(/UPDATE device_tokens SET updated_at/, () => ({ rows: [], rowCount: 1 }));
  // No stored zone, so quiet hours never apply and the fan-out under test is
  // decided by the debounce and the digest alone.
  on(/SELECT timezone FROM device_tokens/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM user_settings/, () => ({ rows: [], rowCount: 0 }));
  // canNotify's single lookup: recipient ban state, actor ban state, visibility.
  on(/can_see/, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }], rowCount: 1 }));
  on(/SELECT 1 FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
}

// ── Firebase, replaced at its front door ────────────────────────────────────
const firebaseService = require('../services/firebaseService');
let SENT = [];
firebaseService.isEnabled = () => true;
firebaseService.sendPushToUser = async (userId, title, body, data) => {
  SENT.push({ userId, title, body, data });
  return { sent: 1, failed: 0 };
};

// ── Auth, replaced before the routers are required ──────────────────────────
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => {
  req.user = { id: 1, name: 'Ava', role: 'user', email_verified: true, is_banned: false };
  next();
};
authMod.requireVerified = (_req, _res, next) => { next(); };

const flocksRouter = require('../routes/flocks');
const guestRouter = require('../routes/guest');

// Nobody is connected, so every notification is a lock-screen push. That is
// the only case a digest or a debounce can be observed in at all.
let emits = [];
const io = {
  sockets: { adapter: { rooms: new Map() } },
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/flocks', flocksRouter);
app.use('/api/guest', guestRouter.router);

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
  unknownSql = [];
  SENT = [];
  emits = [];
  // Both the invite debounce and the RSVP digest windows are process-wide
  // in-memory state, so one test's suppression would otherwise decide the next
  // test's answer.
  flocksRouter.__resetBudgets();
  guestRouter.newGuestLog.clear();
  guestRouter.guestActionLog?.clear();
});

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

// The scan found what it expected to find, or its silence means nothing.
function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknownSql, [],
    `the fixture did not model these statements, so their empty answer decided the test:\n${unknownSql.join('\n')}`);
}

// ===========================================================================
// PART A. Creating a flock with friends on it has to reach those friends
// ===========================================================================

function scriptCreate({ realUsers = [2, 3, 4], blocked = [] } = {}) {
  on(/INSERT INTO flocks \(name, creator_id/, (params) => ({
    rows: [{ id: 77, name: params[0], creator_id: params[1], budget_enabled: false, budget_locked: false, budget_ceiling: null }],
    rowCount: 1,
  }));
  on(/INSERT INTO flock_members \(flock_id, user_id, status\) VALUES/, () => ({ rows: [], rowCount: 1 }));
  on(/SELECT id FROM users WHERE id = ANY/, (params) => ({
    rows: (params[0] || []).filter((id) => realUsers.includes(Number(id))).map((id) => ({ id: Number(id) })),
    rowCount: 0,
  }));
  on(/SELECT blocker_id, blocked_id FROM user_blocks/, () => ({
    rows: blocked.map((id) => ({ blocker_id: 1, blocked_id: id })),
    rowCount: blocked.length,
  }));
  on(/INSERT INTO flock_members \(flock_id, user_id, status\) SELECT/, (params) => ({
    rows: [], rowCount: (params[1] || []).length,
  }));
  scriptPushMachinery();
}

test('creating a flock with friends on it pushes to every friend who is not looking at the app', async () => {
  scriptCreate();
  const res = await call('POST', '/api/flocks', { name: 'Rooftop Friday', invited_user_ids: [2, 3, 4] });

  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(res.body.invited_user_ids.sort(), [2, 3, 4]);

  // The socket event was never the problem and must not regress either: it is
  // what reaches a friend who IS looking.
  const invited = emits.filter((e) => e.event === 'flock_invite_received');
  assert.deepStrictEqual(invited.map((e) => e.room).sort(), ['user:2', 'user:3', 'user:4']);

  assert.deepStrictEqual(SENT.map((s) => s.userId).sort(), [2, 3, 4],
    'the busiest invite door in the product notified nobody who was not already in the app');
  for (const s of SENT) {
    assert.strictEqual(s.data.type, 'flock_invite', 'the push has to deep-link like the other two invite doors');
    assert.strictEqual(s.data.flockId, '77');
    assert.strictEqual(s.title, 'Ava invited you to a flock');
    assert.strictEqual(s.body, 'Rooftop Friday');
  }
  assertQueriesUnderstood();
});

test('the create push follows the rows that were written, not the ids that were asked for', async () => {
  // 4 does not exist and 3 is on the other side of a block, so neither gets a
  // membership row. Pushing either would ring a stranger's phone and would also
  // answer "does user 4 exist?" for free by watching whose phone buzzed.
  scriptCreate({ realUsers: [2, 3], blocked: [3] });
  const res = await call('POST', '/api/flocks', { name: 'Small One', invited_user_ids: [2, 3, 4] });

  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(res.body.invited_user_ids, [2]);
  assert.deepStrictEqual(SENT.map((s) => s.userId), [2]);
  assertQueriesUnderstood();
});

test('a flock created with nobody on it sends no invite push at all', async () => {
  scriptCreate();
  const res = await call('POST', '/api/flocks', { name: 'Just Me' });

  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(SENT, [], 'an empty invite list must not reach Firebase');
  assertQueriesUnderstood();
});

// ===========================================================================
// PART B. Guests answering one share link share the host's RSVP digest
// ===========================================================================

const LINK_TOKEN = 'ABCDEFGHJKLM';

function scriptGuestRsvp() {
  on(/FROM flock_invite_links/, () => ({
    rows: [{ flock_id: 42, name: 'Dinner', event_time: null, venue_name: 'The Bar', status: 'planning', host_name: 'Ava' }],
    rowCount: 1,
  }));
  // A fresh identity every time: no guestToken is presented, so the route takes
  // the INSERT path, which is the one that pushes.
  on(/SELECT COUNT\(\*\)::int AS n FROM guest_rsvps/, () => ({ rows: [{ n: 0 }], rowCount: 1 }));
  on(/pg_advisory_xact_lock/, () => ({ rows: [], rowCount: 1 }));
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [], rowCount: 0 }));
  // The same-name guard asked inside the insert transaction (nameInUse): no
  // visible row answers under this name yet, so the insert proceeds.
  on(/COALESCE\(is_hidden, false\) = false\s+AND lower\(regexp_replace/, () => ({ rows: [], rowCount: 0 }));
  let nextGuestId = 100;
  on(/INSERT INTO guest_rsvps/, () => {
    nextGuestId += 1;
    return { rows: [{ id: nextGuestId, guest_token: `tok-${nextGuestId}`, is_hidden: false }], rowCount: 1 };
  });
  // announceGuestRsvp's counts and fan-out.
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 1 }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/,
    () => ({ rows: [{ user_id: 2 }, { user_id: 3 }], rowCount: 2 }));
  on(/SELECT creator_id, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 9, name: 'Dinner' }], rowCount: 1 }));
  on(/FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  scriptPushMachinery();
}

test('a second guest answering the same link inside the window does not buzz the host again', async () => {
  scriptGuestRsvp();

  const first = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Bo', status: 'in' });
  const second = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Cass', status: 'in' });
  const third = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Dev', status: 'in' });

  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 201);
  assert.strictEqual(third.status, 201);

  // Every one of them still reaches the members' screens live. A folded push is
  // a phone that does not buzz, never an RSVP that did not happen.
  assert.strictEqual(emits.filter((e) => e.event === 'guest_rsvp').length, 6,
    'three RSVPs to a two-member roster is six live events, digest or not');

  assert.strictEqual(SENT.length, 1,
    'three people answered one shared link and the host was interrupted three times');
  assert.strictEqual(SENT[0].userId, 9);
  assert.strictEqual(SENT[0].title, 'Bo is in!');
  assertQueriesUnderstood();
});

test('a guest RSVP and an invite acceptance share ONE window, because they are one event to the host', async () => {
  scriptGuestRsvp();
  // The member half of the same plan. flocks.js keys its window on the flock id
  // alone, so this has to land in the window the guest above opened.
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'invited' }], rowCount: 1 }));
  // The flock row lock the join takes before its UPDATE, the same one billing
  // reads the roster under. BEGIN and COMMIT pass through the client fake above.
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/UPDATE flock_members SET status = 'accepted'/, () => ({ rows: [{ flock_id: 42, user_id: 1, status: 'accepted' }], rowCount: 1 }));

  await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Bo', status: 'in' });
  const joined = await call('POST', '/api/flocks/42/join');

  assert.strictEqual(joined.status, 200);
  assert.strictEqual(SENT.length, 1,
    'a plan filling through both doors at once must cost the host one notification, not two');
  assertQueriesUnderstood();
});

test('a guest saying no never pushes, so a toggled answer cannot be used to ring the host', async () => {
  scriptGuestRsvp();
  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Bo', status: 'out' });

  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(SENT, []);
  // Still broadcast, because the host's count has to move either way.
  assert.strictEqual(emits.filter((e) => e.event === 'guest_rsvp').length, 2);
  assertQueriesUnderstood();
});
