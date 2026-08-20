// ---------------------------------------------------------------------------
// Monday venue digest (ADVISOR-PRODUCT-SHAPE.md section 1: the same four
// advisor cards the dashboard serves, rendered as one email so the Pro card
// line "Your week in numbers, every Monday" is true with the same code).
//
// What this service owns: WHO gets mailed and WHEN. What it does not own:
// any number. Facts come from services/advisorFacts.js (the fact engine the
// cards route uses) and wording comes from templates/venueDigestEmail.js.
// This file never composes a figure.
//
// The gates, in the order they are checked, every one of which must pass
// before a single row is read for rendering:
//
//   1. DIGEST_ENABLED=true. Unset or anything else, the sweep returns without
//      touching the database. Nothing sends until Jayden flips it.
//   2. It is Monday morning (07:00 to 11:59) on the VENUE'S wall clock:
//      ml_venues.timezone when the venue is in the corpus, America/New_York
//      otherwise (both live markets are in it).
//   3. venue_profiles.notification_prefs.weekly is true. The column default
//      is false, so the digest is opt-in via the dashboard's "Weekly reports"
//      switch, which this send finally makes real (see the pinned-open note
//      in __tests__/alertPreferences.test.js).
//   4. The owner has a verified, mailable address and is not banned.
//   5. Tier: Pro gets the full digest, Premium gets the events heads-up only
//      (PRO-VS-PREMIUM.md), free and unclaimed venues get nothing. While
//      VENUE_BILLING_ENABLED is unset every claimed venue acts Pro, the same
//      pilot posture as the dashboard gates.
//   6. A venue_digest_sends marker row is claimed (INSERT ... ON CONFLICT DO
//      NOTHING) BEFORE the send, so overlapping containers on a Monday deploy
//      cannot double-mail. A failed send releases its marker for the next
//      hourly sweep to retry; a skipped send (no RESEND_API_KEY) does too.
//
// The opt-out link in every email is a signed token (JWT_SECRET, single
// purpose claim) that flips notification_prefs.weekly back to false with no
// login, because CAN-SPAM does not care that the dashboard also has a switch.
// The link itself only opens a confirmation page: the write happens on POST,
// from that page's button or from a mail client's RFC 8058 one-click, so a
// scanner that fetches every href in a message cannot unsubscribe anyone. Both
// halves live below (readOptOutState, applyOptOut); the two headers that make
// one-click work are set at the send.
// ---------------------------------------------------------------------------
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { boolFlag } = require('./entitlements');
const { venueBillingEnabled, resolveGrantedTier } = require('./venueEntitlements');
const { sendEmail, baseApiUrl, isMailableAddress, maskAddress } = require('./emailService');
const { renderDigestHtml, renderDigestText, digestSubject } = require('../templates/venueDigestEmail');

const OPT_OUT_PURPOSE = 'venue_digest_optout';
const FALLBACK_TIMEZONE = 'America/New_York';
const SEND_HOUR_FIRST = 7;   // venue-local, inclusive
const SEND_HOUR_LAST = 11;   // venue-local, inclusive
const MARKER_RETENTION_DAYS = 90;

function digestEnabled() {
  return boolFlag('DIGEST_ENABLED');
}

// ---------------------------------------------------------------------------
// Venue-local clock. Intl handles the IANA zone math; a junk zone string from
// the corpus falls back rather than throwing a whole sweep away.
// ---------------------------------------------------------------------------
function localParts(now, timeZone) {
  let zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : FALLBACK_TIMEZONE;
  let dtf;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
  } catch (err) {
    zone = FALLBACK_TIMEZONE;
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
  }
  const parts = {};
  for (const p of dtf.formatToParts(now)) parts[p.type] = p.value;
  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // "24" is midnight in some ICU builds
  };
}

function isMondayMorning(parts) {
  return parts.weekday === 'Mon' && parts.hour >= SEND_HOUR_FIRST && parts.hour <= SEND_HOUR_LAST;
}

