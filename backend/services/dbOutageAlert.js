// ---------------------------------------------------------------------------
// THE ALERT THAT HAS TO WORK WITH POSTGRES GONE
// ---------------------------------------------------------------------------
// Every other ops alert in this server claims its day in ops_alert_ledger
// before it sends (services/opsAlert.js). That is right for all of them and
// useless for this one: when the database is the thing that is down, the
// claim fails and nothing is sent. And the only thing that ever asked whether
// the database was up was /api/health, which runs when somebody requests it.
// Railway requests it once, at the start of a deployment, and never again
// (its healthcheck is a deploy gate, not a monitor), so a pool that died at
// 3pm answered 503 to every route with nobody told.
//
// So the server asks for itself. server.js runs tick() once a minute against
// the same probe /api/health uses. After DOWN_TICKS_BEFORE_ALERT failed probes
// in a row (about three minutes, long enough that a failover or a restart of
// the database does not page anybody) it mails MODERATION_ALERT_EMAIL straight
// through emailService, which reaches Resend without Postgres: its do-not-mail
// check fails open and its per-address cap lives in memory. When the probe
// answers again, one more email says so, with how long it was down.
//
// No ledger means the dedupe is in this process's memory: one email per
// outage, and never two down emails less than MIN_GAP_MS apart, so a database
// flapping every few minutes is one email an hour rather than one a flap. A
// restart forgets that, which costs at most one extra email.
//
// No push leg: the push path reads device tokens from the database that is
// down. A process that is down entirely cannot run any of this; the hourly
// collector's outside check covers that (services/apiUptimeCheck.js).
// ---------------------------------------------------------------------------
const emailService = require('./emailService');
const { alertAddresses } = require('./opsAlert');

const DB_WATCH_INTERVAL_MS = 60 * 1000;
const DOWN_TICKS_BEFORE_ALERT = 3;
const MIN_GAP_MS = 60 * 60 * 1000;

function minutes(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

async function defaultSend(subject, text) {
  const to = alertAddresses();
  if (to.length === 0) {
    console.error(`[db-watch] ${subject}, and MODERATION_ALERT_EMAIL is unset; nobody was told.`);
    return false;
  }
  try {
    const r = await emailService.sendEmail({ to: to[0], subject, text });
    return !(r && r.sent === false);
  } catch (err) {
    console.error('[db-watch] alert email failed:', err && err.message ? err.message : err);
    return false;
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<boolean>} deps.probe  resolves true when Postgres answers
 * @param {(subject: string, text: string) => Promise<boolean>} [deps.send]
 * @param {() => number} [deps.now]
 */
function createDbWatch({ probe, send = defaultSend, now = Date.now }) {
  const state = { downTicks: 0, downSince: null, mailedThisOutage: false, lastMailAt: null };

  async function tick() {
    let ok = false;
    try {
      ok = (await probe()) === true;
    } catch (err) {
      ok = false;
    }
    const t = now();

    if (ok) {
      if (state.mailedThisOutage) {
        const downFor = minutes(t - state.downSince);
        await send(
          'Flock database is answering again',
          [
            `Postgres answered the health probe again after about ${downFor} down.`,
            '',
            'The Railway Postgres service logs will say what happened.',
          ].join('\n')
        ).catch(() => false);
      }
      state.downTicks = 0;
      state.downSince = null;
      state.mailedThisOutage = false;
      return 'up';
    }

    state.downTicks += 1;
    if (state.downSince === null) state.downSince = t;
    if (state.downTicks < DOWN_TICKS_BEFORE_ALERT || state.mailedThisOutage) return 'down';
    if (state.lastMailAt !== null && t - state.lastMailAt < MIN_GAP_MS) return 'down';

    console.error(`[db-watch] database probe has failed ${state.downTicks} times in a row; sending the alert.`);
    const sent = await send(
      'Flock cannot reach its database',
      [
        `The API server has not been able to run SELECT 1 against Postgres for about ${minutes(t - state.downSince)}.`,
        'Every route needs the database, so the app is failing for everybody: sign in,',
        'plans, chat, venues. /api/health answers 503.',
        '',
        'Check, in order: the Railway Postgres service (is it running, is its volume',
        'full), the API service\'s PG variables, and the last deploy.',
        '',
        'One more email follows when the database answers again. This alert is sent',
        'from memory rather than the ops ledger, because the ledger lives in the',
        'database that is down.',
      ].join('\n')
    ).catch(() => false);
    if (sent) {
      state.mailedThisOutage = true;
      state.lastMailAt = t;
    }
    return 'down';
  }

  return { tick, state };
}

module.exports = {
  createDbWatch,
  DB_WATCH_INTERVAL_MS,
  DOWN_TICKS_BEFORE_ALERT,
  MIN_GAP_MS,
};
