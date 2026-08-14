// Run: node --test  (from backend/)
//
// Round 20 — the coerced non-scalar, and its null twin, on the two routers the
// round-19 sweep named but did not reach: routes/venueDashboard.js and
// routes/sensors.js.
//
// THE CLASS. express-validator coerces a value before it tests it, so a
// ONE-ELEMENT ARRAY satisfies isLength / isInt / isFloat / isISO8601 while
// STAYING an array in req.body (sanitizers return non-strings untouched). Two
// failures in one request:
//
//   * it walks past stripHtml AND past rejectIfProfane — utils/moderation.js
//     `moderateText` answers allowed:true for anything that is not a string —
//     so a field the route believed it had screened was screened by nothing; and
//   * node-postgres serialises it as a Postgres array literal against a scalar
//     column, which is a 500 rather than a 400.
//
// WHAT MADE venueDashboard.js THE WORST OF THE TWELVE. Four of its fields are
// PUBLIC user-generated content displayed to other users — promotion title,
// event title, the venue owner's public reply, and the body of a user's review
// of somebody else's business — and NOT ONE of them had a stripHtml on any
// path. rejectIfProfane was the only screen any of them had, and the array form
// skipped that too. So the array was not merely an alternate route past a
// sanitizer here; on these fields it was the only thing between markup and a
// public venue card.
//
// (`title` on venue_reviews does not exist — that table is rating/text/reply.
// The reviewable strings are `text` and `venue_reply`, and both are covered.)
//
// WHAT MADE sensors.js DIFFERENT. It is the ingestion path for hardware sitting
// in a bar, physically reachable by strangers, and it authenticates BEFORE it
// validates — deliberately, so an unauthenticated caller cannot probe the
// payload shape. So "refused before any query" is not the property to assert
// there; "refused before anything is WRITTEN" is. Both are asserted below,
// each against the route it fits.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

process.env.JWT_SECRET = 'venue-ugc-shape-test-secret';
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.GOOGLE_PLACES_API_KEY;

const pool = require('../config/database');

// ── Harness ────────────────────────────────────────────────────────────────
// Scripted pg fake. Every statement is logged so a test can assert both what
// ran and what reached the columns.
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

// Patched BEFORE the routers are required: venueDashboard.js calls
// router.use(authenticate) at require time.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 7, name: 'Owner', role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');
const sensorsRouter = require('../routes/sensors');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/venue-dashboard', venueDashboardRouter);
app.use('/api/sensors', sensorsRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => { server.close(() => resolve()); }));

test.beforeEach(() => {
  handlers = [];
  log = [];
  CURRENT_USER = { id: 7, name: 'Owner', role: 'venue_owner' };
});

async function call(method, path_, body, headers = {}) {
  log = [];
  const res = await fetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json };
}

const ran = (re) => log.filter((q) => re.test(q.sql));

// The venue this owner holds, verified, so nothing stops at an ownership gate.
function venueExists() {
  handlers.push([/FROM venue_profiles WHERE user_id/, () => ({
    rows: [{ id: 1, google_place_id: 'PLACE_A', verified: true }],
  })]);
}

// The shapes. A MULTI-element array gets through the same way whenever the
// joined string still satisfies the rule ("a,b" is three characters), and an
// EMPTY array satisfies every length and range rule vacuously — so a `min: 1`
// field was never actually required.
const NON_SCALARS = [[], ['x'], ['a', 'b'], [1], [['x']], {}, { a: 1 }, { $ne: null }];

// ── venueDashboard: refused BEFORE any query ───────────────────────────────
//
// Asserting on the status alone would pass for a route that stored the array
// and merely rendered it politely. The property that matters is that the shape
// is settled before any validator, sanitizer or statement sees the value.
function sweep(name, { method, path: path_, base: basePayload, fields }) {
  test(`${name}: a non-scalar in any scalar field is a 400 before any query`, async () => {
    for (const field of fields) {
      for (const v of NON_SCALARS) {
        venueExists();
        const res = await call(method, path_, { ...basePayload(), [field]: v });
        const label = `${name} ${field}=${JSON.stringify(v)}`;
        assert.strictEqual(res.status, 400, `${label} -> ${res.status} ${res.text}`);
        assert.deepStrictEqual(log.map((q) => q.sql), [], `${label}: reached the database anyway`);
      }
    }
  });
}

sweep('create promotion', {
  method: 'POST', path: '/api/venue-dashboard/promotions',
  base: () => ({ title: 'Happy hour' }),
  fields: ['title', 'description', 'timeSlot', 'days'],
});

sweep('update promotion', {
  method: 'PUT', path: '/api/venue-dashboard/promotions/2',
  base: () => ({ title: 'Happy hour' }),
  fields: ['title', 'description', 'timeSlot', 'days'],
});

sweep('create event', {
  method: 'POST', path: '/api/venue-dashboard/events',
  base: () => ({ title: 'Quiz night' }),
  fields: ['title', 'eventDate', 'eventTime', 'capacity'],
});

