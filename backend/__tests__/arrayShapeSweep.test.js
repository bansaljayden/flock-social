// Run: node --test  (from backend/)
//
// THE COERCED NON-SCALAR, swept across the twelve routers audited in round 19.
//
// express-validator's validators coerce a value before they test it, so a
// ONE-ELEMENT ARRAY satisfies rules that appear to constrain a scalar —
// isLength, isIn, isFloat, isInt, isUUID, matches — and an EMPTY array
// satisfies the length and range rules vacuously. The value then stays an array
// in req.body, because sanitizers return non-strings untouched. That is two
// failures in one request:
//
//   * it walks past stripHtml AND past rejectIfProfane (utils/moderation.js
//     `moderateText` answers allowed:true for anything that is not a string),
//     so a field the route believed it had screened was never screened; and
//   * node-postgres serialises it as a Postgres array literal against a scalar
//     column, which is a 500 (22P02 on numeric/uuid, 22001 on an over-narrow
//     VARCHAR, 23514 on a CHACK-constrained enum) rather than a 400.
//
// Two siblings are swept with it: an OBJECT value, and a NULL where the chain's
// `.optional()` skips only `undefined`.
//
// HOW THESE TESTS ASSERT. Each bad-shape request must be a 400 AND must not
// reach the database at all — the route-level query log has to be empty. That
// is the property that matters: "settle the shape before any validator,
// sanitizer or query sees it". Asserting on the response body alone would pass
// for a route that stored the array and merely rendered it politely.
//
// The control in the other direction is just as important: a well-shaped
// payload must still get PAST validation. Those tests assert the request
// reached the database (and answers the route's own authorization refusal),
// which proves the guard is not a blanket refusal.
//
// No database: pool.query / pool.connect are fixtures. Anything a guarded
// request issues beyond the auth lookup is recorded and reported.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-array-shape-sweep';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // keep push a no-op
delete process.env.RESEND_API_KEY;

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Fixture plumbing ────────────────────────────────────────────────────────
const USER = {
  id: 1, email: 'ava@example.com', name: 'Ava', role: 'user',
  profile_image_url: null, email_verified: true, is_banned: false, token_version: 0,
};

let routeQueries;  // every statement issued AFTER the auth lookup
function reset() { routeQueries = []; }
reset();

const AUTH_SQL = /^SELECT id, email, name, role,.* FROM users WHERE id = \$1$/i;

