'use strict';
// ---------------------------------------------------------------------------
// THE EVENT FEATURES, ONE COMPUTATION FOR SERVING AND FOR THE COLLECTOR.
//
// Moved out of services/mlPredictor.js unchanged on 2026-09-26, so the hourly
// collector (scripts/ml/collectRealtime.js, through eventService.js) can store
// on each live reading exactly the event values serving hands the model for
// the same Ticketmaster listing: the ongoing events within 2 km, their count,
// the nearest one's type, distance and size, and the summed size. Until then
// the collector stored its own reading of the listing (the nearest event that
// started in the window, a count of one, and a size only when Ticketmaster
// printed a capacity, which it almost never does), so on every live row the
// attendance columns trained as 0 while serving handed the model the size
// class below. Pure: no network, no cache, no budget.
// ---------------------------------------------------------------------------

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// MUST MATCH scripts/ml/collectEvents.js estimateEndHour: the corpus's event
// window for every training row was [startHour, startHour + duration],
// INCLUSIVE of both end hours (enrichWithEvents.isHourInRange). Serving
// re-derives the same window from the same duration table, so an event is
// "nearby" at prediction time exactly when training would have counted it.
const EVENT_DURATION_HOURS = { music: 3, sports: 3, arts: 2, family: 3, other: 3 };
const EVENT_MAX_DURATION_H = 3; // max of the table — bounds the query window
// Module scope since 2026-09-04: buildEventResult below is lifted out of the
// fetch and needs it, and a constant used by two functions belongs to neither.
const HOUR_MS = 60 * 60 * 1000;

function mapTmEventType(classifications) {
  if (!classifications || !classifications.length) return 'other';
  const seg = (classifications[0].segment?.name || '').toLowerCase();
  if (seg.includes('music')) return 'music';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre')) return 'arts';
  if (seg.includes('family')) return 'family';
  return 'other';
}

// THIS MUST STAY BYTE-FOR-BYTE EQUIVALENT TO
// scripts/ml/collectEvents.js estimateAttendance(), which is the function that
// produced `estimated_attendance` for every event row in the corpus. Four
// features are derived from the number it returns (nearest_event_attendance,
// its log, total_nearby_attendance and its log) plus the binary
// large_event_nearby, so a serving-side estimator that has drifted from the
// collector labels the same Ticketmaster payload with one number at training
// time and a different one at prediction time.
//
// Round 17: it had drifted, by four branches, all of them downward:
//   * the arena vocabulary had lost "garden" and "field", so a concert at
//     Madison Square Garden estimated 500 instead of 20,000;
//   * music at a theatre (3,000) had no branch and fell to 500;
//   * arts (1,500) and family (1,000) both collapsed to the 500 default.
// The user-visible half of that: `eventAlert` on the venue card fires at
// >5,000 attendance, so a Garden or arena show — exactly the event a person
// wants to be warned about — could never raise the banner.
// Same ceiling, same reason, as services/nightContext.js MAX_EVENT_ATTENDANCE,
// which carries the long version of this note: `generalInfo.capacity` is a
// promoter-typed field, it was parsed with no bound, and the number lands in
// two INTEGER columns (ml_events.estimated_attendance and
// venue_owner_report_context.total_nearby_attendance / nearest_event_attendance)
// as well as in four features of the crowd model. Past int4 it is a 22003 that
// loses the row; short of that it is simply a wrong score. 250,000 is above
// every venue on earth.
const MAX_EVENT_ATTENDANCE = 250000;

