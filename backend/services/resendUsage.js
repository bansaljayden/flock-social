'use strict';

// THE RESEND METER.
//
// How many emails today and this month have used of Resend's caps, read from
// Resend's own API, so the money hub can warn before mail stops. The account
// is on the free plan: 100 emails a day and 3,000 a month, and every signup
// verification, password reset and notice counts against both. At either cap
// Resend sends nothing more until that window resets, so a busy launch day
// could stop signups from verifying. Nothing in this repo counts every email
// (venue_digest_sends counts the digest only), so Resend is the only place
// the whole count exists.
//
// GET https://api.resend.com/usage
// Header: Authorization: Bearer <RESEND_API_KEY>
// Answers {"object":"usage","emails":{"daily":{used, limit, sent, received,
// resets_at}, "monthly":{...}}, "contacts":...}. Only emails.daily and
// emails.monthly are read.
//
// THE KEY. It is read from process.env.RESEND_API_KEY at call time, the same
// variable services/emailService.js sends mail with, and goes nowhere but that
// header. It is never logged, never returned and never part of an error: a
// failure is logged by its HTTP status or the error's name alone, because a
// fetch error's message can quote the request.
//
// A FAILURE IS NEVER A ZERO. With no key the answer is 'unset'; a refusal, a
// timeout or an answer in a shape this file does not know is 'failed', with
// our own words for why and no numbers.
//
// HELD FOR 10 MINUTES. The daily cap is small enough that a launch morning can
// move it in an hour, so the hold is shorter than the MapTiler meter's. One
// process holds the cache; the application runs on one server (Railway
// numReplicas 1), so there is no second copy to disagree with it.

const costModel = require('./costModel');

const USAGE_URL = 'https://api.resend.com/usage';
const TIMEOUT_MS = 4000;
const READ_TTL_MS = 10 * 60 * 1000;
// A failed read is asked again sooner, so a fixed key shows within minutes.
const FAIL_TTL_MS = 5 * 60 * 1000;
// A forced refresh still waits this long after the last real read.
const MIN_FORCE_MS = 60 * 1000;

let held = null; // { at, value }

function plainKey() {
  const v = process.env.RESEND_API_KEY;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// The caps the code states for the plan (costModel.RATES.resend), carried on
// every answer so a screen can name them even when nothing was read.
function included() {
  const r = costModel.RATES.resend;
  return { daily: r.freePerDay, monthly: r.freePerMonth };
}

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * One window (daily or monthly). A limit may be null, which is how a plan with
 * no cap on that window would answer; anything else that is not a positive
 * number is a shape this file does not know. Returns null for that.
 */
function parseWindow(w) {
  if (!w || typeof w !== 'object') return null;
  if (!isCount(w.used)) return null;
  let limit;
  if (w.limit === null) limit = null;
  else if (typeof w.limit === 'number' && Number.isFinite(w.limit) && w.limit > 0) limit = w.limit;
  else return null;
  let resetsAt = null;
  if (w.resets_at !== undefined && w.resets_at !== null) {
    if (typeof w.resets_at !== 'string') return null;
    const ms = Date.parse(w.resets_at);
    if (!Number.isFinite(ms)) return null;
    resetsAt = new Date(ms).toISOString();
  }
  return { used: w.used, limit, resetsAt, share: limit === null ? null : w.used / limit };
}

/**
 * Turn Resend's JSON answer into the two windows. Returns null for a shape
 * this file does not know, which the caller reports as a failed read.
 */
function parseUsage(body) {
  if (!body || typeof body !== 'object' || !body.emails || typeof body.emails !== 'object') return null;
  if (body.object !== undefined && body.object !== 'usage') return null;
  const daily = parseWindow(body.emails.daily);
  const monthly = parseWindow(body.emails.monthly);
  if (!daily || !monthly) return null;
  return { daily, monthly };
}

function unset() {
  return {
    status: 'unset',
    reason: 'RESEND_API_KEY is not set, so Resend was not asked.',
    included: included(),
  };
}

function failed(reason, now) {
  return { status: 'failed', reason, asOf: now.toISOString(), included: included() };
}

async function readOnce({ fetchImpl, now, key }) {
  const doFetch = fetchImpl || global.fetch;
  let res;
  try {
    res = await doFetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err && err.name) || 'unknown error';
    console.error('[resend] usage read failed:', name);
    return failed(name === 'TimeoutError' || name === 'AbortError'
      ? `Resend did not answer within ${TIMEOUT_MS / 1000} seconds.`
      : 'Resend could not be reached.', now);
  }
  if (res.status === 401 || res.status === 403) {
    console.error('[resend] usage read refused:', res.status);
    return failed(`Resend refused RESEND_API_KEY (${res.status}) when asked for usage. A key limited to sending may not be allowed to read it.`, now);
  }
  if (!res.ok) {
    console.error('[resend] usage read failed: HTTP', res.status);
    return failed(`Resend answered ${res.status}, so there is no reading.`, now);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    console.error('[resend] usage read failed: not JSON');
    return failed('Resend answered with something that is not JSON.', now);
  }
  const parsed = parseUsage(body);
  if (!parsed) {
    console.error('[resend] usage read failed: unknown shape');
    return failed('Resend answered in a shape this reader does not know, so there is no reading.', now);
  }
  return {
    status: 'read',
    reason: null,
    asOf: now.toISOString(),
    daily: parsed.daily,
    monthly: parsed.monthly,
    included: included(),
  };
}

/**
 * Today's and this month's email usage against Resend's caps.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] a fetch, for the suite; global fetch otherwise
 * @param {Date} [opts.now]
 * @param {boolean} [opts.force] skip the hold, but not within a minute of the last read
 * @returns {Promise<object>} { status: 'read'|'unset'|'failed', ... } with `cached`
 */
async function readUsage({ fetchImpl = null, now = new Date(), force = false } = {}) {
  const key = plainKey();
  if (!key) return { ...unset(), cached: false };
  const age = held ? now.getTime() - held.at : Infinity;
  const ttl = held && held.value.status === 'read' ? READ_TTL_MS : FAIL_TTL_MS;
  if (held && age < ttl && (!force || age < MIN_FORCE_MS)) {
    return { ...held.value, cached: true };
  }
  const value = await readOnce({ fetchImpl, now, key });
  held = { at: now.getTime(), value };
  return { ...value, cached: false };
}

module.exports = {
  readUsage,
  parseUsage,
  USAGE_URL,
  READ_TTL_MS,
  FAIL_TTL_MS,
  MIN_FORCE_MS,
  __test: {
    resetCache: () => { held = null; },
  },
};
