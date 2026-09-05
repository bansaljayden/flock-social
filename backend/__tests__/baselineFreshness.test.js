// Run: node --test  (from backend/)
//
// ===========================================================================
// HOW OLD IS THE NUMBER UNDER THE SCORE.
//
// The served model is `label_type: 'delta'` — score = baseline + clamp(delta,
// ±30) — so ml_venue_baselines IS most of the answer. Two things were missing
// and this file pins both:
//
//   1. NOTHING COULD EVER REFRESH A ROW. storeGoogleBaselines wrote
//      `ON CONFLICT ... DO NOTHING`, so the first request that ever touched a
//      venue with no collected baseline fixed that venue's numbers
//      permanently. `DO NOTHING` was the right instinct aimed at the wrong
//      clause: what must not be overwritten is a COLLECTED row (measured data
//      on the corrected clock axis, and the anchor the delta label was computed
//      against), not a google row from an arbitrarily long time ago.
//
//   2. NO READ PATH LOOKED AT THE AGE. Checked read-only against production
//      2026-08-18: all 3,454,955 baseline rows are source='collected' across
//      20,569 venues, and there is not one source='google' row. A card built in
//      December and a card built in April were indistinguishable to every
//      client. (This note used to open "realtime collection stopped
//      2026-05-18". It restarted: the 403s were BestTime's abuse guard on a
//      600/min pace against a 300/min limit, and since the pacing fix the
//      Railway BESTTIME service has collected on a cron.)
//
// WHAT `updated_at` MEANS, and why the payload says so rather than implying
// otherwise: it is when the ROW was written, not when the venue was observed.
// Every collected row in production carries 2026-08-15, the date migration
// 023 rebuilt the table. So it is an UPPER BOUND on freshness — the data can
// only be older than the row holding it, never fresher — and `basis:
// 'baseline_row_written'` is how the payload admits that.
//
// STALENESS IS A LABEL, NOT A GATE. A stale baseline is still the best number
// the venue has; refusing to serve it would drop the venue to the rule engine,
// which is worse. So the assertions below check that an ancient row is served
// AND marked, never that it is withheld.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'baseline-freshness-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

const DAY = 24 * 60 * 60 * 1000;

const pool = require('../config/database');

let BASELINE_ROWS = [];
let writes = [];

pool.query = (sql, params = []) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/INSERT INTO ml_venue_baselines/.test(flat)) {
    writes.push({ sql: flat, params });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/FROM ml_venue_baselines/.test(flat)) {
    return Promise.resolve({ rows: BASELINE_ROWS, rowCount: BASELINE_ROWS.length });
  }
  if (/FROM venue_feedback/.test(flat)) return Promise.resolve({ rows: [{}] });
  if (/is_premium/.test(flat)) return Promise.resolve({ rows: [{ is_premium: false }] });
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const mlPredictor = require('../services/mlPredictor');
const {
  getBaseline, baselineProvenanceFor, baselineMeta,
  BASELINE_STALE_AFTER_MS, GOOGLE_BASELINE_REFRESH_DAYS,
  __resetVenueLookupCaches,
  baselineMissFor, allowVenueLookup, VENUE_LOOKUP_USER_HOURLY,
} = mlPredictor._internals;

const PLACE = 'ChIJ_baseline_freshness_001';
const DOW = 3;
const HOUR = 20;

test.beforeEach(() => {
  BASELINE_ROWS = [];
  writes = [];
  __resetVenueLookupCaches();
});

// ── 1. A row can be refreshed, and only the right kind ─────────────────────

test('storeGoogleBaselines can write over a row it already wrote', async () => {
  await mlPredictor.storeGoogleBaselines(PLACE, [{ day: 1, data: [10, 20, 30] }]);
  assert.ok(writes.length > 0, 'nothing was written at all');
  const sql = writes[0].sql;
  assert.ok(!/DO NOTHING/.test(sql),
    'the baseline upsert is still DO NOTHING, so a row written once is frozen forever');
  assert.ok(/ON CONFLICT \(google_place_id, day_of_week, hour\) DO UPDATE/.test(sql),
    `the upsert does not update on conflict: ${sql.slice(0, 200)}`);
  assert.ok(/SET baseline = EXCLUDED\.baseline/.test(sql));
  assert.ok(/updated_at = NOW\(\)/.test(sql),
    'a refreshed row does not restamp updated_at, so the age it publishes would be a lie');
});

