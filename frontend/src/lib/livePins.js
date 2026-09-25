/**
 * Live pins: when a flock member's shared position comes off this device.
 *
 * WHY THIS FILE EXISTS. App.js keeps one map of member positions for the whole
 * session, `flockMemberLocations`, keyed by user id with the flock each one
 * came from, and it used to take an entry out on exactly one event:
 * member_stopped_sharing. Everything else left the pin where it was, green dot
 * and all, until the app was reloaded:
 *
 *   - blocking the person (the server stops sending, the last position stays);
 *   - the person leaving the plan, or the plan being deleted;
 *   - the host calling the plan off, or the plan finishing;
 *   - a stop that never arrived because this device was offline when it was
 *     sent (the server announces it once and does not replay it).
 *
 * A pin that says somebody is somewhere they left is the one failure a live
 * location must not have, so each of those now drops the pin, through the
 * three functions below. They are pure, so App.js's handlers stay one line
 * each and the rules are tested without mounting the app.
 *
 * Every function returns the SAME object when there is nothing to drop, so a
 * state updater built on one bails out instead of re-rendering the map.
 */

/** How often a sharer's app sends its position (App.js's emit loop). */
export const LOCATION_EMIT_MS = 10 * 1000;

/**
 * How long a pin may go without a position before it comes off: six missed
 * sends. A sharer on a live share sends every LOCATION_EMIT_MS whether or not
 * they moved, so a full minute of silence is not one slow packet, it is a
 * share that ended without its stop reaching this device, or a sharer the
 * server can no longer reach. Short of that the map keeps the pin, and its
 * popup's "Ns ago" is the age it already shows; there is no second,
 * greyed-out design for a fading pin, and no pin outlives this.
 */
export const PIN_STALE_AFTER_MS = 6 * LOCATION_EMIT_MS;

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Drop one person's pin. With `flockId`, only while the pin is that plan's: a
 * person sharing in two of the reader's plans who leaves one is still sharing
 * in the other. A pin with no flock on it (an older server) is dropped either
 * way, as a stop has always dropped it.
 */
export function withoutPersonPin(pins, userId, flockId) {
  if (!pins || userId == null) return pins;
  const key = String(userId);
  const entry = pins[key];
  if (!entry) return pins;
  if (flockId != null && entry.flockId != null && !sameId(entry.flockId, flockId)) return pins;
  const next = { ...pins };
  delete next[key];
  return next;
}

/** Drop every pin that belongs to any of these plans (one id or a list). */
export function withoutFlockPins(pins, flockIds) {
  const ids = new Set((Array.isArray(flockIds) ? flockIds : [flockIds])
    .filter((id) => id != null)
    .map(String));
  if (!pins || ids.size === 0) return pins;
  let next = null;
  for (const [key, entry] of Object.entries(pins)) {
    if (entry && entry.flockId != null && ids.has(String(entry.flockId))) {
      if (!next) next = { ...pins };
      delete next[key];
    }
  }
  return next || pins;
}

/**
 * Drop every pin not heard from for longer than `maxAgeMs`. Measured from
 * `receivedAt`, this device's own clock at the moment the position arrived,
 * rather than the server's `timestamp`: a phone whose clock runs a couple of
 * minutes fast would otherwise drop every pin the moment it landed. The
 * server's time is the fallback for an entry that has no receipt time, and a
 * pin with neither cannot be shown to be live, so it goes.
 */
export function withoutStalePins(pins, now = Date.now(), maxAgeMs = PIN_STALE_AFTER_MS) {
  if (!pins) return pins;
  let next = null;
  for (const [key, entry] of Object.entries(pins)) {
    const heard = Number(entry && (entry.receivedAt != null ? entry.receivedAt : entry.timestamp));
    if (!Number.isFinite(heard) || now - heard > maxAgeMs) {
      if (!next) next = { ...pins };
      delete next[key];
    }
  }
  return next || pins;
}
