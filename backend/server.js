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
      // WITHOUT THIS LINE THE ANTI-FRAMING INTENT BELOW DID NOT SURVIVE.
      // `frameguard: { action: 'deny' }` emits `X-Frame-Options: DENY`, and
      // that is the header this app was relying on. But helmet's CSP merges the
      // directives given here over its own defaults (useDefaults is on unless
      // it is turned off), and one of those defaults is
      // `frame-ancestors 'self'` — which PERMITS same-origin framing.
      //
      // Where the two disagree, the CSP wins: every current browser ignores
      // X-Frame-Options entirely when frame-ancestors is present. So the
      // emitted pair said "deny" in the legacy header and "allow same-origin"
      // in the one that is actually consulted, and the second is the answer.
      // Measured, not assumed — the test dumps the real response headers.
      //
      // `frameSrc` above is the other direction (what WE may embed) and does
      // not substitute for this one (who may embed US). They are different
      // questions and both are 'none'.
      frameAncestors: ["'none'"],
    },
  },
  frameguard: { action: 'deny' },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ---------------------------------------------------------------------------
// Force HTTPS
// ---------------------------------------------------------------------------
// HSTS above is NOT this. HSTS is an instruction to a browser that has already
// completed one successful HTTPS request to this host, and it is only ever
// honoured over TLS — a browser is required to ignore the header when it
// arrives over plaintext. So it does nothing at all for: the FIRST request from
// a client that has never reached us securely, the Capacitor shell and every
// other non-browser caller (none of which implement HSTS), and any request that
// arrives at Railway's edge over http://. Until this block existed, all three
// were served normally, with the bearer token in the Authorization header
// readable by anything on the path. "The host does TLS" is a statement about
// what the host OFFERS, not about what it REFUSES, and nothing here refused.
//
// HOW THE PROTOCOL IS READ, AND WHY NOT `req.protocol`. Express's req.protocol
// takes the FIRST comma-separated entry of X-Forwarded-Proto. A client may send
// its own X-Forwarded-Proto, and a proxy that APPENDS rather than replaces then
// leaves the client's value in front — so `X-Forwarded-Proto: https, http`
// reads as "https" through req.protocol while the real last hop was plaintext.
// The last entry is the one OUR proxy appended and is the only one a client
// cannot write, which is exactly the reasoning socketClientIp further down
// already applies to X-Forwarded-For. Same header family, same rule, so they
// are read the same way.
//
// A MISSING HEADER MEANS "NOT THROUGH THE PROXY", AND IS ALLOWED. Railway's own
// container healthcheck reaches this process directly over plaintext HTTP with
// no forwarding headers at all; so does anything else inside the private
// network, and so does `node server.js` on a laptop. Refusing a request with no
// X-Forwarded-Proto would fail the healthcheck and roll back every deploy. The
// rule is therefore narrow and states exactly what it knows: refuse only when a
// proxy has positively told us this request arrived over plaintext.
//
// Production only. In development there is no TLS terminator in front of this
// process, so enforcing here would refuse every local request.
//
// GET and HEAD are redirected rather than refused because they are safe and
// replayable, and 308 preserves the method. Everything else is refused outright:
// a 3xx on a POST asks the client to send the body a SECOND time, and the copy
// that already crossed the network in plaintext — credentials included — is not
// recoverable by redirecting. Refusing says so instead of pretending otherwise.
const HTTPS_EXEMPT_PATHS = new Set(['/api/health']);

function forwardedProtocol(req) {
  const header = req.headers['x-forwarded-proto'];
  if (!header) return null;
  const hops = String(header).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : null;
}

const isProduction = process.env.NODE_ENV === 'production';

