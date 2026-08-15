'use strict';
// ---------------------------------------------------------------------------
// Export ML training data from PostgreSQL to CSV for the Python training
// pipeline. Splits whole CITIES into a holdout file (Miami, Tokyo, Barcelona);
// there is no row-level split anywhere, by design — see PRE-RETRAIN-AUDIT.md.
//
// THIS SCRIPT IS READ-ONLY AND IS RUN AGAINST PRODUCTION.
// It used to open with
//     ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS label_source ...
// i.e. DDL on the live Railway database, executed by a script whose entire job
// is to read. It is gone. Optional columns are probed through
// information_schema and selected as NULL when absent, the connection is opened
// with `default_transaction_read_only=on`, and every statement runs inside an
// explicit `BEGIN READ ONLY`. A stray write is now a 25006 error from the
// server rather than a silent schema change, and that is pinned by
// __tests__/mlExportContracts.test.js.
//
// ---------------------------------------------------------------------------
// THE HOUR AXIS (migration 023) — WHY THIS FILE REFUSES RATHER THAN FILTERS
//
// `ml_training_data.hour` held two different clocks until 023: collectWeekly.js
// wrote BestTime's `day_raw` ARRAY INDEX (its day runs 06:00-05:59, so stored
// slot 18 was the venue's midnight) while collectRealtime.js wrote the true
// venue-local hour. 023 rotated every weekly row onto the venue-local axis and
// stamped `hour_axis`. A row that does not declare `hour_axis = 'venue_local'`
// is therefore a row whose `hour` is six hours away from what the column means.
//
// Such a row must never reach the CSV: it would corrupt its own delta label,
// the (venue, dow, hour) baseline group it lands in, and the category baselines
// prepare_features.py ships to production in model_metadata.json. So the export
// REFUSES to run while any weekly row is undeclared — the same refusal, for the
// same reason, as buildBaselines.refreshCollectedBaselines(). Silently dropping
// those rows would produce a smaller, apparently-fine corpus and hide a
// half-applied migration.
//
// ---------------------------------------------------------------------------
// baseline_busyness IS THE NUMBER PRODUCTION SERVES, NOT A SECOND DEFINITION
//
// This is a DELTA model: the ONNX graph predicts `busyness - baseline` and
// services/mlPredictor.js reconstructs `score = baseline + clamp(delta)`, where
// its baseline comes from `ml_venue_baselines` — written by exactly one
// statement, buildBaselines.js's UPSERT:
//
//     ROUND(AVG(busyness_pct)) over ml_training_data rows with
//       collection_mode = 'weekly' AND hour_axis = 'venue_local'
//       AND busyness_pct IS NOT NULL, grouped by (place_id, dow, hour)
//
// The aggregate below is that statement, verbatim, and
// __tests__/mlExportContracts.test.js proves the equality row by row against a
// table built by buildBaselines itself. Any other definition means the model
// learns deltas against one anchor and production adds them to a different one,
// which is a systematic error on every prediction and is invisible to the ship
// gate (the gate compares `baseline + delta` against `baseline`, so an error
// shared by both sides cancels).
//
// WHAT THIS REPLACED, AND WHY. Round 13 computed the anchor leave-one-out over
// BOTH collection modes: `(SUM - own busyness) / (n - 1)` over every weekly AND
// realtime row in the slot. Three things were wrong with it, and only the third
// was visible at the time:
//
//   1. It mixed the modes. Production's anchor contains no realtime reading at
//      all, so a realtime row's training anchor — part live observations of the
//      same slot on OTHER dates — was a number the serving path can never
//      compute. Those sibling observations are near-labels: strictly MORE
//      leakage than the self-inclusion round 13 removed, and it inflated every
//      holdout number that mattered.
//   2. After migration 024 collapsed the duplicate rows, a weekly slot holds
//      exactly ONE weekly row, so `n = 1` for every weekly-only slot and the
//      leave-one-out anchor became 0 — which prepare_features.py's
//      `baseline_busyness > 0` serving filter then drops. The v2.3.1 blend's
//      weekly "anchor" rows (weight 0.05, the thing that stops the model
//      predicting a deviation on every ordinary night) would have vanished from
//      the corpus silently. Nothing would have failed; the model would just
//      have been v2.3.0 again.
//   3. It was described in this file as "identical definition to the refresh in
//      collectRealtime.run()". That refresh no longer exists — collectRealtime
//      now calls buildBaselines.refreshCollectedBaselines(), which has always
//      carried the `collection_mode = 'weekly'` filter this file lacked.
//
// SELF-INCLUSION, honestly. A WEEKLY row's anchor is its own busyness value,
// because that value IS what buildBaselines stores for the slot. That is an
// identity, not a leak: the delta label is exactly 0, which is precisely the
// "most moments are typical" anchor v2.3.1 wants at weight 0.05, and those rows
// are never served. A REALTIME row's anchor contains no realtime label
// whatsoever — not its own, not another date's — so on the population the model
// actually serves there is now no label leakage at all. That is strictly
// stronger than round 13, and both halves are pinned by the contract test.
//
// ---------------------------------------------------------------------------
// ROUND 20: label_source AND vendor_forecast_pct ARE CARRIED, NOT FEATURISED
//
// Migration 025 put two columns on ml_training_data that nothing downstream
// could see, because the export contract did not name them. They are named now,
// and the contract is 44 columns. What they are for, and what they are NOT for:
//
//   label_source         the RAW column collectRealtime.js writes: 'live' or
//                        'forecast', NULL on every one of the 457,402 rows
//                        collected before 2026-08-15.
//   vendor_forecast_pct  BestTime's own forecast for the SAME moment, handed to
//                        us in the same response as the live reading and thrown
//                        away until round 19. NULL on all 3,912,357 existing
//                        rows. Costs no extra API call.
//
// label_provenance was already exported and is DERIVED from label_source (see
// labelProvenance below: weekly rows are named by mode, an unrecognised or
// absent source becomes 'unknown'). Carrying the raw column alongside the
// derived one is not duplication — it is what makes the derivation checkable
// from the CSV alone. prepare_features.py recomputes label_provenance from
// (is_realtime, label_source) and refuses when the two disagree, so a masked or
// out-of-domain value can no longer arrive as a silent 'unknown'.
//
// vendor_forecast_pct is what makes a 'live' label FALSIFIABLE. On a 'forecast'
// row it equals busyness_pct by construction; on a 'live' row it is the
// counterfactual, and the gap between them is the distance between our label and
// a vendor's model of it — the quantity WITHIN-CITY-EVAL.md section 9 wanted and
// could not produce.
//
// NEITHER IS A MODEL FEATURE, AND vendor_forecast_pct MUST NEVER BECOME ONE
// NAIVELY. Two independent reasons, and the second is the hard one:
//
//   1. Both are empty on the whole corpus today, so a feature built from either
//      would be a constant column — a dead slot, and the last run already
//      carried 11 of 106. A NULL filled with 0 would be worse than dead: it
//      asserts "BestTime forecast 0% busy" on 3.9M rows where the truth is that
//      nobody asked.
//   2. On a 'forecast' row vendor_forecast_pct IS the label. Feeding it in on
//      the day the corpus does carry it would hand the model the answer on every
//      forecast-sourced row — the same leakage class as popular_times and as the
//      category baselines. If it is ever used it has to be as a residual, on a
//      slice the model is not scored against, and that decision needs data that
//      does not exist yet.
//
// So: exported, available, excluded from the feature set at both ends, and
// reported on every run so the moment coverage stops being zero is visible.
//
// EMPTY IS NOT ZERO. Both columns are written as an EMPTY FIELD when the row
// does not carry a value, and 0 is a legal vendor forecast (a venue nobody is
// at). pandas reads the empty field as NaN and prepare_features.py never
// fillna(0)s a carried column — only feature columns — so "we never asked" and
// "the vendor said nobody is there" stay different facts all the way through.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { CITIES } = require('../config');

