// ---------------------------------------------------------------------------
// Moderator alerting (A6) — so reports get acted on PROMPTLY (Apple 1.2).
//
// HOW A REPORT ACTUALLY REACHES A HUMAN
//
// This file used to say "socket + push" while its one caller (routes/
// moderation.js) said "push/email", and neither was the whole truth: there was
// no email leg at all, push is inert unless FIREBASE_SERVICE_ACCOUNT is set,
// the socket emit only lands if an admin happens to have the app open, and the
// entire function did nothing whatsoever when no users row carried
// role='admin'. All four of those failures looked exactly like success, so a
// report could reach nobody and nothing said so. Now there are three legs, each
// with a stated precondition, and EVERY leg reports its own outcome by name:
//
//   1. LOG — unconditional, and emitted BEFORE any database or network work, so
//      a report survives even a total database failure inside this function.
//      This is the leg that is always true. On the Railway deployment it is a
//      stderr line; it is not a pager, and nothing here pretends it is.
//
//   2. EMAIL — services/emailService.js (the shared Resend wrapper: lazy
//      client, fail-soft on a missing key, deadlined fetch). Recipients, in
//      order of preference: MODERATION_ALERT_EMAIL (comma-separated), then the
//      email addresses of the users holding role='admin', then MODERATION_INBOX
//      below. Needs RESEND_API_KEY; without it emailService logs a skip and
//      this records the leg as skipped rather than delivered.
//
//   3. SOCKET + PUSH — best effort, and honestly counted. The socket emit only
//      reaches an admin with a live connection, so this counts the admins that
//      actually have one instead of counting the emits it issued. Push is a
//      no-op unless Firebase is configured (services/firebaseService.js) and
//      the admin is offline with a registered device.
//
// KNOWN GAPS, recorded here rather than papered over. Both are outside this
// file and neither is fixed by it:
//   * NOTHING IN THE CLIENT LISTENS FOR `moderation_report`. frontend/src/
//     services/socket.js registers ~35 events and this is not one of them, so
//     leg 3's socket half currently delivers to an open connection that drops
//     it on the floor. The emit is kept because it is the correct wire event
//     for the dashboard to subscribe to, not because it works today.
//   * role='admin' is granted ONLY by ADMIN_USER_IDS at boot (server.js
//     postBootTasks) and by scripts/e2e-local.js. If that variable is unset on
//     Railway there are zero admins, and legs 2 and 3 have no per-person
//     recipient. That is exactly why the email leg falls back to a fixed
//     address and why the summary below names the count out loud.
//
// Fire-and-forget: callers must never await-block the reporting user on this,
// and nothing in here is allowed to throw.
// ---------------------------------------------------------------------------
const pool = require('../config/database');
// Held as a module object, not destructured, for the same reason
// services/pushHelper.js holds firebaseService that way: tests replace the
// exported function, and a destructured copy would keep calling the original.
const emailService = require('./emailService');

let pushHelper = null;
try {
  pushHelper = require('./pushHelper');
} catch (err) {
  // Optional, but not silently optional: losing this drops a whole leg.
  console.error(`[MODERATION] pushHelper failed to load (${err.message}). The push leg is off for the life of this process.`);
}

// The address the product already publishes as the way to reach a person
// (routes/users.js BANNED_IDENTITY_MESSAGE, and emailService sends from it).
// Used only when no operator-configured address and no admin row exists, so
// that "a report reaches a human" is true out of the box instead of true only
// once someone remembers to set an environment variable.
const MODERATION_INBOX = 'hello@flockcorp.com';

// Matches isMailableAddress in routes/auth.js: the Apple placeholder
// (@apple-signin.invalid) and evicted-squat tombstones (@unclaimed.invalid)
// can never receive mail, and an admin row can hold either.
function isMailable(addr) {
  return typeof addr === 'string'
    && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(addr.trim())
    && !/\.invalid$/i.test(addr.trim());
}

