// ---------------------------------------------------------------------------
// SERVE/TRAIN SKEW FIXES from the 106-feature hunt (2026-08-19). Four
// divergences between what the model was trained on and what serving hands it,
// each pinned here so it cannot quietly reopen:
//
//   (a) EVENT WINDOW SEMANTICS. Serving queried Ticketmaster for events
//       STARTING in [t, t+3h]; training (scripts/ml/enrichWithEvents.js
//       isHourInRange + scripts/ml/collectEvents.js estimateEndHour) counted
//       events ONGOING at the row hour — start hour through start + duration
//       (music/sports/family 3h, arts 2h), inclusive. So a 20:00 arena show
//       was invisible to serving at 21:00, mid-show — which is also why the
//       eventAlert banner vanished the moment a show began.
//   (b) STALE WEATHER ACROSS THE 24H STRIP. predictHourlyForecast scored all
//       24 slots with ONE current reading: 3 AM slots got 3 PM's temperature,
//       and "raining now" rained on tonight's dinner. Training rows each
//       carried the weather OF THEIR OWN HOUR. weatherService.getHourlyForecast
//       (OWM 3-hour list) now feeds each slot the reading nearest its own
//       instant, with the live reading kept for near-now slots.
//   (c) predictionMethod PER HOURLY ENTRY. A strip could silently mix ML and
//       rule-engine hours (a baseline exists at 19:00 but not 03:00) with
//       nothing in the payload saying which was which.
//   (d) CATEGORY-BASELINE FALLBACK. An out-of-vocab category key filled with
//       `|| 0`; training fills with the corpus global mean
//       (train/prepare_features.py add_baseline_features fillna(global_mean),
//       refined falls back to category). Latent today — no live caller produces
//       an out-of-vocab category — but worth 11 points if ever reached.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const crowdEngine = require('../services/crowdEngine');
const weatherService = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
const I = mlPredictor._internals;

const HOUR = 60 * 60 * 1000;
const CLEAR_WEATHER = { temp: 75, humidity: 50, windSpeed: 5, isRaining: false, conditionId: 800, conditions: 'clear sky' };

function tmEvent(name, startIso, segment, venueName) {
  return {
    name,
    classifications: [{ segment: { name: segment } }],
    dates: { start: { dateTime: startIso } },
    _embedded: { venues: [{ name: venueName || 'Test Hall', location: { latitude: '39.951', longitude: '-75.171' } }] },
  };
}

// ---------------------------------------------------------------------------
// (a) Event window: ongoing events count, future-only events do not, and the
//     per-type duration matches collectEvents.estimateEndHour.
// ---------------------------------------------------------------------------

test('skew (a): serving counts events ONGOING at the hour, training semantics', async () => {
  const realFetch = global.fetch;
  process.env.TICKETMASTER_API_KEY = 'skew-test-key';
  let capturedUrl;
  // Prediction instant mid-hour, so the hour-floor arithmetic is visible.
  const now = new Date('2026-08-21T23:30:00Z');
  const hourFloor = Math.floor(now.getTime() / HOUR) * HOUR;
  global.fetch = async (url) => {
    capturedUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { events: [
        // Started 90 min ago — mid-show. Training counted this; old serving
        // (events STARTING in the next 3h) could not see it.
        tmEvent('mid-show', new Date(now.getTime() - 90 * 60 * 1000).toISOString(), 'Music'),
        // Starts in 2h — old serving counted this; training did not (the row
        // hour is not inside the event's active window yet). Injected even
        // though the new query window would not return it, to pin the
        // per-event filter independently of the query.
        tmEvent('not-started', new Date(now.getTime() + 2 * HOUR).toISOString(), 'Music'),
      ] } }),
    };
  };
  try {
    I.__resetEventBudget();
    const r = await I.getNearbyEvents(39.95, -75.17, now, 424201);

    // Query window matches the ongoing semantics: starts 3h (the max event
    // duration) before the prediction hour, ends within the prediction hour.
    const qs = new URL(capturedUrl).searchParams;
    assert.equal(qs.get('startDateTime'),
      new Date(hourFloor - 3 * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      'window must open 3h back so ongoing events are visible');
    const windowEnd = Date.parse(qs.get('endDateTime'));
    assert.ok(windowEnd > hourFloor && windowEnd <= hourFloor + HOUR,
      'window must close within the prediction hour, not 3h of future starts (got ' + qs.get('endDateTime') + ')');

    assert.equal(r.hasEvent, true, 'the mid-show event must be visible while it is happening');
    assert.equal(r.totalEvents, 1, 'exactly the ongoing event — the not-yet-started one must not count');
    assert.equal(r.nearestName, 'mid-show');
  } finally {
    global.fetch = realFetch;
    delete process.env.TICKETMASTER_API_KEY;
    I.__resetEventBudget();
  }
});

