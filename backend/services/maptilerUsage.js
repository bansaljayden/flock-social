'use strict';

// THE MAPTILER METER.
//
// How many map sessions and API requests this billing period has used, read
// from MapTiler's own service API, so the money hub can say how close the
// account is to the Flex allowance and to the spending limit. Nothing in this
// repo counts map loads: the map runs in the browser and talks to MapTiler
// directly, so MapTiler is the only place the count exists.
//
// GET https://service.maptiler.com/v1/analytics/api_usage/timeline
//   period=current_billing_period  the period the bill is for, which runs from
//                                  the day the plan renews, not the calendar month
//   classifier=services            totals per service, never per key
//   format=json                    one answer carries every group (session,
//                                  request, export) and the period's first day
// Header: Authorization: Token <MAPTILER_SERVICE_TOKEN>
//
// THE TOKEN. It is read from process.env.MAPTILER_SERVICE_TOKEN at call time
// and goes nowhere but that header. It is never logged, never returned and
// never part of an error: a failure is logged by its HTTP status or the
// error's name alone, because a fetch error's message can quote the request.
//
// A FAILURE IS NEVER A ZERO. With no token the answer is 'unset'; a refusal, a
// timeout or an answer in a shape this file does not know is 'failed', with
// our own words for why and no numbers.
//
// HELD FOR 30 MINUTES. The analytics are daily figures, so reading them on
// every hub load would only cost MapTiler calls. One process holds the cache;
// the application runs on one server (Railway numReplicas 1), so there is no
// second copy to disagree with it.

const costModel = require('./costModel');

const TIMELINE_URL = 'https://service.maptiler.com/v1/analytics/api_usage/timeline'
  + '?period=current_billing_period&classifier=services&format=json';
const TIMEOUT_MS = 4000;
const READ_TTL_MS = 30 * 60 * 1000;
// A failed read is asked again sooner, so a fixed token shows within minutes.
const FAIL_TTL_MS = 5 * 60 * 1000;
// A forced refresh still waits this long after the last real read.
const MIN_FORCE_MS = 60 * 1000;
// Extrapolating a month from one or two days is fiction, so no pace is worked
// out before the third day of the period.
const MIN_DAYS_FOR_PACE = 3;

let held = null; // { at, value }

function plainToken() {
  const v = process.env.MAPTILER_SERVICE_TOKEN;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const utcMs = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const ymdOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((utcMs(b) - utcMs(a)) / 86400000);

// The same day a month later, clamped to the month's last day (Jan 31 -> Feb 28).
function addOneMonth(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return ymdOfMs(Date.UTC(y, m, Math.min(d, last)));
}

// Which allowance a session item draws on. Map and weather sessions share the
// main pool; search and 3D sessions have their own. MapTiler names its items
// in the answer's legend, and an item this file cannot place counts against
// the main pool, so an unfamiliar name can only bring a warning forward.
function sessionPool(text) {
  if (/search|geocod/i.test(text)) return 'searchSessions';
  if (/\b3d\b|splat/i.test(text)) return 'sessions3d';
  return 'sessions';
}

/**
 * Dollars past the Flex allowances for a set of counts, in cents, rounded once
 * at the end (the hub's rule: sum unrounded, round once).
 */
function overageCents({ sessions = 0, searchSessions = 0, sessions3d = 0, requests = 0 } = {}) {
  const r = costModel.RATES.maptiler;
  const over = (used, included, per1k) => (Math.max(0, used - included) / 1000) * per1k;
  const usd = over(sessions, r.includedSessionsPerMonth, r.overSessionPer1kUsd)
    + over(searchSessions, r.includedSearchSessionsPerMonth, r.overSearchSessionPer1kUsd)
    + over(sessions3d, r.included3dSessionsPerMonth, r.over3dSessionPer1kUsd)
    + over(requests, r.includedApiRequestsPerMonth, r.overRequestPer1kUsd);
  return Math.round(usd * 100);
}

function included() {
  const r = costModel.RATES.maptiler;
  return {
    sessions: r.includedSessionsPerMonth,
    searchSessions: r.includedSearchSessionsPerMonth,
    sessions3d: r.included3dSessionsPerMonth,
    requests: r.includedApiRequestsPerMonth,
  };
}

/**
 * Turn MapTiler's JSON answer into totals. Returns null for a shape this file
 * does not know, which the caller reports as a failed read.
 */
function parseTimeline(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.datasets) || !isYmd(body.since)) return null;
  const labels = new Map();
  for (const l of Array.isArray(body.legend) ? body.legend : []) {
    if (l && typeof l.item_id === 'string') labels.set(l.item_id, typeof l.label === 'string' ? l.label : l.item_id);
  }
  const totals = { sessions: 0, searchSessions: 0, sessions3d: 0, requests: 0 };
  const byItem = [];
  for (const ds of body.datasets) {
    if (!ds || typeof ds.item_id !== 'string' || !Array.isArray(ds.data)) return null;
    let count = 0;
    for (const point of ds.data) {
      const v = point && Number(point.value);
      if (!Number.isFinite(v) || v < 0) return null;
      count += v;
    }
    const label = labels.get(ds.item_id) || ds.item_id;
    let pool = null;
    if (ds.group_id === 'session') pool = sessionPool(`${ds.item_id} ${label}`);
    else if (ds.group_id === 'request') pool = 'requests';
    // An export is its own group and Flock makes none; it is listed, not pooled.
    if (pool) totals[pool] += count;
    byItem.push({ group: typeof ds.group_id === 'string' ? ds.group_id : null, item: ds.item_id, label, count, pool });
  }
  byItem.sort((a, b) => b.count - a.count);
  return { since: body.since, until: isYmd(body.until) ? body.until : null, totals, byItem };
}

