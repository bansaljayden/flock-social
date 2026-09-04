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

// ---------------------------------------------------------------------------
// Child-safety reports — 18 U.S.C. § 2258A.
//
// Flock is a "provider" under § 2258E (an electronic communication service
// offered to the public), and the statute has NO size floor: the duty attaches
// at one user. On actual knowledge of apparent child sexual abuse material
// (or enticement / trafficking of a minor — §§ 2251, 2252, 2252A, 2422(b),
// 1591), federal law requires a report to the NCMEC CyberTipline "as soon as
// reasonably possible" and one year of evidence preservation (§ 2258A(h), as
// amended by the REPORT Act, Pub. L. 118-59). Knowing and willful failure to
// report is a federal offense with six-figure fines (§ 2258A(e)).
//
// "Actual knowledge" arrives through exactly one channel in this app: a human
// reads a report and looks at the content. The report vocabulary
// (routes/moderation.js VALID_REASONS) has no dedicated child-safety reason —
// adding one needs a client change and coordinated copy — so on a 13+ app the
// reason a CSAM report lands under is 'sexual'. Those reports must not read
// like one more row in the queue: they get a distinct log token, a distinct
// subject line, a statutory note in the mail body, and their OWN email rate
// window, so a brigade of spam reports can never exhaust the ceiling out from
// under the one category with criminal-law stakes.
//
// The full operator runbook — what to actually do when one of these is real —
// is MODERATION-LEGAL.md in the repo root. The alert points at it by name.
// ---------------------------------------------------------------------------
const CHILD_SAFETY_REASONS = new Set(['sexual']);
const CHILD_SAFETY_DOC = 'MODERATION-LEGAL.md';

function isChildSafetyReason(reason) {
  // Strings only, deliberately: `String(['sexual'])` coerces to 'sexual', and
  // a shape the route's scalarOnly validator would have refused must not be
  // able to trip (or dodge) the category by coercion.
  return typeof reason === 'string' && CHILD_SAFETY_REASONS.has(reason.trim().toLowerCase());
}

// The Apple placeholder (@apple-signin.invalid) and evicted-squat tombstones
// (@unclaimed.invalid) can never receive mail, and an admin row can hold
// either. Round 20: this was one of three private copies of that rule, and the
// three disagreed — routes/safety.js's copy accepted the .invalid addresses
// this one refuses, on the emergency path. The definition now lives in the one
// module that would have to do the delivering.
const { isMailableAddress: isMailable } = emailService;

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
//
// Round 20: the constant is named EMAILS_PER_HOUR and the counter was charged
// once per REPORT, which then fanned out to up to MAX_RECIPIENTS addresses. The
// real ceiling was therefore ten times the stated one — 400 sends an hour from
// a limiter that reads 40 — and the number that governs a paid quota was the
// one number in the file that did not mean what it said. It is charged per
// EMAIL now. That changes nothing for the production deployment, which has a
// single fallback recipient and still gets 40 reports an hour alerted; it only
// bites the many-admin-rows configuration the MAX_RECIPIENTS note already tells
// you not to build.
const EMAILS_PER_HOUR = 40;
const emailWindow = { startedAt: 0, count: 0 };

// Child-safety alerts spend from a SEPARATE window with the same ceiling. The
// generic window is exactly what a brigading incident fills first, and "the
// spam reports used up the quota" must never be the reason the one report with
// a federal reporting duty behind it went unmailed. Separate windows also cut
// the other way: forty child-safety alerts cannot silence the generic queue.
const childSafetyEmailWindow = { startedAt: 0, count: 0 };

// `cost` is the number of addresses this alert is about to mail. The whole
// alert is refused or allowed together: sending to four of ten recipients would
// be a partial page, which is harder to reason about than no page at all, and
// the log line below is what carries the report either way.
function chargeEmailWindow(win, cost = 1, now = Date.now()) {
  // A cost that is not a small positive integer is a caller bug, and charging
  // whatever it handed us would either exhaust the window on one alert or
  // silently charge nothing. One email is the honest floor.
  const charge = Number.isInteger(cost) && cost > 0 && cost <= MAX_RECIPIENTS ? cost : 1;
  if (now - win.startedAt > 60 * 60 * 1000) {
    win.startedAt = now;
    win.count = 0;
  }
  if (win.count + charge > EMAILS_PER_HOUR) return false;
  win.count += charge;
  return true;
}

