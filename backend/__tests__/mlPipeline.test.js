// ---------------------------------------------------------------------------
// ML pipeline correctness: the crowd score is the product, and a confidently
// wrong score is its worst failure. These tests pin the train/inference
// contract (feature names, order, encodings), the fail-closed model gate, the
// timezone handling around the fake "venue wall clock" timestamps, and the
// quota-protecting error contract of the paid BestTime wrapper.
// ---------------------------------------------------------------------------

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// No live upstreams in tests: predictions must not reach Ticketmaster.
delete process.env.TICKETMASTER_API_KEY;

const mlPredictor = require('../services/mlPredictor');
const { _internals } = mlPredictor;
const {
  jsDayToBestTimeDay, bestTimeDayToJsDay,
  isHoliday, isSchoolBreak, getLocalTime,
} = require('../scripts/ml/config');

const META_PATH = path.join(__dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json');
const META = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

// A venue with a flat popular_times curve: every hour of every day is 50, so
// whatever moment a test runs at, the baseline is a known 50.
function venueWithBaseline() {
  return {
    place_id: 'test-place',
    types: ['restaurant'],
    rating: 4.2,
    price_level: 2,
    user_ratings_total: 120,
    latitude: 40.71,
    longitude: -74.0,
    popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(50) })),
  };
}

const WEATHER_CAMEL = { temp: 18, humidity: 60, windSpeed: 4, isRaining: true, conditionId: 500 };
const WEATHER_SNAKE = { temperature: 18, humidity: 60, wind_speed: 4, is_raining: true, weather_condition_code: 500 };

before(async () => {
  await mlPredictor.init();
});

// --- 1. model loading fails closed ------------------------------------------

test('a missing or malformed ship gate refuses promotion (fail closed)', () => {
  const gate = _internals.evaluateShipGate;
  assert.equal(gate(null).promote, false);
  assert.equal(gate({}).promote, false);
  assert.equal(gate({ ship_gate: null }).promote, false);
  assert.equal(gate({ ship_gate: 'yes' }).promote, false);
  // Only a literal boolean true passes — a truthy string is not a verdict.
  assert.equal(gate({ ship_gate: { overall_pass: 'true' } }).promote, false);
  assert.equal(gate({ ship_gate: { overall_pass: false, verdict: 'do_not_ship' } }).promote, false);
  assert.equal(gate({ ship_gate: { overall_pass: true, gate_basis: 'holdout_realtime' } }).promote, true);
});

test('the checked-in artifact loads and its gate passes', async () => {
  assert.equal(await mlPredictor.init(), true,
    'crowd_model.onnx + model_metadata.json should load and pass the ship gate');
  assert.equal(META.ship_gate.overall_pass, true);
  assert.equal(META.label_type, 'delta');
});

// --- 2. train/inference feature parity --------------------------------------

test('every trained feature has an inference-side implementation', () => {
  const missing = _internals.missingFeatureNames(META);
  assert.deepEqual(missing, [],
    `these metadata.feature_names would be silently zero-filled at inference: ${missing.join(', ')}`);
});

test('feature_names are unique and in sorted order (the positional contract)', () => {
  const names = META.feature_names;
  assert.equal(META.feature_count, names.length);
  assert.equal(new Set(names).size, names.length, 'duplicate feature name');
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted,
    'prepare_features.py emits sorted(feature_cols); an unsorted list means the metadata was hand-edited and no longer matches the ONNX column order');
});

