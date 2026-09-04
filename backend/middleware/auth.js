const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const TOKEN_EXPIRY = '24h';

// Only HMAC. jsonwebtoken infers this from the secret today, but pinning it
// means a future change to how JWT_SECRET is loaded (a PEM, a KeyObject) can
// never silently widen the accepted algorithm set to the asymmetric family.
const TOKEN_ALGORITHMS = ['HS256'];

// Every Flock JWT carries the issuing user's token_version as `tv` (migration
// 009). Bumping users.token_version invalidates every token outstanding for
// that id — the OAuth account-claim in routes/auth.js and any password change
// do exactly that, which is what makes the claim actually evict a squatter
// instead of leaving them a live 24h session on the victim's account.
//
// BACKWARD COMPATIBILITY: tokens minted before this existed have no `tv` claim.
// A missing claim is read as 0, which is the column DEFAULT, so those tokens
// keep working — and are cleanly rejected the moment anything bumps the row.
// That is the deliberate choice: no forced logout of the whole user base on
// deploy, while the security property (a bump kills old tokens) still holds.
// The one normalisation rule, exported (B3): "anything that is not an integer
// reads as version 0". Two other files compare token versions on paths this
// middleware never runs — sockets/handlers.js revalidates live connections and
// routes/checkin.js tryAuth reads a token on a route that must also serve
// anonymous taps — and each carried its own copy of this predicate. A copy is
// how the missing-claim rule drifts: change it here and the socket keeps (or
// drops) sessions under the old rule. Both now import this function.
function tokenVersionOf(value) {
  return Number.isInteger(value) ? value : 0;
}

function issuedTokenVersion(decoded) {
  return tokenVersionOf(decoded?.tv);
}

function currentTokenVersion(row) {
  return tokenVersionOf(row?.token_version);
}

