// ---------------------------------------------------------------------------
// SERVER FAULTS: WHICH ROUTES ARE ANSWERING 500, AND WHICH JOBS HAVE STOPPED
// ---------------------------------------------------------------------------
// Express 4 does not route a rejected async handler to error middleware, so
// every route in this app catches its own failure: `console.error(label, err)`
// and then `res.status(500).json(...)`, at more than two hundred sites. None of
// them calls next(err), so Sentry.setupExpressErrorHandler and the
// [unhandled-error] handler in server.js only ever saw synchronous throws. A
// route that failed for every user produced a console line per request and
// nothing else: no count, no alert, and with a DSN set, no Sentry error event
// either (a caught 500 shows up at most as a sampled span with no stack).
//
// Background sweeps have the same shape. services/flockSweep.js,
// services/reconfirmSweep.js and services/crowdAlerts.js each catch, log one
// line and carry on, so a sweep broken by a migration leaves last month's
// plans showing as live and nobody is told.
//
// This module is the one place both are counted:
//
//   REQUESTS. faultMiddleware, mounted ahead of every router, opens a request
//   context (AsyncLocalStorage) and counts each response that finishes with a
//   server-fault status into a 15-minute window keyed by the ROUTE PATTERN,
//   `GET /api/flocks/:id`, so no id, token or name ever lands in a key. The
//   error itself is picked up from the console.error call the route already
//   makes: installConsoleHook() notes the last Error logged inside a request,
//   and when that request ends in a 500 the error goes to Sentry with the
//   route as a tag, and its message (clamped, with addresses and tokens
//   blanked) is kept as the route's last message for the alert.
//
//   Hooking the log line rather than rewriting the 218 catch blocks is
//   deliberate. Every existing site and every future one is covered with no
//   change to route code, and a route that logs an error and then recovers
//   (answers 200 from a fallback) is never reported, because only a response
//   that actually failed is.
//
//   JOBS. recordJobRun(name, ok, err, everyMs) is called from each sweep's own
//   try/catch. A job with no success for three of its intervals is stalled.
//
// server.js's money watch reads both every fifteen minutes and alerts through
// services/opsAlert.js (services/serverFaultAlert.js holds the wording).
//
// IT NEVER THROWS. Everything here runs on the request path or inside a job's
// catch, and a counter that can fail a request is worse than no counter.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('node:async_hooks');

const WINDOW_MS = 15 * 60 * 1000;
// How many counted faults inside the window raise the alert. A single 500 is
// somebody's bad luck and the log already has it. Ten inside fifteen minutes
// is a route failing for everyone who touches it, or the database having a bad
// quarter hour, and both are worth knowing the same day rather than the next
// time a user writes in. services/serverFaultAlert.js acts on it.
const SERVER_FAULT_ALERT_THRESHOLD = 10;
// A job is stalled after this many of its own intervals with no success.
const STALLED_INTERVALS = 3;
// Bounds, so a storm cannot grow the maps without limit. Route patterns come
// from the route table, so the real count is a few hundred at most; the cap is
// for the unmatched fallback, which is built from the URL.
const MAX_ROUTES = 500;
const MAX_EVENTS_PER_ROUTE = 1000;
const MESSAGE_MAX = 200;

// 502, 503 and 504 are answers, not faults. Routes send them on purpose when
// an upstream is down or a feature is not configured (Places, Ticketmaster,
// web billing off), and each of those has its own alarm or is an expected
// state. Counting them here would page about a Places outage twice and about
// a switched-off feature forever.
const DELIBERATE_5XX = new Set([502, 503, 504]);

function isFault(status) {
  return Number.isInteger(status) && status >= 500 && !DELIBERATE_5XX.has(status);
}

const context = new AsyncLocalStorage();
// route -> { times: number[], lastMessage, lastAt }
const faults = new Map();
// job name -> { everyMs, firstSeenAt, lastOkAt, lastFailAt, lastError, failuresSinceOk }
const jobs = new Map();