function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) return Promise.resolve({ rows: [USER], rowCount: 1 });

  routeQueries.push({ sql, params });

  // Everything a guarded route could reach on the way to its own refusal.
  // Deliberately answers "nothing found" so each route stops at its own
  // membership / ownership / link check rather than running a whole flow.
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rows: [] });
  if (/pg_advisory/i.test(sql)) return Promise.resolve({ rows: [{}] });
  // routes/safety.js is reached all the way to its INSERT by the tests at the
  // bottom, which need to inspect what a non-scalar `relationship` became.
  if (/COUNT\(\*\)::int AS n FROM trusted_contacts/i.test(sql)) return Promise.resolve({ rows: [{ n: 0 }] });
  if (/AS last_hour/i.test(sql)) return Promise.resolve({ rows: [{ last_hour: 0, active: 0 }] });
  if (/^INSERT INTO trusted_contacts/i.test(sql)) {
    contactInsert = params;
    return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 });
  }

  // Opt-in: enough of the guest-vote world to let the fan-out tests run the
  // whole route, including the member-facing tally it now delegates to
  // routes/venues.js.
  if (guestVoteReachesFanout) {
    if (/FROM flock_invite_links/i.test(sql)) {
      return Promise.resolve({ rows: [{ flock_id: 10, name: 'Dinner', event_time: null, venue_name: null, status: 'planning', host_name: 'Ava B' }] });
    }
    if (/SELECT id FROM guest_rsvps WHERE guest_token/i.test(sql)) return Promise.resolve({ rows: [{ id: 7 }] });
    if (/UNION SELECT 1 FROM guest_votes/i.test(sql)) return Promise.resolve({ rows: [{ '?column?': 1 }] });
    if (/SUM\(c\)::int AS votes/i.test(sql)) return Promise.resolve({ rows: [{ venue_name: 'The Bar', votes: 3 }] });
    if (/MIN\(venue_id\) FILTER/i.test(sql)) {
      return Promise.resolve({ rows: [{ venue_name: 'The Bar', venue_id: 'abc', member_count: 2, voter_rows: [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }] }] });
    }
    if (/AS guest_count/i.test(sql)) return Promise.resolve({ rows: [{ venue_name: 'The Bar', guest_count: 1 }] });
    if (/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/i.test(sql)) {
      return Promise.resolve({ rows: [{ user_id: 1 }, { user_id: 2 }] });
    }
    if (/FROM user_blocks WHERE blocker_id = ANY/i.test(sql)) return Promise.resolve({ rows: blocksFixture });
  }

  // Opt-in: enough of routes/billing.js's world to let one test run the create
  // flow all the way to the bill_splits UPSERT. Off by default, so every other
  // test still sees "nothing found" and stops at the route's own refusal.
  if (billingReachesInsert) {
    if (/FROM flock_members fm JOIN users u/i.test(sql)) return Promise.resolve({ rows: [{ id: 1, name: 'Ava' }] });
    if (/FROM flock_members WHERE flock_id/i.test(sql)) return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 });
    if (/SELECT name, creator_id FROM flocks/i.test(sql)) return Promise.resolve({ rows: [{ name: 'Dinner', creator_id: 1 }] });
    if (/^INSERT INTO bill_splits/i.test(sql)) {
      billInsert = params;
      return Promise.resolve({ rows: [{ id: 99 }] });
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
let contactInsert = null;
let billingReachesInsert = false;
let billInsert = null;
let guestVoteReachesFanout = false;
let blocksFixture = [];

// Records every room an event was addressed to, with its payload.
function fakeIo() {
  const sent = [];
  return {
    sent,
    to(room) { return { emit: (event, payload) => sent.push({ room, event, payload }) }; },
  };
}

pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({
  query: (text, params) => dispatch(text, params),
  release: () => {},
});

// ── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.set('io', null);
// Mount order mirrors server.js, and that ordering is load-bearing: messages.js
// and moderation.js are mounted on the bare `/api` prefix and call
// `router.use(authenticate)`, so anything registered after them that lives
// under /api would be answered 401 by the catch-all before its own router ever
// ran. Guest is unauthenticated and has to come first, exactly as in server.js.
app.use('/api/guest', require('../routes/guest').router);
app.use('/api/checkin', require('../routes/checkin'));
app.use('/api', require('../routes/moderation'));
app.use('/api', require('../routes/messages'));
app.use('/api/flocks', require('../routes/venues'));
app.use('/api/stories', require('../routes/stories'));
app.use('/api/safety', require('../routes/safety'));
app.use('/api/feedback', require('../routes/feedback'));
app.use('/api/budget', require('../routes/budget'));
app.use('/api/billing', require('../routes/billing'));
app.use('/api/notifications', require('../routes/notifications'));
app.use('/api/venue-profile', require('../routes/venueProfile'));

let server, base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const TOKEN = () => signUserToken(USER);

async function call(method, path, body, { auth = true } = {}) {
  reset();
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${TOKEN()}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// The three shapes, plus the multi-element array that satisfies isLength by
// joining ("a,b" is three characters) and the empty array that satisfies every
// length and range rule by having nothing to check.
const ARRAYS = [[], ['x'], ['a', 'b'], [1], [['x']]];
const OBJECTS = [{}, { a: 1 }, { $ne: null }];
const NON_SCALARS = [...ARRAYS, ...OBJECTS];

// A bad shape must be refused BEFORE anything is queried. `routeQueries` is
// captured per-call by `call()`.
async function refusedBeforeSql(method, path, payload, label, opts) {
  const res = await call(method, path, payload, opts);
  assert.strictEqual(res.status, 400, `${label} -> ${res.status} ${res.text}`);
  assert.deepStrictEqual(routeQueries.map((q) => q.sql), [],
    `${label}: reached the database anyway`);
}

// Sweep every listed field of one route with every bad shape.
function sweep(name, { method, path, base: basePayload, fields, auth = true }) {
  test(`${name}: a non-scalar in any scalar field is a 400 before any query`, async () => {
    for (const field of fields) {
      for (const v of NON_SCALARS) {
        await refusedBeforeSql(
          method, path, { ...basePayload(), [field]: v },
          `${name} ${field}=${JSON.stringify(v)}`, { auth }
        );
      }
    }
  });
}

// ── The sweep ───────────────────────────────────────────────────────────────

// guest.js is the only UNAUTHENTICATED write surface in the app, and every
// value it takes is re-broadcast to the flock over `guest_rsvp` and pushed to
// the host, so it is the router that could least afford this. `name` fed
// stripHtml + rejectIfProfane and a VARCHAR(60); `status` fed a CHECK
// constraint; `guestToken` fed a UUID column.
sweep('guest RSVP', {
  method: 'POST', path: '/api/guest/abcd1234efgh/rsvp', auth: false,
  base: () => ({ name: 'Sam', status: 'in' }),
  fields: ['name', 'status', 'guestToken'],
});

sweep('guest vote', {
  method: 'POST', path: '/api/guest/abcd1234efgh/vote', auth: false,
  base: () => ({ guestToken: '9d3f1b2e-1111-4111-8111-111111111111', venueName: 'The Bar' }),
  fields: ['guestToken', 'venueName'],
});

// The one text field in flock chat, and its DM twin.
sweep('flock message', {
  method: 'POST', path: '/api/flocks/10/messages',
  base: () => ({ message_text: 'hi' }),
  fields: ['message_text', 'message_type', 'image_url'],
});

sweep('direct message', {
  method: 'POST', path: '/api/dm/2',
  base: () => ({ message_text: 'hi' }),
  fields: ['message_text', 'message_type', 'image_url', 'reply_to_id'],
});

sweep('flock reaction', {
  method: 'POST', path: '/api/messages/5/react',
  base: () => ({ emoji: '👍' }),
  fields: ['emoji'],
});

sweep('DM venue vote', {
  method: 'POST', path: '/api/dm/2/venue-votes',
  base: () => ({ venue_name: 'The Bar' }),
  fields: ['venue_name'],
});

sweep('venue vote', {
  method: 'POST', path: '/api/flocks/10/vote',
  base: () => ({ venue_name: 'The Bar' }),
  fields: ['venue_name', 'venue_id'],
});

sweep('story', {
  method: 'POST', path: '/api/stories',
  base: () => ({ image_url: 'data:image/png;base64,AAAA' }),
  fields: ['image_url', 'caption'],
});

sweep('report', {
  method: 'POST', path: '/api/reports',
  base: () => ({ content_type: 'profile', reason: 'spam' }),
  fields: ['content_type', 'reason', 'content_id', 'reported_user_id', 'details'],
});

sweep('budget submit', {
  method: 'POST', path: '/api/budget/10/submit',
  base: () => ({ amount: 40 }),
  fields: ['amount', 'skipped'],
});

sweep('bill split', {
  method: 'POST', path: '/api/billing/10/create',
  base: () => ({ totalAmount: 40 }),
  fields: ['splitType'],
});

sweep('venue profile create', {
  method: 'POST', path: '/api/venue-profile',
  base: () => ({ businessName: 'Bar' }),
  fields: ['businessName', 'category', 'location', 'description', 'googlePlaceId'],
});

sweep('venue profile update', {
  method: 'PUT', path: '/api/venue-profile',
  base: () => ({}),
  fields: ['businessName', 'category', 'location', 'description', 'phone', 'googlePlaceId', 'photoUrl'],
});

sweep('feedback', {
  method: 'POST', path: '/api/feedback',
  base: () => ({ venue_place_id: 'ChIJrTLr-GyuEmsRBfy61i59si0', venue_name: 'Bar', crowd_level: 2 }),
  fields: ['venue_place_id', 'venue_name', 'crowd_level', 'price_worth', 'rating',
    'predicted_score', 'flock_id', 'local_day', 'local_hour'],
});

// isString() is itself a shape check — it rejects an array and an object
// outright — so these three fields never needed a guard added. They are swept
// anyway, because "already correct" and "correct by accident" look identical
// until something changes the chain.
sweep('DM reaction', {
  method: 'POST', path: '/api/dm/messages/5/react',
  base: () => ({ emoji: '👍' }),
  fields: ['emoji'],
});

sweep('pinned venue', {
  method: 'PUT', path: '/api/dm/2/pinned-venue',
  base: () => ({ venue_name: 'The Bar' }),
  fields: ['venue_name'],
});

sweep('device token unregister', {
  method: 'DELETE', path: '/api/notifications/unregister',
  base: () => ({ token: 'a'.repeat(64) }),
  fields: ['token'],
});

// `token` only: routes/notifications.js re-derives `deviceType` through
// `['web','ios','android'].includes(deviceType)`, which an array fails, so a
// non-scalar is already neutralised to 'web' and never reaches the column. That
// is pinned below instead of guarded here — adding a guard to a field that
// already defends itself is how a sweep turns into noise.
sweep('device token', {
  method: 'POST', path: '/api/notifications/register',
  base: () => ({ token: 'a'.repeat(64) }),
  fields: ['token'],
});

test('a non-scalar deviceType is neutralised, never stored', async () => {
  for (const v of [['ios'], [], { a: 1 }, null]) {
    const res = await call('POST', '/api/notifications/register', { token: 'a'.repeat(64), deviceType: v });
    const insert = routeQueries.find((q) => /INSERT INTO device_tokens/i.test(q.sql));
    if (res.status === 200) {
      assert.ok(insert, `deviceType=${JSON.stringify(v)}: no insert ran`);
      assert.strictEqual(insert.params[2], 'web', `deviceType=${JSON.stringify(v)} reached pg as ${JSON.stringify(insert.params[2])}`);
    } else {
      assert.strictEqual(res.status, 400, `deviceType=${JSON.stringify(v)} -> ${res.status}`);
      assert.strictEqual(insert, undefined);
    }
  }
});

// ── The two bypasses, asserted as bypasses ──────────────────────────────────

// stripHtml and rejectIfProfane both return a non-string unchanged, so on every
// route below the array WAS the way to put markup and slurs into a column that
// the route's own code believed it had screened. This is the test that would
// fail first if someone moved a scalar guard back behind a sanitizer.
test('an array cannot smuggle markup past a sanitizer on any screened field', async () => {
  const payload = ['<img src=x onerror=alert(1)>'];
  const cases = [
    ['POST', '/api/flocks/10/messages', { message_text: payload }, true],
    ['POST', '/api/dm/2', { message_text: payload }, true],
    ['POST', '/api/dm/2/venue-votes', { venue_name: payload }, true],
    ['POST', '/api/flocks/10/vote', { venue_name: payload }, true],
    ['POST', '/api/stories', { image_url: 'data:image/png;base64,AAAA', caption: payload }, true],
    ['POST', '/api/reports', { content_type: 'profile', reason: 'spam', details: payload }, true],
    ['POST', '/api/guest/abcd1234efgh/rsvp', { name: payload, status: 'in' }, false],
  ];
  for (const [method, path, body, auth] of cases) {
    await refusedBeforeSql(method, path, body, `${method} ${path}`, { auth });
  }
});

// The same trick aimed at the columns rather than the screens: an enum behind a
// CHECK constraint, a UUID column, an int4 column and a DECIMAL column all
// answered 500 for what is plainly a client mistake.
test('an array cannot turn a bad request into a 500 from Postgres', async () => {
  const cases = [
    ['POST', '/api/guest/abcd1234efgh/rsvp', { name: 'Sam', status: ['in'] }, false],           // 23514
    ['POST', '/api/guest/abcd1234efgh/rsvp', { name: 'Sam', status: 'in', guestToken: ['9d3f1b2e-1111-4111-8111-111111111111'] }, false], // 22P02 uuid
    ['POST', '/api/reports', { content_type: 'dm', reason: 'spam', content_id: [5] }, true],     // 22P02 int4
    ['POST', '/api/budget/10/submit', { amount: ['50'] }, true],                                 // 22P02 numeric
    ['POST', '/api/dm/2', { message_text: 'hi', reply_to_id: [5] }, true],                        // 22P02 int4
  ];
  for (const [method, path, body, auth] of cases) {
    await refusedBeforeSql(method, path, body, `${method} ${path}`, { auth });
  }
});

// ── optional() skips undefined, not null ────────────────────────────────────
//
// routes/feedback.js was found 400-ing every honest submission because
// `.optional()` let a JSON null fall through to isBoolean/isInt. The same shape
// of bug was live on the budget route through a different door: the shipping
// Skip button posts `{ amount: 0, skipped: true }`, and 0 is PRESENT, so it fell
// through to isFloat({ min: 0.01 }) and every skip in the app was answered
// "Amount must be between $0.01 and $10,000".
//
// The assertion is that these get PAST validation — they reach the route's own
// membership refusal (403), which is the first thing after the chain.
test('the Skip button gets past validation instead of being told about amounts', async () => {
  for (const body of [
    { amount: 0, skipped: true },   // exactly what frontend/src/App.js posts
    { skipped: true },
    { amount: null, skipped: true },
    { amount: 40, skipped: null },
  ]) {
    const res = await call('POST', '/api/budget/10/submit', body);
    assert.strictEqual(res.status, 403, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
    assert.ok(!/Amount must be/.test(res.text), `${JSON.stringify(body)} was refused as an amount problem`);
  }
});

// The same rule, swept: wherever a handler ALREADY reads null as "absent"
// (`if (reply_to_id)`, `paidBy ? ... : userId`, `sanitizeVenueData(null)`,
// `includes(deviceType)`), the chain above it must not be the thing that
// refuses it. Every payload below is a request the route knows how to serve.
test('an explicit null is treated as absent wherever the handler already does', async () => {
  const cases = [
    ['POST', '/api/flocks/10/messages', { message_text: 'hi', message_type: null, venue_data: null, image_url: null }, true],
    ['POST', '/api/dm/2', { message_text: 'hi', message_type: null, venue_data: null, image_url: null, reply_to_id: null }, true],
    ['POST', '/api/dm/2/venue-votes', { venue_name: 'The Bar', venue_id: null }, true],
    ['POST', '/api/flocks/10/vote', { venue_name: 'The Bar', venue_id: null }, true],
    ['POST', '/api/reports', { content_type: 'profile', reason: 'spam', content_id: null, reported_user_id: null, details: null }, true],
    ['POST', '/api/billing/10/create', { totalAmount: 40, tipPercent: null, splitType: null, paidBy: null, customShares: null }, true],
    ['POST', '/api/notifications/register', { token: 'a'.repeat(64), deviceType: null }, true],
    ['POST', '/api/guest/abcd1234efgh/rsvp', { name: 'Sam', status: 'in', guestToken: null }, false],
    ['POST', '/api/venue-profile', { businessName: 'Bar', category: null, location: null, description: null, googlePlaceId: null }, true],
    ['POST', '/api/stories', { image_url: 'data:image/png;base64,AAAA', caption: null }, true],
  ];
  for (const [method, path, body, auth] of cases) {
    const res = await call(method, path, body, { auth });
    assert.notStrictEqual(res.status, 400, `${method} ${path} -> 400 ${res.text}`);
    assert.ok(routeQueries.length > 0, `${method} ${path}: never reached the database`);
  }
});

// A null splitType is "absent", and absent means 'equal' — not SQL NULL in
// bill_splits.split_type, which GET /:flockId would hand back as the split type
// the client renders. A destructuring default only fires for `undefined`, so
// widening optional() without this would have traded one bug for another.
test('a null splitType becomes equal, never a NULL column', async () => {
  billingReachesInsert = true;
  try {
    for (const [sent, expected] of [[null, 'equal'], [undefined, 'equal'], ['custom', 'custom']]) {
      billInsert = null;
      const body = { totalAmount: 40 };
      if (sent !== undefined) body.splitType = sent;
      const res = await call('POST', '/api/billing/10/create', body);
      assert.strictEqual(res.status, 201, `splitType=${JSON.stringify(sent)} -> ${res.status} ${res.text}`);
      assert.ok(billInsert, `splitType=${JSON.stringify(sent)}: the upsert never ran`);
      // [flockId, billTotal, splitType, payerId, tipPct]
      assert.strictEqual(billInsert[2], expected,
        `splitType=${JSON.stringify(sent)} reached pg as ${JSON.stringify(billInsert[2])}`);
      assert.strictEqual(billInsert[4], 0, 'a null tipPercent must be 0, not NULL');
    }
  } finally {
    billingReachesInsert = false;
  }
});

test('a non-skipped submission with no usable amount is still refused, in words', async () => {
  const res = await call('POST', '/api/budget/10/submit', { amount: 0, skipped: false });
  // Membership is checked before the amount rule in this route, so an
  // authorized caller is what surfaces the message; the point here is only that
  // the request is NOT rejected by the validator chain as an out-of-range float.
  assert.ok(!/Amount must be between/.test(res.text), res.text);
});

// ── Controls: the guards are not blanket refusals ───────────────────────────
test('well-shaped payloads still reach the database on every guarded route', async () => {
  const cases = [
    ['POST', '/api/flocks/10/messages', { message_text: 'hi' }, true],
    ['POST', '/api/dm/2', { message_text: 'hi', message_type: 'text', reply_to_id: 5 }, true],
    ['POST', '/api/messages/5/react', { emoji: '👍' }, true],
    ['POST', '/api/dm/2/venue-votes', { venue_name: 'The Bar', venue_id: 'abc' }, true],
    ['POST', '/api/flocks/10/vote', { venue_name: 'The Bar', venue_id: 'abc' }, true],
    ['POST', '/api/reports', { content_type: 'profile', reason: 'spam', reported_user_id: 2, details: 'rude' }, true],
    ['POST', '/api/budget/10/submit', { amount: 40, skipped: false }, true],
    ['POST', '/api/billing/10/create', { totalAmount: 40, splitType: 'equal', tipPercent: 10, paidBy: 1 }, true],
    ['POST', '/api/venue-profile', { businessName: 'Bar', category: 'bar', googlePlaceId: 'ChIJrTLr' }, true],
    ['PUT', '/api/venue-profile', { businessName: 'Bar', phone: '555', photoUrl: '/uploads/a.png' }, true],
    ['POST', '/api/notifications/register', { token: 'a'.repeat(64), deviceType: 'ios' }, true],
    ['POST', '/api/guest/abcd1234efgh/rsvp', { name: 'Sam', status: 'in' }, false],
    ['POST', '/api/guest/abcd1234efgh/vote', { guestToken: '9d3f1b2e-1111-4111-8111-111111111111', venueName: 'The Bar' }, false],
  ];
  for (const [method, path, body, auth] of cases) {
    const res = await call(method, path, body, { auth });
    assert.notStrictEqual(res.status, 400, `${method} ${path} -> 400 ${res.text}`);
    assert.ok(routeQueries.length > 0, `${method} ${path}: never reached the database`);
  }
});

// The unguarded siblings on PUT /dm/:userId/pinned-venue settle their own shape
// in the handler instead — String()/typeof/Number.isFinite/safeVenuePhotoUrl —
// so a non-scalar is coerced or dropped, never persisted as an array. Pinned so
// that stays true if someone moves those reads into the validator chain.
test('pinned-venue fields with no validator still cannot reach pg as arrays', async () => {
  const res = await call('PUT', '/api/dm/2/pinned-venue', {
    venue_name: 'The Bar',
    venue_address: ['<b>12 High St</b>'],
    venue_id: ['abc'],
    venue_rating: ['4.5'],
    venue_photo_url: ['/api/venues/photo?ref=x'],
  });
  // Stops at the relationship gate, so nothing is written; the point is that
  // nothing was refused as a 500 and nothing structured survived the reads.
  assert.notStrictEqual(res.status, 500, res.text);
  const upsert = routeQueries.find((q) => /INSERT INTO dm_pinned_venues/i.test(q.sql));
  for (const p of (upsert ? upsert.params : [])) {
    assert.ok(typeof p !== 'object' || p === null, `${JSON.stringify(p)} reached pg structured`);
  }
});

// venue_data / customShares / goals / operatingHours / notificationPrefs are
// LEGITIMATELY structured. A shape guard applied mechanically to every field
// would have broken all five, which is the failure mode opposite to the one
// this sweep is about.
test('fields that are meant to be structured are still accepted', async () => {
  const cases = [
    ['POST', '/api/flocks/10/messages', { message_text: 'hi', venue_data: { name: 'Bar' } }, true],
    ['POST', '/api/dm/2', { message_text: 'hi', venue_data: { name: 'Bar' } }, true],
    ['POST', '/api/billing/10/create', { totalAmount: 40, splitType: 'custom', customShares: [{ userId: 1, amount: 40 }] }, true],
    ['POST', '/api/venue-profile', { businessName: 'Bar', goals: ['more walk-ins'] }, true],
    ['PUT', '/api/venue-profile', {
      businessName: 'Bar',
      goals: ['more walk-ins'],
      operatingHours: [{ days: 'Mon', open: '17:00', close: '23:00' }],
      notificationPrefs: { bookings: true },
    }, true],
  ];
  for (const [method, path, body, auth] of cases) {
    const res = await call(method, path, body, { auth });
    assert.notStrictEqual(res.status, 400, `${method} ${path} -> 400 ${res.text}`);
    assert.ok(routeQueries.length > 0, `${method} ${path}: never reached the database`);
  }
});

// ── A message must carry something, not specifically text ───────────────────
//
// Both send routes required message_text with isLength({ min: 1 }), so an
// image-only message was a 400 over REST while sockets/handlers.js accepted it
// (`!message_text && message_type !== 'image'` is its whole test). These REST
// routes are the fallback the socket client uses WHEN THE CONNECTION IS DOWN,
// so sending a photo failed exactly when the network was already struggling.
test('an image with no caption sends over REST, as it does over the socket', async () => {
  const img = 'data:image/png;base64,AAAA';
  for (const path of ['/api/flocks/10/messages', '/api/dm/2']) {
    for (const body of [
      { message_type: 'image', image_url: img },              // no message_text key at all
      { message_text: '', message_type: 'image', image_url: img },
      { message_text: null, message_type: 'image', image_url: img },
      { message_text: '   ', message_type: 'image', image_url: img },
    ]) {
      const res = await call('POST', path, body);
      assert.notStrictEqual(res.status, 400, `${path} ${JSON.stringify(body)} -> ${res.text}`);
      assert.ok(routeQueries.length > 0, `${path}: never reached the database`);
    }
  }
});

test('a message carrying neither text nor an image is still refused', async () => {
  for (const path of ['/api/flocks/10/messages', '/api/dm/2']) {
    for (const body of [{}, { message_text: '' }, { message_text: '   ' }, { message_text: null },
      { message_text: '<b> </b>' }, { message_type: 'image' }]) {
      const res = await call('POST', path, body);
      assert.strictEqual(res.status, 400, `${path} ${JSON.stringify(body)} -> ${res.status} ${res.text}`);
    }
  }
});

// message_text is TEXT NOT NULL on both tables, so an absent or null value has
// to become '' — travelling to Postgres as NULL is 23502, i.e. a 500.
test('an image-only message stores an empty string, never NULL', async () => {
  const img = 'data:image/png;base64,AAAA';
  await call('POST', '/api/flocks/10/messages', { message_type: 'image', image_url: img });
  const insert = routeQueries.find((q) => /INSERT INTO messages/i.test(q.sql));
  if (insert) assert.strictEqual(insert.params[2], '', `message_text reached pg as ${JSON.stringify(insert.params[2])}`);
});

// The length ceiling still holds, and it is measured after sanitizing.
test('an over-long message is still refused', async () => {
  const res = await call('POST', '/api/flocks/10/messages', { message_text: 'a'.repeat(5001) });
  assert.strictEqual(res.status, 400, res.text);
});

// ── A guest vote reaches the members, wherever they are ─────────────────────
//
// routes/guest.js emitted `new_vote` straight into `io.to('flock:'+id)`. That
// room is not a membership list — a socket joins it when the client opens that
// flock's screen — so a member anywhere else in the app never learned a guest
// had voted, on the one surface whose entire purpose is telling the group what
// the people they invited want. It was also a third producer of `new_vote`
// carrying a third payload shape, with no `votes` array, so a client had to
// refetch to find out what actually changed.
async function guestVote(io) {
  guestVoteReachesFanout = true;
  app.set('io', io);
  try {
    return await call('POST', '/api/guest/abcd1234efgh/vote', {
      guestToken: '9d3f1b2e-1111-4111-8111-111111111111',
      venueName: 'The Bar',
    }, { auth: false });
  } finally {
    guestVoteReachesFanout = false;
    blocksFixture = [];
    app.set('io', null);
  }
}

test('a guest vote fans out to each member personally, never to the flock room', async () => {
  const io = fakeIo();
  const res = await guestVote(io);
  assert.strictEqual(res.status, 201, res.text);

  assert.deepStrictEqual(
    io.sent.filter((e) => e.room.startsWith('flock:')), [],
    'still emitting into the flock room'
  );
  assert.deepStrictEqual(
    io.sent.map((e) => e.room).sort(), ['user:1', 'user:2'],
    'every accepted member gets it in their own room'
  );
  for (const e of io.sent) {
    assert.strictEqual(e.event, 'new_vote');
    // Same payload shape the member and socket producers use — flockId as a
    // number, an anonymous voter, and the recipient's own tally.
    assert.strictEqual(e.payload.flockId, 10);
    assert.deepStrictEqual(e.payload.voter, { guest: true });
    assert.strictEqual(e.payload.venue_name, 'The Bar');
    assert.ok(Array.isArray(e.payload.votes), 'the votes array is what was missing before');
    assert.deepStrictEqual(e.payload.votes[0], {
      venue_name: 'The Bar',
      venue_id: 'abc',
      vote_count: 3,       // 2 members + 1 guest, the shared tally's own arithmetic
      guest_count: 1,
      voters: ['Ava', 'Ben'],
    });
  }
});

test('the guest fan-out still honours blocks between members', async () => {
  const io = fakeIo();
  blocksFixture = [{ blocker_id: 1, blocked_id: 2 }];
  const res = await guestVote(io);
  assert.strictEqual(res.status, 201, res.text);

  // The VOTER is anonymous, so nobody can have blocked them — but the votes
  // array names the member voters, and those blocks are real.
  const forAva = io.sent.find((e) => e.room === 'user:1');
  const forBen = io.sent.find((e) => e.room === 'user:2');
  assert.deepStrictEqual(forAva.payload.votes[0].voters, ['Ava']);
  assert.deepStrictEqual(forBen.payload.votes[0].voters, ['Ben']);
  // The COUNT is a fact about the venue and stays whole for both of them.
  assert.strictEqual(forAva.payload.votes[0].vote_count, 3);
  assert.strictEqual(forBen.payload.votes[0].vote_count, 3);
});

test('a fan-out failure cannot turn a saved guest vote into a 500', async () => {
  const io = { to() { throw new Error('socket layer is down'); } };
  const res = await guestVote(io);
  assert.strictEqual(res.status, 201, res.text);
});

test('routes/guest.js no longer addresses the flock room at all', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'guest.js'), 'utf8');
  assert.ok(!/io\.to\(`flock:/.test(src), 'guest.js is emitting into the flock room again');
});

// ── An invitation stays inert (round 19 decision) ───────────────────────────
//
// POST /api/feedback accepts a flock_id as an attribution claim, gated on the
// caller holding a flock_members row. That gate used to accept ANY status, so
// an account holding only an 'invited' row — a row somebody else created, about
// them, without their participation — could attribute feedback to that flock.
// It was the single place in the backend where an invitation was not fully
// inert. flock_members.status is CHECK (status IN ('invited','accepted',
// 'declined')), so requiring 'accepted' costs no honest submitter anything:
// accepting is the only way to become part of a flock.
test('feedback attribution requires an accepted membership, not merely an invitation', async () => {
  const res = await call('POST', '/api/feedback', {
    venue_place_id: 'ChIJrTLr-GyuEmsRBfy61i59si0',
    venue_name: 'The Bar',
    crowd_level: 2,
    flock_id: 10,
  });
  assert.strictEqual(res.status, 403, res.text);
  assert.match(res.text, /not yours to report on/);

  // Asserted against the statement actually issued, not against the source: a
  // comment claiming 'accepted' and a query that does not is the failure this
  // is here to catch.
  const membership = routeQueries.find((q) => /FROM flock_members/i.test(q.sql));
  assert.ok(membership, 'the membership check never ran');
  assert.match(membership.sql, /status = 'accepted'/,
    `the attribution gate accepts a non-accepted row: ${membership.sql}`);

  // Nothing was written.
  assert.strictEqual(routeQueries.find((q) => /INSERT INTO venue_feedback/i.test(q.sql)), undefined);
});

// The claim the decision rests on: no consumer reads the column, and every one
// of them filters on `verified`. If that stops being true the tightened gate
// matters more, not less — so this fails loudly rather than silently ageing.
test('no venue_feedback consumer reads flock_id, and all of them filter on verified', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const consumers = [
    'routes/crowd.js', 'routes/venueDashboard.js',
    'services/mlPredictor.js', 'scripts/ml/train/export_training_data.js',
  ];
  for (const rel of consumers) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    // Every FROM venue_feedback in these files must carry a verified filter
    // within the same statement, and none may project flock_id.
    const stmts = src.split(/FROM venue_feedback/i).slice(1);
    for (const tail of stmts) {
      const stmt = tail.slice(0, 400);
      assert.match(stmt, /verified/i, `${rel}: a venue_feedback read with no verified filter`);
    }
  }
});

// ── Where a guard was deliberately NOT added ────────────────────────────────
//
// Three sets of fields were left alone because the handler re-derives them
// before anything sees them — Number()/parseInt()/parseFloat() flatten a
// one-element array back to the right value. That reasoning is only worth
// anything if it is checked, so it is checked here rather than asserted in a
// comment. If any of these starts arriving at pg structured, the answer is to
// add the guard, not to relax the test.
test('billing money fields are re-derived, so an array never reaches the column', async () => {
  billingReachesInsert = true;
  try {
    billInsert = null;
    const res = await call('POST', '/api/billing/10/create', {
      totalAmount: ['40.005'], tipPercent: ['10'], paidBy: [1], splitType: 'equal',
    });
    assert.strictEqual(res.status, 201, res.text);
    // [flockId, billTotal, splitType, payerId, tipPct]
    assert.strictEqual(billInsert[1], 40.01, `totalAmount reached pg as ${JSON.stringify(billInsert[1])}`);
    assert.strictEqual(billInsert[3], 1, `paidBy reached pg as ${JSON.stringify(billInsert[3])}`);
    assert.strictEqual(billInsert[4], 10, `tipPercent reached pg as ${JSON.stringify(billInsert[4])}`);
    for (const p of billInsert) {
      assert.ok(typeof p !== 'object' || p === null, `${JSON.stringify(p)} reached pg structured`);
    }
  } finally {
    billingReachesInsert = false;
  }
});

test('paginated reads coerce their cursors, so an array query param is inert', async () => {
  // Express parses ?limit[]=5 into ['5'] and ?limit[a]=5 into {a:'5'}; isInt()
  // accepts the first by coercion. parseInt() is what makes it harmless.
  for (const [path, qs] of [
    ['/api/flocks/10/messages', '?limit[]=5&before[]=3'],
    ['/api/dm/2', '?limit[]=5&before[]=3'],
    ['/api/stories', '?limit[]=5&offset[]=3'],
  ]) {
    const res = await call('GET', path + qs, undefined);
    assert.notStrictEqual(res.status, 500, `${path}${qs} -> ${res.text}`);
    for (const q of routeQueries) {
      for (const p of (q.params || [])) {
        assert.ok(!(p && typeof p === 'object' && !Array.isArray(p)),
          `${path}: ${JSON.stringify(p)} reached pg structured`);
        if (Array.isArray(p)) {
          // The only legitimate array params here are the int[] block lists.
          assert.ok(p.every((x) => typeof x === 'number'),
            `${path}: ${JSON.stringify(p)} is not an int[] block list`);
        }
      }
    }
  }
  // An object-shaped query param is refused outright, since isInt() rejects it.
  const bad = await call('GET', '/api/flocks/10/messages?limit[a]=5', undefined);
  assert.strictEqual(bad.status, 400, bad.text);
});

// ── The routes that were already shape-safe, pinned so they stay that way ────
//
// routes/safety.js validates by hand (`typeof body.name === 'string'`,
// readCoords) and routes/checkin.js takes no body at all and re-tests
// `typeof sig === 'string'`. Both were already correct; neither got a guard.
// These tests exist so a future refactor toward express-validator cannot
// quietly reintroduce the hole on the emergency path.
test('safety contacts refuse a non-scalar without a guard of their own', async () => {
  for (const field of ['name', 'phone', 'email']) {
    for (const v of [['x'], { a: 1 }, []]) {
      const res = await call('POST', '/api/safety/contacts', {
        name: 'Mum', phone: '5550100', email: 'mum@example.com', [field]: v,
      });
      assert.strictEqual(res.status, 400, `${field}=${JSON.stringify(v)} -> ${res.status} ${res.text}`);
    }
  }
});

// `relationship` is the one optional field on that form, so a non-scalar is not
// refused — it is DISCARDED, and null is what reaches the VARCHAR(50) column.
// Either answer is sound; what would not be is the array arriving intact.
test('a non-scalar relationship is discarded, never written', async () => {
  contactInsert = null;
  const res = await call('POST', '/api/safety/contacts', {
    name: 'Mum', phone: '5550100', email: 'mum@example.com', relationship: ['<b>mum</b>'],
  });
  assert.strictEqual(res.status, 201, res.text);
  assert.ok(contactInsert, 'the insert never ran');
  assert.strictEqual(contactInsert[4], null, `relationship reached pg as ${JSON.stringify(contactInsert[4])}`);
});

test('an SOS with non-scalar coordinates degrades to no location, never a crash', async () => {
  // readCoords accepts only a number or a numeric string, so an array yields
  // null — "alert without a location", which is a degraded alert, not a failed
  // one. The refusal below is the route's own "no trusted contacts" answer,
  // which proves it got all the way through the coordinate handling.
  const res = await call('POST', '/api/safety/alert', {
    latitude: ['40.7'], longitude: { a: 1 }, timezone: ['UTC'],
  });
  assert.strictEqual(res.status, 400, res.text);
  assert.ok(/trusted contacts/.test(res.text), res.text);
});

test('an NFC tap with a non-scalar signature is unverified, never trusted', async () => {
  const { nfcSigValid } = require('../routes/checkin').__test;
  process.env.NFC_TAG_SECRET = 'shape-sweep-secret';
  for (const sig of [['x'], {}, [], null, undefined, 5]) {
    assert.strictEqual(nfcSigValid('ChIJrTLr', sig), false, JSON.stringify(sig));
  }
  delete process.env.NFC_TAG_SECRET;
});

// ── One definition, not twelve ──────────────────────────────────────────────
test('every guarded router imports the shared predicate rather than copying it', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const shape = require('../validators/shape');

  // The predicate itself, pinned. `null` and `undefined` deliberately pass
  // through to .optional(); deciding optionality is not this rule's job.
  for (const v of [undefined, null, '', 'x', 0, 1, false, true]) {
    assert.strictEqual(shape.isScalar(v), true, JSON.stringify(v));
  }
  for (const v of [[], ['x'], {}, { a: 1 }, new Date()]) {
    assert.strictEqual(shape.isScalar(v), false, JSON.stringify(v));
  }

  const guarded = ['messages', 'billing', 'budget', 'guest', 'moderation',
    'venueProfile', 'venues', 'stories', 'feedback'];
  for (const name of guarded) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', `${name}.js`), 'utf8');
    assert.ok(/require\('\.\.\/validators\/shape'\)/.test(src),
      `routes/${name}.js does not import validators/shape.js`);
    // A private re-definition is how twelve copies start.
    assert.ok(!/const isScalar\s*=/.test(src),
      `routes/${name}.js has its own copy of isScalar`);
  }
});
