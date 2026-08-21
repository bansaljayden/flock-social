// ---------------------------------------------------------------------------
// Enrich ml_training_data with event features from ml_events
// Cross-references training rows with nearby events by day/hour/distance
// Run: node backend/scripts/ml/enrichWithEvents.js
//
// AN UNCHECKED STREET IS NOT AN EMPTY ONE (2026-08-20, migration 045).
//
// Until this change every branch below that did not find an event wrote the
// same six values: has_nearby_event = false, nearest_event_distance_km = NULL,
// nearest_event_attendance = 0, total_nearby_events = 0,
// total_nearby_attendance = 0, nearest_event_type = NULL. Those are exactly the
// column defaults 006 created, so "the matcher looked and the street was quiet"
// was byte-identical to "the matcher never touched this row" AND to "ml_events
// holds no events for this city at all, so there was nothing to match against".
//
// The third one is the leak. Events are indexed by city and date; a city whose
// events were never collected falls through `dowEvents.length === 0` and every
// row in it is stamped a negative observation. Measured against production on
// 2026-08-20: 22 of 34 cities hold ZERO rows with has_nearby_event = true,
// 2,194,300 rows, 56.1% of the corpus. Philadelphia holds 144,665 of them and
// not one nearby event, which is a statement about Ticketmaster collection
// wearing the clothes of a statement about Philadelphia.
//
// So every write below now also records WHETHER THE LOOKUP COULD HAVE FOUND
// ANYTHING. events_observed = true means the row was matched against a
// non-empty index for its own city and its own date, and the values beside it
// are a measurement including the quiet night. events_observed = false means no
// match was possible and events_unavailable_reason says which of the three it
// was; the event columns are written NULL rather than a fabricated 0, so the
// export can carry them as empty and prepare_features.py's fillna(0) does the
// imputing where the imputation is visible.
//
// THIS FIXES THE FUTURE ONLY. The 3.9M rows already in the table are not
// retrospectively separable, because an observed false and an invented false left
// the same bytes behind, and this script does not pretend otherwise. Running it
// again re-derives provenance for every row it can join to ml_venues, but it
// cannot tell you what the PREVIOUS run saw, and nothing ever will. See
// migration 045 and scripts/ml/MODEL-METRICS.md.
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { CITIES } = require('./config');

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