test('skew (a): per-type durations match collectEvents.estimateEndHour (arts 2h, music 3h, inclusive)', async () => {
  const realFetch = global.fetch;
  process.env.TICKETMASTER_API_KEY = 'skew-test-key';
  const now = new Date('2026-08-21T23:30:00Z');
  const hourFloor = Math.floor(now.getTime() / HOUR) * HOUR;
  // Both started exactly 3 hour-slots ago. Training's isHourInRange is
  // inclusive of the end hour: a 3h music show still counts (20 -> 23), a 2h
  // arts show ended at 22 and does not.
  const startIso = new Date(hourFloor - 3 * HOUR).toISOString();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ _embedded: { events: [
      tmEvent('arts-ended', startIso, 'Arts & Theatre'),
      tmEvent('music-final-hour', startIso, 'Music'),
    ] } }),
  });
  try {
    I.__resetEventBudget();
    const r = await I.getNearbyEvents(39.952, -75.172, now, 424202);
    assert.equal(r.totalEvents, 1, 'the 2h arts show is over; the 3h music show is in its final counted hour');
    assert.equal(r.nearestName, 'music-final-hour');
    assert.equal(r.nearestType, 'music');
  } finally {
    global.fetch = realFetch;
    delete process.env.TICKETMASTER_API_KEY;
    I.__resetEventBudget();
  }
});

// ---------------------------------------------------------------------------
// (b) Per-hour forecast weather in the 24h strip.
// ---------------------------------------------------------------------------

test('skew (b): 24h strip consumes per-slot forecast weather, one upstream call, live reading near now', async () => {
  const realGetHourly = weatherService.getHourlyForecast;
  const park = {
    place_id: 'skew-park-test',
    types: ['park', 'tourist_attraction', 'point_of_interest'],
    rating: 4.7, price_level: 0, user_ratings_total: 1200,
    location: { latitude: 39.95, longitude: -75.17 },
  };
  const base = new Date();
  const startHour = base.getHours();
  const slot0 = new Date(base); slot0.setHours(startHour, 0, 0, 0);
  let calls = 0;
  try {
    // Forecast says heavy rain for every upcoming slot; the live reading is
    // clear. A park's rule-engine weather factor separates the two by ~20
    // points, and the ML features (is_raining, temperature) move too.
    weatherService.getHourlyForecast = async () => {
      calls++;
      const entries = [];
      for (let i = 0; i <= 30; i++) {
        entries.push({
          at: slot0.getTime() + i * HOUR,
          temp: 60, feelsLike: 58, humidity: 95, windSpeed: 12,
          conditions: 'heavy intensity rain', conditionId: 502, isRaining: true,
        });
      }
      return entries;
    };
    const withForecast = await mlPredictor.predictHourlyForecast(park, CLEAR_WEATHER, startHour, 24, new Date(base));
    assert.equal(calls, 1, 'one hourly-forecast fetch per 24h card, not one per slot');

    // Outage path: no forecast available, every slot falls back to the live
    // reading — the pre-fix behavior, kept as the honest degradation.
    weatherService.getHourlyForecast = async () => null;
    const withoutForecast = await mlPredictor.predictHourlyForecast(park, CLEAR_WEATHER, startHour, 24, new Date(base));

    assert.equal(withForecast.length, 24);
    assert.equal(withoutForecast.length, 24);

    // Near-now slots keep the live observation (it is a measurement; the
    // forecast is a model), so entry 0 must agree between the two runs.
    assert.equal(withForecast[0].score, withoutForecast[0].score,
      'slot 0 is scored on the live reading in both runs');

    // Tail hours must diverge: rain at the slot vs the clear now-reading.
    const tailDiffers = withForecast.slice(3).some((h, i) => h.score !== withoutForecast[i + 3].score);
    assert.ok(tailDiffers,
      'per-slot forecast weather must reach the tail hours (rain vs clear changed nothing)');
  } finally {
    weatherService.getHourlyForecast = realGetHourly;
  }
});

