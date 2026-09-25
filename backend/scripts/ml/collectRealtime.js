// ---------------------------------------------------------------------------
// Mode 2: Collect BestTime live busyness snapshots with real-time weather
// Produces ~250 rows per run (one per venue). Run periodically via cron.
// Run: node scripts/ml/collectRealtime.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { getWeather } = require('../../services/weatherService');
const { fetchLiveBusyness, NETWORK_ERR_RE } = require('./bestTimeService');
const { CITIES, getLocalTime, isHoliday, isSchoolBreak, sleep, withCorpusWriteLock } = require('./config');
const {
  getNearestEvent, fetchTicketmasterPage, fetchSeatGeekEvents, nearestEventFromAnswers, distanceKm,
  NEARBY_KM, TM_PAGE_SIZE,
} = require('./eventService');
const { specialNightFor, isHolidayEve } = require('./specialNights');
const { refreshCollectedBaselines, REFUSAL_MESSAGE } = require('./buildBaselines');
const { buildRecentDeviation } = require('./buildRecentDeviation');
const { requireSlotIndex } = require('./collectWeekly');

// Migration 024's realtime arbiter. Same reasoning as collectWeekly's: a
// missing column can be created here, a missing unique index cannot, and a
// silent 42P10 per venue is a worse outcome than one clear refusal.
const REALTIME_SLOT_INDEX = 'ml_training_data_realtime_slot_uniq';

// ---------------------------------------------------------------------------
// THE HOUR AXIS. This collector has always written the TRUE venue-local hour
// (config.getLocalTime(tz).hour) into ml_training_data.hour — but it never said
// so, and scripts/ml/collectWeekly.js was writing BestTime's array index into
// the same column. Two clocks, one column, nothing marking which. Every row
// written from here now declares `hour_axis = 'venue_local'`; migration 023
// converts the weekly half to the same axis and adds the CHECK constraint that
// stops an undeclared weekly row from ever being inserted again.
// ---------------------------------------------------------------------------
const HOUR_AXIS_VENUE_LOCAL = 'venue_local';

// ---------------------------------------------------------------------------
// THE LABEL AXIS (round 19). The hour axis above had two clocks in one column;
// this column has two ESTIMANDS in one column, and until 2026-08-13 nothing
// marked which. BestTime's live endpoint answers with a forecast always and a
// live reading sometimes, and this collector stores whichever it got in
// `busyness_pct`. A forecast row is a vendor model's output; a live row is an
// observation of foot traffic. They are not the same quantity, and a model
// trained on a mixture of them with no marker is partly trained to predict a
// prediction.
//
// MEASURED against production on 2026-08-15, read-only:
//   * all 457,402 realtime rows carry label_source IS NULL, so all 369,076 that
//     survive into training export as label_provenance='unknown';
//   * they also carry observed_date IS NULL, hour_axis IS NULL and
//     besttime_epoch IS NULL — the corpus stopped on 2026-05-18, months before
//     any of those columns existed;
//   * NOTHING else stored separates the two. Both series live on the same
//     21-point grid (0,5,...,100 — every one of the 457,402 realtime values and
//     every one of the 3,454,955 weekly values is a multiple of 5), and
//     "realtime value equals this venue's weekly forecast for the same slot"
//     matches 5.64% of rows against 4.72-6.89% for the same test aimed at a
//     deliberately WRONG slot. The signal is indistinguishable from chance.
//
// So the legacy rows stay 'unknown' forever. That is a fact to record, not a
// gap to fill: see migration 025's header. What follows is the go-forward fix.
// ---------------------------------------------------------------------------

// The label domain. `unknown` is deliberately NOT here — it is what the
// exporter says about a row that never declared itself, never a value this
// collector may write.
const LABEL_LIVE = 'live';
const LABEL_FORECAST = 'forecast';

// The whole live/forecast decision, in one pure function, exported so the test
// can table-drive it without a database or a network.
//
// `live.liveAvailable` is the ONLY evidence. BestTime echoes its own forecast
// into venue_live_busyness when it has no live data (see bestTimeService's
// header), so the presence of a number there proves nothing. The comparison is
// `=== true` rather than truthiness, and the fallthrough is 'forecast' rather
// than 'live', because the two mistakes are not symmetric: a vendor forecast
// mislabelled 'live' is trained at sample weight 1.0 as if it were ground
// truth, while a live reading mislabelled 'forecast' is merely downweighted to
// 0.3. When in doubt, doubt.
//
// Returns null when there is nothing nameable to store. A row whose value
// cannot be named is exactly what produced the 457,402 unknowns, so it is
// dropped rather than written unlabelled.
function classifyReading(live) {
  if (!live || typeof live !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const liveValue = num(live.liveBusyness);
  const forecastValue = num(live.forecastedBusyness);

  if (live.liveAvailable === true && liveValue !== null) {
    // vendorForecast rides along even here — in fact ESPECIALLY here. It is the
    // counterfactual: what BestTime would have said if it had had no live data.
    // WITHIN-CITY-EVAL.md asks how far the model's labels sit from the vendor's
    // own prediction and cannot answer, because we were handed both numbers in
    // the same response and threw one away. Storing it costs no extra call.
    return { source: LABEL_LIVE, busyness: liveValue, vendorForecast: forecastValue };
  }
  if (forecastValue !== null) {
    // On a forecast row the two are the same number by construction, which is
    // an invariant the test pins: a 'forecast' row whose vendor_forecast_pct
    // disagrees with its busyness_pct would mean this mapping had drifted.
    return { source: LABEL_FORECAST, busyness: forecastValue, vendorForecast: forecastValue };
  }
  return null;
}

const clampPct = (v) => (v == null ? null : Math.max(0, Math.min(100, v)));

// ---------------------------------------------------------------------------
// THE OPEN-HOURS FILTER (2026-09-03). WHY A CALL AT 4 AM IS A CALL WASTED.
// ---------------------------------------------------------------------------
// Live readings are the scarce thing in the corpus: 1,198 rows out of 3.9M
// carry label_source='live', and RETRAIN.md blames the 91% weekly-snapshot mix
// for a model that shrinks every prediction toward "no deviation". More live
// readings per day is the whole point of running this collector more often.
//
// What stops that is not the BestTime bill, it is the CLOCK. The pacing below
// is one call per second and it is not negotiable (two account-wide 403s bought
// that number), so a sweep of the ~1,400 PA venues is the 47 to 60 minutes
// RETRAIN.md measured on 2026-09-01, whatever else changes. Skipping calls is
// the only lever that does not touch pacing. (Superseded on 2026-09-25 in one
// respect: the pace now limits STARTS, and overlapping slow calls is a second
// lever that leaves it alone. See OVERLAPPING CALLS below.)
//
// BE PRECISE ABOUT WHICH SKIPS THIS CAN RECOVER, because the counters are easy
// to misread. The last run before this filter existed reported 245 rows against
// 1,149 skips, and those 1,149 are NOT 1,149 shut venues: that run swept at
// 22:00-23:00 Philadelphia time, where this rule would still have called 1,199
// of the 1,414 and skipped 215. Most of those skips are simply venues BestTime
// holds no live coverage for, at any hour, and no rule here can predict those. What this
// filter recovers is the OTHER kind, and it is worth the most exactly when the
// cron is cheapest to add: measured against production 2026-09-03, of the 1,414
// PA venues it leaves uncalled 1,055 at 02:00 local, 1,038 at 05:00, 691 at
// 08:00, and only 17 at 17:00. That is what makes an overnight run affordable.
//
// REAL OPENING HOURS, CHECKED FOR FIRST. ml_venues has no hours column (its 20
// columns are id, google_place_id, besttime_venue_id, name, address, city,
// lat/lng, venue_category, google_types, price_level, rating, review_count,
// timezone, is_active, last_collected_at, created_at, updated_at,
// besttime_attempted_at, besttime_status — verified against production, not
// against the migration). Google's currentOpeningHours IS fetched, by
// services/placeDetailsCache.js, but per request and into memory: nothing
// persists it, so consulting it here would mean buying ~1,400 Enterprise Place
// Details calls per sweep to save BestTime calls. That trade is absurd.
//
// WHAT IS ALREADY STORED IS BETTER ANYWAY. The weekly corpus is BestTime's own
// forecast curve for each venue, on the venue_local hour axis since migration
// 023, and BestTime writes 0 for every hour a venue is shut. Production holds
// all 24 hours x 7 days for 1,387 of the 1,414 PA venues. So a venue is treated
// as open at local hour H when its own weekly curve rises above zero anywhere
// in H-2..H+2, on ANY day of the week. No new data, no new vendor, no new
// clock: the same rows the model trains on. A venue is judged only when its
// weekly rows cover all 24 hours — a partial curve is a hole in our collection,
// not a closed venue, and it may not be read as one.
//
// WHY WEEK-WIDE AND WHY +/-2, MEASURED RATHER THAN CHOSEN. Read-only against
// production on 2026-09-03, over all 1,198 live readings we have ever
// collected, counting how many sit in a slot each candidate rule would have
// called closed:
//     same (venue, day-of-week, hour), no padding ... 29 lost
//     same (venue, day-of-week, hour) +/-1 .......... 17 lost
//     week-wide hour, no padding .................... 18 lost
//     week-wide hour +/-1 ............................ 7 lost
//     week-wide hour +/-2 ............................ 0 lost
// A forecast of 0 does not always mean "shut" — it also means "open and never
// busy enough for BestTime to model" — which is exactly why the rule has to be
// the widest one and not the tightest. +/-2 week-wide is the only candidate
// that would not have cost us a single live reading in the record, so it is the
// one that ships. A venue with NO weekly evidence is called, and a failure to
// load the evidence at all calls everything: every unknown resolves toward
// spending the call.
//
// This decides ONLY whether a venue is called. Nothing below it changes what a
// row contains: hour, hour_axis, label_source, provenance and the ON CONFLICT
// key are untouched.
// ---------------------------------------------------------------------------
const OPEN_HOUR_PAD = 2;

// The 24 venue-local hours a venue may be called at, as a bitmask. Pure, and
// exported, so the test can table-drive it with no database and no network.
function buildOpenHourMask(hours, pad = OPEN_HOUR_PAD) {
  let mask = 0;
  for (const raw of hours || []) {
    const hour = Number(raw);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    for (let d = -pad; d <= pad; d++) mask |= 1 << ((hour + d + 24) % 24);
  }
  return mask;
}

// `mask` undefined/null is "this venue has no weekly evidence", which is a
// reason to call it, not a reason to skip it. Same for an hour outside 0..23,
// which cannot happen (config.getLocalTime is h23) but must not silently mean
// "closed" if it ever did.
function isOpenAtHour(mask, hour) {
  if (mask === undefined || mask === null) return true;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return true;
  return (mask & (1 << hour)) !== 0;
}

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

// An explicit PGSSLMODE wins (see config/database.js, and the same line in
// collectWeekly.js) — which also lets the embedded-Postgres harness in
// __tests__/mlClockAxisBackfill.test.js run this collector for real.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

// Dated holiday context (2026-08-12): every realtime row now records WHEN it
// was observed and what special night it was, so retrains can learn eve/party/
// ban effects. Weekly rows stay dateless by design ("typical Tuesday").
async function ensureHolidayColumns() {
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS observed_date DATE`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS is_holiday_eve BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS special_night VARCHAR(40)`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS special_night_effect VARCHAR(8)`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS special_night_conf VARCHAR(4)`);
  // Round 10: 'live' when BestTime reported live foot traffic, 'forecast' when
  // we fell back to their forecast. Both land in collection_mode='realtime',
  // and before this column existed both were exported as is_realtime=1 and
  // trained at sample weight 1.0 — a vendor forecast carrying more confidence
  // than any other label in the corpus. NULL on rows collected before this.
  //
  // Round 19: migration 025 now owns both of these columns, so a database that
  // has booted the server already has them and this is a no-op. The ALTERs stay
  // because these scripts are also pointed at databases that have not booted it
  // — the same reason hour_axis is re-declared below. What changed is that the
  // column is no longer REACHABLE ONLY from here: when it existed nowhere but
  // in this file, train/export_training_data.js's optional-column probe would
  // find it missing and emit `NULL AS label_source`, silently exporting every
  // realtime row as 'unknown'. That is the failure this whole round is about,
  // and a column that only a hand-run collector creates can always re-enter it.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS label_source VARCHAR(10)`);
  // Round 19: BestTime's own forecast for the same moment, stored on EVERY
  // realtime row whatever its label_source. On a 'forecast' row it equals
  // busyness_pct by construction; on a 'live' row it is the counterfactual, and
  // it is what makes a 'live' claim falsifiable after the fact instead of an
  // unbacked assertion. NULL on rows collected before this.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS vendor_forecast_pct SMALLINT`);
  // Which clock this row's `hour` is on. Normally created by migration 023;
  // created here too because these scripts also run against databases that have
  // not booted the current server, and the INSERT below names the column.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS hour_axis VARCHAR(16)`);
}

