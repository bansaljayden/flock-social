require('dotenv').config();

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

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://localhost:5173', // Vite dev server
  'https://flock-app-w65m-git-main-jayden-bansals-projects.vercel.app',
  'https://flock-app-w65m-hm8hk9uo6-jayden-bansals-projects.vercel.app',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    // Allow any Vercel preview deployment for this project
    if (allowedOrigins.includes(origin) || origin.endsWith('-jayden-bansals-projects.vercel.app')) {
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
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Tighter limit on auth endpoints
  message: { error: 'Too many login attempts, please try again later' },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/flocks', apiLimiter, flockRoutes);
app.use('/api', apiLimiter, messageRoutes);     // Handles /api/flocks/:id/messages, /api/messages/:id/react, /api/dm/*
app.use('/api/users', apiLimiter, userRoutes);
app.use('/api/flocks', apiLimiter, venueRoutes); // Handles /api/flocks/:id/vote, /api/flocks/:id/votes
app.use('/api/venues', apiLimiter, venueSearchRoutes); // Handles /api/venues/search, /api/venues/details
app.use('/api/stories', apiLimiter, storyRoutes);     // Handles /api/stories

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
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('-jayden-bansals-projects.vercel.app')) {
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
