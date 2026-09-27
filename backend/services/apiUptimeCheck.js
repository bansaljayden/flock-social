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
// GET of the public /api/health, under a ten second deadline. Anything but a
// 200 mails MODERATION_ALERT_EMAIL. No new vendor, no new service: it needs
// RESEND_API_KEY and MODERATION_ALERT_EMAIL set on the collector service too.
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
 */
async function runApiUptimeCheck({ db, fetchImpl } = {}) {
  try {
    const url = healthUrl();
    const r = await probeApi({ url, fetchImpl });
    if (r.ok) return { ok: true };
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

module.exports = { runApiUptimeCheck, probeApi, healthUrl, ALERT_KEY, HEALTH_TIMEOUT_MS };
