// ---------------------------------------------------------------------------
// PREDICTOR CORRECTNESS — the busyness number on every venue card.
//
// The failure this file exists to catch is not a crash. It is a number that
// looks right, ships to a user, and is wrong because the inference code and the
// training code quietly disagree about what a feature means. The archetype is
// the 0,0 coordinate bug: buildFeatureMap read `venue.latitude`, no caller ever
// set it, and every live prediction ran on the equator for months without one
// error in the logs.
//
// So the assertions here are mostly TRAIN/INFERENCE PARITY assertions, written
// against the Python and the collector scripts that actually produced the
// corpus (scripts/ml/train/prepare_features.py, scripts/ml/collectEvents.js,
// scripts/ml/train/export_training_data.js). If one of those files changes, one
// of these should go red.
//
// Complements __tests__/mlPipeline.test.js (feature order, ship gate, clocks)
// and __tests__/upstreamBudgets.test.js (weather caching/coalescing/ceilings).
// Nothing here duplicates those; it covers what they do not.
// ---------------------------------------------------------------------------

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const META_PATH = path.join(__dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json');
const META = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

const mlPredictor = require('../services/mlPredictor');
const { _internals } = mlPredictor;

// Callers shape a venue as { location: { latitude, longitude } } — routes/
// crowd.js, routes/publicCrowd.js, routes/badge.js and routes/venueDashboard.js
// all do, and none of them sets a top-level `latitude`. Test with the shape
// production actually sends, or a coordinate bug hides here too.
function liveVenue(over = {}) {
  return {
    place_id: 'pc-test-place',
    name: 'Test Venue',
    types: ['bar', 'restaurant', 'food', 'point_of_interest', 'establishment'],
    rating: 4.2,
    price_level: 2,
    user_ratings_total: 240,
    location: { latitude: 40.71, longitude: -74.0 },
    utcOffsetMinutes: -240,
    ...over,
  };
}

const WEATHER = { temp: 71, humidity: 60, windSpeed: 4, isRaining: false, conditionId: 800 };

before(async () => {
  await mlPredictor.init();
});

// ---------------------------------------------------------------------------
// 0. THE ARCHETYPE, PINNED DIRECTLY.
//
// buildFeatureMap once read `venue.latitude` / `venue.lat`, which no caller
// sets, so every live prediction was built at 0,0. Nothing failed: the vector
// was full of plausible numbers for a venue on the equator. The general lesson
// is that a coordinate read has to be asserted against a value, not against a
// key being present — `missingFeatureNames` would have passed throughout.
//
// Two features are sensitive enough to serve as the probe: astronomy (daylight
// is exactly 12.0 hours at the equator in every month) and the v2.5
// special-night calendar (0,0 is not near any training city, so it returns
// all-zeros there).
// ---------------------------------------------------------------------------

test('the live caller venue shape produces the venue\'s real coordinates', () => {
  const nyc = { latitude: 40.71, longitude: -74.0 };
  // 2026-02-08 is a special night in the training calendar for New York, and
  // is not one at 0,0 — so this single assertion fails if the coordinates are
  // ever silently lost again.
  const ts = new Date(2026, 1, 8, 20, 0);
  const map = _internals.buildFeatureMap(
    liveVenue({ location: nyc }), WEATHER, ts, null, null, 50, null);

  assert.equal(map.is_special_night, 1,
    'the venue-clock date at the venue\'s real coordinates is a special night; at 0,0 it is not');

  const astro = _internals.astronomyFeatures(nyc.latitude, 2, 20);
  assert.ok(Math.abs(map.daylight_hours - astro.daylight_hours) < 1e-9);
  assert.notEqual(map.daylight_hours, 12,
    'daylight is exactly 12 hours only on the equator — the 0,0 tell');

  // The climate band is the venue's, not band 0.
  //
  // PROBED IN A MONTH THE ARTIFACT HAS CLIMATOLOGY FOR, which February is not.
  // Since skew fix (e) the anomaly slot is 0 for every latitude outside the
  // corpus months (see monthClimateNorm), so a February build cannot tell band
  // 40 from band 0 and the assertion that used to sit here had quietly stopped
  // probing anything. May is inside the corpus, so the band lookup is live and
  // the two bands give genuinely different answers, which is what makes this a
  // coordinate probe rather than a restatement of the same arithmetic.
  const mayTs = new Date(2026, 4, 8, 20, 0);
  const mayMap = _internals.buildFeatureMap(
    liveVenue({ location: nyc }), WEATHER, mayTs, null, null, 50, null);
  const anomalyAt = (lat) => Math.max(-25, Math.min(25,
    WEATHER.temp - _internals.monthClimateNorm(lat, 5)));
  assert.equal(mayMap.temp_anomaly, anomalyAt(nyc.latitude));
  assert.notEqual(anomalyAt(nyc.latitude), anomalyAt(0),
    'band 40 and band 0 must disagree here, or this assertion is not a 0,0 tell');
  assert.equal(map.temp_anomaly, 0,
    'February is outside the corpus climatology, so no anomaly is claimed at any latitude');

  // And the SAME venue described with top-level coordinates instead of a
  // `location` object must build the identical vector, so neither shape is the
  // one that silently works.
  const a = _internals.buildFeatureVector(liveVenue({ location: nyc }), WEATHER, ts, null, null, 50, null);
  const b = _internals.buildFeatureVector(
    liveVenue({ location: null, latitude: nyc.latitude, longitude: nyc.longitude }),
    WEATHER, ts, null, null, 50, null);
  assert.deepEqual(Array.from(a), Array.from(b));
});

// ---------------------------------------------------------------------------
// 1. GOOGLE TYPE ONE-HOTS — training only ever saw the FIRST THREE types.
//
// scripts/ml/train/export_training_data.js rowToCsv writes exactly three type
// columns: `types[0]`, `types[1]`, `types[2]` -> google_type_1/2/3, and
// prepare_features.add_venue_features builds every `gtype_*` column by testing
// those three columns and nothing else.
//
// Inference tested membership of the WHOLE types array. Google returns the
// generic tail types on essentially every place — `point_of_interest` and
// `establishment` are the last two entries of almost every Places response and
// both are in metadata.top_google_types — so those two one-hots were ~always 1
// at inference and ~always 0 in training. Two of thirty type features
// systematically inverted, on every single prediction.
// ---------------------------------------------------------------------------

test('gtype one-hots read only the first three Google types, as training did', () => {
  const types = ['bar', 'restaurant', 'food', 'point_of_interest', 'establishment'];
  const map = _internals.buildFeatureMap(
    liveVenue({ types }), WEATHER, new Date(2026, 7, 14, 20, 0), null, null, 50, null);

  // google_type_1..3
  assert.equal(map.gtype_bar, 1, 'types[0]');
  assert.equal(map.gtype_restaurant, 1, 'types[1]');
  assert.equal(map.gtype_food, 1, 'types[2]');
  // Beyond position 3 the training corpus has no column at all, so these were
  // zero for every row the model ever saw.
  assert.equal(map.gtype_point_of_interest, 0,
    'types[3] had no column in the training CSV — inference must not set it');
  assert.equal(map.gtype_establishment, 0,
    'types[4] had no column in the training CSV — inference must not set it');
});

test('a venue with fewer than three types sets only the types it has', () => {
  const map = _internals.buildFeatureMap(
    liveVenue({ types: ['cafe'] }), WEATHER, new Date(2026, 7, 14, 9, 0), null, null, 50, null);
  assert.equal(map.gtype_cafe, 1);
  assert.equal(map.gtype_restaurant, 0);
  assert.equal(map.gtype_establishment, 0);
});

// ---------------------------------------------------------------------------
// 2. EVENT ATTENDANCE — the inference estimator drifted from the collector.
//
// `nearest_event_attendance`, its log, `total_nearby_attendance` and
// `large_event_nearby` (>5000) were all produced for TRAINING by
// scripts/ml/collectEvents.js estimateAttendance(). mlPredictor kept a trimmed
// copy that had lost four branches, so the same Ticketmaster payload was scored
// with a different number at serving time than it was labelled with at
// training time — and `eventAlert`, the "big event nearby" banner the user
// sees, is gated on the same >5000 threshold, so a Madison Square Garden
// concert (500 instead of 20000) could never raise it.
// ---------------------------------------------------------------------------

function tmEvent(venueName, segment, genre) {
  return {
    name: 'An Event',
    classifications: [{ segment: { name: segment }, genre: { name: genre || '' } }],
    _embedded: { venues: [{ name: venueName, location: { latitude: '40.75', longitude: '-73.99' } }] },
  };
}

test('event attendance matches scripts/ml/collectEvents.js estimateAttendance', () => {
  const est = _internals.estimateTmAttendance;
  // The arena vocabulary includes garden and field. "Madison Square Garden" and
  // "Levi's Field" are arenas to the collector and were arenas in the corpus.
  assert.equal(est(tmEvent('Madison Square Garden', 'Music')), 20000, 'garden is an arena');
  assert.equal(est(tmEvent("Levi's Field", 'Sports')), 25000, 'field is an arena');
  assert.equal(est(tmEvent('Barclays Arena', 'Music')), 20000);
  assert.equal(est(tmEvent('Wrigley Stadium', 'Sports')), 25000);
  // Music at a theatre is its own tier.
  assert.equal(est(tmEvent('The Fillmore Theatre', 'Music')), 3000);
  assert.equal(est(tmEvent('Orpheum Theater', 'Music')), 3000);
  assert.equal(est(tmEvent('Some Small Club', 'Music')), 500);
  // Arts and family have their own tiers; both used to collapse to 500.
  assert.equal(est(tmEvent('A Gallery', 'Arts & Theatre')), 1500);
  assert.equal(est(tmEvent('A Hall', 'Family')), 1000);
  assert.equal(est(tmEvent('Anywhere', 'Miscellaneous')), 500);
  assert.equal(est(tmEvent('A Small Room', 'Sports')), 5000, 'non-arena sports');
});

// ---------------------------------------------------------------------------
// 3. NEARBY EVENT AGGREGATION — one set of events, counted once.
//
// scripts/ml/enrichWithEvents.js applies DISTANCE_THRESHOLD_KM = 2 and then
// derives total_nearby_events and total_nearby_attendance from the SAME
// surviving list. mlPredictor counted `events.length` (everything Ticketmaster
// returned, including entries with no coordinates and anything the vendor's
// own radius let through) while summing attendance over a smaller set, so the
// two features described different populations and neither matched training.
// ---------------------------------------------------------------------------

test('nearby-event totals count exactly the events that contribute attendance', async () => {
  const realFetch = global.fetch;
  const realKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = 'tm-test-key';
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: {
          events: [
            // In range (~0 km), music at a garden -> 20000.
            { ...tmEvent('Madison Square Garden', 'Music') },
            // No coordinates at all: cannot be placed, must not be counted.
            {
              name: 'Ghost', classifications: [{ segment: { name: 'Music' } }],
              _embedded: { venues: [{ name: 'Unknown' }] },
            },
            // ~55 km away — beyond the 2 km the corpus was built with.
            {
              name: 'Far', classifications: [{ segment: { name: 'Music' } }],
              _embedded: { venues: [{ name: 'Far Arena', location: { latitude: '41.25', longitude: '-73.99' } }] },
            },
          ],
        },
      }),
    });

    const ev = await _internals.getNearbyEvents(40.7505, -73.9934, new Date('2026-08-14T23:00:00Z'));
    assert.equal(ev.hasEvent, true);
    assert.equal(ev.totalEvents, 1,
      'only placeable events within the training radius count');
    assert.equal(ev.totalAttendance, 20000,
      'total attendance must be the sum over exactly those events');
    assert.equal(ev.nearestAttendance, 20000);
    assert.equal(ev.nearestType, 'music');
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = realKey;
  }
});