// One query per run, not one per venue. It reads the same weekly rows the
// baseline lookup below already reads, scoped to the venues this run will
// consider, and returns venue_id -> open-hour bitmask. A venue absent from the
// map has no weekly evidence and is therefore always called.
async function loadOpenHourMasks(cityScope) {
  const params = [HOUR_AXIS_VENUE_LOCAL];
  if (cityScope) params.push(cityScope);
  const { rows } = await pool.query(
    `SELECT t.venue_id,
            COUNT(DISTINCT t.hour) AS hours_covered,
            array_agg(DISTINCT t.hour) FILTER (WHERE t.busyness_pct > 0) AS busy_hours
       FROM ml_training_data t
       JOIN ml_venues v ON v.id = t.venue_id
      WHERE t.collection_mode = 'weekly'
        AND t.hour_axis = $1
        AND v.is_active = true
        AND v.besttime_venue_id IS NOT NULL`
    + (cityScope ? ' AND v.city = ANY($2)' : '')
    + ' GROUP BY t.venue_id',
    params
  );
  const masks = new Map();
  for (const row of rows) {
    // A PARTIAL CURVE IS NOT EVIDENCE OF A CLOSED HOUR. A venue with rows for
    // three hours of the day looks "shut" for the other twenty-one for the same
    // reason a venue with no rows at all would, and that is a gap in OUR
    // collection rather than a fact about the venue. Only a venue whose weekly
    // rows cover all 24 hours may be judged; production holds exactly that for
    // 1,387 of the 1,414 PA venues, so this costs nothing real and closes the
    // one way this filter could invent a closure.
    if (Number(row.hours_covered) !== 24) continue;
    masks.set(row.venue_id, buildOpenHourMask(row.busy_hours || []));
  }
  return masks;
}

// ---------------------------------------------------------------------------
// OVERLAPPING CALLS AT THE SAME START PACE (2026-09-25).
// ---------------------------------------------------------------------------
// The pace has always been "one call per second", and it was enforced by
// sleeping a second AFTER each call finished. So a call's latency was added to
// the pace rather than hidden behind it: a live answer that took eighteen
// seconds, or a timeout at the twenty seconds bestTimeService allows, held the
// whole sweep for that long. Production logs on 2026-09-25 show what that adds
// up to. Sweeps ended with "Time budget reached after 255-277 calls", about a
// thousand of the 1,365 venues were left for the next run, every hour, and
// 47 to 59 live rows were written. The hour was spent waiting, not calling.
//
// So the pace is now what it always claimed to be, a limit on STARTS: at most
// one new call per START_INTERVAL_MS, and a slow call no longer holds the
// queue, because up to `maxInFlight` calls may be waiting on BestTime at once.
// The rate BestTime receives is the same one request a second (a fifth of the
// published 300 a minute); what changes is how many answers may be
// outstanding. Nothing about the pace history is relaxed: it is in the comment
// on START_INTERVAL_MS, and the gate below enforces it start to start.
//
// Every backoff the serial loop had is kept, as a hold on NEW starts rather
// than a sleep: a 503 holds new calls for sixty seconds, any other failure for
// two. Through a 503 wall that reproduces the serial rhythm exactly, because a
// 503 comes back fast and each one pushes the next start a minute out.
//
// The breakers count in COMPLETION order, which is the only order there is once
// calls overlap: consecutive means consecutive answers. The first breaker to
// trip stops new starts at once; calls already in flight finish on their own
// timeout, their readings are stored like any other, and they can neither
// trip a second breaker nor rename the abort.
// ---------------------------------------------------------------------------

// One call STARTED per second, a fifth of BestTime's stated 300 a minute. The
// history that earned this humility, same day: 100ms pacing (600 a minute) drew
// a hard key block; 250ms (240 a minute, lawfully under the limit) still drew a
// soft 503 wall after ~475 calls and then the same 403, because a key that has
// offended once is not judged by the published ceiling. Speed buys nothing
// here and trust buys everything, which is why overlapping the waits is the
// lever and raising this number is not.
const START_INTERVAL_MS = 1000;

// How many calls may be waiting on BestTime at once. At one start a second, a
// sweep keeps about as many calls in flight as the average call occupies a
// slot in seconds, and a timeout occupies one for its twenty seconds plus the
// two second hold after it. Sized on the simulated clock in
// __tests__/collectRealtimeConcurrency.test.js, with a mix of answers that
// reproduces production's serial numbers: two in five calls timing out, one in
// ten answering in fifteen seconds, the rest in two. That mix run serially
// makes about 270 calls in fifty minutes, where production made 255-277 on
// 2026-09-25. Over the full 1,365 venues:
//     in flight   40% time out     50% time out
//         6       48.7 min, all    budget hit, 173 left over
//         8       41.1 min, all    45.9 min, all
//        10       38.3 min, all    41.7 min, all
// Six is too close to the budget to call finished, so the default is eight.
// --max-in-flight=N changes it for one run; 1 restores the serial sweep, with
// the pace measured start to start. The ceiling is pg's default pool size,
// because every call in flight can hold one connection for its write.
const DEFAULT_MAX_IN_FLIGHT = 8;
const MAX_IN_FLIGHT_CEILING = 10;

// THE GATE every call starts through. Three rules, all checked with nothing
// awaited between the last check and the start, so an answer cannot go stale:
//   * at most one start per `intervalMs`, measured start to start;
//   * at most `maxInFlight` calls unfinished;
//   * no start before a hold a completion has asked for (holdOff).
// And one limit on waiting: ready(deadline) stops waiting at the deadline and
// says so ('late') rather than serving a pace or a hold that runs past it.
// stop() ends it: a waiting ready() wakes and answers false, and no later one
// answers true. A task that throws stops it too, because a throw a call did not
// handle is a bug, and drain() rethrows it once everything in flight has
// settled, so the run still fails loudly and the pool is not ended under a
// write.
//
// `now` and `pause` are injectable so a test can drive the gate on a simulated
// clock. Each wait is served ONCE rather than re-measured in a loop, which
// keeps the gate honest under a pause that returns early: the suites that stub
// config.sleep to keep a run to seconds would otherwise spin here until a real
// second had passed.
function createCallGate({
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  intervalMs = START_INTERVAL_MS,
  now = Date.now,
  pause = sleep,
} = {}) {
  const inFlight = new Set();
  let lastStartAt = null;
  let paceOwed = false;
  let notBefore = -Infinity;
  let holdOwed = false;
  let stopped = false;
  let failure = null;
  let wake = null;
  let peak = 0;

  // Resolves when `promise` settles or stop() is called, whichever is first.
  const waitFor = (promise) => new Promise((resolve) => {
    wake = resolve;
    promise.then(resolve, resolve);
  }).then(() => { wake = null; });

  const stop = () => {
    stopped = true;
    if (wake) wake();
  };

  return {
    // Resolves true when one more call may start NOW, and false once stopped.
    // Given a `deadline` (the sweep's time budget, on the same clock as `now`)
    // it also resolves 'late' once the deadline has passed, and a wait for the
    // pace or for a hold is cut at the deadline instead of being served in
    // full: a 503 just before the budget asks for a sixty second hold, and
    // serving that before looking at the budget carried the sweep up to a
    // minute past it. 'late' never starts a call; the caller's budget check
    // acts on it. A wait for a free slot is not cut, because a slot frees when
    // a call in flight answers and that call's own timeout bounds it.
    async ready(deadline = Infinity) {
      // The deadline cuts one wait, once. A pause that returns early (the
      // stubbed sleep some suites use) must not turn the cut into a spin, so
      // after it every wait is served in full, as before.
      let cut = false;
      const napToward = (until) => {
        const wait = until - now();
        const toDeadline = deadline + 1 - now();
        if (!cut && toDeadline < wait) {
          cut = true;
          return { nap: toDeadline, served: false };
        }
        return { nap: wait, served: true };
      };
      for (;;) {
        if (stopped) return false;
        if (now() > deadline) return 'late';
        if (inFlight.size >= maxInFlight) {
          await waitFor(Promise.race(inFlight));
          continue;
        }
        if (paceOwed) {
          if (lastStartAt + intervalMs > now()) {
            const { nap, served } = napToward(lastStartAt + intervalMs);
            if (served) paceOwed = false;
            await waitFor(pause(nap));
            continue;
          }
          paceOwed = false;
        }
        if (holdOwed) {
          if (notBefore > now()) {
            const { nap, served } = napToward(notBefore);
            if (served) holdOwed = false;
            await waitFor(pause(nap));
            continue;
          }
          holdOwed = false;
        }
        return true;
      }
    },
    // Starts `task` now. Call only after ready() answered true, with nothing
    // awaited in between.
    start(task) {
      if (stopped) throw new Error('createCallGate: start() after stop()');
      lastStartAt = now();
      paceOwed = true;
      const tracked = (async () => {
        try {
          await task();
        } catch (err) {
          if (!failure) failure = err;
          stop();
        }
      })().then(() => { inFlight.delete(tracked); });
      inFlight.add(tracked);
      if (inFlight.size > peak) peak = inFlight.size;
      return tracked;
    },
    // No new start for `ms` from now. Never shortens a hold already set.
    holdOff(ms) {
      notBefore = Math.max(notBefore, now() + ms);
      holdOwed = true;
    },
    stop,
    // Waits for every call in flight, then rethrows the first task failure.
    async drain() {
      while (inFlight.size > 0) await Promise.race(inFlight);
      if (failure) throw failure;
    },
    get inFlight() { return inFlight.size; },
    get peak() { return peak; },
    get stopped() { return stopped; },
  };
}

