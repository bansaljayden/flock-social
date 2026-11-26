// ---------------------------------------------------------------------------
// A MODELS DIRECTORY THAT SHIPS ONLY crowd_model.onnx.gz.
//
// A 2,000-tree model is over GitHub's 100 MB per-file limit as a plain .onnx,
// so the repo Railway builds from can carry it only gzipped. mlPredictor.js
// (onnxSource) reads crowd_model.onnx when it exists and otherwise gunzips
// crowd_model.onnx.gz in memory; bandEval.loadArtifact points both names at
// the directory it is given. These tests copy the tracked artifact into a temp
// directory as .gz only and prove:
//   a. mlPredictor's own loader and bandEval.loadArtifact both load it;
//   b. the graph's outputs on a fixed batch, and predictBusyness's answers,
//      are identical to the plain file's;
//   c. with both files present the plain .onnx is the one read;
//   d. a corrupt or truncated .gz is refused loudly, never served.
// It also runs scripts/ml/train/test_onnx_gz.py, which pins the export's
// writer (model_files.gzip_bytes: deterministic, level 9, mtime 0, no name)
// and the Python readers' rule. Skipped, not failed, without Python.
// The tracked models/ directory is never written.
//
// Run: node --test __tests__/mlOnnxGz.test.js  (from backend/)
// ---------------------------------------------------------------------------

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

delete process.env.TICKETMASTER_API_KEY;
delete process.env.ML_SHIP_GATE_OVERRIDE;

const B = require('../scripts/ml/train/bandEval');
// Before mlPredictor builds its pool: nothing here may reach a real database.
B.isolateFromDatabases();

const MOD = require.resolve('../services/mlPredictor');
const MODELS_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'models');
const SERVED_ONNX = path.join(MODELS_DIR, 'crowd_model.onnx');
const SERVED_GZ = `${SERVED_ONNX}.gz`;
const SERVED_META = path.join(MODELS_DIR, 'model_metadata.json');

let tmp;
let plainOnly;
let gzOnly;
let both;
let corrupt;
let truncated;

function writeDir(name, files) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.copyFileSync(SERVED_META, path.join(dir, 'model_metadata.json'));
  for (const [file, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), bytes);
  return dir;
}

before(() => {
  // The tracked graph, whichever form models/ ships it in.
  assert.ok(fs.existsSync(SERVED_ONNX) || fs.existsSync(SERVED_GZ), 'models/ holds neither crowd_model.onnx nor its .gz');
  const raw = fs.existsSync(SERVED_ONNX) ? fs.readFileSync(SERVED_ONNX) : zlib.gunzipSync(fs.readFileSync(SERVED_GZ));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-onnx-gz-'));
  const gz = zlib.gzipSync(raw, { level: 9 });
  plainOnly = writeDir('plain-only', { 'crowd_model.onnx': raw });
  gzOnly = writeDir('gz-only', { 'crowd_model.onnx.gz': gz });
  // Both present, and the .gz is garbage: if it were read at all the load
  // would fail, so a successful load proves the plain file was used.
  both = writeDir('both', { 'crowd_model.onnx': raw, 'crowd_model.onnx.gz': Buffer.from('not gzip at all') });
  // A valid gzip header followed by garbage, and a real .gz cut short.
  corrupt = writeDir('corrupt', { 'crowd_model.onnx.gz': Buffer.concat([gz.subarray(0, 10), Buffer.alloc(4096, 0x5a)]) });
  truncated = writeDir('truncated', { 'crowd_model.onnx.gz': gz.subarray(0, Math.floor(gz.length / 2)) });
});

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// A fresh mlPredictor whose fixed models/ paths are pointed at `dir` at the fs
// boundary, the way mlTwoHeadReconstruction.test.js patches it: the served
// crowd_model.onnx exists only if `dir` has one, the served .gz reads `dir`'s.
// Console output is captured so a refusal's reason can be asserted.
async function withPredictorOn(dir, fn) {
  const real = { existsSync: fs.existsSync, readFileSync: fs.readFileSync };
  const redirect = (p) => {
    const s = path.resolve(String(p));
    if (s === SERVED_ONNX) return path.join(dir, 'crowd_model.onnx');
    if (s === SERVED_GZ) return path.join(dir, 'crowd_model.onnx.gz');
    return p;
  };
  const created = [];
  const ort = require('onnxruntime-node');
  const realCreate = ort.InferenceSession.create;
  const logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const savedMod = require.cache[MOD];
  try {
    fs.existsSync = (p, ...rest) => real.existsSync.call(fs, redirect(p), ...rest);
    fs.readFileSync = (p, ...rest) => real.readFileSync.call(fs, typeof p === 'string' ? redirect(p) : p, ...rest);
    ort.InferenceSession.create = (src, ...rest) => {
      created.push(typeof src === 'string' ? path.resolve(src) : `<${src.constructor.name} ${src.length} bytes>`);
      return realCreate.call(ort.InferenceSession, typeof src === 'string' ? redirect(src) : src, ...rest);
    };
    console.log = (...a) => logs.push(a.join(' '));
    console.warn = console.log;
    console.error = console.log;
    delete require.cache[MOD];
    const fresh = require(MOD);
    const loaded = await fresh.init();
    Object.assign(console, saved);
    return await fn({ fresh, loaded, logs, created });
  } finally {
    fs.existsSync = real.existsSync;
    fs.readFileSync = real.readFileSync;
    ort.InferenceSession.create = realCreate;
    Object.assign(console, saved);
    delete require.cache[MOD];
    if (savedMod) require.cache[MOD] = savedMod;
  }
}

