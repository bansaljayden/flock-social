// ---------------------------------------------------------------------------
// COST HEARTBEAT (2026-09-01)
// ---------------------------------------------------------------------------
// Jayden's order the day he paid the first real Google invoice: keep the
// expense picture current, constantly. Two things on that picture can go
// stale or go wrong silently, and each is checked here once a day.
//
//   1. The reconciled line in services/costModel.js is hand-entered from an
//      invoice. It stood at a mid-month snapshot for twelve days before anyone
//      noticed, and the panel said so only in a date nobody read. If it is
//      older than RECONCILED_STALE_DAYS, one email asks for the new invoice.
//
//   2. The photo budget in services/photoStore.js is the largest line on the
//      Google bill and it is a hard monthly ceiling. Reaching it does not
//      break anything, it stops NEW venues being bought until the 1st, which
//      is a quiet degradation. If the month has spent PHOTO_WARN_FRACTION of
//      the budget, one email says so while there is still time to raise it.
//
// Same shape as collectionHeartbeat.js on purpose: watch the state rather
// than the job, one email per condition per day, dedupe in ops_alert_ledger
// rather than in RAM so a redeploy cannot re-mail, release the claim if the
// send fails, and never let the sweep take the app down. The sweep runs every
// SWEEP_INTERVAL_MS but the ledger keys are per calendar day, so the effect
// is at most one email per condition per day regardless of the interval.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { sendEmail } = require('./emailService');
const costModel = require('./costModel');
// Accessed through the module object rather than destructured, so a test can
// stub photoStore.photoSpendStatus after this file is loaded and the sweep
// sees the stub. A destructured binding is captured once and never moves.
const photoStore = require('./photoStore');

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RECONCILED_STALE_DAYS = 35;
const PHOTO_WARN_FRACTION = 0.9;

function alertAddresses() {
  return String(process.env.MODERATION_ALERT_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

function costHeartbeatEnabled() {
  // Shares the collection heartbeat's kill switch, because a person turning
  // off "email me about ops" means all of it.
  return String(process.env.HEARTBEAT_DISABLED || '').toLowerCase() !== 'true';
}

// Days since a YYYY-MM-DD string, or null if it cannot be read. A date that
// cannot be read is treated as stale by the caller, since an unreadable
// reconciliation date is not a current one.
function daysSince(isoDate, now = new Date()) {
  if (typeof isoDate !== 'string') return null;
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}

// Claim today's slot for one alert key. Resolves true only for the caller
// whose insert landed; that caller sends, everyone else stays quiet.
async function claimToday(alertKey) {
  const claim = await pool.query(
    `INSERT INTO ops_alert_ledger (alert_key, sent_on)
     VALUES ($1, CURRENT_DATE)
     ON CONFLICT (alert_key, sent_on) DO NOTHING
     RETURNING sent_on`,
    [alertKey]
  );
  return claim.rows.length > 0;
}

async function releaseToday(alertKey) {
  await pool
    .query(`DELETE FROM ops_alert_ledger WHERE alert_key = $1 AND sent_on = CURRENT_DATE`, [alertKey])
    .catch(() => {});
}

async function mailOnce(alertKey, to, subject, lines) {
  if (!(await claimToday(alertKey))) return false;
  try {
    await sendEmail({ to, subject, text: lines.join('\n') });
    return true;
  } catch (sendErr) {
    await releaseToday(alertKey);
    throw sendErr;
  }
}

// The two checks, split out so a test can drive each with plain inputs and
// no clock or database.
function reconciledFinding(reconciled, now = new Date()) {
  const asOf = reconciled && reconciled.asOf;
  const age = daysSince(asOf, now);
  if (age !== null && age < RECONCILED_STALE_DAYS) return null;
  return {
    key: 'cost_reconciled_stale',
    subject: 'Flock cost panel needs a fresh invoice figure',
    lines: [
      age === null
        ? 'The reconciled Google Cloud line in services/costModel.js carries no readable date.'
        : `The reconciled Google Cloud line in services/costModel.js was last read from an invoice ${age} days ago, on ${asOf}.`,
      '',
      'Open the Google Cloud billing page, read the latest paid invoice, then open',
      'the admin dashboard, Revenue, and type the amount and the invoice date into',
      'the Reconciled card. The cost panel, this heartbeat and the DECA financial',
      'model all read that entry, so nothing in code needs editing.',
      '',
      `This alert repeats at most once a day while the date is older than ${RECONCILED_STALE_DAYS} days.`,
    ],
  };
}

function photoFinding(status) {
  if (!status || !status.limits) return null;
  const cap = Number(status.limits.fetchesPerMonth);
  const used = Number(status.monthUsed);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(used)) return null;
  const fraction = used / cap;
  if (fraction < PHOTO_WARN_FRACTION) return null;
  const pct = Math.round(fraction * 100);
  return {
    key: 'cost_photo_budget',
    subject: fraction >= 1 ? 'Flock photo budget is spent for the month' : 'Flock photo budget is nearly spent',
    lines: [
      `${used} of ${cap} Place Details Photos have been bought this month, ${pct}% of the ceiling.`,
      `That is about $${Number(status.monthUsd || 0).toFixed(2)} of paid photos so far against the $${Number(status.limits.budgetUsdPerMonth || 0).toFixed(2)} a month the budget allows.`,
      '',
      fraction >= 1
        ? 'New venues will show no photo until the 1st. Cached venues are unaffected.'
        : 'When it reaches the ceiling, new venues will show no photo until the 1st. Cached venues are unaffected.',
      'To allow more, raise PHOTO_BUDGET_USD_PER_YEAR on the Railway service. To spend less, lower it.',
      '',
      'This alert repeats at most once a day while the month stays above the warning line.',
    ],
  };
}

async function runCostHeartbeat() {
  try {
    if (!costHeartbeatEnabled()) return;
    const to = alertAddresses();

    const findings = [];
    // The merged block: a dashboard entry wins over the code constant.
    findings.push(reconciledFinding(await costModel.readReconciled(pool)));
    let photo = null;
    try {
      photo = await photoStore.photoSpendStatus();
    } catch (readErr) {
      // A ledger read failing is not a cost finding; it is logged and the
      // reconciled check still runs.
      console.error('[COST-HEARTBEAT] photo spend read failed:', readErr && readErr.message ? readErr.message : readErr);
    }
    findings.push(photoFinding(photo));

    for (const f of findings) {
      if (!f) continue;
      if (to.length === 0) {
        console.error(`[COST-HEARTBEAT] ${f.subject}, and MODERATION_ALERT_EMAIL is unset; nobody was mailed.`);
        continue;
      }
      const sent = await mailOnce(f.key, to[0], f.subject, f.lines);
      if (sent) console.error(`[COST-HEARTBEAT] ${f.subject}. Alert mailed.`);
    }
  } catch (err) {
    // The heartbeat must never take the app down with it.
    console.error('[COST-HEARTBEAT] sweep failed:', err && err.message ? err.message : err);
  }
}

module.exports = {
  runCostHeartbeat,
  costHeartbeatEnabled,
  reconciledFinding,
  photoFinding,
  daysSince,
  SWEEP_INTERVAL_MS,
  RECONCILED_STALE_DAYS,
  PHOTO_WARN_FRACTION,
};
