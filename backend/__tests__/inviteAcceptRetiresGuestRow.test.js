// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// AN INVITE ACCEPTED IN THE APP RETIRES THE SAME PERSON'S GUEST ROW
// ---------------------------------------------------------------------------
//
// A plan has two doors. The share link lets somebody answer by name with no
// account (a guest_rsvps row), and the in-app invite makes them a member
// (POST /api/flocks/:id/join). The link's own join (POST /api/guest/:token/join)
// has retired the guest row it is handed since 2026-09-05. The in-app accept
// never did, so somebody who answered the link and then accepted the invite
// was on the plan twice for good: "going", momentum, the link's roster and both
// venue tallies counted one person as two.
//
// The app now sends the guest identities it holds (services/inviteHandoff.js
// storedGuestTokens) and the accept retires this plan's matching row in its
// own transaction, carries the row's vote across as one vote, and tells open
// clients the row is gone before it announces the join.
//
// Fixture-backed pool over the real router, the house style of the other join
// suites. An unrecognised statement is recorded, not silently answered.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'invite-accept-retires-guest-row-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// The accept route sits behind authenticate and requireVerified. The caller is
// a verified account; requireVerified runs for real against it.
const authMod = require('../middleware/auth');
const ME = { id: 7, name: 'Sam Rivera', email_verified: true, role: 'user', is_banned: false };
authMod.authenticate = (req, _res, next) => { req.user = ME; next(); };

let handlers = [];
let log = [];
let unknown = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  unknown.push(flat.slice(0, 160));
  return Promise.resolve({ rows: [], rowCount: 0 });
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), params: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });

const flocks = require('../routes/flocks');

let emits = [];
const io = {
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
  in() { return { socketsLeave() {}, disconnectSockets() {} }; },
  socketsLeave() {},
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/flocks', flocks);

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
  unknown = [];
  emits = [];
  flocks.__resetBudgets();
});

function on(re, fn) { handlers.push([re, fn]); }
function ran(re) { return log.filter((q) => re.test(q.sql)); }
const at = (re) => log.findIndex((q) => re.test(q.sql));

const FLOCK = 42;
const UUID = '11111111-2222-4333-8444-555555555555';

