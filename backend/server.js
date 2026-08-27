require('./instrument'); // Sentry — must load before everything else (B3)
require('dotenv').config();
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '[configured]' : '[missing]');

// ---------------------------------------------------------------------------
// Production-database quarantine — added after the 2026-08-13 outage
// ---------------------------------------------------------------------------
// backend/.env points DATABASE_URL at the PRODUCTION Railway proxy, so a plain
// local `node server.js` (or `npm run dev`) booted straight into running
// migrations against the live database. During the outage that nearly
// compounded the incident twice. The rule: a non-production NODE_ENV combined
// with a Railway database host is an accident until the operator says
// otherwise, out loud, with I_UNDERSTAND_THIS_IS_PRODUCTION=1.
//
// What this deliberately does NOT touch:
//   * Railway deploys — they run with NODE_ENV=production and never enter this.
//   * scripts/dump-db.js — the backup runbook's dump path does not boot this
//     file at all, so taking a production backup needs no flag.
//   * scripts/verify-backup.js — never reads DATABASE_URL by design.
//   * scripts/e2e-local.js — sets NODE_ENV=development with a localhost
//     embedded Postgres before requiring this file, so no Railway host matches.
//   * The quarterly restore drill's "point a local backend at the scratch
//     Railway database" step — that is the deliberate case the override exists
//     for (BACKUP-AND-VERIFICATION.md names the flag in that step).
//
// This must stay ABOVE every require that can reach config/database.js: the
// pool opens a real connection at require time when server.js is the entry
// point, so a guard any lower has already lost.
const RAILWAY_DB_HOST_RE = /\.(rlwy\.net|railway\.app|railway\.internal)$/i;

function railwayDatabaseHost() {
  if (process.env.PGHOST && RAILWAY_DB_HOST_RE.test(process.env.PGHOST.trim())) {
    return process.env.PGHOST.trim();
  }
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host && RAILWAY_DB_HOST_RE.test(host) ? host : null;
  } catch (_) {
    // Unparseable URL (a password with reserved characters, say): fall back to
    // matching the raw string. Over-refusing costs one re-run with the
    // override; under-refusing is the outage.
    return /\.(rlwy\.net|railway\.app|railway\.internal)/i.test(url) ? '(unparseable URL with a Railway host)' : null;
  }
}

