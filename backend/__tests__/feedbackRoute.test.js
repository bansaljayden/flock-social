// Run: node --test  (from backend/)
//
// routes/feedback.js — the post-hangout venue feedback surface.
//
// What makes this route worth pinning: a row written here is not inert. It is
// read back by routes/crowd.js (live calibration of the score users see),
// services/mlPredictor.js, the ML training export, and the per-venue aggregate
// in this same file. A forged or mis-bucketed row moves a number a user is
// asked to believe. Every test below is written from that angle: not "does the
// happy path return 201", but "can a wrong number get in, and does a wrong
// number get out".
//
// No database. pool.query / pool.connect are replaced by a fixture dispatcher
// that answers only the statements this route actually issues; anything
// unmodelled is rejected loudly rather than answered with an empty result,
// which would let a test pass for the wrong reason.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-feedback-route-tests';

const pool = require('../config/database');

// ── Fixture state ───────────────────────────────────────────────────────────
let state;
let queries;      // every statement the route issued, in order
let inserted;     // parameters of the INSERT, if it happened
let unknown;      // unmodelled statements

function reset() {
  state = {
    memberships: [{ flock_id: 10, user_id: 1 }], // user 1 belongs to flock 10
    recentCount: 0,          // rows in the last hour for this user
    signedNfcCheckin: false, // an HMAC-signed tap at this venue in the last 3h
    qualifyingFlock: false,  // accepted membership in a >=2-person, non-cancelled flock here
    timezone: null,          // ml_venues.timezone for the place id
    tzQueryFails: false,     // the timezone lookup errors out
    servedScore: null,       // served_predictions row for (user, venue), if any
    servedId: 4001,          // that row's id (the append-only log's join key)
    servedQueryFails: false, // the served-prediction lookup errors out
    aggregate: null,         // row returned by the GET overall query
    byDay: [],
  };
  queries = [];
  inserted = null;
  unknown = [];
}
reset();

