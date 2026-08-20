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
// ---------------------------------------------------------------------------
// ROUND 23: venue_feedback AS A LABEL SOURCE (RETRAIN.md "next lever 1")
//
// Every label in this corpus comes from one vendor. A model trained on it can
// only be rewarded for agreeing with BestTime, so the part of BestTime that is
// wrong is indistinguishable from the part that is right. `venue_feedback` is
// the one label source in this product that is not BestTime: a human who was at
// the venue saying what it was like. That is the entire point of this path, and
// the reason it is built now rather than when the rows arrive.
//
// FEEDBACK AS A FEATURE IS ALREADY SHIPPED AND IS A DIFFERENT THING. The
// per-venue aggregate joined below (avg_user_crowd / user_feedback_count /
// avg_prediction_error, consumed by prepare_features.add_user_feedback_features)
// is a DESCRIPTION OF A VENUE attached to a row whose label came from BestTime:
// "people who reported on this place tend to say X". Feedback as a LABEL is the
// y of the row itself. Putting the same report on both sides is the textbook
// leak — and here it is worse than the textbook case, because
// avg_prediction_error is literally `mapped(crowd_level) - predicted_score`,
// i.e. the candidate label minus a model output. A feedback-labelled row that
// also carried that venue's feedback aggregate would be handed its own answer
// with a venue-level smoother on it. So the rows this path emits carry EMPTY
// feedback-feature fields; see feedbackCellToTrainingRow.
//
// THE MAPPING IS THE HARD PART, AND IT IS NOT SOLVED. See the long block above
// FEEDBACK_CROWD_MAP_ENV. Short version: `crowd_level` is a 3-point human
// perception (Quiet / Moderate / Very Busy) and `busyness_pct` is BestTime's
// per-venue percentage of that venue's own typical peak. No function from the
// first to the second can be justified from anything in this repository, and
// nothing in this file invents one. The path is therefore OFF by default and
// refuses to emit a row unless an operator supplies a mapping explicitly.
//
// IT ALSO CANNOT REACH TRAINING YET, ON PURPOSE. prepare_features.py pins
// label_source to {'', 'live', 'forecast'} and recomputes label_provenance from
// it, so a 'user_report' row raises CorpusContractError by name. That is the
// correct interlock, not an oversight: the sample-weight tier for human reports
// lives in prepare_features.py, this file may not edit it, and a row that
// arrived without one would land in the `1.0` branch — a coarse human report
// outranking every BestTime live observation in the corpus. Round 10 and round
// 20 both exist because a label silently sat at weight 1.0. See the HANDOFF
// comment at the labelProvenance() call site.
//
// EMPTY IS NOT ZERO. Both columns are written as an EMPTY FIELD when the row
// does not carry a value, and 0 is a legal vendor forecast (a venue nobody is
// at). pandas reads the empty field as NaN and prepare_features.py never
// fillna(0)s a carried column — only feature columns — so "we never asked" and
// "the vendor said nobody is there" stay different facts all the way through.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { CITIES, getSeason, isHoliday, isSchoolBreak } = require('../config');
// Round 24 — the owner slider's readings as labels. The whole path (query,
// owner-median anchor, floors, census) lives in its own module; this file only
// wires it into the per-city loop and lends it the two things with one owner:
// rowToCsv (the 44-column contract) and BASELINE_AGGREGATE_SQL (the anchor).
const ownerLabels = require('./ownerLabelExport');

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
//   user_report — round 23: the label is a verified human report out of the
//              venue_feedback table,
//              not a BestTime number at all. Named rather than left to fall
//              through to 'unknown', because 'unknown' is the weight-1.0 pool.
//
// HANDOFF — prepare_features.py MUST change before a 'user_report' row can
// train, and this file may not make that change (another agent owns the file):
//   1. LABEL_SOURCE_VALUES must gain 'user_report', and derive_label_provenance
//      must recognise it, or enforce_label_contract raises on the first row.
//   2. The sample-weight ladder must gain a tier for it. Today the ladder is
//      `is_realtime != 1 -> 0.05, forecast -> 0.3, else 1.0`, so a user_report
//      row would take the ELSE branch and outrank every live BestTime
//      observation in the corpus on the strength of a 3-point tap. The tier
//      argued for in the report is 0.15: above a weekly snapshot (which is not
//      about the moment at all) and below a vendor forecast (which is at least
//      denominated in the label's own units).
// Until both land, a 'user_report' row stops prepare_features.py by name. That
// interlock is deliberate and must not be softened from this side.
function labelProvenance(row) {
  if (row.collection_mode !== 'realtime') return 'weekly';
  if (row.label_source === 'live' || row.label_source === 'forecast') return row.label_source;
  if (row.label_source === FEEDBACK_LABEL_SOURCE) return FEEDBACK_LABEL_SOURCE;
  // Round 24: an owner-slider reading (owner-median anchored — see
  // ownerLabelExport.js). Named for the same reason user_report is: 'unknown'
  // is the weight-1.0 pool, and one self-interested reporter falling into it
  // would outrank every live BestTime observation in the corpus. The handoff
  // tier argued for it is OWNER_LABEL_WEIGHT (0.10); prepare_features.py
  // refuses the value by name until its ladder gains that tier.
  if (row.label_source === ownerLabels.OWNER_LABEL_SOURCE) return ownerLabels.OWNER_LABEL_SOURCE;
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

// ===========================================================================
// ROUND 23 — venue_feedback rows as LABELS.
//
// Everything below produces objects of exactly the shape rowToCsv() already
// consumes, so the 44-column contract cannot drift for these rows: there is one
// row builder and one header, and a column added to the contract is written for
// vendor and feedback rows by the same code.
// ===========================================================================

// The value written into the `label_source` column of the CSV for these rows,
// and (via labelProvenance) into `label_provenance`. Deliberately NOT a value
// migration 025's CHECK allows: nothing may ever write it into
// ml_training_data. It exists only in the export.
const FEEDBACK_LABEL_SOURCE = 'user_report';

// One row per (venue, dow, hour, local date) needs at least this many DISTINCT
// reporters. Not a number picked here: it is the threshold this product already
// uses everywhere a human-derived figure becomes publishable —
// crowdEngine's calibration floor, the budget ceiling, ghost commit. The
// argument crowdEngine.js gives for it applies verbatim to a training label and
// is stronger: crowd_level has three settings, so one report is a 60-point-wide
// opinion, and three is the first count at which one outlier is outvoted rather
// than being the whole signal.
const MIN_FEEDBACK_REPORTERS = 3;

// The feedback candidates are grouped in memory rather than streamed through a
// cursor, because verified feedback is orders of magnitude smaller than the
// 3.9M-row vendor corpus and grouping in SQL would need a window function whose
// correctness is much harder to test than the JS below. This cap is what stops
// that assumption from becoming an out-of-memory crash in silence: crossing it
// REFUSES the run and says to move the grouping into SQL.
const FEEDBACK_ROW_CAP = 2000000;

const FEEDBACK_ENABLE_ENV = 'FLOCK_EXPORT_FEEDBACK_LABELS';
const FEEDBACK_CROWD_MAP_ENV = 'FLOCK_FEEDBACK_CROWD_MAP';

// ---------------------------------------------------------------------------
// WHY THERE IS NO DEFAULT MAPPING, AND WHY A WRONG ONE WOULD BE WORSE THAN NONE
//
// `venue_feedback.crowd_level` is 1 / 2 / 3, rendered in the app as
// "Quiet" / "Moderate" / "Very Busy". `busyness_pct` is BestTime's number for a
// venue-hour. Four reasons no function between them can be justified from
// anything that exists in this repository today:
//
//   1. THEY ARE NOT THE SAME QUANTITY. busyness_pct is normalised per venue
//      against that venue's own typical peak — 100 means "as busy as this place
//      gets", not "full". A human answering "Very Busy" is reporting perceived
//      crowding against their own expectations, with no venue normalisation in
//      it at all. A quiet neighbourhood bar at its Saturday peak is busyness
//      100 and will be reported "Moderate" by most people who go there. That
//      error is not noise; it correlates with venue capacity and category, so
//      it would enter the model as a systematic bias on exactly the venues the
//      corpus is thinnest on.
//   2. THE CONSTANTS THAT LOOK LIKE A MAPPING ARE A DISPLAY CONVENTION.
//      `crowdEngine.CROWD_LEVEL_TO_SCORE = {1:20, 2:50, 3:80}` (mirrored in the
//      SQL of mlPredictor.getVenueFeedback and in the aggregate join in this
//      file) exists to blend a human report into a 0-100 number shown on a
//      card. Its own comment defends the SPAN, because the calibration guard
//      rails are derived from it — not the values. Reusing it as ground truth
//      would promote a UI constant to a measurement, which is the same move as
//      the 85%-confidence figure MODEL-METRICS.md exists to stop.
//   3. IT CANNOT BE FITTED, BECAUSE THE CALIBRATION PAIRS DO NOT EXIST. The
//      honest way to get this mapping is to measure it: take moments where a
//      verified report and a BestTime observation describe the same
//      (venue, dow, hour, date) and read off the conditional distribution of
//      busyness_pct given crowd_level. There are zero verified feedback rows
//      today, so there are zero such pairs. A mapping asserted before the pairs
//      exist can never be checked against the pairs afterwards, because the
//      model trained on it will have already moved.
//   4. THE DELTA LABEL MAKES A POINT MAPPING ACTIVELY POISONOUS. This is a
//      delta model: prepare_features trains on `busyness_pct - baseline`. With
//      only three possible label values, `delta = map(level) - baseline` is,
//      across a corpus whose baselines span 0-100, dominated by `-baseline`. Its
//      correlation with the baseline is -1 by construction. The model has
//      several features from which the baseline is largely recoverable
//      (category_baseline, refined_category_baseline, the smoothed neighbour
//      hours, neighbor_baseline_same_hour), so on this subpopulation the
//      loss-minimising thing to learn is "predict minus the baseline" — and
//      that is a rule about our own anchor, learned from human reports, that
//      would then be applied to every venue the model serves.
//
// WHAT WOULD MAKE IT JUSTIFIABLE, smallest change first (see the report):
//   a. venue_feedback needs the venue-local calendar DATE of the report, so a
//      report and a BestTime observation of the same moment can be joined and
//      the mapping measured. It is derivable today from
//      `created_at AT TIME ZONE ml_venues.timezone` — which is what this file
//      does — but only for venues in ml_venues; a stored column would cover
//      the rest and would not depend on a join.
//   b. Better, and it removes the mapping problem instead of measuring it:
//      ask the venue-relative question. "Compared to a normal Friday here, was
//      it quieter / about the same / busier?" is a report about the DELTA,
//      which is what the model actually predicts, and it needs no absolute
//      scale and no per-venue normalisation. It is a copy change to one sheet
//      in App.js plus one column. Its sign is checkable against BestTime the
//      day the first pair lands, which is more than any 0-100 mapping offers.
//
// So: an operator who has done the measurement supplies the mapping explicitly
// and it is recorded in the run log. Nothing here fills it in.
// ---------------------------------------------------------------------------
const FEEDBACK_MAP_REQUIRED_MESSAGE =
  `REFUSED: ${FEEDBACK_ENABLE_ENV} is set but ${FEEDBACK_CROWD_MAP_ENV} is not. `
  + 'There is no default and there must not be one. crowd_level is a 3-point human '
  + 'perception (Quiet/Moderate/Very Busy) and busyness_pct is BestTime\'s percentage of a '
  + "venue's own typical peak; they are different quantities, and the {1:20, 2:50, 3:80} "
  + 'constants in crowdEngine.js are a display convention for a card, not a measurement. '
  + 'Because this is a delta model, a 3-valued point label makes `delta = map(level) - '
  + 'baseline` almost perfectly anti-correlated with the baseline, so the model would learn '
  + '"predict minus the anchor" from human reports. Measure the mapping first: join verified '
  + 'reports to BestTime observations of the same (venue, dow, hour, date) and read off the '
  + 'conditional distribution. Then pass e.g. '
  + `${FEEDBACK_CROWD_MAP_ENV}='{"1":18,"2":47,"3":79}' with those measured numbers.`;

// Parse and validate the operator-supplied mapping. Every rejection below is a
// value that would otherwise become a silent label.
function parseFeedbackCrowdMap(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    const err = new Error(FEEDBACK_MAP_REQUIRED_MESSAGE);
    err.code = 'FEEDBACK_MAP_MISSING';
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${FEEDBACK_CROWD_MAP_ENV} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${FEEDBACK_CROWD_MAP_ENV} must be a JSON object keyed by crowd_level.`);
  }
  const keys = Object.keys(parsed).sort();
  // Exactly the domain of the CHECK constraint on venue_feedback.crowd_level.
  // A partial map is refused rather than treated as "skip the missing level":
  // silently dropping every "Very Busy" report would bias the corpus toward
  // quiet nights, which is the direction that flatters the metrics.
  if (keys.join(',') !== '1,2,3') {
    throw new Error(
      `${FEEDBACK_CROWD_MAP_ENV} must have exactly the keys "1", "2", "3" `
      + `(venue_feedback.crowd_level's CHECK domain); got [${keys.join(', ')}]. `
      + 'A partial map would silently discard a whole level of report.'
    );
  }
  const map = {};
  for (const k of ['1', '2', '3']) {
    const v = parsed[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new Error(
        `${FEEDBACK_CROWD_MAP_ENV}["${k}"] must be a number in 0-100 (a busyness_pct); got ${JSON.stringify(v)}.`
      );
    }
    map[Number(k)] = v;
  }
  if (!(map[1] < map[2] && map[2] < map[3])) {
    throw new Error(
      `${FEEDBACK_CROWD_MAP_ENV} must be strictly increasing in crowd_level `
      + `(got ${map[1]}, ${map[2]}, ${map[3]}). crowd_level is an ORDINAL — `
      + '1 is quieter than 2 is quieter than 3 — and a non-monotone map asserts otherwise.'
    );
  }
  return map;
}

