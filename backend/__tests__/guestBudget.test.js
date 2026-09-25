// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GUEST DOOR TO THE ANONYMOUS BUDGET
// (routes/guest.js POST /:token/budget, POST /:token/me, GET /:token,
//  and routes/budget.js POST /:flockId/reset)
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS FILE EXISTS. Migration 071 let a share link answer the budget: a
// person with no account writes a budget_submissions row keyed on their RSVP
// instead of on a user, and that row feeds the same MIN and the same one-time
// settle the member door feeds. Every privacy invariant on routes/budget.js
// was pinned on the assumption that a row's author is a member. This file
// pins the same invariants on the second kind of author, pins that there is
// one settle and one publication, not two, and pins the line an adversarial
// review drew through the middle of it: A GUEST'S NUMBER BINDS THE BAND, AND
// A GUEST IS NEVER THE CROWD. The three-amount floor exists because a MIN
// over fewer people is one person's figure, and a guest row is minted by
// whoever holds the link, with no account and no invitation. If guest rows
// could make three, a creator alone in a plan could mint two, park ten
// thousand on each, answer their own number, and read the band of it back
// off the link.
//
// What is pinned, through the REAL routers over HTTP against a modelled world:
//   1. THE GATES. No RSVP row is 403, an out guest is 409 NOT_IN, a hidden row
//      is 403 as if it never existed, a locked budget is 409 BUDGET_LOCKED with
//      nothing written, and the per-guest action budget is 429 with nothing
//      written. A refusal before the transaction costs no pool checkout.
//   2. THE WRITE. The upsert is keyed on (flock_id, guest_rsvp_id) and never
//      mentions user_id, so a guest's row cannot collide with a member's and
//      cannot be mistaken for one.
//   3. THE SETTLE. After the upsert the guest door runs the member door's four
//      statements (MIN over present rows, the totals, the member count, the
//      guest count), in that order, inside BEGIN/COMMIT. The flock locks only
//      when everyone who has to answer has, and three MEMBERS have shared an
//      amount. "Everyone" is accepted members plus visible 'in' guests: a
//      guest's row is waited for and a guest's amount can be the MIN, but two
//      members and any number of guests never settle. An out guest is not
//      waited for, and a hidden guest's cent does not set the number.
//   4. THE PUBLICATION. A guest's answer carries the aggregate and nothing
//      else: no amount, no name, a ceiling only on the answer that settles,
//      and the skip/share split only over a crowd of four or more members,
//      whatever the guests bring the population to. POST /:token/me hands a
//      guest their own row, and the band only to an 'in' guest, once locked,
//      while three member sharers exist. GET /:token carries counts and never
//      a ceiling key at all, and its roster says "reconfirmed" only inside an
//      open window.
//   5. THE SOURCE CONTRACT. Two fragments. MEMBER_SUBMISSIONS is accounts only
//      and is what every reveal threshold counts, here, in routes/flocks.js
//      and in routes/billing.js. PRESENT_ANSWERS widens it by a guest arm
//      gated on a visible 'in' answer and feeds only the MIN and the totals,
//      with the crowd counted inside it by `bm.id IS NOT NULL`. resolveLink no
//      longer hands the routes a ceiling. The remind route asks NOT EXISTS.
//   6. THE RESET. The creator can start the budget over: every row deleted and
//      the lock lifted in one transaction, the room told with all zeros, and
//      the next publication a first publication. A member who is not the
//      creator cannot, and a stranger is answered as /lock answers them.
//   7. THE READ BUDGET. POST /:token/me costs a read unit per call, 120 an
//      hour per RSVP row, and the 121st is 429 with a real wait.
//
// No database: pool.query is a semantic fixture over one flock. Unmodelled
// statements throw rather than answering with an empty result, so a query on
// the wrong thing cannot pass as a query on the right thing.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'guest-budget-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// ── The modelled world ───────────────────────────────────────────────────────
// flocks:      id -> { id, name, creator_id, status, budget_*, event_time,
//                      reconfirm_opened_at, ... }
// members:     [{ flock_id, user_id, name, status, reconfirmed_at }]
// guests:      [{ flock_id, id, guest_token, name, status, is_hidden,
//                 reconfirmed_at }]
// submissions: [{ flock_id, user_id | null, guest_rsvp_id | null, amount,
//                 skipped }]   (UNIQUE on each of the two author keys)
const FLOCK = 42;
let world;
function freshWorld() {
  return { flocks: new Map(), members: [], guests: [], submissions: [] };
}

const acceptedMembers = (flockId) => world.members.filter((m) => m.flock_id === flockId && m.status === 'accepted');
const inGuests = (flockId) => world.guests.filter((g) => g.flock_id === flockId && g.status === 'in' && !g.is_hidden);

// The two presence rules routes/budget.js enforces in SQL, modelled.
//
// MEMBER_SUBMISSIONS is THE CROWD: a row counts while its author is an
// accepted member, and nothing else counts. PRESENT_ANSWERS is WHO HAS
// ANSWERED AND WHAT BINDS: the crowd plus every visible 'in' guest's row.
// Every aggregate here must read through one of the two fragments, and the
// fixture answers such a query only when the statement actually carries the
// fragment it needs, so dropping a join, widening a threshold count onto the
// wrong fragment, or losing the guest arm's status test turns the statement
// unscripted and the case fails naming it, instead of quietly counting rows
// nobody should count.
let MS_FLAT = null;
let PA_FLAT = null;
const overCrowd = (flat) => MS_FLAT && flat.includes(MS_FLAT);
const overPresent = (flat) => PA_FLAT && flat.includes(PA_FLAT);
function memberSubmissions(flockId) {
  const members = new Set(acceptedMembers(flockId).map((m) => m.user_id));
  return world.submissions.filter((s) => s.flock_id === flockId && s.user_id != null && members.has(s.user_id));
}
function presentSubmissions(flockId) {
  const guests = new Set(inGuests(flockId).map((g) => g.id));
  return memberSubmissions(flockId).concat(world.submissions.filter((s) => (
    s.flock_id === flockId && s.guest_rsvp_id != null && guests.has(s.guest_rsvp_id)
  )));
}
function minNonSkipped(rows) {
  const amts = rows
    .filter((s) => s.skipped === false && s.amount != null)
    .map((s) => Number(s.amount));
  // NUMERIC comes back from pg as a string, so the fixture hands one back too.
  return amts.length ? Math.min(...amts).toFixed(2) : null;
}
// The totals statement, answered the way the database would answer it: the
// two totals range over everyone present, and non_skip_count ranges over the
// crowd only when the statement's FILTER says `bm.id IS NOT NULL`. A statement
// that dropped that filter is answered honestly, over everyone, and the cases
// below then fail on their numbers (two members and two guests would lock).
function countsRow(flockId, crowdOnly) {
  const rows = presentSubmissions(flockId);
  const sharers = crowdOnly ? memberSubmissions(flockId) : rows;
  return {
    total_submissions: String(rows.length),
    non_skip_count: String(sharers.filter((s) => !s.skipped).length),
    skip_count: String(rows.filter((s) => s.skipped).length),
  };
}
const guestByToken = (token, flockId) => world.guests.find((g) => (
  g.flock_id === Number(flockId) && g.guest_token === String(token).toLowerCase() && !g.is_hidden
));

// What resolveLink hands every guest route: the flock as the link sees it.
// No ceiling on it: the link is resolved before anything is counted, and a
// number read that early would be older than the count that gates it, so
// POST /:token/me reads the lock and the number together, after the count.
function linkRow() {
  const f = world.flocks.get(FLOCK);
  if (!f) return null;
  return {
    flock_id: f.id, name: f.name, event_time: f.event_time, venue_name: f.venue_name,
    status: f.status, host_name: f.host_name,
    budget_enabled: f.budget_enabled, budget_context: f.budget_context,
    budget_locked: f.budget_locked,
    reconfirm_opened_at: f.reconfirm_opened_at,
  };
}

// utils/reconfirm.js RECONFIRM_STATE_SQL, decided here the way the database
// decides it: open only while a window exists, the plan is confirmed and its
// time is still ahead.
function reconfirmRow(flockId) {
  const f = world.flocks.get(flockId);
  if (!f) return null;
  const open = !!f.reconfirm_opened_at && f.status === 'confirmed'
    && !!f.event_time && new Date(f.event_time).getTime() > Date.now();
  const members = acceptedMembers(flockId);
  const guests = inGuests(flockId);
  return {
    open,
    deadline: f.event_time || null,
    count: members.filter((m) => m.reconfirmed_at).length + guests.filter((g) => g.reconfirmed_at).length,
    total: members.length + guests.length,
  };
}