test('a COLLECTED row is never overwritten by a Google payload', async () => {
  await mlPredictor.storeGoogleBaselines(PLACE, [{ day: 1, data: [10] }]);
  const sql = writes[0].sql;
  assert.ok(/WHERE ml_venue_baselines\.source = 'google'/.test(sql),
    'the conditional update is not restricted to google rows — a measured, ' +
    'axis-corrected baseline could be replaced by Google popular_times, moving ' +
    'the anchor out from under the trained delta weights');
});

test('a Google row younger than the refresh horizon is left alone', async () => {
  await mlPredictor.storeGoogleBaselines(PLACE, [{ day: 1, data: [10] }]);
  const { sql, params } = writes[0];
  assert.ok(/COALESCE\(ml_venue_baselines\.updated_at, 'epoch'::timestamptz\)\s*< NOW\(\) - make_interval\(days => \$5::int\)/.test(sql),
    `the update has no age guard, so every request rewrites 168 rows: ${sql.slice(0, 220)}`);
  assert.strictEqual(params[4], GOOGLE_BASELINE_REFRESH_DAYS,
    'the refresh horizon is not the constant the comment argues for');
});

test('a row with no timestamp is refreshed, not frozen', async () => {
  // updated_at is nullable. If NULL made the age predicate NULL the row would
  // never be rewritten — the write-once bug again, in the one corner where
  // nothing would surface it. COALESCE to the epoch reads unknown as ancient.
  await mlPredictor.storeGoogleBaselines(PLACE, [{ day: 1, data: [10] }]);
  assert.ok(/COALESCE\(ml_venue_baselines\.updated_at, 'epoch'::timestamptz\)/.test(writes[0].sql),
    'a google row with a NULL updated_at can never be refreshed');
});

test('the refresh horizon sits inside the staleness threshold', () => {
  // The inequality the comments claim: a venue looked at even once a month can
  // never go stale by neglect. If these ever cross, a row could be published as
  // stale that the refresh path had already decided was too fresh to rewrite.
  assert.ok(GOOGLE_BASELINE_REFRESH_DAYS * DAY < BASELINE_STALE_AFTER_MS,
    `refresh horizon ${GOOGLE_BASELINE_REFRESH_DAYS}d is not shorter than the ` +
    `${BASELINE_STALE_AFTER_MS / DAY}d staleness threshold`);
});

test('the horizon is bound, not interpolated into the SQL', async () => {
  await mlPredictor.storeGoogleBaselines(PLACE, [{ day: 1, data: [10] }]);
  assert.ok(!new RegExp(`INTERVAL '${GOOGLE_BASELINE_REFRESH_DAYS}`).test(writes[0].sql),
    'the interval was concatenated into the statement instead of bound');
});

// ── 2. The age is knowable on the read path ────────────────────────────────

function row(source, updatedAt, baseline = 60) {
  return { day_of_week: DOW, hour: HOUR, baseline, source, updated_at: updatedAt };
}

test('a baseline read carries the provenance of the row it was anchored on', async () => {
  const written = new Date(Date.now() - 200 * DAY);
  BASELINE_ROWS = [row('collected', written)];

  const value = await getBaseline(PLACE, DOW, HOUR, 1);
  assert.strictEqual(value, 60, 'the value itself changed');

  const p = baselineProvenanceFor(PLACE, DOW, HOUR);
  assert.ok(p, 'the baseline read published no age at all');
  assert.strictEqual(p.source, 'collected');
  assert.strictEqual(p.asOf, written.getTime());
  assert.strictEqual(p.basis, 'baseline_row_written',
    'the payload implies the timestamp is an observation date; it is a write date');
  assert.strictEqual(p.stale, true);
  assert.strictEqual(p.staleAfterMs, BASELINE_STALE_AFTER_MS);
});