function feedbackExportRequested(env = process.env) {
  const v = env[FEEDBACK_ENABLE_ENV];
  return v === '1' || v === 'true' || v === 'yes';
}

// ---------------------------------------------------------------------------
// THE CLOCK. venue_feedback.day_of_week / hour are BUCKET KEYS on the VENUE's
// wall clock (routes/feedback.js venueLocalDayHour), and migration 021
// backfilled every row that predated that fix. ml_training_data.hour has been
// on the venue-local clock since migration 023. So the two agree — but that is
// a claim about two migrations having run, and PRE-RETRAIN-AUDIT finding 13
// named exactly this as the risk in doing what this file now does ("that is a
// fourth clock; do not do it until finding #0.1 is resolved"). It is resolved,
// and it is CHECKED rather than assumed: 021's own predicate is "the stored
// keys disagree with created_at rendered in the venue's zone", which is a fixed
// point of the current write path, so a single disagreeing row proves 021 has
// not run on this database and the export REFUSES.
//
// The join to pg_timezone_names is not decoration either: `AT TIME ZONE` raises
// on a zone string Postgres does not know, and one typo'd row in ml_venues
// would otherwise abort the whole query. Rows it excludes are counted by the
// census as `no_usable_timezone` rather than disappearing.
// ---------------------------------------------------------------------------
function feedbackCandidateQuery(city) {
  return {
    text: `
      SELECT
        f.id           AS feedback_id,
        f.user_id,
        f.crowd_level,
        f.day_of_week,
        f.hour,
        f.created_at,
        to_char(f.created_at AT TIME ZONE z.name, 'YYYY-MM-DD') AS local_date,
        (EXTRACT(DOW  FROM (f.created_at AT TIME ZONE z.name))::int = f.day_of_week
         AND EXTRACT(HOUR FROM (f.created_at AT TIME ZONE z.name))::int = f.hour) AS clock_agrees,
        v.id           AS venue_id,
        v.city,
        v.google_place_id,
        v.google_types, v.latitude, v.longitude,
        a.venue_category, a.price_level, a.rating, a.review_count,
        COALESCE(b.baseline, 0) AS baseline_busyness
      -- verified = true is applied HERE, at the source, rather than in the
      -- WHERE clause forty lines down: an unverified report must not be able to
      -- reach any join, any aggregate or any reader in this query, and a filter
      -- that sits beside the table it protects cannot be separated from it by a
      -- later edit. Every other reader of this table in the codebase carries the
      -- same restriction (routes/crowd.js, services/mlPredictor.js,
      -- routes/venueDashboard.js) and __tests__/arrayShapeSweep.test.js pins
      -- that none of them lose it.
      FROM (SELECT * FROM venue_feedback WHERE verified = true) f
      JOIN ml_venues v         ON v.google_place_id = f.venue_place_id
      JOIN pg_timezone_names z ON z.name = v.timezone
      -- Venue-level attributes are not on venue_feedback and not on ml_venues;
      -- they are stamped onto each ml_training_data row at collection. Take the
      -- most recent one for this venue. A venue with no corpus row at all has
      -- no category, no baseline and no place in the category-baseline maps, so
      -- it is excluded by name below rather than exported with nulls.
      LEFT JOIN LATERAL (
        SELECT t.venue_category, t.price_level, t.rating, t.review_count
          FROM ml_training_data t
         WHERE t.venue_id = v.id
         ORDER BY t.collected_at DESC NULLS LAST, t.id DESC
         LIMIT 1
      ) a ON true
      -- The SAME anchor definition every other row in this file gets. A
      -- feedback row trains as a delta against the number production serves, or
      -- it trains against nothing.
      LEFT JOIN (${BASELINE_AGGREGATE_SQL}
      ) b
        ON b.google_place_id = v.google_place_id
       AND b.day_of_week = f.day_of_week
       AND b.hour = f.hour
      WHERE v.city = $1
      ORDER BY v.id, f.day_of_week, f.hour, local_date
    `,
    values: [city],
  };
}