let log = [];
let unknown = [];
let poolCheckouts = 0;
function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], `unmodelled queries: ${JSON.stringify(unknown.slice(0, 3))}`);
}

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const p = params || [];
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return { rows: [], rowCount: 0 };

  // resolveLink: one token, one flock.
  if (/FROM flock_invite_links il JOIN flocks f ON f\.id = il\.flock_id/.test(flat)) {
    const row = p[0] === LINK_TOKEN ? linkRow() : null;
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  // The guest's own row, by their bearer token. Both projections carry the
  // hidden filter; the fixture applies it whichever columns are asked for.
  if (/^SELECT id, (name, )?status(, reconfirmed_at)? FROM guest_rsvps WHERE guest_token = \$1 AND flock_id = \$2 AND COALESCE\(is_hidden, false\) = false$/.test(flat)) {
    const g = guestByToken(p[0], p[1]);
    return g
      ? { rows: [{ id: g.id, name: g.name, status: g.status, reconfirmed_at: g.reconfirmed_at }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // The flock row, in each of the projections a budget reader asks for.
  if (/^SELECT budget_enabled, budget_locked, status FROM flocks WHERE id = \$1 FOR UPDATE$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f
      ? { rows: [{ budget_enabled: f.budget_enabled, budget_locked: f.budget_locked, status: f.status }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  // The creator's two doors, /lock and /reset, hold the row with this one.
  if (/^SELECT creator_id, budget_enabled, budget_locked FROM flocks WHERE id = \$1 FOR UPDATE$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f
      ? { rows: [{ creator_id: f.creator_id, budget_enabled: f.budget_enabled, budget_locked: f.budget_locked }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (/^SELECT budget_locked, budget_ceiling FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ budget_locked: f.budget_locked, budget_ceiling: f.budget_ceiling }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT budget_enabled, budget_context, budget_locked, budget_ceiling, ghost_mode_enabled FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ ...f }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT name FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ name: f.name }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // The two upserts, one per kind of author.
  if (/^INSERT INTO budget_submissions \(flock_id, guest_rsvp_id, amount, skipped, updated_at\)/.test(flat)) {
    const [fid, gid, amount, skipped] = [Number(p[0]), Number(p[1]), p[2], p[3]];
    const existing = world.submissions.find((s) => s.flock_id === fid && s.guest_rsvp_id === gid);
    if (existing) { existing.amount = amount; existing.skipped = !!skipped; }
    else world.submissions.push({ flock_id: fid, user_id: null, guest_rsvp_id: gid, amount, skipped: !!skipped });
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO budget_submissions \(flock_id, user_id, amount, skipped, updated_at\)/.test(flat)) {
    const [fid, uid, amount, skipped] = [Number(p[0]), Number(p[1]), p[2], p[3]];
    const existing = world.submissions.find((s) => s.flock_id === fid && s.user_id === uid);
    if (existing) { existing.amount = amount; existing.skipped = !!skipped; }
    else world.submissions.push({ flock_id: fid, user_id: uid, guest_rsvp_id: null, amount, skipped: !!skipped });
    return { rows: [], rowCount: 1 };
  }
  // A guest's own row, and a member's own row.
  if (/^SELECT amount, skipped FROM budget_submissions WHERE flock_id = \$1 AND guest_rsvp_id = \$2$/.test(flat)) {
    const s = world.submissions.find((x) => x.flock_id === Number(p[0]) && x.guest_rsvp_id === Number(p[1]));
    return s ? { rows: [{ amount: s.amount, skipped: s.skipped }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT amount, skipped FROM budget_submissions WHERE flock_id = \$1 AND user_id = \$2$/.test(flat)) {
    const s = world.submissions.find((x) => x.flock_id === Number(p[0]) && x.user_id === Number(p[1]));
    return s ? { rows: [{ amount: s.amount, skipped: s.skipped }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // The aggregates. Answered ONLY through a presence fragment (see above):
  // the MIN and the totals through PRESENT_ANSWERS, a reveal threshold
  // through MEMBER_SUBMISSIONS. A MIN over the crowd alone is modelled too,
  // so a statement that asked for it would be answered rather than refused,
  // and the case that needed a guest's cent in the number would say so.
  if (/^SELECT MIN\(amount\) AS ceiling FROM /.test(flat) && /WHERE bs\.flock_id = \$1 AND skipped = false$/.test(flat)) {
    if (overPresent(flat)) return { rows: [{ ceiling: minNonSkipped(presentSubmissions(Number(p[0]))) }], rowCount: 1 };
    if (overCrowd(flat)) return { rows: [{ ceiling: minNonSkipped(memberSubmissions(Number(p[0]))) }], rowCount: 1 };
  }
  if (/COUNT\(\*\) AS total_submissions/.test(flat) && overPresent(flat) && /WHERE bs\.flock_id = \$1$/.test(flat)) {
    const crowdOnly = /COUNT\(\*\) FILTER \(WHERE skipped = false AND bm\.id IS NOT NULL\) AS non_skip_count/.test(flat);
    const row = countsRow(Number(p[0]), crowdOnly);
    // POST /me reads the cached lock and number IN THE SAME STATEMENT as the
    // crowd count, so the two cannot come from different moments (a member
    // leaving between two statements would pair a count of three with a
    // number that now hides two). One snapshot, so the fixture answers both
    // from the same world state.
    if (/\(SELECT budget_locked FROM flocks WHERE id = \$1\) AS budget_locked/.test(flat)) {
      const f = world.flocks.get(Number(p[0]));
      row.budget_locked = f ? f.budget_locked : null;
      row.budget_ceiling = f ? f.budget_ceiling : null;
    }
    return { rows: [row], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\)::int AS n FROM /.test(flat) && overCrowd(flat)
      && /WHERE bs\.flock_id = \$1 AND (bs\.)?skipped = false$/.test(flat)) {
    return { rows: [{ n: memberSubmissions(Number(p[0])).filter((s) => !s.skipped).length }], rowCount: 1 };
  }
  if (/^UPDATE flocks SET budget_locked = true, budget_ceiling = \$2, updated_at = NOW\(\) WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    if (f) { f.budget_locked = true; f.budget_ceiling = p[1]; }
    return { rows: [], rowCount: f ? 1 : 0 };
  }
  // The reset: every row for the plan, then the lock lifted.
  if (/^DELETE FROM budget_submissions WHERE flock_id = \$1$/.test(flat)) {
    const before = world.submissions.length;
    world.submissions = world.submissions.filter((s) => s.flock_id !== Number(p[0]));
    return { rows: [], rowCount: before - world.submissions.length };
  }
  if (/^UPDATE flocks SET budget_locked = false, budget_ceiling = NULL, updated_at = NOW\(\) WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    if (f) { f.budget_locked = false; f.budget_ceiling = null; }
    return { rows: [], rowCount: f ? 1 : 0 };
  }

  // Who has to answer (routes/budget.js answeringPopulation), both halves.
  if (/^SELECT COUNT\(\*\) AS total FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    return { rows: [{ total: String(acceptedMembers(Number(p[0])).length) }], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\) AS total FROM guest_rsvps WHERE flock_id = \$1 AND status = 'in' AND COALESCE\(is_hidden, false\) = false$/.test(flat)) {
    return { rows: [{ total: String(inGuests(Number(p[0])).length) }], rowCount: 1 };
  }

  // Membership gate on the member door, and the fan-out rosters.
  if (/^SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'$/.test(flat)) {
    const m = acceptedMembers(Number(p[0])).find((x) => x.user_id === Number(p[1]));
    return m ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    const rows = acceptedMembers(Number(p[0])).map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
  }
  if (/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2$/.test(flat)) {
    const rows = acceptedMembers(Number(p[0])).filter((m) => m.user_id !== Number(p[1])).map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
  }

  // GET /:token: the going count, the roster, the tallies, the window.
  if (/::int AS members, .*::int AS guests, .*::int AS guest_rows$/.test(flat)) {
    const fid = Number(p[0]);
    return {
      rows: [{
        members: acceptedMembers(fid).length,
        guests: inGuests(fid).length,
        guest_rows: world.guests.filter((g) => g.flock_id === fid).length,
      }],
      rowCount: 1,
    };
  }
  if (/^SELECT u\.name AS name, fm\.status AS status, fm\.reconfirmed_at AS reconfirmed_at FROM flock_members fm JOIN users u ON u\.id = fm\.user_id WHERE fm\.flock_id = \$1/.test(flat)) {
    const rows = world.members.filter((m) => m.flock_id === Number(p[0]))
      .map((m) => ({ name: m.name, status: m.status, reconfirmed_at: m.reconfirmed_at }));
    return { rows, rowCount: rows.length };
  }
  if (/^SELECT name, status, reconfirmed_at FROM guest_rsvps WHERE flock_id = \$1 AND COALESCE\(is_hidden, false\) = false ORDER BY/.test(flat)) {
    const rows = world.guests.filter((g) => g.flock_id === Number(p[0]) && !g.is_hidden)
      .map((g) => ({ name: g.name, status: g.status, reconfirmed_at: g.reconfirmed_at }));
    return { rows, rowCount: rows.length };
  }
  if (/SUM\(CASE WHEN src = 'member'/.test(flat)) return { rows: [], rowCount: 0 };
  // The guest tally's cap counts only the member votes the tally counts
  // (accepted, not banned), so the statement joins the roster.
  if (/^SELECT COUNT\(\*\)::int AS n FROM venue_votes vv JOIN flock_members fm ON fm\.flock_id = vv\.flock_id AND fm\.user_id = vv\.user_id AND fm\.status = 'accepted' JOIN users u ON u\.id = vv\.user_id AND u\.is_banned IS NOT TRUE WHERE vv\.flock_id = \$1$/.test(flat)) return { rows: [{ n: 0 }], rowCount: 1 };
  if (/AS open, f\.event_time AS deadline/.test(flat)) {
    const row = reconfirmRow(Number(p[0]));
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  unknown.push(flat.slice(0, 160));
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => {
  poolCheckouts += 1;
  return { query: (sql, params) => dispatch(sql, params), release: () => {} };
};

// Replaced BEFORE the routers are required: routes/guest.js, routes/budget.js
// and the fan-out helpers all destructure these at module load.
const pushMod = require('../services/pushHelper');
let pushes = [];
pushMod.pushIfOffline = async (_io, userId, title, body, data) => { pushes.push({ userId, title, body, data }); return { sent: 1 }; };
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });
pushMod.pushAlways = async () => ({ skipped: true, reason: 'test' });

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };
authMod.requireVerified = (_req, _res, next) => { next(); };

const budgetRouter = require('../routes/budget');
const guest = require('../routes/guest');
const { bandCeiling, MEMBER_SUBMISSIONS, PRESENT_ANSWERS } = budgetRouter;
MS_FLAT = MEMBER_SUBMISSIONS.replace(/\s+/g, ' ').trim();
PA_FLAT = PRESENT_ANSWERS.replace(/\s+/g, ' ').trim();

let emits = [];
const io = {
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/guest', guest.router);
app.use('/api/budget', budgetRouter);

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
  world = freshWorld();
  log = [];
  unknown = [];
  emits = [];
  pushes = [];
  poolCheckouts = 0;
  guest.guestActionLog.clear();
  guest.newGuestLog.clear();
  budgetRouter.__resetReminderCooldowns();
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
  return { status: res.status, body: json, text, retryAfter: res.headers.get('retry-after') };
}
function ran(re) { return log.filter((q) => re.test(q.sql)); }

const LINK_TOKEN = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
// Synthetic counting patterns, resolved by the fixture above and seen by
// nothing outside this file. The secret scanner flags them on entropy alone.
const GUEST_A = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow
const GUEST_B = 'b1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow
const GUEST_C = 'c1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow
const NOBODY = 'd1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow

const AVA = { id: 1, name: 'Ava Brooks' };
const BOB = { id: 2, name: 'Bob Marley' };
const DEE = { id: 3, name: 'Dee Dee' };
const EVE = { id: 4, name: 'Eve Polastri' };
const CASS = { id: 7, token: GUEST_A, name: 'Cass Elliot' };
const EZRA = { id: 8, token: GUEST_B, name: 'Ezra Pound' };
const GIL = { id: 9, token: GUEST_C, name: 'Gil Scott' };

function seedFlock({
  members = [AVA, BOB], guests = [], locked = false, ceiling = null, status = 'planning',
  budget = true, eventTime = null, opened = null, context = null,
} = {}) {
  world.flocks.set(FLOCK, {
    id: FLOCK, name: 'Dinner', creator_id: AVA.id, host_name: AVA.name, venue_name: 'The Bar',
    status, event_time: eventTime, reconfirm_opened_at: opened,
    budget_enabled: budget, budget_context: context, budget_locked: locked, budget_ceiling: ceiling,
    ghost_mode_enabled: false,
  });
  for (const m of members) {
    world.members.push({ flock_id: FLOCK, user_id: m.id, name: m.name, status: m.status || 'accepted', reconfirmed_at: m.reconfirmed_at || null });
  }
  for (const g of guests) {
    world.guests.push({ flock_id: FLOCK, id: g.id, guest_token: g.token, name: g.name, status: g.status || 'in', is_hidden: !!g.hidden, reconfirmed_at: g.reconfirmed_at || null });
  }
}
const as = (id) => { CURRENT_USER = { id, name: `U${id}`, email_verified: true, role: 'user' }; };
const guestAnswer = (token, amount) => call('POST', `/api/guest/${LINK_TOKEN}/budget`, { guestToken: token, amount });
const guestSkip = (token) => call('POST', `/api/guest/${LINK_TOKEN}/budget`, { guestToken: token, amount: 0, skipped: true });
const me = (token) => call('POST', `/api/guest/${LINK_TOKEN}/me`, { guestToken: token });
const preview = () => call('GET', `/api/guest/${LINK_TOKEN}`);
const memberAnswer = (id, amount) => { as(id); return call('POST', `/api/budget/${FLOCK}/submit`, { amount }); };
const memberSkip = (id) => { as(id); return call('POST', `/api/budget/${FLOCK}/submit`, { amount: 0, skipped: true }); };
const memberStatus = (id) => { as(id); return call('GET', `/api/budget/${FLOCK}`); };
const lock = (id) => { as(id); return call('POST', `/api/budget/${FLOCK}/lock`); };
const reset = (id) => { as(id); return call('POST', `/api/budget/${FLOCK}/reset`); };
const guestRow = (id) => world.submissions.find((s) => s.guest_rsvp_id === id);

// The statements of the most recent transaction, in order, with BEGIN and its
// close left out.
function lastTransaction() {
  const sqls = log.map((q) => q.sql);
  const begin = sqls.lastIndexOf('BEGIN');
  assert.ok(begin >= 0, 'a transaction was opened');
  const end = sqls.findIndex((s, i) => i > begin && /^(COMMIT|ROLLBACK)/.test(s));
  assert.ok(end > begin, 'and closed');
  return { closedBy: sqls[end], statements: sqls.slice(begin + 1, end) };
}

// The four settle statements routes/budget.js settleIfComplete runs, as
// patterns, in the order it runs them. The totals statement counts the crowd
// inside the present rows: `bm.id IS NOT NULL` is the whole design change.
const SETTLE_SHAPE = [
  /^SELECT MIN\(amount\) AS ceiling FROM budget_submissions bs .* WHERE bs\.flock_id = \$1 AND skipped = false$/,
  /^SELECT COUNT\(\*\) AS total_submissions, COUNT\(\*\) FILTER \(WHERE skipped = false AND bm\.id IS NOT NULL\) AS non_skip_count, COUNT\(\*\) FILTER \(WHERE skipped = true\) AS skip_count FROM budget_submissions bs .* WHERE bs\.flock_id = \$1$/,
  /^SELECT COUNT\(\*\) AS total FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/,
  /^SELECT COUNT\(\*\) AS total FROM guest_rsvps WHERE flock_id = \$1 AND status = 'in' AND COALESCE\(is_hidden, false\) = false$/,
];

// ═════════════════════════════════════════════════════════════════════════════
// 1. The gates
// ═════════════════════════════════════════════════════════════════════════════

test('a guest with no RSVP row is 403, writes nothing, and costs no budget', async () => {
  seedFlock({ guests: [CASS] });
  const res = await guestAnswer(NOBODY, 50);
  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(ran(/INSERT INTO budget_submissions/).length, 0);
  assert.strictEqual(poolCheckouts, 0, 'refused before any transaction is opened');
  // The per-guest counter is keyed on a row id the database named. A token
  // nobody holds must not leave a key behind, or the map fills with invented
  // UUIDs (the unbounded-key problem the IP maps have).
  assert.strictEqual(guest.guestActionLog.size, 0);
  assert.strictEqual(emits.length, 0);
  assertQueriesUnderstood();
});

test('an out guest is 409 NOT_IN and writes nothing', async () => {
  // The budget ranges over people who are going. A guest who said out is not
  // in the denominator, so their number must not be in the numerator either.
  seedFlock({ guests: [{ ...CASS, status: 'out' }] });
  const res = await guestAnswer(GUEST_A, 50);
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'NOT_IN');
  assert.strictEqual(ran(/INSERT INTO budget_submissions/).length, 0);
  assert.strictEqual(poolCheckouts, 0);
  assert.strictEqual(guest.guestActionLog.size, 0, 'a refusal on the answer itself costs no budget');
  assertQueriesUnderstood();
});

test('a hidden row is 403, as if it never existed, and the lookup says so in SQL', async () => {
  // A moderator takedown has to hold on this door too: a hidden guest is not
  // a guest anywhere on the public surface, and the filter lives in the
  // statement rather than in a forgettable `if`.
  seedFlock({ guests: [{ ...CASS, hidden: true }] });
  const res = await guestAnswer(GUEST_A, 50);
  assert.strictEqual(res.status, 403, res.text);
  const lookup = ran(/FROM guest_rsvps WHERE guest_token = \$1 AND flock_id = \$2/)[0];
  assert.ok(lookup, 'the guest is looked up by token');
  assert.match(lookup.sql, /COALESCE\(is_hidden, false\) = false/);
  assert.strictEqual(ran(/INSERT INTO budget_submissions/).length, 0);
  assert.strictEqual(poolCheckouts, 0);
  assertQueriesUnderstood();
});

test('a locked budget is 409 BUDGET_LOCKED, writes nothing, and rolls back', async () => {
  // Refused in words rather than silently excluded (routes/budget.js says
  // why): a late number under the published cap would otherwise mean the
  // group is shown a cap a present person cannot afford.
  seedFlock({ guests: [CASS], locked: true, ceiling: 60 });
  const res = await guestAnswer(GUEST_A, 20);
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'BUDGET_LOCKED');
  assert.strictEqual(ran(/INSERT INTO budget_submissions/).length, 0, 'nothing written under a lock');
  assert.strictEqual(ran(/UPDATE flocks/).length, 0);
  const tx = lastTransaction();
  assert.strictEqual(tx.closedBy, 'ROLLBACK');
  assert.deepStrictEqual(tx.statements, ['SELECT budget_enabled, budget_locked, status FROM flocks WHERE id = $1 FOR UPDATE'],
    'the lock is read under FOR UPDATE and nothing else runs');
  assert.strictEqual(emits.length, 0, 'and nobody is told anything changed');
  assert.strictEqual(world.flocks.get(FLOCK).budget_ceiling, 60, 'the published number is untouched');
  assertQueriesUnderstood();
});

test('a plan that is over is 409 before the guest is even looked up', async () => {
  seedFlock({ guests: [CASS], status: 'cancelled' });
  const res = await guestAnswer(GUEST_A, 50);
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(ran(/FROM guest_rsvps WHERE guest_token/).length, 0);
  assert.strictEqual(poolCheckouts, 0);
  assertQueriesUnderstood();
});

test('a bad amount is 400 and never reaches the guest row', async () => {
  seedFlock({ guests: [CASS] });
  // Shape is settled by the validator chain before anything is looked up
  // (the same two validators the member door carries: an array amount would
  // reach DECIMAL as '{50}', a string skip flag would read as a skip).
  for (const body of [
    { guestToken: GUEST_A, amount: 20000 },
    { guestToken: GUEST_A, amount: ['50'] },
    { guestToken: GUEST_A, amount: 50, skipped: ['false'] },
    { guestToken: 'not-a-uuid', amount: 50 },
  ]) {
    log = [];
    const res = await call('POST', `/api/guest/${LINK_TOKEN}/budget`, body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
    assert.strictEqual(log.length, 0, `${JSON.stringify(body)} reached the database`);
  }
  // A missing or zero amount without a skip passes the validator (checkFalsy
  // is what lets the Skip button post amount: 0) and is refused in words by
  // the handler, after the link resolves and before the guest is looked up.
  for (const body of [{ guestToken: GUEST_A, amount: 0 }, { guestToken: GUEST_A }]) {
    log = [];
    const res = await call('POST', `/api/guest/${LINK_TOKEN}/budget`, body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
    assert.match(res.body.error, /Amount is required when not skipping/);
    assert.strictEqual(ran(/FROM guest_rsvps/).length, 0, 'no guest is looked up for an answer with no number');
    assert.strictEqual(poolCheckouts, 0);
  }
  assert.strictEqual(ran(/INSERT INTO budget_submissions/).length, 0);
  assertQueriesUnderstood();
});

test('over the per-guest budget is 429 with a real wait, and the refused answer writes nothing', async () => {
  // This is the unauthenticated write surface: each accepted answer is a
  // pool checkout, a row lock, a settle and a fan-out to every member. The
  // ceiling is the same GUEST_ACTIONS_PER_HOUR the RSVP and vote doors share,
  // keyed on the row id the database named, so re-spelling the token buys
  // nothing (guestSurfaceAbuse pins that on the other doors).
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  const limit = guest.GUEST_ACTIONS_PER_HOUR;
  let refusedAt = null;
  let refused = null;
  for (let i = 0; i < limit + 5; i++) {
    log = [];
    poolCheckouts = 0;
    const res = await guestAnswer(GUEST_A, 10 + i);
    if (res.status === 429) { refusedAt = i; refused = res; break; }
    assert.strictEqual(res.status, 200, res.text);
  }
  assert.strictEqual(refusedAt, limit, `the ceiling must bite at exactly ${limit} answers`);
  assert.strictEqual(ran(/INSERT INTO budget_submissions/).length, 0, 'the refused answer is not written');
  assert.strictEqual(poolCheckouts, 0, 'and opens no transaction');
  assert.ok(refused.retryAfter && Number(refused.retryAfter) >= 1, 'Retry-After is set');
  assert.match(refused.body.error, /in (about|under) (a|an|\d+) ?(minute|minutes|hour|hours)?|in a moment/,
    'the refusal names a window a person can act on');
  assert.strictEqual(Number(guestRow(CASS.id).amount), 10 + limit - 1, 'the last accepted answer is the one that stands');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The write
// ═════════════════════════════════════════════════════════════════════════════

test('the guest upsert is keyed on the RSVP row and never on a user', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  const first = await guestAnswer(GUEST_A, 43.21);
  assert.strictEqual(first.status, 200, first.text);
  const ins = ran(/INSERT INTO budget_submissions/);
  assert.strictEqual(ins.length, 1);
  assert.match(ins[0].sql, /^INSERT INTO budget_submissions \(flock_id, guest_rsvp_id, amount, skipped, updated_at\) VALUES \(\$1, \$2, \$3, \$4, NOW\(\)\)/);
  assert.match(ins[0].sql, /ON CONFLICT \(flock_id, guest_rsvp_id\) DO UPDATE SET amount = \$3, skipped = \$4, updated_at = NOW\(\)/);
  assert.ok(!/user_id/.test(ins[0].sql), 'a guest row has no user on it');
  assert.deepStrictEqual(ins[0].params, [FLOCK, CASS.id, 43.21, false]);

  // A second answer is the same row, changed, not a second row: the UNIQUE in
  // migration 071 is what the conflict target names.
  const second = await guestAnswer(GUEST_A, 55);
  assert.strictEqual(second.status, 200, second.text);
  assert.strictEqual(world.submissions.filter((s) => s.guest_rsvp_id === CASS.id).length, 1);
  assert.strictEqual(Number(guestRow(CASS.id).amount), 55);
  assertQueriesUnderstood();
});

test('a skip is written as a skip: no amount, and it counts as answered but not as shared', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  const res = await guestSkip(GUEST_A);
  assert.strictEqual(res.status, 200, res.text);
  const ins = ran(/INSERT INTO budget_submissions/)[0];
  assert.deepStrictEqual(ins.params, [FLOCK, CASS.id, null, true]);
  assert.strictEqual(res.body.submissionCount, 1, 'a skip is an answer');
  assert.strictEqual(res.body.isReady, false, 'and not an amount');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The settle
// ═════════════════════════════════════════════════════════════════════════════

test('after the upsert the guest door runs the member door\'s settle statements, in order, inside one transaction', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });

  // The member door first, as the reference: what POST /api/budget/:id/submit
  // runs after its own INSERT is the sequence the privacy fixtures model.
  const member = await memberAnswer(AVA.id, 60);
  assert.strictEqual(member.status, 200, member.text);
  const memberTx = lastTransaction();
  const memberInsert = memberTx.statements.findIndex((s) => /^INSERT INTO budget_submissions/.test(s));
  assert.ok(memberInsert >= 0);
  const memberSettle = memberTx.statements.slice(memberInsert + 1);

  log = [];
  const res = await guestAnswer(GUEST_A, 80);
  assert.strictEqual(res.status, 200, res.text);
  const tx = lastTransaction();
  assert.strictEqual(tx.closedBy, 'COMMIT');
  assert.match(tx.statements[0], /^SELECT budget_enabled, budget_locked, status FROM flocks WHERE id = \$1 FOR UPDATE$/,
    'the flock row is held first, so exactly one answer can settle');
  assert.match(tx.statements[1], /^INSERT INTO budget_submissions \(flock_id, guest_rsvp_id/);
  const settle = tx.statements.slice(2);
  assert.strictEqual(settle.length, SETTLE_SHAPE.length, `settle statements: ${JSON.stringify(settle)}`);
  SETTLE_SHAPE.forEach((re, i) => assert.match(settle[i], re, `statement ${i} after the upsert`));
  // The MIN and the totals read through the widened fragment, and the
  // threshold inside the totals is the crowd; the fixture would have refused
  // a MIN or a totals over the crowd alone, but say it here too.
  assert.ok(settle[0].includes(PA_FLAT) && settle[1].includes(PA_FLAT), 'the MIN and the totals range over everyone present');
  assert.ok(!settle[0].includes(MS_FLAT) && !settle[1].includes(MS_FLAT));
  // Byte-identical to the member door. A second door that recomputed these
  // its own way is the "one of the readers forgot" finding routes/budget.js
  // has already had twice.
  assert.deepStrictEqual(settle, memberSettle, 'the two doors settle with the same statements');
  assertQueriesUnderstood();
});

test('the flock locks only when everyone has answered and three MEMBERS have shared: a guest row is waited for and can bind the number, and never makes three', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS, EZRA] });

  // Two members and one guest have shared amounts. Three amounts on the
  // table, but only two of them are from the crowd, so nothing is publishable
  // yet, and two people have still to answer.
  assert.strictEqual((await memberAnswer(AVA.id, 60)).status, 200);
  assert.strictEqual((await memberAnswer(BOB.id, 70)).status, 200);
  const third = await guestAnswer(GUEST_A, 43);
  assert.strictEqual(third.status, 200, third.text);
  assert.strictEqual(third.body.isReady, false, 'three amounts, but a guest is not one of the three');
  assert.strictEqual(third.body.budgetLocked, false);
  assert.strictEqual(third.body.ceiling, null);
  assert.strictEqual(third.body.submissionCount, 3, 'the guest\'s row is an answer all the same');
  assert.strictEqual(third.body.totalMembers, 5, 'three members and two visible in guests');

  // The third member shares. A number is publishable now, and it is still
  // withheld, because a present guest has not answered and the settle waits
  // for their row exactly as it waits for a member's.
  const fourth = await memberAnswer(DEE.id, 65);
  assert.strictEqual(fourth.status, 200, fourth.text);
  assert.strictEqual(fourth.body.isReady, true, 'three members have shared');
  assert.strictEqual(fourth.body.budgetLocked, false, 'but one present guest has not answered');
  assert.strictEqual(fourth.body.ceiling, null);
  assert.strictEqual(fourth.body.submissionCount, 4);
  assert.strictEqual(ran(/UPDATE flocks SET budget_locked/).length, 0);
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, false);

  // The last guest answers, and that answer settles it: locked in the same
  // transaction, the band published once. The band is the first guest's $43
  // banded down, because a cap somebody going cannot afford is not a cap:
  // the guest's cent binds the number once three members have shared.
  log = [];
  const last = await guestAnswer(GUEST_B, 90);
  assert.strictEqual(last.status, 200, last.text);
  assert.strictEqual(last.body.budgetLocked, true);
  assert.strictEqual(last.body.ceiling, 40, 'MIN is the guest\'s $43, banded down to $40');
  assert.strictEqual(last.body.ceiling, bandCeiling(43));
  assert.strictEqual(last.body.submissionCount, 5);
  const tx = lastTransaction();
  const locked = tx.statements.findIndex((s) => /^UPDATE flocks SET budget_locked = true, budget_ceiling = \$2/.test(s));
  assert.ok(locked > 0, 'the lock is written inside the answer\'s own transaction');
  assert.strictEqual(tx.closedBy, 'COMMIT');
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, true);
  assert.strictEqual(world.flocks.get(FLOCK).budget_ceiling, 40, 'the cached column holds the band');

  // Both doors are shut from here.
  const lateMember = await memberAnswer(AVA.id, 10);
  assert.strictEqual(lateMember.status, 409, lateMember.text);
  const lateGuest = await guestAnswer(GUEST_A, 10);
  assert.strictEqual(lateGuest.status, 409, lateGuest.text);
  assert.strictEqual(lateGuest.body.code, 'BUDGET_LOCKED');
  assertQueriesUnderstood();
});

test('one member and any number of guest amounts is never ready, never settles, and /lock refuses it', async () => {
  // The shape the review found: a creator alone in a plan, holding the link,
  // mints guests and answers for them. Everyone has answered, four amounts
  // are on the table, and there is still nobody for the creator's number to
  // hide among.
  seedFlock({ members: [AVA], guests: [CASS, EZRA, GIL] });
  assert.strictEqual((await guestAnswer(GUEST_A, 70)).status, 200);
  assert.strictEqual((await guestAnswer(GUEST_B, 80)).status, 200);
  assert.strictEqual((await guestAnswer(GUEST_C, 90)).status, 200);
  const last = await memberAnswer(AVA.id, 60);
  assert.strictEqual(last.status, 200, last.text);
  assert.strictEqual(last.body.submissionCount, 4);
  assert.strictEqual(last.body.totalMembers, 4, 'everyone who has to answer has');
  assert.strictEqual(last.body.isReady, false, 'and it is one member, however many guests');
  assert.strictEqual(last.body.budgetLocked, false);
  assert.strictEqual(last.body.ceiling, null);
  assert.strictEqual(ran(/UPDATE flocks SET budget_locked/).length, 0);
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, false);

  // The creator's Lock button is gated on the same crowd, in SQL, over the
  // accounts-only fragment: the guest rows are not in the statement at all.
  log = [];
  const res = await lock(AVA.id);
  assert.strictEqual(res.status, 400, res.text);
  assert.match(res.body.error, /3 people have shared an amount/);
  const count = ran(/^SELECT COUNT\(\*\)::int AS n FROM /);
  assert.strictEqual(count.length, 1, 'one threshold count');
  assert.ok(count[0].sql.includes(MS_FLAT), 'counted over MEMBER_SUBMISSIONS');
  assert.ok(!count[0].sql.includes(PA_FLAT) && !/guest_rsvps/.test(count[0].sql), 'and never over the widened fragment');
  assert.strictEqual(lastTransaction().closedBy, 'ROLLBACK');
  assert.strictEqual(ran(/UPDATE flocks SET budget_locked/).length, 0);
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, false);

  // The link reads the same answer: not ready, not locked, no number.
  const mine = await me(GUEST_A);
  assert.strictEqual(mine.status, 200, mine.text);
  assert.strictEqual(mine.body.budget.isReady, false);
  assert.strictEqual(mine.body.budget.locked, false);
  assert.strictEqual(mine.body.budget.ceiling, null);
  assertQueriesUnderstood();
});

test('an out guest is not waited for, so the plan settles without them', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS, { ...EZRA, status: 'out' }] });
  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  await memberAnswer(DEE.id, 75);
  const res = await guestAnswer(GUEST_A, 80);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.totalMembers, 4, 'the out guest is not in the denominator');
  assert.strictEqual(res.body.budgetLocked, true, 'four of four answered, three members among them');
  assert.strictEqual(res.body.ceiling, 60);
  assertQueriesUnderstood();
});