test('the vector is ordered by metadata.feature_names, value by value', () => {
  const ts = new Date(2026, 7, 14, 19, 30); // 7:30 PM local wall clock
  const events = {
    hasEvent: true, nearestAttendance: 8000, totalEvents: 2,
    totalAttendance: 9000, nearestType: 'music', nearestDistance: 1.2,
  };
  const feedback = { avgCrowd: 2.5, count: 4, avgErrorMapped: 11, avgErrorLegacy: -7 };
  const vector = _internals.buildFeatureVector(
    venueWithBaseline(), WEATHER_CAMEL, ts, events, feedback, 50, { count: 3, mean: 42 });

  assert.equal(vector.length, META.feature_names.length);
  const idx = (name) => {
    const i = META.feature_names.indexOf(name);
    assert.ok(i >= 0, `${name} not in feature_names`);
    return i;
  };
  const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-4, `${msg}: ${a} vs ${b}`);

  assert.equal(vector[idx('hour')], ts.getHours());
  assert.equal(vector[idx('day_of_week')], ts.getDay());
  assert.equal(vector[idx('month')], ts.getMonth() + 1);
  approx(vector[idx('temperature')], 18, 'temperature');
  approx(vector[idx('wind_speed')], 4, 'wind_speed');
  assert.equal(vector[idx('is_raining')], 1);
  assert.equal(vector[idx('weather_light_rain')], 1, 'conditionId 500 is light rain');
  assert.equal(vector[idx('weather_clear')], 0);
  assert.equal(vector[idx('is_realtime')], 1, 'live predictions are realtime quality');
  assert.equal(vector[idx('is_dinner_hour')], 1, '19h is dinner');
  assert.equal(vector[idx('has_nearby_event')], 1);
  assert.equal(vector[idx('large_event_nearby')], 1, '8000 > 5000');
  assert.equal(vector[idx('etype_music')], 1);
  assert.equal(vector[idx('etype_sports')], 0);
  approx(vector[idx('hour_sin')], Math.sin(2 * Math.PI * ts.getHours() / 24), 'hour_sin');
  approx(vector[idx('hour_cos')], Math.cos(2 * Math.PI * ts.getHours() / 24), 'hour_cos');
  approx(vector[idx('log_review_count')], Math.log(121), 'log_review_count');
  approx(vector[idx('neighbor_baseline_same_hour')], 42, 'neighbor mean');
  approx(vector[idx('log_neighbor_count')], Math.log1p(3), 'neighbor count');
  assert.equal(vector[idx('has_user_feedback')], 1);
  // Feedback-error semantics must follow what the model trained on: the
  // shipped v2.5-starling metadata does NOT declare 'mapped', so it gets the
  // legacy raw-ordinal error. A model that declares mapped gets mapped.
  const expectedErr = META.feedback_error_semantics === 'mapped' ? 11 : -7;
  approx(vector[idx('avg_prediction_error')], expectedErr, 'feedback error semantics');
  // Every position is a finite number — NaN in a Float32Array would sail
  // straight into the model.
  for (let i = 0; i < vector.length; i++) {
    assert.ok(Number.isFinite(vector[i]), `feature ${META.feature_names[i]} is ${vector[i]}`);
  }
});

test('weatherService camelCase and training snake_case build the identical vector', () => {
  const ts = new Date(2026, 7, 14, 19, 30);
  const a = _internals.buildFeatureVector(venueWithBaseline(), WEATHER_CAMEL, ts, null, null, 50, null);
  const b = _internals.buildFeatureVector(venueWithBaseline(), WEATHER_SNAKE, ts, null, null, 50, null);
  assert.deepEqual(Array.from(a), Array.from(b),
    'the 2026-08-12 audit bug: camelCase weather silently read as 0s');
});