// The local Monday as 'YYYY-MM-DD', the dedupe key.
function isoDate(y, m, d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(m)}-${p(d)}`;
}

// "Aug 11 to Aug 17": the week being recapped, i.e. last Monday through last
// Sunday in the venue's calendar. Dates, not statistics; every figure in the
// body still comes from a fact object.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function lastWeekLabel(parts) {
  const monday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const from = new Date(monday.getTime() - 7 * 24 * 3600 * 1000);
  const to = new Date(monday.getTime() - 1 * 24 * 3600 * 1000);
  return `${MONTHS[from.getUTCMonth()]} ${from.getUTCDate()} to ${MONTHS[to.getUTCMonth()]} ${to.getUTCDate()}`;
}

// ---------------------------------------------------------------------------
// Opt-out: signed, single-purpose, no login.
//
// SECURITY ROUND 25. This token used to be signed with JWT_SECRET itself, and
// the purpose claim was the only thing keeping the two families apart. That
// held in ONE direction and by accident in the other:
//
//   * digest token -> session verifier: middleware/auth.js verifies the
//     SIGNATURE against the same secret, so it passed, and was then rejected
//     only because `decoded.userId` is undefined and the user lookup finds
//     nobody. Nothing checks a purpose on the session side. Any future token
//     minted against JWT_SECRET that happens to carry BOTH a userId and its
//     own purpose would be accepted as a full 24-hour session.
//   * this token is also immune to token_version: a password change, a
//     /logout-all, an OAuth squat eviction — every one of them kills every
//     session JWT and none of them touch an outstanding opt-out link, which
//     lives 180 days in a URL query string.
//
// So the key is DERIVED rather than shared. An HMAC of JWT_SECRET under a
// purpose label is a different key: a session token cannot verify here and a
// token minted here cannot verify anywhere else, whatever claims either
// carries and whoever forgets a check later. The purpose claim stays as the
// in-band statement of intent, but it is no longer the only thing standing
// between the two families.
//
// `algorithms` is pinned for the reason routes/users.js:428 already writes
// down: an undefined `algorithms` makes jsonwebtoken infer the accepted set
// from the key instead of pinning it. This was the one jwt.verify in the
// backend without it.
//
// The v1 label is part of the derivation, so rotating the opt-out family
// (without logging every user out) is a one-character change. Nothing is
// invalidated by this edit: DIGEST_ENABLED is off, so no link has ever been
// mailed.
// ---------------------------------------------------------------------------
const OPT_OUT_ALGORITHMS = ['HS256'];
const OPT_OUT_KEY_LABEL = `flock:${OPT_OUT_PURPOSE}:v1`;

function optOutKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', String(secret)).update(OPT_OUT_KEY_LABEL).digest();
}

function optOutToken(venueProfileId) {
  return jwt.sign({ vp: venueProfileId, purpose: OPT_OUT_PURPOSE }, optOutKey(), {
    algorithm: OPT_OUT_ALGORITHMS[0],
    expiresIn: '180d',
  });
}

function optOutUrl(venueProfileId) {
  return `${baseApiUrl()}/api/venue-digest/opt-out?token=${encodeURIComponent(optOutToken(venueProfileId))}`;
}

// The verifier both verbs share. Returns the payload or null; never throws.
function verifyOptOutToken(token) {
  const key = optOutKey();
  if (!key) return null;
  let payload;
  try {
    payload = jwt.verify(token, key, { algorithms: OPT_OUT_ALGORITHMS });
  } catch (err) {
    return null;
  }
  if (payload.purpose !== OPT_OUT_PURPOSE || !Number.isInteger(payload.vp)) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// The READ half, added when the unsubscribe link stopped mutating on GET.
//
// A link in an email is fetched by things that are not the recipient: Microsoft
// Defender Safe Links, Proofpoint URL Defense and Gmail's own scanner all
// follow every href in a message before a person has seen it. A GET that
// unsubscribed on arrival would therefore unsubscribe venues who never clicked,
// and the owner's only evidence would be a switch that turned itself off. So
// the emailed GET now RENDERS, and this is all it needs from the database: is
// the weekly switch still on, so the page can either offer the button or say
// the account is already unsubscribed. One SELECT, no write.
//
// Returns { ok: true, alreadyOff } or { ok: false, error }. Never throws.
// ---------------------------------------------------------------------------
async function readOptOutState(token) {
  const payload = verifyOptOutToken(token);
  if (!payload) return { ok: false, error: 'invalid or expired link' };
  try {
    const r = await pool.query(
      'SELECT notification_prefs FROM venue_profiles WHERE id = $1',
      [payload.vp]
    );
    if (r.rowCount === 0) return { ok: false, error: 'invalid or expired link' };
    const prefs = r.rows[0].notification_prefs;
    // Same reading the sweep does: a legacy non-object value is "off".
    const weekly = prefs && typeof prefs === 'object' && !Array.isArray(prefs) && prefs.weekly === true;
    return { ok: true, alreadyOff: !weekly };
  } catch (err) {
    console.error('[venueDigest] opt-out read failed:', err.message);
    return { ok: false, error: 'server error' };
  }
}

// The WRITE half. Reached only from POST (the page's button, or a mail client
// doing RFC 8058 one-click), never from the emailed GET.
//
// Idempotent by construction: the UPDATE has no predicate on the current value,
// so unsubscribing an already-unsubscribed venue writes the same false again
// and reports rowCount 1. Only a venue_profiles row that is GONE reports 0, and
// that is a stale link, not a repeat click.
//
// Returns { ok: true } or { ok: false, error }. Never throws.
async function applyOptOut(token) {
  const payload = verifyOptOutToken(token);
  if (!payload) return { ok: false, error: 'invalid or expired link' };
  try {
    // Same guarded jsonb merge routes/venueProfile.js uses: a legacy
    // non-object value is replaced, an object is merged, and only the weekly
    // key moves.
    const r = await pool.query(
      `UPDATE venue_profiles
          SET notification_prefs = (CASE WHEN jsonb_typeof(notification_prefs) = 'object'
                                         THEN notification_prefs ELSE '{}'::jsonb END)
                                   || '{"weekly": false}'::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [payload.vp]
    );
    if (r.rowCount === 0) return { ok: false, error: 'invalid or expired link' };
    return { ok: true };
  } catch (err) {
    console.error('[venueDigest] opt-out update failed:', err.message);
    return { ok: false, error: 'server error' };
  }
}

