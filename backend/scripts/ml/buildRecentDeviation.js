// ---------------------------------------------------------------------------
// Build the per-venue trailing deviation offset.
// Populates ml_venue_recent_deviation — one row per venue.
// Run: node scripts/ml/buildRecentDeviation.js
// ---------------------------------------------------------------------------
//
// WHAT IT COMPUTES. For each venue, the MEDIAN of (observed busyness minus that
// venue's own curve for that day-and-hour) across its most recent live
// readings. It answers "lately, does this place run busier or quieter than its
// own typical pattern says?" and nothing else. It is not a prediction, it is
// not a baseline, and it knows nothing about tonight.
//
// WHY THIS IS THE LEVER. The model generalises well across cities
// (leave-one-city-out R2 0.653) and is weak at exactly one thing: how a
// SPECIFIC venue departs from its OWN pattern. That is a fact about one place,
// learnable only by watching that place. Measured on the 8,895
// provenance-verified live September rows production actually serves, adding
// this offset to the curve moved MAE 25.90 to 24.53, within-10 32.8% to 35.7%,
// band-exact 32.1% to 38.0%, improving band-exact on 5 of 5 days and in both
// cities independently.
//
// WHY IT IS NOT THE STATIC VENUE INTERCEPT THAT WAS REFUTED. A frozen per-venue
// mean measured HARM at depth >= 50 readings, because it averages across drift:
// the served slice's mean busyness moves roughly 12 points over six weeks. A
// TRAILING window tracks the level rather than averaging it, and the measured
// gain holds at every depth band with no reversal. That difference is the whole
// reason this file has a window and a staleness stamp instead of a lifetime
// average.
//
// LIVE ROWS ONLY, AND THAT IS NOT A DETAIL. `label_source = 'live'` is the only
// provenance the corpus can prove is an observation of a room rather than a
// vendor's forecast replayed back at us. 457,017 realtime rows carry a NULL
// label_source and no observed date; using them would build the offset out of
// exactly the material section A.6 of ML-RESEARCH.md exists to warn about, and
// an offset derived from a forecast is a forecast wearing a measurement's
// clothes. Today that restricts this to ~9,300 rows over ~1,230 venues, and it
// grows by roughly 1,550 a day.
//
// PAST-ONLY BY CONSTRUCTION. Every row here is already in the past relative to
// any prediction that reads it, because predictions happen now and readings
// happened before now. There is no leave-one-out subtlety of the kind
// export_training_data.js needs, and no cutoff to get wrong, because this table
// is never joined into a training frame. If that ever changes, it acquires the
// same leakage problem the four user-feedback features already have (see
// RETRAIN.md audit finding 13) and would need a date cutoff per row.
require('dotenv').config();
const pool = require('../../config/database');

// The window. Long enough that one strange night cannot move the median, short
// enough to track a venue whose level has genuinely changed. 28 days is the
// same window buildCalibrationAdjustment already uses for user reports, so the
// product has one answer to "how recent is recent" rather than two.
const WINDOW_DAYS = 28;

// The most recent readings per venue that the median is taken over. Measured at
// 5, 10, 20 and unbounded, and all four agree within 0.05 MAE, so this is not a
// tuned knob and should not be presented as one. 20 is chosen because it is the
// largest that still fits comfortably inside the window for the busiest venues.
const MAX_READINGS = 20;

// PostgreSQL's percentile_cont gives a true median including interpolation on
// even counts. Doing it in SQL rather than in JS keeps the whole build one
// statement and one round trip.
//
// The join to ml_venue_baselines is what makes this a DEVIATION rather than a
// level: without the venue's own curve to subtract, a busy venue and a quiet
// one would both look like they were "running high" simply by being busy.
// baseline > 0 is required for the same reason mlPredictor requires it: a
// missing curve is not a curve of zero.
const UPSERT_SQL = `
  INSERT INTO ml_venue_recent_deviation
    (google_place_id, offset_pct, n_readings, window_start, updated_at)
  SELECT
    r.google_place_id,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY r.deviation)::real,
    COUNT(*)::int,
    MIN(r.observed_at),
    NOW()
  FROM (
    SELECT
      v.google_place_id,
      t.busyness_pct - b.baseline AS deviation,
      t.collected_at              AS observed_at,
      ROW_NUMBER() OVER (
        PARTITION BY v.google_place_id ORDER BY t.collected_at DESC
      ) AS recency
    FROM ml_training_data t
    JOIN ml_venues v ON v.id = t.venue_id
    JOIN ml_venue_baselines b
      ON b.google_place_id = v.google_place_id
     AND b.day_of_week = t.day_of_week
     AND b.hour = t.hour
    WHERE t.collection_mode = 'realtime'
      AND t.label_source = 'live'
      AND t.busyness_pct IS NOT NULL
      AND b.baseline > 0
      AND t.collected_at >= NOW() - ($1 || ' days')::interval
  ) r
  WHERE r.recency <= $2
  GROUP BY r.google_place_id
  ON CONFLICT (google_place_id) DO UPDATE SET
    offset_pct   = EXCLUDED.offset_pct,
    n_readings   = EXCLUDED.n_readings,
    window_start = EXCLUDED.window_start,
    updated_at   = EXCLUDED.updated_at
`;

// A venue that has fallen out of the window keeps a stale row otherwise, and a
// stale offset is worse than none: it describes a level the venue may have left
// weeks ago. The serving path also refuses on age, so this is the second of two
// locks rather than the only one.
const PRUNE_SQL = `
  DELETE FROM ml_venue_recent_deviation
   WHERE updated_at < NOW() - ($1 || ' days')::interval
`;

