const jwt = require('jsonwebtoken');
const pool = require('../config/database');

// Express middleware: verify JWT from Authorization header
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Confirm user still exists in DB
    const result = await pool.query(
      'SELECT id, email, name, role, is_banned FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User no longer exists' });
    }
    // Banned-user enforcement (A6): a ban locks the account out on the next
    // request — EXCEPT deleting their own account, which a banned user must still
    // be able to do (right to erasure: Apple 5.1.1(v) / GDPR / Google).
    if (result.rows[0].is_banned) {
      const isAccountDeletion = req.method === 'DELETE' && /\/users\/me\/?(\?|$)/.test(req.originalUrl || req.url || '');
      if (!isAccountDeletion) {
        return res.status(403).json({ error: 'This account has been suspended for violating our community guidelines.' });
      }
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

// Socket.io middleware: verify JWT from handshake auth
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('No token provided'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      'SELECT id, email, name, role, profile_image_url, is_banned FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return next(new Error('User not found'));
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

module.exports = { authenticate, authenticateSocket };
