'use strict';

// The night-of "still in?" window: OPENED here. Answered in routes/flocks.js
// (POST /:id/reconfirm) and routes/guest.js (POST /:token/reconfirm); shown by
// the chat and by the invite page. Migration 072 says why the window exists.
//
// WHY A SWEEP. The window opens a fixed lead before the plan's time for every
// confirmed plan, whether or not anybody is looking at it, so it is a clock's
// job and not a request's. Same shape as flockSweep.js, the same switch
// (FLOCK_SWEEP_ENABLED), the same never-rejects contract, and a tighter
// interval, because "three hours before" answered thirty minutes late is "two
// and a half hours before".
//
// WHICH PLANS. Confirmed, with a time, that time still ahead and within the
// lead, no window yet, and NOT TOUCHED IN THE LAST FIFTEEN MINUTES. The last
// clause needs saying. A plan confirmed inside the lead ("we're on, 9pm", said
// at 7) has just pushed "It's happening!" to everyone, and a "Still in?" behind
// it in the same minute is the same question twice. updated_at moves on every
// edit, so it is a proxy for "settled", not a record of when the confirm
// happened; what the proxy costs is a window that opens fifteen minutes later
// than the lead says, on a plan somebody was still editing, which is nothing.
//
// A plan whose time has already passed gets no window. There is nothing left
// to be still in for, and flockSweep.js will complete it.
//
// THE CLAIM IS A CLAIM. The inner select takes the rows FOR UPDATE SKIP
// LOCKED and the outer update re-checks the two predicates that another
// writer could have changed, so two sweeps (a second replica, a kickoff
// overlapping a tick) cannot both open the same window and push the same
// people twice, and an un-confirm landing mid-sweep is not overwritten.
//
// TIMES. flocks.event_time and updated_at are naive TIMESTAMP columns holding
// UTC wall-clock (the reading flockSweep.js and routes/flocks.js use), so every
// comparison is against NOW() AT TIME ZONE 'UTC'.
//
// WHAT THE PUSH SAYS (2026-11-17). It used to say how far off the plan was,
// "in about 3 hours", worked out when the window opened. Quiet hours hold
// this push until 08:00 on the recipient's clock (services/pushHelper.js), so
// a window that opened at 05:30 for an 08:30 plan landed at 08:00 still saying
// "in about 3 hours" about a plan half an hour away. It now names the start as a
// clock time, which is still true whenever it lands.
//
// WHOSE CLOCK (2026-11-18). The VENUE'S (ml_venues.timezone), as the app shows
// a plan's time everywhere else: the place is where the plan happens. It used
// to be the recipient's device zone first, and that zone is refreshed only on
// sign-in, cold start and token rotation, so a member who flew to Chicago with
// a phone row still saying New York was told 8:30 PM for a 7:30 PM CDT plan.
// When a device of theirs has reported a zone (pushHelper.reportedZone, never
// the PUSH_QUIET_DEFAULT_TZ stand-in) and its clock at the start reads
// differently from the venue's, the time carries the venue zone's short name,
// "7:30 PM CDT", the rule the app's own event screens follow
// (frontend/src/lib/eventWhereWhen.js eventTimeZoneLabel). With no venue zone,
// the device's reported clock, unlabelled. With neither, the distance, as
// before; the default zone is nobody's clock and never names a time.
//
// WHICH DAY. FLOCK_RECONFIRM_LEAD_HOURS goes up to 24, so the plan can be on
// another day than the push. On the clock the time is said on, compared with
// the day the push will LAND (now, or the end of the quiet hours that hold it,
// read on the zone quiet hours read): the same day says no day; the next says
// "tomorrow", except that a start in the small hours (before 5 AM, routes/
// advisor.js THE SMALL HOURS) is "tonight", the night still running, and a push
// landing in the small hours names the weekday, since "tomorrow" at 1 AM is
// heard both ways; further off, the weekday.

const pool = require('../config/database');
const { pushIfOffline, recipientZone, reportedZone, quietWindowEnd } = require('./pushHelper');
const { flockSweepEnabled } = require('./flockSweep');
const { reconfirmLeadHours } = require('../utils/reconfirm');
const { validTimeZone, civilTime, civilWeekday, zoneOffsetMinutes } = require('../utils/venueZone');
// How the app says an hour: "8:30 PM", "9 PM", "midnight", "noon".
const { spokenClock } = require('./clockWords');
// Each run reports to the stalled-job check (utils/serverFault.js).
const { recordJobRun } = require('../utils/serverFault');