// An invite that is accepted: the membership row flips, the plan is open.
function scriptAccept({ memberStatus = 'invited', transitions = true } = {}) {
  on(/^SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2$/, () => ({ rows: [{ status: memberStatus }] }));
  on(/^SELECT status FROM flocks WHERE id = \$1$/, () => ({ rows: [{ status: 'planning' }] }));
  on(/^SELECT id FROM flocks WHERE id = \$1 FOR UPDATE$/, () => ({ rows: [{ id: FLOCK }] }));
  on(/pg_advisory_xact_lock/, () => ({ rows: [] }));
  on(/^UPDATE flock_members SET status = 'accepted'/, () => (transitions
    ? { rows: [{ flock_id: FLOCK, user_id: ME.id, status: 'accepted' }], rowCount: 1 }
    : { rows: [], rowCount: 0 }));
  on(/^SELECT \* FROM flock_members WHERE flock_id = \$1 AND user_id = \$2$/, () => ({ rows: [{ flock_id: FLOCK, user_id: ME.id, status: 'accepted' }] }));
  // Fan-out reads (emitToFlockMembers, emitToFlockExcludingBlocked, the vote
  // tally's roster and blocks) and the host lookup for the push.
  on(/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, () => ({ rows: [{ user_id: 9 }, { user_id: 11 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/^SELECT creator_id, name FROM flocks WHERE id = \$1$/, () => ({ rows: [{ creator_id: 9, name: 'Dinner' }] }));
}

function scriptRetire({ retired = [77], pick = null } = {}) {
  on(/^UPDATE guest_rsvps SET is_hidden = TRUE/, () => ({ rows: retired.map((id) => ({ id })), rowCount: retired.length }));
  on(/FROM guest_votes gv WHERE gv\.flock_id = \$1 AND gv\.guest_rsvp_id = ANY\(\$3::int\[\]\)/, () => ({ rows: pick ? [pick] : [] }));
  on(/INSERT INTO venue_votes/, () => ({ rows: [{ venue_name: pick && pick.venue_name }], rowCount: 1 }));
  on(/^DELETE FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2 AND venue_name <> \$3$/, () => ({ rows: [], rowCount: 0 }));
  on(/MIN\(venue_id\) FILTER/, () => ({ rows: [] }));
  on(/AS guest_count/, () => ({ rows: [] }));
}

async function accept(body) {
  const res = await fetch(`${base}/api/flocks/${FLOCK}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

test('the guest row this person answered the link under is retired in the accept\'s own transaction', async () => {
  scriptAccept();
  scriptRetire();

  const res = await accept({ guestTokens: [UUID] });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.member.status, 'accepted');

  const hide = ran(/^UPDATE guest_rsvps SET is_hidden = TRUE/);
  assert.strictEqual(hide.length, 1, 'the row is retired');
  assert.deepStrictEqual(hide[0].params, [String(FLOCK), [UUID], ME.id],
    'scoped to this plan, the UUIDs that prove the row is theirs, and the caller');
  assert.match(hide[0].sql, /COALESCE\(is_hidden, false\) = false/,
    'a row a moderator already hid is left exactly as they left it');
  assert.match(hide[0].sql, /EXISTS \(SELECT 1 FROM flock_members fm WHERE fm\.flock_id = \$1 AND fm\.user_id = \$3 AND fm\.status = 'accepted'\)/,
    'only for somebody who IS an accepted member once the accept lands, so a refused accept retires nothing');
  const begin = at(/^BEGIN/);
  const accepted = at(/^UPDATE flock_members SET status = 'accepted'/);
  const hideAt = at(/^UPDATE guest_rsvps SET is_hidden = TRUE/);
  const commit = at(/^COMMIT/);
  assert.ok(begin < accepted && accepted < hideAt && hideAt < commit,
    'after the membership lands and before the one COMMIT, so the count is never doubled or short');
  assert.deepStrictEqual(unknown, []);
});

test('open clients drop the guest entry before they hear about the join', async () => {
  scriptAccept();
  scriptRetire();

  await accept({ guestTokens: [UUID] });
  await settle();
  const removed = emits.findIndex((e) => e.event === 'content_removed');
  const joined = emits.findIndex((e) => e.event === 'flock_invite_responded');
  assert.ok(removed > -1, 'the takedown-shaped removal is sent');
  assert.deepStrictEqual(emits[removed].payload, { contentType: 'guest_rsvp', contentId: 77, flockId: FLOCK });
  assert.ok(joined > removed, 'and it lands first, so no count passes through the doubled state');
});

test('the retired row\'s vote comes across as one vote, under the vote routes\' lock', async () => {
  scriptAccept();
  scriptRetire({ pick: { venue_name: 'The Bar', newest: true } });

  const res = await accept({ guestTokens: [UUID] });
  assert.strictEqual(res.status, 200, res.text);
  const lock = at(/pg_advisory_xact_lock\(hashtext\('flockvote:' \|\| \$1::text \|\| ':' \|\| \$2::text\)\)/);
  const ins = at(/INSERT INTO venue_votes/);
  const del = at(/^DELETE FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2 AND venue_name <> \$3$/);
  const commit = at(/^COMMIT/);
  assert.ok(lock > -1 && lock < ins && ins < del && del < commit,
    'the flockvote: lock, the pick, the clearing of any other venue, all before the COMMIT');
  assert.deepStrictEqual(log[lock].params, [String(FLOCK), String(ME.id)]);
  await settle();
  assert.ok(emits.some((e) => e.event === 'new_vote' && Array.isArray(e.payload.votes)),
    'members re-tally, since the guest vote left the guest ledger');
});

test('an accept with nothing to carry costs nothing extra', async () => {
  scriptAccept();
  const res = await accept();
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(/guest_rsvps/).length, 0, 'no body, no guest statement');
  assert.strictEqual(emits.filter((e) => e.event === 'content_removed').length, 0);
});

test('a token that is not a UUID is dropped rather than refused, and cannot fail the accept', async () => {
  scriptAccept();
  scriptRetire();

  const res = await accept({ guestTokens: ['not-a-uuid; DROP TABLE guest_rsvps', 42, null, { a: 1 }], guestToken: 'nope' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(/^UPDATE guest_rsvps/).length, 0, 'nothing non-UUID reaches the database');
});

test('the carried list is deduplicated across spellings and capped', async () => {
  scriptAccept();
  scriptRetire({ retired: [] });

  const many = Array.from({ length: 30 }, (_, i) => `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`);
  const res = await accept({ guestTokens: [UUID, UUID.toUpperCase(), ...many] });
  assert.strictEqual(res.status, 200, res.text);
  const [hide] = ran(/^UPDATE guest_rsvps SET is_hidden = TRUE/);
  const sent = hide.params[1];
  assert.strictEqual(sent.length, 20, 'a device holds a handful; twenty is the ceiling');
  assert.strictEqual(sent.filter((t) => t === UUID).length, 1, 'two spellings of one uuid are one row');
});

test('a member who is already in and answers the link later still has the row retired', async () => {
  scriptAccept({ memberStatus: 'accepted', transitions: false });
  scriptRetire();

  const res = await accept({ guestToken: UUID });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(/^UPDATE guest_rsvps SET is_hidden = TRUE/).length, 1);
  await settle();
  assert.ok(emits.some((e) => e.event === 'content_removed'), 'the removal still reaches open clients');
  assert.strictEqual(emits.filter((e) => e.event === 'flock_invite_responded').length, 0,
    'but a repeat accept is still not announced as a join');
});