// ---------------------------------------------------------------------------
// THE SWEEP. Everything between "here is the ordered venue list" and "here is
// what the run did": the city blocks and their weather, the time budget, the
// open-hours skip, the calls through the gate, and the breakers. It opens no
// database connection of its own. The write is `store`, which collectRealtime
// passes in as storeReading, and it returns the counters the summary line and
// the refusals below read.
//
// Split out of collectRealtime so the pacing, the in-flight bound, the breakers
// and the budget can be driven on a simulated clock (`now`, `pause`), with a
// fake BestTime (`fetchLive`) and a fake write, by
// __tests__/collectRealtimeConcurrency.test.js. Production passes none of those
// and gets Date.now, config.sleep, bestTimeService and weatherService.
// ---------------------------------------------------------------------------
async function sweepVenues(cityOrder, {
  store,
  openHourMasks = new Map(),
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  fetchLive = fetchLiveBusyness,
  weatherFor = getWeather,
  now = Date.now,
  pause = sleep,
} = {}) {
  if (typeof store !== 'function') throw new TypeError('sweepVenues needs a store(venue, at, live) function');
  let totalRows = 0;
  let skipped = 0;
  // Venues never called because their own weekly curve says they are shut at
  // their own local hour. Counted separately from `skipped`, which keeps its
  // old meaning exactly: a venue that WAS called and had nothing to say.
  let closedSkips = 0;
  // Venues actually asked about. Counted rather than derived, so an aborted run
  // reports what it spent instead of what it planned to.
  let called = 0;
  let liveRows = 0;
  let forecastRows = 0;
  // Rows the unique index turned away because this venue-hour-date was already
  // recorded. Counted and printed rather than swallowed: before migration 024
  // these became extra rows and nothing said so.
  let duplicateRows = 0;
  // Venues that were in this run's list but, by the time their write came,
  // had been retired or unmapped by scripts/ml/repairBestTimeDiscoveredVenues.js.
  // Their reading is not stored (see the write below) and they are accounted
  // for here rather than folded into `skipped`.
  let vanished = 0;
  // Round 13: fetchLiveBusyness now throws on outage/rate-limit (transient)
  // and key/credit failures (fatal) instead of returning null. Before, a dead
  // key or a BestTime outage looked identical to "no live data for this
  // venue": the loop kept firing one doomed request per venue (thousands of
  // them, 250ms apart) and the summary line cheerfully reported them as
  // "skipped". Transient errors bail after 10 in a row; fatal bails instantly.
  let consecutiveErrors = 0;
  // Throttles are counted apart from errors: see the catch block below.
  let consecutiveThrottles = 0;
  // And so are OUR OWN timeouts, for the same reason and a worse incident.
  // 2026-09-04 16:56 UTC: the sweep stopped after 271 of 1414 calls having
  // written 149 rows, and exited non-zero telling the reader to go and check
  // the BestTime subscription. Every one of the ten errors that tripped the
  // breaker was "This operation was aborted", which is the AbortController in
  // bestTimeService firing at twenty seconds, and nine of the ten were
  // consecutive Starbucks venues. Not one 403. Not one 5xx. A slow answer is
  // not evidence that the vendor is down, and the venue list groups chains
  // together, so a run of slow ones is the normal shape of this data rather
  // than a coincidence: it will land in the same place every sweep.
  let consecutiveNetwork = 0;
  let aborted = false;
  // Which of the three ceilings stopped the run, so the refusal at the bottom
  // can name what actually happened instead of naming the worst thing it could
  // have been.
  let abortReason = null;

  const gate = createCallGate({ maxInFlight, intervalMs: START_INTERVAL_MS, now, pause });
  // The FIRST breaker to trip names the abort and stops new starts. A call
  // already in flight that fails afterwards cannot rename it: a run stopped by
  // a 403 whose last few timeouts land a moment later is still a 403 run, and
  // the refusal must say so.
  function abortRun(reason) {
    if (aborted) return;
    aborted = true;
    abortReason = reason;
    gate.stop();
  }

  // THE TIME BUDGET. A sweep that outlives the hour forfeits the next hour:
  // Railway skips a cron trigger while the previous execution is still
  // running, which is what happened at 02:07 on 2026-09-04 after the 01:07
  // sweep took 58 minutes (1 s pace, ~1 s BestTime latency, and a burst of
  // 30 s timeouts). Fifty minutes leaves the slot free by the next trigger
  // (:07 fires ~:08:30). What is not reached is counted and reported, not
  // silently dropped, and the random start above gives it a different tail
  // next time.
  //
  // It bounds STARTS, and it is looked at the moment it runs out, not only when
  // the gate next opens: the gate cuts a wait for the pace or for a hold at the
  // budget (ready's deadline). Without that cut, a 503 at 49:58 asks for a
  // sixty second hold and the sweep sat in the gate until 50:58 before it saw
  // the budget at all. Once it is reached no new call begins, and the calls
  // already in flight are waited for and counted before the summary prints.
  // Each is bounded by its own twenty second timeout in bestTimeService, and
  // storing its reading adds one event lookup (Ticketmaster's own fifteen
  // second timeout) and one write, so the sweep ends at most one BestTime
  // timeout plus one store past fifty minutes. A wait for a free slot at the
  // budget ends inside that same twenty seconds, because a slot frees when a
  // call in flight answers.
  const RUN_TIME_BUDGET_MS = 50 * 60 * 1000;
  const runClockStart = now();
  let budgetHit = false;
  let leftForNextRun = 0;

  // ONE VENUE'S CALL, from the request to the counted outcome. It runs in a
  // gate slot, overlapping others, so it reads nothing the sweep moves on:
  // everything about the moment of the call arrives in `at`, captured when the
  // call started. Every counter update below happens between awaits, and
  // JavaScript runs one completion at a time, so two answers landing together
  // cannot interleave inside one update.
  async function callVenue(venue, at) {
    let live;
    try {
      live = await fetchLive(venue.besttime_venue_id);
      consecutiveErrors = 0;
      consecutiveThrottles = 0;
      consecutiveNetwork = 0;
    } catch (err) {
      // A call that was already in flight when a breaker tripped. The run is
      // stopping; the failure is logged and counts toward nothing.
      if (aborted) {
        console.error(`[ML:Realtime] In-flight call for ${venue.name} failed after the run stopped: ${err.message}`);
        return;
      }
      if (err.fatal) {
        console.error(`[ML:Realtime] FATAL: ${err.message} — aborting run`);
        abortRun('fatal');
        return;
      }
      // A 503 is BestTime asking for space, not a venue problem, so it
      // gets its OWN budget. The first version of this cooldown counted
      // a throttle as a transient error before waiting, so ten throttles
      // still ended the run, just nine minutes later than before
      // (2026-09-01 review). A throttle wall now has to last forty
      // minutes to stop a night, and a genuinely broken venue still
      // trips the ten-error abort exactly as it always did.
      const throttled = err && /503/.test(String(err.message || ''));
      if (throttled) {
        consecutiveThrottles++;
        console.error(`[ML:Realtime] Throttled ${consecutiveThrottles}/40 at ${venue.name}, holding new calls for 60s`);
        if (consecutiveThrottles >= 40) {
          console.error('[ML:Realtime] 40 consecutive throttles, BestTime is not letting us in, aborting run');
          abortRun('throttled');
          return;
        }
        gate.holdOff(60000);
        return;
      }
      // OUR clock, not their answer. `NETWORK_ERR_RE` in bestTimeService is
      // the same test that decides these are worth rethrowing rather than
      // swallowing; this is the same classification applied one level up so
      // the ten-error ceiling keeps meaning what its message says. The
      // ceiling is higher because the cost of being wrong is asymmetric:
      // stopping a sweep that could have run costs a night of corpus, and
      // continuing through a real outage costs one wasted credit per venue
      // until the run-time budget ends the hour anyway. A genuinely dead
      // network fails fast (ECONNREFUSED, not a twenty second hang), so
      // twenty-five of those is seconds, and twenty-five real hangs is about
      // nine minutes, which the time budget already bounds. (With calls
      // overlapping, twenty-five hangs arrive in about two minutes.)
      const networkish = err && NETWORK_ERR_RE.test(String(err.message || ''));
      if (networkish) {
        consecutiveNetwork++;
        console.error(`[ML:Realtime] Slow or unreachable ${consecutiveNetwork}/25 for ${venue.name}: ${err.message}`);
        if (consecutiveNetwork >= 25) {
          console.error('[ML:Realtime] 25 calls in a row timed out or could not connect, aborting run');
          abortRun('network');
          return;
        }
        gate.holdOff(2000);
        return;
      }
      consecutiveErrors++;
      console.error(`[ML:Realtime] Transient error ${consecutiveErrors}/10 for ${venue.name}: ${err.message}`);
      if (consecutiveErrors >= 10) {
        console.error('[ML:Realtime] 10 consecutive errors, BestTime looks down, aborting run');
        abortRun('upstream');
        return;
      }
      gate.holdOff(2000);
      return;
    }
    if (!live) {
      skipped++;
      return;
    }

    const outcome = await store(venue, at, live);
    if (outcome === 'skipped') {
      skipped++;
    } else if (outcome === 'vanished') {
      vanished++;
    } else if (outcome === 'duplicate') {
      duplicateRows++;
    } else if (outcome === LABEL_LIVE || outcome === LABEL_FORECAST) {
      totalRows++;
      if (outcome === LABEL_LIVE) liveRows++; else forecastRows++;
    }
    // 'failed' is an insert that threw. storeReading logged it, and it is not
    // a row, which is what the old loop counted it as too.
  }

  // A THROW IN THE LOOP STILL WAITS FOR THE CALLS IT STARTED. Anything that
  // throws in here (a venue time zone Intl does not know makes getLocalTime
  // throw RangeError, for one) used to leave the sweep at once with up to
  // maxInFlight calls still waiting on BestTime. run() then ended the pg pool,
  // and those answers came back to storeReading on a pool that was gone. So a
  // throw stops new starts, the drain below waits for every call in flight to
  // land and be written, and only then does the error go on up and fail the
  // run, as it always has.
  let sweepError = null;
  try {
    for (const [cityKey, cityVenues] of cityOrder) {
      if (aborted || gate.stopped) break;
      const cityConfig = CITIES[cityKey];
      if (!cityConfig) continue;

      // One weather call per city, REFRESHED WHEN THE HOUR TURNS.
      //
      // getWeather returns current conditions, and these six columns are model
      // features on the scarce live rows this collector exists to produce. A
      // single reading held across a fifty-eight minute sweep stops describing
      // the moment the busyness was measured and starts describing when the city
      // block began - which for the last venues in a long block is a different
      // hour, sometimes a different sky. One extra call per hour crossed, per
      // city, against a corpus of live labels: the cheapest thing here.
      //
      // The reading a row gets is the one current when its CALL STARTED, captured
      // into the call's `at` below. Calls overlap, so an answer can land after
      // this block has refreshed the weather or moved on to the next city; the
      // row still carries its own moment's sky, never whatever `weather` holds
      // by the time it is written.
      let weather = await weatherFor(cityConfig.lat, cityConfig.lon);
      let weatherHour = new Date(now()).getUTCHours();
      const local = getLocalTime(cityConfig.tz, now());
      const special = specialNightFor(cityKey, local.dateStr);
      const holidayEve = isHolidayEve(cityKey, local.dateStr);

      console.log(`\n[ML:Realtime] ${cityConfig.name} (${local.dateStr} ${local.hour}:00 local)`
        + (special ? ` [${special.name}: ${special.effect}]` : '') + (holidayEve ? ' [holiday eve]' : ''));

      // Waits until the gate lets one more call start, refreshing this city's
      // weather first when the hour has turned. It loops rather than refreshing
      // and returning because the refetch takes time, in which a completion can
      // stop the run or ask for a hold: the gate is asked again after it, so no
      // await separates the last check from the start. It answers true to
      // start, false to stop, and 'late' when the budget ran out during the
      // wait, which the budget check in the loop then acts on.
      const readyToCall = async (deadline) => {
        for (;;) {
          const verdict = await gate.ready(deadline);
          if (verdict !== true) return verdict;
          // Only on an hour boundary, and only replaced if the refetch answered -
          // a transient failure must not blank the reading we already have.
          const nowHour = new Date(now()).getUTCHours();
          if (nowHour === weatherHour) return true;
          const fresher = await weatherFor(cityConfig.lat, cityConfig.lon);
          if (fresher) { weather = fresher; }
          weatherHour = nowHour;
        }
      };

      for (const venue of cityVenues) {
        if (aborted) break;
        // The gate first, so the budget, the skip and the row's clock below are
        // all read at the moment the call would start. A closed venue passes the
        // gate and starts nothing, so the next venue finds it still open: the
        // skip costs no time it would not have spent anyway.
        if (!budgetHit && (await readyToCall(runClockStart + RUN_TIME_BUDGET_MS)) === false) break;
        if (budgetHit || now() - runClockStart > RUN_TIME_BUDGET_MS) {
          if (!budgetHit) console.warn(`[ML:Realtime] Time budget reached after ${called} calls; the rest of this sweep is left for the next run.`);
          budgetHit = true;
          leftForNextRun++;
          continue;
        }
        // THE SKIP, BEFORE THE CALL. `local` is the same clock the row's `hour`
        // is written from, so the decision and the row can never disagree about
        // what time it is. ml_venues.timezone equals its city's timezone for all
        // 22,151 rows in production today (checked 2026-09-03), but if one ever
        // diverged the venue is judged on BOTH hours and called if EITHER says
        // open — a disagreement about the clock must cost a call, not a reading.
        const mask = openHourMasks.get(venue.id);
        // THE ROW'S OWN CLOCK, read now, not the one read when this city's block
        // started. `local` is taken once per city and a sweep runs up to fifty
        // minutes (58 observed in production on 2026-09-04), so the tail of a run
        // that crosses an hour boundary was filed under the previous hour: a 22:40
        // sweep still going at 23:30 recorded genuine 23:00 observations as
        // hour = 22. This is a DELTA model whose anchor is keyed on
        // (venue, day_of_week, hour), so those rows were differenced against the
        // wrong baseline cell and refreshed the wrong ml_venue_baselines slot. The
        // dedupe key is built from the same clock, so a sweep crossing midnight
        // could collide with the previous night and be dropped by DO NOTHING.
        //
        // The tell was already in the file: the open-hours test below computed a
        // FRESH per-venue hour and the row then recorded the stale city one.
        //
        // Read ONCE, as an instant, and the clock is derived from it. The event
        // lookup runs only when the answer lands, which can be in the next hour,
        // so it is handed this same instant (storeReading) rather than taking
        // the time again: a row filed under 21:00 gets 21:00's events.
        const startedAt = new Date(now());
        const obs = getLocalTime(venue.timezone || cityConfig.tz, startedAt);
        const venueHour = obs.hour;
        // Same reasoning for the DATE-derived columns. A sweep crossing midnight
        // would otherwise stamp the previous day's holiday, holiday-eve and
        // special-night answers onto rows observed after it. The city-level pair
        // above stays as it is: it is the header log line, which describes the
        // run rather than any row.
        const obsSpecial = specialNightFor(cityKey, obs.dateStr);
        const obsHolidayEve = isHolidayEve(cityKey, obs.dateStr);
        if (!isOpenAtHour(mask, local.hour) && !isOpenAtHour(mask, venueHour)) {
          closedSkips++;
          continue;
        }

        called++;
        // EVERYTHING THE ROW NEEDS FROM THIS MOMENT TRAVELS WITH THE CALL: its
        // instant, its clock, its date answers, and the weather as it stands
        // now. `weather` is read here, at the start, and the call keeps that
        // object even if the hour turns or the sweep reaches another city
        // before the answer lands.
        gate.start(() => callVenue(venue, { obs, weather, obsSpecial, obsHolidayEve, startedAt }));
      }
    }
  } catch (err) {
    sweepError = err;
    gate.stop();
  }

  // THE DRAIN. Every call that was started is allowed to finish, each on its
  // own twenty second timeout, and only then are the counters handed back. A
  // summary printed before this would undercount, and the provenance audit
  // after it would find rows the tally never saw.
  //
  // When the sweep itself has already failed, that is the error to surface. A
  // call that also fails while it drains is reported beside it rather than
  // allowed to replace it, which an await in a finally block would do.
  try {
    await gate.drain();
  } catch (callError) {
    if (!sweepError) throw callError;
    console.error(`[ML:Realtime] A call also failed while the sweep was stopping: ${callError.message}`);
  }
  if (sweepError) throw sweepError;

  return {
    totalRows, skipped, closedSkips, called, liveRows, forecastRows, duplicateRows, vanished,
    aborted, abortReason, budgetHit, leftForNextRun, peakInFlight: gate.peak,
  };
}