app.use((req, res, next) => {
  if (!isProduction) return next();
  if (HTTPS_EXEMPT_PATHS.has(req.path)) return next();

  const proto = forwardedProtocol(req);
  // null = no proxy in front of this request (healthcheck, private network).
  // Anything already https, or some other scheme we did not put there, is not
  // ours to refuse.
  if (proto === null || proto !== 'http') return next();

  if (req.method === 'GET' || req.method === 'HEAD') {
    // req.headers.host is client-controlled, so it is not interpolated into the
    // Location blindly: only a host that is already on the CORS allowlist is
    // echoed back. Anything else is refused rather than turned into an
    // open redirect that this server signs its name to.
    const host = String(req.headers.host || '');
    if (allowedOrigins.includes(`https://${host}`)) {
      return res.redirect(308, `https://${host}${req.originalUrl}`);
    }
  }

  return res.status(403).json({
    error: 'This API is only available over HTTPS.',
  });
});

// ---------------------------------------------------------------------------
// Response trimming — the secret half
// ---------------------------------------------------------------------------
// "Return only what the screen needs" has two halves. The payload half (a list
// endpoint shipping forty columns for a card that renders three) is a per-route
// job and belongs in the routers. This is the other half, and it is the half
// that leaks credentials rather than bytes.
//
// THE SHAPE OF THE NEAR-MISS. `SELECT * FROM users` appears five times —
// routes/auth.js findUserByEmail, and the three OAuth lookups, and
// routes/users.js's password check — because each of those genuinely needs the
// bcrypt hash. The row those queries produce carries `password` and
// `apple_refresh_token`: one is a password-equivalent, the other is a LIVE
// Apple credential that can be exchanged for tokens on the user's account.
// Three handlers hand-strip them on the way out, all three spelling it the same
// way:
//
//     const { password: _, apple_refresh_token: _art, token_version: _tv, ...safeUser } = user;
//
// Three copies of a deny-list is a deny-list waiting to be written a fourth
// time and forgotten. Nothing today gets it wrong; the point is that a new
// handler that does `res.json({ user })` off any of those five queries is one
// line of ordinary-looking code, and it ships a bcrypt hash and an Apple
// refresh token to the client with nothing in the diff to catch the eye.
//
// This is a BACKSTOP, not the control. The routers should still select the
// columns they need. What this guarantees is that the failure mode of forgetting
// is a missing field, not a disclosed credential.
//
// TWO THINGS IT DOES NOT COVER, so nobody reads more into it than it does:
//   * SOCKET PAYLOADS. io.emit() does not go through res.json, so nothing here
//     sees it. That is survivable only because authenticateSocket and every
//     emit in sockets/handlers.js name their columns explicitly — checked, not
//     assumed — and none of them selects a users row with `*`. A future socket
//     handler that does is outside this guard entirely.
//   * THE PAYLOAD HALF of the checklist item. Returning forty columns for a
//     card that renders three is a per-route job, and the routers still have
//     `SELECT *` in a dozen places. Those are a payload and bandwidth problem
//     rather than a disclosure one (the tables involved hold no credentials),
//     and they belong to whoever owns those files.
//
// Mutating the object in place rather than cloning is deliberate: cloning every
// response would make the guard the expensive part of a large message history.
// It is safe because no handler in the app reuses a payload object after
// res.json() — swept for, not assumed.
//
// WHAT IS ON THE LIST AND WHY IT IS SHORT. Every name here is a column of a
// table that stores a credential, and none of them is returned deliberately by
// any route today (checked, route by route, before this was written). Names
// that merely look sensitive are NOT on the list: a guard that removes fields
// the product legitimately serves gets deleted the first time it breaks a
// screen, and then it is protecting nothing.
const SECRET_RESPONSE_FIELDS = new Set([
  'password',            // users.password — bcrypt hash
  'password_hash',
  'apple_refresh_token', // users.apple_refresh_token — a live Apple credential
  'verifier_hash',       // email_verifications / password_resets
  'api_key',             // sensor_devices.api_key
]);

