// Run: node --test  (from backend/)
//
// Two properties of routes/flocks.js, pinned from the attacker's side.
//
// 1. FREE TEXT IS SANITIZED AT THE SOURCE, ON EVERY WRITE.
//    POST /api/flocks stripped markup out of `name`, `venue_name` and
//    `venue_address`; PUT /api/flocks/:id stripped it out of nothing. So a
//    flock created clean could be RENAMED into stored markup one request later
//    and the column kept it verbatim. `budget_context` skipped the sanitizer on
//    both routes. The tests below assert on the values that reach the SQL
//    parameters, not on the response body: a route that escaped on the way out
//    and stored raw markup would pass a response-shaped test and still be
//    wrong, because the flock name is read back by surfaces this file does not
//    own (push bodies, the guest invite page, the venue dashboard).
//
// 2. AN UNVERIFIED ACCOUNT IS NEVER AN ACCEPTED FLOCK MEMBER.
//    middleware/auth.js names flock membership as one of the three assets that
//    make squatting an email address profitable, and enforces it with a deny
//    list of method+path patterns. That deny list is a regex over the URL in
//    ANOTHER file. These tests pin the gate where the membership is actually
//    minted: mounted on the routes, and in the WHERE clause of the one
//    statement that promotes anybody to 'accepted'. The router is deliberately
//    mounted a SECOND time under a prefix the deny list does not match, so a
//    test failure tells you which of the two layers broke.
//
//    The invite direction is pinned too, and it is pinned as ALLOWED: a
//    verified user CAN invite an account that has not confirmed its email yet
//    (a friend who signed up ten minutes ago is the normal case, not an
//    attack). What the tests insist on is that the row this creates stays
//    inert — 'invited', never 'accepted' — until the target verifies.
//
// No database: pool.query is a fixture dispatcher, and any query it does not
// model is recorded and reported rather than answered with an empty result.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-flock-sanitize-tests';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // keep push a no-op

const pool = require('../config/database');
const { signUserToken, UNVERIFIED_MESSAGE, __testing } = require('../middleware/auth');

const FLOCK_ID = 10;

// ── Fixtures ────────────────────────────────────────────────────────────────
// 1 = the creator, verified. 2 = a verified friend. 3 = an account that signed
// up and never clicked the link — the squat the gate is written against.
let users;
let members;
let writes;      // every mutating statement, with its params
let queries;
let unknown;
let emitted;
let promotionRefused; // simulate the UPDATE's own guard firing
let rowVanishes;      // simulate the membership row being deleted mid-request

