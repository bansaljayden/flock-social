// Run: node --test  (from backend/)
//
// THE INVITE LINK'S JOIN PATH — POST /api/guest/:token/join, 2026-08-14.
//
// Jayden's report: "when I send an invite they don't get a direct link to being
// able to text in that flock". Before this route the invite page was a dead
// end. Someone could read the plan, RSVP to it and vote on it, and had no way
// at all to reach the conversation it was being made in; the only door into a
// flock was the host inviting an account that already existed, which is not
// something the person holding the link can do for themselves.
//
// This file pins the properties that make the new door safe to open:
//
//   1. IT IS A DOOR FOR ACCOUNTS, NOT FOR GUESTS. Authenticated, verified, not
//      banned, and there is still no unauthenticated write to chat anywhere on
//      this surface. That last one is a source scan, because it is the property
//      an Apple 1.2 review turns on and it must not be possible to add one by
//      accident.
//   2. NO NEW ORACLE. A dead, revoked or deleted-flock token answers the same
//      404 and the same sentence the three anonymous routes answer.
//   3. BOUNDED. A leaked link cannot pack a flock, and one account cannot spend
//      the route in a loop.
//   4. IDEMPOTENT. Someone already in the flock who taps their own link gets
//      sent to the chat, silently, writing nothing and announcing nothing.
//   5. THE ANNOUNCEMENT IS BLOCK-AWARE, and it is the same one an ordinary
//      invite acceptance produces, so a link joiner is not a second class of
//      member with a second code path.
//
// The payload/privacy half of the same feature (the roster) lives in
// guestInviteHardening.test.js, which owns the exact key set of the preview.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'invite-join-flow-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// ── Fixture plumbing (same shape as guestInviteHardening.test.js) ──────────
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, raw: String(sql), params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), raw: String(sql), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

const pushMod = require('../services/pushHelper');
let pushes = [];
pushMod.pushIfOffline = async (io, userId, title, body, data) => {
  pushes.push({ userId, title, body, data });
  return { skipped: true, reason: 'test' };
};
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });

const guest = require('../routes/guest');

let emits = [];
const io = {
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
  in() { return { disconnectSockets() {} }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/guest', guest.router);

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
  pushes = [];
  guest.newGuestLog.clear();
  guest.guestActionLog.clear();
  guest.joinLog.clear();
});

function on(re, fn) { handlers.push([re, fn]); }
function ran(re) { return log.filter((q) => re.test(q.sql)); }

const TOKEN = 'ABCDEFGHJKLM';

const link = (over = {}) => ({
  flock_id: 42, name: 'Dinner', event_time: '2026-09-01T01:00:00Z', venue_name: 'The Bar',
  status: 'planning', host_name: 'Ava Brooks', ...over,
});

// A signed-in caller. `tv` must match the row the auth middleware reads back or
// the token is rejected as revoked.
const VIEWER = {
  id: 7, email: 'sam@example.com', name: 'Sam Rivera', role: 'user',
  email_verified: true, is_banned: false, token_version: 0,
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id, tv: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

/** Answer the middleware's user lookup with this row. */
function scriptViewer(over = {}) {
  const user = { ...VIEWER, ...over };
  on(/SELECT id, email, name, role, email_verified, is_banned, token_version FROM users WHERE id = \$1/,
    () => ({ rows: [user] }));
  return user;
}

/** Everything the announcement half needs, so a successful join can complete. */
function scriptAnnounce() {
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/,
    () => ({ rows: [{ user_id: 9 }, { user_id: 11 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT creator_id, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 9, name: 'Dinner' }] }));
}