// Depth and node budgets, so this can never become the expensive part of a
// response. Message history is the widest thing this app returns and it is a
// flat array of flat rows; 4 levels covers { flocks: [ { member_previews: [ {} ] } ] },
// the deepest shape in the codebase. A response that exceeds either budget is
// left ALONE rather than half-walked: a partial sweep would be a guard that
// reports success while having skipped the tail.
const RESPONSE_SCAN_MAX_DEPTH = 6;
const RESPONSE_SCAN_MAX_NODES = 20000;

// Strings and numbers are never walked, only containers, so a 700KB base64
// data: URL costs one property read. Returns true if the budget held.
function stripSecretFields(node, depth, budget) {
  if (depth > RESPONSE_SCAN_MAX_DEPTH) return false;
  if (node === null || typeof node !== 'object') return true;
  if (budget.n++ > RESPONSE_SCAN_MAX_NODES) return false;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (!stripSecretFields(item, depth + 1, budget)) return false;
    }
    return true;
  }

  for (const key of Object.keys(node)) {
    if (SECRET_RESPONSE_FIELDS.has(key)) {
      delete node[key];
      console.warn(`[security] stripped '${key}' from a response body — the handler should not have selected it`);
      continue;
    }
    if (!stripSecretFields(node[key], depth + 1, budget)) return false;
  }
  return true;
}

app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    // A pg row is a plain object, so mutating in place is safe here — it has
    // already served its purpose by the time it reaches res.json. Wrapped in a
    // try so a guard can never be the reason a response fails to send.
    try {
      stripSecretFields(body, 0, { n: 0 });
    } catch (err) {
      console.error('[security] response scan failed:', err.message);
    }
    return json(body);
  };
  next();
});

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
// so those get their own parser and everything else keeps the smaller ceiling.
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

// ── THE DEFAULT WAS 1mb, AND NOTHING JUSTIFIED IT ──────────────────────────
//
// 1mb was body-parser's own default, carried forward. The paragraph above says
// why that matters: the parser is the FIRST middleware after cors and helmet,
// so every ceiling it hands out is available with no credential at all.
// `POST /api/auth/login` offered a 1 MB buffer to a caller who has not proved
// anything, and so did /api/waitlist, /api/public and every other unauthed
// surface. The fix is not a smaller number picked by feel — it is knowing what
// the largest HONEST body on each route actually is, and that is the audit
// below. It is written down because the next person to move this number needs
// the reasoning, not the value.
//
// HOW A CHARACTER COUNT BECOMES A BYTE COUNT. Every bound below is a character
// (code point) count from a validator. A JSON string of N code points costs at
// most 4N bytes on the wire from any ordinary serializer — JSON.stringify,
// encoding/json, Jackson — because those escape only control characters, `"`
// and `\`, and the widest UTF-8 code point is 4 bytes. A serializer that also
// \u-escapes non-ASCII (Python's json.dumps with its default ensure_ascii)
// costs up to 3x that. No client of this API does; the browser bundle and the
// Capacitor shell both go through JSON.stringify. Where that distinction would
// change an answer it is called out by name.
const JSON_STRING_BYTES_PER_CHAR = 4;