function reset() {
  users = {
    1: { id: 1, email: 'ava@example.com', name: 'Ava', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
    2: { id: 2, email: 'ben@example.com', name: 'Ben', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
    3: { id: 3, email: 'squat@example.com', name: 'Cass', role: 'user', email_verified: false, is_banned: false, token_version: 0 },
  };
  members = [{ user_id: 1, status: 'accepted' }];
  writes = [];
  queries = [];
  unknown = [];
  emitted = [];
  promotionRefused = false;
  rowVanishes = false;
  flocksRouter.__resetBudgets();
}

const memberOf = (id) => members.find((m) => m.user_id === Number(id));

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });
  const has = (frag) => sql.includes(frag);
  if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };

  // middleware/auth.js
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = users[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  // utils/blocks.js — nobody blocks anybody in this file
  if (has('FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) return { rows: [], rowCount: 0 };
  if (has('SELECT blocked_id AS id FROM user_blocks')) return { rows: [], rowCount: 0 };
  if (has('SELECT blocker_id, blocked_id FROM user_blocks')) return { rows: [], rowCount: 0 };

  // users directory
  if (has('SELECT id, name FROM users WHERE id = $1')) {
    const u = users[params[0]];
    return { rows: u ? [{ id: u.id, name: u.name }] : [], rowCount: u ? 1 : 0 };
  }
  if (has('SELECT id FROM users WHERE id = ANY($1::int[])')) {
    const rows = (params[0] || []).map((id) => users[id]).filter(Boolean).map((u) => ({ id: u.id }));
    return { rows, rowCount: rows.length };
  }
  // The invite path's id-array directory read. Same source as the `id = $1`
  // branch above and the same two columns, so an id with no user is still
  // absent and a real one still carries its real name — which is what the
  // "a verified user CAN invite an unverified account" test reads back.
  if (has('SELECT id, name FROM users WHERE id = ANY($1::int[])')) {
    const rows = (params[0] || []).map((id) => users[id]).filter(Boolean).map((u) => ({ id: u.id, name: u.name }));
    return { rows, rowCount: rows.length };
  }

  // ── flocks ────────────────────────────────────────────────────────────────
  if (has('INSERT INTO flocks')) {
    return {
      rows: [{
        id: FLOCK_ID,
        name: params[0],
        creator_id: Number(params[1]),
        venue_name: params[2],
        venue_address: params[3],
        budget_context: params[11],
        budget_ceiling: null,
        created_at: new Date(),
      }],
      rowCount: 1,
    };
  }
  if (has('SELECT creator_id FROM flocks WHERE id = $1')) {
    return { rows: [{ creator_id: 1 }], rowCount: 1 };
  }
  // The invite helper's best-effort card facts (time, venue, going count),
  // added 2026-09-04 so a live invite says when and where.
  if (has('SELECT f.event_time, f.venue_name')) {
    return { rows: [{ event_time: null, venue_name: null, going: 1 }], rowCount: 1 };
  }
  if (has('SELECT id, name FROM flocks WHERE id = $1')) {
    return Number(params[0]) === FLOCK_ID
      ? { rows: [{ id: FLOCK_ID, name: 'Rooftop Friday' }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has('SELECT creator_id, name FROM flocks WHERE id = $1')) {
    return { rows: [{ creator_id: 1, name: 'Rooftop Friday' }], rowCount: 1 };
  }
  if (has('UPDATE flocks SET name = COALESCE($1, name)')) {
    return {
      rows: [{
        id: FLOCK_ID,
        name: params[0],
        venue_name: params[1],
        venue_address: params[2],
        status: params[9] || 'planning',
        budget_ceiling: null,
        created_at: new Date(),
      }],
      rowCount: 1,
    };
  }

  // ── flock_members ─────────────────────────────────────────────────────────
  // `n` = seats (invited + accepted; declining gives the seat back).
  // `total` = every row, declined included — the second ceiling. The subquery
  // that produces it carries no status predicate, so it counts the whole roster.
  if (has('COUNT(*)::int AS n FROM flock_members WHERE flock_id = $1')) {
    const n = members.filter((m) => m.status === 'invited' || m.status === 'accepted').length;
    return { rows: [{ n, total: members.length }], rowCount: 1 };
  }
  if (has("SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    const m = Number(params[0]) === FLOCK_ID ? memberOf(params[1]) : null;
    const ok = m && m.status === 'accepted';
    return { rows: ok ? [{ id: 1 }] : [], rowCount: ok ? 1 : 0 };
  }
  if (has("SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2")) {
    const rows = members
      .filter((m) => m.status === 'accepted' && m.user_id !== Number(params[1]))
      .map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
  }
  if (has('SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const m = Number(params[0]) === FLOCK_ID ? memberOf(params[1]) : null;
    return { rows: m ? [{ status: m.status }] : [], rowCount: m ? 1 : 0 };
  }
  // The invite path asks the branch above for a whole id set in one statement.
  // A row per id that has one, nothing for the ids that do not, this flock only.
  if (has('SELECT user_id, status FROM flock_members WHERE flock_id = $1 AND user_id = ANY($2::int[])')) {
    if (Number(params[0]) !== FLOCK_ID) return { rows: [], rowCount: 0 };
    const asked = new Set((params[1] || []).map(Number));
    const rows = members
      .filter((m) => asked.has(m.user_id))
      .map((m) => ({ user_id: m.user_id, status: m.status }));
    return { rows, rowCount: rows.length };
  }
  if (has('SELECT * FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const m = rowVanishes ? null : memberOf(params[1]);
    return { rows: m ? [{ flock_id: FLOCK_ID, user_id: m.user_id, status: m.status }] : [], rowCount: m ? 1 : 0 };
  }
  // The flock row lock POST /:id/join takes before its UPDATE, the same one
  // billing reads the accepted roster under. BEGIN and COMMIT are answered
  // above; the lock returns the row it locked.
  if (has('SELECT id FROM flocks WHERE id = $1 FOR UPDATE')) return { rows: [{ id: params[0] }], rowCount: 1 };
  if (has("UPDATE flock_members SET status = 'accepted', joined_at = NOW()")) {
    const m = memberOf(params[1]);
    // The fixture honours the statement's OWN guard, so the SQL predicate is
    // exercised and not merely present: an unverified user is refused here even
    // if every middleware above were removed.
    const verified = users[params[1]]?.email_verified !== false;
    if (promotionRefused || !m || m.status === 'accepted' || !verified) return { rows: [], rowCount: 0 };
    m.status = 'accepted';
    return { rows: [{ flock_id: FLOCK_ID, user_id: m.user_id, status: 'accepted' }], rowCount: 1 };
  }
  if (has('INSERT INTO flock_members')) {
    const ids = Array.isArray(params[1]) ? params[1].map(Number) : [Number(params[1])];
    for (const id of ids) members.push({ user_id: id, status: 'invited' });
    return { rows: [], rowCount: ids.length };
  }
  if (has("UPDATE flock_members SET status = 'invited'")) {
    // Two shapes, same rule per id: one row per call, or `user_id = ANY($2)`.
    const ids = Array.isArray(params[1]) ? params[1].map(Number) : [Number(params[1])];
    let affected = 0;
    for (const id of ids) {
      const m = memberOf(id);
      if (!m) continue;
      m.status = 'invited';
      affected += 1;
    }
    return { rows: [], rowCount: affected };
  }

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
};

// ── App under test ──────────────────────────────────────────────────────────
const flocksRouter = require('../routes/flocks');

const io = {
  sockets: { adapter: { rooms: { get: () => undefined } } }, // everyone offline
  to(room) {
    return { emit: (event, payload) => { emitted.push({ room, event, payload }); } };
  },
};

pool.connect = async () => ({ query: pool.query, release() {} });

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/flocks', flocksRouter);
// Same router, a prefix the middleware deny list cannot match. Everything the
// unverified-account gate still refuses under here is refused by the ROUTE, not
// by the URL regex in middleware/auth.js.
app.use('/internal/flocks', flocksRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; return pool.end().catch(() => {}); });
test.beforeEach(reset);

function call(method, path, who, body) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${signUserToken(users[who])}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const assertQueriesUnderstood = () =>
  assert.deepStrictEqual(unknown, [], 'test fixture did not model one of the queries the route ran');

const lastWrite = (frag) => [...writes].reverse().find((w) => w.sql.includes(frag));

// ═══════════════════════════════════════════════════════════════════════════
// 1. Free text is sanitized at the source, on create AND on update
// ═══════════════════════════════════════════════════════════════════════════

const MARKUP = '<img src=x onerror=alert(1)>Rooftop';

test('renaming a flock stores stripped text, not the markup that was sent', async () => {
  const res = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { name: MARKUP });
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  const w = lastWrite('UPDATE flocks SET name = COALESCE($1, name)');
  assert.ok(w, 'the update ran');
  assert.strictEqual(w.params[0], 'Rooftop', 'the column receives text, not a tag');
  assert.ok(!/[<>]/.test(w.params[0]));
});

test('a rename with <b> in the name stores it stripped (SECURITY-AUDIT-upload-xss #3)', async () => {
  // The upload/XSS audit called out the flock rename path specifically: a host
  // could rename a flock to carry markup that the live-map popup and the invite
  // preview read back. A <b> tag is the minimal case — it survives isLength and
  // reaches the column unless the update validator strips it.
  const res = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { name: '<b>Party</b> at the Roof' });
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  const w = lastWrite('UPDATE flocks SET name = COALESCE($1, name)');
  assert.ok(w, 'the update ran');
  assert.strictEqual(w.params[0], 'Party at the Roof', 'the <b> markup is stripped, not stored');
  assert.ok(!/[<>]/.test(w.params[0]), 'no angle brackets reach the column');
});

test('create and rename agree on what a name is', async () => {
  // The bug was a DIFFERENCE between the two routes, so the regression test is
  // the equality, not either value on its own.
  await call('POST', '/api/flocks', 1, { name: MARKUP });
  const created = lastWrite('INSERT INTO flocks').params[0];

  reset();
  await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { name: MARKUP });
  const renamed = lastWrite('UPDATE flocks SET name = COALESCE($1, name)').params[0];

  assert.strictEqual(created, renamed);
  assert.strictEqual(created, 'Rooftop');
});

test('venue_name and venue_address are stripped on update too', async () => {
  const res = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, {
    venue_name: "<b>Joe's</b> Bar",
    venue_address: '<script>fetch("/steal")</script>12 Main St',
  });
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  const w = lastWrite('UPDATE flocks SET name = COALESCE($1, name)');
  assert.strictEqual(w.params[1], "Joe's Bar");
  assert.strictEqual(w.params[2], '12 Main St', 'stripIgnoreTagBody removes the script contents as well as the tag');
});

test('budget_context was the create-route field that skipped the sanitizer', async () => {
  const res = await call('POST', '/api/flocks', 1, {
    name: 'Dinner',
    budget_enabled: true,
    budget_context: '<i>drinks</i> + food',
  });
  assert.strictEqual(res.status, 201);
  assertQueriesUnderstood();
  assert.strictEqual(lastWrite('INSERT INTO flocks').params[11], 'drinks + food');
});

test('a name that is only markup is refused, not stored blank', async () => {
  // Sanitize-then-measure. Measuring first would let this through as a
  // 30-character name and store the empty string COALESCE happily writes.
  for (const name of ['<script>alert(1)</script>', '<b> </b>', '<div></div>']) {
    reset();
    const post = await call('POST', '/api/flocks', 1, { name });
    assert.strictEqual(post.status, 400, `create: ${name}`);
    const put = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { name });
    assert.strictEqual(put.status, 400, `update: ${name}`);
    assert.strictEqual(lastWrite('INSERT INTO flocks'), undefined);
    assert.strictEqual(lastWrite('UPDATE flocks SET name'), undefined);
  }
});

test('an over-long venue name is a 400, not a 500 from the VARCHAR(255) column', async () => {
  // flocks.venue_name is VARCHAR(255). Neither route bounded it, so 256
  // characters came back as "Failed to update flock" with a Postgres 22001 in
  // the logs — the class routesReliability.test.js pins for id params.
  const long = 'a'.repeat(256);
  const post = await call('POST', '/api/flocks', 1, { name: 'Dinner', venue_name: long });
  assert.strictEqual(post.status, 400);
  const put = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { venue_name: long });
  assert.strictEqual(put.status, 400);

  const ok = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { venue_name: 'a'.repeat(255) });
  assert.strictEqual(ok.status, 200, '255 is still allowed — the bound is the column, not a guess');
  assertQueriesUnderstood();
});