const HOLDOUT_CITIES = ['miami', 'tokyo', 'barcelona'];

// Mirrors buildBaselines.HOUR_AXIS_VENUE_LOCAL, collectWeekly's literal and the
// value migration 023 stamps. Deliberately a copy rather than a require: this
// module must stay importable without touching the collectors.
const HOUR_AXIS_VENUE_LOCAL = 'venue_local';

// Rows per FETCH from the server-side cursor. The export is ~4M rows; a plain
// pool.query() materialises every one of them as a JS object before a single
// byte is written (see runExport).
const FETCH_SIZE = 20000;

// Local calendar date at the venue when the row was observed. Realtime rows
// only — weekly rows are a synthetic "typical week", their insert time is
// meaningless as an observation date.
//
// collectRealtime.js stamps `observed_date` on every row it writes (and
// migration 024's realtime unique key is defined on it), so the STORED value is
// authoritative and this recomputation is only the fallback for rows written
// before that column existed.
const dateFmtCache = {};
function observedDate(row) {
  if (row.collection_mode !== 'realtime') return '';
  if (row.stored_observed_date) {
    const d = row.stored_observed_date;
    // pg returns DATE as a JS Date at local midnight; format its calendar
    // fields directly rather than through toISOString(), which would shift it.
    if (d instanceof Date) {
      if (Number.isNaN(d.getTime())) return '';
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    }
    return String(d).slice(0, 10);
  }
  if (!row.collected_at) return '';
  const tz = CITIES[row.city]?.tz;
  if (!tz) return '';
  if (!dateFmtCache[tz]) {
    dateFmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
  }
  return dateFmtCache[tz].format(new Date(row.collected_at)); // YYYY-MM-DD
}

