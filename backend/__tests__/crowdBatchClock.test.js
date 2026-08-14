// Run: node --test  (from backend/)
//
// POST /api/crowd/batch — WHOSE CLOCK, and does the response agree with itself?
//
// Rounds 13-15 moved the venue card, the alternatives strip, the marketing demo
// and the owner dashboard onto the venue's own wall clock. The batch list — the
// list the card sits under — was the one surface left on the VIEWER's clock, and
// it was left there deliberately for a while, because fixing only half of it
// would have been worse than leaving it whole: this endpoint both SCORES each
// venue at an hour and CALIBRATES that score with reports stored per
// (venue_place_id, day_of_week, hour). Move the scoring onto the venue's clock
// without moving the lookup and one response contains a score for 8 PM adjusted
// by the reports people filed at 11 PM.
//
// So the invariant this file exists to pin is not "the batch uses the venue's
// clock". It is: WITHIN ONE RESPONSE, FOR EACH VENUE, THE HOUR SCORED AND THE
// HOUR LOOKED UP ARE THE SAME HOUR — and that hour is the venue's own.
//
// The pg fake below therefore FILTERS by the bound tuple arrays instead of
// returning whatever it was handed. A test whose fake ignores the parameters
// cannot tell a query on the right bucket from a query on the wrong one, which
// is precisely the bug.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'crowd-batch-clock-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

// --- pg fake that actually answers the question it was asked -----------------
const pool = require('../config/database');

let log = [];
// { venue_place_id, day_of_week, hour, crowd_level, predicted_score, user_id, created_at }
let FEEDBACK_ROWS = [];

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  if (!/FROM venue_feedback/.test(flat)) return Promise.resolve({ rows: [], rowCount: 0 });

  const [ids, days, hours] = params || [];
  // The statement binds three parallel arrays. If that ever changes, fail here
  // with a sentence rather than silently returning zero rows and letting the
  // calibration assertions below pass for the wrong reason.
  assert.ok(Array.isArray(ids) && Array.isArray(days) && Array.isArray(hours),
    'the batch feedback read no longer binds (place_id[], day[], hour[]) — update this fake, and read the note in routes/crowd.js first');
  const asked = new Set(ids.map((id, i) => `${id}|${days[i]}|${hours[i]}`));
  const rows = FEEDBACK_ROWS.filter((r) => asked.has(`${r.venue_place_id}|${r.day_of_week}|${r.hour}`));
  return Promise.resolve({ rows, rowCount: rows.length });
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 3, name: 'Ava', role: 'user' }; next(); };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
weatherService.getForecast = async () => [];

// Nothing here should reach Google: the batch route is fed from the request body.
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    throw new Error(`the batch route called Google: ${u}`);
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');

// What the model was asked, and at what instant. The route builds that instant
// with LOCAL date setters, so it is read back with local getters.
let PREDICT_CALLS = [];
let SCORES = {};
let THROWS_FOR = new Set();
mlPredictor.predictBusyness = async (v, _w, ts) => {
  PREDICT_CALLS.push({ place_id: v.place_id, hour: ts.getHours(), day: ts.getDay() });
  if (THROWS_FOR.has(v.place_id)) throw new TypeError('malformed venue blew up inside the predictor');
  const score = SCORES[v.place_id] != null ? SCORES[v.place_id] : 50;
  return {
    score,
    label: crowdEngine.getLabel(score),
    confidence: 60,
    factors: {},
    dataSourcesUsed: ['ml_model'],
    predictionMethod: 'ml',
    modelVersion: 'test',
  };
};

const crowdRouter = require('../routes/crowd');
const { feedbackWindow } = crowdRouter.__testables;

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  log = [];
  FEEDBACK_ROWS = [];
  PREDICT_CALLS = [];
  SCORES = {};
  THROWS_FOR = new Set();
});

// The viewer. Every request below claims to be at 20:00 on a Friday.
const VIEWER_HOUR = 20;
const VIEWER_DAY = 5;

