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
//   5. THE SERVE IT RECORDS IS ONE THE SERVER CHOSE (migration 038). "What
//      Flock was publishing" is written into a TRAINING corpus here, and the
//      newest served_predictions row is not necessarily the server's own
//      arithmetic: POST /api/crowd/batch scores a client-assembled body and
//      records the result like any other serve. Only 'detail' serves, at the
//      matching venue-local hour, may fill these columns.
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

// The serve this capture SHOULD find: the detail card, scored on the venue's
// own clock, for the hour the owner is reporting on (Wednesday 17:00 in
// America/New_York, which is what NOW resolves to there).
const SERVED_ROW = {
  id: 77,
  score: 62,
  prediction_method: 'ml_model',
  model_version: 'v2.5.0-STARLING',
  served_at: new Date('2026-08-19T21:05:00Z'),
  source: 'detail',
  local_day: 3,
  local_hour: 17,
};

// A serve log the fake filters the way Postgres would. The module's WHERE
// clause is what is under test in section 5, so a handler that returns
// whatever it is holding regardless of the parameters would pass whether the
// clause were there or not.
function serveLogHandler(rows) {
  return [/FROM served_predictions/, (params) => {
    const [, day, hour] = params;
    const qualifying = rows.filter((r) => (
      // `source = 'detail'` is an allowlist: a NULL source drops out here for
      // the same reason `NULL = 'detail'` is NULL rather than true in SQL.
      r.source === 'detail' && r.local_day === day && r.local_hour === hour
    ));
    return { rows: qualifying.length ? [qualifying[0]] : [] };
  }];
}

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
  observed: true,
  unavailableReason: null,
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
    serveLogHandler(served ? [served] : []),
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
  // the event lookup happened, and the row says so (migration 044)
  assert.strictEqual(p[23], true, 'events_observed');
  assert.strictEqual(p[24], null, 'no unavailable reason on an observed lookup');
});

test('a quiet night stores 0 events but no fabricated nearest-event fields', async () => {
  scriptHappyPath();
  await ctxService.captureOwnerReportContext(6, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => WEATHER,
      // getNearbyEvents' no-event shape fills 0s. 0 km away is not a fact.
      getNearbyEvents: async () => ({
        observed: true, unavailableReason: null,
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
  assert.strictEqual(p[23], true, 'Ticketmaster answered, so this false is a measurement');
  assert.strictEqual(p[24], null);
});

// ── 2. NULL DEGRADATION ─────────────────────────────────────────────────────

// A LOOKUP THAT FAILED IS NOT A QUIET NIGHT (migration 044). Until this was
// fixed the failure shapes below all wrote has_nearby_event = false and
// total_nearby_events = 0 into a training corpus, so every Ticketmaster
// outage recorded "there were no events near this venue" for its duration.

test('a refused or broken event lookup stores NULL event columns and the reason', async () => {
  const shapeFor = (reason) => ({
    observed: false, unavailableReason: reason, hasEvent: false, totalEvents: 0,
    totalAttendance: 0, nearestDistance: 0, nearestAttendance: 0, nearestType: null,
  });
  let id = 100;
  for (const reason of ['budget_exhausted', 'provider_error', 'timeout', 'no_api_key']) {
    scriptHappyPath();
    await ctxService.captureOwnerReportContext(id++, {
      placeId: 'ChIJtestplace000000000000000',
      userId: 42,
      now: NOW,
      deps: { getWeather: async () => WEATHER, getNearbyEvents: async () => shapeFor(reason) },
    });
    const p = insertCall().params;
    for (const i of [8, 9, 10, 11, 12, 13]) {
      assert.strictEqual(p[i], null,
        reason + ': event column ' + (i + 1) + ' must be NULL, never a false or a 0');
    }
    assert.strictEqual(p[23], false, reason + ': events_observed is false, not null');
    assert.strictEqual(p[24], reason, reason + ': the reason is kept');
    // Everything else still lands. A refused event call is not a lost capture.
    assert.strictEqual(p[1], 71.2, reason + ': weather survived');
    assert.strictEqual(p[15], 62, reason + ': the served score survived');
  }
});

// The zeros in an unobserved shape are placeholders. A caller that carried
// stale numbers next to observed:false must not have them read as a reading.
test('an unobserved shape carrying numbers still stores NULLs', async () => {
  scriptHappyPath();
  await ctxService.captureOwnerReportContext(110, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => WEATHER,
      getNearbyEvents: async () => ({
        observed: false, unavailableReason: 'provider_error',
        hasEvent: true, totalEvents: 9, totalAttendance: 40000,
        nearestDistance: 0.4, nearestAttendance: 30000, nearestType: 'sports',
      }),
    },
  });
  const p = insertCall().params;
  for (const i of [8, 9, 10, 11, 12, 13]) assert.strictEqual(p[i], null, 'column ' + (i + 1));
  assert.strictEqual(p[23], false);
  assert.strictEqual(p[24], 'provider_error');
});

// Fail closed on a shape that cannot say. The flag is cheap to add, so its
// absence means the caller predates the contract, and a caller that predates
// the contract is exactly the one whose zeros cannot be trusted.
test('an event shape with no observed flag is treated as unobserved', async () => {
  scriptHappyPath();
  await ctxService.captureOwnerReportContext(111, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => WEATHER,
      getNearbyEvents: async () => ({
        hasEvent: false, totalEvents: 0, totalAttendance: 0,
        nearestDistance: 0, nearestAttendance: 0, nearestType: null,
      }),
    },
  });
  const p = insertCall().params;
  assert.strictEqual(p[8], null, 'no flag, no observation');
  assert.strictEqual(p[9], null);
  assert.strictEqual(p[23], false);
  assert.strictEqual(p[24], 'unknown_provenance');
});

