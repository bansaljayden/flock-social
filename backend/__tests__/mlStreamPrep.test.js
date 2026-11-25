// ---------------------------------------------------------------------------
// THE STREAMED FEATURE PREPARATION WRITES WHAT THE IN-MEMORY ONE WRITES, UNDER
// node --test.
//
// A training export of tens of millions of rows does not fit the training PC
// as one frame, so prepare_features.main() hands such an export to
// main_streamed(), which reads training_data.csv in slices and writes X to a
// memory-mapped .npy beside features_train.pkl (FLOCK_PREP_STREAM,
// FLOCK_PREP_STREAM_MIN_ROWS, FLOCK_PREP_CHUNK_ROWS). Nothing about that may
// change a number. This runs scripts/ml/train/test_stream_prep.py, which builds a
// synthetic export holding every trap a slice can fall into (types inferred per
// parser chunk, sums in another order, value_counts ties), prepares it both
// ways and requires model_metadata.json and features_holdout.pkl byte-identical
// and every key of features_train.pkl equal, X bit for bit. Skipped, not
// failed, where Python with pandas is absent.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');

const PY = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

test('test_stream_prep.py passes: the streamed preparation equals the in-memory one',
  { skip: PY ? false : 'python with pandas not available', timeout: 600000 }, () => {
    const r = spawnSync(PY, ['test_stream_prep.py'], { cwd: TRAIN_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr.slice(-4000)}`);
    const summary = r.stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, r.stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 8, `only ${summary[2]} checks ran`);
  });
