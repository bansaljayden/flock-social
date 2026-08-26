// Run: node --test  (from backend/)
//
// Three invariants that live in TWO places each, which is why they drift.
//
// PART 1 — PRESENCE PARITY. routes/feedback.js and routes/venueDashboard.js
// both decide "can we show that this person was actually at this venue", and
// venueDashboard's comment claimed it ran the same rule. It did not: the flock
// branch was missing the "at least two accepted members" clause, so a solo
// flock — one POST with a venue id of your choosing — self-certified a review,
// and reviews are what the public star rating on the venue card is made of.
// The clause is adopted now. These tests pin the parity that is real AND the
// three differences that are deliberate, so neither half can be quietly
// "fixed" into agreement with the other.
//
// PART 2 — THE CALIBRATION ROW BUDGET. The single-venue read carries
// `LIMIT 50` and therefore must carry `DISTINCT ON (user_id)`: a row budget
// spent on one account's duplicates is a genuine reporter pushed out of the
// sample. The batch and alternatives reads carry no LIMIT, so the JavaScript
// dedupe in crowdEngine.buildCalibrationAdjustment is sufficient there and
// SQL-level dedupe would only save bytes. That reasoning was re-verified this
// round and holds — but it holds *because* there is no LIMIT, and adding one is
// otherwise a reasonable thing to want (only the 28-day window bounds those two
// queries today). So the invariant is pinned as a rule rather than as three
// separate facts: A CALIBRATION READ WITH A `LIMIT` MUST HAVE `DISTINCT ON`.
// Plus the other leg the reasoning stands on: no NULL-reporter row can exist,
// which is a property of the venue_feedback.user_id foreign key, not of any JS.
//
// PART 3 — THE FORECAST PAYWALL. gateForecast() was entirely untested, and it
// leaked: it blanked `bestTime` while leaving `bestHour`, `bestIndex` and
// `bestIsNow` — the same answer in three other fields — in a locked response.
// Frontend gating is cosmetic, so anything left in the payload is shipped.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'presence-parity-test-secret';
// Captured at module load by both routers.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.VENUE_BILLING_ENABLED;

// --- scripted pg fake -------------------------------------------------------
const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, raw: String(sql), params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
}
pool.query = (sql, params) => dispatch(sql, params);

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// Destructured at load by both routers.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
weatherService.getForecast = async () => [];

// --- Google Places, faked ---------------------------------------------------
// utcOffsetMinutes stays null so the venue clock falls back to the localHour /
// localDay these tests pass in, which keeps the cache keys predictable.
function place(id) {
  return {
    id,
    displayName: { text: id },
    formattedAddress: '1 Main St',
    rating: 4.2,
    userRatingCount: 300,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'],
    location: { latitude: 39.74, longitude: -104.98 },
    currentOpeningHours: { openNow: true, periods: [] },
    utcOffsetMinutes: null,
  };
}

let NEARBY = [];
let fetched = [];
// How the neighbour search answers. The default is a real, successful search.
let SEARCH_RESPONSE = null;
// 'details' | 'search' — makes that Google call REJECT, the way an
// upstreamSignal timeout or a dropped socket does.
let FETCH_THROWS = null;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) fetched.push(u);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')
   || u.startsWith('https://places.googleapis.com/v1/places:searchNearby')) {
    if (FETCH_THROWS === 'search') {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      return Promise.reject(e);
    }
    if (SEARCH_RESPONSE) return Promise.resolve(SEARCH_RESPONSE);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: NEARBY }) });
  }
  if (FETCH_THROWS === 'details' && u.startsWith('https://places.googleapis.com/')) {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    return Promise.reject(e);
  }
  if (u.startsWith('https://places.googleapis.com/')) {
    const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0];
    return Promise.resolve({ ok: true, status: 200, json: async () => place(id || 'PLACE_X') });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');