sweep('update event', {
  method: 'PUT', path: '/api/venue-dashboard/events/2',
  base: () => ({ title: 'Quiz night' }),
  fields: ['title', 'eventDate', 'eventTime', 'capacity'],
});

sweep('review reply', {
  method: 'POST', path: '/api/venue-dashboard/reviews/55/reply',
  base: () => ({ reply: 'Thanks for coming' }),
  fields: ['reply'],
});

sweep('submit review', {
  method: 'POST', path: '/api/venue-dashboard/submit-review',
  base: () => ({ googlePlaceId: 'PLACE_A', rating: 4 }),
  fields: ['googlePlaceId', 'rating', 'text'],
});

// ── The bypass, asserted as a bypass ───────────────────────────────────────
//
// This is the test that would fail first if someone moved a shape guard back
// behind a sanitizer, or dropped freeText for a bare .trim().
test('an array cannot smuggle markup past a screen on any public venue field', async () => {
  const payload = ['<img src=x onerror=alert(1)>'];
  const cases = [
    ['POST', '/api/venue-dashboard/promotions', { title: payload }],
    ['POST', '/api/venue-dashboard/promotions', { title: 'Happy hour', description: payload }],
    ['POST', '/api/venue-dashboard/events', { title: payload }],
    ['POST', '/api/venue-dashboard/reviews/55/reply', { reply: payload }],
    ['POST', '/api/venue-dashboard/submit-review', { googlePlaceId: 'PLACE_A', rating: 4, text: payload }],
  ];
  for (const [method, path_, body] of cases) {
    venueExists();
    const res = await call(method, path_, body);
    assert.strictEqual(res.status, 400, `${method} ${path_} ${JSON.stringify(body)} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(log.map((q) => q.sql), [], `${method} ${path_}: reached the database anyway`);
  }
});

// The same trick aimed at the columns rather than the screens.
test('an array cannot turn a bad request into a 500 from Postgres', async () => {
  const cases = [
    // rating is INTEGER behind CHECK (rating BETWEEN 1 AND 5) -> 22P02
    ['POST', '/api/venue-dashboard/submit-review', { googlePlaceId: 'PLACE_A', rating: [4] }],
    // google_place_id is VARCHAR(255), and it is also a WHERE operand in the
    // presence query, so this one reached pg twice.
    ['POST', '/api/venue-dashboard/submit-review', { googlePlaceId: ['PLACE_A'], rating: 4 }],
    // capacity is INTEGER
    ['POST', '/api/venue-dashboard/events', { title: 'Quiz night', capacity: [80] }],
  ];
  for (const [method, path_, body] of cases) {
    venueExists();
    const res = await call(method, path_, body);
    assert.strictEqual(res.status, 400, `${method} ${path_} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(log.map((q) => q.sql), [], `${method} ${path_}: reached the database anyway`);
  }
});

// ── The markup is actually removed, not merely refused when it is an array ──
//
// The guard above only proves a BADLY SHAPED value is refused. The finding was
// that these four fields had no stripHtml at all, so a well-shaped string full
// of markup was stored and re-served. That is what this asserts, at the column.
test('markup in a well-shaped promotion is stripped before it reaches the column', async () => {
  venueExists();
  let insert = null;
  handlers.push([/^INSERT INTO venue_promotions/, (p) => { insert = p; return { rows: [{ id: 1 }] }; }]);
  const res = await call('POST', '/api/venue-dashboard/promotions', {
    title: '<b>Happy</b> hour',
    description: '<script>alert(1)</script>Two for one',
    timeSlot: '<i>5-7pm</i>',
    days: 'Fri<img src=x onerror=alert(1)>',
  });
  assert.strictEqual(res.status, 201, res.text);
  assert.ok(insert, 'the insert never ran');
  // [venue_user_id, google_place_id, title, description, time_slot, days]
  assert.strictEqual(insert[2], 'Happy hour');
  assert.strictEqual(insert[3], 'Two for one');
  assert.strictEqual(insert[4], '5-7pm');
  assert.strictEqual(insert[5], 'Fri');
});

test('markup in an event title is stripped before it reaches the column', async () => {
  venueExists();
  let insert = null;
  handlers.push([/^INSERT INTO venue_events/, (p) => { insert = p; return { rows: [{ id: 1 }] }; }]);
  const res = await call('POST', '/api/venue-dashboard/events', { title: '<b>Quiz</b> night' });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(insert[2], 'Quiz night');
});

test("markup in a venue owner's public reply is stripped before it reaches the column", async () => {
  venueExists();
  let upd = null;
  handlers.push([/^UPDATE venue_reviews SET venue_reply/, (p) => { upd = p; return { rows: [{ id: 55 }] }; }]);
  const res = await call('POST', '/api/venue-dashboard/reviews/55/reply', {
    reply: 'Thanks<script>alert(1)</script> for coming',
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(upd[0], 'Thanks for coming');
});

test('markup in a user review is stripped before it reaches the column', async () => {
  handlers.push([/AS visited/, () => ({ rows: [{ visited: true }] })]);
  let insert = null;
  handlers.push([/^INSERT INTO venue_reviews/, (p) => { insert = p; return { rows: [{ id: 3 }] }; }]);
  const res = await call('POST', '/api/venue-dashboard/submit-review', {
    googlePlaceId: 'PLACE_A', rating: 2, text: 'Loud<img src=x onerror=alert(1)> and slow',
  });
  assert.strictEqual(res.status, 201, res.text);
  // [google_place_id, user_id, rating, text]
  assert.strictEqual(insert[3], 'Loud and slow');
});

// A markup-only value sanitizes to blank, and blank is not a title. Measuring
// the PRE-sanitized string is how a 300-character value made of tags gets
// through while a real one that would overflow the column does not.
test('a title made only of markup is a 400, not a blank row', async () => {
  for (const [path_, body] of [
    ['/api/venue-dashboard/promotions', { title: '<b> </b>' }],
    ['/api/venue-dashboard/events', { title: '<b> </b>' }],
    ['/api/venue-dashboard/reviews/55/reply', { reply: '<b> </b>' }],
  ]) {
    venueExists();
    const res = await call('POST', path_, body);
    assert.strictEqual(res.status, 400, `${path_} -> ${res.status} ${res.text}`);
  }
});

// Profanity screening runs on the STRIPPED string, which is strictly stronger:
// `f<b>u</b>ck` used to be measured by content-checker as an unrecognised word.
test('the profanity screen now reads a string, and reads it after stripping', async () => {
  const { moderateText } = require('../utils/moderation');
  // Only assert the bypass that motivated this, so the test does not encode
  // content-checker's word list.
  assert.strictEqual(moderateText(['anything']).allowed, true,
    'moderateText still answers allowed:true for a non-string — the guard is what stops it');
});

// ── optional() skips undefined, not null ───────────────────────────────────
//
// Every handler below already reads a null as "leave this alone" (`title ||
// null` feeding a COALESCE, `capacity || 50`, `text || null`), so the chain
// above it must not be the thing that refuses it.
test('an explicit null is treated as absent wherever the handler already does', async () => {
  const cases = [
    ['POST', '/api/venue-dashboard/promotions', { title: 'Happy hour', description: null, timeSlot: null, days: null }],
    ['PUT', '/api/venue-dashboard/promotions/2', { title: null, description: 'Two for one', timeSlot: null, days: null }],
    ['POST', '/api/venue-dashboard/events', { title: 'Quiz night', eventDate: null, eventTime: null, capacity: null }],
    ['PUT', '/api/venue-dashboard/events/2', { title: null, eventDate: '2026-09-01', eventTime: null, capacity: null }],
    ['POST', '/api/venue-dashboard/submit-review', { googlePlaceId: 'PLACE_A', rating: 4, text: null }],
  ];
  for (const [method, path_, body] of cases) {
    venueExists();
    handlers.push([/AS visited/, () => ({ rows: [{ visited: true }] })]);
    handlers.push([/venue_promotions|venue_events|venue_reviews/, () => ({ rows: [{ id: 1, is_hidden: false }] })]);
    const res = await call(method, path_, body);
    assert.notStrictEqual(res.status, 400, `${method} ${path_} ${JSON.stringify(body)} -> 400 ${res.text}`);
    assert.ok(log.length > 0, `${method} ${path_}: never reached the database`);
  }
});

test('a null capacity becomes the default, never a NULL column', async () => {
  venueExists();
  let insert = null;
  handlers.push([/^INSERT INTO venue_events/, (p) => { insert = p; return { rows: [{ id: 1 }] }; }]);
  await call('POST', '/api/venue-dashboard/events', { title: 'Quiz night', capacity: null });
  assert.strictEqual(insert[5], 50, `capacity reached pg as ${JSON.stringify(insert[5])}`);
});

// ── int4, the id-range guard's twin ────────────────────────────────────────
//
// Every :id here is a SERIAL. `isInt()` with no ceiling satisfied the chain for
// a 20-digit id, which Postgres answers 22003 — a 500 for a plain 404.
test('an out-of-range id is refused, never handed to Postgres', async () => {
  // The PUT/POST routes answer a validator error as a 400 and the DELETEs map
  // theirs to 404 — the shapes each route already had for `/promotions/abc`.
  // The point here is only that neither hands the id to Postgres.
  const huge = '99999999999999999999';
  const cases = [
    ['PUT', `/api/venue-dashboard/promotions/${huge}`, { title: 'x' }, 400],
    ['DELETE', `/api/venue-dashboard/promotions/${huge}`, undefined, 404],
    ['PUT', `/api/venue-dashboard/events/${huge}`, { title: 'x' }, 400],
    ['DELETE', `/api/venue-dashboard/events/${huge}`, undefined, 404],
    ['POST', `/api/venue-dashboard/reviews/${huge}/reply`, { reply: 'thanks' }, 400],
  ];
  for (const [method, path_, body, expected] of cases) {
    venueExists();
    const res = await call(method, path_, body);
    assert.strictEqual(res.status, expected, `${method} ${path_} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(log.map((q) => q.sql), [], `${method} ${path_}: reached the database anyway`);
  }
});

test('an out-of-range capacity is a 400, not a 22003 from Postgres', async () => {
  venueExists();
  const res = await call('POST', '/api/venue-dashboard/events', { title: 'Quiz night', capacity: 3000000000 });
  assert.strictEqual(res.status, 400, res.text);
  assert.deepStrictEqual(log.map((q) => q.sql), []);
});

// ── Controls: the guards are not blanket refusals ──────────────────────────
test('well-shaped payloads still reach the database on every guarded route', async () => {
  const cases = [
    ['POST', '/api/venue-dashboard/promotions', { title: 'Happy hour', description: 'Two for one', timeSlot: '5-7pm', days: 'Fri' }],
    ['PUT', '/api/venue-dashboard/promotions/2', { title: 'Happy hour' }],
    ['DELETE', '/api/venue-dashboard/promotions/2', undefined],
    ['POST', '/api/venue-dashboard/events', { title: 'Quiz night', eventDate: '2026-09-01', eventTime: '20:00', capacity: 80 }],
    ['PUT', '/api/venue-dashboard/events/2', { title: 'Quiz night' }],
    ['DELETE', '/api/venue-dashboard/events/2', undefined],
    ['POST', '/api/venue-dashboard/reviews/55/reply', { reply: 'Thanks for coming' }],
    ['POST', '/api/venue-dashboard/submit-review', { googlePlaceId: 'PLACE_A', rating: 4, text: 'Great night' }],
  ];
  for (const [method, path_, body] of cases) {
    venueExists();
    handlers.push([/AS visited/, () => ({ rows: [{ visited: true }] })]);
    handlers.push([/venue_promotions|venue_events|venue_reviews/, () => ({ rows: [{ id: 1, is_hidden: false }], rowCount: 1 })]);
    const res = await call(method, path_, body);
    assert.notStrictEqual(res.status, 400, `${method} ${path_} -> 400 ${res.text}`);
    assert.ok(log.length > 0, `${method} ${path_}: never reached the database`);
  }
});

// Punctuation is not markup. stripHtml exists to remove tags, not to corrupt
// ordinary text, and a promotion called "2 for 1 < 9pm" is not an attack.
test('ordinary punctuation survives the new sanitizer byte for byte', async () => {
  venueExists();
  let insert = null;
  handlers.push([/^INSERT INTO venue_promotions/, (p) => { insert = p; return { rows: [{ id: 1 }] }; }]);
  await call('POST', '/api/venue-dashboard/promotions', { title: '2 for 1 < 9pm & after' });
  assert.strictEqual(insert[2], '2 for 1 < 9pm & after');
});

// ═══════════════════════════════════════════════════════════════════════════
// sensors.js — the device is untrusted hardware in somebody else's bar
// ═══════════════════════════════════════════════════════════════════════════

const REAL_KEY = 'flock-sensor-key-abc123';
const STORED_DIGEST = 'sha256:' + crypto.createHash('sha256').update(REAL_KEY, 'utf8').digest('hex');

// Behaves like the real indexed lookup: the row comes back when EITHER bound
// parameter equals the stored value, which is exactly what `api_key = $1 OR
// api_key = $2` does.
function deviceStoredAs(stored, row = {}) {
  handlers.push([/FROM sensor_devices WHERE api_key/, (p) => ({
    rows: (p[0] === stored || p[1] === stored)
      ? [{ id: 1, device_id: 'sensor_001', venue_place_id: 'PLACE_A', is_active: true, ...row }]
      : [],
  })]);
  // The live-stream flood guard: WHERE clause and write in one statement, so a
  // rowCount of 0 IS the 429. Answer 1 by default; the tests that care about the
  // guard script their own.
  handlers.push([/^UPDATE sensor_devices SET last_seen_at/, () => ({ rows: [{ id: 1 }], rowCount: 1 })]);
}

const READING = { ir_beam_count: 4, thermal_headcount: 11, noise_db: 82.5 };
const withKey = (k) => ({ 'x-api-key': k });

const WRITES = /^(INSERT|UPDATE|DELETE)/i;

// ── The digest replay ──────────────────────────────────────────────────────
//
// THE FINDING. `WHERE api_key = $1 OR api_key = $2` compared the presented key
// LITERALLY as well as hashed, to keep legacy plaintext rows working. But a
// stored digest is itself a string, so presenting `sha256:<hex>` — the exact
// bytes sitting in the column — matched on the literal branch and authenticated
// as that device. The hashing bought nothing at all against the one adversary
// it was introduced for: flock-sensor/README.md promises the operator that "a
// database dump then does not hand its reader the ability to forge readings for
// every venue we have hardware in", and before this it did precisely that.
test('the stored digest cannot be replayed as an API key', async () => {
  deviceStoredAs(STORED_DIGEST);
  const res = await call('POST', '/api/sensors/data', READING, withKey(STORED_DIGEST));
  assert.strictEqual(res.status, 401, `a database dump is still a fleet-wide forgery key: ${res.text}`);
  assert.deepStrictEqual(ran(WRITES).map((q) => q.sql), [], 'it wrote a reading anyway');
});

// Round 3 of this audit: the same replay through a seam in the first fix. An
// operator who stored an UPPERCASE digest has a row our lowercase digest can
// never match — so that device is already broken and someone has to fix it —
// but a narrower `sha256:[0-9a-f]{64}` test would have let the uppercase string
// fall through to the literal branch and replay straight out of a dump.
test('no cased or malformed digest can be replayed as an API key either', async () => {
  const upper = 'sha256:' + 'AB'.repeat(32);
  for (const stored of [upper, 'sha256:short', 'SHA256:' + 'ab'.repeat(32)]) {
    handlers = [];
    deviceStoredAs(stored);
    const res = await call('POST', '/api/sensors/data', READING, withKey(stored));
    assert.strictEqual(res.status, 401, `${stored} authenticated by literal comparison: ${res.text}`);
    assert.deepStrictEqual(ran(WRITES).map((q) => q.sql), [], `${stored}: wrote a reading anyway`);
  }
});

test('the real key still authenticates against a hashed row', async () => {
  deviceStoredAs(STORED_DIGEST);
  handlers.push([/^INSERT INTO venue_sensor_data/, () => ({ rows: [{ recorded_at: '2026-08-14T20:00:00.000Z' }] })]);
  const res = await call('POST', '/api/sensors/data', READING, withKey(REAL_KEY));
  assert.strictEqual(res.status, 201, res.text);
});

test('a legacy plaintext row still authenticates, so no fleet re-flash is forced', async () => {
  deviceStoredAs('legacy-plain-key');
  handlers.push([/^INSERT INTO venue_sensor_data/, () => ({ rows: [{ recorded_at: '2026-08-14T20:00:00.000Z' }] })]);
  const res = await call('POST', '/api/sensors/data', READING, withKey('legacy-plain-key'));
  assert.strictEqual(res.status, 201, res.text);
});

// ── The device cannot name its own venue, or forge a time ──────────────────
test('a device cannot report for a venue it is not installed at', async () => {
  deviceStoredAs(STORED_DIGEST);
  let insert = null;
  handlers.push([/^INSERT INTO venue_sensor_data/, (p) => { insert = p; return { rows: [{ recorded_at: 'x' }] }; }]);
  const res = await call('POST', '/api/sensors/data',
    { ...READING, venue_place_id: 'SOMEONE_ELSES_BAR', google_place_id: 'SOMEONE_ELSES_BAR' },
    withKey(REAL_KEY));
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(insert[0], 'PLACE_A', 'the venue came from the payload, not the device row');
});

test('a device echoing somebody else‘s device_id is refused', async () => {
  deviceStoredAs(STORED_DIGEST);
  const res = await call('POST', '/api/sensors/data',
    { ...READING, device_id: 'sensor_999' }, withKey(REAL_KEY));
  assert.strictEqual(res.status, 403, res.text);
  assert.deepStrictEqual(ran(/venue_sensor_data/).map((q) => q.sql), []);
});

test('a forged clock is refused rather than quietly rewritten to server time', async () => {
  for (const [when, why] of [
    [new Date(Date.now() + 60 * 60 * 1000).toISOString(), 'an hour in the future'],
    [new Date(Date.now() - 100 * 3600 * 1000).toISOString(), 'four days stale'],
    ['not-a-time', 'junk'],
  ]) {
    deviceStoredAs(STORED_DIGEST);
    const res = await call('POST', '/api/sensors/data', { ...READING, recorded_at: when }, withKey(REAL_KEY));
    assert.strictEqual(res.status, 400, `${why} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(ran(/venue_sensor_data/).map((q) => q.sql), [], `${why}: written anyway`);
  }
});

// ── The shape sweep, on the readings the crowd model trains on ─────────────
//
// Authentication runs BEFORE validation here on purpose, so the device lookup
// is expected. What must not happen is a WRITE — and before this guard,
// `ir_beam_count: [10]` satisfied isInt by coercion, stayed an array, and
// reached an INTEGER column as `{10}`: a 22P02 on the one endpoint whose job is
// to keep answering while a Pi in a bar retries.
test('a non-scalar reading is a 400 and is never written', async () => {
  for (const field of ['ir_beam_count', 'thermal_headcount', 'noise_db', 'recorded_at', 'device_id', 'dry_run']) {
    for (const v of NON_SCALARS) {
      deviceStoredAs(STORED_DIGEST);
      const res = await call('POST', '/api/sensors/data', { ...READING, [field]: v }, withKey(REAL_KEY));
      const label = `${field}=${JSON.stringify(v)}`;
      assert.strictEqual(res.status, 400, `${label} -> ${res.status} ${res.text}`);
      assert.deepStrictEqual(ran(WRITES).map((q) => q.sql), [], `${label}: wrote something`);
    }
  }
});

// dry_run is compared with `=== true`, so a coerced array read as FALSE — and
// an installer's credential check would have written a fabricated "0 people"
// row into the venue's live occupancy and into the model's training data, which
// is the one thing dry_run exists to prevent.
test('a coerced dry_run cannot be read as a live reading', async () => {
  deviceStoredAs(STORED_DIGEST);
  let insert = null;
  handlers.push([/^INSERT INTO venue_sensor_data/, (p) => { insert = p; return { rows: [{ recorded_at: 'x' }] }; }]);
  const res = await call('POST', '/api/sensors/data',
    { ir_beam_count: 0, thermal_headcount: 0, noise_db: 0, dry_run: ['true'] }, withKey(REAL_KEY));
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(insert, null, 'the self test wrote a fabricated zero reading');
});

test('a real dry run still answers without writing anything', async () => {
  deviceStoredAs(STORED_DIGEST);
  const res = await call('POST', '/api/sensors/data', { ...READING, dry_run: true }, withKey(REAL_KEY));
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(ran(WRITES).map((q) => q.sql), []);
});

// ── A device with no usable clock must never be refused ────────────────────
//
// resolveRecordedAt has always documented `''` as "stamp it on arrival" — a Pi
// has no RTC, so a freshly booted one without NTP is somewhere in the 1970s —
// but `optional({ nullable: true })` skips only undefined and null, so the
// empty string fell through to isISO8601 and the documented branch was
// unreachable. checkFalsy closes it.
test('a device with no clock is stamped on arrival, not refused', async () => {
  for (const raw of [undefined, null, '']) {
    // Reset, or the previous iteration's INSERT handler matches first and this
    // iteration's capture stays null.
    handlers = [];
    deviceStoredAs(STORED_DIGEST);
    let insert = null;
    handlers.push([/^INSERT INTO venue_sensor_data/, (p) => { insert = p; return { rows: [{ recorded_at: 'x' }] }; }]);
    const body = { ...READING };
    if (raw !== undefined) body.recorded_at = raw;
    const res = await call('POST', '/api/sensors/data', body, withKey(REAL_KEY));
    assert.strictEqual(res.status, 201, `recorded_at=${JSON.stringify(raw)} -> ${res.status} ${res.text}`);
    // The 6th bind is COALESCE($6::timestamptz, NOW()) — null means "on arrival".
    assert.strictEqual(insert[5], null, `recorded_at=${JSON.stringify(raw)} reached pg as ${JSON.stringify(insert[5])}`);
  }
});

// The time-forgery guard settles its own input rather than trusting the chain
// in front of it. Date.parse STRINGIFIES its argument, so `recorded_at: 0`
// became Date.parse("0") — the year 2000, a real instant nobody sent — and the
// array form stringified the same way.
test('only a string can be a timestamp', async () => {
  for (const raw of [0, 123456789, true, false]) {
    handlers = [];
    deviceStoredAs(STORED_DIGEST);
    handlers.push([/^INSERT INTO venue_sensor_data/, () => ({ rows: [{ recorded_at: 'x' }] })]);
    const res = await call('POST', '/api/sensors/data', { ...READING, recorded_at: raw }, withKey(REAL_KEY));
    assert.strictEqual(res.status, 400, `recorded_at=${JSON.stringify(raw)} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(ran(/INSERT INTO venue_sensor_data/).map((q) => q.sql), [],
      `recorded_at=${JSON.stringify(raw)}: written anyway`);
  }
});

test('a null device_id and a null dry_run are absent, not errors', async () => {
  deviceStoredAs(STORED_DIGEST);
  handlers.push([/^INSERT INTO venue_sensor_data/, () => ({ rows: [{ recorded_at: 'x' }] })]);
  const res = await call('POST', '/api/sensors/data',
    { ...READING, device_id: null, dry_run: null, recorded_at: null }, withKey(REAL_KEY));
  assert.strictEqual(res.status, 201, res.text);
});

// The bounds are still bounds.
test('out-of-range readings are still refused', async () => {
  for (const body of [
    { ...READING, ir_beam_count: 10001 },
    { ...READING, thermal_headcount: 1001 },
    { ...READING, noise_db: 141 },
    { ...READING, ir_beam_count: -1 },
  ]) {
    deviceStoredAs(STORED_DIGEST);
    const res = await call('POST', '/api/sensors/data', body, withKey(REAL_KEY));
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
  }
});

// ── Round 2 of this audit: what the shape guard did not cover ──────────────

// THE LIVE FIGURE WAS WRITABLE THROUGH THE BACKFILL DOOR.
//
// The flood guard was applied to `!isBackfill`, i.e. only to rows stamped
// within the last 60 SECONDS — but GET /:placeId/current serves the newest row
// within FIFTEEN MINUTES. Everything in between was classified as backfill (no
// rate limit at all) while still being exactly what the app shows as the
// venue's live occupancy. A device pulled off a wall could stamp every forged
// reading 61 seconds old, vary the millisecond so the (device, recorded_at)
// dedupe never matched, and write the public number as fast as the network
// allowed. The route's own comment claimed the opposite.
test('a reading inside the live window is throttled however it is stamped', async () => {
  for (const ageMs of [0, 61 * 1000, 5 * 60 * 1000, 14 * 60 * 1000]) {
    handlers = [];
    deviceStoredAs(STORED_DIGEST);
    // The guard is atomic: rowCount 0 IS the refusal. Simulate a device that
    // pushed a moment ago.
    handlers.unshift([/^UPDATE sensor_devices SET last_seen_at/, (_p, sql) => (
      /last_seen_at <=/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [{ id: 1 }], rowCount: 1 }
    )]);
    handlers.push([/^INSERT INTO venue_sensor_data/, () => ({ rows: [{ recorded_at: 'x' }] })]);
    const body = { ...READING };
    if (ageMs > 0) body.recorded_at = new Date(Date.now() - ageMs).toISOString();
    const res = await call('POST', '/api/sensors/data', body, withKey(REAL_KEY));
    assert.strictEqual(res.status, 429,
      `a reading ${ageMs / 1000}s old bypassed the flood guard: ${res.status} ${res.text}`);
    // The dedupe SELECT is expected — it runs before the guard on purpose (an
    // honest retry must not be charged against the rate limit). What must not
    // happen is a WRITE.
    assert.deepStrictEqual(ran(/INSERT INTO venue_sensor_data/).map((q) => q.sql), [],
      `a reading ${ageMs / 1000}s old was written anyway`);
  }
});

// The ordering the guard above depends on: a row we ALREADY HOLD is not new
// data — nothing is written for it, so it cannot move the live figure, the
// hourly SUM or the training set. Charging it against the rate limit would
// answer an honest retry 429, and a device reads 429 as "try later", so the one
// case the dedupe exists to serve would have become a back-off loop.
test('a retried push inside the live window is recognised, not throttled', async () => {
  handlers = [];
  deviceStoredAs(STORED_DIGEST);
  const takenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  handlers.unshift([/^UPDATE sensor_devices SET last_seen_at/, (_p, sql) => (
    /last_seen_at <=/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [{ id: 1 }], rowCount: 1 }
  )]);
  handlers.unshift([/SELECT recorded_at FROM venue_sensor_data/, () => ({ rows: [{ recorded_at: takenAt }] })]);
  let insert = null;
  handlers.push([/^INSERT INTO venue_sensor_data/, (p) => { insert = p; return { rows: [{ recorded_at: 'x' }] }; }]);

  const res = await call('POST', '/api/sensors/data', { ...READING, recorded_at: takenAt }, withKey(REAL_KEY));
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.duplicate, true, 'the retry was not recognised as one');
  assert.strictEqual(insert, null, 'the doorway was counted twice');
});

// The other half of the same rule: a genuine buffer drain must NOT be told 429,
// because the device reads that as "try later", backs off, and never catches
// up. Only the newest ~15 minutes of a two-hour buffer is throttled.
test('a genuine buffer drain is never throttled', async () => {
  for (const ageMinutes of [16, 60, 47 * 60]) {
    handlers = [];
    deviceStoredAs(STORED_DIGEST);
    handlers.unshift([/^UPDATE sensor_devices SET last_seen_at/, (_p, sql) => (
      /last_seen_at <=/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [{ id: 1 }], rowCount: 1 }
    )]);
    handlers.push([/^INSERT INTO venue_sensor_data/, () => ({ rows: [{ recorded_at: 'x' }] })]);
    const res = await call('POST', '/api/sensors/data', {
      ...READING, recorded_at: new Date(Date.now() - ageMinutes * 60 * 1000).toISOString(),
    }, withKey(REAL_KEY));
    assert.strictEqual(res.status, 201,
      `a ${ageMinutes}-minute-old backfill row was throttled: ${res.status} ${res.text}`);
  }
});

// Old backfill still must not be broadcast as "what is happening now" — the
// throttle question and the broadcast question are separate, and widening one
// must not widen the other.
test('the two timestamp questions stayed separate: old rows are still not broadcast', async () => {
  const emitted = [];
  app.set('io', { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });
  try {
    for (const [ageMs, shouldEmit] of [[0, true], [5 * 60 * 1000, false], [60 * 60 * 1000, false]]) {
      handlers = [];
      emitted.length = 0;
      deviceStoredAs(STORED_DIGEST);
      handlers.push([/^INSERT INTO venue_sensor_data/, () => ({ rows: [{ recorded_at: 'x' }] })]);
      const body = { ...READING };
      if (ageMs > 0) body.recorded_at = new Date(Date.now() - ageMs).toISOString();
      const res = await call('POST', '/api/sensors/data', body, withKey(REAL_KEY));
      assert.strictEqual(res.status, 201, res.text);
      assert.strictEqual(emitted.length > 0, shouldEmit,
        `a reading ${ageMs / 1000}s old: emitted=${emitted.length}, expected ${shouldEmit}`);
    }
  } finally {
    app.set('io', null);
  }
});

// THE ORPHANED REPLY. submit-review is an upsert, and its DO UPDATE list left
// venue_reply alone — so "write a fair review, wait for the owner to reply,
// rewrite the review as an abusive one" left the owner's reply, carrying their
// verified badge, attached underneath words they never saw and could not
// retract (the reply route only ever sets a reply, never clears one).
test("editing a review drops the owner's reply to the words it answered", async () => {
  handlers.push([/AS visited/, () => ({ rows: [{ visited: true }] })]);
  let sql = null;
  handlers.push([/^INSERT INTO venue_reviews/, (_p, s) => { sql = s; return { rows: [{ id: 3 }] }; }]);
  const res = await call('POST', '/api/venue-dashboard/submit-review', {
    googlePlaceId: 'PLACE_A', rating: 1, text: 'Actually it was terrible',
  });
  assert.strictEqual(res.status, 201, res.text);
  // Asserted against the statement actually issued, not against a comment.
  assert.match(sql, /venue_reply = CASE/, 'the reply survives an edit again');
  assert.match(sql, /venue_replied_at = CASE/, 'the reply TIMESTAMP survives an edit again');
  // Only a real change clears it: a double-tapped Submit button resends
  // identical content and must not throw away a reply the owner wrote.
  assert.match(sql, /EXCLUDED\.rating IS DISTINCT FROM venue_reviews\.rating/);
  assert.match(sql, /EXCLUDED\.text IS DISTINCT FROM venue_reviews\.text/);
  // A taken-down review stays taken down however many times its author
  // rewrites it, so is_hidden must NOT appear in the DO UPDATE list.
  assert.ok(!/is_hidden/.test(sql), 'the upsert now resets a moderator takedown');
});

// THE UNSCREENED HALF OF A PROMOTION. /public-promotions serves time_slot and
// days to every user who opens the venue card, exactly as it serves title and
// description — and only the latter two were passed to rejectIfProfane.
test('every publicly-served promotion field is profanity-screened, not just two', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  // The public SELECT names the fields that need screening; the screen has to
  // cover all of them. Read from the source so the two cannot drift.
  const publicSelect = /SELECT p\.id, p\.title, p\.description, p\.time_slot, p\.days FROM venue_promotions/.test(src);
  assert.ok(publicSelect, 'the public promotion projection changed — re-check the screen below');
  const screens = src.match(/for \(const field of \['title', 'description', 'timeSlot', 'days'\]\)/g) || [];
  assert.strictEqual(screens.length, 2, 'the create and update routes must both screen all four fields');
});

test('a promotion field that is served publicly cannot skip the screen', async () => {
  // Uses the profanity list only through the route, so the assertion is about
  // the wiring rather than about content-checker's word list.
  const { moderateText } = require('../utils/moderation');
  const dirty = ['shit', 'fuck', 'bitch'].find((w) => !moderateText(w).allowed);
  if (!dirty) return; // filter changed; nothing to assert about wiring
  for (const field of ['title', 'description', 'timeSlot', 'days']) {
    venueExists();
    handlers.push([/^INSERT INTO venue_promotions/, () => ({ rows: [{ id: 1 }] })]);
    const res = await call('POST', '/api/venue-dashboard/promotions', { title: 'Happy hour', [field]: dirty });
    assert.strictEqual(res.status, 400, `${field} was published unscreened: ${res.status} ${res.text}`);
    assert.deepStrictEqual(ran(/INSERT INTO venue_promotions/).map((q) => q.sql), [],
      `${field}: stored anyway`);
  }
});

// The last two unvalidated inputs on the router. A path segment longer than the
// column can never match a row, so bounding it costs nothing and the chain has
// to be READ — a declared-but-unread validator is the decorative-validator bug
// this file has already been fixed for twice.
test('an oversized placeId is refused before any query, and a real one is not', async () => {
  for (const path_ of ['/api/venue-dashboard/public-reviews/', '/api/venue-dashboard/public-promotions/']) {
    const res = await call('GET', path_ + 'x'.repeat(300));
    assert.strictEqual(res.status, 400, `${path_} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(log.map((q) => q.sql), [], `${path_}: reached the database anyway`);

    const ok = await call('GET', path_ + 'ChIJrTLr-GyuEmsRBfy61i59si0');
    assert.notStrictEqual(ok.status, 400, `${path_} refused a real place id: ${ok.text}`);
    assert.ok(log.length > 0, `${path_}: never reached the database`);
  }
});

// ── One definition, not fourteen ───────────────────────────────────────────
test('both routers import the shared predicate rather than copying it', async () => {
  for (const name of ['venueDashboard', 'sensors']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', `${name}.js`), 'utf8');
    assert.ok(/require\('\.\.\/validators\/shape'\)/.test(src),
      `routes/${name}.js does not import validators/shape.js`);
    assert.ok(!/const isScalar\s*=/.test(src),
      `routes/${name}.js has its own copy of isScalar`);
  }
});

// The claim the fix rests on, pinned against the source rather than a comment:
// every public UGC field on this router is screened by BOTH halves.
test('every public venue UGC field goes through freeText, not a bare trim', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  for (const field of ['title', 'description', 'timeSlot', 'days', 'reply', 'text']) {
    const bare = new RegExp(`body\\('${field}'\\)[^,\\n]*\\.trim\\(\\)`);
    assert.ok(!bare.test(src), `${field} is validated with a bare .trim() again`);
    assert.ok(new RegExp(`freeText\\(body\\('${field}'\\)`).test(src),
      `${field} no longer goes through freeText`);
  }
});
