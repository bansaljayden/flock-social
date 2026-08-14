require('./instrument'); // Sentry — must load before everything else (B3)
require('dotenv').config();
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '[configured]' : '[missing]');

// Fail fast if JWT_SECRET is missing — without it every jwt.sign/verify throws
// at request time (opaque 500s). Hard-exit in production; warn elsewhere so
// local tooling that stubs auth still runs.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is not set. Refusing to start.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET is not set — auth endpoints will fail until it is configured.');
}

const express = require('express');
const Sentry = require('@sentry/node');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

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
const publicCrowdRoutes = require('./routes/publicCrowd');
const adminRoutes = require('./routes/admin');
const venueProfileRoutes = require('./routes/venueProfile');
const venueDashboardRoutes = require('./routes/venueDashboard');
const availabilityRoutes = require('./routes/availability');
const calendarRoutes = require('./routes/calendar');
const sensorRoutes = require('./routes/sensors');
const checkinRoutes = require('./routes/checkin');
const moderationRoutes = require('./routes/moderation');
const revenuecatRoutes = require('./routes/revenuecat');
const entitlementsRoutes = require('./routes/entitlements');

// ---------------------------------------------------------------------------
// Process-level safety net
//
// Node's default for an unhandled promise rejection is to print the reason and
// KILL THE PROCESS. On Railway that drops every open WebSocket and 502s every
// in-flight request until the container restarts — one stray floating promise
// anywhere in the codebase takes the whole service down for everyone.
//
// Sentry does not cover this: instrument.js only calls Sentry.init() when
// SENTRY_DSN is set, and it is not set in production, so today the failure is
// silent as well as fatal.
//
// Every floating promise in the tree is currently caught (the `.catch(() => {})`
// tails on the socket fan-outs, the migration unlock, the demo-story refresh),
// so this is insurance against a future regression, not a live bug. It is
// deliberately NOT paired with an uncaughtException handler: a rejected promise
// leaves the process in a known state, a thrown-past-the-top exception does not,
// and swallowing the latter is how you serve corrupted state instead of
// restarting.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (kept alive):', reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

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
  // The real domain. Added ahead of the DNS cutover so the app at
  // flockcorp.com/app works the moment the domain resolves — without this the
  // new origin is blocked and every API call fails.
  'https://flockcorp.com',
  'https://www.flockcorp.com',
  // Capacitor native app shell origins (iOS uses capacitor://localhost,
  // Android uses http(s)://localhost). Required or the app's API + Socket.io
  // calls are blocked by CORS ("load failed" on login).
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
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

// Round 12: the /uploads static mount is gone. Nothing writes to that
// directory any more — routes/users.js buffers the one upload endpoint in
// memory and stores the image as a data URL in users.profile_image_url —
// and serving it from Railway's ephemeral filesystem was a promise the
// platform could not keep: every redeploy emptied it while the column still
// pointed at /uploads/<file>. No Railway volume is needed.

// Health check — defined BEFORE the authenticated /api/* routers so their auth
// middleware doesn't shadow it with a 401 (caught by the local E2E harness).
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
// Mount routes that use NON-JWT auth (or no auth at all) BEFORE the messageRoutes
// catch-all at /api — that router's `router.use(authenticate)` intercepts every
// /api/* request without a Bearer token, which would 401 the Pi (x-api-key) and
// break the anonymous NFC GET below.
app.use('/api/revenuecat', revenuecatRoutes);                  // RevenueCat webhook (shared-secret, no JWT) — before messages catch-all
app.use('/api/guest', apiLimiter, require('./routes/guest').router); // Guest link RSVP/vote (token-authed, no JWT) — before messages catch-all
app.use('/api/badge', apiLimiter, require('./routes/badge'));        // Embeddable live-busyness SVG (public, claimed venues only)
app.use('/api/sensors', apiLimiter, sensorRoutes);              // Pi sensor ingest (x-api-key) + read APIs (JWT)
app.use('/api/checkin', apiLimiter, checkinRoutes);             // NFC tap + manual venue check-in (anon-friendly GET)
app.use('/api/waitlist', apiLimiter, waitlistRoutes);           // PUBLIC, no auth — MUST stay before the /api catch-alls
app.use('/api/public', apiLimiter, publicCrowdRoutes);          // PUBLIC, no auth — website live crowd demo (own per-IP + daily caps inside)
                                                                // (was mounted after them, which 401'd every landing-page signup)
