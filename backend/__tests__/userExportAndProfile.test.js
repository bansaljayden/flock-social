// Run: node --test  (from backend/)
//
// The 2026-08-14 sweep of backend/routes/users.js, in four parts:
//
//   1. EXPORT COMPLETENESS. The privacy policy's "What we collect" list
//      (frontend/src/website/PrivacyPolicy.js) also names venue votes, emoji
//      reactions, venue reviews, crowd reports, bill splits, and stored SOS
//      alerts — all keyed to the account, all absent from the first cut of
//      GET /api/users/export. Each now appears, and the top-level key set is
//      pinned so a section cannot quietly vanish (or quietly appear) again.
//   2. EXPORT LEAKAGE. The new sections must obey the same Art. 20(4) line the
//      old ones do: the venue owner's reply to a review, another member's
//      bill-split share, the model's predicted_score, and a pending/declined
//      friendship (the other person's undecided or negative decision) must
//      never appear.
//   3. AUTHORIZATION. The export is keyed on req.user.id and nothing else — no
//      query parameter, body field, or header can point it at another account.
//   4. PROFILE WRITES. PUT /profile ignores privileged columns in the body
//      (mass-assignment matrix), and the payment-handle routes refuse link
//      shapes in the one free-text handle (zelle) that other members' bill
//      screens render.
//
// Plus the avatar upload's magic-byte typing, pinned as a unit because other
// upload paths were copied from it.
//
// No database is touched: pool.query is stubbed the way dataExport.test.js
// does it, and the fixture honours each query's WHERE the way real Postgres
// would, so a query keyed on the wrong id shows up as a leak in the body.
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
  detectImageFormat,
  DETECTED_MIME,
  proofFailures,
  exportRequests,
} = usersRouter.__testing;

// ── Fixture ────────────────────────────────────────────────────────────────
const PASSWORD = 'CorrectHorse1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // cheap rounds: this is a test

// Sentinels that must NEVER appear in user 1's export.
const VENUE_REPLY = 'VENUE-OWNER-REPLY-DO-NOT-EXPORT';
const OTHERS_SHARE = '88.88';
const OTHERS_VOTE = 'OTHERS-VOTE-DO-NOT-EXPORT';
const OTHERS_CROWD_VENUE = 'OTHERS-CROWD-REPORT-DO-NOT-EXPORT';

let USERS;
let sql;      // every statement the routes ran: { text, params }
let unknown;  // statements the fixture did not model

function reset() {
  USERS = {
    1: {
      id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true,
      is_banned: false, banned_at: null, token_version: 0, password: PASSWORD_HASH,
      phone: '+12025550101', interests: ['hiking'], bio: 'my exported bio words',
      profile_image_url: null, venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
      is_premium: false, oauth_provider: null, oauth_id: null,
      apple_refresh_token: null, terms_accepted_at: '2026-01-01T00:00:00Z',
      date_of_birth: '2008-05-01', reliability_score: '92.50',
      total_plans_joined: 4, total_plans_attended: 3,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    },
    2: {
      id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', email_verified: true,
      is_banned: false, banned_at: null, token_version: 0, password: null,
      phone: null, interests: [], profile_image_url: null,
      venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
      is_premium: false, oauth_provider: 'apple', oauth_id: 'apple-sub-2',
      apple_refresh_token: null, terms_accepted_at: null, date_of_birth: '2007-02-02',
      reliability_score: null, total_plans_joined: 0, total_plans_attended: 0,
      created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
    },
  };
  sql = [];
  unknown = [];
  proofFailures.clearAll();
  exportRequests.clearAll();
}
reset();

