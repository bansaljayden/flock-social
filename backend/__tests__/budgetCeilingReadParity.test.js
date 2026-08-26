// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE CACHED CEILING IS BANDED ON EVERY READER, NOT JUST THE ONE THAT WROTE IT
// ---------------------------------------------------------------------------
//
// SECURITY-AUDIT-injection-idor.md I-1 (round 2). Commit 1fdea72 banded the
// published budget ceiling ($10 steps at $50+, $5 at $5-49.99, $1 at $1-4.99,
// a cent below a dollar, always DOWN) so the number a flock sees is an interval
// and never one member's exact figure. It banded on the way INTO
// flocks.budget_ceiling and reasoned that the readers of that column therefore
// need no change. That holds for a row written since the deploy. It does not
// hold for a row written BEFORE it, and three of the five readers took the
// column verbatim:
//
//   GET  /api/flocks                  routes/flocks.js — the home list
//   GET  /api/flocks/:id              routes/flocks.js — the detail screen
//   PUT  /api/flocks/:id              routes/flocks.js — RETURNING *
//   POST /api/billing/:id/ghost-commit routes/billing.js — estimatedShare
//
// Migration 027 backfills the column, and __tests__/budgetCeilingBackfill.test.js
// proves that. This file proves the other half: that the ROUTES band on the way
// out, so the property survives a restore from an old dump, a row written by
// code that predates all of this, or any future writer that forgets.
//
// The fixture therefore does the one thing the migration cannot do for a test:
// it serves a LEGACY row. flocks.budget_ceiling holds the raw MIN — $47.13,
// the victim's exact amount from the audit's own exploit — and three non-skip
// submissions exist, so every reader is past the reveal threshold and the only
// thing standing between that number and the wire is the banding.
//
// All five readers are mounted on ONE app over ONE fixture and compared to each
// other, not only to the literal 45: agreement between them is the property
// that actually matters, since the audit's proof of the bug was that
// GET /api/flocks/:id and GET /api/budget/:id disagreed about the same flock in
// the same second.
//
// No database. `pool.query`/`pool.connect` are replaced by a dispatcher that
// matches on the CLAUSE under test (the projection or predicate that identifies
// the statement), never a bare prefix — a fake that answers "starts with
// SELECT" pins itself instead of the code. Anything it does not recognise lands
// in `unknown` and fails the test rather than silently returning zero rows.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-budget-ceiling-read-parity';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // push stays a no-op

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');
const { bandCeiling } = require('../routes/budget');

const FLOCK_ID = 10;
// The audit's number. It is not a multiple of any band step, so finding it
// anywhere in a response body is proof of a leak rather than a coincidence.
const LEGACY_RAW_MIN = '47.13';
const BAND = 45;

