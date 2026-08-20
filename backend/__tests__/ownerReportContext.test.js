// Run: node --test  (from backend/)
//
// ===========================================================================
// OWNER-REPORT CONTEXT CAPTURE — the label's moment, recorded when it is
// cheap and true.
//
// The slider (POST /busy-now) writes the only live 0-100 training labels
// Flock has, and a label without its context is weak: at export time nothing
// about that moment's weather, nearby events, or what Flock itself was
// serving is reconstructable. services/ownerReportContext.js records all of
// it into venue_owner_report_context (migration 036) at insert time. This
// file pins the four rules that make that safe:
//
//   1. CAPTURE — a report insert produces one context row carrying weather,
//      events, the last SERVED prediction (read from served_predictions,
//      never recomputed), and the venue's own clock and category.
//   2. NULL DEGRADATION — a weather outage, a venue outside ml_venues, or a
//      missing serve record each store NULLs for their columns and nothing
//      else's; the row still lands.
//   3. NEVER BLOCKS, NEVER THROWS — the returned promise resolves even when
//      every database read rejects, and the route calls it un-awaited.
//   4. IDEMPOTENT — an existing context row short-circuits before any
//      upstream spend, and the INSERT itself is ON CONFLICT DO NOTHING.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'owner-report-context-test-secret';

const pool = require('../config/database');

// pg fake: scripted per test via `handlers`; every statement is logged.
let handlers = [];
let queryLog = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const ctxService = require('../services/ownerReportContext');

// 2026-08-19T21:30:00Z is a Wednesday, 17:30 in America/New_York (EDT).
const NOW = new Date('2026-08-19T21:30:00Z');

const VENUE_ROW = {
  latitude: 39.95,
  longitude: -75.16,
  timezone: 'America/New_York',
  venue_category: 'bar',
};

const SERVED_ROW = {
  id: 77,
  score: 62,
  prediction_method: 'ml_model',
  model_version: 'v2.5.0-STARLING',
  served_at: new Date('2026-08-19T21:05:00Z'),
};

const WEATHER = Object.freeze({
  temp: 71.2,
  feelsLike: 69.8,
  humidity: 55,
  windSpeed: 6.9,
  conditions: 'clear sky',
  conditionId: 800,
  isRaining: false,
  fetchedAt: NOW.getTime(),
});

const EVENTS = Object.freeze({
  hasEvent: true,
  totalEvents: 3,
  totalAttendance: 12000,
  nearestDistance: 1.4,
  nearestAttendance: 8000,
  nearestType: 'music',
  nearestName: 'Test Fest',
});

function scriptHappyPath({ venue = VENUE_ROW, served = SERVED_ROW, existing = false } = {}) {
  handlers = [
    [/SELECT 1 FROM venue_owner_report_context/, () => ({ rows: existing ? [{ '?column?': 1 }] : [] })],
    [/FROM ml_venues/, () => ({ rows: venue ? [venue] : [] })],
    [/FROM served_predictions/, () => ({ rows: served ? [served] : [] })],
    [/INSERT INTO venue_owner_report_context/, () => ({ rows: [], rowCount: 1 })],
  ];
  queryLog = [];
}

function insertCall() {
  return queryLog.find((q) => /INSERT INTO venue_owner_report_context/.test(q.sql)) || null;
}

// ── 1. CAPTURE ───────────────────────────────────────────────────────────────

test('a report insert captures weather, events, the served prediction and the venue clock', async () => {
  scriptHappyPath();
  const weatherCalls = [];
  const eventCalls = [];
  const out = await ctxService.captureOwnerReportContext(5, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async (lat, lon, opts) => { weatherCalls.push([lat, lon, opts]); return WEATHER; },
      getNearbyEvents: async (lat, lng, ts, userId) => { eventCalls.push([lat, lng, ts, userId]); return EVENTS; },
    },
  });
  assert.deepStrictEqual(out, { captured: true });

  // Upstreams were called with the venue's coordinates, and weather carries
  // the caller dimension (the owner's account) for the budget.
  assert.deepStrictEqual(weatherCalls, [[39.95, -75.16, { userId: 42 }]]);
  assert.strictEqual(eventCalls.length, 1);
  assert.strictEqual(eventCalls[0][3], 42);

  const ins = insertCall();
  assert.ok(ins, 'context row inserted');
  const p = ins.params;
  assert.strictEqual(p[0], 5, 'keyed to the report id');
  // weather
  assert.strictEqual(p[1], 71.2);
  assert.strictEqual(p[2], 69.8, 'feels_like captured');
  assert.strictEqual(p[3], 55);
  assert.strictEqual(p[4], 6.9);
  assert.strictEqual(p[5], 'clear sky');
  assert.strictEqual(p[6], 800);
  assert.strictEqual(p[7], false, 'is_raining captured');
  // events
  assert.strictEqual(p[8], true, 'has_nearby_event');
  assert.strictEqual(p[9], 3, 'nearby event count');
  assert.strictEqual(p[10], 12000);
  assert.strictEqual(p[11], 1.4, 'nearest event distance');
  assert.strictEqual(p[12], 8000);
  assert.strictEqual(p[13], 'music');
  // served prediction: READ from the log, id + score + method + version
  assert.strictEqual(p[14], 77);
  assert.strictEqual(p[15], 62);
  assert.strictEqual(p[16], 'ml_model');
  assert.strictEqual(p[17], 'v2.5.0-STARLING');
  assert.strictEqual(p[18], SERVED_ROW.served_at);
  // the venue's own clock: Wednesday 17:xx in America/New_York
  assert.strictEqual(p[19], 3, 'day_of_week in the venue timezone');
  assert.strictEqual(p[20], 17, 'hour in the venue timezone');
  assert.strictEqual(p[21], 'America/New_York');
  assert.strictEqual(p[22], 'bar', 'venue category');
});

