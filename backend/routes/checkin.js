const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticate, TOKEN_ALGORITHMS, issuedTokenVersion, currentTokenVersion } = require('../middleware/auth');
const { validPlaceId, isKnownVenue } = require('../utils/places');
const { createUserBudget } = require('../utils/probeBudget');

const router = express.Router();

// ---------------------------------------------------------------------------
// Round 12: GET /:placeId is UNAUTHENTICATED and inserted a venue_checkins row
// for any attacker-supplied string. There was no validator of any kind, so:
//   - ids longer than VARCHAR(255) blew up as 500s instead of 400s, and
//   - the anonymous dedupe keys on ip|placeId, so rotating fabricated ids
//     defeated it entirely — one IP could write ~288,000 rows/day (the general
//     limiter's ceiling) straight into the table the ML pipeline reads and the
//     live occupancy count sums.
// Taps must look like a Google place id AND name a venue we actually know.
//
// Round 16: both rules moved to utils/places.js, which sockets/handlers.js also
// imports — the shape check and the known-venue query used to be copied in both
// files. Two deliberate deltas come with the shared version:
//   - it fails CLOSED, so a database error during the lookup answers 404
//     ("Unknown venue") instead of bubbling out as a 500. For a route whose
//     whole job is deciding whether to trust a tap, refusing is the right
//     answer to "cannot tell";
//   - it caches for five minutes in both directions, so a venue onboarded
//     seconds ago can take up to five minutes to accept taps. That is
//     acceptable here because NFC tags are programmed as part of onboarding,
//     not before it; utils/places.js exports clearKnownVenueCache() if the
//     onboarding path ever wants it immediate.
//
// Round 17: utils/places.js no longer counts `flocks.venue_id` as evidence a
// venue is real (creating a flock was self-serve, so anyone could promote a
// string of their choosing to "known" and land a fabricated tap). WHAT A
// DEPLOYED TAG NEEDS, therefore, is a row in ONE of: venue_profiles
// (google_place_id), sensor_devices (venue_place_id), or ml_venues
// (google_place_id). Programming a tag is part of venue onboarding, which
// creates the profile row — but if a tag is ever cut before the venue exists in
// our database, it will answer 404 until that row is written.
// ---------------------------------------------------------------------------

// Round 8: the bare GET accepted ANY place id and stored it as source 'nfc',
// which feedback verification trusts as physical presence — so visiting the
// URL in a browser minted "verified" calibration/training feedback for any
// venue. Real tags are ones WE programmed: their URL carries an HMAC of the
// place id under NFC_TAG_SECRET. A tap without a valid signature still counts
// as presence-unproven ('nfc_unverified'), which feedback does not trust.
//
// ---------------------------------------------------------------------------
// Round 17, REPLAY — the limit of this scheme, stated plainly because it cannot
// be fixed from inside this file.
//
// The signature is HMAC(placeId) with no time, nonce or device bound into it,
// so ONE signed URL is a permanent, transferable presence credential for that
// venue. Anyone who taps the tag once (or sees the URL in a screenshot, a group
// chat, a browser history, a shared link) can replay it from anywhere, forever,
// and each replaying ACCOUNT gets its own 30-minute dedupe window. What that
// buys the replayer is not cosmetic: `checkin_source = 'nfc'` is what
// routes/feedback.js trusts to mark crowd reports "verified" (3h window, feeds
// live calibration and ML training export) and what routes/venueDashboard.js
// trusts to let someone review a venue (30-day window).
//
// It is NOT fixable by signing differently, because the tags are physically
// programmed and cannot be re-cut: any scheme this file starts requiring would
// reject every tag already in the field. The two real fixes both live outside
// this file:
//   1. rotate NFC_TAG_SECRET per venue rather than globally, so a leaked URL
//      burns one venue instead of all of them, and re-cut tags on rotation; or
//   2. move to tags that compute their own per-tap code (NTAG 424 DNA SUN),
//      which is the only way a static URL stops being a static credential.
// Until one of those happens, treat 'nfc' as "was probably there or knows
// someone who was", not as proof.
//
// What this file DOES do about it: the signature is never echoed back in a
// response and never written to a log line, so the server is not itself a way
// to learn a tag's sig.
//
// Round 24 (adversarial re-audit): re-verified, and one step further — the
// tempting in-file mitigation, a signed time-window plus a single-use check
// per payload, is not merely disruptive but IMPOSSIBLE here: the payload has
// no per-tap variability. Every tap of one tag, by every patron, is the same
// bytes, so "single-use per payload" would mean one verified check-in per
// venue EVER across all users, and there is no timestamp in the payload to
// window. Replay resistance requires the tag side to vary (fixes 1 and 2
// above). The bounds that DO hold — per-account dedupe and budget, no
// cross-venue re-pointing, no attribution through a revoked token, no sig
// echo, the 'nfc'-only allowlist downstream — are pinned in
// __tests__/nfcTrustPath.test.js.
// ---------------------------------------------------------------------------
function nfcSigValid(placeId, sig) {
  const secret = process.env.NFC_TAG_SECRET;
  if (!secret || !sig || typeof sig !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(String(placeId)).digest('hex').slice(0, 32);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    // Length mismatch (timingSafeEqual throws rather than returning false) or a
    // string that is not representable as bytes. Either way: not a real tag.
    return false;
  }
}