test('a hidden guest\'s cent does not set the group\'s number', async () => {
  // The guest arm of PRESENT_ANSWERS is gated on presence for the reason the
  // member arm is: a stranger holding the link could otherwise park a cent
  // on the plan from a row nobody can see.
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  const cent = await guestAnswer(GUEST_A, 0.01);
  assert.strictEqual(cent.status, 200, cent.text);
  // A moderator hides the row. The submission stays in the table.
  world.guests.find((g) => g.id === CASS.id).is_hidden = true;
  assert.ok(guestRow(CASS.id), 'the row is still there');

  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  const settling = await memberAnswer(DEE.id, 80);
  assert.strictEqual(settling.status, 200, settling.text);
  assert.strictEqual(settling.body.totalMembers, 3, 'the hidden guest is not counted');
  assert.strictEqual(settling.body.submissionCount, 3, 'and neither is their row');
  assert.strictEqual(settling.body.budgetLocked, true);
  assert.strictEqual(settling.body.ceiling, 60, 'the group settles on what its present people can spend');
  assertQueriesUnderstood();
});

test('a guest who flips to out stops counting, and counts again if they come back', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  await guestAnswer(GUEST_A, 5);
  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  world.guests.find((g) => g.id === CASS.id).status = 'out';
  let s = await memberStatus(AVA.id);
  assert.strictEqual(s.body.submissionCount, 2, 'the out guest\'s answer is inert');
  assert.strictEqual(s.body.totalMembers, 3);
  world.guests.find((g) => g.id === CASS.id).status = 'in';
  s = await memberStatus(AVA.id);
  assert.strictEqual(s.body.submissionCount, 3, 'and live again once they are back in');
  assert.strictEqual(s.body.totalMembers, 4);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The publication
// ═════════════════════════════════════════════════════════════════════════════

test('a guest\'s answer carries only the aggregate: no amount, no name, no ceiling before the settle', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  await memberAnswer(AVA.id, 61.5);
  await memberAnswer(BOB.id, 77);
  emits = [];
  const res = await guestAnswer(GUEST_A, 43.21);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(Object.keys(res.body).sort(), [
    'budgetLocked', 'ceiling', 'isReady', 'skipCount', 'submissionCount', 'submitted', 'totalMembers', 'userSubmitted',
  ]);
  assert.strictEqual(res.body.isReady, false, 'three amounts, two of them from members');
  assert.strictEqual(res.body.ceiling, null, 'and one member has not answered');
  assert.strictEqual(res.body.skipCount, null);
  assert.strictEqual(res.body.budgetLocked, false);
  assert.strictEqual(res.body.userSubmitted, true);
  for (const secret of ['43.21', '61.5', '77', 'Cass', 'Ava', 'Bob']) {
    assert.ok(!res.text.includes(secret), `${secret} reached the wire`);
  }
  // The room hears the same aggregate, and only that.
  const updates = emits.filter((e) => e.event === 'budget_updated');
  assert.deepStrictEqual(updates.map((e) => e.room).sort(), ['user:1', 'user:2', 'user:3']);
  for (const u of updates) {
    assert.strictEqual(u.payload.ceiling, null);
    assert.ok(!JSON.stringify(u.payload).includes('43.21'));
  }
  assert.strictEqual(pushes.length, 0, 'nothing settled, so nothing to announce');
  assertQueriesUnderstood();
});