const USERS = {
  1: { id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  2: { id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  3: { id: 3, email: 'cara@example.com', name: 'Cara', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
};
const MEMBERS = [1, 2, 3];

let flock;         // the one flock row, as the column actually holds it
let nonSkipCount;  // how many non-skipped budget submissions exist
let bills;         // [{ id, flock_id, paid_by, total_amount }]
let shares;        // [{ bill_id, user_id, amount, committed }]
let queries;       // { sql, params } for every statement
let unknown;       // statements the fixture did not model

function reset() {
  flock = {
    id: FLOCK_ID,
    name: 'Rooftop Friday',
    creator_id: 1,
    venue_name: 'The Fig',
    venue_address: '12 Private Street',
    venue_id: 'ChIJceilingparity00000',
    venue_latitude: 40.7128,
    venue_longitude: -73.9352,
    venue_rating: 4.6,
    venue_photo_url: null,
    event_time: '2026-08-20T23:00:00.000Z',
    status: 'planning',
    budget_enabled: true,
    // THE LEGACY ROW: written before 1fdea72, never re-banded by anything.
    budget_ceiling: LEGACY_RAW_MIN,
    budget_locked: true,
    budget_context: 'dinner',
    ghost_mode_enabled: true,
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
  };
  nonSkipCount = 3;   // past the reveal threshold on every surface
  bills = [];
  shares = [];
  queries = [];
  unknown = [];
}

// What the SQL CASE in routes/flocks.js publishes: the cached column above the
// 3-non-skip threshold, NULL below it. The threshold gate is SQL-side and is
// modelled here so the fixture cannot accidentally test the band by testing the
// threshold instead.
const gatedCeiling = () => ((flock.budget_locked && nonSkipCount >= 3) ? flock.budget_ceiling : null);

// ── The fixture-backed database ─────────────────────────────────────────────
const realQuery = pool.query;
const realConnect = pool.connect;

async function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const has = (frag) => sql.includes(frag);
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };

  // middleware/auth.js — not logged, identical on every request.
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
  }
  queries.push({ sql, params });

  // ── utils/blocks.js ──
  if (has('SELECT blocked_id AS id FROM user_blocks')) return { rows: [], rowCount: 0 };
  if (has('SELECT blocker_id, blocked_id FROM user_blocks')) return { rows: [], rowCount: 0 };

  // ── services/pushHelper.js (post-response tail) ──
  if (has('AS can_see')) return { rows: [{ is_banned: false, actor_banned: false, can_see: true }], rowCount: 1 };
  if (has('SELECT settings FROM user_settings')) return { rows: [], rowCount: 0 };
  if (has('FROM device_tokens')) return { rows: [], rowCount: 0 };

  // ── GET /api/flocks — the home list. Identified by its correlated join on
  //    the caller's membership row, which no other statement carries.
  if (has('JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1')) {
    return {
      rows: [{
        ...flock,
        budget_ceiling: gatedCeiling(),
        creator_name: USERS[flock.creator_id].name,
        member_status: 'accepted',
        member_count: String(MEMBERS.length),
        guest_count: 0,
        going_count: MEMBERS.length,
        member_previews: MEMBERS.map((id) => ({
          id, name: USERS[id].name, profile_image_url: null, is_creator: id === flock.creator_id,
        })),
      }],
      rowCount: 1,
    };
  }

  // ── GET /api/flocks/:id — the detail row (the creator join is what tells it
  //    apart from the plain `FROM flocks WHERE id = $1` lookups).
  if (has('FROM flocks f JOIN users u ON u.id = f.creator_id')) {
    return {
      rows: [{ ...flock, budget_ceiling: gatedCeiling(), creator_name: USERS[flock.creator_id].name }],
      rowCount: 1,
    };
  }

  // ── routes/budget.js GET — its own projection, in its own order ──
  if (has('SELECT budget_enabled, budget_context, budget_locked, budget_ceiling, ghost_mode_enabled FROM flocks WHERE id = $1')) {
    return { rows: [{ ...flock }], rowCount: 1 };
  }

  // ── routes/billing.js ghost-commit — likewise its own projection ──
  if (has('SELECT budget_ceiling, budget_locked, status, ghost_mode_enabled FROM flocks WHERE id = $1')) {
    const { budget_ceiling, budget_locked, status, ghost_mode_enabled } = flock;
    return { rows: [{ budget_ceiling, budget_locked, status, ghost_mode_enabled }], rowCount: 1 };
  }

  // ── PUT /api/flocks/:id — ownership lookup, then the update ──
  if (/^SELECT [\w, ]+ FROM flocks WHERE id = \$1$/.test(sql)) {
    return { rows: [{ ...flock }], rowCount: 1 };
  }
  if (has('UPDATE flocks SET name = COALESCE($1, name)')) {
    const keys = ['name', 'venue_name', 'venue_address', 'venue_id', 'venue_latitude',
      'venue_longitude', 'venue_rating', 'venue_photo_url', 'event_time', 'status'];
    keys.forEach((k, i) => { if (params[i] !== null && params[i] !== undefined) flock[k] = params[i]; });
    // RETURNING * — and the * includes the cached, unbanded budget_ceiling.
    // This is exactly the shape the audit found: the UPDATE never touches the
    // column, so whatever was cached comes straight back out.
    return { rows: [{ ...flock }], rowCount: 1 };
  }

  // ── budget_submissions: three statements, three different projections ──
  if (has('COUNT(*) FILTER (WHERE skipped = false) AS non_skip_count')) {
    return {
      rows: [{ total_submissions: String(nonSkipCount), non_skip_count: String(nonSkipCount), skip_count: '0' }],
      rowCount: 1,
    };
  }
  if (has('SELECT COUNT(*)::int AS n FROM budget_submissions WHERE flock_id = $1 AND skipped = false')) {
    return { rows: [{ n: nonSkipCount }], rowCount: 1 };
  }
  if (has('SELECT COUNT(*) AS submissions FROM budget_submissions WHERE flock_id = $1')) {
    return { rows: [{ submissions: String(nonSkipCount) }], rowCount: 1 };
  }
  if (has('SELECT amount, skipped FROM budget_submissions WHERE flock_id = $1 AND user_id = $2')) {
    return { rows: [], rowCount: 0 };
  }

  // ── flock_members ──
  if (has('SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    return { rows: [{ status: 'accepted' }], rowCount: 1 };
  }
  if (has("SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    return { rows: [{ id: 1 }], rowCount: 1 };
  }
  if (has("SELECT COUNT(*) AS count FROM flock_members WHERE flock_id = $1 AND status = 'accepted'")) {
    return { rows: [{ count: String(MEMBERS.length) }], rowCount: 1 };
  }
  if (has("SELECT COUNT(*) AS total FROM flock_members WHERE flock_id = $1 AND status = 'accepted'")) {
    return { rows: [{ total: String(MEMBERS.length) }], rowCount: 1 };
  }
  if (has("SELECT COUNT(*) AS cnt FROM flock_members WHERE flock_id = $1 AND status = 'accepted'")) {
    return { rows: [{ cnt: String(MEMBERS.length) }], rowCount: 1 };
  }
  if (has("SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'")) {
    return { rows: MEMBERS.map((user_id) => ({ user_id })), rowCount: MEMBERS.length };
  }
  if (has('FROM flock_members fm JOIN users u ON u.id = fm.user_id')) {
    const rows = MEMBERS.map((id) => ({
      id, name: USERS[id].name, profile_image_url: null,
      reliability_score: '91.00', status: 'accepted', attendance: 'unmarked',
      joined_at: '2026-08-13T00:00:00.000Z',
    }));
    return { rows, rowCount: rows.length };
  }

  // ── guests / votes ──
  if (has('FROM guest_rsvps')) return { rows: [], rowCount: 0 };
  if (has('FROM venue_votes WHERE flock_id = $1')) return { rows: [{ voters: 0 }], rowCount: 1 };
  if (has('FROM guest_votes gv')) return { rows: [{ voters: 0 }], rowCount: 1 };

  // ── bill_splits / bill_split_shares (ghost commit) ──
  if (has('SELECT id, paid_by FROM bill_splits WHERE flock_id = $1')) {
    const b = bills.find((x) => x.flock_id === Number(params[0]));
    return { rows: b ? [{ id: b.id, paid_by: b.paid_by }] : [], rowCount: b ? 1 : 0 };
  }
  if (has('INSERT INTO bill_splits')) {
    const b = { id: 900 + bills.length, flock_id: Number(params[0]), total_amount: params[1], paid_by: null };
    bills.push(b);
    return { rows: [{ id: b.id }], rowCount: 1 };
  }
  if (has('INSERT INTO bill_split_shares')) {
    shares.push({ bill_id: params[0], user_id: params[1], amount: params[2], committed: true });
    return { rows: [], rowCount: 1 };
  }

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
}

pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({
  query: (text, params) => dispatch(text, params),
  release: () => {},
});

// ── App under test: all five readers of the column, one fixture ─────────────
const app = express();
app.use(express.json());
app.use('/api/flocks', require('../routes/flocks'));
app.use('/api/billing', require('../routes/billing'));
app.use('/api/budget', require('../routes/budget'));

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

async function call(method, path, userId, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${signUserToken(USERS[userId])}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, text: await res.clone().text(), body: await res.json().catch(() => null) };
}

function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');
}
// The one assertion every case shares: the victim's exact figure never appears
// anywhere in the response, at any nesting depth, under any key.
function assertNoRawMin(res, where) {
  assert.ok(!res.text.includes(LEGACY_RAW_MIN), `${where} put the raw MIN on the wire: ${res.text}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// The four readers that did not re-band
// ═══════════════════════════════════════════════════════════════════════════

test('GET /api/flocks bands a legacy raw MIN out of the home list', async () => {
  const res = await call('GET', '/api/flocks', 1);
  assert.strictEqual(res.status, 200, res.text);
  assertQueriesUnderstood();
  const card = res.body.flocks.find((f) => f.id === FLOCK_ID);
  assert.strictEqual(card.budget_ceiling, BAND);
  assertNoRawMin(res, 'the flock list');
});

test('GET /api/flocks/:id bands a legacy raw MIN — the audit request, executed', async () => {
  const res = await call('GET', `/api/flocks/${FLOCK_ID}`, 1);
  assert.strictEqual(res.status, 200, res.text);
  assertQueriesUnderstood();
  assert.strictEqual(res.body.flock.budget_ceiling, BAND);
  assertNoRawMin(res, 'the flock detail route');
});

test('PUT /api/flocks/:id bands the ceiling its RETURNING * hands back', async () => {
  const res = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { venue_name: 'The Other Fig' });
  assert.strictEqual(res.status, 200, res.text);
  assertQueriesUnderstood();
  assert.strictEqual(res.body.flock.venue_name, 'The Other Fig', 'the update itself stopped working');
  assert.strictEqual(res.body.flock.budget_ceiling, BAND);
  assertNoRawMin(res, 'the flock update route');
});

test('POST /api/billing/:id/ghost-commit derives the estimated share from the BAND', async () => {
  const res = await call('POST', `/api/billing/${FLOCK_ID}/ghost-commit`, 1);
  assert.strictEqual(res.status, 200, res.text);
  assertQueriesUnderstood();
  assert.strictEqual(res.body.estimatedShare, BAND);
  assertNoRawMin(res, 'the ghost commit response');

  // And the number it WROTE, not merely the one it answered: the share row and
  // the placeholder bill are both derived from the ceiling, and the share is
  // served back later by GET /api/billing/:flockId.
  assert.strictEqual(Number(shares[0].amount), BAND, 'the committed share row holds the raw MIN');
  assert.strictEqual(Number(bills[0].total_amount), BAND * MEMBERS.length,
    'the placeholder bill total was computed from the raw MIN');
});

// ═══════════════════════════════════════════════════════════════════════════
// Agreement, thresholds, and the general rule
// ═══════════════════════════════════════════════════════════════════════════

test('all five readers answer the SAME number for the same flock in the same second', async () => {
  // This is the shape of the bug the audit reported: GET /api/flocks/:id said
  // 47.13 while GET /api/budget/:id said 45. Comparing the readers to each
  // other (not just to a literal) is what makes a future fifth reader that
  // forgets to band fail here.
  const list = await call('GET', '/api/flocks', 1);
  const detail = await call('GET', `/api/flocks/${FLOCK_ID}`, 1);
  const updated = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { venue_name: 'The Fig' });
  const ghost = await call('POST', `/api/billing/${FLOCK_ID}/ghost-commit`, 1);
  const budget = await call('GET', `/api/budget/${FLOCK_ID}`, 1);
  assertQueriesUnderstood();

  const answers = {
    'GET /api/flocks': list.body.flocks.find((f) => f.id === FLOCK_ID).budget_ceiling,
    'GET /api/flocks/:id': detail.body.flock.budget_ceiling,
    'PUT /api/flocks/:id': updated.body.flock.budget_ceiling,
    'POST /api/billing/:id/ghost-commit': ghost.body.estimatedShare,
    'GET /api/budget/:id': budget.body.ceiling,
  };
  for (const [where, value] of Object.entries(answers)) {
    assert.strictEqual(value, BAND, `${where} answered ${value}`);
  }
});

test('the band is applied on TOP of the reveal threshold, not instead of it', async () => {
  // Two non-skips: nothing is published at all, banded or otherwise. A band is
  // still a reveal, and it is still gated.
  nonSkipCount = 2;
  const detail = await call('GET', `/api/flocks/${FLOCK_ID}`, 1);
  const list = await call('GET', '/api/flocks', 1);
  const updated = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { venue_name: 'The Fig' });
  const budget = await call('GET', `/api/budget/${FLOCK_ID}`, 1);
  assertQueriesUnderstood();

  assert.strictEqual(detail.body.flock.budget_ceiling, null);
  assert.strictEqual(list.body.flocks.find((f) => f.id === FLOCK_ID).budget_ceiling, null);
  assert.strictEqual(updated.body.flock.budget_ceiling, null);
  assert.strictEqual(budget.body.ceiling, null);

  const ghost = await call('POST', `/api/billing/${FLOCK_ID}/ghost-commit`, 1);
  assert.strictEqual(ghost.status, 400, 'ghost commit opened below the threshold');
  for (const res of [detail, list, updated, budget, ghost]) assertNoRawMin(res, 'a below-threshold read');
});

test('a NULL cached ceiling stays null rather than becoming a band', async () => {
  flock.budget_ceiling = null;
  const detail = await call('GET', `/api/flocks/${FLOCK_ID}`, 1);
  const list = await call('GET', '/api/flocks', 1);
  assertQueriesUnderstood();
  assert.strictEqual(detail.body.flock.budget_ceiling, null);
  assert.strictEqual(list.body.flocks.find((f) => f.id === FLOCK_ID).budget_ceiling, null);

  const ghost = await call('POST', `/api/billing/${FLOCK_ID}/ghost-commit`, 1);
  assert.strictEqual(ghost.status, 400, 'a null ceiling must not produce an estimated share');
});

test('the rule holds across the bands, not just at $47.13', async () => {
  // Swept through the routes rather than through bandCeiling() directly: the
  // point is that the ROUTE applies it, and a sweep catches a fix that special
  // cases one value or one band.
  for (const raw of ['0.40', '1.99', '4.99', '5.00', '12.75', '49.99', '50.00', '99.99', '9999.99']) {
    reset();
    flock.budget_ceiling = raw;
    const want = bandCeiling(raw);

    const detail = await call('GET', `/api/flocks/${FLOCK_ID}`, 1);
    const list = await call('GET', '/api/flocks', 1);
    const ghost = await call('POST', `/api/billing/${FLOCK_ID}/ghost-commit`, 1);
    assertQueriesUnderstood();

    assert.strictEqual(detail.body.flock.budget_ceiling, want, `detail route at ${raw}`);
    assert.strictEqual(list.body.flocks.find((f) => f.id === FLOCK_ID).budget_ceiling, want, `list route at ${raw}`);
    assert.strictEqual(ghost.body.estimatedShare, want, `ghost commit at ${raw}`);
    assert.ok(want <= Number(raw), `bandCeiling rounded UP at ${raw}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// One implementation, not two
// ═══════════════════════════════════════════════════════════════════════════

test('flocks.js and billing.js import the ceiling rules rather than reimplementing them', () => {
  // A second copy of either rule is how the two sides drift: one gets a new
  // band, or a new answer to WHEN a number may be published, and the other
  // keeps doing what it did. Source-level, because the behavioural tests above
  // would pass just as happily against a duplicate.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['flocks.js', 'billing.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
    assert.ok(
      /require\('\.\/budget'\)/.test(src),
      `routes/${file} no longer imports the ceiling rules from the route that owns them`
    );
    assert.ok(
      /settledCeiling/.test(src),
      `routes/${file} publishes the cached ceiling without the settle gate`
    );
    assert.ok(
      !/CEILING_BANDS|SUB_DOLLAR_CEILING|function bandCeiling|function settledCeiling/.test(src),
      `routes/${file} has grown its own copy of a ceiling rule`
    );
  }

  // The list and detail routes withhold in SQL as well, and the fixture above
  // models that CASE rather than executing it, so the settle gate inside it is
  // pinned here instead. Two gates on purpose: this column has twice been
  // published by a reader that remembered one of them.
  const flocksSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');
  const cases = flocksSrc.match(/CASE WHEN[\s\S]*?AS budget_ceiling/g) || [];
  assert.strictEqual(cases.length, 2, 'expected the list and detail budget_ceiling CASEs');
  for (const c of cases) {
    assert.match(c, /f\.budget_locked/, 'a budget_ceiling CASE publishes a ceiling from an open budget');
    assert.match(c, />= 3/, 'a budget_ceiling CASE dropped the three-amount support gate');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The WHEN gate, on all five readers at once (round 22)
// ═══════════════════════════════════════════════════════════════════════════
//
// Banding was the answer to "the published number is somebody's exact figure".
// It is not an answer to "the published number MOVES", which is a fact about
// two numbers and not about either of them. A ceiling recomputed on every
// submission dropped the instant the member with the least money answered, and
// every member watching the count go 3 to 4 could attribute the new band to
// that one person. So the number is published once, when the budget settles,
// and flocks.budget_ceiling means THE PUBLISHED NUMBER rather than the running
// minimum.
//
// The same five readers, because the same mistake is available to all of them:
// serving a live column that happens to be sitting there.

test('an OPEN budget publishes no ceiling on any of the five readers', async () => {
  // Everything a reveal needs exists except the settle: three shared amounts,
  // and a cached column holding a number. Every door answers nothing.
  flock.budget_locked = false;
  flock.budget_ceiling = '60.00';

  const list = await call('GET', '/api/flocks', 1);
  const detail = await call('GET', `/api/flocks/${FLOCK_ID}`, 1);
  const updated = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { venue_name: 'The Fig' });
  const budget = await call('GET', `/api/budget/${FLOCK_ID}`, 1);
  assertQueriesUnderstood();

  assert.strictEqual(list.body.flocks.find((f) => f.id === FLOCK_ID).budget_ceiling, null);
  assert.strictEqual(detail.body.flock.budget_ceiling, null);
  assert.strictEqual(updated.body.flock.budget_ceiling, null);
  assert.strictEqual(budget.body.ceiling, null);
  assert.strictEqual(budget.body.isReady, true,
    'isReady still says the group CAN settle, which is what the lock button is gated on');

  // The ghost commit derives an estimated share from the ceiling and WRITES it
  // into a bill_split_shares row, so an open budget has to refuse rather than
  // persist a snapshot of a number that is still moving.
  const ghost = await call('POST', `/api/billing/${FLOCK_ID}/ghost-commit`, 1);
  assert.strictEqual(ghost.status, 400, ghost.text);
  assert.strictEqual(shares.length, 0, 'a ghost commit wrote a share from an unpublished ceiling');
  for (const res of [list, detail, updated, budget, ghost]) {
    assert.ok(!res.text.includes('60'), `an open budget put its running minimum on the wire: ${res.text}`);
  }
});

test('a polling client cannot difference the five readers either, because the number does not move', async () => {
  // The read-path form of the attack: poll while the flock answers. The only
  // transition any reader can show is "nothing" to "the number".
  flock.budget_locked = false;
  flock.budget_ceiling = '60.00';
  const observed = [];
  const pollAll = async () => {
    const list = await call('GET', '/api/flocks', 1);
    const detail = await call('GET', `/api/flocks/${FLOCK_ID}`, 1);
    const budget = await call('GET', `/api/budget/${FLOCK_ID}`, 1);
    observed.push(
      list.body.flocks.find((f) => f.id === FLOCK_ID).budget_ceiling,
      detail.body.flock.budget_ceiling,
      budget.body.ceiling,
    );
  };

  await pollAll();                       // three amounts in, still open
  flock.budget_ceiling = '52.00';        // a fourth, lower amount arrives
  await pollAll();
  flock.budget_ceiling = '47.13';        // and a fifth, lower again
  await pollAll();
  // The last member answers, the budget settles, and THAT is the publication.
  flock.budget_locked = true;
  await pollAll();
  assertQueriesUnderstood();

  const distinct = [...new Set(observed.filter((v) => v !== null))];
  assert.deepStrictEqual(distinct, [BAND],
    `a poller saw more than one number: ${JSON.stringify(observed)}`);
  assert.deepStrictEqual(observed.slice(0, 9), [null, null, null, null, null, null, null, null, null],
    'a reader published a number while the budget was still open');
});