test('a stale baseline is still SERVED — the threshold labels, it does not gate', async () => {
  BASELINE_ROWS = [row('collected', new Date(Date.now() - 400 * DAY), 71)];
  assert.strictEqual(await getBaseline(PLACE, DOW, HOUR, 1), 71,
    'a stale baseline was withheld, dropping the venue to the rule engine');
  assert.strictEqual(baselineProvenanceFor(PLACE, DOW, HOUR).stale, true);
});

test('a fresh row is not marked stale', async () => {
  BASELINE_ROWS = [row('google', new Date(Date.now() - 10 * DAY))];
  await getBaseline(PLACE, DOW, HOUR, 1);
  const p = baselineProvenanceFor(PLACE, DOW, HOUR);
  assert.strictEqual(p.stale, false);
  assert.strictEqual(p.source, 'google');
});

test('the threshold is one quarter, the interval over which a weekly pattern really moves', () => {
  assert.strictEqual(BASELINE_STALE_AFTER_MS, 90 * DAY);
  assert.strictEqual(baselineMeta('collected', new Date(Date.now() - 89 * DAY)).stale, false);
  assert.strictEqual(baselineMeta('collected', new Date(Date.now() - 91 * DAY)).stale, true);
});

test('a venue with no baseline row says nothing rather than guessing an age', async () => {
  BASELINE_ROWS = [];
  assert.strictEqual(await getBaseline(PLACE, DOW, HOUR, 1), 0);
  assert.strictEqual(baselineProvenanceFor(PLACE, DOW, HOUR), null);
});

test('an unreadable updated_at is a null age, not an Invalid Date on the card', () => {
  const p = baselineMeta('collected', 'not a date');
  assert.strictEqual(p.asOf, null);
  assert.strictEqual(p.stale, null);
});

// ── 3. The age reaches the client ──────────────────────────────────────────
//
// The card is shared cache (routes/crowd.js setCache), so the ABSOLUTE `asOf`
// is what gets cached and `ageMs` is derived per response — the same split
// routes/publicCrowd.js already makes between `as_of` and `age_ms`. A duration
// written into the cached object would be wrong by the age of the cache entry.

const crowdEngine = require('../services/crowdEngine');

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 900001, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, conditions: 'Clear' });
weatherService.getForecast = async () => [];

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
placesBudget.allowGlobalPlacesCall = () => true;

const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://places.googleapis.com/')) return realFetch(url, opts);
  const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0] || 'PLACE_X';
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      id,
      displayName: { text: id },
      formattedAddress: '1 Main St',
      rating: 4.2,
      userRatingCount: 300,
      types: ['bar'],
      location: { latitude: 39.74, longitude: -104.98 },
      currentOpeningHours: { openNow: true, periods: [] },
      utcOffsetMinutes: null,
    }),
  });
};
test.after(() => { global.fetch = realFetch; });

const BASELINE_WRITTEN = Date.now() - 150 * DAY;
// ── 3. WHICH zero, when getBaseline returns zero ───────────────────────────
//
// getBaseline answers 0 for three unrelated reasons and predictBusyness used to
// report all three to the coverage counter as `rule_engine_no_baseline`. That
// tag is a claim about the CORPUS and it is the dominant entry on the admin
// Revenue panel, so a database wobble or a rate-limited account read there as
// "the collector has not reached these venues yet" — the one number built to
// decide whether to go collect more, answering wrongly precisely when the real
// problem was that we could not ask.

test('no row for the slot is the corpus gap, and says so', async () => {
  BASELINE_ROWS = [];
  assert.strictEqual(await getBaseline(PLACE, DOW, HOUR), 0);
  assert.strictEqual(baselineMissFor(PLACE, DOW, HOUR), 'none');
});