test('an all-out-of-range event list is honestly "no events"', async () => {
  const realFetch = global.fetch;
  const realKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = 'tm-test-key';
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: {
          events: [{
            name: 'Far', classifications: [{ segment: { name: 'Music' } }],
            _embedded: { venues: [{ name: 'Far Arena', location: { latitude: '41.90', longitude: '-73.99' } }] },
          }],
        },
      }),
    });
    // Distinct coordinate so the cache from the previous test cannot answer.
    const ev = await _internals.getNearbyEvents(40.2505, -73.1934, new Date('2026-08-14T23:00:00Z'));
    assert.equal(ev.hasEvent, false, 'an event 130 km away is not a nearby event');
    assert.equal(ev.totalEvents, 0);
    assert.equal(ev.totalAttendance, 0);
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = realKey;
  }
});

// ---------------------------------------------------------------------------
// 4. MODEL / METADATA DRIFT.
//
// The ONNX graph consumes POSITIONS. metadata.feature_names is the only thing
// that says which position is which, and metadata.feature_count is a third
// copy of the same fact. Nothing compared them to the artifact, so a metadata
// file regenerated against a different training run than the .onnx beside it
// loaded happily and threw once per request forever after (every prediction
// silently degrading to the rule engine), or — where the counts happened to
// match — served confidently wrong numbers.
// ---------------------------------------------------------------------------