function dispatch(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ text, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return Promise.resolve({ rows: [] });
  if (/pg_advisory_xact_lock/i.test(text)) return Promise.resolve({ rows: [{}] });

  if (/FROM flock_members WHERE flock_id/i.test(text)) {
    const [flockId, userId] = params;
    const hit = state.memberships.some((m) => m.flock_id === Number(flockId) && m.user_id === Number(userId));
    return Promise.resolve({ rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 });
  }
  if (/^DELETE FROM venue_feedback/i.test(text)) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM venue_feedback/i.test(text)) {
    return Promise.resolve({ rows: [{ n: state.recentCount }] });
  }
  if (/FROM ml_venues WHERE google_place_id/i.test(text)) {
    if (state.tzQueryFails) return Promise.reject(new Error('relation "ml_venues" does not exist'));
    return Promise.resolve({ rows: state.timezone ? [{ timezone: state.timezone }] : [] });
  }
  if (/FROM served_predictions/i.test(text)) {
    if (state.servedQueryFails) return Promise.reject(new Error('relation "served_predictions" does not exist'));
    return Promise.resolve({ rows: state.servedScore != null ? [{ id: state.servedId, score: state.servedScore }] : [] });
  }
  if (/FROM venue_checkins/i.test(text) && /flock_members fm/i.test(text)) {
    return Promise.resolve({ rows: [{ verified: state.signedNfcCheckin || state.qualifyingFlock }] });
  }
  if (/^INSERT INTO venue_feedback/i.test(text)) {
    inserted = params;
    return Promise.resolve({
      rows: [{
        id: 1,
        user_id: params[0],
        flock_id: params[1],
        venue_place_id: params[2],
        venue_name: params[3],
        crowd_level: params[4],
        price_worth: params[5],
        rating: params[6],
        predicted_score: params[7],
        predicted_score_source: params[8],
        client_predicted_score: params[9],
        served_prediction_id: params[10],
        day_of_week: params[11],
        hour: params[12],
        verified: params[13],
      }],
    });
  }
  if (/COUNT\(\*\) FILTER \(WHERE verified\)/i.test(text)) {
    return Promise.resolve({ rows: [state.aggregate] });
  }
  if (/GROUP BY day_of_week/i.test(text)) {
    return Promise.resolve({ rows: state.byDay });
  }

  unknown.push(text);
  return Promise.reject(new Error(`unscripted query: ${text.slice(0, 140)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => dispatch(sql, params),
  release: () => {},
});

// Auth is stubbed before the router is required (it destructures at load).
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// utils/places is real — the shape rule under test is the shared one.
const feedbackRouter = require('../routes/feedback');
const { venueLocalDayHour } = feedbackRouter.__testables;

const app = express();
app.use(express.json());
app.use('/api/feedback', feedbackRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));
test.beforeEach(() => { reset(); CURRENT_USER = { id: 1, name: 'Ava', role: 'user' }; });

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const base_payload = () => ({
  venue_place_id: PLACE,
  venue_name: 'The Vault',
  crowd_level: 2,
});

// ── The nulls the shipping client actually sends ────────────────────────────
// frontend App.js posts price_worth: null / rating: null whenever the user
// answers only the crowd question, and predicted_score: null when no
// prediction is on screen. express-validator 7's bare .optional() only skips
// `undefined`, so every one of those was a 400 and the report was dropped on
// the client's catch. This is the single highest-volume path in the feature.
test('explicit nulls for the optional fields are accepted, not 400', async () => {
  const r = await call('POST', '/api/feedback', {
    ...base_payload(),
    price_worth: null,
    rating: null,
    predicted_score: null,
    flock_id: null,
  });
  assert.equal(r.status, 201, r.text);
  assert.notEqual(inserted, null);
  assert.equal(inserted[5], null); // price_worth
  assert.equal(inserted[6], null); // rating
  assert.equal(inserted[7], null); // predicted_score
  assert.equal(inserted[1], null); // flock_id
});

test('a real value in an optional field is still validated', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), rating: 9 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /rating/);
});

// ── Id typing and int4 bounds ───────────────────────────────────────────────
test('a flock_id past the int4 ceiling is a 400, not a 500', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), flock_id: 2147483648 });
  assert.equal(r.status, 400, r.text);
  assert.match(r.body.error, /flock_id/);
  assert.equal(inserted, null, 'must be refused before any INSERT');
});

test('a non-numeric flock_id is a 400', async () => {
  for (const bad of ['abc', 1.5, -3, {}, []]) {
    const r = await call('POST', '/api/feedback', { ...base_payload(), flock_id: bad });
    assert.equal(r.status, 400, `flock_id=${JSON.stringify(bad)} -> ${r.text}`);
  }
});

// express-validator 7 validates an array field element by element, so an EMPTY
// array satisfies every rule in the chain (there is nothing to check) and the
// raw array survives into req.body. `crowd_level: []` therefore passed
// isInt({min:1,max:3}) and reached a SMALLINT column as the array literal '{}',
// which Postgres rejects with 22P02 — a 500 handed to any authenticated user
// for a malformed request. `venue_name: []` skipped a `min: 1` length check the
// same way, so a "required" field was not required.
test('an array value in any scalar field is a 400 and never reaches SQL', async () => {
  const fields = [
    'venue_place_id', 'venue_name', 'crowd_level', 'price_worth',
    'rating', 'predicted_score', 'flock_id', 'local_day', 'local_hour',
  ];
  for (const field of fields) {
    for (const bad of [[], ['x'], [2]]) {
      const r = await call('POST', '/api/feedback', { ...base_payload(), [field]: bad });
      assert.equal(r.status, 400, `${field}=${JSON.stringify(bad)} -> ${r.text}`);
    }
  }
  assert.equal(inserted, null);
  assert.equal(queries.length, 0, 'refused before the pool was even touched');
});

test('an object value in any scalar field is a 400', async () => {
  for (const field of ['venue_place_id', 'venue_name', 'crowd_level', 'rating', 'flock_id']) {
    const r = await call('POST', '/api/feedback', { ...base_payload(), [field]: { $ne: 1 } });
    assert.equal(r.status, 400, `${field} -> ${r.text}`);
  }
  assert.equal(inserted, null);
});

// The guard covers every key in the body, not a hand-kept list, so adding a
// field to the validator chain later cannot silently reopen the hole.
test('the scalar guard is not keyed to a list of known fields', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), some_future_field: [] });
  assert.equal(r.status, 400, r.text);
});

test('a body that is not an object at all is still a 400, not a crash', async () => {
  for (const raw of ['"just a string"', '[1,2,3]', 'null', '42']) {
    const res = await fetch(base + '/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });
    assert.equal(res.status, 400, `${raw} -> ${res.status}`);
  }
  assert.equal(inserted, null);
});

test('feedback cannot be attributed to someone else\'s flock', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), flock_id: 99 });
  assert.equal(r.status, 403, r.text);
  assert.equal(inserted, null);
  // The transaction must be unwound, not left open on the pooled connection.
  assert.ok(queries.some((q) => /^ROLLBACK/i.test(q.text)), 'expected ROLLBACK');
  assert.ok(!queries.some((q) => /^COMMIT/i.test(q.text)), 'must not COMMIT');
});

test('a flock the user does belong to is accepted', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), flock_id: 10 });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[1], 10);
});

// ── Place id shape ──────────────────────────────────────────────────────────
test('an over-long place id is a 400 before it can reach VARCHAR(255)', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), venue_place_id: 'C'.repeat(300) });
  assert.equal(r.status, 400, r.text);
  assert.equal(inserted, null);
});

test('a fabricated place id that is not place-id shaped is refused', async () => {
  for (const bad of ['../../etc/passwd', 'not a place id', '<script>', 'ab']) {
    const r = await call('POST', '/api/feedback', { ...base_payload(), venue_place_id: bad });
    assert.equal(r.status, 400, `${bad} -> ${r.text}`);
  }
  assert.equal(inserted, null);
});

test('an over-long venue_name is a 400, not a Postgres 22001 turned into a 500', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), venue_name: 'x'.repeat(256) });
  assert.equal(r.status, 400, r.text);
});

// ── Verified presence ───────────────────────────────────────────────────────
test('with no evidence of presence the row is stored but NOT verified', async () => {
  const r = await call('POST', '/api/feedback', base_payload());
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[13], false, 'verified must be false');
  assert.equal(r.body.verified, false, 'the submitter is told it will not count');
});

test('a signed NFC tap verifies; the presence query trusts ONLY source nfc', async () => {
  state.signedNfcCheckin = true;
  const r = await call('POST', '/api/feedback', base_payload());
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[13], true);

  const presence = queries.find((q) => /FROM venue_checkins/i.test(q.text));
  assert.ok(presence, 'expected a presence query');
  // An allowlist, not a blocklist: `<> 'manual'` would trust 'nfc_unverified'
  // (an unsigned URL visit) and 'gps' (self-asserted).
  assert.match(presence.text, /checkin_source = 'nfc'/);
  assert.doesNotMatch(presence.text, /checkin_source <>/);
});

test('the flock half of the presence rule requires accepted, uncancelled, and 2+ members', async () => {
  state.qualifyingFlock = true;
  const r = await call('POST', '/api/feedback', base_payload());
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[13], true);

  const presence = queries.find((q) => /flock_members fm/i.test(q.text));
  assert.match(presence.text, /fm\.status = 'accepted'/);
  // A cancelled flock is an explicit "we did not go".
  assert.match(presence.text, /f\.status IS DISTINCT FROM 'cancelled'/);
  // A solo flock is self-certification: creating one is a single free POST
  // with a client-supplied venue_id, so it would mint verified for any place
  // id on earth from one account.
  assert.match(presence.text, /COUNT\(\*\) FROM flock_members m[\s\S]*>= 2/);
});

// ── Rate limiting and the transaction ───────────────────────────────────────
test('the hourly cap answers 429 and rolls back', async () => {
  state.recentCount = 10;
  const r = await call('POST', '/api/feedback', base_payload());
  assert.equal(r.status, 429, r.text);
  assert.equal(inserted, null);
  assert.ok(queries.some((q) => /^ROLLBACK/i.test(q.text)));
  assert.ok(!queries.some((q) => /^COMMIT/i.test(q.text)));
});

test('dedupe, cap, presence and insert all run inside one locked transaction', async () => {
  await call('POST', '/api/feedback', base_payload());
  const order = queries.map((q) => q.text);
  const idx = (re) => order.findIndex((t) => re.test(t));

  const begin = idx(/^BEGIN/i);
  const lock = idx(/pg_advisory_xact_lock/i);
  const del = idx(/^DELETE FROM venue_feedback/i);
  const count = idx(/COUNT\(\*\)::int AS n/i);
  const tz = idx(/FROM ml_venues/i);
  const served = idx(/FROM served_predictions/i);
  const ins = idx(/^INSERT INTO venue_feedback/i);
  const commit = idx(/^COMMIT/i);

  // The timezone and served-prediction lookups are reference data that no
  // invariant depends on, and they sit OUTSIDE the transaction on purpose:
  // inside, any failure of either (missing table, statement timeout) aborts
  // the transaction in Postgres and the feedback is lost over a bucket label
  // or a provenance tag.
  assert.ok(tz >= 0 && tz < begin, 'timezone lookup runs before BEGIN');
  assert.ok(served >= 0 && served < begin, 'served-prediction lookup runs before BEGIN');
  assert.ok(begin === served + 1, 'BEGIN opens the transaction');
  // Without the lock, two concurrent submissions can both read a count below
  // the cap and both insert.
  assert.ok(lock > begin && lock < del, 'advisory lock taken before any read');
  assert.ok(del < count && count < ins && ins < commit, 'read-then-write ordering inside the tx');
});

test('the advisory lock is namespaced per user, with an int4-safe key', async () => {
  await call('POST', '/api/feedback', base_payload());
  const lock = queries.find((q) => /pg_advisory_xact_lock/i.test(q.text));
  assert.deepEqual(lock.params, [81422, 1]);
  for (const p of lock.params) {
    assert.ok(Number.isInteger(p) && p <= 2147483647 && p >= -2147483648, 'int4 range');
  }
});

// ── The clock the buckets are written on ────────────────────────────────────
// day_of_week / hour are lookup keys, and routes/crowd.js looks them up with
// the VENUE's local day and hour. Writing them from the database server clock
// (UTC on Railway) filed a 9pm Friday Austin report as Saturday 02:00: the
// Friday lookup found nothing and the Saturday-small-hours lookup found a
// crowd level from a different part of the week.
test('venueLocalDayHour resolves a venue timezone to its own wall clock', () => {
  // Fri 2026-07-03 02:00 UTC == Thu 21:00 in Chicago (UTC-5 in July).
  const at = new Date('2026-07-03T02:00:00Z');
  assert.deepEqual(venueLocalDayHour('America/Chicago', at), { day: 4, hour: 21, source: 'venue' });
  assert.deepEqual(venueLocalDayHour('UTC', at), { day: 5, hour: 2, source: 'venue' });
  // A half-hour zone must not be rounded into the wrong hour.
  assert.equal(venueLocalDayHour('Asia/Kolkata', at).hour, 7);
});

test('venueLocalDayHour returns null for a missing or garbage zone rather than throwing', () => {
  const at = new Date();
  for (const bad of [null, undefined, '', 'Not/AZone', 12345, {}]) {
    assert.equal(venueLocalDayHour(bad, at), null, String(bad));
  }
});

test('midnight in the venue zone is hour 0, never 24', () => {
  // 06:30 UTC == 00:30 in Chicago (UTC-6 in January).
  const at = new Date('2026-01-09T06:30:00Z');
  assert.equal(venueLocalDayHour('America/Chicago', at).hour, 0);
});

test('a known venue is bucketed on its own timezone, not the server clock', async () => {
  state.timezone = 'Asia/Kolkata';
  const now = new Date();
  const expected = venueLocalDayHour('Asia/Kolkata', now);
  const r = await call('POST', '/api/feedback', base_payload());
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[11], expected.day);
  assert.equal(inserted[12], expected.hour);
  // and the bucket is a parameter, not EXTRACT(... FROM NOW()) in the SQL
  const ins = queries.find((q) => /^INSERT INTO venue_feedback/i.test(q.text));
  assert.doesNotMatch(ins.text, /EXTRACT/i);
});

test('an unknown venue falls back to the client clock hint when given', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), local_day: 5, local_hour: 21 });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[11], 5);
  assert.equal(inserted[12], 21);
});

test('an out-of-range clock hint is a 400 and can never reach the SMALLINT columns', async () => {
  for (const bad of [{ local_day: 7 }, { local_day: -1 }, { local_hour: 24 }, { local_hour: -1 }]) {
    const r = await call('POST', '/api/feedback', { ...base_payload(), local_day: 1, local_hour: 1, ...bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} -> ${r.text}`);
  }
});

