// ---------------------------------------------------------------------------
// Moderation tooling — services/moderationAlerts.js
//
// THE BUG THIS FILE PINS
// The alerting service claimed more than it did in three separate directions,
// and every one of the failures was silent:
//
//   * its one caller (routes/moderation.js) comments the call as "push/email"
//     and there was no email leg at all;
//   * push is inert unless FIREBASE_SERVICE_ACCOUNT is set, and the socket emit
//     only lands on an admin who has the app open;
//   * with no users row holding role='admin' the whole function did nothing,
//     and role='admin' is granted only by ADMIN_USER_IDS at boot, so on a
//     deployment where that is unset a report reached NOBODY.
//
// On top of that, the one unconditional log line was emitted AFTER the admin
// lookup and inside the same try, so a database failure in this function threw
// the report away entirely: the catch printed a pg error and not one word about
// the report that had just been filed.
//
// The assertions below are about REACH and about the log being honest, not
// about wording.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

const pool = require('../config/database');
const emailService = require('../services/emailService');
const alerts = require('../services/moderationAlerts');
const { alertModerators, __testing } = alerts;

// ---------------------------------------------------------------------------
// Harness: capture the console, the pool, and the Resend wrapper.
// ---------------------------------------------------------------------------
function harness({ admins = [], dbThrows = false, resendKey = null, alertEnv = undefined } = {}) {
  const realQuery = pool.query;
  const realSend = emailService.sendEmail;
  const realWarn = console.warn;
  const realError = console.error;
  const realKey = process.env.RESEND_API_KEY;
  const realAlertEnv = process.env.MODERATION_ALERT_EMAIL;

  const logs = { warn: [], error: [] };
  const mails = [];

  console.warn = (...a) => logs.warn.push(a.join(' '));
  console.error = (...a) => logs.error.push(a.join(' '));

  pool.query = async (text) => {
    if (dbThrows) throw new Error('connection terminated');
    if (String(text).includes("role = 'admin'")) return { rows: admins };
    return { rows: [], rowCount: 0 };
  };

  emailService.sendEmail = async (msg) => {
    mails.push(msg);
    return { sent: true, id: 'test' };
  };

  if (resendKey === null) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = resendKey;
  if (alertEnv === undefined) delete process.env.MODERATION_ALERT_EMAIL;
  else process.env.MODERATION_ALERT_EMAIL = alertEnv;

  __testing.resetEmailWindow();

  return {
    logs,
    mails,
    all: () => [...logs.warn, ...logs.error].join('\n'),
    restore() {
      pool.query = realQuery;
      emailService.sendEmail = realSend;
      console.warn = realWarn;
      console.error = realError;
      if (realKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = realKey;
      if (realAlertEnv === undefined) delete process.env.MODERATION_ALERT_EMAIL;
      else process.env.MODERATION_ALERT_EMAIL = realAlertEnv;
      __testing.resetEmailWindow();
    },
  };
}

const REPORT = { reportId: 42, content_type: 'dm', reason: 'harassment', reporter: 'Reporter <b>X</b>' };

// ===========================================================================
// A. The email leg exists, and reaches somebody even with zero admins
// ===========================================================================

test('alerting: with no admin accounts at all a report still reaches a mailbox', async () => {
  const h = harness({ admins: [], resendKey: 'test-key' });
  try {
    const s = await alertModerators(null, REPORT);
    assert.strictEqual(s.admins, 0, 'the scenario is zero admins');
    // THE FIX: the old code emitted to nobody and sent nothing.
    assert.strictEqual(h.mails.length, 1, 'one fallback recipient must be mailed');
    assert.strictEqual(h.mails[0].to, __testing.MODERATION_INBOX);
    assert.strictEqual(s.emailSent, 1);
  } finally { h.restore(); }
});

test('alerting: zero admins is LOUD, not silent', async () => {
  const h = harness({ admins: [], resendKey: 'test-key' });
  try {
    await alertModerators(null, REPORT);
    // The condition has to be nameable from the log, and it has to say what to
    // do about it. ADMIN_USER_IDS is the only thing that grants the role.
    const errors = h.logs.error.join('\n');
    assert.match(errors, /NO ADMIN ACCOUNTS EXIST/);
    assert.match(errors, /ADMIN_USER_IDS/);
  } finally { h.restore(); }
});

test('alerting: admins are mailed at their own addresses', async () => {
  const h = harness({
    admins: [{ id: 1, email: 'mod1@flockcorp.com' }, { id: 2, email: 'mod2@flockcorp.com' }],
    resendKey: 'test-key',
  });
  try {
    const s = await alertModerators(null, REPORT);
    assert.deepStrictEqual(h.mails.map((m) => m.to).sort(), ['mod1@flockcorp.com', 'mod2@flockcorp.com']);
    assert.strictEqual(s.emailSent, 2);
    // The fallback inbox is for the no-recipient case only.
    assert.ok(!h.mails.some((m) => m.to === __testing.MODERATION_INBOX));
  } finally { h.restore(); }
});

test('alerting: MODERATION_ALERT_EMAIL is honoured and deduped against admin rows', async () => {
  const h = harness({
    admins: [{ id: 1, email: 'MOD1@flockcorp.com' }],
    resendKey: 'test-key',
    alertEnv: 'oncall@flockcorp.com, mod1@flockcorp.com , not-an-email',
  });
  try {
    await alertModerators(null, REPORT);
    const to = h.mails.map((m) => m.to.toLowerCase()).sort();
    assert.deepStrictEqual(to, ['mod1@flockcorp.com', 'oncall@flockcorp.com'],
      'the same mailbox must not be mailed twice, and junk must be dropped');
  } finally { h.restore(); }
});

test('alerting: unmailable admin addresses are skipped, not mailed', async () => {
  // routes/auth.js stores @apple-signin.invalid placeholders and
  // @unclaimed.invalid squat tombstones. Neither can receive mail.
  const h = harness({
    admins: [
      { id: 1, email: 'released+7.abc@unclaimed.invalid' },
      { id: 2, email: 'sub123@apple-signin.invalid' },
    ],
    resendKey: 'test-key',
  });
  try {
    await alertModerators(null, REPORT);
    assert.strictEqual(h.mails.length, 1);
    assert.strictEqual(h.mails[0].to, __testing.MODERATION_INBOX,
      'an unreachable admin address must fall through to the real inbox');
  } finally { h.restore(); }
});

// ===========================================================================
// B. Every leg that does nothing says so
// ===========================================================================

test('alerting: a missing RESEND_API_KEY is reported as no email sent', async () => {
  const h = harness({ admins: [{ id: 1, email: 'mod1@flockcorp.com' }], resendKey: null });
  try {
    const s = await alertModerators(null, REPORT);
    assert.strictEqual(h.mails.length, 0);
    assert.strictEqual(s.emailSkipped, true);
    assert.match(h.logs.error.join('\n'), /NO EMAIL SENT/);
    assert.match(h.logs.error.join('\n'), /RESEND_API_KEY/);
  } finally { h.restore(); }
});

test('alerting: the report line is logged BEFORE any database work, so a db failure cannot lose it', async () => {
  const h = harness({ dbThrows: true, resendKey: 'test-key' });
  try {
    const s = await alertModerators(null, REPORT);
    // THE BUG: the old console.warn ran after the admin lookup, inside the same
    // try, so this scenario logged a pg error and nothing about report #42.
    assert.strictEqual(s.logged, true);
    assert.match(h.all(), /New report #42/);
    assert.match(h.all(), /harassment/);
    // And the alert still degrades to the fallback mailbox rather than dying.
    assert.strictEqual(h.mails.length, 1);
    assert.strictEqual(h.mails[0].to, __testing.MODERATION_INBOX);
  } finally { h.restore(); }
});

test('alerting: a failed admin lookup is not reported as "no admins exist"', async () => {
  const h = harness({ dbThrows: true, resendKey: 'test-key' });
  try {
    const s = await alertModerators(null, REPORT);
    assert.strictEqual(s.adminLookupFailed, true);
    const errors = h.logs.error.join('\n');
    // An outage that reads as a missing setting gets "fixed" by re-setting a
    // variable that was already correct, while the real fault goes unlooked-at.
    assert.ok(!/NO ADMIN ACCOUNTS EXIST/.test(errors),
      'a database failure must not be logged as a misconfiguration');
    assert.match(errors, /database failure, not a missing setting/);
  } finally { h.restore(); }
});

test('alerting: the socket leg is not held behind the network email call', async () => {
  // The socket emit is the only channel that reaches a moderator who is looking
  // at the app right now. Resend carries an 8s deadline, so ordering mail first
  // would delay the instant leg by up to 8 seconds for no reason.
  const order = [];
  const io = {
    to() { return { emit: () => order.push('socket') }; },
    sockets: { adapter: { rooms: new Map() } },
  };
  const h = harness({ admins: [{ id: 7, email: 'mod@flockcorp.com' }], resendKey: 'test-key' });
  emailService.sendEmail = async () => {
    order.push('email');
    return { sent: true };
  };
  try {
    await alertModerators(io, REPORT);
    assert.deepStrictEqual(order, ['socket', 'email']);
  } finally { h.restore(); }
});

test('alerting: never throws and never rejects, whatever fails', async () => {
  const h = harness({ admins: [{ id: 1, email: 'mod1@flockcorp.com' }], resendKey: 'test-key' });
  emailService.sendEmail = async () => { throw new Error('resend exploded'); };
  try {
    // Callers do `alertModerators(...).catch(() => {})` on the reporter's
    // request path; an unhandled rejection here is a crashed report submission.
    const s = await alertModerators(null, REPORT);
    assert.strictEqual(s.emailSent, 0);
    assert.match(h.logs.error.join('\n'), /EMAIL FAILED/);
  } finally { h.restore(); }
});

test('alerting: a burst is capped, and every suppressed alert is logged at error level', async () => {
  const h = harness({ admins: [], resendKey: 'test-key' });
  try {
    for (let i = 0; i < __testing.EMAILS_PER_HOUR; i++) {
      await alertModerators(null, { ...REPORT, reportId: i });
    }
    assert.strictEqual(h.mails.length, __testing.EMAILS_PER_HOUR);
    h.logs.error.length = 0;
    const s = await alertModerators(null, { ...REPORT, reportId: 999 });
    assert.strictEqual(s.emailSkipped, true, 'past the cap nothing more is mailed');
    const errors = h.logs.error.join('\n');
    assert.match(errors, /NO EMAIL SENT/);
    assert.match(errors, /#999/, 'a held-back alert must name its report id');
  } finally { h.restore(); }
});

// ===========================================================================
// C. Socket reach is counted honestly, and the push contract is unchanged
// ===========================================================================

test('alerting: the socket leg still emits moderation_report to each admin room', async () => {
  const emits = [];
  const io = {
    to(room) { return { emit: (event, payload) => emits.push({ room, event, payload }) }; },
    sockets: { adapter: { rooms: new Map() } },
  };
  const h = harness({ admins: [{ id: 7, email: 'mod@flockcorp.com' }], resendKey: 'test-key' });
  try {
    const s = await alertModerators(io, REPORT);
    assert.deepStrictEqual(emits.map((e) => [e.room, e.event]), [['user:7', 'moderation_report']]);
    assert.strictEqual(emits[0].payload.reportId, 42);
    // No socket is in that room, so reach is zero and the summary must say so
    // rather than counting the emit it issued.
    assert.strictEqual(s.onlineAdmins, 0);
  } finally { h.restore(); }
});

test('alerting: a connected admin is counted as reached', async () => {
  const rooms = new Map([['user:7', new Set(['sock1'])]]);
  const io = {
    to() { return { emit: () => {} }; },
    sockets: { adapter: { rooms } },
  };
  const h = harness({ admins: [{ id: 7, email: 'mod@flockcorp.com' }], resendKey: 'test-key' });
  try {
    const s = await alertModerators(io, REPORT);
    assert.strictEqual(s.onlineAdmins, 1);
  } finally { h.restore(); }
});

// ===========================================================================
// D. The mail itself
// ===========================================================================

test('alert email: carries no reported content and escapes the reporter name', () => {
  const html = __testing.alertHtml(REPORT);
  // The reporter name is UGC rendered outside our own client.
  assert.ok(!html.includes('<b>X</b>'), 'UGC must be escaped');
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
  // Deliberately thin: the queue is where a report is read.
  assert.match(html, /\/admin\/moderation/);
  // SLOP-AUDIT.md rule 1: no em dashes in user-visible text.
  assert.ok(!html.includes('—'), 'no em dashes in email copy');
});

test('alert email: the link is the pinned production web base, never a request host', () => {
  const html = __testing.alertHtml(REPORT);
  assert.ok(html.includes(`${emailService.baseWebUrl()}/admin/moderation`));
  assert.ok(!/localhost/i.test(html));
});

test('recipient validation: rejects the shapes that cannot receive mail', () => {
  const { isMailable } = __testing;
  assert.strictEqual(isMailable('mod@flockcorp.com'), true);
  assert.strictEqual(isMailable('x@apple-signin.invalid'), false);
  assert.strictEqual(isMailable('x@unclaimed.invalid'), false);
  assert.strictEqual(isMailable('no-at-sign'), false);
  assert.strictEqual(isMailable('a@b'), false);
  assert.strictEqual(isMailable(''), false);
  assert.strictEqual(isMailable(null), false);
  assert.strictEqual(isMailable('a b@c.com'), false);
});

test('alert email: the subject cannot carry a header injection', () => {
  const { safeSubject } = __testing;
  assert.strictEqual(safeSubject('a\r\nBcc: victim@x.com'), 'a Bcc: victim@x.com');
  assert.ok(!/[\r\n]/.test(safeSubject('x\ny\rz')));
  assert.ok(safeSubject('x'.repeat(500)).length <= 200);
});

test('alert email: a caller-supplied reason reaches the subject already sanitised', async () => {
  const h = harness({ admins: [], resendKey: 'test-key' });
  try {
    await alertModerators(null, { ...REPORT, reason: 'harassment\r\nBcc: victim@x.com' });
    assert.strictEqual(h.mails.length, 1);
    assert.ok(!/[\r\n]/.test(h.mails[0].subject));
  } finally { h.restore(); }
});

test('recipient list: is capped so one misconfiguration cannot fan out without limit', () => {
  const many = Array.from({ length: 50 }, (_, i) => `mod${i}@flockcorp.com`);
  assert.strictEqual(__testing.dedupe(many).length, __testing.MAX_RECIPIENTS);
});

test('recipient list: truncating the list is logged, not silent', async () => {
  const admins = Array.from({ length: 50 }, (_, i) => ({ id: i, email: `mod${i}@flockcorp.com` }));
  const h = harness({ admins, resendKey: 'test-key' });
  try {
    await alertModerators(null, REPORT);
    assert.strictEqual(h.mails.length, __testing.MAX_RECIPIENTS);
    assert.match(h.logs.error.join('\n'), /only the first \d+ were mailed/);
  } finally { h.restore(); }
});

test('config: a typo in MODERATION_ALERT_EMAIL is named, not silently dropped', async () => {
  const h = harness({ admins: [], resendKey: 'test-key', alertEnv: 'oncall@flockcorp,good@flockcorp.com' });
  try {
    await alertModerators(null, REPORT);
    // The good half still goes out.
    assert.deepStrictEqual(h.mails.map((m) => m.to), ['good@flockcorp.com']);
    // The bad half is not silently equivalent to never setting the variable.
    assert.match(h.logs.error.join('\n'), /cannot receive mail and were ignored/);
    assert.match(h.logs.error.join('\n'), /oncall@flockcorp/);
  } finally { h.restore(); }
});
