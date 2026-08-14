// Run: node --test  (from backend/)
//
// GET /api/users/export — data portability (GDPR Art. 20 / CCPA). The tests
// here are the two halves of that obligation plus the abuse case:
//
//   1. The user gets THEIR data: profile, settings, calendar, availability,
//      flock membership, their own messages, their sent DM halves, their own
//      budget amount, check-ins, reports they filed, trusted contacts — as
//      machine-readable JSON, delivered as a named, uncached download.
//   2. The user gets NOBODY ELSE'S data: other members' flock messages, the
//      other party's DM halves, other members' budget amounts, the identity of
//      people they reported and of moderators — none of it may appear. Art.
//      20(4) is a hard line, not a formatting preference.
//   3. An export is the most valuable single read available to someone holding
//      a stolen 24h token, so it demands the same recent-possession proof as
//      account deletion (password retype / fresh OAuth session), shares the
//      same wrong-guess budget, and is metered per account after the proof.
//
// No database is touched: pool.query is stubbed the way the rest of this suite
// does it, and the fixture honours each query's column projection the way real
// Postgres would, so a leak in the SELECT list shows up as a leak in the body.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pool = require('../config/database');
const realQuery = pool.query;
const realConnect = pool.connect;

const usersRouter = require('../routes/users');
const {
  proofFailures,
  exportRequests,
  EXPORT_ROW_CAP,
  EXPORT_MESSAGE_ROW_CAP,
  REAUTH_WINDOW_MS,
} = usersRouter.__testing;

// ── Fixture ────────────────────────────────────────────────────────────────
const PASSWORD = 'CorrectHorse1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // cheap rounds: this is a test

// Strings that must NEVER appear in user 1's export. Each one is somebody
// else's data sitting in the same tables the export reads.
const OTHERS_FLOCK_MSG = 'OTHERS-FLOCK-MESSAGE-DO-NOT-EXPORT';
const OTHERS_DM_TEXT = 'OTHERS-DM-HALF-DO-NOT-EXPORT';
const OTHERS_BUDGET = '999.99';
const INLINE_IMAGE_BASE64 = 'aW5saW5lLWltYWdlLWJ5dGVz';

let USERS;
let MESSAGES;       // flock messages, several senders
let DMS;            // both halves of a conversation
let BUDGETS;        // two members' submissions on one flock
let sql;            // every statement the routes ran, in order
let unknown;        // statements the fixture did not model

