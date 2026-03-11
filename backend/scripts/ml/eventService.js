// ---------------------------------------------------------------------------
// Event Data Service — Ticketmaster + SeatGeek
// Enriches ML training data with nearby event signals.
// STATUS: Skeleton — needs API keys and integration into collectRealtime.js
// ---------------------------------------------------------------------------

const { sleep } = require('./config');

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

// Map Ticketmaster event classifications to simple types
function mapEventType(classification) {
  if (!classification) return 'other';
  const seg = (classification.segment?.name || '').toLowerCase();
  if (seg.includes('music')) return 'concert';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre')) return 'arts';
  if (seg.includes('film')) return 'film';
  return 'other';
}

// Fetch nearby events from Ticketmaster Discovery API
// Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
// Env: TICKETMASTER_API_KEY
async function fetchTicketmasterEvents(lat, lon, radiusKm = 5) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return [];

  try {
    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: `${lat},${lon}`,
      radius: radiusKm,
      unit: 'km',
      size: 20,
      sort: 'date,asc',
    });

    const response = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
    if (!response.ok) return [];

    const data = await response.json();
    const events = data._embedded?.events || [];

    return events.map(e => ({
      name: e.name,
      type: mapEventType(e.classifications?.[0]),
      lat: parseFloat(e._embedded?.venues?.[0]?.location?.latitude || 0),
      lon: parseFloat(e._embedded?.venues?.[0]?.location?.longitude || 0),
      startTime: e.dates?.start?.dateTime || null,
      size: parseInt(e._embedded?.venues?.[0]?.generalInfo?.capacity || 0, 10) || null,
    }));
  } catch (err) {
    console.error('[ML:Events] Ticketmaster error:', err.message);
    return [];
  }
}

// Fetch nearby events from SeatGeek API
// Docs: https://platform.seatgeek.com/
// Env: SEATGEEK_CLIENT_ID
async function fetchSeatGeekEvents(lat, lon, radiusKm = 5) {
  const clientId = process.env.SEATGEEK_CLIENT_ID;
  if (!clientId) return [];

  try {
    const radiusMi = Math.round(radiusKm * 0.621371);
    const params = new URLSearchParams({
      client_id: clientId,
      lat: lat,
      lon: lon,
      range: `${radiusMi}mi`,
      per_page: 20,
      sort: 'datetime_local.asc',
    });

    const response = await fetch(`https://api.seatgeek.com/2/events?${params}`);
    if (!response.ok) return [];

    const data = await response.json();
    const events = data.events || [];

    return events.map(e => ({
      name: e.title,
      type: e.type || 'other',
      lat: e.venue?.location?.lat || 0,
      lon: e.venue?.location?.lon || 0,
      startTime: e.datetime_utc || null,
      size: e.venue?.capacity || null,
    }));
  } catch (err) {
    console.error('[ML:Events] SeatGeek error:', err.message);
    return [];
  }
}

// Get the nearest event to a venue and compute features
// Returns: { event_nearby, event_distance_km, event_size, event_type, event_hours_until }
async function getNearestEvent(venueLat, venueLon, radiusKm = 5) {
  const [tmEvents, sgEvents] = await Promise.all([
    fetchTicketmasterEvents(venueLat, venueLon, radiusKm),
    fetchSeatGeekEvents(venueLat, venueLon, radiusKm),
  ]);

  // Merge and deduplicate by name similarity
  const allEvents = [...tmEvents, ...sgEvents];
  if (allEvents.length === 0) {
    return { event_nearby: false, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null };
  }

  // Find nearest event
  const now = new Date();
  let nearest = null;
  let nearestDist = Infinity;

  for (const event of allEvents) {
    if (!event.lat || !event.lon) continue;
    const dist = distanceKm(venueLat, venueLon, event.lat, event.lon);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = event;
    }
  }

  if (!nearest) {
    return { event_nearby: false, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null };
  }

  // Calculate hours until event
  let hoursUntil = null;
  if (nearest.startTime) {
    const eventTime = new Date(nearest.startTime);
    hoursUntil = Math.round((eventTime - now) / (1000 * 60 * 60));
  }

  return {
    event_nearby: true,
    event_distance_km: Math.round(nearestDist * 10) / 10,
    event_size: nearest.size,
    event_type: nearest.type,
    event_hours_until: hoursUntil,
  };
}

module.exports = { getNearestEvent, fetchTicketmasterEvents, fetchSeatGeekEvents, distanceKm };
