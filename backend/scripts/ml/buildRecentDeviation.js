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
//
// RANKED ON THE PLACE ID, AS BEFORE 11 NOVEMBER, UNTIL PRODUCTION SAYS
// OTHERWISE. On 2026-11-11 (575cc04d) all three statements in this file were
// changed to rank and group on ml_training_data's integer venue_id; a synthetic
// local corpus of production's size put the three at about 12 seconds against
// 19. In production that text took 114 to 168 seconds an hour against the old
// text's 64 to 92 at the same hours the day before, so it was put back
// (157e2947). The comparison was across days, and it did not hold: the old
// text's first run back, 05:00 UTC on 12 November, took 123 seconds, as long
// as the new one at that hour. Something else slowed the rebuild on 11
// November, and which text is faster in production is not known. The daily
// plan below is what will say, and neither the bench nor a comparison across
// days is evidence about it. The per-statement seconds that commit added stay.
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

// THE JOB'S OWN TIME LIMIT. `pool` is config/database.js's, and its cap of
// 15 seconds on every statement is the API's: right for a request, wrong for
// these three aggregates over 28 days of live readings. The hourly collector
// runs this file on that pool, and once its widened sweep began writing about
// 2,400 live rows an hour (2026-10-27), the offset statement ran past the cap:
// from 18:00 UTC that day it was cancelled in 22 of 52 runs ("canceling
// statement due to statement timeout", 57014), and the offsets waited for a
// run that got through. The collector's own pool has no cap, which is why its
// three-minute baseline refresh just before this never failed. Each statement
// here runs in its own transaction with SET LOCAL, so it gets two minutes and
// the connection goes back to the pool with the API's 15 seconds unchanged.
const JOB_STATEMENT_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// HOW PRODUCTION RUNS THESE, ONCE A DAY (2026-11-12).
//
// Production's plans cannot be read from here, and guessing at them went
// wrong. On 2026-11-11 a rewrite that a local bench put a third faster was
// judged slower in production by comparing it with the night before; the old
// text, put back the next night, took as long as the new one had at the same
// hours (123 seconds at 05:00 UTC against 64 to 76 the night before), so the
// slowdown came from somewhere else. So once a day the collector runs the three
// statements under EXPLAIN (ANALYZE, BUFFERS): the same statements, with the
// same writes, in the same transactions under the same cap, in place of that
// hour's ordinary run, and logs where each one's time went and how much it read
// from disk, from the cache and from temporary files. 07:00 UTC is one of the
// quicker hours (the slowest statement took 55 to 60 seconds at 04:00 and 05:00
// UTC on 12 November), which leaves room under the cap for the timing EXPLAIN
// adds. The rebuild starts near the end of the hour before (about :59), so the
// hour is read half an hour ahead.
const PLAN_HOUR_UTC = 7;

function planDue(now = new Date()) {
  return new Date(now.getTime() + 30 * 60000).getUTCHours() === PLAN_HOUR_UTC;
}

// The statement's own row count, read from its plan: EXPLAIN returns the plan
// in place of the count. An INSERT ... ON CONFLICT DO UPDATE counts the rows it
// inserted and the ones it updated (every conflict is updated here, there is no
// WHERE on the update); an UPDATE counts the rows its input hands it.
function rowCountOfPlan(top) {
  const root = top.Plan;
  if (root['Tuples Inserted'] !== undefined) return root['Tuples Inserted'] + (root['Conflicting Tuples'] || 0);
  const input = (root.Plans || [])[0];
  return input ? Math.round(input['Actual Rows'] * (input['Actual Loops'] || 1)) : 0;
}

const MB = (blocks) => Math.round(((blocks || 0) * 8192) / 1e6);