// Called through the module object by the routes, so they can be stubbed here.
// A rising evening curve, so the best-time sentence names a real later hour
// rather than "now" — otherwise the locked/unlocked comparison in PART 3 would
// be comparing two nulls.
mlPredictor.predictBusyness = async () => ({
  score: 30,
  label: crowdEngine.getLabel(30),
  confidence: 60,
  factors: {},
  dataSourcesUsed: ['ml_model'],
  predictionMethod: 'ml',
  modelVersion: 'test',
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const score = i === 0 ? 30 : 30 + i;
    return { hour: `${h12} ${h < 12 ? 'AM' : 'PM'}`, score, label: crowdEngine.getLabel(score) };
  });

const crowdRouter = require('../routes/crowd');
const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);
app.use('/api/venue-dashboard', venueDashboardRouter);

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

test.beforeEach(() => {
  handlers = [];
  log = [];
  NEARBY = [];
  fetched = [];
  SEARCH_RESPONSE = null;
  FETCH_THROWS = null;
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  delete process.env.PAYWALL_ENABLED;
});

async function call(method, path_, body) {
  const res = await realFetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));

// ===========================================================================
// PART 1 — the review presence rule vs the feedback presence rule
// ===========================================================================

// routes/feedback.js is read as text rather than required: VERIFIED_PRESENCE_SQL
// is a module-private constant, and the point of this comparison is the SQL a
// reader of that file would see.
const FEEDBACK_SOURCE = fs.readFileSync(require.resolve('../routes/feedback'), 'utf8');
const FEEDBACK_PRESENCE_SQL = (() => {
  const start = FEEDBACK_SOURCE.indexOf('const VERIFIED_PRESENCE_SQL = `');
  assert.ok(start >= 0, 'routes/feedback.js no longer defines VERIFIED_PRESENCE_SQL');
  const open = FEEDBACK_SOURCE.indexOf('`', start);
  const close = FEEDBACK_SOURCE.indexOf('`', open + 1);
  return FEEDBACK_SOURCE.slice(open + 1, close).replace(/\s+/g, ' ').trim();
})();