function allowAlertEmail(cost = 1, now = Date.now()) {
  return chargeEmailWindow(emailWindow, cost, now);
}

function allowChildSafetyEmail(cost = 1, now = Date.now()) {
  return chargeEmailWindow(childSafetyEmailWindow, cost, now);
}

const { safeSubjectLine: safeSubject, escapeHtml } = emailService;

// A display name has no length of its own anywhere on the report path. It is
// interpolated into the log line, into `label` (which becomes the BODY of a
// push notification on a moderator's lock screen), and through the subject
// builder into a mail header. safeSubject caps the finished subject; nothing
// capped the other two, so one 4000-character profile name produced a 4000-
// character stderr line and a notification whose only actionable content — the
// report id — was pushed past whatever the lock screen truncates at.
const MAX_LABEL_FIELD = 60;
function labelField(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? '[not text]' : String(v);
  return s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_LABEL_FIELD);
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

  // The statutory note rides ONLY on child-safety reports. It names the duty,
  // the one thing not to do (delete), and the runbook, and nothing else: the
  // decision still happens in the queue, on the content, by a person.
  const childSafetyNote = isChildSafetyReason(report.reason) ? `
        <p style="font-size: 14px; color: #7b341e; background: #fffaf0; border: 1px solid #f6ad55; border-radius: 8px; padding: 12px 16px; line-height: 1.6; margin: 0 0 24px;">
          This report is in the sexual content category, and Flock users can be minors.
          If the content appears to involve a minor, federal law (18 U.S.C. 2258A) requires
          a report to the NCMEC CyberTipline and one year of evidence preservation.
          Do not delete the content. Follow the steps in ${CHILD_SAFETY_DOC} in the repo root before acting.
        </p>` : '';

  return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <h1 style="font-size: 22px; font-weight: 700; color: #0d2847; margin-bottom: 8px;">A new report is in the queue</h1>
        <p style="font-size: 15px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Someone reported content in Flock. Open the queue to read it and decide.
        </p>
        <table style="border-collapse: collapse; margin-bottom: 24px;">${rows}
        </table>${childSafetyNote}
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
async function alertModerators(io, rawReport = {}) {
  const summary = {
    logged: false,
    admins: 0,
    onlineAdmins: 0,
    emailRecipients: [],
    emailSent: 0,
    emailSkipped: false,
    pushAttempts: 0,
    pushFailures: 0,
    adminLookupFailed: false,
    usedFallbackInbox: false,
    childSafety: false,
  };

  // Round 20: the header promises "nothing in here is allowed to throw" and its
  // one caller (routes/moderation.js) fires this WITHOUT awaiting. But `label`
  // and the log line below it were built OUTSIDE the try, so a report that was
  // not a plain object — `null`, a string, an array — threw before the try
  // opened and rejected the promise. At that point the report is already
  // committed to the database, so the only thing lost is the notification, and
  // that is exactly the outcome the try/catch further down exists to guarantee.
  // Normalize once, here, and every field below is reading something known.
  const report = (rawReport && typeof rawReport === 'object' && !Array.isArray(rawReport)) ? rawReport : {};
  const reportId = labelField(report.reportId) || 'unknown';
  const label = [
    labelField(report.reason) || 'report',
    labelField(report.content_type),
    report.reporter ? `by ${labelField(report.reporter)}` : '',
  ].filter(Boolean).join(' • ');

  // LEG 1, first and unconditionally. The old version logged this AFTER the
  // admin lookup, inside the same try, so a database failure lost the only
  // record that a report had ever been filed: the catch printed the pg error
  // and not one word about the report.
  console.warn(`[MODERATION] New report #${reportId}: ${label}`);
  summary.logged = true;

  // Child-safety reports get a SECOND, distinct line, at error level, with a
  // stable greppable token — because on the day it matters, "the alert is
  // somewhere in the stderr stream between forty spam refusals" is the same
  // thing as no alert. Emitted here, before any database or network work, for
  // the same reason as the line above: it must survive everything below.
  const childSafety = isChildSafetyReason(report.reason);
  summary.childSafety = childSafety;
  if (childSafety) {
    console.error(
      `[MODERATION][CHILD-SAFETY] report #${reportId} is in the sexual-content category on a 13+ app. ` +
      `If review shows apparent CSAM, 18 U.S.C. 2258A requires a CyberTipline report and one year of evidence preservation. ` +
      `Do not delete the content. Read ${CHILD_SAFETY_DOC} before acting.`
    );
  }

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
      console.error(`[MODERATION] report #${reportId}: admin lookup failed (${dbErr.message}). Falling back to the configured alert address.`);
    }
    summary.admins = admins.length;

    // ---- LEG 3 FIRST: socket + push ---------------------------------------
    // Ordered ahead of the mail deliberately. These emits are synchronous and
    // local; the Resend call below is a network round trip with an 8s deadline
    // (utils/upstream.js). Awaiting mail first would hold the one channel that
    // can reach a moderator who is looking at the app RIGHT NOW behind the one
    // that lands in an inbox, which is backwards for the whole point of this
    // service. Nothing here awaits.
    // Every push is awaited before the summary is written, so the line that
    // says who was paged is written after the pages were attempted, not
    // before. This leg used to be fire-and-forget with .catch(() => {}):
    // pushAttempts was counted, never printed, and a rejection vanished, so
    // the one file whose stated job is making "nobody was paged" visibly
    // different from "everybody was paged" could not report the one channel
    // that reaches a human in real time (no client registers the socket
    // event). The email leg names every failure; this leg now does too.
    const pushes = [];
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
        pushes.push(
          pushHelper
            .pushIfOffline(io, a.id, childSafety ? 'Child safety report' : 'New content report', label, {
              type: 'moderation_report',
              reportId: String(report.reportId || ''),
            })
            .catch((e) => {
              summary.pushFailures += 1;
              console.error(`[MODERATION] report #${reportId}: push to admin ${a.id} FAILED: ${e && e.message ? e.message : e}`);
            })
        );
      }
    }

    // ---- LEG 2: email -----------------------------------------------------
    await Promise.allSettled(pushes);
    const configured = configuredRecipients();
    const adminAddresses = admins.map((a) => a.email).filter(isMailable);
    const wanted = [...configured, ...adminAddresses];
    let recipients = dedupe(wanted);
    // Truncation is a silent no-op for whoever fell off the end, so it is named.
    if (wanted.length > recipients.length && recipients.length === MAX_RECIPIENTS) {
      console.error(`[MODERATION] report #${reportId}: more than ${MAX_RECIPIENTS} alert addresses resolved; only the first ${MAX_RECIPIENTS} were mailed. Use a distribution list in MODERATION_ALERT_EMAIL instead of many admin rows.`);
    }
    // Round 20. TASKS.md records MODERATION_ALERT_EMAIL as UNSET in production,
    // and this branch is what that looks like from the outside: the report is
    // mailed to a hardcoded address, and every line below names that address
    // without ever saying it is the last resort standing in for a setting
    // nobody made. An operator reading "Email went to hello@flockcorp.com
    // (1 delivered)" cannot tell a configured deployment from an unconfigured
    // one, which is the same silent-no-op this whole file exists to stop. The
    // zero-admins case has named ADMIN_USER_IDS since round 18; this is the
    // other half of the same sentence and it was mute.
    if (recipients.length === 0) {
      recipients = [MODERATION_INBOX];
      summary.usedFallbackInbox = true;
      console.error(`[MODERATION] report #${reportId}: MODERATION_ALERT_EMAIL is not set and no admin row has a mailable address, so this alert went to the fallback inbox ${MODERATION_INBOX} instead of to whoever is on duty. Set MODERATION_ALERT_EMAIL on the deployment.`);
    }
    summary.emailRecipients = recipients;

    // Round 20: these two lines named every recipient verbatim. They are staff
    // addresses rather than a minor's parent's, so the stakes are lower than on
    // the SOS path, but it is the same rule and there is no reason for the
    // alerting service to be the one exception to it. The domain is what makes
    // a delivery problem diagnosable; the local part is not.
    const shownRecipients = () => recipients.map(emailService.maskAddress).join(', ');

    if (!process.env.RESEND_API_KEY) {
      summary.emailSkipped = true;
      console.error(`[MODERATION] report #${reportId}: NO EMAIL SENT. RESEND_API_KEY is not set, so the email leg is off and this log line is the only record.`);
    } else if (!(childSafety ? allowChildSafetyEmail : allowAlertEmail)(recipients.length)) {
      // Child-safety alerts are charged to their own window (see the note on
      // childSafetyEmailWindow): spam reports can exhaust the generic ceiling
      // without ever touching this category's budget.
      summary.emailSkipped = true;
      console.error(`[MODERATION] report #${reportId}: NO EMAIL SENT. The ${EMAILS_PER_HOUR}-email hourly ceiling${childSafety ? ' for child-safety alerts' : ''} would have been crossed by this alert's ${recipients.length} recipient(s), so it was held back. Read the queue at ${emailService.baseWebUrl()}/admin/moderation.`);
    } else {
      // A subject is a header, not a body: a CR/LF in one is header injection.
      // `reason` comes from the fixed VALID_REASONS vocabulary in routes/
      // moderation.js today, but this function is reachable from anywhere and
      // must not depend on its caller having validated for it.
      const subject = safeSubject(`${childSafety ? 'CHILD SAFETY: ' : ''}New Flock report #${reportId} (${labelField(report.reason) || 'report'})`);
      const html = alertHtml({ ...report, reportId });
      const results = await Promise.all(
        recipients.map((to) => emailService.sendEmail({ to, subject, html }).catch((e) => ({ sent: false, error: e.message })))
      );
      summary.emailSent = results.filter((r) => r && r.sent).length;
      if (summary.emailSent === 0) {
        console.error(`[MODERATION] report #${reportId}: EMAIL FAILED for every recipient (${shownRecipients()}). Nobody was mailed.`);
      }
    }

    // The summary line. This is what makes "nobody was paged" visibly different
    // from "everybody was paged" in the log.
    const mailOutcome = `Email went to ${shownRecipients()}${summary.emailSkipped ? ' (skipped)' : ` (${summary.emailSent} delivered)`}.`;
    if (summary.adminLookupFailed) {
      console.error(`[MODERATION] report #${reportId}: the admin list could not be read, so nothing was emitted to a person in the app. This is a database failure, not a missing setting. ${mailOutcome}`);
    } else if (summary.admins === 0) {
      console.error(`[MODERATION] report #${reportId}: NO ADMIN ACCOUNTS EXIST. Nothing was emitted to a person in the app. Set ADMIN_USER_IDS on the deployment. ${mailOutcome}`);
    } else {
      console.warn(`[MODERATION] report #${reportId} alert: ${summary.admins} admin(s), ${summary.onlineAdmins} connected, email ${summary.emailSkipped ? 'SKIPPED' : `${summary.emailSent}/${recipients.length} delivered`}, push ${summary.pushAttempts - summary.pushFailures}/${summary.pushAttempts} sent.`);
    }
    return summary;
  } catch (err) {
    // The report is already in the log above, so this can only ever lose the
    // notification, never the report.
    console.error(`[MODERATION] report #${reportId}: alerting failed after logging (${err.message}). The report is in the queue; nobody was notified.`);
    return summary;
  }
}

