// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-auth.md R2-4 (MEDIUM) — INVITE LINKS WERE PERMANENT.
//
// `flock_invite_links` carried token, flock_id, created_by, revoked, created_at
// and NO expiry. resolveLink's whole liveness test was `revoked = false`, and
// the only other gate was flockIsOver, which reads a status nothing in the
// codebase sets automatically (every write of 'completed'/'cancelled' is behind
// the creator-only PUT /api/flocks/:id). event_time was never consulted by the
// link path at all. So:
//
//   1. a member shares https://…/i/<token> into a group chat;
//   2. months pass, the plan happened, nobody marked it complete;
//   3. anyone who scrolls back that far signs up, verifies, and POSTs
//      /api/guest/<token>/join — accepted membership, which is the flock chat,
//      the live location fan-out, the budget ceiling and the bill shares;
//   4. as an accepted member they call POST /api/flocks/:id/invite-link with
//      { regenerate: true } and take the link away from the host who made it.
//
// This file pins steps 3 and 4 as refused, and pins the migration that makes
// step 3 impossible for the rows that already exist.
//
// The database fixtures HONOUR THE CLAUSE under test rather than matching a
// statement prefix: the expiry filter is applied only when the SQL that arrived
// actually carries `expires_at > NOW()`. Delete that clause from the route and
// these tests go red, which is the whole point of writing them this way.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'invite-link-expiry-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const BACKEND = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
const HOST = { id: 1, email: 'ava@example.com', name: 'Ava Brooks', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const MEMBER = { id: 2, email: 'sam@example.com', name: 'Sam Rivera', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const WALKUP = { id: 3, email: 'mal@example.com', name: 'Mal Reyes', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const USERS = { 1: HOST, 2: MEMBER, 3: WALKUP };

const DAY = 86400e3;
const LIVE = 'LIVELIVELIVE1';    // a link that has not lapsed
const DEAD = 'DEADDEADDEAD1';    // a link whose expires_at is in the past
const NEVER_MINTED = 'NOSUCHTOKEN1';

let links;
let members;
let queries;
let flockRow;

function reset() {
  const now = Date.now();
  links = [
    { token: LIVE, flock_id: 42, created_by: 1, revoked: false, expires_at: now + 7 * DAY },
    { token: DEAD, flock_id: 42, created_by: 1, revoked: false, expires_at: now - 1 * DAY },
  ];
  members = [
    { flock_id: 42, user_id: 1, status: 'accepted' },
    { flock_id: 42, user_id: 2, status: 'accepted' },
    { flock_id: 42, user_id: 3, status: 'accepted' }, // the walk-up joiner from step 3
  ];
  flockRow = {
    id: 42, name: 'Dinner', creator_id: 1, status: 'planning',
    event_time: new Date(now + 3 * DAY).toISOString(),
  };
  queries = [];
  guest.newGuestLog.clear();
  guest.guestActionLog.clear();
  guest.joinLog.clear();
}

// `expires_at > NOW()` is applied ONLY if the arriving statement carries it.
const clause = (sql, re) => re.test(sql);
const liveLinks = (sql) => links.filter((l) => (
  !clause(sql, /il\.revoked = false|revoked = false/) || !l.revoked
) && (
  !clause(sql, /expires_at > NOW\(\)/) || l.expires_at > Date.now()
));

const realQuery = pool.query;
const realConnect = pool.connect;

async function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });
  const has = (frag) => sql.includes(frag);

  if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/i.test(sql)) return { rows: [], rowCount: 0 };

  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
  }

  // ── routes/guest.js resolveLink ──
  if (has('FROM flock_invite_links il')) {
    const l = liveLinks(sql).find((x) => x.token === params[0]);
    if (!l) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        flock_id: l.flock_id, name: flockRow.name, event_time: flockRow.event_time,
        venue_name: null, status: flockRow.status, host_name: HOST.name,
      }],
      rowCount: 1,
    };
  }

  // ── routes/flocks.js POST /:id/invite-link ──
  if (has('UPDATE flock_invite_links SET revoked = true')) {
    let n = 0;
    for (const l of links) if (l.flock_id === Number(params[0])) { l.revoked = true; n += 1; }
    return { rows: [], rowCount: n };
  }
  if (has('SELECT token FROM flock_invite_links')) {
    const l = liveLinks(sql).find((x) => x.flock_id === Number(params[0]));
    return { rows: l ? [{ token: l.token }] : [], rowCount: l ? 1 : 0 };
  }
  if (has('INSERT INTO flock_invite_links')) {
    // The route computes expires_at in SQL from the flock's own event_time, so
    // the fixture reproduces the SAME expression rather than inventing a value:
    // GREATEST(NOW() + 14 days, COALESCE(event_time, NOW()) + 7 days).
    if (Number(params[1]) !== flockRow.id) return { rows: [], rowCount: 0 };
    const carriesExpiry = clause(sql, /expires_at/);
    const eventMs = flockRow.event_time ? Date.parse(flockRow.event_time) : Date.now();
    links.push({
      token: params[0], flock_id: Number(params[1]), created_by: params[2], revoked: false,
      expires_at: carriesExpiry
        ? Math.max(Date.now() + 14 * DAY, eventMs + 7 * DAY)
        : null, // a route that stopped computing one writes a permanent link
    });
    return { rows: [{ token: params[0] }], rowCount: 1 };
  }

  // ── the rest of the guest preview, so a LIVE link can render ──
  if (has('AS members') && has('AS guests')) {
    return { rows: [{ members: 2, guests: 0 }], rowCount: 1 };
  }

  if (has('SELECT creator_id FROM flocks WHERE id = $1')) {
    return Number(params[0]) === flockRow.id
      ? { rows: [{ creator_id: flockRow.creator_id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has("FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    const m = members.find((x) => x.flock_id === Number(params[0]) && x.user_id === Number(params[1]) && x.status === 'accepted');
    return { rows: m ? [{ id: 1 }] : [], rowCount: m ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => dispatch(sql, params),
  release: () => {},
});

const guest = require('../routes/guest');
const flocks = require('../routes/flocks');

const app = express();
app.use(express.json());
app.set('io', {
  to: () => ({ emit: () => {} }),
  in: () => ({ disconnectSockets: () => {} }),
});
app.use('/api/guest', guest.router);
app.use('/api/flocks', flocks);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.query = realQuery;
  pool.connect = realConnect;
}));
test.beforeEach(reset);

async function call(method, pathname, user, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user ? { Authorization: `Bearer ${signUserToken(user)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

// ===========================================================================
// PART 1 — an expired link is dead, and says nothing about having existed
// ===========================================================================

test('R2-4: an expired link cannot be used to join', async () => {
  const res = await call('POST', `/api/guest/${DEAD}/join`, WALKUP);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(
    queries.filter((q) => /INSERT INTO flock_members/.test(q.sql)).length, 0,
    'an expired link must not mint membership'
  );
});

test('R2-4: an expired link answers EXACTLY what a token that never existed answers', async () => {
  // "Do not leak whether the link ever existed." An expired link and an
  // invented one must be indistinguishable on both the read and the write door.
  const expiredJoin = await call('POST', `/api/guest/${DEAD}/join`, WALKUP);
  const inventedJoin = await call('POST', `/api/guest/${NEVER_MINTED}/join`, WALKUP);
  assert.strictEqual(expiredJoin.status, inventedJoin.status);
  assert.deepStrictEqual(expiredJoin.body, inventedJoin.body);

  const expiredView = await call('GET', `/api/guest/${DEAD}`);
  const inventedView = await call('GET', `/api/guest/${NEVER_MINTED}`);
  assert.strictEqual(expiredView.status, inventedView.status);
  assert.deepStrictEqual(expiredView.body, inventedView.body);
  assert.strictEqual(expiredView.status, 404);
});

test('R2-4: a link that has NOT lapsed still works', async () => {
  // The fix has to bound the credential, not break the feature.
  const view = await call('GET', `/api/guest/${LIVE}`);
  assert.strictEqual(view.status, 200);
  assert.strictEqual(view.body.flock.name, 'Dinner');
});

test('R2-4: the expiry is enforced in resolveLink, the one door both routes use', () => {
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'guest.js'), 'utf8');
  const fn = /async function resolveLink\(token\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'resolveLink must still exist in routes/guest.js');
  assert.match(fn[0], /expires_at > NOW\(\)/,
    'resolveLink no longer bounds the link in time — every caller of it is unbounded again');
});

// ===========================================================================
// PART 2 — a new link is born with a deadline
// ===========================================================================

test('R2-4: minting a link writes an expires_at computed from the flock', async () => {
  links = []; // no live link yet, so the route mints one
  const res = await call('POST', '/api/flocks/42/invite-link', MEMBER);
  assert.strictEqual(res.status, 200);
  const minted = links.find((l) => l.token === res.body.token);
  assert.ok(minted, 'the route must have inserted the token it returned');
  assert.notStrictEqual(minted.expires_at, null,
    'the INSERT no longer carries expires_at — new links are permanent again');
  assert.ok(minted.expires_at > Date.now(), 'a freshly minted link must not be born expired');
});

test('R2-4: an EXPIRED row is not handed back as the flock\'s live link', async () => {
  // The lookup that decides "there is already a link" has to agree with the
  // lookup that decides "this link still works", or the route keeps handing out
  // a token the join path already refuses.
  links = [{ token: DEAD, flock_id: 42, created_by: 1, revoked: false, expires_at: Date.now() - DAY }];
  const res = await call('POST', '/api/flocks/42/invite-link', MEMBER);
  assert.strictEqual(res.status, 200);
  assert.notStrictEqual(res.body.token, DEAD, 'the route re-issued a link that has already lapsed');
});

// ===========================================================================
// PART 3 — the walk-up joiner cannot take the link off the host
// ===========================================================================

test('R2-4 step 4: a plain member cannot regenerate the host\'s link', async () => {
  const res = await call('POST', '/api/flocks/42/invite-link', WALKUP, { regenerate: true });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /creator/i);
  assert.strictEqual(links.find((l) => l.token === LIVE).revoked, false,
    'the host\'s link was revoked by somebody who did not create the flock');
  assert.strictEqual(res.body.token, undefined, 'and no replacement token was handed out');
});

test('R2-4 step 4: the creator can still regenerate', async () => {
  const res = await call('POST', '/api/flocks/42/invite-link', HOST, { regenerate: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(links.find((l) => l.token === LIVE).revoked, true);
  assert.notStrictEqual(res.body.token, LIVE, 'regenerate must hand back a NEW token');
});

test('R2-4 step 4: a plain member can still SHARE the existing link', async () => {
  // Sharing was never the problem — taking it away was. A member who is not the
  // creator must keep getting the same working link.
  const res = await call('POST', '/api/flocks/42/invite-link', MEMBER);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.token, LIVE);
  assert.strictEqual(
    queries.filter((q) => /UPDATE flock_invite_links SET revoked/.test(q.sql)).length, 0,
    'a plain share must not revoke anything'
  );
});

// ===========================================================================
// PART 4 — the migration behind all of it
// ===========================================================================

test('R2-4: a migration adds expires_at, backfills it, and leaves no permanent row', () => {
  const dir = path.join(BACKEND, 'migrations');
  const file = fs.readdirSync(dir).find((f) => /invite_link_expiry/.test(f));
  assert.ok(file, 'no migration adds flock_invite_links.expires_at');

  const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\s+/g, ' ');
  assert.match(sql, /ALTER TABLE flock_invite_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ/);
  // Existing rows are the whole point: a column nobody backfilled leaves every
  // already-leaked link permanent, which is the finding untouched.
  assert.match(sql, /UPDATE flock_invite_links[\s\S]*SET expires_at =/);
  assert.match(sql, /WHERE (f\.id = il\.flock_id AND )?il\.expires_at IS NULL|expires_at IS NULL/);
  // And nothing may be left NULL afterwards, or the enforcement clause has a
  // hole shaped exactly like the rows that predate it.
  assert.match(sql, /ALTER COLUMN expires_at SET NOT NULL/);
  assert.match(sql, /ALTER COLUMN expires_at SET DEFAULT/);
});

test('R2-4: the migration takes a free number and the runner will pick it up', () => {
  const dir = path.join(BACKEND, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const numbers = files.map((f) => f.slice(0, 3));
  assert.strictEqual(new Set(numbers).size, numbers.length,
    `two migrations share a number: ${numbers.sort().join(', ')}`);
  const mine = files.find((f) => /invite_link_expiry/.test(f));
  assert.match(mine, /^\d{3}_/, 'the migration runner orders by filename, so it must be numbered');
});