test('an over-long venue address is a 400 on both routes', async () => {
  // 512 is the ceiling sockets/handlers.js `select_venue` already clamps this
  // column to. Two writers, one ceiling.
  const long = 'a'.repeat(513);
  assert.strictEqual((await call('POST', '/api/flocks', 1, { name: 'D', venue_address: long })).status, 400);
  assert.strictEqual((await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { venue_address: long })).status, 400);
  assert.strictEqual((await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { venue_address: 'a'.repeat(512) })).status, 200);
});

// ── 1b. Shape before content ────────────────────────────────────────────────
// The sanitizer only sanitizes strings, and express-validator's validators
// coerce before they test. A one-element array therefore satisfied isFloat(),
// isIn() and isLength() while staying an array in req.body, walked past
// stripHtml untouched, and reached pg as a Postgres array against a scalar
// column — a 500, and a sanitizer bypass in the same request.

const NON_SCALARS = [['<b>x</b>'], ['1.5'], ['planning'], [{}], { a: 1 }];

test('a non-scalar body field is a 400 on update, never a 500 from pg', async () => {
  const fields = ['name', 'venue_name', 'venue_address', 'venue_id', 'venue_latitude',
    'venue_longitude', 'venue_rating', 'venue_photo_url', 'event_time', 'status'];
  for (const field of fields) {
    for (const v of NON_SCALARS) {
      reset();
      const res = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { [field]: v });
      assert.strictEqual(res.status, 400, `${field} = ${JSON.stringify(v)}`);
      assert.strictEqual(lastWrite('UPDATE flocks SET name'), undefined,
        `${field}: nothing reached the database`);
    }
  }
});

