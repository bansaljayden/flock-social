'use strict';
// ---------------------------------------------------------------------------
// THE ROOST NOTICE: one email per venue account that existed before Terms 9.6
// put a price on Roost, and the 30 days that email starts.
//
// Terms 9.6 used to say nothing in the venue dashboard costs money and promised
// at least 30 days' notice at the account's email before any venue was charged
// anything. The section that replaced it keeps that promise for every venue
// account created before ROOST_PRICED_FROM (services/venueEntitlements.js):
//
//   * this file emails each of them once, and the email names a date
//     ROOST_NOTICE_DAYS out (templates/roostNoticeEmail.js);
//   * venue_roost_notices (migration 077) records that date, and until it
//     arrives the venue keeps everything it has today, which is every feature,
//     as while enforcement is off (getVenueEntitlement reads the window);
//   * a venue that subscribes inside the window is never charged before that
//     date (services/venueBilling.js sets the Stripe trial_end from it, and
//     sends this notice first if it has not gone out yet).
//
// A venue account created on or after ROOST_PRICED_FROM signed up under the
// priced Terms: no notice, the ordinary 14-day trial, ordinary enforcement.
//
// NOTHING SENDS WHILE VENUE_BILLING_ENABLED IS OFF. The flag is the moment the
// price becomes real, so it is also the moment the notice goes out, from the
// sweep that runs at boot (a Railway variable change restarts the service) and
// once a day after.
//
// A ROW ONLY FOR A SEND THE PROVIDER ACCEPTED. A refusal, a skip (no
// RESEND_API_KEY) or an unknown outcome writes nothing, and the next run tries
// again. The window only starts when a row exists, so a send that did not
// happen can never shorten anybody's 30 days; it can only mean a second copy of
// the same email if an unknown outcome had in fact gone out.
//
// TRANSACTIONAL, NOT MARKETING. This is notice about the venue's own account
// and what it will cost, the kind of message an unsubscribe from a marketing
// list does not reach. A bounce or a spam complaint still stops it, inside
// sendEmail, exactly as for every other message (services/emailSuppression.js),
// and a venue that cannot be reached that way simply stays in its window: it
// keeps everything and cannot be charged until a notice gets through.
//
// WHO IS MAILED: the owner of a venue profile created before the cutoff, not
// banned, with a verified, mailable address. The same address bar the Monday
// digest holds, so a venue account signed up on somebody else's address is not
// what mails that somebody. An unverified owner stays in the window.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { venueBillingEnabled, ROOST_PRICED_FROM, ROOST_NOTICE_DAYS } = require('./venueEntitlements');
const { sendEmail, isMailableAddress, maskAddress } = require('./emailService');
const { roostNoticeSubject, renderRoostNoticeHtml, renderRoostNoticeText } = require('../templates/roostNoticeEmail');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTICE_MS = ROOST_NOTICE_DAYS * DAY_MS;
// Once a day, plus the boot run. The notice is one email per venue for the
// life of the product, so a day's delay on a retry costs nothing: the venue
// is inside its window the whole time.
const ROOST_NOTICE_SWEEP_INTERVAL_MS = DAY_MS;
// Venues per run. A venue that can never be mailed (a bounced address) stays
// due forever, so the batch is sized well above the number of venue accounts
// that exist, and the log says when it is full.
const SWEEP_BATCH = 200;

// Accounts whose notice is being sent right now, so the sweep and a checkout
// landing in the same second cannot mail one owner twice. The app runs on one
// instance (root project documentation).
const inflight = new Set();

const DUE_WHERE = `vn.user_id IS NULL
    AND (vp.created_at IS NULL OR vp.created_at < $1::timestamptz)
    AND u.is_banned IS NOT TRUE
    AND u.email_verified = true
    AND u.email IS NOT NULL`;

const DUE_SQL = `SELECT vp.user_id, vp.business_name, u.email
   FROM venue_profiles vp
   JOIN users u ON u.id = vp.user_id
   LEFT JOIN venue_roost_notices vn ON vn.user_id = vp.user_id
  WHERE ${DUE_WHERE}
  ORDER BY vp.user_id
  LIMIT $2::int`;

const ONE_SQL = `SELECT vp.user_id, vp.business_name, u.email
   FROM venue_profiles vp
   JOIN users u ON u.id = vp.user_id
   LEFT JOIN venue_roost_notices vn ON vn.user_id = vp.user_id
  WHERE ${DUE_WHERE}
    AND vp.user_id = $2::int
  LIMIT 1`;

