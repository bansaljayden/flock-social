// The demo's cold area build says where its time went (routes/publicCrowd.js
// logBuildTime): one line for a slow build, naming the four steps in order,
// and nothing for a quick one, so a hit or a fast miss never fills the log.
const { test } = require('node:test');
const assert = require('node:assert');

const { logBuildTime, SLOW_BUILD_MS } = require('../routes/publicCrowd').__testables;

function captured(fn) {
  const lines = [];
  const prev = console.log;
  console.log = (m) => { lines.push(String(m)); };
  try { fn(); } finally { console.log = prev; }
  return lines;
}

test('a slow build is one line with each step\'s share, in the order they ran', () => {
  const t = 1_000_000;
  const phases = { start: t, places: t + 400, weather: t + 470, venues: t + 2870, card: t + 6830 };
  const lines = captured(() => logBuildTime(phases, 8));
  assert.deepStrictEqual(lines, [
    '[PublicDemo] slow area build 6.8 s: Places search 0.4 s, weather 0.1 s, 8 venue(s) scored 2.4 s, featured card 4.0 s',
  ]);
});

test('a build under the threshold says nothing', () => {
  const t = 2_000_000;
  const quick = { start: t, places: t + 300, weather: t + 320, venues: t + 700, card: t + SLOW_BUILD_MS - 1 };
  assert.deepStrictEqual(captured(() => logBuildTime(quick, 8)), []);
  assert.strictEqual(SLOW_BUILD_MS, 1500);
});
