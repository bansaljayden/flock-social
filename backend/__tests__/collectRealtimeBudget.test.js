// The hourly sweep must be over before the next trigger, or Railway skips
// the hour. Found 2026-09-04 when a 58-minute sweep forfeited 02:07.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const collect = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectRealtime.js'), 'utf8');
const svc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'bestTimeService.js'), 'utf8');

test('a sweep stops calling after fifty minutes and says what it left', () => {
  assert.match(collect, /const RUN_TIME_BUDGET_MS = 50 \* 60 \* 1000;/);
  assert.match(collect, /if \(budgetHit \|\| Date\.now\(\) - runClockStart > RUN_TIME_BUDGET_MS\) \{/);
  assert.match(collect, /leftForNextRun\+\+;/);
  assert.match(collect, /venues left for the next run \(time budget\)/);
});

test('each run starts at a random venue per city, and the city order varies', () => {
  assert.match(collect, /const off = Math\.floor\(Math\.random\(\) \* arr\.length\);\s*byCity\[k\] = arr\.slice\(off\)\.concat\(arr\.slice\(0, off\)\);/);
  assert.match(collect, /for \(const \[cityKey, cityVenues\] of cityOrder\) \{/);
});

test('the live call gives up at twenty seconds; the forecast call keeps thirty', () => {
  const live = svc.slice(svc.indexOf('/api/v1/forecasts/live?'), svc.indexOf('/api/v1/forecasts/live?') + 1000);
  // 20 s, not 10: live answers measured at 16-18 s on 2026-09-04 were all
  // aborted at 10 s and the sweep's second half wrote nothing.
  assert.match(live, /\b20000\b/);
  assert.doesNotMatch(live, /\b10000\b/);
  const fc = svc.slice(svc.indexOf('/api/v1/forecasts?'), svc.indexOf('/api/v1/forecasts?') + 200);
  assert.match(fc, /\b30000\b/);
});

test('the pace itself is untouched: one call per second', () => {
  assert.match(collect, /await sleep\(1000\);/);
});