test('astronomy features match the training formula, clamps included', () => {
  // Recompute prepare_features.add_astronomy_features by hand.
  const expected = (lat, month, hour) => {
    const doy = month * 30.4 - 15.2;
    const decl = -23.44 * Math.cos((Math.PI / 180) * (360 / 365) * (doy + 10));
    const latC = Math.max(-65, Math.min(65, lat));
    const x = Math.max(-1, Math.min(1, -Math.tan(latC * Math.PI / 180) * Math.tan(decl * Math.PI / 180)));
    const daylight = (2 * (Math.acos(x) * 180 / Math.PI)) / 15;
    const sunset = 12 + daylight / 2;
    const hh = hour < 5 ? hour + 24 : hour;
    const after = Math.max(-8, Math.min(12, hh - sunset));
    return { daylight_hours: daylight, hours_after_sunset: after, is_after_sunset: after > 0 ? 1 : 0 };
  };
  for (const [lat, month, hour] of [[40.7, 8, 19], [51.5, 12, 16], [-33.9, 6, 18], [70, 6, 12], [40.7, 1, 1]]) {
    const got = _internals.astronomyFeatures(lat, month, hour);
    const want = expected(lat, month, hour);
    for (const k of Object.keys(want)) {
      assert.ok(Math.abs(got[k] - want[k]) < 1e-9, `${k} at lat=${lat},m=${month},h=${hour}`);
    }
  }
  // 1 AM belongs to the evening: hours_after_sunset must be positive summer night.
  assert.equal(_internals.astronomyFeatures(40.7, 7, 1).is_after_sunset, 1);
});

test('weather code grouping matches prepare_features boundaries', () => {
  const g = _internals.groupWeatherCode;
  assert.equal(g(200), 'thunderstorm');
  assert.equal(g(232), 'thunderstorm');
  assert.equal(g(300), 'light_rain');
  assert.equal(g(321), 'light_rain');
  assert.equal(g(500), 'light_rain');
  assert.equal(g(501), 'light_rain');
  assert.equal(g(502), 'heavy_rain');
  assert.equal(g(531), 'heavy_rain');
  assert.equal(g(600), 'snow');
  assert.equal(g(622), 'snow');
  assert.equal(g(800), 'clear');
  assert.equal(g(801), 'few_clouds');
  assert.equal(g(802), 'few_clouds');
  assert.equal(g(803), 'cloudy');
  assert.equal(g(804), 'cloudy');
  assert.equal(g(781), 'other');
  assert.equal(g(null), 'unknown');
  assert.equal(g(undefined), 'unknown');
});

test('category encoding covers the default guess', () => {
  // guessCategory falls back to 'restaurant'; if the encoding cannot encode
  // it, every unknown venue silently becomes -1.
  assert.ok('restaurant' in META.category_encoding);
});

// --- 3. honest scores through the real model ---------------------------------

test('a venue with a baseline is scored by the model, inside the delta clamp', async () => {
  const result = await mlPredictor.predictBusyness(venueWithBaseline(), WEATHER_CAMEL, new Date());
  assert.equal(result.predictionMethod, 'ml');
  assert.equal(result.modelVersion, META.model_version);
  assert.ok(result.score >= 0 && result.score <= 100, `score ${result.score}`);
  const [lo, hi] = META.delta_clamp_range || [-30, 30];
  assert.ok(result.score >= 50 + lo && result.score <= 50 + hi,
    `delta model with baseline 50 must stay within the clamp; got ${result.score}`);
  assert.equal(result.label, mlPredictor.getLabel(result.score));
  assert.ok(result.confidence > 0 && result.confidence <= 100);
});

test('no baseline at all falls back to the rule engine, honestly labelled', async () => {
  const venue = { ...venueWithBaseline(), place_id: null, popular_times: undefined };
  const result = await mlPredictor.predictBusyness(venue, WEATHER_CAMEL, new Date());
  assert.equal(result.predictionMethod, 'rule_engine_no_baseline',
    'a delta model with baseline 0 caps at ~30 no matter how packed the venue is — it must not answer');
  assert.equal(result.modelVersion, null);
});

