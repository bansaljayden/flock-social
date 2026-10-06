// ---------------------------------------------------------------------------
// A VENUE WITH NO CURVE OF ITS OWN: CROWD_NO_CURVE_FALLBACK.
//
// services/mlPredictor.js can answer the no-baseline exit with the shipped
// artifact's category_baselines value instead of the rule engine, for a venue
// with 200 or more Google reviews and no ml_venue_baselines row at all. What
// this file pins, against the real artifact's metadata with Postgres scripted
// and the ONNX session stubbed to throw (so any model run on these paths
// would show up as rule_engine_fallback):
//
//   * switched off (unset, empty, or any value that is not exactly
//     "category_curve"), a venue with no curve gets today's answer, compared
//     whole, and the presence probe is never sent; a bad value warns once;
//   * switched on, every gate sends the venue back to today's answer on its
//     own: under 200 reviews, any baseline row at all (a curve that is zero at
//     this hour included), a refused or failed baseline lookup, a popular_times
//     payload, no usable place id, an unknown or non-finite table value,
//     another artifact version;
//   * the answer: the table's value rounded and clamped, its tag, a null model
//     version, its sources, baselineScore, and the figure it publishes
//     (within-15 41.3 on 4,248 rows) with its population;
//   * the row: guessCategory over the first three Google types, the ones the
//     table was measured on, never the whole list, and only when those types
//     name one of its categories (an airport, a hotel or no types at all is
//     not given the catch-all restaurant row);
//   * the presence probe: cached (a no for an hour, a yes for a day), charged
//     to the venue-lookup budget, and silent on a refusal or a failure;
//   * the strip, the coverage counter, and the words crowdEngine gives it.
//
// __tests__/noCurveFallbackSurfaces.test.js takes the same number through the
// real routes. No network, no database. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
delete process.env.TICKETMASTER_API_KEY;
delete process.env.ML_SHIP_GATE_OVERRIDE;
for (const k of ['CROWD_NO_CURVE_FALLBACK', 'CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED']) delete process.env[k];

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const crowdEngine = require('../services/crowdEngine');

const MOD = require.resolve('../services/mlPredictor');
const ORT = require.resolve('onnxruntime-node');
const DB = require.resolve('../config/database');
const META_FILE = path.join(__dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json');
const META = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));

const SWITCH = 'CROWD_NO_CURVE_FALLBACK';
const ON = 'category_curve';
const METHOD = 'category_curve_no_baseline';
const SWITCH_ENV = [SWITCH, 'CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED'];

// Friday 2026-09-04, 9 PM on the venue's wall clock (this process runs UTC).
const TS = new Date(Date.UTC(2026, 8, 4, 21, 0, 0));
const DOW = TS.getDay();
const HOUR = TS.getHours();
const WX = { temp: 70, humidity: 50, windSpeed: 4, isRaining: false, conditionId: 800 };

let seq = 0;
const placeIdFor = (tag) => `ChIJnocurve${tag}${String(++seq).padStart(6, '0')}`;

// A bar with 900 reviews and, unless a test gives it rows, no curve at all.
function venue(over = {}) {
  return {
    place_id: placeIdFor('V'),
    name: 'No Curve Bar',
    types: ['bar', 'restaurant', 'food'],
    rating: 4.4,
    price_level: 2,
    user_ratings_total: 900,
    location: { latitude: 40.61, longitude: -75.38 },
    ...over,
  };
}

const tableValue = (category, dow = DOW, hour = HOUR) => META.category_baselines[`${category}_${dow}_${hour}`];