async function join(user, over = {}) {
  const res = await fetch(`${base}/api/guest/${over.token || TOKEN}/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const guestSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'guest.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');

// ===========================================================================
// PART 1 — the door is for accounts
// ===========================================================================

test('no session is a 401 and the database is never asked about the link', async () => {
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  const res = await join(null);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(ran(/FROM flock_invite_links/).length, 0,
    'an anonymous caller must not even learn whether the token resolves');
});

test('a banned account cannot join through a link', async () => {
  // A ban is the whole reason chat is account-only. If a banned user could walk
  // back in through an invite link, the moderation stack would be decorative.
  scriptViewer({ is_banned: true });
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  scriptAnnounce();

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /suspended/i);
  assert.strictEqual(ran(/INSERT INTO flock_members/).length, 0, 'nothing is written');
  assert.strictEqual(emits.length, 0, 'and no member screen hears about it');
});

test('an unverified account cannot join, and the refusal is written three times over', async () => {
  scriptViewer({ email_verified: false });
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.emailVerificationRequired, true);
  assert.strictEqual(ran(/INSERT INTO flock_members/).length, 0);

  // Layer 1: the route mounts requireVerified.
  assert.match(guestSrc, /router\.post\('\/:token\/join',\s*\n\s*authenticate,\s*\n\s*requireVerified,/,
    'the route opts in explicitly');
  // Layer 2: the middleware deny list, which survives the route being renamed.
  assert.match(authSrc, /\{ method: 'POST', pattern: \/\^\\\/api\\\/guest\\\/\[\^\/\]\+\\\/join\$\/ \}/,
    'the URL backstop lists the new join path');
  // Layer 3: the write itself, which survives both middlewares being dropped.
  // This is now the SECOND statement in the codebase that promotes anybody to
  // accepted flock membership, and it carries the same invariant as the first.
  assert.match(guestSrc, /INSERT INTO flock_members[\s\S]*?WHERE EXISTS \(SELECT 1 FROM users u WHERE u\.id = \$2::int AND u\.email_verified IS NOT FALSE\)/,
    'the promotion itself refuses an unverified account');
});

test('there is still no unauthenticated write to chat anywhere on this surface', () => {
  // The property an Apple 1.2 review turns on. Guest RSVP and guest vote are
  // inert rows; a message is user content on a public link with no age gate, no
  // account and no ban behind it. Nothing in this file may ever write one.
  assert.ok(!/INSERT INTO messages/i.test(guestSrc), 'guest.js must never insert a message');
  assert.ok(!/send_message|new_message/.test(guestSrc), 'and must never emit one');

  // Exactly one route here is authenticated, and it is the join.
  const authed = guestSrc.match(/^\s*authenticate,$/gm) || [];
  assert.strictEqual(authed.length, 1, 'exactly one authenticated route in the guest router');
});

// ===========================================================================
// PART 2 — no new oracle
// ===========================================================================

test('a dead, revoked or deleted-flock token is the same 404 a stranger gets', async () => {
  scriptViewer();
  // resolveLink answers nothing: unknown token, revoked link, and deleted flock
  // are indistinguishable to it by construction (the revoked filter and the
  // INNER JOIN are both in the one query).
  const res = await join(VIEWER);
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(res.body, { error: 'This invite link is no longer active' },
    'a signed-in caller learns no more about which tokens exist than an anonymous one');
  assert.strictEqual(ran(/INSERT INTO flock_members/).length, 0);
});

test('a malformed token is a 400 before the database hears about it', async () => {
  scriptViewer();
  for (const bad of ['abcdefg', 'A'.repeat(65)]) {
    log = [];
    const res = await join(VIEWER, { token: bad });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(ran(/FROM flock_invite_links/).length, 0);
  }
});

test('a cancelled or completed plan refuses the join with a 409', async () => {
  for (const status of ['cancelled', 'completed']) {
    handlers = []; log = []; emits = [];
    guest.joinLog.clear();
    scriptViewer();
    on(/FROM flock_invite_links/, () => ({ rows: [link({ status })] }));
    scriptAnnounce();

    const res = await join(VIEWER);
    assert.strictEqual(res.status, 409, `${status} must not accept new members`);
    assert.strictEqual(ran(/INSERT INTO flock_members/).length, 0);
  }
});

// ===========================================================================
// PART 3 — the happy path, and what it announces
// ===========================================================================

test('a stranger with the link becomes an accepted member and is told where to go', async () => {
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM flock_members/, () => ({ rows: [{ n: 4 }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 501 }], rowCount: 1 }));
  scriptAnnounce();

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { flockId: 42, flockName: 'Dinner', joined: true });

  const ins = ran(/INSERT INTO flock_members/)[0];
  assert.ok(ins, 'the membership is written');
  assert.deepStrictEqual(ins.params, [42, 7], 'parameterized, and scoped to this link and this caller');
  assert.match(ins.sql, /'accepted'/, 'accepted, because accepted is what buys the chat');

  // The cap check and the write are serialized, for the same reason the guest
  // INSERT is: read-then-write on a route several people hit at once.
  assert.ok(ran(/pg_advisory_xact_lock/).length > 0, 'the write is serialized per flock');
  assert.ok(log.some((q) => q.sql === 'BEGIN') && log.some((q) => q.sql === 'COMMIT'));
});

test('a blocked account cannot walk into the flock through the share link', async () => {
  // SECURITY ROUND 5, 2026-08-20. This route minted an accepted membership with
  // no block check at all. The header above it claimed otherwise ("blocks ...
  // the join fan-out below is block-aware"), and only the ANNOUNCEMENT was: the
  // membership landed either way.
  //
  // WHAT THAT BOUGHT, and why mutual invisibility made it worse rather than
  // better. A share link is a bearer credential that spreads by design, through
  // group chats and screenshots. B, blocked by A, gets the link to A's plan and
  // joins. B is now an accepted member of the flock A is going to: the venue,
  // the time, and the chat the rest of the group holds about the night. And
  // because every read in routes/flocks.js and every socket fan-out in
  // sockets/handlers.js filters the pair out of each other's view, A IS NEVER
  // SHOWN THAT B IS THERE. The block did not keep B away from A's evening; it
  // hid B from A while B walked into it.
  //
  // POST /api/flocks and POST /:id/invite have both skipped blocked pairs since
  // the block feature shipped. This is the third door and it was open.
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [] }));
  on(/JOIN user_blocks/, () => ({ rows: [{ '?column?': 1 }] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM flock_members/, () => ({ rows: [{ n: 4 }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 501 }], rowCount: 1 }));
  scriptAnnounce();

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 403);
  // THE REFUSAL NAMES NOBODY. Telling the joiner which member blocked them
  // would hand over the exact fact the block exists to withhold: that this
  // person is on this plan. One sentence, whoever is on the roster.
  assert.strictEqual(res.body.error, 'You cannot join this plan.');
  assert.ok(!/block/i.test(JSON.stringify(res.body)), 'the word does not appear either');

  assert.strictEqual(ran(/INSERT INTO flock_members/).length, 0, 'no membership is written');
  assert.strictEqual(ran(/pg_advisory_xact_lock/).length, 0,
    'a refusal never takes the per-flock lock');
  assert.strictEqual(emits.length, 0);
  assert.strictEqual(pushes.length, 0, 'and the host is not pushed a name they blocked');
});

test('the block gate is bidirectional and reads the whole accepted roster', async () => {
  // Bidirectional, matching utils/blocks.js: it does not matter which side
  // pressed the button, and the query has to say so. And it is asked about
  // every ACCEPTED member, not just the host: "who is at this plan" is what the
  // joiner learns and what the members are exposed to, so the host is one of
  // them rather than the only one that counts. One set-based query, not a call
  // per member.
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [] }));
  on(/JOIN user_blocks/, () => ({ rows: [] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM flock_members/, () => ({ rows: [{ n: 4 }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 501 }], rowCount: 1 }));
  scriptAnnounce();

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 200, 'a clean roster still joins');

  const q = ran(/JOIN user_blocks/)[0];
  assert.ok(q, 'the gate is asked at all');
  assert.match(q.sql, /b\.blocker_id = \$2 AND b\.blocked_id = fm\.user_id/);
  assert.match(q.sql, /b\.blocked_id = \$2 AND b\.blocker_id = fm\.user_id/);
  assert.match(q.sql, /fm\.status = 'accepted'/, 'the roster, not every invited row');
  assert.deepStrictEqual(q.params, [42, 7], 'parameterized on the resolved flock and the JWT caller');
  assert.strictEqual(ran(/JOIN user_blocks/).length, 1, 'asked once, not once per member');
});

test('an existing accepted member is not evicted by a block made after they joined', async () => {
  // Two people already in a flock who then block each other stay where they
  // were. That is the behaviour everywhere else, the flock's own reads already
  // keep them apart, and turning a re-tap of your own plan's link into a 403
  // would be a new eviction rule smuggled in through a share link. The gate is
  // about a NEW membership, so it must not even be asked here.
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/,
    () => ({ rows: [{ status: 'accepted' }] }));
  on(/JOIN user_blocks/, () => ({ rows: [{ '?column?': 1 }] }));
  scriptAnnounce();

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { flockId: 42, flockName: 'Dinner', joined: false });
  assert.strictEqual(ran(/JOIN user_blocks/).length, 0,
    'the already-in answer comes first and costs one indexed read');
});

test('the flock hears about it exactly the way it hears about an invite acceptance', async () => {
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM flock_members/, () => ({ rows: [{ n: 4 }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 501 }], rowCount: 1 }));
  scriptAnnounce();

  await join(VIEWER);
  // The response is sent before the fan-out; give the after-response work a tick.
  await new Promise((r) => setTimeout(r, 30));

  const responded = emits.filter((e) => e.event === 'flock_invite_responded');
  assert.ok(responded.length > 0, 'members are told somebody joined');
  for (const e of responded) {
    assert.match(e.room, /^user:/, 'per-member rooms, not the flock room a host is rarely sitting in');
    assert.strictEqual(e.payload.action, 'accepted');
    assert.strictEqual(e.payload.userId, 7);
    assert.ok(!('email' in e.payload), 'no email crosses to a member screen');
  }

  // The block check ran, so a joiner is never announced to somebody who
  // blocked them.
  assert.ok(ran(/FROM user_blocks/).length > 0, 'the fan-out is block-aware');

  // And an offline host gets the same push an invite acceptance sends.
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].userId, 9);
  assert.match(pushes[0].title, /Sam Rivera is going!/);
  assert.strictEqual(pushes[0].data.type, 'flock_rsvp');
});

test('an announcement failure never turns a committed join into a 500', async () => {
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM flock_members/, () => ({ rows: [{ n: 1 }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 501 }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, () => {
    throw new Error('socket fan-out exploded');
  });

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 200, 'the membership is committed; the broadcast is not the caller\'s problem');
  assert.strictEqual(res.body.joined, true);
});

// ===========================================================================
// PART 4 — arriving when you are already in
// ===========================================================================

test('someone already in the flock is sent to the chat, silently', async () => {
  // The host tapping their own share link, or anyone re-opening it later. This
  // must not be an error, must not re-announce, and must not write.
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/,
    () => ({ rows: [{ status: 'accepted' }] }));
  scriptAnnounce();

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { flockId: 42, flockName: 'Dinner', joined: false });
  assert.strictEqual(ran(/INSERT INTO flock_members/).length, 0, 'nothing is written');
  assert.strictEqual(emits.length, 0, 'nothing is announced twice');
  assert.strictEqual(pushes.length, 0, 'and the host is not notified again');
  assert.strictEqual(ran(/pg_advisory_xact_lock/).length, 0,
    'the common re-tap costs one indexed read, not a transaction');
});

test('an already-invited account joins without being counted as new weight', async () => {
  // The host invited them AND shared the link; they came in through the link.
  // The cap exists to stop a leaked link packing a flock, and a row the host
  // created is not a link walk-up, so it is not capped.
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/,
    () => ({ rows: [{ status: 'invited' }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 501 }], rowCount: 1 }));
  scriptAnnounce();

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.joined, true);
  assert.strictEqual(ran(/SELECT COUNT\(\*\)::int AS n FROM flock_members/).length, 0,
    'an invited account is not measured against the walk-up cap');
});

// ===========================================================================
// PART 5 — bounded
// ===========================================================================

test('a leaked link cannot pack a flock past the member cap', async () => {
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM flock_members/,
    () => ({ rows: [{ n: guest.LINK_JOIN_MEMBER_CAP }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [{ id: 501 }], rowCount: 1 }));
  scriptAnnounce();

  const res = await join(VIEWER);
  assert.strictEqual(res.status, 429);
  assert.match(res.body.error, /full/i);
  assert.strictEqual(ran(/INSERT INTO flock_members/).length, 0, 'the refused join writes nothing');
  assert.ok(log.some((q) => q.sql === 'ROLLBACK'), 'and the transaction is rolled back');
});

test('one account cannot spend the route in a loop', async () => {
  scriptViewer();
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  // Never a member, so every call does the full amount of work — which is
  // exactly the shape the budget exists to bound.
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM flock_members/, () => ({ rows: [{ n: 1 }] }));
  on(/INSERT INTO flock_members/, () => ({ rows: [], rowCount: 0 }));
  scriptAnnounce();

  const cap = guest.JOINS_PER_USER_PER_FLOCK;
  for (let i = 0; i < cap; i++) {
    const res = await join(VIEWER);
    assert.strictEqual(res.status, 200, `try ${i + 1} of ${cap}`);
  }
  const refused = await join(VIEWER);
  assert.strictEqual(refused.status, 429);
  assert.match(refused.body.error, /too many/i);
});

test('the budget is keyed per user AND per flock, so one abuser cannot lock others out', () => {
  // Keyed on two server-resolved integers: the id came off a verified JWT and
  // the flock id off the link lookup, so unlike the unauthenticated counters in
  // this file there is no caller-supplied spelling to re-case or invent.
  const log2 = guest.joinLog;
  log2.clear();
  assert.match(guestSrc, /joinCounter\.allow\(`\$\{req\.user\.id\}\|\$\{link\.flock_id\}`\)/,
    'the key is the pair, not the user alone');
});
