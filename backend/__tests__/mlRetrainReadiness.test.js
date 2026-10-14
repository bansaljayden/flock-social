// ---------------------------------------------------------------------------
// THE PRE-REGISTERED RETRAIN: WHAT THE BAND GATE COMPARES AGAINST, AND THE
// RULES IT WAS REGISTERED WITH.
//
// The retrain's hypotheses (H4 to H6), guards and decision rule were fixed in
// code on 2026-09-25 and 09-26 and are quoted in the research paper. The run
// moved to early November; until it happens, three things have to stay true,
// and nothing else in the suite pins them together:
//
//   1. The gate scores the incumbent as production serves it at gate time.
//      Since 2026-10-14 the curve_offset nowcast weights are 1 / 0 / 0 / 0 for
//      a reading 1 / 2 / 3 / 4-12 hours old, so
//      `bandEval.js --gate --incumbent-serve=curve_offset+nowcast` scores
//      rule (b): the venue's reading from the hour before where there is one,
//      else curve + CURVE_OFFSET_WEIGHT x the trailing offset. The
//      configuration the paper tested (1 / 0.85 / 0.25 / 0) differs from it
//      only where the newest earlier reading is two or three hours old.
//   2. The rows file the gate writes (--rows-out) carries what the November
//      runbook needs to report the paper's configuration beside the verdict
//      on the same readings, and that arithmetic reproduces the serve path.
//   3. The thresholds, the criteria and the command block in RETRAIN.md are
//      the registered ones. A change to any of them is a change to the
//      pre-registration, and it fails here first.
//
// No database, no network, no model is fitted: the scored artifact is the
// tracked v2.6.0-starling ONNX, replayed. Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
delete process.env.TICKETMASTER_API_KEY;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-retrain-readiness';
for (const k of ['CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED', 'CROWD_QMAP_ENABLED']) delete process.env[k];

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const B = require('../scripts/ml/train/bandEval');
const crowdEngine = require('../services/crowdEngine');
const FX = require('./helpers/bandEvalFixture');

const ML_DIR = path.join(__dirname, '..', 'scripts', 'ml');
const MODELS_DIR = path.join(ML_DIR, 'models');

// The nowcast weights on the curve_offset base that production served through
// the paper's 30-day test (09-09..10-08), fitted on 09-01..05: the
// "configuration tested in the paper" the runbook reports beside the verdict.
const PAPER_WEIGHTS = Object.freeze({ 1: 1.0, 2: 0.85, 3: 0.25, 4: 0 });
const CURVE_OFFSET_NOWCAST = B.SERVE_CONFIGS.find((c) => c.name === 'curve_offset+nowcast');

const clampRound = (x) => Math.max(0, Math.min(100, Math.round(x)));