// ---------------------------------------------------------------------------
// ONE TICKETMASTER QUERY PER CELL PER HOUR (2026-09-25).
// ---------------------------------------------------------------------------
// Every stored reading asks Ticketmaster for the events near its venue, one
// request per row. Once the sweep reaches every venue each hour that is
// thousands of requests a day against Discovery's free tier of 5,000, which
// the product's own event features (routes/events.js, mlPredictor,
// nightContext) already budget 3,700 of in services/costModel.js. Past the
// quota every lookup fails. A failed lookup is recorded honestly
// (events_observed=false, 'lookup_failed'), so nothing is fabricated, but the
// event features go dark without anything saying so.
//
// WHAT IS SHARED IS THE LIST, NEVER THE ANSWER. A venue's answer is its own:
// its distance to each event, the 2 km filter, which event is nearest and the
// reason when none is all come from the venue's own coordinates and clock
// (eventService.nearestEventFromAnswers). Two venues a few hundred metres
// apart routinely get different answers from one list. So neighbouring venues
// share one REQUEST, and each still reaches its answer through the same code
// a per-venue request feeds.
//
// WHY THE SHARED QUERY IS WIDER, derived rather than assumed. A venue's own
// query is a disk of NEARBY_KM around the venue. Rounding the query's centre
// to a cell and keeping that radius is not safe at ANY cell size: a venue d km
// from the cell's centre loses the part of its own disk that sticks out past
// the shared one, as close as NEARBY_KM - d km to the venue, so at 0.01
// degrees an event 1.3 km from a venue in a corner of the cell could vanish.
// The shared disk contains every member's disk exactly when its radius is at
// least NEARBY_KM plus the farthest a venue can sit from the centre, which is
// the cell's half-diagonal (the triangle inequality). That is widest at the
// equator, where a degree of longitude is longest: 0.786 km for a 0.01 degree
// cell, 0.700 km at Philadelphia's latitude. Discovery takes its radius in
// whole km, so the shared query asks for ceil(2 + 0.786 + 0.1) = 3 km, and
// 0.01 degrees is the round cell that fits under 3 km with the margin to
// spare (the limit is 0.0114). The margin absorbs any difference between
// Discovery's distance and ours near the edge.
//
// WHEN A SHARED LIST MAY BE USED:
//   * it is COMPLETE. A per-venue query is capped at TM_PAGE_SIZE events, and
//     a shared list cut off at its own page could be missing an event a
//     member venue would have seen. The shared query asks for
//     EVENT_SHARED_PAGE and is used only when Discovery's own total says that
//     was everything.
//   * every event in it has coordinates. One without them cannot be placed
//     inside or outside a member's 2 km, and it decides the
//     'events_without_coordinates' reason.
// A cell that fails either test is asked for venue by venue for that hour,
// which is exactly the old behaviour.
//
// A FAILED SHARED QUERY IS NEVER KEPT AS AN ANSWER, empty or otherwise. The
// cell falls back to venue-by-venue requests for that hour, the rows that
// were waiting on the failed one included, so every row's result is again its
// own request's: a row records events_observed=false, 'lookup_failed' exactly
// when its own request fails, as before. Keeping the failure and retrying the
// shared query on the next row instead would turn one transient error into
// failed lookups for rows whose own requests would have answered, and a
// shared request Discovery rejects every time (a page size it refuses, say)
// into a dead event channel. This way the most a failing shared query costs is
// one extra request per cell per hour.
//
// A venue's view of a complete list is the events within NEARBY_KM of it, in
// Discovery's order, cut at TM_PAGE_SIZE: the list its own query would have
// returned. The two can differ only for an event within metres of exactly
// 2 km, where Discovery's distance and ours could round differently, and for
// a tie in start time at the twentieth place.
//
// The key is the query's own inputs: the cell, and the UTC hour Discovery's
// time window is built from (eventService), which for the whole-hour zones of
// every collected city is also the local hour. SeatGeek is still asked per
// venue, as before; it is off in every environment.
// ---------------------------------------------------------------------------
const EVENT_CELL_DEG = 0.01;
const EVENT_EDGE_MARGIN_KM = 0.1;
const EVENT_SHARED_PAGE = 100;
// eventService.distanceKm's earth (R = 6371 km), per degree of arc.
const KM_PER_DEGREE = (6371 * Math.PI) / 180;
const HOUR_MS = 60 * 60 * 1000;

// Centre to corner of a cell, at the equator where a cell is widest.
function cellHalfDiagonalKm(cellDeg) {
  return 0.5 * Math.hypot(cellDeg, cellDeg) * KM_PER_DEGREE;
}

