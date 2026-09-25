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
// THE REQUEST ITSELF LIVES IN services/besttimeAccount.js, which the admin
// Overview's Crowd data block reads through as well, so this script and that
// screen make the same call and screen its answer the same way. What stays here
// is the printing.
//
// THE KEY IS READ FROM BESTTIME_API_KEY, the variable scripts/ml/bestTimeService.js
// reads, so this reports on the same key the hourly collector uses. There is no
// BESTTIME_API_KEY_PRIVATE; BESTTIME_API_KEY_PUBLIC exists in the local .env and
// is read here only to screen the output for it.
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

const besttime = require('../../services/besttimeAccount');

async function main() {
  const key = besttime.configuredKey();
  if (!key) {
    console.error('[BestTime:Status] BESTTIME_API_KEY is not set in backend/.env; nothing to check.');
    process.exitCode = 1;
    return;
  }
  const secrets = [key, process.env.BESTTIME_API_KEY_PUBLIC].filter(Boolean);

  const answer = await besttime.fetchKeyStatus(key, { timeoutMs: 20000 });
  if (!answer.ok) {
    if (answer.kind === 'network') {
      // The message of a failed fetch can quote the request, and the request
      // carries the key. The code is enough to act on.
      console.error(`[BestTime:Status] Request failed (${answer.code}). Nothing was printed from the response.`);
    } else if (answer.kind === 'http') {
      console.error(`[BestTime:Status] HTTP ${answer.httpStatus} from the key endpoint. `
        + '401/403 means the key or the account is rejected; 5xx is BestTime.');
    } else {
      console.error('[BestTime:Status] The key endpoint did not answer with JSON.');
    }
    process.exitCode = 1;
    return;
  }

  const body = answer.body;
  const status = besttime.readKeyStatus(body, { secrets });
  // The three health fields as BestTime sent them, screened like everything else.
  const raw = (v) => (besttime.containsKeyMaterial(v, secrets) ? '[withheld]' : String(v));

  console.log(`[BestTime:Status] Checked ${new Date().toISOString()} (key from BESTTIME_API_KEY; the key itself is never printed)`);
  console.log(`  Key health         : ${status.healthy ? 'OK (valid, active)' : `NOT OK (status=${raw(body.status)}, valid=${raw(body.valid)}, active=${raw(body.active)})`}`);
  console.log('  Plan name          : not reported by the key endpoint (see the besttime.app dashboard)');

  const forecast = status.creditsForecast;
  const query = status.creditsQuery;
  console.log(`  credits_forecast   : ${forecast === null ? 'not reported' : forecast}`
    + '   (undocumented; has read 1 on two package accounts with very different usage, so it is not the admission count)');
  console.log(`  credits_query      : ${query === null ? 'not reported' : query}`
    + '   (undocumented; same)');
  console.log('  Admissions left    : not reported by the API; the besttime.app dashboard shows the '
    + 'new-venue count for this calendar month');

  // Anything else that looks like a plan, quota or cycle field, in case the
  // endpoint grows one. Printed by name and screened for key material.
  for (const field of status.reported) {
    const shown = field.withheld ? '[withheld: contains key material]' : String(field.value).slice(0, 80);
    console.log(`  ${field.name.padEnd(19)}: ${shown}`);
  }

  console.log(`  Cycle reset        : not reported by the key endpoint; package allowances are per calendar `
    + `month, so the next reset is ${besttime.nextCalendarMonthStart()} (derived, not read)`);
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