if (process.env.NODE_ENV !== 'production'
    && process.env.I_UNDERSTAND_THIS_IS_PRODUCTION !== '1') {
  const railwayHost = railwayDatabaseHost();
  if (railwayHost) {
    console.error(
      `REFUSING TO START: NODE_ENV is "${process.env.NODE_ENV || '(unset)'}" but the database host is "${railwayHost}" — a Railway host, almost certainly the production database.\n` +
      'Booting server.js runs migrations against whatever DATABASE_URL points at.\n\n' +
      'To develop locally: edit backend/.env so DATABASE_URL (and PGHOST) point at a local Postgres.\n' +
      'To run against Railway on purpose (restore drill, staging boot): re-run with I_UNDERSTAND_THIS_IS_PRODUCTION=1.\n' +
      'Taking a backup does not need the flag: `node scripts/dump-db.js` never boots the server.'
    );
    process.exit(1);
  }
}

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
const util = require('node:util');
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
// The pool. This require was deleted in a refactor while four call sites kept
// using `pool` (the health probe, admin promotion, seed gate, and the
// migration runner in boot), and no test caught it because tests lift blocks
// out of this file and supply their own pool. Production crash-looped on a
// ReferenceError the moment boot() ran. If you remove this line, nothing in
// the suite goes red; the deploy does.
const pool = require('./config/database');
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
const advisorRoutes = require('./routes/advisor');
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
// THE POLICY, in two lines (pinned by __tests__/observability.test.js):
//   * unhandledRejection -> log a loud structured line and KEEP SERVING.
//   * uncaughtException  -> CRASH AND RESTART, stack on the way out.
//
// Rejections stay alive because Node's default is to print the reason and KILL
// THE PROCESS — on Railway that drops every open WebSocket and 502s every
// in-flight request until the container restarts. The codebase has many
// deliberate post-response fire-and-forgets (socket fan-outs, push sends, the
// migration unlock, the demo-story refresh); every one is `.catch()`-guarded
// today, so this handler is insurance against the NEXT one that is not. A
// rejected promise leaves the process in a known state, so serving on is safe.
//
// Uncaughts crash on purpose, and there is deliberately NO
// process.on for the uncaughtException event here (reliability.test.js pins its
// absence): a thrown-past-the-top exception leaves UNKNOWN state, and a handler
// that swallows it serves corrupted state instead of restarting. Crash-and-
// restart already works with no code: Node's default prints the stack and exits
// 1, Railway restarts the container, and once SENTRY_DSN is set @sentry/node's
// own onUncaughtException integration captures + flushes + exits with the same
// semantics. The MONITOR below observes without changing any of that — it
// exists so the last thing a dying container logs is a grep-able tag naming
// what killed it, not a bare stack scrolled past in the deploy noise.
//
// Sentry note: instrument.js only calls Sentry.init() when SENTRY_DSN is set.
// Unset (production today), captureException is a no-op and these console
// lines are the whole story — which is why they carry the stack, not just the
// message.
process.on('unhandledRejection', (reason) => {
  // The stack on the reason is the only pointer to the source there is — Node
  // does not know which `await` was missing. A non-Error reason (a thrown
  // string, a bare object) has no stack, so it is inspected in full rather
  // than String()-flattened into '[object Object]'.
  const detail = reason instanceof Error
    ? (reason.stack || `${reason.name}: ${reason.message}`)
    : `non-Error rejection: ${util.inspect(reason, { depth: 4, breakLength: 120 })}`;
  console.error(`[unhandledRejection] kept alive — a floating promise is missing its .catch()\n${detail}`);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

// A monitor NEVER prevents the exit — it runs just before Node's default (or
// Sentry's) fatal handling, whatever that turns out to be.
process.on('uncaughtExceptionMonitor', (err, origin) => {
  console.error(
    `[uncaughtException] ${origin} — process will exit; Railway restarts it on a clean state\n` +
    `${(err && err.stack) || util.inspect(err)}`
  );
});

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// THE APP-WIDE BACKSTOP — the ceiling that was missing
// ---------------------------------------------------------------------------
// Every limiter in this file guards a mount. Nothing guarded the process. Four
// surfaces had no ceiling of any kind:
//
//   /api/revenuecat    signed webhook, mounted with no limiter
//   /api/email-events  signed webhook, mounted with no limiter
//   GET /api/health    mounted before any limiter exists
//   every unmatched path, which falls through to the 404 handler below
//
// The last one is the real hole and it is not a mount, which is why reading the
// mount list never found it. `GET /x` matches no router, so it passes CORS,
// helmet, the HTTPS gate and the body parsers and is answered 404 — with no
// counter anywhere having moved. A caller could spend every per-route ceiling
// in full and then keep going indefinitely against a URL that does not exist.
//
// This also answers a question the per-route limiters cannot: a caller who
// spreads traffic across the routers does more total work than any single
// limiter permits, because they are separate buckets. apiLimiter is better than
// it looks here (ONE instance across ~25 mounts, so those genuinely share one
// bucket) but /api/auth, /api/venues, /api/ai, /api/venue-profile,
// /api/venue-dashboard, /api/venue/advisor and the two unsubscribe paths each
// hold their own.
//
// THE NUMBER IS DERIVED, NOT CHOSEN. It is the sum of every other limiter's
// 15-minute-equivalent allowance across the mutually exclusive router mounts:
//
//   apiLimiter              3000 / 15 min  = 3000
//   authLimiter               10 / min     =  150
//   venueSearchLimiter       120 / min     = 1800
//   imageSpendLimiter         10 / min     =  150
//   aiLimiter                 30 / min     =  450
//   advisorLimiter            20 / min     =  300
//   advisorQuestionLimiter    10 / hour    =    3
//   venueDashboardLimiter    120 / min     = 1800
//   venueProfileLimiter       30 / min     =  450
//   digestOptOutLimiter       20 / min     =  300
//                                           -----
//                                            8403
//
// 8500 is that, rounded up to the next hundred. The sum deliberately includes
// imageSpendLimiter and advisorQuestionLimiter even though both are EXTRA gates
// on requests already counted elsewhere and add nothing a caller can push
// through: a sharper model exists, but a backstop derived from a subtle model
// is a backstop that goes wrong the first time somebody reorders a mount, and
// the only property this number needs is that it is a strict upper bound.
//
// Being derived is the whole point. A backstop chosen by instinct is just a new
// limit nobody sized, and it would start refusing callers the per-route
// limiters were built to allow — invisibly, because the 429 would come from a
// limiter nobody was looking at. __tests__/rateLimiterInventory.test.js
// recomputes the sum from utils/cacheKeyInventory.js and fails if a new limiter
// ever pushes it past this constant, so the derivation stays true rather than
// becoming a story about how the number was picked once.
//
// WHAT IT KEYS ON. billedImageKey, the same function the image and Birdie
// meters use: the account when a bearer token verifies, the address otherwise.
// That matters in both directions.
//   * A NAT full of signed-in users gets a bucket each rather than one to fight
//     over, which is the failure an address key hands a school or a bar.
//   * An unauthenticated caller lands in `addr:` and is bounded by apiLimiter's
//     3000/15min long before this, so this can never be the limiter that
//     refuses them on a routed path. On the FOUR unrouted or unlimited
//     surfaces above, it is the only one there is.
//
// WHERE IT SITS, WHICH IS THE ONE THING NO OTHER LIMITER HERE CAN CLAIM. It is
// the FIRST middleware on the app, ahead of the body parsers and ahead of cors.
// The imageSpendLimiter block below explains at length that it cannot save the
// buffer, because express.json has already read the body by the time any
// per-route limiter runs. This one runs first, so a refusal genuinely stops the
// read. It reads only the Authorization header and req.ip, so it needs no
// parsed body to do it.
//
// AHEAD OF cors(), AND THAT IS NOT COSMETIC. When this landed it was mounted
// below cors, and cors is not a header-setter that falls through: it ANSWERS
// two whole classes of request and neither reached the backstop.
//   * A preflight. preflightContinue defaults to false, so cors writes 204 and
//     ends the request at its own line.
//   * ANY request carrying an Origin the allowlist does not hold. The origin
//     callback below hands `new Error('Not allowed by CORS')` to next(), which
//     jumps straight to the error handlers at the bottom of the file, past
//     every mount, past this limiter, past everything.
// The second one is the one that mattered, and it is worse than the unrouted
// 404 this limiter was written to close: that error carried no `status`, so
// Sentry.setupExpressErrorHandler captured it and the handler at the bottom of
// the file logged the whole stack. One header on any URL, from any address,
// with no account, bought an unbounded stream of Sentry events and console
// stacks. The mount order is HALF of that fix: nothing Express sees now decides
// anything before this, so the volume is bounded.
//
// THE OTHER HALF IS AT THE THROW SITE, and bounding was the wrong end to fix on
// its own. 8,500 captured exceptions per key per fifteen minutes is still an
// alert storm out of one request header, and none of them was ever a fault. The
// cors callback below now marks its refusal 403, which is what takes it out of
// Sentry's capture rule and out of the stack-logging branch entirely. Both
// halves are needed and neither is the other: the status stops the refusal
// being reported as a crash, the mount order stops any OTHER thing cors decides
// from skipping the ceiling.
//
// The one deliberate exemption is `skip` below: a preflight from an origin that
// IS on the allowlist. That is the only class of traffic here that a real
// client generates in volume and cannot avoid: the Capacitor shell sends
// `capacitor://localhost` on every cross-origin call, browsers cache a
// preflight for about five seconds, and a preflight carries no Authorization
// header, so every one of them keys to `addr:`. Counting them would put a whole
// bar or a whole school into one 8,500 bucket for requests cors answers in
// constant time without reading a body, which is the NAT failure the account
// key exists to avoid, reintroduced by the back door. A preflight cors is going
// to REFUSE is not exempt, because that is the expensive path above.
//
// AND THE EXEMPTION IS FORGEABLE, WHICH IS ACCEPTED RATHER THAN OVERLOOKED.
// Every input the skip reads is a request header. `OPTIONS`, `Origin:
// http://localhost` and any `Access-Control-Request-Method` is three lines of
// curl, and it buys an uncounted lane through the only app-wide ceiling there
// is. Measured 2026-08-26 against the real server: twenty-five such requests
// moved the backstop's counter by zero. That is allowed to stand because of
// what the lane actually costs, which is the floor of what any HTTP server
// does: cors writes 204 and ends the request before helmet, before the body
// parsers, before routing, with no body read, no query, no upstream call and no
// database. A caller who wanted to spend our money would take any other path in
// preference. If a preflight ever stops being that cheap, or if cors is ever
// configured with preflightContinue, this exemption has to go with it.
//
// It does NOT sit ahead of Socket.IO: the engine intercepts /socket.io/ on the
// raw http.Server before Express is reached. That transport has its own
// ceiling (socketConnections, SOCKET_HANDSHAKES_PER_MINUTE/IP, further down).
//
// Same MemoryStore caveat as every other limiter in this file: it resets on
// deploy and divides by the instance count.
const GLOBAL_BACKSTOP_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_BACKSTOP_MAX = 8500;

// isDev is declared HERE rather than in the rate-limiting section below, which
// is where it used to live, because this limiter has to be defined before the
// body parsers and before cors, and that section comes after both. One
// definition, one strict
// comparison against one string literal — __tests__/publicDemoAbuse.test.js
// fails on a second assignment or on a looser test such as `!isProduction`,
// which would be TRUE on an unset NODE_ENV and would arm the bypass in
// production.
const isDev = process.env.NODE_ENV === 'development';

const globalBackstopLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: GLOBAL_BACKSTOP_WINDOW_MS,
  max: GLOBAL_BACKSTOP_MAX,
  // billedImageKey is a hoisted function declaration further down this file;
  // the wrapper is what makes the forward reference legal, and the key is only
  // ever computed at request time. Reusing it rather than restating it is the
  // rule that function's own comment sets out: two derivations of "which
  // account is this" in one file is how a caller comes to choose their bucket.
  keyGenerator: (req) => billedImageKey(req),
  // The allowed-origin preflight, and nothing else. See the block above for why
  // this one class is exempt and why a preflight cors is about to refuse is
  // not. Access-Control-Request-Method is what makes an OPTIONS a preflight
  // rather than a bare OPTIONS, which is not exempt either.
  skip: (req) => req.method === 'OPTIONS'
    && typeof req.headers['access-control-request-method'] === 'string'
    && isAllowedOrigin(req.headers.origin),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  // This limiter answers BEFORE the cors middleware below, which is the whole
  // point of its position: it has to be able to refuse a request without the
  // body ever being read. The cost is that its 429 would otherwise carry no
  // Access-Control-Allow-Origin, so a browser refuses to let the page read it
  // and the fetch rejects as a network error instead. The guest invite page
  // then shows its generic failure, whose copy says the link is probably fine
  // and to try again, which is the one piece of advice that makes a rate limit
  // worse. The per-route apiLimiter is mounted after cors and never had this
  // problem, which is why only this one lane was mis-told.
  //
  // So the refusal echoes the origin itself, for allowed origins only, using
  // the same predicate the skip above uses rather than a second copy of the
  // allowlist. An origin cors would refuse still gets the 429 with no header,
  // which is correct: it was never entitled to read the response.
  handler: (req, res, _next, options) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.status(options.statusCode).json(options.message);
  },
});

app.use(globalBackstopLimiter);

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