// /api/users must also precede the two /api catch-alls. Those routers call
// `router.use(authenticate)`, which runs for EVERY request under /api — so a
// banned user's DELETE /api/users/me was rejected 403 there before it could
// ever reach the ban-tolerant `authenticateAllowBanned` this router mounts on
// that one route, breaking the right to erasure (Apple 5.1.1(v) / GDPR).
// Neither catch-all defines any /users path, so the move changes nothing else.
app.use('/api/users', apiLimiter, userRoutes);
app.use('/api', apiLimiter, moderationRoutes);  // /api/reports, /api/blocks/* — before messages catch-all
app.use('/api', apiLimiter, messageRoutes);     // Handles /api/flocks/:id/messages, /api/messages/:id/react, /api/dm/*
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
app.use('/api/entitlements', apiLimiter, entitlementsRoutes); // Handles /api/entitlements (Flock Pro paywall status)
app.use('/api/notifications', apiLimiter, notificationRoutes); // Handles /api/notifications/register, unregister
app.use('/api/admin', apiLimiter, adminRoutes);               // Handles /api/admin/* (admin only)
app.use('/api/venue-profile', apiLimiter, venueProfileRoutes); // Handles /api/venue-profile (venue owners)
app.use('/api/venue-dashboard', apiLimiter, venueDashboardRoutes); // Handles promotions, events, reviews CRUD
app.use('/api/availability', apiLimiter, availabilityRoutes); // 3-tap status pulse: down / maybe / not
app.use('/api/calendar', apiLimiter, calendarRoutes);          // personal calendar events (CRUD, per-user)

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Sentry error capture — must precede the custom error handler (B3; no-op without DSN)
Sentry.setupExpressErrorHandler(app);

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
const io = new Server(server, {
  // 8MB: the chat UI accepts images up to 5MB, which base64-expands past
  // Socket.IO's 1MB default and silently killed the send (round 3 P2)
  maxHttpBufferSize: 8 * 1024 * 1024,
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

// Behind Railway's proxy every socket reports the same handshake.address (the
// proxy's own peer address), so keying on it put ALL users in one 10/minute
// bucket — one reconnect loop locked everyone out. Trust the same single
// forwarding hop Express does (app.set('trust proxy', 1)): the last entry in
// X-Forwarded-For is what our proxy appended and is the only one a client
// can't spoof (round 9).
function socketClientIp(socket) {
  const xff = socket.handshake.headers?.['x-forwarded-for'];
  if (xff) {
    const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return socket.handshake.address;
}

io.use((socket, next) => {
  const ip = socketClientIp(socket);
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxConnections = 10;

  if (socketConnections.size > 10000) {
    for (const [k, v] of socketConnections) {
      if (!v.length || now - v[v.length - 1] > windowMs) socketConnections.delete(k);
    }
  }
  if (!socketConnections.has(ip)) {
    socketConnections.set(ip, []);
  }

  const timestamps = socketConnections.get(ip).filter(t => now - t < windowMs);

  // Count the rejection BEFORE recording it: pushing every refused attempt
  // kept the window permanently full, so a client that tripped the limit
  // could never recover within the minute (round 9).
  if (timestamps.length >= maxConnections) {
    socketConnections.set(ip, timestamps);
    return next(new Error('Too many connections, please try again later'));
  }

  timestamps.push(now);
  socketConnections.set(ip, timestamps);
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

// ---------------------------------------------------------------------------
// Schema: versioned migrations in backend/migrations/*.sql (db/migrate.js).
// The old ~460-line inline runner lives on verbatim as 001_baseline.sql; new
// schema changes are NEW numbered files. A failed (non-tolerant) migration
// halts the boot instead of leaving a silently half-migrated deployment.
// ---------------------------------------------------------------------------
const { migrate } = require('./db/migrate');

// Post-boot data tasks — not schema, so not migrations.
async function postBootTasks() {
  // Admin provisioning — by IMMUTABLE user id via env, never by email.
  if (process.env.ADMIN_USER_IDS) {
    const ids = process.env.ADMIN_USER_IDS.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
    if (ids.length > 0) {
      await pool.query(`UPDATE users SET role = 'admin' WHERE id = ANY($1) AND role != 'admin'`, [ids]).catch(() => {});
    }
  }
  // Demo stories are stock picsum placeholders belonging to the seeded demo
  // accounts. This refresh ran UNCONDITIONALLY on every boot, which made a
  // 24-hour story permanent: anyone friended with a demo account — App Review
  // included — saw stock photos presented as a real friend's story, forever.
  // That is the exact "no stock photos / no seed data in production" rule the
  // review checklist exists to enforce, so a populated demo feed now has to be
  // asked for out loud, the same shape of guard as scripts/seed-review-account.js.
  // Unset (production default): the rows expire on their own like any story.
  if (process.env.KEEP_DEMO_STORIES === '1') {
    await pool.query(
      `UPDATE stories SET expires_at = NOW() + INTERVAL '24 hours'
       WHERE image_url LIKE 'https://picsum.photos/seed/flock%' AND expires_at < NOW()`
    ).catch((e) => console.warn('Demo story refresh failed:', e.message));
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;

// Migrations MUST complete before the port opens — listen() accepts requests
// immediately, so migrating inside its callback let traffic hit a half-applied
// schema (and kept serving briefly even after a failed migration).
async function boot() {
  try {
    await migrate(pool);
  } catch (e) {
    console.error('FATAL: migration failed — refusing to serve on a half-applied schema.');
    process.exit(1);
  }
  await postBootTasks();

  server.listen(PORT, () => {
    console.log(`Flock API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });

  // Proactive crowd alerts — check every 15 minutes
  const { checkCrowdAlerts } = require('./services/crowdAlerts');
  setInterval(checkCrowdAlerts, 15 * 60 * 1000);
  // Run once after a short delay on startup
  setTimeout(checkCrowdAlerts, 30 * 1000);
}

boot();

module.exports = { app, server, io };
