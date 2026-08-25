// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// OBJECT-LEVEL AUTHORIZATION SWEEP, PART 2: THE SURFACES NOBODY HAD ATTACKED
// ---------------------------------------------------------------------------
//
// __tests__/objectAuthz.test.js and __tests__/flocksAuthz.test.js cover flocks,
// flock chat, DMs, friendships and stories. __tests__/venueDashboardAuthz
// .test.js covers the venue dashboard. This file covers the rest of the
// id-taking surface, from the attacker's side:
//
//   routes/budget.js         the group's money, and the >=3-submission privacy
//                            threshold that keeps one person's amount private
//   routes/billing.js        the bill split, and the payer's Venmo / Cash App /
//                            Zelle handles
//   routes/calendar.js       a personal calendar row, keyed on a bare SERIAL
//   routes/safety.js         trusted contacts: name, phone and email of the
//                            people who get an SOS
//   routes/notifications.js  device push tokens
//   routes/venues.js         flock venue votes
//   routes/moderation.js     the block routes, which were the one place in this
//                            backend that answered "does user N exist" without
//                            a probe budget, and now carry one
//   routes/messages.js       DM metadata keyed on a user PAIR
//   routes/sensors.js        the two authenticated routes in the whole of
//                            routes/ that take a :placeId and never once
//                            mention req.user
//
// THE QUESTION, EVERY TIME: can account A read, modify or delete something
// belonging to account B by supplying B's id? And where the answer is no, does
// the REFUSAL still tell A that B's object exists?
//
// No database is involved. pool.query and pool.connect are replaced with a
// fixture-backed dispatcher over an in-memory world; an unrecognised statement
// is RECORDED (and reported by assertQueriesUnderstood) rather than silently
// answered with zero rows, which is how an authorization test passes for
// entirely the wrong reason.
//
// Three cases below were marked EXPECTED-FAIL-IF-FIXED: they PINNED CURRENT
// BEHAVIOUR THAT WAS WRONG, so the report had something executable behind it.
// Two of the three are now fixed and their cases assert the fixed behaviour
// instead: the budget.js flock-existence oracle on /lock and /remind, and the
// unbudgeted account-existence oracle on POST /api/blocks/:userId. The one that
// remains says so in its name. Read the comment on it before "fixing" the test.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-money-safety-authz';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Cast ────────────────────────────────────────────────────────────────────
// 1 Alice  : creator + accepted member of flock 10; owns every private object
// 2 Bob    : accepted member of flock 10, but NOT its creator
// 3 Mallory: no relationship to anything
const USERS = {
  1: { id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  2: { id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  3: { id: 3, email: 'mallory@example.com', name: 'Mallory', role: 'user', email_verified: true, is_banned: false, token_version: 0 },
  // 4 Nia: a real row that is BANNED. GET /api/users/:id/card reads banned as
  // deleted, and the block route now does the same, so this account exists only
  // to prove the two answers agree.
  4: { id: 4, email: 'nia@example.com', name: 'Nia', role: 'user', email_verified: true, is_banned: true, token_version: 0 },
};

const FLOCK_ID = 10;
const ABSENT_FLOCK_ID = 11; // no such row, on purpose: the existence-oracle probe
const BILL_ID = 500;
const CAL_EVENT_ID = 700;
const CONTACT_ID = 800;
const ALICE_DEVICE_TOKEN = 'alice-device-token-aaaaaaaaaaaaaaaaaaaa';
const OTHER_VENUE = 'ChIJsomeoneelsesbar000000';

// Every private value is spelled distinctly so a leak is greppable in a failing
// assertion rather than a plausible-looking null.
const FLOCK = () => ({
  id: FLOCK_ID,
  name: 'Rooftop Friday',
  creator_id: 1,
  budget_enabled: true,
  budget_locked: false,
  budget_context: 'dinner',
  budget_ceiling: '85.00',
  ghost_mode_enabled: false,
  status: 'completed',
});

const ALICE_CALENDAR_ROW = () => ({
  id: CAL_EVENT_ID,
  user_id: 1,
  title: 'ALICE-PRIVATE-CALENDAR-TITLE',
  venue: 'ALICE-PRIVATE-VENUE',
  event_date: '2026-09-01',
  time_label: '20:00',
  color: 'blue',
});

const ALICE_CONTACT_ROW = () => ({
  id: CONTACT_ID,
  user_id: 1,
  contact_name: 'ALICE-MUM',
  contact_phone: '5550100000',
  contact_email: 'alice-mum@example.com',
  relationship: 'mother',
});

let flocks;         // id -> row
let blockRows;      // Set of 'blockerId:blockedId'
let nonSkipSubmissions; // how many non-skipped budget rows flock 10 holds
let calendarRows;   // id -> row
let contactRows;    // id -> row
let deviceTokens;   // [{ user_id, token }]
let writes;         // every mutating statement any route issued
let unknown;        // statements the fixture did not model
let queries;        // { sql, params } for shape assertions

function reset() {
  flocks = new Map([[FLOCK_ID, FLOCK()]]);
  blockRows = new Set();
  nonSkipSubmissions = 0;
  calendarRows = new Map([[CAL_EVENT_ID, ALICE_CALENDAR_ROW()]]);
  contactRows = new Map([[CONTACT_ID, ALICE_CONTACT_ROW()]]);
  deviceTokens = [{ user_id: 1, token: ALICE_DEVICE_TOKEN, device_type: 'ios' }];
  writes = [];
  unknown = [];
  queries = [];
}

// Alice and Bob are accepted; Mallory has no row at all.
function memberStatus(flockId, userId) {
  if (Number(flockId) !== FLOCK_ID) return null;
  if (Number(userId) === 1 || Number(userId) === 2) return 'accepted';
  return null;
}

// ── Fixture-backed pool.query ───────────────────────────────────────────────
const realQuery = pool.query.bind(pool);
const realConnect = pool.connect.bind(pool);

async function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });
  const has = (frag) => sql.includes(frag);
  if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params });

  // transaction control + advisory locks
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
  if (has('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };

  // middleware/auth.js
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  // utils/blocks.js: nobody has blocked anybody in this world
  if (has('FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) return { rows: [], rowCount: 0 };
  if (has('SELECT blocked_id AS id FROM user_blocks')) return { rows: [], rowCount: 0 };

  // ── flock membership ──
  if (has("FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    const ok = memberStatus(params[0], params[1]) === 'accepted';
    return { rows: ok ? [{ id: 1 }] : [], rowCount: ok ? 1 : 0 };
  }
  if (has("SELECT COUNT(*) AS total FROM flock_members WHERE flock_id = $1 AND status = 'accepted'")) {
    return { rows: [{ total: '2' }], rowCount: 1 };
  }

  // ── flocks ──
  if (/^SELECT [a-z_, ]*FROM flocks WHERE id = \$1/.test(sql)) {
    const f = flocks.get(Number(params[0]));
    return f ? { rows: [{ ...f }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ── budget ──
  if (has('FROM budget_submissions WHERE flock_id = $1 AND user_id = $2')) return { rows: [], rowCount: 0 };
  // Matched on the table alone: every aggregate here now reads submissions
  // through a JOIN on flock_members (round 18, so a departed account's row
  // stops setting the group MIN), so the statement no longer reads
  // "FROM budget_submissions WHERE flock_id = $1".
  if (has('FROM budget_submissions')) {
    // nonSkipSubmissions is 0 for every attack case; a test that needs the
    // creator's lock to actually reach the write sets it to 3 first.
    return {
      rows: [{
        total_submissions: String(nonSkipSubmissions),
        non_skip_count: String(nonSkipSubmissions),
        skip_count: '0',
        ceiling: nonSkipSubmissions > 0 ? '85.00' : null,
        n: nonSkipSubmissions,
      }],
      rowCount: 1,
    };
  }
  // /remind's "who has not submitted yet" lookup. Nobody is outstanding, which
  // is enough to prove the creator reaches the end of the route.
  if (has('FROM flock_members fm JOIN users u')) return { rows: [], rowCount: 0 };
  if (has('INSERT INTO budget_submissions')) return { rows: [], rowCount: 1 };
  if (has('UPDATE flocks SET budget_ceiling')) return { rows: [], rowCount: 1 };
  if (has('UPDATE flocks SET budget_locked')) return { rows: [], rowCount: 1 };

  // ── billing ──
  if (has('FROM bill_splits bs')) {
    return Number(params[0]) === FLOCK_ID
      ? { rows: [{ id: BILL_ID, flock_id: FLOCK_ID, paid_by: 1, total_amount: '120.00', tip_percent: '18.0', split_type: 'equal', payer_name: 'Alice', flock_name: 'Rooftop Friday', created_at: '2026-08-20T00:00:00.000Z' }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has('FROM bill_splits WHERE flock_id = $1')) {
    return Number(params[0]) === FLOCK_ID ? { rows: [{ id: BILL_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('FROM bill_split_shares')) return { rows: [], rowCount: 0 };
  if (has('venmo_username')) {
    return { rows: [{ name: 'Alice', venmo_username: 'ALICE-SECRET-VENMO', cashapp_cashtag: 'ALICESECRETCASHTAG', zelle_identifier: 'alice-secret@zelle.example' }], rowCount: 1 };
  }

  // ── calendar ──
  if (has('UPDATE calendar_events SET')) {
    // WHERE id = $6 AND user_id = $7
    const row = calendarRows.get(Number(params[5]));
    if (!row || row.user_id !== Number(params[6])) return { rows: [], rowCount: 0 };
    if (params[0] != null) row.title = params[0];
    if (params[1] != null) row.event_date = params[1];
    if (params[2] != null) row.venue = params[2];
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (has('DELETE FROM calendar_events')) {
    const id = Number(params[0]);
    const row = calendarRows.get(id);
    if (!row || row.user_id !== Number(params[1])) return { rows: [], rowCount: 0 };
    calendarRows.delete(id);
    return { rows: [{ id }], rowCount: 1 };
  }
  if (has('FROM calendar_events WHERE')) {
    return { rows: [...calendarRows.values()].filter((r) => r.user_id === Number(params[0])), rowCount: 0 };
  }

  // ── trusted contacts ──
  if (has('UPDATE trusted_contacts SET')) {
    // WHERE id = $5 AND user_id = $6
    const row = contactRows.get(Number(params[4]));
    if (!row || row.user_id !== Number(params[5])) return { rows: [], rowCount: 0 };
    row.contact_name = params[0];
    row.contact_phone = params[1];
    row.contact_email = params[2];
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (has('DELETE FROM trusted_contacts')) {
    const id = Number(params[0]);
    const row = contactRows.get(id);
    if (!row || row.user_id !== Number(params[1])) return { rows: [], rowCount: 0 };
    contactRows.delete(id);
    return { rows: [{ id }], rowCount: 1 };
  }

  // ── device tokens ──
  if (has('INSERT INTO device_tokens')) {
    const [userId, token, deviceType] = params;
    const existing = deviceTokens.find((d) => d.token === token);
    if (existing) { existing.user_id = Number(userId); existing.device_type = deviceType; }
    else deviceTokens.push({ user_id: Number(userId), token, device_type: deviceType });
    return { rows: [], rowCount: 1 };
  }
  if (has('DELETE FROM device_tokens WHERE user_id = $1 AND token = $2')) {
    const before = deviceTokens.length;
    deviceTokens = deviceTokens.filter((d) => !(d.user_id === Number(params[0]) && d.token === params[1]));
    return { rows: [], rowCount: before - deviceTokens.length };
  }
  if (has('DELETE FROM device_tokens')) return { rows: [], rowCount: 0 };

  // ── venue votes ──
  if (has('FROM venue_votes')) return { rows: [], rowCount: 0 };
  if (has('INSERT INTO venue_votes')) return { rows: [{ id: 1 }], rowCount: 1 };
  if (has('DELETE FROM venue_votes')) return { rows: [], rowCount: 0 };
  if (has('FROM guest_votes')) return { rows: [], rowCount: 0 };

  // ── blocks (moderation.js) ──
  // The route asks with `AND is_banned IS NOT TRUE` appended, which is what
  // makes a banned row answer like an absent one. Honour the filter rather than
  // ignoring it, or the banned case would pass for the wrong reason.
  if (has('SELECT id FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    const hidden = !u || (has('is_banned IS NOT TRUE') && u.is_banned);
    return { rows: hidden ? [] : [{ id: u.id }], rowCount: hidden ? 0 : 1 };
  }
  // "have I already blocked this account": the caller's own rows, which is why
  // the route treats a hit as free rather than as a probe.
  if (has('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2')) {
    const hit = blockRows.has(`${params[0]}:${params[1]}`);
    return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
  }
  if (has('INSERT INTO user_blocks')) {
    blockRows.add(`${params[0]}:${params[1]}`);
    return { rows: [], rowCount: 1 };
  }
  if (has('DELETE FROM friendships')) return { rows: [], rowCount: 0 };
  if (has('DELETE FROM user_blocks')) {
    const key = `${params[0]}:${params[1]}`;
    const had = blockRows.delete(key);
    return { rows: had ? [{ id: 1 }] : [], rowCount: had ? 1 : 0 };
  }

  // ── DM relationship (utils/relationships.js) ──
  if (has('SELECT 1 WHERE EXISTS ( SELECT 1 FROM friendships')) return { rows: [], rowCount: 0 };
  if (has('INSERT INTO dm_pinned_venues')) return { rows: [], rowCount: 1 };
  if (has('FROM dm_pinned_venues')) return { rows: [], rowCount: 0 };
  if (has('INSERT INTO dm_venue_votes')) return { rows: [], rowCount: 1 };
  if (has('FROM dm_venue_votes')) return { rows: [], rowCount: 0 };

  // ── sensors ──
  if (has('FROM venue_sensor_data')) {
    return {
      rows: [{
        venue_place_id: params[0],
        thermal_headcount: 87,
        ir_beam_count: 412,
        noise_db: '91.50',
        sample_count: 30,
        sensor_device_id: 'pi-01',
        recorded_at: '2026-08-24T23:00:00.000Z',
      }],
      rowCount: 1,
    };
  }
  if (has('FROM venue_checkins')) return { rows: [{ count: 12 }], rowCount: 1 };

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
}

pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({
  query: (text, params) => dispatch(text, params),
  release: () => {},
});

// ── App under test: the real routers, mounted the way server.js mounts them ──
const app = express();
app.use(express.json());
app.use('/api/budget', require('../routes/budget'));
app.use('/api/billing', require('../routes/billing'));
app.use('/api/calendar', require('../routes/calendar'));
app.use('/api/safety', require('../routes/safety'));
app.use('/api/notifications', require('../routes/notifications'));
app.use('/api/sensors', require('../routes/sensors'));
app.use('/api', require('../routes/moderation'));
app.use('/api', require('../routes/messages'));
app.use('/api/flocks', require('../routes/venues'));

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => {
  pool.query = realQuery;
  pool.connect = realConnect;
  return pool.end().catch(() => {});
});

test.beforeEach(() => {
  reset();
  // The safety contact form and the budget reminder both hold process-wide
  // in-memory throttles. Start every case from a clean window so a refusal is
  // an authorization refusal and not a rate limit wearing its clothes.
  require('../routes/budget').__resetReminderCooldowns?.();
  require('../routes/safety').__test?.resetContactBudget?.();
  // The block probe budget is process-wide in-memory state too, so a refusal in
  // one case must not be a budget spent by the case before it.
  require('../routes/moderation').__test?.resetBlockProbeBudget?.();
});

const TOKENS = {
  alice: () => signUserToken(USERS[1]),
  bob: () => signUserToken(USERS[2]),
  mallory: () => signUserToken(USERS[3]),
};

async function call(method, path, who, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKENS[who]()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, body: json, text };
}

function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], 'test fixture did not model one of the queries the route ran');
}

const noWriteTo = (table) =>
  assert.ok(!writes.some((w) => w.sql.includes(table)), `unexpected write to ${table}: ${JSON.stringify(writes)}`);

// A private string must never appear anywhere in a refused response.
const leaksNothing = (r, ...secrets) => {
  for (const s of secrets) {
    assert.ok(!r.text.includes(s), `response leaked ${s}: ${r.text}`);
  }
};

// ---------------------------------------------------------------------------
// routes/budget.js: the group's money
// ---------------------------------------------------------------------------

test('budget: an outsider cannot read a flock budget, and gets no ceiling', async () => {
  const r = await call('GET', `/api/budget/${FLOCK_ID}`, 'mallory');
  assert.strictEqual(r.status, 403);
  leaksNothing(r, '85.00', 'dinner');
  assertQueriesUnderstood();
});

test('budget: an outsider cannot submit an amount into a flock they are not in', async () => {
  const r = await call('POST', `/api/budget/${FLOCK_ID}/submit`, 'mallory', { amount: 9999 });
  assert.strictEqual(r.status, 403);
  noWriteTo('budget_submissions');
  noWriteTo('UPDATE flocks');
  assertQueriesUnderstood();
});

test('budget: a plain member cannot lock the budget, and nothing is written', async () => {
  const r = await call('POST', `/api/budget/${FLOCK_ID}/lock`, 'bob');
  assert.strictEqual(r.status, 403);
  noWriteTo('UPDATE flocks');
  assertQueriesUnderstood();
});

test('budget: a plain member cannot send reminders to the flock', async () => {
  const r = await call('POST', `/api/budget/${FLOCK_ID}/remind`, 'bob');
  assert.strictEqual(r.status, 403);
  assertQueriesUnderstood();
});

// ── DEFECT, FOUND AND CLOSED ───────────────────────────────────
// budget.js /lock and /remind used to read the FLOCKS ROW FIRST and only then
// compare creator_id, so the two refusals a total outsider got were:
//
//     POST /api/budget/10/lock  -> 403   (flock 10 exists)
//     POST /api/budget/11/lock  -> 404   (flock 11 does not)
//
// flocks.id is a SERIAL, i.e. a walkable integer space, and both routes are
// open to any authenticated account with no probe budget of any kind. That made
// them a flock-existence oracle: an attacker enumerates which plan ids are
// real, which is the first step of every id-walking attack and is exactly the
// leak routes/flocks.js closes deliberately everywhere else, with a
// hasMembershipRow() call whose comment reads "unless you hold a membership
// row, every flock looks like it does not exist".
//
// Both routes now run the membership check FIRST, which is what GET /:flockId
// and /submit in the same file always did. The three tests below pin the fix
// from both sides: the outsider cannot tell the two ids apart, the MEMBER can
// still tell that he lacks permission, and the creator can still do the thing.
test('budget: /lock answers a total outsider identically for a real and a fake flock', async () => {
  const real = await call('POST', `/api/budget/${FLOCK_ID}/lock`, 'mallory');
  assert.strictEqual(real.status, 403);
  noWriteTo('UPDATE flocks');
  reset();
  const fake = await call('POST', `/api/budget/${ABSENT_FLOCK_ID}/lock`, 'mallory');
  assert.strictEqual(fake.status, real.status, 'the status still separates a real flock from a fake one');
  assert.deepStrictEqual(fake.body, real.body, 'the body still separates a real flock from a fake one');
  noWriteTo('UPDATE flocks');
  assertQueriesUnderstood();
});

test('budget: /remind answers a total outsider identically for a real and a fake flock', async () => {
  const real = await call('POST', `/api/budget/${FLOCK_ID}/remind`, 'mallory');
  assert.strictEqual(real.status, 403);
  reset();
  const fake = await call('POST', `/api/budget/${ABSENT_FLOCK_ID}/remind`, 'mallory');
  assert.strictEqual(fake.status, real.status);
  assert.deepStrictEqual(fake.body, real.body);
  assertQueriesUnderstood();
});

// The distinction that MATTERS is the one between a stranger and a member: a
// member who is not the creator has to be told he lacks permission, or the app
// cannot explain a disabled button. Only the outsider is made indistinguishable.
test('budget: a plain member is still told he is not the creator, which an outsider never learns', async () => {
  const member = await call('POST', `/api/budget/${FLOCK_ID}/lock`, 'bob');
  reset();
  const outsider = await call('POST', `/api/budget/${FLOCK_ID}/lock`, 'mallory');
  assert.strictEqual(member.status, 403);
  assert.strictEqual(outsider.status, 403);
  assert.notDeepStrictEqual(member.body, outsider.body,
    'a member and a stranger were told the same thing, so the member cannot be shown why the button is off');
  assert.match(member.body.error, /creator/i);
  assertQueriesUnderstood();
});

test('budget: the creator can still lock and still remind (the outsider 403s are not a broken route)', async () => {
  nonSkipSubmissions = 3; // the privacy threshold, met
  const lock = await call('POST', `/api/budget/${FLOCK_ID}/lock`, 'alice');
  assert.strictEqual(lock.status, 200, JSON.stringify(lock.body));
  assert.strictEqual(lock.body.locked, true);
  assert.ok(writes.some((w) => w.sql.includes('UPDATE flocks SET budget_locked')), 'the lock was not written');
  reset();
  const remind = await call('POST', `/api/budget/${FLOCK_ID}/remind`, 'alice');
  assert.strictEqual(remind.status, 200, JSON.stringify(remind.body));
  assertQueriesUnderstood();
});

// The membership-first routes in the SAME FILE do not have the problem, which
// is what makes the two above an inconsistency rather than a policy.
test('budget: GET and /submit answer identically for a real and a fake flock (the gate order that works)', async () => {
  const realGet = await call('GET', `/api/budget/${FLOCK_ID}`, 'mallory');
  reset();
  const fakeGet = await call('GET', `/api/budget/${ABSENT_FLOCK_ID}`, 'mallory');
  assert.strictEqual(realGet.status, fakeGet.status);
  assert.strictEqual(realGet.status, 403);
  assertQueriesUnderstood();
});

// ---------------------------------------------------------------------------
// routes/billing.js: the bill split and the payer's payment handles
// ---------------------------------------------------------------------------

test('billing: an outsider cannot read a flock bill', async () => {
  const r = await call('GET', `/api/billing/${FLOCK_ID}`, 'mallory');
  assert.strictEqual(r.status, 403);
  leaksNothing(r, '120.00', 'Alice');
  assertQueriesUnderstood();
});

test('billing: an outsider cannot pull the payer Venmo / Cash App / Zelle handles', async () => {
  for (const path of ['venmo-link', 'payment-links']) {
    reset();
    const r = await call('GET', `/api/billing/${FLOCK_ID}/${path}`, 'mallory');
    assert.strictEqual(r.status, 403, path);
    leaksNothing(r, 'ALICE-SECRET-VENMO', 'ALICESECRETCASHTAG', 'alice-secret@zelle.example');
    assertQueriesUnderstood();
  }
});

test('billing: an outsider cannot create, settle or ghost-commit on somebody else\'s flock', async () => {
  const attempts = [
    ['POST', `/api/billing/${FLOCK_ID}/create`, { totalAmount: 1 }],
    ['POST', `/api/billing/${FLOCK_ID}/settle`, undefined],
    ['POST', `/api/billing/${FLOCK_ID}/ghost-commit`, undefined],
  ];
  for (const [method, path, body] of attempts) {
    reset();
    const r = await call(method, path, 'mallory', body);
    assert.strictEqual(r.status, 403, path);
    noWriteTo('bill_split');
    assertQueriesUnderstood();
  }
});

test('billing: every route answers the same way for a real and a fake flock (no existence oracle)', async () => {
  for (const path of ['', '/venmo-link', '/payment-links']) {
    reset();
    const real = await call('GET', `/api/billing/${FLOCK_ID}${path}`, 'mallory');
    reset();
    const fake = await call('GET', `/api/billing/${ABSENT_FLOCK_ID}${path}`, 'mallory');
    assert.strictEqual(real.status, fake.status, `billing${path} distinguishes a real flock from a fake one`);
    assert.strictEqual(real.status, 403);
  }
  assertQueriesUnderstood();
});

test('billing: a member cannot name an outsider as the payer', async () => {
  const r = await call('POST', `/api/billing/${FLOCK_ID}/create`, 'bob', { totalAmount: 60, paidBy: 3 });
  assert.strictEqual(r.status, 400);
  noWriteTo('bill_split');
  assertQueriesUnderstood();
});

// ---------------------------------------------------------------------------
// routes/calendar.js: a personal row on a bare SERIAL
// ---------------------------------------------------------------------------

test('calendar: an id-walker cannot read, edit or delete another account\'s event', async () => {
  const upd = await call('PUT', `/api/calendar/${CAL_EVENT_ID}`, 'mallory', { title: 'MALLORY-OVERWROTE-THIS' });
  assert.strictEqual(upd.status, 404);
  leaksNothing(upd, 'ALICE-PRIVATE-CALENDAR-TITLE', 'ALICE-PRIVATE-VENUE');
  assert.strictEqual(calendarRows.get(CAL_EVENT_ID).title, 'ALICE-PRIVATE-CALENDAR-TITLE');

  const del = await call('DELETE', `/api/calendar/${CAL_EVENT_ID}`, 'mallory');
  assert.strictEqual(del.status, 404);
  assert.ok(calendarRows.has(CAL_EVENT_ID), 'Alice\'s calendar row survived a stranger\'s DELETE');
  assertQueriesUnderstood();
});

test('calendar: "not yours" and "does not exist" are the same 404', async () => {
  const notYours = await call('DELETE', `/api/calendar/${CAL_EVENT_ID}`, 'mallory');
  const notThere = await call('DELETE', '/api/calendar/999999', 'mallory');
  assert.strictEqual(notYours.status, notThere.status);
  assert.deepStrictEqual(notYours.body, notThere.body);
  assertQueriesUnderstood();
});

test('calendar: the owner\'s own edit and delete still work (the attack 404s are not a broken route)', async () => {
  const upd = await call('PUT', `/api/calendar/${CAL_EVENT_ID}`, 'alice', { title: 'Alice renamed it' });
  assert.strictEqual(upd.status, 200);
  const del = await call('DELETE', `/api/calendar/${CAL_EVENT_ID}`, 'alice');
  assert.strictEqual(del.status, 200);
  assert.ok(!calendarRows.has(CAL_EVENT_ID));
  assertQueriesUnderstood();
});

// ---------------------------------------------------------------------------
// routes/safety.js: trusted contacts (name, phone, EMAIL of a third party)
// ---------------------------------------------------------------------------

const CONTACT_BODY = {
  name: 'MALLORY-REDIRECTED',
  phone: '5559990000',
  email: 'mallory@example.com',
  relationship: 'friend',
};

test('safety: a stranger cannot rewrite whose phone gets somebody else\'s SOS', async () => {
  const r = await call('PUT', `/api/safety/contacts/${CONTACT_ID}`, 'mallory', CONTACT_BODY);
  assert.strictEqual(r.status, 404);
  leaksNothing(r, 'ALICE-MUM', 'alice-mum@example.com', '5550100000');
  const row = contactRows.get(CONTACT_ID);
  assert.strictEqual(row.contact_email, 'alice-mum@example.com', 'Alice\'s emergency contact was NOT redirected');
  assert.strictEqual(row.contact_phone, '5550100000');
  assertQueriesUnderstood();
});

test('safety: a stranger cannot delete somebody else\'s emergency contact', async () => {
  const r = await call('DELETE', `/api/safety/contacts/${CONTACT_ID}`, 'mallory');
  assert.strictEqual(r.status, 404);
  assert.ok(contactRows.has(CONTACT_ID), 'Alice\'s trusted contact survived a stranger\'s DELETE');
  assertQueriesUnderstood();
});

test('safety: "not yours" and "does not exist" are the same 404 on contacts too', async () => {
  const notYours = await call('DELETE', `/api/safety/contacts/${CONTACT_ID}`, 'mallory');
  const notThere = await call('DELETE', '/api/safety/contacts/999999', 'mallory');
  assert.strictEqual(notYours.status, notThere.status);
  assert.deepStrictEqual(notYours.body, notThere.body);
  assertQueriesUnderstood();
});

test('safety: the owner can still edit and delete their own contact', async () => {
  const upd = await call('PUT', `/api/safety/contacts/${CONTACT_ID}`, 'alice', {
    name: 'Mum', phone: '5550100000', email: 'mum2@example.com', relationship: 'mother',
  });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(contactRows.get(CONTACT_ID).contact_email, 'mum2@example.com');
  const del = await call('DELETE', `/api/safety/contacts/${CONTACT_ID}`, 'alice');
  assert.strictEqual(del.status, 200);
  assertQueriesUnderstood();
});

// ---------------------------------------------------------------------------
// routes/notifications.js: device push tokens
// ---------------------------------------------------------------------------

test('notifications: unregistering somebody else\'s device token does nothing to it', async () => {
  const r = await call('DELETE', '/api/notifications/unregister', 'mallory', { token: ALICE_DEVICE_TOKEN });
  assert.strictEqual(r.status, 200); // scoped by user_id, so it is a no-op rather than a refusal
  assert.ok(deviceTokens.some((d) => d.token === ALICE_DEVICE_TOKEN && d.user_id === 1),
    'Alice\'s device token survived a stranger\'s unregister');
  assertQueriesUnderstood();
});

// ── DEFECT, RECORDED (and a deliberate design decision behind it) ────────────
// POST /api/notifications/register writes
//     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id
// so registering a token that already belongs to another account MOVES it.
// The comment on that statement says this is intentional ("A device token
// belongs to exactly ONE account"), and it has to be: the same physical device
// signing into a second account must not keep pushing the first account's
// notifications.
//
// What it means as an authorization property is worth being explicit about,
// because nothing else in this backend lets one account write a row keyed to
// another: an attacker who obtains a victim's FCM registration token (it is
// held by the victim's device and by Google, so this is not a remote attack,
// but it is also not a secret the victim can rotate on demand) can
//   a) silence the victim's push notifications entirely, and
//   b) have the ATTACKER's own notifications delivered to the victim's device.
// There is no re-confirmation, no rate limit on the takeover, and the victim
// is never told. This test pins the behaviour so a change to it is deliberate.
test('DEFECT notifications: registering a token that belongs to another account STEALS it', async () => {
  const r = await call('POST', '/api/notifications/register', 'mallory', {
    token: ALICE_DEVICE_TOKEN, deviceType: 'ios',
  });
  assert.strictEqual(r.status, 200);
  const row = deviceTokens.find((d) => d.token === ALICE_DEVICE_TOKEN);
  assert.strictEqual(row.user_id, 3,
    'FIXED? the token no longer moves to the caller, and this test should be inverted');
  assert.ok(!deviceTokens.some((d) => d.token === ALICE_DEVICE_TOKEN && d.user_id === 1),
    'Alice no longer owns her own device token');
  assertQueriesUnderstood();
});

// ---------------------------------------------------------------------------
// routes/venues.js: flock venue votes
// ---------------------------------------------------------------------------

test('venue votes: an outsider cannot vote, unvote or read the tally, and cannot tell a real flock from a fake one', async () => {
  const cases = [
    ['POST', `/api/flocks/${FLOCK_ID}/vote`, { venue_name: 'Mallory Bar' }],
    ['DELETE', `/api/flocks/${FLOCK_ID}/vote`, undefined],
    ['GET', `/api/flocks/${FLOCK_ID}/votes`, undefined],
  ];
  for (const [method, path, body] of cases) {
    reset();
    const real = await call(method, path, 'mallory', body);
    reset();
    const fake = await call(method, path.replace(`/${FLOCK_ID}/`, `/${ABSENT_FLOCK_ID}/`), 'mallory', body);
    assert.strictEqual(real.status, 403, path);
    assert.strictEqual(fake.status, 403, `${path} (fake flock) leaked that the real one exists`);
    noWriteTo('venue_votes');
  }
  assertQueriesUnderstood();
});

// ---------------------------------------------------------------------------
// routes/messages.js: DM metadata keyed on a USER PAIR
// ---------------------------------------------------------------------------

test('dm metadata: an account with no relationship cannot overwrite a pair\'s pinned venue', async () => {
  const r = await call('PUT', '/api/dm/2/pinned-venue', 'mallory', { venue_name: 'MALLORY-PINNED-THIS' });
  assert.strictEqual(r.status, 403);
  noWriteTo('dm_pinned_venues');
  assertQueriesUnderstood();
});

test('dm metadata: the same gate holds on the pair\'s venue votes', async () => {
  const r = await call('POST', '/api/dm/2/venue-votes', 'mallory', { venue_name: 'MALLORY-VOTED-HERE' });
  assert.strictEqual(r.status, 403);
  noWriteTo('dm_venue_votes');
  assertQueriesUnderstood();
});

// ---------------------------------------------------------------------------
// routes/moderation.js: the block routes
// ---------------------------------------------------------------------------

// ── DEFECT, FOUND AND CLOSED ───────────────────────────────────
// This backend takes account enumeration seriously nearly everywhere:
//
//   GET  /api/users/:id/card       404 for every refused case, and a probe
//                                  budget (card-probe, 120/hr, 400/day) charged
//                                  on HITS AND MISSES ALIKE so the misses are
//                                  not the free answers
//   POST /api/friends/request      the same uniform 404, its own probe budget
//                                  (friend-probe, 20/hr, 60/day), and the
//                                  budget-exhausted answer deliberately made
//                                  identical to a miss
//   GET  /api/friends/status/:id   answers "none" for everything
//
// POST /api/blocks/:userId had none of that. It ran
//     SELECT id FROM users WHERE id = $1
// and answered 404 "User not found" for an id with no row, 201 "User blocked"
// for one with a row. No probe budget, no uniform refusal, no is_banned filter
// (so it also confirmed accounts /card deliberately hides), and the side effect
// was a row in the CALLER'S OWN block list which DELETE /api/blocks/:userId
// removes again: so the probe was repeatable and left no trace on the victim.
// The only bound left was the generic apiLimiter, 3000 requests per 15 minutes,
// i.e. 12,000 an hour on the same question those two budgets exist to ration.
//
// It now carries the friends.js shape: one refusal body for a missing row, a
// banned row and a spent budget alike, and a block-probe budget (60/hr,
// 150/day) charged on hits and misses. The limits sit above the friend probe
// because blocking is a SAFETY control and the worst legitimate hour is
// "block every stranger in a 50-person link-joined flock", which must not be
// throttled.
test('blocks: a banned account is indistinguishable from an id with no row', async () => {
  const banned = await call('POST', '/api/blocks/4', 'alice');
  noWriteTo('user_blocks');
  reset();
  const absent = await call('POST', '/api/blocks/999999', 'alice');
  assert.strictEqual(banned.status, 404, 'a banned account must not be confirmed by the block route');
  assert.strictEqual(absent.status, banned.status);
  assert.deepStrictEqual(absent.body, banned.body);
  noWriteTo('user_blocks');
  assertQueriesUnderstood();
});

test('blocks: enumeration is rationed, and running out of budget looks exactly like a miss', async () => {
  const { BLOCK_PROBE_HOURLY } = require('../routes/moderation').__test;
  // Spend the hour on ids that do not exist. Every one of them is charged: if
  // only the hits were charged, the misses would be the free answers and the
  // free answers are the enumeration signal itself.
  for (let i = 0; i < BLOCK_PROBE_HOURLY; i += 1) {
    const r = await call('POST', `/api/blocks/${100000 + i}`, 'alice');
    assert.strictEqual(r.status, 404, `probe ${i} was not a miss`);
  }
  reset();
  const exhausted = await call('POST', '/api/blocks/3', 'alice');
  const stillFake = await call('POST', '/api/blocks/999999', 'alice');
  assert.strictEqual(exhausted.status, 404, 'a real account past the budget must not answer 201');
  assert.deepStrictEqual(exhausted.body, stillFake.body,
    'the exhausted answer differs from a miss, which moves the oracle instead of closing it');
  noWriteTo('user_blocks');
  assert.strictEqual(blockRows.size, 0, 'a refused probe still wrote a block row');
  assertQueriesUnderstood();
});

test('blocks: the block itself still works, and is still reversible by the blocker', async () => {
  const blocked = await call('POST', '/api/blocks/3', 'alice');
  assert.strictEqual(blocked.status, 201, JSON.stringify(blocked.body));
  assert.ok(blockRows.has('1:3'), 'the block row was not written');
  assert.ok(writes.some((w) => w.sql.includes('DELETE FROM friendships')),
    'a block that leaves the friendship in place leaves a relationship the app still reads');
  const undo = await call('DELETE', '/api/blocks/3', 'alice');
  assert.strictEqual(undo.status, 200);
  assert.ok(!blockRows.has('1:3'));
  assertQueriesUnderstood();
});

test('blocks: re-blocking an account you already blocked is free, so double-taps cannot spend the budget', async () => {
  const { blockProbeBudget } = require('../routes/moderation').__test;
  const first = await call('POST', '/api/blocks/3', 'alice');
  assert.strictEqual(first.status, 201);
  const afterFirst = blockProbeBudget.remaining(1).hourly;

  for (let i = 0; i < 5; i += 1) {
    const again = await call('POST', '/api/blocks/3', 'alice');
    assert.strictEqual(again.status, 201, 'blocking somebody already blocked must stay idempotent');
    assert.strictEqual(again.body.message, first.body.message);
  }
  assert.strictEqual(blockProbeBudget.remaining(1).hourly, afterFirst,
    'a re-block was charged as a probe, which would let the block button starve a frightened user');
  assertQueriesUnderstood();
});

test('blocks: a caller still cannot block themselves, and an unparseable id is refused', async () => {
  const self = await call('POST', '/api/blocks/1', 'alice');
  assert.strictEqual(self.status, 400);
  const junk = await call('POST', '/api/blocks/12abc', 'alice');
  assert.strictEqual(junk.status, 400);
  assertQueriesUnderstood();
});

// ---------------------------------------------------------------------------
// routes/sensors.js: the read APIs
// ---------------------------------------------------------------------------

// ── RECORDED, and it is closer to a design note than a defect ────────────────
// These are the ONLY two authenticated routes in the whole of routes/ that take
// an object reference (:placeId) and never once mention req.user. A static
// sweep of every router turns up seven such handlers and the other five are
// deliberately public or token-authed (badge.js, guest.js x3, feedback.js
// aggregate).
//
// /current is correct: the header of routes/sensors.js says these rows ARE the
// public "Live Occupancy" figure, and the consumer venue card renders it.
//
// /history is the one worth a second look. The consumer client only ever asks
// for 12 or 24 hours (frontend/src/App.js), but the validator accepts up to
// 168, so any signed-in account can pull a full WEEK of hourly occupancy,
// noise and door-count for any venue it can name: including venues that have
// not claimed their listing and have never agreed to anything. The paid owner
// surfaces over the same underlying signal (/venue-dashboard/intelligence,
// /this-week) sit behind claim + verified + tier. This test pins what the route
// actually does so the asymmetry is on the record rather than assumed.
test('sensors: any signed-in account can pull a week of any venue\'s occupancy history', async () => {
  const r = await call('GET', `/api/sensors/${OTHER_VENUE}/history?hours=168`, 'mallory');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.readings) && r.body.readings.length > 0);
  // Nothing the route ran asked who the caller was or who owns the venue.
  const touchedOwnership = queries.some((q) => q.sql.includes('venue_profiles'));
  assert.ok(!touchedOwnership, 'the route consulted venue ownership after all');
  assert.ok(!queries.some((q) => q.sql.includes('venue_sensor_data') && q.params.includes(3)),
    'the caller id never reaches the sensor query');
  assertQueriesUnderstood();
});

test('sensors: /current is the same, which is the documented public live figure', async () => {
  const r = await call('GET', `/api/sensors/${OTHER_VENUE}/current`, 'mallory');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.sensor_data.thermal_headcount, 87);
  assertQueriesUnderstood();
});

test('sensors: an unauthenticated caller still gets nothing', async () => {
  const res = await fetch(`${base}/api/sensors/${OTHER_VENUE}/history`);
  assert.strictEqual(res.status, 401);
});