// WHY THERE IS NO PREVIEW PATTERN HERE ANY MORE (SECURITY-AUDIT-auth.md R2-1).
//
// Two pattern-matching attempts have now been bypassed on this exact line:
//
//   1. /^https:\/\/flock-app(-[a-z0-9]+)*\.vercel\.app$/ admitted ANY
//      `flock-app-<anything>.vercel.app`, so `flock-app-evil.vercel.app` — a
//      Vercel project name anyone can register — was an allowed origin.
//   2. Its replacement pinned the production slug and demanded the preview URL
//      SHAPE: /^https:\/\/flock-app-w65m-(?:git-[a-z0-9-]+|[a-z0-9]+)-[a-z0-9-]+\.vercel\.app$/.
//      But that shape is `<pinned-slug>-<label>-<label>`, and a Vercel project
//      name is free text, so `flock-app-w65m-evil-x` is registrable and its
//      origin `https://flock-app-w65m-evil-x.vercel.app` matched.
//
// The root problem is not the regex, it is the namespace: `*.vercel.app` is a
// shared, self-service namespace, so ANY pattern over it is a pattern over
// hostnames an attacker can mint. Pinning the slug does not help — the repo is
// going public, and the slug is also simply the production origin, so it was
// never a secret. A third, tighter regex would be the same bet a third time.
//
// So the allowlist is now EXACT HOSTS only. Preview deploys are opt-in per
// deploy through EXTRA_CORS_ORIGIN (comma-separated absolute origins), which is
// UNSET in production: a preview that wants to talk to this backend adds its own
// origin to its own deploy's env, and nothing an attacker registers is admitted
// by default. Production is flockcorp.com and is listed above verbatim.
const EXTRA_CORS_ORIGINS = String(process.env.EXTRA_CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  // Absolute origins only. A bare hostname or a path fragment would never equal
  // a browser-sent Origin header anyway, and refusing it here keeps a typo in a
  // deploy variable from reading as "allowlist entry that silently does nothing".
  .filter((s) => /^[a-z][a-z0-9+.-]*:\/\/[^\s/]+$/i.test(s));

if (EXTRA_CORS_ORIGINS.length > 0) {
  console.warn(`[cors] EXTRA_CORS_ORIGIN is set — additionally allowing: ${EXTRA_CORS_ORIGINS.join(', ')}`);
}

for (const extra of EXTRA_CORS_ORIGINS) allowedOrigins.push(extra);

// THE one predicate. The REST cors() callback and the Socket.io handshake
// callback both call this, so the two cannot drift apart (that de-duplication
// came in with the previous fix and is kept deliberately).
const isAllowedOrigin = (origin) => allowedOrigins.includes(origin);

// A REFUSED ORIGIN IS A CLIENT MISTAKE AND HAS TO BE ANSWERED AS ONE.
//
// This used to be a bare `new Error('Not allowed by CORS')`. An Error with no
// `status` is, to every consumer downstream, a 500:
//
//   * Sentry.setupExpressErrorHandler's defaultShouldHandleError reads
//     `error.status || error.statusCode || error.status_code ||
//     error.output?.statusCode` and treats a missing one as 500, so it CAPTURED
//     every refusal as an unhandled server exception.
//   * The global error handler at the bottom of this file fell through to its
//     "genuine server fault" branch: `console.error` with the whole stack, and
//     a 500 body.
//
// The mount-order fix above put the backstop in front of this so the volume is
// bounded, and bounded was the wrong end to fix. 8,500 captured exceptions and
// 8,500 stack traces per key per fifteen minutes is still an unbounded-looking
// alert storm out of one request header, and the request that produced them was
// never a fault: an origin that is not on the allowlist is exactly the case this
// allowlist exists to answer. Naming the status is what stops it being reported
// as a crash, and it costs one line.
//
// 403 rather than 400 because the request is well formed and the answer is
// refusal. The BROWSER-visible behaviour does not change either way: a browser
// blocks the response on the missing Access-Control-Allow-Origin header and
// never shows the body or the code, so this status is read by our logs, our
// alerting, and non-browser callers, all three of which were being told the
// server had broken.
//
// The Socket.io handshake callback further down keeps its own bare Error on
// purpose: it never reaches this express error handler, the engine answers the
// handshake itself, and giving it a status would suggest it flows through here.
const CORS_REFUSED = 'cors.origin.refused';

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      const err = new Error('Not allowed by CORS');
      err.status = 403;
      err.type = CORS_REFUSED;
      callback(err);
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
      // budget.route names the request (set by the middleware below) so the
      // handler that over-selected can be found without reproducing the call.
      console.warn(`[security] stripped '${key}' from the response body of ${budget.route || 'a response'} — the handler should not have selected it`);
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
      stripSecretFields(body, 0, { n: 0, route: `${req.method} ${req.originalUrl}` });
    } catch (err) {
      console.error(`[security] response scan failed on ${req.method} ${req.originalUrl}:`, err.message);
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
// reason. express.json() is mounted ahead of every route and ahead of every
// PER-ROUTE limiter (apiLimiter/authLimiter are mounted per-router further
// down), so for those the body is fully buffered into memory before any
// limiter can refuse the request. The one exception is globalBackstopLimiter
// directly above, which is why it is up there: it reads only the
// Authorization header and req.ip, so it can run before the parsers and a
// refusal from it genuinely stops the read. Raising it globally would hand an UNAUTHENTICATED client a bigger
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
//   * POST /api/venue/advisor/ask — one `intentId` string matched against a
//     closed registry; any other key is a 400 before a value is read. Bytes on
//     the wire: well under 1KB.
//   * POST /api/venue/advisor/question — the one advisor body carrying the
//     owner's own words. One `question` key, rejected unless it is a string,
//     and rejected before sanitising if it is longer than 280 characters
//     (services/advisorFreeText.js FREE_TEXT_MAX_CHARS). The parser's ceiling
//     is therefore never the binding limit here; the router's own is.
//   * routes/venueDigest.js — no body it reads: the unsubscribe link is a GET
//     that renders and a POST that writes, and BOTH take the token from the
//     query string, capped at 2048 chars by the router's own validator. The
//     RFC 8058 one-click POST does carry a fixed `List-Unsubscribe=One-Click`
//     form body, which the urlencoded parser below buffers under the same
//     64KB ceiling and the router never looks at.
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

// The Resend delivery webhook. Also a third-party POST, so the ceiling is the
// webhook one, but it needs something the RevenueCat route does not: the RAW
// BYTES. Resend signs with Svix, and a Svix signature covers the exact payload
// as sent. Re-serialising the parsed object and hashing that is hashing
// something the sender never signed, so a whitespace difference in the payload
// would reject every real event while a forged one that happens to round-trip
// would be indistinguishable. `verify` is body-parser's own hook for this and
// runs before the parse, so the route gets both the object and the bytes.
//
// A bounce event is a few hundred bytes; the ceiling is inherited rather than
// tuned because the sender is not us and the payload shape is theirs.
const emailWebhookParser = express.json({
  limit: WEBHOOK_JSON_BODY_BYTES,
  verify: (req, _res, buf) => { req.rawBody = buf; },
});

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
const EMAIL_EVENTS_BODY_ROUTE = /^\/api\/email-events\/?$/i;

// One table, one dispatch. A fourth scoped parser is a row here, not a second
// `if` — two places deciding which ceiling a request gets is how the ceiling
// and the meter drifted apart the last three times something in this block
// broke. First match wins; the patterns are disjoint by construction (a test
// pins that they are).
const SCOPED_JSON_PARSERS = [
  ...IMAGE_BODY_ROUTES.map((re) => [re, imageJsonParser]),
  [AI_CHAT_BODY_ROUTE, aiChatJsonParser],
  [WEBHOOK_BODY_ROUTE, webhookJsonParser],
  [EMAIL_EVENTS_BODY_ROUTE, emailWebhookParser],
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

// ---------------------------------------------------------------------------
// Health check — defined BEFORE the authenticated /api/* routers so their auth
// middleware doesn't shadow it with a 401 (caught by the local E2E harness).
// ---------------------------------------------------------------------------
// HONEST, AND CHEAP, IN THAT ORDER. The old handler returned {status:'ok'}
// unconditionally, which made it a liveness ping wearing a health check's
// name: with Postgres unreachable or the pool wedged, Railway kept routing
// traffic to a process that could not serve a single route, and the operator —
// at school, phone in a bag — had a green healthcheck over a dead app for
// hours. Every route in this app needs the pool, so the pool IS the health of
// this service, and one SELECT 1 is the whole question.
//
// Cheap is guaranteed two ways, because this endpoint is public and
// unauthenticated and must never become a load source:
//   * the answer is CACHED for HEALTH_CACHE_MS — however hard the endpoint is
//     polled, the database sees at most one probe per window per instance;
//   * concurrent cache misses SHARE one in-flight probe instead of each
//     issuing their own.
//
// The probe races its own HEALTH_DB_TIMEOUT_MS timer because the pool's
// connectionTimeoutMillis is 10s and its statement_timeout 15s
// (config/database.js — sized for request traffic, not for this): a health
// check that takes 10 seconds to say "down" has answered nobody. A pool that
// cannot return SELECT 1 inside 1.5s is not serving users either — outage and
// saturation both deserve the 503, and Railway routing away from a saturated
// instance is the correct response to saturation too.
//
// State TRANSITIONS are logged once each, not per poll: hours of a 5-second
// "still down" cadence would bury the one line that says when it started.
const HEALTH_DB_TIMEOUT_MS = 1500;
const HEALTH_CACHE_MS = 5000;
let healthCache = { at: 0, ok: false };
let healthProbe = null; // the shared in-flight probe, if one is running
let healthWasDown = false;

function probeDbHealth() {
  if (healthProbe) return healthProbe;
  healthProbe = Promise.race([
    // Both contenders RESOLVE (the query maps its rejection to false), so this
    // race can never itself become an unhandled rejection.
    pool.query('SELECT 1').then(() => true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), HEALTH_DB_TIMEOUT_MS).unref()),
  ]).then((ok) => {
    healthCache = { at: Date.now(), ok };
    if (!ok && !healthWasDown) {
      healthWasDown = true;
      console.error('[health] database probe FAILED — /api/health answers 503 until it recovers');
    } else if (ok && healthWasDown) {
      healthWasDown = false;
      console.log('[health] database probe recovered — /api/health answering 200 again');
    }
    healthProbe = null;
    return ok;
  });
  return healthProbe;
}