// Mint a Flock JWT for a user row. Single place so no call site can forget the
// `tv` claim (a token without it is treated as version 0 and would survive a
// bump-based revocation only until the first bump).
function signUserToken(user) {
  return jwt.sign(
    { userId: user.id, tv: currentTokenVersion(user) },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

// Round 15: bumping token_version only bites at the NEXT authentication.
// Express requests re-authenticate on every call, so they die immediately —
// but a Socket.io connection authenticates ONCE, at the handshake, and then
// lives for as long as the TCP connection does. So the round-13 OAuth
// account-claim (and any password change) revoked the REST session and left
// the intruder's live socket subscribed to `user:{id}`, which is the room
// every DM, flock message, venue vote, flock invite and location_update is
// delivered to. routes/admin.js already knew this for bans
// (`io.in(...).disconnectSockets(true)` after a ban commits); nothing did it
// for a token_version bump.
//
// Callers pass the io instance (`req.app.get('io')` in a route). A missing io
// is a no-op, not a throw: revocation must never 500 the sign-in that
// triggered it.
//
// This is the IMMEDIATE half. sockets/handlers.js separately revalidates every
// live connection on a timer (SESSION_RECHECK_MS), which catches bumps made by
// code that never calls this — but only after up to a minute, during which the
// intruder is still reading. Anything that bumps token_version must call this
// as well. As of round 18 all four callers do: the Google claim, the Apple
// claim and the squat eviction in routes/auth.js, the completed password reset
// in the same file, /logout-all, and the password change in routes/users.js
// (which this comment used to record as the outstanding gap — it is closed).
function revokeUserSessions(io, userId) {
  if (userId === undefined || userId === null) return false;
  // The device rows go with the sessions. A revoke (password change, reset,
  // sign out everywhere, a squatted address released) makes every token
  // dead, and the client's own unregister cannot authenticate with a dead
  // token, so the rows stayed and pushes kept landing on devices that were
  // no longer signed in. Each device that signs in again re-registers.
  // Fire-and-forget: a revoke must not wait on, or fail on, this delete.
  pool.query('DELETE FROM device_tokens WHERE user_id = $1', [userId])
    .catch((err) => console.error(`[auth] device token revocation failed for user ${userId}:`, err.message));
  if (!io) return false;
  try {
    io.in(`user:${userId}`).disconnectSockets(true);
    return true;
  } catch (err) {
    console.error(`[auth] socket revocation failed for user ${userId}:`, err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unverified accounts (round 16) — what a squatter is allowed to do
// ---------------------------------------------------------------------------
// A password signup no longer proves anything by existing; it proves something
// by clicking the link. Until then the rule is:
//
//   READ AND BE REACHED, BUT DO NOT ACCUMULATE.
//
// An unverified account can sign in, hold a token, read its own profile, look
// around the app, change its own name, resend its verification mail and delete
// itself. It cannot do the three things that made squatting an address
// profitable in the first place:
//
//   1. store a payment handle   (Venmo / Cash App / Zelle)
//   2. gain an accepted friendship
//   3. create or join a flock
//
// Those three are exactly the assets the OAuth account-claim used to hand to
// the victim: the payment handles that redirect their bill splits, the
// friendship that makes the attacker a trusted contact, and the flock
// membership that puts the attacker in the room. Strip those and a squat is
// worth nothing even if it is never detected. Locking unverified users out of
// the app entirely was the alternative and it is worse: it turns a mistyped
// address into a dead end, and it teaches people that Flock is broken.
//
// WHY THE LIST IS HERE AND NOT ONLY IN THE ROUTES. `requireVerified` below is
// the intended, explicit way for a route to opt in, and routes/users.js,
// routes/friends.js and routes/flocks.js should each mount it. This table is
// the BACKSTOP that holds until they do, and afterwards holds if one of them is
// ever refactored and drops the middleware. Belt and braces: the gate is the
// whole point of the round-16 fix, so it must not depend on three other files
// remembering it.
//
// STATUS (2026-08-14): routes/flocks.js now mounts `requireVerified` on all
// four of its entries here — POST /, and /:id/join, /:id/invite, /:id/invite-link
// — and the one statement that promotes anybody to accepted flock membership
// carries the check in its own WHERE clause as well. That is deliberate
// redundancy, not duplication: this table is a regex over a URL, so renaming a
// route or mounting the router under a second prefix makes the pattern stop
// matching while the route keeps working, and the gate would fail SILENTLY and
// OPEN. Whichever layer is edited, the other still refuses.
//
// routes/users.js gates its one path (the email change in PUT /profile) with a
// branch-level check rather than route-level middleware, by design — see the
// comment there. routes/friends.js still relies on this table alone.
//
// A NOTE ON THE OTHER SIDE OF AN INVITE. This list gates the ACTOR. It does not,
// and should not, refuse a verified user who invites an account that has not
// confirmed its email yet: that writes `flock_members.status = 'invited'`, which
// is not membership — every capability and count in the backend keys on
// 'accepted' — and the target cannot promote it without passing this gate
// themselves. A friend who signed up ten minutes ago is the normal case, and
// refusing would leak their verification state to anyone who can guess a user
// id. The long-form reasoning is above POST /:id/invite in routes/flocks.js.
//
// It is NOT the URL-regex carve-out that middleware/auth.js used to have for
// bans, and it must never become one. That one matched an unanchored pattern
// against req.originalUrl INCLUDING the query string, so
// `DELETE /api/flocks/42?x=/users/me` satisfied it. This matches anchored
// patterns against `req.baseUrl + req.path`, which are the values Express
// itself resolved while routing — no query string can reach them, and the
// string Express matched the route on is the string we match here. Both the
// raw and percent-decoded forms are tested, and the check is a DENY list on
// state-changing verbs, so an unrecognised shape fails toward "allowed" the
// same way it does today rather than toward a mass 403.
// POST /api/feedback IS DELIBERATELY NOT ON THIS LIST (decision 2026-08-14,
// closing the B3 "consider adding it" item). The worry was an unverified
// account feeding the training corpus and moving public crowd numbers. Checked
// against the code, the worry is already contained twice over, and denying
// would cost real reports:
//   * Row-level containment. Every reader of venue_feedback that moves a number
//     anyone else sees — routes/crowd.js calibration, services/mlPredictor.js,
//     the training export, GET /api/feedback/venue/:placeId — filters
//     `verified = true`, and a row only gets that flag from
//     VERIFIED_PRESENCE_SQL (routes/feedback.js): an HMAC-signed NFC tap, or
//     accepted membership in a non-cancelled flock with >= 2 accepted members.
//   * This list already closes the flock leg for unverified accounts: they
//     cannot create, join, or invite (the entries below), so the only way an
//     email-unverified account mints a verified row is a signed NFC tap —
//     which is genuine physical presence, exactly the evidence the corpus
//     wants, regardless of whether the email link was clicked. On top of that,
//     calibration needs 3 distinct reporters before feedback moves a score.
//   * The cost side is the same one this route has hit twice before (the UUID
//     validator, the `.optional()` null): the post-hangout sheet fires right
//     after signup for exactly the users least likely to have confirmed email
//     yet, and a 403 here is a silently lost honest report. "Read and be
//     reached, but do not accumulate" — a feedback row is data about a venue,
//     not an asset on the account, so it is not what this list exists to strip.
// Pinned by __tests__/b3Leftovers.test.js: the decision holds only while the
// flock entries below stay on this list.
const UNVERIFIED_DENY = [
  // 1. Payment handles — routes/users.js
  { method: 'PUT', pattern: /^\/api\/users\/venmo-username$/ },
  { method: 'PUT', pattern: /^\/api\/users\/payment-methods$/ },
  // 2. Friendships — routes/friends.js. `request` is included as well as
  //    `accept`: a squatter's outgoing request is half of an accepted edge, and
  //    the victim accepting it is the attack working.
  { method: 'POST', pattern: /^\/api\/friends\/(request|accept|add-by-code)$/ },
  //    Contact discovery resolves an address book to names and faces. An
  //    account that has not proved its email has no business doing that, and
  //    the route was not on this list.
  { method: 'POST', pattern: /^\/api\/friends\/find-by-phone$/ },
  // 3. Flock membership — routes/flocks.js. Creating a flock makes you its
  //    first member, so it belongs on the list next to join and invite.
  { method: 'POST', pattern: /^\/api\/flocks$/ },
  //    `rerun` is the "Do it again" door added with friend flock history: it
  //    creates a NEW flock from an old one with the caller as an accepted
  //    member, which is the same thing POST /api/flocks does and therefore the
  //    same reason to be here. It mounts requireVerified explicitly in
  //    routes/flocks.js, so it is gated today; what it was missing is the
  //    SECOND gate the other four doors have. This list is the backstop for
  //    exactly the case where a refactor drops a requireVerified from a
  //    handler's argument list, and a door protected by one gate fails open
  //    silently when that happens while the other four do not.
  { method: 'POST', pattern: /^\/api\/flocks\/[^/]+\/(join|invite|invite-link|rerun)$/ },
  //    The SECOND door into accepted membership, added with the invite-link
  //    join (routes/guest.js POST /:token/join). It has to be on this list for
  //    the same reason the four above are, and specifically because the B3-4
  //    decision to leave POST /api/feedback OFF the list rests on the premise
  //    that an unverified account cannot manufacture flock-membership evidence
  //    — a premise that a second, ungated join route would have quietly broken.
  { method: 'POST', pattern: /^\/api\/guest\/[^/]+\/join$/ },
  //    The venue side's two doors. Both mount requireVerified explicitly in
  //    routes/venueProfile.js; this is the second gate every other door on
  //    this list has, for the reason the header of this list gives.
  { method: 'POST', pattern: /^\/api\/venue-profile$/ },
  { method: 'POST', pattern: /^\/api\/venue-profile\/request-verification$/ },
];

const UNVERIFIED_MESSAGE =
  'Confirm your email to do this. Check your inbox for the link we sent, or ask for a new one.';

// Normalise one path the way Express's default router settings do: case
// insensitive, trailing slash optional. Duplicate slashes are collapsed too, so
// a path cannot be dressed up to miss a pattern it would otherwise hit.
function normalizeGatePath(value) {
  let p = String(value || '').toLowerCase().replace(/\/{2,}/g, '/');
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

// The routed path, in both the raw and percent-decoded spellings. Express
// matched the route on the raw one, so that is the authoritative form; the
// decoded one is checked as well because over-blocking a strangely encoded URL
// is a far cheaper mistake than under-blocking one.
function gateCandidates(req) {
  const raw = `${req.baseUrl || ''}${req.path || ''}`;
  const out = new Set([normalizeGatePath(raw)]);
  try {
    out.add(normalizeGatePath(decodeURIComponent(raw)));
  } catch {
    // Malformed percent-escape. The raw form is what Express routed on, and it
    // is already in the set.
  }
  return out;
}

// users.email_verified is NOT NULL, so in any database this code can actually
// query it is exactly true or false. Only a literal `false` gates: a row read
// by a test harness (or by some future SELECT that omits the column) must not
// silently lock every user out of friends, flocks and payments.
function isUnverified(row) {
  return row?.email_verified === false;
}

function unverifiedBlocked(req) {
  const paths = [...gateCandidates(req)];
  return UNVERIFIED_DENY.some(
    (rule) => rule.method === req.method && paths.some((p) => rule.pattern.test(p))
  );
}

// Explicit opt-in for a route that must not run for an unverified account.
// Mount it AFTER authenticate: it reads req.user.
//
// A missing req.user means this was mounted BEFORE authenticate, which is a
// wiring mistake rather than a request to allow. Refuse rather than wave it
// through, so the mistake shows up on the first request instead of silently
// disabling the gate on whatever route it was mounted on.
function requireVerified(req, res, next) {
  if (!req.user || isUnverified(req.user)) {
    return res.status(403).json({ error: UNVERIFIED_MESSAGE, emailVerificationRequired: true });
  }
  next();
}

// Express middleware factory: verify JWT from Authorization header.
//
// `allowBanned` exists for exactly one route — DELETE /api/users/me — because a
// banned user must still be able to erase their own account (Apple 5.1.1(v) /
// GDPR / Google Play). It used to be a URL-matching carve-out inside this
// middleware, which was a hole: the regex was unanchored and ran against
// req.originalUrl (query string included), so `DELETE /api/flocks/42?x=/users/me`
// matched and skipped the ban check entirely. A banned harasser could delete a
// flock and CASCADE away every message in it — the exact evidence a moderator
// was reviewing — plus deletes on blocks, safety contacts, friends, calendar,
// venue promotions and reactions. There is no URL matching here any more: the
// one route that needs the exemption opts in explicitly by mounting this
// variant, so nothing else can ever reach it.
function makeAuthenticate({ allowBanned = false } = {}) {
  return async function authenticateRequest(req, res, next) {
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const token = header.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: TOKEN_ALGORITHMS });

      // Confirm user still exists in DB.
      // `email_verified` is selected BEFORE is_banned deliberately: it keeps
      // the `is_banned, token_version FROM users WHERE id = $1` substring that
      // the existing test harnesses dispatch on intact.
      const result = await pool.query(
        'SELECT id, email, name, role, email_verified, is_banned, token_version FROM users WHERE id = $1',
        [decoded.userId]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'User no longer exists' });
      }

      // Server-side revocation (round 13). A stale version means the account
      // was claimed by its verified owner or its password changed since this
      // token was minted.
      if (issuedTokenVersion(decoded) !== currentTokenVersion(result.rows[0])) {
        return res.status(401).json({ error: 'Session expired, please sign in again' });
      }

      // Banned-user enforcement (A6): a ban locks the account out on the next
      // request, everywhere except the opted-in account-deletion route.
      if (result.rows[0].is_banned && !allowBanned) {
        return res.status(403).json({ error: 'This account has been suspended for violating our community guidelines.' });
      }

      // Unverified-account backstop (round 16). See UNVERIFIED_DENY above for
      // the rule and why it lives here as well as in the routes.
      if (isUnverified(result.rows[0]) && unverifiedBlocked(req)) {
        return res.status(403).json({ error: UNVERIFIED_MESSAGE, emailVerificationRequired: true });
      }

      req.user = result.rows[0];
      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        console.warn(`Expired token from ${req.ip} at ${new Date().toISOString()}`);
        return res.status(401).json({ error: 'Token expired' });
      }
      if (err.name === 'JsonWebTokenError') {
        console.warn(`Invalid token from ${req.ip} at ${new Date().toISOString()}`);
        return res.status(401).json({ error: 'Invalid token' });
      }
      return res.status(500).json({ error: 'Authentication failed' });
    }
  };
}

