// ---------------------------------------------------------------------------
// Event Data Service — Ticketmaster + SeatGeek
// Enriches ML training data with nearby event signals.
// STATUS: Active — Ticketmaster integrated into collectRealtime.js pipeline
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

// THE MODEL'S VOCABULARY, not a third one.
//
// This returned 'concert' and 'film' while collectEvents.js and
// mlPredictor.mapTmEventType both return 'music' and 'family', and
// prepare_features.py builds the etype_* one-hots over exactly
// ['music','sports','arts','family','other']. That was harmless while this
// function only fed `event_type`, which the feature list excludes. It stopped
// being harmless on 2026-09-01 when collectRealtime.js began writing
// `nearest_event_type` from it: a music event, the largest Ticketmaster
// segment, produced a row where has_nearby_event is 1 and ALL FIVE etype slots
// are 0, a combination that exists nowhere in the corpus, while serving would
// hand the same event to the model as etype_music = 1.
function mapEventType(classification) {
  if (!classification) return 'other';
  const seg = (classification.segment?.name || '').toLowerCase();
  if (seg.includes('music')) return 'music';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre')) return 'arts';
  if (seg.includes('family')) return 'family';
  return 'other';
}

// The corpus and the serving path both mean this by "nearby": 2 km, and an
// event whose own window can contain the hour being scored. enrichWithEvents
// uses DISTANCE_THRESHOLD_KM = 2 with isHourInRange; mlPredictor uses
// NEARBY_KM = 2 with a [hour - EVENT_MAX_DURATION_H, hour + 1) window. This
// file used 5 km and no time filter at all, so it answered a different
// question and wrote the answer into the same columns.
const NEARBY_KM = 2;
const EVENT_MAX_DURATION_H = 3;

// Fetch nearby events from Ticketmaster Discovery API
// Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
// Env: TICKETMASTER_API_KEY
async function fetchTicketmasterEvents(lat, lon, radiusKm = NEARBY_KM, at = new Date()) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  // No key is a provider that cannot answer, never an empty answer.
  if (!apiKey) return null;

  try {
    // A WINDOW, because without one Discovery returns UPCOMING events and the
    // nearest of those was reported as happening now. A concert scheduled for
    // next Saturday five kilometres away stamped has_nearby_event on a Tuesday
    // afternoon observation, which turns the event channel into a proxy for
    // "this venue is in a city". Same arithmetic as mlPredictor: open
    // EVENT_MAX_DURATION_H before the observed HOUR and close at the end of it,
    // so anything whose active window can contain this hour is fetched.
    const HOUR_MS = 60 * 60 * 1000;
    const tsHour = Math.floor(at.getTime() / HOUR_MS);
    const startDt = new Date((tsHour - EVENT_MAX_DURATION_H) * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const endDt = new Date((tsHour + 1) * HOUR_MS - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: `${lat},${lon}`,
      radius: radiusKm,
      unit: 'km',
      size: 20,
      sort: 'date,asc',
      startDateTime: startDt,
      endDateTime: endDt,
    });

    // Timeout: this sits inside the paid BestTime collection loop — a hung
    // event API must not stall the whole run (round 13).
    const response = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`,
      { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;

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
    return null;
  }
}

// Fetch nearby events from SeatGeek API
// Docs: https://platform.seatgeek.com/
// Env: SEATGEEK_CLIENT_ID
async function fetchSeatGeekEvents(lat, lon, radiusKm = 5) {
  const clientId = process.env.SEATGEEK_CLIENT_ID;
  // Same rule: SEATGEEK_CLIENT_ID is unset in every environment today,
  // and [] here read as an answered-empty vote toward observed=true.
  if (!clientId) return null;

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

    const response = await fetch(`https://api.seatgeek.com/2/events?${params}`,
      { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;

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
    return null;
  }
}

