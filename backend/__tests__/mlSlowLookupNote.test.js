// A score whose slowest lookup took a second or more says which lookup it was
// (services/mlPredictor.js noteSlowLookups), and each kind of slow read speaks
// at most once every ten seconds, so eight venues scored side by side make one
// line. A quick score says nothing.
const { test } = require('node:test');
const assert = require('node:assert');

const { _internals: I } = require('../services/mlPredictor');

function captured(fn) {
  const lines = [];
  const prev = console.log;
  console.log = (m) => { lines.push(String(m)); };
  try { fn(); } finally { console.log = prev; }
  return lines;
}

test('a slow score names its four lookups, once in ten seconds', () => {
  I.slowNoted.clear();
  const lines = captured(() => {
    I.noteSlowLookups([180, 12, 40, 2700]);
    I.noteSlowLookups([150, 10, 35, 2650]);
  });
  assert.deepStrictEqual(lines, [
    '[MLPredictor] slow lookups for one score: events 180 ms, feedback 12 ms, baseline 40 ms, neighbours 2700 ms',
  ]);
});

test('a quick score says nothing, and the threshold is a second', () => {
  I.slowNoted.clear();
  assert.deepStrictEqual(captured(() => I.noteSlowLookups([120, 8, 30, I.SLOW_LOOKUP_MS - 1])), []);
  assert.strictEqual(I.SLOW_LOOKUP_MS, 1000);
});

test('each kind of slow read keeps its own ten seconds', () => {
  I.slowNoted.clear();
  const lines = captured(() => {
    I.noteSlow('box', 'slow neighbour box scan: 2400 ms for 41000 baseline rows in 168 slots');
    I.noteSlow('self', 'slow venue curve read: 1100 ms for 168 rows');
    I.noteSlow('box', 'slow neighbour box scan: 2300 ms for 39000 baseline rows in 168 slots');
  });
  assert.deepStrictEqual(lines, [
    '[MLPredictor] slow neighbour box scan: 2400 ms for 41000 baseline rows in 168 slots',
    '[MLPredictor] slow venue curve read: 1100 ms for 168 rows',
  ]);
});