const authenticate = makeAuthenticate();
// Opt-in variant for DELETE /api/users/me only (see makeAuthenticate above).
const authenticateAllowBanned = makeAuthenticate({ allowBanned: true });

// Socket.io middleware: verify JWT from handshake auth
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('No token provided'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: TOKEN_ALGORITHMS });

    const result = await pool.query(
      'SELECT id, email, name, role, profile_image_url, email_verified, is_banned, token_version FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return next(new Error('User not found'));
    }
    if (issuedTokenVersion(decoded) !== currentTokenVersion(result.rows[0])) {
      return next(new Error('Session expired'));
    }
    if (result.rows[0].is_banned) {
      return next(new Error('Account suspended'));
    }

    socket.user = result.rows[0];
    // NOTE: this handshake is the only authentication this connection gets.
    // sockets/handlers.js re-runs these same checks on a timer for the life of
    // the socket, and revokeUserSessions above cuts it immediately when we
    // already know the session is dead. Neither can be dropped for the other.
    next();
  } catch (err) {
    next(new Error('Authentication failed'));
  }
};

module.exports = {
  authenticate,
  authenticateAllowBanned,
  authenticateSocket,
  signUserToken,
  revokeUserSessions,
  requireVerified,
  isUnverified,
  TOKEN_EXPIRY,
  TOKEN_ALGORITHMS,
  UNVERIFIED_MESSAGE,
  // Token-version helpers, exported so sockets/handlers.js and
  // routes/checkin.js compare versions with THIS file's rule instead of a copy.
  tokenVersionOf,
  issuedTokenVersion,
  currentTokenVersion,
};

// Exported for backend/__tests__/emailVerification.test.js.
module.exports.__testing = {
  UNVERIFIED_DENY,
  normalizeGatePath,
  gateCandidates,
  unverifiedBlocked,
};