// ---------------------------------------------------------------------------
// Tier for the digest. Mirrors requireVenueTier's pilot posture: billing off
// means every claimed venue acts Pro; billing on means the column decides.
// ---------------------------------------------------------------------------
function effectiveTier(rowTier) {
  if (!venueBillingEnabled()) return 'pro';
  return rowTier === 'pro' || rowTier === 'premium' ? rowTier : 'free';
}

// ---------------------------------------------------------------------------
// The sweep. Called hourly from server.js, next to checkCrowdAlerts. Returns
// a small tally so a log line (and the tests) can say what happened.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Card composition. The fact engine (services/advisorFacts.js) is the ONLY
// place a fact is computed; this assembles its four builders into the same
// {id, title, facts, status} cards GET /api/venue/advisor/cards serves
// (routes/advisor.js, pinned by __tests__/advisorCards.test.js), except that
// the digest builds only the cards the tier receives: no 'locked' upsell
// rows exist in an email, so below-tier cards are simply never computed.
//
// Returns null when the venue has no linked listing or is unverified, which
// the sweep reads as "skip this venue", the same soft answer the cards route
// gives those states.
// ---------------------------------------------------------------------------
//
// THE VERDICT LEADS. The email used to open on the week ahead, which is a
// forecast, and forecasting is the least asked thing operators ask a tool that
// holds their data (one percent of prompts across 125,000+ locations,
// ROOST-OWNER-INPUT.md). The most asked is "how did we just do". So the first
// card in the stack, and the first block in the email, is the verdict on the
// most recent complete day, built by the SAME builder the dashboard card and
// the chip use, with the same threshold, so the email cannot say something the
// dashboard would not. The sweep runs Monday morning on the venue's clock, so
// "the most recent complete day" is the Sunday that closes the week being
// recapped.
const DIGEST_CARDS = [
  { id: 'last_night_verdict', title: 'Yesterday, against your own numbers', tier: 'pro' },
  { id: 'week_ahead', title: 'Week ahead', tier: 'pro' },
  { id: 'around_you', title: 'Around you this week', tier: 'premium' },
  { id: 'listing_read_back', title: 'Your listing, read back', tier: 'pro' },
  { id: 'readings_vs_estimates', title: 'What you said vs what we estimated', tier: 'pro' },
];

