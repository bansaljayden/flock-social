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
// clock time, which is still true whenever it lands. Read on the recipient's
// own zone, the one quiet hours read (pushHelper.recipientZone: the device
// that last reported one), and on the venue's (ml_venues.timezone) for a
// recipient whose devices never named a zone. The "It's happening!" push in
// routes/flocks.js says no time because it had neither zone to hand. With
// neither here the distance is said as before, and it stays true: quiet hours
// hold nothing for a recipient with no zone (unless PUSH_QUIET_DEFAULT_TZ is
// set, and then that is the zone recipientZone answers with).

const pool = require('../config/database');
const { pushIfOffline, recipientZone } = require('./pushHelper');
const { flockSweepEnabled } = require('./flockSweep');
const { reconfirmLeadHours } = require('../utils/reconfirm');
const { validTimeZone, civilTime } = require('../utils/venueZone');
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

// The push's body: "<plan> starts at 8:30 PM." on `zone`'s clock, or "<plan>
// is in about 3 hours." when the zone or the instant cannot be read. eventMs
// may arrive as the numeric string EXTRACT gives.
function reconfirmBody({ where, eventMs, zone, hoursOut }) {
  const plan = where || 'Your plan';
  const z = validTimeZone(zone);
  const ms = eventMs == null ? NaN : Number(eventMs);
  const c = z ? civilTime(ms, z) : null;
  const when = c ? `starts at ${spokenClock(c.hour, c.minute)}` : `is ${hoursOutPhrase(hoursOut)}`;
  return `${plan} ${when}. Tap to say you're still coming.`;
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
      // start on the recipient's clock (WHAT THE PUSH SAYS, above). Each
      // member's zone is read alongside the others', not one after another.
      const where = [f.name, f.venue_name].filter(Boolean).join(' at ');
      pushes.push((async () => {
        const zone = validTimeZone(await recipientZone(row.user_id)) || validTimeZone(f.venue_zone);
        const bodyText = reconfirmBody({ where, eventMs: f.event_ms, zone, hoursOut: f.hours_out });
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
