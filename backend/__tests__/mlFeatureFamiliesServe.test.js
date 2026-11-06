// ---------------------------------------------------------------------------
// AN ARTIFACT THAT LISTS THE LIVE AND SPORTS FEATURES IS SERVED THEM.
//
// mlLiveFeatureParity and mlSportsParity prove the feature arithmetic equals
// the Python. This proves the plumbing: that predictBusyness, for an artifact
// whose feature_names lists the two families, reads the offset row with its
// readings, the curve an hour earlier and the game schedule, and hands the
// graph exactly the vector scripts/ml/train/bandEval.js replays for the same
// reading (the vector the band gate scores). The artifact is v2.6.0-starling's
// metadata with the eleven names appended, and the graph is replaced by a
// stand-in that records its input and answers a delta of zero.
//
// It also pins that such an artifact is not handed the trailing offset a
// second time after the model (artifactLearnsOffset), and that its numbers say
// a live reading is in them exactly when one was in the graph's inputs
// (liveFeaturesUsedReadings, usedLiveReadings, liveReadingsReached).
//
// No database, no network. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
delete process.env.TICKETMASTER_API_KEY;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-feature-families';
for (const k of ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_QMAP_ENABLED']) delete process.env[k];

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const B = require('../scripts/ml/train/bandEval');
const crowdEngine = require('../services/crowdEngine');
const FX = require('./helpers/bandEvalFixture');

const MODELS_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'models');
const PREDICTOR = require.resolve('../services/mlPredictor');

// Three games on the fixture's dates: a home evening game at an arena 2 km from
// the fixture's venues, an away game, and a home afternoon game elsewhere in
// market. The fixture's far venue (105) is ~18 km away: in market, not near.
const SPORTS_ROWS = [
  { is_home: true, event_local_date: '2026-09-04', event_local_time: '19:05:00', venue_lat: 40.6181, venue_lon: -75.4712 },
  { is_home: false, event_local_date: '2026-09-05', event_local_time: '13:00:00', venue_lat: null, venue_lon: null },
  { is_home: true, event_local_date: '2026-09-06', event_local_time: '16:10:00', venue_lat: 40.8, venue_lon: -75.2 },
];