// Group candidate rows into one training row per (venue, dow, hour, date), one
// vote per reporter.
//
// ONE VOTE PER ACCOUNT, for the reason crowdEngine.usableCalibrationReports
// gives: a single account that filed six reports for the same venue-hour used
// to arrive as six independent voices, which both cleared any sample floor by
// itself and pushed the blend weight up the ladder. Newest report per user_id
// wins — an account revising its own opinion is one opinion. A NULL user_id
// counts individually, matching that function; venue_feedback.user_id CASCADEs
// on account deletion so no such row exists today.
function groupFeedbackCells(rows) {
  const cells = new Map();
  for (const row of rows) {
    const key = `${row.venue_id}|${row.day_of_week}|${row.hour}|${row.local_date}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { key, meta: row, votes: new Map() };
      cells.set(key, cell);
    }
    const voter = row.user_id == null ? `anon:${row.feedback_id}` : `u:${row.user_id}`;
    const prev = cell.votes.get(voter);
    const at = row.created_at ? new Date(row.created_at).getTime() : 0;
    if (!prev || at >= prev.at) cell.votes.set(voter, { row, at });
  }
  return [...cells.values()];
}

// Every exclusion reason this path can produce. Two kinds, and the difference
// is the whole doctrine:
//   ABSENCE  — the row is fine, we just cannot place it. Counted, logged, skipped.
//   CORRUPT  — the row contradicts something the schema or a migration
//              guarantees. Stops the run; a counted skip would hide it.
const FEEDBACK_EXCLUSION_REASONS = {
  no_observation_date: { kind: 'absence', why: 'created_at is NULL, so the venue-local date of the report is unknowable and the row cannot be dated, holiday-stamped or joined to a moment' },
  no_venue_attributes: { kind: 'absence', why: 'the venue has no ml_training_data row, so it has no venue_category — it is in none of the category-baseline cells and cannot be featurised' },
  below_reporter_floor: { kind: 'absence', why: `fewer than ${MIN_FEEDBACK_REPORTERS} distinct reporters for the venue-hour-date; one 3-point tap is a 60-point-wide opinion` },
  clock_disagreement: { kind: 'corrupt', why: 'the stored day_of_week/hour disagree with created_at rendered in the venue timezone — migration 021 has not been applied to this database, so the bucket keys are on the UTC clock and the row would be a second clock in the hour column' },
  unmappable_crowd_level: { kind: 'corrupt', why: "crowd_level is outside venue_feedback's CHECK domain of 1-3, so something wrote past the constraint and no mapping covers it" },
};

// Build the training row for one grouped cell, or say why not.
function feedbackCellToTrainingRow(cell, crowdMap) {
  const meta = cell.meta;
  const votes = [...cell.votes.values()].map((v) => v.row);

  for (const v of votes) {
    if (v.clock_agrees === false) return { excluded: 'clock_disagreement', cell };
    if (!Object.prototype.hasOwnProperty.call(crowdMap, v.crowd_level)) {
      return { excluded: 'unmappable_crowd_level', cell, detail: v.crowd_level };
    }
  }
  if (!meta.local_date) return { excluded: 'no_observation_date', cell };
  if (meta.venue_category == null || meta.venue_category === '') {
    return { excluded: 'no_venue_attributes', cell };
  }
  if (votes.length < MIN_FEEDBACK_REPORTERS) return { excluded: 'below_reporter_floor', cell };

  const mean = votes.reduce((s, v) => s + crowdMap[v.crowd_level], 0) / votes.length;
  const busyness = Math.round(mean);
  const month = Number(meta.local_date.slice(5, 7));

  return {
    reporters: votes.length,
    row: {
      venue_id: meta.venue_id,
      day_of_week: meta.day_of_week,
      hour: meta.hour,
      // From the report's OWN venue-local date. Not a guess and not the
      // insert-time UTC month audit finding 5 was about.
      month,
      season: getSeason(month),
      is_holiday: isHoliday(meta.local_date),
      is_school_break: isSchoolBreak(meta.local_date),
      venue_category: meta.venue_category,
      price_level: meta.price_level,
      rating: meta.rating,
      review_count: meta.review_count,
      // NO WEATHER, NO EVENTS. Nothing recorded either at the moment the report
      // describes, and both are unrecoverable after the fact. Empty, never 0:
      // 0°C and "no reading" are different facts, and recover_weather_codes
      // already treats a missing reading honestly (weather_unknown).
      // KNOWN BLOCKER, stated rather than papered over: prepare_features.py
      // ends with a fillna(0) over the feature columns, which WOULD assert 0°C
      // and drive the climate-anomaly feature hard negative on every one of
      // these rows. That imputation has to become provenance-aware before a
      // user_report row may train. It is in the handoff.
      temperature: null,
      humidity: null,
      wind_speed: null,
      weather_condition: null,
      weather_condition_code: null,
      is_raining: false,
      event_nearby: false,
      event_distance_km: null,
      event_size: null,
      event_type: null,
      event_hours_until: null,
      has_nearby_event: false,
      nearest_event_distance_km: null,
      nearest_event_attendance: null,
      total_nearby_events: null,
      total_nearby_attendance: null,
      nearest_event_type: null,
      baseline_busyness: meta.baseline_busyness,
      // A human report is an observation of ONE MOMENT, not a synthetic typical
      // week, so is_realtime=1 is the truthful value of that column and the
      // weekly 0.05 pool would be a lie about what the row is. What separates
      // this row from a BestTime live reading is label_provenance, which is
      // what the weight ladder is keyed on.
      collection_mode: 'realtime',
      busyness_pct: busyness,
      city: meta.city,
      google_types: meta.google_types,
      latitude: meta.latitude,
      longitude: meta.longitude,
      // THE FEEDBACK-AS-FEATURE CHANNEL IS OFF FOR THESE ROWS. The per-venue
      // aggregate contains the very reports that produced this label, and
      // avg_prediction_error is `mapped(crowd_level) - predicted_score`, i.e.
      // this row's own label minus a model output. Empty rather than 0 so the
      // CSV records "not supplied"; prepare_features will read NaN and fill it
      // with the same 0 a venue with no feedback gets, which is the correct
      // encoding of "this channel says nothing about this row".
      avg_user_crowd: null,
      user_feedback_count: null,
      avg_prediction_error: null,
      stored_observed_date: meta.local_date,
      label_source: FEEDBACK_LABEL_SOURCE,
      // BestTime was never asked about this moment. Empty, not 0.
      vendor_forecast_pct: null,
    },
  };
}

// The census. Runs on EVERY export whether the path is enabled or not, for the
// same reason the round-20 provenance census does: the number that matters is
// the day it stops being zero, and the only way that day gets noticed is if the
// export says so out loud every time.
async function feedbackCensus(db, hasVerifiedColumn) {
  if (!hasVerifiedColumn) {
    return { available: false };
  }
  const { rows: [row] } = await db.query(
    `SELECT
       COUNT(*)::bigint AS verified_rows,
       COUNT(*) FILTER (WHERE v.id IS NOT NULL)::bigint AS in_ml_venues,
       COUNT(*) FILTER (WHERE z.name IS NOT NULL)::bigint AS with_usable_timezone,
       COUNT(*) FILTER (
         WHERE z.name IS NOT NULL
           AND f.created_at IS NOT NULL
           AND NOT (EXTRACT(DOW  FROM (f.created_at AT TIME ZONE z.name))::int = f.day_of_week
                AND EXTRACT(HOUR FROM (f.created_at AT TIME ZONE z.name))::int = f.hour)
       )::bigint AS clock_disagreements
     FROM venue_feedback f
     LEFT JOIN ml_venues v         ON v.google_place_id = f.venue_place_id
     LEFT JOIN pg_timezone_names z ON z.name = v.timezone
     WHERE f.verified = true`
  );
  return { available: true, ...row };
}

const FEEDBACK_CLOCK_REFUSAL_MESSAGE =
  'REFUSED: verified venue_feedback rows whose stored (day_of_week, hour) disagree with '
  + 'created_at rendered in their venue timezone. Those bucket keys are on the UTC clock '
  + '(routes/feedback.js wrote EXTRACT(DOW/HOUR FROM NOW()) before the venue-local fix), so '
  + 'exporting them would put a second clock in the hour column — the disease migration 023 '
  + 'cured for ml_training_data, and the exact risk PRE-RETRAIN-AUDIT finding 13 raised '
  + 'against this export path. Apply migration 021_backfill_feedback_local_buckets.sql '
  + '(it runs on server boot and is idempotent), then export again.';

// Export every eligible feedback cell for one city onto `stream`. Returns
// counters; the caller aggregates and reports them.
async function exportFeedbackCity(pool, city, stream, crowdMap, counters) {
  const q = feedbackCandidateQuery(city);
  const client = await pool.connect();
  let rows;
  try {
    await client.query('BEGIN READ ONLY');
    ({ rows } = await client.query(q.text, q.values));
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }

  counters.candidates += rows.length;
  if (counters.candidates > FEEDBACK_ROW_CAP) {
    const err = new Error(
      `REFUSED: more than ${FEEDBACK_ROW_CAP} verified feedback candidate rows. This path `
      + 'groups them in memory on the assumption that verified feedback stays orders of '
      + 'magnitude below the vendor corpus. That assumption has expired — move the '
      + 'per-(venue, dow, hour, date) grouping into SQL rather than raising this cap.'
    );
    err.code = 'FEEDBACK_ROW_CAP';
    throw err;
  }

  let chunk = '';
  for (const cell of groupFeedbackCells(rows)) {
    counters.cells += 1;
    const out = feedbackCellToTrainingRow(cell, crowdMap);
    if (out.excluded) {
      counters.excluded[out.excluded] = (counters.excluded[out.excluded] || 0) + 1;
      if (FEEDBACK_EXCLUSION_REASONS[out.excluded].kind === 'corrupt') {
        counters.corrupt.push({ reason: out.excluded, city, key: cell.key, detail: out.detail });
      }
      continue;
    }
    counters.emitted += 1;
    counters.reporters += out.reporters;
    chunk += rowToCsv(out.row) + '\n';
  }
  if (chunk) {
    const backpressure = write(stream, chunk);
    if (backpressure) await backpressure;
  }
  return counters;
}

function newFeedbackCounters() {
  return { candidates: 0, cells: 0, emitted: 0, reporters: 0, excluded: {}, corrupt: [] };
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

  // Round 23: the venue_feedback census. Same doctrine as the round-20 block
  // above — a REPORT, never a gate, because it is zero on the corpus today and
  // a gate on it would block every retrain until the product has users.
  //
  // `verified` came in with migration 003. Without it there is no way to tell a
  // presence-verified report from a Sybil one, and every other reader in the
  // codebase (routes/crowd.js, mlPredictor, the aggregate join above) filters on
  // it — so its absence disables the label path rather than widening it.
  const feedbackColumns = await columnsPresent(db, 'venue_feedback');
  const feedback = await feedbackCensus(db, feedbackColumns.has('verified'));
  if (!feedback.available) {
    log('[Export] NOTE: venue_feedback has no `verified` column (migration 003). The '
      + 'feedback-label path is disabled: an unverified report must never become a '
      + 'training label.');
  } else {
    log(`[Export] Feedback labels: ${feedback.verified_rows} verified venue_feedback rows — `
      + `${feedback.in_ml_venues} at a venue in ml_venues, `
      + `${feedback.with_usable_timezone} of those with a usable timezone.`);
    if (Number(feedback.verified_rows) === 0) {
      log('[Export] NOTE: no verified feedback exists yet, so the only label source in this '
        + 'corpus is BestTime. Until that changes the model can only be rewarded for agreeing '
        + `with one vendor. The path is built and dormant; set ${FEEDBACK_ENABLE_ENV}=1 with a `
        + `measured ${FEEDBACK_CROWD_MAP_ENV} once there are rows.`);
    }
  }

  return { optional, undeclaredWeekly, calendarGaps, provenance, feedback };
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

  // Round 23. Resolved BEFORE a single byte is written: an operator who set the
  // flag without a mapping must find out in the first second, not after a
  // two-hour vendor export.
  const feedbackEnabled = feedbackExportRequested();
  let crowdMap = null;
  const feedbackCounters = newFeedbackCounters();
  if (feedbackEnabled) {
    if (!pre.feedback.available) {
      const err = new Error(
        `REFUSED: ${FEEDBACK_ENABLE_ENV} is set but venue_feedback has no \`verified\` column, `
        + 'so unverified reports could not be excluded. Apply migration 003.'
      );
      err.code = 'FEEDBACK_UNVERIFIABLE';
      throw err;
    }
    crowdMap = parseFeedbackCrowdMap(process.env[FEEDBACK_CROWD_MAP_ENV]);
    log(`[Export] Feedback labels ENABLED. crowd_level -> busyness_pct map: `
      + `1=${crowdMap[1]}, 2=${crowdMap[2]}, 3=${crowdMap[3]} (operator-supplied; there is no `
      + 'default). Rows are emitted with label_source=' + FEEDBACK_LABEL_SOURCE
      + ', which prepare_features.py currently REFUSES by name — see the handoff note above '
      + 'labelProvenance(). That interlock is why this cannot silently reach training.');
  }

  // Round 24 — owner-slider readings, same shape as the feedback path: env-
  // gated, censused every run either way, and refused downstream by name until
  // prepare_features.py gains the 'owner_report' tier (OWNER_LABEL_WEIGHT,
  // 0.10 — the handoff in ownerLabelExport.js owns the argument).
  const ownerEnabled = ownerLabels.ownerExportRequested();
  const ownerCounters = ownerLabels.newOwnerCounters();
  const ownerCensusResult = await ownerLabels.ownerCensus(pool);
  if (!ownerCensusResult.available) {
    log('[Export] NOTE: venue_owner_reports does not exist — migration 031 has not run on this database.');
  } else {
    log(`[Export] Owner readings in the database: ${ownerCensusResult.readings} `
      + `across ${ownerCensusResult.venues} venue(s) (${ownerCensusResult.retracted} retracted, `
      + `${ownerCensusResult.diverged} diverged). The day this stops being zero is the day the `
      + 'corpus starts growing again — BestTime froze 2026-05-18.');
  }
  if (ownerEnabled) {
    if (!ownerCensusResult.available) {
      const err = new Error(
        `REFUSED: ${ownerLabels.OWNER_ENABLE_ENV} is set but venue_owner_reports does not exist. `
        + 'Apply migration 031 (it runs on server boot).'
      );
      err.code = 'OWNER_TABLE_MISSING';
      throw err;
    }
    log(`[Export] Owner labels ENABLED. Rows are emitted with label_source=`
      + `${ownerLabels.OWNER_LABEL_SOURCE}, owner-median anchored, and prepare_features.py `
      + 'currently REFUSES that value by name. Serving baselines are untouched by design.');
  }

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

      if (feedbackEnabled) {
        const before = feedbackCounters.emitted;
        await exportFeedbackCity(pool, city, stream, crowdMap, feedbackCounters);
        const added = feedbackCounters.emitted - before;
        if (added > 0) {
          cityCounts[city] += added;
          if (isHoldout) holdoutCount += added; else trainCount += added;
          log(`  + ${added} feedback-labelled rows`);
        }
      }

      if (ownerEnabled) {
        const before = ownerCounters.emitted;
        await ownerLabels.exportOwnerCity(pool, city, stream, ownerCounters, {
          rowToCsv,
          baselineAggregateSql: BASELINE_AGGREGATE_SQL,
          write,
        });
        const added = ownerCounters.emitted - before;
        if (added > 0) {
          cityCounts[city] += added;
          if (isHoldout) holdoutCount += added; else trainCount += added;
          log(`  + ${added} owner-labelled rows (owner-median anchored)`);
        }
      }
    }

    // A corrupt row is never a counted skip. Reported AFTER every city so the
    // message names all of them at once instead of one per re-run, and thrown
    // before the .partial files are renamed, so a refused run leaves no CSV.
    if (feedbackCounters.corrupt.length > 0) {
      const byReason = {};
      for (const c of feedbackCounters.corrupt) byReason[c.reason] = (byReason[c.reason] || 0) + 1;
      const lines = Object.entries(byReason).map(([reason, n]) =>
        `  ${n} cell(s): ${reason} — ${FEEDBACK_EXCLUSION_REASONS[reason].why}`);
      const first = feedbackCounters.corrupt[0];
      const err = new Error(
        (byReason.clock_disagreement ? FEEDBACK_CLOCK_REFUSAL_MESSAGE + '\n' : '')
        + 'REFUSED: venue_feedback cells that cannot be honestly labelled.\n'
        + lines.join('\n')
        + `\n  First offender: city=${first.city} cell=${first.key}`
        + (first.detail !== undefined ? ` detail=${first.detail}` : '')
        + '\n  These are not "absent" rows. Each one contradicts something the schema or a '
        + 'migration guarantees, and letting it become a counted skip is how a bad label '
        + 'stays invisible.'
      );
      err.code = 'FEEDBACK_CORRUPT_ROWS';
      throw err;
    }

    // Same rule, owner path: a reading outside its own CHECK domain proves the
    // constraint is missing from the database this corpus came from.
    if (ownerCounters.corrupt.length > 0) {
      const first = ownerCounters.corrupt[0];
      const err = new Error(
        'REFUSED: venue_owner_reports rows that cannot be honestly labelled.\n'
        + ownerCounters.corrupt.map((c) =>
          `  ${c.reason} — ${ownerLabels.OWNER_EXCLUSION_REASONS[c.reason].why}`).join('\n')
        + `\n  First offender: city=${first.city} venue_id=${first.venueId}`
        + (first.detail !== undefined ? ` detail=${first.detail}` : '')
      );
      err.code = 'OWNER_CORRUPT_ROWS';
      throw err;
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

  if (feedbackEnabled) {
    log(`\n[Export] Feedback labels: ${feedbackCounters.candidates} verified reports -> `
      + `${feedbackCounters.cells} (venue, dow, hour, date) cells -> `
      + `${feedbackCounters.emitted} rows from ${feedbackCounters.reporters} reporter-votes.`);
    const skipped = Object.entries(feedbackCounters.excluded);
    if (skipped.length === 0) {
      log('[Export]   no cells excluded.');
    } else {
      for (const [reason, n] of skipped.sort((a, b) => b[1] - a[1])) {
        log(`[Export]   excluded ${n} cell(s): ${reason} — ${FEEDBACK_EXCLUSION_REASONS[reason].why}`);
      }
    }
  }

  if (ownerEnabled) {
    log(`\n[Export] Owner labels: ${ownerCounters.candidates} readings -> `
      + `${ownerCounters.emitted} rows from ${ownerCounters.anchoredVenues} anchored venue(s).`);
    for (const [reason, n] of Object.entries(ownerCounters.excluded).sort((a, b) => b[1] - a[1])) {
      log(`[Export]   excluded ${n} reading(s): ${reason} — ${ownerLabels.OWNER_EXCLUSION_REASONS[reason].why}`);
    }
  }

  log('\n[Export] City breakdown:');
  for (const [city, count] of Object.entries(cityCounts).sort((a, b) => b[1] - a[1])) {
    const set = HOLDOUT_CITIES.includes(city) ? '(holdout)' : '(train)';
    log(`  ${city.padEnd(16)} ${String(count).padStart(8)} rows  ${set}`);
  }

  return {
    trainCount, holdoutCount, cityCounts, trainPath, holdoutPath,
    trainBytes, holdoutBytes, elapsedMs,
    feedback: { enabled: feedbackEnabled, ...feedbackCounters },
    owner: { enabled: ownerEnabled, ...ownerCounters },
  };
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
  // Round 23 — venue_feedback as a label source.
  FEEDBACK_LABEL_SOURCE,
  FEEDBACK_ENABLE_ENV,
  FEEDBACK_CROWD_MAP_ENV,
  FEEDBACK_MAP_REQUIRED_MESSAGE,
  FEEDBACK_CLOCK_REFUSAL_MESSAGE,
  FEEDBACK_EXCLUSION_REASONS,
  MIN_FEEDBACK_REPORTERS,
  FEEDBACK_ROW_CAP,
  parseFeedbackCrowdMap,
  feedbackExportRequested,
  feedbackCandidateQuery,
  groupFeedbackCells,
  feedbackCellToTrainingRow,
  feedbackCensus,
  exportFeedbackCity,
  newFeedbackCounters,
};
