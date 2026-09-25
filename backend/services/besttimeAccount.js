'use strict';
// ---------------------------------------------------------------------------
// BESTTIME'S KEY ENDPOINT, READ ONLY.
//
// One request, GET https://besttime.app/api/v1/keys/<private key>, shared by
// the admin Overview's Crowd data block (services/moneyHub.js) and the
// command-line check scripts/ml/besttimeAccountStatus.js, so the two cannot
// disagree about what BestTime said. The endpoint reports on the key itself.
// It is not a forecast, a live call or a venue search: it admits no venue and
// spends nothing on a package plan.
//
// THE KEY IS IN THE URL AND COMES BACK IN THE BODY. The response echoes both
// keys (api_key_private, api_key_public) and the key's website restrictions,
// so every way out of this file is a way to leak one. Nothing here returns the
// body whole, the URL, a fetch error's message or any text of BestTime's
// choosing about a failure: a failure is a kind plus an HTTP status or an error
// code, and a field is passed on only when its name says it is a plan, quota
// or cycle figure and neither its name nor its value carries key material.
//
// WHAT THE ENDPOINT DOES NOT SAY, measured 2026-09-25: no plan name, no count
// of new-venue admissions and no cycle date. Its whole shape was
// api_key_private, api_key_public, status, active, credits_forecast,
// credits_query, valid, restricted_website_public and
// restricted_website_private. credits_forecast and credits_query are
// undocumented, and on 2026-09-25 this key read 1 and 1, the same pair a
// different package account read on 2026-09-03 after more than five thousand
// calls in its cycle. They behave like flags, so they are passed on under
// BestTime's own names and never as the admission count. The besttime.app
// dashboard is the authority for the plan and for the admissions used.
// ---------------------------------------------------------------------------

const KEY_STATUS_URL = 'https://besttime.app/api/v1/keys/';

// THE PLAN'S TERMS, AS THE CODE RECORDS THEM, because the endpoint above
// reports none of them. services/costModel.js carries the plan's name, price
// and checked date on its besttime-subscription line ("Package 100"); a package
// plan meters new venue admissions per calendar month, and by-id, live and
// query calls on venues already admitted are unlimited (the note on that same
// line). Stated, never read: whatever shows these says so.
const STATED_PLAN = Object.freeze({
  costLineId: 'besttime-subscription',
  newVenuesPerMonth: 100,
  cycle: 'calendar_month',
});

// Field names worth passing on if BestTime ever adds them. Matched against the
// NAME only; the value is still screened for key material below.
const REPORTABLE_NAME = /(plan|package|subscription|tier|credit|quota|allowance|limit|remaining|used|usage|venue|reset|renew|cycle|period|expire)/i;
// Echoed identity, never passed on, whatever the pattern above says.
const NEVER_PRINT_NAME = /(api_key|key_private|key_public|restricted_website|email|token|secret|password)/i;
// The key's health and the two counters are read by name, so they are not
// listed a second time among the other fields.
const KNOWN_FIELDS = new Set(['status', 'active', 'valid', 'credits_forecast', 'credits_query']);

// The key BESTTIME_API_KEY names, the variable scripts/ml/bestTimeService.js
// reads, so this reports on the same key the hourly collector uses. Null when
// it is unset or blank.
function configuredKey() {
  const raw = typeof process.env.BESTTIME_API_KEY === 'string' ? process.env.BESTTIME_API_KEY.trim() : '';
  return raw || null;
}

function containsKeyMaterial(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return false;
  if (/\b(pri|pub)_[0-9a-f]{8,}/i.test(text)) return true;
  return secrets.some((s) => typeof s === 'string' && s.length >= 8 && text.includes(s));
}

// The first day of next month, UTC, as YYYY-MM-DD.
function nextCalendarMonthStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toISOString().slice(0, 10);
}

// The last day of this month, UTC, as YYYY-MM-DD: the day before the one above.
function calendarMonthEnd(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return d.toISOString().slice(0, 10);
}

// Flattens the response into [path, value] pairs, dropping anything that is
// not a scalar (arrays and objects are walked, never passed on whole).
function flatten(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push([prefix, value]);
  }
  return out;
}

// An error code that is safe to show: the cause's code (ECONNRESET) or the
// error's name (TimeoutError). Never the message, which can quote the request
// URL, and the URL carries the key.
function errorCode(err) {
  const raw = String((err && err.cause && err.cause.code) || (err && err.name) || '');
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(raw) ? raw : 'unknown';
}

/**
 * The one request. Never throws, and nothing it returns carries the key:
 *   { ok: true, body }                     the endpoint answered with a JSON object
 *   { ok: false, kind: 'network', code }   no answer; code as errorCode gives it
 *   { ok: false, kind: 'http', httpStatus } an answer that was not a success
 *   { ok: false, kind: 'not_json' }        a success that was not a JSON object
 * `body` is BestTime's answer as sent, both keys included: pass it through
 * readKeyStatus before anything of it leaves the caller.
 */
async function fetchKeyStatus(key, { timeoutMs = 10000 } = {}) {
  let response;
  try {
    response = await fetch(KEY_STATUS_URL + encodeURIComponent(key), {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, kind: 'network', code: errorCode(err) };
  }
  if (!response || !response.ok) {
    return { ok: false, kind: 'http', httpStatus: response && Number.isInteger(response.status) ? response.status : null };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, kind: 'not_json' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, kind: 'not_json' };
  return { ok: true, body };
}

/**
 * BestTime's answer reduced to what may leave the server: the key's health,
 * the two counters under BestTime's own names, and every other field whose
 * name reads as a plan, quota or cycle figure, in the order BestTime sent
 * them. A field whose name or value carries key material is marked withheld
 * rather than passed on, and the echoed keys never appear at all.
 */
function readKeyStatus(body, { secrets = [] } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const reported = [];
  for (const [name, value] of flatten(b)) {
    if (KNOWN_FIELDS.has(name)) continue;
    if (NEVER_PRINT_NAME.test(name) || !REPORTABLE_NAME.test(name)) continue;
    if (value !== null && !['number', 'boolean', 'string'].includes(typeof value)) continue;
    if (containsKeyMaterial(name, secrets)) continue;
    reported.push(containsKeyMaterial(value, secrets) ? { name, withheld: true } : { name, value });
  }
  let status = null;
  if (b.status !== undefined && b.status !== null) {
    const text = String(b.status).slice(0, 40);
    status = containsKeyMaterial(text, secrets) ? '[withheld]' : text;
  }
  return {
    healthy: b.status === 'OK' && b.valid === true && b.active === true,
    status,
    valid: typeof b.valid === 'boolean' ? b.valid : null,
    active: typeof b.active === 'boolean' ? b.active : null,
    creditsForecast: num(b.credits_forecast),
    creditsQuery: num(b.credits_query),
    reported,
  };
}

module.exports = {
  KEY_STATUS_URL,
  STATED_PLAN,
  configuredKey,
  fetchKeyStatus,
  readKeyStatus,
  containsKeyMaterial,
  nextCalendarMonthStart,
  calendarMonthEnd,
  errorCode,
  flatten,
};
