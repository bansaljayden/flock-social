// Quick data summary — run: node scripts/ml/checkData.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

if (process.env.PGHOST && !process.env.DATABASE_URL) {
  const h = process.env.PGHOST, p = process.env.PGPORT || 5432;
  const u = process.env.PGUSER || 'postgres', pw = process.env.PGPASSWORD || '';
  const d = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${u}:${pw}@${h}:${p}/${d}`;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const total = await pool.query('SELECT COUNT(*)::int as count FROM ml_training_data');
  const byMode = await pool.query('SELECT collection_mode, COUNT(*)::int as count FROM ml_training_data GROUP BY collection_mode');
  const venues = await pool.query('SELECT COUNT(*)::int as total, COUNT(besttime_venue_id)::int as with_bt FROM ml_venues WHERE is_active = true');
  const byCity = await pool.query(`
    SELECT mv.city, COUNT(DISTINCT mv.id)::int as venues,
      (SELECT COUNT(*)::int FROM ml_training_data td JOIN ml_venues v ON td.venue_id = v.id WHERE v.city = mv.city) as rows
    FROM ml_venues mv WHERE is_active = true GROUP BY mv.city ORDER BY venues DESC
  `);
  const recentRT = await pool.query("SELECT COUNT(*)::int as count FROM ml_training_data WHERE collection_mode = 'realtime' AND collected_at > NOW() - INTERVAL '24 hours'");
  const eventRows = await pool.query('SELECT COUNT(*)::int as count FROM ml_training_data WHERE event_nearby = true');
  const withWeather = await pool.query('SELECT COUNT(*)::int as count FROM ml_training_data WHERE temperature IS NOT NULL');

  console.log('=== ML Data Summary ===');
  console.log('Total training rows:', total.rows[0].count);
  console.log('By mode:', byMode.rows.map(r => `${r.collection_mode}: ${r.count}`).join(', '));
  console.log('Active venues:', venues.rows[0].total, '| With BestTime ID:', venues.rows[0].with_bt);
  console.log('Realtime rows (last 24h):', recentRT.rows[0].count);
  console.log('Rows with weather:', withWeather.rows[0].count);
  console.log('Rows with event data:', eventRows.rows[0].count);
  console.log('\n=== By City ===');
  for (const r of byCity.rows) {
    console.log(`  ${r.city.padEnd(15)} ${String(r.venues).padStart(4)} venues  ${String(r.rows).padStart(7)} rows`);
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
