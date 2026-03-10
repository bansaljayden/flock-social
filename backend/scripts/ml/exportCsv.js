// ---------------------------------------------------------------------------
// Exports ml_training_data to CSV for Python ML training
// Run: node scripts/ml/exportCsv.js [--mode=all|weekly|realtime] [--output=path]
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

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

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = 'all';
  let output = path.join(__dirname, 'training_data.csv');

  for (const arg of args) {
    if (arg.startsWith('--mode=')) mode = arg.split('=')[1];
    if (arg.startsWith('--output=')) output = arg.split('=')[1];
  }

  return { mode, output };
}

const COLUMNS = [
  'id', 'city', 'google_place_id', 'venue_name', 'collection_mode',
  'day_of_week', 'hour', 'month', 'season', 'is_holiday', 'is_school_break',
  'venue_category', 'price_level', 'rating', 'review_count',
  'temperature', 'humidity', 'wind_speed', 'weather_condition', 'weather_condition_code', 'is_raining',
  'busyness_pct', 'collected_at',
];

function escCsv(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function exportCsv(opts) {
  const { mode, output } = opts || parseArgs();

  const params = [];
  let whereClause = '';

  if (mode !== 'all') {
    params.push(mode);
    whereClause = 'WHERE t.collection_mode = $1';
  }

  const query = `
    SELECT
      t.id, v.city, v.google_place_id, v.name AS venue_name, t.collection_mode,
      t.day_of_week, t.hour, t.month, t.season, t.is_holiday, t.is_school_break,
      t.venue_category, t.price_level, t.rating, t.review_count,
      t.temperature, t.humidity, t.wind_speed, t.weather_condition, t.weather_condition_code, t.is_raining,
      t.busyness_pct, t.collected_at
    FROM ml_training_data t
    JOIN ml_venues v ON t.venue_id = v.id
    ${whereClause}
    ORDER BY t.collected_at, t.venue_id, t.day_of_week, t.hour
  `;

  const { rows } = await pool.query(query, params);

  const stream = fs.createWriteStream(output);
  stream.write(COLUMNS.join(',') + '\n');

  for (const row of rows) {
    const values = COLUMNS.map(col => escCsv(row[col] ?? row[col.replace('venue_name', 'venue_name')]));
    stream.write(values.join(',') + '\n');
  }

  stream.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  console.log(`[ML:Export] Exported ${rows.length} rows to ${output} (mode: ${mode})`);
  await pool.end();
}

async function run(opts) {
  await exportCsv(opts);
}

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Export] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