test('the checked-in ONNX graph and its metadata agree on shape', () => {
  const problems = _internals.verifyModelShape(_internals.getSession(), META);
  assert.deepEqual(problems, [], `artifact/metadata drift: ${problems.join('; ')}`);
});

test('verifyModelShape catches every way the two can disagree', () => {
  const v = _internals.verifyModelShape;
  const session = {
    inputNames: ['input'],
    outputNames: ['variable'],
    inputMetadata: [{ name: 'input', isTensor: true, type: 'float32', shape: ['', 106] }],
  };
  const good = {
    feature_names: Array.from({ length: 106 }, (_, i) => `f${i}`),
    feature_count: 106,
    onnx_input_name: 'input',
    training_metrics: { within_15: 83.6 },
  };
  assert.deepEqual(v(session, good), []);

  // Graph width vs feature_names length.
  const short = { ...good, feature_names: good.feature_names.slice(0, 105), feature_count: 105 };
  assert.ok(v(session, short).some((p) => /105/.test(p) && /106/.test(p)),
    'a graph that takes 106 columns must not be fed 105');

  // feature_count disagreeing with feature_names is a hand-edited metadata file.
  assert.ok(v(session, { ...good, feature_count: 99 }).length > 0);

  // The input tensor name the code binds must exist on the graph.
  assert.ok(v(session, { ...good, onnx_input_name: 'float_input' }).length > 0,
    'binding a name the graph does not have throws on every prediction');

  // No feature_names at all is not "zero features", it is unusable metadata —
  // and it has to be caught by its OWN check, not incidentally by the width
  // comparison, because an older onnxruntime exposes no inputMetadata to
  // compare against. Assert it with a session that offers nothing.
  const blind = { inputNames: [], outputNames: [] };
  assert.ok(v(blind, { feature_count: 0, feature_names: [] }).length > 0, 'empty feature_names');
  assert.ok(v(blind, {}).length > 0, 'absent feature_names');
  assert.ok(v(blind, null).length > 0, 'absent metadata');
  assert.ok(v(blind, { feature_names: 'a,b,c' }).length > 0, 'feature_names that is not a list');
  assert.ok(v(session, { feature_count: 0, feature_names: [] }).length > 0);

  // feature_types is a fourth copy of the width and drifts the same way.
  assert.deepEqual(v(session, { ...good, feature_types: new Array(106).fill('float') }), []);
  assert.ok(v(session, { ...good, feature_types: new Array(80).fill('float') }).length > 0);

  // A single-value regression head is what predictBusyness reads: it takes
  // session.outputNames[0] and then .data[0]. An artifact re-exported with a
  // classifier head (['label','probabilities']) still runs, still returns a
  // number, and that number is a class index — a wrong score with no error.
  const classifier = {
    inputNames: ['input'],
    outputNames: ['label', 'probabilities'],
    inputMetadata: session.inputMetadata,
    outputMetadata: [
      { name: 'label', isTensor: true, type: 'int64', shape: [''] },
      { name: 'probabilities', isTensor: true, type: 'float32', shape: ['', 5] },
    ],
  };
  assert.ok(v(classifier, good).length > 0,
    'a multi-output graph is not the single-value regressor this code reads');

  // The confidence percentage this file publishes IS metadata.training_metrics
  // .within_15. With no measured accuracy in the metadata the code fell back to
  // a bare `58`, a number with no provenance at all, and shipped it to users as
  // "58% confident". A model that cannot say how accurate it is must not be
  // promoted — same fail-closed rule as the ship gate and the feature-coverage
  // check.
  assert.deepEqual(v(session, { ...good, training_metrics: { within_15: 83.6 } }), []);
  for (const bad of [undefined, {}, { within_15: null }, { within_15: 'high' }, { within_15: 0 }, { within_15: 140 }]) {
    assert.ok(v(session, { ...good, training_metrics: bad }).length > 0,
      `training_metrics=${JSON.stringify(bad)} gives the response no honest confidence to report`);
  }
});

