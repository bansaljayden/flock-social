// ---------------------------------------------------------------------------
// THE BIRDIE EVAL READS THE SERVING SWITCHES THE WAY SERVING DOES.
//
// scripts/birdie/birdieEval.js answers the crowd tool from fixture curves,
// shaped the way the serving switches in force shape a real answer. It used to
// read CROWD_SERVE_MODE with a comparison of its own that knew only
// curve_offset, so under model_when_fresh (the mix the November retrain ships
// with) it served every venue as the model, and with the nowcast off as if no
// switch were on at all. It now reads every switch with mlPredictor's own
// readers (serveMode, nowcastEnabled, hourlyAttributionOn, isFreshReading).
//
// This drives the eval's --fixtures preview, which needs no model key and
// makes no network call, at the eval's own pinned clocks, under each setting,
// and compares what the crowd tool tells Birdie: each venue's headline source,
// its confidence figure and each forecast hour's source and live-readings yes
// or no.
//
// The model side answers as an artifact, read from its metadata through the
// serving code's readers: by default the one serving loads, or --artifact=F.
// So the shape the November retrain serves under the mix (no crowd_method,
// live readings yes: its hour-old reading is a model input, and no nowcast
// or offset follows the graph) is put in front of Birdie before it ships, and
// every number carries the confidence figure serving publishes for the
// arithmetic that made it, never the model's figure on a curve's number.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const EVAL = path.join(BACKEND, 'scripts', 'birdie', 'birdieEval.js');
const cases = require('../scripts/birdie/birdieEvalCases');
const serving = require('../services/mlPredictor')._internals;

// The artifacts the previews answer as, written once outside the repo from
// the metadata serving loads. `starling` is v2.6.0-starling as served today:
// the version the quantile map and the model-table nowcast were fitted on,
// reading no live features. `retrained` is the November ship's shape: the
// live features among its inputs and a version neither table was fitted on.
// Every preview answers as starling unless it names another, so these tests
// describe the same artifacts after the ship changes the file serving loads.
const artifacts = new Map();
function artifactFile(name) {
  if (artifacts.has(name)) return artifacts.get(name);
  const meta = JSON.parse(fs.readFileSync(serving.META_PATH, 'utf8'));
  const own = meta.feature_names.filter((n) => !serving.LIVE_FEATURE_NAMES.includes(n));
  if (name === 'starling') {
    meta.model_version = serving.QMAP_FITTED_ON;
    meta.feature_names = own;
  } else {
    meta.model_version = '2.8.0-retrained';
    meta.feature_names = [...own, ...serving.LIVE_FEATURE_NAMES];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `birdie-eval-${name}-`));
  const file = path.join(dir, 'model_metadata.json');
  fs.writeFileSync(file, JSON.stringify(meta));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  artifacts.set(name, { file, meta, dir });
  return artifacts.get(name);
}
const STARLING = () => [`--artifact=${artifactFile('starling').file}`];

// One preview per setting, read once. The child gets only what a process
// needs to start, the eval's zone and the switches: no key of any kind.
// `extra` is the rest of the eval's arguments: the starling artifact unless
// a test names another (--artifact=F, --replay=F), or [] for the artifact
// serving loads.
const previews = new Map();
const artifactOf = new Map();
function preview(switches, extra = STARLING()) {
  const key = JSON.stringify([switches, extra]);
  if (previews.has(key)) return previews.get(key);
  const env = { TZ: cases.ZONE };
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  Object.assign(env, switches);
  const r = spawnSync(process.execPath, [EVAL, '--fixtures', ...extra], { cwd: BACKEND, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `the preview failed under ${key}: ${r.stderr || r.stdout}`);
  const parsed = parsePreview(r.stdout);
  assert.ok(parsed.length > 40, `the preview printed only ${parsed.length} venue lines under ${key}`);
  const named = r.stdout.match(/^artifact (\S+) \(/m);
  artifactOf.set(key, named ? named[1] : null);
  previews.set(key, parsed);
  return parsed;
}
const artifactUnder = (switches, extra = STARLING()) => {
  preview(switches, extra);
  return artifactOf.get(JSON.stringify([switches, extra]));
};

// The preview's venue lines, one record per clock and venue:
//   head   the line after `open=`
//   score, label  the headline number and its word (null on an error line)
//   source crowd_source, method crowd_method (null when none was sent)
//   conf   { published, percent, metric }: confidence, and the measured
//          percent and metric confidence_measurement gives (both null when
//          it is unmeasured); null when the result carries neither
//   hours  [{ hour, score, method, live }], live true, false or undefined
function parsePreview(stdout) {
  const lines = stdout.split(/\r?\n/);
  const out = [];
  let clock = null;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\S+ (\w+) \(/);
    if (header && header[1] in cases.CLOCKS) { clock = header[1]; continue; }
    const m = lines[i].match(/^(\S+)\s+open=([yn]) (.*)$/);
    if (!m || !clock || !cases.byKey.has(m[1])) continue;
    const src = m[3].match(/\bsrc=([a-z_]+)(?:\/([a-z0-9_]+))?/);
    const num = m[3].match(/^score=(\d+) "([^"]+)"/);
    const cf = m[3].match(/ conf=(\d+)\((?:([\d.]+) ([a-z0-9_]+)|[a-z_]+)\)$/);
    const next = lines[i + 1] || '';
    const hours = /^\s{11}\d/.test(next)
      ? [...next.matchAll(/(\d{1,2} [AP]M)=(\d+)(?:\/([a-z0-9_]+))?([+-]live)?/g)].map((h) => ({
        hour: h[1], score: Number(h[2]), method: h[3] || null, live: h[4] ? h[4] === '+live' : undefined,
      }))
      : [];
    out.push({
      clock, key: m[1], open: m[2] === 'y', head: m[3],
      score: num ? Number(num[1]) : null, label: num ? num[2] : null,
      source: src ? src[1] : null, method: src && src[2] ? src[2] : null,
      conf: cf ? { published: Number(cf[1]), percent: cf[2] ? Number(cf[2]) : null, metric: cf[3] || null } : null,
      hours,
    });
  }
  return out;
}