test('a quiet night stores 0 events but no fabricated nearest-event fields', async () => {
  scriptHappyPath();
  await ctxService.captureOwnerReportContext(6, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => WEATHER,
      // getNearbyEvents' no-event shape fills 0s — 0 km away is not a fact.
      getNearbyEvents: async () => ({
        hasEvent: false, nearestAttendance: 0, totalEvents: 0,
        totalAttendance: 0, nearestType: null, nearestDistance: 0, nearestName: null,
      }),
    },
  });
  const p = insertCall().params;
  assert.strictEqual(p[8], false);
  assert.strictEqual(p[9], 0, 'zero events is a real observation');
  assert.strictEqual(p[11], null, 'no nearest distance without a nearest event');
  assert.strictEqual(p[12], null);
  assert.strictEqual(p[13], null);
});

// ── 2. NULL DEGRADATION ─────────────────────────────────────────────────────

test('a weather outage stores NULL weather columns and loses nothing else', async () => {
  scriptHappyPath();
  const out = await ctxService.captureOwnerReportContext(7, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => { throw new Error('OpenWeather down'); },
      getNearbyEvents: async () => EVENTS,
    },
  });
  assert.deepStrictEqual(out, { captured: true });
  const p = insertCall().params;
  for (let i = 1; i <= 7; i++) assert.strictEqual(p[i], null, `weather column $${i + 1} is NULL`);
  assert.strictEqual(p[9], 3, 'events survived the weather outage');
  assert.strictEqual(p[15], 62, 'served score survived the weather outage');
});

test('a venue outside ml_venues degrades geo columns to NULL but keeps the serve record', async () => {
  scriptHappyPath({ venue: null });
  let weatherCalled = false;
  const out = await ctxService.captureOwnerReportContext(8, {
    placeId: 'ChIJnotincorpus0000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => { weatherCalled = true; return WEATHER; },
      getNearbyEvents: async () => EVENTS,
    },
  });
  assert.deepStrictEqual(out, { captured: true });
  assert.strictEqual(weatherCalled, false, 'no coordinates, no weather spend');
  const p = insertCall().params;
  assert.strictEqual(p[1], null);
  assert.strictEqual(p[19], null, 'no timezone, no local clock');
  assert.strictEqual(p[22], null, 'no category');
  assert.strictEqual(p[15], 62, 'the served prediction is keyed on place id and still lands');
});

test('null returns (weather budget refused, no event lookup available) are NULLs, not crashes', async () => {
  scriptHappyPath();
  const out = await ctxService.captureOwnerReportContext(9, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: { getWeather: async () => null, getNearbyEvents: null },
  });
  assert.deepStrictEqual(out, { captured: true });
  const p = insertCall().params;
  assert.strictEqual(p[1], null);
  assert.strictEqual(p[8], null, 'no event lookup means unknown, never false');
  assert.strictEqual(p[9], null);
});

// ── 3. NEVER BLOCKS, NEVER THROWS ───────────────────────────────────────────

test('the capture resolves even when every database read rejects', async () => {
  handlers = [[/./, () => new Error('database on fire')]];
  queryLog = [];
  const out = await ctxService.captureOwnerReportContext(10, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: { getWeather: async () => WEATHER, getNearbyEvents: async () => EVENTS },
  });
  assert.deepStrictEqual(out, { captured: false, reason: 'error' });
});

test('bad arguments are refused quietly, without a round trip', async () => {
  handlers = [];
  queryLog = [];
  assert.deepStrictEqual(
    await ctxService.captureOwnerReportContext(undefined, { placeId: 'x' }),
    { captured: false, reason: 'bad_args' });
  assert.deepStrictEqual(
    await ctxService.captureOwnerReportContext(1, { placeId: '' }),
    { captured: false, reason: 'bad_args' });
  assert.strictEqual(queryLog.length, 0);
});

test('the route fires the capture without awaiting it, off the POST critical path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  assert.ok(/INSERT INTO venue_owner_reports[\s\S]{0,200}?RETURNING id/.test(src),
    'the insert must return the id the capture is keyed to');
  assert.ok(/captureOwnerReportContext\(/.test(src), 'the POST handler must fire the capture');
  assert.ok(!/await\s+ownerReportContext\s*$/m.test(src)
    && !/await\s+ownerReportContext\.captureOwnerReportContext/.test(src),
    'the capture must never sit on the response path');
});

