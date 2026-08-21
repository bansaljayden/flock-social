// Run: node --test  (from backend/)
//
// ===========================================================================
// AN UNCHECKED STREET IS NOT AN EMPTY ONE, AT SERVE TIME.
//
// mlPredictor.getNearbyEvents used to answer with one shared "no events"
// object whether Ticketmaster listed nothing, the per-account budget refused
// the call, the provider errored, or the request timed out. It now carries
// `observed` and `unavailableReason` on every return. This file pins what the
// SERVING path does with that, which is a different question from what
// services/advisorFacts.js does with it (advisorEventProvenance.test.js) and
// from what services/ownerReportContext.js does with it
// (ownerReportContext.test.js).
//
// The serving answer has two halves and they pull in opposite directions:
//
//   1. THE VECTOR DOES NOT CHANGE, deliberately. prepare_features.py ends
//      with fillna(0) over the feature columns, so every missing event value
//      in the corpus was trained as 0, and has_nearby_event is a hard 0/1
//      that every tree splits at 0.5. There is no in-distribution way to say
//      "unknown" to this model, and inventing one (-1, NaN, a fractional base
//      rate) would be the same mistake as the `?? 20` that told it 20F on
//      every weather outage. What the no-information values produce is the
//      right fallback anyway: with the event pathway contributing nothing, a
//      delta model reverts to baseline plus the non-event features, which is
//      the venue's own expectation for that slot.
//
//   2. THE RESPONSE DOES CHANGE. The bug was never the arithmetic. It was
//      that nothing downstream could tell the difference, so an outage was
//      published with the confidence of a measurement, listed Ticketmaster as
//      a source it had not reached, and was written into
//      venue_owner_report_context as an observation. So the response states
//      `eventsObserved`, names the reason, and stops claiming the source.
//      What it does NOT do is deduct a made-up number from `confidence`:
//      nothing has measured what an unchecked listing costs, and this file
//      would then be shipping the invented constant confidenceHonesty.test.js
//      exists to keep out.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');

// No live upstream: with no key, getNearbyEvents answers observed:false with
// reason 'no_api_key', which is exactly the state under test.
delete process.env.TICKETMASTER_API_KEY;
process.env.JWT_SECRET = 'event-unknown-vs-zero-test-secret';

const pool = require('../config/database');
// predictBusyness reads baselines, feedback and neighbours from the database.
// None of them is under test here and none may reach a real server.
pool.query = async () => ({ rows: [], rowCount: 0 });

const mlPredictor = require('../services/mlPredictor');
const mlInternals = mlPredictor._internals;

const VENUE = {
  place_id: 'event-unknown-test-venue',
  name: 'Test Bar',
  types: ['bar', 'restaurant', 'point_of_interest', 'establishment'],
  rating: 4.2,
  price_level: 2,
  user_ratings_total: 300,
  location: { latitude: 40.71, longitude: -74.0 },
  popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(50) })),
};

const WEATHER = { temp: 70, humidity: 55, windSpeed: 4, isRaining: false, conditionId: 800 };
const TS = new Date(2026, 7, 14, 20, 0, 0, 0); // Friday 8 PM, venue wall clock

const EVENT_SLOTS = [
  'has_nearby_event', 'nearest_event_attendance', 'log_nearest_event_attendance',
  'nearest_event_distance_km', 'total_nearby_events', 'total_nearby_attendance',
  'log_total_nearby_attendance', 'large_event_nearby', 'event_x_weekend',
  'event_x_dinner', 'event_x_bar', 'etype_music', 'etype_sports', 'etype_arts',
  'etype_family', 'etype_other',
];

function slots(map) {
  const out = {};
  for (const k of EVENT_SLOTS) out[k] = map[k];
  return out;
}

const OBSERVED_QUIET = {
  observed: true, unavailableReason: null,
  hasEvent: false, nearestAttendance: 0, totalEvents: 0, totalAttendance: 0,
  nearestType: null, nearestDistance: 0, nearestName: null,
};

// ---------------------------------------------------------------------------
// 1. THE VECTOR
// ---------------------------------------------------------------------------

test('an unobserved lookup fills the event slots the way a quiet night does, and that is the decision', async () => {
  await mlPredictor.init();
  const quiet = mlInternals.buildFeatureMap(VENUE, WEATHER, TS, OBSERVED_QUIET, {}, 50, {});
  for (const reason of ['no_api_key', 'budget_exhausted', 'provider_error', 'timeout', 'lookup_failed']) {
    const unknown = mlInternals.buildFeatureMap(
      VENUE, WEATHER, TS,
      { ...OBSERVED_QUIET, observed: false, unavailableReason: reason },
      {}, 50, {});
    assert.deepStrictEqual(slots(unknown), slots(quiet),
      `${reason}: the model has no learned encoding for "unknown", so the vector must stay in distribution`);
  }
});