// Get the nearest event to a venue and compute features
// Returns: { event_nearby, event_distance_km, event_size, event_type,
//   event_hours_until, observed, reason } per migration 045.
//
// The reason vocabulary EXTENDS 045's three values on purpose. That migration
// described a backfill matcher, whose only failures were no_events_for_city,
// no_events_on_date and no_observation_date. A live collector doing its own
// lookups has two more: 'lookup_failed' (no provider could answer) and
// 'events_without_coordinates' (they answered, but nothing they returned can
// be measured against a venue). The column is TEXT with no CHECK, and
// inventing one of the migration's three would be a lie about which failure
// happened.
async function getNearestEvent(venueLat, venueLon, radiusKm = NEARBY_KM, at = new Date()) {
  const [tmEvents, sgEvents] = await Promise.all([
    fetchTicketmasterEvents(venueLat, venueLon, radiusKm, at),
    fetchSeatGeekEvents(venueLat, venueLon, radiusKm),
  ]);

  // Provenance travels with the answer (2026-09-01, migration 045's rule
  // applied at the source). A fetcher returns NULL when it could not answer
  // (no key, HTTP failure, timeout) and an ARRAY when it answered, empty
  // included. `observed` is true only when at least one provider answered:
  // a quiet night is a measurement, an outage is not, and before this the
  // two produced byte-identical rows, which is exactly how 56% of the
  // corpus became an unquantifiable negative-event leak.
  const answered = [tmEvents, sgEvents].filter((r) => Array.isArray(r));
  if (answered.length === 0) {
    // NULL, not false: migration 045's contract is that the event columns
    // beside events_observed=false carry NULL, because a false there is the
    // fabricated negative the migration exists to end.
    return {
      event_nearby: null, event_distance_km: null, event_size: null,
      event_type: null, event_hours_until: null,
      observed: false, reason: 'lookup_failed',
    };
  }

  const allEvents = answered.flat();
  if (allEvents.length === 0) {
    return {
      event_nearby: false, event_distance_km: null, event_size: null,
      event_type: null, event_hours_until: null,
      observed: true, reason: null,
    };
  }

  // Find nearest event.
  //
  // TWO FILTERS, because the column this feeds means "an event is happening
  // near this venue at this hour" and the loop below used to mean "the closest
  // thing Ticketmaster knows about". Distance is held to NEARBY_KM rather than
  // to whatever radius the API was asked for, and start time is held to the
  // same window the query asked for, because SeatGeek is not filtered upstream
  // and a provider is free to answer wider than it was asked.
  const now = at instanceof Date && Number.isFinite(at.getTime()) ? at : new Date();
  const HOUR_MS = 60 * 60 * 1000;
  const tsHour = Math.floor(now.getTime() / HOUR_MS);
  const windowOpen = (tsHour - EVENT_MAX_DURATION_H) * HOUR_MS;
  const windowClose = (tsHour + 1) * HOUR_MS;
  let nearest = null;
  let nearestDist = Infinity;
  // Measurability is judged over EVERY event, before the two filters: an event
  // with no coordinates is unmeasurable whether or not it is close or current,
  // and that distinction is what `events_without_coordinates` reports.
  let anyMeasurable = false;

  for (const event of allEvents) {
    if (!event.lat || !event.lon) continue;
    anyMeasurable = true;
    if (event.startTime) {
      const startedAt = new Date(event.startTime).getTime();
      if (!Number.isFinite(startedAt) || startedAt < windowOpen || startedAt >= windowClose) continue;
    }
    const dist = distanceKm(venueLat, venueLon, event.lat, event.lon);
    if (dist > NEARBY_KM) continue;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = event;
    }
  }

  // The providers answered and nothing they returned is near this venue in
  // this hour. That is a measured absence, which is the honest answer and the
  // one the corpus carries for a quiet night.
  if (!nearest && anyMeasurable) {
    return {
      event_nearby: false, event_distance_km: null, event_size: null,
      event_type: null, event_hours_until: null,
      observed: true, reason: null,
    };
  }

  if (!nearest) {
    // Events came back but not one carried usable coordinates, so distance
    // could not be computed for any of them. That is an unmeasurable answer,
    // not a quiet night: reporting observed=true here would turn real nearby
    // events into a measured absence, the same fabrication in a subtler
    // shape (2026-09-01 review).
    return { event_nearby: null, event_distance_km: null, event_size: null,
             event_type: null, event_hours_until: null,
             observed: false, reason: 'events_without_coordinates' };
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
    observed: true,
    reason: null,
  };
}

module.exports = { getNearestEvent, fetchTicketmasterEvents, fetchSeatGeekEvents, distanceKm };
