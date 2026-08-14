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

// The result of this file goes into `venue_data JSONB`, and jsonb is stricter
// about text than a text column is: a NUL byte is `22P05 unsupported Unicode
// escape sequence` and an unpaired surrogate is `invalid unicode surrogate
// pair`, both of which surface as a 500 on sending a message rather than as a
// bad venue card. Control characters are removed before the length clamp, and
// a surrogate left dangling BY that clamp is dropped after it — slicing at a
// fixed character count cuts emoji in half, and a venue name ending in one at
// exactly the limit is ordinary input, not an attack.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DANGLING_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const str = (v, max) => {
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(CONTROL_CHARS, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max).replace(DANGLING_SURROGATE, '') || null;
};

// Out of range is dropped rather than clamped: a coordinate that is not on the
// globe is not a location to pin, and a rating of 1e308 is not a rating to
// print next to a venue name.
const inRange = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

// Returns { ok: true, data } with only known, clamped fields (data may be
// null if nothing usable), or { ok: false } when text fails moderation.
function sanitizeVenueData(raw) {
  if (raw == null) return { ok: true, data: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, data: null };

  const name = str(raw.name, 256);
  const addr = str(raw.addr, 512) || str(raw.address, 512) || str(raw.formatted_address, 512) || str(raw.vicinity, 512);
  // `category` joins the screened set because it is rendered as the card's
  // subtitle whenever `type` is absent, so it is displayed UGC on the same
  // terms as the name.
  const category = str(raw.category, 64);
  for (const text of [name, addr, category]) {
    if (text && !moderateText(text).allowed) return { ok: false };
  }

  const data = {
    place_id: str(raw.place_id, 256),
    name,
    addr,
    rating: inRange(raw.rating ?? raw.stars, 0, 5),
    user_ratings_total: inRange(raw.user_ratings_total, 0, 1e9),
    price_level: Number.isInteger(raw.price_level) && raw.price_level >= 0 && raw.price_level <= 4 ? raw.price_level : null,
    type: str(raw.type, 64),
    // Dropped silently until round 20. The card renders a category colour and
    // icon and a crowd percentage, and the flock-create card sends its
    // coordinates as lat/lng rather than latitude/longitude — so a card looked
    // right on the sender's screen (from the local copy) and came back plain,
    // uncoloured and unpinnable for everyone else once it had been through
    // here. Same clamps as everything else; nothing new is trusted.
    category,
    crowd: inRange(raw.crowd, 0, 100),
    photo_url: safeVenuePhotoUrl(raw.photo_url),
    latitude: inRange(raw.latitude ?? raw.lat ?? raw.location?.latitude, -90, 90),
    longitude: inRange(raw.longitude ?? raw.lng ?? raw.location?.longitude, -180, 180),
  };
  return { ok: true, data };
}

module.exports = { sanitizeVenueData, safeVenuePhotoUrl };
