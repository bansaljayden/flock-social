// ---------------------------------------------------------------------------
// Fetch Ticketmaster events for all ML training cities
// Stores in ml_events table for historical event enrichment
// Run: node backend/scripts/ml/collectEvents.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { CITIES, sleep } = require('./config');

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

const API_KEY = process.env.TICKETMASTER_API_KEY;
const TM_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';

// Map Ticketmaster segment to simple event type
function mapEventType(classifications) {
  if (!classifications || !classifications.length) return 'other';
  const seg = (classifications[0].segment?.name || '').toLowerCase();
  if (seg.includes('music')) return 'music';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre')) return 'arts';
  if (seg.includes('family')) return 'family';
  return 'other';
}

// Estimate attendance from venue capacity or classification
function estimateAttendance(event) {
  // Try venue capacity first
  const venues = event._embedded?.venues || [];
  for (const v of venues) {
    const cap = parseInt(v.generalInfo?.capacity, 10) ||
                parseInt(v.boxOfficeInfo?.capacity, 10) || 0;
    if (cap > 0) return cap;
  }

  // Estimate from classification
  const type = mapEventType(event.classifications);
  const subType = (event.classifications?.[0]?.genre?.name || '').toLowerCase();
  const venueName = (venues[0]?.name || '').toLowerCase();

  // Check for large venues
  const isArena = venueName.includes('arena') || venueName.includes('stadium') ||
                  venueName.includes('center') || venueName.includes('centre') ||
                  venueName.includes('garden') || venueName.includes('field');

  if (type === 'sports') return isArena ? 25000 : 5000;
  if (type === 'music') {
    if (isArena) return 20000;
    if (venueName.includes('theater') || venueName.includes('theatre')) return 3000;
    return 500;
  }
  if (type === 'arts') return 1500;
  if (type === 'family') return 1000;
  return 500;
}

// Estimate event end hour from type and start hour
function estimateEndHour(startHour, type) {
  const durations = { music: 3, sports: 3, arts: 2, family: 3, other: 3 };
  const duration = durations[type] || 3;
  return (startHour + duration) % 24;
}

// Fetch one page of events from Ticketmaster
async function fetchPage(lat, lon, startDt, endDt, page) {
  const params = new URLSearchParams({
    apikey: API_KEY,
    latlong: `${lat},${lon}`,
    radius: '30',
    unit: 'km',
    startDateTime: startDt,
    endDateTime: endDt,
    size: '200',
    page: String(page),
    sort: 'date,asc',
  });

  const url = `${TM_BASE}?${params}`;
  const response = await fetch(url);

  if (response.status === 429) {
    console.log('  Rate limited, waiting 2s...');
    await sleep(2000);
    return fetchPage(lat, lon, startDt, endDt, page);
  }

  if (!response.ok) {
    console.error(`  API error: ${response.status} ${response.statusText}`);
    return { events: [], totalPages: 0 };
  }

  const data = await response.json();
  const events = data._embedded?.events || [];
  const totalPages = data.page?.totalPages || 0;
  return { events, totalPages };
}

// Fetch all events for a city within a date window
async function fetchCityWindow(cityKey, lat, lon, startDt, endDt) {
  const allEvents = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages && page < 5) {
    const result = await fetchPage(lat, lon, startDt, endDt, page);
    allEvents.push(...result.events);
    totalPages = result.totalPages;
    page++;
    await sleep(200);
  }

  return allEvents;
}

