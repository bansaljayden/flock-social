// Run: node --test  (from backend/)
//
// THE COERCED NON-SCALAR, round 20 — the identity and personal-data routers.
//
// backend/__tests__/arrayShapeSweep.test.js swept twelve routers for this. The
// five audited here were not in that sweep: routes/auth.js, routes/users.js,
// routes/friends.js, routes/availability.js and routes/calendar.js.
//
// The class, restated because these files show every one of its faces:
// express-validator COERCES a value before it tests it, so a one-element array
// satisfies isLength / isIn / isInt / isURL / matches / isISO8601, and an empty
// array satisfies every length and range rule vacuously. The value then STAYS an
// array in req.body — verified against the installed express-validator, which
// expands an array-valued field into one instance per element and writes the
// sanitized elements back individually rather than collapsing them. What
// happened next depended only on which line read it first:
//
//   * pg serialised it against a scalar column        -> 500 (friends /accept,
//     /decline; users payment handles, /profile-image; availability status;
//     calendar title / date / venue / time / color; signup interests)
//   * a string method was called on it                -> TypeError, also a 500
//     (friends /add-by-code `code.toUpperCase()`, users
//     `venmo_username.replace()`)
//   * stripHtml and moderateText both return a non-string UNCHANGED, so a
//     screened field was never screened.
//
// The sibling failure is the same rule read from the other side: `optional()`
// skips ONLY `undefined`, so a route whose client legitimately spells an
// untouched field as `null` was refusing honest submissions.
//
// HOW THESE TESTS ASSERT. A bad shape must be a 400 AND must not reach the
// database — the route-level query log has to be empty. Asserting on the body
// alone would pass for a route that stored the array and rendered it politely.
// The control in the other direction matters just as much: a well-shaped
// payload, and an explicit null wherever the handler already reads null as
// absent, must still get PAST the chain.
//
// No database: pool.query / pool.connect are fixtures.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-auth-shape-guards';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // keep push a no-op
delete process.env.RESEND_API_KEY;           // keep mail a no-op
// Set, not deleted: an unset client id makes POST /api/auth/google fail closed
// with its own 500 before the branch the malformed-credential test exercises.
process.env.GOOGLE_CLIENT_ID = 'shape-guard-client-id';
delete process.env.APPLE_REQUIRE_NONCE;

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Fixture plumbing ────────────────────────────────────────────────────────
const USER = {
  id: 1, email: 'ava@example.com', name: 'Ava', role: 'user',
  profile_image_url: null, email_verified: true, is_banned: false, token_version: 0,
};

let routeQueries;   // every statement issued AFTER the auth lookup
let calendarWrite;  // the INSERT/UPDATE the calendar routes issued, if any
function reset() { routeQueries = []; calendarWrite = null; }
reset();

const AUTH_SQL = /^SELECT id, email, name, role,.* FROM users WHERE id = \$1$/i;

// The row PUT /api/users/profile re-reads for itself. A password account, so the
// current-password proof is what the handler exercises rather than the OAuth
// freshness branch.
const PROFILE_ROW = {
  ...USER,
  // bcrypt hash of 'Password1', generated below at load time.
  password: null,
  phone: '+12025550100',
  oauth_provider: null,
  verified_email: 'ava@example.com',
};

function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) return Promise.resolve({ rows: [USER], rowCount: 1 });

  routeQueries.push({ sql, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rows: [] });
  // PUT /profile's own re-read of the caller's row.
  if (/^SELECT \* FROM users WHERE id = \$1$/i.test(sql)) {
    return Promise.resolve({ rows: [PROFILE_ROW], rowCount: 1 });
  }
  // The calendar writes are answered with a real row so their handlers run to
  // completion — rowToEvent() throws on an empty result, and a 500 from the
  // FIXTURE would mask the 500 these tests are looking for.
  if (/^(INSERT INTO calendar_events|UPDATE calendar_events)/i.test(sql)) {
    calendarWrite = { sql, params };
    return Promise.resolve({
      rows: [{ id: 5, title: 'Dinner', venue: null, event_date: '2026-09-01', time_label: null, color: null }],
      rowCount: 1,
    });
  }
  // Everything else answers "nothing found", so each route stops at its own
  // refusal instead of running a whole flow.
  return Promise.resolve({ rows: [], rowCount: 0 });
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
app.use('/api/auth', require('../routes/auth'));
app.use('/api/users', require('../routes/users'));
app.use('/api/friends', require('../routes/friends'));
app.use('/api/availability', require('../routes/availability'));
app.use('/api/calendar', require('../routes/calendar'));

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

