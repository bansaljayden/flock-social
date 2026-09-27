// ---------------------------------------------------------------------------
// OPS ALERTS: THE ONE WAY THIS SERVER TELLS A PERSON SOMETHING IS BROKEN
// ---------------------------------------------------------------------------
// Three services already mailed the operator once a day through
// ops_alert_ledger (migration 058): collectionHeartbeat.js, costHeartbeat.js
// and placesOutageAlert.js. Each kept its own copy of the same claim, send,
// release-on-failure code, and all three reached an inbox and nothing else.
//
// Meanwhile the alarms with the most user-visible consequences reached nobody
// at all. The money watch in server.js reports a spent Cloud Vision ceiling
// (every photo upload in the app refused until 00:00 UTC) and a spent Gemini
// ceiling (Birdie and the Roost advisor answer 429) with console.error and
// Sentry.captureMessage, and emailService's alarm reports a dead Resend key
// the same way. Sentry is a no-op on this deployment because SENTRY_DSN is
// unset, so every one of those lands in a Railway log nobody reads.
//
// This is the shape they all share now:
//
//   1. CLAIM today's row for `key` in ops_alert_ledger. No row back means an
//      earlier run, or an earlier boot, already told somebody today. The claim
//      lives in Postgres rather than process memory because migration 058
//      exists precisely because an in-memory "already sent" was reset by two
//      deploys in an hour and mailed the operator twice.
//
//   2. SEND over each leg the caller asked for:
//        email  MODERATION_ALERT_EMAIL, through services/emailService.js
//        push   every ADMIN_USER_IDS account, through services/pushHelper.js,
//               the same path every other push takes. Quiet hours apply, so an
//               alert raised at 03:00 waits on the phone until morning while
//               the email is already in the inbox.
//
//   3. RELEASE the claim when no leg reached anybody. Holding it after every
//      send failed buys a silent day from the one thing whose job is to break
//      silence, and a duplicate alert costs nothing by comparison.
//
// A leg cannot report its own outage: an alarm about email asks for the push
// leg only, and an alarm about push asks for email only.
//
// IT NEVER THROWS. Every caller is a watchdog on a timer or inside a send, and
// a watchdog that can break the thing it watches is worse than no watchdog.
// ---------------------------------------------------------------------------
const pool = require('../config/database');
// Held as a module object, not destructured: tests replace sendEmail on the
// module, and a destructured copy would keep calling the original.
const emailService = require('./emailService');

const LEGS = ['email', 'push'];

// A push body is a lock-screen line, not an email. Anything longer is cut by
// the phone anyway, and cutting it here keeps the ellipsis in a sane place.
const PUSH_TITLE_MAX = 60;
const PUSH_BODY_MAX = 180;