test('the promoted model publishes a measured accuracy, not a magic number', async () => {
  const meta = mlPredictor._internals.getMetadata();
  assert.ok(meta, 'the checked-in model is promoted');
  const within15 = meta.training_metrics.within_15;
  assert.ok(Number.isFinite(within15) && within15 > 0 && within15 <= 100);
  const venue = liveVenue({
    popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(50) })),
  });
  const r = await mlPredictor.predictBusyness(venue, WEATHER, new Date());
  // This used to assert the published confidence IS training_metrics.within_15.
  // That number is computed over a blend in which four of five rows are weekly
  // snapshots whose label equals the baseline by construction, so the model
  // gets them free: 87.3% blended against 33.3% on the rows production
  // actually scores. The pin was encoding the overstatement, so no honest
  // implementation could satisfy it. What the test means is that the number is
  // MEASURED rather than invented, and that claim now has two legitimate
  // shapes: an artifact carrying a served-population figure publishes it, and
  // an older artifact that never measured one publishes venue metadata
  // completeness instead and says so, rather than reaching for the blend.
  const acc = mlPredictor._internals.readServedAccuracy(meta);
  if (acc.status === 'measured') {
    assert.equal(r.confidence, Math.round(acc.percent),
      'a measured artifact publishes its served-population accuracy');
    assert.equal(r.confidenceMeasurement.status, 'measured');
  } else {
    assert.equal(r.confidenceMeasurement.status, 'unmeasured',
      'an artifact with no served-population slice must say the accuracy is unmeasured');
    assert.notEqual(r.confidence, Math.round(within15),
      'the blended figure must never be republished as if it were an accuracy');
  }
});

// ---------------------------------------------------------------------------
// 5. COLD-START RACE — a concurrent first request must not silently get the
// rule engine.
//
// init() set `loadAttempted = true` synchronously and only then awaited
// InferenceSession.create(). Every request that arrived during that window
// (a Railway cold boot, or the public demo scoring twenty venues at once) saw
// loadAttempted already true, read `useML` while it was still false, and was
// answered by the rule engine — different numbers for different venues in the
// same response, with nothing in the logs to say so.
// ---------------------------------------------------------------------------

// ROUND 2, ON THE FIX ABOVE. Memoising the load promise turns a ONE-TIME
// failure into a PERMANENT one unless the promise is guaranteed to settle.
// `await init()` sits OUTSIDE the try/catch in both predictBusyness and
// predictHourlyForecast, so a rejected memoised promise would reject every
// prediction the process ever makes again — routes/crowd.js turns that into a
// 500 and the venue card shows nothing at all, where the old code would have
// degraded to the rule engine. fs.existsSync runs before loadModel's own try,
// which is the reachable version of that.
test('a throwing model load resolves false forever, it never rejects', async () => {
  const modPath = require.resolve('../services/mlPredictor');
  const realExists = fs.existsSync;
  delete require.cache[modPath];
  try {
    fs.existsSync = () => { throw new Error('EIO: model volume unreadable'); };
    const broken = require('../services/mlPredictor');
    assert.equal(await broken.init(), false, 'first call must degrade, not throw');
    assert.equal(await broken.init(), false, 'and so must every call after it');
    // The whole point: a prediction still answers, honestly, from the rule engine.
    const r = await broken.predictBusyness(liveVenue(), WEATHER, new Date());
    assert.match(r.predictionMethod, /^rule_engine/);
    assert.equal(r.modelVersion, null);
    assert.ok(Number.isInteger(r.score));
  } finally {
    fs.existsSync = realExists;
    delete require.cache[modPath];
    require('../services/mlPredictor');
  }
});