// Required lazily for the same reason the fact engine is: a build without it
// loses one card, not the whole digest.
function lastNightVerdictBuilder() {
  try {
    // eslint-disable-next-line global-require
    return require('./lastNightVerdict').buildLastDayVerdict;
  } catch (err) {
    console.warn('[VenueDigest] last day verdict unavailable:', err.message);
    return null;
  }
}

async function buildDigestCards(advisorFacts, { userId, tier, now }) {
  const ctx = await advisorFacts.getVenueContext(userId);
  if (!ctx || !ctx.profile || !ctx.profile.google_place_id || !ctx.profile.verified) return null;
  const opts = { now, userId };
  const finished = (def, facts) => ({
    id: def.id,
    title: def.title,
    facts,
    status: facts.some((f) => !advisorFacts.isRefusal(f)) ? 'ok' : 'refused',
  });

  const [verdictDef, weekDef, aroundDef, listingDef, readingsDef] = DIGEST_CARDS;
  const cards = [];
  if (tier === 'pro') {
    // The verdict leads the email. It reads no forecast and no corpus, so it
    // is built first and cannot be delayed by anything the model does.
    const buildVerdict = lastNightVerdictBuilder();
    if (buildVerdict) cards.push(finished(verdictDef, await buildVerdict(ctx, opts)));
    // Then card 1, before card 3, because card 3's arithmetic reads its peak
    // facts, the same ordering the route uses.
    const weekFacts = await advisorFacts.buildWeekAhead(ctx, opts);
    cards.push(finished(weekDef, weekFacts));
    cards.push(finished(aroundDef, await advisorFacts.buildAroundYou(ctx, opts)));
    cards.push(finished(listingDef, await advisorFacts.buildListingReadBack(ctx, weekFacts, opts)));
    cards.push(finished(readingsDef, await advisorFacts.buildReadingsVsServed(ctx, opts)));
  } else {
    cards.push(finished(aroundDef, await advisorFacts.buildAroundYou(ctx, opts)));
  }
  return cards;
}

// Test seam: __tests__/venueDigest.test.js swaps the card loader so the sweep
// tests exercise gating and delivery without the fact engine's own queries.
// Production always goes through require('./advisorFacts') — lazily, so a
// build where the fact engine is absent degrades to a warning, not a crash at
// require time of everything that imports this service.
let cardLoaderOverride = null;
function _setCardLoaderForTests(fn) { cardLoaderOverride = fn; }

function resolveCardLoader() {
  if (cardLoaderOverride) return cardLoaderOverride;
  const advisorFacts = require('./advisorFacts');
  if (typeof advisorFacts.getVenueContext !== 'function') {
    throw new Error('advisorFacts exports no getVenueContext');
  }
  return (args) => buildDigestCards(advisorFacts, args);
}

