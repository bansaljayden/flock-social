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

// Checked on every decoding a URL, a form or JSON can give the text, and
// without regard to case: "pri%5F..." (percent-encoded underscore) and a
// lowercased %2f each carried a whole key past the literal check. Escapes are
// decoded one at a time, repeatedly, so one stray "%" cannot void the whole
// decode ("100% used; pri%5F...") and a double encoding (%255F) unwinds.
function decodeEscapes(text) {
  let cur = text;
  for (let pass = 0; pass < 4; pass++) {
    // %XX, and \uXXXX / \xXX left as literal text inside a parsed string.
    const next = cur
      .replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

// A run of sixteen or more hex characters with at least one letter in it, the
// shape of a key's body. Digits alone are an id or a count, not a key.
function hasHexKeyRun(text) {
  const runs = text.match(/[0-9a-f]{16,}/g) || [];
  return runs.some((r) => /[a-f]/.test(r));
}
function keyCheckForms(text) {
  const forms = new Set([text]);
  const unescaped = text.replace(/\\\//g, '/');
  for (const t of [text, unescaped]) {
    forms.add(t);
    const decoded = decodeEscapes(t);
    forms.add(decoded);
    forms.add(decoded.replace(/\+/g, ' '));
  }
  return [...forms].map((t) => t.toLowerCase());
}

// Key material is: a pri_/pub_ prefix with hex after it (no word boundary
// asked for, so "ref_pub_..." counts), any run of sixteen or more hex
// characters (a key's body without its prefix), or a configured key, whole or
// its body alone.
function containsConfiguredSecret(text, secrets = []) {
  if (typeof text !== 'string' || !text) return false;
  const forms = keyCheckForms(text);
  return secrets.some((s) => {
    if (typeof s !== 'string' || s.length < 8) return false;
    const whole = s.toLowerCase();
    const body = whole.replace(/^(pri|pub)_/, '');
    return forms.some((t) => t.includes(whole) || (body.length >= 12 && t.includes(body)));
  });
}

const SECRET_WINDOW = 8;
function containsSecretWindow(text, secrets = []) {
  if (typeof text !== 'string' || text.length < SECRET_WINDOW) return false;
  const forms = keyCheckForms(text);
  return secrets.some((s) => {
    if (typeof s !== 'string' || s.length < 8) return false;
    const body = s.toLowerCase().replace(/^(pri|pub)_/, '');
    if (body.length < SECRET_WINDOW * 2) return false;
    for (let i = 0; i + SECRET_WINDOW <= body.length; i++) {
      const piece = body.slice(i, i + SECRET_WINDOW);
      if (forms.some((t) => t.includes(piece))) return true;
    }
    return false;
  });
}

// Both screens at once: key-shaped text, or any eight characters of a
// configured key's body. What every printed account value goes through.
function screenValue(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return containsKeyMaterial(value, secrets) || containsSecretWindow(String(text || ''), secrets);
}

function containsKeyMaterial(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return false;
  const forms = keyCheckForms(text);
  if (forms.some((t) => /(pri|pub)[_\s-]?[0-9a-f]{4,}/.test(t) || hasHexKeyRun(t))) return true;
  return containsConfiguredSecret(text, secrets);
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
  const candidates = [];
  for (const [name, value] of flatten(b)) {
    if (KNOWN_FIELDS.has(name)) continue;
    if (NEVER_PRINT_NAME.test(name) || !REPORTABLE_NAME.test(name)) continue;
    if (value !== null && !['number', 'boolean', 'string'].includes(typeof value)) continue;
    // A name is printed too, so it gets the same two screens as a value.
    if (containsKeyMaterial(name, secrets) || containsSecretWindow(name, secrets)) continue;
    candidates.push({ name, value });
  }
  // A key split across fields can pass each field's own check, so the values
  // that passed are also joined and searched for the configured key (whole or
  // its body). Only for the configured key: the generic hex rule would read a
  // few numeric quota fields run together as a key.
  // A piece is any eight characters of a configured key's body, so the pieces
  // are caught in any order and with anything between them.
  const flagged = candidates.map((c) => containsKeyMaterial(c.value, secrets)
    || containsSecretWindow(String(c.value), secrets));
  const passing = candidates.filter((_, i) => !flagged[i]).map((c) => String(c.value));
  const splitKey = passing.length > 1 && containsConfiguredSecret(passing.join(''), secrets);
  const reported = candidates.map(({ name, value }, i) => (
    flagged[i] || splitKey ? { name, withheld: true } : { name, value }
  ));
  let status = null;
  if (b.status !== undefined && b.status !== null) {
    // Screened whole, then shortened: shortening first let the start of a key
    // through under the cut.
    const full = String(b.status);
    status = screenValue(full, secrets) ? '[withheld]' : full.slice(0, 40);
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
  screenValue,
  decodeEscapes,
  nextCalendarMonthStart,
  calendarMonthEnd,
  errorCode,
  flatten,
};
