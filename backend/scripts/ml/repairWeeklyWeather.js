// ---------------------------------------------------------------------------
// ONE-TIME REPAIR: clear the fabricated weather from typical-week rows.
// ---------------------------------------------------------------------------
// WHAT WENT WRONG. collectWeekly called getWeather(venue.lat, venue.lng) once
// per venue — current conditions, at one instant — and stamped temperature,
// humidity, wind_speed, weather_condition, weather_condition_code and
// is_raining from that single reading onto all 168 rows of the venue's typical
// week. All six are shipped model features, and weekly rows are 88.3% of
// ml_training_data (3,456,635 of 3,915,235 in the 2026-09-03 dump), so most of
// what the crowd model has ever seen under "temperature" is the temperature at
// the moment some collection batch happened to run.
//
// WHY IT IS WORSE THAN NOISE. Within a venue the column is CONSTANT across all
// 168 hours. So it cannot encode the hour, the day or the season — it encodes
// which batch wrote the venue, which is a straight line from a venue's identity
// to its collection time. That is the leakage shape ml_overfitting_fixes.md
// exists to keep out of the corpus.
//
// Concretely: venue 42042's entire week carries 79.5F / 83% / 'light rain' /
// is_raining TRUE from one 05:53 fetch on 2026-05-09, including a
// Sunday-midnight row asserting rain at 79.5F beside busyness 0.
//
// WHY NULLING IS ALLOWED. A row that says "Tuesdays at 8pm, in general" has no
// moment for weather to describe, so there is no true value being destroyed
// here. This removes an assertion nobody measured; it does not discard an
// observation. Realtime rows — actual readings at an actual time, where the
// weather columns are a real measurement — are explicitly out of scope and are
// never touched.
//
// Month and season are NOT cleared. A typical week collected in August really
// does describe August, so those two are honest context about the aggregate.
//
// BATCHED, because this is millions of rows on a database an hourly cron is
// also using. Each statement takes a bounded slice by primary key and commits
// on its own; the script can be stopped and restarted at any point and simply
// resumes, because the predicate only matches rows that still carry a value.
//
//   node scripts/ml/repairWeeklyWeather.js            (report only)
//   node scripts/ml/repairWeeklyWeather.js --commit   (write)
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

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
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

// `collection_mode = 'weekly'` is the whole safety argument: realtime rows
// carry a real reading taken at the time of a real observation and must keep
// it. Stated once, here, and reused by both statements below so the report and
// the write cannot disagree about what they are talking about.
const WEEKLY_WITH_WEATHER = `
  collection_mode = 'weekly'
    AND (temperature IS NOT NULL
      OR humidity IS NOT NULL
      OR wind_speed IS NOT NULL
      OR weather_condition IS NOT NULL
      OR weather_condition_code IS NOT NULL
      OR is_raining IS NOT NULL)`;

const BATCH = 50000;

async function main() {
  const commit = process.argv.includes('--commit');

  const { rows: before } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data WHERE ${WEEKLY_WITH_WEATHER}`
  );
  console.log(`[Repair] ${before[0].n} weekly rows carry a weather reading they cannot have.`);

  // Said out loud because it is the guard that makes this safe to run.
  const { rows: safe } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data
      WHERE collection_mode <> 'weekly' AND temperature IS NOT NULL`
  );
  console.log(`[Repair] ${safe[0].n} non-weekly rows carry weather and are OUT OF SCOPE.`);

  if (before[0].n === 0) {
    console.log('[Repair] Nothing to do.');
    return pool.end();
  }
  if (!commit) {
    console.log('[Repair] Report only. Re-run with --commit to clear those six columns.');
    return pool.end();
  }

  let total = 0;
  for (;;) {
    const res = await pool.query(`
      UPDATE ml_training_data
         SET temperature = NULL,
             humidity = NULL,
             wind_speed = NULL,
             weather_condition = NULL,
             weather_condition_code = NULL,
             is_raining = NULL
       WHERE id IN (
         SELECT id FROM ml_training_data
          WHERE ${WEEKLY_WITH_WEATHER}
          ORDER BY id
          LIMIT ${BATCH}
       )`);
    if (res.rowCount === 0) break;
    total += res.rowCount;
    console.log(`[Repair] ${total} rows cleared...`);
  }
  console.log(`[Repair] Done. ${total} rows cleared.`);

  const { rows: after } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data WHERE ${WEEKLY_WITH_WEATHER}`
  );
  console.log(`[Repair] Remaining: ${after[0].n} (expected 0).`);
  return pool.end();
}

main().catch((err) => {
  console.error('[Repair] Fatal:', err.message);
  pool.end();
  process.exitCode = 1;
});