/**
 * The period's arithmetic and the pace, from parsed totals and today's date.
 * Separate from the read so the suite can work it at any boundary.
 */
function summarize(parsed, now = new Date()) {
  const today = ymdOfMs(now.getTime());
  const since = parsed.since;
  // Flex bills monthly, so the period ends the day before the same date next
  // month (2026-10-07 to 2026-11-06, renewing 2026-11-07).
  const renewsOn = addOneMonth(since);
  const daysInPeriod = daysBetween(since, renewsOn);
  const daysElapsed = Math.min(daysInPeriod, Math.max(1, daysBetween(since, today) + 1));
  const used = parsed.totals;

  let projected = null;
  let projectionWithheld = null;
  if (daysElapsed < MIN_DAYS_FOR_PACE) {
    projectionWithheld = `Day ${daysElapsed} of ${daysInPeriod} in the billing period, too early to work out a pace.`;
  } else {
    const pace = (n) => Math.round((n / daysElapsed) * daysInPeriod);
    projected = {
      sessions: pace(used.sessions),
      searchSessions: pace(used.searchSessions),
      sessions3d: pace(used.sessions3d),
      requests: pace(used.requests),
    };
  }

  return {
    status: 'read',
    reason: null,
    asOf: now.toISOString(),
    period: { since, until: parsed.until, endsOn: ymdOfMs(utcMs(renewsOn) - 86400000), renewsOn, daysElapsed, daysInPeriod },
    sessions: used.sessions,
    searchSessions: used.searchSessions,
    sessions3d: used.sessions3d,
    requests: used.requests,
    byItem: parsed.byItem,
    included: included(),
    projected,
    projectionWithheld,
    overSoFarCents: overageCents(used),
    overProjectedCents: projected ? overageCents(projected) : null,
  };
}

function unset() {
  return {
    status: 'unset',
    reason: 'MAPTILER_SERVICE_TOKEN is not set, so MapTiler was not asked.',
    included: included(),
  };
}

function failed(reason, now) {
  return { status: 'failed', reason, asOf: now.toISOString(), included: included() };
}

async function readOnce({ fetchImpl, now, token }) {
  const doFetch = fetchImpl || global.fetch;
  let res;
  try {
    res = await doFetch(TIMELINE_URL, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err && err.name) || 'unknown error';
    console.error('[maptiler] usage read failed:', name);
    return failed(name === 'TimeoutError' || name === 'AbortError'
      ? `MapTiler did not answer within ${TIMEOUT_MS / 1000} seconds.`
      : 'MapTiler could not be reached.', now);
  }
  if (res.status === 401 || res.status === 403) {
    console.error('[maptiler] usage read refused:', res.status);
    return failed(`MapTiler refused the service token (${res.status}). It must be a Service credential from Account, then Credentials.`, now);
  }
  if (!res.ok) {
    console.error('[maptiler] usage read failed: HTTP', res.status);
    return failed(`MapTiler answered ${res.status}, so there is no reading.`, now);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    console.error('[maptiler] usage read failed: not JSON');
    return failed('MapTiler answered with something that is not JSON.', now);
  }
  const parsed = parseTimeline(body);
  if (!parsed) {
    console.error('[maptiler] usage read failed: unknown shape');
    return failed('MapTiler answered in a shape this reader does not know, so there is no reading.', now);
  }
  return summarize(parsed, now);
}

/**
 * This billing period's MapTiler usage.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] a fetch, for the suite; global fetch otherwise
 * @param {Date} [opts.now]
 * @param {boolean} [opts.force] skip the hold, but not within a minute of the last read
 * @returns {Promise<object>} { status: 'read'|'unset'|'failed', ... } with `cached`
 */
async function readUsage({ fetchImpl = null, now = new Date(), force = false } = {}) {
  const token = plainToken();
  if (!token) return { ...unset(), cached: false };
  const age = held ? now.getTime() - held.at : Infinity;
  const ttl = held && held.value.status === 'read' ? READ_TTL_MS : FAIL_TTL_MS;
  if (held && age < ttl && (!force || age < MIN_FORCE_MS)) {
    return { ...held.value, cached: true };
  }
  const value = await readOnce({ fetchImpl, now, token });
  held = { at: now.getTime(), value };
  return { ...value, cached: false };
}

module.exports = {
  readUsage,
  overageCents,
  parseTimeline,
  summarize,
  TIMELINE_URL,
  READ_TTL_MS,
  FAIL_TTL_MS,
  MIN_DAYS_FOR_PACE,
  __test: {
    resetCache: () => { held = null; },
  },
};