async function runVenueDigestSweep(now = new Date()) {
  const tally = { considered: 0, sent: 0, skipped: 0, failed: 0 };
  if (!digestEnabled()) return tally;

  let loadCards;
  try {
    loadCards = resolveCardLoader();
    if (typeof loadCards !== 'function') throw new Error('advisorFacts exports no card loader');
  } catch (err) {
    console.warn('[venueDigest] advisorFacts unavailable, digest sweep skipped:', err.message);
    return tally;
  }

  let rows;
  try {
    const r = await pool.query(
      `SELECT vp.id, vp.user_id, vp.business_name, vp.tier, vp.google_place_id,
              vp.notification_prefs,
              vs.tier AS grant_tier, vs.status AS grant_status, vs.expires_at,
              u.email, u.email_verified, u.is_banned,
              mv.timezone
         FROM venue_profiles vp
         JOIN users u ON u.id = vp.user_id
         LEFT JOIN venue_subscriptions vs ON vs.user_id = vp.user_id
         LEFT JOIN ml_venues mv ON mv.google_place_id = vp.google_place_id
        WHERE vp.google_place_id IS NOT NULL
          AND u.email IS NOT NULL`
    );
    rows = r.rows;
  } catch (err) {
    console.error('[venueDigest] venue query failed:', err.message);
    return tally;
  }

  for (const row of rows) {
    tally.considered += 1;

    // Opt-in only. The dashboard switch writes this column; its default is
    // false, and a legacy non-object value reads as "off".
    const prefs = row.notification_prefs;
    const weekly = prefs && typeof prefs === 'object' && !Array.isArray(prefs) && prefs.weekly === true;
    if (!weekly) { tally.skipped += 1; continue; }

    if (row.is_banned === true || row.email_verified !== true || !isMailableAddress(row.email)) {
      tally.skipped += 1; continue;
    }

    // The GRANT decides, not the cached column. This sweep is the one paid
    // surface that does not go through requireVenueTier, so an expired comp
    // would have kept receiving Monday digests until an admin noticed
    // (migration 040). resolveGrantedTier is the same function the gate uses,
    // so there is one expiry rule in the product and not two.
    const tier = effectiveTier(resolveGrantedTier(row, now.getTime()));
    if (tier === 'free') { tally.skipped += 1; continue; }

    const parts = localParts(now, row.timezone);
    if (!isMondayMorning(parts)) { tally.skipped += 1; continue; }
    const weekStart = isoDate(parts.year, parts.month, parts.day);

    try {
      // Cards first: it is read-only, so an unverified or unlinked venue (a
      // null from the loader) is skipped without ever claiming a marker.
      const cards = await loadCards({ userId: row.user_id, tier, now });
      if (cards === null) { tally.skipped += 1; continue; }

      // Claim BEFORE the send. Losing the race means another instance owns
      // this venue's Monday.
      const claim = await pool.query(
        `INSERT INTO venue_digest_sends (venue_profile_id, week_start)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [row.id, weekStart]
      );
      if (claim.rowCount === 0) { tally.skipped += 1; continue; }

      const renderInput = {
        businessName: row.business_name,
        cards: Array.isArray(cards) ? cards : [],
        tier,
        optOutUrl: optOutUrl(row.id),
        weekLabel: lastWeekLabel(parts),
      };

      const result = await sendEmail({
        to: row.email,
        subject: digestSubject(row.business_name, renderInput.weekLabel),
        html: renderDigestHtml(renderInput),
        // RFC 8058. List-Unsubscribe alone gets the client's own unsubscribe
        // affordance shown next to the sender; the -Post header is what tells
        // it the URI takes a POST, so Gmail and Apple Mail unsubscribe the
        // owner in one tap without opening a browser. It is also the pairing
        // that makes the GET-renders/POST-writes split safe to ship: the two
        // paths that mutate are the page's button and this header, both POST.
        headers: {
          'List-Unsubscribe': `<${renderInput.optOutUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      // renderDigestText is the same content for logs/tests and any future
      // multipart send; Resend derives a text part from html today.
      if (result.sent) {
        tally.sent += 1;
      } else {
        // Release the marker so the next hourly sweep inside the window can
        // retry (covers a provider blip and a missing RESEND_API_KEY alike).
        await pool.query(
          'DELETE FROM venue_digest_sends WHERE venue_profile_id = $1 AND week_start = $2',
          [row.id, weekStart]
        );
        tally.failed += 1;
        console.warn('[venueDigest] send did not go out for', maskAddress(row.email), result.error || 'skipped');
      }
    } catch (err) {
      tally.failed += 1;
      console.error('[venueDigest] digest failed for venue_profile', row.id, err.message);
    }
  }

  // Prune old markers, best effort.
  try {
    await pool.query(
      `DELETE FROM venue_digest_sends WHERE sent_at < NOW() - INTERVAL '${MARKER_RETENTION_DAYS} days'`
    );
  } catch (err) {
    console.warn('[venueDigest] marker prune failed:', err.message);
  }

  if (tally.sent || tally.failed) {
    console.log(`[venueDigest] sweep: ${tally.sent} sent, ${tally.failed} failed, ${tally.skipped} skipped of ${tally.considered}`);
  }
  return tally;
}

module.exports = {
  runVenueDigestSweep,
  applyOptOut,
  readOptOutState,
  optOutToken,
  optOutUrl,
  digestEnabled,
  effectiveTier,
  localParts,
  isMondayMorning,
  lastWeekLabel,
  OPT_OUT_PURPOSE,
  buildDigestCards,
  DIGEST_CARDS,
  _setCardLoaderForTests,
};
