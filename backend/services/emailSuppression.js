// ---------------------------------------------------------------------------
// The do-not-mail list, and the one place that reads it.
// ---------------------------------------------------------------------------
// This has to sit on the SEND PATH, not on a screen. A suppression list that
// only the dashboard consults is a suppression list that the Monday digest
// sweep, the waitlist confirmation and every future sender walk straight past,
// and each of them is a separate place to forget. So the check lives inside
// services/emailService.js sendEmail(), which every outbound message in the
// codebase already goes through, and this module is what that check calls.
//
// FAIL OPEN, DELIBERATELY. If the database is unreachable, this answers "not
// suppressed" and mails. The alternative is a Postgres blip silently swallowing
// a password reset and an SOS alert to a minor's parent, which is a far worse
// failure than one message to an address that had bounced. The read is logged
// when it fails so the blip is visible.
//
// The cache exists because the digest sweep asks once per venue in a loop and
// the SOS path asks while somebody is in trouble. Entries are small, the TTL is
// short, and a suppression that arrives mid-TTL costs at most one more send.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;

// Reasons that stop everything, versus the one that stops marketing only. An
// address that does not exist cannot receive a password reset either; an
// address whose owner unsubscribed from the waitlist still needs to be able to
// reset their password.
const HARD_REASONS = new Set(['bounce', 'complaint']);
const VALID_REASONS = new Set(['bounce', 'complaint', 'unsubscribe']);

// THE ONE CATEGORY NO SUPPRESSION STOPS, AND WHY.
//
// A trusted contact is a third party who never signed up. Their address is on
// file because a teenager typed it into a safety screen and named them as the
// person to reach if something goes wrong. Two things could otherwise put that
// address on this list and silently disarm the SOS button:
//
//   * a hard bounce, which is a DELIVERABILITY signal and not a consent
//     signal. It says the last attempt failed. It does not say the person
//     refuses to hear from us, and a mailbox that was full or a server that
//     was misconfigured in March is not evidence about tonight.
//   * a complaint, which arrives from a marketing message. A parent hitting
//     "spam" on a Monday venue digest has refused the digest. They have not
//     refused an ambulance.
//
// So the emergency path is allowed through both. The cost of being wrong in
// this direction is one message to a dead address, which costs a fraction of a
// deliverability point. The cost of being wrong in the other direction is an
// emergency alert that is never sent and never seen to fail, on the one route
// in this codebase where nobody gets a second attempt. Those are not
// comparable, so this is not a close call.
//
// THE BOUNDARY IS DELIBERATELY NARROW. 'emergency' is the SOS route in
// routes/safety.js and nothing else. Not the safety test email, not the
// share-my-location email, not password reset, not verification. Everything
// else stays 'transactional' and keeps obeying a hard bounce, because the
// argument above is an argument about an emergency and generalises to nothing.
// If a second caller ever wants this category, it needs the same argument made
// about it in writing, here, first.
//
// WHAT PAYS FOR THIS. Bypassing the list means the user is the only person who
// can notice a broken contact address, so the Safety screen has to tell them.
// GET /api/safety/contacts marks a contact whose address is on this list and
// App.js renders that beside the contact, which is the actionable form of the
// problem: the fix is a working address, not a swallowed alert.
//
// The privacy policy states this exception in the same words
// (website/PrivacyPolicy.js, "Email, and how to stop it"). If this constant
// changes, that page changes in the same commit.
const EMERGENCY_CATEGORY = 'emergency';

// One normalisation for the read and the write, so "Jay@Example.com " and
// "jay@example.com" cannot end up as two rows, one of which is never matched.
// Case folding stops at the domain boundary for nobody: RFC 5321 says the local
// part is the receiving server's business, but every provider Flock actually
// mails treats it case-insensitively, and the alternative here is a suppression
// row that the next send misses because the person capitalised their name.
function normalizeAddress(addr) {
  if (typeof addr !== 'string') return '';
  return addr.trim().toLowerCase();
}

const cache = new Map(); // normalised address -> { reason, expiresAt }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.reason; // null means "checked, not suppressed"
}

function cacheSet(key, reason) {
  if (cache.size > CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) if (now > v.expiresAt) cache.delete(k);
    if (cache.size > CACHE_MAX_ENTRIES) cache.clear();
  }
  cache.set(key, { reason, expiresAt: Date.now() + CACHE_TTL_MS });
}

function resetCache() {
  cache.clear();
}

// Returns the suppression reason string, or null when the address may be
// mailed. Never throws.
async function suppressionReason(addr) {
  const key = normalizeAddress(addr);
  if (!key) return null;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  try {
    const r = await pool.query('SELECT reason FROM email_suppressions WHERE email = $1', [key]);
    const reason = r.rowCount ? r.rows[0].reason : null;
    cacheSet(key, reason);
    return reason;
  } catch (err) {
    // Fail open. See the header: a blocked SOS is worse than a wasted send.
    console.error('[emailSuppression] lookup failed, mailing anyway:', err.message);
    return null;
  }
}

// The question the send path actually asks. `category` is 'marketing' for the
// Monday digest and the waitlist confirmation, 'emergency' for the SOS alert
// and nothing else, and 'transactional' for everything in between
// (verification, password reset, share-location, moderation alerts).
//
// Returns { blocked: false } or { blocked: true, reason }.
async function checkSendAllowed(addr, category = 'transactional') {
  // Asked BEFORE the lookup, so an emergency does not wait on a database read
  // it is going to ignore. See EMERGENCY_CATEGORY above for the whole
  // argument; the short version is that a bounce is a deliverability fact and
  // an SOS is not a subscription.
  if (category === EMERGENCY_CATEGORY) return { blocked: false, bypassed: true };
  const reason = await suppressionReason(addr);
  if (!reason) return { blocked: false };
  if (HARD_REASONS.has(reason)) return { blocked: true, reason };
  if (category === 'marketing') return { blocked: true, reason };
  return { blocked: false };
}

// Record a suppression. Upserts, and the reason only ever gets STRONGER: an
// address that stopped existing does not start existing again because somebody
// later clicked an unsubscribe link from an old message. Order is bounce,
// then complaint, then unsubscribe.
// Returns true when the row is in place. Never throws.
async function suppress(addr, reason, detail) {
  const key = normalizeAddress(addr);
  if (!key || !VALID_REASONS.has(reason)) return false;
  const text = typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 500) : null;
  try {
    await pool.query(
      `INSERT INTO email_suppressions (email, reason, detail)
            VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
            SET reason = CASE
                  WHEN email_suppressions.reason = 'bounce' OR EXCLUDED.reason = 'bounce' THEN 'bounce'
                  WHEN email_suppressions.reason = 'complaint' OR EXCLUDED.reason = 'complaint' THEN 'complaint'
                  ELSE EXCLUDED.reason END,
                detail = COALESCE(EXCLUDED.detail, email_suppressions.detail),
                updated_at = NOW()`,
      [key, reason, text]
    );
    cache.delete(key);
    return true;
  } catch (err) {
    console.error('[emailSuppression] could not record suppression:', err.message);
    return false;
  }
}

module.exports = {
  checkSendAllowed,
  suppressionReason,
  suppress,
  normalizeAddress,
  resetCache,
  HARD_REASONS,
  VALID_REASONS,
  EMERGENCY_CATEGORY,
  CACHE_TTL_MS,
};