// The radius a cell's shared query needs so that its disk holds every
// member's own disk, in the whole km Discovery accepts.
function sharedEventRadiusKm(nearbyKm, cellDeg = EVENT_CELL_DEG, marginKm = EVENT_EDGE_MARGIN_KM) {
  return Math.ceil(nearbyKm + cellHalfDiagonalKm(cellDeg) + marginKm);
}

// Built once per sweep. lookup(lat, lon, at) answers what
// getNearestEvent(lat, lon, NEARBY_KM, at) would, sharing the Ticketmaster
// request with the other venues of its cell and hour when the rules above
// allow it. `at` is the moment the observation was taken, which storeReading
// passes as the instant its BestTime call started; the cell's hour,
// Discovery's window and the filter all read it, never the moment the answer
// landed, which can be in the next hour. Without one it is now. Everything is
// injectable for __tests__/collectRealtimeEventCache.test.js. An event module
// without the shared-query parts (a test double that only answers
// getNearestEvent) is asked per venue, as before.
function createEventLookup({
  perVenue = getNearestEvent,
  fetchPage = fetchTicketmasterPage,
  fetchSeatGeek = fetchSeatGeekEvents,
  answerFor = nearestEventFromAnswers,
  distance = distanceKm,
  nearbyKm = NEARBY_KM,
  perVenuePage = TM_PAGE_SIZE,
  cellDeg = EVENT_CELL_DEG,
  sharedPage = EVENT_SHARED_PAGE,
  now = Date.now,
} = {}) {
  const stats = { lookups: 0, sharedCalls: 0, perVenueCalls: 0, failedSharedCalls: 0 };
  const canShare = [fetchPage, fetchSeatGeek, answerFor, distance].every((f) => typeof f === 'function')
    && Number.isFinite(nearbyKm) && Number.isInteger(perVenuePage);
  // The venue's own request, at getNearestEvent's own radius, about the same
  // moment.
  const askPerVenue = (lat, lon, at) => {
    stats.perVenueCalls++;
    return perVenue(lat, lon, NEARBY_KM, at);
  };
  if (!canShare) {
    return {
      shared: false,
      stats,
      lookup(lat, lon, at) {
        stats.lookups++;
        return askPerVenue(lat, lon, at);
      },
    };
  }
  const radiusKm = sharedEventRadiusKm(nearbyKm, cellDeg);
  const cells = new Map();

  // One promise per cell and hour, shared by every venue that asks while it is
  // pending or after it answered. It settles to { events } when the list may
  // be shared, and to { perVenue: true } otherwise, a failure included: a
  // failed request is never kept as an answer, and the venues of that cell ask
  // for themselves for the rest of the hour.
  function cellAnswer(cellLat, cellLon, hour, at) {
    const key = `${hour}:${cellLat}:${cellLon}`;
    const known = cells.get(key);
    if (known) return known;
    stats.sharedCalls++;
    const failed = () => {
      stats.failedSharedCalls++;
      return { perVenue: true };
    };
    const pending = Promise.resolve()
      .then(() => fetchPage((cellLat + 0.5) * cellDeg, (cellLon + 0.5) * cellDeg, radiusKm, at, sharedPage))
      .then((page) => {
        if (!page || !Array.isArray(page.events)) return failed();
        const complete = Number.isInteger(page.total) && page.total <= page.events.length;
        const placeable = page.events.every((e) => e.lat && e.lon);
        return complete && placeable ? { events: page.events } : { perVenue: true };
      }, failed);
    cells.set(key, pending);
    return pending;
  }

  async function ticketmasterFor(lat, lon, at) {
    const hour = Math.floor(at.getTime() / HOUR_MS);
    const shared = await cellAnswer(Math.floor(lat / cellDeg), Math.floor(lon / cellDeg), hour, at);
    if (shared.perVenue) {
      stats.perVenueCalls++;
      const own = await fetchPage(lat, lon, nearbyKm, at);
      return own ? own.events : null;
    }
    return shared.events
      .filter((e) => distance(lat, lon, e.lat, e.lon) <= nearbyKm)
      .slice(0, perVenuePage);
  }

  return {
    shared: true,
    stats,
    radiusKm,
    async lookup(lat, lon, observedAt) {
      stats.lookups++;
      const at = observedAt instanceof Date && Number.isFinite(observedAt.getTime())
        ? observedAt
        : new Date(now());
      // A venue with no usable position has no cell; it is asked as before.
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return askPerVenue(lat, lon, at);
      const [tmEvents, sgEvents] = await Promise.all([
        ticketmasterFor(lat, lon, at),
        fetchSeatGeek(lat, lon, nearbyKm),
      ]);
      return answerFor(tmEvents, sgEvents, lat, lon, at);
    },
  };
}

// ---------------------------------------------------------------------------
// THE WRITE: one venue's answer into one row. The sweep calls this once per
// answered call, with the venue, what the moment of the call looked like
// (`at`: its instant, its clock, its weather, its special night, all captured
// when the call STARTED) and BestTime's answer. It returns what happened and
// the sweep does the counting:
//   'skipped'             the answer held nothing nameable (classifyReading)
//   'vanished'            the repair retired or unmapped the venue mid-sweep
//   'duplicate'           this venue-hour-date was already recorded
//   'failed'              the insert threw; logged here, not a row
//   'live' / 'forecast'   a row was written with that label
//
// `at` is the whole point of the signature. Calls overlap now (see
// OVERLAPPING CALLS above), so by the time an answer lands the sweep may be
// venues, a city or an hour further on, and a row must never be stamped with
// what the sweep's own variables say at write time. Everything below that
// describes the moment reads `at`, the event lookup included: it is handed
// `startedAt`. `lookupEvents(lat, lon, at)` is the sweep's shared event lookup;
// called on its own this falls back to one request per venue.
// ---------------------------------------------------------------------------
async function storeReading(venue, at, live,
  lookupEvents = (lat, lon, observedAt) => getNearestEvent(lat, lon, NEARBY_KM, observedAt)) {
  const { obs, weather, obsSpecial, obsHolidayEve, startedAt } = at;
  // Use live busyness if available, else forecasted — and record WHICH, so
  // training can stop treating a vendor forecast as ground truth. The
  // decision itself is classifyReading()'s, not this loop's.
  const reading = classifyReading(live);
  if (!reading) return 'skipped';
  const { source: labelSource, busyness } = reading;
  // Belt and braces on the one column this round exists to protect. If the
  // classifier ever returns a value outside the domain, the run stops here
  // rather than writing a row nobody can interpret later.
  if (labelSource !== LABEL_LIVE && labelSource !== LABEL_FORECAST) {
    throw new Error(`[ML:Realtime] classifyReading returned an unknown label_source: ${labelSource}`);
  }

  // Look up the weekly baseline for this venue at the current venue-local
  // day/hour, on the venue's own clock (obs), not the city clock the block
  // header was printed from. obs.hour is a wall clock hour, so only weekly rows that
  // DECLARE the venue-local axis may answer it: before migration 023 the
  // weekly rows held BestTime array indices, and this lookup silently
  // stamped every realtime row with the busyness of a slot six hours away.
  // An undeclared corpus now yields NULL — an honest "no baseline" — rather
  // than a confident wrong number. (Nothing in training reads this column:
  // train/export_training_data.js recomputes the baseline leave-one-out at
  // export time. It is kept for operational inspection.)
  let baseline = null;
  try {
    const { rows: baselineRows } = await pool.query(
      `SELECT ROUND(AVG(busyness_pct)) AS avg
       FROM ml_training_data
       WHERE venue_id = $1 AND collection_mode = 'weekly'
         AND hour_axis = $4
         AND day_of_week = $2 AND hour = $3 AND busyness_pct IS NOT NULL`,
      // `obs`, NOT `local`. The block above converted every date-derived
      // column on this row to the venue's own clock; this lookup was left
      // on the city clock captured once at the top of the city, and
      // RUN_TIME_BUDGET_MS is fifty minutes against runs that have
      // measured fifty-eight. A sweep crossing an hour boundary therefore
      // wrote hour = 23 with the 22:00 baseline attached to it.
      [venue.id, obs.dayOfWeek, obs.hour, HOUR_AXIS_VENUE_LOCAL]
    );
    baseline = baselineRows[0]?.avg ?? null;
  } catch (_) {}

  // Fetch nearby event data (graceful — nulls if no API key or error)
  // observed/reason ride the lookup itself (migration 045 applied at the
  // source): a thrown lookup and a measured quiet night must never write
  // the same row. The default covers the throw path.
  let eventData = { event_nearby: null, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null, observed: false, reason: 'lookup_failed' };
  try {
    // The sweep's shared lookup (ONE TICKETMASTER QUERY PER CELL PER HOUR,
    // above): the same answer getNearestEvent gives, from a request this
    // venue may share with its neighbours.
    //
    // About the moment the call STARTED, the one `obs` was read from. It used
    // to take the time again here, after the answer landed: a call started at
    // 21:59:55 and answered at 22:00:10 was filed under 21:00 and handed the
    // 22:00 window's events, so a show starting at 22:30 was attached to the
    // hour before it.
    eventData = await lookupEvents(venue.latitude, venue.longitude, startedAt);
  } catch (err) {
    console.error(`  Event fetch error for ${venue.name}:`, err.message);
  }

  // One value per column, in the column list's order, with the placeholder
  // string generated from it. The previous form hand-numbered $1..$30 with
  // hour_axis bound to $30 but written third, which is exactly the shape
  // that miscounts the next time a column is added.
  const columns = [
    ['venue_id', venue.id],
    ['hour_axis', HOUR_AXIS_VENUE_LOCAL],
    ['day_of_week', obs.dayOfWeek],
    ['hour', obs.hour],
    ['month', obs.month],
    ['season', obs.season],
    ['is_holiday', isHoliday(obs.dateStr)],
    ['is_school_break', isSchoolBreak(obs.dateStr)],
    ['venue_category', venue.venue_category],
    ['price_level', venue.price_level],
    ['rating', venue.rating],
    ['review_count', venue.review_count],
    ['temperature', weather?.temp ?? null],
    ['humidity', weather?.humidity ?? null],
    ['wind_speed', weather?.windSpeed ?? null],
    ['weather_condition', weather?.conditions ?? null],
    // The OWM condition id. NULL in 100% of the corpus before this line,
    // because no collector ever wrote it — which left ten weather_* features
    // constant in training and dead at inference. weatherService has exposed
    // conditionId since the 2026-08-12 audit.
    ['weather_condition_code', weather?.conditionId ?? null],
    ['is_raining', weather?.isRaining ?? null],
    ['event_nearby', eventData.event_nearby],
    ['event_distance_km', eventData.event_distance_km],
    ['event_size', eventData.event_size],
    ['event_type', eventData.event_type],
    ['event_hours_until', eventData.event_hours_until],
    ['events_observed', eventData.observed === true],
    // The SEVEN enrichment columns are written EXPLICITLY, because their
    // defaults are false, false, 0 and 0: omitting them wrote a measured
    // absence beside an events_observed of false, which is exactly the
    // fabricated negative migration 045 exists to end. A 2026-09-01
    // review found 132,432 rows already carrying it.
    //
    // SEVEN, not six, and the count in this comment was the tell. Until
    // 2026-09-04 `nearest_event_attendance` was left off this list while the
    // other six were named, and enrichWithEvents.js declares it
    // `INTEGER DEFAULT 0`. So every row the hourly sweep wrote asserted that
    // the nearest event had nobody at it, next to an event_size that might
    // say two hundred, and the model carries both `nearest_event_attendance`
    // and `log_nearest_event_attendance` as features. It was the exact bug
    // the paragraph above describes, in the column the paragraph forgot to
    // count. Realtime rows are the scarce live labels the hourly cadence
    // exists to produce, so it was wrong on the rows that matter most.
    //
    // The value mirrors total_nearby_attendance because the realtime
    // enrichment resolves ONE nearest event: its attendance is that event's
    // size. null when the lookup did not happen, never a defaulted zero.
    ['has_nearby_event', eventData.observed === true ? (eventData.event_nearby === true) : null],
    ['total_nearby_events', eventData.observed === true ? (eventData.event_nearby === true ? 1 : 0) : null],
    // THREE STATES, NOT TWO. The comment above says "null when the lookup
    // did not happen, never a defaulted zero", and `|| 0` broke it in the
    // other direction: Ticketmaster publishes capacity for almost nothing,
    // eventService maps a missing capacity to null, and `null || 0` is 0.
    // So every live detection wrote "there is an event within 2km and
    // nobody is at it" - all 1,052 such rows in the corpus. Meanwhile
    // enrichWithEvents defaults the same quantity to 500, so the two
    // writers disagreed by construction.
    //
    //   observed, no event nearby  -> 0      (a real measurement)
    //   observed, event of unknown size -> null (we looked, they do not say)
    //   not observed               -> null   (we could not look)
    ['total_nearby_attendance', eventData.observed === true
      ? (eventData.event_nearby === true ? (eventData.event_size ?? null) : 0)
      : null],
    ['nearest_event_attendance', eventData.observed === true
      ? (eventData.event_nearby === true ? (eventData.event_size ?? null) : 0)
      : null],
    ['nearest_event_distance_km', eventData.event_distance_km],
    ['nearest_event_type', eventData.event_type],
    ['events_unavailable_reason', eventData.observed === true ? null : (eventData.reason || 'lookup_failed')],
    ['baseline_busyness', baseline],
    ['busyness_pct', clampPct(busyness)],
    ['observed_date', obs.dateStr],
    ['is_holiday_eve', obsHolidayEve],
    ['special_night', obsSpecial?.name ?? null],
    ['special_night_effect', obsSpecial?.effect ?? null],
    ['special_night_conf', obsSpecial?.conf ?? null],
    ['label_source', labelSource],
    ['vendor_forecast_pct', clampPct(reading.vendorForecast)],
  ];

  try {
    // ON CONFLICT DO NOTHING against ml_training_data_realtime_slot_uniq
    // (migration 024): one row per venue per venue-local hour per observed
    // date. A second pull inside the same clock hour is the same observation
    // re-read, not a new one.
    //
    // DO NOTHING here where collectWeekly.js does DO UPDATE, and the
    // asymmetry is deliberate: a weekly row is an ESTIMATE of a typical week
    // and a re-collection is a fresher read of it, so refreshing is right; a
    // realtime row is an OBSERVATION of one venue-hour on one date, and
    // overwriting a recorded observation is a different act.
    //
    // The predicate is repeated verbatim because the index is partial: it is
    // what lets Postgres infer this arbiter. Legacy rows with no
    // observed_date are outside the index, so nothing here can collide with
    // or delete them.
    //
    // UNDER THE CORPUS WRITE LOCK, WITH THE VENUE RE-RESOLVED FIRST. The
    // venue list was read once at the top of this sweep and a sweep runs
    // up to fifty minutes. scripts/ml/repairBestTimeDiscoveredVenues.js
    // retires `bt_` twins by deleting their ml_venues row, and
    // ml_training_data.venue_id cascades on delete: a row inserted here
    // between the repair moving the twin's rows and deleting the twin is
    // deleted with it, and one inserted after the delete fails its foreign
    // key, both after the credit is spent. It also unmaps a real place
    // sharing an id, whose reading would otherwise be filed under a second
    // name again. So the row's existence and its id are checked inside the
    // same transaction as the write, under the lock the repair takes per
    // group; the answer cannot change before COMMIT. The keeper of the id
    // is in this same list and gets its own row.
    const result = await withCorpusWriteLock(pool, async (client) => {
      // review_count comes back with the identity check because the
      // venue list was read before the lock: the repair's phase two nulls
      // a synthetic zero on ml_venues under this same lock, and a value
      // read before it would be written straight back here (adversarial
      // audit round 2, 2026-09-05). What the row says NOW is what is
      // stored.
      const { rows: still } = await client.query(
        'SELECT review_count FROM ml_venues WHERE id = $1 AND besttime_venue_id = $2',
        [venue.id, venue.besttime_venue_id]
      );
      if (still.length === 0) return null;
      const rc = columns.find(([c]) => c === 'review_count');
      if (rc) rc[1] = still[0].review_count;
      return client.query(
        `INSERT INTO ml_training_data (collection_mode, ${columns.map(([c]) => c).join(', ')})
         VALUES ('realtime', ${columns.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (venue_id, day_of_week, hour, observed_date)
           WHERE collection_mode = 'realtime' AND observed_date IS NOT NULL
         DO NOTHING`,
        columns.map(([, v]) => v)
      );
    });
    if (!result) {
      console.warn(`[ML:Realtime] ${venue.name}: ml_venues ${venue.id} no longer holds ${venue.besttime_venue_id} `
        + '(retired or unmapped by the venue repair mid-sweep); reading not stored');
      return 'vanished';
    }
    if (result.rowCount === 0) return 'duplicate';
    return labelSource;
  } catch (err) {
    console.error(`  Insert error for ${venue.name}:`, err.message);
    return 'failed';
  }
}