test('a non-scalar body field is a 400 on create too', async () => {
  const fields = ['name', 'venue_name', 'venue_address', 'venue_id', 'venue_latitude',
    'venue_longitude', 'venue_rating', 'venue_photo_url', 'event_time',
    'budget_context', 'budget_enabled', 'ghost_mode_enabled'];
  for (const field of fields) {
    for (const v of NON_SCALARS) {
      reset();
      const res = await call('POST', '/api/flocks', 1, { name: 'Dinner', [field]: v });
      assert.strictEqual(res.status, 400, `${field} = ${JSON.stringify(v)}`);
      assert.strictEqual(lastWrite('INSERT INTO flocks'), undefined,
        `${field}: nothing reached the database`);
    }
  }
});

test('the array trick specifically cannot smuggle markup past the sanitizer', async () => {
  // stripHtml returns non-strings unchanged, so ["<b>x</b>"] was never
  // sanitized at all. It is refused now, rather than sanitized-by-accident.
  const res = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { name: ['<img src=x onerror=alert(1)>'] });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(lastWrite('UPDATE flocks SET name'), undefined);
});

test('a missing or null name is still refused, sanitizer or no sanitizer', async () => {
  // isScalar() passes `undefined` through on purpose — `.optional()` and the
  // existing coercions decide absence, not the shape guard. This pins that the
  // required-name path did not become optional by accident.
  for (const body of [{}, { name: null }, { name: '' }, { name: '   ' }]) {
    reset();
    const res = await call('POST', '/api/flocks', 1, body);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
    assert.strictEqual((await res.json()).error, 'Flock name is required');
    assert.strictEqual(lastWrite('INSERT INTO flocks'), undefined);
  }
});

