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
// ways and requires model_metadata.json and features_holdout.pkl byte-identical,
// every key of features_train.pkl equal (X bit for bit), and the string columns
// sharing str objects as the in-memory pickle's do (with X put back inline the
// pickle is the same bytes). It also requires the time holdout's cutoff to count
// a live reading that only a holdout city has, and the in-memory outputs to
// match goldens written by the code from before the streamed path (a mismatch
// under numpy or pandas versions other than the goldens' is reported as SKIP,
// shown here as a diagnostic). Skipped, not failed, where Python with pandas is
// absent.
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

// spawnSync blocks the event loop, so the test's own timeout cannot fire while
// it runs: the child gets its own, and the test a minute more to report it.
const RUN_MS = 600000;

test('test_stream_prep.py passes: the streamed preparation equals the in-memory one',
  { skip: PY ? false : 'python with pandas not available', timeout: RUN_MS + 60000 }, (t) => {
    const r = spawnSync(PY, ['test_stream_prep.py'], {
      cwd: TRAIN_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: RUN_MS,
    });
    const stdout = r.stdout || '';
    assert.equal(r.status, 0, [
      `status ${r.status}, signal ${r.signal}${r.error ? `, error ${r.error.message}` : ''}`,
      stdout, (r.stderr || '').slice(-4000)].join('\n'));
    for (const line of stdout.match(/^SKIP .*$/gm) || []) t.diagnostic(line);
    const summary = stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 10, `only ${summary[2]} checks ran`);
  });