async function collectRealtime() {
  await ensureHolidayColumns();
  await requireSlotIndex(pool, REALTIME_SLOT_INDEX);
  // The database's clock, not Node's. The post-run provenance audit below
  // filters on collected_at, which Postgres fills from NOW(); reading the same
  // clock means host skew cannot make the audit miss rows this run wrote.
  const { rows: [{ started_at: runStartedAt }] } = await pool.query('SELECT NOW() AS started_at');
  // PA-ONLY BY DEFAULT since 2026-08-28. This sweep used to select every
  // venue with a BestTime id, about 14,000 across 34 cities, and the Railway
  // cron ran it every 3 hours: on a metered key that is roughly 112,000
  // credits a day, about $4,500/day, for cities with zero users. The paid
  // plan's users are in eastern Pennsylvania, so philly and lehigh are the
  // default scope; --cities=a,b picks a different set, and --all-cities
  // restores the old global sweep as a deliberate act rather than a default.
  // Both spellings: --cities=a,b (this script) and --city=x (the singular
  // collectWeekly has always taken, which the clock-axis suite and muscle
  // memory both use). Either one overrides the PA default.
  const citiesArg = process.argv.find((a) => a.startsWith('--cities='));
  const cityArg = process.argv.find((a) => a.startsWith('--city='));
  const allCities = process.argv.includes('--all-cities');
  if (HOLDOUT.misconfigured) {
    await pool.end();
    throw new Error(
      'REFUSED: --holdout-city needs --holdout-utc-hours=<0-23,...> with at least one valid hour. '
      + 'Without it the holdout city would either never run, or silently take every hour away from '
      + 'the training cities. Exiting non-zero rather than guessing which was meant.');
  }
  const cityScope = allCities
    ? null
    : (HOLDOUT.active ? [HOLDOUT.city]
      : citiesArg ? citiesArg.split('=')[1].split(',').map((c) => c.trim()).filter(Boolean)
      : cityArg ? [cityArg.split('=')[1].trim()]
      : ['philly', 'lehigh']);
  /* THE HOLDOUT CONFIG IS LOGGED EVERY RUN, not only on the hours it fires.
     On 2026-09-05 the service was given --holdout-city=miami and the flags
     never reached the process, because a start-command change does not apply
     until the service is redeployed and every push since had been filtered out
     by the watch patterns. The only evidence in the log was the ABSENCE of the
     line below, and an absent line is indistinguishable from an hour that is
     simply not a holdout hour. Stating the parsed configuration unconditionally
     makes "did the flags arrive" answerable by reading one line instead of
     inferring it from which cities got collected. */
  console.log(`[ML:Realtime] Holdout config: ${HOLDOUT.city
    ? `city=${HOLDOUT.city} hours=${HOLDOUT.hours.join(',')} activeThisRun=${HOLDOUT.active}`
    : 'none (no --holdout-city flag reached this process)'}`);
  if (HOLDOUT.active) {
    console.log(`[ML:Realtime] Holdout hour: this run collects ${HOLDOUT.city} instead of the training cities.`);
  }
  // `demand_serves` is how many times a REAL USER has been shown a crowd card
  // for this venue. It decides collection order below, and nothing else: no
  // venue is excluded by it and no extra call is made because of it.
  //
  // LEFT JOIN, so a venue nobody has seen simply scores 0 rather than dropping
  // out. The subquery groups first so a venue served forty times contributes
  // one row here rather than forty.
  const { rows: venues } = await pool.query(
    `SELECT v.*, COALESCE(d.serves, 0)::int AS demand_serves
       FROM ml_venues v
       LEFT JOIN (
         SELECT venue_place_id, COUNT(*)::int AS serves
           FROM served_predictions
          GROUP BY venue_place_id
       ) d ON d.venue_place_id = v.google_place_id
      WHERE v.is_active = true AND v.besttime_venue_id IS NOT NULL`
    + (cityScope ? ' AND v.city = ANY($1)' : '')
    + ' ORDER BY v.city, v.id',
    cityScope ? [cityScope] : []
  );
  console.log(`[ML:Realtime] City scope: ${cityScope ? cityScope.join(', ') : 'ALL CITIES (explicit --all-cities)'}`);
  const demandedCount = venues.filter((v) => v.demand_serves > 0).length;
  console.log(`[ML:Realtime] ${demandedCount} of ${venues.length} venues have been served to a real user; `
    + `those are collected first every run, so the time budget cannot cut them.`);

  // THE CREDIT BUDGET. The old Railway cron's mental model was "run until the
  // rate limit"; on a metered BestTime plan there is no rate limit, only a
  // bill (one live credit per venue per pull, so a 3-hourly sweep of the PA
  // corpus alone is ~15,000 credits a day). Every run therefore refuses
  // above a per-run credit ceiling unless the caller raises it on purpose:
  // one venue here is one credit, so the ceiling is a venue count.
  const maxCreditsArg = process.argv.find((a) => a.startsWith('--max-credits='));
  const maxCredits = maxCreditsArg ? parseInt(maxCreditsArg.split('=')[1], 10) : 2500;
  if (!Number.isInteger(maxCredits) || maxCredits <= 0) {
    await pool.end();
    // Thrown, not returned. See the ceiling refusal below for why.
    throw new Error('REFUSED: --max-credits must be a positive integer. Exiting non-zero so the scheduler records a failure.');
  }
  if (venues.length > maxCredits) {
    await pool.end();
    // THROWN, NOT RETURNED (2026-09-05). This used to end the process with a
    // console.error and a bare return, so a refused run exited 0 and Railway
    // painted the cron green while nothing had been collected. That is the
    // same silent-success shape as the ninety-day gap this file's header
    // exists to prevent, and it is exactly the failure a new city's service
    // would hit first, because its scope is likely to exceed a stale ceiling.
    // Every other refusal in this file throws; this one now does too.
    //
    // The prices quoted are for the METERED plans. On the current package
    // subscription live calls are unlimited and cost nothing, so the ceiling
    // here is a guard against a runaway scope rather than against a bill.
    throw new Error(
      `REFUSED: this run would spend ~${venues.length} live credits `
      + `against a ceiling of ${maxCredits}. On a metered plan that is about `
      + `$${(venues.length * 0.009).toFixed(2)} on Pro, and it is free on a package `
      + `subscription. Narrow the scope (--cities=...) or raise the ceiling on `
      + `purpose with --max-credits=${venues.length}. Exiting non-zero so the `
      + `scheduler records a failure rather than a green run that collected nothing.`);
  }
  console.log(`[ML:Realtime] Credit budget: ~${venues.length} of ${maxCredits} allowed this run.`);

  if (venues.length === 0) {
    await pool.end();
    // ALSO THROWN (2026-09-05), for the same reason as the ceiling above. An
    // empty scope is not a quiet no-op: with the default cities there are
    // always venues, so zero means the scope asked for something that does not
    // exist. A mistyped --cities=maimi would otherwise log one line, exit 0,
    // and paint a green cron every hour for as long as nobody looked.
    throw new Error(
      `REFUSED: no active venues with a besttime_venue_id in scope (${cityScope ? cityScope.join(', ') : 'all cities'}). `
      + 'Either the city name is wrong or weekly collection has not run for it. '
      + 'Exiting non-zero so the scheduler records a failure rather than a green run that collected nothing.');
  }

  // How many calls may overlap (OVERLAPPING CALLS, above). Refused rather than
  // clamped when it is not a whole number in range, the same way --max-credits
  // is: a mistyped flag should fail the cron, not quietly run a shape nobody
  // asked for. The start pace is not a flag at all.
  const maxInFlightArg = process.argv.find((a) => a.startsWith('--max-in-flight='));
  const maxInFlight = maxInFlightArg ? Number(maxInFlightArg.split('=')[1]) : DEFAULT_MAX_IN_FLIGHT;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > MAX_IN_FLIGHT_CEILING) {
    await pool.end();
    throw new Error(
      `REFUSED: --max-in-flight must be a whole number from 1 to ${MAX_IN_FLIGHT_CEILING}. `
      + 'Exiting non-zero so the scheduler records a failure rather than guessing.');
  }

  console.log(`[ML:Realtime] Starting real-time collection for ${venues.length} venues...`);
  // Stated every run, like the holdout config above, so "did the flag arrive"
  // is one line to read rather than something to infer from the timing.
  console.log(`[ML:Realtime] Pacing: at most one call started every ${START_INTERVAL_MS} ms, `
    + `up to ${maxInFlight} in flight at once.`);

  // The open-hours evidence, loaded once. --no-open-hours turns the filter off
  // for the run (a deliberate "call everything and see"), and a failed load
  // does the same thing on its own, because an unknown must never cost a
  // reading.
  const openHoursFilter = !process.argv.includes('--no-open-hours');
  let openHourMasks = new Map();
  if (openHoursFilter) {
    try {
      openHourMasks = await loadOpenHourMasks(cityScope);
      console.log(`[ML:Realtime] Open hours: ${openHourMasks.size} of ${venues.length} venues have a `
        + `weekly curve to judge by (+/-${OPEN_HOUR_PAD}h); the rest are called unconditionally.`);
    } catch (err) {
      openHourMasks = new Map();
      console.error(`[ML:Realtime] Open-hours lookup failed (${err.message}) — calling every venue.`);
    }
  } else {
    console.log('[ML:Realtime] Open-hours filter DISABLED by --no-open-hours; every venue will be called.');
  }

  // Group venues by city to share weather calls
  const byCity = {};
  for (const venue of venues) {
    if (!byCity[venue.city]) byCity[venue.city] = [];
    byCity[venue.city].push(venue);
  }

  // DEMAND FIRST, THEN A RANDOM START FOR EVERYTHING ELSE.
  //
  // The rotation below is the right answer when every venue matters equally.
  // They do not. 268 venues have ever had a crowd card shown to a real person
  // and 137 of those are pollable; the hourly scope is 1,303 and the time
  // budget leaves several hundred behind most hours. Under a pure rotation the
  // venues someone will actually open are in the collected set by luck.
  //
  // This is the one lever MODEL-METRICS.md section 4 identifies. The model is
  // not weak at generalising (section 3: R2 0.653 across unseen cities). It is
  // weak at knowing how ONE venue deviates from its own pattern, which is
  // learned only by watching that venue repeatedly, and 26 live rows per venue
  // across 168 weekly slots is not repeatedly. Collecting the served venues
  // every hour instead of sometimes is density where density is the deficit.
  //
  // Nothing is excluded. The tail keeps the rotation, for exactly the reason
  // the original comment gives: without it the same venues are cut every single
  // run and never sampled at that hour at all.
  for (const k of Object.keys(byCity)) {
    const arr = byCity[k];
    const demanded = arr.filter((v) => v.demand_serves > 0)
      .sort((a, b) => b.demand_serves - a.demand_serves);
    const rest = arr.filter((v) => v.demand_serves === 0);
    const off = rest.length ? Math.floor(Math.random() * rest.length) : 0;
    byCity[k] = demanded.concat(rest.slice(off), rest.slice(0, off));
  }
  const cityOrder = Object.entries(byCity);
  if (cityOrder.length > 1 && Math.random() < 0.5) cityOrder.reverse();

  // One per sweep, so a cell's Ticketmaster list is shared within this run
  // and never outlives it.
  const events = createEventLookup();
  const {
    totalRows, skipped, closedSkips, called, liveRows, forecastRows, duplicateRows, vanished,
    aborted, abortReason, budgetHit, leftForNextRun, peakInFlight,
  } = await sweepVenues(cityOrder, {
    openHourMasks, maxInFlight, store: (venue, at, live) => storeReading(venue, at, live, events.lookup),
  });

  // Their own lines, so the summary below keeps the exact shape monitoring reads.
  console.log(`[ML:Realtime] Calls in flight at once: peak ${peakInFlight} of ${maxInFlight} allowed.`);
  const ev = events.stats;
  console.log(events.shared
    ? `[ML:Realtime] Event lookups: ${ev.lookups} for stored readings took ${ev.sharedCalls + ev.perVenueCalls} `
      + `Ticketmaster calls (${ev.sharedCalls} shared by ${EVENT_CELL_DEG} degree cell and hour, `
      + `${ev.perVenueCalls} per venue where a cell's list could not be shared, `
      + `${ev.failedSharedCalls} shared calls failed and were not reused).`
    : `[ML:Realtime] Event lookups: ${ev.lookups} for stored readings, each asked per venue.`);

  // The contract of this line is unchanged — "N rows inserted (live, forecast).
  // K venues skipped." — with the new number named beside it rather than folded
  // into K, so a Railway log still reads the same and now also says how much of
  // the sweep was never bought.
  console.log(`\n[ML:Realtime] ${aborted ? 'ABORTED EARLY' : 'Done'}. ${totalRows} rows inserted `
    + `(${liveRows} live-observed, ${forecastRows} vendor-forecast). ${skipped} venues skipped`
    + `, ${closedSkips} venues not called (closed at their local hour)`
    + `, ${called} calls spent of ${venues.length} venues in scope`
    + `${duplicateRows > 0 ? `, ${duplicateRows} already recorded for this venue-hour-date` : ''}`
    + `${vanished > 0 ? `, ${vanished} venues retired or unmapped by the venue repair mid-sweep` : ''}`
    + `${budgetHit ? `, ${leftForNextRun} venues left for the next run (time budget)` : ''}.`);

  await auditProvenance(runStartedAt, liveRows + forecastRows);

  // A RUN THAT COLLECTED NOTHING MUST NOT REPORT SUCCESS, and for 90 days it did.
  //
  // The BestTime key went dead account-wide some time around 2026-05-18. Every
  // three hours from then until 2026-08-16 the cron started, took a 403 on the
  // first venue, aborted, printed a tidy summary, ran the provenance audit —
  // which compared the 0 rows it expected against the 0 rows it found and passed
  // — and exited 0. Railway recorded ~700 consecutive SUCCESSES. Nobody looked,
  // because there was nothing to look at: the platform said green.
  //
  // The audit above is the wrong instrument for this. It asks "is what I wrote
  // labelled", and it is scrupulously correct that nothing unlabelled was
  // written. Zero rows are trivially all-labelled. Absence of bad data is not
  // presence of good data, so the emptiness needs its own check.
  //
  // `aborted` is the unambiguous case: the run stopped early on an upstream
  // error and must exit non-zero. A completed run that still wrote nothing is
  // also wrong — 22,145 venues cannot all legitimately have nothing to say — but
  // it is a softer signal, so it refuses too and names the benign explanation so
  // the reader can rule it out rather than guess.
  //
  // AND IT NAMES THE RIGHT SUSPECT. This sentence used to be the 403 story on
  // every abort, whatever stopped the run, because the 403 story is the one
  // that cost 90 days. On 2026-09-04 it sent the reader to check a paid
  // subscription over ten client-side timeouts in a row. A refusal that
  // misdiagnoses is worse than a quiet one: it spends the reader's attention in
  // the wrong place, and the account it accuses is the thing being paid for.
  if (aborted) {
    const why = {
      fatal: 'A 403 on every BestTime endpoint (live, forecasts-by-id, venues) is an '
        + 'account-level rejection rather than a spent quota, which returns 402 — check the '
        + 'BestTime subscription state before replacing the key, because a new key on a '
        + 'lapsed account fails identically.',
      throttled: 'Forty 503s in a row: BestTime is refusing the pace, not the account. The '
        + 'pacing constant is what to look at, not the key.',
      network: 'Twenty-five calls in a row timed out on OUR clock or could not connect. That '
        + 'is a slow or unreachable upstream, not a rejected account, and the live timeout in '
        + 'scripts/ml/bestTimeService.js is the number that decides it.',
      upstream: 'Ten upstream errors in a row that were not throttles and not timeouts. Read '
        + 'the status codes above; a 5xx run is BestTime, a 4xx run is us.',
    }[abortReason] || 'The reason was not recorded, which is itself a bug worth fixing.';
    throw new Error(
      `REFUSED: the run aborted after ${totalRows} rows. Exiting non-zero so the scheduler `
      + `records a failure. ${why}`);
  }
  // duplicateRows > 0 is the one benign way to write nothing: a re-run inside the
  // same venue-hour-date, which migration 024's unique index correctly drops.
  // That is the collector working, not failing, so it is excluded by the
  // condition rather than only mentioned in the message.
  //
  // closedSkips joins the accounting rather than being ignored, and it has to:
  // a 4 AM sweep in which every venue is shut writes 0 rows and skips 0, and
  // the old condition would have called that a failure and exited non-zero
  // every night. The invariant is unchanged — every venue in scope must be
  // accounted for by SOME skip before an empty run is allowed to pass. A venue
  // the repair retired mid-sweep is accounted for the same way.
  if (totalRows === 0 && duplicateRows === 0 && skipped + closedSkips + vanished < venues.length) {
    throw new Error(
      `REFUSED: the run completed without aborting and wrote 0 rows, having skipped ${skipped} `
      + `of the ${called} venues it called (and left ${closedSkips} of ${venues.length} uncalled as `
      + 'closed). That is not a plausible outcome of a healthy run. If every venue was genuinely '
      + 'already recorded for this venue-hour-date, the duplicate counter would say so; it says 0.');
  }
}