const corpus = (key) => Boolean(cases.byKey.get(key).corpus);
const NOW = { CROWD_NOWCAST_ENABLED: 'true' };
const MODEL = { CROWD_SERVE_MODE: 'model', ...NOW };
const MIX = { CROWD_SERVE_MODE: 'model_when_fresh', ...NOW };
const MODEL_SIDE = /^(model_live|live_reading_1h)$/;

function paired(a, b) {
  assert.equal(a.length, b.length);
  return a.map((x, i) => {
    assert.equal(`${x.clock} ${x.key}`, `${b[i].clock} ${b[i].key}`);
    return [x, b[i]];
  });
}

test('unset, model and a value serving does not know answer alike, as they do in serving', () => {
  const unset = preview(NOW);
  assert.deepEqual(preview(MODEL), unset);
  assert.deepEqual(preview({ CROWD_SERVE_MODE: 'model-when-fresh', ...NOW }), unset);
  assert.deepEqual(preview({ CROWD_SERVE_MODE: 'Model', ...NOW }), unset);
});

test('under model_when_fresh a venue with an hour-old reading gets the model setting\'s answer and every other venue its curve', () => {
  // The best-time and peak words are left out: the route ranks "now" against
  // later hours on the curve plus the offset whenever an hour of the strip was
  // made by the curve (crowdEngine servedCurveShift), so under the mix they
  // can change with the same numbers, as they do in serving.
  const said = (r) => ({ score: r.score, label: r.label, source: r.source, method: r.method });
  let modelSide = 0;
  let curveSide = 0;
  for (const [mix, model] of paired(preview(MIX), preview(MODEL))) {
    const where = `${mix.clock} ${mix.key}`;
    if (model.source === 'model_holdout' && MODEL_SIDE.test(model.method || '')) {
      // The reading is fresh: the number and its source are the model
      // setting's.
      assert.deepEqual(said(mix), said(model), where);
      modelSide++;
    } else if (model.source === 'model_holdout' && corpus(mix.key)) {
      assert.deepEqual(said(mix), { ...said(model), method: 'venue_pattern' }, `${where}: no fresh reading, so the venue's curve made it`);
      curveSide++;
    } else {
      // The owner's reading, the category table and the errors answer before
      // any serve mode is read.
      assert.deepEqual(said(mix), said(model), where);
      if (mix.score === null) assert.equal(mix.head, model.head, where);
    }
    assert.equal(mix.hours.length, model.hours.length, where);
    mix.hours.forEach((h, k) => {
      const m = model.hours[k];
      assert.equal(h.score, m.score, `${where} ${h.hour}: the fixture's number`);
      if (m.live === undefined || MODEL_SIDE.test(m.method || '') || !corpus(mix.key)) {
        assert.deepEqual(h, m, `${where} ${h.hour}`);
      } else {
        assert.deepEqual(h, { ...m, method: 'venue_pattern', live: false }, `${where} ${h.hour}: the curve side`);
      }
    });
  }
  assert.ok(modelSide >= 5 && curveSide >= 10, `both sides must be exercised (model ${modelSide}, curve ${curveSide})`);
});