test('the fields that are supposed to be arrays still are', async () => {
  // The guard is per-field, not a blanket "no arrays on this router".
  const created = await call('POST', '/api/flocks', 1, { name: 'Dinner', invited_user_ids: [2, 3] });
  assert.strictEqual(created.status, 201);
  assert.deepStrictEqual((await created.json()).invited_user_ids, [2, 3]);

  const invited = await call('POST', `/api/flocks/${FLOCK_ID}/invite`, 1, { user_ids: [2] });
  assert.strictEqual(invited.status, 200);
  assertQueriesUnderstood();
});

test('the update fan-out carries the sanitized name, so no client re-renders the markup', async () => {
  await call('POST', '/api/flocks', 1, { name: 'Rooftop' });
  reset();
  members.push({ user_id: 2, status: 'accepted' });

  const res = await call('PUT', `/api/flocks/${FLOCK_ID}`, 1, { name: MARKUP });
  assert.strictEqual(res.status, 200);
  const evt = emitted.find((e) => e.event === 'flock_updated');
  assert.ok(evt, 'members were told about the update');
  assert.strictEqual(evt.payload.name, 'Rooftop');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. An unverified account is never an accepted flock member
// ═══════════════════════════════════════════════════════════════════════════

const refusesUnverified = async (res) => {
  assert.strictEqual(res.status, 403);
  const body = await res.json();
  assert.strictEqual(body.emailVerificationRequired, true);
  assert.strictEqual(body.error, UNVERIFIED_MESSAGE);
};

test('an unverified account cannot create, join, invite, or make a share link', async () => {
  members.push({ user_id: 3, status: 'invited' });

  await refusesUnverified(await call('POST', '/api/flocks', 3, { name: 'Mine' }));
  await refusesUnverified(await call('POST', `/api/flocks/${FLOCK_ID}/join`, 3));
  await refusesUnverified(await call('POST', `/api/flocks/${FLOCK_ID}/invite`, 3, { user_ids: [2] }));
  await refusesUnverified(await call('POST', `/api/flocks/${FLOCK_ID}/invite-link`, 3));

  assert.deepStrictEqual(writes, [], 'a refused request writes nothing at all');
  assert.strictEqual(memberOf(3).status, 'invited', 'the invite is still just an invite');
});

test('the gate travels with the route, not with the URL the deny list matches', async () => {
  // Proof the two layers are independent: under /internal the middleware deny
  // list does not fire, and the refusal still happens.
  const req = (method, baseUrl, path) => ({ method, baseUrl, path, originalUrl: baseUrl + path });
  assert.strictEqual(__testing.unverifiedBlocked(req('POST', '/internal/flocks', '/')), false);
  assert.strictEqual(__testing.unverifiedBlocked(req('POST', '/internal/flocks', '/10/join')), false);

  members.push({ user_id: 3, status: 'invited' });
  await refusesUnverified(await call('POST', '/internal/flocks', 3, { name: 'Mine' }));
  await refusesUnverified(await call('POST', `/internal/flocks/${FLOCK_ID}/join`, 3));
  await refusesUnverified(await call('POST', `/internal/flocks/${FLOCK_ID}/invite`, 3, { user_ids: [2] }));
  assert.deepStrictEqual(writes, []);
});

test('a verified user CAN invite an account that has not confirmed its email', async () => {
  // Deliberately allowed. A friend who signed up ten minutes ago has not done
  // anything wrong, and refusing would leak their verification state to anyone
  // who can guess a user id.
  const res = await call('POST', `/api/flocks/${FLOCK_ID}/invite`, 1, { user_ids: [3] });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.invited, [{ user_id: 3, user_name: 'Cass' }]);
  assertQueriesUnderstood();

  const w = lastWrite('INSERT INTO flock_members');
  assert.ok(w, 'the row is written');
  assert.strictEqual(w.sql.includes("'invited'"), true, "and it is written as 'invited'");
  assert.strictEqual(memberOf(3).status, 'invited');
});

test('the invite it creates stays inert until the target verifies', async () => {
  await call('POST', `/api/flocks/${FLOCK_ID}/invite`, 1, { user_ids: [3] });
  assert.strictEqual(memberOf(3).status, 'invited');

  // The whole point: holding the row is not being a member.
  await refusesUnverified(await call('POST', `/api/flocks/${FLOCK_ID}/join`, 3));
  await refusesUnverified(await call('POST', `/internal/flocks/${FLOCK_ID}/join`, 3));
  assert.strictEqual(memberOf(3).status, 'invited', 'still not accepted');
  assert.strictEqual(lastWrite("UPDATE flock_members SET status = 'accepted'"), undefined);

  // ...and the moment they click the link, the invite they were already holding
  // works. Nothing has to be re-sent.
  users[3].email_verified = true;
  const res = await call('POST', `/api/flocks/${FLOCK_ID}/join`, 3);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).member.status, 'accepted');
  assert.strictEqual(memberOf(3).status, 'accepted');
  assertQueriesUnderstood();
});