const REVIEW_BODY = { googlePlaceId: 'PLACE_PARITY', rating: 5 };
function scriptReview(visited) {
  handlers = [
    [/AS visited/, () => ({ rows: [{ visited }] })],
    [/INSERT INTO venue_reviews/, () => ({ rows: [{ id: 1, rating: 5 }] })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
}

async function reviewPresenceSql() {
  scriptReview(true);
  log = [];
  const res = await call('POST', '/api/venue-dashboard/submit-review', REVIEW_BODY);
  assert.strictEqual(res.status, 201, res.text);
  const q = ran(/AS visited/)[0];
  assert.ok(q, 'submit-review no longer runs a presence check at all');
  return q.sql;
}

test('a review needs a flock somebody else accepted, exactly as feedback does', async () => {
  const sql = await reviewPresenceSql();

  // THE CLAUSE THIS ROUND ADDED. Creating a flock is one request with a
  // client-supplied venue_id, so without a second accepted member the "proof"
  // of presence is a document the reviewer wrote themselves. One account could
  // one-star every competitor on the map.
  const twoMembers = /SELECT COUNT\(\*\) FROM flock_members m WHERE m\.flock_id = f\.id AND m\.status = 'accepted' \) >= 2/;
  assert.match(
    sql.replace(/\s+/g, ' '),
    twoMembers,
    'a solo flock self-certifies a review: the two-accepted-members clause is gone'
  );
  assert.match(
    FEEDBACK_PRESENCE_SQL,
    twoMembers,
    'routes/feedback.js lost the clause this file exists to keep in step with it'
  );

  // The rest of the conditions, asserted on BOTH statements in the same
  // assertion so neither can drift alone.
  for (const [name, re] of [
    ['signed taps only (migration 004 stores unsigned visits as nfc_unverified)', /checkin_source = 'nfc'/],
    ['an invitation nobody accepted is not attendance', /fm\.status = 'accepted'/],
    ['the flock must name the venue in question', /f\.venue_id = \$2/],
    ['a cancelled flock is an explicit "we did not go"', /f\.status IS DISTINCT FROM 'cancelled'/],
  ]) {
    assert.match(sql, re, `submit-review: ${name}`);
    assert.match(FEEDBACK_PRESENCE_SQL, re, `feedback.js: ${name}`);
  }
  // A blocklist would trust 'nfc_unverified' and 'gps', both self-asserted.
  assert.ok(!/<>\s*'manual'/.test(sql), 'the check-in signal became a blocklist');
});

test('the windows are still deliberately different, and in the documented direction', async () => {
  const sql = await reviewPresenceSql();

  // A review is written after the fact — often the next morning — so presence
  // counts for 30 days on BOTH signals. Forcing feedback's 3-hour tap window on
  // it would refuse nearly every honest review.
  // NOW_UTC accepts both the bare NOW() these clauses used to carry and the
  // (NOW() AT TIME ZONE 'UTC') the event_time comparisons carry now. That
  // rewrite was a real fix and not a rename: event_time is TIMESTAMP WITHOUT
  // TIME ZONE holding a UTC wall clock, so a bare NOW() casts the naive side at
  // the database session zone and the window was right only because Railway
  // runs UTC. The WINDOW LENGTHS below are what this test is about and they are
  // unchanged; only the spelling of "now" moved, and these patterns had pinned
  // the spelling. venueDashboardClockBounds.test.js is what fails if a bare
  // NOW() comes back against event_time, so widening here loses no guard.
  // The zone NAME is read in either case, and that is not laxity. Postgres
  // resolves time zone names case-insensitively, services/photoStore.js already
  // writes AT TIME ZONE 'utc' in lower case, and flockCompletionSweep.test.js
  // already reads this same literal with the i flag. Pinning the capitals would
  // fail a correct rewrite on the case of three letters, which is the defect
  // this pattern was widened to stop making.
  const NOW_UTC = "(?:NOW\\(\\)|\\(NOW\\(\\) AT TIME ZONE '[Uu][Tt][Cc]'\\))";
  assert.match(sql, new RegExp(`created_at > ${NOW_UTC} - INTERVAL '30 days'`), 'the check-in window is no longer the review window');
  assert.match(sql, new RegExp(`f\\.event_time BETWEEN ${NOW_UTC} - INTERVAL '30 days'`), 'the flock window is no longer the review window');
  // ...and reviewing while you are still there works: feedback's 12-hour lead
  // is kept on the forward edge.
  assert.match(sql, new RegExp(`${NOW_UTC} \\+ INTERVAL '12 hours'`));

  // Feedback is a LIVE crowd report and keeps the tight windows. If this ever
  // matches 30 days, somebody has "unified" the two rules in the wrong
  // direction and a day-old tap now verifies a live busyness report.
  assert.match(FEEDBACK_PRESENCE_SQL, /created_at > NOW\(\) - INTERVAL '3 hours'/,
    'feedback.js widened its check-in window to match reviews; a live report is not a review');
  assert.ok(!/INTERVAL '30 days'/.test(FEEDBACK_PRESENCE_SQL),
    'feedback.js adopted the review windows');
});

test('the upsert escape hatch is review-only, and stays', async () => {
  const sql = await reviewPresenceSql();
  // submit-review is an upsert: the same POST edits an existing review.
  // Presence was proved when it was first written, so locking someone out of
  // correcting their own words two months later would be absurd. feedback.js
  // INSERTs, so it has no equivalent and must not grow one.
  assert.match(sql, /FROM venue_reviews WHERE user_id = \$1 AND google_place_id = \$2/,
    'you can no longer edit a review you already wrote');
  assert.ok(!/FROM venue_feedback/.test(FEEDBACK_PRESENCE_SQL),
    'feedback.js presence now trusts a previous report, which is circular');
});

test('a presence check that says no still refuses the review', async () => {
  scriptReview(false);
  const res = await call('POST', '/api/venue-dashboard/submit-review', REVIEW_BODY);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'VISIT_REQUIRED');
  assert.strictEqual(ran(/INSERT INTO venue_reviews/).length, 0, 'the review was written anyway');
});

