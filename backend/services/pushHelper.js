// ---------------------------------------------------------------------------
// Push Notification Helper
//
// Every push in the app goes through here. Three things happen before a
// notification is allowed out:
//   1. online check  — the user is already looking at the thing
//   2. visibility    — the user can still SEE the thing the push is about
//   3. debounce      — per conversation, not per person
//
// ---------------------------------------------------------------------------
// App Review 4.5.4 — the classification every push in this app lives under
//
// The guideline (current text, developer.apple.com/app-store/review/guidelines):
//   "Push Notifications must not be required for the app to function, and
//    should not be used to send sensitive personal or confidential
//    information. Push Notifications should not be used for promotions or
//    direct marketing purposes unless customers have explicitly opted in to
//    receive them via consent language displayed in your app's UI, and you
//    provide a method in your app for a user to opt out from receiving such
//    messages."
//
// Every push this backend sends today is TRANSACTIONAL: it reports a concrete
// thing that happened to a plan, conversation, or account the recipient is
// already part of. The full inventory, by data.type:
//
//   flock_invite       someone invited the recipient          (routes/flocks.js)
//   flock_rsvp         someone joined the recipient's flock   (routes/flocks.js)
//   flock_confirmed    a plan the recipient accepted is on    (routes/flocks.js)
//   flock_reconfirm    a plan they said yes to is hours away  (services/reconfirmSweep.js)
//   attendance_marked  the recipient's own score changed      (routes/flocks.js)
//   flock_message      chat in a flock they belong to         (routes/messages.js, sockets/handlers.js)
//   dm_message         a DM addressed to them                 (routes/messages.js, sockets/handlers.js)
//   friend_request     someone asked to be their friend       (routes/friends.js)
//   guest_rsvp         a guest joined the host's flock        (routes/guest.js)
//   budget_ready       their group's budget resolved          (routes/budget.js)
//   budget_reminder    the organizer asked them to submit     (routes/budget.js, user-initiated)
//   bill_created       they owe a share of a real bill        (routes/billing.js)
//   moderation_report  admin-only: a report needs review      (services/moderationAlerts.js)
//   crowd_alert        forecast for an event they committed to (services/crowdAlerts.js)
//
// crowd_alert is the only push not directly triggered by a person's action, so
// it sits closest to the 4.5.4 line and carries its own user switch
// (user_settings.settings.crowdAlerts). That switch is enforced twice: at the
// producer (services/crowdAlerts.js filters recipients before claiming the
// alert) and again below in deliver(), so no future caller can reuse the type
// and skip the check.
//
// THE RULE FOR ADDING A PUSH. If the notification promotes anything — Flock
// Pro, an upgrade, a venue's offer or slow night, a discount, a "we miss you"
// re-engagement nudge — it is a promotion or direct marketing under 4.5.4 and
// it MUST NOT ship on the transactional inventory above. It needs its own
// explicit opt-IN collected through consent language in the app UI (not a
// pre-checked default, not this file's default-on switch), its own opt-out,
// and its own data.type so both are enforceable here. No such push exists
// today; do not be the first without all three pieces.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { isBlockedBetween } = require('../utils/blocks');
// Held as a module object, not destructured: routes and tests replace the
// exported function, and a destructured copy would keep calling the original.
const firebaseService = require('./firebaseService');
// The words of an SOS alarm and its all-clear, for when rule 4 has to build one
// again (see AN SOS ALARM MUST NOT OUTLIVE ITS ALL-CLEAR below).
const { alarmPush, allClearPush } = require('./sosPushes');
// The pushes that carry a bill's figure, which a quarantined bill never sends
// (see checkVisibility).
const { BILL_PUSH_TYPES } = require('../db/billQuarantine');

// Debounce map: key -> timestamp of last push sent
const lastPushSent = new Map();
const DEBOUNCE_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// THE DELIVERY LEDGER (migration 050, table push_sends)
//
// Until 2026-08-25 nobody could answer "has a single push ever been delivered
// in production". sendPushToUser answered { sent, failed } and every caller
// except services/crowdAlerts.js discarded it, so a notification that never
// left the building and one that landed on a lock screen left identical
// evidence behind: none.
//
// This is deliberately the SMALLEST thing that answers the question honestly,
// not an analytics pipeline. One row per push attempt, written here because
// here is the one place every push in the app passes through, plus one
// structured console line so the same answer is greppable in Railway logs
// without a database at all.
//
// WHAT IT DOES NOT STORE: the title, the body, or any token. A notification
// body is a private message and a lock-screen preview. It has no business
// outliving the notification inside a counts table.
//
// HOW TO READ IT (this is the query, there is no dashboard yet, because the
// admin cost panel is rendered from frontend/src/App.js which this change does
// not own):
//
//   SELECT date_trunc('day', created_at) AS day, push_type, outcome,
//          COUNT(*) AS pushes, SUM(devices_sent) AS devices
//     FROM push_sends
//    WHERE created_at >= NOW() - INTERVAL '7 days'
//    GROUP BY 1, 2, 3
//    ORDER BY 1 DESC, pushes DESC;
//
// pushDeliveryStats() below returns exactly that rollup, so a panel line is
// one call away whenever App.js is free to take it.
//
// Retention is 30 days (sweepPushMaintenance). "Did pushes go out this week"
// is the question; a year of rows answers it no better.
// ---------------------------------------------------------------------------
const OUTCOME = {
  DELIVERED: 'delivered',
  NO_DEVICE: 'no-device',
  FAILED: 'failed',
  ONLINE: 'online',
  DEBOUNCED: 'debounced',
  NOT_VISIBLE: 'not-visible',
  // "The visibility check itself failed", as opposed to NOT_VISIBLE's "we
  // checked and the answer was no". Both suppress the push - canNotify fails
  // closed on purpose and that does not change - but only one of them is a
  // permanent property of the recipient. The outbox sweep used to read them as
  // the same thing and DELETE the row, so a Postgres blip during the 08:00
  // release of a quiet-hours DM destroyed the notification outright: the retry
  // rows, the TTLs and the FOR UPDATE SKIP LOCKED this whole file exists for
  // never engaged, and the ledger recorded it as a legitimate suppression.
  UNCHECKABLE: 'visibility-uncheckable',
  OPTED_OUT: 'opted-out',
  QUIET_HELD: 'quiet-held',
  QUIET_DROPPED: 'quiet-dropped',
  EXPIRED: 'expired',
  // An SOS alarm for an alert its sender has since stood down, and a late
  // all-clear held back from somebody a newer alarm has reached. See AN SOS
  // ALARM MUST NOT OUTLIVE ITS ALL-CLEAR below.
  WITHDRAWN: 'withdrawn',
  SUPERSEDED: 'superseded',
};
const LEDGER_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// QUIET HOURS
//
// WHAT "NIGHT" MEANS FOR THIS PRODUCT. The obvious quiet window for a consumer
// app is something like 21:00 to 08:00. Applied here it would delete the app.
// Flock exists so that people aged 15 to 22 can arrange to go out, and going
// out happens between roughly 20:00 and 01:00. Those are the hours the product
// is FOR. Muting them would mean the invite, the "we moved to the other bar"
// and the "where are you" all arrive silently at exactly the moment they are
// the only thing that matters.
//
// The window that is actually dead for this audience is the one AFTER the
// night ends and BEFORE the day starts: people get home somewhere between
// 01:00 and 02:00, and school or an early shift starts around 08:00. So:
//
//     quiet hours are 02:00 to 08:00, on the RECIPIENT's clock.
//
// 02:00 rather than 01:00 because a group still out at 01:30 is still
// coordinating, and a phone that is in someone's hand at 01:30 has a live
// socket anyway, so presence already suppresses it. 08:00 rather than 09:00
// because this audience is awake for school before 09:00, and a message held
// past the moment they wake up is a message they read in the app first, which
// makes the notification pointless.
//
// THEY DEFER, THEY DO NOT DROP. A quiet-hours push is written to push_outbox
// and released when the window closes. Dropping would mean the product
// silently decides which of your messages you are allowed to be told about.
// Deferring costs one notification at 08:00 that collapses, on the device,
// with every other message from the same conversation (services/firebaseService
// .js sets an apns-collapse-id and an Android collapseKey per conversation), so
// a forty-message group chat overnight is one line in the morning.
//
// WHY THIS IS THE HIGHEST-VALUE ITEM IN THE FILE. The failure it prevents is
// not "a user is mildly annoyed". It is a 15 year old whose phone rings at
// 03:00, who turns notifications off in iOS Settings, which iOS never asks
// about again. That is one user permanently unreachable per incident, and it
// is unrecoverable without them going and finding the switch themselves.
//
// WHAT BREAKS THROUGH. Two kinds, and the list is short on purpose:
//   * safety. An SOS is the one message whose entire value is that it wakes
//     somebody up. routes/safety.js sends safety_alert to the flockmates of a
//     plan that is on tonight, and safety_alert_cancelled when the SOS is
//     withdrawn; 'sos' and 'emergency_alert' are held in reserve so a future
//     producer is exempt from the day it is written.
//   * moderation_report, which is admin-only and includes child-safety
//     reports. There is one admin, and a child-safety report at 03:00 is
//     exactly the thing that should wake him.
// Nothing else. Not a DM, not a flock invite, not "your plan is confirmed".
//
// WHAT IS DROPPED RATHER THAN HELD. crowd_alert, and only crowd_alert. It
// fires inside the three hours before an event and says "head out now"; held
// until 08:00 it is a sentence about an evening that already happened. It is
// also the app's only unsolicited push, so the one hour it must not arrive at
// is the one nobody asked for it in. services/crowdAlerts.js releases its
// once-per-flock claim when nothing was delivered, so the flock is not
// permanently marked as alerted.
//
// WHOSE CLOCK. device_tokens.timezone, the IANA name the device itself reports
// (migration 050). NULL means unknown, and unknown means DO NOT DEFER: holding
// a message for six hours because we guessed the wrong continent is a worse
// failure than one badly timed notification. PUSH_QUIET_DEFAULT_TZ exists as an
// explicit opt-in for rows that predate the column, and is unset by default.
// ---------------------------------------------------------------------------
const QUIET_START_HOUR = 2;
const QUIET_END_HOUR = 8;
const RINGS_THROUGH_THE_NIGHT = new Set([
  'sos',
  'emergency_alert',
  'safety_alert',
  // The withdrawal of the above. Anyone it reaches was already woken by the
  // alarm and is worrying or moving; an all-clear held until morning is a
  // night spent acting on an emergency that ended.
  'safety_alert_cancelled',
  'moderation_report',
]);
const DROPPED_IN_QUIET_HOURS = new Set(['crowd_alert']);

// Types whose PRODUCER already owns a durable retry, so the outbox must keep
// its hands off them or the same notification goes out twice.
//
// crowd_alert is the one. services/crowdAlerts.js releases its
// crowd_alert_sends claim whenever nothing was delivered, which means the next
// 15 minute sweep rebuilds and re-sends the alert by itself. An outbox retry on
// top of that is two copies of the same push racing each other, and the alert
// is the app's only unsolicited notification, so a duplicate is the worst place
// to have one. The claim is also strictly better than a retry here: it re-scores
// the venue against a fresh forecast instead of replaying an old sentence.
const OWN_RETRY = new Set(['crowd_alert']);

// Types queued for retry when their visibility check could not be answered,
// rather than dropped. canNotify fails closed on purpose and the reasoning
// there stands: a message, a plan or a bill waits in the app and is seen the
// moment it is opened. An SOS and its stand-down do not wait anywhere. The
// socket emit is never replayed, nothing on launch loads a pending alarm, and
// routes/safety.js sends these once, so a Postgres blip during the check was
// an offline flockmate never being told. The same set that rings through the
// night, for the same reason: these are the pushes whose whole value is
// reaching somebody now.
const UNCHECKABLE_RETRIED = RINGS_THROUGH_THE_NIGHT;

// ---------------------------------------------------------------------------
// AN SOS ALARM MUST NOT OUTLIVE ITS ALL-CLEAR, NOR AN ALL-CLEAR A NEWER ALARM
//
// safety_alert and safety_alert_cancelled share one lock-screen slot per
// sender (firebaseService.collapseId), so whichever reaches a phone last is
// what the phone shows, and the provider takes pushes in whatever order their
// sends finish. Both orders have gone wrong:
//
//   * An alarm landing after "I'm OK". A push not yet handed to the provider
//     when the stand-down committed, a send still running at the 8 second
//     deadline (firebase-admin keeps retrying it well past that), or a retry
//     waiting in the outbox put "needs help" back over "says they are OK", and
//     a tap on it opened the full-screen alarm on any build that has not seen
//     the stand-down. The stand-down's DELETE of queued alarms
//     (routes/safety.js) runs once, so a retry queued after it, by a send that
//     failed late, went out a minute later.
//   * An all-clear landing after a NEWER alarm. "I'm OK" more than two minutes
//     after an alert is past every hold, so a new SOS goes straight out, and
//     an all-clear for the old alert still at the provider landed on top of
//     the new alarm: the phone said "says they are OK" while the person needed
//     help. That is the worse of the two, because it hides an emergency.
//
// Five rules, read off emergency_alerts: withdrawn_at (migration 084), the
// audience each alert recorded (flock_recipient_ids, migration 063), and when
// the alert was raised (created_at).
//
//   1. NO ALARM FOR AN ALERT THAT HAS BEEN STOOD DOWN. Each alarm push names
//      its alert (alertId, which the server keeps and never sends to a device)
//      and is checked just before it is sent, fresh or released from the
//      outbox, and the sweep deletes a row this refuses. A row queued before
//      alertId existed asks about the sender's newest alert instead.
//   2. NO RETRY FOR ONE EITHER. A send that fails after the stand-down,
//      because it was still running at the deadline, is not queued at all.
//   3. NO ALL-CLEAR OVER A NEWER ALARM. No all-clear is sent to somebody a
//      newer alert from the same person has reached since, the stand-down's
//      own included. A stand-down withdraws every alert standing in its
//      window, so a standing alert raised after the sender's last stand-down
//      is the newer one. The stand-down's own all-clear used to be exempt, and
//      its flock leg can wait on a slow audience read for long enough that a
//      new SOS goes out and lands first.
//   4. WHAT EACH DEVICE RECEIVED LAST IS CHECKED AGAINST POSTGRES. Rules 1 to 3
//      decide before a send, a send already at the provider cannot be
//      recalled, and one person's devices do not hear in step: a push answers
//      only once every device has, so the order pushes answer in is not the
//      order any one device received them in. So every SOS push to one person
//      from one sender is registered below from before its checks until its
//      answer, the moment each device accepts a copy is recorded, and once the
//      last of them still on its way has answered, each device's last copy is
//      compared with the newest alert of that sender whose recorded audience
//      holds this person. If that alert stands, its alarm must be the last
//      thing on every device; if it was stood down, an all-clear must be. A
//      device that says otherwise is sent the right one, only that device, and
//      its answer is checked the same way, whatever it was. So is a device
//      whose send failed without saying the copy never arrived. When a
//      device's row has gone since (a token replaced or pruned), or a push
//      sent to it found no row left, the devices registered now take its
//      place, even if it was waiting on a retry of its own: that retry can no
//      longer reach it, and is taken off it. The right one is the copy this
//      process sent, or, when nothing in memory still holds it, a push built
//      from emergency_alerts and users; an all-clear carries the time of the
//      stand-down that withdrew the alert, so the app can tell the alarm it
//      called off from a newer one, and an all-clear older than that
//      stand-down is not the right one. A correction that reaches a device
//      takes that device off any retry of the same push still queued for it,
//      and never off a newer all-clear's. A correction that fails is queued
//      like any failed push, and each device is corrected to one push a few
//      times at most (sosCorrections).
//   5. NOTHING AFTER THE ALERT'S DEADLINE. An alert can be stood down for six
//      hours from its created_at (CANCEL_WINDOW_MS in routes/safety.js), and
//      that is as long as its pushes are looked after: rule 4 corrects nothing
//      once the window of the alert it checks against has closed, a queued SOS
//      push expires no later than its alert's deadline, and one released
//      after that is dropped. The counts in sosCorrections are forgotten when
//      that map is full, so they alone cannot end a chain of corrections that
//      fail and are retried; the deadline does, and nothing resets it.
//
// A check that cannot read Postgres does not give up at once: it tries again a
// few times first. The same step catches a rule 1 or rule 3 read that failed
// and sent anyway (an alarm is never withheld on a guess, nor an all-clear),
// so a short outage cannot leave a device on the wrong push.
// ---------------------------------------------------------------------------