// ── EVERY ROUTE THAT TAKES A JSON BODY, AND ITS LARGEST HONEST ONE ─────────
//
// Read off the validators and handlers, not the route names. Grouped by what
// actually bounds the body.
//
// SERVED BY THE 64KB DEFAULT (largest first):
//   * PUT /api/venue-profile — the biggest body under the default, and the
//     tightest fit. businessName 255 + category 100 + location 255 +
//     description 2000 + goals 20x80 + operatingHours 21 rows x 3 fields x 60 +
//     phone 50 + photoUrl 500 + placeId 255 = ~8.8K chars -> 35KB at 4 bytes
//     each. 1.8x of headroom, and the fields are business copy, so in practice
//     it is a few KB. (routes/venueProfile.js MAX_* constants.)
//   * POST /api/crowd/batch — THE NAMED SUSPECT, and it is not the largest.
//     `venues` is isArray({ min: 1, max: 20 }); the handler then TRUNCATES each
//     item itself — place_id .slice(0,256), name .slice(0,256), types
//     .slice(0,10) — so anything past that is thrown away rather than used.
//     20 x (256 place_id + 256 name + 10 type strings + location + 6 numbers)
//     is ~22K chars. Only `name` is UGC; place ids and Google type strings are
//     ASCII by definition, so the real ceiling is 20 x (256 + 4x256 + ~400 +
//     ~200) = ~37KB, and the test that costs this builds exactly that body and
//     sends it. The only client that calls the route (getCrowdBatch in
//     frontend/src/services/api.js, fed by `venues.slice(0, 20)` in App.js)
//     forwards our own venue-search rows and sends ~10KB. Comfortably inside.
//   * PATCH /api/users/settings — the settings batch. The handler refuses when
//     JSON.stringify(body).length > 8192 (routes/users.js), i.e. at most 24KB
//     of UTF-8. NOTE the one way this could be squeezed: 8192 UTF-16 units of
//     \u-escaped input is ~49KB on the wire, still under the default, but that
//     is the one route where an escaping serializer gets within reach. Anyone
//     raising that 8192 has to come back here.
//   * POST /api/friends/find-by-phone — the contacts batch. 200 numbers
//     (MAX_SYNC_PHONES) -> ~5KB. POST /api/flocks and POST /api/flocks/:id/
//     invite carry 25 user ids, /attendance 50 rows, POST /api/billing/:id/
//     create up to 100 { userId, amount } shares: every id/amount batch in the
//     app is arrays of numbers, all under 4KB.
//   * Largest free text outside chat is 1000 characters, three times over:
//     POST /api/reports `details`, POST /api/venue-dashboard/reviews/:id/reply,
//     POST /api/venue-dashboard/submit-review. Under 4KB each.
//   * POST /api/notifications/register — token 1024 chars.
//   * POST /api/auth/* — signup/login/verify-email/forgot-password/reset-
//     password/logout*/google/apple. The largest field anywhere in them is a
//     Google or Apple identity token, a JWT of a couple of KB; everything else
//     is <=255 chars. Two fields here have NO bound of their own and the
//     default IS their bound, which is an argument for a low one, not against:
//     `interests` is isArray() with no max (routes/auth.js signupValidation and
//     routes/users.js PUT /profile) and `password` has only isLength({ min: 8 }).
//   * Everything else — availability, calendar, budget, checkin, feedback,
//     guest RSVP/vote, moderation blocks, safety contacts/alert/share-location,
//     sensors, users venmo/payment-methods/profile-image, venues vote,
//     venue-dashboard promotions/events, waitlist, admin — is under 2KB.
//
// SCOPED LARGER, each for a reason it can state:
//   * the three IMAGE_BODY_ROUTES below, unchanged and still derived from
//     CHAT_IMAGE_MAX_BYTES;
//   * POST /api/ai/chat, derived from Birdie's own message caps;
//   * POST /api/revenuecat/webhook, because the sender is not us.
const DEFAULT_JSON_BODY_BYTES = 64 * 1024;
const defaultJsonParser = express.json({ limit: DEFAULT_JSON_BODY_BYTES });