test('the settling answer publishes the band once, to the guest and to the room alike, and pushes every member', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  await memberAnswer(AVA.id, 123.45);
  await memberAnswer(BOB.id, 140);
  await memberAnswer(DEE.id, 160);
  emits = [];
  const res = await guestAnswer(GUEST_A, 150);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.budgetLocked, true);
  assert.strictEqual(res.body.ceiling, 120, 'MIN $123.45 banded down to $120');
  assert.strictEqual(res.body.ceiling, bandCeiling(123.45));
  assert.ok(!res.text.includes('123.45'), 'the raw MIN never crosses');

  const updates = emits.filter((e) => e.event === 'budget_updated');
  assert.deepStrictEqual(updates.map((e) => e.room).sort(), ['user:1', 'user:2', 'user:3']);
  for (const u of updates) {
    assert.strictEqual(u.payload.ceiling, 120, 'the socket carries the same value the response does');
    assert.strictEqual(u.payload.budgetLocked, true);
  }
  // A guest has no account to leave out of the fan-out, so every accepted
  // member hears "Budget set!".
  assert.deepStrictEqual(pushes.map((p) => p.userId).sort(), [1, 2, 3]);
  for (const p of pushes) {
    assert.strictEqual(p.title, 'Budget set!');
    assert.match(p.body, /up to \$120 for Dinner/);
    assert.deepStrictEqual(p.data, { type: 'budget_ready', flockId: String(FLOCK) });
  }
  assertQueriesUnderstood();
});

