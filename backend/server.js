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

const app = express();
app.set('trust proxy', true);
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
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://maps.googleapis.com", "https://places.googleapis.com", "wss:", "ws:"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  frameguard: { action: 'deny' },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '10mb' }));
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
app.use('/api/flocks', apiLimiter, flockRoutes);
app.use('/api', apiLimiter, messageRoutes);     // Handles /api/flocks/:id/messages, /api/messages/:id/react, /api/dm/*
app.use('/api/users', apiLimiter, userRoutes);
app.use('/api/flocks', apiLimiter, venueRoutes); // Handles /api/flocks/:id/vote, /api/flocks/:id/votes
app.use('/api/venues', venueSearchLimiter, venueSearchRoutes); // Handles /api/venues/search, /api/venues/details
app.use('/api/stories', apiLimiter, storyRoutes);     // Handles /api/stories
app.use('/api/friends', apiLimiter, friendRoutes);    // Handles /api/friends, /api/friends/request, etc.

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
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Flock API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = { app, server, io };