// ===========================================================================
// PART 2 — the calibration row budget
// ===========================================================================

function scriptFeedback(rows) {
  handlers = [
    [/FROM venue_feedback/, () => ({ rows })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
}
const feedbackSql = () => log.find((q) => /FROM venue_feedback/.test(q.sql))?.sql;

const CALIBRATION_PATHS = [
  {
    name: 'GET /api/crowd/:placeId',
    budgeted: true, // carries LIMIT 50
    run: (suffix) => call('GET', `/api/crowd/SINGLE_${suffix}?localHour=20&localDay=5`),
  },
  {
    name: 'POST /api/crowd/batch',
    budgeted: false,
    run: (suffix) => call('POST', '/api/crowd/batch', {
      venues: [{ place_id: `BATCH_${suffix}`, location: { latitude: 39.74, longitude: -104.98 } }],
      localHour: 20,
      localDay: 5,
    }),
  },
  {
    name: 'GET /api/crowd/:placeId/alternatives',
    budgeted: false,
    run: (suffix) => call('GET', `/api/crowd/ALT_${suffix}/alternatives?localHour=20&localDay=5`),
  },
];

test('a calibration read with a row budget must spend it on distinct reporters', async () => {
  // The rule, not the three current answers. buildCalibrationAdjustment keeps
  // exactly one report per account, so every duplicate row inside a LIMIT is a
  // slot a genuine reporter does not get — and a handful of accounts holding a
  // dozen in-window rows each can own the whole sample. Without a LIMIT the
  // duplicates are merely fetched and discarded, which is why the batch and
  // alternatives reads are correct as they stand.
  let i = 0;
  for (const p of CALIBRATION_PATHS) {
    scriptFeedback([]);
    log = [];
    const res = await p.run(`BUDGET${i++}`);
    assert.strictEqual(res.status, 200, res.text);

    const sql = feedbackSql();
    assert.ok(sql, `${p.name} did not query venue_feedback at all`);
    const hasLimit = /\bLIMIT\b/.test(sql);
    const hasDedupe = /DISTINCT ON \(\s*user_id\s*\)/.test(sql);
    if (hasLimit) {
      assert.ok(hasDedupe,
        `${p.name}: this query caps its rows but does not dedupe reporters in SQL, so the cap can be filled by one account`);
      assert.match(sql, /ORDER BY user_id, created_at DESC/,
        `${p.name}: the row kept per account must be that account's newest report`);
    }
    // And the current shape, so a LIMIT appearing on an un-deduped read is a
    // failure here rather than a silent regression somewhere downstream.
    assert.strictEqual(hasLimit, p.budgeted,
      `${p.name}: the row budget changed — re-read the invariant note in routes/crowd.js before updating this`);
  }
});

test('no calibration row can arrive without an account attached to it', () => {
  // The other leg the batch/alternatives reasoning stands on. crowdEngine
  // counts a NULL-user_id row INDIVIDUALLY (it cannot attribute it, and
  // dropping evidence is the wrong default), so on the two un-deduped paths a
  // pile of NULL-reporter rows would each get a vote. Nothing can write one:
  // routes/feedback.js is the only writer and always binds the authenticated
  // caller, and the column CASCADEs, so a deleted account takes its reports
  // with it instead of orphaning them. Change that FK to SET NULL and the
  // reasoning behind those two queries silently stops holding.
  const sqlDir = path.join(__dirname, '..', 'migrations');
  const files = [
    ...fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).map((f) => path.join(sqlDir, f)),
    path.join(__dirname, '..', 'database', 'schema.sql'),
  ].filter((f) => fs.existsSync(f));

  let sawDefinition = false;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');

    const create = text.match(/CREATE TABLE IF NOT EXISTS venue_feedback\s*\(([\s\S]*?)\n\s*\);/);
    if (create) {
      sawDefinition = true;
      assert.match(
        create[1].replace(/\s+/g, ' '),
        /user_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE/,
        `${path.basename(file)}: venue_feedback.user_id must CASCADE, or deleted accounts become unattributable voters`
      );
    }

    // Nothing may re-point the column later either.
    for (const alter of text.match(/ALTER TABLE\s+venue_feedback[^;]*/gi) || []) {
      assert.ok(!/user_id/i.test(alter),
        `${path.basename(file)}: a migration alters venue_feedback.user_id — re-check the NULL-reporter argument in routes/crowd.js`);
    }
  }
  assert.ok(sawDefinition, 'venue_feedback is no longer created by any migration; this guard is looking at nothing');
});

