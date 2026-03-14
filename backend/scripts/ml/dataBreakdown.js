const pool = require('../../config/database');

(async () => {
  const res = await pool.query(`
    SELECT v.city, COUNT(DISTINCT v.id) as venues, COUNT(d.id) as training_rows
    FROM ml_venues v
    LEFT JOIN ml_training_data d ON d.venue_id = v.id
    WHERE d.id IS NOT NULL
    GROUP BY v.city
    ORDER BY training_rows DESC
  `);

  console.log('City            | Venues | Training Rows');
  console.log('----------------|--------|-------------');
  let totalV = 0, totalR = 0;
  for (const r of res.rows) {
    const city = r.city.padEnd(16);
    const venues = String(r.venues).padStart(6);
    const rows = String(r.training_rows).padStart(13);
    totalV += parseInt(r.venues);
    totalR += parseInt(r.training_rows);
    console.log(`${city}|${venues} |${rows}`);
  }
  console.log('----------------|--------|-------------');
  console.log(`TOTAL           |${String(totalV).padStart(6)} |${String(totalR).padStart(13)}`);
  pool.end();
})();