// A throw is a FAILED lookup, not an unattempted one, and the two are
// different rows in an audit.
test('an event lookup that throws is recorded as a failure, not as never attempted', async () => {
  scriptHappyPath();
  const out = await ctxService.captureOwnerReportContext(112, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => WEATHER,
      getNearbyEvents: async () => { throw new Error('Ticketmaster down'); },
    },
  });
  assert.deepStrictEqual(out, { captured: true });
  const p = insertCall().params;
  assert.strictEqual(p[8], null);
  assert.strictEqual(p[23], false);
  assert.strictEqual(p[24], 'lookup_threw');
});

// No coordinates means no call was made and none could have been. That is a
// third state, and it is NULL rather than false.
test('a venue with no coordinates records events_observed NULL, not false', async () => {
  scriptHappyPath({ venue: null });
  let called = false;
  await ctxService.captureOwnerReportContext(113, {
    placeId: 'ChIJtestplace000000000000000',
    userId: 42,
    now: NOW,
    deps: {
      getWeather: async () => { called = true; return WEATHER; },
      getNearbyEvents: async () => { called = true; return EVENTS; },
    },
  });
  assert.strictEqual(called, false, 'no coordinates, no upstream spend');
  const p = insertCall().params;
  assert.strictEqual(p[8], null);
  assert.strictEqual(p[23], null, 'nobody looked, and nobody could have');
  assert.strictEqual(p[24], null);
});

test('the INSERT names as many columns as it binds placeholders', () => {
  const sql = ctxService.INSERT_CONTEXT_SQL;
  const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(') VALUES')).split(',').length;
  const highest = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.strictEqual(cols, highest,
    'a column list and a placeholder list that disagree is a runtime syntax error');
});

test('migration 044 records whether the event lookup happened, with no default', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '044_owner_report_event_provenance.sql'), 'utf8');
  assert.ok(/ADD COLUMN IF NOT EXISTS events_observed BOOLEAN/.test(sql));
  assert.ok(/ADD COLUMN IF NOT EXISTS events_unavailable_reason TEXT/.test(sql));
  assert.ok(!/events_observed BOOLEAN\s+DEFAULT/.test(sql),
    'a default of false would claim knowledge about rows written before anyone recorded it');
  assert.ok(!/ADD COLUMN[^;]*NOT NULL/.test(sql),
    'pre-044 rows genuinely do not know, and NULL is the only honest value for them');
});


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