// ===========================================================================
// PART 3 — the forecast paywall gate
// ===========================================================================

// The fields the meter sells. Every one of these answers "when should I go",
// which is the whole product of the gate; the free half below answers "how busy
// is it right now", which is the commodity Google gives away.
const PREMIUM_FIELDS = ['bestTime', 'hourly', 'peak', 'bestHour', 'bestIndex', 'bestIsNow'];
const FREE_FIELDS = ['score', 'label', 'isOpen', 'hoursToday', 'capacity', 'waitEstimate', 'calibration'];

function scriptMeter({ premium }) {
  handlers = [
    [/SELECT is_premium FROM users/, () => ({ rows: [{ is_premium: premium }] })],
    [/FROM venue_feedback/, () => ({ rows: [] })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
}

// A fresh user id per test: forecastUsage is a process-wide in-memory meter.
let nextMeterUser = 90000;
const meterUser = () => { CURRENT_USER = { id: ++nextMeterUser, name: 'Meter', role: 'user' }; };

test('with the paywall dormant nothing is metered and nothing is stripped', async () => {
  meterUser();
  scriptMeter({ premium: false });
  const res = await call('GET', '/api/crowd/PW_OFF?localHour=20&localDay=5');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!('forecastAccess' in res.body), 'the dormant paywall announced itself to the client');
  assert.strictEqual(typeof res.body.bestIsNow, 'boolean');
  assert.ok(res.body.hourly.length > 0);
});

test('a spent allowance strips every field that carries the best-time answer', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  meterUser();
  scriptMeter({ premium: false });

  // Burn the month's allowance. The venue and the hour are constant, so
  // requests 2..10 are cache hits — which must still be metered, or refreshing
  // the same card would be a free forecast forever.
  let open = null;
  for (let i = 1; i <= 10; i++) {
    const res = await call('GET', '/api/crowd/PW_METER?localHour=20&localDay=5');
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.forecastAccess.locked, false);
    assert.strictEqual(res.body.forecastAccess.remaining, 10 - i, `view ${i} did not consume the meter`);
    if (i === 1) open = res.body;
  }

  // The test only means something if the open response HAD the answer.
  assert.ok(open.bestTime, 'the unlocked card named no best time; this comparison proves nothing');
  assert.ok(open.hourly.length > 0);
  assert.strictEqual(typeof open.bestIsNow, 'boolean');

  const locked = (await call('GET', '/api/crowd/PW_METER?localHour=20&localDay=5')).body;
  assert.strictEqual(locked.forecastAccess.locked, true);
  assert.strictEqual(locked.forecastAccess.remaining, 0);

  for (const field of PREMIUM_FIELDS) {
    const v = locked[field];
    const emptied = v === null || (Array.isArray(v) && v.length === 0);
    assert.ok(emptied,
      `a locked forecast still ships \`${field}\` = ${JSON.stringify(v)} — frontend gating is cosmetic, so this is sold and given away`);
  }
  // ...and the free half is untouched. A paywall that also took the live score
  // would be selling the one thing this product promised to keep free.
  for (const field of FREE_FIELDS) {
    assert.ok(locked[field] !== undefined && locked[field] !== null, `the live half lost \`${field}\``);
  }
  assert.strictEqual(locked.score, open.score);
  assert.strictEqual(locked.label, open.label);
});