// Keys a producer puts on a payload for the server's own use. They stay on the
// data the outbox stores and are taken off what goes to a device.
const SERVER_ONLY_KEYS = ['alertId'];

function forDevice(data) {
  if (!data || typeof data !== 'object' || !SERVER_ONLY_KEYS.some((k) => k in data)) return data;
  const copy = { ...data };
  for (const k of SERVER_ONLY_KEYS) delete copy[k];
  return copy;
}

const ALERT_STOOD_DOWN_SQL = `SELECT withdrawn_at IS NOT NULL AS stood_down
     FROM emergency_alerts
    WHERE id = $1 AND user_id = $2`;
const NEWEST_ALERT_STOOD_DOWN_SQL = `SELECT withdrawn_at IS NOT NULL AS stood_down
     FROM emergency_alerts
    WHERE user_id = $1
    ORDER BY id DESC
    LIMIT 1`;
const NEWER_ALARM_REACHED_SQL = `SELECT EXISTS (
       SELECT 1 FROM emergency_alerts s
        WHERE s.user_id = $1
          AND s.withdrawn_at IS NULL
          AND $2 = ANY(s.flock_recipient_ids)
          AND s.id > (SELECT COALESCE(MAX(w.id), 0) FROM emergency_alerts w
                       WHERE w.user_id = $1 AND w.withdrawn_at IS NOT NULL)
     ) AS superseded`;

// Rules 1 and 2. False when the answer cannot be had: an alarm is never
// withheld on a guess.
async function alarmStoodDown(data = {}) {
  const sender = actorFrom(data);
  if (!sender) return false;
  const alertId = Number(data.alertId);
  try {
    const r = Number.isInteger(alertId) && alertId > 0
      ? await pool.query(ALERT_STOOD_DOWN_SQL, [alertId, sender])
      : await pool.query(NEWEST_ALERT_STOOD_DOWN_SQL, [sender]);
    return Boolean(r && r.rows && r.rows[0] && r.rows[0].stood_down === true);
  } catch (err) {
    console.error('[Push] could not read whether an SOS was stood down, sending it:', err.message);
    return false;
  }
}

// Rule 3. False when the answer cannot be had: the all-clear is what somebody
// acting on a withdrawn emergency is waiting for.
async function newerAlarmReached(userId, data = {}) {
  const sender = actorFrom(data);
  const recipient = Number(userId);
  if (!sender || !Number.isInteger(recipient) || recipient <= 0) return false;
  try {
    const r = await pool.query(NEWER_ALARM_REACHED_SQL, [sender, recipient]);
    return Boolean(r && r.rows && r.rows[0] && r.rows[0].superseded === true);
  } catch (err) {
    console.error('[Push] could not read whether a newer SOS stands, sending the all-clear:', err.message);
    return false;
  }
}

// Rule 4's truth: the newest alert of the sender whose recorded audience holds
// this person, whether it still stands, and, when it does not, when it was
// stood down; and, for rule 5, when it was raised. A row from before the
// snapshot (NULL, migration 064) names nobody and is passed over. withdrawn_at
// and created_at are naive UTC (migration 084, schema.sql), so they are read
// as epoch milliseconds here rather than handed to a driver that would read
// them in the server's local zone.
const SOS_TRUTH_SQL = `SELECT id, withdrawn_at IS NULL AS standing,
          FLOOR(EXTRACT(EPOCH FROM (withdrawn_at AT TIME ZONE 'UTC')) * 1000)::bigint AS withdrawn_ms,
          FLOOR(EXTRACT(EPOCH FROM (created_at AT TIME ZONE 'UTC')) * 1000)::bigint AS created_ms
     FROM emergency_alerts
    WHERE user_id = $1
      AND $2 = ANY(flock_recipient_ids)
    ORDER BY id DESC
    LIMIT 1`;

// Rule 5: how long after its created_at an alert's pushes are looked after.
// The stand-down's own window, CANCEL_WINDOW_MS in routes/safety.js, which a
// test holds this to, since this file cannot require a route.
const SOS_ALERT_WINDOW_MS = 6 * 60 * 60 * 1000;

// Rule 5 for the outbox: when the alert a queued SOS push is for was raised.
// An alarm names its alert. An all-clear, or an alarm queued before alarms
// named theirs, is for the alert rule 4 checks this person against: the
// sender's newest whose recorded audience holds them.
const SOS_ALERT_RAISED_SQL = `SELECT FLOOR(EXTRACT(EPOCH FROM (created_at AT TIME ZONE 'UTC')) * 1000)::bigint AS created_ms
     FROM emergency_alerts
    WHERE user_id = $1
      AND (id = $3::int OR ($3::int IS NULL AND $2::int = ANY(flock_recipient_ids)))
    ORDER BY id DESC
    LIMIT 1`;

// The moment after which the SOS push `data` describes is not sent to this
// person again, in epoch milliseconds (rule 5). Null when there is no such
// alert or it cannot be read, and the outbox's own expiry is all that applies.
async function sosDeadline(userId, data = {}) {
  const sender = actorFrom(data);
  const recipient = Number(userId);
  if (!sender || !Number.isInteger(recipient) || recipient <= 0) return null;
  const alertId = data && data.type === 'safety_alert' ? alertIdOf(data) : null;
  try {
    const r = await pool.query(SOS_ALERT_RAISED_SQL, [sender, recipient, alertId]);
    const row = r && r.rows && r.rows[0];
    const raised = row ? Number(row.created_ms) : NaN;
    return Number.isFinite(raised) ? raised + SOS_ALERT_WINDOW_MS : null;
  } catch (err) {
    console.error('[Push] could not read when an SOS alert was raised:', err.message);
    return null;
  }
}

// What rule 4 sends when nothing in memory still holds the right push: the
// alert and its sender's name for an alarm, the name and the stand-down's time
// for an all-clear.
//
// A rebuilt alarm's `at` is the moment it is rebuilt, never the alert's
// created_at: a claim whose every email failed is set back past the floor
// (routes/safety.js), so created_at can be earlier than a stand-down that came
// before the alert, and the app would take the alarm for one that stand-down
// had called off. It is read the way the first copy's was (WHICH ALARM A
// STAND-DOWN CALLS OFF, routes/safety.js): Postgres's clock, a millisecond past
// the sender's last stand-down at least, and only while the alert stands,
// under a share lock, so a stand-down that takes the row after this is
// stamped after it too.
const SOS_ALARM_SOURCE_SQL = `SELECT a.latitude, a.longitude, a.contacts_alerted, u.name,
          FLOOR(EXTRACT(EPOCH FROM GREATEST(
            clock_timestamp(),
            (SELECT MAX(w.withdrawn_at) FROM emergency_alerts w WHERE w.user_id = a.user_id)
              AT TIME ZONE 'UTC' + INTERVAL '1 millisecond'
          )) * 1000)::bigint AS at_ms
     FROM emergency_alerts a
     JOIN users u ON u.id = a.user_id
    WHERE a.id = $1 AND a.user_id = $2 AND a.withdrawn_at IS NULL
      FOR SHARE OF a`;
const SOS_CLEAR_SOURCE_SQL = `SELECT u.name,
          FLOOR(EXTRACT(EPOCH FROM (a.withdrawn_at AT TIME ZONE 'UTC')) * 1000)::bigint AS withdrawn_ms
     FROM emergency_alerts a
     JOIN users u ON u.id = a.user_id
    WHERE a.id = $1 AND a.user_id = $2`;

// Queued retries a device no longer needs: the same SOS push, to the same
// device, from the same sender. For an alarm that is one of the same alert
// ($5); for an all-clear, one stamped no later than this one ($6, both in the
// form toISOString writes, so the strings order as the times do). A newer
// all-clear calls off an alert an older one does not, so an older all-clear
// never takes a newer one's retry, and a queued one whose time cannot be read
// is kept. A row owed to no other device goes; one owed to others as well is
// narrowed. A row that names no devices (every device on the account) is left
// alone.
const SOS_QUEUED_COPIES_DELETE_SQL = `DELETE FROM push_outbox
    WHERE user_id = $1
      AND token_ids <@ $2::int[]
      AND data->>'type' = $3::text
      AND data->>'fromUserId' = $4::text
      AND ($5::text IS NULL OR data->>'alertId' = $5::text)
      AND ($6::text IS NULL OR (data->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                                AND data->>'at' <= $6::text))`;
const SOS_QUEUED_COPIES_NARROW_SQL = `UPDATE push_outbox
      SET token_ids = ARRAY(SELECT t FROM unnest(token_ids) AS t WHERE t <> ALL($2::int[]))
    WHERE user_id = $1
      AND token_ids && $2::int[]
      AND data->>'type' = $3::text
      AND data->>'fromUserId' = $4::text
      AND ($5::text IS NULL OR data->>'alertId' = $5::text)
      AND ($6::text IS NULL OR (data->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                                AND data->>'at' <= $6::text))`;

// Queued SOS pushes from one sender to one person, taken off devices whose
// rows have gone. Nothing queued can reach such a device again, and the
// devices registered now have just been sent what is true in its place
// (checkSosSlot), so a release that found its device gone must not stand in
// for it a second time. Same shape as the two above: a row owed to no other
// device goes, one owed to others as well is narrowed.
const SOS_GONE_COPIES_DELETE_SQL = `DELETE FROM push_outbox
    WHERE user_id = $1
      AND token_ids <@ $2::int[]
      AND data->>'type' IN ('safety_alert', 'safety_alert_cancelled')
      AND data->>'fromUserId' = $3::text`;
const SOS_GONE_COPIES_NARROW_SQL = `UPDATE push_outbox
      SET token_ids = ARRAY(SELECT t FROM unnest(token_ids) AS t WHERE t <> ALL($2::int[]))
    WHERE user_id = $1
      AND token_ids && $2::int[]
      AND data->>'type' IN ('safety_alert', 'safety_alert_cancelled')
      AND data->>'fromUserId' = $3::text`;

// Rule 4's register: one slot per person and sender, holding the SOS pushes
// still on their way to that person, what each of their devices accepted
// last, the devices a push that went to the provider was addressed to, and
// the newest all-clear sent to them. In process on purpose: a send still
// running exists only in the process that is running it, and this app runs
// one (numReplicas 1 on Railway).
//
// It drains itself. A push leaves its slot when its send answers, and a send
// always answers: the provider call settles on firebase-admin's own retries and
// timeouts, and one still running at the 8 second deadline answers through
// `settled`, which never rejects. The slot is deleted once its last push has
// answered and every device it reached agrees with Postgres, or is still
// registered and waiting on the retry its own failed correction queued. The
// ceilings are for what would stop that. Past SOS_SLOTS_MAX a push goes out
// unregistered; corrections are counted in sosCorrections below and end at
// the alert's deadline (rule 5); a check that cannot read Postgres tries
// again after each of SOS_RECHECK_DELAYS_MS and then lets the slot go. Every
// push itself still goes.
const sosSlots = new Map(); // `${recipient}|${sender}` -> slot
const SOS_SLOTS_MAX = 5000;
const SOS_RECHECK_DELAYS_MS = [5000, 30000, 120000];
let sosRecheckDelays = SOS_RECHECK_DELAYS_MS;
// Each device's acceptance takes the next number, so "which copy did this
// device accept last" is a comparison of two integers, not of two clocks.
let sosAcceptOrder = 0;

// HOW MANY TIMES ONE DEVICE IS CORRECTED TO ONE PUSH. A correction that fails
// is queued like any failed push, with the outbox's own attempts and expiry,
// and its release, failing in turn, is corrected again, in a new slot each
// time; so the bound has to outlive a slot. It is kept per device and per what
// the device is corrected to (the alert and the kind, rule 4's target), so no
// device's history ever stops another device being corrected: at most
// SOS_CORRECTIONS_PER_KEY corrections each, after which the queued retry is
// all that is left. A device whose row has gone since its push (a token
// replaced or pruned) cannot be traced to the row that took its place, so the
// devices sent to in its stead count together, on the account and the target.
// An entry lapses after the alert window (SOS_ALERT_WINDOW_MS), past which
// nothing is left to correct; the map holds at most SOS_CORRECTIONS_MAX keys,
// the least recently corrected out first. A key pushed out that way starts
// its count again, so these counts are the fine bound and not the last one:
// rule 5's deadline is read from Postgres, and no eviction moves it.
const sosCorrections = new Map(); // `${deviceId}|${target}` or `u${recipient}|${target}` -> { count, at }
const SOS_CORRECTIONS_PER_KEY = 3;
const SOS_CORRECTIONS_MAX = 5000;