test('a venue outside ml_venues degrades geo columns AND the serve record to NULL', async () => {
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
  // CHANGED BY 038, deliberately. This used to keep the serve record, because
  // the lookup was keyed on the place id alone. It is now keyed on the place
  // id AND the venue's own hour — and a venue outside ml_venues has no clock
  // to key on, so there is nothing to check the pairing against. A
  // served_score nobody can tie to an hour is exactly the unverifiable figure
  // 032 exists to stop recording, so it degrades with the rest of the geo
  // columns rather than standing alone.
  assert.strictEqual(p[14], null, 'no clock, no serve id');
  assert.strictEqual(p[15], null, 'and no serve score to go with it');
  assert.ok(!queryLog.some((q) => /FROM served_predictions/.test(q.sql)),
    'and the read is not even issued — there is no hour to issue it for');
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

// ── 5. THE SERVE IT RECORDS IS ONE THE SERVER CHOSE (migration 038) ─────────
//
// This module writes "what Flock was publishing" onto a row the training
// exporter reads. Until 038 it took the newest served_predictions row for the
// venue, and the newest row is not necessarily the server's own arithmetic:
// POST /api/crowd/batch scores venues out of a client-assembled body — rating,
// review count, utcOffsetMinutes — and records the result like any other
// serve. So anyone with an account could decide what this table says Flock was
// publishing at any venue, without ever touching that venue's account, and the
// number landed in a training corpus rather than in a sentence read once.
//
// routes/feedback.js refuses those rows for provenance
// (__tests__/feedbackRoute.test.js); this is the same allowlist, one reader
// over.

const CTX_PLACE = 'ChIJtestplace000000000000000';

function captureWith(serveRows, reportId) {
  handlers = [
    [/SELECT 1 FROM venue_owner_report_context/, () => ({ rows: [] })],
    [/FROM ml_venues/, () => ({ rows: [VENUE_ROW] })],
    serveLogHandler(serveRows),
    [/INSERT INTO venue_owner_report_context/, () => ({ rows: [], rowCount: 1 })],
  ];
  queryLog = [];
  return ctxService.captureOwnerReportContext(reportId, {
    placeId: CTX_PLACE,
    userId: 42,
    now: NOW,
    deps: { getWeather: async () => WEATHER, getNearbyEvents: async () => EVENTS },
  });
}

test('THE FORGERY: a batch-sourced serve never becomes this label\'s context', async () => {
  // The attacker's row. A real bar posted to /api/crowd/batch with rating 1.0
  // and a 4am offset; the server published the ~5 that produced and recorded
  // it. It is the newest serve for this venue and it is on the right hour.
  const forged = { ...SERVED_ROW, id: 9001, score: 5, source: 'batch' };
  const out = await captureWith([forged], 501);
  assert.deepStrictEqual(out, { captured: true });

  const p = insertCall().params;
  assert.strictEqual(p[15], null, 'a client-assembled score must not be recorded as what Flock published');
  assert.strictEqual(p[14], null, 'nor may the row name the forged serve');
  assert.strictEqual(p[16], null);
  assert.strictEqual(p[17], null);
  assert.strictEqual(p[18], null);
  // NULLS, NOT A FALLBACK. Every column here is nullable by design (036: NULL
  // means not observed, never 0), so refusing is a first-class answer — and
  // the rest of the capture is untouched by the refusal.
  assert.strictEqual(p[1], 71.2, 'the weather still landed');
  assert.strictEqual(p[19], 3, 'and the venue clock still landed');
});

test('a batch row does not shadow the honest card serve underneath it', async () => {
  // Otherwise the attack survives in a weaker form: mint one batch row and the
  // newest-row rule blanks the real serve, deleting this column for any venue
  // on demand. Newest QUALIFYING, not newest-then-check.
  const out = await captureWith([
    { ...SERVED_ROW, id: 9002, score: 5, source: 'batch' },   // newest
    { ...SERVED_ROW, id: 4712, score: 62, source: 'detail' }, // the real one
  ], 502);
  assert.deepStrictEqual(out, { captured: true });
  const p = insertCall().params;
  assert.strictEqual(p[14], 4712);
  assert.strictEqual(p[15], 62, 'the trustworthy serve underneath is what was published');
});

test("the detail card's own client-clock fallback is not trusted here either", async () => {
  // Google returned no utcOffsetMinutes, so that card was scored on the hour
  // the CALLER named. The venue facts are Google's; the hour is not, and the
  // hour is the biggest lever on the score.
  const out = await captureWith([{ ...SERVED_ROW, id: 9003, score: 5, source: 'detail_client_clock' }], 503);
  assert.deepStrictEqual(out, { captured: true });
  assert.strictEqual(insertCall().params[15], null);
});

test('a pre-038 row, with no source recorded at all, is untrusted rather than assumed good', async () => {
  // No backfill is possible: those rows genuinely do not record which door
  // they came out of, and inventing the answer is the thing this column exists
  // to stop doing.
  const out = await captureWith([{ ...SERVED_ROW, id: 9004, score: 5, source: null }], 504);
  assert.deepStrictEqual(out, { captured: true });
  assert.strictEqual(insertCall().params[15], null);
});

test('a serve computed for a different hour did not answer "what was on screen now"', async () => {
  const out = await captureWith([{ ...SERVED_ROW, id: 9005, local_hour: 4 }], 505);
  assert.deepStrictEqual(out, { captured: true });
  assert.strictEqual(insertCall().params[15], null);
});

test('a serve computed for a different day is refused too', async () => {
  const out = await captureWith([{ ...SERVED_ROW, id: 9006, local_day: 6 }], 506);
  assert.deepStrictEqual(out, { captured: true });
  assert.strictEqual(insertCall().params[15], null);
});

test('a qualifying serve still lands — the filter refuses nothing legitimate', async () => {
  const out = await captureWith([SERVED_ROW], 507);
  assert.deepStrictEqual(out, { captured: true });
  const p = insertCall().params;
  assert.strictEqual(p[14], 77);
  assert.strictEqual(p[15], 62);
  assert.strictEqual(p[16], 'ml_model');
});

test('the serve lookup asks on the SAME clock it stores, and asks for it by parameter', async () => {
  // Two numbers that must never drift apart: the day/hour written into
  // day_of_week/hour, and the day/hour the serve had to match to be believed.
  await captureWith([SERVED_ROW], 508);
  const lookup = queryLog.find((q) => /FROM served_predictions/.test(q.sql));
  const p = insertCall().params;
  assert.deepStrictEqual([lookup.params[1], lookup.params[2]], [p[19], p[20]]);
  assert.strictEqual(lookup.params[0], CTX_PLACE);
});

test('the provenance filter is an ALLOWLIST in the shipped SQL, not a blocklist', () => {
  // Asserted against the source text, not only through the fake. A blocklist
  // (`source <> 'batch'`) re-opens this the day a fourth write path is added,
  // and lets every pre-038 NULL-source row through in the meantime.
  const sql = ctxService.SERVED_LOOKUP_SQL;
  assert.ok(/source = 'detail'/.test(sql), 'only the detail card may fill these columns');
  assert.ok(!/source\s*(<>|!=)/.test(sql), 'no blocklist');
  assert.ok(/local_day = \$2/.test(sql) && /local_hour = \$3/.test(sql),
    'the clock is matched in the database, not in a caller that could forget');
  assert.ok(/ORDER BY served_at DESC/.test(sql), 'newest QUALIFYING serve, not an arbitrary one');
});

test('the label exporter does not carry the served columns, so nothing bypasses this filter', () => {
  // scripts/ml/train/ownerLabelExport.js selects the weather and event context
  // columns and NOT served_score / served_prediction_id, so the poisoned value
  // never had a second route into training. That is worth pinning rather than
  // assuming: it is one line away from being untrue, and the guard that would
  // make it safe if it changed is the one above — the value stored is already
  // 'detail'-only, so a future SELECT that does reach for these columns
  // inherits the filter instead of needing its own.
  const ownerExport = require('../scripts/ml/train/ownerLabelExport');
  const { text } = ownerExport.ownerCandidateQuery('philadelphia', 'SELECT 1 AS baseline');
  assert.ok(/LEFT JOIN venue_owner_report_context c/.test(text), 'the context join is still there');
  assert.ok(!/c\.served_/.test(text),
    'if this ever selects a served_ column, the value it reads is 038-filtered at the write');
});