// Birdie. This is the one non-image route in the app that legitimately needs
// more than the default, and it needs a lot more: routes/ai.js accepts
// `messages` as isArray({ min: 1, max: 24 }) with `messages.*.text` at
// isLength({ max: 4000 }), so one honest turn can carry 96,000 characters of
// conversation history — up to 384KB once they are emoji. The old 1mb ceiling
// hid that; a flat 64KB would have broken a long chat with a 413, and refusing
// a real request to save memory is a worse outcome than the buffer.
//
// The two numbers are restated here because routes/ai.js exports neither, and
// this file must not import a router to size a parser that runs before it.
// What keeps them honest is a test, not this comment: bodyLimitAudit.test.js
// reads both literals back out of routes/ai.js and fails if either moves
// without this parser moving with it.
//
// express-validator's isLength counts CODE POINTS (it discounts surrogate
// pairs), so 4000 "characters" of astral text is 4000 code points at 4 bytes
// each, not 4000 UTF-16 units. That is why the multiplier is 4 and not 2.
const AI_CHAT_MAX_MESSAGES = 24;
const AI_CHAT_MAX_MESSAGE_CHARS = 4000;
const AI_CHAT_JSON_BODY_BYTES =
  AI_CHAT_MAX_MESSAGES * AI_CHAT_MAX_MESSAGE_CHARS * JSON_STRING_BYTES_PER_CHAR + JSON_BODY_ENVELOPE_BYTES;
const aiChatJsonParser = express.json({ limit: AI_CHAT_JSON_BODY_BYTES });

// The RevenueCat webhook. Scoped rather than defaulted because THE SENDER IS
// NOT US: a webhook we refuse is an entitlement event nobody sees, so a paying
// subscriber silently does not get Pro. Every documented RevenueCat event is a
// few KB (the event object plus subscriber_attributes, whose values RevenueCat
// itself caps at 500 characters), so 256KB is roughly two orders of magnitude
// of margin on a payload shape we do not control and cannot re-derive from a
// validator. It is still 4x below the 1mb this route used to get. Nothing else
// in the app is a third-party POST; if a second one ever lands, it belongs on
// this parser and in this comment.
//
// (routes/revenuecat.js also mounts its own bare `express.json()` on the
// handler. That is a no-op: body-parser sets req._body and skips a body that
// has already been read, and this middleware runs first. It is not a second
// ceiling and must not be mistaken for one.)
const WEBHOOK_JSON_BODY_BYTES = 256 * 1024;
const webhookJsonParser = express.json({ limit: WEBHOOK_JSON_BODY_BYTES });

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

// The two scoped non-image routes. Same three properties as the list above,
// for the same reasons, and they are not decorative on either one:
//   * anchored, so a longer path that merely starts with these does not
//     inherit the bigger buffer;
//   * case-insensitive, because Express routes case-insensitively by default
//     and POST /API/AI/CHAT reaches the Birdie handler (measured);
//   * matched through imageRoutePath, because POST /api/ai//chat and
//     POST /api/revenuecat//webhook ALSO reach their handlers (measured — one
//     extra slash immediately after a mount point survives Express 4's router,
//     though /api//ai/chat does not). Without the collapse, a client that
//     doubled a slash would be served the 64KB default and its perfectly legal
//     long conversation would come back 413. Over-matching is the safe
//     direction here for the same reason it is above: a spelling that reaches
//     no handler gets a larger buffer and then a 404.
// The function's name is historical — it is the shared path normaliser now,
// not an image-only one — and it is left alone because
// __tests__/imageSpendLimits.test.js lifts it out of this file by that name.
const AI_CHAT_BODY_ROUTE = /^\/api\/ai\/chat\/?$/i;
const WEBHOOK_BODY_ROUTE = /^\/api\/revenuecat\/webhook\/?$/i;

// One table, one dispatch. A fourth scoped parser is a row here, not a second
// `if` — two places deciding which ceiling a request gets is how the ceiling
// and the meter drifted apart the last three times something in this block
// broke. First match wins; the patterns are disjoint by construction (a test
// pins that they are).
const SCOPED_JSON_PARSERS = [
  ...IMAGE_BODY_ROUTES.map((re) => [re, imageJsonParser]),
  [AI_CHAT_BODY_ROUTE, aiChatJsonParser],
  [WEBHOOK_BODY_ROUTE, webhookJsonParser],
];

