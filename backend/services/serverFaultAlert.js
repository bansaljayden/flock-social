// ---------------------------------------------------------------------------
// THE ALERT FOR A ROUTE THAT KEEPS FAILING, OR A JOB THAT HAS STOPPED
// ---------------------------------------------------------------------------
// utils/serverFault.js counts; this decides when the count is worth a person's
// attention and says it in words they can act on. Run from the money watch in
// server.js every fifteen minutes, and sent through services/opsAlert.js, so
// it is one email and one push to the admins per condition per day. The
// threshold and its reason live beside the counter in utils/serverFault.js.
// ---------------------------------------------------------------------------
const {
  serverFaultStatus,
  jobStatus,
  STALLED_INTERVALS,
  SERVER_FAULT_ALERT_THRESHOLD,
} = require('../utils/serverFault');
const { opsAlert } = require('./opsAlert');

const TOP_ROUTES = 5;

// What stops for users when each job stops. A job missing from this list is
// still reported, by name, with no consequence line.
const JOB_CONSEQUENCE = {
  flockSweep: 'Plans whose night is over stay listed as live, and the Past screen stops filling.',
  reconfirmSweep: 'The "Still in?" check before a confirmed plan is not sent.',
  crowdAlerts: 'Pre-plan crowd alerts stop, and so do pushes held for quiet hours or queued for a retry, which ride the same sweep.',
  photoPrune: 'Expired Places photos are not deleted, which the Places terms require.',
  storyPurge: 'Expired stories are not deleted.',
};

function ago(ms) {
  const mins = Math.round(ms / 60000);
  if (mins >= 120) return `${Math.round(mins / 60)} hours ago`;
  if (mins >= 1) return `${mins} minutes ago`;
  return 'just now';
}

function every(ms) {
  const mins = Math.round(ms / 60000);
  return mins >= 60 && mins % 60 === 0 ? `every ${mins / 60} hour${mins === 60 ? '' : 's'}` : `every ${mins} minutes`;
}

function faultBody(status) {
  const lines = [
    `In the last ${Math.round(status.windowMs / 60000)} minutes the server answered ${status.total} requests with an error: a route caught its own failure and returned a 500.`,
    '',
    'By route:',
  ];
  for (const r of status.routes.slice(0, TOP_ROUTES)) {
    lines.push(`  ${r.route}  ${r.count}`);
    if (r.lastMessage) lines.push(`    last error: ${r.lastMessage}`);
  }
  if (status.routes.length > TOP_ROUTES) lines.push(`  and ${status.routes.length - TOP_ROUTES} more routes`);
  lines.push(
    '',
    'Each of those people saw the action fail. Check, in order: the Railway log',
    'around now for the route\'s own error line, whether the last deploy touched',
    'that route or ran a migration, and whether the database is answering',
    '(/api/health).',
    '',
    'This alert repeats at most once a day.'
  );
  return lines.join('\n');
}

function jobBody(stalled, now) {
  const lines = [`${stalled.length === 1 ? 'A background job has' : 'Background jobs have'} not succeeded for at least ${STALLED_INTERVALS} of ${stalled.length === 1 ? 'its' : 'their'} own intervals:`, ''];
  for (const j of stalled) {
    const last = j.lastOkAt ? `last success ${ago(now - j.lastOkAt)}` : 'no success since the server started';
    lines.push(`  ${j.name} (runs ${every(j.everyMs)}): ${last}, ${j.failuresSinceOk} failed runs since.`);
    if (j.lastError) lines.push(`    last error: ${j.lastError}`);
    if (JOB_CONSEQUENCE[j.name]) lines.push(`    ${JOB_CONSEQUENCE[j.name]}`);
  }
  lines.push(
    '',
    'A sweep that starts failing right after a deploy is usually a migration or a',
    'renamed column. The Railway log has each failure under the job\'s own name.',
    '',
    'This alert repeats at most once a day.'
  );
  return lines.join('\n');
}

/**
 * Read the fault window and the job table, and alert on either. Never throws.
 * @param {object} [inputs] { status, jobs, now } injectable for tests.
 */
async function runServerFaultAlert(inputs = {}) {
  const out = { faults: null, jobs: null };
  try {
    const now = inputs.now || Date.now();
    const status = inputs.status || serverFaultStatus(now);
    if (status.total >= SERVER_FAULT_ALERT_THRESHOLD) {
      const top = status.routes[0];
      out.faults = await opsAlert({
        key: 'server_errors',
        subject: `Flock answered ${status.total} requests with an error in ${Math.round(status.windowMs / 60000)} minutes`,
        text: faultBody(status),
        push: {
          title: 'Flock is answering errors',
          body: `${status.total} failed requests in ${Math.round(status.windowMs / 60000)} minutes${top ? `, most on ${top.route}` : ''}.`,
        },
        tag: '[server-faults]',
      });
    }

    const stalled = (inputs.jobs || jobStatus(now)).filter((j) => j.stalled);
    if (stalled.length > 0) {
      out.jobs = await opsAlert({
        key: 'job_stalled',
        subject: stalled.length === 1
          ? `Flock's ${stalled[0].name} job has stopped succeeding`
          : `${stalled.length} Flock background jobs have stopped succeeding`,
        text: jobBody(stalled, now),
        push: {
          title: 'A background job has stopped',
          body: `${stalled.map((j) => j.name).join(', ')} ${stalled.length === 1 ? 'has' : 'have'} not succeeded in ${STALLED_INTERVALS} intervals.`,
        },
        tag: '[server-faults]',
      });
    }
  } catch (err) {
    console.error('[server-faults] alert failed:', err && err.message ? err.message : err);
  }
  return out;
}

module.exports = {
  runServerFaultAlert,
  faultBody,
  jobBody,
  SERVER_FAULT_ALERT_THRESHOLD,
  JOB_CONSEQUENCE,
};