const RECONFIRM_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// See "NOT TOUCHED IN THE LAST FIFTEEN MINUTES" above.
const SETTLE_MINUTES = 15;
// Bounded like flockSweep.js: a single pass never touches more than this many
// plans, and the next pass is five minutes away.
const SWEEP_BATCH_SIZE = 200;

// "in about 3 hours" / "in about an hour" / "soon". Rounded. Said only when no
// zone is known (see WHAT THE PUSH SAYS above).
function hoursOutPhrase(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0.75) return 'soon';
  const whole = Math.round(h);
  if (whole <= 1) return 'in about an hour';
  return `in about ${whole} hours`;
}

// The small hours, midnight to 5 AM, belong to the night before
// (routes/advisor.js SMALL_HOURS_END).
const SMALL_HOURS_END = 5;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 24 * 60 * 60 * 1000;

// "GMT+1", "GMT-6", "GMT+5:30": Intl's own form for a zone with no short name
// (the frontend's gmtLabel).
function gmtLabel(offsetMinutes) {
  if (offsetMinutes === 0) return 'GMT';
  const abs = Math.abs(offsetMinutes);
  const minutes = abs % 60;
  return `GMT${offsetMinutes < 0 ? '-' : '+'}${Math.floor(abs / 60)}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

// `zone`'s short name at instant `ms` ("CDT", "EST", "GMT+1"), or null.
function zoneLabel(ms, zone) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(ms).find((p) => p.type === 'timeZoneName');
    if (name && name.value) return name.value;
  } catch {
    // Falls through to the offset.
  }
  const off = zoneOffsetMinutes(ms, zone);
  return off == null ? null : gmtLabel(off);
}

const sameWall = (a, b) => Boolean(a && b) && a.year === b.year && a.month === b.month && a.day === b.day
  && a.hour === b.hour && a.minute === b.minute;

// The day word for a start at `plan` said at `land` (both civilTime on one
// clock): '' for the same day, else 'tonight', 'tomorrow' or a weekday (WHICH
// DAY, above).
function dayWord(plan, land) {
  const days = Math.round((Date.UTC(plan.year, plan.month - 1, plan.day) - Date.UTC(land.year, land.month - 1, land.day)) / DAY_MS);
  if (days <= 0) return '';
  const weekday = WEEKDAYS[civilWeekday(plan.year, plan.month, plan.day)];
  if (days >= 2) return weekday;
  if (land.hour < SMALL_HOURS_END) return weekday;
  return plan.hour < SMALL_HOURS_END ? 'tonight' : 'tomorrow';
}

// The push's body: "<plan> starts at 7:30 PM." on the venue's clock, with the
// venue zone's name when the recipient's device reads another clock ("starts at
// 7:30 PM CDT"), on the device's reported clock when the venue has no zone, and
// "<plan> is in about 3 hours." with neither or no instant. A day word goes
// before the time when the start is not on the day the push lands (`nowMs`).
// eventMs and nowMs may arrive as the numeric strings EXTRACT gives.
function reconfirmBody({ where, eventMs, venueZone, deviceZone, hoursOut, nowMs = Date.now() }) {
  const plan = where || 'Your plan';
  const venue = validTimeZone(venueZone);
  const device = validTimeZone(deviceZone);
  const clockZone = venue || device;
  const ms = eventMs == null ? NaN : Number(eventMs);
  const c = clockZone ? civilTime(ms, clockZone) : null;
  if (!c) return `${plan} is ${hoursOutPhrase(hoursOut)}. Tap to say you're still coming.`;
  const label = venue && device && !sameWall(c, civilTime(ms, device)) ? zoneLabel(ms, venue) : null;
  const land = civilTime(Number(nowMs), clockZone);
  const day = land ? dayWord(c, land) : '';
  const when = `starts ${day ? `${day} ` : ''}at ${spokenClock(c.hour, c.minute)}${label ? ` ${label}` : ''}`;
  return `${plan} ${when}. Tap to say you're still coming.`;
}

// When a push composed at `nowMs` lands: the end of the quiet hours that would
// hold it on `quietZone` (the zone pushHelper's quiet hours read), else now.
function landingMs(quietZone, nowMs) {
  const zone = validTimeZone(quietZone);
  const release = zone ? quietWindowEnd(zone, new Date(nowMs)) : null;
  return release ? release.getTime() : nowMs;
}

