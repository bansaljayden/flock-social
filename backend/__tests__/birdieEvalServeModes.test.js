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
// and compares what the crowd tool tells Birdie: each venue's headline source
// and each forecast hour's source and live-readings yes or no.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const EVAL = path.join(BACKEND, 'scripts', 'birdie', 'birdieEval.js');
const cases = require('../scripts/birdie/birdieEvalCases');

// One preview per setting, read once. The child gets only what a process
// needs to start, the eval's zone and the switches: no key of any kind.
const previews = new Map();
function preview(switches) {
  const key = JSON.stringify(switches);
  if (previews.has(key)) return previews.get(key);
  const env = { TZ: cases.ZONE };
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  Object.assign(env, switches);
  const r = spawnSync(process.execPath, [EVAL, '--fixtures'], { cwd: BACKEND, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `the preview failed under ${key}: ${r.stderr || r.stdout}`);
  const parsed = parsePreview(r.stdout);
  assert.ok(parsed.length > 40, `the preview printed only ${parsed.length} venue lines under ${key}`);
  previews.set(key, parsed);
  return parsed;
}

// The preview's venue lines, one record per clock and venue:
//   head   the line after `open=`
//   score, label  the headline number and its word (null on an error line)
//   source crowd_source, method crowd_method (null when none was sent)
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
    const next = lines[i + 1] || '';
    const hours = /^\s{11}\d/.test(next)
      ? [...next.matchAll(/(\d{1,2} [AP]M)=(\d+)(?:\/([a-z0-9_]+))?([+-]live)?/g)].map((h) => ({
        hour: h[1], score: Number(h[2]), method: h[3] || null, live: h[4] ? h[4] === '+live' : undefined,
      }))
      : [];
    out.push({
      clock, key: m[1], open: m[2] === 'y', head: m[3],
      score: num ? Number(num[1]) : null, label: num ? num[2] : null,
      source: src ? src[1] : null, method: src && src[2] ? src[2] : null, hours,
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

test('the eval restates no switch: every one is read through the serving code\'s readers', () => {
  const src = fs.readFileSync(EVAL, 'utf8');
  assert.doesNotMatch(src, /process\.env\.CROWD_SERVE_MODE\s*[!=]==/);
  assert.doesNotMatch(src, /process\.env\.CROWD_NOWCAST_ENABLED\s*[!=]==/);
  for (const reader of ['serveMode', 'nowcastEnabled', 'hourlyAttributionOn', 'isFreshReading']) {
    assert.match(src, new RegExp(`serving\\.${reader}\\(`), reader);
  }
  // Every mode serving knows runs the eval. A mode added to serving fails here
  // until birdieEval.js curveSide says which side of it a number takes.
  const { SERVE_MODES } = require('../services/mlPredictor')._internals;
  assert.deepEqual([...SERVE_MODES].sort(), ['curve_offset', 'model', 'model_when_fresh'],
    'a new serve mode: teach birdieEval.js curveSide which side its numbers take');
  for (const mode of SERVE_MODES) preview({ CROWD_SERVE_MODE: mode, ...NOW });
});