// Per-table rows, both users', so a query keyed on the wrong column leaks.
const VENUE_VOTES = [
  { id: 1, flock_id: 7, user_id: 1, venue_name: 'Taco Spot', venue_id: 'place-abc', created_at: '2026-03-01T00:00:00Z' },
  { id: 2, flock_id: 7, user_id: 2, venue_name: OTHERS_VOTE, venue_id: 'place-x', created_at: '2026-03-01T00:01:00Z' },
];
const DM_VENUE_VOTES = [
  { id: 1, user1_id: 1, user2_id: 2, user_id: 1, venue_name: 'Coffee Bar', venue_id: 'place-cc', created_at: '2026-03-02T00:00:00Z' },
  { id: 2, user1_id: 1, user2_id: 2, user_id: 2, venue_name: OTHERS_VOTE, venue_id: 'place-x', created_at: '2026-03-02T00:01:00Z' },
];
const REACTIONS = [
  { id: 1, message_id: 10, user_id: 1, emoji: '🔥', created_at: '2026-03-03T00:00:00Z' },
  { id: 2, message_id: 10, user_id: 2, emoji: '💀', created_at: '2026-03-03T00:01:00Z' },
];
const DM_REACTIONS = [
  { id: 1, dm_id: 20, user_id: 1, emoji: '👍', created_at: '2026-03-03T01:00:00Z' },
];
const REVIEWS = [
  { id: 1, google_place_id: 'place-abc', user_id: 1, rating: 4, text: 'my own review words',
    venue_reply: VENUE_REPLY, venue_replied_at: '2026-03-05T00:00:00Z', created_at: '2026-03-04T00:00:00Z' },
];
const CROWD_REPORTS = [
  { id: 1, user_id: 1, flock_id: 7, venue_place_id: 'place-abc', venue_name: 'Taco Spot',
    crowd_level: 2, price_worth: true, rating: 4, predicted_score: 61,
    day_of_week: 5, hour: 21, created_at: '2026-03-04T02:00:00Z' },
  { id: 2, user_id: 2, flock_id: 7, venue_place_id: 'place-x', venue_name: OTHERS_CROWD_VENUE,
    crowd_level: 3, price_worth: false, rating: 1, predicted_score: 12,
    day_of_week: 5, hour: 22, created_at: '2026-03-04T02:01:00Z' },
];
const BILLS = [
  { id: 100, flock_id: 7, total_amount: '50.00', tip_percent: '20.0', paid_by: 2, created_at: '2026-03-05T00:00:00Z' },
  { id: 101, flock_id: 8, total_amount: '30.00', tip_percent: '0.0', paid_by: 1, created_at: '2026-03-06T00:00:00Z' },
];
const SHARES = [
  { id: 1, bill_id: 100, user_id: 1, amount: '12.50', committed: true, settled: false, settled_at: null },
  { id: 2, bill_id: 100, user_id: 2, amount: OTHERS_SHARE, committed: true, settled: true, settled_at: '2026-03-05T01:00:00Z' },
  { id: 3, bill_id: 101, user_id: 1, amount: '15.00', committed: true, settled: true, settled_at: '2026-03-06T01:00:00Z' },
];
const SOS = [
  { id: 1, user_id: 1, latitude: 40.7128, longitude: -74.006, contacts_alerted: 2, created_at: '2026-03-07T00:00:00Z' },
  { id: 2, user_id: 2, latitude: 34.0522, longitude: -118.2437, contacts_alerted: 1, created_at: '2026-03-07T00:01:00Z' },
];
const STORIES = [
  { id: 1, user_id: 1, caption: 'my story caption', image_url: 'data:image/png;base64,c3RvcnktYnl0ZXM=',
    created_at: '2026-03-08T00:00:00Z', expires_at: '2026-03-09T00:00:00Z' },
];
const FRIENDSHIPS = [
  { id: 1, requester_id: 1, addressee_id: 2, status: 'accepted', created_at: '2026-02-15T00:00:00Z' },
  { id: 2, requester_id: 3, addressee_id: 1, status: 'pending', created_at: '2026-02-16T00:00:00Z' },
  { id: 3, requester_id: 1, addressee_id: 4, status: 'declined', created_at: '2026-02-17T00:00:00Z' },
];

const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : row[c]]));
const capped = (rows, limitParam) => (Number.isFinite(Number(limitParam)) ? rows.slice(0, Number(limitParam)) : rows);

