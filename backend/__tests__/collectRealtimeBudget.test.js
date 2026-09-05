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

// ---------------------------------------------------------------------------
// 2026-09-04. scripts/ml/discoverBestTime.js, both halves, verified against the
// 2026-09-03 production dump.
//
// It minted a pseudo google_place_id (`bt_<besttime_venue_id>`) and upserted on
// it. ml_venues is UNIQUE on google_place_id and on nothing else, so a venue
// already stored under its REAL Google place id conflicted with nothing and got
// a SECOND row. 933 BestTime venue ids are held by two or more ml_venues rows;
// 111 of those groups are active philly/lehigh venues, which is the hourly
// realtime cron's whole scope, so each sweep pays two credits and writes two
// rows for one building. Willow Grove Park is ml_venues 33840 ('park', rating
// NULL, review_count 0) and 49000 ('mall', 4.4, 9,880 reviews), both active,
// both philly, both handed 168 identical weekly rows on 2026-09-01.
//
// And the training rows it wrote were all rejected while it reported success:
// `hour` held BestTime's day_raw ARRAY INDEX, six hours off the venue clock
// with no day rollover for slots 18-23, hour_axis was never set, so migration
// 023's axis CHECK raised 23514 on every row and the catch suppressed only
// 23505. "Training rows inserted: 0", exit 0.
// ---------------------------------------------------------------------------
const discover = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'discoverBestTime.js'), 'utf8');
const venueRepair = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'repairBestTimeDiscoveredVenues.js'), 'utf8');
const mlConfig = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'config.js'), 'utf8');
const baselines = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'buildBaselines.js'), 'utf8');
const migration060 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '060_ml_venues_besttime_identity.sql'), 'utf8');
const prepareFeatures = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'train', 'prepare_features.py'), 'utf8');

// The ml_venues upsert, sliced out so the assertions below read the STATEMENT
// and not the header comment that quotes the old one.
const venueUpsert = discover.slice(
  discover.indexOf('INSERT INTO ml_venues'),
  discover.indexOf('RETURNING id, google_place_id')
);

test('the discovery collector upserts on the id BestTime issues, not on one it invented', () => {
  assert.ok(venueUpsert.length > 0, 'the ml_venues upsert is gone');
  assert.doesNotMatch(venueUpsert, /ON CONFLICT \(google_place_id\)/,
    'a pseudo place id cannot arbitrate identity: the venue we already hold has a real one, so it never conflicts');
  assert.match(venueUpsert, /ON CONFLICT \(besttime_venue_id\) WHERE besttime_venue_id IS NOT NULL/,
    "the arbiter must be the BestTime id, with 060's partial predicate repeated verbatim so Postgres can infer it");
  // The conflict path must not push BestTime's blanks over Google's record.
  // Willow Grove is a 'mall' with 9,880 reviews in one row and a 'park' with
  // none in the other; the wrong DO UPDATE turns the duplicate-row defect into
  // a quieter overwrite defect.
  const doUpdate = venueUpsert.slice(venueUpsert.indexOf('DO UPDATE SET'));
  assert.match(doUpdate, /DO UPDATE SET updated_at = NOW\(\)/);
  for (const col of ['venue_category', 'rating', 'review_count', 'name', 'google_place_id']) {
    assert.ok(!new RegExp(col + '\\s*=\\s*EXCLUDED').test(doUpdate),
      col + ' is overwritten from BestTime, which knows less about the venue than the stored row does');
  }
});

test('the discovery collector refuses to spend credits it cannot store', () => {
  // Same refusal collectWeekly.requireSlotIndex makes. Without it Postgres
  // raises 42P10 once per venue and a run of thousands reports failed inserts
  // with no stated cause.
  assert.match(discover, /const VENUE_ID_INDEX = 'ml_venues_besttime_venue_id_uniq';/);
  assert.match(discover, /await requireVenueIdIndex\(pool\);/);
  assert.match(discover, /await requireSlotIndex\(pool, WEEKLY_SLOT_INDEX\);/);
  // Before the first paid search, not after it.
  assert.ok(
    discover.indexOf('await requireVenueIdIndex(pool);') < discover.indexOf('const job = await submitSearch'),
    'the refusals run after the first search has already been paid for'
  );
  // And each names the remedy, because the remedy is not "run the migration".
  assert.match(discover, /repairBestTimeDiscoveredVenues\.js/);
});