// ── 4. IDEMPOTENT ───────────────────────────────────────────────────────────

test('an existing context row short-circuits before any upstream spend', async () => {
  scriptHappyPath({ existing: true });
  let spent = false;
  const out = await ctxService.captureOwnerReportContext(5, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => { spent = true; return WEATHER; },
      getNearbyEvents: async () => { spent = true; return EVENTS; },
    },
  });
  assert.deepStrictEqual(out, { captured: false, reason: 'already_captured' });
  assert.strictEqual(spent, false, 're-capture must not touch the weather or event budgets');
  assert.strictEqual(insertCall(), null, 'no duplicate row');
});

test('two racing captures still write one row — the INSERT is ON CONFLICT DO NOTHING', () => {
  assert.ok(/ON CONFLICT \(report_id\) DO NOTHING/.test(ctxService.INSERT_CONTEXT_SQL),
    'the primary key, not luck, is what makes the race safe');
});

// ── The schema and the training join ────────────────────────────────────────

test('migration 036 keys the context to the report and prunes with it', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '036_venue_owner_report_context.sql'), 'utf8');
  assert.ok(/CREATE TABLE IF NOT EXISTS venue_owner_report_context/.test(sql));
  assert.ok(/report_id INTEGER PRIMARY KEY REFERENCES venue_owner_reports\(id\) ON DELETE CASCADE/.test(sql),
    'one context row per report, gone when the report goes');
  assert.ok(/idx_served_predictions_venue_at/.test(sql),
    'the by-venue serve read needs its own index — 032 leads on user_id');
});

test('the label exporter joins the context so every column it once shipped NULL can fill', () => {
  const ownerExport = require('../scripts/ml/train/ownerLabelExport');
  const { text } = ownerExport.ownerCandidateQuery('philadelphia', 'SELECT 1 AS baseline');
  assert.ok(/LEFT JOIN venue_owner_report_context c ON c\.report_id = r\.id/.test(text),
    'LEFT JOIN: pre-036 readings still export, with empty context');

  // With a context row, the training row carries the captured moment.
  const base = {
    report_id: 1, busy_percent: 50, created_at: NOW, day_of_week: 3, hour: 17,
    venue_id: 12, city: 'philadelphia', google_place_id: 'ChIJx', google_types: ['bar'],
    latitude: 39.95, longitude: -75.16, venue_category: 'bar', price_level: 2,
    rating: 4.4, review_count: 812, baseline_busyness: 40,
    ctx_temperature: '71.2', ctx_humidity: 55, ctx_wind_speed: '6.9',
    ctx_weather_condition: 'clear sky', ctx_weather_condition_code: 800,
    ctx_is_raining: false, ctx_has_nearby_event: true, ctx_total_nearby_events: 3,
    ctx_total_nearby_attendance: 12000, ctx_nearest_event_distance_km: '1.40',
    ctx_nearest_event_attendance: 8000, ctx_nearest_event_type: 'music',
  };
  const dates = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];
  const rows = dates.map((d, i) => ({ ...base, report_id: i + 1, local_date: d, hour: 17 + i }));
  const [group] = ownerExport.groupOwnerVenues(rows);
  const out = ownerExport.ownerVenueToTrainingRows(group);
  assert.strictEqual(out.rows.length, 5);
  const row = out.rows[0];
  assert.strictEqual(row.temperature, 71.2, 'pg NUMERIC strings become numbers');
  assert.strictEqual(row.humidity, 55);
  assert.strictEqual(row.wind_speed, 6.9);
  assert.strictEqual(row.weather_condition, 'clear sky');
  assert.strictEqual(row.weather_condition_code, 800);
  assert.strictEqual(row.is_raining, false);
  assert.strictEqual(row.has_nearby_event, true);
  assert.strictEqual(row.event_nearby, true);
  assert.strictEqual(row.total_nearby_events, 3);
  assert.strictEqual(row.total_nearby_attendance, 12000);
  assert.strictEqual(row.nearest_event_distance_km, 1.4);
  assert.strictEqual(row.nearest_event_attendance, 8000);
  assert.strictEqual(row.nearest_event_type, 'music');

  // Without a context row (pre-036 reading), the columns stay empty, never 0.
  const bare = dates.map((d, i) => {
    const r = { ...base, report_id: i + 10, local_date: d, hour: 17 + i };
    for (const k of Object.keys(r)) if (k.startsWith('ctx_')) delete r[k];
    return r;
  });
  const [bareGroup] = ownerExport.groupOwnerVenues(bare);
  const bareRow = ownerExport.ownerVenueToTrainingRows(bareGroup).rows[0];
  assert.strictEqual(bareRow.temperature, null);
  assert.strictEqual(bareRow.weather_condition, null);
  assert.strictEqual(bareRow.total_nearby_events, null);
  assert.strictEqual(bareRow.is_raining, false, 'unchanged pre-context behavior');
  assert.strictEqual(bareRow.has_nearby_event, false, 'unchanged pre-context behavior');
});