// What the no-baseline exit answers today: the rule engine's own result plus
// the four fields the exit sets. No Ticketmaster key in this process, so the
// lookup says why it saw nothing.
function todaysAnswer(v, weather, ts, method = 'rule_engine_no_baseline') {
  return {
    ...crowdEngine.calculateCrowdScore(v, weather, ts),
    predictionMethod: method,
    modelVersion: null,
    eventsObserved: false,
    eventsUnavailableReason: 'no_api_key',
  };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// A scripted Postgres. `curves` maps a place id to its ml_venue_baselines rows
// as { 'day_hour': baseline }; a place id it does not name has no row at all.
// `fail` is a pattern for statements that throw.
function scriptedDb({ curves = {}, fail = null } = {}) {
  const sent = [];
  const rowsOf = (placeId) => Object.entries(curves[placeId] || {}).map(([k, v]) => {
    const [d, h] = k.split('_').map(Number);
    return { day_of_week: d, hour: h, baseline: String(v), source: 'collected', updated_at: new Date() };
  });
  const query = async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    sent.push({ sql, params });
    if (fail && fail.test(sql)) throw new Error('scripted failure');
    if (/^SELECT 1 FROM ml_venue_baselines WHERE google_place_id = \$1 LIMIT 1$/.test(sql)) {
      return { rows: rowsOf(params[0]).length ? [{ '?column?': 1 }] : [] };
    }
    if (/FROM ml_venue_baselines WHERE google_place_id = \$1 AND \(/.test(sql)) {
      const slots = [[params[1], params[2]], [params[3], params[4]], [params[5], params[6]]];
      return { rows: rowsOf(params[0]).filter((r) => slots.some(([d, h]) => r.day_of_week === d && r.hour === h)) };
    }
    if (/^SELECT day_of_week, hour, baseline, source, updated_at FROM ml_venue_baselines WHERE google_place_id = \$1$/.test(sql)) {
      return { rows: rowsOf(params[0]) };
    }
    if (/FROM venue_feedback/.test(sql)) return { rows: [{}] };
    return { rows: [] };
  };
  const presence = () => sent.filter((s) => /^SELECT 1 FROM ml_venue_baselines/.test(s.sql));
  return { query, sent, presence };
}

// The shape a real artifact presents, so every load gate opens, and a run()
// that throws: nothing in this file may reach the model.
function stubOrt() {
  const inputName = META.onnx_input_name || 'input';
  const session = {
    inputNames: [inputName],
    outputNames: ['variable'],
    inputMetadata: [{ name: inputName, isTensor: true, type: 'float32', shape: ['', META.feature_names.length] }],
    outputMetadata: [{ name: 'variable', isTensor: true, type: 'float32', shape: ['', 1] }],
    run: async () => { throw new Error('the model ran on a path that must not run it'); },
  };
  return {
    InferenceSession: { create: async () => session },
    Tensor: class Tensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
  };
}

// A fresh predictor on `db`, with the switches set to `env` for the whole call
// (they are read at call time) and the metadata rewritten on the way in when
// `mutateMeta` is given. Load logs are kept out of the test output.
async function withPredictor({ db = scriptedDb(), env = {}, mutateMeta } = {}, fn) {
  const saved = Object.fromEntries(SWITCH_ENV.map((k) => [k, process.env[k]]));
  const savedMod = require.cache[MOD];
  const savedOrt = require.cache[ORT];
  const savedDb = require.cache[DB];
  const realReadFileSync = fs.readFileSync;
  for (const k of SWITCH_ENV) delete process.env[k];
  Object.assign(process.env, env);
  try {
    require.cache[ORT] = { id: ORT, filename: ORT, loaded: true, exports: stubOrt() };
    require.cache[DB] = { id: DB, filename: DB, loaded: true, exports: db };
    if (mutateMeta) {
      fs.readFileSync = (p, ...rest) => (String(p).endsWith('model_metadata.json')
        ? JSON.stringify(mutateMeta(JSON.parse(realReadFileSync(META_FILE, 'utf8'))))
        : realReadFileSync(p, ...rest));
    }
    delete require.cache[MOD];
    const predictor = require(MOD);
    const quiet = console.log;
    console.log = () => {};
    try {
      assert.equal(await predictor.init(), true, 'the artifact must load: this file is about what it serves');
    } finally {
      console.log = quiet;
    }
    return await fn(predictor, db);
  } finally {
    fs.readFileSync = realReadFileSync;
    delete require.cache[MOD];
    if (savedOrt) require.cache[ORT] = savedOrt; else delete require.cache[ORT];
    if (savedDb) require.cache[DB] = savedDb; else delete require.cache[DB];
    if (savedMod) require.cache[MOD] = savedMod;
    for (const k of SWITCH_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// console.warn, captured for the length of fn.
async function capturingWarnings(fn) {
  const warned = [];
  const real = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = real;
  }
  return warned;
}

const FALLBACK_KEYS = ['baselineData', 'baselineScore', 'confidence', 'confidenceMeasurement', 'dataSourcesUsed',
  'eventsObserved', 'eventsUnavailableReason', 'factors', 'label', 'modelVersion', 'predictionMethod', 'score'];

// ---------------------------------------------------------------------------
// 1. Off: exactly today's answer.
// ---------------------------------------------------------------------------

test('switched off, a venue with no curve gets exactly today\'s answer, and no presence probe is sent', async () => {
  const statements = [];
  for (const env of [{}, { [SWITCH]: '' }]) {
    await withPredictor({ env }, async (p, db) => {
      const v = venue();
      const r = await p.predictBusyness(v, WX, TS);
      assert.deepStrictEqual(r, todaysAnswer(v, WX, TS), `${JSON.stringify(env)}: the whole response is today's`);
      assert.equal(db.presence().length, 0, 'switched off, nothing new is read');
      assert.equal(p._internals.noCurveFallbackEnabled(), false);
      assert.equal(p.noCurveFallbackEnabled(), false);
      assert.equal(p.predictionCoverage().noCurveFallback, false);
      assert.equal(p.predictionCoverage().categoryCurve, 0);
      // The strip, too: every hour today's tag, and no source named.
      assert.equal(p._internals.hourlyAttributionOn(), false);
      const strip = await p.predictHourlyForecast(v, WX, 19, 4, TS);
      for (const h of strip) {
        assert.equal(h.predictionMethod, 'rule_engine_no_baseline', h.hour);
        assert.ok(!('numberSource' in h) && !('liveReadings' in h), h.hour);
        assert.equal(h.baselineScore, null, h.hour);
      }
      statements.push(db.sent.map((s) => s.sql));
    });
  }
  assert.deepStrictEqual(statements[0], statements[1], 'unset and empty send the same statements');
});

test('a value that is not exactly "category_curve" leaves it off, and says so once', async () => {
  for (const value of ['CATEGORY_CURVE', ' category_curve', 'category_curve ', 'category-curve', 'true', '1', 'on', 'curve_offset']) {
    const warned = await capturingWarnings(() => withPredictor({ env: { [SWITCH]: value } }, async (p, db) => {
      for (let i = 0; i < 3; i++) assert.equal(p._internals.noCurveFallbackEnabled(), false, JSON.stringify(value));
      const v = venue();
      assert.deepStrictEqual(await p.predictBusyness(v, WX, TS), todaysAnswer(v, WX, TS), JSON.stringify(value));
      assert.deepStrictEqual(await p.predictBusyness(v, WX, TS), todaysAnswer(v, WX, TS));
      assert.equal(db.presence().length, 0);
    }));
    const mine = warned.filter((w) => w.includes(SWITCH));
    assert.equal(mine.length, 1, `${JSON.stringify(value)}: one warning, not one per prediction`);
    assert.ok(mine[0].includes(JSON.stringify(value)) && mine[0].includes(`"${ON}"`), mine[0]);
  }
  for (const env of [{}, { [SWITCH]: '' }, { [SWITCH]: ON }]) {
    const warned = await capturingWarnings(() => withPredictor({ env }, async (p) => {
      p._internals.noCurveFallbackEnabled();
      await p.predictBusyness(venue(), WX, TS);
    }));
    assert.equal(warned.filter((w) => w.includes(SWITCH)).length, 0, `${JSON.stringify(env)} is not a bad value`);
  }
});

// ---------------------------------------------------------------------------
// 2. On: the table's typical level, and every gate.
// ---------------------------------------------------------------------------

test('switched on, a venue with 200+ reviews and no row at all gets the table\'s typical level for its category at that hour', async () => {
  await withPredictor({ env: { [SWITCH]: ON } }, async (p, db) => {
    const v = venue();
    const r = await p.predictBusyness(v, WX, TS);
    const value = Math.round(tableValue('bar'));
    assert.equal(value, 67, 'bar, Friday 9 PM, on the shipped table (66.6)');
    assert.deepStrictEqual(r, {
      score: value,
      label: crowdEngine.getLabel(value),
      confidence: 41,
      factors: {},
      dataSourcesUsed: ['google_places', 'category_curve'],
      predictionMethod: METHOD,
      modelVersion: null,
      confidenceMeasurement: {
        status: 'measured',
        means: 'measured_accuracy',
        metric: 'within_15_category_curve_no_baseline',
        population: p._internals.NO_CURVE_FALLBACK_POPULATION,
        populationRows: 4248,
        measuredPercent: 41.3,
        weatherPenalty: 0,
      },
      eventsObserved: false,
      eventsUnavailableReason: 'no_api_key',
      baselineData: null,
      baselineScore: value,
    });
    assert.deepStrictEqual(Object.keys(r).sort(), FALLBACK_KEYS);
    // Not the rule engine's number, and not anything the model or the
    // weather made.
    assert.notEqual(r.score, crowdEngine.calculateCrowdScore(v, WX, TS).score);
    for (const s of ['ml_model', 'weather', 'ticketmaster_events', 'recent_live_readings', 'venue_data']) {
      assert.ok(!r.dataSourcesUsed.includes(s), s);
    }
    // One presence probe, for this venue, and a second prediction reads the cache.
    assert.deepStrictEqual(db.presence().map((s) => s.params), [[v.place_id]]);
    const again = await p.predictBusyness(v, WX, TS);
    assert.deepStrictEqual(again, r);
    assert.equal(db.presence().length, 1);
    assert.equal(p.noCurveFallbackEnabled(), true);
  });
});

test('the category is guessCategory(types), the hour and weekday are the scored timestamp\'s, and the value is rounded and clamped', async () => {
  const club = { types: ['night_club', 'bar'] };
  await withPredictor({ env: { [SWITCH]: ON } }, async (p) => {
    const r = await p.predictBusyness(venue(club), WX, TS);
    assert.equal(r.score, Math.round(tableValue('nightclub')), 'night_club is a nightclub, not a bar');
    const late = new Date(Date.UTC(2026, 8, 7, 4, 0, 0)); // Monday 4 AM
    const r2 = await p.predictBusyness(venue(), WX, late);
    assert.equal(r2.score, Math.round(tableValue('bar', 1, 4)));
    // A restaurant is named by its own types (guessCategory has no test for
    // one: it is what is left over), and then it gets the restaurant row.
    const r3 = await p.predictBusyness(venue({ types: ['italian_restaurant', 'food', 'point_of_interest'] }), WX, TS);
    assert.equal(r3.predictionMethod, METHOD);
    assert.equal(r3.score, Math.round(tableValue('restaurant')));
  });
  for (const [stored, served] of [[150, 100], [-5, 0], [0.4, 0], [99.5, 100]]) {
    await withPredictor({
      env: { [SWITCH]: ON },
      mutateMeta: (m) => ({ ...m, category_baselines: { ...m.category_baselines, [`bar_${DOW}_${HOUR}`]: stored } }),
    }, async (p) => {
      const r = await p.predictBusyness(venue(), WX, TS);
      assert.equal(r.predictionMethod, METHOD, String(stored));
      assert.equal(r.score, served, String(stored));
      assert.equal(r.label, crowdEngine.getLabel(served));
      // A zero is not an ordering axis, the same rule the model path keeps.
      assert.equal(r.baselineScore, served > 0 ? served : null);
    });
  }
});

test('the category is read off the first three Google types, the ones the table was measured on', async () => {
  // The study read google_type_1..3 (types[0..2] of the same Places array the
  // card passes whole). A bar fourth in the list was never part of what it
  // scored: this place was measured with the restaurant row.
  const types = ['american_restaurant', 'restaurant', 'food', 'bar', 'point_of_interest', 'establishment'];
  const restaurant = Math.round(tableValue('restaurant'));
  assert.notEqual(restaurant, Math.round(tableValue('bar')), 'the two rows differ at this hour');
  await withPredictor({ env: { [SWITCH]: ON } }, async (p) => {
    assert.equal(p._internals.NO_CURVE_FALLBACK_TYPES_READ, 3);
    const r = await p.predictBusyness(venue({ types }), WX, TS);
    assert.equal(r.predictionMethod, METHOD);
    assert.equal(r.score, restaurant, 'the row of the three types it was measured on, not the bar fourth');
    // Third is inside them, and a club fourth is still not read.
    const clubFourth = ['restaurant', 'food', 'bar', 'night_club'];
    assert.notEqual(Math.round(tableValue('bar')), Math.round(tableValue('nightclub')));
    const r2 = await p.predictBusyness(venue({ types: clubFourth }), WX, TS);
    assert.equal(r2.score, Math.round(tableValue('bar')));
  });
});

test('a place the table has no row for keeps today\'s answer: guessCategory\'s catch-all restaurant is not a category', async () => {
  // guessCategory answers 'restaurant' for any list it does not recognise and
  // for none. Served, every one of these would get the restaurant row as what
  // is typical for its kind of place, with a figure measured on none of them.
  const unnamed = [
    ['airport', 'point_of_interest', 'establishment'],
    ['lodging', 'point_of_interest', 'establishment'],
    ['car_repair', 'point_of_interest', 'establishment'],
    ['hospital', 'health', 'point_of_interest'],
    ['stadium', 'sports_complex', 'arena'],
    // 'food' is on supermarkets; it names no restaurant.
    ['supermarket', 'grocery_store', 'food'],
    // A restaurant fourth is past the three types the table was measured on.
    ['hotel', 'lodging', 'point_of_interest', 'restaurant'],
    // guessCategory names none of these either, so the study scored this bar
    // on the restaurant row; it keeps the rule engine now.
    ['bar_and_grill', 'gastropub', 'sports_bar'],
    // No types, or types that are not a list, name nothing.
    [], 'bar', null, undefined,
  ];
  await withPredictor({ env: { [SWITCH]: ON } }, async (p, db) => {
    for (const types of unnamed) {
      const v = venue({ types });
      assert.deepStrictEqual(await p.predictBusyness(v, WX, TS), todaysAnswer(v, WX, TS), JSON.stringify(types));
    }
    assert.equal(db.presence().length, 0, 'every one refused before the probe');
    // A restaurant its types name keeps the row, with or without the plain type.
    for (const types of [['restaurant', 'food', 'point_of_interest'], ['sushi_restaurant', 'point_of_interest', 'establishment']]) {
      const r = await p.predictBusyness(venue({ types }), WX, TS);
      assert.equal(r.predictionMethod, METHOD, JSON.stringify(types));
      assert.equal(r.score, Math.round(tableValue('restaurant')), JSON.stringify(types));
    }
    // The rule on its own: a named category, or null.
    const { noCurveFallbackCategory } = p._internals;
    assert.equal(noCurveFallbackCategory(['night_club', 'bar']), 'nightclub');
    assert.equal(noCurveFallbackCategory(['amusement_park', 'park']), 'entertainment');
    assert.equal(noCurveFallbackCategory(['fast_food_restaurant']), 'fast_food');
    assert.equal(noCurveFallbackCategory(['steak_house', 'american_restaurant']), 'restaurant');
    assert.equal(noCurveFallbackCategory(['airport']), null);
    assert.equal(noCurveFallbackCategory(['food', 'point_of_interest']), null);
    assert.equal(noCurveFallbackCategory([]), null);
  });
});

test('the gate is 200 reviews, read off user_ratings_total or review_count, and a count nobody gave is not 200', async () => {
  const cases = [
    [{ user_ratings_total: 199 }, false],
    [{ user_ratings_total: 200 }, true],
    [{ user_ratings_total: 1e6 }, true],
    [{ user_ratings_total: undefined, review_count: 300 }, true],
    [{ user_ratings_total: null, review_count: 150 }, false],
    [{ user_ratings_total: '450' }, true],
    [{ user_ratings_total: 'many' }, false],
    [{ user_ratings_total: undefined }, false],
    [{ user_ratings_total: null }, false],
    [{ user_ratings_total: NaN }, false],
    [{ user_ratings_total: [900] }, false],
  ];
  await withPredictor({ env: { [SWITCH]: ON } }, async (p, db) => {
    for (const [over, served] of cases) {
      const v = venue(over);
      const before = db.presence().length;
      const r = await p.predictBusyness(v, WX, TS);
      const what = JSON.stringify(over);
      if (served) {
        assert.equal(r.predictionMethod, METHOD, what);
      } else {
        assert.deepStrictEqual(r, todaysAnswer(v, WX, TS), `${what}: today's answer`);
        assert.equal(db.presence().length, before, `${what}: refused before any query`);
      }
    }
  });
});

test('a venue with any curve row keeps today\'s answer, even where its own curve is zero at this hour', async () => {
  const closedTonight = venue();
  const quietHere = venue();
  const db = scriptedDb({
    curves: {
      // A curve that has rows, none near Friday 9 PM: the slot lookup finds
      // nothing, and only the presence probe can tell this from no curve.
      [closedTonight.place_id]: { '1_12': 40, '1_13': 55, '2_12': 38 },
      // A curve whose own value around this hour is zero.
      [quietHere.place_id]: { [`${DOW}_${HOUR - 1}`]: 0, [`${DOW}_${HOUR}`]: 0, [`${DOW}_${HOUR + 1}`]: 0, '1_12': 40 },
    },
  });
  await withPredictor({ db, env: { [SWITCH]: ON } }, async (p) => {
    for (const v of [closedTonight, quietHere]) {
      const r = await p.predictBusyness(v, WX, TS);
      assert.deepStrictEqual(r, todaysAnswer(v, WX, TS), v.place_id);
      // The probe asked, and the answer kept the rule engine.
      assert.ok(db.presence().some((s) => s.params[0] === v.place_id));
    }
    // And the strip of the venue whose curve is zero tonight is today's too.
    for (const h of await p.predictHourlyForecast(quietHere, WX, HOUR, 1, TS)) {
      assert.equal(h.predictionMethod, 'rule_engine_no_baseline', h.hour);
    }
  });
});

test('only the corpus gap: a refused or failed lookup, a popular_times payload or no usable place id keeps today\'s answer and sends no probe', async () => {
  // A refused lookup. A user id that is not an id is refused by the budget,
  // and the slot's zero is then the budget's, not the corpus's.
  await withPredictor({ env: { [SWITCH]: ON } }, async (p, db) => {
    const v = venue();
    const r = await p.predictBusyness(v, WX, TS, { userId: 'not-an-account' });
    assert.deepStrictEqual(r, todaysAnswer(v, WX, TS, 'rule_engine_baseline_refused'));
    assert.equal(db.presence().length, 0);
  });
  // A lookup that threw.
  await withPredictor({
    db: scriptedDb({ fail: /FROM ml_venue_baselines WHERE google_place_id = \$1 AND \(/ }),
    env: { [SWITCH]: ON },
  }, async (p, db) => {
    const v = venue();
    const errors = [];
    const real = console.error;
    console.error = (...a) => { errors.push(a.join(' ')); };
    let r;
    try { r = await p.predictBusyness(v, WX, TS); } finally { console.error = real; }
    assert.deepStrictEqual(r, todaysAnswer(v, WX, TS, 'rule_engine_baseline_error'));
    assert.equal(db.presence().length, 0);
    assert.ok(errors.some((e) => /Baseline lookup failed/.test(e)));
  });
  await withPredictor({ env: { [SWITCH]: ON } }, async (p, db) => {
    // The venue's own popular_times said zero at this hour: its own pattern.
    const zero = Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(0) }));
    const own = venue({ popular_times: zero });
    assert.deepStrictEqual(await p.predictBusyness(own, WX, TS), todaysAnswer(own, WX, TS));
    // No place id, or one that cannot be a Google place id: nothing can say
    // the venue has no curve, so nothing is served as if it had none.
    for (const placeId of [null, undefined, '', 'x', 'has spaces in it']) {
      const v = venue({ place_id: placeId });
      assert.deepStrictEqual(await p.predictBusyness(v, WX, TS), todaysAnswer(v, WX, TS), String(placeId));
    }
    assert.equal(db.presence().length, 0, 'none of those reached the probe');
  });
});

test('an unknown category key or a value that is not a finite number keeps today\'s answer', async () => {
  const key = `bar_${DOW}_${HOUR}`;
  const edits = [
    ['the key removed', (t) => { const c = { ...t }; delete c[key]; return c; }],
    ['null', (t) => ({ ...t, [key]: null })],
    ['a word', (t) => ({ ...t, [key]: 'busy' })],
    ['"NaN"', (t) => ({ ...t, [key]: 'NaN' })],
    ['an object', (t) => ({ ...t, [key]: { v: 60 } })],
    ['true', (t) => ({ ...t, [key]: true })],
    ['no table at all', () => undefined],
  ];
  for (const [what, edit] of edits) {
    await withPredictor({
      env: { [SWITCH]: ON },
      mutateMeta: (m) => ({ ...m, category_baselines: edit(m.category_baselines) }),
    }, async (p, db) => {
      const v = venue();
      assert.deepStrictEqual(await p.predictBusyness(v, WX, TS), todaysAnswer(v, WX, TS), what);
      assert.equal(db.presence().length, 0, `${what}: refused before the probe`);
    });
  }
});

test('another artifact\'s table has not been measured, so another version keeps today\'s answer', async () => {
  assert.equal(META.model_version, '2.6.0-starling', 'the shipped artifact is the one the table was measured on');
  for (const version of ['2.7.0-candidate', '2.6.0', '', undefined]) {
    await withPredictor({
      env: { [SWITCH]: ON },
      mutateMeta: (m) => ({ ...m, model_version: version }),
    }, async (p, db) => {
      const v = venue();
      assert.deepStrictEqual(await p.predictBusyness(v, WX, TS), todaysAnswer(v, WX, TS), String(version));
      assert.equal(db.presence().length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The presence probe.
// ---------------------------------------------------------------------------

test('the presence probe: a no is held an hour and a yes a day, and a refusal or a failure is not remembered', async () => {
  const curved = placeIdFor('C');
  const bare = placeIdFor('B');
  const db = scriptedDb({ curves: { [curved]: { '5_21': 60 } } });
  await withPredictor({ db, env: { [SWITCH]: ON } }, async (p) => {
    const I = p._internals;
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      assert.equal(await I.venueHasCurve(bare), false);
      assert.equal(await I.venueHasCurve(curved), true);
      assert.equal(db.presence().length, 2);
      // Inside an hour both are answered from memory.
      shift = I.CURVE_ABSENT_CACHE_TTL - 1000;
      assert.equal(await I.venueHasCurve(bare), false);
      assert.equal(await I.venueHasCurve(curved), true);
      assert.equal(db.presence().length, 2);
      // Past the hour the no is asked again, and the yes is not.
      shift = I.CURVE_ABSENT_CACHE_TTL + 1000;
      assert.equal(await I.venueHasCurve(bare), false);
      assert.equal(await I.venueHasCurve(curved), true);
      assert.deepStrictEqual(db.presence().slice(2).map((s) => s.params[0]), [bare]);
      // Past the day the yes is asked again.
      shift = I.BASELINE_CACHE_TTL + 1000;
      assert.equal(await I.venueHasCurve(curved), true);
      assert.equal(db.presence().slice(-1)[0].params[0], curved);
    } finally {
      Date.now = realNow;
    }
    assert.ok(I.CURVE_ABSENT_CACHE_TTL < I.BASELINE_CACHE_TTL);
    // A refused caller neither asks nor teaches the cache anything.
    const size = I.curvePresenceCacheSize();
    const sent = db.presence().length;
    assert.equal(await I.venueHasCurve(placeIdFor('R'), 'not-an-account'), null);
    assert.equal(await I.venueHasCurve('not a place id'), null);
    assert.equal(await I.venueHasCurve(null), null);
    assert.equal(db.presence().length, sent);
    assert.equal(I.curvePresenceCacheSize(), size);
  });
  // A probe that throws answers unknown, and the next caller asks again.
  const failing = scriptedDb({ fail: /^SELECT 1 FROM ml_venue_baselines/ });
  await withPredictor({ db: failing, env: { [SWITCH]: ON } }, async (p) => {
    const I = p._internals;
    const id = placeIdFor('F');
    const real = console.error;
    console.error = () => {};
    try {
      assert.equal(await I.venueHasCurve(id), null);
      assert.equal(await I.venueHasCurve(id), null);
      // Unknown is not "no curve": the venue keeps today's answer.
      const v = venue({ place_id: placeIdFor('F') });
      assert.deepStrictEqual(await p.predictBusyness(v, WX, TS), todaysAnswer(v, WX, TS));
    } finally {
      console.error = real;
    }
    assert.equal(failing.presence().filter((s) => s.params[0] === id).length, 2, 'a failure is never cached');
    assert.equal(I.curvePresenceCacheSize(), 0);
  });
});

test('a strip that has just read the venue\'s rows is not overruled by a cached no from before they existed', async () => {
  // 13:30, a card: no rows, so the probe says no and the no is held an hour.
  // 14:05, the collector writes the venue's rows. 14:20, a card again, with
  // its strip: the whole-curve read primes every slot the curve has, and the
  // hours the curve says zero still take the no-baseline exit. They must keep
  // the rule engine, not get the category's level beside the venue's own bars.
  const v = venue();
  const curves = {};
  const db = scriptedDb({ curves });
  await withPredictor({ db, env: { [SWITCH]: ON, CROWD_SERVE_MODE: 'curve_offset' } }, async (p) => {
    const I = p._internals;
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      assert.equal((await p.predictBusyness(v, WX, TS)).predictionMethod, METHOD, 'no rows yet');
      assert.equal(db.presence().length, 1);
      // Busy until 9 PM, then closed by the venue's own curve.
      curves[v.place_id] = {
        [`${DOW}_18`]: 40, [`${DOW}_19`]: 55, [`${DOW}_20`]: 60, [`${DOW}_21`]: 0, [`${DOW}_22`]: 0, [`${DOW}_23`]: 0,
      };
      shift = 50 * 60 * 1000; // inside the hour the no is held
      const strip = await p.predictHourlyForecast(v, WX, 18, 6, TS);
      const byHour = Object.fromEntries(strip.map((h) => [h.hour, h.predictionMethod]));
      for (const [hour, method] of Object.entries(byHour)) {
        assert.notEqual(method, METHOD, `${hour}: the venue has a curve now`);
      }
      assert.equal(byHour['6 PM'], 'ml', 'its own curve, where it has one');
      // 10 and 11 PM blend to zero on the venue's own curve: today's answer.
      assert.equal(byHour['10 PM'], 'rule_engine_no_baseline');
      assert.equal(byHour['11 PM'], 'rule_engine_no_baseline');
      // The read answered the question, so nothing was probed for it.
      assert.equal(db.presence().length, 1);
      assert.equal(await I.venueHasCurve(v.place_id), true);
      assert.equal(db.presence().length, 1);
    } finally {
      Date.now = realNow;
    }
  });
  // With the switch off the read writes nothing: the map is the fallback's.
  await withPredictor({ db: scriptedDb({ curves: { [v.place_id]: { [`${DOW}_20`]: 60 } } }) }, async (p) => {
    await p.predictHourlyForecast(v, WX, 18, 6, TS);
    assert.equal(p._internals.curvePresenceCacheSize(), 0);
  });
});

test('a probe is charged to the account like the slot lookup it follows', async () => {
  await withPredictor({ env: { [SWITCH]: ON } }, async (p) => {
    const I = p._internals;
    I.__resetVenueLookupCaches();
    const uid = 424242;
    const before = I.venueLookupBudgetRemaining(uid);
    const v = venue();
    const r = await p.predictBusyness(v, WX, TS, { userId: uid });
    assert.equal(r.predictionMethod, METHOD);
    // The slot lookup, the feedback lookup and the probe: three lookups.
    assert.equal(before.hourly - I.venueLookupBudgetRemaining(uid).hourly, 3);
    // A cache hit costs nothing.
    await p.predictBusyness(v, WX, TS, { userId: uid });
    assert.equal(before.hourly - I.venueLookupBudgetRemaining(uid).hourly, 3);
  });
});

// ---------------------------------------------------------------------------
// 4. The strip, the counter, the figure.
// ---------------------------------------------------------------------------

test('the strip carries the table\'s number hour by hour, names it, and ranks the hours on it', async () => {
  for (const env of [{ [SWITCH]: ON }, { [SWITCH]: ON, CROWD_SERVE_MODE: 'curve_offset', CROWD_NOWCAST_ENABLED: 'true' }]) {
    await withPredictor({ env }, async (p) => {
      assert.equal(p._internals.hourlyAttributionOn(), true);
      const v = venue();
      const strip = await p.predictHourlyForecast(v, WX, 18, 6, TS);
      assert.equal(strip.length, 6);
      strip.forEach((h, i) => {
        const value = Math.round(tableValue('bar', DOW, 18 + i));
        assert.equal(h.predictionMethod, METHOD, h.hour);
        assert.equal(h.score, value, h.hour);
        assert.equal(h.baselineScore, value, h.hour);
        assert.equal(h.numberSource, 'category_typical', h.hour);
        // A plain no on every hour, with the serving switches off too: the
        // fallback is a switch, and while it is on each hour says what made
        // it, which is what lets the venue dashboard's strip name a peak the
        // table made instead of captioning it as the crowd model's.
        assert.equal(h.liveReadings, false, `${h.hour}: no live reading reached it`);
      });
      // Every hour has the table's value as its ordering axis, so best time
      // and peak rank on it rather than falling back to model scores.
      assert.equal(crowdEngine.orderingAxis(strip).basis, 'baseline');
    });
  }
});

test('the coverage counter gives the table its own leg, and the three legs add up', async () => {
  await withPredictor({ env: { [SWITCH]: ON } }, async (p) => {
    await p.predictBusyness(venue(), WX, TS);
    await p.predictBusyness(venue(), WX, TS);
    await p.predictBusyness(venue({ user_ratings_total: 20 }), WX, TS);
    const c = p.predictionCoverage();
    assert.equal(c.categoryCurve, 2);
    assert.equal(c.byMethod[METHOD], 2);
    assert.equal(c.byMethod.rule_engine_no_baseline, 1);
    assert.equal(c.ruleEngine, 1);
    assert.equal(c.ml + c.categoryCurve + c.ruleEngine, c.total);
    assert.equal(c.modelShare, 0, 'none of it is a venue\'s own data');
    assert.equal(c.noCurveFallback, true);
  });
});

test('the published figure is pinned: within-15 41.3 on 4,248 rows, with what it was measured on', async () => {
  await withPredictor({ env: { [SWITCH]: ON } }, async (p) => {
    const I = p._internals;
    assert.deepStrictEqual({ ...I.NO_CURVE_FALLBACK_MEASURED }, { within15: 41.3, rows: 4248 });
    assert.ok(Object.isFrozen(I.NO_CURVE_FALLBACK_MEASURED));
    assert.match(I.NO_CURVE_FALLBACK_POPULATION, /2026-09-06\.\.08/);
    assert.match(I.NO_CURVE_FALLBACK_POPULATION, /Lehigh and Miami/);
    assert.match(I.NO_CURVE_FALLBACK_POPULATION, /own curve withheld/);
    assert.match(I.NO_CURVE_FALLBACK_POPULATION, /200\+ Google reviews/);
    // The category gate is part of the policy the figure describes (re-read
    // with it on the same rows: 41.29, published as 41.3).
    assert.match(I.NO_CURVE_FALLBACK_POPULATION, /first three Google types name one of its categories/);
    assert.notEqual(I.NO_CURVE_FALLBACK_POPULATION, I.SERVE_MEASURED_POPULATION);
    assert.equal(I.NO_CURVE_FALLBACK_MIN_REVIEWS, 200);
    assert.equal(I.NO_CURVE_FALLBACK_FITTED_ON, '2.6.0-starling');
    assert.equal(I.NO_CURVE_FALLBACK_SWITCH, ON);
    assert.equal(I.NO_CURVE_FALLBACK_METHOD, METHOD);
    // The integer on the card is the measured figure, reconstructible from
    // the block beside it, and a weather outage does not move it: the table
    // reads no weather.
    for (const weather of [WX, null]) {
      const r = await p.predictBusyness(venue(), weather, TS);
      const m = r.confidenceMeasurement;
      assert.equal(r.confidence, Math.round(m.measuredPercent) - m.weatherPenalty);
      assert.equal(r.confidence, 41);
      assert.equal(m.weatherPenalty, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The words.
// ---------------------------------------------------------------------------

test('crowdEngine hedges it as a category prior, says its confidence is measured, and names it category_typical', () => {
  assert.equal(crowdEngine.NO_CURVE_FALLBACK_METHOD, METHOD);
  const support = crowdEngine.describePredictionSupport(METHOD, 0);
  assert.deepStrictEqual(support, { basis: 'category_pattern', supported: false, confidenceMeans: 'measured_accuracy' });
  for (const score of [10, 30, 55, 75, 95]) {
    assert.equal(crowdEngine.publishedLabel(score, support), `Usually ${crowdEngine.getLabel(score).toLowerCase()}`);
  }
  // Verified reporters outrank it exactly as they outrank every other basis.
  assert.equal(crowdEngine.describePredictionSupport(METHOD, crowdEngine.MIN_CALIBRATION_REPORTERS).basis, 'user_reports');
  assert.equal(crowdEngine.describePredictionSupport(METHOD, crowdEngine.MIN_CALIBRATION_REPORTERS - 1).basis, 'category_pattern');
  // The rule engine's own words are untouched.
  assert.deepStrictEqual(crowdEngine.describePredictionSupport('rule_engine_no_baseline', 0),
    { basis: 'category_pattern', supported: false, confidenceMeans: 'input_completeness' });

  // Named by what it is, whatever a switch left on the response, and adjusted
  // only when reporters moved it; an owner's reading names its own source.
  const r = { predictionMethod: METHOD, dataSourcesUsed: ['google_places', 'category_curve'] };
  assert.equal(crowdEngine.describeServedArithmetic(r), 'category_typical');
  assert.equal(crowdEngine.describeServedArithmetic({ ...r, serveMode: 'curve_offset', nowcast: { weight: 1, lagHours: 1 } }), 'category_typical');
  assert.equal(crowdEngine.describePublishedArithmetic(r), 'category_typical');
  assert.equal(crowdEngine.describePublishedArithmetic(r, { reportsBlended: true }), 'category_typical_adjusted');
  assert.equal(crowdEngine.describePublishedArithmetic(r, { ownerReading: true }), null);
  assert.equal(crowdEngine.describeServedArithmetic({ predictionMethod: 'rule_engine_no_baseline' }), null);
});