function reset() {
  USERS = {
    1: { // password account — the exporter
      id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true,
      is_banned: false, banned_at: null, token_version: 0, password: PASSWORD_HASH,
      phone: '+12025550101', interests: ['hiking', 'live music'],
      profile_image_url: 'https://api.dicebear.com/7.x/thumbs/svg?seed=alice',
      venmo_username: 'alice-v', cashapp_cashtag: 'alicec', zelle_identifier: 'alice@example.com',
      is_premium: false, oauth_provider: null, oauth_id: null,
      apple_refresh_token: null, terms_accepted_at: '2026-01-01T00:00:00Z',
      date_of_birth: '2008-05-01', reliability_score: '92.50',
      total_plans_joined: 4, total_plans_attended: 3,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    },
    2: { // Apple account, no password — holds a live Apple credential
      id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', email_verified: true,
      is_banned: false, banned_at: null, token_version: 0, password: null,
      phone: null, interests: [],
      profile_image_url: null, venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
      is_premium: false, oauth_provider: 'apple', oauth_id: 'apple-sub-2',
      apple_refresh_token: 'apple-secret-refresh-token', terms_accepted_at: null,
      date_of_birth: '2007-02-02', reliability_score: null,
      total_plans_joined: 0, total_plans_attended: 0,
      created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
    },
  };
  MESSAGES = [
    { id: 10, flock_id: 7, sender_id: 1, message_text: 'my first flock message', message_type: 'text', venue_data: null, image_url: null, created_at: '2026-03-01T00:00:00Z' },
    { id: 11, flock_id: 7, sender_id: 2, message_text: OTHERS_FLOCK_MSG, message_type: 'text', venue_data: null, image_url: null, created_at: '2026-03-01T00:01:00Z' },
    { id: 12, flock_id: 7, sender_id: 1, message_text: 'photo', message_type: 'image', venue_data: null, image_url: `data:image/png;base64,${INLINE_IMAGE_BASE64}`, created_at: '2026-03-01T00:02:00Z' },
    { id: 13, flock_id: 7, sender_id: 1, message_text: 'venue card', message_type: 'venue_card', venue_data: { name: 'Taco Spot' }, image_url: 'https://places.example.com/photo.jpg', created_at: '2026-03-01T00:03:00Z' },
  ];
  DMS = [
    { id: 20, sender_id: 1, receiver_id: 2, message_text: 'my half of the DM', message_type: 'text', venue_data: null, image_url: null, created_at: '2026-03-02T00:00:00Z' },
    { id: 21, sender_id: 2, receiver_id: 1, message_text: OTHERS_DM_TEXT, message_type: 'text', venue_data: null, image_url: null, created_at: '2026-03-02T00:01:00Z' },
  ];
  BUDGETS = [
    { flock_id: 7, user_id: 1, amount: '25.00', skipped: false, submitted_at: '2026-03-03T00:00:00Z', updated_at: '2026-03-03T00:00:00Z' },
    { flock_id: 7, user_id: 2, amount: OTHERS_BUDGET, skipped: false, submitted_at: '2026-03-03T00:01:00Z', updated_at: '2026-03-03T00:01:00Z' },
  ];
  sql = [];
  unknown = [];
  proofFailures.clearAll();
  exportRequests.clearAll();
}
reset();

// Real Postgres returns only the projected columns; the fixture does the same,
// so any secret that reaches the response got there through the route's own
// SELECT list, not through a sloppy stub.
const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : row[c]]));
const capped = (rows, limitParam) => (Number.isFinite(Number(limitParam)) ? rows.slice(0, Number(limitParam)) : rows);