test('under model_when_fresh with the nowcast off the eval still sees a switch, and still picks each side', () => {
  const mix = preview({ CROWD_SERVE_MODE: 'model_when_fresh' });
  const off = preview({});
  const model = preview(MODEL);
  paired(mix, off);
  paired(mix, model);
  let attributed = 0;
  mix.forEach((r, i) => {
    const where = `${r.clock} ${r.key}`;
    assert.deepEqual(r.hours.map((h) => h.score), off[i].hours.map((h) => h.score), `${where}: the fixture's numbers`);
    for (const h of off[i].hours) assert.equal(h.live, undefined, `${where} ${h.hour}: switched off, no hour says`);
    if (!corpus(r.key) || r.source !== 'model_holdout') return;
    // A fresh reading is one the model setting's nowcast carried; with the
    // nowcast off the model makes that number with nothing blended in, and
    // the curve makes every other one.
    const fresh = MODEL_SIDE.test(model[i].method || '');
    assert.equal(r.method, fresh ? null : 'venue_pattern', where);
    // Every hour says what made it, which the switched-off preview never does,
    // and none has a live reading in it: no nowcast, and the fixture keeps no
    // trailing offset.
    for (const h of r.hours) assert.equal(h.live, false, `${where} ${h.hour}`);
    attributed++;
  });
  assert.ok(attributed >= 15, `too few model-path venues (${attributed})`);
});

test('under curve_offset every model-path number is the venue\'s curve or its hour-old reading, never the model', () => {
  const co = preview({ CROWD_SERVE_MODE: 'curve_offset', ...NOW });
  let n = 0;
  for (const r of co) {
    if (!corpus(r.key)) continue;
    if (r.source === 'model_holdout') {
      assert.match(r.method || '', /^(venue_pattern|live_reading_1h)$/, `${r.clock} ${r.key}`);
      n++;
    }
    for (const h of r.hours) assert.notEqual(h.method, 'model_live', `${r.clock} ${r.key} ${h.hour}`);
  }
  assert.ok(n >= 15, `too few model-path venues (${n})`);
});

