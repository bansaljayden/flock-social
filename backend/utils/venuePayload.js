// Venue payload sanitizer (round 8). Clients send venue objects with messages
// (venue cards), flock create/edit, and DM pins. They were stored and
// re-rendered as-is, which allowed two attacks a clean message can't pull off:
//   - photo_url pointing at a sender-controlled HTTPS host renders as
//     <img src> on every recipient's device — a per-recipient tracking pixel
//     that leaks IP and viewing time. Only OUR photo proxy path survives.
//   - name/address text bypassed the profanity screen every direct text
//     field goes through.
// Everything else is type- and length-clamped to known fields.

const { moderateText } = require('./moderation');

// Our own photo proxy is the only photo source that renders. Clients send the
// proxy path either relative (as the search API returns it) or prefixed with
// the API origin — normalize both down to the RELATIVE path, which re-anchors
// the request to our proxy regardless of what host the sender wrote.
function safeVenuePhotoUrl(url) {
  if (typeof url !== 'string') return null;
  const i = url.indexOf('/api/venues/photo?');
  if (i === -1) return null;
  const u = url.slice(i).trim();
  if (/^\/api\/venues\/photo\?[A-Za-z0-9=&%._~-]+$/.test(u) && u.length <= 1024) return u;
  return null;
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v) => (Number.isFinite(v) ? v : null);

// Returns { ok: true, data } with only known, clamped fields (data may be
// null if nothing usable), or { ok: false } when text fails moderation.
function sanitizeVenueData(raw) {
  if (raw == null) return { ok: true, data: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, data: null };

  const name = str(raw.name, 256);
  const addr = str(raw.addr, 512) || str(raw.address, 512) || str(raw.formatted_address, 512) || str(raw.vicinity, 512);
  for (const text of [name, addr]) {
    if (text && !moderateText(text).allowed) return { ok: false };
  }

  const data = {
    place_id: str(raw.place_id, 256),
    name,
    addr,
    rating: num(raw.rating ?? raw.stars),
    user_ratings_total: num(raw.user_ratings_total),
    price_level: Number.isInteger(raw.price_level) ? raw.price_level : null,
    type: str(raw.type, 64),
    photo_url: safeVenuePhotoUrl(raw.photo_url),
    latitude: num(raw.latitude ?? raw.location?.latitude),
    longitude: num(raw.longitude ?? raw.location?.longitude),
  };
  return { ok: true, data };
}

module.exports = { sanitizeVenueData, safeVenuePhotoUrl };
