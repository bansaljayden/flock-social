// ---------------------------------------------------------------------------
// A VENUE'S OWN CLOCK, FROM ITS IANA TIME ZONE.
//
// Google's `utcOffsetMinutes` is the offset in force at the venue when the
// Places payload was fetched. It is the right number for "now" and the wrong
// one for every hour on the far side of the venue's next clock change. On
// 2026-11-01 a New York bar is at UTC-4 until 2 AM and at UTC-5 after it, so a
// forecast built with Saturday's -240 put every later Sunday hour's weather and
// event window an hour early, drew the repeated 1 AM once as if nothing
// happened, and on the March night drew a 2 AM the wall clock never shows.
//
// The offset in force at each hour comes from the zone's rules, and Google
// names the zone: Places API (New) `timeZone`, `{ id: "America/New_York" }`.
// It is a Pro field in Place Details, Text Search and Nearby Search, the same
// tier as utcOffsetMinutes, so every mask in this repo that feeds the crowd
// model (each already buys Enterprise fields) carries it at no extra charge.
// ml_venues.timezone holds the same kind of name for corpus venues.
//
// A venue with no zone (an older payload, a client-assembled batch row) keeps
// the fixed offset. Nothing here throws on a bad or missing name; every
// function answers null or an empty list and the caller falls back.
//
// Intl only. Node ships full ICU and the repo has no date library; four
// conversions did not justify adding one.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// What an IANA name can look like before ICU is asked about it: letters,
// digits and the punctuation real names use ("America/Port-au-Prince",
// "Etc/GMT+5", "America/Argentina/Buenos_Aires"), at most 64 characters, the
// same ceiling device_tokens.timezone uses. Anything else is not a zone and
// never reaches Intl.
const ZONE_NAME_RE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

// ONE formatter, for the last zone asked about. Building an
// Intl.DateTimeFormat costs about eight times what formatting with one does,
// and a forecast strip asks the same zone twenty-odd questions in a row, so
// remembering one zone takes nearly all of the saving. A single slot rather
// than a map: it cannot grow, and a request for another zone costs one rebuild.
let memoZone = null;
let memoFormatter = null;

function formatterFor(zone) {
  if (zone === memoZone && memoFormatter) return memoFormatter;
  // Throws a RangeError for a name ICU does not know. Callers catch it.
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  memoZone = zone;
  memoFormatter = f;
  return f;
}

/**
 * The zone name when this runtime can use it, else null. Never throws.
 * @param {unknown} zone
 * @returns {string|null}
 */
function validTimeZone(zone) {
  if (typeof zone !== 'string' || !ZONE_NAME_RE.test(zone)) return null;
  try {
    formatterFor(zone);
    return zone;
  } catch {
    return null;
  }
}

/**
 * Google's `timeZone` off a Places payload, as a usable IANA name or null.
 * Accepts the documented `{ id }` object and a bare string, so a place shaped
 * either way reads the same.
 * @param {object|null|undefined} place
 * @returns {string|null}
 */
function placeTimeZone(place) {
  const tz = place ? place.timeZone : null;
  if (typeof tz === 'string') return validTimeZone(tz);
  if (tz && typeof tz === 'object' && typeof tz.id === 'string') return validTimeZone(tz.id);
  return null;
}

/**
 * The wall clock in `zone` at instant `ms`: { year, month (1-12), day,
 * hour (0-23), minute, second }, or null for an unusable zone or instant.
 */
function civilTime(ms, zone) {
  if (!Number.isFinite(ms)) return null;
  let parts;
  try {
    parts = formatterFor(zone).formatToParts(ms);
  } catch {
    return null;
  }
  const f = {};
  for (const p of parts) f[p.type] = p.value;
  const out = {
    year: Number(f.year),
    month: Number(f.month),
    day: Number(f.day),
    // hourCycle h23 prints midnight as 00; the modulo is for an ICU that
    // still says 24.
    hour: Number(f.hour) % 24,
    minute: Number(f.minute),
    second: Number(f.second),
  };
  for (const k of Object.keys(out)) {
    if (!Number.isInteger(out[k])) return null;
  }
  return out;
}

