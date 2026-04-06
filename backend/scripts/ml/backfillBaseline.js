// ---------------------------------------------------------------------------
// Backfill baseline_busyness on ml_training_data
// Uses each venue's weekly forecast as the baseline for all rows
// Run: node scripts/ml/backfillBaseline.js
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
  ssl: { rejectUnauthorized: false },
});

async function backfill() {
  // Check current state
  const { rows: [counts] } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE baseline_busyness IS NOT NULL AND baseline_busyness > 0) AS has_baseline,
      COUNT(*) FILTER (WHERE baseline_busyness IS NULL OR baseline_busyness = 0) AS missing
    FROM ml_training_data
    WHERE busyness_pct IS NOT NULL
  `);
  console.log(`[Backfill] Total rows: ${counts.total}, has baseline: ${counts.has_baseline}, missing: ${counts.missing}`);

  if (parseInt(counts.missing) === 0) {
    console.log('[Backfill] Nothing to backfill!');
    await pool.end();
    return;
  }

  // Backfill baseline ONLY on realtime rows — weekly baseline comes from
  // the venue's weekly forecast for that day/hour (a different observation
  // than the live reading, so no label leakage)
  console.log('[Backfill] Computing baselines for realtime rows from weekly forecasts...');
  const { rowCount } = await pool.query(`
    UPDATE ml_training_data t
    SET baseline_busyness = w.avg_busyness
    FROM (
      SELECT venue_id, day_of_week, hour,
        ROUND(AVG(busyness_pct)) AS avg_busyness
      FROM ml_training_data
      WHERE collection_mode = 'weekly' AND busyness_pct IS NOT NULL
      GROUP BY venue_id, day_of_week, hour
    ) w
    WHERE t.venue_id = w.venue_id
      AND t.day_of_week = w.day_of_week
      AND t.hour = w.hour
      AND t.collection_mode = 'realtime'
      AND (t.baseline_busyness IS NULL OR t.baseline_busyness = 0)
  `);
  console.log(`[Backfill] Updated ${rowCount} rows`);

  // Check final state
  const { rows: [after] } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE baseline_busyness IS NOT NULL AND baseline_busyness > 0) AS has_baseline,
      COUNT(*) FILTER (WHERE baseline_busyness IS NULL OR baseline_busyness = 0) AS still_missing
    FROM ml_training_data
    WHERE busyness_pct IS NOT NULL
  `);
  console.log(`[Backfill] After: ${after.has_baseline}/${after.total} rows have baseline (${after.still_missing} still missing)`);

  await pool.end();
}

backfill().catch(err => {
  console.error('[Backfill] Error:', err);
  process.exit(1);
});
