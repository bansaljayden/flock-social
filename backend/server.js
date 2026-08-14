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
// Used by the billed-image limiter below to name the ACCOUNT behind a request
// before any router's authenticate middleware has run. TOKEN_ALGORITHMS comes
// from middleware/auth.js rather than being written out again, for the same
// reason the socket's session revalidator imports it: two places that verify
// the same token must not be able to accept different algorithms.
const jwt = require('jsonwebtoken');

const { authenticateSocket, TOKEN_ALGORITHMS } = require('./middleware/auth');
// CHAT_IMAGE_MAX_BYTES is the ceiling the socket handler enforces on a chat
// photo's data: URL. The REST body limit below is derived from it so the two
// transports accept exactly the same image. See the JSON body limits block.
// checkInboundImage is the socket's own "is there an image here, and is it one
// we would accept for free?" test — the billed-image limiter below asks it the
// same question so the two transports charge for the same payloads.
const { registerHandlers, CHAT_IMAGE_MAX_BYTES, checkInboundImage } = require('./sockets/handlers');

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
// ---------------------------------------------------------------------------
// JSON body limits
// ---------------------------------------------------------------------------
// Chat photos travel INSIDE the message body as a base64 data: URL, on
// whichever transport is up. Socket.IO was deliberately raised to 8MB to carry
// them (maxHttpBufferSize, below); express.json() was left at the 1mb it
// shipped with, and nobody reconciled the two. base64 inflates by ~4/3, so 1mb
// of body is roughly a 750KB photo — past that the REST path died on a
// body-parser 413, and the REST path is the FALLBACK the socket client uses
// when its connection is down. A photo therefore failed precisely on the weak
// signal that put the send on that transport in the first place, and went
// through the moment the socket came back. routes/messages.js has carried a
// comment acknowledging this cap for a while.
//
// This is NOT fixed by raising the limit globally, and the blast radius is the
// reason. express.json() is mounted ahead of every route AND ahead of every
// rate limiter (apiLimiter/authLimiter are mounted per-router further down), so
// the body is fully buffered into memory before any limiter can refuse the
// request. Raising it globally would hand an UNAUTHENTICATED client a bigger
// free buffer on /api/auth/login, /api/waitlist and /api/public — none of which
// carry an image — on a single Railway instance that also runs ONNX inference.
// The endpoints that legitimately carry an image are three authenticated POSTs,
// so those get their own parser and everything else keeps the 1mb ceiling.
//
// The size is derived rather than picked. CHAT_IMAGE_MAX_BYTES is what
// sockets/handlers.js enforces on the data: URL itself, so REST has to fit that
// same image plus the rest of the body: up to 5000 characters of message text
// (as much as 6 bytes each once JSON-escapes them), a sanitized venue card, and
// the keys. 64KB covers all of it several times over. The result is that
// neither transport is the narrower one, and the number that decides it lives
// in exactly one place.
const JSON_BODY_ENVELOPE_BYTES = 64 * 1024;
const imageJsonParser = express.json({ limit: CHAT_IMAGE_MAX_BYTES + JSON_BODY_ENVELOPE_BYTES });
const defaultJsonParser = express.json({ limit: '1mb' });

// POSTs whose body legitimately carries a base64 image. Anchored and
// case-insensitive: Express routes case-insensitively by default, so a
// `/api/DM/5` that reaches the DM handler must reach the same parser.
//
// The id segments are `[^/]+`, NOT `\d+`, and that is the fix to a real miss
// rather than looseness. This list has to match what EXPRESS routes, and
// `:userId` is any one segment: `POST /api/dm/+7` reaches the DM send handler
// (express-validator's isInt() accepts a leading plus, and parseInt turns it
// into 7), while `\d+` did not match it. The consequence was not academic — the
// same list decides the JSON body limit AND, further down, whether a request is
// charged the billed-image meter, so `+7` was an unmetered door to a paid Cloud
// Vision call. Over-matching is the safe direction here: a URL like
// `/api/dm/abc` is metered and then 400s, which costs an abuser a token and a
// real user nothing. Every path that must NOT be on this list — /api/dm itself,
// /api/dm/:id/read, the react routes, /api/stories/:id — differs by a segment,
// not by the shape of one, and __tests__/chatTransportParity.test.js pins that.
const IMAGE_BODY_ROUTES = [
  /^\/api\/flocks\/[^/]+\/messages\/?$/i,  // flock chat photo — REST twin of send_message
  /^\/api\/dm\/[^/]+\/?$/i,                // DM photo — REST twin of send_dm
  /^\/api\/stories\/?$/i,                  // story photo (route caps the data URL at 700KB itself)
];

