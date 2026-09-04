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

// ---------------------------------------------------------------------------
// 2026-09-04 16:56 UTC. The sweep stopped after 271 of 1414 calls having
// written 149 rows, exited non-zero, and told the reader to go and check the
// BestTime subscription. Every one of the ten errors that tripped the breaker
// was "This operation was aborted", which is our own AbortController at twenty
// seconds, and nine of the ten were consecutive Starbucks venues. Not one 403.
// Not one 5xx in that run. The venue list groups chains together, so a run of
// slow answers is the normal shape of this data, not a coincidence.
// ---------------------------------------------------------------------------
test('a timeout on our own clock is not evidence that BestTime is down', () => {
  // One definition of "network error", shared, so the two places that decide
  // cannot drift.
  assert.match(svc, /module\.exports = \{ fetchWeeklyForecast, fetchLiveBusyness, NETWORK_ERR_RE \};/);
  assert.match(collect, /const \{ fetchLiveBusyness, NETWORK_ERR_RE \} = require\('\.\/bestTimeService'\);/);
  // Its own counter and its own ceiling, the way a 503 throttle already has.
  assert.match(collect, /let consecutiveNetwork = 0;/);
  assert.match(collect, /const networkish = err && NETWORK_ERR_RE\.test\(String\(err\.message \|\| ''\)\);/);
  assert.match(collect, /if \(consecutiveNetwork >= 25\) \{/);
  assert.match(collect, /25 calls in a row timed out or could not connect, aborting run/);
  // All three counters reset on a success.
  assert.match(collect, /consecutiveErrors = 0;\s*consecutiveThrottles = 0;\s*consecutiveNetwork = 0;/);
});

test('the refusal names what actually stopped the run', () => {
  // The 403 story was printed on every abort, whatever caused it, because the
  // 403 story is the one that cost 90 days. A refusal that misdiagnoses spends
  // the reader's attention in the wrong place, and here it accused the paid
  // subscription over ten client-side timeouts.
  assert.match(collect, /let abortReason = null;/);
  for (const reason of ['fatal', 'throttled', 'network', 'upstream']) {
    assert.match(collect, new RegExp(`abortReason = '${reason}';`), `${reason} names itself`);
  }
  assert.match(collect, /\}\[abortReason\] \|\| 'The reason was not recorded/);
  assert.match(collect, /timed out on OUR clock or could not connect/);
});

test('every enrichment column is written, including the one the comment miscounted', () => {
  // enrichWithEvents.js declares nearest_event_attendance INTEGER DEFAULT 0, and
  // the collector's own comment explains why the enrichment columns must be
  // written explicitly: a default writes a measured absence where nothing was
  // measured. It named six and there are seven. So every realtime row asserted
  // the nearest event had nobody at it, beside an event_size that might say two
  // hundred, and the model carries nearest_event_attendance and
  // log_nearest_event_attendance as features. Realtime rows are the scarce live
  // labels the hourly cadence exists to produce.
  for (const col of [
    'has_nearby_event', 'total_nearby_events', 'total_nearby_attendance',
    'nearest_event_attendance', 'nearest_event_distance_km', 'nearest_event_type',
    'events_unavailable_reason',
  ]) {
    assert.ok(collect.includes("['" + col + "',"), col + ' is written explicitly');
  }
  // And it is null when the lookup did not happen, never a defaulted zero.
  assert.match(collect, /\['nearest_event_attendance', eventData\.observed === true \? \(eventData\.event_size \|\| 0\) : null\]/);
  assert.match(collect, /The SEVEN enrichment columns are written EXPLICITLY/);
});
