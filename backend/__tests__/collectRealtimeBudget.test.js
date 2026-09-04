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
  // THREE STATES, and the pin used to allow only two. `event_size || 0` met
  // the letter of "never a defaulted zero when the lookup did not happen" and
  // broke it the other way: Ticketmaster publishes capacity for almost nothing,
  // eventService maps a missing capacity to null, and `null || 0` is 0 - so
  // every live detection wrote "there is an event within 2 km and nobody is at
  // it". All 1,052 such rows in the corpus say that. enrichWithEvents defaults
  // the same quantity to 500, so the two writers disagreed by construction.
  //
  //   observed, nothing nearby        -> 0     (a real measurement)
  //   observed, event of unknown size -> null  (we looked; they do not publish it)
  //   not observed                    -> null  (we could not look)
  for (const col of ['total_nearby_attendance', 'nearest_event_attendance']) {
    const m = collect.match(new RegExp("\\['" + col + "',[\\s\\S]{0,260}?\\],"));
    assert.ok(m, col + ' is not written at all');
    const expr = m[0];
    assert.ok(!/event_size \|\| 0/.test(expr),
      col + ': `event_size || 0` turns an unpublished capacity into a measured zero');
    assert.match(expr, /event_size \?\? null/,
      col + ': an unknown capacity must be null, not a number');
    assert.match(expr, /event_nearby === true/,
      col + ': a measured zero is only honest when the lookup found nothing nearby');
    assert.match(expr, /observed === true/,
      col + ': a lookup that did not happen must be null');
  }
  assert.match(collect, /The SEVEN enrichment columns are written EXPLICITLY/);
});

// ---------------------------------------------------------------------------
// The event channel asked a different question than the corpus answers.
// ---------------------------------------------------------------------------
const eventSvc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'eventService.js'), 'utf8');
const weekly = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectWeekly.js'), 'utf8');
const repair = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'repairFabricatedEventAbsence.js'), 'utf8');

const enrich = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'enrichWithEvents.js'), 'utf8');

test('the WEEKLY insert names all seven enrichment columns too', () => {
  // The same defect as the realtime one above, left behind in the other
  // collector. nearest_event_attendance is INTEGER DEFAULT 0, so a fresh weekly
  // row got a measured attendance of zero beside three NULLs and an honest
  // events_observed = false - the exact pairing migration 045 and
  // repairFabricatedEventAbsence exist to erase, recreated on every insert.
  const insert = weekly.slice(weekly.indexOf('INSERT INTO ml_training_data'));
  const cols = insert.slice(0, insert.indexOf('VALUES'));
  for (const col of [
    'event_nearby', 'has_nearby_event', 'total_nearby_events', 'total_nearby_attendance',
    'nearest_event_attendance', 'nearest_event_distance_km', 'nearest_event_type',
  ]) {
    assert.ok(cols.includes(col), `${col} is missing from the weekly INSERT column list`);
    // And in DO UPDATE, or a refreshed row keeps stale enrichment beside a
    // reset events_observed - the invariant the statement states about itself.
    assert.match(insert, new RegExp(col + '\\s*=\\s*EXCLUDED\\.' + col),
      `${col} is missing from the weekly DO UPDATE, so a re-collection keeps the stale value`);
  }
});

test('enrichWithEvents does not rewrite what collectRealtime measured live', () => {
  // It reconstructs event context from ml_events, a historical table that ends
  // in 2026-05. collectRealtime resolves the nearest event live and writes those
  // columns itself. Unscoped, this script found no ml_events entry for any
  // post-cutoff date and NULLed every live measurement to
  // events_observed = false / 'no_events_on_date', while leaving
  // collectRealtime's own event_nearby and event_size beside it, so the row
  // contradicted itself. Every live detection in the corpus would have gone
  // that way the first time it ran.
  assert.match(enrich, /collection_mode IS DISTINCT FROM 'realtime'/,
    'the rebuild is not scoped away from realtime rows');
  const select = enrich.slice(enrich.indexOf('SELECT t.id, t.day_of_week'));
  assert.match(select.slice(0, select.indexOf('ORDER BY')), /WHERE \$\{REBUILDABLE\}/,
    'the chunk query walks every row, realtime included');
});