async function withFixtureCsv(fn) {
  const fx = FX.buildFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-retrain-readiness-'));
  const csv = path.join(dir, 'fixture.csv');
  FX.writeFixtureCsv(csv, fx);
  try {
    return await fn(csv, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('--incumbent-serve=curve_offset+nowcast scores the incumbent as rule (b) under today\'s weights', async () => {
  await withFixtureCsv(async (csv) => {
    B.pinUtcClock();
    const corpus = await B.readCorpus([csv]);
    const art = await B.loadArtifact(MODELS_DIR);
    const { I } = art;
    assert.deepEqual({ ...I.NOWCAST_WEIGHTS.curve_offset }, { 1: 1, 2: 0, 3: 0, 4: 0 },
      'production\'s curve_offset nowcast weights changed: the gate now compares against something other '
      + 'than rule (b), and RETRAIN.md, MODEL-METRICS.md and the November runbook must say so');
    const prepared = B.prepareRows(corpus.live, corpus, { I, crowdEngine });
    // Exactly as main() scores the incumbent under the flag.
    const serve = B.parseIncumbentServe('curve_offset+nowcast', I);
    assert.deepEqual(serve, { serveMode: 'curve_offset', nowcast: true });
    const scored = await B.scoreArtifact(art, prepared, { qmap: undefined, ...serve });

    const ml = [];
    const lagSeen = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let paperDiffers = 0;
    prepared.forEach((r, i) => {
      const s = scored.rows[i];
      if (!s.ml) return; // no served curve: the rule engine, identical in every configuration
      ml.push({ r, s });
      const base = I.curveOffsetScore(r.smoothed, r.switchedOffset === null ? null : { offset: r.switchedOffset });
      const pick = r.nowcastPick;
      if (pick) lagSeen[pick.bucket]++;
      const ruleB = pick && pick.lagHours === 1 ? pick.value : base;
      assert.equal(s.served, ruleB, `row ${i} (${r.venueId} ${r.date} ${r.hour}h): not rule (b)`);
      assert.equal(s.beforeNowcast, base);
      const w = pick ? PAPER_WEIGHTS[pick.bucket] : 0;
      const paper = w > 0 ? clampRound(base + w * (pick.value - base)) : base;
      if (paper !== s.served) {
        assert.ok(pick && (pick.bucket === 2 || pick.bucket === 3),
          `row ${i}: the paper's configuration and rule (b) differ outside the two- and three-hour buckets`);
        paperDiffers++;
      }
    });
    assert.ok(ml.length >= 60, `only ${ml.length} rows reached the model path`);
    for (const b of [1, 2, 3, 4]) assert.ok(lagSeen[b] > 0, `the fixture has no reading ${b} h old`);
    assert.ok(paperDiffers >= 5, `the two configurations differ on only ${paperDiffers} rows; the check would be vacuous`);

    // bandEval's restated arithmetic (servedAt, the one --fit trusts) gives the
    // same numbers at today's weights, and the paper's at the paper's.
    const rows = ml.map((x) => x.r);
    const today = B.servedAt(rows, { switched: {} },
      { curveOffsetWeight: I.CURVE_OFFSET_WEIGHT, nowcast: I.NOWCAST_WEIGHTS }, CURVE_OFFSET_NOWCAST, false);
    assert.deepEqual(today, ml.map((x) => x.s.served));
    const paper = B.servedAt(rows, { switched: {} },
      { curveOffsetWeight: I.CURVE_OFFSET_WEIGHT, nowcast: { ...I.NOWCAST_WEIGHTS, curve_offset: PAPER_WEIGHTS } },
      CURVE_OFFSET_NOWCAST, false);
    assert.equal(paper.filter((v, k) => v !== today[k]).length, paperDiffers);
  });
});

test('the rows file carries what the runbook needs to report the paper\'s configuration on the same readings', async () => {
  await withFixtureCsv(async (csv, dir) => {
    const rowsOut = path.join(dir, 'band_rows.csv');
    const quiet = console.log;
    console.log = () => {};
    try {
      await B.main([`--train=${csv}`, '--holdout=-', `--model=${MODELS_DIR}`, `--incumbent=${MODELS_DIR}`,
        '--incumbent-serve=curve_offset+nowcast', `--rows-out=${rowsOut}`]);
    } finally {
      console.log = quiet;
    }
    const [head, ...lines] = fs.readFileSync(rowsOut, 'utf8').trim().split('\n');
    const H = head.split(',');
    const need = ['section', 'date', 'y', 'ml', 'smoothed', 'served', 'incumbent_served',
      'served_curve_offset', 'served_curve_offset_nowcast', 'served_nowcast_reading', 'served_nowcast_lag_hours'];
    for (const c of need) assert.ok(H.includes(c), `--rows-out no longer writes ${c}; the runbook reads it`);
    const ix = Object.fromEntries(H.map((k, i) => [k, i]));
    const num = (s) => (s === '' ? null : Number(s));
    let served = 0;
    let paperDiffers = 0;
    for (const l of lines) {
      const f = l.split(',');
      assert.equal(f.length, H.length, 'a field carries a comma; the runbook\'s split would misread it');
      if (f[ix.section] !== 'live_time_holdout' || f[ix.ml] !== '1' || !(num(f[ix.smoothed]) > 0)) continue;
      served++;
      const base = num(f[ix.served_curve_offset]);
      const reading = num(f[ix.served_nowcast_reading]);
      const lag = num(f[ix.served_nowcast_lag_hours]);
      const prod = num(f[ix.served_curve_offset_nowcast]);
      // The incumbent as gated, the configuration column and rule (b) from the
      // file's own columns are one number.
      assert.equal(num(f[ix.incumbent_served]), prod);
      assert.equal(prod, reading !== null && lag === 1 ? reading : base);
      // The runbook's arithmetic for the paper's configuration.
      const w = reading === null ? 0 : (PAPER_WEIGHTS[lag >= 4 ? 4 : lag] || 0);
      const paper = w > 0 ? clampRound(base + w * (reading - base)) : base;
      if (paper !== prod) {
        assert.ok(lag === 2 || lag === 3);
        paperDiffers++;
      }
    }
    assert.ok(served >= 60, `only ${served} model-served rows in the file`);
    assert.ok(paperDiffers >= 5, `only ${paperDiffers} rows tell the two configurations apart`);
  });
});

test('the band gate\'s thresholds and criteria are the registered ones', () => {
  // H4 beats_incumbent, H5 within_10_not_worse, H6 beats_naive_curve; the rest
  // are the guards (RETRAIN.md "The ship gate"; the paper's pre-registered test).
  assert.deepEqual({ ...B.BAND_GATE }, {
    minRows: 1000,
    minDates: 5,
    incumbentCiLowerMin: -1.0,
    naiveCiLowerMin: 0.0,
    cityMinRows: 300,
    cityMaxRegression: -2.0,
    maeSlack: 1.0,
    bootstrapResamples: 2000,
  });
  const src = fs.readFileSync(path.join(ML_DIR, 'train', 'bandEval.js'), 'utf8');
  assert.match(src, /function pairedDateBootstrap\(rows, hitA, hitB, \{ resamples = BAND_GATE\.bootstrapResamples, seed = 20260925 \} = \{\}\)/,
    'the bootstrap seed is part of the registered analysis: a verdict must reproduce');
  const { cuts, labels } = B.bandLadder(crowdEngine.getLabel);
  const rows = [];
  for (let d = 1; d <= 6; d++) {
    for (let i = 0; i < 200; i++) rows.push({ date: `2026-10-0${d}`, city: i % 2 ? 'philly' : 'lehigh', y: [5, 30, 55, 80, 95][i % 5] });
  }
  const truth = rows.map((r) => r.y);
  const g = B.bandGate({ rows, cuts, labels, candidate: truth, incumbent: truth, naive: truth, rule: truth,
    fromDate: '2026-10-01', incumbentThrough: '2026-08-18' });
  assert.deepEqual(Object.keys(g.criteria).sort(), ['beats_incumbent', 'beats_naive_curve', 'incumbent_unseen',
    'no_city_regression', 'not_worse_than_rule_engine', 'point_error_guard', 'sample', 'within_10_not_worse']);
  for (const k of ['candidate', 'incumbent', 'naive_curve', 'rule_engine', 'hedge_reference']) {
    assert.ok(g[k], `the verdict no longer carries ${k}`);
  }
  // The verdict records how the incumbent was served, so the report can say it was rule (b).
  assert.match(src, /gateResult\.incumbent_serving = \{ serve_mode: theirs\.serveMode, nowcast: theirs\.nowcast \};/);
});

test('a candidate gated through 2.6.0\'s quantile map is refused at load, so the point gate runs with the map off', () => {
  const { _internals: I } = require('../services/mlPredictor');
  const meta = (fitted) => ({ model_version: '2.8.0-starling', ship_gate: { overall_pass: true, score_qmap_fitted_on: fitted } });
  assert.equal(I.evaluateShipGate(meta('2.6.0-starling')).promote, false);
  assert.equal(I.evaluateShipGate(meta(null)).promote, true);
});

test('RETRAIN.md\'s command block runs the registered procedure, with no hatch', () => {
  const doc = fs.readFileSync(path.join(ML_DIR, 'RETRAIN.md'), 'utf8').replace(/\r\n/g, '\n');
  const at = doc.indexOf('### The commands, in order');
  assert.ok(at !== -1, 'RETRAIN.md lost "The commands, in order"');
  const open = doc.indexOf('```bash\n', at);
  const close = doc.indexOf('\n```', open + 8);
  const block = doc.slice(open + 8, close);
  const commands = block.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
  for (const step of [
    'cp models/crowd_model.onnx models/model_metadata.json models/incumbent/',
    'node export_training_data.js',
    'node exportSportsEvents.js',
    'FLOCK_CALENDAR_POLICY=drop FLOCK_WEEKLY_ANCHOR_WEIGHT=auto python prepare_features.py',
    'python test_fold_category_baselines.py && python test_time_holdout.py',
    'FLOCK_TRAIN_DEVICE=cpu FLOCK_TRAIN_THREADS=12 python train_model.py',
    'CROWD_QMAP_ENABLED=false python quick_eval.py',
    'python export_model.py',
    'node bandEval.js --gate --incumbent-serve=curve_offset+nowcast',
  ]) {
    assert.ok(commands.includes(step), `the command block no longer runs: ${step}`);
  }
  // The registered rule picks the window, and no escape hatch belongs in a release.
  for (const hatch of ['FLOCK_TIME_HOLDOUT_FROM', 'FLOCK_TIME_HOLDOUT_DAYS', 'FLOCK_DEAD_SLOT_POLICY',
    'FLOCK_MIN_REALTIME_ROWS', 'ML_ALLOW_', 'ML_SHIP_GATE_OVERRIDE', '--include-harvested']) {
    assert.ok(!commands.includes(hatch), `the command block sets ${hatch}`);
  }
});