// A utcOffsetMinutes that puts a venue at `hour` local, whenever this runs.
// Only finiteness matters to crowdEngine.venueLocalNow, so the value does not
// have to be one a real country uses.
function offsetForLocalHour(hour, at = new Date()) {
  return (((hour - at.getUTCHours()) * 60) + 1440) % 1440;
}

// The hour(s) a venue at `offset` could legitimately have been scored at, given
// the request happened somewhere between t0 and t1. Two answers when a UTC hour
// ticked over mid-test; one otherwise.
function plausibleHours(offset, t0, t1) {
  return new Set([
    crowdEngine.venueLocalNow(offset, t0).hour,
    crowdEngine.venueLocalNow(offset, t1).hour,
  ]);
}

async function batch(venues, body = {}) {
  const t0 = new Date();
  const res = await fetch(`${base}/api/crowd/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ venues, localHour: VIEWER_HOUR, localDay: VIEWER_DAY, ...body }),
  });
  const t1 = new Date();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text, t0, t1 };
}

function venue(place_id, extra = {}) {
  return {
    place_id,
    name: place_id,
    rating: 4.2,
    user_ratings_total: 300,
    types: ['bar'],
    price_level: 2,
    location: { latitude: 39.74, longitude: -104.98 },
    ...extra,
  };
}

const feedbackQuery = () => log.find((q) => /FROM venue_feedback/.test(q.sql));

// Triples the route asked Postgres for, as [place_id, day, hour].
function askedTriples() {
  const q = feedbackQuery();
  assert.ok(q, 'the batch route did not query venue_feedback at all');
  const [ids, days, hours] = q.params;
  return ids.map((id, i) => [id, days[i], hours[i]]);
}

const triplesFor = (placeId) => askedTriples().filter(([id]) => id === placeId).map(([, d, h]) => [d, h]);
const scoredAt = (placeId) => PREDICT_CALLS.find((c) => c.place_id === placeId);

// A verified report as Postgres hands it back, filed in one weekly bucket.
function report({ place, day, hour, level = 3, userId }) {
  return {
    venue_place_id: place,
    day_of_week: day,
    hour,
    crowd_level: level,
    predicted_score: 50,
    user_id: userId,
    created_at: new Date(),
  };
}

// ===========================================================================
// PART 1 — one request, three venues, three clocks
// ===========================================================================

test('every venue in one batch is scored on its own wall clock, not the viewer\'s', async () => {
  // A list can hold venues in three time zones at once, which is what makes
  // this endpoint different from every other surface: there is no single clock
  // to put the REQUEST on.
  const abroad = offsetForLocalHour(3);
  const far = offsetForLocalHour(14);

  const res = await batch([
    venue('BC_ABROAD', { utcOffsetMinutes: abroad }),
    venue('BC_FAR', { utcOffsetMinutes: far }),
    venue('BC_HOME'), // no offset from the client: the caller's clock stands
  ]);
  assert.strictEqual(res.status, 200, res.text);

  assert.ok(plausibleHours(abroad, res.t0, res.t1).has(scoredAt('BC_ABROAD').hour),
    `a venue at 3 AM local was scored at ${scoredAt('BC_ABROAD').hour}`);
  assert.ok(plausibleHours(far, res.t0, res.t1).has(scoredAt('BC_FAR').hour),
    `a venue at 2 PM local was scored at ${scoredAt('BC_FAR').hour}`);
  assert.strictEqual(scoredAt('BC_HOME').hour, VIEWER_HOUR,
    'a venue with no offset must keep falling back to the caller\'s clock');
  assert.strictEqual(scoredAt('BC_HOME').day, VIEWER_DAY);

  assert.notStrictEqual(scoredAt('BC_ABROAD').hour, scoredAt('BC_FAR').hour,
    'two venues three zones apart were scored at the same hour — one clock for the whole list is the bug');
});

test('the response says which clock each row was scored on', async () => {
  const abroad = offsetForLocalHour(3);
  const res = await batch([
    venue('VC_ABROAD', { utcOffsetMinutes: abroad }),
    venue('VC_HOME'),
  ]);
  assert.strictEqual(res.status, 200, res.text);
  const byId = Object.fromEntries(res.body.predictions.map((p) => [p.placeId, p]));

  // The same field the card publishes, so a client can label the row with the
  // venue's hour instead of the phone's — and so the two halves of this change
  // can deploy in either order.
  assert.strictEqual(byId.VC_ABROAD.venueClock.local, true);
  assert.strictEqual(byId.VC_ABROAD.venueClock.utcOffsetMinutes, abroad);
  assert.strictEqual(byId.VC_ABROAD.venueClock.hour, scoredAt('VC_ABROAD').hour);
  assert.strictEqual(byId.VC_ABROAD.venueClock.day, scoredAt('VC_ABROAD').day);

  assert.strictEqual(byId.VC_HOME.venueClock.local, false,
    'a fallback to the caller\'s clock must announce itself as one');
  assert.strictEqual(byId.VC_HOME.venueClock.utcOffsetMinutes, null);
  assert.strictEqual(byId.VC_HOME.venueClock.hour, VIEWER_HOUR);
});

test('a client that sends junk for an offset is treated as sending none', async () => {
  const res = await batch([
    venue('JUNK_OFFSET', { utcOffsetMinutes: 'abc' }),
    venue('NAN_OFFSET', { utcOffsetMinutes: Number.NaN }),
  ]);
  assert.strictEqual(res.status, 200, res.text);
  for (const id of ['JUNK_OFFSET', 'NAN_OFFSET']) {
    assert.strictEqual(scoredAt(id).hour, VIEWER_HOUR, `${id} was scored on a garbage clock`);
    for (const [, hour] of triplesFor(id)) {
      assert.ok(Number.isInteger(hour) && hour >= 0 && hour <= 23,
        `${id}: a garbage offset reached the SQL as ${hour}`);
    }
  }
});

// ===========================================================================
// PART 2 — the half that makes the other half safe
// ===========================================================================

test('each venue\'s feedback lookup is keyed on the hour that venue was scored at', async () => {
  // THE invariant. Not "the batch uses the venue clock" — that alone would be a
  // half-fix — but "inside one response, per venue, the score and the reports
  // adjusting it are the same hour of the same week".
  const res = await batch([
    venue('AGREE_ABROAD', { utcOffsetMinutes: offsetForLocalHour(3) }),
    venue('AGREE_FAR', { utcOffsetMinutes: offsetForLocalHour(14) }),
    venue('AGREE_HOME'),
  ]);
  assert.strictEqual(res.status, 200, res.text);

  for (const id of ['AGREE_ABROAD', 'AGREE_FAR', 'AGREE_HOME']) {
    const scored = scoredAt(id);
    assert.deepStrictEqual(triplesFor(id), feedbackWindow(scored.day, scored.hour),
      `${id}: scored at day ${scored.day} hour ${scored.hour} but calibrated from another bucket`);
  }
});

test('reports filed in the venue\'s own bucket move it; the viewer\'s bucket does not', async () => {
  // End to end, through a fake that filters on the bound tuples. The model says
  // 20 for both venues. Three verified reporters say "packed" — for ABROAD in
  // the venue's own local bucket, for DECOY in the viewer's 20:00 bucket.
  SCORES.CAL_ABROAD = 20;
  SCORES.CAL_DECOY = 20;
  const offset = offsetForLocalHour(3);
  const local = crowdEngine.venueLocalNow(offset);

  FEEDBACK_ROWS = [
    ...[401, 402, 403].map((u) => report({ place: 'CAL_ABROAD', day: local.day, hour: local.hour, userId: u })),
    // Filed at the hour the VIEWER is at. 20:00 is well outside the ±1 hour
    // window around the venue's 3 AM, so nothing here may vote.
    ...[411, 412, 413].map((u) => report({ place: 'CAL_DECOY', day: VIEWER_DAY, hour: VIEWER_HOUR, userId: u })),
  ];

  const res = await batch([
    venue('CAL_ABROAD', { utcOffsetMinutes: offset }),
    venue('CAL_DECOY', { utcOffsetMinutes: offset }),
  ]);
  assert.strictEqual(res.status, 200, res.text);
  const byId = Object.fromEntries(res.body.predictions.map((p) => [p.placeId, p]));

  assert.strictEqual(byId.CAL_ABROAD.calibration.feedbackUsed, true,
    'three verified reporters in the venue\'s own bucket were not found');
  assert.ok(byId.CAL_ABROAD.score > 20, 'the reports were found and then ignored');

  assert.strictEqual(byId.CAL_DECOY.calibration.reportCount, 0,
    'reports filed at the viewer\'s hour calibrated a venue three time zones away');
  assert.strictEqual(byId.CAL_DECOY.score, 20);
});

test('a venue with no offset still finds the reports filed on the caller\'s clock', async () => {
  // The fallback is not a leftover; it is the answer for the overwhelmingly
  // common case, and it has to keep working end to end.
  SCORES.CAL_HOME = 20;
  FEEDBACK_ROWS = [401, 402, 403].map((u) =>
    report({ place: 'CAL_HOME', day: VIEWER_DAY, hour: VIEWER_HOUR, userId: u }));

  const res = await batch([venue('CAL_HOME')]);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.predictions[0].calibration.feedbackUsed, true);
  assert.ok(res.body.predictions[0].score > 20);
});

test('the same venue twice does not ask Postgres the same question twice', async () => {
  // Twenty venues x three window slots is sixty tuples before dedupe, and a
  // client that sends the same place twice should not widen that.
  const res = await batch([venue('DUP_ONE'), venue('DUP_ONE'), venue('DUP_TWO')]);
  assert.strictEqual(res.status, 200, res.text);

  const triples = askedTriples();
  assert.strictEqual(triples.length, new Set(triples.map((t) => t.join('|'))).size,
    'the tuple list contains duplicates');
  assert.strictEqual(triples.length, 6, 'two distinct venues, three window slots each');
});

test('a body whose venues all lost their place ids asks Postgres nothing at all', async () => {
  const res = await batch([{ name: 'no id here' }]);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(feedbackQuery(), undefined,
    'an empty tuple list is a round trip that can only return zero rows');
});

// ===========================================================================
// PART 3 — one bad venue is one bad venue
// ===========================================================================

test('one venue that throws inside the predictor does not cost the batch its other scores', async () => {
  // The venues here are shaped from REQUEST BODY fields, so a malformed item
  // that throws inside predictBusyness used to reject the whole Promise.all and
  // return a 500: nineteen good venues lost their scores because of the
  // twentieth. /alternatives has always guarded each neighbour individually.
  THROWS_FOR = new Set(['ROT_BAD']);
  const res = await batch([venue('ROT_GOOD_A'), venue('ROT_BAD'), venue('ROT_GOOD_B')]);

  assert.strictEqual(res.status, 200, res.text);
  const ids = res.body.predictions.map((p) => p.placeId);
  assert.deepStrictEqual(ids, ['ROT_GOOD_A', 'ROT_GOOD_B'],
    'the failed venue must be dropped, and the good ones must survive it');
  // The client keys predictions by placeId, so a missing entry degrades to "no
  // crowd badge on that row" rather than to an empty list.
  assert.ok(res.body.predictions.every((p) => typeof p.score === 'number'));
});

test('every venue failing is still a 200 with an empty list, not a 500', async () => {
  THROWS_FOR = new Set(['ALL_BAD_1', 'ALL_BAD_2']);
  const res = await batch([venue('ALL_BAD_1'), venue('ALL_BAD_2')]);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.predictions, []);
  assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)));
});
