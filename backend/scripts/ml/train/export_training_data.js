// ---------------------------------------------------------------------------
// Export ML training data from PostgreSQL to CSV for Python training pipeline
// Splits into training set (10 cities) and holdout set (Miami, Tokyo, Barcelona)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const pool = require('../../../config/database');

const HOLDOUT_CITIES = ['miami', 'tokyo', 'barcelona'];

function cityQuery(city) {
  return {
    text: `
      SELECT
        t.day_of_week, t.hour, t.month, t.season,
        t.is_holiday, t.is_school_break,
        t.venue_category, t.price_level, t.rating, t.review_count,
        t.temperature, t.humidity, t.wind_speed,
        t.weather_condition, t.weather_condition_code, t.is_raining,
        t.event_nearby, t.event_distance_km, t.event_size, t.event_type, t.event_hours_until,
        t.busyness_pct,
        v.city, v.google_types, v.latitude, v.longitude
      FROM ml_training_data t
      JOIN ml_venues v ON t.venue_id = v.id
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

function rowToCsv(row) {
  const types = row.google_types || [];
  return [
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
    row.busyness_pct,
    row.city,
    types[0] || '',
    types[1] || '',
    types[2] || '',
    row.latitude,
    row.longitude,
  ].map(escapeCsv).join(',');
}

const HEADER = [
  'day_of_week', 'hour', 'month', 'season',
  'is_holiday', 'is_school_break',
  'venue_category', 'price_level', 'rating', 'review_count',
  'temperature', 'humidity', 'wind_speed',
  'weather_condition', 'weather_condition_code', 'is_raining',
  'event_nearby', 'event_distance_km', 'event_size', 'event_type', 'event_hours_until',
  'busyness_pct',
  'city',
  'google_type_1', 'google_type_2', 'google_type_3',
  'latitude', 'longitude',
].join(',');

async function main() {
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

main().catch(err => {
  console.error('[Export] Error:', err);
  process.exit(1);
});
