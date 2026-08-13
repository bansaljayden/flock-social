const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const TOKEN_EXPIRY = '24h';

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
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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
  TOKEN_EXPIRY,
};