// GET/PUT/PATCH/DELETE take the default unconditionally: every route with a
// scoped ceiling is a POST, and the largest body on any non-POST verb in the
// app is PUT /api/venue-profile at ~35KB (see the audit above).
app.use((req, res, next) => {
  if (req.method !== 'POST') return defaultJsonParser(req, res, next);
  const routePath = imageRoutePath(req);
  const scoped = SCOPED_JSON_PARSERS.find(([re]) => re.test(routePath));
  return (scoped ? scoped[1] : defaultJsonParser)(req, res, next);
});
// Form-encoded bodies get the same ceiling as JSON ones, and for the same
// reason: this parser is also ahead of every limiter, and its own default is
// 100KB. Nothing in this app posts a form — the frontend sends JSON everywhere
// and the one multipart upload (POST /api/users/upload-image) is buffered by
// multer inside routes/users.js, which neither of these parsers touches — so
// this ceiling exists to be an unauthenticated buffer and nothing else. Size it
// like one.
app.use(express.urlencoded({ extended: true, limit: DEFAULT_JSON_BODY_BYTES }));

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

// The HTTPS gate again, for the transport Express never sees.
//
// The middleware near the top of this file runs on the Express app. Socket.IO
// attaches to the raw http.Server and its engine intercepts /socket.io/
// requests BEFORE Express is reached, so the handshake — which carries the JWT
// in its auth payload, exactly like an Authorization header — was not covered
// by it. Enforcing on one transport and not the other is not enforcing.
//
// Identical rule to the REST gate, deliberately reusing forwardedProtocol
// rather than re-deriving it: production only, the LAST forwarded hop decides,
// and a handshake with no forwarding header at all is allowed through because
// that is what an internal or local connection looks like.
io.use((socket, next) => {
  if (!isProduction) return next();
  const proto = forwardedProtocol({ headers: socket.handshake.headers || {} });
  if (proto !== null && proto === 'http') {
    return next(new Error('This API is only available over HTTPS.'));
  }
  next();
});

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
  //
  // RECORD ACCESS. This is the only path in the app that grants `role='admin'`,
  // and admin is the role that can read reported images — "sometimes from a
  // minor's camera roll", in routes/admin.js's own words — hide content and ban
  // accounts. It used to run under a bare `.catch(() => {})`, which meant the
  // grant was invisible on both outcomes at once: a success wrote nothing
  // anywhere, and a FAILURE was swallowed silently, so a boot where the promotion
  // did not happen looked exactly like a boot where it did. The first time that
  // matters is an incident review asking who held admin on a given day, and the
  // answer was "no idea".
  //
  // This does not write to moderation_actions, and deliberately so: that table's
  // `action` column is CHECK-constrained to a fixed set (migration 017) which
  // has no value for a role grant, and adding one is a migration. This is the
  // half that needs no schema change — say what was granted, to whom, and say
  // it loudly when it fails. The durable audit row is a handoff, recorded in the
  // report this change came with.
  if (process.env.ADMIN_USER_IDS) {
    const ids = process.env.ADMIN_USER_IDS.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
    if (ids.length > 0) {
      try {
        const granted = await pool.query(
          `UPDATE users SET role = 'admin' WHERE id = ANY($1) AND role != 'admin' RETURNING id`,
          [ids]
        );
        // Both facts are worth a line. The ids that CHANGED say who was promoted
        // on this boot; the configured set says who is expected to hold admin at
        // all, which is the question an audit actually asks.
        console.log(`[admin-provisioning] configured admin ids: ${ids.join(', ')}`);
        if (granted.rows.length > 0) {
          console.warn(`[admin-provisioning] GRANTED admin to user ids: ${granted.rows.map(r => r.id).join(', ')}`);
        }
      } catch (err) {
        // Not fatal — the app serves fine without a moderation console — but it
        // must never again be silent. Guideline 1.2 wants a reachable moderator,
        // and this failing quietly is how there stops being one.
        console.error('[admin-provisioning] FAILED to apply ADMIN_USER_IDS:', err.message);
      }
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