test('the promotion statement carries the verification check in its own WHERE clause', async () => {
  users[3].email_verified = true;
  members.push({ user_id: 3, status: 'invited' });
  await call('POST', `/api/flocks/${FLOCK_ID}/join`, 3);

  const w = lastWrite("UPDATE flock_members SET status = 'accepted'");
  assert.ok(w);
  // Defence in depth, and the reason the fixture above honours it: this is the
  // only statement in the backend that promotes anybody to accepted membership.
  assert.match(w.sql, /EXISTS \(SELECT 1 FROM users u WHERE u\.id = \$2 AND u\.email_verified IS NOT FALSE\)/);
  // IS NOT FALSE, never = TRUE: a row read without the column must not lock the
  // whole user base out of joining flocks.
  assert.ok(!/email_verified = TRUE/.test(w.sql));
});

test('a refused promotion answers 403, never a 200 that claims you joined', async () => {
  // What the route does when the statement's own guard fires — the only way to
  // reach this branch if both middlewares were somehow removed.
  members.push({ user_id: 3, status: 'invited' });
  users[3].email_verified = true;
  promotionRefused = true;

  const res = await call('POST', `/api/flocks/${FLOCK_ID}/join`, 3);
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).emailVerificationRequired, true);
  assert.strictEqual(memberOf(3).status, 'invited');
  assertQueriesUnderstood();
});

