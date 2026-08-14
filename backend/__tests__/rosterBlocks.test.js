// Run: node --test  (from backend/)
//
// Round 18 — BLOCKS ON THE FLOCK DETAIL ROSTER, and the head count they must
// not move.
//
// GET /api/flocks/:id returns the roster a blocked person used to sit in, which
// is why frontend/src/App.js still keeps its own Set of blocked ids and re-runs
// it over `data.members` after every refetch. That is a filter at the wrong
// layer: it is one build behind the server, it is empty until the blocked-users
// call returns, and any other client has none of it at all.
//
// The server-side filter exists (routes/flocks.js, GET /:id and GET
// /:id/members). What was never pinned is the SHAPE of the decision, and that
// is the part a future edit will get wrong:
//
//   IDENTITY IS FILTERED. COUNTS ARE NOT.
//
// A blocked member's name, face and reliability score stop being served. The
// number of people going does not change, because a head count is a fact about
// the plan and not an identity. Move it into the roster SQL and the count
// silently decrements for the blocker alone: two people would read a different
// "4 going" for the same night, the momentum meter would disagree with itself,
// and the flock list's member_count (a plain COUNT, unfiltered) would contradict
// the detail screen on the same device.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'roster-blocks-test-secret';

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
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rows: [] });
    return dispatch(sql, params);
  },
  release: () => {},
});

// Replaced BEFORE the router is required — it destructures at module load.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'disabled' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'disabled' });

const flocksRouter = require('../routes/flocks');
const { getInvisibleUserIds } = require('../utils/blocks');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/flocks', flocksRouter);

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
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
});

function on(re, fn) { handlers.push([re, fn]); }

async function call(method, p) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' } });
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

const INVISIBLE_IDS = /blocked_id AS id FROM user_blocks/;

// Ava (the caller) has blocked Mallory. Ben is an ordinary flockmate; Cleo has
// an outstanding invite she has not answered.
const ROSTER = [
  { id: 1, name: 'Ava', profile_image_url: 'ava.jpg', reliability_score: 90, status: 'accepted', attendance: 'unmarked', joined_at: '2026-08-01' },
  { id: 2, name: 'Ben', profile_image_url: 'ben.jpg', reliability_score: 80, status: 'accepted', attendance: 'unmarked', joined_at: '2026-08-02' },
  { id: 3, name: 'Mallory', profile_image_url: 'mallory.jpg', reliability_score: 12, status: 'accepted', attendance: 'unmarked', joined_at: '2026-08-03' },
  { id: 4, name: 'Cleo', profile_image_url: 'cleo.jpg', reliability_score: 70, status: 'invited', attendance: 'unmarked', joined_at: '2026-08-04' },
];

const GUESTS = [
  { id: 12, name: 'Sam', status: 'in', created_at: '2026-08-05', updated_at: '2026-08-05' },
  { id: 13, name: 'Tam', status: 'out', created_at: '2026-08-05', updated_at: '2026-08-05' },
];

function scriptDetail({ invisible = [{ id: 3 }], creatorName = 'Ava' } = {}) {
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'accepted' }] }));
  on(/FROM flocks f/, () => ({ rows: [{
    id: 9, name: 'Dinner', status: 'planning', budget_enabled: false, budget_locked: false,
    event_time: null, venue_name: 'TBD', creator_id: 1, creator_name: creatorName,
  }] }));
  on(/u\.reliability_score/, () => ({ rows: ROSTER }));
  on(/FROM guest_rsvps/, () => ({ rows: GUESTS }));
  on(/FROM venue_votes/, () => ({ rows: [{ voters: '0' }] }));
  on(/FROM guest_votes/, () => ({ rows: [{ voters: '0' }] }));
  on(INVISIBLE_IDS, () => ({ rows: invisible }));
}

// ===========================================================================
// Identity is filtered
// ===========================================================================

test('the detail roster serves no part of a blocked member: not the name, not the face, not the score', async () => {
  scriptDetail();

  const res = await call('GET', '/api/flocks/9');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.members.map((m) => m.id), [1, 2, 4]);
  // The name is the obvious one. The avatar renders the same person's face and
  // the reliability score is a claim about them, so a filter that dropped only
  // the name would not be a filter.
  for (const leak of ['Mallory', 'mallory.jpg', '"reliability_score":12']) {
    assert.ok(!res.text.includes(leak), `blocked member leaked via ${leak}`);
  }
});

test('the block is mutual, so the person who blocked YOU disappears too', async () => {
  // Nothing in the route decides direction; utils/blocks.js resolves both, and
  // a one-directional rewrite of that UNION would silently reopen this.
  const src = getInvisibleUserIds.toString();
  assert.match(src, /blocked_id AS id FROM user_blocks WHERE blocker_id = \$1/);
  assert.match(src, /UNION/);
  assert.match(src, /blocker_id AS id FROM user_blocks WHERE blocked_id = \$1/);

  scriptDetail({ invisible: [{ id: 2 }] }); // Ben blocked Ava, not the reverse
  const res = await call('GET', '/api/flocks/9');
  assert.deepStrictEqual(res.body.members.map((m) => m.name), ['Ava', 'Mallory', 'Cleo']);
});

