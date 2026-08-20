/**
 * ONE ORDERING FLOOR, SPELLED IN TWO FILES.
 *
 * backend/services/crowdEngine.js HOUR_ORDERING_MIN_GAP is the measured floor
 * under every "which hour is better" decision Flock makes: inside it, the
 * model orders two hours in one venue-night no better than a coin flip, and
 * the popular-times curve alone does the job very slightly better
 * (backend/scripts/ml/HOUR-RANKING-EVAL.md). The server refuses to name a
 * quiet hour, a standout or a direction below that gap.
 *
 * The card's "Expected Crowd by Hour" trend arrow draws its OWN comparison,
 * client side, between the current hour and the next one. It used to use a
 * 5 point dead zone justified in a code comment by the model's LEVEL error
 * ("MAE is ~5pts"), which is the exact substitution the ordering evaluation
 * ruled out: how far a number sits from the truth licenses nothing about
 * whether one hour outranks another. So the card printed "Rising" inside the
 * band where the sentence directly beside it says the hours look alike.
 *
 * The client cannot import the server's constant, so it mirrors it, and a
 * mirrored constant is a constant that drifts. This pins the two together.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP_PATH = path.resolve(__dirname, '../App.js');
const CROWD_ENGINE_PATH = path.resolve(__dirname, '../../../backend/services/crowdEngine.js');

// Normalised to LF: these files are CRLF on disk (see birdieWindowAndDemoLock).
const readSource = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const appSource = readSource(APP_PATH);
const engineSource = readSource(CROWD_ENGINE_PATH);

const declaredGap = (src) => {
  const m = src.match(/const HOUR_ORDERING_MIN_GAP = (\d+);/);
  return m ? Number(m[1]) : null;
};

describe('the hour-ordering floor', () => {
  test('the server declares one, and it is the measured ten', () => {
    expect(declaredGap(engineSource)).toBe(10);
  });

  test('the client mirrors the server value exactly', () => {
    const client = declaredGap(appSource);
    expect(client).not.toBeNull();
    expect(client).toBe(declaredGap(engineSource));
  });

  test('the trend arrow decides on the named constant, never on a literal', () => {
    // The block between the heading and the bar chart.
    const start = appSource.indexOf('Expected Crowd by Hour');
    expect(start).toBeGreaterThan(-1);
    const block = appSource.slice(start, start + 3000);
    const arrow = block.slice(0, block.indexOf("{arrow} {label}"));
    expect(arrow).toContain('diff >= HOUR_ORDERING_MIN_GAP');
    expect(arrow).toContain('diff <= -HOUR_ORDERING_MIN_GAP');
    expect(arrow).not.toMatch(/diff >= \d/);
    expect(arrow).not.toMatch(/diff <= -\d/);
  });

  test('the dead zone is never justified by the level error again', () => {
    const start = appSource.indexOf('Expected Crowd by Hour');
    const block = appSource.slice(start, start + 3000);
    const arrow = block.slice(0, block.indexOf("{arrow} {label}"));
    // The old comment read "model's MAE is ~5pts so use that as the dead-zone
    // threshold". An ordering claim may not cite a level statistic.
    expect(arrow).not.toMatch(/MAE is ~?\d+ ?pts? so use that/i);
    expect(arrow).toMatch(/HOUR-RANKING-EVAL/);
  });
});