function handle(text, params = []) {
  sql.push({ text, params });
  const has = (s) => text.includes(s);
  const uid = params[0];

  // middleware/auth.js
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[uid];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  // PUT /profile re-reads the whole row
  if (text.startsWith('SELECT * FROM users WHERE id = $1')) {
    const u = USERS[uid];
    return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
  }
  // the export's account fetch
  if (has('reliability_score') && has('FROM users WHERE id = $1')) {
    const u = USERS[uid];
    return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
  }
  // PUT /profile's UPDATE
  if (has('UPDATE users') && has('SET name = COALESCE')) {
    const u = USERS[params[5]];
    if (!u) return { rows: [], rowCount: 0 };
    const updated = { ...u, name: params[0] || u.name };
    return {
      rows: [pick(updated, ['id', 'email', 'name', 'phone', 'interests', 'role',
        'profile_image_url', 'email_verified', 'token_version', 'created_at', 'updated_at'])],
      rowCount: 1,
    };
  }
  // payment-methods UPDATE (dynamic SET clause, id is the LAST parameter)
  if (text.startsWith('UPDATE users SET') && (has('venmo_username') || has('cashapp_cashtag') || has('zelle_identifier'))) {
    return { rows: [], rowCount: 1 };
  }

  // export sections, filtered exactly the way Postgres would
  if (has('JOIN flocks f ON f.id = fm.flock_id')) return { rows: [], rowCount: 0 };
  if (has('FROM messages WHERE sender_id = $1')) return { rows: [], rowCount: 0 };
  if (has('FROM direct_messages WHERE sender_id = $1')) return { rows: [], rowCount: 0 };
  if (has('FROM budget_submissions WHERE user_id = $1')) return { rows: [], rowCount: 0 };
  if (has('FROM venue_checkins WHERE user_id = $1')) return { rows: [], rowCount: 0 };
  if (has('FROM content_reports WHERE reporter_id = $1')) return { rows: [], rowCount: 0 };
  if (has('FROM trusted_contacts WHERE user_id = $1')) return { rows: [], rowCount: 0 };
  if (has('FROM calendar_events WHERE user_id = $1')) return { rows: [], rowCount: 0 };
  if (has('FROM user_settings WHERE user_id = $1')) return { rows: [], rowCount: 0 };
  if (has('FROM availability_pulses WHERE user_id = $1')) return { rows: [], rowCount: 0 };

  if (has('FROM venue_votes WHERE user_id = $1')) {
    const rows = VENUE_VOTES.filter((r) => r.user_id === uid)
      .map((r) => pick(r, ['flock_id', 'venue_name', 'venue_id', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM dm_venue_votes WHERE user_id = $1')) {
    const rows = DM_VENUE_VOTES.filter((r) => r.user_id === uid)
      .map((r) => pick(r, ['venue_name', 'venue_id', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM emoji_reactions WHERE user_id = $1')) {
    const rows = REACTIONS.filter((r) => r.user_id === uid).map((r) => pick(r, ['emoji', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM dm_emoji_reactions WHERE user_id = $1')) {
    const rows = DM_REACTIONS.filter((r) => r.user_id === uid).map((r) => pick(r, ['emoji', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM venue_reviews WHERE user_id = $1')) {
    const rows = REVIEWS.filter((r) => r.user_id === uid)
      .map((r) => pick(r, ['google_place_id', 'rating', 'text', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM venue_feedback WHERE user_id = $1')) {
    const rows = CROWD_REPORTS.filter((r) => r.user_id === uid)
      .map((r) => pick(r, ['flock_id', 'venue_place_id', 'venue_name', 'crowd_level', 'price_worth', 'rating', 'day_of_week', 'hour', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('JOIN bill_splits b ON b.id = s.bill_id')) {
    const rows = SHARES.filter((s) => s.user_id === uid).map((s) => {
      const b = BILLS.find((x) => x.id === s.bill_id);
      const youPaid = b.paid_by === uid;
      return {
        flock_id: b.flock_id, your_share: s.amount, committed: s.committed,
        settled: s.settled, settled_at: s.settled_at, you_paid: youPaid,
        total_amount: youPaid ? b.total_amount : null,
        tip_percent: youPaid ? b.tip_percent : null,
        created_at: b.created_at,
      };
    });
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM emergency_alerts WHERE user_id = $1')) {
    const rows = SOS.filter((r) => r.user_id === uid)
      .map((r) => pick(r, ['latitude', 'longitude', 'contacts_alerted', 'created_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM stories WHERE user_id = $1')) {
    const rows = STORIES.filter((r) => r.user_id === uid)
      .map((r) => pick(r, ['caption', 'image_url', 'created_at', 'expires_at']));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
  }
  if (has('FROM friendships')) {
    // The fixture applies the route's own status filter only if the route
    // wrote one; a route that forgot it exports the pending/declined rows.
    const accepted = has("status = 'accepted'");
    const rows = FRIENDSHIPS
      .filter((f) => (f.requester_id === uid || f.addressee_id === uid) && (!accepted || f.status === 'accepted'))
      .map((f) => ({
        friend_user_id: f.requester_id === uid ? f.addressee_id : f.requester_id,
        request_direction: f.requester_id === uid ? 'sent' : 'received',
        created_at: f.created_at,
      }));
    return { rows: capped(rows, params[1]), rowCount: rows.length };
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

function tokenFor(id) {
  return jwt.sign({ userId: id, tv: USERS[id]?.token_version || 0 }, process.env.JWT_SECRET);
}

async function exportCall(token, { password = PASSWORD, query = '', headers = {} } = {}) {
  const res = await fetch(`${base}/api/users/export${query}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(password !== undefined ? { 'X-Export-Password': password } : {}),
      ...headers,
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

async function call(method, path, body, token = tokenFor(1)) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

const assertModelled = () => assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');
const updates = () => sql.filter((s) => /UPDATE users\s+SET/i.test(s.text));

// ===========================================================================
// 1. Export completeness: every table the privacy policy promises
// ===========================================================================

test('the export carries votes, reactions, reviews, crowd reports, bill splits, SOS alerts, stories, and friends', async () => {
  const res = await exportCall(tokenFor(1));
  assert.strictEqual(res.status, 200, res.text);
  assertModelled();
  const b = res.body;

  assert.strictEqual(b.venue_votes[0].venue_name, 'Taco Spot');
  assert.strictEqual(b.dm_venue_votes[0].venue_name, 'Coffee Bar');
  assert.strictEqual(b.emoji_reactions[0].emoji, '🔥');
  assert.strictEqual(b.dm_emoji_reactions[0].emoji, '👍');
  assert.strictEqual(b.venue_reviews[0].text, 'my own review words');
  assert.strictEqual(b.crowd_reports[0].crowd_level, 2);
  assert.strictEqual(b.crowd_reports[0].venue_place_id, 'place-abc');
  assert.strictEqual(b.sos_alerts[0].latitude, 40.7128);
  assert.strictEqual(b.friends.length, 1);
  assert.strictEqual(b.friends[0].friend_user_id, 2);
  // The bio is data the user typed about themselves, so the export carries it
  // (migration 026 / routes/users.js profile pick list).
  assert.strictEqual(b.profile.bio, 'my exported bio words');

  // Bill splits: own share always; the bill's total only where the caller paid.
  const owed = b.bill_splits.find((x) => x.you_paid === false);
  const paid = b.bill_splits.find((x) => x.you_paid === true);
  assert.strictEqual(owed.your_share, '12.50');
  assert.strictEqual(owed.total_amount, null, 'a bill total the caller did not enter is group data, not theirs');
  assert.strictEqual(paid.total_amount, '30.00');

  // Stories: caption exported, inline image replaced by the marker.
  assert.strictEqual(b.stories[0].caption, 'my story caption');
  assert.strictEqual(b.stories[0].image_url, null);
  assert.strictEqual(b.stories[0].image_omitted, true);
  assert.ok(!res.text.includes('c3RvcnktYnl0ZXM='), 'inline story bytes leaked');
});

test('the top-level key set is pinned exactly', async () => {
  const res = await exportCall(tokenFor(1));
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(Object.keys(res.body).sort(), [
    'availability', 'bill_splits', 'budget_submissions', 'calendar_events',
    'crowd_reports', 'direct_messages_sent', 'dm_emoji_reactions',
    'dm_venue_votes', 'emoji_reactions', 'export_format', 'flock_messages',
    'flocks', 'friends', 'profile', 'reports_filed', 'settings', 'sos_alerts',
    'stories', 'truncated_sections', 'trusted_contacts', 'venue_checkins',
    'venue_reviews', 'venue_votes',
  ]);
});

// ===========================================================================
// 2. Export leakage: the new sections hold the Art. 20(4) line too
// ===========================================================================

test('no other person\'s data, no venue reply, no model output in the new sections', async () => {
  const res = await exportCall(tokenFor(1));
  assert.strictEqual(res.status, 200, res.text);
  const raw = res.text;

  assert.ok(!raw.includes(OTHERS_VOTE), 'another user\'s vote leaked');
  assert.ok(!raw.includes(OTHERS_CROWD_VENUE), 'another user\'s crowd report leaked');
  assert.ok(!raw.includes(OTHERS_SHARE), 'another member\'s bill share leaked');
  assert.ok(!raw.includes(VENUE_REPLY), 'the venue owner\'s reply leaked');
  assert.ok(!raw.includes('predicted_score'), 'a derived model output leaked');
  assert.ok(!raw.includes('bob@example.com'), 'another user\'s email leaked');

  // And out of the SELECTs themselves, not just the response.
  const reviewSql = sql.find((s) => s.text.includes('FROM venue_reviews'));
  assert.ok(reviewSql, 'venue_reviews query not run');
  for (const col of ['venue_reply', 'venue_replied_at']) {
    assert.ok(!reviewSql.text.includes(col), `venue_reviews SELECT names ${col}`);
  }
  const crowdSql = sql.find((s) => s.text.includes('FROM venue_feedback'));
  assert.ok(!crowdSql.text.includes('predicted_score'), 'crowd report SELECT names predicted_score');
  const dmVoteSql = sql.find((s) => s.text.includes('FROM dm_venue_votes'));
  assert.ok(!dmVoteSql.text.includes('user1_id') && !dmVoteSql.text.includes('user2_id'),
    'the DM vote SELECT names the conversation pair');
});

test('pending and declined friendships are the other person\'s decision and stay out', async () => {
  const res = await exportCall(tokenFor(1));
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.friends.map((f) => f.friend_user_id), [2]);
  const friendSql = sql.find((s) => s.text.includes('FROM friendships'));
  assert.ok(friendSql.text.includes("status = 'accepted'"), 'the friendships query does not filter on accepted');
});

// ===========================================================================
// 3. Authorization: no parameter redirects the export
// ===========================================================================

test('the export cannot be pointed at another account by any parameter', async () => {
  const res = await exportCall(tokenFor(1), {
    query: '?user_id=2&userId=2&id=2',
    headers: { 'X-User-Id': '2' },
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.profile.id, 1);
  assert.strictEqual(res.body.profile.email, 'alice@example.com');
  assert.ok(!res.text.includes('bob@example.com'));

  // Every per-user query the export ran was keyed on the caller's own id.
  const exportQueries = sql.filter((s) => /LIMIT \$2|user_settings|availability_pulses/.test(s.text));
  assert.ok(exportQueries.length >= 10, 'the export ran fewer queries than it has sections');
  for (const q of exportQueries) {
    assert.strictEqual(q.params[0], 1, `an export query was keyed on ${q.params[0]}: ${q.text.slice(0, 60)}`);
  }
});

test('the export stays metered: five proven exports, then 429', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await exportCall(tokenFor(1));
    assert.strictEqual(res.status, 200, `export ${i + 1}: ${res.text}`);
  }
  const capped6 = await exportCall(tokenFor(1));
  assert.strictEqual(capped6.status, 429, capped6.text);
});

// ===========================================================================
// 4. PUT /profile: the mass-assignment matrix
// ===========================================================================

const FORBIDDEN_FIELDS = {
  is_premium: true,
  role: 'admin',
  reliability_score: 100,
  token_version: 99,
  is_banned: false,
  email_verified: true,
  oauth_provider: 'google',
  profile_image_url: 'https://evil.example/x.png',
  password: 'Sneaky1A', // NOT new_password: raw column name in the body
  apple_refresh_token: 'stolen',
};

test('privileged body fields never reach the UPDATE, together or alone', async () => {
  const res = await call('PUT', '/api/users/profile', {
    name: 'New Name', current_password: PASSWORD, ...FORBIDDEN_FIELDS,
  });
  assert.strictEqual(res.status, 200, res.text);
  assertModelled();

  const update = updates().find((s) => s.text.includes('SET name = COALESCE'));
  assert.ok(update, 'the profile UPDATE never ran');
  // The statement's SET list is fixed: none of the privileged columns appear
  // in it. (RETURNING may READ columns like role and profile_image_url; only
  // the part before WHERE writes anything.)
  const setClause = update.text.slice(0, update.text.indexOf('WHERE id'));
  for (const col of ['is_premium', 'reliability_score', 'is_banned', 'oauth_provider', 'profile_image_url', 'apple_refresh_token']) {
    assert.ok(!setClause.includes(col), `the UPDATE's SET list names ${col}`);
  }
  assert.ok(!/\brole\s*=/.test(setClause), 'the UPDATE writes role');
  // token_version appears only as the CASE-gated bump, and the gate ($5, the
  // hashed new password) is null because no new_password was sent — the body's
  // raw `password` field must not have become one. The trailing nulls are $7
  // (bio, unsent here) and the contact-discovery trio $8/$9/$10, which are
  // non-null only when the phone actually moved. All four sit AFTER the id so
  // params[5] stays the user id.
  assert.deepStrictEqual(update.params, ['New Name', null, null, null, null, 1, null, null, null, null]);
  // And the response reflects the database, not the body.
  assert.strictEqual(res.body.user.role, 'user');
  assert.strictEqual(res.body.user.is_premium, undefined);

  // The matrix, one field at a time.
  for (const [field, value] of Object.entries(FORBIDDEN_FIELDS)) {
    sql = [];
    const one = await call('PUT', '/api/users/profile', { current_password: PASSWORD, [field]: value });
    assert.strictEqual(one.status, 200, `${field}: ${one.text}`);
    const u = updates().find((s) => s.text.includes('SET name = COALESCE'));
    assert.ok(u, `${field}: the profile UPDATE never ran`);
    assert.deepStrictEqual(u.params, [null, null, null, null, null, 1, null, null, null, null],
      `${field} altered the UPDATE's parameters`);
  }
});

// ===========================================================================
// 5. Payment handles: link shapes cannot become a payment instruction
// ===========================================================================

test('a Zelle identifier that is a link is refused; real identifiers save', async () => {
  for (const link of [
    'https://evil.example/pay',
    'http://evil.example',
    'www.evil.example',
    'evil.example/steal',
    'HTTPS://EVIL.EXAMPLE',
    'zelle://payme',
  ]) {
    sql = [];
    const res = await call('PUT', '/api/users/payment-methods', { zelle_identifier: link });
    assert.strictEqual(res.status, 400, `"${link}" was accepted: ${res.text}`);
    assert.deepStrictEqual(updates(), [], `"${link}" reached the database`);
  }

  for (const good of ['ava@example.com', '+1 (202) 555-0101', '2025550101']) {
    sql = [];
    const res = await call('PUT', '/api/users/payment-methods', { zelle_identifier: good });
    assert.strictEqual(res.status, 200, `"${good}" was refused: ${res.text}`);
    const u = updates()[0];
    assert.ok(u && u.params.includes(good), `"${good}" was not written`);
  }
});

test('venmo and cashapp charsets already exclude links and markup', async () => {
  for (const [field, value] of [
    ['venmo_username', 'https://evil'],
    ['venmo_username', '<b>ava</b>'],
    ['cashapp_cashtag', 'a/b'],
    ['cashapp_cashtag', 'evil.example'],
  ]) {
    sql = [];
    const res = await call('PUT', '/api/users/payment-methods', { [field]: value });
    assert.strictEqual(res.status, 400, `${field}="${value}" was accepted: ${res.text}`);
    assert.deepStrictEqual(updates(), [], `${field}="${value}" reached the database`);
  }
});

// ===========================================================================
// 6. Avatar magic bytes: the model other upload paths were copied from
// ===========================================================================

test('detectImageFormat answers from bytes, with full signatures, and DETECTED_MIME covers every answer', () => {
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('rest')]);
  const gif87 = Buffer.concat([Buffer.from('GIF87a', 'latin1'), Buffer.from([0x01])]);
  const gif89 = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x01])]);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1')]);

  assert.strictEqual(detectImageFormat(jpeg), 'jpeg');
  assert.strictEqual(detectImageFormat(png), 'png');
  assert.strictEqual(detectImageFormat(gif87), 'gif');
  assert.strictEqual(detectImageFormat(gif89), 'gif');
  assert.strictEqual(detectImageFormat(webp), 'webp');

  // The refusals that keep the two byte-typers in this repo agreeing:
  // a truncated PNG signature, an unpublished GIF version, and a RIFF
  // container that is a WAV, not a WebP.
  assert.strictEqual(detectImageFormat(Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.from('zzzz')])), null);
  assert.strictEqual(detectImageFormat(Buffer.from('GIF88a', 'latin1')), null);
  assert.strictEqual(detectImageFormat(Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ', 'latin1')])), null);
  assert.strictEqual(detectImageFormat(Buffer.alloc(0)), null);
  assert.strictEqual(detectImageFormat(Buffer.from('not an image')), null);

  // Belt: every detectable format maps to a real image/* MIME, so no future
  // signature can ship data:undefined avatars.
  for (const [buf, format] of [[jpeg, 'jpeg'], [png, 'png'], [gif87, 'gif'], [webp, 'webp']]) {
    assert.strictEqual(detectImageFormat(buf), format);
    assert.match(DETECTED_MIME[format], /^image\/[a-z]+$/);
  }
});
