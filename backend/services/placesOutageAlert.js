// ---------------------------------------------------------------------------
// THE HALF OF THE PLACES ALARM THAT ACTUALLY REACHES A PERSON
// ---------------------------------------------------------------------------
// utils/placesHealth.js counts the failures. server.js's money watch says so
// with console.error and Sentry.captureMessage. On this deployment BOTH of
// those are the same dead end the September outage already proved:
//
//   * console.error goes to the Railway log, and the Railway log carried
//     "[PublicDemo] Places search failed: HTTP 429" thousands of times for five
//     days while nobody read it. That is the failure, not the fix.
//   * Sentry is a NO-OP here. instrument.js disables it when SENTRY_DSN is
//     unset, and it is unset in production — the boot log prints
//     "Sentry DISABLED: SENTRY_DSN is unset" on every deploy.
//
// So an alarm that only did those two things would have detected the outage
// perfectly and still told the maintainer nothing. This is the channel that works,
// copied deliberately from services/collectionHeartbeat.js rather than
// invented: same MODERATION_ALERT_EMAIL recipients, same ops_alert_ledger
// dedupe, same release-the-claim-on-failure rule.
//
// WHY THE LEDGER AND NOT AN IN-MEMORY FLAG. Migration 058 was written because
// the heartbeat's "already sent today" lived in process RAM and two deploys on
// 2026-09-01 mailed the maintainer twice inside an hour about one condition. The money
// watch's sayOnceToday has exactly that shape, so the EMAIL claim goes through
// Postgres and survives every restart. The log line can repeat; an inbox may
// not.
const pool = require('../config/database');
const { sendEmail } = require('./emailService');
const { placesHealthStatus } = require('../utils/placesHealth');

const ALERT_KEY = 'places_outage';

function alertAddresses() {
  return String(process.env.MODERATION_ALERT_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

/** "4 hours", "12 minutes", "less than a minute". */
function forPhrase(ms) {
  const mins = Math.round(ms / 60000);
  if (mins >= 120) return `${Math.round(mins / 60)} hours`;
  if (mins >= 1) return `${mins} minutes`;
  return 'less than a minute';
}

function body(h) {
  return [
    `Google Places has failed ${h.consecutiveFailures} times in a row, with no`,
    `success in between, over the last ${forPhrase(h.failingForMs)}.`,
    '',
    h.reasons.length ? `What Google said: ${h.reasons.join(', ')}.` : '',
    '',
    'What is broken for users right now: venue search, venue photos, the crowd',
    'card and the public demo on flockcorp.com. The app degrades to a plain',
    '"could not load" message rather than showing an empty list, so this looks',
    'like nothing to a user and like nothing in the product analytics.',
    '',
    'This is NOT a spend ceiling. utils/placesBudget.js has its own alarm for',
    'that, and it cannot see this one, because a call Google REFUSES costs',
    'nothing and never moves the spend counter.',
    '',
    'Check, in order:',
    '  1. The per-day quotas on the project that owns GOOGLE_PLACES_API_KEY.',
    '     On 2026-08-21 all four were clamped by hand in the Cloud Console to',
    '     37 / 38 / 152 / 10 a day, which killed Places for five days starting',
    '     2026-09-01 and survived every midnight rollover, because 37 calls are',
    '     gone within minutes of each reset. That project is NOT the one named',
    '     "Flock"; it is the one whose number appears in Google\'s error text.',
    '  2. Billing on that same project.',
    '  3. Whether the API key was restricted or rotated.',
    '',
    'Diagnose with fresh coordinates, never repeated ones: routes/publicCrowd.js',
    'caches an area search for 20 minutes in ~1km buckets, so asking twice about',
    'the same place replays the last good answer and fakes a recovery.',
    '',
    '  curl "https://api.flockcorp.com/api/public/demo/venues?lat=39.95&lng=-75.16"',
    '',
    'This alert repeats at most once a day while Places stays broken.',
  ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n');
}

/**
 * Mail once a day while Places is failing. Never throws, never refuses a
 * request, never touches a counter — a watchdog that can break the thing it
 * watches is worse than no watchdog.
 *
 * @param {object} [status] injectable for tests; defaults to the live reading.
 */
async function runPlacesOutageAlert(status) {
  try {
    const h = status || placesHealthStatus();
    if (!h.unhealthy) return { skipped: 'healthy' };

    const to = alertAddresses();
    if (to.length === 0) {
      console.error('[PlacesHealth] Places is failing and MODERATION_ALERT_EMAIL is unset; nobody was mailed.');
      return { skipped: 'no-recipient' };
    }

    // Claim today's slot durably BEFORE mailing. No row back means an earlier
    // run (or an earlier boot) already claimed it today.
    const claim = await pool.query(
      `INSERT INTO ops_alert_ledger (alert_key, sent_on)
       VALUES ($1, CURRENT_DATE)
       ON CONFLICT (alert_key, sent_on) DO NOTHING
       RETURNING sent_on`,
      [ALERT_KEY]
    );
    if (claim.rows.length === 0) return { skipped: 'already-sent-today' };

    try {
      await sendEmail({
        to: to[0],
        subject: 'Google Places is down for Flock',
        text: body(h),
      });
    } catch (sendErr) {
      // Release the claim. Holding it after a failed send buys a full day of
      // silence from the one thing whose entire job is to break silence, and a
      // duplicate email costs nothing by comparison. Same rule, same reason as
      // services/collectionHeartbeat.js.
      await pool.query(
        'DELETE FROM ops_alert_ledger WHERE alert_key = $1 AND sent_on = CURRENT_DATE',
        [ALERT_KEY]
      ).catch(() => {});
      throw sendErr;
    }

    console.error(`[PlacesHealth] Places failing (${h.consecutiveFailures} in a row). Alert mailed.`);
    return { mailed: true };
  } catch (err) {
    console.error('[PlacesHealth] alert failed:', err && err.message ? err.message : err);
    return { failed: true };
  }
}

module.exports = { runPlacesOutageAlert, ALERT_KEY, alertAddresses };