// A typo in MODERATION_ALERT_EMAIL used to be indistinguishable from not
// setting it: the entry was dropped and the alert quietly went somewhere else.
// That is the same silent-no-op this whole file exists to stop, so a rejected
// entry is named.
function configuredRecipients() {
  const raw = String(process.env.MODERATION_ALERT_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const good = raw.filter(isMailable);
  const bad = raw.filter((a) => !isMailable(a));
  if (bad.length > 0) {
    console.error(`[MODERATION] MODERATION_ALERT_EMAIL contains ${bad.length} address(es) that cannot receive mail and were ignored: ${bad.join(', ')}`);
  }
  return good;
}

// Case-insensitive dedupe, and a hard ceiling so a misconfigured env var or a
// large admin table cannot turn one report into a hundred Resend calls.
const MAX_RECIPIENTS = 10;
function dedupe(addresses) {
  const seen = new Set();
  const out = [];
  for (const a of addresses) {
    const key = a.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a.trim());
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

// Resend quotas are finite and a brigading incident is precisely when the
// alerting must not collapse. The report route already caps one reporter at 10
// per hour, but fifty reporters are not capped by that, so the mail leg gets
// its own per-process ceiling. Crossing it is logged at error level WITH the
// report id, so a suppressed alert is louder in the log than a sent one, never
// quieter.
const EMAILS_PER_HOUR = 40;
const emailWindow = { startedAt: 0, count: 0 };
function allowAlertEmail(now = Date.now()) {
  if (now - emailWindow.startedAt > 60 * 60 * 1000) {
    emailWindow.startedAt = now;
    emailWindow.count = 0;
  }
  if (emailWindow.count >= EMAILS_PER_HOUR) return false;
  emailWindow.count += 1;
  return true;
}

function safeSubject(s) {
  return String(s).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Deliberately thin. The queue itself is the place to read a report, and this
// mail travels to inboxes we do not control, so it carries no reported content,
// no excerpt, no image and no reported-user identity. Reason and content type
// are fixed vocabularies from routes/moderation.js; the reporter name is UGC
// and is escaped. Copy follows SLOP-AUDIT.md: no em dashes, plain sentences.
function alertHtml(report) {
  const link = `${emailService.baseWebUrl()}/admin/moderation`;
  const rows = [
    ['Report', `#${escapeHtml(report.reportId)}`],
    ['Reason', escapeHtml(report.reason || 'not given')],
    ['Content type', escapeHtml(report.content_type || 'not given')],
    ['Reported by', escapeHtml(report.reporter || 'not given')],
  ].map(([k, v]) => `
        <tr>
          <td style="padding: 6px 16px 6px 0; color: #4a5568; font-size: 14px;">${k}</td>
          <td style="padding: 6px 0; color: #0d2847; font-size: 14px; font-weight: 600;">${v}</td>
        </tr>`).join('');

  return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <h1 style="font-size: 22px; font-weight: 700; color: #0d2847; margin-bottom: 8px;">A new report is in the queue</h1>
        <p style="font-size: 15px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Someone reported content in Flock. Open the queue to read it and decide.
        </p>
        <table style="border-collapse: collapse; margin-bottom: 24px;">${rows}
        </table>
        <p style="margin: 0 0 24px;">
          <a href="${escapeHtml(link)}" style="display: inline-block; background: #0d2847; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 600;">Open the moderation queue</a>
        </p>
        <p style="font-size: 13px; color: #a0aec0; line-height: 1.6;">
          The report text is not in this email on purpose. Read it in the queue.
        </p>
      </div>
    `;
}

// Returns a summary of what each leg actually did. Callers ignore it; the tests
// and the log line do not.
async function alertModerators(io, report = {}) {
  const summary = {
    logged: false,
    admins: 0,
    onlineAdmins: 0,
    emailRecipients: [],
    emailSent: 0,
    emailSkipped: false,
    pushAttempts: 0,
    adminLookupFailed: false,
  };
  const label = `${report.reason || 'report'} • ${report.content_type || ''}${report.reporter ? ` • by ${report.reporter}` : ''}`;

  // LEG 1, first and unconditionally. The old version logged this AFTER the
  // admin lookup, inside the same try, so a database failure lost the only
  // record that a report had ever been filed: the catch printed the pg error
  // and not one word about the report.
  console.warn(`[MODERATION] New report #${report.reportId}: ${label}`);
  summary.logged = true;

  try {
    // One database round trip for both remaining legs. Its own try: losing the
    // admin list must degrade to the configured/fallback email address, not
    // cancel the alert.
    let admins = [];
    try {
      const r = await pool.query("SELECT id, email FROM users WHERE role = 'admin'");
      admins = r.rows || [];
    } catch (dbErr) {
      // "The lookup failed" and "there are no admins" are different facts and
      // must not print the same sentence, or an outage reads as a
      // misconfiguration and gets fixed by setting an environment variable that
      // was already set.
      summary.adminLookupFailed = true;
      console.error(`[MODERATION] report #${report.reportId}: admin lookup failed (${dbErr.message}). Falling back to the configured alert address.`);
    }
    summary.admins = admins.length;

    // ---- LEG 3 FIRST: socket + push ---------------------------------------
    // Ordered ahead of the mail deliberately. These emits are synchronous and
    // local; the Resend call below is a network round trip with an 8s deadline
    // (utils/upstream.js). Awaiting mail first would hold the one channel that
    // can reach a moderator who is looking at the app RIGHT NOW behind the one
    // that lands in an inbox, which is backwards for the whole point of this
    // service. Nothing here awaits.
    for (const a of admins) {
      if (io) {
        // Kept, and kept honest: no client registers `moderation_report` yet
        // (see the header), so this is delivered to a connection that ignores
        // it. Counted by whether a connection EXISTS, not by whether an emit
        // was issued, so the summary cannot overstate reach.
        io.to(`user:${a.id}`).emit('moderation_report', { reportId: report.reportId, ...report });
        if (pushHelper && pushHelper.isUserOnline && pushHelper.isUserOnline(io, a.id)) {
          summary.onlineAdmins += 1;
        }
      }
      if (pushHelper && pushHelper.pushIfOffline) {
        summary.pushAttempts += 1;
        pushHelper
          .pushIfOffline(io, a.id, 'New content report', label, {
            type: 'moderation_report',
            reportId: String(report.reportId || ''),
          })
          .catch(() => {});
      }
    }

    // ---- LEG 2: email -----------------------------------------------------
    const configured = configuredRecipients();
    const adminAddresses = admins.map((a) => a.email).filter(isMailable);
    const wanted = [...configured, ...adminAddresses];
    let recipients = dedupe(wanted);
    // Truncation is a silent no-op for whoever fell off the end, so it is named.
    if (wanted.length > recipients.length && recipients.length === MAX_RECIPIENTS) {
      console.error(`[MODERATION] report #${report.reportId}: more than ${MAX_RECIPIENTS} alert addresses resolved; only the first ${MAX_RECIPIENTS} were mailed. Use a distribution list in MODERATION_ALERT_EMAIL instead of many admin rows.`);
    }
    if (recipients.length === 0) recipients = [MODERATION_INBOX];
    summary.emailRecipients = recipients;

    if (!process.env.RESEND_API_KEY) {
      summary.emailSkipped = true;
      console.error(`[MODERATION] report #${report.reportId}: NO EMAIL SENT. RESEND_API_KEY is not set, so the email leg is off and this log line is the only record.`);
    } else if (!allowAlertEmail()) {
      summary.emailSkipped = true;
      console.error(`[MODERATION] report #${report.reportId}: NO EMAIL SENT. More than ${EMAILS_PER_HOUR} alert emails in the last hour, so this one was held back. Read the queue at ${emailService.baseWebUrl()}/admin/moderation.`);
    } else {
      // A subject is a header, not a body: a CR/LF in one is header injection.
      // `reason` comes from the fixed VALID_REASONS vocabulary in routes/
      // moderation.js today, but this function is reachable from anywhere and
      // must not depend on its caller having validated for it.
      const subject = safeSubject(`New Flock report #${report.reportId} (${report.reason || 'report'})`);
      const html = alertHtml(report);
      const results = await Promise.all(
        recipients.map((to) => emailService.sendEmail({ to, subject, html }).catch((e) => ({ sent: false, error: e.message })))
      );
      summary.emailSent = results.filter((r) => r && r.sent).length;
      if (summary.emailSent === 0) {
        console.error(`[MODERATION] report #${report.reportId}: EMAIL FAILED for every recipient (${recipients.join(', ')}). Nobody was mailed.`);
      }
    }

    // The summary line. This is what makes "nobody was paged" visibly different
    // from "everybody was paged" in the log.
    const mailOutcome = `Email went to ${recipients.join(', ')}${summary.emailSkipped ? ' (skipped)' : ` (${summary.emailSent} delivered)`}.`;
    if (summary.adminLookupFailed) {
      console.error(`[MODERATION] report #${report.reportId}: the admin list could not be read, so nothing was emitted to a person in the app. This is a database failure, not a missing setting. ${mailOutcome}`);
    } else if (summary.admins === 0) {
      console.error(`[MODERATION] report #${report.reportId}: NO ADMIN ACCOUNTS EXIST. Nothing was emitted to a person in the app. Set ADMIN_USER_IDS on the deployment. ${mailOutcome}`);
    } else {
      console.warn(`[MODERATION] report #${report.reportId} alert: ${summary.admins} admin(s), ${summary.onlineAdmins} connected, email ${summary.emailSkipped ? 'SKIPPED' : `${summary.emailSent}/${recipients.length} delivered`}.`);
    }
    return summary;
  } catch (err) {
    // The report is already in the log above, so this can only ever lose the
    // notification, never the report.
    console.error(`[MODERATION] report #${report.reportId}: alerting failed after logging (${err.message}). The report is in the queue; nobody was notified.`);
    return summary;
  }
}

module.exports = {
  alertModerators,
  // Test seams: the hourly window is process-global, and the pure helpers are
  // the parts worth pinning.
  __testing: {
    isMailable,
    dedupe,
    configuredRecipients,
    allowAlertEmail,
    safeSubject,
    alertHtml,
    MODERATION_INBOX,
    EMAILS_PER_HOUR,
    MAX_RECIPIENTS,
    resetEmailWindow: () => { emailWindow.startedAt = 0; emailWindow.count = 0; },
  },
};