app.get('/api/health', async (req, res) => {
  const ok = Date.now() - healthCache.at < HEALTH_CACHE_MS
    ? healthCache.ok
    : await probeDbHealth();
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    db: ok ? 'ok' : 'unreachable',
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (disabled in development)
// ---------------------------------------------------------------------------
// isDev is declared further up, beside globalBackstopLimiter, which needs it
// before the body parsers. There is exactly one definition of it in this file.

// ONE REQUEST MUST COST ONE UNIT, AND UNTIL THIS EXISTED IT COST ONE TO FOUR.
//
// A limiter created by rateLimit() is a single middleware over a single store,
// so mounting the SAME instance on twenty-five routers gives those routers one
// shared bucket rather than twenty-five. That part was intended and is what
// makes apiLimiter a meaningful ceiling at all.
//
// What was not intended is that a request can pass through that one instance
// several times on its way to a handler. Two of the mounts below are the bare
// `/api` catch-alls (moderationRoutes and messageRoutes), and `app.use('/api')`
// matches EVERY path under /api, not just the ones its router defines. An
// authenticated request that those routers have no route for runs their
// `router.use(authenticate)`, matches nothing, and falls through to the next
// mount — having already charged apiLimiter on the way in. Measured against
// this file's real mount order with stub routers:
//
//   GET /api/users/me              1 unit   (mounted before the catch-alls)
//   GET /api/reports               1 unit
//   GET /api/venue-dashboard/...   2 units
//   GET /api/crowd/:placeId        3 units
//   POST /api/flocks/:id/vote      4 units  (/api/flocks is mounted twice)
//   GET /api/anything-unrouted     2 units  (a 404 is not free)
//
// So the documented ceiling of 3000 per 15 minutes was really 750 for the vote
// path and 1000 for the crowd card, and 3000 only for the handful of routes
// mounted above the catch-alls. Three things are wrong with that, in order of
// how much they matter:
//
//   1. THE COST IS BACKWARDS. The routes a real user hits constantly — open a
//      venue card, vote on a plan — are the expensive ones, and the cheapest
//      lane in the app is /api/users, which is where an enumeration attempt
//      goes. The limiter was strictly harder on the product than on the abuse
//      it exists to stop, and reading the mount order was all it took to find
//      the cheap lane.
//   2. THE NUMBER WAS NOT THE NUMBER. Nothing anywhere said 750, so every
//      argument written about this ceiling — in this file, in
//      utils/probeBudget.js, in routes/users.js, in services/mlPredictor.js —
//      reasoned from 3000 and was wrong by up to 4x.
//   3. IT DEPENDED ON MOUNT ORDER. Moving a router one line changes its
//      ceiling, silently, with no test able to notice.
//
// The fix is to charge once per request per limiter instance, which is what
// every one of those arguments already assumed. It is deliberately generic
// rather than a special case for the two catch-alls: a third bare `/api` mount
// would reintroduce this, and this way it cannot.
//
// __tests__/rateLimiterInventory.test.js replays the real mount order and fails
// if any route charges more than one unit.
function countOncePerRequest(limiter, label) {
  const charged = Symbol(`rateLimitCharged:${label}`);
  return function countedLimiter(req, res, next) {
    if (req[charged]) return next();
    req[charged] = true;
    return limiter(req, res, next);
  };
}

const apiLimiter = countOncePerRequest(isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
}), 'apiLimiter');

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

// The venue advisor (Roost), which is more expensive per request than Birdie is
// and was sitting on the 3000/15min general limiter until this was written.
//
// What one GET /cards actually costs: services/advisorFacts.js walks the venue's
// next seven days, and for each day asks mlPredictor for nearby events, then
// asks the weather service for a forecast. That is up to eight upstream
// lookups, on top of the baseline-curve, owner-report and served-prediction
// aggregates it runs in Postgres. POST /ask builds the same facts and may then
// spend a Gemini call. The general limiter would have let one account drive
// three thousand of those in a quarter of an hour.
//
// The vendor meters inside weatherService and the event fetcher already stop
// this from becoming an unbounded invoice, and the token ledgers in
// services/advisorPhrasing.js bound the model spend. What NEITHER of those
// bounds is the database and the latency, which is what this limiter is for:
// cheap and early, the same division of labour aiLimiter documents above.
//
// Keyed on the ACCOUNT, not the address, for the reason billedImageKey states:
// an advisor caller is always authenticated, so an address key would just be a
// meter that IP rotation defeats. Twenty a minute is a dashboard open plus a
// run of question chips, with room to spare and none for a loop.
const advisorLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: billedAccountKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many advisor requests, please slow down' },
});

// Typed questions (POST /api/venue/advisor/question), which are the one advisor
// path the CALLER shapes. The limiter above is a burst brake sized for a
// dashboard open plus a run of chips, and a minute window is the wrong shape
// for this: twenty a minute is twelve hundred an hour, and every one of them is
// at least two model calls over a prompt carrying the owner's own words.
//
// An HOUR window, and a small number in it, because a question is a thought and
// nobody has ten of those a minute. Ten an hour leaves an owner room to work
// through a real problem in one sitting and leaves a script nowhere to go. It
// sits UNDER the per-venue daily cap in migration 039 rather than replacing it:
// this one is per process and defeated by a restart, the daily one is in
// Postgres and is not, and the pair is the same brake-and-cap division
// services/birdieUsage.js documents.
//
// Keyed on the account, like every other authenticated meter here.
const advisorQuestionLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: billedAccountKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'That is a lot of questions in one hour. Give it a little while and ask again.' },
});

// The venue owner's own surfaces. These landed on the general 3000/15min
// limiter, which is an ADDRESS meter sized for a consumer app's chat and feed
// traffic; the routes underneath it are analytics.
//
//   /api/venue-dashboard  /this-week runs four fourteen-day aggregate scans
//                         per request with no cache, /busy-now runs a
//                         DISTINCT ON plus a correlated NOT EXISTS, and
//                         /incoming-flocks joins votes per call.
//   /api/venue-profile    every save re-checks corpus membership, which is an
//                         EXISTS plus a COUNT(*) over ml_venue_baselines.
//
// Both are authenticated, so both key on the ACCOUNT for the reason
// billedImageKey states: an address meter on an authenticated route is a meter
// IP rotation defeats. The numbers are sized for a person with a dashboard
// open, not for the loop that a shared limiter left room for. A dashboard
// opens perhaps a dozen panels at once and a profile is saved by hand.
const venueDashboardLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: billedAccountKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many dashboard requests, please slow down' },
});

const venueProfileLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: billedAccountKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many profile requests, please slow down' },
});

// The digest unsubscribe link is the one venue surface with NO login, so it is
// the one that cannot key on an account: the address is all there is. The token
// is an HMAC and is not guessable, so this is not a brute-force gate; it is
// there so an open unauthenticated endpoint cannot be used as free load.
const digestOptOutLimiter = isDev ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
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
// The Monday digest's unsubscribe link. NO JWT — the signed, purpose-labelled
// token in the query string is the whole authorisation (services/venueDigest.js).
// It belongs in THIS block for exactly the reason the block exists, and it was
// mounted below the catch-alls instead: every emailed unsubscribe link, and
// every RFC 8058 one-click POST from Gmail or Apple Mail, was answered
// `401 {"error":"No token provided"}` by moderationRoutes' `router.use(authenticate)`
// before routes/venueDigest.js ever ran. Nobody noticed because
// __tests__/venueDigest.test.js mounts the router on a bare express app, so the
// route works perfectly in isolation and is unreachable in the product.
// The consequences were the whole point of the file it broke: the confirm page
// could not render, one-click unsubscribe failed (a deliverability signal Gmail
// scores senders on, and the CAN-SPAM obligation the header cites), and the only
// remaining way off the list was signing in to the dashboard.
// __tests__/venueDigest.test.js now pins this position against server.js itself.
app.use('/api/venue-digest', digestOptOutLimiter, require('./routes/venueDigest')); // Monday digest unsubscribe link (signed token, no JWT)
// The waitlist unsubscribe link, and Resend's delivery webhook. Both belong in
// this block for the same reason /api/venue-digest does: neither carries a JWT,
// so mounting either below the /api catch-alls would have moderationRoutes'
// `router.use(authenticate)` answer 401 to an emailed unsubscribe link and to
// every bounce notification.
//   * /api/unsubscribe  — HMAC over the address in the query string is the
//     whole authorisation (services/emailUnsubscribe.js). Same limiter as the
//     digest's, for the same reason: not a brute-force gate on an unguessable
//     token, just a ceiling on an open endpoint.
//   * /api/email-events — Svix-signed by Resend and verified against the RAW
//     bytes, which is why it gets emailWebhookParser above rather than the
//     default one.
app.use('/api/unsubscribe', digestOptOutLimiter, require('./routes/unsubscribe'));
app.use('/api/email-events', require('./routes/emailWebhook'));
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
app.use('/api/venue-profile', venueProfileLimiter, venueProfileRoutes); // Handles /api/venue-profile (venue owners)
app.use('/api/venue-dashboard', venueDashboardLimiter, venueDashboardRoutes); // Handles promotions, events, reviews CRUD
app.use('/api/venue/advisor/question', advisorQuestionLimiter);  // free text, tighter: 10/hour per account
app.use('/api/venue/advisor', advisorLimiter, advisorRoutes);  // Roost: fact cards + chip chat (own limiter, see above)
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
  // The CORS allowlist refusing an origin. One line, no stack: this is the
  // control doing its job, not a fault, and the caller is anonymous by
  // construction, so a stack per refusal is 8,500 identical traces per key per
  // window with nothing in any of them that the one line does not say. See the
  // block above the cors() mount for why the status is set at the throw site
  // rather than guessed here.
  // The header is caller-controlled, so it is JSON.stringify'd (which escapes
  // the CR and LF that would otherwise forge a second log line) and clamped to
  // 200 characters. A real Origin is a hostname; anything longer is somebody
  // writing into our log with the one string this line has to print.
  if (err && err.type === CORS_REFUSED) {
    const shown = JSON.stringify(String(req.headers.origin || '').slice(0, 200));
    console.warn(`[cors] refused origin ${shown} on ${req.method} ${String(req.originalUrl).slice(0, 200)}`);
    return res.status(403).json({ error: 'Not allowed by CORS' });
  }

  // ANYTHING ELSE THAT NAMES A 4xx IS A CLIENT FAULT TOO, AND THIS HANDLER WAS
  // STILL ANSWERING THOSE 500 WITH A STACK.
  //
  // The branch above fixed one error that was being reported as a crash. It is
  // not the only one, and the next one along needs no new code anywhere to be
  // reachable: EXPRESS ITSELF raises it. A `:id` route with a malformed
  // percent-escape in the parameter — `GET /api/flocks/%ZZ`, three characters,
  // no account, any router in this app — makes Express's own decode_param throw
  // a URIError carrying `status = statusCode = 400`. Measured against this file
  // on 2026-08-26, before this branch existed:
  //
  //     HTTP/1.1 500 Internal Server Error
  //     [unhandled-error] GET /api/users/%ZZ user=anon: URIError: Failed to
  //         decode param '%ZZ' ... plus the rest of the stack
  //
  // Sentry does not capture it (its rule reads the 400 and leaves it alone, so
  // the alert storm stays closed), which is precisely why it survived the last
  // pass: the half that was measured was the Sentry half. The other two halves
  // were still wrong. The caller is told the server broke when the caller's own
  // URL was malformed, and every one of those writes a full stack trace into
  // the production log, from an anonymous request, at whatever rate the
  // backstop allows.
  //
  // An error that sets `status` is DECLARING what it is, and the block above
  // already trusts that declaration for body-parser. There is no reason to
  // trust it there and guess here. Only 4xx is honoured: a 5xx declaration is a
  // server fault and belongs in the branch below with its stack, and anything
  // outside 400-499 is not a claim this handler recognises.
  //
  // The body stays the same opaque sentence the body-parser branch uses,
  // because a client error's message is written for us and not for the caller,
  // and one sentence is better than a second one that says the same thing. The
  // log line is clamped and carries no stack, for the reason the cors line
  // above gives.
  const declaredStatus = Number(err && (err.status ?? err.statusCode));
  if (Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus < 500) {
    console.warn(
      `[client-error] ${req.method} ${String(req.originalUrl).slice(0, 200)} `
      + `user=${req.user?.id ?? 'anon'}: ${declaredStatus} `
      + `${String((err && err.message) || '').replace(/[\r\n]+/g, ' ').slice(0, 200)}`
    );
    return res.status(declaredStatus).json({ error: 'That request could not be read.' });
  }

  // Everything below is a genuine server fault, and this line is where a 3am
  // debug starts: which verb, which URL, which account — then the stack.
  // req.originalUrl rather than req.path because by the time an error reaches
  // this handler the request may have been routed through a mounted router,
  // and the original spelling is the one to paste into a reproduction.
  console.error(
    `[unhandled-error] ${req.method} ${req.originalUrl} user=${req.user?.id ?? 'anon'}:`,
    err
  );
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
      // Same predicate as the REST callback above, on purpose — see
      // isAllowedOrigin and the comment block above it.
      if (!origin || isAllowedOrigin(origin)) {
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

// Rate limit WebSocket connections, per client IP.
//
// 200 per minute, not 10, and the number is chosen against who actually uses
// this app rather than against a single phone. The key is the client's public
// address (last X-Forwarded-For hop), and Flock's audience sits behind shared
// school, dorm and bar NATs, so one bucket is a whole venue. The failure the
// old ceiling produced was collective and silent: venue wifi blips, every phone
// in the room reconnects at once (the client retries forever, 1s backoff), the
// first ten win, and the bucket refills at ten a minute, so a fifty-person bar
// waits most of five minutes for chat to come back and nothing on any screen
// says why. 200/minute clears a full venue's reconnect burst inside one window.
//
// It is not weaker as protection in any way that matters. 200 handshakes a
// minute from one IP is trivial load; the DoS answer is the global backstop and
// the infrastructure, and per-ACCOUNT abuse is already capped separately by
// MAX_SOCKETS_PER_USER. 200/min also matches the main API limiter's rate
// (3000 per 15 minutes), which is the consistency that was missing: opening a
// socket was two hundred times scarcer than calling the REST API.
//
// Dev bypasses it entirely, exactly like every express limiter above (isDev).
// It never did, and that asymmetry was found the hard way: five local test
// browsers sharing 127.0.0.1 starved each other out of realtime.
const SOCKET_HANDSHAKES_PER_MINUTE = 200;
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
  if (isDev) return next();
  const ip = socketClientIp(socket);
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxConnections = SOCKET_HANDSHAKES_PER_MINUTE;

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
  // SECURITY ROUND 5, 2026-08-20: the DISPLAY NAME is gone from this line.
  // This is the highest-volume log statement in the app — one line per socket
  // connection, so several per user per session — and it printed a real name
  // beside the integer id. Run for a week and the Railway log IS a complete
  // id-to-name directory of everyone who used the product, readable by anyone
  // with dashboard access, and (once SENTRY_DSN is set) riding along on
  // unrelated errors as console breadcrumbs. The id is what a connection log
  // is for: it joins to every other line here and to the database. The name
  // was never doing anything a lookup could not do on demand.
  console.log(`Socket connected: user ${socket.user.id}`);
  registerHandlers(io, socket);
});