// Best-effort token decode without bouncing the request — used by the NFC tap
// routes, which must succeed for both authenticated and anonymous taps.
//
// Round 15: this only asked "does a user with this id still exist", which
// silently skipped the two revocation controls middleware/auth.js enforces on
// every other authenticated route:
//
//   1. token_version (migration 009). Bumping users.token_version is what makes
//      an OAuth account-claim or a password change actually evict a squatter.
//      Here a revoked token still resolved, so the evicted party kept writing
//      venue_checkins rows AS THE VICTIM and kept marking the victim's flock
//      attendance for up to the token's remaining 24h.
//   2. is_banned. A ban is supposed to bite on the next request everywhere; a
//      banned account could still mint check-ins, emit into the venue room, and
//      earn reliability credit through this route.
//
// A failing token is treated as an ANONYMOUS tap (which then takes the
// anonymous dedupe path), never as a hard 401 — a real NFC tap from a logged-out
// phone must still work.
//
// The round-16 note here used to record that middleware/auth.js kept
// `issuedTokenVersion` / `currentTokenVersion` private, forcing this file to
// carry a COPY of the "a missing tv claim reads as 0" rule. The helpers are
// exported now (B3 follow-up) and imported at the top, so the comparison below
// is the middleware's own rule, not a copy that must be kept in step by hand.
//
// ---------------------------------------------------------------------------
// Round 23 — the THIRD control this copy had quietly dropped.
//
// Rounds 15 brought token_version and is_banned across. The algorithm pin did
// not come with them: middleware/auth.js verifies with `{ algorithms: ['HS256'] }`
// and records in its own comment why — "a future change to how JWT_SECRET is
// loaded (a PEM, a KeyObject) can never silently widen the accepted algorithm
// set to the asymmetric family". This called jwt.verify with NO options, so it
// accepted the whole HMAC family (verified: an HS512 token is 401 on every
// other route in the app and resolved to a user id here).
//
// That is not exploitable against jsonwebtoken 9 with a string secret today.
// It is still the wrong shape, and it is worse here than anywhere else: this is
// the only place in the app where a token is read on a route that must also
// serve anonymous callers, and an accepted identity mints a venue_checkins row,
// an occupancy event and flock attendance. TOKEN_ALGORITHMS is imported rather
// than re-spelled, so the pin cannot drift from the middleware's.
// ---------------------------------------------------------------------------
async function tryAuth(req) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: TOKEN_ALGORITHMS });
    const result = await pool.query(
      'SELECT id, is_banned, token_version FROM users WHERE id = $1',
      [decoded.userId]
    );
    const row = result.rows[0];
    if (!row) return null;

    // The middleware's own version rule ("missing claim reads as 0"), so
    // tokens minted before migration 009 keep working until something bumps
    // the row — and a change to that rule cannot skip this route.
    if (issuedTokenVersion(decoded) !== currentTokenVersion(row)) return null;
    if (row.is_banned) return null;

    return row.id;
  } catch {
    return null;
  }
}