function alertAddresses() {
  return String(process.env.MODERATION_ALERT_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

// The same variable server.js reads to grant role='admin' at boot, so "who
// gets an ops push" and "who can open the admin dashboard" cannot drift apart.
function adminUserIds() {
  return String(process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function clamp(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

async function claimToday(key) {
  const claim = await pool.query(
    `INSERT INTO ops_alert_ledger (alert_key, sent_on)
     VALUES ($1, CURRENT_DATE)
     ON CONFLICT (alert_key, sent_on) DO NOTHING
     RETURNING sent_on`,
    [key]
  );
  return claim.rows.length > 0;
}

async function releaseToday(key) {
  await pool
    .query('DELETE FROM ops_alert_ledger WHERE alert_key = $1 AND sent_on = CURRENT_DATE', [key])
    .catch(() => {});
}

// emailService.sendEmail fails SOFT: a refused or failed send comes back as
// { sent: false } rather than a throw. The three alerts this file replaced
// only caught throws, so a Resend outage read as "mailed" and held the day's
// claim. Either shape of failure counts here.
async function sendEmailLeg(to, subject, text) {
  try {
    const r = await emailService.sendEmail({ to, subject, text });
    // Strict: only an answer that says the mail left counts. A skipped send
    // (no key, a suppressed address) is not a delivery either.
    if (!r || r.sent !== true) return { ok: false, error: (r && (r.error || r.reason)) || (r && r.skipped ? 'no email key' : 'not sent') };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// A push counts as reaching somebody when a device took it, when it is still
// in flight at the deadline (it is far more often slow than lost, and the
// outbox retries it), or when quiet hours are holding it for the morning.
function pushReached(r) {
  if (!r) return false;
  if (Number(r.sent) > 0) return true;
  if (r.settled) return true;
  return r.skipped === true && r.reason === 'quiet-held';
}

async function sendPushLeg(ids, key, title, body) {
  let pushHelper;
  try {
    // Lazy: pushHelper loads firebaseService, and firebaseService raises its
    // own alarm through this file, so a top-level require would be a cycle.
    // eslint-disable-next-line global-require
    pushHelper = require('./pushHelper');
  } catch (err) {
    return { ok: false, error: `pushHelper failed to load: ${err.message}` };
  }
  const results = await Promise.allSettled(
    ids.map((id) => pushHelper.pushAlways(id, title, body, { type: 'ops_alert', alert: key }))
  );
  const reached = results.filter((r) => r.status === 'fulfilled' && pushReached(r.value)).length;
  if (reached > 0) return { ok: true, reached };
  const why = results.map((r) => (r.status === 'rejected'
    ? (r.reason && r.reason.message) || 'rejected'
    : (r.value && r.value.reason) || 'nothing delivered'));
  return { ok: false, error: [...new Set(why)].join(', ') };
}

/**
 * Tell a person, at most once per `key` per calendar day.
 *
 * @param {object} alert
 * @param {string} alert.key      ledger key; one alert per key per day. Never
 *                                put an address, an id or any user data in it.
 * @param {string} alert.subject  email subject
 * @param {string} alert.text     email body
 * @param {object} [alert.push]   { title, body } for the lock screen. Defaults
 *                                to the subject and the first line of the text.
 * @param {string[]} [alert.legs] which of 'email' and 'push' to use.
 * @param {string} [alert.tag]    log prefix, e.g. '[PlacesHealth]'.
 * @returns {Promise<object>} { sent: true, legs } | { skipped: reason } | { failed: true }
 */
async function opsAlert({ key, subject, text, push, legs = LEGS, tag = '[ops-alert]' } = {}) {
  try {
    if (typeof key !== 'string' || !key) return { skipped: 'no-key' };
    const wanted = Array.isArray(legs) ? legs.filter((l) => LEGS.includes(l)) : LEGS;
    const to = wanted.includes('email') ? alertAddresses() : [];
    const admins = wanted.includes('push') ? adminUserIds() : [];
    if (to.length === 0 && admins.length === 0) {
      // Doing nothing quietly here would recreate the original bug one layer
      // up: a watchdog that looks armed and reaches nobody. And it does not
      // burn the day's claim, so setting the variable takes effect at once.
      const need = wanted.map((l) => (l === 'email' ? 'MODERATION_ALERT_EMAIL' : 'ADMIN_USER_IDS')).join(' or ');
      console.error(`${tag} ${subject}, and ${need} is unset; nobody was told.`);
      return { skipped: 'no-recipient' };
    }

    if (!(await claimToday(key))) return { skipped: 'already-sent-today' };

    const pushTitle = clamp((push && push.title) || subject, PUSH_TITLE_MAX);
    // The lock screen has room for what broke, not for what to do about it.
    // When the email leg is going out too, the push says where the rest is.
    const pointer = to.length ? ' The alert email has the details.' : '';
    const firstLine = String(text || '').split('\n').find((l) => l.trim()) || subject;
    const pushBody = clamp((push && push.body) || firstLine, PUSH_BODY_MAX - pointer.length) + pointer;

    const [emailOut, pushOut] = await Promise.all([
      to.length ? sendEmailLeg(to[0], subject, text) : null,
      admins.length ? sendPushLeg(admins, key, pushTitle, pushBody) : null,
    ]);

    const reached = [];
    if (emailOut && emailOut.ok) reached.push('email');
    if (pushOut && pushOut.ok) reached.push('push');
    if (emailOut && !emailOut.ok) console.error(`${tag} alert email failed: ${emailOut.error}`);
    if (pushOut && !pushOut.ok) console.error(`${tag} alert push reached no admin device: ${pushOut.error}`);

    if (reached.length === 0) {
      await releaseToday(key);
      return { failed: true };
    }
    console.error(`${tag} ${subject}. Alert sent by ${reached.join(' and ')}.`);
    return { sent: true, legs: reached };
  } catch (err) {
    console.error(`${tag} alert failed:`, err && err.message ? err.message : err);
    return { failed: true };
  }
}

module.exports = {
  opsAlert,
  alertAddresses,
  adminUserIds,
  pushReached,
  PUSH_TITLE_MAX,
  PUSH_BODY_MAX,
};