// One line: the statement's time, what it read, and its slowest steps. A step's
// time is its own (its children's taken off), and with parallel workers it is
// summed over them, so the shares are of all the steps' time together.
function describePlan(top) {
  const steps = [];
  (function walk(node) {
    const loops = node['Actual Loops'] || 1;
    const kids = node.Plans || [];
    const below = kids.reduce((s, k) => s + (k['Actual Total Time'] || 0) * (k['Actual Loops'] || 1), 0);
    steps.push({ node, ms: Math.max(0, (node['Actual Total Time'] || 0) * loops - below), rows: Math.round((node['Actual Rows'] || 0) * loops) });
    kids.forEach(walk);
  })(top.Plan);
  const all = steps.reduce((s, x) => s + x.ms, 0) || 1;
  const name = ({ node: n }) => n['Node Type']
    + (n['Index Name'] ? ` using ${n['Index Name']}` : '')
    + (n['Relation Name'] ? ` on ${n['Relation Name']}` : '')
    + (n['Sort Space Type'] === 'Disk' ? `, spilled ${Math.round((n['Sort Space Used'] || 0) / 1000)} MB` : '');
  const slowest = steps.filter((x) => x.ms / all >= 0.05).sort((a, b) => b.ms - a.ms).slice(0, 4)
    .map((x) => `${name(x)} ${(x.ms / 1000).toFixed(1)}s (${Math.round((100 * x.ms) / all)}%, ${x.rows.toLocaleString('en-US')} rows)`);
  const r = top.Plan;
  return `${((top['Execution Time'] || 0) / 1000).toFixed(1)}s; from disk ${MB(r['Shared Read Blocks'])} MB, `
    + `from cache ${MB(r['Shared Hit Blocks'])} MB, temp files ${MB(r['Temp Written Blocks'])} MB; `
    + `slowest steps: ${slowest.join('; ') || 'none over 5%'}`;
}

async function jobQuery(sql, params, { plan = false } = {}) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${JOB_STATEMENT_TIMEOUT_MS}`);
    const res = await client.query(plan ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}` : sql, params);
    await client.query('COMMIT');
    if (!plan) return res;
    const doc = res.rows[0]['QUERY PLAN'];
    const top = (typeof doc === 'string' ? JSON.parse(doc) : doc)[0];
    return { rowCount: rowCountOfPlan(top), plan: describePlan(top) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { broken = true; });
    throw err;
  } finally {
    // A connection whose ROLLBACK failed is not one to hand back to the pool.
    client.release(broken || undefined);
  }
}

async function storeLatestReadings({ windowHours = READINGS_WINDOW_HOURS, keep = READINGS_KEPT, plan = false } = {}) {
  try {
    const res = await jobQuery(LATEST_READINGS_SQL, [windowHours, keep], { plan });
    return { updated: res.rowCount, error: null, plan: res.plan || null };
  } catch (err) {
    console.error('[ML:Deviation] Recent readings not stored (the offset was):', err.message);
    return { updated: null, error: err.message, plan: null };
  }
}

// ---------------------------------------------------------------------------
// THE OFFSET'S OWN READINGS, FOR A SWITCHED NUMBER (migration 093).
//
// offset_pct above is a median as of this run, and this runs right after each
// hourly sweep, so a card for hour H served after H's sweep reads a median
// that includes H's own reading, the reading the number is scored against.
// services/mlPredictor.js, with CROWD_SERVE_MODE=curve_offset or
// CROWD_NOWCAST_ENABLED=true, recomputes the offset strictly before the hour
// it scores (trailingOffsetBefore) from this list instead. With both switches
// off the column is never read and offset_pct is served as before.
//
// The same population as the offset (live, a busyness, a positive curve at
// the reading's own slot, inside WINDOW_DAYS), each reading's deviation and
// venue-local slot, newest slot first, MAX_READINGS + OFFSET_READINGS_SLACK of
// them: the slack is what lets the target hour's own reading be dropped with
// MAX_READINGS still left. OFFSET_READINGS_SLACK equals mlPredictor's
// (__tests__/mlServeModes.test.js pins the two). A row whose venue has no
// dated reading in the window is set back to NULL.
//
// Its own statement inside its own try, like the recent readings, because this
// file deploys with the collector before the main service's boot applies 093.
const OFFSET_READINGS_SLACK = 4;

const OFFSET_READINGS_SQL = `
  WITH ranked AS (
    SELECT
      v.google_place_id,
      t.busyness_pct - b.baseline AS deviation,
      t.observed_date,
      t.hour,
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
      AND t.collected_at >= NOW() - ($1 || ' days')::interval
  ),
  latest AS (
    SELECT
      google_place_id,
      jsonb_agg(
        jsonb_build_object(
          'dev', deviation,
          'd', to_char(observed_date, 'YYYY-MM-DD'),
          'h', hour
        ) ORDER BY recency
      ) AS readings
    FROM ranked
    WHERE recency <= $2::int
    GROUP BY google_place_id
  )
  UPDATE ml_venue_recent_deviation d
     SET offset_readings = l.readings
    FROM ml_venue_recent_deviation d0
    LEFT JOIN latest l ON l.google_place_id = d0.google_place_id
   WHERE d.google_place_id = d0.google_place_id
     AND d.offset_readings IS DISTINCT FROM l.readings
`;