test('a failing timezone lookup degrades the bucket, it does not lose the report', async () => {
  state.tzQueryFails = true;
  const r = await call('POST', '/api/feedback', { ...base_payload(), local_day: 3, local_hour: 14 });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[11], 3);
  assert.equal(inserted[12], 14);
  // and the transaction that followed still committed cleanly
  assert.ok(queries.some((q) => /^COMMIT/i.test(q.text)));
  assert.ok(!queries.some((q) => /^ROLLBACK/i.test(q.text)));
});

test('with no timezone and no hint the server clock is used, in range', async () => {
  const r = await call('POST', '/api/feedback', base_payload());
  assert.equal(r.status, 201, r.text);
  assert.ok(Number.isInteger(inserted[11]) && inserted[11] >= 0 && inserted[11] <= 6);
  assert.ok(Number.isInteger(inserted[12]) && inserted[12] >= 0 && inserted[12] <= 23);
});

// ── The aggregate: unverified rows must be EXCLUDED, not merely flagged ─────
test('the public per-venue aggregate counts verified rows only', async () => {
  state.aggregate = {
    total_feedback: 3,
    unverified_excluded: 40,
    avg_crowd_level: '2.3',
    avg_rating: '4.0',
    price_worth_percent: '66',
  };
  state.byDay = [{ day_of_week: 5, avg_crowd_level: '2.5', count: 2 }];

  const r = await call('GET', `/api/feedback/venue/${PLACE}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.verifiedOnly, true);
  assert.equal(r.body.totalFeedback, 3);
  // The 40 unverifiable reports are reported, not silently dropped: "3 reports"
  // and "3 of 43 reports could be verified" are different claims.
  assert.equal(r.body.unverifiedExcluded, 40);

  const overall = queries.find((q) => /COUNT\(\*\) FILTER \(WHERE verified\)/i.test(q.text));
  assert.match(overall.text, /AVG\(crowd_level\) FILTER \(WHERE verified\)/);
  assert.match(overall.text, /AVG\(rating\) FILTER \(WHERE verified\)/);
  assert.match(overall.text, /FILTER \(WHERE verified AND price_worth = true\)/);

  const day = queries.find((q) => /GROUP BY day_of_week/i.test(q.text));
  assert.match(day.text, /verified = true/);
});

test('a genuine 0% price-worth is reported as 0, not as no-data', async () => {
  state.aggregate = {
    total_feedback: 4,
    unverified_excluded: 0,
    avg_crowd_level: '3.0',
    avg_rating: null,
    price_worth_percent: 0, // a number, as a driver returning numerics as JS numbers would
  };
  const r = await call('GET', `/api/feedback/venue/${PLACE}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.priceWorthPercent, 0, 'everybody said it was not worth it — that is an answer');
  assert.equal(r.body.avgRating, null, 'nobody rated it — that is not an answer');
});

