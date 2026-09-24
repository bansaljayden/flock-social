'use strict';

// ---------------------------------------------------------------------------
// /relay/public/* - the website demo's same-origin path to the backend.
//
// WHY A FUNCTION AND NOT A REWRITE. The demo (src/website/LiveDemo.js) calls
// same-origin /relay/public/* in production because school and work filters
// block *.railway.app. That used to be a bare rewrite in vercel.json straight
// to the backend, which meant every request reached Railway from Vercel's
// egress address: the backend's per-visitor limits (20 demo requests an hour,
// and three venues' crowd levels a day while the paywall is on) were metering
// Vercel's edge, not people, so everyone behind one edge shared one allowance.
//
// This function forwards the same two requests and adds who is asking, in a
// form the backend can check and a direct caller cannot forge:
//   x-flock-relay-ip   the visitor's address as Vercel's edge reports it
//   x-flock-relay-ts   unix seconds
//   x-flock-relay-sig  HMAC-SHA256 over `${ip}.${ts}` under RELAY_SIGNING_SECRET
// backend/routes/publicCrowd.js visitorKey believes the address only when the
// signature matches and the timestamp is within two minutes, and falls back to
// the source address for everything else. With RELAY_SIGNING_SECRET unset here
// the function forwards without the headers, which is exactly the old rewrite.
//
// WHAT IT FORWARDS, AND NOTHING ELSE. GET only, and only the two demo paths
// LiveDemo.js calls: demo/venues and demo/venue/<place id>. The rewrite passed
// every /api/public/* path through; a function that proxies anything is an
// open relay with a signature attached, so the allowlist is the point.
//
// The address is never logged, and neither is the query (it carries a map
// position). Errors log their name only.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const net = require('net');

// The same backend host the rewrite targeted.
const UPSTREAM = 'https://flock-app-production.up.railway.app';

// A cold backend has taken 23 s to answer the first area search after idle
// (LiveDemo.js keeps the measurement), so the bound sits above that and below
// the function's own maxDuration in vercel.json.
const UPSTREAM_TIMEOUT_MS = 25000;

const MIN_SECRET = 16;

// The backend's own busy sentence (routes/publicCrowd.js DEMO_BUSY_MSG), so a
// relay failure reads the same as a backend refusal on the page.
const BUSY_MSG = 'The live demo is taking a breather. The full thing is in the app.';

const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,512}$/;

function relaySecret() {
  const raw = process.env.RELAY_SIGNING_SECRET;
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length >= MIN_SECRET ? v : null;
}

function firstHeader(req, name) {
  const v = req && req.headers ? req.headers[name] : undefined;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return typeof v === 'string' ? v : null;
}

// The visitor's address as Vercel's edge wrote it. Vercel overwrites
// x-real-ip and x-forwarded-for at the edge rather than appending to a value
// the browser sent, so the first entry is the client it saw. Anything that
// does not parse as an address is no address at all.
function clientAddress(req) {
  const candidates = [
    firstHeader(req, 'x-real-ip'),
    (firstHeader(req, 'x-forwarded-for') || '').split(',')[0],
    (firstHeader(req, 'x-vercel-forwarded-for') || '').split(',')[0],
  ];
  for (const c of candidates) {
    const v = typeof c === 'string' ? c.trim() : '';
    if (v && v.length <= 64 && net.isIP(v) !== 0) return v;
  }
  return null;
}

function signatureHeaders(ip, nowMs) {
  const secret = relaySecret();
  if (!secret || !ip) return {};
  const ts = String(Math.floor(nowMs / 1000));
  const sig = crypto.createHmac('sha256', secret).update(`${ip}.${ts}`).digest('hex');
  return { 'x-flock-relay-ip': ip, 'x-flock-relay-ts': ts, 'x-flock-relay-sig': sig };
}

// The demo path this request is for, from the rewrite's `path` parameter or,
// failing that, from the original URL. Returns null for anything that is not
// one of the two demo endpoints.
function demoPath(req, url) {
  let raw = url.searchParams.get('path');
  if (raw === null && req && req.query && typeof req.query.path === 'string') raw = req.query.path;
  if (raw === null) {
    const m = /^\/relay\/public\/(.+)$/.exec(url.pathname);
    raw = m ? m[1] : null;
  }
  if (typeof raw !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (err) {
    return null;
  }
  decoded = decoded.replace(/^\/+/, '');
  if (decoded === 'demo/venues') return 'demo/venues';
  const m = /^demo\/venue\/([^/]+)$/.exec(decoded);
  if (m && PLACE_ID_RE.test(m[1])) return `demo/venue/${encodeURIComponent(m[1])}`;
  return null;
}

function sendJson(res, status, body, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return;
    }
    const url = new URL(req.url || '/', 'https://relay.invalid');
    const path = demoPath(req, url);
    if (!path) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const params = new URLSearchParams(url.search);
    params.delete('path');
    const qs = params.toString();
    const target = `${UPSTREAM}/api/public/${path}${qs ? `?${qs}` : ''}`;

    if (typeof fetch !== 'function') {
      sendJson(res, 503, { error: BUSY_MSG });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream;
    let body;
    try {
      upstream = await fetch(target, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: firstHeader(req, 'accept') || 'application/json',
          'User-Agent': 'FlockDemoRelay/1.0 (+https://www.flockcorp.com)',
          ...signatureHeaders(clientAddress(req), Date.now()),
        },
      });
      // Read inside the timeout window: a backend that sends headers and then
      // stalls is still bounded.
      body = Buffer.from(await upstream.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }

    res.statusCode = upstream.status;
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('Content-Type', type);
    // Every answer from this path is metered per visitor, so one visitor's
    // response must never be cached at Vercel's edge and served to another. The
    // backend's own Cache-Control passes through when it sends one.
    res.setHeader('Cache-Control', upstream.headers.get('cache-control') || 'private, no-store');
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    res.end(body);
  } catch (err) {
    const name = (err && err.name) || 'Error';
    console.error('demo-relay: upstream failed:', name);
    try {
      sendJson(res, name === 'AbortError' ? 504 : 502, { error: BUSY_MSG });
    } catch (sendErr) {
      // Headers already went out; nothing more to say.
    }
  }
}

module.exports = handler;

// Named handles for unit tests. Vercel treats the function itself as the
// handler and ignores extra properties hung off it.
module.exports.clientAddress = clientAddress;
module.exports.signatureHeaders = signatureHeaders;
module.exports.demoPath = demoPath;
module.exports.UPSTREAM = UPSTREAM;
module.exports.UPSTREAM_TIMEOUT_MS = UPSTREAM_TIMEOUT_MS;