// Insert events into ml_events
async function insertEvents(events, cityKey) {
  let inserted = 0;
  for (const e of events) {
    const tmId = e.id;
    const name = (e.name || '').substring(0, 500);
    const venueName = (e._embedded?.venues?.[0]?.name || '').substring(0, 255);
    const venueLat = parseFloat(e._embedded?.venues?.[0]?.location?.latitude) || null;
    const venueLng = parseFloat(e._embedded?.venues?.[0]?.location?.longitude) || null;

    if (!venueLat || !venueLng) continue;

    const localDate = e.dates?.start?.localDate || null;
    if (!localDate) continue;

    const localTime = e.dates?.start?.localTime || '19:00:00';
    const startHour = parseInt(localTime.split(':')[0], 10) || 19;
    const type = mapEventType(e.classifications);
    const endHour = estimateEndHour(startHour, type);
    const attendance = estimateAttendance(e);

    try {
      await pool.query(
        `INSERT INTO ml_events (ticketmaster_id, name, city, venue_name, venue_lat, venue_lng,
         event_date, event_start_hour, event_end_hour, event_type, estimated_attendance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (ticketmaster_id) DO NOTHING`,
        [tmId, name, cityKey, venueName, venueLat, venueLng,
         localDate, startHour, endHour, type, attendance]
      );
      inserted++;
    } catch (err) {
      // Skip duplicates or errors
    }
  }
  return inserted;
}

// Format date as ISO 8601 for Ticketmaster API
function toTmDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function main() {
  if (!API_KEY) {
    console.error('[CollectEvents] TICKETMASTER_API_KEY not set');
    process.exit(1);
  }

  console.log('[CollectEvents] Fetching training data date range...');
  const { rows: dateRange } = await pool.query(
    `SELECT MIN(collected_at) as min_date, MAX(collected_at) as max_date FROM ml_training_data`
  );

  if (!dateRange[0].min_date) {
    console.error('[CollectEvents] No training data found');
    process.exit(1);
  }

  const minDate = new Date(dateRange[0].min_date);
  const maxDate = new Date(dateRange[0].max_date);
  // Extend to cover a reasonable window (2 weeks before and after)
  minDate.setDate(minDate.getDate() - 14);
  maxDate.setDate(maxDate.getDate() + 7);

  console.log(`[CollectEvents] Date range: ${minDate.toISOString().slice(0, 10)} to ${maxDate.toISOString().slice(0, 10)}`);

  // Get cities with training data
  const { rows: cityRows } = await pool.query(
    `SELECT DISTINCT city FROM ml_venues WHERE is_active = true ORDER BY city`
  );
  const trainingCities = cityRows.map(r => r.city);
  console.log(`[CollectEvents] Cities: ${trainingCities.join(', ')}`);

  let totalEvents = 0;
  let totalCalls = 0;

  for (const cityKey of trainingCities) {
    const cityConfig = CITIES[cityKey];
    if (!cityConfig) {
      console.log(`  Skipping ${cityKey} — not in config`);
      continue;
    }

    console.log(`\n[CollectEvents] === ${cityConfig.name} (${cityKey}) ===`);
    const { lat, lon } = cityConfig;

    // Split date range into 3-day windows to stay under 1000-event limit
    const windowMs = 3 * 24 * 60 * 60 * 1000;
    let windowStart = new Date(minDate);
    let cityTotal = 0;

    while (windowStart < maxDate) {
      const windowEnd = new Date(Math.min(windowStart.getTime() + windowMs, maxDate.getTime()));
      const startDt = toTmDate(windowStart);
      const endDt = toTmDate(windowEnd);

      const events = await fetchCityWindow(cityKey, lat, lon, startDt, endDt);
      totalCalls++;

      if (events.length > 0) {
        const inserted = await insertEvents(events, cityKey);
        cityTotal += inserted;
        process.stdout.write(`  ${windowStart.toISOString().slice(0, 10)}: ${events.length} found, ${inserted} inserted\n`);
      }

      windowStart = windowEnd;
    }

    console.log(`  Total for ${cityKey}: ${cityTotal} events`);
    totalEvents += cityTotal;
  }

  // Final count
  const { rows: countRows } = await pool.query('SELECT COUNT(*) as count FROM ml_events');
  console.log(`\n[CollectEvents] Done! ${totalEvents} new events inserted.`);
  console.log(`[CollectEvents] Total events in ml_events: ${countRows[0].count}`);
  console.log(`[CollectEvents] API calls made: ${totalCalls}`);

  await pool.end();
}

main().catch(err => {
  console.error('[CollectEvents] Error:', err);
  process.exit(1);
});