// Corrections already sent under `key` inside the window.
function correctionsSent(key) {
  const entry = sosCorrections.get(key);
  if (!entry) return 0;
  if (Date.now() - entry.at > SOS_ALERT_WINDOW_MS) {
    sosCorrections.delete(key);
    return 0;
  }
  return entry.count;
}

function noteCorrection(key) {
  const count = correctionsSent(key) + 1;
  sosCorrections.delete(key);
  sosCorrections.set(key, { count, at: Date.now() });
  while (sosCorrections.size > SOS_CORRECTIONS_MAX) sosCorrections.delete(sosCorrections.keys().next().value);
}

// The alarms this process has sent, by alert, so rule 4 sends the same copy
// again, the fix's radius included, which is stored nowhere else. One entry per
// alert rather than per recipient: the recipient is written in when it is sent.
// Bounded, oldest out first, and an entry older than SOS_ALARM_COPY_TTL_MS is
// not used; past that, or after a restart, the copy is built from Postgres.
const sosAlarmCopies = new Map(); // alertId -> { title, body, data, storedAt }
const SOS_ALARM_COPIES_MAX = 1000;
const SOS_ALARM_COPY_TTL_MS = 30 * 60 * 1000;

function sosSlotKey(userId, data) {
  const sender = actorFrom(data);
  const recipient = Number(userId);
  return sender && Number.isInteger(recipient) && recipient > 0 ? `${recipient}|${sender}` : null;
}

