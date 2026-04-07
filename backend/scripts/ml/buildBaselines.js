// ---------------------------------------------------------------------------
// Build venue baselines from collected weekly data
// Populates ml_venue_baselines table — 168 rows per venue (7 days x 24 hours)
// Run: node scripts/ml/buildBaselines.js
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

async function build() {
  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ml_venue_baselines (
      google_place_id VARCHAR(255) NOT NULL,
      day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
      baseline SMALLINT NOT NULL DEFAULT 0,
      source VARCHAR(20) NOT NULL DEFAULT 'collected',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (google_place_id, day_of_week, hour)
    );
  `);

  // Build baselines from weekly forecast data
  console.log('[Baselines] Computing from weekly collection data...');
  const { rowCount } = await pool.query(`
    INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source, updated_at)
    SELECT
      v.google_place_id,
      t.day_of_week,
      t.hour,
      ROUND(AVG(t.busyness_pct))::smallint,
      'collected',
      NOW()
    FROM ml_training_data t
    JOIN ml_venues v ON t.venue_id = v.id
    WHERE t.collection_mode = 'weekly' AND t.busyness_pct IS NOT NULL
    GROUP BY v.google_place_id, t.day_of_week, t.hour
    ON CONFLICT (google_place_id, day_of_week, hour)
    DO UPDATE SET
      baseline = EXCLUDED.baseline,
      updated_at = NOW()
  `);

  console.log(`[Baselines] Upserted ${rowCount} baseline slots`);

  // Stats
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(DISTINCT google_place_id) AS venues, COUNT(*) AS slots
    FROM ml_venue_baselines
  `);
  console.log(`[Baselines] ${stats.venues} venues, ${stats.slots} total slots`);

  await pool.end();
}

build().catch(err => {
  console.error('[Baselines] Error:', err);
  process.exit(1);
});