// Round 10: the local calendar date a training row was observed on. Same rule
// as train/export_training_data.js — realtime rows only. Weekly rows are a
// synthetic "typical week" with no observation date, so no specific one-off
// event can be attributed to them.
const dateFmtCache = {};
function observedDateOf(row) {
  if (row.observed_date) return row.observed_date; // already YYYY-MM-DD (to_char)
  if (row.collection_mode !== 'realtime' || !row.collected_at) return null;
  const tz = CITIES[row.city]?.tz;
  if (!tz) return null;
  if (!dateFmtCache[tz]) {
    dateFmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
  }
  return dateFmtCache[tz].format(new Date(row.collected_at));
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
    // to_char keeps the calendar date exactly as stored — reading a DATE back
    // through JS Date and calling getUTCDay()/getDate() shifts it by the
    // process timezone.
    `SELECT id, city, venue_lat, venue_lng,
            to_char(event_date, 'YYYY-MM-DD') AS event_date,
            event_start_hour, event_end_hour, event_type, estimated_attendance
     FROM ml_events`
  );

  if (events.length === 0) {
    console.log('[Enrich] No events found in ml_events. Run collectEvents.js first.');
    await pool.end();
    return;
  }

  console.log(`[Enrich] Loaded ${events.length} events`);

  // Round 10: events are indexed by city + ACTUAL DATE, not city + weekday.
  // The old weekday index applied a single Saturday concert to every Saturday
  // row in that city — training then learned "this venue is always busy on
  // Saturdays because of an event" from one night. Rows are now joined on the
  // date they were actually observed.
  const eventsByCityDate = new Map();
  for (const event of events) {
    if (!event.event_date) continue;
    const key = `${event.city}|${event.event_date}`;
    if (!eventsByCityDate.has(key)) eventsByCityDate.set(key, []);
    eventsByCityDate.get(key).push({
      lat: parseFloat(event.venue_lat),
      lng: parseFloat(event.venue_lng),
      startHour: event.event_start_hour,
      endHour: event.event_end_hour,
      type: event.event_type,
      attendance: event.estimated_attendance || 500,
    });
  }

  // Log event distribution
  const perCity = {};
  for (const [key, list] of eventsByCityDate) {
    const city = key.split('|')[0];
    perCity[city] = (perCity[city] || 0) + list.length;
  }
  for (const [city, total] of Object.entries(perCity)) {
    console.log(`  ${city}: ${total} events`);
  }

  // The cities this run can say anything about at all. A city absent from here
  // has no events in ml_events, so every false it would have produced is a
  // statement about collection coverage, not about the city, which is the exact
  // confusion that put 22 cities and 56.1% of the corpus into the fabricated
  // negatives. Named, counted and reported instead of silently written.
  const citiesWithEvents = new Set(Object.keys(perCity));
  const configuredCities = Object.keys(CITIES);
  const uncoveredCities = configuredCities.filter((c) => !citiesWithEvents.has(c));
  if (uncoveredCities.length > 0) {
    console.log(`[Enrich] ${uncoveredCities.length} of ${configuredCities.length} configured cities have NO events `
      + `in ml_events: ${uncoveredCities.join(', ')}`);
    console.log('[Enrich] Their rows get events_observed = false / no_events_for_city. They are NOT '
      + 'evidence that nothing was happening near those venues.');
  }

  // Ensure new columns exist
  console.log('[Enrich] Adding columns if needed...');
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS has_nearby_event BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_distance_km DECIMAL(5,2)`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_attendance INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS total_nearby_events INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS total_nearby_attendance INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_type VARCHAR(50)`);
  // Migration 045 is the real home for these two; the ALTERs keep this script
  // runnable against a database that has not booted the migration yet. NO
  // DEFAULT on either, for 045's reason: a default of false would say "we know
  // the lookup failed" about every row written before anyone was recording it.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS events_observed BOOLEAN`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS events_unavailable_reason TEXT`);

  // Process training data in chunks
  const { rows: countResult } = await pool.query('SELECT COUNT(*) as count FROM ml_training_data');
  const totalRows = parseInt(countResult[0].count, 10);
  console.log(`[Enrich] Processing ${totalRows} training rows...`);

  const CHUNK_SIZE = 5000;
  let processed = 0;
  let enriched = 0;
  let observedQuiet = 0;
  let dateless = 0;
  let offset = 0;
  const unavailableCounts = {};

  while (offset < totalRows) {
    // Fetch chunk with venue info
    const { rows: chunk } = await pool.query(
      `SELECT t.id, t.day_of_week, t.hour, t.collection_mode, t.collected_at,
              to_char(t.observed_date, 'YYYY-MM-DD') AS observed_date,
              v.city, v.latitude, v.longitude
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
      // Dateless rows (weekly "typical week" snapshots) have no date a one-off
      // concert could be attributed to. That is a real reason not to match, and
      // it is still not an observation of an empty street: the row is marked
      // unavailable rather than stamped with a negative it never earned.
      const rowDate = observedDateOf(row);
      if (!rowDate) {
        updates.push({ id: row.id, observed: false, reason: 'no_observation_date' });
        dateless++;
        continue;
      }

      // Nothing was collected for this city, ever. The old code wrote false
      // here and that single branch is most of the 2,194,300 fabricated
      // negatives.
      if (!citiesWithEvents.has(row.city)) {
        updates.push({ id: row.id, observed: false, reason: 'no_events_for_city' });
        continue;
      }

      const dowEvents = eventsByCityDate.get(`${row.city}|${rowDate}`) || [];
      if (dowEvents.length === 0) {
        // The city has events but none on this date. Nothing in ml_events
        // records the collection WINDOW, so a date with no events cannot be
        // told from a date nobody collected. Unavailable, not quiet.
        updates.push({ id: row.id, observed: false, reason: 'no_events_on_date' });
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
          observed: true,
          hasEvent: true,
          nearestDist: Math.round(nearestDist * 100) / 100,
          nearestAttendance: nearestEvent.attendance,
          totalNearby,
          totalAttendance,
          nearestType: nearestEvent.type,
        });
        enriched++;
      } else {
        // THE ONLY HONEST NEGATIVE IN THIS FILE. A non-empty index for this
        // city and this date was searched, and nothing was within 2 km in this
        // hour. false and 0 here are measurements.
        updates.push({ id: row.id, observed: true, hasEvent: false });
        observedQuiet++;
      }
    }

    // Batch update — build a single query for all event-matched rows
    const withEvents = updates.filter(u => u.observed && u.hasEvent);
    if (withEvents.length > 0) {
      // Build VALUES list for batch update
      const vals = [];
      const params = [];
      let idx = 1;
      for (const u of withEvents) {
        vals.push(`($${idx}::int, $${idx+1}::numeric, $${idx+2}::int, $${idx+3}::int, $${idx+4}::int, $${idx+5}::varchar)`);
        params.push(u.id, u.nearestDist, u.nearestAttendance, u.totalNearby, u.totalAttendance, u.nearestType);
        idx += 6;
      }
      await pool.query(
        `UPDATE ml_training_data AS t SET
          has_nearby_event = true,
          nearest_event_distance_km = v.dist,
          nearest_event_attendance = v.att,
          total_nearby_events = v.cnt,
          total_nearby_attendance = v.tot_att,
          nearest_event_type = v.etype,
          events_observed = true,
          events_unavailable_reason = NULL
         FROM (VALUES ${vals.join(',')}) AS v(id, dist, att, cnt, tot_att, etype)
         WHERE t.id = v.id`,
        params
      );
    }

    // Batch reset the rows that WERE searched and came back quiet. false and 0
    // are the measurement here, and events_observed = true is what says so.
    const quiet = updates.filter(u => u.observed && !u.hasEvent).map(u => u.id);
    if (quiet.length > 0) {
      await pool.query(
        `UPDATE ml_training_data SET
          has_nearby_event = false,
          nearest_event_distance_km = NULL,
          nearest_event_attendance = 0,
          total_nearby_events = 0,
          total_nearby_attendance = 0,
          nearest_event_type = NULL,
          events_observed = true,
          events_unavailable_reason = NULL
         WHERE id = ANY($1::int[])`,
        [quiet]
      );
    }

    // Batch the rows no lookup could have answered, one statement per reason.
    // Every event column goes NULL rather than to its default: a 0 here would
    // be the fabricated negative this whole change exists to stop, and
    // export_training_data.js writes a NULL out as an EMPTY CSV field, which
    // pandas reads as NaN and prepare_features.py fills with 0 in the one place
    // the imputation is visible and revisable.
    const unavailable = updates.filter(u => !u.observed);
    const byReason = new Map();
    for (const u of unavailable) {
      if (!byReason.has(u.reason)) byReason.set(u.reason, []);
      byReason.get(u.reason).push(u.id);
    }
    for (const [reason, ids] of byReason) {
      unavailableCounts[reason] = (unavailableCounts[reason] || 0) + ids.length;
      await pool.query(
        `UPDATE ml_training_data SET
          has_nearby_event = NULL,
          nearest_event_distance_km = NULL,
          nearest_event_attendance = NULL,
          total_nearby_events = NULL,
          total_nearby_attendance = NULL,
          nearest_event_type = NULL,
          events_observed = false,
          events_unavailable_reason = $2
         WHERE id = ANY($1::int[])`,
        [ids, reason]
      );
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
       COUNT(*) FILTER (WHERE events_observed IS TRUE) as observed_rows,
       COUNT(*) FILTER (WHERE events_observed IS FALSE) as unavailable_rows,
       COUNT(*) FILTER (WHERE events_observed IS NULL) as unrecorded_rows,
       AVG(CASE WHEN has_nearby_event = true THEN nearest_event_attendance END) as avg_attendance,
       AVG(CASE WHEN has_nearby_event = true THEN total_nearby_events END) as avg_nearby_count
     FROM ml_training_data`
  );

  console.log(`\n[Enrich] Done!`);
  console.log(`  Total rows: ${summary[0].total}`);
  console.log(`  Dateless rows (weekly, no date to attribute a one-off event to): ${dateless}`);
  console.log(`  Rows with nearby events: ${summary[0].with_events}`);
  console.log(`  Avg attendance (when event): ${Math.round(summary[0].avg_attendance || 0)}`);
  console.log(`  Avg nearby events (when event): ${parseFloat(summary[0].avg_nearby_count || 0).toFixed(1)}`);

  // The provenance census. This is the number the corpus was missing: how many
  // of those negatives anyone actually looked for.
  console.log('\n[Enrich] Event provenance:');
  console.log(`  Measured this run: ${enriched} with an event, ${observedQuiet} searched and quiet`);
  const unavailableTotal = Object.values(unavailableCounts).reduce((a, b) => a + b, 0);
  if (unavailableTotal > 0) {
    console.log(`  Not measurable this run: ${unavailableTotal}`);
    for (const [reason, count] of Object.entries(unavailableCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason}: ${count}`);
    }
  }
  console.log(`  Table-wide: ${summary[0].observed_rows} observed, ${summary[0].unavailable_rows} `
    + `unavailable, ${summary[0].unrecorded_rows} with no provenance recorded at all.`);
  if (Number(summary[0].unrecorded_rows) > 0) {
    console.log('  The unrecorded rows predate migration 045. Their has_nearby_event = false is not '
      + 'separable into observed and fabricated, it never will be, and nothing here backfills a '
      + 'guess. See scripts/ml/MODEL-METRICS.md before training on them.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('[Enrich] Error:', err);
  process.exit(1);
});