// If the user has any active flock at this venue, mark them as attended
// (drives the anti-flake reliability scoring).
// Manual check-ins are self-reported: they may record presence, but they must
// not by themselves mint the "verified" evidence feedback trusts, and they
// must not credit attendance without a matching flock at that venue in its
// event window (round 6). markFlockAttendance already enforces the window.
async function markFlockAttendance(userId, placeId) {
  if (!userId || !placeId) return;
  try {
    // status stays 'accepted' (the CHECK constraint only allows invited/
    // accepted/declined — the old status='attended' write violated it and the
    // swallowed error meant check-ins NEVER fed reliability scoring, audit
    // 2026-08-12). Attendance lives in its own column, which scoring reads.
    const r = await pool.query(
      `UPDATE flock_members SET attendance = 'attended'
       WHERE user_id = $1
         AND status = 'accepted'
         AND flock_id IN (
           SELECT id FROM flocks
           -- flocks has no venue_data column — referencing it made PostgreSQL
           -- reject the whole UPDATE, so attendance was never recorded
           WHERE venue_id = $2
             AND status NOT IN ('completed', 'cancelled')
             -- Only within the event window (round 3: checking in today must
             -- not pre-credit attendance for next week's flock — reliability
             -- scores were inflatable above 100%)
             AND event_time IS NOT NULL
             AND NOW() BETWEEN event_time - INTERVAL '3 hours' AND event_time + INTERVAL '12 hours'
         )`,
      [userId, placeId]
    );
    // SECURITY ROUND 5, 2026-08-20: the PLACE ID is gone from this line.
    // user + venue + timestamp, appended once per check-in, is a location
    // history — the exact artefact the privacy policy promises we do not build
    // ("We do not store those coordinates in our database or build a location
    // history from them"). A promise kept in Postgres and broken in stderr is
    // still broken: Railway retains the log, and it is queryable by user id.
    // The attendance table already records where somebody was, under the
    // retention and deletion rules that apply to it. This line exists to say
    // the write landed, so it says that.
    if (r.rowCount > 0) console.log(`[Checkin] attendance recorded for user ${userId} (${r.rowCount} flock[s])`);
  } catch (err) {
    // Non-fatal — never block the checkin, but the failure must be loud
    console.error('Flock attendance update FAILED:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Tap dedupe.
//
// Round 3 deduped ANONYMOUS taps only (ip|place, 30 min). Round 15: an
// authenticated tap had no ceiling at all, on either verb, and every accepted
// tap does two things that must not be repeatable at will:
//
//   - it INSERTs into venue_checkins, the table routes/sensors.js reads for
//     public occupancy and the ML pipeline exports as training data, and
//   - it emits `venue_checkin` into the venue room, where the client
//     (App.js venue screen + venue-owner dashboard) increments its displayed
//     "recent check-ins" by one PER EVENT. (Round 17 narrowed that emit to
//     IDENTIFIED check-ins only — see recordTap — but an identified tap is
//     exactly the one an account can repeat at will, so the ceiling still
//     carries it.)
//
// POST is the worse of the two, because it deliberately skips the known-place
// requirement (a manual check-in legitimately happens at a Google Places venue
// we have never seen), so unbounded rows could be written for FABRICATED place
// ids. The window matches the client's own 2h checkin lockout on the generous
// side; it exists to bound abuse, not to police honest re-taps.
//
// Round 17: this Map is the CONCURRENCY guard, not the durability guard. It is
// per-process, so a Railway restart, a deploy, or a second replica hands every
// caller a fresh window. The durable half lives in recordTap's conditional
// INSERT; read the IDEMPOTENCE note there for which layer covers which case and
// for the one gap neither closes.
// ---------------------------------------------------------------------------
const TAP_DEDUPE_MS = 30 * 60 * 1000;
const tapCache = new Map(); // "u:<id>|place" or "ip:<addr>|place" -> last tap ms

// flockcorp.com has no DNS pointed at the app yet, so tapping an NFC tag would
// land on a dead domain. Overridable once DNS is live.
const anonRedirect = () => process.env.PUBLIC_WEB_URL || 'https://flock-app-w65m.vercel.app';

// ---------------------------------------------------------------------------
// Round 15 (location privacy): this event used to carry `user_id`.
//
// `venue:{placeId}` is not a private room. sockets/handlers.js `join_venue`
// accepts any place id string from any authenticated socket, with no
// relationship, membership or block check. So any logged-in account could
// subscribe to venues of its choosing and receive a live feed of exactly which
// user ids walked into them — a stalking primitive on an app whose users are
// 15-22, and one that ignored user_blocks entirely.
//
// Nothing consumed the field: both client handlers (App.js venue screen and the
// venue-owner dashboard) only do `recent_checkins + 1`. The count is the whole
// point of the event, so the count is all it carries.
// ---------------------------------------------------------------------------
function emitVenueCheckin(io, placeId, createdAt) {
  io.to(`venue:${placeId}`).emit('venue_checkin', {
    venue_place_id: placeId,
    created_at: createdAt,
  });
}

// True when this identity already checked in at this venue inside the window.
// Identity is the user id when we have one, so rotating IPs (or sitting behind
// the same proxy as everyone else) changes nothing for a logged-in caller.
function tapKey(userId, placeId, ip) {
  return userId ? `u:${userId}|${placeId}` : `ip:${ip}|${placeId}`;
}

const TAP_CACHE_MAX = 10000;

function tapIsDuplicate(userId, placeId, ip) {
  const key = tapKey(userId, placeId, ip);
  const now = Date.now();
  const last = tapCache.get(key);
  if (last && now - last < TAP_DEDUPE_MS) return true;

  // Round 16 (reliability audit): this was `tapCache.clear()`, which dropped
  // all ten thousand entries at once — so crossing the bound re-opened the
  // duplicate window for EVERY user simultaneously, and someone spraying
  // fabricated place ids could force that moment at will. Expire what is
  // actually stale, then evict oldest-first, matching crowd.js's crowdCache.
  // A Map iterates in insertion order, and `set` on an EXISTING key keeps its
  // original position — which would make a regular's entry look permanently
  // old and evict it first. Delete then set, so the first key really is the
  // least recently written one.
  tapCache.delete(key);
  tapCache.set(key, now);
  if (tapCache.size > TAP_CACHE_MAX) {
    for (const [k, ts] of tapCache) {
      if (now - ts >= TAP_DEDUPE_MS) tapCache.delete(k);
    }
    while (tapCache.size > TAP_CACHE_MAX) {
      tapCache.delete(tapCache.keys().next().value);
    }
  }
  return false;
}

// Round 16: the window is claimed BEFORE the INSERT (it has to be — that is
// what makes it a lock rather than a race). But nothing released it when the
// insert then failed, so a single database error locked that person out of
// checking in at that venue for the next 30 minutes and left no row behind to
// show for it. On the failure path the claim is given back.
function forgetTap(userId, placeId, ip) {
  tapCache.delete(tapKey(userId, placeId, ip));
}

// ---------------------------------------------------------------------------
// Round 17: a per-ACCOUNT ceiling across ALL venues.
//
// The dedupe above is per venue, so it says nothing about how many DISTINCT
// venues one account may check into. The manual POST has no known-venue gate at
// all (by design — see the route), so one account could spend the general
// limiter's 3,000 requests / 15 min writing ~3,000 rows for ~3,000 fabricated
// place ids, every one of them with a real user_id and therefore counted by
// routes/sensors.js and exported as ML training data.
//
// A real person checks into a handful of places a day. 15/hour and 50/day is
// far above honest use and far below "useful for poisoning a dataset". Keyed on
// the numeric user id, which is what an attacker cannot rotate for free —
// anonymous taps are bounded instead by the known-venue gate plus the per-IP
// dedupe, because there is no identity to bill them to.
// ---------------------------------------------------------------------------
const tapBudget = createUserBudget({ name: 'venue-checkin', hourly: 15, daily: 50 });

// ---------------------------------------------------------------------------
// Round 17: the same ceiling for taps with no account behind them.
//
// The GET is the app's only unauthenticated INSERT besides guest RSVP. Its
// per-(ip, venue) dedupe bounds repeats at ONE venue, and the known-venue gate
// bounds WHICH venues — but ml_venues is a curated list of thousands, so one IP
// spending the general limiter's 3,000 requests / 15 min could still write on
// the order of a hundred thousand NULL-user rows a day into a table nobody is
// paying to store.
//
// Those rows are inert downstream today (routes/sensors.js counts
// COUNT(DISTINCT user_id) WHERE user_id IS NOT NULL, and feedback + venue
// reviews both join on user_id), so this is a storage and data-hygiene bound,
// not a bypass fix. The number is set for that: 60 distinct venues an hour is
// unreachable for an honest phone and comfortable even for a carrier-grade NAT
// with many Flock users behind it, while still turning "unbounded" into
// "bounded and small".
//
// WHY NOT utils/probeBudget.js: createUserBudget deliberately refuses any
// identity that is not a positive integer user id ("a budget denies an identity
// it cannot pin down" is one of its tested invariants), and an IP is a string.
// Hashing an IP into an integer would be worse than a second implementation —
// collisions are attacker-choosable, so anyone could deliberately land in a
// victim's bucket and spend their allowance. If createUserBudget ever grows a
// string-key mode, this should be deleted in favour of it.
// ---------------------------------------------------------------------------
const ANON_TAPS_PER_HOUR = 60;
const ANON_BUDGET_WINDOW_MS = 60 * 60 * 1000;
const ANON_BUDGET_MAX_IPS = 5000;
const anonTapBudget = new Map(); // ip -> number[] of tap times

function anonTapAllowed(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();

  const hits = (anonTapBudget.get(key) || []).filter((t) => now - t < ANON_BUDGET_WINDOW_MS);
  anonTapBudget.set(key, hits);
  if (hits.length >= ANON_TAPS_PER_HOUR) return false;

  hits.push(now);
  if (anonTapBudget.size > ANON_BUDGET_MAX_IPS) evictAnonTapBudget(now);
  return true;
}

// Eviction order is LEAST CONSUMED first, not oldest — this is the rule
// utils/probeBudget.js spells out and the reason it gives is exactly the attack
// here: a flooder SPENDS their allowance and only then sprays fresh keys, so
// their own entry is the oldest thing in the map and an oldest-first policy
// deletes precisely the counter they wanted gone. Dropping the entries with
// almost nothing left to remember costs an attacker a flood of IPs that have
// each already spent a full hour's allowance, which is more than the allowance
// being recovered.
//
// (The tap dedupe Map above still evicts oldest-first. That is deliberate and
// different: every entry there holds the same single timestamp, so there is no
// "least consumed", and buying one extra check-in row costs more requests than
// the general limiter will pass.)
function evictAnonTapBudget(now) {
  for (const [k, v] of anonTapBudget) {
    if (!v.length || now - v[v.length - 1] >= ANON_BUDGET_WINDOW_MS) anonTapBudget.delete(k);
  }
  if (anonTapBudget.size <= ANON_BUDGET_MAX_IPS) return;
  // Never clear() to make room: that hands every tracked IP a fresh allowance
  // at a moment the flooder chooses.
  const byConsumption = [...anonTapBudget.entries()].sort((a, b) => a[1].length - b[1].length);
  for (const [k] of byConsumption) {
    if (anonTapBudget.size <= ANON_BUDGET_MAX_IPS) break;
    anonTapBudget.delete(k);
  }
}

// Give back one unit — used when a tap that consumed budget then failed to
// write, so a database blip does not cost the caller their allowance.
function refundAnonTap(ip) {
  const key = String(ip || 'unknown');
  const hits = anonTapBudget.get(key);
  if (hits && hits.length) hits.pop();
}

// ---------------------------------------------------------------------------
// The one write path, shared by all three routes.
//
// Returns one of:
//   { status: 'recorded',  checked_in_at }
//   { status: 'deduped' }                    — a repeat inside the window
//   { status: 'rate_limited' }
//
// IDEMPOTENCE. A repeat inside TAP_DEDUPE_MS writes no row, emits no socket
// event and marks no attendance. Two layers enforce that, and each covers what
// the other cannot:
//
//   - the in-process Map, which is synchronous, so it collapses SIMULTANEOUS
//     duplicates before either reaches the database. That is the shape a
//     prefetcher, a double-mounted effect or a retry layer actually produces;
//   - the conditional INSERT below, which is DURABLE, so a repeat still finds
//     the earlier row after a restart, a deploy, or on a different replica —
//     precisely the case the Map loses, and precisely the case a retry layer
//     hits, since the retry happens BECAUSE the first attempt met a restarting
//     instance.
//
// The one gap left is the intersection: two SIMULTANEOUS taps landing on two
// DIFFERENT replicas inside the same millisecond would each see no prior row
// under READ COMMITTED and both insert. Closing that needs either a unique
// index (a migration) or an advisory lock and a transaction; it is not worth a
// pool checkout on the hot path for a second duplicate row that no consumer
// double-counts (sensors.js counts DISTINCT user_id, feedback and reviews ask
// EXISTS). The deployment is single-instance today in any case.
//
// A repeat caught by the MAP also spends no budget. A repeat caught by the
// DATABASE does spend one unit, because by then the request has already been
// admitted — that is the conservative direction and it only happens on the
// restart path.
//
// ANONYMOUS TAPS are the one case that cannot be made durably idempotent here:
// user_id is NULL, and venue_checkins has no column that records WHO an
// anonymous tap came from (adding one is a migration, which this file cannot
// make). They are deduped in memory only. The blast radius is small and worth
// stating: an anonymous row is invisible to routes/sensors.js (it counts
// COUNT(DISTINCT user_id) WHERE user_id IS NOT NULL), can never verify feedback
// or a review (both join on user_id), and no longer emits a live event (see
// below) — so a duplicate anonymous row is ML noise and nothing else.
// ---------------------------------------------------------------------------
async function recordTap({ userId, placeId, ip, source, io }) {
  if (tapIsDuplicate(userId, placeId, ip)) return { status: 'deduped' };

  const allowed = userId ? tapBudget.allow(userId) : anonTapAllowed(ip);
  if (!allowed) {
    forgetTap(userId, placeId, ip); // a refused tap must not burn the window
    return { status: 'rate_limited' };
  }

  let row;
  try {
    if (userId) {
      // Conditional INSERT — one statement, one round trip. The row is written
      // only when this account has no check-in at this venue inside the same
      // window the Map enforces, and the window is passed as a PARAMETER so the
      // two halves cannot drift apart.
      //
      // RETURNING therefore yields exactly one row when something was written
      // and NO rows when the write was suppressed, which is the whole dedupe
      // signal. Nothing else is needed: the deduped response deliberately does
      // not carry a timestamp, so there is no reason to go and read the earlier
      // row back.
      const q = await pool.query(
        `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM venue_checkins
           WHERE venue_place_id = $1
             AND user_id = $2
             AND created_at > NOW() - (INTERVAL '1 millisecond' * $4::double precision)
         )
         RETURNING created_at`,
        [placeId, userId, source, TAP_DEDUPE_MS]
      );
      row = q.rows[0];
      if (!row) return { status: 'deduped' };
    } else {
      const q = await pool.query(
        `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source)
         VALUES ($1, NULL, $2)
         RETURNING created_at`,
        [placeId, source]
      );
      row = q.rows[0];
    }
    // A write that reports no row is a write we cannot describe. Raising here
    // rather than reading `row.created_at` outside the try means it takes the
    // same refund path as any other failure, instead of throwing a TypeError
    // past it and leaving the dedupe window claimed for nothing.
    if (!row) throw new Error('venue_checkins insert returned no row');
  } catch (insertErr) {
    // A failure must not cost the caller their 30-minute window: forgetTap gives
    // it back on both paths.
    //
    // The HOURLY allowance is given back on the ANONYMOUS path only, and the
    // asymmetry is a limitation rather than a decision: utils/probeBudget.js
    // exposes allow() / remaining() / reset() and has no per-caller refund, so
    // an authenticated tap that meets a database error still spends one of its
    // 15/hour. Costing an honest caller 1/15th of an hour's allowance on a blip
    // is a small, self-healing loss and the conservative direction, so this is
    // not worth a second budget implementation — but do not read the line below
    // as covering both paths, because it does not.
    forgetTap(userId, placeId, ip);
    if (!userId) refundAnonTap(ip);
    throw insertErr;
  }

  const checked_in_at = row.created_at;

  // Round 17: the live event fires only for an IDENTIFIED check-in, because the
  // number it increments in every viewer's browser is backed by
  // routes/sensors.js's `COUNT(DISTINCT user_id) ... WHERE user_id IS NOT NULL`.
  // Emitting for anonymous taps made the live figure disagree with the figure a
  // refresh shows, and made the live figure the softer of the two to inflate:
  // anonymous taps are keyed on IP, so a phone on mobile data could raise a
  // venue's public busyness display without ever writing something the REST
  // query would count.
  //
  // Guarded: the row is already committed by this point, so a fan-out problem
  // must not turn a recorded check-in into a 500 the client then retries. Same
  // lesson as the billing route, where post-commit work inside the transaction's
  // try block ran ROLLBACK on a committed connection.
  if (io && userId) {
    try {
      emitVenueCheckin(io, placeId, checked_in_at);
    } catch (emitErr) {
      console.error('venue_checkin emit failed:', emitErr.message);
    }
  }

  if (userId) markFlockAttendance(userId, placeId).catch(() => {});

  return { status: 'recorded', checked_in_at };
}

// The tap body shared by GET /:placeId and POST /:placeId/tap. Anonymous is a
// first-class case on both: an NFC tap from a logged-out phone must work.
async function handleNfcTap(req, res) {
  // Set before anything can answer, so the refusals are uncacheable too — a
  // stored 404 for a venue that gets onboarded an hour later would refuse real
  // taps from behind that cache for as long as it kept the entry.
  res.set('Cache-Control', 'no-store');

  const { placeId } = req.params;
  if (!validPlaceId(placeId)) return res.status(400).json({ error: 'Invalid venue id' });
  if (!(await isKnownVenue(placeId))) return res.status(404).json({ error: 'Unknown venue' });

  const userId = await tryAuth(req);

  const source = nfcSigValid(placeId, req.query.sig) ? 'nfc' : 'nfc_unverified';
  const result = await recordTap({
    userId,
    placeId,
    ip: req.ip,
    source,
    io: req.app.get('io'),
  });

  if (result.status === 'rate_limited') {
    return res.status(429).json({ error: 'Too many check-ins. Try again later.' });
  }

  // An anonymous tap is a phone sitting on the landing URL, so every anonymous
  // answer — including a deduped one — has to say where to send it. Dropping
  // this stranded the second tap of the evening on a blank page.
  const redirect = userId ? {} : { redirect: anonRedirect() };

  if (result.status === 'deduped') {
    // A duplicate is a success, not an error: the tap happened, we just already
    // know about it. `ok` is kept alongside `success` because the shipped
    // clients read one or the other.
    return res.json({
      ok: true,
      success: true,
      venue_place_id: placeId,
      deduped: true,
      ...redirect,
    });
  }

  return res.json({
    success: true,
    venue_place_id: placeId,
    checked_in_at: result.checked_in_at,
    ...redirect,
  });
}

// ---------------------------------------------------------------------------
// POST /api/checkin/:placeId/tap — NFC tap, correctly shaped
//
// This is the endpoint the NFC landing screen SHOULD call. A tap is a write, so
// it belongs on a verb that no link prefetcher, no browser speculative fetch
// and no generic "retry idempotent methods" layer will replay on its own.
// frontend/src/services/api.js `getNfcCheckin` currently calls the GET below
// with an explicit `retry: false` opt-out, which is a client working around the
// server's shape.
// ---------------------------------------------------------------------------
router.post('/:placeId/tap', async (req, res) => {
  try {
    await handleNfcTap(req, res);
  } catch (err) {
    console.error('NFC checkin error:', err);
    res.status(500).json({ error: 'Failed to record checkin' });
  }
});

// ---------------------------------------------------------------------------
// HEAD /api/checkin/:placeId — read-only, and it MUST be registered above the
// GET.
//
// Express serves HEAD from a `router.get` handler automatically, so before this
// existed a HEAD request ran the full tap: validate, dedupe, INSERT, emit, mark
// attendance — and then Express discarded the body. HEAD is exactly what link
// preview bots, uptime monitors, security scanners and some proxy caches send
// unprompted, none of which have any business recording that somebody walked
// into a bar. A router matches in registration order, so this has to come
// first or the GET below claims the method.
//
// It answers 200 for a shaped, known venue and the same 400/404 otherwise, so a
// caller can probe reachability without minting presence.
// ---------------------------------------------------------------------------
router.head('/:placeId', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { placeId } = req.params;
    if (!validPlaceId(placeId)) return res.sendStatus(400);
    if (!(await isKnownVenue(placeId))) return res.sendStatus(404);
    return res.sendStatus(200);
  } catch (err) {
    console.error('NFC checkin HEAD error:', err);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/checkin/:placeId — NFC tap landing endpoint (legacy verb)
// Open to authenticated AND anonymous users. Records check-in either way.
//
// WHY A GET STILL WRITES. It should not, and the POST above is the replacement.
// It cannot simply become read-only yet, because the callers are not all
// updatable on our schedule:
//   - the deployed Vercel build calls the GET, and
//   - the iOS Capacitor build ships the web bundle INSIDE the binary, so a
//     shipped build keeps calling the GET until it is replaced through App
//     Review. A read-only GET would mean every tap from an installed app
//     silently records nothing.
// The physical tags are not the constraint here: a tag points at
// `flockcorp.com/checkin/<placeId>?sig=<hmac>`, which is a FRONTEND route. The
// phone loads the web app and the web app chooses the API call, so switching to
// the POST needs no tag re-cutting at all. Only the clients have to ship.
//
// What makes the GET safe in the meantime is that its write is genuinely
// idempotent rather than merely guarded: for an identified tap the INSERT is
// conditional in SQL on there being no row for the same account and venue in
// the same 30-minute window, so a prefetch, a speculative fetch, a refresh or a
// retry across a restart all collapse into the one row that already exists.
// See recordTap.
// ---------------------------------------------------------------------------
router.get('/:placeId', async (req, res) => {
  try {
    await handleNfcTap(req, res);
  } catch (err) {
    console.error('NFC checkin error:', err);
    res.status(500).json({ error: 'Failed to record checkin' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/checkin/:placeId — manual check-in from inside the app
// ---------------------------------------------------------------------------
router.post('/:placeId', authenticate, async (req, res) => {
  try {
    const { placeId } = req.params;
    // Round 12 (VARCHAR overflow): same shape check as the public tap. The
    // known-place requirement is deliberately NOT applied here — a manual
    // check-in is an authenticated, identified, rate-limited write from inside
    // the app, and it legitimately happens at venues discovered through Google
    // Places that we have never seen before. Round 17 gives the "rate-limited"
    // half of that sentence real teeth: see tapBudget.
    if (!validPlaceId(placeId)) return res.status(400).json({ error: 'Invalid venue id' });

    // Round 15: with no known-place requirement AND no dedupe, this was the
    // cheapest way to write unbounded rows for FABRICATED place ids into the
    // table the ML pipeline exports — and to drive the live occupancy figure in
    // every viewer's browser. The client already self-limits to one check-in per
    // venue per 2h in localStorage; per CLAUDE.md that gate is cosmetic until
    // the server enforces it too.
    const result = await recordTap({
      userId: req.user.id,
      placeId,
      ip: req.ip,
      // Self-reported. Never 'nfc': routes/feedback.js and
      // routes/venueDashboard.js both treat 'nfc' as proof of physical
      // presence, and tapping a button in the app proves nothing.
      source: 'manual',
      io: req.app.get('io'),
    });

    if (result.status === 'rate_limited') {
      return res.status(429).json({ error: 'Too many check-ins. Try again later.' });
    }
    if (result.status === 'deduped') {
      return res.json({ success: true, venue_place_id: placeId, deduped: true });
    }

    res.json({
      success: true,
      venue_place_id: placeId,
      checked_in_at: result.checked_in_at,
    });
  } catch (err) {
    console.error('Manual checkin error:', err);
    res.status(500).json({ error: 'Failed to record checkin' });
  }
});

module.exports = router;

// Exposed for __tests__/unauthSurface.test.js and __tests__/checkinFlow.test.js
// only. Properties on the router keep server.js's
// `app.use('/api/checkin', checkinRoutes)` mount unchanged — an express Router
// is a function object, so this adds nothing to the request path.
module.exports.__test = {
  tryAuth,
  tapIsDuplicate,
  forgetTap,
  emitVenueCheckin,
  tapCache,
  validPlaceId,
  nfcSigValid,
  recordTap,
  markFlockAttendance,
  tapBudget,
  anonTapAllowed,
  anonTapBudget,
  ANON_TAPS_PER_HOUR,
  TAP_DEDUPE_MS,
};