test('the skip/share split is published over the crowd, never the population', async () => {
  // publishableSkipCount withholds the split below three co-members. The
  // co-members it means are MEMBERS: "1 skipped" over a population of five
  // still names a person when only two of the other four hold accounts, and
  // the two guest rows that pushed the population over the floor were minted
  // by whoever holds the link. Three members and two guests, one guest
  // skipped, everyone answered: settled, and the split withheld.
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS, EZRA] });
  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  await memberAnswer(DEE.id, 80);
  await guestAnswer(GUEST_A, 90);
  emits = [];
  const settling = await guestSkip(GUEST_B);
  assert.strictEqual(settling.status, 200, settling.text);
  assert.strictEqual(settling.body.budgetLocked, true, 'five of five answered, three members shared');
  assert.strictEqual(settling.body.totalMembers, 5);
  assert.strictEqual(settling.body.ceiling, 60);
  assert.strictEqual(settling.body.skipCount, null, 'a population of five over a crowd of three withholds the split');
  for (const u of emits.filter((e) => e.event === 'budget_updated')) {
    assert.strictEqual(u.payload.skipCount, null, 'the room hears the same withholding');
  }

  // Four members, one of whom skipped, and one guest: the crowd is four, so
  // the settling answer carries the split, once, and the count includes the
  // skip whoever made it.
  world = freshWorld();
  emits = [];
  guest.guestActionLog.clear();
  seedFlock({ members: [AVA, BOB, DEE, EVE], guests: [CASS] });
  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  await memberAnswer(DEE.id, 80);
  await memberSkip(EVE.id);
  emits = [];
  const published = await guestAnswer(GUEST_A, 90);
  assert.strictEqual(published.status, 200, published.text);
  assert.strictEqual(published.body.budgetLocked, true);
  assert.strictEqual(published.body.skipCount, 1, 'four members: the split goes out with the settle');
  for (const u of emits.filter((e) => e.event === 'budget_updated')) {
    assert.strictEqual(u.payload.skipCount, 1);
  }
  assertQueriesUnderstood();
});

test('POST /me answers a guest their own row and nothing of anyone else\'s', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  await memberAnswer(AVA.id, 61.5);
  await memberAnswer(BOB.id, 77);
  await guestAnswer(GUEST_A, 43.21);

  const res = await me(GUEST_A);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.name, CASS.name);
  assert.strictEqual(res.body.status, 'in');
  assert.strictEqual(res.body.reconfirmed, false);
  assert.strictEqual(res.body.reconfirm, null, 'no window has been opened');
  assert.deepStrictEqual(Object.keys(res.body.budget).sort(), [
    'ceiling', 'context', 'enabled', 'isReady', 'locked', 'submissionCount', 'totalMembers', 'userAmount', 'userSkipped', 'userSubmitted',
  ]);
  assert.strictEqual(res.body.budget.userSubmitted, true);
  assert.strictEqual(res.body.budget.userAmount, 43.21, 'only the caller\'s own figure comes back');
  assert.strictEqual(res.body.budget.userSkipped, false);
  assert.strictEqual(res.body.budget.submissionCount, 3);
  assert.strictEqual(res.body.budget.totalMembers, 4);
  assert.strictEqual(res.body.budget.isReady, false, 'the guest\'s own amount is not one of the three');
  assert.strictEqual(res.body.budget.locked, false);
  assert.strictEqual(res.body.budget.ceiling, null, 'not settled, so no number');
  for (const secret of ['61.5', '77', 'Ava', 'Bob', 'Dee']) {
    assert.ok(!res.text.includes(secret), `${secret} reached the wire`);
  }
  // The own-row read is by the guest's row id, never by a user.
  const own = ran(/^SELECT amount, skipped FROM budget_submissions WHERE flock_id = \$1 AND guest_rsvp_id = \$2$/);
  assert.strictEqual(own.length, 1);
  assert.deepStrictEqual(own[0].params, [FLOCK, CASS.id]);
  assertQueriesUnderstood();
});