test('a Pro subscriber is never metered', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  meterUser();
  scriptMeter({ premium: true });

  for (let i = 0; i < 12; i++) {
    const res = await call('GET', '/api/crowd/PW_PRO?localHour=20&localDay=5');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.forecastAccess, { locked: false, remaining: null, limit: null });
    assert.ok(res.body.bestTime, 'a paying subscriber lost the forecast');
  }
});

test('list previews do not spend the single-venue allowance', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  meterUser();
  scriptMeter({ premium: false });
  NEARBY = [place('PW_NEIGHBOUR')];

  // The batch list and the alternatives strip both run the same predictor, but
  // neither is the detail view the meter is denominated in, and neither returns
  // a best time. Charging for them would burn a month's allowance scrolling a
  // vote list once.
  const batch = await call('POST', '/api/crowd/batch', {
    venues: [{ place_id: 'PW_BATCH', location: { latitude: 39.74, longitude: -104.98 } }],
    localHour: 20,
    localDay: 5,
  });
  assert.strictEqual(batch.status, 200, batch.text);
  const alts = await call('GET', '/api/crowd/PW_ALT/alternatives?localHour=20&localDay=5');
  assert.strictEqual(alts.status, 200, alts.text);

  const first = await call('GET', '/api/crowd/PW_FIRST?localHour=20&localDay=5');
  assert.strictEqual(first.body.forecastAccess.remaining, 9,
    'a preview consumed the forecast meter');
});

// ===========================================================================
// PART 4 — a place id is ONE path segment of the Google URL
//
// Express percent-decodes a path parameter before the route sees it, so
// `/api/crowd/x%2F..%2Fy` arrives as the string `x/../y`. Interpolated raw into
// `https://places.googleapis.com/v1/places/${placeId}`, the URL parser then
// normalises that into a different Google endpoint — called with our
// server-restricted API key attached — and a `?` or `#` in the id rewrites the
// query string and field mask the same way.
//
// These tests originally asserted the WEAK property: that a traversal id was
// encoded by the time it reached Google. Both routes now shape-check the id
// against utils/places.isPlaceIdShaped, so the strong property holds instead —
// a traversal never reaches Google at all, and never spends a paid call.
//
// Both halves are asserted here on purpose. The refusal is what actually
// protects today. The single-segment check is the reason it still holds if the
// shape rule is ever loosened, and it is the only thing standing between us and
// this bug returning: the shape rule is a separate file's decision, and a
// place id that satisfies it must STILL land as exactly one path segment.
// ===========================================================================

const placesPathOf = (url) => new URL(url).pathname;

// Shaped per utils/places.PLACE_ID_RE, so it gets through to Google.
const LEGIT_PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

// BOTH TESTS BELOW NEED A COLD PLACES CACHE, and since 2026-08-20 that cache is
// process-wide rather than per-route: services/placeDetailsCache.js owns one raw
// Place Details payload per place id and hands it to routes/crowd.js and
// routes/venueSearch.js alike, which is what collapsed the venue detail screen's
// two paid calls into one. The saving and this assertion pull in opposite
// directions on purpose — each test here asserts that the route DID reach
// Google, so that what it then checks about the URL is a real check — so each
// one starts from an empty cache instead of inheriting the previous test's
// entry for the same id.
const placeDetailsCache = require('../services/placeDetailsCache');

test('a place id cannot walk out of /v1/places/ on the crowd card', async () => {
  placeDetailsCache.__test.reset();
  scriptFeedback([]);
  // Encoded on the wire, decoded by Express into a traversal.
  const res = await call('GET', '/api/crowd/AAAAAA%2F..%2F..%2Fv1%3Aescape?localHour=20&localDay=5');
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(fetched.filter((u) => u.includes('/v1/places/')).length, 0,
    'a paid Google call was spent on an id that cannot be real');

  // And an id that IS shaped still becomes exactly one segment.
  fetched.length = 0;
  placeDetailsCache.__test.reset();
  scriptFeedback([]);
  const ok = await call('GET', `/api/crowd/${LEGIT_PLACE_ID}?localHour=20&localDay=5`);
  assert.ok(ok.status === 200 || ok.status === 502, ok.text);
  const details = fetched.filter((u) => u.includes('/v1/places/'));
  assert.ok(details.length > 0, 'the route never called Google, so this proves nothing');
  for (const u of details) {
    const segments = placesPathOf(u).split('/').filter(Boolean);
    // /v1/places/<id> and nothing more.
    assert.deepStrictEqual(segments.slice(0, 2), ['v1', 'places']);
    assert.strictEqual(segments.length, 3, `a place id became extra path segments: ${placesPathOf(u)}`);
  }
});