test('the placeholders on an unobserved shape never reach the vector as numbers', async () => {
  await mlPredictor.init();
  // A shape that says observed:false while still carrying figures. The figures
  // are placeholders by contract and reading them would be the original bug
  // wearing the opposite sign: a fabricated POSITIVE.
  const map = mlInternals.buildFeatureMap(VENUE, WEATHER, TS, {
    observed: false, unavailableReason: 'provider_error',
    hasEvent: true, nearestAttendance: 30000, totalEvents: 9, totalAttendance: 40000,
    nearestType: 'sports', nearestDistance: 0.4, nearestName: 'stale',
  }, {}, 50, {});
  assert.strictEqual(map.has_nearby_event, 0);
  assert.strictEqual(map.nearest_event_attendance, 0);
  assert.strictEqual(map.total_nearby_events, 0);
  assert.strictEqual(map.total_nearby_attendance, 0);
  assert.strictEqual(map.nearest_event_distance_km, 0);
  assert.strictEqual(map.large_event_nearby, 0);
  assert.strictEqual(map.etype_sports, 0);
});

test('an observed event still lands in the vector unchanged', async () => {
  await mlPredictor.init();
  const map = mlInternals.buildFeatureMap(VENUE, WEATHER, TS, {
    observed: true, unavailableReason: null,
    hasEvent: true, nearestAttendance: 8000, totalEvents: 3, totalAttendance: 12000,
    nearestType: 'music', nearestDistance: 1.4, nearestName: 'Test Fest',
  }, {}, 50, {});
  assert.strictEqual(map.has_nearby_event, 1);
  assert.strictEqual(map.nearest_event_attendance, 8000);
  assert.strictEqual(map.total_nearby_events, 3);
  assert.strictEqual(map.nearest_event_distance_km, 1.4);
  assert.strictEqual(map.etype_music, 1);
  assert.strictEqual(map.large_event_nearby, 1);
});

test('a shape with no observed flag keeps its numbers: the vector fires on a stated failure, not on a missing field', async () => {
  await mlPredictor.init();
  // The opposite polarity to ownerReportContext, on purpose. Writing a fact
  // into a training corpus fails closed. Changing a live prediction's inputs
  // must not fire on the absence of a flag.
  const map = mlInternals.buildFeatureMap(VENUE, WEATHER, TS, {
    hasEvent: true, nearestAttendance: 8000, totalEvents: 3, totalAttendance: 12000,
    nearestType: 'music', nearestDistance: 1.4,
  }, {}, 50, {});
  assert.strictEqual(map.has_nearby_event, 1);
  assert.strictEqual(map.total_nearby_events, 3);
});

// ---------------------------------------------------------------------------
// 2. THE RESPONSE
// ---------------------------------------------------------------------------

test('a prediction made without an event lookup says so, names the reason, and pays for it', async () => {
  const ready = await mlPredictor.init();
  const r = await mlPredictor.predictBusyness(VENUE, WEATHER, TS);

  assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100,
    'the outage must still produce a prediction');
  assert.strictEqual(r.eventsObserved, false,
    'no key means no lookup, and the response has to be able to say that');
  assert.strictEqual(r.eventsUnavailableReason, 'no_api_key');
  assert.ok(!r.dataSourcesUsed.includes('ticketmaster_events'),
    'a source that was never reached is not a source');
  assert.strictEqual(r.eventAlert, undefined,
    'no event was seen, so no event may be announced');

  if (ready && r.predictionMethod === 'ml') {
    assert.ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100);
    // No made-up deduction. The weather penalty is the ladder's own 15 given
    // back; there is no measured equivalent for events, and publishing an
    // invented one as part of a percentage a user reads is the failure
    // confidenceHonesty.test.js was written to catch.
    assert.ok(!('eventPenalty' in r.confidenceMeasurement),
      'state the missing input, do not price it at a number nobody measured');
  }
});

test('every hour of the strip carries the same honesty, not just the first', async () => {
  const strip = await mlPredictor.predictHourlyForecast(VENUE, WEATHER, 18, 4, TS);
  assert.strictEqual(strip.length, 4);
  for (const entry of strip) {
    assert.ok(Number.isInteger(entry.score) && entry.score >= 0 && entry.score <= 100,
      'an event outage must not cost the strip an hour');
  }
});
