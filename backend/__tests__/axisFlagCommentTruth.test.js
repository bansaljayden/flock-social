// Run: node --test  (from backend/)
//
// ===========================================================================
// THE COMMENTS AROUND ML_BASELINE_AXIS_VERIFIED MUST DESCRIBE THE FLAG THAT
// EXISTS, NOT THE ONE THAT USED TO.
//
// This flag decides whether an ML crowd answer is published as a measurement
// (basis 'model_holdout', supported: true, confidenceMeans 'measured_accuracy')
// or hedged. It flipped to true with v2.6.0-starling on 2026-08-18, once the
// clock-axis correction reached the weights themselves — the collector, the
// 023 backfill and the single baseline writer had already landed.
//
// Four comments did not flip with it:
//   * services/mlPredictor.js said the flag "stays false" until the retrain,
//     and its status header still called the retrain PENDING;
//   * services/crowdEngine.js said the confidence figure sat on a corpus the
//     flag "still refuses to vouch for";
//   * services/mlPredictor.js's confidenceMeasurement note said
//     describePredictionSupport "still returns supported:false for the ML path
//     while ML_BASELINE_AXIS_VERIFIED is false";
//   * routes/crowd.js said the same thing a third time, in the payload note
//     beside confidenceMeans. Three of the four were named in the audit; the
//     fourth was found by the flattened-prose scan below, which is the argument
//     for scanning rather than fixing the three by hand and moving on.
//
// These are not decoration. They are what a future reader consults when
// deciding what this system is allowed to assert to a user, and all three told
// that reader the opposite of what the code does. A comment that has to be
// checked against the code before it can be trusted is worse than no comment.
//
// WHAT THIS FILE DOES NOT DO: it does not require the flag to be true. If the
// served artifact is rolled back to a pre-2026-08-18 model the flag SHOULD go
// back to false, and then the old sentences become correct again. So the
// assertions are conditional on the flag's live value, read out of the source.
// Rolling the flag back and rolling the prose back together passes; moving one
// without the other fails.
//
// The caution those comments carried is separately pinned below, because
// re-aiming it must not mean losing it: the confidence integer is still the
// served-population figure and still must not be swapped for the blended one.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8').replace(/\r\n/g, '\n');