// ---------------------------------------------------------------------------
// Lightweight migrations (idempotent — safe to run every startup)
// ---------------------------------------------------------------------------
// (The pool itself is required up by the health check, which probes it.)

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

// ---------------------------------------------------------------------------
// THE MONEY WATCH — the alarm the spend ceilings never had
// ---------------------------------------------------------------------------
// Every upstream in this app that costs money or burns a vendor quota has a
// global daily ceiling, and each one is read here: Google Places
// (utils/placesBudget.js), Google Cloud Vision (utils/visionBudget.js), Gemini
// tokens (services/birdieUsage.js), the Places photo dollar budget
// (services/photoStore.js), Ticketmaster (services/mlPredictor.js) and the
// night-context sweep's own Ticketmaster slice (services/nightContext.js).
// __tests__/moneyWatchAlarm.test.js sweeps for a seventh and fails if one
// exists without a line here.
//
// WHAT WAS ACTUALLY WRONG. Five of the six hit their ceiling in complete
// silence. placesBudget has no console call anywhere in the file: it just
// starts returning false, every venue card and every search answers 429, and
// nothing anywhere records that it happened. birdieUsage is the same — Birdie
// simply stops answering. photoStore logs one line per hour to stdout.
// visionBudget is the only one that talks properly, and its own inventory row
// says what is still missing in the same breath:
//
//     "STILL OPEN, and what is missing is still not a different policy but an
//      alarm. Fix: emit a real alert (Sentry, or the moderation alert channel)
//      when the global leg crosses 80%, rather than a throttled console.error
//      nobody reads."
//
// This is that fix, applied to all four rather than to the one that reported
// it — the class, not the instance, which is the rule utils/cacheKeyInventory.js
// opens with.
//
// THE ADMIN COST PANEL IS NOT THIS. routes/admin.js already reads several
// statuses, and that is genuinely useful, but it is a PULL: it answers the
// question on the day somebody thinks to ask it. A ceiling that is reached at
// 3pm and never mentioned is discovered from the invoice, or from a user saying
// the app stopped loading venues. This is the push half.
//
// WHY 80% AND 100% AND NOTHING ELSE. 80% is the last moment a decision is still
// available (raise the number, or find out who is spending). 100% is the point
// at which the product has started refusing people, and on Vision that refusal
// is fail-closed by design, so every image upload in the app is off until
// 00:00 UTC. Those are the two facts worth waking somebody for; anything
// between them is the admin panel's job.
//
// ONCE PER LEG PER UTC DAY. The counters themselves roll at UTC midnight, so
// the alarm rolls with them. Repeating it every fifteen minutes would train the
// reader to ignore it, which is the failure mode a silent counter and a noisy
// one share.
//
// IT REPORTS, IT NEVER REFUSES. Nothing here calls an allow() function or moves
// a counter — every read is the module's own non-consuming status reader, and
// the whole body is wrapped so a thrown read can never take down the process it
// is watching. A watchdog that can break the thing it watches is worse than no
// watchdog.
const MONEY_WATCH_INTERVAL_MS = 15 * 60 * 1000;
const MONEY_WARN_FRACTION = 0.8;

// leg name -> the UTC day it last spoke about, so each leg speaks at most once
// per day per level.
const moneyWatchSaid = new Map();

function sayOnceToday(leg, level, day, message, extra) {
  const key = `${leg}:${level}`;
  // THE DAY IS ONLY A DEDUPE KEY IF THERE IS ONE. moneyWatchSaid.get(key) is
  // undefined before a leg has ever spoken, so a status reader that came back
  // without a `day` compared equal to "already said this today" on its very
  // first call and that leg went silent forever. All six readers return one
  // today; the point is that a seventh that does not would turn the alarm into
  // the thing that fails quietly, which is precisely the failure this watch
  // exists to end. A missing day means the reader is broken, and a broken
  // reader is a reason to talk more rather than less.
  if (typeof day === 'string' && day && moneyWatchSaid.get(key) === day) return;
  moneyWatchSaid.set(key, day);
  // The 'MONEY' token is what utils/visionBudget.js already uses, so one grep
  // over the Railway log finds every spend event whatever raised it.
  console.error(`🛡️ MONEY: ${message}`);
  // Sentry is the half that reaches a person who is not reading the log.
  // instrument.js makes this a no-op when SENTRY_DSN is unset, so it is safe
  // in every environment.
  Sentry.captureMessage(`MONEY: ${message}`, {
    level: level === 'exhausted' ? 'error' : 'warning',
    tags: { money_leg: leg, money_level: level },
    extra: { day, ...extra },
  });
}

// One leg: used against its ceiling, plus the sentence to say. `noun` is what
// the numbers are denominated in, because "2000/2000" means nothing on its own
// and the four legs count four different things (calls, calls, tokens, fetches).
function checkMoneyLeg({ leg, day, used, ceiling, noun, atCeiling, atWarn }) {
  if (!Number.isFinite(used) || !Number.isFinite(ceiling) || ceiling <= 0) return;
  const pct = Math.round((used / ceiling) * 100);
  const numbers = `${used}/${ceiling} ${noun} (${pct}%) on ${day}`;
  if (used >= ceiling) {
    sayOnceToday(leg, 'exhausted', day, `${atCeiling} ${numbers}`, { used, ceiling, pct });
    return;
  }
  if (used >= ceiling * MONEY_WARN_FRACTION) {
    sayOnceToday(leg, 'warn', day, `${atWarn} ${numbers}`, { used, ceiling, pct });
  }
}