/** Weekday (0 = Sunday) of a civil date. */
function civilWeekday(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Minutes east of UTC in force in `zone` at instant `ms` (Google's sign:
 * -240 is New York in summer), or null.
 */
function zoneOffsetMinutes(ms, zone) {
  const c = civilTime(ms, zone);
  if (!c) return null;
  const wall = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  const whole = ms - (((ms % 1000) + 1000) % 1000);
  return Math.round((wall - whole) / 60000);
}

// Wall-clock fields as the epoch number they would be if they were UTC. Two
// wall times compare equal exactly when these numbers do.
function wallNumber(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour, minute || 0);
}

/**
 * Every instant at which `zone`'s wall clock reads the given date and time,
 * earliest first: one normally, none inside a spring-forward gap, two inside a
 * fall-back overlap.
 */
function wallClockInstants(year, month, day, hour, minute, zone) {
  const wall = wallNumber(year, month, day, hour, minute);
  if (!Number.isFinite(wall)) return [];
  const found = new Set();
  // The offsets in force a day before, at, and a day after the wall time
  // cover every offset that could apply: no zone changes its clock twice
  // inside two days. Each candidate is kept only if the zone reads it back as
  // the same wall time, which is what rejects a time inside a gap.
  for (const probe of [wall - DAY_MS, wall, wall + DAY_MS]) {
    const off = zoneOffsetMinutes(probe, zone);
    if (off == null) continue;
    const t = wall - off * 60000;
    const back = civilTime(t, zone);
    if (back && wallNumber(back.year, back.month, back.day, back.hour, back.minute) === wall) {
      found.add(t);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The one instant a wall-clock time stands for in `zone`.
 *
 *   - A time the clock never shows (spring forward, 2:00 to 2:59 in New York
 *     on 2027-03-14) is read with the offset in force before the change, so
 *     2:00 lands on the instant the clock jumps to, 3:00.
 *   - A time the clock shows twice (fall back, 1:00 to 1:59 on 2026-11-01) is
 *     the first showing whose hour has not ended at `nowMs`, and the first
 *     showing when both have. So the current hour, asked for during the second
 *     1 AM, is that second 1 AM; every other request means the first.
 *
 * Null only when the zone is unusable.
 * @param {{year:number, month:number, day:number, hour:number, minute?:number}} wall
 * @param {string} zone
 * @param {number} [nowMs]
 * @returns {number|null}
 */
function instantForWallClock(wall, zone, nowMs = Date.now()) {
  const { year, month, day, hour } = wall || {};
  const minute = (wall && wall.minute) || 0;
  const found = wallClockInstants(year, month, day, hour, minute, zone);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    const unfinished = found.find((t) => t + HOUR_MS > nowMs);
    return unfinished != null ? unfinished : found[0];
  }
  const w = wallNumber(year, month, day, hour, minute);
  if (!Number.isFinite(w)) return null;
  const before = zoneOffsetMinutes(w - DAY_MS, zone);
  return before == null ? null : w - before * 60000;
}

/**
 * The venue's hour and weekday at instant `ms`, plus the offset in force, or
 * null for an unusable zone. The zone-aware half of crowdEngine.venueLocalNow.
 */
function clockInZone(ms, zone) {
  const c = civilTime(ms, zone);
  if (!c) return null;
  const offset = zoneOffsetMinutes(ms, zone);
  return {
    hour: c.hour,
    day: civilWeekday(c.year, c.month, c.day),
    utcOffsetMinutes: offset,
  };
}

module.exports = {
  validTimeZone,
  placeTimeZone,
  civilTime,
  civilWeekday,
  zoneOffsetMinutes,
  wallClockInstants,
  instantForWallClock,
  clockInZone,
  HOUR_MS,
};