function handle(text, params = []) {
  sql.push(text);
  const has = (s) => text.includes(s);

  // middleware/auth.js
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  // the export's account fetch (profile pick list + password for the proof)
  if (has('reliability_score') && has('FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
  }
  if (has('JOIN flocks f ON f.id = fm.flock_id')) {
    const rows = [{
      flock_id: 7, name: 'Friday tacos', flock_status: 'confirmed', venue_name: 'Taco Spot',
      venue_address: '1 Main St', event_time: '2026-03-05T01:00:00Z', created_at: '2026-02-20T00:00:00Z',
      membership_status: 'accepted', attendance: 'attended', joined_at: '2026-02-20T00:00:00Z',
      is_creator: params[0] === 1,
    }];
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM messages WHERE sender_id = $1')) {
    const rows = MESSAGES.filter((m) => m.sender_id === params[0])
      .map((m) => pick(m, ['id', 'flock_id', 'message_text', 'message_type', 'venue_data', 'image_url', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM direct_messages WHERE sender_id = $1')) {
    const rows = DMS.filter((m) => m.sender_id === params[0])
      .map((m) => pick(m, ['id', 'receiver_id', 'message_text', 'message_type', 'venue_data', 'image_url', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM budget_submissions WHERE user_id = $1')) {
    const rows = BUDGETS.filter((b) => b.user_id === params[0])
      .map((b) => pick(b, ['flock_id', 'amount', 'skipped', 'submitted_at', 'updated_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM venue_checkins WHERE user_id = $1')) {
    const rows = params[0] === 1
      ? [{ venue_place_id: 'place-abc', checkin_source: 'nfc', created_at: '2026-03-04T00:00:00Z' }]
      : [];
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM content_reports WHERE reporter_id = $1')) {
    // The underlying table row also carries reported_user_id, content_id and
    // handled_by; the projection is what keeps them out.
    const rows = params[0] === 1
      ? [pick(
          { content_type: 'dm', reason: 'harassment', details: 'my own report words', status: 'resolved', created_at: '2026-03-04T01:00:00Z', resolved_at: '2026-03-05T00:00:00Z', reported_user_id: 2, content_id: 21, handled_by: 99 },
          ['content_type', 'reason', 'details', 'status', 'created_at', 'resolved_at']
        )]
      : [];
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM trusted_contacts WHERE user_id = $1')) {
    const rows = params[0] === 1
      ? [{ contact_name: 'Mom', contact_phone: '+12025550111', contact_email: 'mom@example.com', relationship: 'parent', created_at: '2026-01-02T00:00:00Z' }]
      : [];
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM calendar_events WHERE user_id = $1')) {
    const rows = params[0] === 1
      ? [{ id: 30, title: 'Study group', venue: 'Library', event_date: '2026-03-10', time_label: '4 PM', color: 'teal', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' }]
      : [];
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM user_settings WHERE user_id = $1')) {
    const rows = params[0] === 1 ? [{ settings: { theme: 'dark' }, updated_at: '2026-03-01T00:00:00Z' }] : [];
    return { rows, rowCount: rows.length };
  }
  if (has('FROM availability_pulses WHERE user_id = $1')) {
    const rows = params[0] === 1
      ? [{ status: 'down', note: 'free after 6', set_at: '2026-03-04T00:00:00Z', expires_at: '2026-03-05T00:00:00Z' }]
      : [];
    return { rows, rowCount: rows.length };
  }
  // deleteAccount's account fetch (used by the shared-proof-budget test; the
  // 429 fires before the transaction, so nothing else needs modelling)
  if (has('apple_refresh_token, is_banned, banned_at')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  unknown.push(text);
  return { rows: [], rowCount: 0 };
}

pool.query = async (text, params) => handle(typeof text === 'string' ? text : text.text, params);
pool.connect = async () => ({
  query: async (text, params) => handle(typeof text === 'string' ? text : text.text, params),
  release() {},
});

// ── App under test ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

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

function tokenFor(id, { ageSeconds = 0 } = {}) {
  return jwt.sign(
    { userId: id, tv: USERS[id]?.token_version || 0, iat: Math.floor(Date.now() / 1000) - ageSeconds },
    process.env.JWT_SECRET
  );
}

async function exportCall(token, { password, headers = {} } = {}) {
  const res = await fetch(`${base}/api/users/export`, {
    method: 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(password !== undefined ? { 'X-Export-Password': password } : {}),
      ...headers,
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const assertModelled = () => assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');

// ===========================================================================
// 1. The user gets their data, as a real machine-readable download
// ===========================================================================

test('a password account exports its own data as a named, uncached JSON file', async () => {
  const res = await exportCall(tokenFor(1), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assertModelled();

  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename="flock-data-export.json"');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');

  const b = res.body;
  assert.strictEqual(b.export_format.version, 1);
  assert.strictEqual(b.profile.email, 'alice@example.com');
  assert.deepStrictEqual(b.profile.interests, ['hiking', 'live music']);
  assert.strictEqual(b.profile.sign_in_method, 'password');
  assert.strictEqual(b.profile.date_of_birth, '2008-05-01');

  assert.deepStrictEqual(b.settings, { theme: 'dark' });
  assert.strictEqual(b.availability.status, 'down');
  assert.strictEqual(b.calendar_events[0].title, 'Study group');
  assert.strictEqual(b.flocks[0].name, 'Friday tacos');
  assert.strictEqual(b.flocks[0].is_creator, true);

  // Provided content: their messages, their DM halves, their budget amount.
  assert.deepStrictEqual(b.flock_messages.map((m) => m.id), [10, 12, 13]);
  assert.deepStrictEqual(b.direct_messages_sent.map((m) => m.id), [20]);
  assert.strictEqual(b.budget_submissions[0].amount, '25.00');

  // Observed data: check-ins. Provided-about-others data: trusted contacts.
  assert.strictEqual(b.venue_checkins[0].venue_place_id, 'place-abc');
  assert.strictEqual(b.trusted_contacts[0].contact_name, 'Mom');
  assert.strictEqual(b.reports_filed[0].details, 'my own report words');

  assert.deepStrictEqual(b.truncated_sections, []);
});

// ===========================================================================
// 2. Nobody else's data, and no credentials, in the file
// ===========================================================================

test('the export contains no other person\'s content and no credential of any kind', async () => {
  const res = await exportCall(tokenFor(1), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  const raw = res.text;

  // Other people's content (Art. 20(4)): the flock-mate's message, the other
  // half of the DM, the other member's budget amount.
  assert.ok(!raw.includes(OTHERS_FLOCK_MSG), 'another member\'s flock message leaked');
  assert.ok(!raw.includes(OTHERS_DM_TEXT), 'the other party\'s DM half leaked');
  assert.ok(!raw.includes(OTHERS_BUDGET), 'another member\'s budget amount leaked');
  assert.ok(!raw.includes('bob@example.com'), 'another user\'s email leaked');

  // Credentials and internals, stripped at source (the server.js response
  // backstop is NOT mounted in this harness, so this proves the route itself).
  assert.ok(!raw.includes(PASSWORD_HASH), 'the bcrypt hash leaked');
  // Key position only: profile.sign_in_method's VALUE is the string "password".
  assert.ok(!raw.includes('"password":'), 'a password field leaked');
  assert.ok(!raw.includes('apple_refresh_token'), 'the Apple credential column leaked');
  assert.ok(!raw.includes('apple-secret-refresh-token'), 'the Apple credential value leaked');
  assert.ok(!raw.includes('token_version'), 'token_version leaked');
  assert.ok(!raw.includes('oauth_id'), 'the provider subject id leaked');

  // The moderation pipeline's other parties stay out of reports_filed, and out
  // of the SELECT itself, not just the response.
  const report = res.body.reports_filed[0];
  for (const key of ['reported_user_id', 'content_id', 'handled_by']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(report, key), false, `${key} in reports_filed`);
  }
  const reportSql = sql.find((s) => s.includes('FROM content_reports WHERE reporter_id'));
  assert.ok(reportSql, 'reports query not run');
  for (const col of ['reported_user_id', 'content_id', 'handled_by']) {
    assert.ok(!reportSql.includes(col), `reports SELECT names ${col}`);
  }
});

test('inline image data is replaced with a marker; external image URLs pass through', async () => {
  const res = await exportCall(tokenFor(1), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);

  const withInline = res.body.flock_messages.find((m) => m.id === 12);
  assert.strictEqual(withInline.image_url, null);
  assert.strictEqual(withInline.image_omitted, true);
  assert.ok(!res.text.includes(INLINE_IMAGE_BASE64), 'inline image bytes leaked into the export');

  const withExternal = res.body.flock_messages.find((m) => m.id === 13);
  assert.strictEqual(withExternal.image_url, 'https://places.example.com/photo.jpg');
  assert.strictEqual(withExternal.image_omitted, undefined);
});

// ===========================================================================
// 3. The proof: password retype / fresh OAuth session, shared guess budget
// ===========================================================================

test('a missing password is a prompt; a wrong one is a guess; five guesses lock the proof', async () => {
  // No header: the shipped client has not prompted yet. 401 with the prompt
  // kind, and it must NOT burn an attempt.
  const bare = await exportCall(tokenFor(1));
  assert.strictEqual(bare.status, 401);
  assert.strictEqual(bare.body.reauthRequired, 'password');

  // Five wrong guesses.
  for (let i = 0; i < 5; i++) {
    const wrong = await exportCall(tokenFor(1), { password: 'WrongGuess9' });
    assert.strictEqual(wrong.status, 401, wrong.text);
  }
  // The sixth answer is a lockout, even with the RIGHT password.
  const locked = await exportCall(tokenFor(1), { password: PASSWORD });
  assert.strictEqual(locked.status, 429, locked.text);

  // Nothing was exported along the way.
  assert.ok(!sql.some((s) => s.includes('FROM messages WHERE sender_id')), 'a refused request still ran export queries');
});

test('export guesses and deletion guesses share one budget', async () => {
  // The whole point of proofFailures is one per-account ceiling across every
  // password-proof surface. If export guesses were counted separately, this
  // route would hand an attacker five fresh bcrypt guesses.
  for (let i = 0; i < 5; i++) await exportCall(tokenFor(1), { password: 'WrongGuess9' });

  const res = await fetch(`${base}/api/users/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenFor(1)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.strictEqual(res.status, 429, await res.text());
});

test('an OAuth account needs a session minted by a recent provider sign-in', async () => {
  const stale = await exportCall(tokenFor(2, { ageSeconds: Math.ceil(REAUTH_WINDOW_MS / 1000) + 60 }));
  assert.strictEqual(stale.status, 401);
  assert.strictEqual(stale.body.reauthRequired, 'reauth');
  assert.ok(!sql.some((s) => s.includes('FROM messages WHERE sender_id')), 'a stale session still ran export queries');

  const fresh = await exportCall(tokenFor(2));
  assert.strictEqual(fresh.status, 200, fresh.text);
  assertModelled();
  assert.strictEqual(fresh.body.profile.sign_in_method, 'apple');
  // And still no credential: the Apple refresh token lives on this very row.
  assert.ok(!fresh.text.includes('apple-secret-refresh-token'));
});

test('an oversized password header is a client bug, answered 400, not a guess', async () => {
  const res = await exportCall(tokenFor(1), { password: 'x'.repeat(2000) });
  assert.strictEqual(res.status, 400);
  // It must not have burned an attempt: the real password still works.
  const ok = await exportCall(tokenFor(1), { password: PASSWORD });
  assert.strictEqual(ok.status, 200, ok.text);
});

// ===========================================================================
// 4. Metering: proven exports are capped; unproven ones cost the owner nothing
// ===========================================================================

test('five proven exports an hour, then 429 — and a failed proof never spends the quota', async () => {
  // A wrong guess first: proof runs BEFORE metering, so this must not count.
  await exportCall(tokenFor(1), { password: 'WrongGuess9' });

  for (let i = 0; i < 5; i++) {
    const res = await exportCall(tokenFor(1), { password: PASSWORD });
    assert.strictEqual(res.status, 200, `export ${i + 1}: ${res.text}`);
  }
  const capped = await exportCall(tokenFor(1), { password: PASSWORD });
  assert.strictEqual(capped.status, 429, capped.text);
  // The refusal is the meter's, not the proof's: the password was right.
  assert.ok(capped.body.error.toLowerCase().includes('exported'), capped.text);
});

// ===========================================================================
// 5. The sync bound: row caps hold and the file says when they bit
// ===========================================================================

test('a section past its row cap is truncated and says so', async () => {
  MESSAGES = [];
  for (let i = 0; i < EXPORT_MESSAGE_ROW_CAP + 3; i++) {
    MESSAGES.push({
      id: 1000 + i, flock_id: 7, sender_id: 1, message_text: `m${i}`, message_type: 'text',
      venue_data: null, image_url: null, created_at: '2026-03-01T00:00:00Z',
    });
  }
  const res = await exportCall(tokenFor(1), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.flock_messages.length, EXPORT_MESSAGE_ROW_CAP);
  assert.deepStrictEqual(res.body.truncated_sections, ['flock_messages']);

  // And the caps the bound is stated in are the caps actually used.
  assert.ok(EXPORT_MESSAGE_ROW_CAP <= 5000 && EXPORT_ROW_CAP <= 2000,
    'the caps grew past the bound the sync-response decision was justified with');
});
