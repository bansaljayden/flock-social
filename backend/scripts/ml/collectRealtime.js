// ---------------------------------------------------------------------------
// Mode 2: Collect BestTime live busyness snapshots with real-time weather
// Produces ~250 rows per run (one per venue). Run periodically via cron.
// Run: node scripts/ml/collectRealtime.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { getWeather } = require('../../services/weatherService');
const { fetchLiveBusyness } = require('./bestTimeService');
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

  // Group venues by city to share weather calls
  const byCity = {};
  for (const venue of venues) {
    if (!byCity[venue.city]) byCity[venue.city] = [];
    byCity[venue.city].push(venue);
  }

  let totalRows = 0;
  let skipped = 0;
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
  let aborted = false;

  for (const [cityKey, cityVenues] of Object.entries(byCity)) {
    if (aborted) break;
    const cityConfig = CITIES[cityKey];
    if (!cityConfig) continue;

    // One weather call per city
    const weather = await getWeather(cityConfig.lat, cityConfig.lon);
    const local = getLocalTime(cityConfig.tz);
    const special = specialNightFor(cityKey, local.dateStr);
    const holidayEve = isHolidayEve(cityKey, local.dateStr);

    console.log(`\n[ML:Realtime] ${cityConfig.name} (${local.dateStr} ${local.hour}:00 local)`
      + (special ? ` [${special.name}: ${special.effect}]` : '') + (holidayEve ? ' [holiday eve]' : ''));

    for (const venue of cityVenues) {
      let live;
      try {
        live = await fetchLiveBusyness(venue.besttime_venue_id);
        consecutiveErrors = 0;
      } catch (err) {
        if (err.fatal) {
          console.error(`[ML:Realtime] FATAL: ${err.message} — aborting run`);
          aborted = true;
          break;
        }
        consecutiveErrors++;
        console.error(`[ML:Realtime] Transient error ${consecutiveErrors}/10 for ${venue.name}: ${err.message}`);
        if (consecutiveErrors >= 10) {
          console.error('[ML:Realtime] 10 consecutive errors — BestTime looks down, aborting run');
          aborted = true;
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
      // day/hour. local.hour is a wall clock hour, so only weekly rows that
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
          [venue.id, local.dayOfWeek, local.hour, HOUR_AXIS_VENUE_LOCAL]
        );
        baseline = baselineRows[0]?.avg ?? null;
      } catch (_) {}

      // Fetch nearby event data (graceful — nulls if no API key or error)
      // observed/reason ride the lookup itself (migration 045 applied at the
      // source): a thrown lookup and a measured quiet night must never write
      // the same row. The default covers the throw path.
      let eventData = { event_nearby: false, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null, observed: false, reason: 'lookup_failed' };
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
        ['day_of_week', local.dayOfWeek],
        ['hour', local.hour],
        ['month', local.month],
        ['season', local.season],
        ['is_holiday', isHoliday(local.dateStr)],
        ['is_school_break', isSchoolBreak(local.dateStr)],
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
        ['events_unavailable_reason', eventData.observed === true ? null : (eventData.reason || 'lookup_failed')],
        ['baseline_busyness', baseline],
        ['busyness_pct', clampPct(busyness)],
        ['observed_date', local.dateStr],
        ['is_holiday_eve', holidayEve],
        ['special_night', special?.name ?? null],
        ['special_night_effect', special?.effect ?? null],
        ['special_night_conf', special?.conf ?? null],
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

      // 250ms, not 100: BestTime's global limit is 300 requests a minute, and
      // 100ms pacing is 600. The 2026-09-01 philly refresh proved it: 169
      // venues succeeded and then a burst of 503s tripped the error guard.
      await sleep(250);
    }
  }

  console.log(`\n[ML:Realtime] ${aborted ? 'ABORTED EARLY' : 'Done'}. ${totalRows} rows inserted `
    + `(${liveRows} live-observed, ${forecastRows} vendor-forecast). ${skipped} venues skipped`
    + `${duplicateRows > 0 ? `, ${duplicateRows} already recorded for this venue-hour-date` : ''}.`);

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
  if (aborted) {
    throw new Error(
      `REFUSED: the run aborted after ${totalRows} rows. Exiting non-zero so the scheduler `
      + 'records a failure. A 403 on every BestTime endpoint (live, forecasts-by-id, venues) '
      + 'is an account-level rejection rather than a spent quota, which returns 402 — check '
      + 'the BestTime subscription state before replacing the key, because a new key on a '
      + 'lapsed account fails identically.');
  }
  // duplicateRows > 0 is the one benign way to write nothing: a re-run inside the
  // same venue-hour-date, which migration 024's unique index correctly drops.
  // That is the collector working, not failing, so it is excluded by the
  // condition rather than only mentioned in the message.
  if (totalRows === 0 && duplicateRows === 0 && skipped < venues.length) {
    throw new Error(
      `REFUSED: the run completed without aborting and wrote 0 rows, having skipped ${skipped} `
      + `of ${venues.length} venues. That is not a plausible outcome of a healthy run. If every `
      + 'venue was genuinely already recorded for this venue-hour-date, the duplicate counter '
      + 'would say so; it says 0.');
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

module.exports = { run, classifyReading, LABEL_LIVE, LABEL_FORECAST, PROVENANCE_REFUSAL };

if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Realtime] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