test('the 24h forecast labels every hour in sequence from the start hour', async () => {
  const start = 22;
  const forecast = await mlPredictor.predictHourlyForecast(venueWithBaseline(), WEATHER_CAMEL, start, 24, new Date());
  assert.equal(forecast.length, 24);
  const label = (h) => {
    const hh = h % 24;
    const period = hh >= 12 ? 'PM' : 'AM';
    const display = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
    return `${display} ${period}`;
  };
  for (let i = 0; i < 24; i++) {
    assert.equal(forecast[i].hour, label(start + i), `entry ${i}`);
    assert.ok(forecast[i].score >= 0 && forecast[i].score <= 100);
    assert.equal(forecast[i].label, mlPredictor.getLabel(forecast[i].score));
  }
});

test('baselineFromPopularTimes reads the requested day and hour, clamped to 0..100', () => {
  const pt = [
    { day: 5, data: Array.from({ length: 24 }, (_, h) => h * 10) }, // 8 PM = 200 → clamp 100
  ];
  assert.equal(_internals.baselineFromPopularTimes(pt, 5, 3), 30);
  assert.equal(_internals.baselineFromPopularTimes(pt, 5, 20), 100, 'clamped');
  assert.equal(_internals.baselineFromPopularTimes(pt, 2, 3), 0, 'day not present');
  assert.equal(_internals.baselineFromPopularTimes(null, 5, 3), 0);
});

// --- 4. timezone: wall clocks vs instants ------------------------------------

test('the event window converts the venue wall clock back to a true instant', () => {
  // The callers hand predictBusyness a Date whose LOCAL fields are the venue's
  // wall clock. 8 PM Aug 13 at a Tokyo venue (UTC+9) is 11:00 UTC.
  const fake = new Date(2026, 7, 13, 20, 0, 0);
  assert.equal(_internals.trueEventInstant(fake, 540).toISOString(), '2026-08-13T11:00:00.000Z');
  // Same wall clock at a New York venue (EDT, UTC-4) is 00:00 UTC next day.
  assert.equal(_internals.trueEventInstant(fake, -240).toISOString(), '2026-08-14T00:00:00.000Z');
  // No offset known → unchanged (legacy behavior, not a guess).
  assert.equal(_internals.trueEventInstant(fake, null).getTime(), fake.getTime());
  assert.equal(_internals.trueEventInstant(fake, 'nonsense').getTime(), fake.getTime());
});

test('BestTime day convention roundtrips (Mon=0 there, Sun=0 here)', () => {
  assert.equal(jsDayToBestTimeDay(0), 6, 'JS Sunday is BestTime 6');
  assert.equal(bestTimeDayToJsDay(0), 1, 'BestTime Monday is JS 1');
  for (let d = 0; d < 7; d++) {
    assert.equal(bestTimeDayToJsDay(jsDayToBestTimeDay(d)), d);
    assert.equal(jsDayToBestTimeDay(bestTimeDayToJsDay(d)), d);
  }
});