test('concurrent callers during model load all get the loaded model', async () => {
  const modPath = require.resolve('../services/mlPredictor');
  delete require.cache[modPath];
  const fresh = require('../services/mlPredictor');
  try {
    const results = await Promise.all([fresh.init(), fresh.init(), fresh.init()]);
    assert.deepEqual(results, [true, true, true],
      'a caller that arrives while the model is loading must wait for it, not be told there is no model');
  } finally {
    delete require.cache[modPath];
    require('../services/mlPredictor');
  }
});

// ---------------------------------------------------------------------------
// 5b. THE HOUR LABEL MUST BE THE HOUR THAT WAS SCORED.
//
// predictHourlyForecast steps the timestamp by `i * 3600000` milliseconds — a
// fixed amount of ELAPSED TIME — and then labelled the entry `(start + i) % 24`,
// a count of WALL-CLOCK hours. Those are the same number only where no clock
// change happens between them. Across a DST transition they diverge by an hour
// in opposite directions, so the chart printed "2 AM" over a bar that had been
// scored at 1 AM (fall back) or 3 AM (spring forward). Same wall-clock-versus-
// instant confusion as the six-day crowd-card bug and the Ticketmaster query
// window, and the same rule applies: the label and the score must describe one
// moment or the card is lying about one of them.
//
// Railway runs UTC, which has no transitions, so this is a developer-machine
// and future-deployment bug rather than a live one — but it is provable, so it
// is proved. Run in a child process because the offending arithmetic depends on
// the process TZ, which Node reads once.
// ---------------------------------------------------------------------------

const { execFileSync } = require('child_process');