test('a place id cannot walk out of /v1/places/ on the alternatives list', async () => {
  placeDetailsCache.__test.reset();
  scriptFeedback([]);
  // Two `..` segments, so an unencoded id escapes /v1/places/ entirely. One is
  // not enough — it only pops the id itself and lands back inside the
  // collection, which is why the id is written this way.
  const res = await call('GET', '/api/crowd/BBBBBB%2F..%2F..%2Fv1%3Aescape/alternatives?localHour=20&localDay=5');
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(fetched.filter((x) => x.includes('/v1/places/')).length, 0,
    'a paid Google call was spent on an id that cannot be real');

  fetched.length = 0;
  placeDetailsCache.__test.reset();
  scriptFeedback([]);
  const ok = await call('GET', `/api/crowd/${LEGIT_PLACE_ID}/alternatives?localHour=20&localDay=5`);
  assert.ok(ok.status === 200 || ok.status === 502, ok.text);
  const details = fetched.filter((x) => x.includes('/v1/places/'));
  assert.ok(details.length > 0, 'the route never called Google, so this proves nothing');
  for (const u of details) {
    assert.strictEqual(placesPathOf(u).split('/').filter(Boolean).length, 3, u);
    assert.strictEqual(new URL(u).search, '', `a place id injected a query string: ${u}`);
  }
});

// ===========================================================================
// PART 5 — an upstream failure without Google's error envelope
//
// __tests__/calibrationQueries.test.js pins that `{ error: ... }` from Places
// is not published as "there is nobody around you tonight". That covers
// Google's own failures. It does not cover the two that arrive without that
// envelope — a gateway answering a non-2xx with some other body, or a body that
// is not JSON — and both left `places` undefined, which read as a successful
// search that found nothing and was then cached for an hour.
// ===========================================================================