function estimateTmAttendance(event) {
  const venues = event._embedded?.venues || [];
  for (const v of venues) {
    const raw = parseInt(v.generalInfo?.capacity, 10) ||
                parseInt(v.boxOfficeInfo?.capacity, 10) || 0;
    const cap = Number.isFinite(raw) ? Math.min(raw, MAX_EVENT_ATTENDANCE) : 0;
    if (cap > 0) return cap;
  }
  const venueName = (venues[0]?.name || '').toLowerCase();
  const isArena = venueName.includes('arena') || venueName.includes('stadium') ||
                  venueName.includes('center') || venueName.includes('centre') ||
                  venueName.includes('garden') || venueName.includes('field');
  const type = mapTmEventType(event.classifications);
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

// The guard every coordinate consumer below shares: two finite numbers that
// name a place on Earth. The range half is services/weatherService.js
// validCoords's, so the weather, event and neighbour lookups for one venue
// agree about whether it has a location; before it, a latitude of 500 from a
// batch body was a fresh event cache key and a Ticketmaster call for a point
// that does not exist. The one deliberate difference from validCoords is
// strings: validCoords accepts a numeric string from the callers that hand it
// one (a Birdie tool argument is whatever the model wrote), while these
// coordinates come off venue objects and are used as numbers (toFixed, the
// query's latlong), so a string is not a coordinate here.
const hasCoordinates = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

// TWO DIFFERENT ZEROS, AND WHY THEY CANNOT SHARE ONE OBJECT (round 24).
//
// This function used to answer with the SAME `noEvents` object in five
// situations: the key is missing, the budget refused the call, Ticketmaster
// returned an error, the request timed out, and Ticketmaster answered with an
// empty list. Only the last of those is an observation. The other four are a
// question nobody asked, and a caller reading `hasEvent: false` could not tell
// which it had.
//
// The crowd model does not care, because a missing feature and a zero feature
// score the same way there and the prediction degrades either way. The venue
// advisor does care, and that is where the indistinguishable sentinel became a
// falsehood: services/advisorFacts.js counted seven of these as seven negative
// observations and built a SOURCED fact reading "No big listed events within
// about a kilometer over the next 7 days" out of seven calls that never
// happened. An owner can staff a night against that sentence.
//
// So every return carries `observed`. True means Ticketmaster answered and
// this is what it said. False means no answer reached us, `unavailableReason`
// says which of the four it was, and the zeros in the rest of the object are
// placeholders rather than measurements. Callers that only read hasEvent keep
// working unchanged; callers that make CLAIMS about the street must check
// `observed` first.
const EVENT_ZERO = {
  hasEvent: false, nearestAttendance: 0, totalEvents: 0,
  totalAttendance: 0, nearestType: null, nearestDistance: 0,
  nearestName: null,
};

// Ticketmaster answered, and the answer was nothing nearby.
function eventsObserved() {
  return { ...EVENT_ZERO, observed: true, unavailableReason: null };
}

// No answer reached us. The zeros below mean "unknown", not "none".
function eventsUnavailable(reason) {
  return { ...EVENT_ZERO, observed: false, unavailableReason: reason };
}

// The per-slot filter, lifted out of the fetch on 2026-09-04 so ONE fetched
// list can answer many hours.
//
// Everything below depends only on the events, the venue's coordinates and
// the HOUR being asked about. That is what makes a range prefetch possible:
// a 24 hour strip used to make up to 24 upstream calls whose windows overlap
// by three hours each, re-buying most of the same events every time, and
// EVENT_DAILY_BUDGET divided by 25 is sixty cold venue cards a day for the
// whole product before event enrichment silently vanishes for everyone.
//
// Pure: no cache write, no budget charge, no network. The two callers below
// own those.
function buildEventResult(events, lat, lng, tsHour) {
  // ONE POPULATION, COUNTED ONCE. scripts/ml/enrichWithEvents.js builds the
  // training values by filtering to DISTANCE_THRESHOLD_KM = 2 and then
  // deriving total_nearby_events AND total_nearby_attendance from the same
  // surviving list. Round 17: this counted `events.length` — everything
  // Ticketmaster returned, including entries with no coordinates at all and
  // whatever the vendor's own radius interpretation let through — while
  // summing attendance over a strictly smaller set. So the two features
  // described different populations, and total_nearby_events was inflated
  // relative to every row the model was trained on.
  const NEARBY_KM = 2; // enrichWithEvents.DISTANCE_THRESHOLD_KM
  let nearestDist = Infinity;
  let nearestEvent = null;
  let totalAttendance = 0;
  let totalNearby = 0;

  for (const e of events) {
    // Parsed WITHOUT a `|| 0` default: a missing or unreadable coordinate is
    // NaN and is skipped, and a 0 is the equator or the prime meridian and is
    // kept. The old `|| 0` then `!eLat || !eLng` pair dropped every event on
    // either line, which since the venue side keeps a 0 (venueCoordinate) is
    // exactly the street a venue on the meridian is asking about.
    const eLat = parseFloat(e._embedded?.venues?.[0]?.location?.latitude);
    const eLng = parseFloat(e._embedded?.venues?.[0]?.location?.longitude);
    // An event we cannot place is an event we cannot say is nearby.
    if (!hasCoordinates(eLat, eLng)) continue;

    const dist = distanceKm(lat, lng, eLat, eLng);
    if (dist > NEARBY_KM) continue;

    // ONGOING, THE WAY TRAINING COUNTED IT: hour(t) inside [startHour,
    // startHour + duration], both ends inclusive, at hour granularity
    // (enrichWithEvents.isHourInRange over collectEvents.estimateEndHour's
    // per-type durations). Hour floors of real instants: offsets cancel for
    // whole-hour timezones, and a half-hour zone is off by at most the same
    // hour of slack training's integer-hour comparison already had. An event
    // whose start Ticketmaster does not timestamp stays counted — it matched
    // the query window, so it started within the last EVENT_MAX_DURATION_H
    // hours, and "probably mid-show" beats inventing a start time.
    const type = mapTmEventType(e.classifications);
    const startMs = Date.parse(e.dates?.start?.dateTime || '');
    if (Number.isFinite(startMs)) {
      const hoursSinceStart = tsHour - Math.floor(startMs / HOUR_MS);
      const durH = EVENT_DURATION_HOURS[type] ?? EVENT_MAX_DURATION_H;
      if (hoursSinceStart < 0 || hoursSinceStart > durH) continue;
    }

    const attendance = estimateTmAttendance(e);
    totalNearby++;
    totalAttendance += attendance;

    if (dist < nearestDist) {
      nearestDist = dist;
      nearestEvent = { name: e.name, type, attendance };
    }
  }

  // Everything Ticketmaster listed was too far away, over, or unplaceable.
  // The listing ran, so this is observed: an empty street, honestly.
  return nearestEvent ? {
    hasEvent: true,
    nearestAttendance: nearestEvent.attendance,
    totalEvents: totalNearby,
    totalAttendance,
    nearestType: nearestEvent.type,
    nearestDistance: Math.round(nearestDist * 100) / 100,
    nearestName: nearestEvent.name,
    observed: true,
    unavailableReason: null,
  } : eventsObserved();
}

module.exports = {
  distanceKm,
  EVENT_DURATION_HOURS,
  EVENT_MAX_DURATION_H,
  HOUR_MS,
  mapTmEventType,
  MAX_EVENT_ATTENDANCE,
  estimateTmAttendance,
  hasCoordinates,
  EVENT_ZERO,
  eventsObserved,
  eventsUnavailable,
  buildEventResult,
};