function forecastHoursInTz(tz, isoLocalMidnight) {
  const script = `
    const ml = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'mlPredictor'))});
    (async () => {
      const base = new Date(${JSON.stringify(isoLocalMidnight)});
      const venue = { place_id: null, types: ['bar'], rating: 4.1, price_level: 2,
        user_ratings_total: 100, location: { latitude: 40.71, longitude: -74.0 } };
      const f = await ml.predictHourlyForecast(venue, null, 0, 5, base);
      // Marker: the module logs to stdout on load, so the payload is fenced.
      process.stdout.write('<<<' + JSON.stringify(f.map(e => e.hour)) + '>>>');
    })();
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz, TICKETMASTER_API_KEY: '' },
    encoding: 'utf8',
  });
  const m = /<<<(.*)>>>/s.exec(out);
  assert.ok(m, `child produced no payload:\n${out}`);
  return JSON.parse(m[1]);
}

test('forecast hour labels follow the wall clock across a DST transition', () => {
  // 2026-11-01, America/New_York: 1 AM happens twice. Five hourly steps from
  // local midnight land on 12, 1, 1, 2, 3 — not 12, 1, 2, 3, 4.
  assert.deepEqual(
    forecastHoursInTz('America/New_York', '2026-11-01T04:00:00Z'),
    ['12 AM', '1 AM', '1 AM', '2 AM', '3 AM'],
    'fall back: the repeated hour must be labelled as it was scored');

  // 2026-03-08, America/New_York: 2 AM does not exist. Five steps land on
  // 12, 1, 3, 4, 5 — not 12, 1, 2, 3, 4.
  assert.deepEqual(
    forecastHoursInTz('America/New_York', '2026-03-08T05:00:00Z'),
    ['12 AM', '1 AM', '3 AM', '4 AM', '5 AM'],
    'spring forward: the skipped hour must not be labelled at all');

  // And on a zone with no transitions nothing changes.
  assert.deepEqual(
    forecastHoursInTz('UTC', '2026-11-01T00:00:00Z'),
    ['12 AM', '1 AM', '2 AM', '3 AM', '4 AM']);
});

// ---------------------------------------------------------------------------
// 5c. CACHE EVICTION MUST NOT TARGET THE HOTTEST KEYS.
//
// Map.set on a key that already exists keeps its ORIGINAL insertion position,
// so an oldest-first eviction over a map that is refreshed in place evicts the
// entries that are re-read most often — precisely backwards.
// services/weatherService.js setCache already documents finding and fixing
// exactly this ("the oldest-first eviction below was evicting the most
// frequently refreshed (i.e. hottest) keys"); this file's boundedSet had the
// same shape and had not been fixed. It costs money here too: every eviction of
// a live baseline / neighbour entry is another database round trip, and every
// eviction of an event entry is another paid Ticketmaster call.
// ---------------------------------------------------------------------------

test('a refreshed cache entry moves to the back of the eviction queue', () => {
  const { boundedSet, PREDICTOR_CACHE_MAX } = _internals;
  const MAX = PREDICTOR_CACHE_MAX;
  const map = new Map();
  for (let i = 0; i < MAX; i++) boundedSet(map, `k${i}`, i);
  assert.equal(map.size, MAX);

  // Refresh a key from part-way down the queue, NOT the very oldest one: an
  // eviction-before-insert that forgets to delete the key first happens to
  // re-seat the oldest key correctly (it evicts it and then re-adds it), so
  // testing k0 would let the bug through. k100 is the honest probe.
  boundedSet(map, 'k100', 'refreshed');
  // Now push 200 brand new keys through. With the refresh honoured, k100 is at
  // the back and survives; without it, k100 is still ~100th in line and goes.
  for (let i = 0; i < 200; i++) boundedSet(map, `new${i}`, i);

  assert.equal(map.get('k100'), 'refreshed',
    'the entry that was just refreshed must not be near the front of the eviction queue');
  assert.equal(map.size, MAX, 'and the ceiling is exactly a ceiling');
  assert.equal(map.has('k0'), false, 'while genuinely cold keys are the ones dropped');
});

test('boundedSet enforces a per-map ceiling and never grows past it', () => {
  const { boundedSet } = _internals;
  const map = new Map();
  for (let i = 0; i < 50; i++) {
    boundedSet(map, `k${i}`, i, 10);
    assert.ok(map.size <= 10, `size ${map.size} after ${i}`);
  }
  assert.equal(map.size, 10);
  // Re-inserting an existing key must not cost an unrelated entry.
  boundedSet(map, 'k49', 'again', 10);
  assert.equal(map.size, 10);
  assert.equal(map.get('k49'), 'again');
});

test('the event cache is bounded by the same helper as every other cache', async () => {
  const realFetch = global.fetch;
  const realKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = 'tm-test-key';
  try {
    // Every lookup is an empty result — the branch that used to carry its own
    // hand-inlined eviction rather than going through boundedSet. An
    // unbounded event cache is a memory leak keyed by caller-chosen
    // coordinates; a shrinking one buys back paid Ticketmaster calls.
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) });
    const ts = new Date('2026-08-14T23:00:00Z');
    const MAX = _internals.EVENT_CACHE_MAX;
    // Fill past the ceiling so the eviction branch actually runs — that is the
    // branch that carried the eviction twice.
    for (let i = 0; i < MAX + 40; i++) {
      await _internals.getNearbyEvents(10 + i * 0.001, 20 + i * 0.001, ts);
    }
    assert.equal(_internals.eventCacheSize(), MAX,
      'the cache must sit AT its ceiling, not one slot below it forever');
    // And STAY there. An insert that evicts twice makes the size oscillate
    // MAX / MAX-1, so a single sample can pass by luck; several cannot.
    for (let i = 0; i < 4; i++) {
      await _internals.getNearbyEvents(70 + i * 0.001, 80 + i * 0.001, ts);
      assert.equal(_internals.eventCacheSize(), MAX,
        `one insert must evict exactly one entry (after extra insert ${i})`);
    }

    // And the most recent lookups are the ones still remembered, so re-asking
    // is free rather than a second paid call.
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) }; };
    for (let i = MAX + 10; i < MAX + 40; i++) {
      await _internals.getNearbyEvents(10 + i * 0.001, 20 + i * 0.001, ts);
    }
    assert.equal(calls, 0, 'a remembered "no events here" must not be re-purchased');
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = realKey;
  }
});

// ---------------------------------------------------------------------------
// 6. WEATHER OUTAGE HONESTY on the ML path.
//
// weatherService's failure contract is null. The model has never seen
// "missing", so the vector carries the training run's climatology — but an
// imputed number is not evidence, and the response must not claim it is.
// ---------------------------------------------------------------------------

test('a weather outage lowers confidence and is left out of dataSourcesUsed', async () => {
  const venue = liveVenue({
    popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(50) })),
  });
  const withWx = await mlPredictor.predictBusyness(venue, WEATHER, new Date());
  const noWx = await mlPredictor.predictBusyness(venue, null, new Date());

  assert.equal(withWx.predictionMethod, 'ml');
  assert.ok(withWx.dataSourcesUsed.includes('weather'));

  if (noWx.predictionMethod === 'ml') {
    assert.ok(!noWx.dataSourcesUsed.includes('weather'),
      'climatology is not a reading and must not be reported as one');
    assert.equal(noWx.confidence, Math.max(0, withWx.confidence - 15),
      'the rule engine adds 15 for having weather; the ML path must give the same 15 back');
  } else {
    // The other honest answer: refuse the model and say so.
    assert.match(noWx.predictionMethod, /^rule_engine/);
  }
});

test('a missing reading imputes the training climatology, never 20 degrees', () => {
  // 20 was a °F fallback in an imperial pipeline: below freezing, every time
  // OpenWeatherMap was down. The replacement is prepare_features'
  // add_climate_anomaly climatology, which also makes temp_anomaly resolve to 0.
  const lat = 40.71;
  const month = 8;
  const norm = _internals.climateNorm(lat, month);
  assert.ok(Number.isFinite(norm), 'the shipped metadata carries temp_norms');
  assert.equal(_internals.tempForFeature(null, lat, month), norm);
  assert.equal(_internals.tempForFeature({}, lat, month), norm);
  assert.notEqual(norm, 20);

  const map = _internals.buildFeatureMap(
    liveVenue(), null, new Date(2026, 7, 14, 20, 0), null, null, 50, null);
  assert.equal(map.temperature, norm);
  assert.equal(map.temp_anomaly, 0, 'an imputed temperature is not an anomaly');
  assert.equal(map.cold_outdoor, 0);
  assert.equal(map.weather_unknown, 1, 'a missing reading lands in a bucket the model has seen');
  assert.equal(map.weather_clear, 0);
});

// ---------------------------------------------------------------------------
// 7. THE FORECAST METER (services/forecastUsage.js).
//
// It gates a paid product surface, so the two things that matter are that one
// account is one bucket and that a read never spends. services/birdieUsage.js
// states the rule this file was written to mirror: "'5' and 5 are the same
// account and must share one bucket, and anything that is not a real id is
// refused rather than handed a free lane."
// ---------------------------------------------------------------------------

const forecastUsage = require('../services/forecastUsage');

// A fresh id per test — the meter is a process-wide in-memory map.
let nextId = 900000;
const freshId = () => ++nextId;

test('forecast meter: a string id and a numeric id are one account', () => {
  const id = freshId();
  forecastUsage.recordView(id);
  forecastUsage.recordView(String(id));
  assert.equal(forecastUsage.getUsedThisMonth(id), 2,
    'two spellings of one user id must not mint two free allowances');
  assert.equal(forecastUsage.getUsedThisMonth(String(id)), 2);
});

test('forecast meter: an unusable id is refused, not given its own lane', () => {
  for (const bad of [null, undefined, 0, -1, 1.5, '', 'abc', {}, [], NaN, true]) {
    assert.equal(forecastUsage.recordView(bad), 0, `recordView(${String(bad)})`);
    assert.equal(forecastUsage.getUsedThisMonth(bad), 0, `getUsedThisMonth(${String(bad)})`);
  }
});

test('forecast meter: reading the meter never spends it', () => {
  const id = freshId();
  for (let i = 0; i < 5; i++) assert.equal(forecastUsage.getUsedThisMonth(id), 0);
  assert.equal(forecastUsage.recordView(id), 1);
  for (let i = 0; i < 5; i++) assert.equal(forecastUsage.getUsedThisMonth(id), 1);
});

test('forecast meter: counting is per account and monotonic', () => {
  const a = freshId();
  const b = freshId();
  for (let i = 1; i <= forecastUsage.FREE_MONTHLY_FORECASTS; i++) {
    assert.equal(forecastUsage.recordView(a), i);
  }
  assert.equal(forecastUsage.getUsedThisMonth(a), forecastUsage.FREE_MONTHLY_FORECASTS);
  assert.equal(forecastUsage.getUsedThisMonth(b), 0, 'one account spending does not spend another');
  // Past the free allowance the counter keeps climbing — gateForecast reads
  // `used >= limit`, so a counter that saturated would be a free allowance.
  assert.equal(forecastUsage.recordView(a), forecastUsage.FREE_MONTHLY_FORECASTS + 1);
});

test('forecast meter: the allowance is monthly, and a new month is a new allowance', () => {
  const id = freshId();
  forecastUsage.recordView(id);
  assert.equal(forecastUsage.getUsedThisMonth(id), 1);

  // Move a full month forward. monthKey() is `new Date().toISOString()`, so the
  // clock has to move for the zero-argument constructor specifically.
  // RESTORE IN `finally`: this is a global, and leaving it patched after a
  // failed assertion would silently corrupt every test that runs after it.
  const OriginalDate = global.Date;
  const SKEW = 45 * 24 * 60 * 60 * 1000;
  try {
    global.Date = class extends OriginalDate {
      constructor(...args) {
        if (args.length === 0) super(OriginalDate.now() + SKEW);
        else super(...args);
      }
      static now() { return OriginalDate.now() + SKEW; }
    };
    assert.equal(forecastUsage.getUsedThisMonth(id), 0, 'next month starts clean');
    assert.equal(forecastUsage.recordView(id), 1);
  } finally {
    global.Date = OriginalDate;
  }
  // And back on the real clock the stale record is gone, not resurrected.
  assert.equal(forecastUsage.getUsedThisMonth(id), 0,
    'the record now belongs to a month that is not this one');
});

// ---------------------------------------------------------------------------
// 8. WEATHER SERVICE — the parts __tests__/upstreamBudgets.test.js does not
// already pin. Everything here is about a failure never becoming a reading.
// ---------------------------------------------------------------------------

const weatherService = require('../services/weatherService');

test('weather: a 200 with a missing temperature is a failure, not 0 degrees', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const real = global.fetch;
  let calls = 0;
  try {
    global.fetch = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ main: {}, weather: [{ id: 800 }] }) };
    };
    assert.equal(await weatherService.getWeather(51.5, -0.12), null);
    // And it is remembered, so a broken upstream cannot re-charge the budget
    // once per request.
    assert.equal(await weatherService.getWeather(51.5, -0.12), null);
    assert.equal(calls, 1);
    assert.equal(weatherService.weatherBudgetStatus().dailyUsed, 1);
  } finally {
    global.fetch = real;
    weatherService.__resetWeatherState();
  }
});

test('weather: a coordinate that cannot be a coordinate never reaches the vendor', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const real = global.fetch;
  let calls = 0;
  try {
    global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ main: { temp: 70 }, weather: [{ id: 800 }] }) }; };
    for (const [lat, lon] of [[undefined, undefined], [null, null], ['', ''], [NaN, 0], [91, 0], [0, 181], [[], []], [false, false]]) {
      assert.equal(await weatherService.getWeather(lat, lon), null, `${String(lat)},${String(lon)}`);
    }
    assert.equal(calls, 0, 'an unanswerable question must not be paid for');
    assert.equal(weatherService.weatherBudgetStatus().dailyUsed, 0);
  } finally {
    global.fetch = real;
    weatherService.__resetWeatherState();
  }
});

test('weather: the readings it hands out are frozen, so one caller cannot poison the cache', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const real = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ main: { temp: 71.2, feels_like: 70, humidity: 44 }, wind: { speed: 6 }, weather: [{ id: 800, main: 'Clear', description: 'clear sky' }] }),
    });
    const a = await weatherService.getWeather(35.68, 139.69);
    assert.equal(Object.isFrozen(a), true);
    try { a.temp = -40; } catch { /* strict-mode throw is also fine */ }
    const b = await weatherService.getWeather(35.68, 139.69);
    assert.equal(b.temp, 71.2, 'a mutation by one consumer must not reach the next');
    // fetchedAt is the observation time, not "now" — a cache hit must not
    // relabel a 29-minute-old reading as live.
    assert.equal(b.fetchedAt, a.fetchedAt);
  } finally {
    global.fetch = real;
    weatherService.__resetWeatherState();
  }
});

test('weather: an explicitly null options argument is not a silent outage', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const real = global.fetch;
  try {
    global.fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => (String(url).includes('/forecast')
        ? { list: [{ dt_txt: '2026-08-15 12:00:00', main: { temp: 70 }, wind: { speed: 2 }, weather: [{ description: 'clear', icon: '01d' }] }] }
        : { main: { temp: 66, humidity: 50 }, wind: { speed: 3 }, weather: [{ id: 800, main: 'Clear' }] }),
    });
    // `opts = {}` is a DEFAULT, which only applies to `undefined`. An explicit
    // null threw on `opts.userId`, and the outer catch turned that into `return
    // null` — i.e. weather silently off for that call, indistinguishable from an
    // OpenWeatherMap outage. `getWeather(lat, lon, isUser ? { userId } : null)`
    // is an entirely natural thing for a caller to write.
    const r = await weatherService.getWeather(47.6, -122.3, null);
    assert.ok(r && r.temp === 66, 'a null options object is "no options", not "no weather"');
    const f = await weatherService.getForecast(47.6, -122.3, null);
    assert.notEqual(f, null);
  } finally {
    global.fetch = real;
    weatherService.__resetWeatherState();
  }
});

