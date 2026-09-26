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
// second time after the model (artifactLearnsOffset).
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