// Anything shaped like an address or a JWT is blanked before a message is
// kept or mailed, the same two shapes instrument.js scrubs from Sentry events.
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function cleanMessage(err) {
  const raw = err && typeof err === 'object'
    ? `${err.name || 'Error'}: ${err.message || ''}`
    : String(err == null ? '' : err);
  const s = raw.replace(/[\r\n]+/g, ' ').replace(JWT_SHAPE, '[jwt]').replace(EMAIL_SHAPE, '[email]').trim();
  return s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX - 1)}…` : s;
}

// A path segment that carries data rather than naming a route: any digit, or
// long enough to be a token. Only used when Express matched no route pattern.
function genericPath(url) {
  const path = String(url || '').split('?')[0];
  const parts = path.split('/').map((seg) => (/\d/.test(seg) || seg.length > 24 ? ':param' : seg));
  return parts.join('/').slice(0, 120) || '/';
}

// The route pattern for a request, never its concrete URL. Inside a mounted
// router req.baseUrl is the mount path; once a request has left the router
// (an error passed to next()), Express restores baseUrl to '' while req.route
// still names the router-relative pattern, so the pattern is only trusted when
// it lines up with the URL's first segment. Otherwise the URL is generalised.
function routeKey(req) {
  try {
    const method = req.method || 'GET';
    const pattern = req.route && typeof req.route.path === 'string'
      ? `${req.baseUrl || ''}${req.route.path}`
      : null;
    const url = String(req.originalUrl || req.url || '').split('?')[0];
    if (pattern && url.split('/')[1] === pattern.split('/')[1]) return `${method} ${pattern}`;
    return `${method} ${genericPath(url)}`;
  } catch (err) {
    return 'unknown';
  }
}

function prune(entry, now) {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < entry.times.length && entry.times[i] < cutoff) i += 1;
  if (i > 0) entry.times.splice(0, i);
}

function recordFault(route, err, now = Date.now()) {
  try {
    let entry = faults.get(route);
    if (!entry) {
      if (faults.size >= MAX_ROUTES) {
        // Drop the route whose newest fault is oldest. Losing it only lets
        // that route be under-counted, never a request fail.
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [k, v] of faults) {
          const at = v.times.length ? v.times[v.times.length - 1] : 0;
          if (at < oldestAt) { oldestAt = at; oldestKey = k; }
        }
        if (oldestKey !== null) faults.delete(oldestKey);
      }
      entry = { times: [], lastMessage: null, lastAt: null };
      faults.set(route, entry);
    }
    prune(entry, now);
    entry.times.push(now);
    if (entry.times.length > MAX_EVENTS_PER_ROUTE) entry.times.splice(0, entry.times.length - MAX_EVENTS_PER_ROUTE);
    entry.lastAt = now;
    if (err) entry.lastMessage = cleanMessage(err);
  } catch (e) {
    // Counting is best effort.
  }
}

function sentry() {
  try {
    // eslint-disable-next-line global-require
    return require('@sentry/node');
  } catch (err) {
    return null;
  }
}

// Mounted first in server.js. Runs the rest of the request inside a context
// the console hook can see, and counts the response once it has finished.
function faultMiddleware(req, res, next) {
  const store = { error: null, note: null, route: null, req };
  let counted = false;
  res.on('finish', () => {
    if (counted) return;
    counted = true;
    try {
      if (!isFault(res.statusCode)) return;
      const route = store.route || routeKey(req);
      recordFault(route, store.error || store.note);
      const S = sentry();
      if (S) {
        const tags = { route, status: String(res.statusCode) };
        if (store.error) {
          // Sentry marks an error it has already captured (the
          // setupExpressErrorHandler path) and skips a second capture of the
          // same object, so an error passed to next() is not sent twice.
          S.captureException(store.error, { tags });
        } else {
          S.captureMessage(store.note
            ? `${res.statusCode} on ${route}: ${cleanMessage(store.note)}`
            : `${res.statusCode} with no logged error on ${route}`, { level: 'error', tags });
        }
      }
    } catch (err) {
      // Never let the counter reach the request.
    }
  });
  context.run(store, next);
}

// Note the last Error a request logs, and the route it was logged from.
// Taken at the moment of the log, while the router still has req.baseUrl set.
function noteLoggedError(args) {
  try {
    const store = context.getStore();
    if (!store) return;
    for (let i = args.length - 1; i >= 0; i -= 1) {
      if (args[i] instanceof Error) {
        store.error = args[i];
        if (store.req) store.route = routeKey(store.req);
        return;
      }
    }
    // A handful of routes log `err.message` rather than the error. The words
    // are still the best description of the failure there is, so they are
    // kept as the fallback message; a real Error logged earlier still wins.
    const words = args.filter((a) => typeof a === 'string').join(' ');
    if (words) {
      store.note = words;
      if (store.req && !store.route) store.route = routeKey(store.req);
    }
  } catch (err) {
    // Best effort.
  }
}

let hooked = false;
// Wrap console.error once. The original is always called first and with the
// same arguments, so every log line is exactly what it was.
function installConsoleHook() {
  if (hooked) return;
  hooked = true;
  const original = console.error;
  console.error = function faultAwareConsoleError(...args) {
    const out = original.apply(this, args);
    noteLoggedError(args);
    return out;
  };
}

// For code that answers a 500 without logging an Error first: hand the error
// over explicitly so the alert and Sentry get it.
function noteRequestError(err) {
  noteLoggedError([err]);
}

function serverFaultStatus(now = Date.now()) {
  const routes = [];
  let total = 0;
  for (const [route, entry] of faults) {
    prune(entry, now);
    if (entry.times.length === 0) continue;
    total += entry.times.length;
    routes.push({ route, count: entry.times.length, lastMessage: entry.lastMessage, lastAt: entry.lastAt });
  }
  routes.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return { windowMs: WINDOW_MS, total, routes };
}

/**
 * A background job reports each run.
 * @param {string} name     stable job name, e.g. 'flockSweep'
 * @param {boolean} ok      did the run succeed
 * @param {*} [err]         the failure, when !ok
 * @param {number} everyMs  the job's interval, which sets when it is stalled
 */
function recordJobRun(name, ok, err, everyMs, now = Date.now()) {
  try {
    if (typeof name !== 'string' || !name) return;
    let job = jobs.get(name);
    if (!job) {
      job = { everyMs: null, firstSeenAt: now, lastOkAt: null, lastFailAt: null, lastError: null, failuresSinceOk: 0 };
      jobs.set(name, job);
    }
    if (Number.isFinite(everyMs) && everyMs > 0) job.everyMs = everyMs;
    if (ok) {
      job.lastOkAt = now;
      job.failuresSinceOk = 0;
      return;
    }
    job.lastFailAt = now;
    job.failuresSinceOk += 1;
    job.lastError = cleanMessage(err);
    const S = sentry();
    if (S && err instanceof Error) S.captureException(err, { tags: { job: name } });
  } catch (e) {
    // Best effort.
  }
}

function jobStatus(now = Date.now()) {
  const out = [];
  for (const [name, job] of jobs) {
    const since = job.lastOkAt || job.firstSeenAt;
    const stalled = Boolean(job.everyMs) && now - since > STALLED_INTERVALS * job.everyMs;
    out.push({ name, ...job, stalled });
  }
  return out;
}

function __resetServerFaults() {
  faults.clear();
  jobs.clear();
}

module.exports = {
  faultMiddleware,
  installConsoleHook,
  noteRequestError,
  recordFault,
  recordJobRun,
  serverFaultStatus,
  jobStatus,
  routeKey,
  cleanMessage,
  isFault,
  WINDOW_MS,
  SERVER_FAULT_ALERT_THRESHOLD,
  STALLED_INTERVALS,
  __resetServerFaults,
  // Exposed so a test can run code inside a request context.
  __context: context,
};
