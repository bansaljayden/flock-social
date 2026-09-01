// ---------------------------------------------------------------------------
// COLLECTION HEARTBEAT (2026-09-01)
// ---------------------------------------------------------------------------
// Jayden's standing order the day collection restarted: the nightly BestTime
// pull runs until he cancels the subscription, about five months. The Railway
// cron that does the pulling exits silently on failure (restart NEVER, by
// design for a cron), so a broken deploy, a dead key, a vendor block, or a
// misconfigured schedule would stop the corpus growing and nobody would
// notice for weeks. That exact silence already cost this project once: the
// original corpus froze on 2026-05-18 and the freeze was discovered months
// later.
//
// This watches the DATA, not the job, which catches every failure mode in
// one place: if no realtime rows have landed in the last WINDOW_HOURS, one
// email goes out per quiet day to the same address moderation alerts use.
// The window is 26 hours so a cron that fires daily at 02:00 UTC has a full
// day plus slack before the alarm, and the sweep runs hourly so the alert
// lands within an hour of the window expiring rather than at some fixed
// time of day.
//
// Once-per-day dedupe lives in ops_alert_ledger (migration 058), NOT in
// process memory: the first version kept it in RAM, and two deploys on
// 2026-09-01 mailed Jayden twice inside an hour because each restart forgot
// it had already sent. The INSERT ... ON CONFLICT DO NOTHING is the whole
// mutex: only the caller whose insert lands sends the email, atomically,
// across restarts and replicas alike.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { sendEmail } = require('./emailService');

const WINDOW_HOURS = 26;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function alertAddresses() {
  return String(process.env.MODERATION_ALERT_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

function heartbeatEnabled() {
  // Default ON wherever email can actually send; the sweep itself is one
  // COUNT an hour. HEARTBEAT_DISABLED=true is the kill switch.
  return String(process.env.HEARTBEAT_DISABLED || '').toLowerCase() !== 'true';
}

async function runCollectionHeartbeat() {
  try {
    if (!heartbeatEnabled()) return;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM ml_training_data
        WHERE collection_mode = 'realtime'
          AND collected_at > NOW() - ($1 || ' hours')::interval`,
      [WINDOW_HOURS]
    );
    const fresh = rows[0]?.n ?? 0;
    if (fresh > 0) {
      // Healthy. Reset nothing: lastAlertDate only gates repeats within a
      // day, and a recovery followed by a new failure deserves a new email.
      return;
    }

    const to = alertAddresses();
    if (to.length === 0) {
      console.error(`[HEARTBEAT] No realtime rows in ${WINDOW_HOURS}h and MODERATION_ALERT_EMAIL is unset; nobody was mailed.`);
      return;
    }
    // Claim today's send slot durably before mailing. No row back means an
    // earlier boot already claimed it today.
    const claim = await pool.query(
      `INSERT INTO ops_alert_ledger (alert_key, sent_on)
       VALUES ('collection_heartbeat', CURRENT_DATE)
       ON CONFLICT (alert_key, sent_on) DO NOTHING
       RETURNING sent_on`
    );
    if (claim.rows.length === 0) return;
    await sendEmail({
      to: to[0],
      subject: 'Flock data collection has stopped',
      text: [
        `No live crowd observations have landed in ml_training_data in the last ${WINDOW_HOURS} hours.`,
        '',
        'The nightly BestTime pull (Railway service BESTTIME, cron 0 2 * * *) has likely failed.',
        'Check, in order: the Railway service logs, the BestTime subscription state,',
        'and whether the last deploy changed scripts/ml/collectRealtime.js.',
        '',
        'This alert repeats at most once a day while collection stays stopped.',
      ].join('\n'),
    });
    console.error(`[HEARTBEAT] Collection stopped: no realtime rows in ${WINDOW_HOURS}h. Alert mailed.`);
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
