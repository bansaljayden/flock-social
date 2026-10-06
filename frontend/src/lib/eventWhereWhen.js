/**
 * How far an event is from the person looking at it, and whose clock its time
 * is on. The Discover events list and the event detail screen both say these
 * two things, and both read them from here, so the card and the screen it
 * opens cannot say them differently.
 *
 * THE DISTANCE IS MEASURED ON THE DEVICE. The server caches an events answer
 * for everyone in a 0.1-degree cell, so a distance it measured would be from
 * some point that is not the viewer's. It used to be the first caller's own
 * position, up to about 14 km off, and the detail screen showed it under a
 * card that had worked out a different number (backend/routes/events.js, THE
 * CELL, NOT THE CALLER). The server now sends the venue's position and no
 * distance, and this file measures from where the viewer is, one way, for
 * both surfaces.
 *
 * THE TIME IS THE VENUE'S WALL CLOCK, and that is right: a 7 PM show in
 * Denver is a 7 PM show. But a plan started from it is shown in the device's
 * own zone (screens/CreateScreen.js), so a viewer two zones away read 7:00 PM
 * on the card and 9:00 PM on the plan with nothing to say which was which.
 * When the venue's clock at the moment the event starts is not the viewer's,
 * the time carries the venue's zone, "7:00 PM MDT". When the two clocks agree
 * it carries nothing, so the ordinary case reads exactly as it did.
 */

const EARTH_RADIUS_KM = 6371;

// A coordinate is a finite number. Number(null) is 0, which is a real place,
// so nothing is coerced.
const coord = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Kilometres from the viewer ({ lat, lng }) to the event's venue
 * (event.location { latitude, longitude }), or null when either end is
 * unknown. The haversine the events card has always used.
 */
export function eventDistanceKm(event, viewer) {
  const lat1 = coord(viewer?.lat);
  const lng1 = coord(viewer?.lng);
  const lat2 = coord(event?.location?.latitude);
  const lng2 = coord(event?.location?.longitude);
  if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) return null;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** "800m" under a kilometre, "2.3km" from there: the card's own format. */
export function formatEventDistance(km) {
  if (typeof km !== 'number' || !Number.isFinite(km) || km < 0) return null;
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
}

// An Intl formatter costs far more to build than to use, and the card asks
// once per event on every render, so each zone's is built once and kept. The
// set is the zones Ticketmaster names, a few dozen at most. A zone the device
// does not know throws, and nothing is kept for it.
const clockFormats = new Map();
const nameFormats = new Map();
function formatFor(cache, timeZone, options) {
  let format = cache.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    cache.set(timeZone, format);
  }
  return format;
}

const pad2 = (n) => String(n).padStart(2, '0');

// "YYYY-MM-DDTHH:MM" on the wall clock of `timeZone` at `instant`, or null
// when the zone is not one the device knows. No zone means the device's own
// clock, read off the Date itself, which is the clock CreateScreen prints.
function wallClock(instant, timeZone) {
  if (timeZone === undefined) {
    return `${instant.getFullYear()}-${pad2(instant.getMonth() + 1)}-${pad2(instant.getDate())}T${pad2(instant.getHours())}:${pad2(instant.getMinutes())}`;
  }
  try {
    const parts = {};
    const format = formatFor(clockFormats, timeZone, {
      hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    for (const p of format.formatToParts(instant)) parts[p.type] = p.value;
    // An engine that ignores hourCycle writes midnight as "24".
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
  } catch {
    return null;
  }
}

// "GMT-6", "GMT+5:30", "GMT": the form Intl itself uses for a zone with no
// short name.
function gmtLabel(offsetMinutes) {
  if (offsetMinutes === 0) return 'GMT';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const minutes = abs % 60;
  return `GMT${sign}${Math.floor(abs / 60)}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/**
 * The venue's zone ("MDT", "GMT+1") when the venue's clock at the start of
 * the event is not the viewer's, else null. `viewerTimeZone` is for tests; the
 * app passes nothing and gets the device's zone.
 *
 * Null whenever it cannot be known, which is the old behaviour: no start
 * instant (a listing with the time to be announced) or a date and time that
 * are not the shape Ticketmaster sends.
 */
export function eventTimeZoneLabel(event, viewerTimeZone) {
  if (!event || typeof event.datetime_utc !== 'string'
    || typeof event.date !== 'string' || typeof event.time !== 'string') return null;
  const at = new Date(event.datetime_utc);
  if (Number.isNaN(at.getTime())) return null;
  const venueClock = `${event.date}T${event.time.slice(0, 5)}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(venueClock);
  if (!m) return null;
  const viewerClock = wallClock(at, viewerTimeZone);
  if (!viewerClock || viewerClock === venueClock) return null;
  // The listing's own name for the zone, but only while that zone's clock is
  // the one the listing printed. Otherwise the offset the printed time
  // implies, which is true of the time on screen whatever the name says.
  if (typeof event.timezone === 'string' && event.timezone && wallClock(at, event.timezone) === venueClock) {
    try {
      const name = formatFor(nameFormats, event.timezone, { timeZoneName: 'short' })
        .formatToParts(at).find((p) => p.type === 'timeZoneName');
      if (name && name.value) return name.value;
    } catch {
      // Falls through to the offset.
    }
  }
  const venueAsUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return gmtLabel(Math.round((venueAsUtc - at.getTime()) / 60000));
}
