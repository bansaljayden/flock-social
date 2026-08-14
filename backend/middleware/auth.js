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
function issuedTokenVersion(decoded) {
  return Number.isInteger(decoded?.tv) ? decoded.tv : 0;
}

function currentTokenVersion(row) {
  return Number.isInteger(row?.token_version) ? row.token_version : 0;
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
// intruder is still reading. Anything that bumps token_version should call this
// as well; routes/users.js's password change currently does not.
function revokeUserSessions(io, userId) {
  if (!io || userId === undefined || userId === null) return false;
  try {
    io.in(`user:${userId}`).disconnectSockets(true);
    return true;
  } catch (err) {
    console.error(`[auth] socket revocation failed for user ${userId}:`, err.message);
    return false;
  }
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

      // Confirm user still exists in DB
      const result = await pool.query(
        'SELECT id, email, name, role, is_banned, token_version FROM users WHERE id = $1',
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
      'SELECT id, email, name, role, profile_image_url, is_banned, token_version FROM users WHERE id = $1',
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
  TOKEN_EXPIRY,
  TOKEN_ALGORITHMS,
};