test('a baseline lookup that throws is not reported as a missing venue', async () => {
  const real = pool.query;
  pool.query = (sql, params) => (/FROM ml_venue_baselines/.test(String(sql))
    ? Promise.reject(new Error('connection terminated'))
    : real(sql, params));
  try {
    assert.strictEqual(await getBaseline(PLACE, DOW, HOUR), 0);
    assert.strictEqual(baselineMissFor(PLACE, DOW, HOUR), 'error',
      'a failed query is indistinguishable from a venue nobody has collected');
  } finally {
    pool.query = real;
  }
});

test('a caller over the lookup budget is "we could not ask", not "no such row"', async () => {
  const userId = 909;
  for (let i = 0; i < VENUE_LOOKUP_USER_HOURLY; i++) allowVenueLookup(PLACE, userId);
  assert.strictEqual(allowVenueLookup(PLACE, userId), false, 'the budget never ran out');

  BASELINE_ROWS = [{ day_of_week: DOW, hour: HOUR, baseline: 70, source: 'collected', updated_at: new Date() }];
  assert.strictEqual(await getBaseline(PLACE, DOW, HOUR, userId), 0);
  assert.strictEqual(baselineMissFor(PLACE, DOW, HOUR), 'refused');
});

test('a venue with no usable place id stays the corpus gap, not an outage', async () => {
  // allowVenueLookup refuses for two unrelated reasons behind one boolean. An
  // id that is not shaped like a place id is a standing property of the venue —
  // there is no row and there never will be — which is what `no_baseline`
  // already means. Only the budget refusal is momentary.
  // Too short for PLACE_ID_RE ({6,128}); note that a hyphenated word IS shaped,
  // so this has to be a length failure rather than a punctuation one.
  const junk = 'ab';
  assert.strictEqual(allowVenueLookup(junk, null), false, 'fixture precondition');
  assert.strictEqual(await getBaseline(junk, DOW, HOUR), 0);
  assert.strictEqual(baselineMissFor(junk, DOW, HOUR), 'none');
});

test('each caller learns the reason for its own zero, not the slot\'s last one', async () => {
  // Two requests for one slot in flight together: one over its lookup budget,
  // one allowed and finding no row. The shared map could only hold one
  // reason, so the refused caller read the other's 'none' and reported a
  // budget refusal as a corpus gap (adversarial audit round 2, 2026-09-05).
  // The reason now travels with the call.
  __resetVenueLookupCaches();
  const slot = `${PLACE}race`;
  const userId = 911;
  for (let i = 0; i < VENUE_LOOKUP_USER_HOURLY; i++) allowVenueLookup(slot, userId);
  assert.strictEqual(allowVenueLookup(slot, userId), false, 'fixture precondition');
  BASELINE_ROWS = [];
  const refused = {};
  const none = {};
  await Promise.all([
    getBaseline(slot, DOW, HOUR, userId, refused),
    getBaseline(slot, DOW, HOUR, undefined, none),
  ]);
  assert.strictEqual(refused.reason, 'refused');
  assert.strictEqual(none.reason, 'none');

  // And a thrown query is 'error' for the caller that threw.
  const real = pool.query;
  pool.query = (sql, params) => (/FROM ml_venue_baselines/.test(String(sql))
    ? Promise.reject(new Error('down'))
    : real(sql, params));
  try {
    __resetVenueLookupCaches();
    const errored = {};
    assert.strictEqual(await getBaseline(`${PLACE}err`, DOW, HOUR, undefined, errored), 0);
    assert.strictEqual(errored.reason, 'error');
  } finally {
    pool.query = real;
  }
  // A usable number writes null, so a caller can tell "answered" from "cached".
  __resetVenueLookupCaches();
  BASELINE_ROWS = [{ day_of_week: DOW, hour: HOUR, baseline: 64, source: 'collected', updated_at: new Date() }];
  const answered = {};
  assert.ok(await getBaseline(`${PLACE}ok`, DOW, HOUR, undefined, answered) > 0);
  assert.strictEqual(answered.reason, null);
});