test('skew (b): weatherForSlot picks the nearest entry, live reading near now, live fallback past the horizon', () => {
  const now = Date.parse('2026-08-21T18:20:00Z');
  const live = CLEAR_WEATHER;
  const entries = [
    { at: now + 2 * HOUR, temp: 61, isRaining: true },
    { at: now + 5 * HOUR, temp: 58, isRaining: true },
  ];
  // Near now (within 90 min): the observation wins.
  assert.equal(I.weatherForSlot(entries, now + 30 * 60 * 1000, live, now), live);
  // Farther out: nearest forecast entry.
  assert.equal(I.weatherForSlot(entries, now + 2 * HOUR + 20 * 60 * 1000, live, now), entries[0]);
  assert.equal(I.weatherForSlot(entries, now + 4 * HOUR + 30 * 60 * 1000, live, now), entries[1]);
  // Past the forecast horizon (no entry within 90 min): live reading, honestly stale.
  assert.equal(I.weatherForSlot(entries, now + 20 * HOUR, live, now), live);
  // No forecast at all: live reading.
  assert.equal(I.weatherForSlot(null, now + 6 * HOUR, live, now), live);
  assert.equal(I.weatherForSlot([], now + 6 * HOUR, live, now), live);
});

// ---------------------------------------------------------------------------
// (c) predictionMethod on every hourly entry, end to end.
// ---------------------------------------------------------------------------

test('skew (c): every hourly entry says which engine scored it', async () => {
  const venue = {
    place_id: 'skew-method-test',
    types: ['restaurant', 'food'],
    rating: 4.4, price_level: 2, user_ratings_total: 800,
    location: { latitude: 39.95, longitude: -75.17 },
  };
  const fc = await mlPredictor.predictHourlyForecast(venue, CLEAR_WEATHER, 19, 6, new Date());
  assert.equal(fc.length, 6);
  for (const h of fc) {
    assert.equal(typeof h.predictionMethod, 'string',
      'entry ' + h.hour + ' must carry predictionMethod (got ' + h.predictionMethod + ')');
    assert.ok(h.predictionMethod.length > 0);
  }

  const rules = crowdEngine.generateHourlyForecast(venue, CLEAR_WEATHER, 19, 6, new Date());
  for (const h of rules) {
    assert.equal(h.predictionMethod, 'rule_engine',
      'the pure rule-engine strip labels every entry rule_engine');
  }
});

test('skew (c): publicCrowd forwards predictionMethod per hourly entry (source contract)', () => {
  // Same style as calibrationQueries.test.js pinning SQL text: the public demo
  // rebuilds each hourly entry field by field, so a dropped field there is
  // silent. routes/crowd.js spreads `...h` and needs no pin.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'publicCrowd.js'), 'utf8');
  assert.match(src, /predictionMethod:\s*h\.predictionMethod/,
    'routes/publicCrowd.js hourly map must forward h.predictionMethod');
});

// ---------------------------------------------------------------------------
// (d) Category-baseline fallback matches training's global-mean fill.
// ---------------------------------------------------------------------------

test('skew (d): categoryGlobalMean — explicit metadata key wins, else the table mean', () => {
  assert.equal(I.categoryGlobalMean({ category_baselines: { a_0_0: 40, b_0_0: 60 } }), 50);
  assert.equal(I.categoryGlobalMean({
    category_global_mean: 58.7,
    category_baselines: { a_0_0: 40, b_0_0: 60 },
  }), 58.7);
  // Junk values cannot poison the mean.
  assert.equal(I.categoryGlobalMean({ category_baselines: { a_0_0: 40, b_0_0: 'junk', c_0_0: 60 } }), 50);
  // Nothing to average: null, and the caller's last-resort 0 applies.
  assert.equal(I.categoryGlobalMean({ category_baselines: {} }), null);
  assert.equal(I.categoryGlobalMean({}), null);
});