module.exports = {
  alertModerators,
  // Not a test seam. The alert path and the moderation QUEUE have to agree on
  // which reports carry a federal reporting duty, and the queue used to make
  // that decision nowhere at all: a 'sexual' report got a distinct subject line
  // in the mail and rendered in the console as one more row, beside the same
  // Hide and Ban buttons MODERATION-LEGAL.md § 4 step 2 says not to press yet.
  // routes/admin.js reads this, so widening CHILD_SAFETY_REASONS widens both.
  isChildSafetyReason,
  CHILD_SAFETY_DOC,
  // Test seams: the hourly window is process-global, and the pure helpers are
  // the parts worth pinning.
  __testing: {
    isMailable,
    dedupe,
    configuredRecipients,
    allowAlertEmail,
    allowChildSafetyEmail,
    isChildSafetyReason,
    safeSubject,
    labelField,
    alertHtml,
    MODERATION_INBOX,
    EMAILS_PER_HOUR,
    MAX_RECIPIENTS,
    CHILD_SAFETY_REASONS,
    CHILD_SAFETY_DOC,
    resetEmailWindow: () => {
      emailWindow.startedAt = 0;
      emailWindow.count = 0;
      childSafetyEmailWindow.startedAt = 0;
      childSafetyEmailWindow.count = 0;
    },
  },
};