test('a slot that answers clears a reason an earlier failure left behind', async () => {
  const real = pool.query;
  pool.query = (sql, params) => (/FROM ml_venue_baselines/.test(String(sql))
    ? Promise.reject(new Error('down'))
    : real(sql, params));
  try {
    await getBaseline(PLACE, DOW, HOUR);
    assert.strictEqual(baselineMissFor(PLACE, DOW, HOUR), 'error');
  } finally {
    pool.query = real;
  }
  // The outage ends; the cached zero must not keep the venue labelled.
  __resetVenueLookupCaches();
  BASELINE_ROWS = [{ day_of_week: DOW, hour: HOUR, baseline: 64, source: 'collected', updated_at: new Date() }];
  assert.ok(await getBaseline(PLACE, DOW, HOUR) > 0);
  assert.strictEqual(baselineMissFor(PLACE, DOW, HOUR), null,
    'a resolved outage kept labelling a venue that has since been scored');
});

mlPredictor.predictBusyness = async () => ({
  score: 55,
  label: crowdEngine.getLabel(55),
  confidence: 33,
  factors: {},
  dataSourcesUsed: ['ml_model'],
  predictionMethod: 'ml',
  modelVersion: '2.6.0-starling',
  baselineData: {
    source: 'collected',
    asOf: BASELINE_WRITTEN,
    basis: 'baseline_row_written',
    stale: true,
    staleAfterMs: BASELINE_STALE_AFTER_MS,
  },
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) => (
  Array.from({ length: count || 12 }, (_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return { hour: `${h12} ${h < 12 ? 'AM' : 'PM'}`, score: 50 + i, label: 'Moderate' };
  })
);

const crowdRouter = require('../routes/crowd');
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

let nextUser = 900001;
async function card(placeId) {
  CURRENT_USER = { id: ++nextUser, name: 'Ava', role: 'user' };
  const res = await realFetch(`${base}/api/crowd/${placeId}?localHour=20&localDay=3`);
  return { status: res.status, body: await res.json() };
}

test('the venue card publishes how old its baseline is', async () => {
  const res = await card('ChIJ_card_freshness_0001');
  assert.strictEqual(res.status, 200);
  const d = res.body.baselineData;
  assert.ok(d, 'the card carries no data-age field, so March numbers read as December numbers');
  assert.strictEqual(d.asOf, BASELINE_WRITTEN);
  assert.strictEqual(d.basis, 'baseline_row_written');
  assert.strictEqual(d.stale, true);
  assert.ok(d.ageMs >= 150 * DAY, `ageMs was ${d.ageMs}`);
});

test('the list under the card publishes the same age the card does', async () => {
  // routes/crowd.js keeps the batch rows and the card in step on the label, the
  // clock and the confidence block, for the stated reason that a row that
  // disagrees with the card one tap away is the bug three rounds were spent
  // closing. An undated row under a card marked four months old is that same
  // disagreement, one field over.
  CURRENT_USER = { id: ++nextUser, name: 'Ava', role: 'user' };
  const res = await realFetch(`${base}/api/crowd/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ venues: [{ place_id: 'ChIJ_batch_freshness_1', name: 'A Bar' }], localHour: 20, localDay: 3 }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const d = body.predictions[0].baselineData;
  assert.ok(d, 'a batch row carries no data-age field while the card it sits under does');
  assert.strictEqual(d.asOf, BASELINE_WRITTEN);
  assert.strictEqual(d.stale, true);
  assert.ok(d.ageMs >= 150 * DAY, `ageMs was ${d.ageMs}`);
});

test('the age is stamped per response, never baked into the shared cache', async () => {
  const placeId = 'ChIJ_card_freshness_0002';
  const first = await card(placeId);
  await new Promise((r) => setTimeout(r, 12));
  const second = await card(placeId);
  assert.strictEqual(second.body.baselineData.asOf, first.body.baselineData.asOf,
    'the absolute stamp moved between two reads of the same cached card');
  assert.ok(second.body.baselineData.ageMs > first.body.baselineData.ageMs,
    'a cached card served a frozen age, so a card can report itself younger than it is');
});