// The shapes. The multi-element array satisfies isLength by joining, and the
// empty array satisfies every length and range rule by having nothing to check.
const ARRAYS = [[], ['x'], ['a', 'b'], [1], [['x']]];
const OBJECTS = [{}, { a: 1 }, { $ne: null }];
const NON_SCALARS = [...ARRAYS, ...OBJECTS];

async function refusedBeforeSql(method, path, payload, label, opts) {
  const res = await call(method, path, payload, opts);
  assert.strictEqual(res.status, 400, `${label} -> ${res.status} ${res.text}`);
  assert.deepStrictEqual(routeQueries.map((q) => q.sql), [],
    `${label}: reached the database anyway`);
}

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

// ── routes/auth.js — the unauthenticated surface ────────────────────────────
//
// These five fields were ALREADY covered, by rejectNonStringFields (round 15/16)
// rather than by validators/shape.js. That guard is strictly stronger than
// isScalar — "a string or nothing", so it also refuses a NUMBER, which is the
// shape that still hurts on date_of_birth (`new Date(946684800000)` parses, and
// the value then goes to a DATE column). Swept anyway: "already correct" and
// "correct by accident" look identical until someone edits the chain.
const DOB = '2000-01-01';

sweep('signup', {
  method: 'POST', path: '/api/auth/signup', auth: false,
  base: () => ({ email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: DOB }),
  fields: ['email', 'password', 'name', 'date_of_birth'],
});

sweep('login', {
  method: 'POST', path: '/api/auth/login', auth: false,
  base: () => ({ email: 'ava@example.com', password: 'Password1' }),
  fields: ['email', 'password'],
});

sweep('forgot password', {
  method: 'POST', path: '/api/auth/forgot-password', auth: false,
  base: () => ({ email: 'ava@example.com' }),
  fields: ['email'],
});

sweep('reset password', {
  method: 'POST', path: '/api/auth/reset-password', auth: false,
  base: () => ({ token: 'a'.repeat(40), password: 'Password1' }),
  fields: ['token', 'password'],
});

sweep('google sign-in', {
  method: 'POST', path: '/api/auth/google', auth: false,
  base: () => ({ credential: 'x'.repeat(40) }),
  fields: ['credential', 'access_token', 'date_of_birth'],
});

sweep('apple sign-in', {
  method: 'POST', path: '/api/auth/apple', auth: false,
  base: () => ({ identityToken: 'x'.repeat(40) }),
  fields: ['identityToken', 'nonce', 'authorizationCode', 'date_of_birth'],
});

// The one field on signup that had NO validator at all. users.interests is
// TEXT[], so an ARRAY is the legitimate shape here and only the non-array
// shapes are refused — which is exactly why a blanket scalar guard would have
// been the wrong tool and isArray() is the right one.
test('signup interests: a non-array reaches no query, an array still does', async () => {
  for (const v of ['music', 5, true, { a: 1 }]) {
    await refusedBeforeSql('POST', '/api/auth/signup',
      { email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: DOB, interests: v },
      `signup interests=${JSON.stringify(v)}`, { auth: false });
  }
  for (const v of [['music'], [], null]) {
    const res = await call('POST', '/api/auth/signup',
      { email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: DOB, interests: v },
      { auth: false });
    assert.notStrictEqual(res.status, 400, `interests=${JSON.stringify(v)} -> ${res.text}`);
    assert.ok(routeQueries.length > 0, `interests=${JSON.stringify(v)}: never reached the database`);
  }
});