test('the discovery collector writes the venue wall clock, and says which clock it is', () => {
  // IMPORTED, not reimplemented: migration 023's SQL is pinned against
  // collectWeekly's exported transform by mlClockAxisBackfill.test.js, so a
  // second copy here is how the two would drift.
  assert.match(discover, /bestTimeSlotToLocal[\s\S]{0,120}?\} = require\('\.\/collectWeekly'\);/);
  assert.ok(!/function bestTimeSlotToLocal/.test(discover), 'the slot transform is reimplemented here');
  assert.match(discover, /const local = bestTimeSlotToLocal\(slot, jsDayOfWeek\);/);
  assert.match(discover, /const jsDayOfWeek = bestTimeDayToJsDay\(day\.day_int\);/);
  assert.ok(!/dayInt === 6 \? 0 : dayInt \+ 1/.test(discover),
    'the BestTime-to-JS day mapping is a second copy of config.bestTimeDayToJsDay');

  const insert = discover.slice(discover.indexOf('INSERT INTO ml_training_data'));
  const cols = insert.slice(0, insert.indexOf('VALUES'));
  assert.ok(cols.includes('hour_axis'),
    "hour_axis is unset, so migration 023's CHECK rejects every row and the run still reports success");
  assert.match(insert, /ON CONFLICT \(venue_id, day_of_week, hour\)\s*\n?\s*WHERE collection_mode = 'weekly' AND hour_axis = 'venue_local'/,
    "migration 024's weekly arbiter is not named, so a re-run stacks another copy of the week");
  // The catch used to swallow 23505 on the theory that a duplicate slot was
  // expected; what it hid was 23514 on every row it ever wrote.
  assert.ok(!/err\.code !== '23505'/.test(discover), 'an error class is still suppressed unread');
});

test('the discovery collector fabricates neither an event absence nor a review count', () => {
  const insert = discover.slice(discover.indexOf('INSERT INTO ml_training_data'));
  const cols = insert.slice(0, insert.indexOf('VALUES'));
  // The SQL defaults are false/false/0/0, so a row that omits these asserts a
  // measured "no event nearby" beside an honest "nothing was measured" - the
  // pairing migration 045 and repairFabricatedEventAbsence.js exist to end.
  for (const col of [
    'events_observed', 'events_unavailable_reason',
    'event_nearby', 'has_nearby_event', 'total_nearby_events', 'total_nearby_attendance',
    'nearest_event_attendance', 'nearest_event_distance_km', 'nearest_event_type',
  ]) {
    assert.ok(cols.includes(col), col + ' is missing from the discovery INSERT column list');
  }
  for (const col of [
    'event_nearby', 'has_nearby_event', 'total_nearby_events', 'total_nearby_attendance',
    'nearest_event_attendance', 'nearest_event_distance_km', 'nearest_event_type',
  ]) {
    assert.match(insert, new RegExp(col + '\\s*=\\s*EXCLUDED\\.' + col),
      col + ' is missing from the discovery DO UPDATE, so a refresh keeps the stale value');
  }
  // month and season, the same way collectWeekly stamps them, from the venue's
  // own clock - not omitted into the month = 0 corner the serving path cannot
  // reach.
  assert.match(discover, /const calendar = venueCalendar\(\{ timezone: city\.tz \}\);/);
  assert.ok(cols.includes('month') && cols.includes('season'));

  // review_count: NULL, never 0. BestTime reports no review counts, and a
  // stored zero says "nobody has ever been here" - the far end of the range.
  assert.ok(!/^\s*0,\s*$/m.test(venueUpsert), 'a literal 0 is still written into the ml_venues insert');
  // and the training rows copy the VENUE's stored metadata, so a row filed
  // under a Google-enriched venue carries that venue's category and rating
  // rather than BestTime's blanks.
  for (const col of ['venue_category', 'price_level', 'rating', 'review_count']) {
    assert.ok(discover.includes('dbVenue.' + col), col + ' is not read off the ml_venues row');
  }
});