async function runMoneyWatch() {
  // Places. The one with no voice of its own at all.
  try {
    const s = require('./utils/placesBudget').placesBudgetStatus(null);
    checkMoneyLeg({
      leg: 'places-global', day: s.day, used: s.globalUsed, ceiling: s.limits.globalDaily,
      noun: 'paid Google Places calls',
      atCeiling: 'Google Places DAILY CEILING REACHED. Venue search, the crowd card, the owner dashboard and Birdie venue lookups all answer 429 until 00:00 UTC.',
      atWarn: 'Google Places daily budget is nearly spent.',
    });
    // The unauthenticated share is a separate decision (M5-1) and reaching it
    // means the badge, the photo proxy and the marketing demo are done for the
    // day while the signed-in product is untouched. Worth its own line, because
    // the two have completely different answers.
    checkMoneyLeg({
      leg: 'places-unauth', day: s.day, used: s.unauthUsed, ceiling: s.limits.unauthDaily,
      noun: 'paid Places calls from doors with no account',
      atCeiling: 'The UNAUTHENTICATED Places share is spent. Venue badges, the photo proxy and the public demo are refusing until 00:00 UTC; the signed-in product still has its reserve.',
      atWarn: 'The unauthenticated Places share is nearly spent.',
    });
  } catch (e) { console.error('[moneyWatch] places read failed:', e && e.message); }

  // Vision. It already logs at its own thresholds; this adds the Sentry half
  // its inventory row asks for, and says out loud what exhaustion costs.
  try {
    const s = require('./utils/visionBudget').visionBudgetStatus(null);
    checkMoneyLeg({
      leg: 'vision-global', day: s.day, used: s.globalUsed, ceiling: s.limits.globalDaily,
      noun: 'billed Cloud Vision screens',
      atCeiling: 'Cloud Vision DAILY CEILING REACHED. Image screening fails CLOSED by design, so EVERY photo upload in the app (chat, DM, story, avatar) is refused until 00:00 UTC.',
      atWarn: 'Cloud Vision daily budget is nearly spent; photo uploads stop entirely when it runs out.',
    });
  } catch (e) { console.error('[moneyWatch] vision read failed:', e && e.message); }

  // Gemini, denominated in tokens rather than requests, which is the whole
  // reason aiLimiter is not this number.
  try {
    const s = require('./services/birdieUsage').geminiSpendStatus(null);
    checkMoneyLeg({
      leg: 'gemini-global', day: s.day, used: s.globalUsed, ceiling: s.limits.globalDaily,
      noun: 'Gemini tokens',
      atCeiling: 'Gemini DAILY TOKEN CEILING REACHED. Birdie and the Roost advisor answer 429 until 00:00 UTC.',
      atWarn: 'The Gemini daily token budget is nearly spent.',
    });
  } catch (e) { console.error('[moneyWatch] gemini read failed:', e && e.message); }

  // Ticketmaster. Not billed per call, but a hard daily quota all the same, and
  // reaching it is a user-visible outage: event search and the advisor's event
  // facts both answer "busy right now" for the rest of the UTC day. Silent until
  // now, exactly like the Places one.
  try {
    const s = require('./services/mlPredictor').eventBudgetStatus();
    checkMoneyLeg({
      leg: 'events-global', day: s.day, used: s.globalUsed, ceiling: s.limits.globalDaily,
      noun: 'Ticketmaster lookups',
      atCeiling: 'The Ticketmaster DAILY BUDGET is spent. Event search and the advisor\'s event facts answer 429 until 00:00 UTC.',
      atWarn: 'The Ticketmaster daily budget is nearly spent.',
    });
    checkMoneyLeg({
      leg: 'events-unauth', day: s.day, used: s.unauthUsed, ceiling: s.limits.unauthDaily,
      noun: 'Ticketmaster lookups from doors with no account',
      atCeiling: 'The UNAUTHENTICATED Ticketmaster share is spent; the signed-in product still has its reserve.',
      atWarn: 'The unauthenticated Ticketmaster share is nearly spent.',
    });
  } catch (e) { console.error('[moneyWatch] events read failed:', e && e.message); }

  // The night-context sweep's own Ticketmaster slice. It is a background job, so
  // nobody sees a 429 when it runs dry — the symptom is a differencing report
  // that quietly has no events for last night, weeks later.
  try {
    const s = require('./services/nightContext').nightContextBudgetStatus();
    checkMoneyLeg({
      leg: 'nightcontext-global', day: s.day, used: s.globalUsed, ceiling: s.limits.globalDaily,
      noun: 'night-context Ticketmaster lookups',
      atCeiling: 'The night-context sweep has spent its Ticketmaster budget. Tonight\'s listings will not be snapshotted, and the advisor cannot answer about this night later.',
      atWarn: 'The night-context Ticketmaster budget is nearly spent.',
    });
  } catch (e) { console.error('[moneyWatch] nightContext read failed:', e && e.message); }

  // The photo budget is the one ledger of the four that lives in Postgres, so
  // it is the only one a deploy does not reset — and the only one whose ceiling
  // is a calendar MONTH. Its exhaustion sentence has to say so, because "try
  // again later" on a month budget can mean the 1st.
  try {
    const s = await require('./services/photoStore').photoSpendStatus();
    checkMoneyLeg({
      // Keyed on the MONTH, not the day, because the ceiling is a month: a
      // budget exhausted on the 9th stays exhausted until the 1st, and a daily
      // reminder of a three-week condition is noise.
      leg: 'photo-month', day: new Date().toISOString().slice(0, 7),
      used: s.monthUsed, ceiling: s.limits.fetchesPerMonth,
      noun: 'Places photo fetches this month',
      atCeiling: 'The Places photo MONTH budget is spent. Cached photos keep serving; a venue nobody has viewed this month has no picture until the 1st.',
      atWarn: 'The Places photo month budget is nearly spent.',
    });
  } catch (e) { console.error('[moneyWatch] photo read failed:', e && e.message); }
}

// Handles for the background timers, held so shutdown() can clear them —
// a crowd-alert sweep firing into a closing pool would be one last error on
// the way out of every deploy.
let crowdAlertsInterval = null;
let crowdAlertsKickoff = null;
let nightContextInterval = null;
let nightContextKickoff = null;
let venueDigestInterval = null;
let venueDigestKickoff = null;
let photoPruneInterval = null;
let photoPruneKickoff = null;
let storyPurgeInterval = null;
let storyPurgeKickoff = null;
let flockSweepInterval = null;
let flockSweepKickoff = null;
let moneyWatchInterval = null;
let moneyWatchKickoff = null;