// A fixed batch: 64 rows in the graph's width, from a seeded generator, each
// column in a plausible range for its name.
function fixedBatch(meta) {
  let seed = 20261126;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const names = meta.feature_names;
  const rows = [];
  for (let i = 0; i < 64; i++) {
    rows.push(names.map((n) => {
      if (n === 'hour') return Math.floor(rnd() * 24);
      if (n === 'day_of_week') return Math.floor(rnd() * 7);
      if (n === 'month') return 1 + Math.floor(rnd() * 12);
      if (/^(is_|season_|weather_|gtype_|etype_|rain_x_|cold_|event_nearby)/.test(n)) return rnd() < 0.3 ? 1 : 0;
      return rnd() * 100;
    }));
  }
  return rows;
}

async function runBatch(session, meta) {
  const ort = require('onnxruntime-node');
  const rows = fixedBatch(meta);
  const width = meta.feature_names.length;
  const flat = new Float32Array(rows.length * width);
  rows.forEach((r, i) => flat.set(r, i * width));
  const res = await session.run({ [meta.onnx_input_name || 'input']: new ort.Tensor('float32', flat, [rows.length, width]) });
  return Array.from(res[session.outputNames[0]].data);
}

const WEATHER = { temp: 64, humidity: 50, windSpeed: 6, isRaining: false, conditionId: 800 };
const TS = new Date(2026, 9, 16, 21, 0, 0, 0);
function venues() {
  return [30, 55, 80].map((fill, i) => ({
    place_id: `onnx-gz-${i}`,
    name: `Gz Venue ${i}`,
    types: i === 1 ? ['restaurant', 'food', 'establishment'] : ['bar', 'restaurant', 'food', 'establishment'],
    rating: 4.0 + i * 0.2,
    price_level: 2,
    user_ratings_total: 200 + 100 * i,
    location: { latitude: 40.72 + i * 0.01, longitude: -73.99 },
    popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array.from({ length: 24 }, (_, h) => Math.min(100, fill + ((h * 7 + d) % 20))) })),
  }));
}

test('a: mlPredictor loads a .gz-only models directory, from the decompressed bytes', async () => {
  await withPredictorOn(gzOnly, async ({ fresh, loaded, logs, created }) => {
    assert.equal(loaded, true, `the .gz-only artifact was refused: ${logs.join(' | ')}`);
    assert.equal(created.length, 1);
    assert.match(created[0], /^<Buffer \d+ bytes>$/, 'the session must be built from the gunzipped bytes');
    assert.equal(Number(created[0].match(/\d+/)[0]), fs.statSync(path.join(plainOnly, 'crowd_model.onnx')).size);
    assert.ok(logs.some((l) => /crowd_model\.onnx is absent; read crowd_model\.onnx\.gz/.test(l)), logs.join('\n'));
    assert.equal(fresh._internals.getMetadata().model_version, JSON.parse(fs.readFileSync(SERVED_META, 'utf8')).model_version);
  });
});

test('a: bandEval.loadArtifact scores a .gz-only directory', async () => {
  const art = await B.loadArtifact(gzOnly);
  assert.equal(art.dir, path.resolve(gzOnly));
  assert.ok(art.session, 'no session');
});