// The production baseline, as one aggregate. Kept as a named constant so the
// contract test can assert it against buildBaselines.UPSERT_SQL instead of
// trusting the comment above.
const BASELINE_AGGREGATE_SQL = `
        SELECT v2.google_place_id, t2.day_of_week, t2.hour,
               ROUND(AVG(t2.busyness_pct)) AS baseline
        FROM ml_training_data t2
        JOIN ml_venues v2 ON t2.venue_id = v2.id
        WHERE t2.collection_mode = 'weekly'
          AND t2.hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'
          AND t2.busyness_pct IS NOT NULL
          AND v2.city = $1
        GROUP BY v2.google_place_id, t2.day_of_week, t2.hour`;

// `optional` names the columns this query may select only if the database has
// them. A fresh database (or one whose server has not booted the current
// migration chain) is missing label_source / observed_date, and a missing
// column is a hard SQL error — which is what the ALTER TABLE this file used to
// run was papering over.
function cityQuery(city, optional = {}) {
  // `column` is the ml_training_data column preflight() probed for; `alias` is
  // what the row object is keyed on. They differ for observed_date, which is
  // selected as stored_observed_date so rowToCsv can tell a stored value from
  // the collected_at fallback.
  const has = (column, expr, alias = column) =>
    (optional[column] === false ? `NULL AS ${alias}` : expr);
  return {
    text: `
      SELECT
        -- Round 10: venue_id is what prepare_features.smooth_baseline_hours
        -- keys the neighbouring-hour baseline blend on. Without it the block
        -- was silently skipped, so the model learned deltas against RAW
        -- baselines while mlPredictor.getBaseline serves a smoothed one
        -- (current*0.6 + prev*0.2 + next*0.2). Exported as an identifier only —
        -- prepare_features excludes it from the feature set.
        t.venue_id,
        t.day_of_week, t.hour, t.month, t.season,
        t.is_holiday, t.is_school_break,
        t.venue_category, t.price_level, t.rating, t.review_count,
        t.temperature, t.humidity, t.wind_speed,
        t.weather_condition, t.weather_condition_code, t.is_raining,
        t.event_nearby, t.event_distance_km, t.event_size, t.event_type, t.event_hours_until,
        t.has_nearby_event, t.nearest_event_distance_km, t.nearest_event_attendance,
        t.total_nearby_events, t.total_nearby_attendance, t.nearest_event_type,
        -- The anchor production serves. See the header block.
        COALESCE(b.baseline, 0) AS baseline_busyness,
        t.collection_mode,
        -- Round 10: collection_mode='realtime' only says WHEN the row was
        -- taken, not whether the number is an observation. collectRealtime.js
        -- falls back to BestTime's own forecast when live data is unavailable,
        -- and those rows used to be exported as is_realtime=1 and weighted 1.0
        -- in training — a vendor's prediction carrying more confidence than
        -- anything else in the corpus. label_source records the truth.
        ${has('label_source', 't.label_source')},
        -- Round 20: BestTime's forecast for the same moment, stored by
        -- collectRealtime.js on every realtime row whatever its label_source.
        -- Carried to the CSV as-is; see the header block for why it is not a
        -- feature. Absent on a database that has not applied migration 025, and
        -- selecting a column that does not exist is a hard SQL error, so it is
        -- probed like the other optionals rather than assumed.
        ${has('vendor_forecast_pct', 't.vendor_forecast_pct')},
        t.collected_at,
        ${has('observed_date', 't.observed_date AS stored_observed_date', 'stored_observed_date')},
        t.busyness_pct,
        v.city, v.google_types, v.latitude, v.longitude,
        -- User feedback aggregates per venue
        COALESCE(fb.avg_user_crowd, 0) AS avg_user_crowd,
        COALESCE(fb.user_feedback_count, 0) AS user_feedback_count,
        COALESCE(fb.avg_prediction_error, 0) AS avg_prediction_error
      FROM ml_training_data t
      JOIN ml_venues v ON t.venue_id = v.id
      LEFT JOIN (${BASELINE_AGGREGATE_SQL}
      ) b
        ON b.google_place_id = v.google_place_id
       AND b.day_of_week = t.day_of_week
       AND b.hour = t.hour
      LEFT JOIN (
        SELECT venue_place_id,
          AVG(crowd_level)::numeric(4,1) AS avg_user_crowd,
          COUNT(*)::int AS user_feedback_count,
          AVG((CASE crowd_level WHEN 1 THEN 20 WHEN 2 THEN 50 ELSE 80 END) - predicted_score)::numeric(5,2) AS avg_prediction_error
        FROM venue_feedback
        WHERE verified = true -- only presence-verified reports: unverified rows let Sybil accounts poison training features (REVIEW-ROUND5)
        GROUP BY venue_place_id
      ) fb ON fb.venue_place_id = v.google_place_id
      WHERE t.busyness_pct IS NOT NULL AND v.city = $1
        -- Unreachable while preflight() stands, and deliberately kept: if the
        -- refusal above is ever softened, a legacy-axis weekly row must still
        -- not reach the CSV. A row on the BestTime bucket axis is a row whose
        -- hour column means something else.
        AND (t.collection_mode <> 'weekly' OR t.hour_axis = '${HOUR_AXIS_VENUE_LOCAL}')
      ORDER BY t.venue_id, t.day_of_week, t.hour
    `,
    values: [city],
  };
}

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  // \r as well as \n: a lone CR inside a field breaks a CSV reader exactly the
  // way a LF does, and pandas reads this file with the default dialect.
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Round 10: honest provenance for the label.
//   weekly   — synthetic "typical week" snapshot (sample weight 0.05)
//   live     — BestTime reported live foot traffic (full confidence)
//   forecast — BestTime's own forecast, used because live was unavailable
//   unknown  — realtime row collected before label_source existed; we cannot
//              tell live from forecast retroactively, so it keeps the old
//              treatment rather than silently reweighting the whole corpus.
function labelProvenance(row) {
  if (row.collection_mode !== 'realtime') return 'weekly';
  if (row.label_source === 'live' || row.label_source === 'forecast') return row.label_source;
  return 'unknown';
}