test('a weekly venue whose insert failed is not stamped as collected', () => {
  // The batch insert's catch logs and continues, so a venue whose 168-row
  // statement died fell through to the last_collected_at stamp with zero rows
  // written. --skip-collected and --skip-attempted then excluded it from every
  // later pass, permanently, and consecutiveErrors was reset so ten such
  // venues in a row could not trip the abort.
  const stamp = weekly.indexOf("UPDATE ml_venues SET last_collected_at = NOW()");
  assert.ok(stamp > -1, 'the collected stamp is gone');
  const before = weekly.slice(Math.max(0, stamp - 1200), stamp);
  assert.match(before, /if \(insertFailed \|\| venueRows === 0\)/,
    'last_collected_at is written without checking that any row landed');
  assert.match(before, /consecutiveErrors\+\+/,
    'a venue that wrote nothing does not count toward the abort');
  // And the failure path must still be paced: skipping the sleep would lift
  // the rate limit exactly when the run is going wrong.
  assert.ok(!/if \(insertFailed \|\| venueRows === 0\)[\s\S]{0,900}?\n\s*continue;/.test(weekly),
    'the no-rows path continues past the pacing sleep');
});

test('the collector means by "nearby" what the corpus and the model mean', () => {
  // 5 km and no time filter at all: the nearest UPCOMING event was reported as
  // happening now, so a concert next Saturday stamped has_nearby_event on a
  // Tuesday afternoon observation and the channel became a proxy for "this
  // venue is in a city". enrichWithEvents uses 2 km with an hour-range test and
  // mlPredictor uses 2 km with a [hour - 3, hour + 1) window.
  assert.match(eventSvc, /const NEARBY_KM = 2;/);
  assert.match(eventSvc, /const EVENT_MAX_DURATION_H = 3;/);
  assert.match(eventSvc, /startDateTime: startDt,\s*endDateTime: endDt,/);
  assert.match(eventSvc, /if \(dist > NEARBY_KM\) continue;/);
  assert.match(eventSvc, /startedAt < windowOpen \|\| startedAt >= windowClose\) continue;/);
  // A provider that answered with nothing near right now is a measured absence.
  assert.match(eventSvc, /if \(!nearest && anyMeasurable\) \{/);
});

test('one event-type vocabulary, the one the model was trained on', () => {
  // This returned 'concert' and 'film' while the feature one-hots are
  // music/sports/arts/family/other, so a music event produced has_nearby_event
  // = 1 with all five etype slots at 0, a combination absent from the corpus.
  assert.match(eventSvc, /if \(seg\.includes\('music'\)\) return 'music';/);
  assert.match(eventSvc, /if \(seg\.includes\('family'\)\) return 'family';/);
  assert.doesNotMatch(eventSvc, /return 'concert';/);
  assert.doesNotMatch(eventSvc, /return 'film';/);
});

test('a row is stamped with the hour it was observed, not the hour the sweep began', () => {
  // `local` is read once per city and a sweep runs up to fifty minutes, so the
  // tail of a run crossing an hour boundary was filed under the previous hour.
  // This is a delta model anchored on (venue, day_of_week, hour), so those rows
  // were differenced against the wrong baseline cell, and the dedupe key is
  // built from the same clock.
  assert.match(collect, /const obs = getLocalTime\(venue\.timezone \|\| cityConfig\.tz\);/);
  for (const col of ['day_of_week', 'hour', 'month', 'season', 'observed_date']) {
    assert.ok(collect.includes("['" + col + "', obs."), col + ' reads the row clock');
  }
  // And the date-derived answers follow it, so a midnight crossing cannot stamp
  // the previous day's holiday onto rows observed after it.
  assert.match(collect, /const obsSpecial = specialNightFor\(cityKey, obs\.dateStr\);/);
  assert.match(collect, /const obsHolidayEve = isHolidayEve\(cityKey, obs\.dateStr\);/);
  assert.ok(collect.includes("['is_holiday', isHoliday(obs.dateStr)]"));
});

test('the weekly upsert refreshes every column it inserts', () => {
  // The invariant is stated three lines above the block and was broken: a
  // re-collection flipped events_observed to the honest value while the SQL
  // defaults survived beside it, undoing the repair script on that row.
  for (const col of ['event_nearby', 'has_nearby_event', 'total_nearby_events', 'total_nearby_attendance']) {
    assert.match(weekly, new RegExp(col + String.raw`\s*= EXCLUDED\.` + col), col + ' is refreshed');
  }
});

test('the repair script can see its own miss', () => {
  // It NULLed six columns and verified six, so it left the seventh asserting a
  // measurement on 136,920 rows and then printed "Remaining: 0 (expected 0)".
  assert.match(repair, /nearest_event_attendance = NULL,/);
  assert.strictEqual((repair.match(/OR nearest_event_attendance IS NOT NULL/g) || []).length, 2);
  assert.match(repair, /left the SEVEN enrichment columns/);
});