test('a venue with no verified feedback reports nulls, not zeros', async () => {
  state.aggregate = {
    total_feedback: 0,
    unverified_excluded: 7,
    avg_crowd_level: null,
    avg_rating: null,
    price_worth_percent: null,
  };
  const r = await call('GET', `/api/feedback/venue/${PLACE}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.totalFeedback, 0);
  assert.equal(r.body.unverifiedExcluded, 7);
  assert.equal(r.body.avgCrowdLevel, null);
  assert.equal(r.body.avgRating, null);
});

test('a malformed place id on the aggregate is a 400 and never reaches SQL', async () => {
  const r = await call('GET', '/api/feedback/venue/not%20a%20place%20id');
  assert.equal(r.status, 400, r.text);
  assert.equal(queries.length, 0);
});

// ── predicted_score provenance (migration 032) ──────────────────────────────
// The denominator of every calibration feature used to be whatever the client
// asserted. routes/crowd.js now records every score it publishes in
// served_predictions, and this route prefers its own record: a served row for
// (user, venue) in the last 12 hours wins outright, the client's claim is kept
// verbatim beside it, and predicted_score_source says which one the
// calibration layer is looking at.
test('a served prediction overrides the client claim, and the row says so', async () => {
  state.servedScore = 40;
  state.servedId = 4711;
  const r = await call('POST', '/api/feedback', { ...base_payload(), predicted_score: 95 });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[7], 40, 'predicted_score must be the score the server actually served');
  assert.equal(inserted[8], 'server');
  assert.equal(inserted[9], 95, 'the client claim is kept verbatim for comparison');
  assert.equal(inserted[10], 4711, 'the row names the exact serve its denominator came from');
  assert.equal(r.body.predicted_score, 40, 'the submitter sees the server-resolved value');
});

test('the served lookup is keyed to THIS caller and THIS venue, newest serve, inside 12 hours', async () => {
  state.servedScore = 40;
  const r = await call('POST', '/api/feedback', { ...base_payload(), predicted_score: 95 });
  assert.equal(r.status, 201, r.text);
  const lookup = queries.find((q) => /FROM served_predictions/i.test(q.text));
  assert.ok(lookup, 'expected a served_predictions lookup');
  assert.deepEqual(lookup.params, [1, PLACE], 'must be scoped to the authenticated user and the reported venue');
  assert.match(lookup.text, /INTERVAL '12 hours'/, 'a stale served score must not become the denominator');
  // The log is append-only (routes/crowd.js), so a night holds many serves for
  // one (user, venue). Without the ordering, "some serve from tonight" stands
  // in for "the score on screen at submit time".
  assert.match(lookup.text, /ORDER BY served_at DESC\s+LIMIT 1/i, 'must take the NEWEST serve, not an arbitrary one');
});

test('with no served record the client value still lands, marked as the claim it is', async () => {
  const r = await call('POST', '/api/feedback', { ...base_payload(), predicted_score: 90 });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[7], 90);
  assert.equal(inserted[8], 'client');
  assert.equal(inserted[9], 90);
  assert.equal(inserted[10], null, 'no serve, no serve id — a client claim must not invent one');
});

test('no served record and no client claim means null everywhere, not a fabricated source', async () => {
  const r = await call('POST', '/api/feedback', base_payload());
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[7], null);
  assert.equal(inserted[8], null);
  assert.equal(inserted[9], null);
  assert.equal(inserted[10], null);
});

test('a failing served lookup degrades provenance to client, it does not lose the report', async () => {
  state.servedQueryFails = true;
  const r = await call('POST', '/api/feedback', { ...base_payload(), predicted_score: 55 });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[7], 55);
  assert.equal(inserted[8], 'client');
  assert.ok(queries.some((q) => /^COMMIT/i.test(q.text)), 'the transaction still committed');
});

test('the lookup runs OUTSIDE the transaction, so its failure cannot abort the insert', async () => {
  await call('POST', '/api/feedback', { ...base_payload(), predicted_score: 55 });
  const beginIdx = queries.findIndex((q) => /^BEGIN/i.test(q.text));
  const servedIdx = queries.findIndex((q) => /FROM served_predictions/i.test(q.text));
  assert.ok(servedIdx >= 0 && beginIdx > servedIdx,
    'served_predictions must be read before BEGIN — inside the tx, a failed lookup aborts the feedback');
});

// ── Nothing unmodelled slipped past ─────────────────────────────────────────
test('no unscripted statement was issued by any test above', () => {
  assert.deepEqual(unknown, []);
});
