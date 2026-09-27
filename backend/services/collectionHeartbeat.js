// ---------------------------------------------------------------------------
// COLLECTION HEARTBEAT (2026-09-01)
// ---------------------------------------------------------------------------
// The standing order the day collection restarted: the BestTime pull
// runs until the subscription is cancelled, about five months. The Railway
// cron that does the pulling exits silently on failure (restart NEVER, by
// design for a cron), so a broken deploy, a dead key, a vendor block, or a
// misconfigured schedule would stop the corpus growing and nobody would
// notice for weeks. That exact silence already cost this project once: the
// original corpus froze on 2026-05-18 and the freeze was discovered months
// later.
//
// This watches the DATA, not the job, which catches every failure mode in
// one place: if too little has landed in the last WINDOW_HOURS, one email
// goes out per quiet day to the same address moderation alerts use. The
// window is 26 hours, a full day plus slack, and the sweep runs hourly so
// the alert lands within an hour of the window expiring rather than at some
// fixed time of day.
//
// THE CADENCE CHANGED UNDER THIS FILE AND THE THRESHOLDS DID NOT (fixed
// 2026-09-06). Everything above was written for a cron that fired once a
// night at 02:00 UTC. The collector runs HOURLY at :07 now, and its own
// time budget is written against that (`collectRealtime.js` records Railway
// skipping the 02:07 trigger while the 01:07 sweep was still running). The
// floor stayed where a single nightly run had put it: 200 rows, against a
// measured 3,779 in the trailing 26 hours. A collector that lost 94% of its
// yield would have passed. Worse, one that died outright was still covered
// for a day by the tail of good rows already inside the window, which is the
// one failure this file exists to catch quickly.
//
// So there are two floors now, and either one trips the alarm. ROWS catches
// a collector that degrades. HOURS catches one that stops, because on an
// hourly cadence a healthy window has rows in all 26 hours and a dead
// collector's hour count falls immediately while its row count coasts.
//
// Once-per-day dedupe lives in ops_alert_ledger (migration 058), NOT in
// process memory: the first version kept it in RAM, and two deploys on
// 2026-09-01 mailed the operator twice inside an hour because each restart forgot
// it had already sent. The INSERT ... ON CONFLICT DO NOTHING is the whole
// mutex: only the caller whose insert lands sends the email, atomically,
// across restarts and replicas alike. That claim, the send and the release on
// a failed send are services/opsAlert.js's now, shared with every other ops
// alert, which also adds a push to each ADMIN_USER_IDS account.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { opsAlert } = require('./opsAlert');

const WINDOW_HOURS = 26;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// A run that aborts after twenty venues leaves rows behind, so a bare
// "any rows at all" test stays silent through exactly the failure the
// collector's own throttle wall produces (2026-09-01 review).
//
// Sized against measurement, not against an expected venue count, because
// the expected count is what went stale last time. Trailing 26 hours read
// 2026-09-06: 3,779 rows over 27 distinct hours, per-hour mean 140, thinnest
// hour 33. Recent full days: 3,002 and 3,490. A third of the weakest of
// those is the floor, so a two-thirds collapse alarms while an ordinary
// quiet Sunday does not.
const MIN_HEALTHY_ROWS = 1000;
// Of 26 hours. Measured coverage is every hour, so this is better than
// twice the margin, and it is the threshold that catches a collector dead
// for half a day: at that point roughly 1,800 rows are still inside the
// window and the row floor alone would say nothing.
const MIN_HEALTHY_HOURS = 12;

function heartbeatEnabled() {
  // Default ON wherever email can actually send; the sweep itself is one
  // COUNT an hour. HEARTBEAT_DISABLED=true is the kill switch.
  return String(process.env.HEARTBEAT_DISABLED || '').toLowerCase() !== 'true';
}

async function runCollectionHeartbeat() {
  try {
    if (!heartbeatEnabled()) return;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(DISTINCT date_trunc('hour', collected_at))::int AS hours
         FROM ml_training_data
        WHERE collection_mode = 'realtime'
          AND collected_at > NOW() - ($1 || ' hours')::interval`,
      [WINDOW_HOURS]
    );
    const fresh = rows[0]?.n ?? 0;
    const hours = rows[0]?.hours ?? 0;
    const rowsLow = fresh < MIN_HEALTHY_ROWS;
    const hoursLow = hours < MIN_HEALTHY_HOURS;
    if (!rowsLow && !hoursLow) return;

    // Three shapes, and the email says which, because the first thing anyone
    // does with this alert is guess at the cause. STOPPED is nothing at all.
    // STALLED is the tell that the cron quit: plenty of rows still inside the
    // window, but they all landed in a handful of hours near its far edge.
    // DEGRADED is the collector still firing every hour and yielding little,
    // which is a throttle wall or an expiring key, not a dead job.
    const state = fresh === 0 ? 'stopped' : (rowsLow ? 'degraded' : 'stalled');

    // The claim is taken before the send and released if nothing reached
    // anybody, so a failed send never buys a day of silence from the one
    // service whose entire job is to break silence (2026-09-01 review). The
    // key stays 'collection_heartbeat': services/moneyHub.js reads the date of
    // the last alert by it.
    const out = await opsAlert({
      key: 'collection_heartbeat',
      subject: {
        stopped: 'Flock data collection has stopped',
        stalled: 'Flock data collection has stopped firing',
        degraded: 'Flock data collection is failing partway',
      }[state],
      text: [
        {
          stopped: `No live crowd observations have landed in ml_training_data in the last ${WINDOW_HOURS} hours.`,
          stalled: `${fresh} live crowd observations landed in ml_training_data in the last ${WINDOW_HOURS} hours, but only across ${hours} distinct hours out of ${WINDOW_HOURS}. The hourly run has stopped firing and what is in the window is the tail of the last good hours.`,
          degraded: `Only ${fresh} live crowd observations landed in ml_training_data in the last ${WINDOW_HOURS} hours, against roughly 3,000 expected. The hourly run is starting and dying partway.`,
        }[state],
        '',
        'The BestTime pull (Railway service BESTTIME, cron 7 * * * *, hourly) has likely failed.',
        'Check, in order: the Railway service logs, the BestTime subscription state,',
        'and whether the last deploy changed scripts/ml/collectRealtime.js.',
        '',
        'This alert repeats at most once a day while collection stays broken.',
      ].join('\n'),
      push: {
        title: 'Data collection is down',
        body: `${fresh} live crowd rows over ${hours} of the last ${WINDOW_HOURS} hours. The hourly BestTime pull has likely failed.`,
      },
      tag: '[HEARTBEAT]',
    });
    if (out.sent) {
      console.error(`[HEARTBEAT] Collection ${state}: ${fresh} realtime rows over ${hours} distinct hours in ${WINDOW_HOURS}h.`);
    }
  } catch (err) {
    // The heartbeat must never take the app down with it.
    console.error('[HEARTBEAT] sweep failed:', err && err.message ? err.message : err);
  }
}

module.exports = {
  runCollectionHeartbeat,
  heartbeatEnabled,
  SWEEP_INTERVAL_MS,
  __test: {
    // Dedupe state lives in the database now; nothing in-process to reset.
    reset() {},
  },
};