async function boot() {
  try {
    await migrate(pool);
  } catch (e) {
    // The generic sentence used to be the ONLY output, which cost a real
    // production outage its diagnosis: the deploy crash-looped printing this
    // line while the actual failure (a TLS handshake refused before any SQL
    // ran) was invisible. The cause now prints with it, always.
    console.error('FATAL: migration failed — refusing to serve on a half-applied schema.');
    console.error('CAUSE:', e && e.message ? e.message : e);
    if (e && e.stack) console.error(String(e.stack).split('\n').slice(0, 3).join('\n'));
    process.exit(1);
  }
  await postBootTasks();

  server.listen(PORT, () => {
    console.log(`Flock API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });

  // Proactive crowd alerts — check every 15 minutes
  const { checkCrowdAlerts } = require('./services/crowdAlerts');
  crowdAlertsInterval = setInterval(checkCrowdAlerts, 15 * 60 * 1000);
  // Run once after a short delay on startup
  crowdAlertsKickoff = setTimeout(checkCrowdAlerts, 30 * 1000);

  // Nightly context snapshots — evening weather into night_context and
  // tonight's Ticketmaster listings into ml_events, so the advisor's
  // differencing report can still answer a past night after the in-memory
  // caches (and Ticketmaster's own past-event window) have forgotten it.
  // Env-gated, default ON: the sweep is cheap, pure-write, and never throws.
  const { runNightContextSweep, nightContextEnabled, NIGHT_CONTEXT_INTERVAL_MS } = require('./services/nightContext');
  if (nightContextEnabled()) {
    nightContextInterval = setInterval(runNightContextSweep, NIGHT_CONTEXT_INTERVAL_MS);
    // First run shortly after boot, staggered behind the crowd-alerts kickoff
    // so the two sweeps do not contend for the pool on the same tick.
    nightContextKickoff = setTimeout(runNightContextSweep, 45 * 1000);
  }

  // Monday venue digest — hourly sweep, and every send is gated inside the
  // service: DIGEST_ENABLED (default OFF, so this is a no-op that reads
  // nothing until it is flipped), Monday morning on the venue's own clock,
  // notification_prefs.weekly, tier, and a durable venue_digest_sends claim
  // (migration 033) so overlapping deploy containers cannot double-mail.
  const { runVenueDigestSweep } = require('./services/venueDigest');
  const digestSweep = () => runVenueDigestSweep().catch((e) => console.error('[venueDigest] sweep failed:', e.message));
  venueDigestInterval = setInterval(digestSweep, 60 * 60 * 1000);
  // Staggered behind the other two kickoffs for the same pool-contention reason.
  venueDigestKickoff = setTimeout(digestSweep, 60 * 1000);

  // Expire cached Places photos. This is a TERMS obligation and not
  // housekeeping: caching Places content is permitted only temporarily, so a
  // row past PHOTO_CACHE_TTL_MS has to leave the disk whether or not anything
  // is short of space. The read path already treats an expired row as a miss;
  // this is what makes the deletion real. Hourly, because the window is 30 days
  // and the only cost of being an hour late is an hour.
  const { prunePhotoStore } = require('./services/photoStore');
  const photoPrune = () => prunePhotoStore().catch((e) => console.error('[photoStore] prune failed:', e.message));
  photoPruneInterval = setInterval(photoPrune, 60 * 60 * 1000);
  photoPruneKickoff = setTimeout(photoPrune, 75 * 1000);

  // Delete expired stories. The route deletes them opportunistically off a
  // feed read, a successful post and a delete, and that is a floor rather than
  // a scheduler: the only trigger that ran on its own was the tail of
  // GET /api/stories, and the shipping client never calls that route, so a
  // table of expired rows in a process nobody posts to stayed full forever.
  // "Stories last 24 hours" was true of the feed, which filters on expires_at,
  // and false of the row, which held the image indefinitely. That is a
  // retention promise about a photograph, on a product whose age floor is 13,
  // so it gets a timer of its own rather than a hope that somebody reads the
  // feed. Hourly for the same reason the photo prune is: the window is a day
  // and the only cost of being an hour late is an hour.
  const { purgeExpiredStories } = require('./routes/stories');
  const storyPurge = () => purgeExpiredStories().catch((e) => console.error('[stories] purge failed:', e.message));
  storyPurgeInterval = setInterval(storyPurge, 60 * 60 * 1000);
  // Staggered off the photo prune so two DELETE sweeps do not open on the same
  // tick of a cold boot.
  storyPurgeKickoff = setTimeout(storyPurge, 105 * 1000);

  // Finish plans whose night is over. Until this existed, NOTHING in the
  // product moved a flock through time: a confirmed plan stayed confirmed
  // forever unless its host slid the done bar by hand, so a plan for a night
  // three weeks ago was still listed as a live plan, and the Past screen was
  // empty for everyone. See services/flockSweep.js for why the window is
  // twelve hours and why a swept flock can still have its attendance marked.
  const { runFlockCompletionSweep, flockSweepEnabled, FLOCK_SWEEP_INTERVAL_MS } = require('./services/flockSweep');
  if (flockSweepEnabled()) {
    // `io` rides along so a swept flock's members hear about it live; the
    // sweep treats it as optional and never lets a fan-out failure reach the
    // timer.
    flockSweepInterval = setInterval(() => runFlockCompletionSweep(io), FLOCK_SWEEP_INTERVAL_MS);
    // Last in the kickoff stagger (30s, 45s, 60s, 75s), same pool-contention
    // reason as its neighbours.
    flockSweepKickoff = setTimeout(() => runFlockCompletionSweep(io), 90 * 1000);
  }

  // The money watch. Registered LAST because it reads what the others spend,
  // and every read is non-consuming. See its block above for why it exists.
  const moneyWatch = () => runMoneyWatch().catch((e) => console.error('[moneyWatch] sweep failed:', e && e.message));
  moneyWatchInterval = setInterval(moneyWatch, MONEY_WATCH_INTERVAL_MS);
  // Behind every other kickoff (30s, 45s, 60s, 75s, 90s): a budget cannot be
  // near its ceiling in the first two minutes of a process whose counters
  // started at zero, so there is nothing for this to find until later anyway.
  moneyWatchKickoff = setTimeout(moneyWatch, 120 * 1000);
}

// ---------------------------------------------------------------------------
// Graceful shutdown — Railway sends SIGTERM on EVERY deploy
// ---------------------------------------------------------------------------
// Without this, every push killed the process mid-flight: in-flight responses
// dropped, pooled connections severed inside open transactions (Postgres rolls
// those back, but the client saw a socket error instead of an answer), and
// WebSockets cut without a close frame. Deploys happen many times a day, so
// "what SIGTERM does" is this app's single most common failure mode.
//
// Order: stop taking new work, finish the work in hand, then close the pool,
// then exit 0. A deadline backstops the drain, because a drain that never
// completes only moves the mid-flight kill to Railway's SIGKILL — minus the
// log line saying it happened.
const SHUTDOWN_DEADLINE_MS = 8000; // under Railway's kill window, far above any legit request

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    // A second signal is the operator (or the platform) insisting. Obey now.
    console.error(`[shutdown] second ${signal} — exiting immediately`);
    process.exit(1);
    // Unreachable in production (exit never returns); the explicit return keeps
    // this function correct even where exit is stubbed (observability.test.js),
    // instead of silently re-running the whole drain.
    return;
  }
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining (deadline ${SHUTDOWN_DEADLINE_MS}ms)`);

  // unref()'d so the timer never holds an otherwise-finished process open; if
  // the drain completes first, the exit(0) below wins and this never fires.
  setTimeout(() => {
    console.error('[shutdown] deadline hit with work still open — exiting anyway');
    process.exit(0);
  }, SHUTDOWN_DEADLINE_MS).unref();

  if (crowdAlertsInterval) clearInterval(crowdAlertsInterval);
  if (crowdAlertsKickoff) clearTimeout(crowdAlertsKickoff);
  if (nightContextInterval) clearInterval(nightContextInterval);
  if (nightContextKickoff) clearTimeout(nightContextKickoff);
  if (venueDigestInterval) clearInterval(venueDigestInterval);
  if (venueDigestKickoff) clearTimeout(venueDigestKickoff);
  if (photoPruneInterval) clearInterval(photoPruneInterval);
  if (photoPruneKickoff) clearTimeout(photoPruneKickoff);
  if (storyPurgeInterval) clearInterval(storyPurgeInterval);
  if (storyPurgeKickoff) clearTimeout(storyPurgeKickoff);
  if (flockSweepInterval) clearInterval(flockSweepInterval);
  if (flockSweepKickoff) clearTimeout(flockSweepKickoff);
  if (moneyWatchInterval) clearInterval(moneyWatchInterval);
  if (moneyWatchKickoff) clearTimeout(moneyWatchKickoff);

  // Disconnect socket clients FIRST: a live WebSocket is an open connection
  // and server.close() waits on open connections indefinitely. Clients
  // auto-reconnect (to the freshly deployed instance) — that is the
  // transport's normal recovery path, exercised by every phone that rides an
  // elevator.
  try { io.disconnectSockets(true); } catch (err) {
    console.error('[shutdown] socket disconnect failed:', err?.message || err);
  }

  // Stop accepting connections and let in-flight HTTP requests finish...
  server.close(() => {
    // ...and only then take the pool away from them.
    pool.end()
      .catch((err) => console.error('[shutdown] pool.end failed:', err?.message || err))
      .finally(() => {
        console.log('[shutdown] drained cleanly');
        process.exit(0);
      });
  });
  // Idle keep-alive connections hold no request but count as open — without
  // this, close() waits out their keep-alive timers for nothing. Guarded
  // because the method arrived in Node 18.2.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A REJECTED boot() USED TO BE INDISTINGUISHABLE FROM A HEALTHY ONE.
//
// `boot()` was called bare, so its rejection went to the unhandledRejection
// handler at the top of this file — and that handler's contract, deliberately,
// is to log and KEEP SERVING. That is right for a floating promise inside a
// request. It is exactly wrong here, and the two halves of boot() fail in two
// different directions:
//
//   * Before listen(): migrate() has its own try/catch that exits 1, but
//     postBootTasks() does not. It caught its two inner awaits when it was
//     written; a third one added later without a .catch() would reject the
//     whole boot, the port would never open, and the process would sit alive
//     and idle forever. Railway's health check fails a deploy on that, but the
//     container keeps running with nothing in the log except one
//     [unhandledRejection] line.
//
//   * After listen(): the timer registrations `require()` their services
//     at call time, and a require() that throws (a bad env read at module
//     scope, a syntax error, a missing file) is not caught by anything. The
//     port is already open, the health check passes, and the server serves
//     normally — with crowd alerts, night-context snapshots, the Monday
//     digest and the flock completion sweep all silently never registered.
//     That is the failure that would have gone unnoticed longest, because
//     everything a user touches works.
//
// Boot is the one place where "keep serving" is the wrong answer, so it gets
// its own terminal handler: say what failed, and exit 1 so the platform
// restarts on a clean process instead of leaving a half-started one up.
boot().catch((e) => {
  console.error('FATAL: boot failed after migrations — the process is not fully started, exiting.');
  console.error('CAUSE:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(String(e.stack).split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});

module.exports = { app, server, io };