test('POST /me hands the band to an in guest only once locked, and only while three MEMBER sharers exist', async () => {
  // Settled by a member's answer: three members and the guest, four amounts,
  // and the guest's $50 is the MIN.
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  await guestAnswer(GUEST_A, 50);
  await memberAnswer(AVA.id, 123.45);
  await memberAnswer(BOB.id, 140);
  const settling = await memberAnswer(DEE.id, 160);
  assert.strictEqual(settling.body.budgetLocked, true);
  assert.strictEqual(settling.body.ceiling, 50, 'the guest\'s $50 is the MIN');

  let res = await me(GUEST_A);
  assert.strictEqual(res.body.budget.locked, true);
  assert.strictEqual(res.body.budget.ceiling, 50, 'locked, three member sharers, in: the band reaches the guest');
  assert.strictEqual(res.body.budget.userAmount, 50);

  // Two members leave. One member sharer is below the floor, so the number
  // is withheld from this reader as it is from every other reader of it
  // (budgetCeilingReadParity pins the member-side readers).
  world.members = world.members.filter((m) => m.user_id !== BOB.id && m.user_id !== DEE.id);
  res = await me(GUEST_A);
  assert.strictEqual(res.body.budget.locked, true, 'still locked');
  assert.strictEqual(res.body.budget.isReady, false);
  assert.strictEqual(res.body.budget.ceiling, null, 'and withheld under three member sharers');
  assert.strictEqual(res.body.budget.userAmount, 50, 'their own figure is still theirs');

  // A second guest with an amount on the plan does not restore it. Three
  // present sharers (one member, two guests) is what the old rule counted;
  // the crowd is still one.
  world.guests.push({ flock_id: FLOCK, id: EZRA.id, guest_token: EZRA.token, name: EZRA.name, status: 'in', is_hidden: false, reconfirmed_at: null });
  world.submissions.push({ flock_id: FLOCK, user_id: null, guest_rsvp_id: EZRA.id, amount: 55, skipped: false });
  res = await me(GUEST_A);
  assert.strictEqual(res.body.budget.submissionCount, 3, 'three present rows');
  assert.strictEqual(res.body.budget.isReady, false, 'and still one member among them');
  assert.strictEqual(res.body.budget.ceiling, null);
  assertQueriesUnderstood();
});

test('POST /me withholds the band from a guest who said out, even when the flock is locked', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  await guestAnswer(GUEST_A, 50);
  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  const settling = await memberAnswer(DEE.id, 80);
  assert.strictEqual(settling.body.budgetLocked, true);

  world.guests.find((g) => g.id === CASS.id).status = 'out';
  const res = await me(GUEST_A);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.status, 'out');
  assert.strictEqual(res.body.budget.locked, true);
  assert.strictEqual(res.body.budget.ceiling, null, 'the group\'s number is for people who are going');
  assert.strictEqual(res.body.budget.userAmount, 50, 'their own row is still theirs to see');
  assert.ok(!res.text.includes('"60"') && !res.text.includes(':60'), 'no other amount, and not the band either');
  assertQueriesUnderstood();
});

test('POST /me withholds the band before the settle, whatever the count says', async () => {
  // isReady is "a number could be published", never "here it is". Without
  // the lock gate this route is a poll of the live minimum, which is the
  // oracle the whole differencing attack is built on. Three members have
  // shared and a second guest has not answered, so ready and not settled.
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS, EZRA] });
  await guestAnswer(GUEST_A, 50);
  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  await memberAnswer(DEE.id, 75);
  const res = await me(GUEST_A);
  assert.strictEqual(res.body.budget.isReady, true);
  assert.strictEqual(res.body.budget.locked, false);
  assert.strictEqual(res.body.budget.ceiling, null);
  assertQueriesUnderstood();
});

test('POST /me is 403 with no row and 403 with a hidden row, and reads no counts for either', async () => {
  seedFlock({ members: [AVA, BOB], guests: [{ ...CASS, hidden: true }] });
  for (const token of [NOBODY, GUEST_A]) {
    log = [];
    const res = await me(token);
    assert.strictEqual(res.status, 403, `${token} -> ${res.text}`);
    assert.strictEqual(ran(/total_submissions/).length, 0, 'no aggregate is computed for a stranger');
  }
  assertQueriesUnderstood();
});

test('POST /me spends a read budget: the 121st reload of one row in an hour is 429 with a real wait, and another row\'s allowance is separate', async () => {
  // The page asks /me on every load and each answer costs about eight
  // statements, so a link holder reloading in a loop is the cheapest read
  // amplifier on the unauthenticated surface. Keyed on the row id, like the
  // action budget, so re-spelling the token buys nothing. These two rows are
  // used by no other case in this file: the read counter is process-wide and
  // nothing here clears it, so a row exhausted in this case stays exhausted
  // for the hour.
  const READER = { id: 91, token: GUEST_A, name: 'Cass Elliot' };
  const OTHER = { id: 92, token: GUEST_B, name: 'Ezra Pound' };
  seedFlock({ members: [AVA, BOB, DEE], guests: [READER, OTHER] });
  await guestAnswer(GUEST_A, 45);
  const limit = 120;
  let refusedAt = null;
  let refused = null;
  for (let i = 0; i < limit + 5; i++) {
    log = [];
    const res = await me(GUEST_A);
    if (res.status === 429) { refusedAt = i; refused = res; break; }
    assert.strictEqual(res.status, 200, `reload ${i}: ${res.text}`);
  }
  assert.strictEqual(refusedAt, limit, `the ceiling must bite at exactly ${limit} reloads`);
  assert.ok(refused.retryAfter && Number(refused.retryAfter) >= 1, 'Retry-After is set');
  assert.match(refused.body.error, /Try again in (about|under) (a|an|\d+) ?(minute|minutes|hour|hours)?|Try again in a moment/,
    'the refusal names a window a person can act on');
  // Spent right after the guest lookup, before anything is counted: a
  // refused reload costs the row lookup and nothing else.
  assert.strictEqual(ran(/total_submissions/).length, 0, 'the refused reload counts nothing');
  assert.strictEqual(ran(/^SELECT budget_locked, budget_ceiling FROM flocks/).length, 0, 'and reads no number');
  assert.strictEqual(ran(/AS open, f\.event_time AS deadline/).length, 0);
  // The refusal carries a wait and nothing of the row: no budget block, no
  // amount, no name. (Not a search for the digits of the amount: a 429 body
  // names a retry instant, and a clock can contain any two digits.)
  assert.ok(!('budget' in (refused.body || {})) && !/"userAmount"|"amount"|"name"/.test(refused.text), 'and hands back no row');

  // A different row, same link: its own allowance, untouched.
  const other = await me(GUEST_B);
  assert.strictEqual(other.status, 200, other.text);
  assert.strictEqual(other.body.name, OTHER.name);
  // The action budget is a separate ledger: 120 reloads did not spend it.
  assert.strictEqual(guest.guestActionLog.get(String(READER.id)).count, 1, 'one answer, one action unit');
  assertQueriesUnderstood();
});

test('POST /me carries the night-of window only while it is open, and the guest\'s own answer to it', async () => {
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const passed = new Date(Date.now() - 3600 * 1000).toISOString();

  // Never opened: nothing to say, and the state query is not even run.
  seedFlock({ members: [AVA, BOB], guests: [CASS], status: 'confirmed', eventTime: soon });
  let res = await me(GUEST_A);
  assert.strictEqual(res.body.reconfirm, null);
  assert.strictEqual(ran(/AS open, f\.event_time AS deadline/).length, 0, 'a plan with no window costs nothing here');

  // Opened and ahead: open, with the count over both rosters.
  world = freshWorld();
  seedFlock({
    members: [{ ...AVA, reconfirmed_at: passed }, BOB], guests: [{ ...CASS, reconfirmed_at: passed }],
    status: 'confirmed', eventTime: soon, opened: passed,
  });
  res = await me(GUEST_A);
  assert.deepStrictEqual(res.body.reconfirm, { open: true, deadline: soon, count: 2, total: 3 });
  assert.strictEqual(res.body.reconfirmed, true);

  // Opened, but the plan's time has passed: closed, so null.
  world = freshWorld();
  seedFlock({ members: [AVA, BOB], guests: [CASS], status: 'confirmed', eventTime: passed, opened: passed });
  res = await me(GUEST_A);
  assert.strictEqual(res.body.reconfirm, null);
  assertQueriesUnderstood();
});

test('GET /:token carries the budget as counts and never a ceiling key', async () => {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS], context: 'Dinner and drinks' });
  await memberAnswer(AVA.id, 123.45);
  await memberAnswer(BOB.id, 140);
  await memberAnswer(DEE.id, 160);
  const settling = await guestAnswer(GUEST_A, 150);
  assert.strictEqual(settling.body.budgetLocked, true, 'settled, with a band cached on the flock');
  assert.strictEqual(world.flocks.get(FLOCK).budget_ceiling, 120);

  const res = await preview();
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.budget, {
    enabled: true, context: 'Dinner and drinks', locked: true, submissionCount: 4, totalMembers: 4, isReady: true,
  });
  assert.ok(!('ceiling' in res.body.budget), 'the public read never carries the group\'s number');
  for (const secret of ['120', '123.45', '140', '150', '160']) {
    assert.ok(!res.text.includes(secret), `${secret} reached the public page`);
  }
  assertQueriesUnderstood();
});

