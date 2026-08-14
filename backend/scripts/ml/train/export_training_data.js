// ---------------------------------------------------------------------------
// Export ML training data from PostgreSQL to CSV for Python training pipeline
// Splits into training set (10 cities) and holdout set (Miami, Tokyo, Barcelona)
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const HOLDOUT_CITIES = ['miami', 'tokyo', 'barcelona'];

const { CITIES } = require('../config');

// Local calendar date at the venue when the row was observed. Realtime rows
// only — weekly rows are a synthetic "typical week", their insert time is
// meaningless as an observation date.
const dateFmtCache = {};
function observedDate(row) {
  if (row.collection_mode !== 'realtime' || !row.collected_at) return '';
  const tz = CITIES[row.city]?.tz;
  if (!tz) return '';
  if (!dateFmtCache[tz]) {
    dateFmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
  }
  return dateFmtCache[tz].format(new Date(row.collected_at)); // YYYY-MM-DD
}

function cityQuery(city) {
  return {
    text: `
      SELECT
        -- Round 10: venue_id is what prepare_features.add_baseline_features
        -- keys its neighbouring-hour baseline smoothing on. Without it the
        -- smoothing block was silently skipped (it is guarded by
        -- "if 'venue_id' in df.columns"), so the model learned deltas against
        -- RAW baselines while mlPredictor.getBaseline serves a smoothed one
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
        -- baseline_busyness: same DEFINITION production serves at inference
        -- time (per-venue/dow/hour average of collected busyness — what
        -- collectRealtime's refresh writes into ml_venue_baselines), but
        -- computed LEAVE-ONE-OUT (round 13). The table's stored average
        -- includes every row's own busyness_pct, so joining it directly meant
        -- each row's delta label (busyness - baseline) was computed against a
        -- baseline that partially CONTAINED that label: deltas systematically
        -- shrunk toward zero in training, and holdout rows' baselines carried
        -- their own answers — the self-inclusion flavor of the popular_times
        -- leak the overfitting doctrine bans. Production can never include
        -- the moment being predicted in its baseline; training now can't
        -- either. Slots with a single observation get baseline 0 (honest "no
        -- prior"), which the baseline>0 training filter then excludes.
        COALESCE(
          CASE WHEN b.bl_n > 1
               THEN ROUND((b.bl_sum - t.busyness_pct) / (b.bl_n - 1))
               ELSE 0 END,
        0) AS baseline_busyness,
        t.collection_mode,
        -- Round 10: collection_mode='realtime' only says WHEN the row was
        -- taken, not whether the number is an observation. collectRealtime.js
        -- falls back to BestTime's own forecast when live data is unavailable,
        -- and those rows used to be exported as is_realtime=1 and weighted 1.0
        -- in training — a vendor's prediction carrying more confidence than
        -- anything else in the corpus. label_source records the truth.
        t.label_source,
        t.collected_at,
        t.busyness_pct,
        v.city, v.google_types, v.latitude, v.longitude,
        -- User feedback aggregates per venue
        COALESCE(fb.avg_user_crowd, 0) AS avg_user_crowd,
        COALESCE(fb.user_feedback_count, 0) AS user_feedback_count,
        COALESCE(fb.avg_prediction_error, 0) AS avg_prediction_error
      FROM ml_training_data t
      JOIN ml_venues v ON t.venue_id = v.id
      LEFT JOIN (
        -- Recomputed from ml_training_data rather than read from
        -- ml_venue_baselines: identical definition to the refresh in
        -- collectRealtime.run() (AVG of collected busyness per place/dow/hour)
        -- but carrying SUM and COUNT so the outer query can subtract each
        -- row's own contribution. Also immune to a stale table when export
        -- runs before the post-collection refresh.
        SELECT v2.google_place_id, t2.day_of_week, t2.hour,
               SUM(t2.busyness_pct)::float AS bl_sum, COUNT(*)::int AS bl_n
        FROM ml_training_data t2
        JOIN ml_venues v2 ON t2.venue_id = v2.id
        WHERE t2.busyness_pct IS NOT NULL AND v2.city = $1
        GROUP BY v2.google_place_id, t2.day_of_week, t2.hour
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
      ORDER BY t.venue_id, t.day_of_week, t.hour
    `,
    values: [city],
  };
}

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
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
  ].map(escapeCsv).join(',');
}

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
].join(',');

async function main() {
  // Round 10: label_source is written by collectRealtime.js. Export can run
  // against a DB where that script hasn't run since the column was added, and
  // a missing column is a hard SQL error — so make sure it exists first.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS label_source VARCHAR(10)`);

  // Get list of cities that have training data
  console.log('[Export] Finding cities with data...');
  const { rows: cityRows } = await pool.query(
    `SELECT DISTINCT v.city FROM ml_training_data t JOIN ml_venues v ON t.venue_id = v.id WHERE t.busyness_pct IS NOT NULL ORDER BY v.city`
  );
  const cities = cityRows.map(r => r.city);
  console.log(`[Export] Found ${cities.length} cities: ${cities.join(', ')}`);

  const trainPath = path.join(__dirname, 'training_data.csv');
  const holdoutPath = path.join(__dirname, 'holdout_data.csv');

  const trainStream = fs.createWriteStream(trainPath);
  const holdoutStream = fs.createWriteStream(holdoutPath);
  trainStream.write(HEADER + '\n');
  holdoutStream.write(HEADER + '\n');

  let trainCount = 0;
  let holdoutCount = 0;
  const cityCounts = {};

  // Export city by city to avoid DB temp file overflow
  for (const city of cities) {
    console.log(`[Export] Exporting ${city}...`);
    const { rows } = await pool.query(cityQuery(city));
    cityCounts[city] = rows.length;

    const isHoldout = HOLDOUT_CITIES.includes(city);
    const stream = isHoldout ? holdoutStream : trainStream;

    for (const row of rows) {
      stream.write(rowToCsv(row) + '\n');
    }

    if (isHoldout) holdoutCount += rows.length;
    else trainCount += rows.length;

    console.log(`  ${rows.length} rows ${isHoldout ? '(holdout)' : '(train)'}`);
  }

  trainStream.end();
  holdoutStream.end();

  console.log(`\n[Export] Training set: ${trainCount} rows → ${trainPath}`);
  console.log(`[Export] Holdout set: ${holdoutCount} rows → ${holdoutPath}`);
  console.log(`[Export] Holdout cities: ${HOLDOUT_CITIES.join(', ')}`);

  console.log('\n[Export] City breakdown:');
  for (const [city, count] of Object.entries(cityCounts).sort((a, b) => b[1] - a[1])) {
    const set = HOLDOUT_CITIES.includes(city) ? '(holdout)' : '(train)';
    console.log(`  ${city.padEnd(16)} ${String(count).padStart(8)} rows  ${set}`);
  }

  await pool.end();
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Export] Error:', err);
    process.exit(1);
  });
}

// cityQuery exported so the leave-one-out baseline SQL can be exercised
// against a real Postgres (scripts/e2e or ad-hoc verification) without
// running a full export.
module.exports = { cityQuery, rowToCsv, HEADER, labelProvenance, observedDate };