// A nested object inside a legitimate array is dropped by sanitizeArray rather
// than refused, and must never reach the TEXT[] column carrying markup.
test('signup interests never carry a nested value into the column', async () => {
  await call('POST', '/api/auth/signup', {
    email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: DOB,
    interests: ['<b>music</b>', { a: 1 }, ['nested']],
  }, { auth: false });
  const insert = routeQueries.find((q) => /INSERT INTO users/i.test(q.sql));
  if (insert) {
    const interests = insert.params[3];
    assert.deepStrictEqual(interests, ['music'],
      `interests reached pg as ${JSON.stringify(interests)}`);
  }
});

// ── routes/users.js ─────────────────────────────────────────────────────────
sweep('profile update', {
  method: 'PUT', path: '/api/users/profile',
  base: () => ({ name: 'Ava' }),
  fields: ['name', 'email', 'phone', 'current_password', 'new_password'],
});

sweep('venmo handle', {
  method: 'PUT', path: '/api/users/venmo-username',
  base: () => ({ venmo_username: 'ava' }),
  fields: ['venmo_username'],
});

sweep('payment handles', {
  method: 'PUT', path: '/api/users/payment-methods',
  base: () => ({ venmo_username: 'ava' }),
  fields: ['venmo_username', 'cashapp_cashtag', 'zelle_identifier'],
});

sweep('avatar url', {
  method: 'PUT', path: '/api/users/profile-image',
  base: () => ({ url: 'https://api.dicebear.com/7.x/bottts/svg?seed=ava' }),
  fields: ['url'],
});

// The avatar URL is the sharpest of these: isURL passed by coercion AND
// `new URL(value)` stringifies its argument, so the trusted-host allowlist
// passed too and the array went to pg for users.profile_image_url.
test('an array avatar url is refused even though it names a trusted host', async () => {
  await refusedBeforeSql('PUT', '/api/users/profile-image',
    { url: ['https://api.dicebear.com/7.x/bottts/svg?seed=ava'] }, 'avatar array');
});