test('predictBusyness hands a live-and-sports artifact the vector the band replay builds, and adds no offset after it', async () => {
  const fx = FX.buildFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-families-'));
  const csv = path.join(dir, 'fixture.csv');
  FX.writeFixtureCsv(csv, fx);
  const pool = require('../config/database');
  const realQuery = pool.query;
  const moments = new Map();
  const stub = FX.makeFixturePool(fx, (alias) => moments.get(alias));
  const sql = [];
  pool.query = (text, params) => {
    sql.push(String(text));
    if (/FROM ml_sports_events/.test(String(text))) return Promise.resolve({ rows: SPORTS_ROWS });
    return stub.query(text, params);
  };
  const quiet = [console.log, console.warn, console.error];
  try {
    B.pinUtcClock();
    const corpus = await B.readCorpus([csv]);
    const art = await B.loadArtifact(MODELS_DIR);
    delete require.cache[PREDICTOR];
    const predictor = require(PREDICTOR);
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    assert.equal(await predictor.init(), true);
    const I = predictor._internals;
    const meta = I.getMetadata();
    const extra = [...I.LIVE_FEATURE_NAMES, ...I.SPORTS_FEATURE_NAMES];
    meta.feature_names = [...meta.feature_names, ...extra];
    assert.equal(I.artifactReadsLiveFeatures(), true);
    assert.equal(I.artifactReadsSportsFeatures(), true);
    assert.deepEqual(I.missingFeatureNames(meta), [], 'serving builds every name the artifact lists');

    const session = I.getSession();
    const inputName = meta.onnx_input_name || 'input';
    const outName = session.outputNames[0];
    let captured = null;
    session.run = async (feeds) => {
      captured = Array.from(feeds[inputName].data);
      return { [outName]: { data: new Float32Array([0]) } };
    };

    const sports = I.buildSportsTable(SPORTS_ROWS);
    const prepared = B.prepareRows(corpus.live, corpus, { I, crowdEngine, sports });
    let compared = 0;
    let withReading = 0;
    let withOffset = 0;
    let gameRows = 0;
    for (let i = 0; i < prepared.length; i++) {
      const r = prepared[i];
      const alias = `ChIJfamilies_${r.venueId}_${i}`;
      moments.set(alias, { venueId: Number(r.venueId), date: r.date, hour: r.hour });
      captured = null;
      const res = await predictor.predictBusyness({ ...r.venue, place_id: alias }, r.weather, r.ts);
      if (res.predictionMethod !== 'ml') { assert.equal(captured, null); continue; }
      const replay = Array.from(I.buildFeatureVector(r.venue, r.weather, r.ts, r.events, null, r.smoothed, r.neighbors,
        { live: r.live, sports: prepared.sports }));
      assert.ok(captured, `row ${i}: the graph ran`);
      const names = meta.feature_names;
      const bad = names.filter((n, k) => captured[k] !== replay[k]);
      assert.deepEqual(bad, [], `row ${i}: served and replayed vectors differ on ${bad.join(', ')}`);
      assert.equal(res.recentDeviation, null, `row ${i}: no offset is added after a model that took it as an input`);
      const at = (n) => captured[names.indexOf(n)];
      if (at('last_live_age_h') !== I.LIVE_MISSING_AGE_H) withReading++;
      if (at('recent_offset_n') > 0) withOffset++;
      if (at('sports_game_today') === 1) gameRows++;
      compared++;
    }
    assert.ok(compared > 100, `only ${compared} model-served rows compared`);
    assert.ok(withReading > 20 && withOffset > 20, `too few rows exercised the live features (${withReading}, ${withOffset})`);
    assert.ok(gameRows > 10, `too few game-night rows (${gameRows})`);
    assert.equal(sql.filter((s) => /FROM ml_sports_events/.test(s)).length, 1, 'the schedule is read once and cached');
    assert.ok(sql.filter((s) => /ml_venue_recent_deviation/.test(s)).every((s) => /offset_readings/.test(s)),
      'the offset row is read with its readings for an artifact that lists the live features');
    assert.deepEqual(stub.unknown, []);
  } finally {
    [console.log, console.warn, console.error] = quiet;
    pool.query = realQuery;
    delete require.cache[PREDICTOR];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Whether such an artifact's numbers say a live reading is in them ───────
//
// A model that takes the live features is handed no offset after it
// (artifactLearnsOffset), and under a version the nowcast tables were not
// fitted on, no nowcast either, so the offset and the nowcast alone said "no
// live readings" about every number it made, the hour-old reading among its
// inputs included. That is the number model_when_fresh serves wherever the
// reading is fresh, and what Birdie is told about it (live_readings).

const SWITCHES = ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_QMAP_ENABLED', 'CROWD_NO_CURVE_FALLBACK'];

// The fixture through predictBusyness under `env`, for v2.6.0-starling's
// metadata with the live family appended, the graph a stand-in that records
// its input. Each response comes back with the vector its graph was handed
// (null where no graph ran: a rule-engine exit or the curve_offset side).
// `version` replaces the artifact's version, as a retrained artifact's would.
async function serveLiveArtifact(env, { version = null } = {}) {
  const fx = FX.buildFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-live-readings-'));
  const csv = path.join(dir, 'fixture.csv');
  FX.writeFixtureCsv(csv, fx);
  const pool = require('../config/database');
  const realQuery = pool.query;
  const moments = new Map();
  const stub = FX.makeFixturePool(fx, (alias) => moments.get(alias));
  pool.query = (text, params) => stub.query(text, params);
  const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) delete process.env[k];
  Object.assign(process.env, env);
  const quiet = [console.log, console.warn, console.error];
  try {
    B.pinUtcClock();
    const corpus = await B.readCorpus([csv]);
    delete require.cache[PREDICTOR];
    const predictor = require(PREDICTOR);
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    assert.equal(await predictor.init(), true);
    const I = predictor._internals;
    const meta = I.getMetadata();
    meta.feature_names = [...meta.feature_names, ...I.LIVE_FEATURE_NAMES];
    if (version) meta.model_version = version;
    assert.equal(I.artifactLearnsOffset(), true);
    const session = I.getSession();
    const inputName = meta.onnx_input_name || 'input';
    const outName = session.outputNames[0];
    let captured = null;
    session.run = async (feeds) => {
      captured = Array.from(feeds[inputName].data);
      return { [outName]: { data: new Float32Array([0]) } };
    };
    const prepared = B.prepareRows(corpus.live, corpus, { I, crowdEngine });
    const rows = [];
    for (let i = 0; i < prepared.length; i++) {
      const r = prepared[i];
      const alias = `ChIJliveReadings_${r.venueId}_${i}`;
      moments.set(alias, { venueId: Number(r.venueId), date: r.date, hour: r.hour });
      captured = null;
      const res = await predictor.predictBusyness({ ...r.venue, place_id: alias }, r.weather, r.ts);
      const vec = captured;
      const at = (n) => vec[meta.feature_names.indexOf(n)];
      rows.push({ res, ran: vec !== null, at });
    }
    assert.deepEqual(stub.unknown, []);
    return { rows, I, liveReadingsReached: predictor.liveReadingsReached };
  } finally {
    [console.log, console.warn, console.error] = quiet;
    pool.query = realQuery;
    for (const k of SWITCHES) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[PREDICTOR];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, env, version = null] of [
  ['with every switch off', {}],
  ['as production serves today (model, nowcast on)', { CROWD_SERVE_MODE: 'model', CROWD_NOWCAST_ENABLED: 'true' }],
  ['under model_when_fresh with the nowcast on', { CROWD_SERVE_MODE: 'model_when_fresh', CROWD_NOWCAST_ENABLED: 'true' }],
  ['under model_when_fresh with the nowcast off', { CROWD_SERVE_MODE: 'model_when_fresh' }],
  // The November ship: a retrained version, which the model nowcast tables
  // were not fitted on (nowcastBaseKey), so its model side carries no nowcast
  // and the reading in its inputs is the only live reading in its numbers.
  ['under model_when_fresh with the nowcast on, for a retrained version', { CROWD_SERVE_MODE: 'model_when_fresh', CROWD_NOWCAST_ENABLED: 'true' }, '2.8.0-retrained'],
]) {
  test(`a live-feature artifact's number says yes to live readings exactly when one reached it, ${label}`, async () => {
    const { rows, I, liveReadingsReached } = await serveLiveArtifact(env, { version });
    const switched = Object.keys(env).length > 0;
    let held = 0;
    let none = 0;
    let modelSide = 0;
    for (const [i, { res, ran, at }] of rows.entries()) {
      if (res.predictionMethod !== 'ml') continue;
      if (!ran) {
        // The curve_offset side: no graph, so nothing is said about its inputs.
        assert.equal(res.serveMode, 'curve_offset', `row ${i}`);
        assert.ok(!('liveFeaturesUsedReadings' in res), `row ${i}`);
        assert.equal(res.usedLiveReadings, Boolean(res.recentDeviation || res.nowcast), `row ${i}`);
        continue;
      }
      const read = at('last_live_age_h') !== I.LIVE_MISSING_AGE_H || at('recent_offset_n') > 0;
      if (read) held++; else none++;
      assert.equal(res.recentDeviation, null, `row ${i}: no offset after a model that took it as an input`);
      const want = read || Boolean(res.nowcast);
      if (switched) assert.equal(res.usedLiveReadings, want, `row ${i}: usedLiveReadings`);
      else assert.ok(!('usedLiveReadings' in res), `row ${i}: a switched-off response gains no switch key`);
      assert.equal(liveReadingsReached(res), want, `row ${i}: what Birdie and the strip are told`);
      assert.equal(res.liveFeaturesUsedReadings, read, `row ${i}: what the graph was handed`);
      if (res.freshMix) {
        // The mix runs the model only on an hour-old reading, which is one of
        // its inputs, so every number its model side makes says yes.
        assert.equal(res.freshMix.answered, 'model');
        assert.equal(at('last_live_age_h'), 1, `row ${i}`);
        assert.equal(res.usedLiveReadings, true, `row ${i}`);
        if (version) assert.equal(res.nowcast, null, `row ${i}: no nowcast for a version its tables were not fitted on`);
        modelSide++;
      }
    }
    assert.ok(held > 20, `too few numbers with a reading in their inputs (${held})`);
    if (env.CROWD_SERVE_MODE === 'model_when_fresh') assert.ok(modelSide > 20, `too few fresh numbers (${modelSide})`);
    else assert.ok(none > 0, 'the fixture has a model number with no reading in its inputs');
  });
}

test('only a feature the artifact lists, and never the curve an hour earlier, counts as a live reading in its inputs', () => {
  const I = require(PREDICTOR)._internals;
  const all = { feature_names: ['hour', ...I.LIVE_FEATURE_NAMES] };
  const only = (...names) => ({ feature_names: ['hour', ...names] });
  const reading = { ...I.LIVE_FEATURE_DEFAULTS, last_live_dev: -12, last_live_age_h: 1, curve_prev_hour: 40 };
  const offset = { ...I.LIVE_FEATURE_DEFAULTS, recent_offset: 6, recent_offset_n: 3, curve_prev_hour: 40 };
  const curveOnly = { ...I.LIVE_FEATURE_DEFAULTS, curve_prev_hour: 40 };
  assert.equal(I.liveFeaturesUsedReadings(I.LIVE_FEATURE_DEFAULTS, all), false);
  assert.equal(I.liveFeaturesUsedReadings(null, all), false);
  assert.equal(I.liveFeaturesUsedReadings(curveOnly, all), false, 'the curve is not a reading');
  assert.equal(I.liveFeaturesUsedReadings(reading, all), true);
  assert.equal(I.liveFeaturesUsedReadings(offset, all), true);
  // A reading the newest-reading features carry, read only by an artifact listing one of them.
  assert.equal(I.liveFeaturesUsedReadings(reading, only('last_live_age_h')), true);
  assert.equal(I.liveFeaturesUsedReadings(reading, only('last_live_dev')), true);
  assert.equal(I.liveFeaturesUsedReadings(reading, only('recent_offset', 'recent_offset_n', 'curve_prev_hour')), false);
  // The offset, read only by an artifact listing one of its two features.
  assert.equal(I.liveFeaturesUsedReadings(offset, only('recent_offset_n')), true);
  assert.equal(I.liveFeaturesUsedReadings(offset, only('recent_offset')), true);
  assert.equal(I.liveFeaturesUsedReadings(offset, only('last_live_dev', 'last_live_age_h', 'curve_prev_hour')), false);
  // A reading whose value equals the curve (last_live_dev 0) is still a reading.
  assert.equal(I.liveFeaturesUsedReadings({ ...reading, last_live_dev: 0 }, only('last_live_dev')), true);
  // Off a stored row, through liveFeatureValues: an 18:00 reading for 19:00
  // is a yes, and the same row scored at 18:00 (its own hour) is a no.
  const slot = (hour) => I.slotDayNumber('2026-09-06') * 24 + hour;
  const row = { readings: I.parseRecentReadings([{ v: 55, d: '2026-09-06', h: 18 }]), offsetReadings: null, fresh: true };
  assert.equal(I.liveFeaturesUsedReadings(I.liveFeatureValues(row, slot(19), 40, 38), all), true);
  assert.equal(I.liveFeaturesUsedReadings(I.liveFeatureValues(row, slot(18), 40, 38), all), false);
  delete require.cache[PREDICTOR];
});
