// ---------------------------------------------------------------------------
// Enrich ml_training_data with event features from ml_events
// Cross-references training rows with nearby events by day/hour/distance
// Run: node backend/scripts/ml/enrichWithEvents.js
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

const DISTANCE_THRESHOLD_KM = 2;
// ~0.018 degrees latitude ≈ 2km (rough filter before real distance calc)
const LAT_DELTA = 0.018;
const LNG_DELTA = 0.025; // slightly larger for longitude at typical latitudes

// Haversine distance in km
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Check if hour falls within event's active window
function isHourInRange(hour, startHour, endHour) {
  if (endHour >= startHour) {
    // Normal range: e.g. 19-22
    return hour >= startHour && hour <= endHour;
  }
  // Wraps midnight: e.g. 22-1
  return hour >= startHour || hour <= endHour;
}

async function main() {
  console.log('[Enrich] Loading events from ml_events...');
  const { rows: events } = await pool.query(
    `SELECT id, city, venue_lat, venue_lng, event_date, event_start_hour,
            event_end_hour, event_type, estimated_attendance
     FROM ml_events`
  );

  if (events.length === 0) {
    console.log('[Enrich] No events found in ml_events. Run collectEvents.js first.');
    await pool.end();
    return;
  }

  console.log(`[Enrich] Loaded ${events.length} events`);

  // Group events by city, then by day_of_week for fast lookup
  // day_of_week: 0=Sun, 1=Mon, ..., 6=Sat (JavaScript convention)
  const eventsByCityDow = {};
  for (const event of events) {
    const city = event.city;
    if (!eventsByCityDow[city]) {
      eventsByCityDow[city] = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    }
    const date = new Date(event.event_date);
    const dow = date.getUTCDay(); // 0=Sun
    eventsByCityDow[city][dow].push({
      lat: parseFloat(event.venue_lat),
      lng: parseFloat(event.venue_lng),
      startHour: event.event_start_hour,
      endHour: event.event_end_hour,
      type: event.event_type,
      attendance: event.estimated_attendance || 500,
    });
  }

  // Log event distribution
  for (const [city, dows] of Object.entries(eventsByCityDow)) {
    const total = Object.values(dows).reduce((s, arr) => s + arr.length, 0);
    console.log(`  ${city}: ${total} events`);
  }

  // Ensure new columns exist
  console.log('[Enrich] Adding columns if needed...');
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS has_nearby_event BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_distance_km DECIMAL(5,2)`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_attendance INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS total_nearby_events INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS total_nearby_attendance INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_type VARCHAR(50)`);

  // Process training data in chunks
  const { rows: countResult } = await pool.query('SELECT COUNT(*) as count FROM ml_training_data');
  const totalRows = parseInt(countResult[0].count, 10);
  console.log(`[Enrich] Processing ${totalRows} training rows...`);

  const CHUNK_SIZE = 1000;
  let processed = 0;
  let enriched = 0;
  let offset = 0;

  while (offset < totalRows) {
    // Fetch chunk with venue info
    const { rows: chunk } = await pool.query(
      `SELECT t.id, t.day_of_week, t.hour, v.city, v.latitude, v.longitude
       FROM ml_training_data t
       JOIN ml_venues v ON t.venue_id = v.id
       ORDER BY t.id
       LIMIT $1 OFFSET $2`,
      [CHUNK_SIZE, offset]
    );

    if (chunk.length === 0) break;

    // Process each row
    const updates = [];
    for (const row of chunk) {
      const cityEvents = eventsByCityDow[row.city];
      if (!cityEvents) {
        updates.push({ id: row.id, hasEvent: false });
        continue;
      }

      const dowEvents = cityEvents[row.day_of_week] || [];
      if (dowEvents.length === 0) {
        updates.push({ id: row.id, hasEvent: false });
        continue;
      }

      const vLat = parseFloat(row.latitude);
      const vLng = parseFloat(row.longitude);

      // Find nearby events matching hour
      let nearestDist = Infinity;
      let nearestEvent = null;
      let totalNearby = 0;
      let totalAttendance = 0;

      for (const event of dowEvents) {
        // Quick bounding box filter
        if (Math.abs(event.lat - vLat) > LAT_DELTA) continue;
        if (Math.abs(event.lng - vLng) > LNG_DELTA) continue;

        // Check hour overlap
        if (!isHourInRange(row.hour, event.startHour, event.endHour)) continue;

        // Real distance
        const dist = distanceKm(vLat, vLng, event.lat, event.lng);
        if (dist > DISTANCE_THRESHOLD_KM) continue;

        totalNearby++;
        totalAttendance += event.attendance;

        if (dist < nearestDist) {
          nearestDist = dist;
          nearestEvent = event;
        }
      }

      if (totalNearby > 0) {
        updates.push({
          id: row.id,
          hasEvent: true,
          nearestDist: Math.round(nearestDist * 100) / 100,
          nearestAttendance: nearestEvent.attendance,
          totalNearby,
          totalAttendance,
          nearestType: nearestEvent.type,
        });
        enriched++;
      } else {
        updates.push({ id: row.id, hasEvent: false });
      }
    }

    // Batch update
    for (const u of updates) {
      if (u.hasEvent) {
        await pool.query(
          `UPDATE ml_training_data SET
            has_nearby_event = true,
            nearest_event_distance_km = $1,
            nearest_event_attendance = $2,
            total_nearby_events = $3,
            total_nearby_attendance = $4,
            nearest_event_type = $5
           WHERE id = $6`,
          [u.nearestDist, u.nearestAttendance, u.totalNearby, u.totalAttendance, u.nearestType, u.id]
        );
      } else {
        await pool.query(
          `UPDATE ml_training_data SET
            has_nearby_event = false,
            nearest_event_distance_km = NULL,
            nearest_event_attendance = 0,
            total_nearby_events = 0,
            total_nearby_attendance = 0,
            nearest_event_type = NULL
           WHERE id = $1`,
          [u.id]
        );
      }
    }

    processed += chunk.length;
    offset += CHUNK_SIZE;

    if (processed % 10000 === 0 || processed === totalRows) {
      console.log(`  ${processed}/${totalRows} rows processed (${enriched} with events)`);
    }
  }

  // Summary
  const { rows: summary } = await pool.query(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN has_nearby_event = true THEN 1 ELSE 0 END) as with_events,
       AVG(CASE WHEN has_nearby_event = true THEN nearest_event_attendance END) as avg_attendance,
       AVG(CASE WHEN has_nearby_event = true THEN total_nearby_events END) as avg_nearby_count
     FROM ml_training_data`
  );

  console.log(`\n[Enrich] Done!`);
  console.log(`  Total rows: ${summary[0].total}`);
  console.log(`  Rows with nearby events: ${summary[0].with_events}`);
  console.log(`  Avg attendance (when event): ${Math.round(summary[0].avg_attendance || 0)}`);
  console.log(`  Avg nearby events (when event): ${parseFloat(summary[0].avg_nearby_count || 0).toFixed(1)}`);

  await pool.end();
}

main().catch(err => {
  console.error('[Enrich] Error:', err);
  process.exit(1);
});
