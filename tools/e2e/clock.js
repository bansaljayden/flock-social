/* A LOCAL HOUR OF THE SPEC'S CHOOSING.
 *
 * The app changes with the local hour: auto mode paints it dark from 20:00 to
 * 06:00 (context/ThemeContext.js), and the Nest's day line says morning,
 * afternoon, evening or night (lib/nestTime.js). A spec that only ever runs
 * at whatever hour somebody happens to start it tests half of that.
 *
 * This moves the hour by moving the browser's time zone, not its clock.
 * Date.now() stays the real instant, so the session token, the server's
 * windows and every timer in the page agree with each other exactly as they
 * do on a phone; only getHours() changes. Etc/GMT zones carry the sign
 * backwards (Etc/GMT-9 is nine hours AHEAD of UTC), and they run from -14 to
 * +12, which covers every whole-hour offset a target hour can need.
 *
 * Worked out when the spec file loads, so a run that starts at 13:58 for a
 * 13:00 page can reach 14:xx before the last test. Pick hours with room on
 * both sides of a boundary (13 for day, 22 for night) and that cannot matter.
 */
'use strict';

function zoneForLocalHour(hour, now = new Date()) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`not an hour: ${hour}`);
  let offset = (((hour - now.getUTCHours()) % 24) + 24) % 24;
  if (offset > 14) offset -= 24;
  if (offset === 0) return 'Etc/UTC';
  return `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

/* hour:minute local, as a zone and an instant that agree: the zone above, and
   `now` with its minutes moved (the zones are whole hours, so the minutes are
   the same everywhere). For page.clock, when a spec has to sit on a screen
   while the hour turns. */
function localTime(hour, minute, now = new Date()) {
  const at = new Date(now.getTime());
  at.setUTCMinutes(minute, 0, 0);
  return { timezoneId: zoneForLocalHour(hour, now), at };
}

module.exports = { zoneForLocalHour, localTime };