test('joining twice is still a quiet 200, and a vanished row is still a 404', async () => {
  // Regression guard on the branch above: the pre-existing "already accepted"
  // and "row is gone" cases must not have been turned into 403s.
  members.push({ user_id: 3, status: 'accepted' });
  users[3].email_verified = true;

  const again = await call('POST', `/api/flocks/${FLOCK_ID}/join`, 3);
  assert.strictEqual(again.status, 200);
  assert.strictEqual((await again.json()).member.status, 'accepted');
  assert.strictEqual(emitted.filter((e) => e.event === 'flock_invite_responded').length, 0,
    'a repeat join re-broadcasts nothing');

  // They left between the membership lookup and the promotion: the UPDATE
  // matches nothing and the re-read finds nothing either.
  members.find((m) => m.user_id === 3).status = 'invited';
  promotionRefused = true;
  rowVanishes = true;
  const gone = await call('POST', `/api/flocks/${FLOCK_ID}/join`, 3);
  assert.strictEqual(gone.status, 404);
  assertQueriesUnderstood();
});

test('the read half of the rule stays open — the gate is not a lockout', async () => {
  // "READ AND BE REACHED, BUT DO NOT ACCUMULATE". Gating the whole router would
  // turn a mistyped address into a dead end and teach people the app is broken,
  // which middleware/auth.js explicitly rejects as the worse option. An
  // unverified account must still be able to see the invite it was sent, and to
  // get out of a flock it does not want to be in.
  members.push({ user_id: 3, status: 'invited' });
  for (const [method, path] of [['POST', `/api/flocks/${FLOCK_ID}/decline`], ['POST', `/api/flocks/${FLOCK_ID}/leave`]]) {
    reset();
    members.push({ user_id: 3, status: 'invited' });
    const res = await call(method, path, 3);
    assert.notStrictEqual(res.status, 403, `${method} ${path} must not be gated`);
  }
});

test('a verified account is untouched by any of this', async () => {
  members.push({ user_id: 2, status: 'invited' });
  const res = await call('POST', `/api/flocks/${FLOCK_ID}/join`, 2);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(memberOf(2).status, 'accepted');

  const create = await call('POST', '/api/flocks', 2, { name: 'Brunch' });
  assert.strictEqual(create.status, 201);
  assertQueriesUnderstood();
});


test('a plan name over the limit is told it is long, not that it is missing', async () => {
  // One isLength chain carried one sentence, so 256 characters answered
  // "Flock name is required" while the field was visibly filled in
  // (first-session audit 2026-09-05).
  reset();
  // A run of one letter trips the profanity list on its own, so the fixture
  // is words.
  const words = 'Dinner at the park with everyone '.repeat(12);
  const res = await call('POST', '/api/flocks', 1, { name: words.slice(0, 256) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, 'Flock name is too long (255 characters max)');
  assert.strictEqual(lastWrite('INSERT INTO flocks'), undefined);
  reset();
  const ok = await call('POST', '/api/flocks', 1, { name: words.slice(0, 255) });
  assert.strictEqual(ok.status, 201, await ok.text());
});

test('a real venue picked from Google is not refused for its name', async () => {
  // "Dick's Sporting Goods" with its place id used to answer the community
  // guidelines sentence on Create, with the venue still attached and nothing
  // on screen saying the venue was the problem.
  reset();
  const res = await call('POST', '/api/flocks', 1, {
    name: 'Gear run', venue_name: "Dick's Sporting Goods", venue_address: '1 Dick Rd, Bath, PA',
    venue_id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
  });
  assert.strictEqual(res.status, 201, await res.text());
  // Typed, with no place id, the full list still applies.
  reset();
  const typed = await call('POST', '/api/flocks', 1, { name: 'Gear run', venue_name: "Dick's Sporting Goods" });
  assert.strictEqual(typed.status, 400);
  assert.match((await typed.json()).error, /venue's name or address/);
});
