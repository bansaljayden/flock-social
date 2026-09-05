// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// OBJECT-LEVEL AUTHORIZATION SWEEP OF routes/flocks.js
// ---------------------------------------------------------------------------
//
// flocks.js is the core CRUD surface of the product and it guards the most
// private thing in it: a group's plan, its roster, and the chat behind them.
// __tests__/objectAuthz.test.js already covers a handful of its routes from the
// attacker's side; this file covers ALL THIRTEEN of them, one endpoint at a
// time, against two threat models:
//
//   A. an authenticated user with NO relationship to flock F,
//   B. a plain accepted member reaching for a creator-only power.
//
// and against four states that are easy to get wrong: invited-but-not-accepted,
// declined, departed (row deleted), and creator.
//
// No database is involved. `pool.query` and `pool.connect` are replaced with a
// fixture-backed dispatcher over an in-memory world; an unrecognised statement
// is RECORDED (and reported by assertQueriesUnderstood) rather than silently
// answered with zero rows, which is how an authorization test passes for
// entirely the wrong reason.
//
// ---------------------------------------------------------------------------
// HOW MEMBERSHIP IS MINTED (there are four doors, and this file knows all four)
// ---------------------------------------------------------------------------
//   1. POST /api/flocks                      creator row, 'accepted'
//   2. POST /api/flocks (invited_user_ids)   'invited'
//   3. POST /api/flocks/:id/invite           'invited'
//   4. POST /api/guest/:token/join           'accepted' — routes/guest.js, the
//                                            authenticated link walk-up added
//                                            by inviteJoinFlow.test.js
// and exactly one promotion: POST /api/flocks/:id/join, invited|declined →
// accepted, for the CALLER ONLY. Door 4 lives in another file and is not
// re-tested here, but it is why "an accepted member did not have to be invited"
// is a legal state, and why nothing below assumes an accepted row implies a
// prior invite.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-flocks-authz-sweep';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Cast ────────────────────────────────────────────────────────────────────
// 1 Alice   — creator of flock 10, accepted
// 2 Bob     — accepted member of flock 10 (a PLAIN member: threat model B)
// 3 Carol   — invited to flock 10, has NOT accepted
// 4 Mallory — no relationship to flock 10 at all (threat model A)
// 5 Dave    — declined flock 10
// 6 Erin    — accepted, and removed part-way through some tests (departed)
const USERS = {
  1: { id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  2: { id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  3: { id: 3, email: 'carol@example.com', name: 'Carol', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  4: { id: 4, email: 'mallory@example.com', name: 'Mallory', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  5: { id: 5, email: 'dave@example.com', name: 'Dave', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  6: { id: 6, email: 'erin@example.com', name: 'Erin', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
};

// Every private field of flock 10 is spelled distinctly so a leak is greppable
// in an assertion failure rather than a plausible-looking null.
const FLOCK_10 = () => ({
  id: 10,
  name: 'Rooftop Friday',
  creator_id: 1,
  venue_name: 'The Fig',
  venue_address: '12 Private Street',
  venue_id: 'ChIJsecretplaceid00000',
  venue_latitude: 40.7128,
  venue_longitude: -73.9352,
  venue_rating: 4.6,
  venue_photo_url: null,
  event_time: '2026-08-20T23:00:00.000Z',
  status: 'planning',
  budget_enabled: true,
  budget_ceiling: '85.00',
  budget_locked: false,
  budget_context: 'keep it cheap, Dave is broke',
  ghost_mode_enabled: false,
  created_at: '2026-08-13T00:00:00.000Z',
  updated_at: '2026-08-13T00:00:00.000Z',
});

// A second flock Mallory owns, so "mark attendance for a member of a flock you
// DO run, naming a member of one you don't" has somewhere to be attempted from.
const FLOCK_20 = () => ({
  ...FLOCK_10(), id: 20, name: "Mallory's Thing", creator_id: 4,
  status: 'completed', budget_enabled: false, budget_ceiling: null,
  venue_name: 'Somewhere Else', venue_address: '99 Other Road',
  budget_context: null,
});

const MISSING_ID = 999999; // never issued

let flocks;    // Map<number, flockRow>
let members;   // Map<number, Array<{ user_id, status, attendance }>>
let links;     // [{ token, flock_id, revoked }]
let msgRows;   // [{ id, flock_id }]      — cascade witnesses
let voteRows;  // [{ id, flock_id }]      — cascade witnesses
let blocks;    // [[a, b]]
let writes;    // every mutating statement the routes issued
let queries;   // { sql, params } for every statement
let unknown;   // statements the fixture did not model
let vanishAfterOwnershipCheck; // see the flock-row lookup below

function reset() {
  vanishAfterOwnershipCheck = false;
  flocks = new Map([[10, FLOCK_10()], [20, FLOCK_20()]]);
  members = new Map([
    [10, [
      { user_id: 1, status: 'accepted', attendance: 'unmarked' },
      { user_id: 2, status: 'accepted', attendance: 'unmarked' },
      { user_id: 3, status: 'invited', attendance: 'unmarked' },
      { user_id: 5, status: 'declined', attendance: 'unmarked' },
      { user_id: 6, status: 'accepted', attendance: 'unmarked' },
    ]],
    [20, [{ user_id: 4, status: 'accepted', attendance: 'unmarked' }]],
  ]);
  links = [{ token: 'tok_flock10_original', flock_id: 10, revoked: false }];
  msgRows = [{ id: 100, flock_id: 10 }, { id: 101, flock_id: 20 }];
  voteRows = [{ id: 300, flock_id: 10 }];
  blocks = [];
  writes = [];
  queries = [];
  unknown = [];
  require('../routes/flocks').__resetBudgets();
}

const rowsOf = (flockId) => members.get(Number(flockId)) || [];
const memberOf = (flockId, userId) =>
  rowsOf(flockId).find((m) => m.user_id === Number(userId));
const acceptedCount = (flockId) =>
  rowsOf(flockId).filter((m) => m.status === 'accepted').length;

// ── The fixture-backed database ─────────────────────────────────────────────
const realQuery = pool.query;
const realConnect = pool.connect;

async function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });
  const has = (frag) => sql.includes(frag);
  if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params });
  if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/i.test(sql)) return { rows: [], rowCount: 0 };

  // ── middleware/auth.js ──
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
  }

  // ── utils/blocks.js ──
  if (has('SELECT blocked_id AS id FROM user_blocks')) {
    const me = Number(params[0]);
    const ids = blocks.filter(([a, b]) => a === me || b === me).map(([a, b]) => (a === me ? b : a));
    return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
  }
  if (has('SELECT blocker_id, blocked_id FROM user_blocks')) {
    const me = Number(params[0]);
    const rows = blocks.filter(([a, b]) => a === me || b === me)
      .map(([a, b]) => ({ blocker_id: a, blocked_id: b }));
    return { rows, rowCount: rows.length };
  }
  // Precise, NOT `has('SELECT 1 FROM user_blocks')`: the list and detail
  // queries carry their own inline `SELECT 1 FROM user_blocks b` subqueries, so
  // a loose match here swallowed the whole route and answered it zero rows.
  if (has('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) {
    return { rows: [], rowCount: 0 };
  }

  // ── services/pushHelper.js (post-response; modelled so nothing lands in
  //    `unknown` from a previous test's tail) ──
  if (has('AS can_see')) return { rows: [{ is_banned: false, actor_banned: false, can_see: true }], rowCount: 1 };
  if (has('SELECT settings FROM user_settings')) return { rows: [], rowCount: 0 };

  // ── GET /history ── (before the home-list matcher: this SQL contains the
  // same fm join fragment plus its own status predicate, and only this route
  // aliases venue_id AS venue_place_id)
  if (has('AS venue_place_id')) {
    const me = Number(params[0]);
    const rows = [];
    for (const [fid, f] of flocks) {
      const m = memberOf(fid, me);
      if (!m || m.status !== 'accepted') continue;
      if (f.status !== 'completed' && f.status !== 'cancelled') continue;
      rows.push({
        id: fid, name: f.name, status: f.status, event_time: f.event_time,
        venue_name: f.venue_name, venue_address: f.venue_address,
        venue_place_id: f.venue_id,
        members: rowsOf(fid).filter((x) => x.status === 'accepted')
          .map((x) => ({ id: x.user_id, name: USERS[x.user_id].name, profile_image_url: null })),
      });
    }
    return { rows, rowCount: rows.length };
  }

  // ── GET / (the home list) ──
  if (has('JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1')) {
    const me = Number(params[0]);
    const rows = [];
    for (const [fid, f] of flocks) {
      const m = memberOf(fid, me);
      if (!m) continue;
      rows.push({
        ...f,
        budget_ceiling: null, // < 3 submissions in this world
        creator_name: USERS[f.creator_id]?.name ?? null,
        member_status: m.status,
        member_count: String(acceptedCount(fid)),
        guest_count: 0,
        going_count: acceptedCount(fid),
        member_previews: rowsOf(fid).filter((x) => x.status === 'accepted').slice(0, 4)
          .map((x) => ({ id: x.user_id, name: USERS[x.user_id].name, profile_image_url: null, is_creator: x.user_id === f.creator_id })),
      });
    }
    return { rows, rowCount: rows.length };
  }

  // ── GET /activity ──
  if (has("SELECT 'created' AS action")) {
    const me = Number(params[0]);
    const rows = [];
    for (const [fid, f] of flocks) {
      const m = memberOf(fid, me);
      if (!m || m.status !== 'accepted') continue;
      rows.push({
        action: 'created', user_id: f.creator_id, user_name: USERS[f.creator_id].name,
        flock_name: f.name, flock_id: fid, happened_at: f.created_at,
      });
    }
    return { rows, rowCount: rows.length };
  }

  // ── flock row lookups (PUT, DELETE, leave, invite, attendance, join push) ──
  if (/^SELECT [\w, ]+ FROM flocks WHERE id = \$1$/.test(sql)) {
    const f = flocks.get(Number(params[0]));
    // "Revoked mid-request": the ownership check reads a row that is real at
    // the instant it is read and gone by the time the write lands. This is the
    // only way to produce that interleaving deterministically.
    if (f && vanishAfterOwnershipCheck) { flocks.delete(Number(params[0])); }
    return { rows: f ? [{ ...f }] : [], rowCount: f ? 1 : 0 };
  }
  if (has('FROM flocks f JOIN users u ON u.id = f.creator_id')) {
    const f = flocks.get(Number(params[0]));
    if (!f) return { rows: [], rowCount: 0 };
    return { rows: [{ ...f, budget_ceiling: null, creator_name: USERS[f.creator_id].name }], rowCount: 1 };
  }

  // ── membership lookups ──
  if (has('SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const m = memberOf(params[0], params[1]);
    return { rows: m ? [{ status: m.status }] : [], rowCount: m ? 1 : 0 };
  }
  if (has('SELECT 1 FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const m = memberOf(params[0], params[1]);
    return { rows: m ? [{ '?column?': 1 }] : [], rowCount: m ? 1 : 0 };
  }
  if (has("SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    const m = memberOf(params[0], params[1]);
    const ok = !!m && m.status === 'accepted';
    return { rows: ok ? [{ id: 1 }] : [], rowCount: ok ? 1 : 0 };
  }
  if (has('SELECT * FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const m = memberOf(params[0], params[1]);
    return { rows: m ? [{ flock_id: Number(params[0]), ...m }] : [], rowCount: m ? 1 : 0 };
  }
  if (has('SELECT user_id, status FROM flock_members WHERE flock_id = $1 AND user_id = ANY($2::int[])')) {
    const want = new Set((params[1] || []).map(Number));
    const rows = rowsOf(params[0]).filter((m) => want.has(m.user_id))
      .map((m) => ({ user_id: m.user_id, status: m.status }));
    return { rows, rowCount: rows.length };
  }
  if (has('AS total, COUNT(*)::int AS n FROM flock_members')) {
    const all = rowsOf(params[0]);
    return {
      rows: [{ total: all.length, n: all.filter((m) => m.status === 'invited' || m.status === 'accepted').length }],
      rowCount: 1,
    };
  }
  if (has("SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'")) {
    const me = params[1] === undefined ? null : Number(params[1]);
    const rows = rowsOf(params[0]).filter((m) => m.status === 'accepted' && m.user_id !== me)
      .map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
  }
  if (has("SELECT COUNT(*) AS cnt FROM flock_members WHERE flock_id = $1 AND status = 'accepted'")) {
    return { rows: [{ cnt: String(acceptedCount(params[0])) }], rowCount: 1 };
  }
  if (has('::int AS n, (SELECT COUNT(*) FROM guest_rsvps')) {
    return { rows: [{ n: acceptedCount(params[0]), guests: 0 }], rowCount: 1 };
  }

  // ── rosters: two different projections, same FROM clause ──
  if (has('FROM flock_members fm JOIN users u ON u.id = fm.user_id')) {
    const detail = has('reliability_score'); // GET /:id carries more than GET /:id/members
    const rows = rowsOf(params[0]).map((m) => ({
      id: m.user_id,
      name: USERS[m.user_id].name,
      profile_image_url: null,
      ...(detail ? { reliability_score: '91.00', attendance: m.attendance } : {}),
      status: m.status,
      joined_at: '2026-08-13T00:00:00.000Z',
    }));
    return { rows, rowCount: rows.length };
  }

  // ── guests / votes / budget ──
  if (has('FROM guest_rsvps')) return { rows: [], rowCount: 0 };
  if (has('FROM venue_votes WHERE flock_id = $1')) return { rows: [{ voters: 0 }], rowCount: 1 };
  if (has('FROM guest_votes gv')) return { rows: [{ voters: 0 }], rowCount: 1 };
  if (has('FROM budget_submissions')) {
    return { rows: [{ submissions: 0, n: 0, sub_count: 0, skip_count: 0 }], rowCount: 1 };
  }

  // ── users ──
  if (has('SELECT id FROM users WHERE id = ANY($1::int[])')) {
    const rows = (params[0] || []).map(Number).filter((id) => USERS[id]).map((id) => ({ id }));
    return { rows, rowCount: rows.length };
  }
  if (has('SELECT id, name FROM users WHERE id = ANY($1::int[])')) {
    const rows = (params[0] || []).map(Number).filter((id) => USERS[id])
      .map((id) => ({ id, name: USERS[id].name }));
    return { rows, rowCount: rows.length };
  }

  // ── invite links ──
  if (has('UPDATE flock_invite_links SET revoked = true')) {
    let n = 0;
    for (const l of links) if (l.flock_id === Number(params[0])) { l.revoked = true; n += 1; }
    return { rows: [], rowCount: n };
  }
  if (has('SELECT token FROM flock_invite_links')) {
    const l = links.find((x) => x.flock_id === Number(params[0]) && !x.revoked);
    return { rows: l ? [{ token: l.token }] : [], rowCount: l ? 1 : 0 };
  }
  if (has('INSERT INTO flock_invite_links')) {
    links.push({ token: params[0], flock_id: Number(params[1]), revoked: false });
    return { rows: [], rowCount: 1 };
  }

  // ── mutations on flocks ──
  if (has('INSERT INTO flocks')) {
    const id = 30 + flocks.size;
    const row = {
      ...FLOCK_10(), id, name: params[0], creator_id: Number(params[1]),
      venue_name: params[2], venue_address: params[3], venue_id: params[4],
      venue_latitude: params[5], venue_longitude: params[6], venue_rating: params[7],
      venue_photo_url: params[8], event_time: params[9],
      budget_enabled: params[10], budget_context: params[11], ghost_mode_enabled: params[12],
      status: 'planning', budget_ceiling: null, budget_locked: false,
    };
    flocks.set(id, row);
    members.set(id, []);
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (has('UPDATE flocks SET name = COALESCE($1, name)')) {
    const f = flocks.get(Number(params[10]));
    if (!f) return { rows: [], rowCount: 0 };
    const keys = ['name', 'venue_name', 'venue_address', 'venue_id', 'venue_latitude',
      'venue_longitude', 'venue_rating', 'venue_photo_url', 'event_time', 'status'];
    keys.forEach((k, i) => { if (params[i] !== null && params[i] !== undefined) f[k] = params[i]; });
    return { rows: [{ ...f }], rowCount: 1 };
  }
  // The flock row lock both delete paths take before the outstanding-bill
  // guard and the DELETE, so a concurrent /create cannot slip a bill between.
  if (has('FROM flocks WHERE id = $1 FOR UPDATE')) return { rows: [{ id: params[0] }], rowCount: 1 };
  if (has('DELETE FROM flocks WHERE id = $1')) {
    const id = Number(params[0]);
    const existed = flocks.delete(id);
    // The database's ON DELETE CASCADE, modelled. Asserted against the real
    // migrations by the schema test at the bottom of this file.
    members.delete(id);
    links = links.filter((l) => l.flock_id !== id);
    msgRows = msgRows.filter((m) => m.flock_id !== id);
    voteRows = voteRows.filter((v) => v.flock_id !== id);
    return { rows: [], rowCount: existed ? 1 : 0 };
  }

  // ── mutations on flock_members ──
  if (has("UPDATE flock_members SET status = 'accepted'")) {
    const m = memberOf(params[0], params[1]);
    const u = USERS[Number(params[1])];
    if (!m || m.status === 'accepted' || u?.email_verified === false) return { rows: [], rowCount: 0 };
    m.status = 'accepted';
    return { rows: [{ flock_id: Number(params[0]), ...m }], rowCount: 1 };
  }
  if (has("UPDATE flock_members SET status = 'declined'")) {
    const m = memberOf(params[0], params[1]);
    if (!m || m.status !== 'invited') return { rows: [], rowCount: 0 };
    m.status = 'declined';
    return { rows: [{ flock_id: Number(params[0]), ...m }], rowCount: 1 };
  }
  if (has("UPDATE flock_members SET status = 'invited'")) {
    let n = 0;
    for (const uid of params[1] || []) {
      const m = memberOf(params[0], uid);
      if (m && m.status === 'declined') { m.status = 'invited'; n += 1; }
    }
    return { rows: [], rowCount: n };
  }
  if (has('INSERT INTO flock_members')) {
    const fid = Number(params[0]);
    if (!members.has(fid)) members.set(fid, []);
    const list = members.get(fid);
    const status = /'accepted'/.test(sql) ? 'accepted' : 'invited';
    const ids = Array.isArray(params[1]) ? params[1] : [params[1]];
    for (const raw of ids) {
      const uid = Number(raw);
      if (list.some((m) => m.user_id === uid)) continue;
      list.push({ user_id: uid, status, attendance: 'unmarked' });
    }
    return { rows: [], rowCount: ids.length };
  }
  if (has('UPDATE flock_members SET attendance = t.mark')) {
    const [uids, marks, fid] = params;
    let n = 0;
    uids.forEach((uid, i) => {
      const m = memberOf(fid, uid);
      if (m && m.status === 'accepted') { m.attendance = marks[i]; n += 1; }
    });
    return { rows: [], rowCount: n };
  }
  if (has('DELETE FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const list = rowsOf(params[0]);
    const i = list.findIndex((m) => m.user_id === Number(params[1]));
    if (i >= 0) list.splice(i, 1);
    return { rows: [], rowCount: i >= 0 ? 1 : 0 };
  }

  // ── attendance tally + reliability write ──
  if (has('FROM UNNEST($1::int[]) AS t(uid)')) {
    const rows = (params[0] || []).map((uid) => ({ uid: Number(uid), joined: 1, attended: 1 }));
    return { rows, rowCount: rows.length };
  }
  if (has('UPDATE users SET reliability_score')) return { rows: [], rowCount: (params[0] || []).length };
  if (has('INSERT INTO research_analytics')) return { rows: [], rowCount: 1 };
  // Both delete paths now refuse while anyone still owes money on the plan:
  // bill_splits.flock_id and bill_split_shares.bill_id are ON DELETE CASCADE, so
  // the delete used to take the bill and every share row with it and there was
  // no way to get any of it back. This fixture has no bills, so nothing is owed.
  if (has('FROM bill_split_shares bss')) return { rows: [{ owed: false }] };

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
}

pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({
  query: (text, params) => dispatch(text, params),
  release: () => {},
});

// ── App under test ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/flocks', require('../routes/flocks'));

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => {
  pool.query = realQuery;
  pool.connect = realConnect;
  return pool.end().catch(() => {});
});
test.beforeEach(reset);

const WHO = { alice: 1, bob: 2, carol: 3, mallory: 4, dave: 5, erin: 6 };
function call(method, path, who, body) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${signUserToken(USERS[WHO[who]])}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');
}
const noWriteMatching = (frag) =>
  assert.ok(!writes.some((w) => w.sql.includes(frag)),
    `unexpected write matching ${frag}: ${JSON.stringify(writes.map((w) => w.sql))}`);

// Every private field of flock 10 that must never reach a non-accepted caller.
const PRIVATE_FLOCK_FIELDS = [
  'venue_address', 'venue_id', 'venue_latitude', 'venue_longitude', 'venue_rating',
  'budget_ceiling', 'budget_context', 'budget_enabled', 'budget_locked',
  'ghost_mode_enabled', 'creator_id', 'status', 'created_at', 'updated_at',
];

// ═══════════════════════════════════════════════════════════════════════════
// 1. GET /api/flocks — the home list
// ═══════════════════════════════════════════════════════════════════════════

test('list: an outsider sees none of a flock they are not in', async () => {
  const res = await call('GET', '/api/flocks', 'mallory');
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();
  const { flocks: got } = await res.json();
  assert.deepStrictEqual(got.map((f) => f.id), [20], 'the list is not scoped to the caller');
  assert.ok(!JSON.stringify(got).includes('12 Private Street'));
});

test('list: an invitee gets an invite card, never the flock body or the previews', async () => {
  const res = await call('GET', '/api/flocks', 'carol');
  const { flocks: got } = await res.json();
  assertQueriesUnderstood();
  const card = got.find((f) => f.id === 10);
  assert.strictEqual(card.invitePreview, true);
  assert.strictEqual(card.member_previews, undefined, 'invite card carried member faces');
  for (const field of PRIVATE_FLOCK_FIELDS) {
    assert.strictEqual(card[field], undefined, `invite card leaked ${field}`);
  }
  // The list card and the detail card are the SAME preview, and drift between
  // them is how one of the two quietly re-widens. Pinned to one key list.
  assert.deepStrictEqual(Object.keys(card).sort(), [...INVITE_CARD_KEYS, 'invitePreview'].sort());
});

test('list: a declined member is collapsed to the same card as an invitee', async () => {
  const res = await call('GET', '/api/flocks', 'dave');
  const card = (await res.json()).flocks.find((f) => f.id === 10);
  assert.strictEqual(card.invitePreview, true);
  assert.strictEqual(card.member_status, 'declined');
  for (const field of PRIVATE_FLOCK_FIELDS) assert.strictEqual(card[field], undefined);
});

test('list: a departed member stops seeing the flock on the very next request', async () => {
  const before = await (await call('GET', '/api/flocks', 'erin')).json();
  assert.ok(before.flocks.some((f) => f.id === 10));
  await call('POST', '/api/flocks/10/leave', 'erin');
  const after = await (await call('GET', '/api/flocks', 'erin')).json();
  assert.ok(!after.flocks.some((f) => f.id === 10), 'a departed member kept the flock on their list');
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. POST /api/flocks — create
// ═══════════════════════════════════════════════════════════════════════════

test('create: creator_id and status are server-set — the body cannot claim either', async () => {
  const res = await call('POST', '/api/flocks', 'mallory', {
    name: 'Mine', creator_id: 1, id: 10, status: 'confirmed',
    budget_ceiling: '1.00', budget_locked: true,
  });
  assert.strictEqual(res.status, 201);
  assertQueriesUnderstood();
  const { flock } = await res.json();
  assert.strictEqual(flock.creator_id, 4, 'creator_id was taken from the body');
  assert.notStrictEqual(flock.id, 10);
  assert.strictEqual(flock.status, 'planning');
  assert.strictEqual(flock.budget_locked, false);
  // And flock 10 was not touched by the smuggled id.
  assert.strictEqual(flocks.get(10).name, 'Rooftop Friday');
});

// Creating a flock is the one place a caller names OTHER people's ids, so it is
// the one place "invite" could quietly become "conscript". It cannot: the only
// 'accepted' row this route writes is the creator's own.
test('create: invited_user_ids buys an invite, never a membership', async () => {
  const res = await call('POST', '/api/flocks', 'mallory', {
    name: 'Roundup', invited_user_ids: [1, 2, 3, 4],
  });
  assert.strictEqual(res.status, 201);
  const { flock, invited_user_ids: got } = await res.json();
  assert.ok(!got.includes(4), 'the creator was invited to their own flock');

  const roster = rowsOf(flock.id);
  assert.deepStrictEqual(roster.filter((m) => m.status === 'accepted').map((m) => m.user_id), [4],
    'create minted an accepted membership for somebody who never answered');
  for (const m of roster) {
    if (m.user_id !== 4) assert.strictEqual(m.status, 'invited', `user ${m.user_id} was force-added`);
  }
  // And the people named cannot be read out of the flock they were named into
  // until they accept it themselves.
  assert.strictEqual((await call('GET', `/api/flocks/${flock.id}/members`, 'alice')).status, 404);
  assertQueriesUnderstood();
});

test('create: ghost mode cannot be switched on without a budget', async () => {
  const res = await call('POST', '/api/flocks', 'mallory', { name: 'Quiet', ghost_mode_enabled: true });
  const { flock } = await res.json();
  assert.strictEqual(flock.ghost_mode_enabled, false);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. GET /api/flocks/activity
// ═══════════════════════════════════════════════════════════════════════════

test('activity: an invitee and a declined member get nothing from a flock they never joined', async () => {
  for (const who of ['carol', 'dave', 'mallory']) {
    const res = await call('GET', '/api/flocks/activity', who);
    assert.strictEqual(res.status, 200);
    const { activity } = await res.json();
    assert.ok(!activity.some((a) => a.flock_id === 10), `${who} read flock 10's activity`);
  }
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. GET /api/flocks/:id — detail
// ═══════════════════════════════════════════════════════════════════════════

test('detail: an outsider gets the same 404 as a flock id that was never issued', async () => {
  const real = await call('GET', '/api/flocks/10', 'mallory');
  const fake = await call('GET', `/api/flocks/${MISSING_ID}`, 'mallory');
  assert.strictEqual(real.status, 404);
  assert.strictEqual(fake.status, 404);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assertQueriesUnderstood();
});

test('detail: an accepted member gets the plan; nothing about the gate overshot', async () => {
  const res = await call('GET', '/api/flocks/10', 'bob');
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();
  const body = await res.json();
  assert.strictEqual(body.invitePreview, undefined);
  assert.strictEqual(body.flock.venue_address, '12 Private Street');
  assert.strictEqual(body.members.length, 5);
  assert.ok(body.momentum);
});

// ── THE INVITED STATE, PINNED ───────────────────────────────────────────────
// DECISION: the invite card is a DELIBERATE preview, not a leak. An invitation
// you cannot evaluate is an invitation you cannot answer, so name / venue name /
// time / host name / head counts are exactly what an invitee is entitled to —
// and the code says so in as many words ("Invited/declined users get a minimal
// invite card, not the full flock", audit 2026-08-12). What that decision must
// NOT be allowed to do is drift: this test freezes the field list in both
// directions, so adding `f.*` back, or a roster, or a coordinate, is a red test
// rather than a quiet re-widening.
const INVITE_CARD_KEYS = [
  'id', 'name', 'venue_name', 'event_time', 'creator_name',
  'member_count', 'guest_count', 'going_count', 'member_status',
  // A derived boolean, not the status itself: an invite to a finished plan
  // used to sit in Pending Invites until declined (2026-09-04).
  'finished',
];

test('detail: the invite card is exactly the agreed preview, no more and no less', async () => {
  const res = await call('GET', '/api/flocks/10', 'carol');
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();
  const body = await res.json();

  assert.strictEqual(body.invitePreview, true);
  assert.deepStrictEqual(Object.keys(body.flock).sort(), [...INVITE_CARD_KEYS].sort(),
    'the invite card changed shape');
  assert.deepStrictEqual(body.members, [], 'the invite card carried a roster');
  assert.deepStrictEqual(body.guests, []);
  assert.strictEqual(body.momentum, undefined);
  for (const field of PRIVATE_FLOCK_FIELDS) {
    assert.strictEqual(body.flock[field], undefined, `invite card leaked ${field}`);
  }
  // The one field an invitee IS entitled to, so a future "fix" cannot empty the
  // card out and call it hardened.
  assert.strictEqual(body.flock.name, 'Rooftop Friday');
  assert.strictEqual(body.flock.venue_name, 'The Fig');
});

test('detail: a declined member keeps the card (they can still change their mind) and nothing else', async () => {
  const body = await (await call('GET', '/api/flocks/10', 'dave')).json();
  assert.strictEqual(body.invitePreview, true);
  assert.strictEqual(body.flock.member_status, 'declined');
  assert.deepStrictEqual(Object.keys(body.flock).sort(), [...INVITE_CARD_KEYS].sort());
});

test('detail: a departed member is an outsider immediately, not at the next login', async () => {
  assert.strictEqual((await call('GET', '/api/flocks/10', 'erin')).status, 200);
  await call('POST', '/api/flocks/10/leave', 'erin');
  const after = await call('GET', '/api/flocks/10', 'erin');
  assert.strictEqual(after.status, 404, 'a stale membership row kept serving reads');
  assert.deepStrictEqual(await after.json(),
    await (await call('GET', `/api/flocks/${MISSING_ID}`, 'erin')).json());
  assertQueriesUnderstood();
});

test('detail: a flock id is settled as a bounded integer before any query runs', async () => {
  for (const bad of ['abc', '0', '-1', '9999999999', '1.5', '1%20OR%201=1', 'null']) {
    const res = await call('GET', `/api/flocks/${bad}`, 'mallory');
    assert.strictEqual(res.status, 400, `id "${bad}" was not rejected`);
  }
  assert.deepStrictEqual(queries.filter((q) => q.sql.includes('flock_members')), [],
    'a malformed id reached a query');
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. PUT /api/flocks/:id — update (creator only)
// ═══════════════════════════════════════════════════════════════════════════

test('update: an outsider is refused without learning the flock exists', async () => {
  const real = await call('PUT', '/api/flocks/10', 'mallory', { name: 'pwned' });
  const fake = await call('PUT', `/api/flocks/${MISSING_ID}`, 'mallory', { name: 'pwned' });
  assert.strictEqual(real.status, 404);
  assert.strictEqual(fake.status, 404);
  assert.deepStrictEqual(await real.json(), await fake.json());
  noWriteMatching('UPDATE flocks');
  assert.strictEqual(flocks.get(10).name, 'Rooftop Friday');
  assertQueriesUnderstood();
});

test('update: a plain accepted member gets 403 and changes nothing', async () => {
  const res = await call('PUT', '/api/flocks/10', 'bob', { name: 'Bob was here', status: 'cancelled' });
  assert.strictEqual(res.status, 403);
  noWriteMatching('UPDATE flocks');
  assert.strictEqual(flocks.get(10).name, 'Rooftop Friday');
  assert.strictEqual(flocks.get(10).status, 'planning');
  assertQueriesUnderstood();
});

test('update: an invitee gets 403 (they already know it exists), an outsider still gets 404', async () => {
  const invitee = await call('PUT', '/api/flocks/10', 'carol', { name: 'x' });
  assert.strictEqual(invitee.status, 403);
  const outsider = await call('PUT', '/api/flocks/10', 'mallory', { name: 'x' });
  assert.strictEqual(outsider.status, 404);
  noWriteMatching('UPDATE flocks');
  assertQueriesUnderstood();
});

// ── VENUE SELECTION ─────────────────────────────────────────────────────────
// The app's own rule, stated in sockets/handlers.js `select_venue`: "Only the
// flock creator can confirm a venue". PUT /:id writes the same four columns, so
// it has to answer the same way or the socket rule is decoration.
test('update: venue selection is creator-only on REST, exactly as it is on the socket', async () => {
  const member = await call('PUT', '/api/flocks/10', 'bob', {
    venue_name: 'Bob\'s Bar', venue_address: '1 Elsewhere', venue_id: 'ChIJbobsbar0000000000', status: 'confirmed',
  });
  assert.strictEqual(member.status, 403);
  assert.strictEqual(flocks.get(10).venue_name, 'The Fig');

  const creator = await call('PUT', '/api/flocks/10', 'alice', { venue_name: 'The Other Fig' });
  assert.strictEqual(creator.status, 200);
  assert.strictEqual(flocks.get(10).venue_name, 'The Other Fig');
  assertQueriesUnderstood();
});

// ── MASS ASSIGNMENT ─────────────────────────────────────────────────────────
// One field at a time, then all together. The UPDATE has a fixed SET list, so
// the answer is "nothing outside that list is writable" — this is what pins it.
const UNWRITABLE = {
  creator_id: 4,
  id: 20,
  budget_enabled: false,
  budget_ceiling: '1.00',
  budget_locked: true,
  budget_context: 'rewritten',
  ghost_mode_enabled: true,
  created_at: '2000-01-01T00:00:00.000Z',
  reliability_score: 100,
};

test('update: no body field outside the route\'s own SET list is writable, one at a time', async () => {
  for (const [field, value] of Object.entries(UNWRITABLE)) {
    reset();
    const res = await call('PUT', '/api/flocks/10', 'alice', { [field]: value });
    assert.ok(res.status === 200 || res.status === 400, `${field} produced ${res.status}`);
    const f = flocks.get(10);
    assert.notDeepStrictEqual(f[field], value, `mass assignment wrote ${field}`);
    // Only the SET clause, not the trailing `WHERE id = $11` (and not
    // `venue_id = ...`, which contains "id =" as a substring).
    const stmt = writes.find((w) => w.sql.startsWith('UPDATE flocks'));
    if (stmt) {
      const setClause = stmt.sql.slice(stmt.sql.indexOf(' SET ') + 5, stmt.sql.indexOf(' WHERE '));
      const assigned = setClause.split(',').map((s) => s.trim().split('=')[0].trim());
      assert.ok(!assigned.includes(field), `${field} appeared in the SET list`);
    }
  }
  assertQueriesUnderstood();
});

test('update: and all of them at once, in one body, still write nothing', async () => {
  const res = await call('PUT', '/api/flocks/10', 'alice', { ...UNWRITABLE, name: 'Renamed' });
  assert.strictEqual(res.status, 200);
  const f = flocks.get(10);
  assert.strictEqual(f.name, 'Renamed', 'the legitimate field did not land');
  assert.strictEqual(f.creator_id, 1);
  assert.strictEqual(f.budget_enabled, true);
  assert.strictEqual(f.budget_locked, false);
  assert.strictEqual(f.budget_context, 'keep it cheap, Dave is broke');
  assert.strictEqual(f.ghost_mode_enabled, false);
  assert.strictEqual(flocks.get(20).creator_id, 4, 'a smuggled id moved the write to another flock');
  assertQueriesUnderstood();
});

test('update: a completed flock is still only the creator\'s to re-time', async () => {
  flocks.get(10).status = 'completed';
  const member = await call('PUT', '/api/flocks/10', 'bob', { event_time: '2030-01-01T00:00:00.000Z' });
  assert.strictEqual(member.status, 403);
  assert.strictEqual(flocks.get(10).event_time, '2026-08-20T23:00:00.000Z');
  const outsider = await call('PUT', '/api/flocks/10', 'mallory', { event_time: '2030-01-01T00:00:00.000Z' });
  assert.strictEqual(outsider.status, 404);
  assert.strictEqual(flocks.get(10).event_time, '2026-08-20T23:00:00.000Z');
  assertQueriesUnderstood();
});

test('update: status is a closed vocabulary, and a coerced non-scalar is a 400 not a 500', async () => {
  for (const status of ['deleted', 'admin', ['planning'], { s: 'planning' }, 1]) {
    const res = await call('PUT', '/api/flocks/10', 'alice', { status });
    assert.strictEqual(res.status, 400, `status ${JSON.stringify(status)} was accepted`);
  }
  assert.strictEqual(flocks.get(10).status, 'planning');
  assertQueriesUnderstood();
});

// FINDING (round 1). The ownership read and the write were two statements with
// nothing tying them together: the creator check passed on a row that was gone
// by the time the UPDATE ran, `result.rows[0]` came back undefined, and the
// route carried on. Without an `io` attached that answered 200 with
// `{ flock: {} }` — a success for a write that did not happen. With one (i.e.
// in production) `updated.name` on the fan-out payload threw a TypeError into
// the outer catch and it was a 500. Same shape as a co-creator deleting the
// flock, or an admin takedown, landing between the two queries.
test('update: a flock that vanishes between the ownership check and the write is a 404', async () => {
  vanishAfterOwnershipCheck = true;
  const res = await call('PUT', '/api/flocks/10', 'alice', { name: 'Ghost' });
  assert.strictEqual(res.status, 404, 'a write that matched no row was reported as success');
  assert.deepStrictEqual(await res.json(), { error: 'Flock not found' });
  assertQueriesUnderstood();
});

test('delete: a flock that vanishes between the ownership check and the write is a 404', async () => {
  vanishAfterOwnershipCheck = true;
  const res = await call('DELETE', '/api/flocks/10', 'alice');
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { error: 'Flock not found' });
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. DELETE /api/flocks/:id — delete (creator only) + cascade
// ═══════════════════════════════════════════════════════════════════════════

test('delete: an outsider is refused without learning the flock exists', async () => {
  const real = await call('DELETE', '/api/flocks/10', 'mallory');
  const fake = await call('DELETE', `/api/flocks/${MISSING_ID}`, 'mallory');
  assert.strictEqual(real.status, 404);
  assert.strictEqual(fake.status, 404);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assert.ok(flocks.has(10));
  noWriteMatching('DELETE FROM flocks');
  assertQueriesUnderstood();
});

test('delete: a plain accepted member gets 403 and the flock survives', async () => {
  const res = await call('DELETE', '/api/flocks/10', 'bob');
  assert.strictEqual(res.status, 403);
  assert.ok(flocks.has(10));
  noWriteMatching('DELETE FROM flocks');
  assertQueriesUnderstood();
});

test('delete: the creator deletes, and members, messages, votes and invite links go with it', async () => {
  const res = await call('DELETE', '/api/flocks/10', 'alice');
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  assert.ok(!flocks.has(10));
  assert.deepStrictEqual(rowsOf(10), [], 'memberships survived the flock');
  assert.deepStrictEqual(links.filter((l) => l.flock_id === 10), [], 'invite links survived the flock');
  assert.deepStrictEqual(msgRows.filter((m) => m.flock_id === 10), [], 'messages survived the flock');
  assert.deepStrictEqual(voteRows.filter((v) => v.flock_id === 10), [], 'votes survived the flock');

  // The route leans on ON DELETE CASCADE deliberately: one statement, no
  // hand-rolled per-table sweep that a new table could be forgotten from.
  const deletes = writes.filter((w) => w.sql.startsWith('DELETE'));
  assert.strictEqual(deletes.length, 1, `expected one DELETE, saw ${JSON.stringify(deletes.map((d) => d.sql))}`);
  assert.match(deletes[0].sql, /^DELETE FROM flocks WHERE id = \$1$/);

  // And a departed-by-deletion member reads nothing afterwards.
  const after = await call('GET', '/api/flocks/10', 'bob');
  assert.strictEqual(after.status, 404);
});

test('delete: the cascade the route relies on is actually declared in the migrations', async () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    .replace(/\s+/g, ' ');
  for (const table of ['flock_members', 'messages', 'venue_votes', 'flock_invite_links', 'guest_rsvps']) {
    const at = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    assert.ok(at >= 0, `${table} is not created by any migration`);
    const body = sql.slice(at, at + 900);
    assert.match(body, /flock_id INTEGER( NOT NULL)? REFERENCES flocks\(id\) ON DELETE CASCADE/,
      `${table}.flock_id is not ON DELETE CASCADE — DELETE /api/flocks/:id would orphan or 500`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. POST /api/flocks/:id/invite-link
// ═══════════════════════════════════════════════════════════════════════════

test('invite-link: only an ACCEPTED member can mint or revoke one', async () => {
  for (const who of ['mallory', 'carol', 'dave']) {
    const res = await call('POST', '/api/flocks/10/invite-link', who, { regenerate: true });
    assert.strictEqual(res.status, 403, `${who} reached the invite link`);
    assert.strictEqual((await res.json()).token, undefined);
  }
  noWriteMatching('flock_invite_links');
  assert.strictEqual(links[0].revoked, false, 'a non-member revoked the host\'s link');
  assertQueriesUnderstood();
});

test('invite-link: the refusal is the same whether or not the flock exists', async () => {
  const real = await call('POST', '/api/flocks/10/invite-link', 'mallory');
  const fake = await call('POST', `/api/flocks/${MISSING_ID}/invite-link`, 'mallory');
  assert.strictEqual(real.status, fake.status);
  assert.deepStrictEqual(await real.json(), await fake.json());
  // 403 rather than 404 here is safe precisely BECAUSE it never consults
  // `flocks`: the answer is identical for a real id and a fabricated one, so it
  // is not an existence oracle the way a 403/404 split would be.
  assert.strictEqual(real.status, 403);
  assert.deepStrictEqual(queries.filter((q) => /FROM flocks\b/.test(q.sql)), []);
  assertQueriesUnderstood();
});

test('invite-link: a member can still share, and a departed one cannot', async () => {
  const ok = await call('POST', '/api/flocks/10/invite-link', 'erin');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).token, 'tok_flock10_original');

  await call('POST', '/api/flocks/10/leave', 'erin');
  const after = await call('POST', '/api/flocks/10/invite-link', 'erin');
  assert.strictEqual(after.status, 403);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. POST /api/flocks/:id/join — RSVP yes (self only)
// ═══════════════════════════════════════════════════════════════════════════

test('join: an uninvited user cannot add themselves, and learns nothing by trying', async () => {
  const real = await call('POST', '/api/flocks/10/join', 'mallory');
  const fake = await call('POST', `/api/flocks/${MISSING_ID}/join`, 'mallory');
  assert.strictEqual(real.status, 404);
  assert.strictEqual(fake.status, 404);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assert.strictEqual(memberOf(10, 4), undefined);
  noWriteMatching('flock_members');
  assertQueriesUnderstood();
});

test('join: RSVP is for the caller alone — a user id in the body is ignored', async () => {
  const res = await call('POST', '/api/flocks/10/join', 'carol', { user_id: 4, userId: 4, member_id: 4 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(memberOf(10, 3).status, 'accepted', 'the caller did not RSVP');
  assert.strictEqual(memberOf(10, 4), undefined, 'the body RSVPd somebody else');
  assertQueriesUnderstood();
});

test('join: a departed member cannot walk back in through the join route', async () => {
  await call('POST', '/api/flocks/10/leave', 'erin');
  const res = await call('POST', '/api/flocks/10/join', 'erin');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(memberOf(10, 6), undefined);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. POST /api/flocks/:id/invite
// ═══════════════════════════════════════════════════════════════════════════

test('invite: an outsider, an invitee and a declined member are all refused', async () => {
  for (const who of ['mallory', 'carol', 'dave']) {
    const res = await call('POST', '/api/flocks/10/invite', who, { user_ids: [4] });
    assert.strictEqual(res.status, 403, `${who} invited into a flock they are not in`);
  }
  assert.strictEqual(memberOf(10, 4), undefined);
  noWriteMatching('INSERT INTO flock_members');
  assertQueriesUnderstood();
});

test('invite: the refusal never distinguishes a real flock from a fabricated one', async () => {
  const real = await call('POST', '/api/flocks/10/invite', 'mallory', { user_ids: [4] });
  const fake = await call('POST', `/api/flocks/${MISSING_ID}/invite`, 'mallory', { user_ids: [4] });
  assert.strictEqual(real.status, 403);
  assert.strictEqual(fake.status, 403);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assertQueriesUnderstood();
});

test('invite: an accepted member may invite, and cannot promote anyone to accepted', async () => {
  const res = await call('POST', '/api/flocks/10/invite', 'bob', { user_ids: [4] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(memberOf(10, 4).status, 'invited', 'invite minted more than an invite');
  assertQueriesUnderstood();
});

test('invite: a re-invite cannot demote an accepted member back out of the roster', async () => {
  const res = await call('POST', '/api/flocks/10/invite', 'alice', { user_ids: [2, 6] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(memberOf(10, 2).status, 'accepted');
  assert.strictEqual(memberOf(10, 6).status, 'accepted');
  assertQueriesUnderstood();
});

test('invite: a departed member loses the power immediately', async () => {
  await call('POST', '/api/flocks/10/leave', 'erin');
  const res = await call('POST', '/api/flocks/10/invite', 'erin', { user_ids: [4] });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(memberOf(10, 4), undefined);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. POST /api/flocks/:id/decline — RSVP no (self only)
// ═══════════════════════════════════════════════════════════════════════════

test('decline: an outsider gets the same answer for a real flock and a fake one', async () => {
  const real = await call('POST', '/api/flocks/10/decline', 'mallory');
  const fake = await call('POST', `/api/flocks/${MISSING_ID}/decline`, 'mallory');
  assert.strictEqual(real.status, 404);
  assert.strictEqual(fake.status, 404);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assertQueriesUnderstood();
});

test('decline: nobody can decline on anyone else\'s behalf', async () => {
  const res = await call('POST', '/api/flocks/10/decline', 'bob', { user_id: 3, userId: 3 });
  assert.strictEqual(res.status, 404, 'an accepted member had a pending invite to decline');
  assert.strictEqual(memberOf(10, 3).status, 'invited', 'somebody else\'s RSVP was changed');
  assertQueriesUnderstood();
});

test('decline: the invitee themselves can, and it is idempotent-safe', async () => {
  assert.strictEqual((await call('POST', '/api/flocks/10/decline', 'carol')).status, 200);
  assert.strictEqual(memberOf(10, 3).status, 'declined');
  assert.strictEqual((await call('POST', '/api/flocks/10/decline', 'carol')).status, 404);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. POST /api/flocks/:id/leave
// ═══════════════════════════════════════════════════════════════════════════

test('leave: an outsider cannot learn a flock\'s name by leaving it', async () => {
  const real = await call('POST', '/api/flocks/10/leave', 'mallory');
  const fake = await call('POST', `/api/flocks/${MISSING_ID}/leave`, 'mallory');
  assert.strictEqual(real.status, 404);
  assert.strictEqual(fake.status, 404);
  const body = await real.json();
  assert.deepStrictEqual(body, await fake.json());
  assert.strictEqual(body.flock_name, undefined);
  assert.ok(flocks.has(10));
  assertQueriesUnderstood();
});

test('leave: leaving removes only the caller\'s own row', async () => {
  const before = rowsOf(10).length;
  const res = await call('POST', '/api/flocks/10/leave', 'bob', { user_id: 1, userId: 1 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(memberOf(10, 2), undefined);
  assert.strictEqual(memberOf(10, 1).status, 'accepted', 'leave removed somebody else');
  assert.strictEqual(rowsOf(10).length, before - 1);
  assertQueriesUnderstood();
});

test('leave: a plain member leaving never deletes the flock', async () => {
  await call('POST', '/api/flocks/10/leave', 'bob');
  assert.ok(flocks.has(10), 'a member leaving took the whole plan down');
  assertQueriesUnderstood();
});

test('leave: only the creator\'s departure deletes, and it cascades', async () => {
  const res = await call('POST', '/api/flocks/10/leave', 'alice');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).deleted, true);
  assert.ok(!flocks.has(10));
  assert.deepStrictEqual(links.filter((l) => l.flock_id === 10), []);
  assert.deepStrictEqual(msgRows.filter((m) => m.flock_id === 10), []);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. GET /api/flocks/:id/members — the roster
// ═══════════════════════════════════════════════════════════════════════════

test('roster: closed to outsiders, invitees and declined members alike', async () => {
  for (const who of ['mallory', 'carol', 'dave']) {
    const res = await call('GET', '/api/flocks/10/members', who);
    assert.strictEqual(res.status, 404, `${who} read the roster`);
    const body = await res.json();
    assert.strictEqual(body.members, undefined);
    assert.strictEqual(body.going_count, undefined);
  }
  assertQueriesUnderstood();
});

test('roster: the 404 an outsider gets is the 404 a fabricated id gets', async () => {
  const real = await call('GET', '/api/flocks/10/members', 'mallory');
  const fake = await call('GET', `/api/flocks/${MISSING_ID}/members`, 'mallory');
  assert.deepStrictEqual(await real.json(), await fake.json());
  assert.strictEqual(real.status, fake.status);
});

test('roster: an accepted member sees it, and no email is on any row', async () => {
  const res = await call('GET', '/api/flocks/10/members', 'bob');
  assert.strictEqual(res.status, 200);
  const { members: got } = await res.json();
  assert.strictEqual(got.length, 5);
  for (const m of got) assert.strictEqual(m.email, undefined, 'the roster carried an email address');
  assertQueriesUnderstood();
});

test('roster: a departed member loses it on the next request', async () => {
  assert.strictEqual((await call('GET', '/api/flocks/10/members', 'erin')).status, 200);
  await call('POST', '/api/flocks/10/leave', 'erin');
  assert.strictEqual((await call('GET', '/api/flocks/10/members', 'erin')).status, 404);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. POST /api/flocks/:id/attendance — creator only, completed flocks only
// ═══════════════════════════════════════════════════════════════════════════

test('attendance: an outsider is refused without confirming the flock exists', async () => {
  flocks.get(10).status = 'completed';
  const real = await call('POST', '/api/flocks/10/attendance', 'mallory', { attendance: [{ userId: 4, attended: true }] });
  const fake = await call('POST', `/api/flocks/${MISSING_ID}/attendance`, 'mallory', { attendance: [{ userId: 4, attended: true }] });
  assert.strictEqual(real.status, 404);
  assert.strictEqual(fake.status, 404);
  assert.deepStrictEqual(await real.json(), await fake.json());
  noWriteMatching('attendance = t.mark');
  assertQueriesUnderstood();
});

test('attendance: a plain accepted member cannot mark it, not even for themselves', async () => {
  flocks.get(10).status = 'completed';
  const res = await call('POST', '/api/flocks/10/attendance', 'bob', { attendance: [{ userId: 2, attended: true }] });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(memberOf(10, 2).attendance, 'unmarked');
  noWriteMatching('UPDATE users SET reliability_score');
  assertQueriesUnderstood();
});

test('attendance: the creator of ANOTHER flock cannot reach into this one\'s roster', async () => {
  // Mallory owns flock 20 (completed) and is nobody in flock 10. Naming flock
  // 10's members from her own flock must move nothing: the UPDATE is scoped to
  // the flock in the path, and the reliability recompute is scoped to that
  // flock's accepted roster.
  const res = await call('POST', '/api/flocks/20/attendance', 'mallory', {
    attendance: [{ userId: 1, attended: false }, { userId: 2, attended: false }, { userId: 4, attended: true }],
  });
  assert.strictEqual(res.status, 200);
  const { results } = await res.json();
  assert.deepStrictEqual(results.map((r) => r.userId), [4], 'a stranger\'s reliability was recomputed');
  assert.strictEqual(memberOf(10, 1).attendance, 'unmarked');
  assert.strictEqual(memberOf(10, 2).attendance, 'unmarked');
  assertQueriesUnderstood();
});

test('attendance: creator-check comes before the completed-check, so neither is an oracle', async () => {
  // flock 10 is 'planning'. A member must not be able to tell "not completed"
  // from "not yours" — both are refusals they cannot act on, and only the
  // creator is entitled to the flock's lifecycle state.
  const member = await call('POST', '/api/flocks/10/attendance', 'bob', { attendance: [{ userId: 2, attended: true }] });
  assert.strictEqual(member.status, 403);
  const creator = await call('POST', '/api/flocks/10/attendance', 'alice', { attendance: [{ userId: 2, attended: true }] });
  assert.strictEqual(creator.status, 400);
  assertQueriesUnderstood();
});

test('attendance: the creator can mark, and only accepted members of this flock move', async () => {
  flocks.get(10).status = 'completed';
  const res = await call('POST', '/api/flocks/10/attendance', 'alice', {
    attendance: [
      { userId: 2, attended: true },
      { userId: 3, attended: true },       // invited, not accepted
      { userId: 4, attended: true },       // not in this flock at all
      { userId: 'guest:12', attended: true },
    ],
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(memberOf(10, 2).attendance, 'attended');
  assert.strictEqual(memberOf(10, 3).attendance, 'unmarked', 'an invitee was marked present');
  assert.strictEqual(memberOf(20, 4).attendance, 'unmarked', 'another flock\'s member was marked');
  const { results } = await res.json();
  assert.deepStrictEqual(results.map((r) => r.userId), [2]);
  assertQueriesUnderstood();
});

// FINDING (round 4). `attendance_marked` fanned `results` out verbatim to every
// accepted member, and `results` carries totalPlansJoined / totalPlansAttended
// — counts summed over EVERY completed flock each person has ever been in.
// Marking one evening's attendance therefore told Bob how many plans Carol has
// joined and shown up to across the whole app, in groups Bob has no
// relationship to. Nothing consumed it: the frontend knows `attendance_marked`
// only as a push deep-link type, and no test pinned the payload.
test('attendance: the broadcast carries this flock\'s facts, not each member\'s app-wide history', async () => {
  const emitted = [];
  const fakeIo = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  app.set('io', fakeIo);
  try {
    flocks.get(10).status = 'completed';
    const res = await call('POST', '/api/flocks/10/attendance', 'alice', {
      attendance: [{ userId: 2, attended: true }, { userId: 6, attended: false }],
    });
    assert.strictEqual(res.status, 200);

    const room = emitted.filter((e) => e.event === 'attendance_marked');
    assert.ok(room.length > 0, 'nobody was told attendance was recorded');
    for (const e of room) {
      for (const entry of e.payload.attendance) {
        assert.deepStrictEqual(Object.keys(entry).sort(), ['reliabilityScore', 'userId'],
          'the flock broadcast carried a member\'s cross-flock plan history');
      }
    }

    // The owner of the numbers still gets them, on their own channel.
    const mine = emitted.filter((e) => e.event === 'reliability_updated');
    assert.ok(mine.length > 0);
    for (const e of mine) {
      assert.ok(Object.hasOwn(e.payload, 'totalPlansJoined'));
      assert.match(e.room, /^user:\d+$/);
    }

    // And the creator's own reply is unchanged — a different disclosure, one
    // recipient, and a shape other suites pin.
    const { results } = await res.json();
    assert.deepStrictEqual(Object.keys(results[0]).sort(),
      ['reliabilityScore', 'totalPlansAttended', 'totalPlansJoined', 'userId']);
    assertQueriesUnderstood();
  } finally {
    app.set('io', undefined);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Powers that do not exist — pinned so nobody adds one without a gate
// ═══════════════════════════════════════════════════════════════════════════

test('there is no kick: no route removes a membership row other than the owner\'s own', async () => {
  const attempts = [
    ['DELETE', '/api/flocks/10/members/2'],
    ['POST', '/api/flocks/10/kick'],
    ['POST', '/api/flocks/10/members/2/remove'],
    ['DELETE', '/api/flocks/10/members'],
    ['PUT', '/api/flocks/10/members/2'],
  ];
  for (const [method, p] of attempts) {
    for (const who of ['alice', 'bob', 'mallory']) {
      const res = await call(method, p, who, { user_id: 2, status: 'declined' });
      assert.strictEqual(res.status, 404, `${method} ${p} is a live route — it needs an authz gate`);
    }
  }
  assert.strictEqual(memberOf(10, 2).status, 'accepted');
  noWriteMatching('flock_members');
});

test('role smuggling: no body key promotes the caller anywhere in this router', async () => {
  const smuggle = { role: 'admin', is_admin: true, creator_id: 4, status: 'accepted', member_status: 'accepted' };
  const probes = [
    ['POST', '/api/flocks/10/join', 'mallory'],
    ['POST', '/api/flocks/10/decline', 'mallory'],
    ['POST', '/api/flocks/10/leave', 'mallory'],
    ['POST', '/api/flocks/10/invite-link', 'mallory'],
    ['PUT', '/api/flocks/10', 'mallory'],
    ['DELETE', '/api/flocks/10', 'mallory'],
  ];
  for (const [method, p, who] of probes) {
    const res = await call(method, p, who, smuggle);
    // 400 is a legitimate answer too (PUT refuses `status: 'accepted'`, which is
    // not in the flock-status vocabulary) — what may never happen is a 2xx.
    assert.ok([400, 403, 404].includes(res.status), `${method} ${p} answered ${res.status}`);
  }
  assert.strictEqual(memberOf(10, 4), undefined);
  assert.strictEqual(flocks.get(10).creator_id, 1);
  // The only statement any of these may issue is `decline`'s self-scoped
  // UPDATE, which is keyed on the caller's own id and matched nothing.
  for (const w of writes) {
    assert.match(w.sql, /^UPDATE flock_members SET status = 'declined'/,
      `a smuggled role key produced a write: ${w.sql}`);
    assert.strictEqual(Number(w.params[1]), WHO.mallory, 'a write escaped the caller\'s own row');
  }
  assert.deepStrictEqual(rowsOf(10).map((m) => `${m.user_id}:${m.status}`),
    ['1:accepted', '2:accepted', '3:invited', '5:declined', '6:accepted'],
    'the roster moved');
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Round 2 — the adversarial re-audit
// ═══════════════════════════════════════════════════════════════════════════

// A read route can only be as safe as its ORDERING: if any flock data is
// fetched before the membership question is asked, then a revocation landing
// mid-request, a thrown error, or a future `return` inserted between them all
// turn into a leak. Both read routes ask first and fetch second, and this is
// what keeps that true.
test('ordering: on every read route the membership question is asked before any flock data', async () => {
  await call('GET', '/api/flocks/10', 'bob');
  const gate = queries.findIndex((q) => q.sql.startsWith('SELECT status FROM flock_members'));
  const data = queries.findIndex((q) => /FROM flocks f\b/.test(q.sql));
  assert.ok(gate >= 0 && data > gate, 'GET /:id read flock data before deciding membership');

  queries.length = 0;
  await call('GET', '/api/flocks/10/members', 'bob');
  const rosterGate = queries.findIndex((q) => q.sql.includes("AND status = 'accepted'") && q.sql.includes('user_id = $2'));
  const roster = queries.findIndex((q) => q.sql.includes('FROM flock_members fm JOIN users u'));
  assert.ok(rosterGate >= 0 && roster > rosterGate, 'the roster was read before membership was decided');
  assertQueriesUnderstood();
});

// A moderation removal or an admin action deletes the row without going through
// POST /:id/leave. The reads must close for that too, not only for a departure
// the router itself performed.
test('revocation: a row removed out of band closes every read on the next request', async () => {
  assert.strictEqual((await call('GET', '/api/flocks/10', 'bob')).status, 200);
  assert.strictEqual((await call('GET', '/api/flocks/10/members', 'bob')).status, 200);

  const list = rowsOf(10);
  list.splice(list.findIndex((m) => m.user_id === 2), 1); // kicked, out of band

  assert.strictEqual((await call('GET', '/api/flocks/10', 'bob')).status, 404);
  assert.strictEqual((await call('GET', '/api/flocks/10/members', 'bob')).status, 404);
  assert.strictEqual((await call('POST', '/api/flocks/10/invite-link', 'bob')).status, 403);
  assert.strictEqual((await call('POST', '/api/flocks/10/invite', 'bob', { user_ids: [4] })).status, 403);
  assert.strictEqual((await call('POST', '/api/flocks/10/join', 'bob')).status, 404);
  const seen = await (await call('GET', '/api/flocks', 'bob')).json();
  assert.ok(!seen.flocks.some((f) => f.id === 10));
  assertQueriesUnderstood();
});

// An accepted member sees themselves demoted to `invited` while the request is
// in flight. The next request must serve the invite card, not the plan.
test('revocation: a demotion to `invited` downgrades the very next read to the card', async () => {
  memberOf(10, 2).status = 'invited';
  const body = await (await call('GET', '/api/flocks/10', 'bob')).json();
  assert.strictEqual(body.invitePreview, true);
  assert.deepStrictEqual(Object.keys(body.flock).sort(), [...INVITE_CARD_KEYS].sort());
  assert.strictEqual((await call('GET', '/api/flocks/10/members', 'bob')).status, 404);
  assertQueriesUnderstood();
});

test('invited state: leaving tells an invitee nothing their own invite card did not', async () => {
  const card = (await (await call('GET', '/api/flocks/10', 'carol')).json()).flock;
  const left = await call('POST', '/api/flocks/10/leave', 'carol');
  assert.strictEqual(left.status, 200);
  const body = await left.json();
  assert.strictEqual(body.flock_name, card.name, 'leave returned a name the card did not carry');
  assert.strictEqual(body.deleted, false, 'an invitee walking away took the plan down');
  assert.deepStrictEqual(Object.keys(body).sort(), ['deleted', 'flock_name', 'message']);
  assert.strictEqual(memberOf(10, 3), undefined);
  assertQueriesUnderstood();
});

// Deliberate, and recorded as such in the route: "invited, previously declined,
// or already accepted" may join. Someone who said no and changed their mind is
// not a new person, and their row is still the host's invitation.
test('invited state: a declined member may still accept — a departed one may not', async () => {
  assert.strictEqual((await call('POST', '/api/flocks/10/join', 'dave')).status, 200);
  assert.strictEqual(memberOf(10, 5).status, 'accepted');

  await call('POST', '/api/flocks/10/leave', 'dave');
  assert.strictEqual((await call('POST', '/api/flocks/10/join', 'dave')).status, 404);
  assert.strictEqual(memberOf(10, 5), undefined);
  assertQueriesUnderstood();
});

// express-validator coerces before it tests, so a one-element array reads as a
// scalar. That has already been fixed on this router's flock fields; these
// probe the ARRAY-of-ids bodies, where the elements are never validated at all
// and only `parseInt` stands between the wire and an integer column.
test('coercion: array- and object-shaped ids in a body cannot bypass a single gate', async () => {
  const shapes = [[4], ['4'], [['4']], [{ toString: () => '4' }], ['4abc'], [4.9], [null], [{}], [[[4]]]];
  for (const user_ids of shapes) {
    reset();
    const outsider = await call('POST', '/api/flocks/10/invite', 'mallory', { user_ids });
    assert.strictEqual(outsider.status, 403, `user_ids ${JSON.stringify(user_ids)} let an outsider through`);
    assert.strictEqual(memberOf(10, 4), undefined);
    noWriteMatching('flock_members');
  }
  assertQueriesUnderstood();
});

test('coercion: a coerced attendance id still cannot reach another flock\'s roster', async () => {
  flocks.get(10).status = 'completed';
  const res = await call('POST', '/api/flocks/10/attendance', 'bob', {
    attendance: [{ userId: ['2'], attended: true }, { userId: { valueOf: () => 2 }, attended: true }],
  });
  assert.strictEqual(res.status, 403, 'a plain member marked attendance with a coerced id');
  assert.strictEqual(memberOf(10, 2).attendance, 'unmarked');
  noWriteMatching('attendance = t.mark');
  assertQueriesUnderstood();
});

test('cross-flock: a body cannot redirect a mutation at a flock the path did not name', async () => {
  flocks.get(20).status = 'completed';
  const smuggle = { flock_id: 10, flockId: 10, id: 10 };

  const attendance = await call('POST', '/api/flocks/20/attendance', 'mallory', {
    ...smuggle, attendance: [{ userId: 4, attended: true }],
  });
  assert.strictEqual(attendance.status, 200);
  assert.strictEqual(memberOf(20, 4).attendance, 'attended');
  assert.strictEqual(memberOf(10, 1).attendance, 'unmarked', 'attendance landed on the smuggled flock');

  const invite = await call('POST', '/api/flocks/20/invite', 'mallory', { ...smuggle, user_ids: [3] });
  assert.strictEqual(invite.status, 200);
  assert.strictEqual(memberOf(20, 3).status, 'invited');
  assert.strictEqual(memberOf(10, 3).status, 'invited', 'the invite rewrote a row in another flock');
  assert.strictEqual(rowsOf(10).length, 5);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. Round 3 — blocks, cleanup, and the inventory that keeps this file honest
// ═══════════════════════════════════════════════════════════════════════════

// Blocking is the one filter layered on top of these gates, which makes it the
// one thing that could quietly change an authorization ANSWER rather than just
// a payload. It must do neither: a block hides names, never memberships.
test('blocks: blocking the creator withholds faces, not the plan or the gate', async () => {
  blocks = [[2, 1]]; // Bob blocked Alice
  const res = await call('GET', '/api/flocks/10', 'bob');
  assert.strictEqual(res.status, 200, 'a block turned a member into an outsider');
  const body = await res.json();
  assert.ok(!body.members.some((m) => m.id === 1), 'a blocked member stayed in the roster');
  // The head count is deliberately NOT block-filtered: two people looking at
  // one plan must read the same number of people.
  assert.strictEqual(body.momentum.totalMembers, 5);
  assertQueriesUnderstood();
});

test('blocks: a block cannot be used to reach a flock you are not in', async () => {
  blocks = [[4, 1]]; // Mallory blocked Alice
  assert.strictEqual((await call('GET', '/api/flocks/10', 'mallory')).status, 404);
  assert.strictEqual((await call('GET', '/api/flocks/10/members', 'mallory')).status, 404);
  assert.strictEqual((await call('DELETE', '/api/flocks/10', 'mallory')).status, 404);
  assertQueriesUnderstood();
});

// The empty-flock sweep is a cleanup, not a power: it only fires when the last
// accepted member walks away, which cannot happen while the creator holds an
// accepted row (the creator's own departure takes the other branch).
test('cleanup: a plain member cannot delete a flock by leaving while anyone remains', async () => {
  await call('POST', '/api/flocks/10/leave', 'bob');
  await call('POST', '/api/flocks/10/leave', 'erin');
  assert.ok(flocks.has(10), 'the plan died with its members still in it');
  assert.strictEqual(acceptedCount(10), 1);
  assertQueriesUnderstood();
});

// ── GET /history and POST /:id/rerun (the "do it again" pair) ───────────────

test('history: only completed/cancelled flocks the caller was ACCEPTED into appear', async () => {
  // Flock 10 is 'planning': nobody's history may show it, member or not.
  const planning = await (await call('GET', '/api/flocks/history', 'alice')).json();
  assert.deepStrictEqual(planning.flocks, [], 'a live plan is not history');

  flocks.get(10).status = 'completed';
  const res = await call('GET', '/api/flocks/history', 'bob');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.flocks.map((f) => f.id), [10]);
  // The contract the frontend is built against, field for field.
  const entry = body.flocks[0];
  assert.deepStrictEqual(Object.keys(entry).sort(),
    ['event_time', 'id', 'members', 'name', 'status', 'venue_address', 'venue_name', 'venue_place_id']);
  assert.strictEqual(entry.venue_place_id, FLOCK_10().venue_id);
  // Accepted members only — Carol (invited) and Dave (declined) were never in it.
  assert.deepStrictEqual(entry.members.map((m) => m.id).sort(), [1, 2, 6]);
  assert.deepStrictEqual(Object.keys(entry.members[0]).sort(), ['id', 'name', 'profile_image_url']);

  // Carol holds an invite to flock 10 and STILL does not see it in history.
  const carol = await (await call('GET', '/api/flocks/history', 'carol')).json();
  assert.deepStrictEqual(carol.flocks.map((f) => f.id), [],
    'an invite is not membership, in history as everywhere else');
  // Mallory sees only her own completed flock 20, never 10.
  const mallory = await (await call('GET', '/api/flocks/history', 'mallory')).json();
  assert.deepStrictEqual(mallory.flocks.map((f) => f.id), [20]);
  assertQueriesUnderstood();
});

test('history: a blocked member\'s name and face are withheld from the roster', async () => {
  flocks.get(10).status = 'cancelled';
  blocks = [[2, 6]]; // Bob and Erin blocked each other (either direction)
  const body = await (await call('GET', '/api/flocks/history', 'bob')).json();
  assert.deepStrictEqual(body.flocks.map((f) => f.id), [10], 'cancelled counts as history too');
  assert.deepStrictEqual(body.flocks[0].members.map((m) => m.id).sort(), [1, 2],
    'the blocked member must be filtered the way GET /:id/members filters them');
  assertQueriesUnderstood();
});

test('rerun: outsiders get 404, the merely-invited and the declined get 403', async () => {
  flocks.get(10).status = 'completed';
  assert.strictEqual((await call('POST', '/api/flocks/10/rerun', 'mallory')).status, 404,
    'no membership row means the flock does not exist for you');
  assert.strictEqual((await call('POST', '/api/flocks/10/rerun', 'carol')).status, 403);
  assert.strictEqual((await call('POST', '/api/flocks/10/rerun', 'dave')).status, 403);
  assert.strictEqual((await call('POST', `/api/flocks/${MISSING_ID}/rerun`, 'alice')).status, 404);
  noWriteMatching('INSERT INTO flocks');
  assertQueriesUnderstood();
});

test('rerun: a live flock cannot be cloned — completed or cancelled only', async () => {
  // FLOCK_10 is 'planning' in the fixture.
  const res = await call('POST', '/api/flocks/10/rerun', 'bob');
  assert.strictEqual(res.status, 400);
  noWriteMatching('INSERT INTO flocks');

  flocks.get(10).status = 'confirmed';
  assert.strictEqual((await call('POST', '/api/flocks/10/rerun', 'bob')).status, 400);
  noWriteMatching('INSERT INTO flocks');
  assertQueriesUnderstood();
});

test('rerun: a plain accepted member clones the plan and the old roster is invited', async () => {
  flocks.get(10).status = 'completed';
  const res = await call('POST', '/api/flocks/10/rerun', 'bob', { event_time: '2026-09-01T23:00:00.000Z' });
  const body = await res.json();
  assert.strictEqual(res.status, 201, JSON.stringify(body));

  // Same shape as POST /: the client navigates straight into `flock`.
  assert.ok(body.flock.id && body.flock.id !== 10, 'a NEW flock, not the old one');
  assert.strictEqual(body.flock.name, FLOCK_10().name);
  assert.strictEqual(body.flock.venue_name, FLOCK_10().venue_name);
  assert.strictEqual(body.flock.venue_id, FLOCK_10().venue_id);
  assert.strictEqual(body.flock.status, 'planning');

  // The caller is the creator/accepted member; every OTHER accepted member of
  // the source is invited. Carol (invited) and Dave (declined) are not.
  const roster = rowsOf(body.flock.id);
  assert.deepStrictEqual(roster.filter((m) => m.status === 'accepted').map((m) => m.user_id), [2]);
  assert.deepStrictEqual(body.invited_user_ids.sort(), [1, 6]);
  assert.deepStrictEqual(roster.filter((m) => m.status === 'invited').map((m) => m.user_id).sort(), [1, 6]);

  // The SOURCE flock is untouched: same status, same roster.
  assert.strictEqual(flocks.get(10).status, 'completed');
  assert.strictEqual(rowsOf(10).length, 5);
  assertQueriesUnderstood();
});

test('rerun: a block that happened since the old flock keeps the pair apart', async () => {
  flocks.get(10).status = 'completed';
  blocks = [[6, 2]]; // Erin blocked Bob after the old plan
  const res = await call('POST', '/api/flocks/10/rerun', 'bob');
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.deepStrictEqual(body.invited_user_ids, [1],
    'the shared invite pipeline must re-apply blocks on a rerun');
  assert.ok(!rowsOf(body.flock.id).some((m) => m.user_id === 6),
    'a blocked pair must not be re-joined by replaying an old plan');
  assertQueriesUnderstood();
});

// This sweep is only complete while the route list is. A new endpoint added to
// flocks.js without a line here means an ungated surface nobody audited.
test('inventory: every route in flocks.js is one this sweep actually covers', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');
  const found = [...src.matchAll(/router\.(get|post|put|delete|patch|all)\(\s*'([^']+)'/g)]
    .map(([, method, p]) => `${method.toUpperCase()} ${p}`).sort();
  const audited = [
    'GET /', 'POST /', 'GET /activity', 'GET /history', 'GET /:id', 'PUT /:id',
    'DELETE /:id', 'POST /:id/invite-link', 'POST /:id/join', 'POST /:id/invite',
    'POST /:id/rerun', 'POST /:id/decline', 'POST /:id/leave', 'GET /:id/members',
    'POST /:id/attendance',
  ].sort();
  assert.deepStrictEqual(found, audited,
    'routes/flocks.js gained or lost a route — audit it and update this list');

  // And nothing is mounted ahead of the authentication middleware.
  assert.ok(src.indexOf('router.use(authenticate)') < src.indexOf("router.get('/'"),
    'a route is mounted before authenticate');
});

test('id confusion: a bounded-integer id is settled on every route before any query', async () => {
  const paths = [
    ['GET', '/api/flocks/%s'],
    ['PUT', '/api/flocks/%s'],
    ['DELETE', '/api/flocks/%s'],
    ['GET', '/api/flocks/%s/members'],
    ['POST', '/api/flocks/%s/join'],
    ['POST', '/api/flocks/%s/decline'],
    ['POST', '/api/flocks/%s/leave'],
    ['POST', '/api/flocks/%s/invite-link'],
    ['POST', '/api/flocks/%s/invite'],
    ['POST', '/api/flocks/%s/rerun'],
    ['POST', '/api/flocks/%s/attendance'],
  ];
  for (const [method, tpl] of paths) {
    for (const bad of ['abc', '0', '-5', '2147483648', '1e3']) {
      const res = await call(method, tpl.replace('%s', bad), 'mallory',
        method === 'GET' || method === 'DELETE' ? undefined : { user_ids: [4], attendance: [{ userId: 4, attended: true }] });
      assert.strictEqual(res.status, 400, `${method} ${tpl.replace('%s', bad)} answered ${res.status}`);
    }
  }
  assert.deepStrictEqual(writes, [], 'a malformed id reached a write');
  assertQueriesUnderstood();
});