test('skew (d): out-of-vocab category fills with the global mean, refined falls back to category (training fillna chain)', async () => {
  assert.equal(await mlPredictor.init(), true,
    'the checked-in artifact must load — same doctrine as mlPredictorHarness.test.js');
  const meta = I.getMetadata();
  const venue = {
    place_id: 'skew-cat-test',
    types: ['restaurant', 'food', 'point_of_interest'],
    rating: 4.4, price_level: 2, user_ratings_total: 800,
    location: { latitude: 39.95, longitude: -75.17 },
  };
  const ts = new Date(2026, 7, 21, 19, 0, 0); // Fri 19:00
  const noEv = { hasEvent: false, nearestAttendance: 0, totalEvents: 0, totalAttendance: 0, nearestType: null, nearestDistance: 0 };
  const noFb = { avgCrowd: 0, count: 0, avgErrorMapped: 0, avgErrorLegacy: 0 };
  const nb = { count: 0, mean: 0 };
  const build = () => I.buildFeatureMap(venue, CLEAR_WEATHER, ts, noEv, noFb, 60, nb);

  // In-vocab sanity: the real table answers for this venue.
  const cat = I.guessCategory(venue.types);
  const realKey = cat + '_' + ts.getDay() + '_' + ts.getHours();
  const inVocab = build();
  if (Number.isFinite(Number((meta.category_baselines || {})[realKey]))) {
    assert.equal(inVocab.category_baseline, Number(meta.category_baselines[realKey]));
  }

  const savedCat = meta.category_baselines;
  const savedRef = meta.refined_baselines;
  try {
    // A table that has never seen this category: both fills must be the
    // training global mean (here, the swapped table's mean: 50), never 0.
    meta.category_baselines = { zzz_0_0: 40, zzz_0_1: 60 };
    meta.refined_baselines = {};
    const orphan = build();
    assert.equal(orphan.category_baseline, 50,
      'unknown category must fill with global mean — `|| 0` was an 11-point skew if ever reached');
    assert.equal(orphan.refined_category_baseline, 50,
      'refined falls back through category to the same fill (prepare_features fillna chain)');

    // Refined missing but category present: refined = category value.
    meta.category_baselines = { ...savedCat };
    meta.refined_baselines = {};
    const noRefined = build();
    assert.equal(noRefined.refined_category_baseline, noRefined.category_baseline);
  } finally {
    meta.category_baselines = savedCat;
    meta.refined_baselines = savedRef;
  }
});

// ---------------------------------------------------------------------------
// (e) THE CLIMATE ANOMALY OUTSIDE THE ARTIFACT'S CLIMATOLOGY (2026-08-26).
//
// prepare_features.add_climate_anomaly builds temp_norms by grouping the TRAIN
// SPLIT on (5-degree latitude band, month), so a key exists exactly when
// training rows exist for it. v2.6.0-starling's corpus is one spring, its last
// row is 2026-05-18, and all four season one-hots are declared constant slots.
// The table therefore holds months 3, 4 and 5 and nothing else.
//
// climateNorm's miss fell through to the mean of the whole table, 66.01F on
// this artifact, which is a spring average taken across every latitude from
// -35 to 55. Subtracting it from a live reading gave a "seasonal anomaly" of
// +16.0 on a normal August evening in the Lehigh Valley and -25.0, the clip
// floor, on a normal December one, and pinned is_warm_anomaly_evening at 1 for
// the whole summer. Measured against the shipped graph, 72 venue-hours per
// month over bar/cafe/restaurant: worth 0.035 points inside the corpus months,
// 0.260 in August and 2.049 (max 7.069) in December.
//
// The fix is monthClimateNorm: with no norm for the month there is no anomaly
// to state, so the slot carries 0, the centre of the trained distribution and
// the value an imputed temperature already produced. Mirroring the Python
// fillna would not have been parity, because that fill never described one
// training row.
// ---------------------------------------------------------------------------

const CORPUS_MONTHS = [3, 4, 5];

test('skew (e): the shipped artifact carries climatology for the corpus spring only', async () => {
  assert.equal(await mlPredictor.init(), true);
  const norms = I.getMetadata().temp_norms || {};
  const keys = Object.keys(norms);
  assert.ok(keys.length > 0, 'the artifact must carry temp_norms at all');
  const months = [...new Set(keys.map((k) => Number(k.split('_')[1])))].sort((a, b) => a - b);
  assert.deepEqual(months, CORPUS_MONTHS,
    'if a retrain widens the corpus past spring this test is the notice, and the '
    + 'null branch in monthClimateNorm stops firing on its own');
});

