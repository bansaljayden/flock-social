// ---------------------------------------------------------------------------
// BestTime account status, READ ONLY: how much of this cycle's allowance is left
// before an admission run spends any of it.
//
// Run (from backend/):  node scripts/ml/besttimeAccountStatus.js
//
// ONE request, GET https://besttime.app/api/v1/keys/<private key>, which reports
// on the key itself. It is not a forecast, a live call or a venue search, so it
// admits no venue and spends nothing on the package plan. Nothing is written
// anywhere, and no database is opened.
//
// THE KEY IS READ FROM BESTTIME_API_KEY, the variable scripts/ml/bestTimeService.js
// reads, so this reports on the same key the hourly collector uses. There is no
// BESTTIME_API_KEY_PRIVATE; BESTTIME_API_KEY_PUBLIC exists in the local .env and
// is not used here.
//
// WHAT IT PRINTS, AND WHAT IT NEVER PRINTS. The response echoes both keys back
// (api_key_private, api_key_public) along with the key's website restrictions.
// None of that is printed. Output is an allowlist: the key's health, the two
// credit counters the endpoint reports, and any future plan, quota or cycle
// field it may add, recognised by name. A value that contains either key is
// withheld even when its field is on the list, the request URL (which carries
// the key) is never logged, and a network failure prints its error code rather
// than its message.
//
// WHAT THE ENDPOINT DOES NOT SAY, measured 2026-09-25: it returns no plan name
// and no cycle date. Its whole shape was api_key_private, api_key_public,
// status, active, credits_forecast, credits_query, valid,
// restricted_website_public, restricted_website_private. So the plan line says
// "not reported" rather than guessing, and the reset line is derived from the
// package terms (allowances are per calendar month) and labelled as derived.
// The dashboard at besttime.app is the authority for both.
//
// AND THE TWO COUNTERS ARE NOT THE ADMISSION COUNT. On 2026-09-25 this key
// read credits_forecast 1 and credits_query 1, the same pair a different
// package account read on 2026-09-03 after more than five thousand calls in
// its cycle. Two accounts with nothing in common but the plan type reading the
// same 1 and 1 behave like flags, not counts, and BestTime documents neither
// field. They are printed as BestTime names them and not interpreted: the
// number of new-venue admissions left this month is on the dashboard only.
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const KEY_STATUS_URL = 'https://besttime.app/api/v1/keys/';

// Field names worth printing if BestTime ever adds them. Matched against the
// NAME only; the value is still screened for key material below.
const REPORTABLE_NAME = /(plan|package|subscription|tier|credit|quota|allowance|limit|remaining|used|usage|venue|reset|renew|cycle|period|expire)/i;
// Echoed identity, never printed, whatever the pattern above says.
const NEVER_PRINT_NAME = /(api_key|key_private|key_public|restricted_website|email|token|secret|password)/i;

function containsKeyMaterial(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return false;
  if (/\b(pri|pub)_[0-9a-f]{8,}/i.test(text)) return true;
  return secrets.some((s) => s && s.length >= 8 && text.includes(s));
}

// The first day of next month, UTC, as YYYY-MM-DD.
function nextCalendarMonthStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toISOString().slice(0, 10);
}

// Flattens the response into [path, value] pairs, dropping anything that is
// not a scalar (arrays and objects are walked, never printed whole).
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

async function main() {
  const key = process.env.BESTTIME_API_KEY;
  if (!key) {
    console.error('[BestTime:Status] BESTTIME_API_KEY is not set in backend/.env; nothing to check.');
    process.exitCode = 1;
    return;
  }
  const secrets = [key, process.env.BESTTIME_API_KEY_PUBLIC].filter(Boolean);

  let response;
  try {
    response = await fetch(KEY_STATUS_URL + encodeURIComponent(key), {
      method: 'GET',
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    // The message of a failed fetch can quote the request, and the request
    // carries the key. The code is enough to act on.
    const code = (err && err.cause && err.cause.code) || (err && err.name) || 'unknown';
    console.error(`[BestTime:Status] Request failed (${code}). Nothing was printed from the response.`);
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    console.error(`[BestTime:Status] HTTP ${response.status} from the key endpoint. `
      + '401/403 means the key or the account is rejected; 5xx is BestTime.');
    process.exitCode = 1;
    return;
  }

  let body;
  try {
    body = await response.json();
  } catch (_) {
    console.error('[BestTime:Status] The key endpoint did not answer with JSON.');
    process.exitCode = 1;
    return;
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const health = body.status === 'OK' && body.valid === true && body.active === true;

  console.log(`[BestTime:Status] Checked ${new Date().toISOString()} (key from BESTTIME_API_KEY; the key itself is never printed)`);
  console.log(`  Key health         : ${health ? 'OK (valid, active)' : `NOT OK (status=${String(body.status)}, valid=${String(body.valid)}, active=${String(body.active)})`}`);
  console.log('  Plan name          : not reported by the key endpoint (see the besttime.app dashboard)');

  const forecast = num(body.credits_forecast);
  const query = num(body.credits_query);
  console.log(`  credits_forecast   : ${forecast === null ? 'not reported' : forecast}`
    + '   (undocumented; has read 1 on two package accounts with very different usage, so it is not the admission count)');
  console.log(`  credits_query      : ${query === null ? 'not reported' : query}`
    + '   (undocumented; same)');
  console.log('  Admissions left    : not reported by the API; the besttime.app dashboard shows the '
    + 'new-venue count for this calendar month');

  // Anything else that looks like a plan, quota or cycle field, in case the
  // endpoint grows one. Printed by name and screened for key material.
  const known = new Set(['status', 'active', 'valid', 'credits_forecast', 'credits_query']);
  for (const [path, value] of flatten(body)) {
    if (known.has(path)) continue;
    if (NEVER_PRINT_NAME.test(path) || !REPORTABLE_NAME.test(path)) continue;
    if (value !== null && !['number', 'boolean', 'string'].includes(typeof value)) continue;
    const shown = containsKeyMaterial(value, secrets) ? '[withheld: contains key material]' : String(value).slice(0, 80);
    console.log(`  ${path.padEnd(19)}: ${shown}`);
  }

  console.log(`  Cycle reset        : not reported by the key endpoint; package allowances are per calendar `
    + `month, so the next reset is ${nextCalendarMonthStart()} (derived, not read)`);
}

module.exports = { main };

// Only when run directly: a require from a test or a sibling script must not
// send the key anywhere.
if (require.main === module) {
  main().catch((err) => {
    // Same rule as the fetch catch: a message could carry the request.
    console.error(`[BestTime:Status] Failed (${(err && err.name) || 'unknown error'}).`);
    process.exitCode = 1;
  });
}