test('every model-path answer carries the confidence figure serving publishes for the arithmetic that made it', () => {
  // servedConfidence's figures, per arithmetic: the curve and offset, their
  // nowcast at an hour, the model's number with an hour-old reading blended
  // in (the quantile map is on and starling is the artifact it and the
  // model-table nowcast were fitted on, so the model_qmap table), and the
  // quantile map's figure for the model's number alone. Every fixture city
  // has a weather reading, so nothing is taken off the published integer for
  // its absence.
  const { SERVE_MEASURED, QMAP_MEASURED } = serving;
  const nowcastModel = ['within_15_nowcast_model_qmap_lag1', SERVE_MEASURED.nowcast.model_qmap[1].within15];
  const figure = {
    venue_pattern: ['within_15_curve_offset', SERVE_MEASURED.curveOffset.within15],
    curve_live_reading_1h: ['within_15_nowcast_curve_offset_lag1', SERVE_MEASURED.nowcast.curve_offset[1].within15],
    model_live: nowcastModel,
    model_live_reading_1h: nowcastModel,
    model: ['within_15_score_qmap', QMAP_MEASURED.within15],
  };
  const settings = [
    [{}, 'model'], [NOW, 'model'], [MIX, 'mix'], [{ CROWD_SERVE_MODE: 'model_when_fresh' }, 'mix'],
    [{ CROWD_SERVE_MODE: 'curve_offset', ...NOW }, 'curve_offset'], [{ CROWD_SERVE_MODE: 'curve_offset' }, 'curve_offset'],
  ];
  const seen = new Set();
  for (const [switches, mode] of settings) {
    for (const r of preview(switches)) {
      if (r.source !== 'model_holdout' || !r.conf) continue;
      const where = `${JSON.stringify(switches)} ${r.clock} ${r.key}`;
      let side = 'model';
      if (r.method === 'venue_pattern') side = 'venue_pattern';
      else if (r.method === 'live_reading_1h') side = mode === 'curve_offset' ? 'curve_live_reading_1h' : 'model_live_reading_1h';
      else if (r.method === 'model_live') side = 'model_live';
      else assert.equal(r.method, null, where);
      const [metric, percent] = figure[side];
      assert.deepEqual(r.conf, { published: Math.round(percent), percent, metric }, `${where}: ${side}`);
      seen.add(side);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(figure).sort(), 'every arithmetic must be exercised');
});

test('as an artifact that reads the live features, a venue with an hour-old reading under the mix gets the model\'s number with no crowd_method and live readings yes', () => {
  // The November retrain's shape: its version takes neither the quantile map
  // nor the model-table nowcast, and it takes no offset after the graph, so
  // the hour-old reading reaches the number only as one of the graph's
  // inputs. The confidence figure is the artifact's own measured one.
  const { file, meta } = artifactFile('retrained');
  const art = [`--artifact=${file}`];
  const own = meta.training_metrics_by_population.realtime_served.within_15;
  // Which venues the mix answers from the model is the reading's age alone,
  // whatever the artifact: the ones starling's nowcast carried.
  const fresh = new Set(preview(MIX).filter((r) => MODEL_SIDE.test(r.method || '')).map((r) => `${r.clock} ${r.key}`));
  assert.ok(fresh.size >= 5, `too few venues with an hour-old reading (${fresh.size})`);
  for (const switches of [MIX, { CROWD_SERVE_MODE: 'model_when_fresh' }]) {
    assert.equal(artifactUnder(switches, art), meta.model_version);
    for (const [now, was] of paired(preview(switches, art), preview(switches))) {
      const where = `${JSON.stringify(switches)} ${now.clock} ${now.key}`;
      if (fresh.has(`${now.clock} ${now.key}`)) {
        assert.deepEqual(
          { score: now.score, label: now.label, source: now.source, method: now.method, conf: now.conf },
          { score: was.score, label: was.label, source: 'model_holdout', method: null, conf: { published: Math.round(own), percent: own, metric: 'within_15' } },
          where,
        );
        assert.equal(now.hours[0].live, true, `${where}: the headline says it used live readings`);
      } else {
        // The curve side, the owner's reading, the category table and the
        // errors read nothing of the artifact that reaches Birdie.
        assert.deepEqual({ ...now, hours: null }, { ...was, hours: null }, where);
      }
      assert.equal(now.hours.length, was.hours.length, where);
      now.hours.forEach((h, k) => {
        const w = was.hours[k];
        // Under the mix a venue's curve-side hour is its pattern alone, and
        // every other attributed hour of a venue with a curve is the model's,
        // with the reading in it.
        if (w.live === undefined || w.method === 'venue_pattern' || !corpus(now.key)) assert.deepEqual(h, w, `${where} ${h.hour}`);
        else assert.deepEqual(h, { ...w, method: null, live: true }, `${where} ${h.hour}: the model read the reading`);
      });
    }
  }
});

test('a replay answers as the artifact its recorded run named, under the switches it recorded', () => {
  const { file, dir, meta } = artifactFile('retrained');
  const run = path.join(dir, 'recorded-run.json');
  fs.writeFileSync(run, JSON.stringify({ meta: { switches: MIX, artifact: { file: path.relative(BACKEND, file), modelVersion: meta.model_version } }, items: [] }));
  assert.equal(artifactUnder({}, [`--replay=${run}`]), meta.model_version);
  assert.deepEqual(preview({}, [`--replay=${run}`]), preview(MIX, [`--artifact=${file}`]));
});

test('with no --artifact the eval answers as the artifact serving loads', () => {
  const served = JSON.parse(fs.readFileSync(serving.META_PATH, 'utf8')).model_version;
  assert.equal(artifactUnder(MIX, []), served);
  // While that is v2.6.0-starling, the starling fixture these tests pin is
  // the same artifact, so every answer matches it.
  if (served === serving.QMAP_FITTED_ON) assert.deepEqual(preview(MIX, []), preview(MIX));
});

test('the eval restates no switch: every one is read through the serving code\'s readers', () => {
  const src = fs.readFileSync(EVAL, 'utf8');
  assert.doesNotMatch(src, /process\.env\.CROWD_SERVE_MODE\s*[!=]==/);
  assert.doesNotMatch(src, /process\.env\.CROWD_NOWCAST_ENABLED\s*[!=]==/);
  for (const reader of ['serveMode', 'nowcastEnabled', 'hourlyAttributionOn', 'isFreshReading']) {
    assert.match(src, new RegExp(`serving\\.${reader}\\(`), reader);
  }
  // Nor the artifact: its version, its inputs and its figures are read off
  // its metadata by serving's readers, never written in.
  for (const reader of ['readServedAccuracy', 'qmapEnabled', 'nowcastBaseKey', 'artifactReadsLiveFeatures', 'liveFeaturesUsedReadings', 'servedConfidence', 'servedModelVersion']) {
    assert.match(src, new RegExp(`serving\\.${reader}\\(`), reader);
  }
  assert.doesNotMatch(src, /'2\.6\.0-starling'/, 'a version written into the eval answers as that artifact whatever serving loads');
  // Every mode serving knows runs the eval. A mode added to serving fails here
  // until birdieEval.js curveSide says which side of it a number takes.
  const { SERVE_MODES } = require('../services/mlPredictor')._internals;
  assert.deepEqual([...SERVE_MODES].sort(), ['curve_offset', 'model', 'model_when_fresh'],
    'a new serve mode: teach birdieEval.js curveSide which side its numbers take');
  for (const mode of SERVE_MODES) preview({ CROWD_SERVE_MODE: mode, ...NOW });
});