// ---------------------------------------------------------------------------
// The audit that would have caught this in March.
//
// Everything above intends to write a label on every row. Intent is what the
// corpus already had: this file has "recorded WHICH" in its comments since round
// 10, and 457,402 rows say otherwise. So the run now READS BACK what it wrote
// and refuses to report success on an unlabelled row.
//
// It is one indexed count (idx_ml_training_collected) over the rows this run
// committed, and it fails LOUD — throwing propagates to run()'s caller and out
// through the module's top-level catch as exit 1. A collection that cannot say
// what its labels are is worse than no collection: it looks like evidence.
// ---------------------------------------------------------------------------
const PROVENANCE_REFUSAL =
  'REFUSED: rows this run wrote have no label_source. Nothing can tell afterwards whether they '
  + 'hold observed foot traffic or BestTime\'s own forecast of it, which is exactly how the '
  + '457,402 rows collected before 2026-05-18 became permanently unusable for that question. '
  + 'Apply migration 025_ml_label_provenance.sql, confirm ml_training_data.label_source exists, '
  + 'and re-run.';

async function auditProvenance(runStartedAt, expected) {
  const { rows: [audit] } = await pool.query(
    `SELECT COUNT(*)::int                                                   AS written,
            COUNT(*) FILTER (WHERE label_source IS NULL)::int               AS unlabelled,
            COUNT(*) FILTER (WHERE label_source = 'live')::int              AS live,
            COUNT(*) FILTER (WHERE label_source = 'forecast')::int          AS forecast
       FROM ml_training_data
      WHERE collection_mode = 'realtime' AND collected_at >= $1`,
    [runStartedAt]
  );

  if (audit.unlabelled > 0) {
    console.error(`[ML:Realtime] ${PROVENANCE_REFUSAL}`);
    throw new Error(`[ML:Realtime] ${audit.unlabelled} of ${audit.written} rows written this run have label_source IS NULL`);
  }
  // A mismatch here means the loop's tally and the database disagree about what
  // was committed — a different bug from an unlabelled row, and just as worth
  // hearing about.
  if (audit.written !== expected) {
    console.error(`[ML:Realtime] WARNING: counted ${expected} inserts but the database holds `
      + `${audit.written} realtime rows from this run.`);
  }
  console.log(`[ML:Realtime] Provenance audit: ${audit.written} rows written, `
    + `${audit.live} live, ${audit.forecast} forecast, 0 unlabelled.`);
}