test('skew (e): monthClimateNorm answers only for a month the artifact has, climateNorm still imputes', async () => {
  assert.equal(await mlPredictor.init(), true);
  const norms = I.getMetadata().temp_norms || {};
  const LAT = 40.6; // Lehigh Valley, band 40

  const may = I.monthClimateNorm(LAT, 5);
  assert.equal(may, Number(norms['40_5']), 'an in-corpus month reads its own band/month cell');

  assert.equal(I.monthClimateNorm(LAT, 8), null, 'August has no cell, so there is no normal to state');
  assert.equal(I.monthClimateNorm(LAT, 12), null);

  // tempForFeature's job is different and its fallback is untouched: with no
  // reading it still needs an in-range temperature to impute, and the
  // alternative is dropping the venue to the rule engine.
  const global = I.climateNorm(LAT, 8);
  assert.ok(Number.isFinite(global), 'climateNorm must still answer with the table mean');
  assert.equal(I.tempForFeature({}, LAT, 8), global);
  assert.equal(I.climateNorm(LAT, 5), may, 'an in-corpus month is the same number through both doors');
});

test('skew (e): outside the corpus months the vector claims no anomaly, and a normal December is not 25 degrees cold', async () => {
  assert.equal(await mlPredictor.init(), true);
  const venue = {
    place_id: 'skew-anomaly-test',
    types: ['bar', 'restaurant', 'food'],
    rating: 4.4, price_level: 2, user_ratings_total: 900,
    location: { latitude: 40.6, longitude: -75.37 },
  };
  const noEv = { hasEvent: false, nearestAttendance: 0, totalEvents: 0, totalAttendance: 0, nearestType: null, nearestDistance: 0 };
  const noFb = { avgCrowd: 0, count: 0, avgErrorMapped: 0, avgErrorLegacy: 0 };
  const nb = { count: 0, mean: 0 };
  const at = (monthIndex, day, hour, temp) => I.buildFeatureMap(
    venue, { ...CLEAR_WEATHER, temp }, new Date(2026, monthIndex, day, hour, 0, 0), noEv, noFb, 55, nb,
  );

  // August, a warm evening. Before the fix this read +15.99 and 1.
  const aug = at(7, 15, 20, 82);
  assert.equal(aug.temp_anomaly, 0);
  assert.equal(aug.is_warm_anomaly_evening, 0,
    'a normal summer evening is not a warm ANOMALY, and this slot sat at 1 all summer');

  // December, a normal cold evening. Before the fix this sat on the clip floor.
  const dec = at(11, 15, 20, 34);
  assert.equal(dec.temp_anomaly, 0);
  assert.notEqual(dec.temp_anomaly, -25, 'the -25 clip is an extreme, not an ordinary December');

  // Inside the corpus months nothing changed: the real deviation still ships,
  // and it still drives the evening flag.
  const norm5 = I.monthClimateNorm(40.6, 5);
  const may = at(4, 15, 20, 82);
  assert.equal(may.temp_anomaly, Math.max(-25, Math.min(25, 82 - norm5)));
  assert.ok(may.temp_anomaly > 5);
  assert.equal(may.is_warm_anomaly_evening, 1);

  // The flag is an EVENING flag on both sides of the change.
  assert.equal(at(4, 15, 11, 82).is_warm_anomaly_evening, 0, 'hour 11 is not the evening');
});

test('skew (e): an imputed temperature still lands on anomaly 0, in and out of the corpus months', async () => {
  assert.equal(await mlPredictor.init(), true);
  const venue = {
    place_id: 'skew-anomaly-impute',
    types: ['cafe', 'coffee_shop', 'food'],
    rating: 4.2, price_level: 1, user_ratings_total: 300,
    location: { latitude: 40.6, longitude: -75.37 },
  };
  const noEv = { hasEvent: false, nearestAttendance: 0, totalEvents: 0, totalAttendance: 0, nearestType: null, nearestDistance: 0 };
  const noFb = { avgCrowd: 0, count: 0, avgErrorMapped: 0, avgErrorLegacy: 0 };
  // No temperature anywhere in the reading: tempForFeature imputes.
  const noTemp = { humidity: 50, windSpeed: 5, isRaining: false, conditionId: 800 };
  for (const monthIndex of [4, 7, 11]) {
    const f = I.buildFeatureMap(venue, noTemp, new Date(2026, monthIndex, 15, 20, 0, 0), noEv, noFb, 55, { count: 0, mean: 0 });
    assert.equal(f.temp_anomaly, 0, `month index ${monthIndex}: an imputed reading claims no anomaly`);
    assert.equal(f.is_warm_anomaly_evening, 0);
    assert.ok(Number.isFinite(f.temperature), 'the temperature slot itself is still filled, not zeroed');
  }
});