test('a non-scalar search term never becomes a joined query', async () => {
  for (const qs of ['?q[]=a&q[]=b', '?q[]=a', '?q[a]=1']) {
    const res = await call('GET', `/api/users/search${qs}`, undefined);
    assert.strictEqual(res.status, 400, `${qs} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(routeQueries.map((q) => q.sql), [], `${qs}: reached the database`);
  }
  const ok = await call('GET', '/api/users/search?q=ava', undefined);
  assert.strictEqual(ok.status, 200, ok.text);
});

// ── routes/friends.js ───────────────────────────────────────────────────────
//
// /request flattened its own id with parseInt(), so it was untidy rather than
// broken; /accept and /decline read user_id straight off the body and handed it
// to pg against friendships.requester_id / addressee_id (INTEGER). All three
// carry the same guard now so they cannot drift apart again.
sweep('friend request', {
  method: 'POST', path: '/api/friends/request',
  base: () => ({ user_id: 2 }),
  fields: ['user_id'],
});

sweep('friend accept', {
  method: 'POST', path: '/api/friends/accept',
  base: () => ({ user_id: 2 }),
  fields: ['user_id'],
});

sweep('friend decline', {
  method: 'POST', path: '/api/friends/decline',
  base: () => ({ user_id: 2 }),
  fields: ['user_id'],
});

sweep('friend code', {
  method: 'POST', path: '/api/friends/add-by-code',
  base: () => ({ code: 'FLOCK-0002' }),
  fields: ['code'],
});

// ── routes/availability.js ──────────────────────────────────────────────────
sweep('availability pulse', {
  method: 'POST', path: '/api/availability',
  base: () => ({ status: 'down' }),
  fields: ['status', 'note', 'expires_at'],
});

// ── routes/calendar.js ──────────────────────────────────────────────────────
sweep('calendar create', {
  method: 'POST', path: '/api/calendar',
  base: () => ({ title: 'Dinner', date: '2026-09-01' }),
  fields: ['title', 'date', 'venue', 'time', 'color'],
});

sweep('calendar update', {
  method: 'PUT', path: '/api/calendar/5',
  base: () => ({ title: 'Dinner' }),
  fields: ['title', 'date', 'venue', 'time', 'color'],
});

test('a calendar range query cannot be an array', async () => {
  const res = await call('GET', '/api/calendar?start[]=2026-09-01&end[]=2026-09-30', undefined);
  assert.strictEqual(res.status, 400, res.text);
  assert.deepStrictEqual(routeQueries.map((q) => q.sql), [], 'reached the database anyway');
});

// The shape guard's twin: an id past the int4 ceiling reaches the query as an
// out-of-range value and comes back 22003, i.e. a 500 for a malformed id.
test('a calendar event id outside int4 is a 400, not a 500 from Postgres', async () => {
  for (const id of ['99999999999', '0', '-1', 'abc']) {
    for (const [method, body] of [['PUT', { title: 'x' }], ['DELETE', undefined]]) {
      const res = await call(method, `/api/calendar/${id}`, body);
      assert.strictEqual(res.status, 400, `${method} /api/calendar/${id} -> ${res.status} ${res.text}`);
      assert.deepStrictEqual(routeQueries.map((q) => q.sql), [],
        `${method} /api/calendar/${id}: reached the database`);
    }
  }
});

// ── The same doctrine one level up: a token has a shape too ─────────────────
//
// A Google ID token is a JWT — three base64url segments — and anything else
// cannot verify. Handing garbage to verifyIdToken threw a message the handler's
// catch does not recognise, so `{"credential": "x"}` was an UNAUTHENTICATED
// 500 anyone could produce on demand. The Apple branch never had this, because
// jsonwebtoken raises a JsonWebTokenError that catch already maps to 401.
test('a malformed OAuth credential is a 401, never a 500', async () => {
  const garbage = ['x', 'x'.repeat(40), 'a.b', 'a.b.c.d', '<script>', '   ', 'a.b.c!'];
  for (const credential of garbage) {
    const g = await call('POST', '/api/auth/google', { credential }, { auth: false });
    assert.strictEqual(g.status, 401, `google credential=${JSON.stringify(credential)} -> ${g.status} ${g.text}`);
    assert.deepStrictEqual(routeQueries.map((q) => q.sql), [],
      `google credential=${JSON.stringify(credential)}: reached the database`);

    // The Apple twin, pinned alongside so the two stay symmetrical.
    const a = await call('POST', '/api/auth/apple', { identityToken: credential }, { auth: false });
    assert.notStrictEqual(a.status, 500, `apple identityToken=${JSON.stringify(credential)} -> ${a.text}`);
  }
});

// ── Measure AFTER sanitizing, not before ────────────────────────────────────
//
// The other half of the rule validators/shape.js states, and the reason
// freeText() ends with a second trim. stripHtml('<b> </b>') is a single SPACE,
// which is length 1 — so isLength({ min: 1 }) passed, rejectIfProfane saw
// nothing to object to, and "a name is required" stored a blank name in
// users.name on both the unauthenticated signup and the authenticated rename.
test('a display name made only of markup is a 400, not a blank row', async () => {
  for (const blank of ['<b> </b>', '<i></i>', '   ', '<span>\t</span>']) {
    const signup = await call('POST', '/api/auth/signup',
      { email: 'new@example.com', password: 'Password1', name: blank, date_of_birth: DOB },
      { auth: false });
    assert.strictEqual(signup.status, 400, `signup name=${JSON.stringify(blank)} -> ${signup.text}`);
    assert.deepStrictEqual(routeQueries.map((q) => q.sql), [],
      `signup name=${JSON.stringify(blank)}: reached the database`);

    const rename = await call('PUT', '/api/users/profile', { name: blank, current_password: 'Password1' });
    assert.strictEqual(rename.status, 400, `rename name=${JSON.stringify(blank)} -> ${rename.text}`);
  }
});

// The control: markup around REAL text is stripped and the name still saves.
test('markup around a real name is stripped, and the name still saves', async () => {
  await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: 'Password1', name: '  <b>Sam</b>  ', date_of_birth: DOB },
    { auth: false });
  const insert = routeQueries.find((q) => /INSERT INTO users/i.test(q.sql));
  assert.ok(insert, 'the signup insert never ran');
  assert.strictEqual(insert.params[2], 'Sam', `name reached pg as ${JSON.stringify(insert.params[2])}`);
});

// ── The number sibling ──────────────────────────────────────────────────────
//
// A NUMBER is a scalar, so no shape guard refuses one. It still breaks any
// handler that calls a string method on the value, and only a SANITIZER in the
// chain coerces it. `date` was the one field on the calendar routes carrying no
// sanitizer, and isISO8601 accepts the basic form — so `{"date": 20260901}`
// passed every rule as a number and hit `date.slice(0, 10)`, a TypeError and a
// 500. Every other field on these routes already ran through trim(), which is
// why this was the only one.
test('a numeric date is coerced or refused, never handed to a string method', async () => {
  for (const [method, path, body] of [
    ['POST', '/api/calendar', { title: 'Dinner', date: 20260901 }],
    ['PUT', '/api/calendar/5', { date: 20260901 }],
  ]) {
    const res = await call(method, path, body);
    assert.notStrictEqual(res.status, 500, `${method} ${path} -> 500 ${res.text}`);
    assert.ok(calendarWrite, `${method} ${path}: the write never ran`);
    // The DATE parameter: index 3 on the INSERT, index 1 on the UPDATE.
    const dateParam = method === 'POST' ? calendarWrite.params[3] : calendarWrite.params[1];
    assert.strictEqual(dateParam, '20260901',
      `${method} ${path}: the date reached pg as ${JSON.stringify(dateParam)}`);
  }
  // A value that is not a date in any spelling is still refused.
  for (const bad of [true, 2026.5]) {
    const res = await call('POST', '/api/calendar', { title: 'Dinner', date: bad });
    assert.strictEqual(res.status, 400, `date=${JSON.stringify(bad)} -> ${res.status} ${res.text}`);
  }
});

// The Apple display name is the mirror case: `fullName` is LEGITIMATELY an
// object, so its halves get no shape guard — the handler re-derives both through
// String() and stripHtml instead. Pinned, because that reasoning is only worth
// something if it is checked.
test('a non-scalar Apple name half is re-derived, never stored structured', async () => {
  const { __testing } = require('../routes/auth');
  assert.ok(__testing, 'routes/auth.js stopped exporting its test hooks');
  for (const v of [['<b>Sam</b>'], { a: 1 }, []]) {
    const res = await call('POST', '/api/auth/apple',
      { identityToken: 'x'.repeat(40), fullName: { givenName: v, familyName: 'Lee' } },
      { auth: false });
    // The token is junk, so this stops at Apple's own verification — the point
    // is only that nothing structured got as far as a column.
    assert.notStrictEqual(res.status, 500, res.text);
    for (const q of routeQueries) {
      for (const p of (q.params || [])) {
        assert.ok(typeof p !== 'object' || p === null,
          `fullName.givenName=${JSON.stringify(v)}: ${JSON.stringify(p)} reached pg structured`);
      }
    }
  }
});

// ── The bypass, asserted as a bypass ────────────────────────────────────────
//
// stripHtml and moderateText both return a non-string unchanged, so on every
// screened field below the array WAS the way to put markup into a column the
// route believed it had cleaned. users.name is the one that matters most: it is
// rendered on invites, rosters, chat and push, and the signup path that writes
// it is unauthenticated.
test('an array cannot smuggle markup past a sanitizer on any screened field', async () => {
  const payload = ['<img src=x onerror=alert(1)>'];
  const cases = [
    ['POST', '/api/auth/signup', { email: 'new@example.com', password: 'Password1', name: payload, date_of_birth: DOB }, false],
    ['PUT', '/api/users/profile', { name: payload }, true],
    ['POST', '/api/availability', { status: 'down', note: payload }, true],
    ['POST', '/api/calendar', { title: payload, date: '2026-09-01' }, true],
  ];
  for (const [method, path, body, auth] of cases) {
    await refusedBeforeSql(method, path, body, `${method} ${path}`, { auth });
  }
});

// The same trick aimed at the columns rather than the screens.
test('an array cannot turn a bad request into a 500 from Postgres', async () => {
  const cases = [
    ['POST', '/api/friends/accept', { user_id: [2] }, true],                       // int4
    ['POST', '/api/friends/decline', { user_id: [2] }, true],                      // int4
    ['POST', '/api/availability', { status: ['down'] }, true],                     // 23514 CHECK
    ['POST', '/api/calendar', { title: 'Dinner', date: ['2026-09-01'] }, true],    // DATE
    ['PUT', '/api/users/payment-methods', { zelle_identifier: ['a@b.com'] }, true],// varchar(255)
    ['PUT', '/api/users/venmo-username', { venmo_username: [] }, true],            // [] is truthy
  ];
  for (const [method, path, body, auth] of cases) {
    await refusedBeforeSql(method, path, body, `${method} ${path}`, { auth });
  }
});

// ── optional() skips undefined, not null ────────────────────────────────────
//
// Every payload below is a request the handler already knows how to serve: it
// reads the null as "leave this alone" (`name || null`, `title || null`,
// `date ? … : null`, `note || null`, `clampExpiry(null)`, `if (new_password)`,
// `if (!credential && !access_token)`). Before round 20 the CHAIN refused them.
test('an explicit null is treated as absent wherever the handler already does', async () => {
  const cases = [
    ['PUT', '/api/users/profile', { name: 'Ava', email: null, new_password: null, interests: null, current_password: 'Password1' }, true],
    ['PUT', '/api/users/venmo-username', { venmo_username: null }, true],
    ['PUT', '/api/users/payment-methods', { venmo_username: null, cashapp_cashtag: null, zelle_identifier: null }, true],
    ['POST', '/api/availability', { status: 'down', note: null, expires_at: null }, true],
    ['POST', '/api/calendar', { title: 'Dinner', date: '2026-09-01', venue: null, time: null, color: null }, true],
    ['PUT', '/api/calendar/5', { title: null, date: null, venue: null, time: null, color: null }, true],
  ];
  for (const [method, path, body, auth] of cases) {
    const res = await call(method, path, body, { auth });
    assert.notStrictEqual(res.status, 400, `${method} ${path} -> 400 ${res.text}`);
    assert.ok(routeQueries.length > 0, `${method} ${path}: never reached the database`);
  }
});

// The OAuth pair is its own case: neither half is required on its own, so a
// null in the unused slot has to be read as "not supplied" and the route's own
// "credential is required" answer has to survive when BOTH are null.
test('a null OAuth credential is absent, not invalid', async () => {
  const nulled = await call('POST', '/api/auth/google', { credential: null, access_token: null }, { auth: false });
  assert.strictEqual(nulled.status, 400, nulled.text);
  assert.match(nulled.text, /credential is required/, nulled.text);

  const nonced = await call('POST', '/api/auth/apple',
    { identityToken: 'x'.repeat(40), nonce: null, fullName: null, authorizationCode: null }, { auth: false });
  assert.notStrictEqual(nonced.status, 400, nonced.text);
});

// ── Controls: the guards are not blanket refusals ───────────────────────────
test('well-shaped payloads still reach the database on every guarded route', async () => {
  const cases = [
    ['POST', '/api/friends/request', { user_id: 2 }, true],
    ['POST', '/api/friends/accept', { user_id: 2 }, true],
    ['POST', '/api/friends/decline', { user_id: 2 }, true],
    ['POST', '/api/friends/add-by-code', { code: 'FLOCK-0002' }, true],
    ['POST', '/api/availability', { status: 'down', note: 'out tonight', expires_at: '2026-09-01T04:00:00Z' }, true],
    ['POST', '/api/calendar', { title: 'Dinner', date: '2026-09-01', venue: 'The Bar', time: '8pm', color: '#123456' }, true],
    ['PUT', '/api/calendar/5', { title: 'Dinner', date: '2026-09-01' }, true],
    ['PUT', '/api/users/venmo-username', { venmo_username: 'ava-b' }, true],
    ['PUT', '/api/users/payment-methods', { venmo_username: 'ava-b', cashapp_cashtag: 'avab', zelle_identifier: 'ava@example.com' }, true],
    ['PUT', '/api/users/profile-image', { url: 'https://api.dicebear.com/7.x/bottts/svg?seed=ava' }, true],
    ['PUT', '/api/users/profile', { name: 'Ava B', current_password: 'Password1' }, true],
    ['POST', '/api/auth/signup', { email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: DOB }, false],
    ['POST', '/api/auth/login', { email: 'ava@example.com', password: 'Password1' }, false],
    ['POST', '/api/auth/forgot-password', { email: 'ava@example.com' }, false],
  ];
  for (const [method, path, body, auth] of cases) {
    const res = await call(method, path, body, { auth });
    assert.notStrictEqual(res.status, 400, `${method} ${path} -> 400 ${res.text}`);
    assert.ok(routeQueries.length > 0, `${method} ${path}: never reached the database`);
  }
});

// An empty string is a MEANINGFUL value on the payment handles: it is how the
// shipping client clears one. It must reach the column as NULL, never be
// refused, and never be confused with the empty array that reads as truthy.
test('an empty payment handle clears the column instead of being refused', async () => {
  const res = await call('PUT', '/api/users/payment-methods', {
    venmo_username: '', cashapp_cashtag: '', zelle_identifier: '',
  });
  assert.strictEqual(res.status, 200, res.text);
  const update = routeQueries.find((q) => /UPDATE users SET/i.test(q.sql));
  assert.ok(update, 'the update never ran');
  for (const p of update.params.slice(0, 3)) {
    assert.strictEqual(p, null, `an empty handle reached pg as ${JSON.stringify(p)}`);
  }
});

// ── One definition, not thirteen ────────────────────────────────────────────
test('the round-20 routers import the shared predicate rather than copying it', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const shape = require('../validators/shape');

  for (const v of [undefined, null, '', 'x', 0, 1, false, true]) {
    assert.strictEqual(shape.isScalar(v), true, JSON.stringify(v));
  }
  for (const v of [[], ['x'], {}, { a: 1 }, new Date()]) {
    assert.strictEqual(shape.isScalar(v), false, JSON.stringify(v));
  }

  const guarded = ['auth', 'users', 'friends', 'availability', 'calendar'];
  for (const name of guarded) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', `${name}.js`), 'utf8');
    assert.ok(/require\('\.\.\/validators\/shape'\)/.test(src),
      `routes/${name}.js does not import validators/shape.js`);
  }

  // routes/auth.js keeps rejectNonStringFields ALONGSIDE the shared predicate:
  // it is the stricter "a string or nothing" rule, because a number reaching
  // ageFromDob and then a DATE column is a shape isScalar waves through. What
  // no router may do is grow a second copy of the predicate itself.
  for (const name of guarded) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', `${name}.js`), 'utf8');
    assert.ok(!/const isScalar\s*=/.test(src),
      `routes/${name}.js has its own copy of isScalar`);
  }
});