// ---------------------------------------------------------------------------
// THE NEWEST READINGS, FOR THE NOWCAST (migration 092).
//
// services/mlPredictor.js, with CROWD_NOWCAST_ENABLED=true, blends a venue's
// newest live reading from an hour before the one it is scoring into the
// served number. Serving may not add a query for it, so it is stored here, on
// the row the serving path already reads for the offset.
//
// The same readings the offset is built from (live, a busyness, a positive
// curve at the reading's own slot), newest slot first, READINGS_KEPT of them.
// More than one because the newest is often the target hour's own reading,
// which the nowcast refuses to use: right after this runs at hour H, the
// newest reading is H's and the one the card for hour H may carry is H-1's.
// READINGS_KEPT equals mlPredictor's NOWCAST_READINGS_KEPT
// (__tests__/mlServeModes.test.js pins the two).
//
// A short scan window: the nowcast weighs nothing older than twelve hours,
// and READINGS_WINDOW_HOURS only has to cover that from any moment it serves.
// A row whose venue has no reading inside it is set back to NULL, so a stale
// list can never outlive the readings it names.
//
// ITS OWN STATEMENT, run after the offset's and inside its own try, because
// this file deploys with the BESTTIME collector while migration 092 is applied
// by the main service's boot. Until that boot, this statement fails on the
// missing column, and the offset above must not fail with it.
const READINGS_KEPT = 3;
const READINGS_WINDOW_HOURS = 48;

const LATEST_READINGS_SQL = `
  WITH ranked AS (
    SELECT
      v.google_place_id,
      t.busyness_pct,
      t.observed_date,
      t.day_of_week,
      t.hour,
      t.collected_at,
      ROW_NUMBER() OVER (
        PARTITION BY v.google_place_id
        ORDER BY t.observed_date DESC, t.hour DESC, t.collected_at DESC
      ) AS recency
    FROM ml_training_data t
    JOIN ml_venues v ON v.id = t.venue_id
    JOIN ml_venue_baselines b
      ON b.google_place_id = v.google_place_id
     AND b.day_of_week = t.day_of_week
     AND b.hour = t.hour
    WHERE t.collection_mode = 'realtime'
      AND t.label_source = 'live'
      AND t.busyness_pct IS NOT NULL
      AND t.observed_date IS NOT NULL
      AND b.baseline > 0
      AND t.collected_at >= NOW() - make_interval(hours => $1::int)
  ),
  latest AS (
    SELECT
      google_place_id,
      jsonb_agg(
        jsonb_build_object(
          'v', busyness_pct,
          'd', to_char(observed_date, 'YYYY-MM-DD'),
          'dow', day_of_week,
          'h', hour,
          'at', collected_at
        ) ORDER BY recency
      ) AS readings
    FROM ranked
    WHERE recency <= $2::int
    GROUP BY google_place_id
  )
  UPDATE ml_venue_recent_deviation d
     SET recent_readings = l.readings
    FROM ml_venue_recent_deviation d0
    LEFT JOIN latest l ON l.google_place_id = d0.google_place_id
   WHERE d.google_place_id = d0.google_place_id
     AND d.recent_readings IS DISTINCT FROM l.readings
`;

async function storeLatestReadings({ windowHours = READINGS_WINDOW_HOURS, keep = READINGS_KEPT } = {}) {
  try {
    const res = await pool.query(LATEST_READINGS_SQL, [windowHours, keep]);
    return { updated: res.rowCount, error: null };
  } catch (err) {
    console.error('[ML:Deviation] Recent readings not stored (the offset was):', err.message);
    return { updated: null, error: err.message };
  }
}

async function buildRecentDeviation({ windowDays = WINDOW_DAYS, maxReadings = MAX_READINGS } = {}) {
  const written = await pool.query(UPSERT_SQL, [windowDays, maxReadings]);
  const readings = await storeLatestReadings();
  const pruned = await pool.query(PRUNE_SQL, [windowDays * 2]);
  return { written: written.rowCount, pruned: pruned.rowCount, readings };
}

async function main() {
  const t0 = Date.now();
  const { written, pruned, readings } = await buildRecentDeviation();

  const { rows } = await pool.query(`
    SELECT COUNT(*)::int                                    AS venues,
           COUNT(*) FILTER (WHERE n_readings >= 2)::int     AS usable,
           ROUND(AVG(offset_pct)::numeric, 2)               AS mean_offset,
           ROUND(MIN(offset_pct)::numeric, 1)               AS min_offset,
           ROUND(MAX(offset_pct)::numeric, 1)               AS max_offset
      FROM ml_venue_recent_deviation`);
  const s = rows[0] || {};

  console.log(`[ML:Deviation] ${written} venues written, ${pruned} stale rows pruned `
    + `in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`[ML:Deviation] ${s.venues} venues hold an offset, ${s.usable} of them with `
    + `at least two readings (the floor the serving path requires). `
    + `Offset mean ${s.mean_offset}, range ${s.min_offset} to ${s.max_offset}.`);
  console.log('[ML:Deviation] A venue with fewer than two readings is recorded but not '
    + 'served: one reading is an anecdote, not a level.');
  console.log(readings.error
    ? `[ML:Deviation] Recent readings for the nowcast were not stored: ${readings.error}`
    : `[ML:Deviation] Recent readings for the nowcast: ${readings.updated} venue rows changed.`);
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[ML:Deviation] FAILED:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = {
  buildRecentDeviation,
  storeLatestReadings,
  WINDOW_DAYS,
  MAX_READINGS,
  READINGS_KEPT,
  READINGS_WINDOW_HOURS,
};