// NEVER REJECTS. It runs inside setInterval, where an unhandled rejection is a
// process-level event; every failure is logged and the count so far returned.
async function runReconfirmSweep(io) {
  if (!flockSweepEnabled()) return 0;
  const lead = reconfirmLeadHours();
  let opened = [];
  try {
    const result = await pool.query(
      `UPDATE flocks
          SET reconfirm_opened_at = NOW(), updated_at = NOW()
        WHERE id IN (
          SELECT id FROM flocks
           WHERE status = 'confirmed'
             AND reconfirm_opened_at IS NULL
             AND event_time IS NOT NULL
             AND event_time > (NOW() AT TIME ZONE 'UTC')
             AND event_time <= (NOW() AT TIME ZONE 'UTC') + make_interval(hours => $1::int)
             AND updated_at <= (NOW() AT TIME ZONE 'UTC') - make_interval(mins => $2::int)
           ORDER BY event_time
           LIMIT $3::int
           FOR UPDATE SKIP LOCKED
        )
          AND status = 'confirmed'
          AND reconfirm_opened_at IS NULL
        RETURNING id, name, venue_name, event_time,
                  EXTRACT(EPOCH FROM (event_time - (NOW() AT TIME ZONE 'UTC'))) / 3600 AS hours_out,
                  EXTRACT(EPOCH FROM (event_time AT TIME ZONE 'UTC')) * 1000 AS event_ms,
                  (SELECT v.timezone FROM ml_venues v WHERE v.google_place_id = flocks.venue_id LIMIT 1) AS venue_zone`,
      [lead, SETTLE_MINUTES, SWEEP_BATCH_SIZE]
    );
    opened = result.rows || [];
    if (opened.length === 0) {
      recordJobRun('reconfirmSweep', true, null, RECONFIRM_SWEEP_INTERVAL_MS);
      return 0;
    }
    console.log(`[reconfirmSweep] opened ${opened.length} window${opened.length === 1 ? '' : 's'} (${lead}h lead)`);

    // Everyone who said yes is asked again. Members reach here through their
    // personal rooms (wherever they are in the app) and through a push if
    // they are not in it; guests are asked by the page they already have the
    // link to, because the link is the only address a guest has.
    const members = await pool.query(
      `SELECT flock_id, user_id FROM flock_members
        WHERE flock_id = ANY($1::int[]) AND status = 'accepted'`,
      [opened.map((f) => f.id)]
    );
    const byFlock = new Map(opened.map((f) => [f.id, f]));
    const pushes = [];
    for (const row of members.rows || []) {
      const f = byFlock.get(row.flock_id);
      if (!f) continue;
      if (io) {
        try {
          io.to(`user:${row.user_id}`).emit('flock_reconfirm_opened', {
            flockId: row.flock_id,
            deadline: f.event_time,
          });
        } catch (err) {
          console.error('[reconfirmSweep] socket fan-out failed:', err.message);
        }
      }
      // Same voice as "It's happening!": the plan and the place, and then the
      // start on the venue's clock (WHOSE CLOCK and WHICH DAY, above). Each
      // member's zones are read alongside the others', not one after another.
      const where = [f.name, f.venue_name].filter(Boolean).join(' at ');
      // The database's now, as the row gives it: the start less how far off it is.
      const dbNow = f.event_ms == null || f.hours_out == null ? NaN : Number(f.event_ms) - Number(f.hours_out) * 3600000;
      const nowMs = Number.isFinite(dbNow) ? dbNow : Date.now();
      pushes.push((async () => {
        const [deviceZone, quietZone] = await Promise.all([reportedZone(row.user_id), recipientZone(row.user_id)]);
        const bodyText = reconfirmBody({
          where, eventMs: f.event_ms, venueZone: f.venue_zone, deviceZone, hoursOut: f.hours_out,
          nowMs: landingMs(quietZone, nowMs),
        });
        return pushIfOffline(io, row.user_id, 'Still in?', bodyText,
          { type: 'flock_reconfirm', flockId: String(row.flock_id) });
      })());
    }
    // allSettled: one member's failed delivery must not abort the rest, and
    // pushIfOffline is not guaranteed to hand back a promise (see
    // routes/budget.js on the same point).
    await Promise.allSettled(pushes);
    recordJobRun('reconfirmSweep', true, null, RECONFIRM_SWEEP_INTERVAL_MS);
    return opened.length;
  } catch (err) {
    console.error('[reconfirmSweep] sweep failed:', err.message);
    recordJobRun('reconfirmSweep', false, err, RECONFIRM_SWEEP_INTERVAL_MS);
    return opened.length;
  }
}

module.exports = {
  runReconfirmSweep,
  hoursOutPhrase,
  reconfirmBody,
  RECONFIRM_SWEEP_INTERVAL_MS,
  SETTLE_MINUTES,
  SWEEP_BATCH_SIZE,
};