test('getLocalTime returns coherent venue-local fields', () => {
  // 2026-08-13T02:30Z: already Thursday in Tokyo/Sydney, still Wednesday
  // evening in New York — the split the six-day crowd card bug lived in.
  const instant = new Date('2026-08-13T02:30:00Z');
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (const tz of ['America/New_York', 'Asia/Tokyo', 'Australia/Sydney', 'UTC']) {
    const t = getLocalTime(tz, instant);
    assert.ok(Number.isInteger(t.hour) && t.hour >= 0 && t.hour <= 23, `${tz} hour ${t.hour}`);
    assert.ok(Number.isInteger(t.dayOfWeek) && t.dayOfWeek >= 0 && t.dayOfWeek <= 6);
    assert.match(t.dateStr, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(t.month, parseInt(t.dateStr.slice(5, 7), 10), `${tz} month/dateStr disagree`);
    // The stamped weekday must be the weekday OF the stamped date in that tz —
    // the exact confusion class of the crowd card's six-day bug.
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(instant);
    assert.equal(t.dayOfWeek, map[wd], `${tz} weekday mismatch`);
  }
  assert.equal(getLocalTime('America/New_York', instant).dateStr, '2026-08-12', 'NYC is still Wednesday');
  assert.equal(getLocalTime('Asia/Tokyo', instant).dateStr, '2026-08-13', 'Tokyo has rolled over');
  assert.equal(getLocalTime('America/New_York', instant).hour, 22);
  assert.equal(getLocalTime('Asia/Tokyo', instant).hour, 11);
});

test('the holiday calendar answers dates, not weekdays', () => {
  assert.equal(isHoliday('2026-11-26'), true, 'Thanksgiving 2026');
  assert.equal(isHoliday('2026-11-25'), false, 'the eve is not the holiday');
  assert.equal(isHoliday('2026-07-04'), true);
  assert.equal(isSchoolBreak('2026-07-15'), true, 'summer break');
  assert.equal(isSchoolBreak('2026-10-15'), false);
});

// --- 5. the paid BestTime wrapper protects quota and corpus -------------------

test('BestTime failures follow the transient/fatal/no-data contract', async (t) => {
  const realFetch = global.fetch;
  const realKey = process.env.BESTTIME_API_KEY;
  process.env.BESTTIME_API_KEY = 'test-key';
  // Fresh copy of the module so the mocked fetch is what it sees.
  delete require.cache[require.resolve('../scripts/ml/bestTimeService')];
  const { fetchWeeklyForecast, fetchLiveBusyness } = require('../scripts/ml/bestTimeService');

  const respond = (status, body) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  });

  try {
    // 5xx and 429: transient — the caller must not 404-mark the venue.
    for (const status of [500, 503, 429]) {
      global.fetch = respond(status);
      await assert.rejects(() => fetchWeeklyForecast('V', 'A', null),
        (e) => e.transient === true, `weekly ${status} should throw transient`);
      await assert.rejects(() => fetchLiveBusyness('venue-id'),
        (e) => e.transient === true, `live ${status} should throw transient`);
    }
    // 401/402/403: key or credits — nothing venue-level; the RUN must stop.
    // (402 is BestTime out-of-credits; before this contract it 404-marked
    // every remaining venue and poisoned the corpus for the cycle.)
    for (const status of [401, 402, 403]) {
      global.fetch = respond(status);
      await assert.rejects(() => fetchWeeklyForecast('V', 'A', null),
        (e) => e.fatal === true, `weekly ${status} should throw fatal`);
      await assert.rejects(() => fetchLiveBusyness('venue-id'),
        (e) => e.fatal === true, `live ${status} should throw fatal`);
    }
    // 404: genuinely not in BestTime — null, caller may mark it.
    global.fetch = respond(404);
    assert.equal(await fetchWeeklyForecast('V', 'A', null), null);
    assert.equal(await fetchLiveBusyness('venue-id'), null);
    // Network failure: transient, never a 404 mark.
    global.fetch = async () => { throw new Error('fetch failed'); };
    await assert.rejects(() => fetchWeeklyForecast('V', 'A', null), /fetch failed/);
    await assert.rejects(() => fetchLiveBusyness('venue-id'), /fetch failed/);
    // A healthy weekly payload maps BestTime's Mon=0 days straight through.
    global.fetch = respond(200, {
      status: 'OK',
      analysis: [{ day_info: { day_int: 0, day_text: 'Monday' }, day_raw: Array(24).fill(40) }],
      venue_info: { venue_id: 'bt-1' },
    });
    const weekly = await fetchWeeklyForecast('V', 'A', null);
    assert.equal(weekly.venueId, 'bt-1');
    assert.equal(weekly.days[0].dayInt, 0);
    assert.equal(weekly.days[0].hours.length, 24);
    // Live "status not OK" is venue-level no-data, not an error.
    global.fetch = respond(200, { status: 'ERROR' });
    assert.equal(await fetchLiveBusyness('venue-id'), null);
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.BESTTIME_API_KEY;
    else process.env.BESTTIME_API_KEY = realKey;
    delete require.cache[require.resolve('../scripts/ml/bestTimeService')];
  }
});