test('a venue BestTime cannot place is skipped, not dropped in the Gulf of Guinea', () => {
  // The header comment quotes the old expression on purpose, so this reads the
  // code and not the account of what the code used to be.
  const codeLines = discover.split('\n').filter((l) => !l.trim().startsWith('//'));
  assert.ok(!codeLines.some((l) => /venue\.venue_(lat|lon) \|\| 0/.test(l)),
    'a coordinate-less venue is stored at 0,0, and weather, events and the astronomy features all read it');
  assert.match(discover, /if \(!Number\.isFinite\(lat\) \|\| !Number\.isFinite\(lon\)\) \{/);
  assert.match(discover, /noCoords\+\+;/);
  assert.match(discover, /Skipped, no coordinates/);
});

test('requiring the discovery collector does not start a paid run', () => {
  // It called discover() at import time, so a require from a test or a sibling
  // script began spending BestTime credits against whatever DATABASE_URL was set.
  assert.match(discover, /if \(require\.main === module\) \{/);
});

// ---------------------------------------------------------------------------
// Migration 060 and the repair script that finishes what it cannot.
// ---------------------------------------------------------------------------
test('060 gives besttime_venue_id a unique key and refuses to take the boot down for it', () => {
  assert.match(migration060, /CREATE UNIQUE INDEX IF NOT EXISTS ml_venues_besttime_venue_id_uniq\s*\n\s*ON ml_venues \(besttime_venue_id\)\s*\n\s*WHERE besttime_venue_id IS NOT NULL;/);
  // Production still holds the 933 groups. db/migrate.js runs the chain before
  // server.listen() and exits 1 on a failure, so an unconditional build here
  // would close the port rather than surface the problem.
  assert.match(migration060, /HAVING COUNT\(\*\) > 1/);
  assert.match(migration060, /IF dup_groups > 0 THEN\s*\n\s*RAISE NOTICE/);
  assert.match(migration060, /repairBestTimeDiscoveredVenues\.js/,
    'a migration that skips its own protection must name the thing that finishes it');
  // The DEFAULT that made "we never asked Google" indistinguishable from
  // "nobody has ever been here".
  assert.match(migration060, /ALTER TABLE ml_venues ALTER COLUMN review_count DROP DEFAULT;/);
  assert.match(migration060, /SET review_count = NULL[\s\S]{0,200}?WHERE google_place_id LIKE 'bt\\_%' ESCAPE '\\'/,
    'the fabricated zeros are cleared, scoped to rows discoverBestTime created');
  // The 186 Google-sourced zeros are a measurement and must survive: the scope
  // is the SOURCE of the row, never the value.
  assert.ok(!/WHERE review_count = 0;\s*$/m.test(migration060),
    'an unscoped clear would erase Google answering "0 reviews", which is a measurement');
});

test('the repair merges the twins, and refuses to delete a venue Google knows about', () => {
  // Report only by default, --commit to write, the shape both sibling repairs use.
  assert.match(venueRepair, /const commit = process\.argv\.includes\('--commit'\);/);
  assert.match(venueRepair, /Report only\. Re-run with --commit/);
  // The merge: collisions resolved by migration 024's survivor rule BEFORE the
  // move, because repointing venue_id is exactly what its two partial unique
  // indexes forbid, and Willow Grove's two rows hold all 168 of the same cells.
  assert.match(venueRepair, /PARTITION BY day_of_week, hour\s*\n\s*ORDER BY collected_at DESC NULLS LAST,\s*\n\s*besttime_epoch DESC NULLS LAST,\s*\n\s*id DESC/);
  assert.match(venueRepair, /PARTITION BY day_of_week, hour, observed_date/);
  assert.match(venueRepair, /UPDATE ml_training_data t\s*\n\s*SET venue_id\s*= k\.id/);
  assert.match(venueRepair, /DELETE FROM ml_venues WHERE id = \$1/);
  // The VENUE ROW survives in the 24 groups where two REAL Google places share
  // one BestTime venue: it loses the mapping, never its identity. (Its training
  // rows are another matter; see the F3 test further down.)
  assert.match(venueRepair, /besttime_venue_id = NULL,\s*\n\s*besttime_status = 'duplicate'/);
  // Batched and resumable, on a database an hourly cron is also using. The
  // transaction is the shared helper's, which is what puts the corpus lock in
  // front of every group; BEGIN and ROLLBACK live there now.
  assert.match(venueRepair, /const BATCH = \d+;/);
  assert.match(venueRepair, /await withCorpusWriteLock\(pool, async \(client\) => \{/);
  assert.match(mlConfig, /await client\.query\('BEGIN'\);/);
  assert.match(mlConfig, /await client\.query\('ROLLBACK'\)/);
  // It builds the index 060 could not, and only when nothing is left to trip it.
  assert.match(venueRepair, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS \$\{VENUE_ID_INDEX\}/);
  assert.match(venueRepair, /duplicate groups remain; NOT building/);
  // ml_venue_baselines is keyed on google_place_id, so the FK cascade never
  // reaches it and a deleted pseudo id would leave a baseline behind.
  assert.match(venueRepair, /DELETE FROM ml_venue_baselines WHERE google_place_id = \$1/);
});

test('a missing review count is imputed like a missing rating, not like a measured zero', () => {
  // rating fills with the corpus median and stores it for the holdout;
  // review_count filled with 0, the MINIMUM of its range. Paired with the
  // median rating that is a learnable signature for "this row came from the
  // discovery path", and both review_count and log_review_count are shipped
  // features.
  assert.ok(!/df\['review_count'\] = df\['review_count'\]\.fillna\(0\)/.test(prepareFeatures),
    'review_count is still filled with a measured zero');
  assert.match(prepareFeatures, /median_review_count = df\['review_count'\]\.median\(\)/);
  assert.match(prepareFeatures, /df\['review_count'\] = df\['review_count'\]\.fillna\(median_review_count\)/);
  assert.match(prepareFeatures, /'median_review_count': float\(median_review_count\),/,
    'the median is not published, so the holdout has nothing to reuse');
  // The holdout must reuse the STORED number. Recomputing one from the holdout's
  // own rows is how a fill becomes a leak.
  assert.match(prepareFeatures, /holdout_df\['review_count'\]\.fillna\(venue_metadata\['median_review_count'\]\)/);
  assert.ok(!/holdout_df\['review_count'\]\.fillna\(0\)/.test(prepareFeatures));
  // log_review_count is derived from the imputed value, not from the raw one.
  const idx = prepareFeatures.indexOf("df['review_count'] = df['review_count'].fillna(median_review_count)");
  assert.ok(
    prepareFeatures.slice(idx, idx + 200).includes("df['log_review_count'] = np.log1p(df['review_count'])"),
    'log_review_count is not recomputed from the imputed review_count'
  );
  // And the serving side is named at the site, because a model trained with a
  // median fill and served with `|| 0` has the same skew the other way round.
  assert.match(prepareFeatures, /THE SERVING SIDE MUST MATCH BEFORE THE NEXT MODEL SHIPS/);
});

test('the weekly collector survives two Google places resolving to one BestTime venue', () => {
  // Migration 060 makes besttime_venue_id unique, and the stamp at the top of
  // the per-venue loop writes it. That is a route widening and a constraint
  // arriving in the same change, which is the pairing 017's header says has
  // nearly shipped three times: 24 pairs in the 2026-09-03 dump have two
  // DIFFERENT Google places behind one BestTime venue id (a Bangkok "Taco Bell"
  // at two addresses, "100 Gramm Bar" and "100 GRAMM Lounge"), so an unhandled
  // 23505 there would become a per-venue error and ten in a row would end the
  // run.
  assert.match(weekly, /if \(err\.code !== '23505'\) throw err;/,
    'the besttime_venue_id stamp does not handle the collision its own new constraint creates');
  assert.match(weekly, /besttime_status = 'duplicate'/,
    "the venue is left unmarked, so every later run re-resolves it and hits the same wall");
  // The same word the repair script writes on the losing row of an existing
  // pair, so a reader has one term to grep for.
  assert.match(venueRepair, /besttime_status = 'duplicate'/);
  // Not a failure: the run continues and the venue is counted as skipped.
  assert.match(weekly, /Left unmapped and marked duplicate/);
});

// ---------------------------------------------------------------------------
// 2026-09-04 adversarial audit of the repair against the live cron. The
// behavioural half of each of these is in mlCorpusDedupe.test.js and
// mlClockAxisBackfill.test.js against a real server; what is pinned here is
// the SHAPE that makes the behaviour hold, so a refactor that keeps the tests
// green by accident still has to keep the lock in the right place.
// ---------------------------------------------------------------------------
test('every writer of the corpus takes one advisory lock, and the repair takes it before it reads a row', () => {
  // One name, one statement, defined once. Four callers spelling the key by
  // hand is four ways for one of them to hold a different lock.
  assert.match(mlConfig, /const ML_CORPUS_LOCK_SQL = "SELECT pg_advisory_xact_lock\(hashtext\('ml_corpus_writer'\)\)";/);
  assert.match(mlConfig, /async function withCorpusWriteLock\(pool, fn\) \{/);
  // Lock first, before any row is read or touched, so a waiter holds nothing.
  const helper = mlConfig.slice(mlConfig.indexOf('async function withCorpusWriteLock'));
  assert.ok(helper.indexOf("await client.query('BEGIN');") < helper.indexOf('await client.query(ML_CORPUS_LOCK_SQL);'));
  assert.ok(helper.indexOf('await client.query(ML_CORPUS_LOCK_SQL);') < helper.indexOf('await fn(client);'));
  for (const [name, src] of [
    ['collectRealtime', collect], ['collectWeekly', weekly],
    ['repairBestTimeDiscoveredVenues', venueRepair], ['buildBaselines', baselines],
  ]) {
    assert.match(src, /withCorpusWriteLock\b[\s\S]{0,80}?require\('\.\/config'\)/, `${name} does not import the shared lock`);
    assert.match(src, /await withCorpusWriteLock\(pool, async \(client\) => \{|return withCorpusWriteLock\(pool, async \(client\) => \{/,
      `${name} never takes the lock`);
  }
  // The repair's group transaction IS the locked callback: nothing in
  // mergeGroup runs outside it.
  const merge = venueRepair.slice(venueRepair.indexOf('async function mergeGroup'), venueRepair.indexOf('async function phase2'));
  assert.match(merge, /^\s*await withCorpusWriteLock\(pool, async \(client\) => \{/m);
  assert.ok(!/pool\.query|pool\.connect/.test(merge), 'mergeGroup touches the database outside the locked transaction');
});

test('both collectors re-resolve the venue inside the lock, immediately before the insert', () => {
  // Realtime: the id is always stored, so the check is an equality.
  const rtCheck = collect.indexOf("'SELECT 1 FROM ml_venues WHERE id = $1 AND besttime_venue_id = $2'");
  const rtLock = collect.indexOf('const result = await withCorpusWriteLock(pool, async (client) => {');
  const rtInsert = collect.indexOf("INSERT INTO ml_training_data (collection_mode,");
  assert.ok(rtLock > -1 && rtCheck > rtLock && rtInsert > rtCheck,
    'collectRealtime does not check the venue between taking the lock and inserting');
  assert.match(collect, /if \(still\.length === 0\) return null;/);
  assert.match(collect, /let vanished = 0;/);
  assert.match(collect, /vanished\+\+;/);
  // A retired venue is accounted for in the empty-run refusal, or an hour in
  // which the repair retired every venue in scope would exit non-zero.
  assert.match(collect, /skipped \+ closedSkips \+ vanished < venues\.length/);
  // Weekly: the id may have been learned this iteration, so it is the claimed
  // id, and NULL on both sides must still match.
  const wkCheck = weekly.indexOf("'SELECT 1 FROM ml_venues WHERE id = $1 AND besttime_venue_id IS NOT DISTINCT FROM $2'");
  const wkLock = weekly.indexOf('const res = await withCorpusWriteLock(pool, async (client) => {');
  // search(), not indexOf() on a literal newline: the checkout is CRLF.
  const wkInsert = weekly.search(/INSERT INTO ml_training_data\s+\(venue_id, collection_mode, hour_axis/);
  assert.ok(wkLock > -1 && wkCheck > wkLock && wkInsert > wkCheck,
    'collectWeekly does not check the venue between taking the lock and inserting');
  assert.match(weekly, /const claimedId = venue\.besttime_venue_id \|\| forecast\.venueId \|\| null;/);
  // And the 'found' stamp only lands on a row that still holds that id, so it
  // cannot overwrite the repair's 'duplicate' verdict.
  assert.match(weekly, /besttime_status = 'found'\s*\n\s*WHERE id = \$1 AND besttime_venue_id IS NOT DISTINCT FROM \$2/);
});

test('collectWeekly asks the table who holds a BestTime id before claiming it, and does not rely on the index', () => {
  // Migration 060 skips its index build while the duplicate groups exist,
  // which is production's state until the repair runs. A stamp guarded only by
  // 23505 was guarded by an error that could not fire.
  const holderLookup = weekly.indexOf('WHERE besttime_venue_id = $1 AND id <> $2');
  const claim = weekly.indexOf('SET besttime_venue_id = $1,');
  assert.ok(holderLookup > -1, 'the holder lookup is gone');
  assert.ok(holderLookup < claim, 'the id is stamped before the table is asked who holds it');
  // Both inside one locked transaction, so nothing can claim it in between.
  const claimBlock = weekly.slice(weekly.indexOf('holder = await withCorpusWriteLock(pool, async (client) => {'), claim);
  assert.ok(claimBlock.includes('WHERE besttime_venue_id = $1 AND id <> $2'),
    'the holder lookup is not in the same locked transaction as the stamp');
  // The 23505 net stays for the day the index exists.
  assert.match(weekly, /if \(err\.code !== '23505'\) throw err;/);
  assert.match(weekly, /storing it would file the same forecast under a second parent/);
});

test("the repair strips a rival of the keeper's data and keeps only what is genuinely the rival's", () => {
  // Every row under a rival was bought with the shared id, so its weekly and
  // realtime rows are the keeper's data under another name.
  assert.match(venueRepair, /DELETE FROM ml_training_data\s*\n\s*WHERE venue_id = \$1\s*\n\s*AND collection_mode IN \('weekly', 'realtime'\)/);
  // Only the collected half of its baselines: Google popular_times rows are
  // about the rival's own place id.
  assert.match(venueRepair, /DELETE FROM ml_venue_baselines WHERE google_place_id = \$1 AND source = 'collected'/);
  // The venue row itself is still not deleted.
  const rivalLoop = venueRepair.slice(venueRepair.indexOf('for (const rival of g.rivals)'), venueRepair.indexOf('async function phase2'));
  assert.ok(!/DELETE FROM ml_venues/.test(rivalLoop), 'a rival ml_venues row is deleted');
  assert.match(rivalLoop, /DROP_RIVAL_ROWS_SQL/);
  assert.match(rivalLoop, /DROP_RIVAL_BASELINES_SQL/);
  // And the reasoning for deleting rather than moving the realtime rows is in
  // the file, because it is a judgement and the next reader needs it.
  assert.match(venueRepair, /realtime rows are deleted rather than moved onto the keeper/);
});

test('the repair exits 1 when the index is not in place, and drops an INVALID leftover before rebuilding', () => {
  // A false from buildIndex used to be ignored: main awaited it and returned
  // pool.end(), exit 0, with the constraint absent.
  assert.match(venueRepair, /const built = await buildIndex\(\);\s*\n\s*if \(!built\) \{[\s\S]{0,400}?process\.exitCode = 1;/);
  // CREATE INDEX CONCURRENTLY IF NOT EXISTS skips an invalid same-name index.
  const build = venueRepair.slice(venueRepair.indexOf('async function buildIndex'), venueRepair.indexOf('async function main'));
  assert.match(build, /if \(before && before\.indisvalid === false\) \{/);
  assert.match(build, /DROP INDEX CONCURRENTLY IF EXISTS \$\{VENUE_ID_INDEX\}/);
  assert.ok(build.indexOf('DROP INDEX CONCURRENTLY') < build.indexOf('CREATE UNIQUE INDEX CONCURRENTLY'),
    'the invalid leftover is dropped after the build that would have skipped it');
  // The hard assertion reads the catalog, all four facts.
  assert.match(venueRepair, /function indexProblems\(ix\)/);
  for (const fact of ['indisunique', 'columns', 'predicate', 'indisvalid']) {
    assert.ok(venueRepair.slice(venueRepair.indexOf('function indexProblems')).includes(fact), `the assertion does not check ${fact}`);
  }
  assert.match(build, /const problems = indexProblems\(after\);\s*\n\s*if \(problems\.length > 0\) \{[\s\S]{0,600}?return false;/);
});

test('a baseline refresh is serialized, and its stamp is the evidence date of the value it writes', () => {
  // One transaction under the corpus lock: check, delete, upsert.
  const refresh = baselines.slice(baselines.indexOf('async function refreshCollectedBaselines'));
  assert.match(refresh, /return withCorpusWriteLock\(pool, async \(client\) => \{/);
  for (const stmt of ['UNDECLARED_WEEKLY_SQL', 'DELETE_STALE_SQL', 'UPSERT_SQL']) {
    assert.match(refresh, new RegExp('client\\.query\\(' + stmt + '\\)'), `${stmt} runs outside the locked transaction`);
  }
  // updated_at moves only with the value: no GREATEST that lets an older value
  // inherit a newer stamp.
  const upsert = baselines.slice(baselines.indexOf('const UPSERT_SQL'), baselines.indexOf('async function refreshCollectedBaselines'));
  assert.match(upsert, /updated_at = EXCLUDED\.updated_at/);
  assert.ok(!/GREATEST/.test(upsert), 'updated_at still takes GREATEST(old, new) independently of the value written');
  // The churn guard is unchanged, because it is what keeps re-runs free.
  assert.match(upsert, /WHERE ml_venue_baselines\.baseline IS DISTINCT FROM EXCLUDED\.baseline\s*\n\s*OR EXCLUDED\.updated_at > COALESCE\(ml_venue_baselines\.updated_at, 'epoch'::timestamptz\)/);
});