// Round 20: the RAW label_source column, passed through without laundering.
//
// labelProvenance() above MASKS: a weekly row reports 'weekly' whatever the
// column says, and anything outside {live, forecast} reports 'unknown'. Both
// masks are correct for the derived column and both destroy evidence, which is
// why the raw one now travels beside it. A value outside the domain must reach
// the CSV rather than be silently normalised here: migration 025's CHECK is
// what stops one being written, and a row carrying one is proof that the CHECK
// is not on the database this corpus came from. prepare_features.py raises on
// it by name.
//
// NULL becomes the empty field — never a string 'null', never 'unknown'. The
// 457,402 legacy rows are unrecoverable (migration 025's header proves it), and
// an empty field is the only honest thing to write for them.
function labelSource(row) {
  const v = row.label_source;
  if (v === null || v === undefined) return '';
  return String(v);
}

// Round 20: BestTime's own forecast for the row's moment.
//
// The ONLY thing this function exists to guarantee is that a missing value and
// a value of zero do not collapse into each other. 0 is a legal forecast — a
// venue the vendor expects to be empty — and NULL means the collector never had
// the number, which is true of every row in the corpus today. So NULL yields
// the empty field and 0 yields '0'; a fillna(0) anywhere downstream would turn
// 3.9 million "nobody asked" rows into 3.9 million "the vendor said empty".
// A value that is not a number is NOT normalised to empty either. "The
// collector never had a forecast" and "something wrote a value nothing can read"
// are different problems with different fixes, and collapsing the second into
// the first would hide it in the 3.9 million rows that are legitimately empty.
// It is passed through so prepare_features.py's unparsable_vendor_forecast check
// can name it. Neither end of this pipeline launders.
function vendorForecastPct(row) {
  const v = row.vendor_forecast_pct;
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

function rowToCsv(row) {
  const types = row.google_types || [];
  return [
    row.venue_id,
    row.day_of_week,
    row.hour,
    row.month,
    row.season,
    row.is_holiday ? 1 : 0,
    row.is_school_break ? 1 : 0,
    row.venue_category,
    row.price_level,
    row.rating,
    row.review_count,
    row.temperature,
    row.humidity,
    row.wind_speed,
    row.weather_condition,
    row.weather_condition_code,
    row.is_raining ? 1 : 0,
    row.event_nearby ? 1 : 0,
    row.event_distance_km,
    row.event_size,
    row.event_type,
    row.event_hours_until,
    row.has_nearby_event ? 1 : 0,
    row.nearest_event_distance_km,
    row.nearest_event_attendance,
    row.total_nearby_events,
    row.total_nearby_attendance,
    row.nearest_event_type,
    row.baseline_busyness,
    row.collection_mode === 'realtime' ? 1 : 0,
    row.busyness_pct,
    row.city,
    types[0] || '',
    types[1] || '',
    types[2] || '',
    row.latitude,
    row.longitude,
    row.avg_user_crowd,
    row.user_feedback_count,
    row.avg_prediction_error,
    observedDate(row),
    labelProvenance(row),
    labelSource(row),
    vendorForecastPct(row),
  ].map(escapeCsv).join(',');
}

// The corpus contract, 44 columns, in exactly this order.
//
// prepare_features.py's EXPORT_COLUMNS is the same list and the two are pinned
// against each other by __tests__/mlPipelineContracts.test.js and
// __tests__/mlExportContracts.test.js. rowToCsv() above must emit one field per
// entry here, in this order — a column added to one and forgotten in the other
// shifts every field after it and still produces a file pandas will read.
//
// Round 20's two additions are APPENDED, deliberately. Every column an older
// reader knows keeps its index, so the growth cannot silently re-point a
// positional consumer; and a pre-round-20 CSV fails require_export_columns by
// NAME rather than by arriving one field short somewhere in the middle.
//
// Keep this a flat array of single-quoted literals with no comments inside it:
// the contract tests parse it out of the source text, and any other quoted
// string between the brackets would be read as a column name.
const HEADER = [
  'venue_id',
  'day_of_week', 'hour', 'month', 'season',
  'is_holiday', 'is_school_break',
  'venue_category', 'price_level', 'rating', 'review_count',
  'temperature', 'humidity', 'wind_speed',
  'weather_condition', 'weather_condition_code', 'is_raining',
  'event_nearby', 'event_distance_km', 'event_size', 'event_type', 'event_hours_until',
  'has_nearby_event', 'nearest_event_distance_km', 'nearest_event_attendance',
  'total_nearby_events', 'total_nearby_attendance', 'nearest_event_type',
  'baseline_busyness', 'is_realtime',
  'busyness_pct',
  'city',
  'google_type_1', 'google_type_2', 'google_type_3',
  'latitude', 'longitude',
  'avg_user_crowd', 'user_feedback_count', 'avg_prediction_error',
  'observed_date', 'label_provenance',
  'label_source', 'vendor_forecast_pct',
].join(',');

const UNDECLARED_WEEKLY_MESSAGE =
  'REFUSED: ml_training_data still holds weekly rows that do not declare '
  + `hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'. Their hour column is a BestTime array index, `
  + 'six hours off the venue clock, so their delta labels, their baseline groups and the '
  + 'category baselines shipped in model_metadata.json would all be wrong. Apply migration '
  + '023_backfill_ml_weekly_local_hours.sql (it runs on server boot), re-run '
  + '`node scripts/ml/buildBaselines.js`, then export again.';

// Optional columns, each with the reason it may be absent.
const OPTIONAL_COLUMNS = {
  label_source: 'collectRealtime.js writes it; without it every realtime label is "unknown"',
  observed_date: 'collectRealtime.js writes it; without it the date is derived from collected_at',
  hour_axis: 'migration 023 adds it; without it NO weekly row can declare its axis',
  vendor_forecast_pct: 'migration 025 adds it; without it the vendor forecast column is empty '
    + 'on every row and a "live" label cannot be checked against the counterfactual',
};

async function columnsPresent(db, table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(rows.map((r) => r.column_name));
}

// Everything that has to be true BEFORE a two-hour export starts, checked in
// one round trip each. Returns { optional, undeclaredWeekly, calendarGaps }.
async function preflight(db, log = console.log) {
  const present = await columnsPresent(db, 'ml_training_data');
  const optional = {};
  for (const [name, why] of Object.entries(OPTIONAL_COLUMNS)) {
    optional[name] = present.has(name);
    if (!optional[name]) log(`[Export] NOTE: ml_training_data.${name} does not exist — ${why}`);
  }

  // The axis gate. EXISTS, not COUNT: this table is millions of rows.
  let undeclaredWeekly = true;
  if (optional.hour_axis) {
    const { rows: [{ undeclared }] } = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM ml_training_data
          WHERE collection_mode = 'weekly'
            AND hour_axis IS DISTINCT FROM $1
       ) AS undeclared`,
      [HOUR_AXIS_VENUE_LOCAL]
    );
    undeclaredWeekly = undeclared;
  }

  // Not a refusal: FLOCK_CALENDAR_POLICY=drop is a legitimate (if unreleasable)
  // way to run without these. But prepare_features.py raises on the first
  // undated row, and finding that out AFTER a full export is an hour wasted, so
  // the count is reported here.
  const { rows: [calendarGaps] } = await db.query(
    `SELECT COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE month IS NULL OR month = 0)::bigint AS no_month,
            COUNT(*) FILTER (WHERE season IS NULL OR season = '')::bigint AS no_season
       FROM ml_training_data
      WHERE busyness_pct IS NOT NULL`
  );

  // Round 20 coverage census. Not a refusal and it must never become one: BOTH
  // columns are empty on 100% of the corpus today, and a gate on them would
  // block every retrain until a new collection run finishes. It is a REPORT,
  // because the number that matters is the day it stops being zero — and the
  // only way that day is noticed is if the export says so out loud every time.
  //
  // Restricted to realtime rows because that is the only population either
  // column describes; a weekly row leaving both NULL is the design, not a gap.
  const provenance = await labelCoverage(db, optional);
  const rt = Number(provenance.realtime_rows);
  if (rt > 0) {
    const pct = (n) => ((Number(n) / rt) * 100).toFixed(1);
    log(`[Export] Label provenance: ${rt} realtime rows — `
      + `${provenance.named} named live/forecast (${pct(provenance.named)}%), `
      + `${provenance.with_vendor_forecast} carry a vendor forecast `
      + `(${pct(provenance.with_vendor_forecast)}%).`);
    if (Number(provenance.named) === 0) {
      log('[Export] NOTE: every realtime row exports as label_provenance=unknown and an empty '
        + 'vendor_forecast_pct. That is the recorded state of the pre-2026-08-15 corpus and it '
        + 'is not recoverable (migration 025 header). The columns are carried, not featurised, '
        + 'so this costs the retrain nothing — it only means the vendor-distance question '
        + 'stays unanswerable until collectRealtime.js has run again.');
    }
  }

  return { optional, undeclaredWeekly, calendarGaps, provenance };
}

// One pass, both counts, and NULL-safe against a database missing either
// column: a column that does not exist cannot be named in SQL at all, so the
// absent case selects a literal 0 rather than erroring the way the removed
// ALTER TABLE used to paper over.
//
// COST, stated rather than assumed: this is a second sequential scan of
// ml_training_data (~1 GB, 3.9M rows) on top of the calendar-gap count above,
// so a handful of seconds ahead of a two-hour export. It is deliberately not
// folded into that query — the two answer unrelated questions and this one has
// to build its column list conditionally — and a handful of seconds is not a
// reason to make either harder to read or to test.
//
// COUNT(vendor_forecast_pct), not a SUM over a truthiness test: COUNT of a
// column counts NON-NULLS, so a stored forecast of 0 is counted. A row where
// the vendor predicted an empty venue is a row that HAS a forecast.
async function labelCoverage(db, optional) {
  const named = optional.label_source
    ? `COUNT(*) FILTER (WHERE label_source IN ('live', 'forecast'))::bigint`
    : '0::bigint';
  const vendored = optional.vendor_forecast_pct
    ? 'COUNT(vendor_forecast_pct)::bigint'
    : '0::bigint';
  const { rows: [row] } = await db.query(
    `SELECT COUNT(*)::bigint AS realtime_rows,
            ${named} AS named,
            ${vendored} AS with_vendor_forecast
       FROM ml_training_data
      WHERE collection_mode = 'realtime' AND busyness_pct IS NOT NULL`
  );
  return row;
}

// fs.WriteStream.write() returns false when its buffer is full and the rest is
// held in memory until the OS catches up. The old loop ignored that and ran
// synchronously, so an entire city's CSV — hundreds of MB — accumulated in the
// process before a single byte reached the disk. Await the drain.
//
// BOTH listeners are removed on either outcome. A `once('error', reject)` that
// is only removed when it fires accumulates one dead listener per drain — tens
// of thousands of them over a 600 MB file, a MaxListenersExceededWarning at
// eleven, and an array that grows for the whole run.
function write(stream, chunk) {
  if (stream.write(chunk)) return null;
  return new Promise((resolve, reject) => {
    const onDrain = () => { stream.removeListener('error', onError); resolve(); };
    const onError = (err) => { stream.removeListener('drain', onDrain); reject(err); };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function finished(stream) {
  return new Promise((resolve, reject) => {
    const onFinish = () => { stream.removeListener('error', onError); resolve(); };
    const onError = (err) => { stream.removeListener('finish', onFinish); reject(err); };
    stream.once('finish', onFinish);
    stream.once('error', onError);
  });
}

let cursorSeq = 0;

// Stream one city through a server-side cursor. `pool.query()` buffers the
// WHOLE result set as JS objects before returning — for the largest city that
// is hundreds of thousands of ~40-field objects, and the failure mode is an
// out-of-memory crash two thirds of the way through a two-hour export.
async function exportCity(pool, city, stream, optional, onRows) {
  const q = cityQuery(city, optional);
  const name = `flock_export_cur_${++cursorSeq}`;
  const client = await pool.connect();
  let rows = 0;
  try {
    // Explicit READ ONLY on top of the connection-level default: the guarantee
    // should not depend on how the pool was constructed.
    await client.query('BEGIN READ ONLY');
    await client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${q.text}`, q.values);
    for (;;) {
      const batch = await client.query(`FETCH FORWARD ${FETCH_SIZE} FROM ${name}`);
      if (batch.rows.length === 0) break;
      let chunk = '';
      for (const row of batch.rows) chunk += rowToCsv(row) + '\n';
      const backpressure = write(stream, chunk);
      if (backpressure) await backpressure;
      rows += batch.rows.length;
      if (onRows) onRows(rows);
    }
    await client.query(`CLOSE ${name}`);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw err;
  } finally {
    client.release();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The export itself.
//
// PARTIAL OUTPUT IS THE ENEMY. prepare_features.py's contract check reads the
// HEADER and the column count — a CSV truncated by a full disk, a killed
// process or a dropped connection passes that check and trains a model on a
// silently shortened corpus. So both files are written to `.partial` paths and
// renamed only after the streams have flushed, and the final paths are deleted
// FIRST so a failed run leaves no file at all rather than the previous run's.
// ---------------------------------------------------------------------------
async function runExport({ pool, outDir = __dirname, log = console.log } = {}) {
  const started = Date.now();
  const trainPath = path.join(outDir, 'training_data.csv');
  const holdoutPath = path.join(outDir, 'holdout_data.csv');
  const trainTmp = `${trainPath}.partial`;
  const holdoutTmp = `${holdoutPath}.partial`;

  // FIRST, before anything can fail: the previous run's files go. A refusal or
  // a crash must never leave a readable training_data.csv behind — it has the
  // right header and the right 44 columns, so prepare_features.py accepts it,
  // and the retrain silently runs on the corpus the last export saw.
  for (const p of [trainPath, holdoutPath, trainTmp, holdoutTmp]) {
    fs.rmSync(p, { force: true });
  }

  const pre = await preflight(pool, log);
  if (pre.undeclaredWeekly) {
    const err = new Error(UNDECLARED_WEEKLY_MESSAGE);
    err.code = 'UNDECLARED_HOUR_AXIS';
    throw err;
  }
  const gaps = pre.calendarGaps;
  if (Number(gaps.no_month) > 0 || Number(gaps.no_season) > 0) {
    log(`[Export] WARNING: ${gaps.no_month} of ${gaps.total} labelled rows carry no month and `
      + `${gaps.no_season} carry no season. prepare_features.py REFUSES THE WHOLE RUN on `
      + 'the first such row (month=0 with four zero season one-hots is a point inference '
      + 'can never produce), so this export would be an hour spent on a CSV it will reject. '
      + 'Migration 024 stamps both from collected_at — apply it, or accept a run under '
      + 'FLOCK_CALENDAR_POLICY=drop, which is not shippable.');
  }

  log('[Export] Finding cities with data...');
  const { rows: cityRows } = await pool.query(
    `SELECT DISTINCT v.city FROM ml_training_data t JOIN ml_venues v ON t.venue_id = v.id WHERE t.busyness_pct IS NOT NULL ORDER BY v.city`
  );
  const cities = cityRows.map((r) => r.city);
  log(`[Export] Found ${cities.length} cities: ${cities.join(', ')}`);

  const trainStream = fs.createWriteStream(trainTmp);
  const holdoutStream = fs.createWriteStream(holdoutTmp);
  let trainCount = 0;
  let holdoutCount = 0;
  const cityCounts = {};

  try {
    await write(trainStream, HEADER + '\n');
    await write(holdoutStream, HEADER + '\n');

    for (const city of cities) {
      log(`[Export] Exporting ${city}...`);
      const isHoldout = HOLDOUT_CITIES.includes(city);
      const stream = isHoldout ? holdoutStream : trainStream;
      // A city can take minutes. Say something every 250k rows so a long export
      // is distinguishable from a hung one.
      let announced = 0;
      const n = await exportCity(pool, city, stream, pre.optional, (soFar) => {
        if (soFar - announced >= 250000) {
          announced = soFar;
          log(`    ... ${soFar} rows`);
        }
      });
      cityCounts[city] = n;
      if (isHoldout) holdoutCount += n; else trainCount += n;
      log(`  ${n} rows ${isHoldout ? '(holdout)' : '(train)'}`);
    }

    trainStream.end();
    holdoutStream.end();
    await Promise.all([finished(trainStream), finished(holdoutStream)]);
  } catch (err) {
    trainStream.destroy();
    holdoutStream.destroy();
    fs.rmSync(trainTmp, { force: true });
    fs.rmSync(holdoutTmp, { force: true });
    throw err;
  }

  // Only now do these become the files prepare_features.py will read.
  fs.renameSync(trainTmp, trainPath);
  fs.renameSync(holdoutTmp, holdoutPath);

  const elapsedMs = Date.now() - started;
  const trainBytes = fs.statSync(trainPath).size;
  const holdoutBytes = fs.statSync(holdoutPath).size;
  const mb = (b) => (b / (1024 * 1024)).toFixed(1);

  log(`\n[Export] Training set: ${trainCount} rows → ${trainPath} (${mb(trainBytes)} MB)`);
  log(`[Export] Holdout set: ${holdoutCount} rows → ${holdoutPath} (${mb(holdoutBytes)} MB)`);
  log(`[Export] Holdout cities: ${HOLDOUT_CITIES.join(', ')}`);
  log(`[Export] Elapsed: ${(elapsedMs / 1000).toFixed(1)}s for ${trainCount + holdoutCount} rows`);

  log('\n[Export] City breakdown:');
  for (const [city, count] of Object.entries(cityCounts).sort((a, b) => b[1] - a[1])) {
    const set = HOLDOUT_CITIES.includes(city) ? '(holdout)' : '(train)';
    log(`  ${city.padEnd(16)} ${String(count).padStart(8)} rows  ${set}`);
  }

  return { trainCount, holdoutCount, cityCounts, trainPath, holdoutPath, trainBytes, holdoutBytes, elapsedMs };
}

// The pool is built HERE, not at module load. Requiring this file used to run
// dotenv against backend/.env — which points at the live Railway database — and
// construct a pg Pool as a side effect of an `import`.
function createPool() {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
  if (!process.env.DATABASE_URL && process.env.PGHOST) {
    const host = process.env.PGHOST;
    const port = process.env.PGPORT || 5432;
    const user = process.env.PGUSER || 'postgres';
    const pass = process.env.PGPASSWORD || '';
    const db = process.env.PGDATABASE || 'railway';
    process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
  }
  const { Pool } = require('pg');
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // An explicit PGSSLMODE wins — see config/database.js.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    // Server-enforced read-only. Any INSERT/UPDATE/DELETE/DDL from this process
    // fails with 25006 instead of touching production.
    options: '-c default_transaction_read_only=on',
  });
}

async function main() {
  const pool = createPool();
  try {
    await runExport({ pool });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[Export] Error:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  cityQuery,
  rowToCsv,
  HEADER,
  labelProvenance,
  labelSource,
  vendorForecastPct,
  observedDate,
  OPTIONAL_COLUMNS,
  escapeCsv,
  preflight,
  labelCoverage,
  exportCity,
  runExport,
  createPool,
  BASELINE_AGGREGATE_SQL,
  HOUR_AXIS_VENUE_LOCAL,
  HOLDOUT_CITIES,
  UNDECLARED_WEEKLY_MESSAGE,
  FETCH_SIZE,
};