// Express collapses nothing: `POST /api//dm/7` and `POST /api/users//upload-image`
// both reach their handlers, and neither matched the anchored patterns above.
// That made a doubled slash a way to sidestep both this parser and the
// billed-image meter below — the same request, the same handler, a different
// spelling of the URL. Match on a path with runs of slashes collapsed so the
// spelling cannot decide the ceiling. (req.path carries no query string, so
// there is nothing else to strip.)
const imageRoutePath = (req) => req.path.replace(/\/{2,}/g, '/');

app.use((req, res, next) => {
  const parser = req.method === 'POST' && IMAGE_BODY_ROUTES.some((re) => re.test(imageRoutePath(req)))
    ? imageJsonParser
    : defaultJsonParser;
  return parser(req, res, next);
});
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

// aiLimiter is declared further down, immediately after billedImageKey, because
// it keys on the ACCOUNT and therefore has to reuse that function rather than
// grow a second copy of it. See the Birdie block below.

const venueSearchLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many venue searches, please try again later' },
});

// ---------------------------------------------------------------------------
// Billed image screening — the REST twin of the socket's send_image meter
// ---------------------------------------------------------------------------
// Every image this app accepts is screened by Google Cloud Vision, and every
// screen is a PAID call (utils/moderation.js). sockets/handlers.js meters them:
// both send paths charge a 'send_image' bucket of 10 per 60 seconds per
// connection, and allowEvent charges the ACCOUNT USER_LIMIT_MULTIPLIER times
// that across every connection it holds — so one account can buy at most 20
// billed screens a minute over the socket, however many sockets it opens and
// from however many addresses.
//
// The REST twins of those same sends had no per-image bucket at all. Their only
// ceiling was apiLimiter, at 3000 per 15 minutes: 200 requests a minute, and
// therefore up to 200 billed calls a minute, per address, with a fresh 200 for
// every address the caller can reach us from. The FALLBACK transport was an
// order of magnitude cheaper to abuse than the primary one it exists to back
// up, and no test said a word about it until __tests__/imageSpendLimits.test.js.
//
// WHAT THIS SAVES, AND WHAT IT CANNOT SAVE. express.json() is mounted above,
// ahead of every route AND ahead of every limiter, so by the time this runs the
// body has already been read into memory — up to CHAT_IMAGE_MAX_BYTES plus the
// envelope on the three image routes. A refusal here therefore does NOT save
// the buffer; it saves the billed Vision call, the row, and the fan-out to
// every recipient. That is the expensive part by a wide margin (a megabyte of
// transient heap costs nothing; a Vision call is money and a stored data URL is
// re-sent on every history read), but the buffer is genuinely not recovered and
// no comment here should pretend otherwise. Moving this ahead of the parser
// would recover it — and would also meter plain text messages, which arrive on
// the same three URLs and carry no image, because nothing can tell a text
// message from a photo before the body is parsed. Metering ordinary chat to
// save a megabyte of heap is the wrong trade.
//
// The ONE exception is the avatar upload, which is multipart: its bytes are
// buffered by multer INSIDE routes/users.js, so a refusal here does stop that
// read, and every POST to it carries an image by definition.
const AVATAR_UPLOAD_ROUTE = /^\/api\/users\/upload-image\/?$/i;

