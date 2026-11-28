// ---------------------------------------------------------------------------
// Exports ml_training_data to CSV for Python ML training
// Run: node scripts/ml/exportCsv.js [--mode=all|weekly|realtime] [--output=path]
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const labelQuarantine = require('../../services/labelQuarantine');

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

// THE LABEL QUARANTINE (services/labelQuarantine.json, 2026-11-27). A realtime
// row labelled live and dated inside a window is a value the provider made
// from its own forecast; this CSV carries neither label_source nor
// observed_date, so nothing downstream could tell it apart, and it is left out
// here, in the query, and counted. train/export_training_data.js is the export
// the retrain reads; this older one follows the same rule.
function quarantinedRowSql(fromParam, throughParam) {
  return `COALESCE(t.collection_mode = 'realtime' AND t.label_source = 'live'
      AND EXISTS (SELECT 1 FROM unnest(${fromParam}::date[], ${throughParam}::date[]) AS q(from_date, through_date)
                   WHERE t.observed_date BETWEEN q.from_date AND q.through_date), false)`;
}

function buildExportQuery(mode) {
  const params = [];
  const conds = [];
  if (mode !== 'all') {
    params.push(mode);
    conds.push(`t.collection_mode = $${params.length}`);
  }
  params.push(labelQuarantine.WINDOWS.map((w) => w.fromDate));
  const from = `$${params.length}`;
  params.push(labelQuarantine.WINDOWS.map((w) => w.throughDate));
  const through = `$${params.length}`;
  conds.push(`NOT ${quarantinedRowSql(from, through)}`);
  const text = `
    SELECT
      t.id, v.city, v.google_place_id, v.name AS venue_name, t.collection_mode,
      t.day_of_week, t.hour, t.month, t.season, t.is_holiday, t.is_school_break,
      t.venue_category, t.price_level, t.rating, t.review_count,
      t.temperature, t.humidity, t.wind_speed, t.weather_condition, t.weather_condition_code, t.is_raining,
      t.busyness_pct, t.collected_at
    FROM ml_training_data t
    JOIN ml_venues v ON t.venue_id = v.id
    WHERE ${conds.join(' AND ')}
    ORDER BY t.collected_at, t.venue_id, t.day_of_week, t.hour
  `;
  const countText = `SELECT COUNT(*)::int AS n FROM ml_training_data t WHERE ${quarantinedRowSql('$1', '$2')}`;
  const countParams = [labelQuarantine.WINDOWS.map((w) => w.fromDate), labelQuarantine.WINDOWS.map((w) => w.throughDate)];
  return { text, params, countText, countParams };
}

async function exportCsv(opts) {
  const { mode, output } = opts || parseArgs();

  const q = buildExportQuery(mode);
  const { rows } = await pool.query(q.text, q.params);
  const { rows: [left] } = await pool.query(q.countText, q.countParams);
  console.log(`[ML:Export] Left out ${left ? left.n : 0} live rows inside a quarantined window (services/labelQuarantine.json).`);

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

module.exports = { run, buildExportQuery };

if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Export] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