function alertIdOf(data) {
  const n = Number(data && data.alertId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function dropSosSlot(key, slot) {
  if (slot.pending.size === 0 && sosSlots.get(key) === slot) sosSlots.delete(key);
}

function rememberAlarmCopy(alertId, title, body, data) {
  if (alertId === null) return;
  const general = { ...(data || {}) };
  delete general.toUserId;
  sosAlarmCopies.delete(alertId);
  sosAlarmCopies.set(alertId, { title, body, data: general, storedAt: Date.now() });
  while (sosAlarmCopies.size > SOS_ALARM_COPIES_MAX) sosAlarmCopies.delete(sosAlarmCopies.keys().next().value);
}

function alarmCopyFor(alertId, recipient) {
  const copy = sosAlarmCopies.get(alertId);
  if (!copy) return null;
  if (Date.now() - copy.storedAt > SOS_ALARM_COPY_TTL_MS) {
    sosAlarmCopies.delete(alertId);
    return null;
  }
  return { title: copy.title, body: copy.body, data: { ...copy.data, toUserId: String(recipient) } };
}

// The right push built again from Postgres, for when no copy of it is left in
// memory: after a restart, or when the push this person needs was never sent
// through this slot. The words come from services/sosPushes.js, as the first
// copy's did. The database does not keep the fix's radius, so a rebuilt alarm
// with a position calls it approximate rather than a spot. Null when the alarm
// it would be is for an alert stood down since the truth was read: the
// stand-down's own all-clear checks for itself. Throws when Postgres cannot be
// read.
async function rebuildSosPush(truth, recipient, sender) {
  if (truth.standing) {
    const r = await pool.query(SOS_ALARM_SOURCE_SQL, [truth.alertId, sender]);
    const row = r && r.rows && r.rows[0];
    if (!row) return null;
    const hasFix = row.latitude != null && row.longitude != null;
    const atMs = Number(row.at_ms);
    const built = alarmPush({
      senderId: sender,
      name: row.name,
      coords: hasFix ? { lat: Number(row.latitude), lng: Number(row.longitude) } : null,
      fixMetres: null,
      radiusLost: true,
      contactsAlerted: Number(row.contacts_alerted) || 0,
      at: new Date(Number.isFinite(atMs) && atMs > 0 ? atMs : Date.now()).toISOString(),
    });
    return { ...built, data: { ...built.data, toUserId: String(recipient), alertId: String(truth.alertId) } };
  }
  const r = await pool.query(SOS_CLEAR_SOURCE_SQL, [truth.alertId, sender]);
  const row = r && r.rows && r.rows[0];
  if (!row) return null;
  const built = allClearPush({
    senderId: sender,
    name: row.name,
    at: stoodDownIso(row.withdrawn_ms, truth.withdrawnMs),
  });
  return { ...built, data: { ...built.data, toUserId: String(recipient) } };
}

// An all-clear's `at` is the stand-down's own time (sosPushes.js), from
// whichever reading of withdrawn_at is to hand. With none, the all-clear goes
// without a time rather than with "now": a time later than a newer alarm's
// would have the app take that alarm for one this all-clear called off.
function stoodDownIso(...readings) {
  for (const reading of readings) {
    const ms = Number(reading);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  return null;
}

// The all-clear this slot sent last, for a device the truth says should show
// one, carrying the time of the stand-down that withdrew the alert the truth
// names (an older stand-down's copy may be all the slot holds).
function clearCopyFor(slot, truth) {
  if (!slot.clear) return null;
  const at = stoodDownIso(truth.withdrawnMs);
  return at ? { ...slot.clear, data: { ...slot.clear.data, at } } : slot.clear;
}

// Registers one SOS push, `kind` 'alarm' or 'clear', from before its checks.
// Returns `accepted(deviceId)` and `uncertain(deviceId)`, which record, the
// moment each happens, a device taking a copy and a send to a device failing
// in a way that does not say whether the copy arrived; `owed(deviceIds)`,
// which records the devices a push that went to the provider was addressed
// to, so that one which never answers is known to have had no row left; and
// `answered()`, which records the push's answer. `correctionFor` is rule 4's
// target when the push is a correction, and null otherwise.
function holdSosSlot(kind, userId, title, body, data, correctionFor = null) {
  const none = { accepted: () => {}, uncertain: () => {}, owed: () => {}, answered: () => {} };
  const key = sosSlotKey(userId, data);
  if (!key) return none;
  let slot = sosSlots.get(key);
  if (!slot) {
    if (sosSlots.size >= SOS_SLOTS_MAX) return none;
    slot = { pending: new Set(), devices: new Map(), owed: new Set(), clear: null, round: 0, rechecks: 0 };
    sosSlots.set(key, slot);
  }
  const alertId = kind === 'alarm' ? alertIdOf(data) : null;
  // An all-clear is told apart by the stand-down it carries (its `at`, that
  // stand-down's withdrawn_at): an older one does not call off an alert
  // withdrawn after it, so it does not count as the right one (checkSosSlot).
  const stoodDownMs = kind === 'clear' ? Date.parse(data && data.at) : NaN;
  if (kind === 'alarm') rememberAlarmCopy(alertId, title, body, data);
  if (kind === 'clear') slot.clear = { title, body, data };
  const token = {};
  slot.pending.add(token);
  const note = (deviceId, unsure) => {
    const id = Number(deviceId);
    if (!Number.isInteger(id) || id <= 0) return null;
    sosAcceptOrder += 1;
    slot.devices.set(id, { kind, alertId, stoodDownMs, order: sosAcceptOrder, uncertain: unsure, correctionFor });
    return id;
  };
  return {
    accepted: (deviceId) => {
      const id = note(deviceId, false);
      // A correction that reached a device makes a retry of the same push
      // queued for that device a second ring of it.
      if (id !== null && correctionFor) {
        forgetQueuedSosCopies(Number(userId), data, [id])
          .catch((err) => console.error('[Push] could not drop a queued SOS copy:', err.message));
      }
    },
    // firebase-admin retries a send on its own, so a failure can hide an
    // attempt that landed and whose reply was lost. Such a device is not
    // taken to hold what it held before: the check sends it the truth.
    uncertain: (deviceId) => { note(deviceId, true); },
    owed: (deviceIds) => {
      for (const deviceId of deviceIds || []) {
        const id = Number(deviceId);
        if (Number.isInteger(id) && id > 0) slot.owed.add(id);
      }
    },
    answered: () => {
      if (!slot.pending.delete(token)) return;
      // The last push to answer does the checking, whatever it came to. A
      // correction refused by the checks or by the provider used to end the
      // slot there, and another device on the wrong push was left on it.
      if (slot.pending.size > 0) return;
      slot.round += 1;
      checkSosSlot(key, slot, slot.round, Number(userId), actorFrom(data))
        .catch((err) => console.error('[Push] SOS lock-screen check failed:', err.message));
    },
  };
}

// Drops `deviceIds` from queued retries this push makes needless: the same
// sender and kind, and for an alarm the same alert, for an all-clear one no
// newer than this (SOS_QUEUED_COPIES_DELETE_SQL). Best effort: a row it misses
// is at worst the same push ringing twice.
async function forgetQueuedSosCopies(userId, data, deviceIds) {
  const type = data && data.type ? String(data.type) : '';
  const sender = actorFrom(data);
  const ids = (deviceIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!sender || ids.length === 0) return;
  let alertId = null;
  let upTo = null;
  if (type === 'safety_alert') {
    alertId = alertIdOf(data);
    // An alarm that names no alert cannot be told apart from the others.
    if (alertId === null) return;
  } else if (type === 'safety_alert_cancelled') {
    // An all-clear that does not say which stand-down it is cannot be shown
    // to be as new as any queued one.
    upTo = stoodDownIso(Date.parse(data && data.at));
    if (upTo === null) return;
  } else {
    return;
  }
  const params = [userId, ids, type, String(sender), alertId === null ? null : String(alertId), upTo];
  await pool.query(SOS_QUEUED_COPIES_DELETE_SQL, params);
  await pool.query(SOS_QUEUED_COPIES_NARROW_SQL, params);
}

// A check that could not read Postgres, tried again later rather than given up.
function checkSosSlotLater(key, slot, round, recipient, sender) {
  const delay = sosRecheckDelays[slot.rechecks];
  if (delay === undefined) return dropSosSlot(key, slot);
  slot.rechecks += 1;
  const timer = setTimeout(() => {
    // A push sent since will check for itself when it answers.
    if (slot.pending.size > 0 || slot.round !== round || sosSlots.get(key) !== slot) return;
    checkSosSlot(key, slot, round, recipient, sender)
      .catch((err) => console.error('[Push] SOS lock-screen check failed:', err.message));
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  return undefined;
}

// Rule 4, once the slot has drained: does what each device accepted last say
// what is true? A device that says otherwise, or whose last send may or may not
// have arrived, is sent the right push, alone; one that has gone, through the
// devices registered in its place.
async function checkSosSlot(key, slot, round, recipient, sender) {
  // No device accepted anything while this slot was open, and no push that
  // went out was addressed to a device that may have gone: nothing changed.
  if (slot.devices.size === 0 && slot.owed.size === 0) return dropSosSlot(key, slot);
  let truth = null;
  try {
    const r = await pool.query(SOS_TRUTH_SQL, [sender, recipient]);
    const row = r && r.rows && r.rows[0];
    truth = row
      ? {
        standing: row.standing === true,
        alertId: Number(row.id),
        withdrawnMs: Number(row.withdrawn_ms),
        deadlineMs: Number(row.created_ms) + SOS_ALERT_WINDOW_MS,
      }
      : null;
  } catch (err) {
    console.error('[Push] could not read what an SOS slot should show, will try again:', err.message);
    return checkSosSlotLater(key, slot, round, recipient, sender);
  }
  // Something was sent while this asked, and its own answer checks again.
  if (slot.pending.size > 0 || slot.round !== round) return undefined;
  if (!truth) return dropSosSlot(key, slot);
  // Rule 5: once the alert's window has closed nothing is corrected, whatever
  // sosCorrections still remembers. An alert whose created_at cannot be read
  // is taken to have no window left.
  if (!(Date.now() < truth.deadlineMs)) return dropSosSlot(key, slot);
  // The correction, named by its alert both ways. An all-clear named by its
  // kind alone was spent by the first stand-down, and a device that took a
  // withdrawn alarm after a second stand-down was left on it.
  const target = `${truth.standing ? 'alarm' : 'clear'}|${truth.alertId}`;
  // An all-clear is right only if it is the stand-down that withdrew the
  // alert the truth names, or a later one: an older all-clear leaves that
  // alert's alarm open in the app, which closes only what an all-clear's time
  // covers. With the truth's time unread, any all-clear is taken, as before.
  const agrees = (last) => !last.uncertain && (truth.standing
    ? last.kind === 'alarm' && last.alertId === truth.alertId
    : last.kind === 'clear'
      && (!Number.isFinite(truth.withdrawnMs) || last.stoodDownMs >= truth.withdrawnMs));
  // Every device not on the right push, and every device a push that went out
  // was addressed to and that never answered, because its row had gone.
  const disagree = [];
  for (const [deviceId, last] of slot.devices) {
    if (!agrees(last)) disagree.push(deviceId);
  }
  const unanswered = [...slot.owed].filter((deviceId) => !slot.devices.has(deviceId));
  if (disagree.length === 0 && unanswered.length === 0) return dropSosSlot(key, slot);
  // Which of them are still registered is asked before any is set aside for a
  // retry of its own below. A device whose row has gone since (its token
  // replaced, or pruned as dead) cannot be corrected where it was, nor reached
  // by a retry queued for it, so the devices registered now that this slot has
  // heard nothing from stand in for it. This was asked after the setting
  // aside, and a phone whose correction was still out when its token was
  // replaced was set aside for a retry that then found no device and was
  // deleted: the phone kept the alarm the person had withdrawn.
  let current = null;
  try {
    current = await firebaseService.currentDeviceIds(recipient);
  } catch (err) {
    console.error('[Push] could not read the devices an SOS correction can go to:', err.message);
  }
  if (slot.pending.size > 0 || slot.round !== round) return undefined;
  const gone = current
    ? [...disagree, ...unanswered].filter((deviceId) => !current.includes(deviceId))
    : [];
  // A device still registered whose own correction to this same push failed
  // without saying whether it arrived is set aside: that failure queued a
  // retry of it, which follows with the outbox's backoff, and sending it again
  // now could ring a phone it did reach.
  const awaitingRetry = (deviceId) => {
    const last = slot.devices.get(deviceId);
    return Boolean(last && last.uncertain && last.correctionFor === target);
  };
  // Each device within its own count, and the stand-ins for gone devices
  // within one count on the account (sosCorrections). Unread, the check goes
  // on with the devices it knows.
  const known = disagree.filter((deviceId) => (!current || current.includes(deviceId))
    && !awaitingRetry(deviceId)
    && correctionsSent(`${deviceId}|${target}`) < SOS_CORRECTIONS_PER_KEY);
  const accountKey = `u${recipient}|${target}`;
  const standIns = gone.length > 0 && correctionsSent(accountKey) < SOS_CORRECTIONS_PER_KEY
    ? current.filter((deviceId) => !slot.devices.has(deviceId))
    : [];
  const wrong = [...known, ...standIns];
  if (wrong.length === 0) {
    // Only the device read can say whether one set aside, or one that never
    // answered, has gone. Unread, it is asked again rather than let go.
    if (!current && (unanswered.length > 0 || disagree.some(awaitingRetry))) {
      return checkSosSlotLater(key, slot, round, recipient, sender);
    }
    return dropSosSlot(key, slot);
  }
  let right = truth.standing ? alarmCopyFor(truth.alertId, recipient) : clearCopyFor(slot, truth);
  if (!right) {
    try {
      right = await rebuildSosPush(truth, recipient, sender);
    } catch (err) {
      console.error('[Push] could not build the SOS push a device needs, will try again:', err.message);
      return checkSosSlotLater(key, slot, round, recipient, sender);
    }
    if (slot.pending.size > 0 || slot.round !== round) return undefined;
  }
  if (!right) return dropSosSlot(key, slot);
  if (standIns.length > 0) {
    // Whatever is queued for the gone devices can never reach them, and the
    // stand-ins are sent what is true now, so the queued copies are taken off
    // them: released, each would find its device gone and stand in again.
    const params = [recipient, gone, String(sender)];
    await pool.query(SOS_GONE_COPIES_DELETE_SQL, params)
      .then(() => pool.query(SOS_GONE_COPIES_NARROW_SQL, params))
      .catch((err) => console.error('[Push] could not drop SOS copies queued for a gone device:', err.message));
    if (slot.pending.size > 0 || slot.round !== round) return undefined;
    noteCorrection(accountKey);
  }
  for (const deviceId of known) noteCorrection(`${deviceId}|${target}`);
  // Through deliverSos, so it is registered in this slot and its own answer
  // is checked the same way; `again` puts it under rules 1 and 3, and
  // `onlyIds` keeps it off every device that already shows the right push.
  // A correction that fails is queued like any failed push, with the outbox's
  // own attempts and an expiry no later than the alert's deadline; the counts
  // above bound the chain inside that window, and rule 5 ends it there.
  await deliverSos(truth.standing ? 'alarm' : 'clear', recipient, right.title, right.body, right.data,
    { again: true, correctionFor: target, onlyIds: wrong });
  return undefined;
}

// ---------------------------------------------------------------------------
// THE OUTBOX (migration 050, table push_outbox)
//
// Two reasons a push is written now and delivered later:
//
//   'retry'  the provider failed transiently. firebase-admin retries a send
//            four times by itself and services/firebaseService.js races that
//            with an 8 second deadline ON PURPOSE. Read the SEND_TIMEOUT_MS
//            comment there before touching it: the deadline is what makes "a
//            notification failing is never something a user experiences as the
//            app hanging" a property of the code rather than a habit of each
//            caller. So the retry cannot live inside the send, and it must not
//            extend the deadline. It lives out here, where a later sweep takes
//            another run at it with nothing waiting on the answer.
//
//   'quiet'  the quiet-hours hold described above.
//
// This is the crowd_alert_sends pattern (migration 007) generalised: durable
// state, claimed in SQL with FOR UPDATE SKIP LOCKED, so two Railway instances
// cannot both release the same row.
// ---------------------------------------------------------------------------
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_TTL_MS = 30 * 60 * 1000;
const QUIET_TTL_MS = 12 * 60 * 60 * 1000;
const OUTBOX_BATCH = 50;
const OUTBOX_SWEEP_MS = 60 * 1000;
// Five consecutive empty sweeps and the timer stands down. It is restarted by
// the next enqueue, and services/crowdAlerts.js sweeps every 15 minutes
// regardless, so a row can never be stranded by the timer having stopped.
const OUTBOX_IDLE_SWEEPS = 5;

// FCM expires a registration token after roughly 270 days of app inactivity.
// A row older than that is a guaranteed failed send forever, so it is deleted
// rather than retried until the end of time. 270 and not 90: updated_at is now
// a liveness timestamp (see touchDeviceTokens), but the only events that write
// it are a registration and a clean send, and a real person can go a long time
// between both without uninstalling anything.
const TOKEN_MAX_IDLE_DAYS = 270;

// Clean up old entries every 5 minutes
const debounceSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastPushSent) {
    if (now - ts > DEBOUNCE_MS * 2) lastPushSent.delete(key);
  }
}, 5 * 60 * 1000);
// A cleanup timer must never be the reason the process stays up. Unreffed, the
// server (whose listening socket holds the loop open) is unaffected, but a
// short-lived process that merely REQUIRES this module can exit: `node --test`
// hung forever the moment a test touched anything that pulls in pushHelper.
if (typeof debounceSweep.unref === 'function') debounceSweep.unref();

// Check if a user is currently connected via Socket.io.
//
// Still exported, still true when ANY socket sits in the room, because two
// other things read it for what it actually says. It is no longer, on its own,
// a reason to suppress a notification. See everyDeviceAttended below.
function isUserOnline(io, userId) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  return room && room.size > 0;
}

// ---------------------------------------------------------------------------
// PRESENCE IS NOT ATTENTION
//
// THE BUG THIS REPLACES, which was the worst one in the push path. Push was
// suppressed whenever any socket sat in `user:{id}`. server.js sets
// pingTimeout 60000 and pingInterval 25000, so for up to about 85 seconds
// after a phone was backgrounded the server still believed the user was
// looking and dropped the notification with nothing queued behind it. Far
// worse and with no time limit at all: an open laptop tab occupies that room
// forever, so leaving flockcorp.com open on a laptop killed push on the
// owner's phone indefinitely, with no symptom and nothing in any log.
//
// The premise was wrong on both counts. A socket means a CONNECTION exists. It
// does not mean a person is looking, and it says nothing whatsoever about the
// other device in their pocket.
//
// THE RULE NOW: a push is suppressed only when EVERY device that could receive
// it is already attended. A device is attended when it has a live socket that
// names it. Anything else, including one unaccounted-for device, sends.
//
// HOW A SOCKET NAMES ITS DEVICE. frontend/src/services/socket.js puts this
// browser or app's FCM registration token in the handshake auth alongside the
// JWT, so the server can line a live connection up with a row in device_tokens
// without a new socket event and without trusting anything but a value that is
// already the user's own. A socket that names no token attends no device: an
// unidentifiable connection can no longer silence anything, which is exactly
// the property the old rule lacked.
//
// AND THE 85 SECONDS. The client half closes it from the other side:
// socket.js now tears the connection down when the tab or the app goes hidden,
// immediately on native and after a short grace on the web, so "has a live
// socket" means "is in the foreground" rather than "was in the foreground
// within the last minute and a half". What remains is a device that dies
// without warning (a tunnel, a dead battery), whose own token stays attended
// for up to pingTimeout plus pingInterval. That is one device, for 85 seconds,
// and it no longer takes the rest of the account down with it.
// ---------------------------------------------------------------------------
function attentiveTokens(io, userId) {
  const claimed = new Set();
  if (!io) return claimed;
  const room = io.sockets.adapter && io.sockets.adapter.rooms
    ? io.sockets.adapter.rooms.get(`user:${userId}`)
    : null;
  if (!room) return claimed;
  // A room with no socket registry behind it (which is what a partial stub in a
  // test is) names no device, so it speaks for none. Fail toward sending.
  const registry = io.sockets.sockets;
  if (!registry || typeof registry.get !== 'function') return claimed;
  for (const socketId of room) {
    const s = registry.get(socketId);
    const token = s && s.handshake && s.handshake.auth && s.handshake.auth.pushToken;
    // Bounded the same way routes/notifications.js bounds a registration, so a
    // client cannot park anything large in a Set the send path iterates.
    if (typeof token === 'string' && token.length >= 8 && token.length <= 1024) {
      claimed.add(token);
    }
  }
  return claimed;
}

async function everyDeviceAttended(io, userId) {
  const claimed = attentiveTokens(io, userId);
  try {
    const r = await pool.query(
      'SELECT token FROM device_tokens WHERE user_id = $1',
      [userId]
    );
    // No registered device: vacuously true, and there was nothing to deliver
    // to anyway. Answering false here would spend a visibility check and a
    // no-op provider call to learn the same thing.
    if (r.rows.length === 0) return true;
    return r.rows.every((row) => claimed.has(row.token));
  } catch (err) {
    // An unreadable device list is the ONE case that still falls back to the
    // old account-level rule. It is consistent with canNotify, which fails
    // closed a few lines later for the same reason: while the database is
    // unreachable the safe move is the quiet one, and it lasts only as long as
    // the outage.
    console.error('[Push] device list unreadable, falling back to presence:', err.message);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Visibility gate
//
// A push is written at one moment and delivered at another. In between, the
// recipient can leave the flock, the flock can be deleted, or either side can
// block the other. Round 7: nothing re-checked any of that, so a member who
// left a flock at 6pm still got "It's happening!" at 8pm, a queued crowd alert
// still fired for a deleted flock, and the RSVP/friend-request pushes named a
// user the recipient had blocked. Every caller is gated here rather than in
// nine call sites that each have to remember.
// ---------------------------------------------------------------------------
function actorFrom(data = {}) {
  const raw = data.senderId != null ? data.senderId
    : data.fromUserId != null ? data.fromUserId
      : data.actorId != null ? data.actorId : null;
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Whether the message a push is about has been hidden, unsent, or deleted
// since the push was made. `messageId` is a flock message, `dmId` a direct
// message; each producer sets exactly one. No id, nothing to check.
async function contentGoneFor(data = {}) {
  const messageId = Number(data.messageId);
  const dmId = Number(data.dmId);
  if (Number.isInteger(messageId) && messageId > 0) {
    const r = await pool.query(
      'SELECT (COALESCE(is_hidden, false) OR sender_deleted_at IS NOT NULL) AS gone FROM messages WHERE id = $1',
      [messageId]
    );
    return r.rows.length === 0 || r.rows[0].gone === true;
  }
  if (Number.isInteger(dmId) && dmId > 0) {
    const r = await pool.query(
      'SELECT (COALESCE(is_hidden, false) OR sender_deleted_at IS NOT NULL) AS gone FROM direct_messages WHERE id = $1',
      [dmId]
    );
    return r.rows.length === 0 || r.rows[0].gone === true;
  }
  return false;
}

// For a merged quiet row whose newest message is gone: the newest message
// in the same conversation that the recipient can still see, no older than
// the first message the hold carried and past the recipient's read cursor
// (the same predicates unreadBadge uses). null when the newest is still
// visible, when nothing survives, or when the read fails (the sweep then
// behaves as it did).
async function repairMergedHold(userId, data = {}) {
  try {
    if (!(await contentGoneFor(data))) return null;
    const flockId = flockFrom(data);
    const senderId = Number(data.senderId);
    const firstMessageId = Number(data.firstMessageId);
    const firstDmId = Number(data.firstDmId);
    if (flockId && Number.isInteger(firstMessageId) && firstMessageId > 0) {
      // The survivor's own sender rides on the payload (hardening review round 3,
      // 2026-09-05): the merged row carried the NEWEST message's sender, and a
      // repair that kept it let a push caused by a since-blocked sender out
      // under another name. Blocked either way and banned senders are not
      // survivors at all.
      //
      // So does the survivor's TITLE. The held row's title is the newest
      // sender's "{name} in {plan}", and the sweep sent it unchanged over the
      // survivor's data, so the lock screen named the person whose message
      // was just unsent or hidden, very often someone the recipient had
      // blocked. The title is rebuilt here from the survivor, in the words
      // both producers use (routes/messages.js, sockets/handlers.js).
      const r = await pool.query(
        `SELECT m.id, m.sender_id, su.name AS sender_name, f.name AS flock_name
           FROM messages m
           JOIN flock_members fm ON fm.flock_id = m.flock_id
                                AND fm.user_id = $2
                                AND fm.status = 'accepted'
           JOIN users su ON su.id = m.sender_id AND su.is_banned IS NOT TRUE
           JOIN flocks f ON f.id = m.flock_id
          WHERE m.flock_id = $1
            AND m.id >= $3
            AND m.id > COALESCE(fm.last_read_message_id, 0)
            AND m.sender_id IS NOT NULL
            AND m.sender_id != $2
            AND m.is_hidden IS NOT TRUE
            AND m.sender_deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
               WHERE (b.blocker_id = $2 AND b.blocked_id = m.sender_id)
                  OR (b.blocker_id = m.sender_id AND b.blocked_id = $2)
            )
          ORDER BY m.id DESC
          LIMIT 1`,
        [flockId, userId, firstMessageId]
      );
      if (r.rows.length === 0) return null;
      const survivor = r.rows[0];
      const flockName = survivor.flock_name || 'Flock';
      return {
        title: survivor.sender_name ? `${survivor.sender_name} in ${flockName}` : flockName,
        body: 'New messages',
        data: { ...data, messageId: String(survivor.id), senderId: String(survivor.sender_id) },
      };
    }
    if (Number.isInteger(senderId) && senderId > 0 && Number.isInteger(firstDmId) && firstDmId > 0) {
      const r = await pool.query(
        `SELECT dm.id
           FROM direct_messages dm
           JOIN users su ON su.id = dm.sender_id AND su.is_banned IS NOT TRUE
          WHERE dm.receiver_id = $1
            AND dm.sender_id = $2
            AND dm.id >= $3
            AND dm.read_status = FALSE
            AND COALESCE(dm.is_hidden, false) = false
            AND dm.sender_deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
               WHERE (b.blocker_id = $1 AND b.blocked_id = $2)
                  OR (b.blocker_id = $2 AND b.blocked_id = $1)
            )
          ORDER BY dm.id DESC
          LIMIT 1`,
        [userId, senderId, firstDmId]
      );
      if (r.rows.length === 0) return null;
      return { body: 'New messages', data: { ...data, dmId: String(r.rows[0].id) } };
    }
    return null;
  } catch (err) {
    console.error('[Push] merged hold repair failed, releasing as held:', err.message);
    return null;
  }
}

function flockFrom(data = {}) {
  if (data.flockId === undefined || data.flockId === null) return null;
  const n = Number(data.flockId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The three answers a visibility check can give. Returned, never recorded
// anywhere shared. Two pushes to one recipient are routinely in flight at once
// (a DM and a flock message landing together, a Promise.allSettled fan-out
// that names the same person twice), and the previous design marked "the check
// itself failed" in a module-level set keyed by recipient which deliver() read
// and cleared. A sibling delivery for the same recipient whose lookup settled
// in the same tick cleared that mark or claimed it, so an outage was filed as
// a permanent suppression and the outbox sweep deleted the row instead of
// retrying it. A return value cannot be reached by another call.
const CAN_SEE = Object.freeze({ allowed: true, uncheckable: false });
const CANNOT_SEE = Object.freeze({ allowed: false, uncheckable: false });
const CANNOT_TELL = Object.freeze({ allowed: false, uncheckable: true });

async function checkVisibility(userId, data = {}) {
  try {
    const actorId = actorFrom(data);
    if (actorId && Number(actorId) !== Number(userId)) {
      if (await isBlockedBetween(userId, actorId)) return CANNOT_SEE;
    }

    // THE CONTENT ITSELF, when the payload names it (UGC-loop audit,
    // 2026-09-05). A push held for quiet hours carries its body verbatim, and
    // the sweep handed that body back hours later whatever had happened to
    // the row in between: a message a moderator hid at 23:50 landed on the
    // lock screen at 08:00, text and sender name included. A row that is
    // hidden, unsent, or gone answers CANNOT_SEE; a payload with no id (the
    // older producers, and every non-message type) is unchanged.
    const contentGone = await contentGoneFor(data);
    if (contentGone) return CANNOT_SEE;

    // One lookup answers all four questions: does the recipient still exist,
    // are they allowed to be here at all, can they still see the thing, and is
    // the person this push NAMES still an account in good standing.
    // Creator OR a member who has not walked away; 'invited' counts, since an
    // invite notification is the whole reason that row exists.
    //
    // Round 18: the actor half was missing. Every push that names somebody
    // ("{name} invited you to a flock", "You owe {name} $12", "{name} in
    // {flock}") was gated on the RECIPIENT's ban state and never the sender's,
    // so a banned or deleted account's display name still landed on a lock
    // screen, where it stays until it is dismissed — the same reach the block
    // gate two lines up exists to deny. A missing actor row is treated as
    // banned: an id that no longer resolves to a user is not somebody we can
    // vouch for naming.
    // The actor branch is spliced in only when there IS an actor, so a push
    // that names nobody (an admin moderation alert) still asks the database
    // exactly the questions it has rather than binding a third parameter that
    // means nothing. Nothing user-supplied reaches the SQL text: the only two
    // possible values below are a literal `false` and the bind marker itself.
    const flockId = flockFrom(data);
    const actorClause = actorId
      ? 'COALESCE((SELECT COALESCE(a.is_banned, false) FROM users a WHERE a.id = $3), true)'
      : 'false';
    // An invite is the one push whose whole message is "come to this plan",
    // so it is the one push a finished or cancelled plan must never send.
    // The doors that send it read the plan first, but a push can be held
    // for quiet hours or retried, and the plan can close in between; this
    // is where every delivery path passes. Same shape as the actor clause:
    // a literal chosen by a boolean, never text from the payload.
    const inviteClause = data?.type === 'flock_invite'
      ? " AND f.status NOT IN ('completed', 'cancelled')"
      : '';
    // A QUARANTINED BILL SENDS NOBODY ITS FIGURES (migration 089,
    // db/billQuarantine.js). bill_created and bill_settled carry an amount in
    // their body, and a push held for quiet hours or queued for a retry keeps
    // that body verbatim, so one written for a legacy bill before 089 ran went
    // out after it with the figure the bill no longer shows anybody. The
    // payload names the bill by its plan, which has one bill; a bill push that
    // names no plan cannot be checked and is not sent. Same shape as the
    // invite clause: a literal chosen by a boolean, never text from the payload.
    const billPush = BILL_PUSH_TYPES.includes(data?.type);
    if (billPush && !flockId) return CANNOT_SEE;
    const billClause = billPush
      ? ' AND NOT EXISTS (SELECT 1 FROM bill_splits bs WHERE bs.flock_id = f.id AND bs.quarantined IS TRUE)'
      : '';
    const r = await pool.query(
      `SELECT
         COALESCE(u.is_banned, false) AS is_banned,
         ${actorClause} AS actor_banned,
         CASE WHEN $2::int IS NULL THEN true ELSE EXISTS (
           SELECT 1 FROM flocks f
           LEFT JOIN flock_members m ON m.flock_id = f.id AND m.user_id = u.id
           WHERE f.id = $2
             AND (f.creator_id = u.id OR m.status IN ('accepted', 'invited'))${inviteClause}${billClause}
         ) END AS can_see
       FROM users u
       WHERE u.id = $1`,
      actorId ? [userId, flockId, actorId] : [userId, flockId]
    );

    const row = r.rows[0];
    if (!row) return CANNOT_SEE;        // the account was deleted
    if (row.is_banned) return CANNOT_SEE; // no pulling a banned user back into an app that rejects them
    // A removed account does not get to keep announcing itself, with one
    // exception: an SOS or its stand-down. routes/safety.js deliberately
    // authenticates a banned user for those (a banned person in danger is
    // still a person in danger), and this clause was silently dropping the
    // flock leg it had just allowed. The block check above still applies.
    if (row.actor_banned && !RINGS_THROUGH_THE_NIGHT.has(data?.type)) return CANNOT_SEE;
    return row.can_see !== false ? CAN_SEE : CANNOT_SEE;
  } catch (err) {
    // FAIL CLOSED. This was the one block-enforcement point in the codebase
    // that failed open, and it was the loudest one: a push is delivered to a
    // phone's lock screen, so a database blip here pushed a blocked user's NAME
    // ("{name} invited you to a flock", "You owe {name} $12") to the person who
    // blocked them, where it stays until it is dismissed. Every sibling check
    // already fails closed for exactly this reason — utils/blocks.js throws out
    // to the caller's guard, announceToRoomExcludingBlocked stays silent,
    // routes/moderation.js refuses — and a rule that holds only while the
    // database is healthy is not the guarantee Apple 1.2 asks for.
    //
    // The cost of being wrong in this direction is a notification that arrives
    // late or not at all, which the app recovers from the moment the user opens
    // it; the cost in the other direction cannot be taken back. That recovery
    // is true of a message, a plan or a bill, which all wait in the app. It is
    // NOT true of an SOS or its stand-down: the socket emit is never replayed
    // and nothing on launch loads a pending alarm, so an offline flockmate was
    // simply never told. deliver() queues those for retry instead of dropping
    // them (see UNCHECKABLE_RETRIED there).
    console.error('[Push] visibility check failed, suppressing push:', err.message);
    // Still not allowed - the paragraph above is the reason and it stands. But
    // the answer says the check FAILED rather than that it answered no, so the
    // one caller that needs the difference can tell a suppression from an
    // outage without anything being left behind for another call to find.
    return CANNOT_TELL;
  }
}

// The boolean the rest of the codebase and the tests know. Everything that
// asks this wants the fail-closed answer and none of it wants a second
// vocabulary; deliver() is the one place that has to know WHY, and it asks
// checkVisibility directly.
async function canNotify(userId, data = {}) {
  return (await checkVisibility(userId, data)).allowed;
}

// Debounce is per CONVERSATION, not per person. Round 7: the key was the user
// id alone, so a DM from one friend swallowed a flock invite and a message in
// a different flock for the next 30 seconds, and the swallowed notification
// was never sent — the timer suppressed it, nothing batched it.
function debounceKey(userId, data = {}) {
  const type = data.type ? String(data.type) : 'generic';
  const scope = data.flockId != null ? `f${data.flockId}`
    : data.senderId != null ? `u${data.senderId}` : '';
  return `${userId}|${type}|${scope}`;
}

// ---------------------------------------------------------------------------
// The crowd-alert switch (see the 4.5.4 block above)
//
// Stored in user_settings.settings (JSONB), key `crowdAlerts`, default ON.
// The default is defensible only because the alert is transactional: it fires
// for a flock the recipient ACCEPTED, inside the 3 hours before an event they
// committed to, at most once per flock. A promotional push could not inherit
// this default; 4.5.4 requires explicit opt-in for those.
//
// WHY IT TOLERATES A STRING. frontend/src/services/userSettings.js pullSettings
// writes every synced value into localStorage with String(value), and
// readLocalSettings pushes those raw strings back up on a first sync — so a
// boolean false round-trips into this column as the JSON string "false". A
// reader that only understood booleans would read a switched-off account as
// switched on, which is exactly the failure this code exists to prevent.
//
// Anything we cannot read means UNSET, not off: junk in the blob must not
// silently stop a notification the user never asked to stop.
const CROWD_ALERT_KEY = 'crowdAlerts';
const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

function wantsCrowdAlerts(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  const v = settings[CROWD_ALERT_KEY];
  if (v === undefined || v === null) return true;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return !OFF_VALUES.has(v.trim().toLowerCase());
  return true;
}

// Fail OPEN, and the asymmetry with canNotify's fail-closed is deliberate. The
// preference's own doctrine is "unreadable means unset, unset means on": a
// database blip here must not silently stop an alert the user never switched
// off. The stakes are also different in kind — canNotify fails closed because
// delivering to the wrong person cannot be taken back, while this check only
// decides whether a person who never opted out hears about their own evening.
// A user who DID opt out and hits this window gets one alert at most (the
// crowd_alert_sends claim), not a stream. The safety gate below still runs
// either way.
async function crowdAlertOptedOut(userId) {
  try {
    const r = await pool.query(
      'SELECT settings FROM user_settings WHERE user_id = $1',
      [userId]
    );
    return !wantsCrowdAlerts(r.rows.length ? r.rows[0].settings : null);
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The ledger write. Best-effort in every direction: it never throws, it never
// changes the verdict, and it is never awaited by a caller that has a user
// waiting. A metrics table that can break the thing it measures is worse than
// no metrics table.
// ---------------------------------------------------------------------------
// A write whose failure must never reach the caller, including a driver that
// throws before it ever returns a promise. Every one of these is bookkeeping
// (the ledger, the token liveness stamp, a debounce release) and every one of
// them sits on a path with a person waiting at the other end of it.
function fireAndForget(sql, params, label) {
  try {
    const p = pool.query(sql, params);
    if (p && typeof p.catch === 'function') {
      p.catch((err) => console.error(`[Push] ${label} failed:`, err.message));
    }
  } catch (err) {
    console.error(`[Push] ${label} failed:`, err.message);
  }
}

function typeOf(data) {
  const t = data && data.type ? String(data.type) : '';
  return t ? t.slice(0, 40) : 'unknown';
}

function record(userId, data, outcome, { sent = 0, failed = 0, quiet = false } = {}) {
  const type = typeOf(data);
  // The zero-dependency half of the answer. One line per push, in Railway's
  // log stream, greppable as `[Push] outcome=`, so "did anything go out
  // yesterday" survives even a database nobody can reach.
  console.log(
    `[Push] type=${type} user=${userId} outcome=${outcome} sent=${sent} failed=${failed} quiet=${quiet}`
  );
  // Once per failure, not silently. A ledger that has quietly stopped writing
  // reads exactly like a product that has quietly stopped sending.
  fireAndForget(
    `INSERT INTO push_sends (user_id, push_type, outcome, devices_sent, devices_failed, quiet_hours)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, type, outcome, sent, failed, quiet],
    'ledger write'
  );
}

// The shape callers already expect, with the ledger row written on the way out
// so no return path can forget one.
function skip(userId, data, reason, extra) {
  record(userId, data, reason, extra);
  return { skipped: true, reason };
}

// ---------------------------------------------------------------------------
// Quiet hours. See the block at the top of the file for what "night" means for
// a nightlife app and which types break through.
// ---------------------------------------------------------------------------
function localClock(timeZone, at = new Date()) {
  if (!timeZone || typeof timeZone !== 'string') return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const f = {};
    for (const p of parts) f[p.type] = p.value;
    const hour = Number(f.hour);
    const minute = Number(f.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { hour, minute };
  } catch {
    return null; // not an IANA name this runtime knows
  }
}

function localHourIn(timeZone, at = new Date()) {
  const clock = localClock(timeZone, at);
  return clock ? clock.hour : null;
}

// Pure, so the window can be tested without a clock or a database.
function isQuietHour(hour) {
  if (!Number.isInteger(hour)) return false;
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

// When the current quiet window ends, as an instant. Used to schedule the
// release rather than polling every minute all night.
function quietWindowEnd(timeZone, at = new Date()) {
  const clock = localClock(timeZone, at);
  if (!clock || !isQuietHour(clock.hour)) return null;
  // Minutes as well as hours, and arithmetic on the instant rather than on a
  // server-local Date. Half-hour zones (Asia/Kolkata, Australia/Adelaide) do
  // not share the server's minute-of-hour, so flattening minutes here would
  // release the row half an hour early and bounce it straight back.
  const minutesLeft = (QUIET_END_HOUR - clock.hour) * 60 - clock.minute;
  // One minute inside the open window rather than exactly on the boundary.
  return new Date(at.getTime() + (minutesLeft + 1) * 60 * 1000);
}

// The zone of the device that most recently TOLD US its clock (migration 085,
// timezone_reported_at, written by every registration that sends a zone, and
// a registration runs on every sign-in and cold start). One clock per person,
// on purpose: quiet hours protect somebody's sleep, and the device they last
// opened is where they are.
//
// This used to order by updated_at, and updated_at is a LIVENESS stamp that
// touchDeviceTokens writes on every row of the account in one statement after
// a clean send. So after any delivered push every row tied, `id DESC` broke
// the tie, and the highest row id won whatever it said: a phone that had just
// registered Europe/London on arrival lost to a laptop row left on
// America/New_York, and was held while its owner was awake or rung at 03:00.
// updated_at stays as the tiebreak for rows from before 085 that have not
// registered since.
async function recipientZone(userId) {
  try {
    const r = await pool.query(
      `SELECT timezone FROM device_tokens
        WHERE user_id = $1 AND timezone IS NOT NULL AND timezone <> ''
        ORDER BY timezone_reported_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [userId]
    );
    if (r.rows.length && r.rows[0].timezone) return String(r.rows[0].timezone);
  } catch (err) {
    // Unknown, which below means deliver. A database blip must not hold
    // somebody's messages.
    return null;
  }
  const fallback = process.env.PUSH_QUIET_DEFAULT_TZ;
  return fallback ? String(fallback) : null;
}

// ---------------------------------------------------------------------------
// The outbox: enqueue, and the sweep that releases it.
// ---------------------------------------------------------------------------
let outboxTimer = null;
let idleSweeps = 0;

function startOutboxSweep() {
  if (outboxTimer) return;
  idleSweeps = 0;
  outboxTimer = setInterval(() => {
    sweepPushOutbox().catch((err) => console.error('[Push] outbox sweep failed:', err.message));
  }, OUTBOX_SWEEP_MS);
  // Same rule as the debounce sweep below it: a cleanup timer must never be
  // the reason a process stays up. `node --test` hangs forever otherwise.
  if (typeof outboxTimer.unref === 'function') outboxTimer.unref();
}

function stopOutboxSweep() {
  if (!outboxTimer) return;
  clearInterval(outboxTimer);
  outboxTimer = null;
}

// `tokenIds` names the devices the row is still owed to (migration 085,
// push_outbox.token_ids). Null, the default, is every device the account has
// when the row is released, which is what every row meant before.
async function enqueue(userId, title, body, data, reason, nextAttemptAt, expiresAt, tokenIds = null) {
  try {
    // Rule 5 of AN SOS ALARM MUST NOT OUTLIVE ITS ALL-CLEAR: an SOS push is
    // queued to expire no later than its alert's deadline, and not queued at
    // all once that has passed. A deadline that cannot be read leaves the
    // expiry the caller gave, and the release asks again.
    const sosType = data && (data.type === 'safety_alert' || data.type === 'safety_alert_cancelled');
    if (sosType) {
      const deadline = await sosDeadline(userId, data);
      if (deadline !== null) {
        if (Date.now() >= deadline) return false;
        const cap = new Date(deadline);
        if (!(expiresAt instanceof Date) || expiresAt > cap) expiresAt = cap;
      }
    }
    if (reason === 'quiet') {
      // ONE held row per conversation. Every debounce window through the
      // night used to add its own row, and the table has no dedupe, so a busy
      // overnight group chat released twenty to forty separate sends at
      // 08:00, each with a sound. apns-collapse-id merges the visible line,
      // not the alerts, which is the failure this file's header claims to
      // prevent. The key is the one buildFcmMessage collapses on: the type and
      // the conversation, asked of firebaseService.scopeKeys so the two cannot
      // drift (the plan, else the person: senderId, else fromUserId; one hold
      // per payer for bill_settled). Keyed on flockId and senderId alone, every
      // friend request and free-tonight pulse overnight shared one row and
      // only the last name reached the morning. The newest words win and the
      // hold's expiry is extended, so the morning gets one line that is
      // current, not the first of forty. A hold is for every device, so a
      // merge clears any device list the row carried.
      const d = data && typeof data === 'object' ? data : {};
      const [scopeA = null, scopeB = null] = firebaseService.scopeKeys(d);
      // Its own guard: a merge that cannot run must fall through to the
      // insert below, never cost the hold.
      let merged = null;
      try {
        merged = await pool.query(
          `UPDATE push_outbox
              SET title = $3, body = $4,
                  data = $5::jsonb || jsonb_build_object(
                    'merged', true,
                    'firstMessageId', COALESCE(push_outbox.data->'firstMessageId', push_outbox.data->'messageId'),
                    'firstDmId', COALESCE(push_outbox.data->'firstDmId', push_outbox.data->'dmId')
                  ),
                  expires_at = GREATEST(expires_at, $6),
                  token_ids = NULL
            WHERE user_id = $1 AND reason = 'quiet'
              AND COALESCE(data->>'type', '') = COALESCE($2, '')
              AND ($7::text IS NULL OR data->>$7::text = $8::text)
              AND ($9::text IS NULL OR data->>$9::text = $10::text)
            RETURNING id`,
          [
            userId,
            d.type != null ? String(d.type) : '',
            String(title == null ? '' : title).slice(0, 500),
            String(body == null ? '' : body).slice(0, 1000),
            JSON.stringify(d),
            expiresAt,
            scopeA,
            scopeA ? String(d[scopeA]) : null,
            scopeB,
            scopeB ? String(d[scopeB]) : null,
          ]
        );
      } catch (mergeErr) {
        console.error('[Push] outbox merge failed, inserting instead:', mergeErr.message);
      }
      if (merged && merged.rowCount > 0) return true;
    }
    await pool.query(
      `INSERT INTO push_outbox (user_id, reason, title, body, data, next_attempt_at, expires_at, token_ids)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::int[])`,
      [
        userId,
        reason,
        String(title == null ? '' : title).slice(0, 500),
        String(body == null ? '' : body).slice(0, 1000),
        JSON.stringify(data && typeof data === 'object' ? data : {}),
        nextAttemptAt,
        expiresAt,
        Array.isArray(tokenIds) && tokenIds.length > 0 ? tokenIds : null,
      ]
    );
    startOutboxSweep();
    return true;
  } catch (err) {
    console.error('[Push] outbox enqueue failed:', err.message);
    return false;
  }
}

// A clean batch means every device we still hold a token for accepted the
// message, so every one of those tokens is demonstrably alive today.
//
// WHY ONLY ON A CLEAN BATCH. updated_at is the ordering key the send path uses
// for "newest first" and the input to the 270-day prune, so freshening it is a
// claim that the row is alive. On a mixed batch we do not know WHICH row
// failed (the provider answer is per token, but this file only sees the
// totals), and re-dating a corpse is how a dead row survives the prune forever.
// Under-claiming costs nothing: every sign-in re-registers the token and writes
// updated_at anyway.
function touchDeviceTokens(userId) {
  fireAndForget(
    'UPDATE device_tokens SET updated_at = NOW() WHERE user_id = $1',
    [userId],
    'token liveness touch'
  );
}

// ---------------------------------------------------------------------------
// The unread count behind the app icon badge.
//
// Two read states since migration 056: direct_messages.read_status for DMs,
// and flock_members.last_read_message_id for flock chat. Both are cleared by
// the app itself (opening a thread marks DMs read, opening a flock chat
// advances the cursor), which is the rule this number lives by: counting
// something the app cannot clear would leave a badge nobody can get rid of,
// which is the one badge failure worse than having none. Every predicate here
// mirrors the reads in routes/messages.js and routes/flocks.js, hidden and
// unsent rows excluded, so the badge counts exactly what the screens show.
//
// Blocked either way is excluded, matching the conversation list in
// routes/messages.js: a message that will never be shown must not sit in the
// count forever. Unsent rows (sender_deleted_at, migration 055) are excluded
// for the same reason with a sharper edge: every read filters them, so the
// recipient can never mark one read, and counting it would inflate the badge
// permanently. A BANNED sender is excluded for exactly that reason too: the
// inbox and the flock history treat a ban as a block (utils/blocks.js
// getInvisibleUserIds), and GET /api/dm/:userId answers a banned counterpart
// before its mark-read runs, so their unread DMs could never be cleared and
// every later push wrote the number back onto the icon. Returns null rather
// than 0 on any failure, because aps.badge of 0 CLEARS the icon and "we could
// not count" is not "you have nothing".
// ---------------------------------------------------------------------------
async function unreadBadge(userId) {
  try {
    const r = await pool.query(
      `SELECT (
          (SELECT COUNT(*)
             FROM direct_messages dm
            WHERE dm.receiver_id = $1
              AND dm.read_status = FALSE
              AND COALESCE(dm.is_hidden, false) = false
              AND dm.sender_deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM user_blocks b
                 WHERE (b.blocker_id = $1 AND b.blocked_id = dm.sender_id)
                    OR (b.blocker_id = dm.sender_id AND b.blocked_id = $1)
              )
              AND NOT EXISTS (
                SELECT 1 FROM users su WHERE su.id = dm.sender_id AND su.is_banned IS TRUE
              ))
        + (SELECT COUNT(*)
             FROM messages m
             JOIN flock_members fm ON fm.flock_id = m.flock_id
                                  AND fm.user_id = $1
                                  AND fm.status = 'accepted'
                                  -- Only memberships whose cursor has MOVED.
                                  -- Migration 056 starts every cursor at 0 and
                                  -- the app builds already installed never call
                                  -- PUT /flocks/:id/read, so counting cursor-0
                                  -- rows put every historical flock message on
                                  -- the icon badge of exactly the clients that
                                  -- can never clear it (code review,
                                  -- 2026-09-01). One real read arms the count
                                  -- for good; until then the DM half still
                                  -- carries the badge, as it always did.
                                  AND fm.last_read_message_id > 0
            WHERE m.id > COALESCE(fm.last_read_message_id, 0)
              AND m.sender_id IS NOT NULL
              AND m.sender_id != $1
              AND m.is_hidden IS NOT TRUE
              AND m.sender_deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM user_blocks b
                 WHERE (b.blocker_id = $1 AND b.blocked_id = m.sender_id)
                    OR (b.blocker_id = m.sender_id AND b.blocked_id = $1)
              )
              AND NOT EXISTS (
                SELECT 1 FROM users su WHERE su.id = m.sender_id AND su.is_banned IS TRUE
              ))
       )::int AS n`,
      [userId]
    );
    const n = r.rows.length ? Number(r.rows[0].n) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (err) {
    return null;
  }
}

// Every push in the app comes through here. An SOS alarm and its all-clear go
// through their slot first, for rule 4 of AN SOS ALARM MUST NOT OUTLIVE ITS
// ALL-CLEAR, NOR AN ALL-CLEAR A NEWER ALARM; everything else goes straight to
// deliverOnce.
async function deliver(userId, title, body, data, opts = {}) {
  const type = data && data.type ? String(data.type) : '';
  if (type === 'safety_alert') return deliverSos('alarm', userId, title, body, data, opts);
  if (type === 'safety_alert_cancelled') return deliverSos('clear', userId, title, body, data, opts);
  return deliverOnce(userId, title, body, data, opts);
}

// An SOS push is registered in its slot from before its checks until its
// answer, and each device's acceptance is recorded as it happens, which is
// what lets every device be checked against what is true once the last push
// has landed. The send itself is deliverOnce's, unchanged; the caller is
// released on the same deadline as every other push.
async function deliverSos(kind, userId, title, body, data, opts = {}) {
  const slot = holdSosSlot(kind, userId, title, body, data, opts.correctionFor || null);
  let result;
  try {
    result = await deliverOnce(userId, title, body, data,
      { ...opts, onAccepted: slot.accepted, onUncertain: slot.uncertain });
  } catch (err) {
    slot.answered();
    throw err;
  }
  // A push that went to the provider for the devices it names: one of them
  // that never answers had no row left to send to (checkSosSlot). One the
  // checks held back went nowhere, and says nothing about any device.
  if (result && !result.skipped && Array.isArray(opts.onlyIds)) slot.owed(opts.onlyIds);
  if (result && result.settled && typeof result.settled.then === 'function') {
    result.settled.then(() => slot.answered(), () => slot.answered());
  } else {
    slot.answered();
  }
  return result;
}

async function deliverOnce(userId, title, body, data, opts = {}) {
  // Enforced HERE, not only in the producer: services/crowdAlerts.js filters
  // its recipients before claiming the alert, but a chokepoint check is what
  // makes "the user's switch works" a property of the type rather than a habit
  // of the one caller that currently sends it.
  const type = data && data.type ? String(data.type) : '';
  if (type === 'crowd_alert' && (await crowdAlertOptedOut(userId))) {
    return skip(userId, data, OUTCOME.OPTED_OUT);
  }
  // Re-run for a released outbox row too, and that is the point of doing it
  // here rather than at enqueue time: a recipient who left the flock, blocked
  // the sender, or was banned while the row waited gets nothing.
  const visibility = await checkVisibility(userId, data);
  if (!visibility.allowed) {
    if (!visibility.uncheckable) return skip(userId, data, OUTCOME.NOT_VISIBLE);
    // Still not sent: an unanswerable check fails closed. But an SOS or its
    // stand-down cannot wait for the app to be opened the way a message can,
    // so it is queued and the sweep asks again (it keeps an uncheckable row
    // for its backoff) rather than the alarm being dropped for good.
    let queued = false;
    if (!opts.fromOutbox && UNCHECKABLE_RETRIED.has(type)) {
      queued = await enqueue(
        userId, title, body, data, 'retry',
        new Date(Date.now() + 60 * 1000), new Date(Date.now() + RETRY_TTL_MS),
        Array.isArray(opts.onlyIds) ? opts.onlyIds : null
      );
    }
    const out = skip(userId, data, OUTCOME.UNCHECKABLE);
    return queued ? { ...out, queued: true } : out;
  }

  // Rule 5 of AN SOS ALARM MUST NOT OUTLIVE ITS ALL-CLEAR: an SOS push
  // released from the outbox after its alert's deadline is dropped, whatever
  // expiry its row carries (enqueue caps it there, but a row can predate
  // that). A push going out fresh is for an alert raised just now, a
  // stand-down inside the window, or a correction rule 4 has just checked.
  if (opts.fromOutbox && (type === 'safety_alert' || type === 'safety_alert_cancelled')) {
    const deadline = await sosDeadline(userId, data);
    if (deadline !== null && Date.now() >= deadline) return skip(userId, data, OUTCOME.EXPIRED);
  }
  // Rule 1: no alarm for an alert its sender has stood down, whether it is
  // going out now, was released from the outbox, or is rule 4 sending it
  // again. The sweep deletes a row this refuses.
  if (type === 'safety_alert' && (await alarmStoodDown(data))) {
    return skip(userId, data, OUTCOME.WITHDRAWN);
  }
  // Rule 3: no all-clear is laid over a newer alarm, whether it is the
  // stand-down's own, a released retry, or rule 4 sending it again.
  if (type === 'safety_alert_cancelled' && (await newerAlarmReached(userId, data))) {
    return skip(userId, data, OUTCOME.SUPERSEDED);
  }

  if (!RINGS_THROUGH_THE_NIGHT.has(type)) {
    const zone = await recipientZone(userId);
    const hour = localHourIn(zone);
    if (isQuietHour(hour)) {
      if (DROPPED_IN_QUIET_HOURS.has(type)) {
        return skip(userId, data, OUTCOME.QUIET_DROPPED, { quiet: true });
      }
      if (!opts.fromOutbox) {
        const releaseAt = quietWindowEnd(zone) || new Date(Date.now() + 60 * 60 * 1000);
        const held = await enqueue(
          userId, title, body, data, 'quiet',
          releaseAt, new Date(Date.now() + QUIET_TTL_MS)
        );
        // Could not persist the hold. Deliver it rather than lose it: a
        // notification at a bad hour is recoverable, a notification that never
        // existed is not.
        if (held) return skip(userId, data, OUTCOME.QUIET_HELD, { quiet: true });
      } else {
        // Released early, the window moved under it (a DST shift), or a
        // RETRY row crossed into the night. The sweep reschedules rather than
        // re-enqueueing a duplicate, and it is told WHEN: without the release
        // time, a retry row was bumped by its own backoff, kept meeting the
        // window, and expired inside it, so a transient failure just before
        // 02:00 was dropped rather than held.
        return { skipped: true, reason: OUTCOME.QUIET_HELD, requeue: true, releaseAt: quietWindowEnd(zone) || null };
      }
    }
  }

  // The app icon badge, computed here because here is where every push in the
  // app converges. See the block above buildFcmMessage in
  // services/firebaseService.js for what the number means and why it is safe to
  // send on every type. A shallow copy rather than a mutation: `data` belongs to
  // the caller, several of whom hand the same object to a whole flock. What the
  // server keeps for itself (SERVER_ONLY_KEYS) is left off here; the retry and
  // the ledger below still read the caller's `data`.
  const badge = await unreadBadge(userId);
  const deviceData = forDevice(data);
  const payload = badge === null ? deviceData : { ...deviceData, badge };

  // A device whose socket is in the room is being looked at, and it gets no
  // banner (notifications audit, 2026-09-05). alreadyInFrontOfThem answers only
  // when EVERY device is attended, so a laptop tab left open somewhere put a
  // banner with sound over the very chat the phone was reading, once per
  // window. The outbox sweep has no socket server and sends to every device,
  // as it did.
  const skipTokens = opts.io ? attentiveTokens(opts.io, userId) : null;
  // A queued row names the devices it is still owed to; everything else goes
  // to every device, as it always did.
  const sendOpts = Array.isArray(opts.onlyIds) ? { skipTokens, onlyIds: opts.onlyIds } : { skipTokens };
  // An SOS push records, as it happens, each device taking a copy and each
  // send that may or may not have arrived (rule 4).
  if (typeof opts.onAccepted === 'function') sendOpts.onAccepted = opts.onAccepted;
  if (typeof opts.onUncertain === 'function') sendOpts.onUncertain = opts.onUncertain;
  const result = await firebaseService.sendPushToUser(userId, title, body, payload, sendOpts);

  // A send still out at the deadline (services/firebaseService.js) may yet
  // land. Deciding now, on the deadline's "failed", is what queued a second
  // copy of a push that had arrived after all. The caller is released on time
  // either way; the retry, the liveness stamp and the ledger row wait for the
  // real answer.
  if (result && result.settled && typeof result.settled.then === 'function') {
    result.settled
      .then((final) => afterSend(userId, title, body, data, type, opts, final))
      .catch((err) => console.error('[Push] late delivery bookkeeping failed:', err.message));
    return result;
  }
  await afterSend(userId, title, body, data, type, opts, result);
  return result;
}

// Which devices a retry goes to: undefined for none, null for every device on
// the account, or the ids of the devices whose send failed for a reason a
// second try can fix. firebaseService names those (retryIds); a tally that
// names no device keeps the rule this file always had, which is to retry
// only when nothing at all was delivered.
function retryTargets(tally, sent) {
  if (tally && Array.isArray(tally.retryIds)) return tally.retryIds.length ? tally.retryIds : undefined;
  return sent === 0 ? null : undefined;
}

// What follows a send, once its answer is final: the liveness stamp, the
// retry, and the one ledger row.
async function afterSend(userId, title, body, data, type, opts, tally) {
  const sent = Number(tally && tally.sent) || 0;
  const failed = Number(tally && tally.failed) || 0;
  const attendedOnly = sent === 0 && failed === 0 && (Number(tally && tally.attended) || 0) > 0;

  if (sent > 0 && failed === 0) touchDeviceTokens(userId);

  if (failed > 0 && !opts.fromOutbox && !OWN_RETRY.has(type)) {
    // Something answered with an error. Usually that is an FCM 5xx or a
    // network blip, which a second attempt fixes. A token the provider called
    // dead has already been deleted and is not retried.
    //
    // ONLY THE DEVICES THAT FAILED. The retry used to be all or nothing: a
    // batch where the laptop accepted and the phone got a 5xx was never
    // retried at all, because a second send to every device would have told
    // the laptop twice, so the phone simply never got the notification. The
    // row now names the phone and nothing else (push_outbox.token_ids).
    //
    // First retry a minute out: longer than any blip, shorter than a person
    // noticing.
    //
    // Not for an SOS alarm whose alert has been stood down by the time the
    // send answered (rule 2 of AN SOS ALARM MUST NOT OUTLIVE ITS ALL-CLEAR). A
    // send still running at the deadline answers here after the stand-down
    // has already cleared the outbox, and its retry put "needs help" back on
    // the lock screen a minute after "says they are OK".
    const targets = retryTargets(tally, sent);
    const withdrawnAlarm = targets !== undefined && type === 'safety_alert' && (await alarmStoodDown(data));
    if (targets !== undefined && !withdrawnAlarm) {
      // One queued copy of an SOS push per device. A send that fails on a
      // device rule 4 is correcting, and a correction that fails there too,
      // each queue one, and both would ring a minute later.
      if (Array.isArray(targets) && (type === 'safety_alert' || type === 'safety_alert_cancelled')) {
        await forgetQueuedSosCopies(userId, data, targets)
          .catch((err) => console.error('[Push] could not drop a queued SOS copy:', err.message));
      }
      await enqueue(
        userId, title, body, data, 'retry',
        new Date(Date.now() + 60 * 1000), new Date(Date.now() + RETRY_TTL_MS),
        targets
      );
    }
  }

  record(userId, data, sent > 0 ? OUTCOME.DELIVERED : failed > 0 ? OUTCOME.FAILED : attendedOnly ? OUTCOME.ONLINE : OUTCOME.NO_DEVICE, {
    sent,
    failed,
  });
}

function forgetOutboxRow(id) {
  fireAndForget('DELETE FROM push_outbox WHERE id = $1', [id], 'outbox cleanup');
}

// Narrow a row to the devices still owed it. A row that cannot be narrowed is
// dropped rather than left pointing at devices that already have it: the
// fallback is the old rule, which never sent anything twice.
async function narrowOwed(id, deviceIds) {
  try {
    await pool.query('UPDATE push_outbox SET token_ids = $2::int[] WHERE id = $1', [id, deviceIds]);
    return true;
  } catch (err) {
    console.error('[Push] outbox narrow failed, dropping the row:', err.message);
    forgetOutboxRow(id);
    return false;
  }
}

// A row whose send was still out at the deadline. It is moved past the
// provider's own retries first (firebase-admin gives one send up to five
// attempts of 15 seconds), so no sweep takes it again before the answer is
// in, and is then settled the way the loop in sweepPushOutbox settles a row
// whose answer it has: forgotten once it landed everywhere it was owed,
// narrowed when some device is still owed it, left for its backoff when
// nothing landed and tries remain.
function parkUntilSettled(row, settled) {
  fireAndForget(
    `UPDATE push_outbox SET next_attempt_at = GREATEST(next_attempt_at, NOW() + INTERVAL '5 minutes') WHERE id = $1`,
    [row.id],
    'outbox park'
  );
  settled
    .then(async (final) => {
      const sent = Number(final && final.sent) || 0;
      const failed = Number(final && final.failed) || 0;
      const owed = final && Array.isArray(final.retryIds) ? final.retryIds : [];
      const lastTry = row.attempts >= RETRY_MAX_ATTEMPTS;
      if (sent > 0 && owed.length > 0 && !lastTry) {
        await narrowOwed(row.id, owed);
        return;
      }
      if (sent > 0 || failed === 0 || lastTry) forgetOutboxRow(row.id);
    })
    .catch((err) => console.error('[Push] outbox settle failed:', err.message));
}

// ---------------------------------------------------------------------------
// The sweep. Claims due rows with FOR UPDATE SKIP LOCKED so a second Railway
// instance running the same sweep at the same second takes a different set,
// and advances next_attempt_at inside the claim so a crash between the claim
// and the send costs a delay rather than a duplicate.
// ---------------------------------------------------------------------------
async function sweepPushOutbox() {
  if (disabled()) return 0;

  let rows;
  try {
    const claimed = await pool.query(
      `WITH due AS (
         SELECT id FROM push_outbox
          WHERE next_attempt_at <= NOW()
          ORDER BY next_attempt_at
          LIMIT ${OUTBOX_BATCH}
          FOR UPDATE SKIP LOCKED
       )
       UPDATE push_outbox o
          SET attempts = o.attempts + 1,
              next_attempt_at = NOW() + CASE
                WHEN o.reason = 'quiet' THEN INTERVAL '30 minutes'
                ELSE INTERVAL '1 minute' * POWER(2, LEAST(o.attempts, 4))
              END
         FROM due
        WHERE o.id = due.id
    RETURNING o.id, o.user_id, o.reason, o.title, o.body, o.data, o.attempts, o.expires_at, o.token_ids`
    );
    rows = claimed.rows || [];
  } catch (err) {
    console.error('[Push] outbox claim failed:', err.message);
    return 0;
  }

  if (rows.length === 0) {
    idleSweeps += 1;
    if (idleSweeps >= OUTBOX_IDLE_SWEEPS) stopOutboxSweep();
    return 0;
  }
  idleSweeps = 0;

  const drop = [];
  for (const row of rows) {
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      // A notification nobody can act on any more. Recorded rather than
      // deleted in silence, because "how often do we give up" is one of the
      // two numbers this whole ledger exists to make answerable.
      record(row.user_id, data, OUTCOME.EXPIRED, { quiet: row.reason === 'quiet' });
      drop.push(row.id);
      continue;
    }

    let result = null;
    try {
      // A merged quiet row names only its newest message. When that one was
      // unsent or hidden before morning, the release used to drop the whole
      // conversation's notification (notifications audit, 2026-09-05). The row
      // is re-pointed at the newest message the person can still see, with a
      // body that quotes nothing and a title that names that message's sender,
      // and the visibility check inside deliver() then judges that message.
      const repaired = row.reason === 'quiet' && data.merged === true
        ? await repairMergedHold(row.user_id, data)
        : null;
      result = await deliver(
        row.user_id,
        repaired && repaired.title ? repaired.title : row.title,
        repaired ? repaired.body : row.body,
        repaired ? repaired.data : data,
        // A row that names its devices goes to those and no others.
        Array.isArray(row.token_ids) ? { fromOutbox: true, onlyIds: row.token_ids } : { fromOutbox: true }
      );
    } catch (err) {
      console.error('[Push] outbox delivery threw:', err.message);
    }

    const sent = Number(result && result.sent) || 0;
    const stillQuiet = Boolean(result && result.requeue);
    if (stillQuiet) {
      // The claim moved next_attempt_at by the row's own backoff. For a row
      // that has to wait for morning, that is the wrong clock: move it to the
      // window's end and keep it alive until then, whatever its reason.
      const at = result.releaseAt instanceof Date && !Number.isNaN(result.releaseAt.getTime()) ? result.releaseAt : null;
      if (at) {
        await pool.query(
          /* $2 IS CAST IN BOTH PLACES. Assigned bare it is unknown to the
             planner, so `$2 + INTERVAL '1 hour'` resolves as interval plus
             interval and GREATEST is then asked to match a timestamptz against
             an interval, which it refuses. The driver sends parameters
             untyped, so the server makes that same deduction at run time: this
             statement could never reschedule a row. It fails into a catch that
             only logs, which is why a quiet-hours row quietly kept its old
             wake-up time instead of moving to the end of the window. */
          `UPDATE push_outbox
              SET next_attempt_at = $2::timestamptz,
                  reason = 'quiet',
                  expires_at = GREATEST(expires_at, $2::timestamptz + INTERVAL '1 hour')
            WHERE id = $1`,
          [row.id, at]
        ).catch((err) => console.error('[Push] outbox reschedule failed:', err.message));
      }
      continue;
    }
    // A send still out at the deadline decides this row when it answers, not
    // now: a retry scheduled on the deadline's "failed" went out a second time
    // after the first had landed.
    if (result && result.settled && typeof result.settled.then === 'function') {
      parkUntilSettled(row, result.settled);
      continue;
    }
    if (sent > 0) {
      // Some devices took it. Any whose send failed for a reason a retry can
      // fix is still owed it, and only those: the row is narrowed to them and
      // keeps the backoff the claim gave it. It used to be dropped whole, so
      // the phone that got the 5xx never heard.
      const owed = Array.isArray(result.retryIds) ? result.retryIds : [];
      if (owed.length > 0 && row.attempts < RETRY_MAX_ATTEMPTS) {
        await narrowOwed(row.id, owed);
        continue;
      }
      drop.push(row.id);
      continue;
    }
    // A row the recipient will never be allowed to see is finished. A row we
    // could not ASK about is not - it goes back for its own backoff, and the
    // attempts ceiling below still stops it eventually.
    if (result && result.skipped && result.reason === OUTCOME.UNCHECKABLE) {
      // The claim already moved next_attempt_at by this row's own backoff, so
      // continuing schedules the retry rather than spinning. The ceiling still
      // applies: an outage that outlasts RETRY_MAX_ATTEMPTS ends the row here
      // rather than leaving it to be re-attempted until its TTL.
      if (row.attempts >= RETRY_MAX_ATTEMPTS) drop.push(row.id);
      continue;
    }
    if (result && result.skipped) { drop.push(row.id); continue; } // never becomes visible
    // Nothing failed and nothing sent means the account has no registered
    // device any more. Retrying that produces the same nothing forever.
    const failed = Number(result && result.failed) || 0;
    if (result && failed === 0) { drop.push(row.id); continue; }
    if (row.attempts >= RETRY_MAX_ATTEMPTS) drop.push(row.id);
  }

  if (drop.length) {
    await pool
      .query('DELETE FROM push_outbox WHERE id = ANY($1)', [drop])
      .catch((err) => console.error('[Push] outbox cleanup failed:', err.message));
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Housekeeping, called from the crowd-alert sweep (every 15 minutes) rather
// than from a timer of its own. Rate-limited per process so two instances do
// not both run it every quarter hour.
// ---------------------------------------------------------------------------
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
let lastMaintenance = 0;

async function sweepPushMaintenance(force = false) {
  const now = Date.now();
  if (!force && now - lastMaintenance < MAINTENANCE_INTERVAL_MS) return false;
  lastMaintenance = now;

  const step = async (sql, params) => {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      console.warn('[Push] maintenance step failed:', err.message);
      return null;
    }
  };

  await step(
    `DELETE FROM push_sends WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [LEDGER_RETENTION_DAYS]
  );
  await step("DELETE FROM push_outbox WHERE expires_at < NOW() - INTERVAL '1 day'");
  await step("DELETE FROM push_debounce WHERE sent_at < NOW() - INTERVAL '1 hour'");
  // The rot this exists to stop: FCM expires a token after roughly 270 days of
  // app inactivity, and a row past that point is a failed send on every
  // notification the account will ever receive, forever, with the only symptom
  // being a `failed` count nobody was reading until this week.
  await step(
    `DELETE FROM device_tokens
      WHERE COALESCE(updated_at, created_at) < NOW() - ($1::int * INTERVAL '1 day')`,
    [TOKEN_MAX_IDLE_DAYS]
  );
  return true;
}

// The rollup behind "did pushes go out this week, and did they land". Returned
// rather than printed so a panel, a script or a one-off can all use the same
// numbers.
async function pushDeliveryStats(days = 7) {
  const window = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 90) : 7;
  const r = await pool.query(
    `SELECT push_type, outcome,
            COUNT(*)::int                        AS pushes,
            COALESCE(SUM(devices_sent), 0)::int  AS devices_sent,
            COALESCE(SUM(devices_failed), 0)::int AS devices_failed
       FROM push_sends
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY push_type, outcome
      ORDER BY pushes DESC`,
    [window]
  );
  const rows = r.rows || [];
  const totals = { attempts: 0, delivered: 0, devicesReached: 0, failed: 0, held: 0, suppressed: 0 };
  for (const row of rows) {
    totals.attempts += row.pushes;
    totals.devicesReached += row.devices_sent;
    if (row.outcome === OUTCOME.DELIVERED) totals.delivered += row.pushes;
    else if (row.outcome === OUTCOME.FAILED || row.outcome === OUTCOME.EXPIRED) totals.failed += row.pushes;
    else if (row.outcome === OUTCOME.QUIET_HELD) totals.held += row.pushes;
    else totals.suppressed += row.pushes;
  }
  return { days: window, totals, byTypeAndOutcome: rows };
}

// Nothing below does any database work when push is not configured — several
// suites assert that a push-triggering route touches no unscripted query.
function disabled() {
  return !firebaseService.isEnabled();
}

// The cross-instance half of the chat debounce. One statement, so it needs no
// transaction: the upsert only writes when the stored timestamp is already
// older than the window, and exactly one caller can win that write.
async function claimDebounce(key) {
  try {
    const r = await pool.query(
      `INSERT INTO push_debounce (debounce_key, sent_at)
       VALUES ($1, NOW())
       ON CONFLICT (debounce_key) DO UPDATE
          SET sent_at = NOW()
        WHERE push_debounce.sent_at < NOW() - ($2::int * INTERVAL '1 millisecond')
       RETURNING debounce_key`,
      [key, DEBOUNCE_MS]
    );
    return r.rowCount === 1;
  } catch (err) {
    // Fail open. See the caller's comment: a duplicate notification is a small
    // cost, a lost one is the failure this whole change exists to remove.
    return true;
  }
}

function releaseDebounce(key) {
  fireAndForget('DELETE FROM push_debounce WHERE debounce_key = $1', [key], 'debounce release');
}

// "Is this notification already in front of them, on every device it would
// reach?" That is the question the old isUserOnline check was standing in for,
// and the long block above everyDeviceAttended is why the substitution failed.
// The database read only happens when there IS a live socket, so the common
// case (recipient offline, which is the whole reason a push exists) still costs
// nothing extra, and a deployment with push unconfigured still touches no
// database at all.
async function alreadyInFrontOfThem(io, userId) {
  if (!isUserOnline(io, userId)) return false;
  if (disabled()) return true; // nothing to send anyway; do not spend a query
  return everyDeviceAttended(io, userId);
}

// Send push only if the notification is not already in front of the user
async function pushIfOffline(io, userId, title, body, data = {}) {
  if (await alreadyInFrontOfThem(io, userId)) {
    if (disabled()) return { skipped: true, reason: 'online' };
    return skip(userId, data, OUTCOME.ONLINE);
  }
  if (disabled()) return { skipped: true, reason: 'disabled' };
  return deliver(userId, title, body, data, { io });
}

// Send push only if user is offline AND not debounced
async function pushIfOfflineDebounced(io, userId, title, body, data = {}) {
  if (await alreadyInFrontOfThem(io, userId)) {
    if (disabled()) return { skipped: true, reason: 'online' };
    return skip(userId, data, OUTCOME.ONLINE);
  }
  if (disabled()) return { skipped: true, reason: 'disabled' };

  const key = debounceKey(userId, data);
  const now = Date.now();
  const lastSent = lastPushSent.get(key);
  if (lastSent && now - lastSent < DEBOUNCE_MS) {
    return skip(userId, data, OUTCOME.DEBOUNCED);
  }

  // Claimed before the send so two concurrent messages can't both pass, and
  // rolled back if the send never happened — otherwise a blocked or invisible
  // recipient burned the window for the next legitimate notification.
  lastPushSent.set(key, now);

  // THE SECOND LAYER, and the reason this one is durable.
  //
  // Three debounces guard the push path. crowd_alert_sends (migration 007) is
  // a real DB claim. This one and the invite debounce in routes/flocks.js were
  // in-heap Maps, which is a window that does not exist the moment Railway runs
  // two instances: each process holds its own copy, so a message debounced on
  // instance A goes out again from instance B, and a deploy clears every window
  // at once. The Map above is kept as a free local fast path; push_debounce
  // (migration 050) is what makes the window true across processes.
  //
  // Fails OPEN, unlike canNotify. Losing this claim means one duplicate
  // notification; refusing to send because the database blinked means a lost
  // message, and the whole point of this change is that a notification is
  // never silently dropped.
  const claimed = await claimDebounce(key);
  if (!claimed) {
    lastPushSent.delete(key);
    return skip(userId, data, OUTCOME.DEBOUNCED);
  }

  const result = await deliver(userId, title, body, data, { io });
  // Release the window if nothing actually went out. A recipient who was
  // invisible, or who had no registered device at that instant, must not have
  // the next thirty seconds of their notifications suppressed on the strength
  // of a delivery that never happened. A quiet-hours hold DID happen (the
  // notification exists, in push_outbox, waiting for morning), so it keeps the
  // window: releasing it would let the next forty messages each queue their own
  // copy of the same conversation.
  // A quiet hold releases the claim too (notifications audit, 2026-09-05).
  // It used to be kept, so the second and later messages of each 30 s window
  // were DEBOUNCED and never reached the merge, and the held body was the
  // FIRST message of the window rather than the newest. The merge is
  // idempotent per conversation, so every held message may go through it.
  // A send still in flight at the deadline keeps the window: it is far more
  // often slow than lost, and if it is lost deliver() retries it.
  const nothingSent = !result || result.skipped || (result.sent === 0 && !result.settled);
  if (nothingSent) {
    lastPushSent.delete(key);
    releaseDebounce(key);
  }
  return result;
}

// Send push regardless of online status. Two callers, both time-sensitive
// enough that "already in the app" is not a reason to stay silent: the
// organizer-initiated budget reminder (routes/budget.js) and the pre-event
// crowd alert (services/crowdAlerts.js). Not a channel for anything
// promotional — see the 4.5.4 block at the top of this file.
// ---------------------------------------------------------------------------
// BADGE SYNC (2026-09-01). The icon badge is an ABSOLUTE number that only ever
// travelled on an alert push, so it moved when a notification arrived and at
// no other time. A user who opened the app and read everything kept whatever
// number the last push had set, until some later push happened to carry a
// lower one. Nothing on the client sets or clears a badge, and no badge plugin
// is installed, so the only writer is the server. This sends a badge-only push,
// no alert, no sound, carrying the same unreadBadge() count deliver() attaches
// to every alert, so a read that empties the count clears the icon. Called
// fire-and-forget from the read routes; a push failure must never fail a read.
// ---------------------------------------------------------------------------
async function pushBadgeSync(userId) {
  if (disabled()) return { skipped: true, reason: 'disabled' };
  const badge = await unreadBadge(userId);
  if (badge === null) return { skipped: true, reason: 'unreadable' };
  try {
    return await firebaseService.sendBadgeToUser(userId, badge);
  } catch (err) {
    console.error('[Push] badge sync failed:', err && err.message ? err.message : err);
    return { sent: 0, failed: 0 };
  }
}

async function pushAlways(userId, title, body, data = {}) {
  if (disabled()) return { skipped: true, reason: 'disabled' };
  return deliver(userId, title, body, data);
}

module.exports = {
  pushBadgeSync,
  unreadBadge,
  isUserOnline,
  pushIfOffline,
  pushIfOfflineDebounced,
  pushAlways,
  canNotify,
  debounceKey,
  // Delivery machinery. sweepPushOutbox releases retries and quiet-hours
  // holds; sweepPushMaintenance ages out dead device tokens and trims the
  // ledger. Both are driven from services/crowdAlerts.js, which server.js
  // already schedules, so neither needs a timer of its own in the boot path.
  sweepPushOutbox,
  sweepPushMaintenance,
  // "Did pushes go out this week, and did they land."
  pushDeliveryStats,
  // Quiet hours, exported as pure functions so the window and the release
  // arithmetic are testable without a clock, a zone or a database.
  isQuietHour,
  localHourIn,
  quietWindowEnd,
  QUIET_START_HOUR,
  QUIET_END_HOUR,
  RINGS_THROUGH_THE_NIGHT,
  DROPPED_IN_QUIET_HOURS,
  // The presence fix: which devices a live socket actually speaks for.
  attentiveTokens,
  repairMergedHold,
  // Whose clock quiet hours read (migration 085).
  recipientZone,
  everyDeviceAttended,
  OUTCOME,
  // ---------------------------------------------------------------------------
  // FOR THE THIRD DEBOUNCE, WHICH IS STILL IN A HEAP.
  //
  // routes/flocks.js holds `lastInvitePush`, an in-process Map keyed
  // `${user_id}|flock_invite` with the same 30 second window as this file's.
  // Like the chat one before today, it does not exist across two Railway
  // instances: each process has its own copy, so an invite debounced on
  // instance A is sent again by instance B, and a deploy clears every window.
  //
  // Adopting the durable half is one line at each of its two call sites, and
  // needs no new key format: `${user_id}|flock_invite` is already what this
  // file's debounceKey produces for a type with no scope.
  //
  //   if (!(await claimDebounce(key))) return { skipped: true, reason: 'debounced' };
  //   ... and releaseDebounce(key) wherever it deletes from the Map today.
  //
  // Both fail OPEN, so a database blip sends a duplicate rather than swallowing
  // an invite.
  claimDebounce,
  releaseDebounce,
  // The crowd-alert preference reader. services/crowdAlerts.js uses it to
  // filter recipients before burning the once-per-flock claim; deliver() above
  // re-checks it at send time.
  wantsCrowdAlerts,
  // Background producers (services/crowdAlerts.js) ask this BEFORE they do the
  // scoring and the paid weather call that build a notification nothing can
  // deliver — and, just as importantly, before they write a marker row saying
  // the notification was already sent.
  isPushConfigured: () => !disabled(),
  // What the server keeps off a device (see AN SOS ALARM MUST NOT OUTLIVE ITS
  // ALL-CLEAR), exported so a test can hold the list to what is stripped.
  SERVER_ONLY_KEYS,
  // Rule 3, for the stand-down's socket event, which routes/safety.js sends
  // itself: nobody a newer alarm from the sender has reached is told "OK".
  newerSosAlarmReached: newerAlarmReached,
  // How many SOS slots are open. A test reads it to see the register drain.
  _openSosSlots: () => sosSlots.size,
  // What a restart forgets: the SOS alarms this process sent, so a test can
  // make rule 4 build the push it needs from Postgres.
  _forgetSosContent: () => sosAlarmCopies.clear(),
  // How long a check that could not read Postgres waits before each retry;
  // null restores SOS_RECHECK_DELAYS_MS.
  _setSosRecheckDelays: (delays) => {
    sosRecheckDelays = Array.isArray(delays) ? delays : SOS_RECHECK_DELAYS_MS;
  },
  // How many times one device is corrected to one push, and the alert window
  // that count and rule 5 both run on, so a test can hold it to the
  // stand-down's.
  SOS_CORRECTIONS_PER_KEY,
  SOS_ALERT_WINDOW_MS,
  // Test seam: the debounce window is process-global state, and so is the
  // register of SOS pushes still on their way, the copies of what was sent,
  // and the count of corrections.
  _resetDebounce: () => {
    lastPushSent.clear();
    sosSlots.clear();
    sosAlarmCopies.clear();
    sosCorrections.clear();
    lastMaintenance = 0;
    stopOutboxSweep();
  },
};