test('GET /:token says budget: null when the plan is not matching budgets, without counting anything', async () => {
  seedFlock({ members: [AVA, BOB], guests: [CASS], budget: false });
  const res = await preview();
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.budget, null);
  assert.strictEqual(ran(/total_submissions/).length, 0);
  assertQueriesUnderstood();
});

test('GET /:token: reconfirm is null unless the window is open, and the roster says who has reconfirmed only inside it', async () => {
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const passed = new Date(Date.now() - 3600 * 1000).toISOString();

  // No window: null, and the state is not asked for.
  seedFlock({ members: [AVA, BOB], guests: [CASS], status: 'confirmed', eventTime: soon });
  let res = await preview();
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.reconfirm, null);
  assert.strictEqual(ran(/AS open, f\.event_time AS deadline/).length, 0);
  assert.ok(Array.isArray(res.body.people) && res.body.people.length === 3);
  for (const p of res.body.people) {
    assert.strictEqual(typeof p.reconfirmed, 'boolean', `${p.name} carries a boolean`);
    assert.strictEqual(p.reconfirmed, false);
  }

  // Open: the window, and who has answered it, by first name only.
  world = freshWorld();
  seedFlock({
    members: [{ ...AVA, reconfirmed_at: passed }, BOB],
    guests: [{ ...CASS, reconfirmed_at: passed }, { ...EZRA, status: 'out' }],
    status: 'confirmed', eventTime: soon, opened: passed,
  });
  res = await preview();
  assert.deepStrictEqual(res.body.reconfirm, { open: true, deadline: soon, count: 2, total: 3 });
  const byName = Object.fromEntries(res.body.people.map((p) => [p.name, p]));
  assert.deepStrictEqual(byName.Ava, { name: 'Ava', rsvp: 'in', kind: 'member', reconfirmed: true });
  assert.deepStrictEqual(byName.Bob, { name: 'Bob', rsvp: 'in', kind: 'member', reconfirmed: false });
  assert.deepStrictEqual(byName.Cass, { name: 'Cass', rsvp: 'in', kind: 'guest', reconfirmed: true });
  assert.deepStrictEqual(byName.Ezra, { name: 'Ezra', rsvp: 'out', kind: 'guest', reconfirmed: false });

  // Opened, then the plan's time passed: closed, so null again, and the
  // answers still on the rows are not listed. A link to a past plan must
  // not say who said still-in that night; "reconfirmed" is a fact about an
  // open window and nothing else.
  world = freshWorld();
  seedFlock({
    members: [{ ...AVA, reconfirmed_at: passed }, BOB],
    guests: [{ ...CASS, reconfirmed_at: passed }],
    status: 'confirmed', eventTime: passed, opened: passed,
  });
  res = await preview();
  assert.strictEqual(res.body.reconfirm, null);
  assert.strictEqual(res.body.people.length, 3);
  for (const p of res.body.people) {
    assert.strictEqual(p.reconfirmed, false, `${p.name} answered a window that has closed`);
  }
  assertQueriesUnderstood();
});

test('the link and the app read the same "n of m answered"', async () => {
  // The guest page and the member's budget screen must agree, or one side is
  // waiting on a person the other side is not counting.
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS, { ...EZRA, status: 'out' }] });
  await memberAnswer(AVA.id, 60);
  await guestAnswer(GUEST_A, 70);
  const link = await preview();
  const member = await memberStatus(BOB.id);
  assert.strictEqual(link.body.budget.submissionCount, member.body.submissionCount);
  assert.strictEqual(link.body.budget.totalMembers, member.body.totalMembers);
  assert.strictEqual(link.body.budget.isReady, member.body.isReady);
  assert.strictEqual(link.body.budget.totalMembers, 4, 'three members and the one guest who is in');
  assert.strictEqual(link.body.budget.submissionCount, 2);
  assertQueriesUnderstood();
});

test('resolveLink asks the database for every column the guest routes read off the link, and no longer a ceiling', () => {
  // The fixture answers with whatever shape it is given, so it cannot notice
  // a column vanishing from the projection. Both the GET and POST /me read
  // budget_enabled and reconfirm_opened_at from the link row to decide
  // whether to ask anything further; a projection that lost either would
  // quietly answer "no budget" and "no window" for every plan.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'guest.js'), 'utf8').replace(/\s+/g, ' ');
  const at = src.indexOf('async function resolveLink(token)');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('return r.rows[0] || null', at));
  for (const col of ['f.budget_enabled', 'f.budget_context', 'f.budget_locked', 'f.reconfirm_opened_at', 'f.status']) {
    assert.ok(body.includes(col), `resolveLink must select ${col}`);
  }
  // And not the number. The link is resolved before anything is counted, so
  // a ceiling read here would be older than the count that gates it; POST
  // /me reads budget_locked and budget_ceiling together, after the count,
  // and nothing else on the link surface reads the number at all.
  assert.ok(!body.includes('budget_ceiling'), 'the link row carries no ceiling');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The source contract
// ═════════════════════════════════════════════════════════════════════════════

const MEMBER_JOIN = "JOIN flock_members bm ON bm.flock_id = bs.flock_id AND bm.user_id = bs.user_id AND bm.status = 'accepted'";

test('MEMBER_SUBMISSIONS is the crowd: accounts only, no guest arm, beginning where its callers expect', () => {
  // Every reader appends its own `WHERE bs.flock_id = $1 ...`, so the alias
  // and the fragment's opening are part of its contract.
  assert.ok(MEMBER_SUBMISSIONS.startsWith('budget_submissions bs'), 'the fragment begins with the aliased table');
  assert.ok(MS_FLAT.includes(MEMBER_JOIN), 'the member join is still the one the privacy fixtures model');
  assert.ok(!/LEFT JOIN/.test(MS_FLAT), 'an inner join: a row with no accepted author is not a row');
  assert.ok(!/guest_rsvps/.test(MS_FLAT), 'and no guest arm: a guest never makes three');
  assert.strictEqual(MS_FLAT, `budget_submissions bs ${MEMBER_JOIN}`, 'byte for byte the fragment the crowd was always counted through');
});

test('PRESENT_ANSWERS widens the crowd by a guest arm gated on a visible in answer, and joins on presence', () => {
  assert.ok(PRESENT_ANSWERS.startsWith('budget_submissions bs'), 'same opening, same alias');
  assert.ok(PA_FLAT.includes(`LEFT ${MEMBER_JOIN}`), 'the same member join, made optional');
  assert.ok(PA_FLAT.includes(
    "LEFT JOIN guest_rsvps bg ON bg.id = bs.guest_rsvp_id AND bg.flock_id = bs.flock_id AND bg.status = 'in' AND COALESCE(bg.is_hidden, false) = false",
  ), 'the guest arm joins the RSVP row on the plan it belongs to, and only while the guest is a visible in answer');
  assert.ok(PA_FLAT.includes('JOIN (SELECT 1) present ON (bm.id IS NOT NULL OR bg.id IS NOT NULL)'),
    'and a row is present when exactly one author matched');
  assert.ok(!PA_FLAT.includes(MS_FLAT), 'the two fragments are distinguishable by text, which is what the fixture relies on');
});

test('every totals statement over PRESENT_ANSWERS counts the crowd with bm.id IS NOT NULL, and every reveal threshold counts MEMBER_SUBMISSIONS', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'routes', f), 'utf8').replace(/\s+/g, ' ');
  const sources = { 'budget.js': read('budget.js'), 'guest.js': read('guest.js') };

  // The totals: settleIfComplete and GET /api/budget/:id in budget.js,
  // guestBudgetSummary and POST /:token/me in guest.js. Each ranges over
  // everyone present and counts the crowd inside that with the member
  // filter. Counted exactly, so a fifth reader has to be looked at here.
  const TOTALS = /SELECT COUNT\(\*\) AS total_submissions,[^`]*?FROM \$\{PRESENT_ANSWERS\} WHERE bs\.flock_id = \$1`/g;
  for (const [name, src] of Object.entries(sources)) {
    const totals = src.match(TOTALS) || [];
    assert.strictEqual(totals.length, 2, `${name}: two totals statements over PRESENT_ANSWERS`);
    for (const t of totals) {
      assert.match(t, /COUNT\(\*\) FILTER \(WHERE skipped = false AND bm\.id IS NOT NULL\) AS non_skip_count/,
        `${name}: non_skip_count is member sharers only in ${t}`);
    }
    assert.ok(!/total_submissions[^`]*FROM \$\{MEMBER_SUBMISSIONS\}/.test(src),
      `${name}: no totals over the crowd alone, or a guest's answer stops counting toward "everyone has answered"`);
    assert.ok(!/COUNT\(\*\)::int AS n FROM \$\{PRESENT_ANSWERS\}/.test(src),
      `${name}: no reveal threshold over the widened fragment`);
  }

  // The /lock threshold, and the MIN it publishes: the crowd decides, and
  // everyone present binds.
  const budgetSrc = sources['budget.js'];
  const lockAt = budgetSrc.indexOf("router.post('/:flockId/lock'");
  const resetAt = budgetSrc.indexOf("router.post('/:flockId/reset'");
  assert.ok(lockAt > 0 && resetAt > lockAt);
  const lockSrc = budgetSrc.slice(lockAt, resetAt);
  assert.match(lockSrc, /SELECT COUNT\(\*\)::int AS n FROM \$\{MEMBER_SUBMISSIONS\} WHERE bs\.flock_id = \$1 AND skipped = false/);
  assert.match(lockSrc, /SELECT MIN\(amount\) AS ceiling FROM \$\{PRESENT_ANSWERS\} WHERE bs\.flock_id = \$1 AND skipped = false/);

  // The correlated counts in routes/flocks.js and the ghost commit in
  // routes/billing.js are reveal thresholds too, and they never see the
  // widened fragment: it is not even imported there.
  for (const f of ['flocks.js', 'billing.js']) {
    const src = read(f);
    assert.ok(!src.includes('PRESENT_ANSWERS'), `${f} never counts the widened fragment`);
    assert.ok((src.match(/\$\{MEMBER_SUBMISSIONS\}/g) || []).length >= 2, `${f} counts the crowd through MEMBER_SUBMISSIONS`);
  }
});

test('the remind route asks NOT EXISTS, not NOT IN', () => {
  // A guest's answer carries a NULL user_id (migration 071). One NULL inside
  // a NOT IN list makes the whole predicate unknown, so "members who have not
  // answered" would have been nobody on any plan where a guest had answered.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'budget.js'), 'utf8');
  const start = src.indexOf("router.post('/:flockId/remind'");
  assert.ok(start > 0, 'the remind route exists');
  const remind = src.slice(start).replace(/\s+/g, ' ');
  assert.match(remind, /NOT EXISTS \(SELECT 1 FROM budget_submissions bs WHERE bs\.flock_id = \$1 AND bs\.user_id = fm\.user_id\)/);
  assert.ok(!/NOT IN\s*\(/.test(remind), 'no NOT IN over a column that can now be NULL');
});

test('migration 071 is what the guest upsert conflicts on', () => {
  // ON CONFLICT (flock_id, guest_rsvp_id) is a runtime error (42P10) unless a
  // unique constraint names exactly those columns, and the one-author CHECK
  // is what stops a row being counted by both arms of the presence join.
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations', '071_guest_budget_answers.sql'), 'utf8').replace(/\s+/g, ' ');
  assert.match(src, /ALTER TABLE budget_submissions ADD COLUMN IF NOT EXISTS guest_rsvp_id INTEGER REFERENCES guest_rsvps\(id\) ON DELETE CASCADE/);
  assert.match(src, /UNIQUE \(flock_id, guest_rsvp_id\)/);
  assert.match(src, /CHECK \(num_nonnulls\(user_id, guest_rsvp_id\) = 1\)/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The reset: POST /api/budget/:flockId/reset
// ═════════════════════════════════════════════════════════════════════════════
//
// The ceiling is a MIN, published once and never moved, so a cent that has
// settled is the group's budget for good, and a guest holding the link can
// park one. The creator's recovery is the only privacy-safe one: every row
// goes and the lock lifts in one transaction, so the next publication is a
// first publication with no earlier number to subtract it from. An unlock
// that kept the rows would publish a second number over the same people,
// which is the sequence leak the whole router exists to close.

// Three members and a guest, everyone answered, settled at $60.
async function settleFourWay() {
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  await memberAnswer(DEE.id, 80);
  const settling = await guestAnswer(GUEST_A, 90);
  assert.strictEqual(settling.body.budgetLocked, true, settling.text);
  assert.strictEqual(world.flocks.get(FLOCK).budget_ceiling, 60);
  assert.strictEqual(world.submissions.length, 4);
  // The settle itself told the room and pushed everyone; what follows is
  // measured from here.
  log = [];
  emits = [];
  pushes = [];
}

test('the creator resets a settled budget: every row deleted and the lock lifted in one transaction, and the room hears all zeros', async () => {
  await settleFourWay();
  log = [];
  emits = [];
  const res = await reset(AVA.id);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { reset: true, totalMembers: 4 });

  const tx = lastTransaction();
  assert.strictEqual(tx.closedBy, 'COMMIT');
  assert.deepStrictEqual(tx.statements, [
    'SELECT creator_id, budget_enabled, budget_locked FROM flocks WHERE id = $1 FOR UPDATE',
    'DELETE FROM budget_submissions WHERE flock_id = $1',
    'UPDATE flocks SET budget_locked = false, budget_ceiling = NULL, updated_at = NOW() WHERE id = $1',
  ], 'held under the flock lock: the delete, bounded by the plan, then the unlock');
  for (const q of log.filter((x) => /^(DELETE FROM budget_submissions|UPDATE flocks SET budget_locked = false)/.test(x.sql))) {
    assert.deepStrictEqual(q.params, [FLOCK]);
  }
  assert.deepStrictEqual(world.submissions, [], 'members\' rows and the guest\'s row alike');
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, false);
  assert.strictEqual(world.flocks.get(FLOCK).budget_ceiling, null, 'nothing cached to leak');

  // The room hears the open state again, in the shape every other budget
  // event carries, with `reset` so a screen showing "up to $60" redraws.
  const updates = emits.filter((e) => e.event === 'budget_updated');
  assert.deepStrictEqual(updates.map((e) => e.room).sort(), ['user:1', 'user:2', 'user:3']);
  for (const u of updates) {
    assert.deepStrictEqual(u.payload, {
      flockId: FLOCK, ceiling: null, submissionCount: 0, totalMembers: 4, isReady: false, skipCount: null, budgetLocked: false, reset: true,
    });
  }
  assert.strictEqual(pushes.length, 0, 'a reset is not "Budget set!"');
  assertQueriesUnderstood();
});

test('an open budget cannot be started over: there is no number to get off, and nothing is deleted', async () => {
  // Two private answers and no settle. A reset here would delete answers
  // people are still free to change themselves and publish nothing new, so
  // the door is closed with a code the client can read; the transaction
  // opens, reads the lock under FOR UPDATE, and rolls back.
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS] });
  await memberAnswer(AVA.id, 60);
  await memberAnswer(BOB.id, 70);
  log = [];
  emits = [];
  const res = await reset(AVA.id);
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'BUDGET_OPEN');
  assert.strictEqual(ran(/DELETE FROM budget_submissions/).length, 0);
  const tx = lastTransaction();
  assert.strictEqual(tx.closedBy, 'ROLLBACK');
  assert.strictEqual(world.submissions.length, 2, 'the two private answers stand');
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, false);
  assert.strictEqual(emits.filter((e) => e.event === 'budget_updated').length, 0);
  assertQueriesUnderstood();
});