async function storeOffsetReadings({ windowDays = WINDOW_DAYS, keep = MAX_READINGS + OFFSET_READINGS_SLACK, plan = false } = {}) {
  try {
    const res = await jobQuery(OFFSET_READINGS_SQL, [windowDays, keep], { plan });
    return { updated: res.rowCount, error: null, plan: res.plan || null };
  } catch (err) {
    console.error('[ML:Deviation] Offset readings not stored (the offset was):', err.message);
    return { updated: null, error: err.message, plan: null };
  }
}

// WHERE THE SECONDS WENT. JOB_STATEMENT_TIMEOUT_MS is a cap on each statement,
// not on the run, so the number that says how close this is to being cancelled
// is the slowest statement's and the run's total hides it. statementSeconds
// carries each of the three, and the collector's hourly line prints them.
// With `plan` (the collector passes planDue()), the three run under EXPLAIN
// and `plans` carries each one's line; otherwise `plans` is null.
async function buildRecentDeviation({ windowDays = WINDOW_DAYS, maxReadings = MAX_READINGS, plan = false } = {}) {
  const t0 = Date.now();
  const written = await jobQuery(UPSERT_SQL, [windowDays, maxReadings], { plan });
  const t1 = Date.now();
  const readings = await storeLatestReadings({ plan });
  const t2 = Date.now();
  const offsetReadings = await storeOffsetReadings({ windowDays, keep: maxReadings + OFFSET_READINGS_SLACK, plan });
  const t3 = Date.now();
  const pruned = await pool.query(PRUNE_SQL, [windowDays * 2]);
  return {
    written: written.rowCount,
    pruned: pruned.rowCount,
    readings,
    offsetReadings,
    seconds: (Date.now() - t0) / 1000,
    statementSeconds: {
      offset: (t1 - t0) / 1000,
      recentReadings: (t2 - t1) / 1000,
      offsetReadings: (t3 - t2) / 1000,
    },
    plans: plan
      ? { offsets: written.plan, 'recent readings': readings.plan, 'offset readings': offsetReadings.plan }
      : null,
  };
}

// The three statement times as the collector's line and main() print them.
function describeStatementSeconds({ offset, recentReadings, offsetReadings }) {
  return `offsets ${offset.toFixed(1)}s, recent readings ${recentReadings.toFixed(1)}s, `
    + `offset readings ${offsetReadings.toFixed(1)}s`;
}

async function main() {
  const t0 = Date.now();
  const { written, pruned, readings, offsetReadings, statementSeconds } = await buildRecentDeviation();

  const { rows } = await pool.query(`
    SELECT COUNT(*)::int                                    AS venues,
           COUNT(*) FILTER (WHERE n_readings >= 2)::int     AS usable,
           ROUND(AVG(offset_pct)::numeric, 2)               AS mean_offset,
           ROUND(MIN(offset_pct)::numeric, 1)               AS min_offset,
           ROUND(MAX(offset_pct)::numeric, 1)               AS max_offset
      FROM ml_venue_recent_deviation`);
  const s = rows[0] || {};

  console.log(`[ML:Deviation] ${written} venues written, ${pruned} stale rows pruned `
    + `in ${((Date.now() - t0) / 1000).toFixed(1)}s (${describeStatementSeconds(statementSeconds)}).`);
  console.log(`[ML:Deviation] ${s.venues} venues hold an offset, ${s.usable} of them with `
    + `at least two readings (the floor the serving path requires). `
    + `Offset mean ${s.mean_offset}, range ${s.min_offset} to ${s.max_offset}.`);
  console.log('[ML:Deviation] A venue with fewer than two readings is recorded but not '
    + 'served: one reading is an anecdote, not a level.');
  console.log(readings.error
    ? `[ML:Deviation] Recent readings for the nowcast were not stored: ${readings.error}`
    : `[ML:Deviation] Recent readings for the nowcast: ${readings.updated} venue rows changed.`);
  console.log(offsetReadings.error
    ? `[ML:Deviation] Offset readings for the switched offset were not stored: ${offsetReadings.error}`
    : `[ML:Deviation] Offset readings for the switched offset: ${offsetReadings.updated} venue rows changed.`);
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
  storeOffsetReadings,
  describeStatementSeconds,
  planDue,
  describePlan,
  rowCountOfPlan,
  PLAN_HOUR_UTC,
  WINDOW_DAYS,
  MAX_READINGS,
  READINGS_KEPT,
  READINGS_WINDOW_HOURS,
  OFFSET_READINGS_SLACK,
  JOB_STATEMENT_TIMEOUT_MS,
};