test('b: the .gz graph answers a fixed batch and predictBusyness exactly as the plain file does', async () => {
  // The plain file, served the way production serves it today.
  let meta;
  let plain;
  const plainAnswers = [];
  await withPredictorOn(plainOnly, async ({ fresh, loaded, logs, created }) => {
    assert.equal(loaded, true, `the plain artifact was refused: ${logs.join(' | ')}`);
    assert.deepEqual(created, [SERVED_ONNX]);
    meta = fresh._internals.getMetadata();
    plain = await runBatch(fresh._internals.getSession(), meta);
    for (const v of venues()) plainAnswers.push(await fresh.predictBusyness(v, WEATHER, TS));
  });
  assert.ok(plainAnswers.some((r) => r.predictionMethod === 'ml'), 'no venue reached the model, so the comparison proves nothing');
  assert.ok(new Set(plain).size > 1, 'the batch must not collapse to one output');

  const artPlain = await B.loadArtifact(plainOnly);
  const artGz = await B.loadArtifact(gzOnly);
  assert.deepEqual(await runBatch(artPlain.session, artPlain.meta), plain);
  assert.deepEqual(await runBatch(artGz.session, artGz.meta), plain, 'bandEval\'s .gz session diverged from the plain graph');

  await withPredictorOn(gzOnly, async ({ fresh, loaded, created }) => {
    assert.equal(loaded, true);
    assert.match(created[0], /^<Buffer /);
    assert.deepEqual(await runBatch(fresh._internals.getSession(), meta), plain, 'mlPredictor\'s .gz session diverged from the plain graph');
    const gzAnswers = [];
    for (const v of venues()) gzAnswers.push(await fresh.predictBusyness(v, WEATHER, TS));
    // baselineData.asOf is the clock at the call, the one field that may differ.
    const timeless = (rs) => rs.map((r) => ({ ...r, baselineData: r.baselineData && { ...r.baselineData, asOf: undefined } }));
    assert.deepEqual(timeless(gzAnswers), timeless(plainAnswers));
  });
});

test('c: with both files present the plain .onnx is read and the .gz is never opened', async () => {
  await withPredictorOn(both, async ({ loaded, logs, created }) => {
    assert.equal(loaded, true, `refused: ${logs.join(' | ')}`);
    assert.deepEqual(created, [SERVED_ONNX], 'the session must be created from the plain path, exactly as before the .gz existed');
    assert.ok(!logs.some((l) => /crowd_model\.onnx\.gz/.test(l)), logs.join('\n'));
  });
  const art = await B.loadArtifact(both);
  assert.ok(art.session);
});

test('d: a corrupt or truncated .gz is refused loudly and the rule engine serves', async () => {
  for (const [what, dir] of [['corrupt', corrupt], ['truncated', truncated]]) {
    await withPredictorOn(dir, async ({ fresh, loaded, logs, created }) => {
      assert.equal(loaded, false, `${what}: a broken .gz was promoted`);
      assert.deepEqual(created, [], `${what}: onnxruntime must never see the bytes`);
      assert.ok(logs.some((l) => /Failed to load model: crowd_model\.onnx\.gz could not be decompressed/.test(l)),
        `${what}: the refusal must name the file and why:\n${logs.join('\n')}`);
      const r = await fresh.predictBusyness(venues()[0], WEATHER, TS);
      assert.notEqual(r.predictionMethod, 'ml', `${what}: a refused artifact answered as the model`);
    });
    await assert.rejects(() => B.loadArtifact(dir), /the serving path refused .*crowd_model\.onnx\.gz could not be decompressed/,
      `${what}: bandEval must refuse with the reason`);
  }
});

test('a directory with neither file is refused by bandEval before anything loads', async () => {
  const empty = writeDir('neither', {});
  await assert.rejects(() => B.loadArtifact(empty), /does not hold crowd_model\.onnx \(or crowd_model\.onnx\.gz\) and model_metadata\.json/);
});

const PY = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import gzip, zlib, hashlib'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

test('test_onnx_gz.py passes: the export\'s gzip is deterministic and round-trips, and the Python readers take a .gz',
  { skip: PY ? false : 'python not available' }, () => {
    const r = spawnSync(PY, ['test_onnx_gz.py'], { cwd: path.join(__dirname, '..', 'scripts', 'ml', 'train'), encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const summary = r.stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, r.stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 6, `only ${summary[2]} checks ran`);
  });