const RECORD_SQL = `INSERT INTO venue_roost_notices (user_id, emailed_at, charge_not_before)
  VALUES ($1::int, $2::timestamptz, $3::timestamptz)
  ON CONFLICT (user_id) DO NOTHING
  RETURNING charge_not_before`;

const EXISTING_SQL = 'SELECT charge_not_before FROM venue_roost_notices WHERE user_id = $1::int';

// One owner. Returns { sent, chargeNotBefore, outcome }. Throws only on a
// database failure after a send, which leaves no row and so is retried.
async function sendOne(row, nowMs) {
  const userId = row.user_id;
  if (inflight.has(userId)) return { sent: false, chargeNotBefore: null, outcome: 'in_flight' };
  if (!isMailableAddress(row.email)) return { sent: false, chargeNotBefore: null, outcome: 'unmailable' };
  inflight.add(userId);
  try {
    const emailedAt = new Date(nowMs);
    const chargeNotBefore = new Date(nowMs + NOTICE_MS);
    const input = { businessName: row.business_name, chargeNotBefore };
    const result = await sendEmail({
      to: row.email,
      category: 'transactional',
      subject: roostNoticeSubject(input),
      html: renderRoostNoticeHtml(input),
      text: renderRoostNoticeText(input),
    });
    if (!result || result.sent !== true) {
      const outcome = result && result.suppressed ? 'suppressed' : result && result.skipped ? 'skipped' : 'failed';
      console.warn(`[roost-notice] not sent to ${maskAddress(row.email)} (${outcome}${result && result.error ? `: ${result.error}` : ''}); the venue keeps everything until one is, and the next run tries again.`);
      return { sent: false, chargeNotBefore: null, outcome };
    }
    const r = await pool.query(RECORD_SQL, [userId, emailedAt, chargeNotBefore]);
    if (r.rows && r.rows[0]) return { sent: true, chargeNotBefore: new Date(r.rows[0].charge_not_before), outcome: 'sent' };
    // Another path recorded a notice for this account first. Its date stands:
    // it is the one that owner was told.
    const e = await pool.query(EXISTING_SQL, [userId]);
    const existing = e.rows && e.rows[0] ? new Date(e.rows[0].charge_not_before) : chargeNotBefore;
    return { sent: true, chargeNotBefore: existing, outcome: 'sent' };
  } finally {
    inflight.delete(userId);
  }
}

async function runRoostNoticeSweep(now = new Date()) {
  const tally = { due: 0, sent: 0, failed: 0, skipped: 0 };
  if (!venueBillingEnabled()) return tally;
  let rows;
  try {
    const r = await pool.query(DUE_SQL, [ROOST_PRICED_FROM, SWEEP_BATCH]);
    rows = Array.isArray(r.rows) ? r.rows : [];
  } catch (err) {
    console.error('[roost-notice] could not read the venues due a notice:', err && err.message);
    return tally;
  }
  for (const row of rows) {
    tally.due += 1;
    try {
      const out = await sendOne(row, now.getTime());
      if (out.sent) tally.sent += 1;
      else if (out.outcome === 'failed') tally.failed += 1;
      else tally.skipped += 1;
    } catch (err) {
      tally.failed += 1;
      console.error(`[roost-notice] notice for venue user ${row.user_id} was sent but could not be recorded, so it will be sent again:`, err && err.message);
    }
  }
  if (tally.due) {
    console.log(`[roost-notice] sweep: ${tally.due} due, ${tally.sent} sent, ${tally.failed} failed, ${tally.skipped} skipped${rows.length === SWEEP_BATCH ? ' (batch full; the rest go next run)' : ''}`);
  }
  return tally;
}

// A pre-existing venue starting checkout before the sweep has reached it: send
// its notice now, so its window has an end and its first charge a floor.
// Answers the date the notice named, or null when no notice could be sent
// (the caller then floors the charge at 30 days from now instead).
async function sendNoticeForCheckout(userId, now = Date.now()) {
  if (!venueBillingEnabled()) return null;
  const r = await pool.query(ONE_SQL, [ROOST_PRICED_FROM, userId]);
  const row = r.rows && r.rows[0];
  if (!row) return null;
  const out = await sendOne(row, now);
  return out.sent ? out.chargeNotBefore : null;
}

module.exports = {
  runRoostNoticeSweep,
  sendNoticeForCheckout,
  NOTICE_MS,
  ROOST_NOTICE_SWEEP_INTERVAL_MS,
  SWEEP_BATCH,
  __test: { DUE_SQL, ONE_SQL, RECORD_SQL, EXISTING_SQL, inflight },
};