// Same numbers as `allowEvent(socket, 'send_image', 10, 60_000)` in
// sockets/handlers.js — an account gets the same photo allowance over REST that
// it gets on one socket connection, and strictly less than the 20 a minute the
// socket transport grants the account overall. They are literals at those call
// sites rather than exported constants, so the pairing is pinned by
// __tests__/imageSpendLimits.test.js, which reads both files and fails if one
// number moves without the other.
const IMAGE_SCREENS_PER_WINDOW = 10;
const IMAGE_SCREEN_WINDOW_MS = 60 * 1000;
// Verbatim the sentence the socket sends for the same refusal. The client
// toasts both, and one condition described two ways reads as two products.
const IMAGE_RATE_LIMIT_MESSAGE = 'Slow down a moment.';

// Identity is the ACCOUNT, not the address, and that is the whole point. Every
// other limiter in this file keys on the IP, which the socket's meter
// deliberately does not: a per-address ceiling here would leave REST beatable
// by rotating addresses (the socket path is not) while also handing one school
// or one household's shared address a single allowance to fight over. This runs
// before any router's `authenticate`, so it verifies the bearer token itself
// and falls back to the address only for a request that is about to be 401'd
// anyway. The token is VERIFIED rather than merely decoded: reading `userId`
// out of an unchecked payload would let a caller mint a fresh bucket per
// request out of forged tokens, which is worse than having no meter at all.
//
// The token is pulled out of the header EXACTLY the way makeAuthenticate in
// middleware/auth.js pulls it out — `startsWith('Bearer ')` then
// `split(' ')[1]` — and that is not stylistic. Reading it as `slice(7)`
// instead, which looks equivalent, disagrees on `Bearer <valid token> junk`:
// the router authenticates that request (split stops at the first space) while
// slice hands jwt.verify a string with trailing junk, which throws. The
// difference is a caller who appends a space and a character to their own
// header, is authenticated normally, and drops out of their account's bucket
// into the shared per-address one — i.e. straight back to a meter that IP
// rotation defeats. Two readings of one header is the bug; keep them identical.
function billedImageKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET, { algorithms: TOKEN_ALGORITHMS });
      if (Number.isInteger(decoded?.userId)) return `user:${decoded.userId}`;
    } catch (_) { /* expired, forged or malformed — the router will answer it */ }
  }
  return `addr:${req.ip}`;
}

// Charge a token only for a request that is actually going to reach
// moderateImage. checkInboundImage is the socket's own gate, imported rather
// than restated, so all three of its answers carry across: no image at all
// (a text message, or the empty string both transports read as "no image") is
// free, and a malformed or oversized payload is free too — the routes refuse
// those from the bytes alone, and the socket path deliberately runs the same
// checks AHEAD of its bucket so a photo that could never work does not spend
// the allowance the user needs for one that would.
//
// The route list is IMAGE_BODY_ROUTES itself: exactly the JSON endpoints whose
// bodies may carry a base64 image, so the two lists cannot drift into
// disagreeing about which those are. The story route caps its data URL lower
// (700KB) and takes a narrower set of formats than the chat ceiling here, so a
// story image between the two limits spends a token and is then refused for
// free. That is the conservative direction and it costs a legitimate poster
// nothing.
function carriesBilledImage(req) {
  if (req.method !== 'POST') return false;
  // imageRoutePath, not req.path — see its definition. `/api//dm/7` and
  // `/api/users//upload-image` reach the same handlers as their single-slash
  // spellings and must reach the same meter.
  const routePath = imageRoutePath(req);
  if (AVATAR_UPLOAD_ROUTE.test(routePath)) return true;
  if (!IMAGE_BODY_ROUTES.some((re) => re.test(routePath))) return false;
  const inbound = checkInboundImage(req.body?.image_url);
  return inbound !== null && inbound.ok === true;
}

// Two things this does NOT claim, so nobody reads more into it later:
//   * The counters are in this process's heap, so they reset on every deploy
//     and they divide by the instance count — the same caveat utils/probeBudget
//     and utils/placesBudget carry. One Railway instance today; if that ever
//     changes, this and they move to Postgres together.
//   * The socket keeps its own bucket, so an account holding a live connection
//     AND using the fallback at the same time can reach the sum of the two
//     rather than the larger. No client does that (REST is what the socket
//     client falls back to when its connection is DOWN), and the sum is still
//     bounded per account instead of unbounded per address, which is the hole
//     this closes. Making it exact would mean one shared bucket, which means
//     reaching into sockets/handlers.js's private counters from here.
const imageSpendLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: IMAGE_SCREEN_WINDOW_MS,
  max: IMAGE_SCREENS_PER_WINDOW,
  keyGenerator: billedImageKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: IMAGE_RATE_LIMIT_MESSAGE },
});