// Comment prose, flattened: the `//` markers and the line breaks are stripped so
// a claim that happens to wrap across two lines is still one sentence here.
// That wrapping is exactly how the third stale comment hid.
function commentProse(source) {
  return source
    .split('\n')
    .filter((l) => /^\s*\/\//.test(l))
    .map((l) => l.replace(/^\s*\/\/ ?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

const crowdEngineSrc = read('services/crowdEngine.js');
const mlPredictorSrc = read('services/mlPredictor.js');

const FLAG_DECL = /^const ML_BASELINE_AXIS_VERIFIED = (true|false);$/m;

test('the flag is declared exactly once, with a literal this file can read', () => {
  const m = crowdEngineSrc.match(FLAG_DECL);
  assert.ok(m, 'ML_BASELINE_AXIS_VERIFIED is no longer a plain boolean literal in crowdEngine.js');
  assert.strictEqual(
    (crowdEngineSrc.match(/^const ML_BASELINE_AXIS_VERIFIED/gm) || []).length, 1);
});

const flagIsTrue = crowdEngineSrc.match(FLAG_DECL)[1] === 'true';

// Sentences that ASSERT the flag is currently false. Deliberately narrow: the
// files legitimately say "TURN THIS BACK TO false if ..." and describe the
// false branch of describePredictionSupport, and neither is a claim about the
// present state.
const CLAIMS_FALSE = [
  /ML_BASELINE_AXIS_VERIFIED stays false/i,
  /ML_BASELINE_AXIS_VERIFIED is false/i,
  /while ML_BASELINE_AXIS_VERIFIED is false/i,
  /ML_BASELINE_AXIS_VERIFIED (?:still )?refuses to vouch/i,
  /ML_BASELINE_AXIS_VERIFIED (?:is |remains |stays )?(?:still )?unverified/i,
];

const SOURCES = [
  ['services/crowdEngine.js', crowdEngineSrc],
  ['services/mlPredictor.js', mlPredictorSrc],
  ['routes/crowd.js', read('routes/crowd.js')],
];

test('no comment claims the flag is false while it is true', () => {
  if (!flagIsTrue) return; // rolled back; the old sentences are correct again
  for (const [name, src] of SOURCES) {
    const prose = commentProse(src);
    for (const re of CLAIMS_FALSE) {
      const hit = prose.match(re);
      // `assert.ok`, not strictEqual against the match object: a failing
      // strictEqual would print the whole flattened comment stream of the file.
      assert.ok(hit === null,
        `${name} tells a reader the axis flag is false while it is true: "${hit && hit[0]}"`);
    }
  }
});

test('no comment claims the retrain is still outstanding while the flag is true', () => {
  if (!flagIsTrue) return;
  const prose = commentProse(mlPredictorSrc);
  // The flag can only be true because the weights landed. A comment saying the
  // retrain is pending contradicts the flag by itself, whether or not it names it.
  for (const re of [/step 4 \(the retrain\) PENDING/i, /4\. NOT DONE/i, /the retrain is blocked on/i]) {
    assert.ok(prose.match(re) === null,
      `services/mlPredictor.js still describes the retrain as outstanding: ${re}`);
  }
});

test('the comments name the version that flipped the flag, so the claim is checkable', () => {
  if (!flagIsTrue) return;
  const version = require('../scripts/ml/models/model_metadata.json').model_version;
  assert.ok(commentProse(crowdEngineSrc).includes(version),
    `crowdEngine.js does not say which artifact justifies the flag (served: ${version})`);
  assert.ok(commentProse(mlPredictorSrc).includes(version),
    `mlPredictor.js does not say which artifact justifies the flag (served: ${version})`);
});

// ── The caution that survives the flip ─────────────────────────────────────

test('the served-accuracy warning is re-aimed, not deleted', () => {
  // The flag flipping says the axis is trustworthy. It says nothing about WHICH
  // metric may be published as the confidence integer, and the blended figure
  // is still the wrong one: ~84% of its rows are weekly snapshots whose label
  // equals the baseline by construction.
  const metadata = require('../scripts/ml/models/model_metadata.json');
  const byPop = metadata.training_metrics_by_population || {};
  // `all_rows` is the canonical home of the blended figure; older artifacts
  // also duplicated it at the top level as `training_metrics`. Read the
  // by-population block first so this does not depend on the duplicate.
  const blended = (byPop.all_rows || metadata.training_metrics || {}).within_15;
  const served = (byPop.realtime_served || {}).within_15;
  assert.ok(Number.isFinite(blended) && Number.isFinite(served),
    'the served artifact publishes no per-population within-15 to check the comments against');
  assert.ok(blended > served, 'the fixture assumption is gone: the blended figure is no longer the flattering one');

  for (const [name, src] of [['services/crowdEngine.js', crowdEngineSrc], ['services/mlPredictor.js', mlPredictorSrc]]) {
    const prose = commentProse(src);
    assert.ok(prose.includes(String(served)),
      `${name} no longer names the served-population figure (${served}%) that may be published`);
    assert.ok(prose.includes(String(blended)),
      `${name} no longer warns against the blended figure (${blended}%)`);
  }
});

test('the rollback instruction is still there, since the flip is not permanent', () => {
  for (const [name, src] of [['services/crowdEngine.js', crowdEngineSrc], ['services/mlPredictor.js', mlPredictorSrc]]) {
    assert.ok(/TURN (?:THIS|THE FLAG) BACK TO false/i.test(commentProse(src)),
      `${name} lost the instruction to flip the flag back on an artifact rollback`);
  }
});

test('the code the comments describe still behaves that way', () => {
  const crowdEngine = require('../services/crowdEngine');
  const support = crowdEngine.describePredictionSupport('ml', 0);
  if (flagIsTrue) {
    assert.deepStrictEqual(support,
      { basis: 'model_holdout', supported: true, confidenceMeans: 'measured_accuracy' });
  } else {
    assert.deepStrictEqual(support,
      { basis: 'model_unverified_axis', supported: false, confidenceMeans: 'input_completeness' });
  }
  // Verified reporters outrank the holdout either way — the one claim in those
  // comments that the flip did not touch.
  assert.strictEqual(crowdEngine.describePredictionSupport('ml', 99).basis, 'user_reports');
});
