// ---------------------------------------------------------------------------
// THE CHECK FROM OUTSIDE THE API PROCESS
// ---------------------------------------------------------------------------
// Everything else that watches this app runs inside the API process, so none
// of it can say anything when that process is down or crash-looping, which is
// exactly when it matters. Railway calls /api/health only at the start of a
// deployment (its healthcheck is a deploy gate, not a monitor), so a server
// that died at 3pm, at school, phone in a bag, is a green dashboard over a
// dead app until a user says so.
//
// The hourly BestTime collector (scripts/ml/collectRealtime.js) is a separate
// Railway service that already runs every hour, so it opens each run with one
// GET of the public /api/health, under a ten second deadline. A failed GET is
// asked once more RETRY_AFTER_MS later, and only a second failure mails
// MODERATION_ALERT_EMAIL: the aim is a process that is down or crash-looping,
// and one network blip or one slow answer on an hourly probe is neither. A
// healthy API still costs exactly one GET. No new vendor, no new service: it
// needs RESEND_API_KEY and MODERATION_ALERT_EMAIL set on the collector service
// too, and every run says so in the collector's log while either is missing,
// because an unset variable here fails silently until the day it matters.
//
// Once a day through ops_alert_ledger when the database is reachable from the
// collector, and FAIL OPEN when it is not: a claim that throws means the
// database is probably the reason the API is down, which is the one case where
// sending an extra email is clearly right. It never throws and never stops a
// collection run.
// ---------------------------------------------------------------------------
const emailService = require('./emailService');
const { alertAddresses } = require('./opsAlert');

const ALERT_KEY = 'api_unreachable';
const HEALTH_TIMEOUT_MS = 10 * 1000;
// Long enough for a dropped connection or a GC pause to clear, short enough
// that the hourly collection run it delays barely moves. Paid only when the
// first GET failed.
const RETRY_AFTER_MS = 25 * 1000;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// What this service is missing to tell anybody, or [] when it can mail.
function missingAlertConfig() {
  const missing = [];
  if (!process.env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (alertAddresses().length === 0) missing.push('MODERATION_ALERT_EMAIL');
  return missing;
}

function healthUrl() {
  return `${emailService.baseApiUrl()}/api/health`;
}

/**
 * One GET, bounded. Resolves { ok, status, detail } and never rejects.
 */
async function probeApi({ url = healthUrl(), timeoutMs = HEALTH_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    let db = null;
    try {
      const body = await res.json();
      db = body && typeof body.db === 'string' ? body.db : null;
    } catch (e) {
      db = null;
    }
    return { ok: res.status === 200, status: res.status, db };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: null,
      detail: timedOut
        ? `no answer within ${Math.round(timeoutMs / 1000)} seconds`
        : `the request failed: ${String((err && (err.cause && err.cause.code)) || (err && err.message) || err).slice(0, 120)}`,
    };
  }
}

function describe(r, url) {
  if (r.status === 503 && r.db === 'unreachable') {
    return {
      what: `GET ${url} answered 503: the API is running but cannot reach Postgres.`,
      check: 'Check the Railway Postgres service first (is it running, is its volume full), then the API service\'s PG variables.',
    };
  }
  if (r.status !== null) {
    return {
      what: `GET ${url} answered ${r.status} instead of 200.`,
      check: 'Check the API service\'s latest deployment and its logs on Railway.',
    };
  }
  return {
    what: `GET ${url} got ${r.detail}.`,
    check: 'The API process is probably down or restarting in a loop. Check the API service\'s deployments and logs on Railway.',
  };
}

/**
 * @param {object} deps
 * @param {{ query: Function }} deps.db   the collector's own pool, for the ledger
 * @param {Function} [deps.fetchImpl]
 * @param {number} [deps.retryAfterMs]  the wait before the second GET
 * @param {Function} [deps.sleep]       test seam for that wait
 */
async function runApiUptimeCheck({ db, fetchImpl, retryAfterMs = RETRY_AFTER_MS, sleep = wait } = {}) {
  try {
    const missing = missingAlertConfig();
    if (missing.length > 0) {
      const both = missing.length > 1;
      console.error(`[uptime] ${missing.join(' and ')} ${both ? 'are' : 'is'} unset on this service, so an API outage seen from here reaches nobody. Set ${both ? 'both' : 'it'} on the collector's Railway service.`);
    }

    const url = healthUrl();
    const first = await probeApi({ url, fetchImpl });
    if (first.ok) return { ok: true };
    const retrySeconds = Math.round(retryAfterMs / 1000);
    console.error(`[uptime] ${describe(first, url).what} Asking once more in ${retrySeconds} seconds.`);
    await sleep(retryAfterMs);
    const r = await probeApi({ url, fetchImpl });
    if (r.ok) {
      console.warn('[uptime] the second GET answered 200, so that was a blip and nobody is mailed.');
      return { ok: true, retried: true };
    }
    const words = describe(r, url);
    console.error(`[uptime] ${words.what}`);

    const to = alertAddresses();
    if (to.length === 0) {
      console.error('[uptime] MODERATION_ALERT_EMAIL is unset on this service; nobody was told.');
      return { ok: false, skipped: 'no-recipient' };
    }

    let claimed = false;
    if (db && typeof db.query === 'function') {
      try {
        const c = await db.query(
          `INSERT INTO ops_alert_ledger (alert_key, sent_on)
           VALUES ($1, CURRENT_DATE)
           ON CONFLICT (alert_key, sent_on) DO NOTHING
           RETURNING sent_on`,
          [ALERT_KEY]
        );
        if (c.rows.length === 0) return { ok: false, skipped: 'already-sent-today' };
        claimed = true;
      } catch (err) {
        // Fail open. See the header.
        console.error('[uptime] ledger claim failed, sending anyway:', err && err.message ? err.message : err);
      }
    }

    let sent = false;
    try {
      const out = await emailService.sendEmail({
        to: to[0],
        subject: 'Flock\'s API is not answering',
        text: [
          words.what,
          `It failed twice, ${retrySeconds} seconds apart, so this is not one dropped request.`,
          '',
          'Seen by the hourly collector, which runs as its own Railway service, so this',
          'check still works when the API process itself is down.',
          '',
          words.check,
          '',
          'This alert repeats at most once a day while the API stays down, or once an',
          'hour if the collector cannot reach the database either.',
        ].join('\n'),
      });
      sent = !(out && out.sent === false);
    } catch (err) {
      sent = false;
    }
    if (!sent && claimed) {
      await db.query('DELETE FROM ops_alert_ledger WHERE alert_key = $1 AND sent_on = CURRENT_DATE', [ALERT_KEY]).catch(() => {});
    }
    return { ok: false, sent };
  } catch (err) {
    console.error('[uptime] check failed:', err && err.message ? err.message : err);
    return { ok: false, failed: true };
  }
}

module.exports = { runApiUptimeCheck, probeApi, healthUrl, ALERT_KEY, HEALTH_TIMEOUT_MS, RETRY_AFTER_MS };