test('a blocked HOST is withheld by name in SQL and dropped from the roster in the same breath', async () => {
  // creator_name is decided in the query (it is free there, and the invite-card
  // branch returns before any roster work), the roster row after it. Both, or
  // the host is unnameable in the header and named three lines further down.
  scriptDetail({ invisible: [{ id: 3 }], creatorName: null });

  const res = await call('GET', '/api/flocks/9');

  assert.strictEqual(res.body.flock.creator_name, null);
  assert.match(sqlOf(/creator_name/).replace(/\s+/g, ' '), /NOT EXISTS|CASE WHEN EXISTS \( SELECT 1 FROM user_blocks b/);
  assert.ok(!res.text.includes('Mallory'));
});

test('guests are never touched by the block filter', async () => {
  // A guest has no account, so there is no block relationship to apply. They
  // are also not in `members`, so a filter that walked the wrong array would
  // drop a stranger's RSVP for no reason at all.
  scriptDetail();
  const res = await call('GET', '/api/flocks/9');
  assert.deepStrictEqual(res.body.guests.map((g) => g.name), ['Sam', 'Tam']);
  assert.deepStrictEqual(res.body.guests.map((g) => g.id), ['guest:12', 'guest:13']);
});

// ===========================================================================
// Counts are not
// ===========================================================================

test('every count on the detail payload still counts the blocked member', async () => {
  scriptDetail();

  const res = await call('GET', '/api/flocks/9');

  // 3 accepted members (Ava, Ben, Mallory) + 1 guest going.
  assert.strictEqual(res.body.flock.member_count, 3);
  assert.strictEqual(res.body.flock.guest_count, 1);
  assert.strictEqual(res.body.flock.going_count, 4);

  // The momentum meter is derived from the same roster and must be derived from
  // the whole of it: a score that moved when you blocked someone would be a
  // second, subtler leak — and a wrong reading of the plan.
  assert.strictEqual(res.body.momentum.accepted, 4);
  assert.strictEqual(res.body.momentum.totalMembers, 6, '4 members + 2 guests');
  assert.strictEqual(res.body.momentum.responded, 5, 'Cleo has not answered; Mallory has');
  assert.strictEqual(res.body.momentum.memberAccepted, 3);

  // Said plainly: fewer rows on screen than the number beside them.
  assert.strictEqual(res.body.members.length, 3);
  assert.ok(res.body.momentum.memberAccepted > res.body.members.filter((m) => m.status === 'accepted').length);
});

test('the roster query carries no block predicate — that is the decision, not an omission', async () => {
  scriptDetail();
  await call('GET', '/api/flocks/9');

  const roster = sqlOf(/u\.reliability_score/);
  assert.ok(!/user_blocks/.test(roster),
    'filtering here would decrement the counts derived from it, for the blocker only');
  // And the filtering that replaces it is real, server-side, and unconditional.
  assert.ok(log.some((q) => INVISIBLE_IDS.test(q.sql)), 'the roster is filtered against the block set on every read');
});

test('the members list answers with the same roster and the same head count', async () => {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] }));
  on(/SELECT u\.id, u\.name, u\.profile_image_url, fm\.status/, () => ({ rows: ROSTER }));
  on(/FROM guest_rsvps/, () => ({ rows: GUESTS }));
  on(INVISIBLE_IDS, () => ({ rows: [{ id: 3 }] }));

  const res = await call('GET', '/api/flocks/9/members');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.members.map((m) => m.id), [1, 2, 4]);
  assert.ok(!res.text.includes('Mallory'));
  assert.strictEqual(res.body.going_count, 4, 'the same 4 the detail route reports');
});

test('the flock list counts heads the same way, so the two screens cannot disagree', async () => {
  on(/FROM flocks f/, () => ({ rows: [{
    id: 9, name: 'Dinner', member_status: 'accepted', creator_name: 'Ava',
    member_count: '3', guest_count: 1, going_count: 4, member_previews: [],
  }] }));

  const res = await call('GET', '/api/flocks');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.flocks[0].going_count, 4);

  const sql = sqlOf(/member_previews/).replace(/\s+/g, ' ');
  // member_count / guest_count / going_count are plain COUNTs with no block
  // predicate; only member_previews, which carries names and faces, has one.
  assert.match(sql, /\(SELECT COUNT\(\*\) FROM flock_members WHERE flock_id = f\.id AND status = 'accepted'\) AS member_count/);
  const previews = sql.slice(sql.indexOf('AS member_previews') - 900, sql.indexOf('AS member_previews'));
  assert.match(previews, /NOT EXISTS \( SELECT 1 FROM user_blocks b/, 'the identity-bearing column is the one that is filtered');
});

test('an invitee gets counts and no names at all, blocked or otherwise', async () => {
  // The invite-card branch returns before any roster read, so it must not be
  // assumed to inherit the filter below it.
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'invited' }] }));
  on(/FROM flocks f/, () => ({ rows: [{ id: 9, name: 'Dinner', venue_name: 'TBD', event_time: null, creator_name: 'Ava' }] }));
  on(/::int AS n/, () => ({ rows: [{ n: 3, guests: 1 }] }));

  const res = await call('GET', '/api/flocks/9');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.invitePreview, true);
  assert.deepStrictEqual(res.body.members, []);
  assert.strictEqual(res.body.flock.going_count, 4, 'the same number an accepted member reads');
  assert.ok(!log.some((q) => /u\.reliability_score/.test(q.sql)), 'an invitee never triggers a roster read');
});