function scriptStripCtx(placeId) {
  handlers = [
    [/FROM venue_profiles WHERE user_id/, () => ({ rows: [{ id: 5, google_place_id: placeId, verified: true }] })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
}

for (const [name, response] of [
  ['a non-2xx carrying no error envelope', { ok: false, status: 503, json: async () => ({}) }],
  ['a body that is not JSON at all', { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }],
]) {
  test(`${name} is not "the street is empty"`, async () => {
    SEARCH_RESPONSE = response;
    const placeId = `STRIP_${response.status}`;
    scriptStripCtx(placeId);

    const res = await call('GET', '/api/venue-dashboard/strip');
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.available, false, 'an outage was served as "no competitors nearby"');
    assert.ok(!('competitors' in res.body));

    // And it must not be remembered: the strip is cached for an hour, so a
    // cached failure freezes the false reading on the dashboard while the
    // owner's own dial keeps updating beside it.
    SEARCH_RESPONSE = null;
    NEARBY = [];
    scriptStripCtx(placeId);
    const retry = await call('GET', '/api/venue-dashboard/strip');
    assert.strictEqual(retry.body.available, true, 'the failure was cached; the retry never reached Google');
  });
}

test('a venue owner cannot point the dashboard at another Google endpoint', async () => {
  // google_place_id is whatever the owner typed into Edit Profile; nothing on
  // that write path constrains it to utils/places.isPlaceIdShaped.
  handlers = [
    [/FROM venue_profiles WHERE user_id/, () => ({ rows: [{ id: 5, google_place_id: 'CCCCCC/../../escape', verified: true }] })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
  const res = await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(res.status, 200, res.text);

  const details = fetched.filter((u) => u.includes('/v1/places/'));
  assert.ok(details.length > 0, 'the route never called Google, so this proves nothing');
  for (const u of details) {
    assert.strictEqual(placesPathOf(u).split('/').filter(Boolean).length, 3, u);
  }
});

// ===========================================================================
// PART 6 — a Google timeout is Google failing, and answers like it
//
// utils/upstream.js puts a deadline on every Places call, so an abort REJECTING
// the fetch is a designed outcome, not a freak one. Both crowd.js calls left
// that rejection to the route's outer catch, which answers 500 — while the
// status check one line later answers 502 for the identical condition. 500 says
// "this server is broken"; the client retry story and the on-call story are
// different for the two, and only one of them is true here.
// ===========================================================================

test('a timed-out Place Details is a 502, not "this server is broken"', async () => {
  scriptFeedback([]);
  FETCH_THROWS = 'details';
  const res = await call('GET', '/api/crowd/TIMEOUT_CARD?localHour=20&localDay=5');
  assert.strictEqual(res.status, 502, res.text);
});

test('a timed-out neighbour search is a 502, and never an empty alternatives list', async () => {
  scriptFeedback([]);
  FETCH_THROWS = 'search';
  const res = await call('GET', '/api/crowd/TIMEOUT_ALTS/alternatives?localHour=20&localDay=5');
  assert.strictEqual(res.status, 502, res.text);
  assert.strictEqual(res.body.unavailable, true);
  // An empty `alternatives` array is a claim about a real place ("we looked,
  // nothing near you is quieter"). A timeout is not that claim.
  assert.ok(!('alternatives' in res.body));
});

// ===========================================================================
// PART 7 — "we looked here and found nothing" is cached like any other answer
//
// The public demo's whole cost story is its cache (see the header of
// routes/publicCrowd.js: "area searches 20 min"). The empty-result branch was
// the one shape that skipped it — and with lat/lng rounded to ~1km buckets, an
// empty bucket is the cheapest thing in the world to ask for repeatedly.
// ===========================================================================

const publicCrowdRouter = require('../routes/publicCrowd');
app.use('/api/public', publicCrowdRouter);

test('an empty area search is not re-bought from Google on every request', async () => {
  // No places at all — a real, successful, zero-result search.
  SEARCH_RESPONSE = { ok: true, status: 200, json: async () => ({ places: [] }) };
  const first = await call('GET', '/api/public/demo/venues?lat=1.11&lng=2.22&localHour=20&localDay=5');
  assert.strictEqual(first.status, 200, first.text);
  assert.deepStrictEqual(first.body, { venues: [] });
  const afterFirst = fetched.length;
  assert.ok(afterFirst > 0, 'the first request never reached Google, so this proves nothing');

  const second = await call('GET', '/api/public/demo/venues?lat=1.11&lng=2.22&localHour=20&localDay=5');
  assert.deepStrictEqual(second.body, { venues: [] });
  assert.strictEqual(fetched.length, afterFirst,
    'an empty area was bought from Google a second time; the cache is the demo\'s only cost control');
});

test('an upstream failure is still never cached', async () => {
  // The distinction the branch above must not blur: a zero-result search is an
  // answer, an outage is not, and caching an outage would freeze "your city has
  // no spots" on the marketing page for 20 minutes.
  SEARCH_RESPONSE = { ok: false, status: 503, json: async () => ({}) };
  const down = await call('GET', '/api/public/demo/venues?lat=3.33&lng=4.44&localHour=20&localDay=5');
  assert.strictEqual(down.status, 503, down.text);

  SEARCH_RESPONSE = { ok: true, status: 200, json: async () => ({ places: [] }) };
  const retry = await call('GET', '/api/public/demo/venues?lat=3.33&lng=4.44&localHour=20&localDay=5');
  assert.strictEqual(retry.status, 200, 'the outage was cached');
});