test('weather: the documented ceilings are the ones actually enforced', () => {
  const { limits } = weatherService.weatherBudgetStatus();
  // WX_DAILY was decided 2026-08-14: 950, UNDER OpenWeatherMap's free
  // 1,000/day (was 3000, spending past free unconfirmed). Pinned so a silent
  // change stays visible; raise only with a paid plan confirmed on an invoice.
  assert.equal(limits.daily, 950);
  assert.equal(limits.perMinute, 55);
  assert.equal(limits.perUserHourly, 40);
});

// ---------------------------------------------------------------------------
// 9. NUMBERS THAT REACH THE CLIENT.
// ---------------------------------------------------------------------------

test('every number in a prediction is a clean integer in range', async () => {
  const venue = liveVenue({
    popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(50) })),
  });
  const r = await mlPredictor.predictBusyness(venue, WEATHER, new Date());
  assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, `score ${r.score}`);
  assert.ok(Number.isInteger(r.confidence) && r.confidence >= 0 && r.confidence <= 100, `confidence ${r.confidence}`);
  assert.equal(r.label, mlPredictor.getLabel(r.score));
  assert.ok(Array.isArray(r.dataSourcesUsed));
});

test('the feature vector never carries NaN or Infinity, whatever the caller sends', () => {
  const nasty = [
    liveVenue({ rating: undefined, price_level: undefined, user_ratings_total: undefined }),
    liveVenue({ types: [], location: null }),
    liveVenue({ location: { latitude: null, longitude: null } }),
    liveVenue({ user_ratings_total: -5, rating: 0 }),
  ];
  for (const v of nasty) {
    const vec = _internals.buildFeatureVector(v, null, new Date(2026, 0, 1, 3, 0), null, null, 40, null);
    assert.equal(vec.length, META.feature_names.length);
    for (let i = 0; i < vec.length; i++) {
      assert.ok(Number.isFinite(vec[i]),
        `feature ${META.feature_names[i]} is ${vec[i]} for ${JSON.stringify(v.location)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 10. THE DEAD-FIELD TRIPWIRE. routes/crowd.js states that no route supplies
// `popular_times`, which makes storeGoogleBaselines' INSERT into the retraining
// corpus unreachable from every request path. That claim is load-bearing: it is
// the reason the batch endpoint is allowed to skip place-id shape validation.
// If it stops being true, the shape check has to be added in the same edit.
// ---------------------------------------------------------------------------

test('no route supplies popular_times, so the corpus write stays unreachable', () => {
  const routeDir = path.join(__dirname, '..', 'routes');
  const suppliers = fs.readdirSync(routeDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /popular_times\s*:/.test(fs.readFileSync(path.join(routeDir, f), 'utf8')));
  assert.deepEqual(suppliers, [],
    'a route now supplies popular_times: services/mlPredictor.js storeGoogleBaselines '
    + 'will start INSERTing into ml_venue_baselines under a place id that routes/crowd.js '
    + 'POST /batch does not shape-check. Add the check and update the tripwire comment.');
});
