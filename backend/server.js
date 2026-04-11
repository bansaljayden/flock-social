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
const crowdRoutes = require('./routes/crowd');
const feedbackRoutes = require('./routes/feedback');
const weatherRoutes = require('./routes/weather');
const budgetRoutes = require('./routes/budget');
const billingRoutes = require('./routes/billing');
const eventRoutes = require('./routes/events');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const waitlistRoutes = require('./routes/waitlist');
const adminRoutes = require('./routes/admin');
const venueProfileRoutes = require('./routes/venueProfile');
const venueDashboardRoutes = require('./routes/venueDashboard');

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
      styleSrc: ["'self'", "https://fonts.googleapis.com", "https://api.fontshare.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://maps.googleapis.com", "https://places.googleapis.com", "wss:", "ws:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.fontshare.com"],
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
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

const aiLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please slow down' },
});

const venueSearchLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 120,
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
app.use('/api/crowd', apiLimiter, crowdRoutes);       // Handles /api/crowd/:placeId, /api/crowd/batch, /api/crowd/:placeId/alternatives
app.use('/api/feedback', apiLimiter, feedbackRoutes); // Handles /api/feedback, /api/feedback/venue/:placeId
app.use('/api/weather', apiLimiter, weatherRoutes);   // Handles /api/weather?lat=...&lon=...
app.use('/api/budget', apiLimiter, budgetRoutes);     // Handles /api/budget/:flockId/*
app.use('/api/billing', apiLimiter, billingRoutes);   // Handles /api/billing/:flockId/*
app.use('/api/events', apiLimiter, eventRoutes);      // Handles /api/events/search, /api/events/featured
app.use('/api/ai', aiLimiter, aiRoutes);             // Handles /api/ai/chat (Birdie AI assistant)
app.use('/api/notifications', apiLimiter, notificationRoutes); // Handles /api/notifications/register, unregister
app.use('/api/waitlist', apiLimiter, waitlistRoutes);          // Handles /api/waitlist (public, no auth)
app.use('/api/admin', apiLimiter, adminRoutes);               // Handles /api/admin/* (admin only)
app.use('/api/venue-profile', apiLimiter, venueProfileRoutes); // Handles /api/venue-profile (venue owners)
app.use('/api/venue-dashboard', apiLimiter, venueDashboardRoutes); // Handles promotions, events, reviews CRUD

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
app.set('io', io);

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

    // Crowd Intelligence: venue feedback for calibration loop
    await pool.query(`CREATE TABLE IF NOT EXISTS venue_feedback (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      flock_id INTEGER,
      venue_place_id VARCHAR(255) NOT NULL,
      venue_name VARCHAR(255) NOT NULL,
      crowd_level SMALLINT NOT NULL CHECK (crowd_level BETWEEN 1 AND 3),
      price_worth BOOLEAN,
      rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
      predicted_score SMALLINT CHECK (predicted_score BETWEEN 0 AND 100),
      day_of_week SMALLINT NOT NULL,
      hour SMALLINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_venue_feedback_place ON venue_feedback(venue_place_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_venue_feedback_day_hour ON venue_feedback(venue_place_id, day_of_week, hour)`);

    // Money layer: budget matching, bill splits, Venmo settlement
    // Wrapped in own try/catch to ensure these run even if earlier migrations fail
    try {
      await pool.query(`ALTER TABLE flocks ADD COLUMN IF NOT EXISTS budget_enabled BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE flocks ADD COLUMN IF NOT EXISTS budget_context VARCHAR(100)`);
      await pool.query(`ALTER TABLE flocks ADD COLUMN IF NOT EXISTS budget_locked BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE flocks ADD COLUMN IF NOT EXISTS budget_ceiling DECIMAL(8,2)`);
      await pool.query(`ALTER TABLE flocks ADD COLUMN IF NOT EXISTS ghost_mode_enabled BOOLEAN DEFAULT false`);

      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS venmo_username VARCHAR(50)`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS cashapp_cashtag VARCHAR(50)`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS zelle_identifier VARCHAR(255)`);

      await pool.query(`CREATE TABLE IF NOT EXISTS budget_submissions (
        id SERIAL PRIMARY KEY,
        flock_id INTEGER REFERENCES flocks(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(8,2),
        skipped BOOLEAN DEFAULT false,
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(flock_id, user_id)
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_budget_submissions_flock ON budget_submissions(flock_id)`);

      await pool.query(`CREATE TABLE IF NOT EXISTS bill_splits (
        id SERIAL PRIMARY KEY,
        flock_id INTEGER REFERENCES flocks(id) ON DELETE CASCADE,
        total_amount DECIMAL(8,2) NOT NULL,
        split_type VARCHAR(20) DEFAULT 'equal',
        paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        tip_percent DECIMAL(4,1) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(flock_id)
      )`);

      await pool.query(`CREATE TABLE IF NOT EXISTS bill_split_shares (
        id SERIAL PRIMARY KEY,
        bill_id INTEGER REFERENCES bill_splits(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(8,2) NOT NULL,
        committed BOOLEAN DEFAULT false,
        settled BOOLEAN DEFAULT false,
        settled_at TIMESTAMPTZ,
        UNIQUE(bill_id, user_id)
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bill_split_shares_bill ON bill_split_shares(bill_id)`);

      // Cleanup: delete individual budget submissions 24h after flock completes (privacy)
      await pool.query(`DELETE FROM budget_submissions
        WHERE flock_id IN (
          SELECT id FROM flocks
          WHERE status IN ('completed', 'cancelled')
          AND updated_at < NOW() - INTERVAL '24 hours'
        )`);

      console.log('Money layer migrations complete');
    } catch (moneyErr) {
      console.error('Money layer migration error:', moneyErr.message);
    }

    // Push notifications: device token storage
    await pool.query(`CREATE TABLE IF NOT EXISTS device_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      device_type VARCHAR(20) DEFAULT 'web',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, token)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id)`);

    // Reliability scoring columns
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reliability_score DECIMAL(5,2)`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_plans_joined INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_plans_attended INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE flock_members ADD COLUMN IF NOT EXISTS attendance VARCHAR(20) DEFAULT 'unmarked'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_flock_members_attendance ON flock_members(attendance)`);
      console.log('Reliability scoring migrations complete');
    } catch (relErr) {
      console.error('Reliability migration error:', relErr.message);
    }

    // Research analytics table
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS research_analytics (
        id SERIAL PRIMARY KEY,
        flock_id INTEGER REFERENCES flocks(id) ON DELETE SET NULL,
        group_size INTEGER,
        budget_enabled BOOLEAN DEFAULT false,
        budget_ceiling DECIMAL(8,2),
        submission_count INTEGER DEFAULT 0,
        skip_count INTEGER DEFAULT 0,
        flock_completed BOOLEAN DEFAULT false,
        venue_price_level_selected INTEGER,
        time_to_confirmation INTEGER,
        stall_point VARCHAR(30),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(flock_id)
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_research_analytics_created ON research_analytics(created_at)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_research_analytics_stall ON research_analytics(stall_point)`);
      console.log('Research analytics migrations complete');
    } catch (analyticsErr) {
      console.error('Research analytics migration error:', analyticsErr.message);
    }

    // OAuth columns
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(20)`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_id VARCHAR(255)`);
      await pool.query(`ALTER TABLE users ALTER COLUMN password DROP NOT NULL`);
      console.log('OAuth migrations complete');
    } catch (oauthErr) {
      console.error('OAuth migration error:', oauthErr.message);
    }

    // Venue profiles table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_profiles (
          id SERIAL PRIMARY KEY,
          user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          business_name VARCHAR(255) NOT NULL,
          category VARCHAR(100),
          location VARCHAR(255),
          description TEXT,
          goals TEXT[],
          google_place_id VARCHAR(255),
          photo_url TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('Venue profiles migration complete');
    } catch (venueErr) {
      console.error('Venue profiles migration error:', venueErr.message);
    }

    // Venue promotions table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_promotions (
          id SERIAL PRIMARY KEY,
          venue_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          google_place_id VARCHAR(255),
          title VARCHAR(255) NOT NULL,
          description TEXT,
          time_slot VARCHAR(100),
          days VARCHAR(100),
          active BOOLEAN DEFAULT true,
          views INTEGER DEFAULT 0,
          claims INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_venue_promos_place ON venue_promotions(google_place_id)');
      console.log('Venue promotions migration complete');
    } catch (e) { console.error('Venue promotions migration error:', e.message); }

    // Venue events table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_events (
          id SERIAL PRIMARY KEY,
          venue_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          google_place_id VARCHAR(255),
          title VARCHAR(255) NOT NULL,
          event_date VARCHAR(50),
          event_time VARCHAR(50),
          capacity INTEGER DEFAULT 50,
          rsvps INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_venue_events_place ON venue_events(google_place_id)');
      console.log('Venue events migration complete');
    } catch (e) { console.error('Venue events migration error:', e.message); }

    // Venue reviews table (Flock user reviews, separate from Google)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_reviews (
          id SERIAL PRIMARY KEY,
          google_place_id VARCHAR(255) NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          text TEXT,
          venue_reply TEXT,
          venue_replied_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(google_place_id, user_id)
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_venue_reviews_place ON venue_reviews(google_place_id)');
      console.log('Venue reviews migration complete');
    } catch (e) { console.error('Venue reviews migration error:', e.message); }

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

  // Proactive crowd alerts — check every 15 minutes
  const { checkCrowdAlerts } = require('./services/crowdAlerts');
  setInterval(checkCrowdAlerts, 15 * 60 * 1000);
  // Run once after a short delay on startup
  setTimeout(checkCrowdAlerts, 30 * 1000);
});

module.exports = { app, server, io };
