// ---------------------------------------------------------------------------
// Mode 2: Collect BestTime live busyness snapshots with real-time weather
// Produces ~250 rows per run (one per venue). Run periodically via cron.
// Run: node scripts/ml/collectRealtime.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { getWeather } = require('../../services/weatherService');
const { fetchLiveBusyness, NETWORK_ERR_RE } = require('./bestTimeService');
const { CITIES, getLocalTime, isHoliday, isSchoolBreak, sleep } = require('./config');
const { getNearestEvent } = require('./eventService');
const { specialNightFor, isHolidayEve } = require('./specialNights');
const { refreshCollectedBaselines, REFUSAL_MESSAGE } = require('./buildBaselines');
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
// the only lever that does not touch pacing.
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
  const cityScope = allCities
    ? null
    : (citiesArg ? citiesArg.split('=')[1].split(',').map((c) => c.trim()).filter(Boolean)
      : cityArg ? [cityArg.split('=')[1].trim()]
      : ['philly', 'lehigh']);
  const { rows: venues } = await pool.query(
    `SELECT * FROM ml_venues WHERE is_active = true AND besttime_venue_id IS NOT NULL`
    + (cityScope ? ' AND city = ANY($1)' : '')
    + ' ORDER BY city, id',
    cityScope ? [cityScope] : []
  );
  console.log(`[ML:Realtime] City scope: ${cityScope ? cityScope.join(', ') : 'ALL CITIES (explicit --all-cities)'}`);

  // THE CREDIT BUDGET. The old Railway cron's mental model was "run until the
  // rate limit"; on a metered BestTime plan there is no rate limit, only a
  // bill (one live credit per venue per pull, so a 3-hourly sweep of the PA
  // corpus alone is ~15,000 credits a day). Every run therefore refuses
  // above a per-run credit ceiling unless the caller raises it on purpose:
  // one venue here is one credit, so the ceiling is a venue count.
  const maxCreditsArg = process.argv.find((a) => a.startsWith('--max-credits='));
  const maxCredits = maxCreditsArg ? parseInt(maxCreditsArg.split('=')[1], 10) : 2500;
  if (!Number.isInteger(maxCredits) || maxCredits <= 0) {
    console.error('[ML:Realtime] --max-credits must be a positive integer.');
    await pool.end();
    return;
  }
  if (venues.length > maxCredits) {
    console.error(
      `[ML:Realtime] REFUSED: this run would spend ~${venues.length} live credits `
      + `against a ceiling of ${maxCredits}. On Basic metered that is `
      + `$${(venues.length * 0.04).toFixed(2)}; on Pro metered about `
      + `$${(venues.length * 0.009).toFixed(2)}. Narrow the scope (--cities=...) `
      + `or raise the ceiling on purpose with --max-credits=${venues.length}.`
    );
    await pool.end();
    return;
  }
  console.log(`[ML:Realtime] Credit budget: ~${venues.length} of ${maxCredits} allowed this run.`);

  if (venues.length === 0) {
    console.log('[ML:Realtime] No venues with besttime_venue_id. Run weekly collection first.');
    await pool.end();
    return;
  }

  console.log(`[ML:Realtime] Starting real-time collection for ${venues.length} venues...`);

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

  // A RANDOM START, per city and per run. With the time budget below, the
  // venues at the end of a fixed order would be the ones cut off every single
  // hour, so they would never be sampled at that hour at all. Rotating the
  // start each run spreads the cut across the corpus instead. Stateless on
  // purpose: nothing has to remember where the last run stopped.
  for (const k of Object.keys(byCity)) {
    const arr = byCity[k];
    const off = Math.floor(Math.random() * arr.length);
    byCity[k] = arr.slice(off).concat(arr.slice(0, off));
  }
  const cityOrder = Object.entries(byCity);
  if (cityOrder.length > 1 && Math.random() < 0.5) cityOrder.reverse();

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

  // THE TIME BUDGET. A sweep that outlives the hour forfeits the next hour:
  // Railway skips a cron trigger while the previous execution is still
  // running, which is what happened at 02:07 on 2026-09-04 after the 01:07
  // sweep took 58 minutes (1 s pace, ~1 s BestTime latency, and a burst of
  // 30 s timeouts). Fifty minutes leaves the slot free by the next trigger
  // (:07 fires ~:08:30). What is not reached is counted and reported, not
  // silently dropped, and the random start above gives it a different tail
  // next time.
  const RUN_TIME_BUDGET_MS = 50 * 60 * 1000;
  const runClockStart = Date.now();
  let budgetHit = false;
  let leftForNextRun = 0;

  for (const [cityKey, cityVenues] of cityOrder) {
    if (aborted) break;
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
    let weather = await getWeather(cityConfig.lat, cityConfig.lon);
    let weatherHour = new Date().getUTCHours();
    const local = getLocalTime(cityConfig.tz);
    const special = specialNightFor(cityKey, local.dateStr);
    const holidayEve = isHolidayEve(cityKey, local.dateStr);

    console.log(`\n[ML:Realtime] ${cityConfig.name} (${local.dateStr} ${local.hour}:00 local)`
      + (special ? ` [${special.name}: ${special.effect}]` : '') + (holidayEve ? ' [holiday eve]' : ''));

    for (const venue of cityVenues) {
      if (budgetHit || Date.now() - runClockStart > RUN_TIME_BUDGET_MS) {
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
      const obs = getLocalTime(venue.timezone || cityConfig.tz);

      // Only on an hour boundary, and only replaced if the refetch answered -
      // a transient failure must not blank the reading we already have.
      const nowHour = new Date().getUTCHours();
      if (nowHour !== weatherHour) {
        const fresher = await getWeather(cityConfig.lat, cityConfig.lon);
        if (fresher) { weather = fresher; }
        weatherHour = nowHour;
      }
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

      let live;
      called++;
      try {
        live = await fetchLiveBusyness(venue.besttime_venue_id);
        consecutiveErrors = 0;
        consecutiveThrottles = 0;
        consecutiveNetwork = 0;
      } catch (err) {
        if (err.fatal) {
          console.error(`[ML:Realtime] FATAL: ${err.message} — aborting run`);
          aborted = true;
          abortReason = 'fatal';
          break;
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
          console.error(`[ML:Realtime] Throttled ${consecutiveThrottles}/40 at ${venue.name}, waiting 60s`);
          if (consecutiveThrottles >= 40) {
            console.error('[ML:Realtime] 40 consecutive throttles, BestTime is not letting us in, aborting run');
            aborted = true;
            abortReason = 'throttled';
            break;
          }
          await sleep(60000);
          continue;
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
        // nine minutes, which the time budget already bounds.
        const networkish = err && NETWORK_ERR_RE.test(String(err.message || ''));
        if (networkish) {
          consecutiveNetwork++;
          console.error(`[ML:Realtime] Slow or unreachable ${consecutiveNetwork}/25 for ${venue.name}: ${err.message}`);
          if (consecutiveNetwork >= 25) {
            console.error('[ML:Realtime] 25 calls in a row timed out or could not connect, aborting run');
            aborted = true;
            abortReason = 'network';
            break;
          }
          await sleep(2000);
          continue;
        }
        consecutiveErrors++;
        console.error(`[ML:Realtime] Transient error ${consecutiveErrors}/10 for ${venue.name}: ${err.message}`);
        if (consecutiveErrors >= 10) {
          console.error('[ML:Realtime] 10 consecutive errors, BestTime looks down, aborting run');
          aborted = true;
          abortReason = 'upstream';
          break;
        }
        await sleep(2000);
        continue;
      }
      if (!live) {
        skipped++;
        continue;
      }

      // Use live busyness if available, else forecasted — and record WHICH, so
      // training can stop treating a vendor forecast as ground truth. The
      // decision itself is classifyReading()'s, not this loop's.
      const reading = classifyReading(live);
      if (!reading) {
        skipped++;
        continue;
      }
      const { source: labelSource, busyness } = reading;
      const usedLive = labelSource === LABEL_LIVE;
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
        eventData = await getNearestEvent(venue.latitude, venue.longitude);
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
        const result = await pool.query(
          `INSERT INTO ml_training_data (collection_mode, ${columns.map(([c]) => c).join(', ')})
           VALUES ('realtime', ${columns.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (venue_id, day_of_week, hour, observed_date)
             WHERE collection_mode = 'realtime' AND observed_date IS NOT NULL
           DO NOTHING`,
          columns.map(([, v]) => v)
        );
        if (result.rowCount === 0) {
          duplicateRows++;
        } else {
          totalRows++;
          if (usedLive) liveRows++; else forecastRows++;
        }
      } catch (err) {
        console.error(`  Insert error for ${venue.name}:`, err.message);
      }

      // One call per second, a fifth of BestTime's stated 300 a minute. The
      // history that earned this humility, same day: 100ms pacing (600 a
      // minute) drew a hard key block; 250ms (240 a minute, lawfully under
      // the limit) still drew a soft 503 wall after ~475 calls and then the
      // same 403, because a key that has offended once is not judged by the
      // published ceiling. The full corpus at this pace is still only ~30
      // minutes, so speed buys nothing and trust buys everything.
      await sleep(1000);
    }
  }

  // The contract of this line is unchanged — "N rows inserted (live, forecast).
  // K venues skipped." — with the new number named beside it rather than folded
  // into K, so a Railway log still reads the same and now also says how much of
  // the sweep was never bought.
  console.log(`\n[ML:Realtime] ${aborted ? 'ABORTED EARLY' : 'Done'}. ${totalRows} rows inserted `
    + `(${liveRows} live-observed, ${forecastRows} vendor-forecast). ${skipped} venues skipped`
    + `, ${closedSkips} venues not called (closed at their local hour)`
    + `, ${called} calls spent of ${venues.length} venues in scope`
    + `${duplicateRows > 0 ? `, ${duplicateRows} already recorded for this venue-hour-date` : ''}`
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
  // accounted for by SOME skip before an empty run is allowed to pass.
  if (totalRows === 0 && duplicateRows === 0 && skipped + closedSkips < venues.length) {
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

async function run() {
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
  } finally {
    await pool.end().catch(() => {});
  }
}

module.exports = {
  run, classifyReading, LABEL_LIVE, LABEL_FORECAST, PROVENANCE_REFUSAL,
  buildOpenHourMask, isOpenAtHour, OPEN_HOUR_PAD,
};

if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Realtime] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