// THE HOLDOUT CITY GETS A FEW NAMED HOURS OF THE DAY, ON THIS SAME CRON.
//
// The trainer holds out by CITY (train/export_training_data.js pins the list to
// miami, tokyo and barcelona), and it has never had a live-labelled holdout at
// all, so the ship gate has nothing current to measure a model on. The holdout
// needs very little: about a hundred servable rows across five distinct dates.
// That is a handful of sweeps, not a second collection programme.
//
// It runs here rather than on a second Railway service on purpose. A second
// service needs its own copy of nine variables, and a collector whose key is
// missing calls nothing, skips every venue and exits 0, which Railway paints
// green for as long as nobody looks. That is the failure this file's header
// exists to prevent, so the safer shape is the one service that already has its
// variables spending a named hour on a different city.
//
// The cost is those hours of Pennsylvania collection, which is the corpus the
// 50,000 row training floor is counted from. Two hours in twenty four is about
// eight per cent. The hours are named rather than random so the holdout gets
// more than one time of day in it: a holdout that only ever saw six in the
// evening would not test a model that has to answer at noon.
//
// Resolved once, at load, because a sweep runs for the better part of an hour
// and must not change which city it is collecting halfway through.
const HOLDOUT = (() => {
  const cityArg = process.argv.find((a) => a.startsWith('--holdout-city='));
  const hoursArg = process.argv.find((a) => a.startsWith('--holdout-utc-hours='));
  const city = cityArg ? cityArg.split('=')[1].trim() : null;
  const hours = hoursArg
    ? hoursArg.split('=')[1].split(',')
      .map((h) => parseInt(h.trim(), 10))
      .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    : [];
  const misconfigured = Boolean(cityArg) && (!city || hours.length === 0);
  return { city, hours, misconfigured, active: Boolean(city) && hours.includes(new Date().getUTCHours()) };
})();

// RUN WATCHDOG. The fifty-minute budget bounds the CALLS; nothing bounded the
// PROCESS, and a run that never exits costs every hour after it, because a
// cron run does not start while the previous one is still alive. No line in
// the venue loop logs a success, so from outside a hang is indistinguishable
// from a slow hour. A run still alive at MAX_RUN_MS is ended with its own
// exit code so the next hour can collect; everything written so far is
// committed per venue.
//
// THREE HOURS, NOT FIFTY-FIVE MINUTES. The first version of this sat at 55
// minutes, on the theory that a run is fifty minutes of calls plus a little
// bookkeeping. The bookkeeping is not little: the baseline refresh rebuilds
// every venue from 3.3M weekly rows inside one transaction, and a run
// observed on 2026-09-11 was still in that phase more than five minutes after
// its calls ended. A watchdog inside that window would have rolled the
// refresh back every single hour, which is a far worse outcome than one
// skipped tick. A genuine hang costs hours; a legitimately long run costs
// one skipped tick and nothing else. So the line is drawn where nothing
// legitimate can reach it. unref: the timer must never be the thing that
// keeps a finished run alive.
const MAX_RUN_MS = 3 * 60 * 60 * 1000;
const WATCHDOG_EXIT_CODE = 3;

async function run() {
  const watchdog = setTimeout(() => {
    console.error(`[ML:Realtime] Watchdog: still running after ${Math.round(MAX_RUN_MS / 60000)} minutes; exiting so the next scheduled run can start.`);
    process.exit(WATCHDOG_EXIT_CODE);
  }, MAX_RUN_MS);
  watchdog.unref();
  // try/finally, not a bare sequence: collectRealtime() can now REFUSE (the
  // provenance audit throws), and the old form skipped pool.end() on any throw,
  // leaving the process alive on an open pool with nothing left to do.
  try {
    await collectRealtime();
    // Refresh baselines. This used to be a second, hand-written copy of
    // buildBaselines.js's statement that had drifted from it: no
    // `collection_mode = 'weekly'` filter at all, so it averaged live realtime
    // readings and weekly forecast rows — on two different hour axes — into the
    // same baseline slot, and whichever script ran last decided what a venue's
    // baseline meant. One definition now, in buildBaselines.js.
    // THE BASELINE REFRESH IS CORPUS-WIDE, AND ONLY ONE COLLECTOR SHOULD DO IT.
    // It rebuilds every venue's baselines from all 3.3M weekly rows inside one
    // transaction under withCorpusWriteLock, so a second collector running on
    // its own cron stalls on that lock for the whole rebuild while its own run
    // clock keeps ticking. A holdout-city collector therefore passes
    // --no-baseline-refresh and leaves the rebuild to the hourly PA run, which
    // already covers every city because the statement is not city-scoped.
    // A holdout hour skips it too. The rebuild is corpus-wide and not city
    // scoped, so the training-city runs either side of this one cover it.
    const skipBaselines = process.argv.includes('--no-baseline-refresh') || HOLDOUT.active;
    if (skipBaselines) {
      console.log('[ML:Realtime] Skipping the baseline refresh (--no-baseline-refresh); another collector owns it.');
    }
    if (!skipBaselines) {
      try {
        console.log('[ML:Realtime] Refreshing venue baselines...');
        const result = await refreshCollectedBaselines(pool);
        if (!result.ok) {
          console.error(`[ML:Realtime] Baseline refresh ${REFUSAL_MESSAGE}`);
        } else {
          console.log(`[ML:Realtime] Baselines refreshed (${result.upserted} changed, ${result.deleted} stale removed)`);
        }
      } catch (err) {
        console.error('[ML:Realtime] Baseline refresh failed:', err.message);
      }

      // THE TRAILING OFFSET, refreshed after the baselines and not before.
      //
      // It is the median of (observed - baseline) over a venue's recent live
      // readings, so it has to be rebuilt AFTER two things this run just did:
      // written new live rows, and refreshed the curve those rows are measured
      // against. Rebuilding it first would compute this hour's deviation from
      // last hour's baseline and miss every reading the sweep just collected.
      //
      // Same skip flag as the baselines, for the same reason: whichever
      // collector owns the corpus-wide rebuild owns both, and a holdout run
      // owns neither.
      //
      // Its own try/catch, and a failure here is a log line rather than a run
      // failure. The offset is an improvement on the published number; if it
      // cannot be rebuilt the serving path refuses a stale one on age and every
      // card falls back to exactly what it published before this existed.
      try {
        const dev = await buildRecentDeviation();
        console.log(`[ML:Realtime] Recent-deviation offsets rebuilt `
          + `(${dev.written} venues written, ${dev.pruned} stale rows pruned).`);
      } catch (err) {
        console.error('[ML:Realtime] Recent-deviation refresh failed:', err.message);
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

module.exports = {
  run, classifyReading, LABEL_LIVE, LABEL_FORECAST, PROVENANCE_REFUSAL,
  buildOpenHourMask, isOpenAtHour, OPEN_HOUR_PAD,
  createCallGate, sweepVenues, START_INTERVAL_MS, DEFAULT_MAX_IN_FLIGHT, MAX_IN_FLIGHT_CEILING,
  createEventLookup, sharedEventRadiusKm, cellHalfDiagonalKm, EVENT_CELL_DEG, EVENT_SHARED_PAGE,
  // For __tests__/collectRealtimeEventCache.test.js, which hands it a reading
  // whose call started before the hour turned.
  storeReading,
};

if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Realtime] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