// Mounted here, ahead of every router, so it covers all four billed paths at
// once — flock photo, DM photo, story, avatar. Per-route mounting would have
// given each its own bucket, and a caller alternating between them would have
// bought the sum.
app.use((req, res, next) => (carriesBilledImage(req) ? imageSpendLimiter(req, res, next) : next()));

// ---------------------------------------------------------------------------
// Birdie (Gemini) — the same identity question, answered the same way
// ---------------------------------------------------------------------------
// This limiter used to key on the IP, like every other limiter in this file
// except the billed-image one above. That is the weakness the image meter was
// rewritten to remove: a per-address ceiling is bought around by rotating
// addresses, and it simultaneously puts one school or one household into a
// single shared bucket. Gemini is a PAID upstream (billed per token,
// utils/upstream.js), so the same reasoning applies with the same force.
//
// It reuses billedImageKey rather than restating it. Two derivations of "which
// account is this" in one file is exactly the bug that function's own comment
// warns about — one of them reads the Authorization header a hair differently
// from middleware/auth.js, and a caller who can pick which bucket they land in
// by adding a space to their own header is not metered by account at all. One
// function, one answer, one place to get it wrong.
const billedAccountKey = billedImageKey;

// WHAT THIS DOES AND DOES NOT BOUND. It bounds REQUESTS, not tokens, and Gemini
// is not billed per request. It runs ahead of `authenticate`, so its job is to
// stop a flood before it reaches the router at all; the ceiling that actually
// bounds the invoice is the token ledger in services/birdieUsage.js, which
// routes/ai.js charges for every single chat.sendMessage. Neither replaces the
// other: this one is cheap and early, that one is denominated in money.
const aiLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: billedAccountKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please slow down' },
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

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
// body-parser marks every error it raises with a `type` and the correct HTTP
// status. This handler ignored both and answered 500 "Internal server error" to
// all of them, so a photo that overran the body limit told the user the SERVER
// had broken — a 413 reported as a 500, with wording that offers no way to
// recover. That now reaches a person: the client toasts these strings rather
// than console.warn-ing them. The status has to be honest and the sentence has
// to say what to do about it. Everything else stays deliberately opaque.
const BODY_PARSER_CLIENT_ERRORS = new Set([
  'entity.parse.failed',
  'entity.verify.failed',
  'request.aborted',
  'request.size.invalid',
  'stream.encoding.set',
  'stream.not.readable',
  'parameters.too.many',
  'charset.unsupported',
  'encoding.unsupported',
]);

app.use((err, req, res, next) => {
  // Something already started writing this response — a second write is an
  // ERR_HTTP_HEADERS_SENT crash on a request that may well have succeeded.
  // Hand it to Express's default handler, which closes the connection.
  if (res.headersSent) return next(err);

  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: "That's too large to send. If it has a photo, try a smaller one.",
    });
  }
  if (err && BODY_PARSER_CLIENT_ERRORS.has(err.type)) {
    const status = Number(err.status || err.statusCode);
    return res.status(status >= 400 && status < 500 ? status : 400)
      .json({ error: 'That request could not be read.' });
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
const io = new Server(server, {
  // 8MB: Socket.IO's 1MB default silently killed any image send, because a
  // chat photo travels base64-encoded inside the message frame (round 3 P2).
  //
  // This is a FRAME ceiling, not the photo ceiling. The photo ceiling is
  // CHAT_IMAGE_MAX_BYTES in sockets/handlers.js, which is the same number the
  // REST body limit above is derived from; this stays comfortably above it so
  // an oversized send is refused by the handler, with a sentence explaining
  // why, rather than being dropped by the transport with no error at all.
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