test('a member who is not the creator is 403 and nothing is deleted; a stranger is answered as /lock answers them; a plan not matching budgets is 400', async () => {
  await settleFourWay();

  log = [];
  const member = await reset(BOB.id);
  assert.strictEqual(member.status, 403, member.text);
  assert.match(member.body.error, /Only the flock creator can start the budget over/);
  assert.strictEqual(ran(/DELETE FROM budget_submissions/).length, 0);
  const tx = lastTransaction();
  assert.strictEqual(tx.closedBy, 'ROLLBACK');
  assert.deepStrictEqual(tx.statements, ['SELECT creator_id, budget_enabled, budget_locked FROM flocks WHERE id = $1 FOR UPDATE'],
    'the creator check runs under the lock and nothing follows it');
  assert.strictEqual(world.submissions.length, 4);
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, true);
  assert.strictEqual(emits.filter((e) => e.event === 'budget_updated').length, 0);

  // Membership first, like /lock: a stranger cannot learn which ids exist,
  // and the two doors refuse them with the same body.
  log = [];
  poolCheckouts = 0;
  const stranger = await reset(99);
  assert.strictEqual(stranger.status, 403, stranger.text);
  const strangerLock = await lock(99);
  assert.strictEqual(strangerLock.status, 403);
  assert.deepStrictEqual(stranger.body, { error: 'You are not a member of this flock' });
  assert.deepStrictEqual(stranger.body, strangerLock.body, 'the same 403 body as /lock');
  assert.strictEqual(poolCheckouts, 0, 'refused before any transaction is opened');
  assert.strictEqual(ran(/DELETE FROM budget_submissions/).length, 0);
  assert.strictEqual(ran(/FROM flocks/).length, 0, 'the flock row is not even read for a stranger');

  // Not matching budgets: nothing to start over.
  world = freshWorld();
  seedFlock({ members: [AVA, BOB, DEE], guests: [CASS], budget: false });
  log = [];
  const off = await reset(AVA.id);
  assert.strictEqual(off.status, 400, off.text);
  assert.match(off.body.error, /not enabled/);
  assert.strictEqual(ran(/DELETE FROM budget_submissions/).length, 0);
  assert.strictEqual(lastTransaction().closedBy, 'ROLLBACK');
  assertQueriesUnderstood();
});

test('after a reset a fresh answer is accepted, publishes nothing, and the next settle is a first publication', async () => {
  await settleFourWay();
  assert.strictEqual((await reset(AVA.id)).status, 200);
  guest.guestActionLog.clear();

  // The doors are open again: no BUDGET_LOCKED, no number, and the room
  // hears an aggregate with nothing in it.
  emits = [];
  const fresh = await memberAnswer(AVA.id, 30);
  assert.strictEqual(fresh.status, 200, fresh.text);
  assert.strictEqual(fresh.body.budgetLocked, false);
  assert.strictEqual(fresh.body.ceiling, null);
  assert.strictEqual(fresh.body.isReady, false);
  assert.strictEqual(fresh.body.submissionCount, 1, 'the old four rows are gone');
  assert.strictEqual(fresh.body.totalMembers, 4);
  for (const u of emits.filter((e) => e.event === 'budget_updated')) {
    assert.strictEqual(u.payload.ceiling, null);
    assert.strictEqual(u.payload.budgetLocked, false);
  }
  const g = await guestAnswer(GUEST_A, 45);
  assert.strictEqual(g.status, 200, g.text);
  assert.strictEqual(g.body.ceiling, null);

  // Everyone answers again, and the band that goes out is the only band that
  // has gone out since the reset: $30 banded, not the $60 of the first
  // settle, and nobody was shown a number in between.
  await memberAnswer(BOB.id, 35);
  emits = [];
  pushes = [];
  const settling = await memberAnswer(DEE.id, 40);
  assert.strictEqual(settling.status, 200, settling.text);
  assert.strictEqual(settling.body.budgetLocked, true);
  assert.strictEqual(settling.body.ceiling, 30);
  assert.strictEqual(world.flocks.get(FLOCK).budget_ceiling, 30);
  const bands = emits.filter((e) => e.event === 'budget_updated').map((e) => e.payload.ceiling);
  assert.deepStrictEqual(bands, [30, 30, 30], 'published to the three members, once each');
  assert.deepStrictEqual(pushes.map((p) => p.userId).sort(), [1, 2], 'and pushed to everyone but the settler');
  assertQueriesUnderstood();
});
