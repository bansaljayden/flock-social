require('dotenv').config();
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '[configured]' : '[missing]');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { authenticateSocket } = require('./middleware/auth');
const { registerHandlers } = require('./sockets/handlers');

// Route imports
const authRoutes = require('./routes/auth');
const flockRoutes = require('./routes/flocks');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/users');
const venueRoutes = require('./routes/venues');
const venueSearchRoutes = require('./routes/venueSearch');
const storyRoutes = require('./routes/stories');
const friendRoutes = require('./routes/friends');
const safetyRoutes = require('./routes/safety');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://localhost:5173', // Vite dev server
  'https://flock-app-w65m.vercel.app',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    // Allow any Vercel preview/production deployment for this project
    if (allowedOrigins.includes(origin) || /^https:\/\/flock-app(-[a-z0-9]+)*\.vercel\.app$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// ---------------------------------------------------------------------------
// Security & parsing middleware
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://maps.googleapis.com"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://maps.googleapis.com", "https://places.googleapis.com", "wss:", "ws:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  frameguard: { action: 'deny' },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files (deny dotfiles, no directory listing)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { dotfiles: 'deny', index: false }));

// ---------------------------------------------------------------------------
// Rate limiting (disabled in development)
// ---------------------------------------------------------------------------
const isDev = process.env.NODE_ENV === 'development';

const apiLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

const venueSearchLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many venue searches, please try again later' },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/venues', venueSearchLimiter, venueSearchRoutes); // Before /api catch-all — photo proxy needs no auth
app.use('/api/flocks', apiLimiter, flockRoutes);
app.use('/api', apiLimiter, messageRoutes);     // Handles /api/flocks/:id/messages, /api/messages/:id/react, /api/dm/*
app.use('/api/users', apiLimiter, userRoutes);
app.use('/api/flocks', apiLimiter, venueRoutes); // Handles /api/flocks/:id/vote, /api/flocks/:id/votes
app.use('/api/stories', apiLimiter, storyRoutes);     // Handles /api/stories
app.use('/api/friends', apiLimiter, friendRoutes);    // Handles /api/friends, /api/friends/request, etc.
app.use('/api/safety', apiLimiter, safetyRoutes);     // Handles /api/safety/contacts, /api/safety/alert, etc.

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || /^https:\/\/flock-app(-[a-z0-9]+)*\.vercel\.app$/.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Rate limit WebSocket connections: 10 per minute per IP
const socketConnections = new Map();
io.use((socket, next) => {
  const ip = socket.handshake.address;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxConnections = 10;

  if (!socketConnections.has(ip)) {
    socketConnections.set(ip, []);
  }

  const timestamps = socketConnections.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  socketConnections.set(ip, timestamps);

  if (timestamps.length > maxConnections) {
    return next(new Error('Too many connections, please try again later'));
  }

  next();
});

// Authenticate every socket connection
io.use(authenticateSocket);

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.user.name} (${socket.user.id})`);
  registerHandlers(io, socket);
});

// ---------------------------------------------------------------------------
// Lightweight migrations (idempotent — safe to run every startup)
// ---------------------------------------------------------------------------
const pool = require('./config/database');

async function runMigrations() {
  try {
    // DM feature parity: add rich message columns
    await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text'`);
    await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS venue_data JSONB`);
    await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES direct_messages(id) ON DELETE SET NULL`);

    await pool.query(`CREATE TABLE IF NOT EXISTS dm_emoji_reactions (
      id SERIAL PRIMARY KEY,
      dm_id INTEGER REFERENCES direct_messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      emoji VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(dm_id, user_id, emoji)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_emoji_reactions_dm ON dm_emoji_reactions(dm_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS dm_venue_votes (
      id SERIAL PRIMARY KEY,
      user1_id INTEGER NOT NULL,
      user2_id INTEGER NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      venue_name VARCHAR(255) NOT NULL,
      venue_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user1_id, user2_id, user_id, venue_name)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_venue_votes_pair ON dm_venue_votes(user1_id, user2_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS dm_pinned_venues (
      id SERIAL PRIMARY KEY,
      user1_id INTEGER NOT NULL,
      user2_id INTEGER NOT NULL,
      venue_name VARCHAR(255) NOT NULL,
      venue_address TEXT,
      venue_id VARCHAR(255),
      venue_rating NUMERIC(2,1),
      venue_photo_url TEXT,
      pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user1_id, user2_id)
    )`);

    // Safety: trusted contacts & emergency alert log
    await pool.query(`CREATE TABLE IF NOT EXISTS trusted_contacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      contact_name VARCHAR(100) NOT NULL,
      contact_phone VARCHAR(20) NOT NULL,
      contact_email VARCHAR(255),
      relationship VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, contact_phone)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trusted_contacts_user ON trusted_contacts(user_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS emergency_alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      contacts_alerted INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Keep demo stories alive — refresh expiration for seeded picsum stories
    await pool.query(
      `UPDATE stories SET expires_at = NOW() + INTERVAL '24 hours'
       WHERE image_url LIKE 'https://picsum.photos/seed/flock%' AND expires_at < NOW()`
    );

    console.log('Migrations complete');
  } catch (err) {
    console.warn('Migration warning (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  console.log(`Flock API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  await runMigrations();
});

module.exports = { app, server, io };
