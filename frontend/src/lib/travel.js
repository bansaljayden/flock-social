/**
 * "On my way": the intent that rides on a shared position, and the arithmetic
 * that turns a position into "about 8 min".
 *
 * WHY THIS FILE EXISTS. The chat's who-is-here card needs to say how far off
 * each person is, the sharing bar needs to know which modes exist, the socket
 * emitter needs to know what is allowed on the wire, and the card cannot
 * import App.js (App.js imports it). One small module every side reads, so
 * the vocabulary cannot drift between the server, the emitter and the card.
 *
 * WHAT IS SENT. A position packet may carry three optional fields:
 *   intent  'omw' | 'need_ride'   what the person is telling the group
 *   mode    'walk' | 'drive' | 'transit'   how they are getting there
 *   seats   0..8, integer   spare seats, only meaningful with mode 'drive'
 * Absent means "just sharing", which is what every packet was before this
 * file existed; the server forwards the fields only when present and valid,
 * so an older client and a plain share are byte-identical to what they were.
 *
 * WHY THE ETA IS AN ESTIMATE AND SAYS SO. There is no routing call here, on
 * purpose. A routing API costs money per look, the budget guard exists because
 * of exactly that class of spend, and a navigation-grade number would be a
 * claim the app cannot stand behind for a person who is walking through a
 * building or stuck at a light. What the group actually wants is "is Sam five
 * minutes off or forty", and a straight-line distance with a road factor and a
 * mode speed answers that honestly when it is labelled "about". Find My does
 * the same. If a route ever replaces this, only etaMinutes changes.
 *
 * The road factor (1.3) is the usual ratio of driven or walked distance to the
 * straight line in a street grid. The speeds are night-time urban averages,
 * chosen to run slow rather than fast: an ETA that is a little pessimistic is
 * a friend who arrives early, and the other kind is a friend everybody is
 * waiting on.
 */

export const TRAVEL_INTENTS = Object.freeze(['omw', 'need_ride']);
export const TRAVEL_MODES = Object.freeze(['walk', 'drive', 'transit']);
export const MAX_SEATS = 8;

const ROAD_FACTOR = 1.3;
const SPEED_KMH = Object.freeze({ walk: 4.8, drive: 28, transit: 18 });

export const MODE_LABEL = Object.freeze({ walk: 'walking', drive: 'driving', transit: 'on transit' });

/** True for a value the wire accepts as an intent. */
export const isTravelIntent = (v) => typeof v === 'string' && TRAVEL_INTENTS.includes(v);
/** True for a value the wire accepts as a mode. */
export const isTravelMode = (v) => typeof v === 'string' && TRAVEL_MODES.includes(v);

/**
 * The fields to put on the wire for a travel state, or an empty object for a
 * plain share. Everything is validated here so the emitter cannot send a
 * shape the server would drop, and seats only travel with a car.
 */
export function travelFields(travel) {
  if (!travel || typeof travel !== 'object') return {};
  const out = {};
  if (isTravelIntent(travel.intent)) out.intent = travel.intent;
  if (isTravelMode(travel.mode)) out.mode = travel.mode;
  if (out.mode === 'drive') {
    // Strict, like the server: '2' is not a seat count and is dropped there,
    // so it is dropped here rather than coerced into something it would refuse.
    const n = travel.seats;
    if (Number.isInteger(n) && n >= 0 && n <= MAX_SEATS) out.seats = n;
  }
  return out;
}

/**
 * Minutes to cover `distanceKm` by `mode`, or null when the mode is unknown:
 * with no mode there is no speed, and a distance is still worth showing but a
 * time would be invented.
 */
export function etaMinutes(distanceKm, mode) {
  if (distanceKm == null) return null;
  const d = Number(distanceKm);
  const speed = SPEED_KMH[mode];
  if (!Number.isFinite(d) || d < 0 || !speed) return null;
  return (d * ROAD_FACTOR) / speed * 60;
}

/**
 * "about 8 min", "under a minute", "about 1 hr 10 min". The word "about" is
 * part of the number, not decoration: see the header.
 */
export function formatEta(minutes) {
  if (minutes == null) return null;
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return null;
  if (m < 1) return 'under a minute';
  const whole = Math.round(m);
  if (whole < 60) return `about ${whole} min`;
  const hrs = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `about ${hrs} hr` : `about ${hrs} hr ${rest} min`;
}

/** "2.1 km away" / "400 m away", for a position with no mode. */
export function formatDistance(distanceKm) {
  if (distanceKm == null) return null;
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d < 0) return null;
  return d < 1 ? `${Math.max(50, Math.round(d * 1000 / 50) * 50)} m away` : `${d.toFixed(1)} km away`;
}
