// ---------------------------------------------------------------------------
// Child-safety alerting — 18 U.S.C. § 2258A visibility (MODERATION-LEGAL.md)
//
// THE GAP THIS FILE PINS
// The statutory duty (report apparent CSAM to the NCMEC CyberTipline, preserve
// evidence for one year) triggers on ACTUAL KNOWLEDGE, and knowledge arrives
// through a human reading a report. Before this file's changes, the one report
// category that can carry that duty was indistinguishable from spam noise in
// every channel: same log line, same mail subject, same rate window — and a
// hard adult flag from SafeSearch logged the same generic fail-closed line as
// a quota error. Every assertion below is about the child-safety path staying
// DISTINCT and never being silently starved by the generic one.
//
// What is deliberately NOT asserted: that SafeSearch detects CSAM (it cannot
// judge age; the [CHILD-SAFETY] token on hard adult flags is a pattern signal,
// not knowledge), and that any of this fulfils the legal duty by itself (the
// runbook is MODERATION-LEGAL.md; this file pins that the code keeps pointing
// at it).
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Production posture, set before require (both flags are read at require time).
process.env.IMAGE_MODERATION_REQUIRED = 'true';
process.env.VISION_API_KEY = 'test-key';

const pool = require('../config/database');
const emailService = require('../services/emailService');
const alerts = require('../services/moderationAlerts');
const moderation = require('../utils/moderation');
const { alertModerators, __testing } = alerts;

// ---------------------------------------------------------------------------
// Harness — same shape as moderationTooling.test.js: capture the console, the
// pool, and the Resend wrapper.
// ---------------------------------------------------------------------------
function harness({ admins = [], resendKey = 'test-key', alertEnv = undefined } = {}) {
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

const SEXUAL_REPORT = { reportId: 7, content_type: 'story', reason: 'sexual', reporter: 'Ava' };
const GENERIC_REPORT = { reportId: 8, content_type: 'dm', reason: 'harassment', reporter: 'Ava' };

// ===========================================================================
// A. A child-safety report is DISTINCT in every channel
// ===========================================================================

test('child safety: a sexual-content report carries the [CHILD-SAFETY] token, the statute, and the runbook in the log', async () => {
  const h = harness();
  try {
    const s = await alertModerators(null, SEXUAL_REPORT);
    assert.strictEqual(s.childSafety, true, 'the summary must name the category');
    const errors = h.logs.error.join('\n');
    assert.match(errors, /\[CHILD-SAFETY\]/, 'the greppable token is the whole point');
    assert.match(errors, /#7/, 'the token line must carry the report id');
    assert.match(errors, /2258A/, 'the statute must be nameable from the log');
    assert.match(errors, /MODERATION-LEGAL\.md/, 'the log must point at the runbook');
  } finally { h.restore(); }
});

test('child safety: the mail subject is distinct and the body names the duty without carrying content', async () => {
  const h = harness();
  try {
    await alertModerators(null, SEXUAL_REPORT);
    assert.strictEqual(h.mails.length, 1);
    assert.match(h.mails[0].subject, /^CHILD SAFETY: /,
      'a moderator triaging an inbox must be able to tell this category apart at a glance');
    assert.match(h.mails[0].html, /2258A/);
    assert.match(h.mails[0].html, /CyberTipline/);
    assert.match(h.mails[0].html, /MODERATION-LEGAL\.md/);
    assert.match(h.mails[0].html, /Do not delete the content/);
  } finally { h.restore(); }
});

test('child safety: a generic report is NOT dressed up as one', async () => {
  // The control. Crying child-safety at every harassment report is how the
  // token gets tuned out before the day it matters.
  const h = harness();
  try {
    const s = await alertModerators(null, GENERIC_REPORT);
    assert.strictEqual(s.childSafety, false);
    assert.ok(!h.all().includes('[CHILD-SAFETY]'), 'no token on generic reports');
    assert.strictEqual(h.mails.length, 1);
    assert.ok(!h.mails[0].subject.includes('CHILD SAFETY'), h.mails[0].subject);
    assert.ok(!h.mails[0].html.includes('2258A'), 'the statutory note rides only on child-safety reports');
  } finally { h.restore(); }
});

test('child safety: the token line survives a total database failure', async () => {
  // Same doctrine as leg 1: the line is emitted before any database work.
  const h = harness();
  const realQuery = pool.query;
  pool.query = async () => { throw new Error('connection terminated'); };
  try {
    await alertModerators(null, SEXUAL_REPORT);
    assert.match(h.logs.error.join('\n'), /\[CHILD-SAFETY\]/);
  } finally { pool.query = realQuery; h.restore(); }
});

// ===========================================================================
// B. Rate-window isolation — spam cannot starve the child-safety channel
// ===========================================================================

test('child safety: exhausting the generic email ceiling does not suppress a child-safety alert', async () => {
  const h = harness();
  try {
    for (let i = 0; i < __testing.EMAILS_PER_HOUR; i++) {
      await alertModerators(null, { ...GENERIC_REPORT, reportId: i });
    }
    assert.strictEqual(h.mails.length, __testing.EMAILS_PER_HOUR, 'generic window is now full');
    // The 41st generic report is held back...
    const generic = await alertModerators(null, { ...GENERIC_REPORT, reportId: 900 });
    assert.strictEqual(generic.emailSkipped, true);
    // ...and the child-safety report is NOT. This is the assertion this whole
    // test file exists for.
    const s = await alertModerators(null, { ...SEXUAL_REPORT, reportId: 901 });
    assert.strictEqual(s.emailSkipped, false,
      'a brigade of spam reports must never exhaust the ceiling out from under the one category with a federal duty behind it');
    assert.strictEqual(h.mails.length, __testing.EMAILS_PER_HOUR + 1);
    assert.match(h.mails[h.mails.length - 1].subject, /^CHILD SAFETY: /);
  } finally { h.restore(); }
});

test('child safety: the reverse also holds, and the child-safety window has its own loud ceiling', async () => {
  const h = harness();
  try {
    for (let i = 0; i < __testing.EMAILS_PER_HOUR; i++) {
      await alertModerators(null, { ...SEXUAL_REPORT, reportId: i });
    }
    // Its own ceiling exists (Resend quota is finite even for this category),
    // and crossing it is loud, with the report id.
    const over = await alertModerators(null, { ...SEXUAL_REPORT, reportId: 777 });
    assert.strictEqual(over.emailSkipped, true);
    assert.match(h.logs.error.join('\n'), /#777/);
    assert.match(h.logs.error.join('\n'), /NO EMAIL SENT/);
    // A generic report still mails: the windows are independent in both directions.
    const generic = await alertModerators(null, { ...GENERIC_REPORT, reportId: 778 });
    assert.strictEqual(generic.emailSkipped, false);
  } finally { h.restore(); }
});

test('child safety: reason matching is exact vocabulary, not substring guessing', () => {
  const { isChildSafetyReason } = __testing;
  assert.strictEqual(isChildSafetyReason('sexual'), true);
  assert.strictEqual(isChildSafetyReason(' SEXUAL '), true, 'case and whitespace must not defeat the category');
  for (const notIt of ['harassment', 'spam', 'hate', 'violence', 'self_harm', 'other', '', null, undefined, 42, ['sexual']]) {
    assert.strictEqual(isChildSafetyReason(notIt), false, `${JSON.stringify(notIt)} is not the category`);
  }
});

// ===========================================================================
// C. The SafeSearch side — a hard adult flag is distinct from fail-closed noise
// ===========================================================================

const realFetch = global.fetch;
const CLEAN = { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY' };
// A minimal still JPEG: FF D8 FF is the signature and JPEG holds exactly one
// image, so the animation gate passes it straight to the (mocked) provider.
const STILL_JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')}`;

function withVision(annotation, fn) {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ responses: [{ safeSearchAnnotation: annotation }] }),
  });
  return fn(errors).finally(() => {
    console.error = realError;
    global.fetch = realFetch;
  });
}

test('safesearch: adult VERY_LIKELY and LIKELY log the [CHILD-SAFETY] token; the verdict is unchanged', async () => {
  for (const level of ['VERY_LIKELY', 'LIKELY']) {
    await withVision({ ...CLEAN, adult: level }, async (errors) => {
      const res = await moderation.moderateImage(STILL_JPEG);
      assert.strictEqual(res.allowed, false);
      assert.strictEqual(res.reason, 'unsafe_adult', 'the caller-facing verdict must not change shape');
      const text = errors.join('\n');
      assert.match(text, /\[CHILD-SAFETY\]/, `adult=${level} must be distinct in the log`);
      assert.match(text, new RegExp(`adult=${level}`), 'the likelihood belongs in the line');
      assert.match(text, /MODERATION-LEGAL\.md/);
      // Stated honestly: this is a signal, not knowledge, and nothing was kept.
      assert.match(text, /not knowledge of CSAM/i);
      assert.match(text, /no copy was kept/i);
    });
  }
});

test('safesearch: POSSIBLE adult is refused as before but does NOT cry child-safety', async () => {
  // POSSIBLE exists to eat ordinary night-out photos. Alerting on it would
  // train the operator to ignore the token.
  await withVision({ ...CLEAN, adult: 'POSSIBLE' }, async (errors) => {
    const res = await moderation.moderateImage(STILL_JPEG);
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason, 'unsafe_adult');
    assert.ok(!errors.join('\n').includes('[CHILD-SAFETY]'), 'POSSIBLE is not a child-safety signal');
  });
});

test('safesearch: a hard racy flag alone is not the adult category', async () => {
  await withVision({ ...CLEAN, racy: 'VERY_LIKELY' }, async (errors) => {
    const res = await moderation.moderateImage(STILL_JPEG);
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason, 'unsafe_racy');
    assert.ok(!errors.join('\n').includes('[CHILD-SAFETY]'));
  });
});

test('safesearch: fail-closed provider errors stay generic — the token means one thing only', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const res = await moderation.moderateImage(STILL_JPEG);
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason, 'moderation_error');
    assert.ok(!errors.join('\n').includes('[CHILD-SAFETY]'),
      'a timeout is not a child-safety event; diluting the token would silence it');
  } finally {
    console.error = realError;
    global.fetch = realFetch;
  }
});

test('safesearch: a clean image logs nothing and is allowed', async () => {
  await withVision(CLEAN, async (errors) => {
    const res = await moderation.moderateImage(STILL_JPEG);
    assert.strictEqual(res.allowed, true);
    assert.ok(!errors.join('\n').includes('[CHILD-SAFETY]'));
  });
});

// ===========================================================================
// D. The runbook exists and the code keeps pointing at it — drift protection,
// same doctrine as the VALID_CONTENT_TYPES-vs-migration diff in safetyFlow.
// ===========================================================================

const REPO_ROOT = path.join(__dirname, '..', '..');

test('runbook: MODERATION-LEGAL.md exists at the repo root and covers the load-bearing facts', () => {
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'MODERATION-LEGAL.md'), 'utf8');
  // The statute, the reporting destination, the preservation term, the
  // no-scanning-duty clause, and both operational URLs. Wording is free to
  // change; these facts are not allowed to fall out of the document.
  for (const fact of [
    '2258A',
    'CyberTipline',
    'one year', // § 2258A(h) preservation, post-REPORT Act
    '2258A(f)', // no proactive-scanning duty
    'report.cybertip.org',
    'esp.ncmec.org/registration',
    '[CHILD-SAFETY]', // the operator's grep string must be documented
    'PRESERVE FIRST',
  ]) {
    assert.ok(doc.includes(fact), `MODERATION-LEGAL.md must mention ${JSON.stringify(fact)}`);
  }
});

test('runbook: the deletion paths that can destroy evidence document the preservation limit', () => {
  // Account deletion hard-deletes authored content and the story purge deletes
  // resolved-report rows on schedule; both notes point at the runbook step
  // that actually satisfies § 2258A(h). If either note is removed, the next
  // maintainer has no reason to know the cascade is destroying evidence.
  const usersRoute = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'routes', 'users.js'), 'utf8');
  const storiesRoute = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'routes', 'stories.js'), 'utf8');
  assert.ok(usersRoute.includes('2258A'), 'users.js deleteAccount must carry the preservation note');
  assert.ok(usersRoute.includes('MODERATION-LEGAL.md'), 'users.js must point at the runbook');
  assert.ok(storiesRoute.includes('2258A'), 'stories.js purge must carry the preservation note');
  assert.ok(storiesRoute.includes('MODERATION-LEGAL.md'), 'stories.js must point at the runbook');
});

test('runbook: the alert service and the runbook agree on the document name', () => {
  assert.strictEqual(__testing.CHILD_SAFETY_DOC, 'MODERATION-LEGAL.md');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, __testing.CHILD_SAFETY_DOC)),
    'the alert points operators at a file that must actually exist');
});

test("runbook: the report vocabulary's child-safety mapping cannot silently drift", () => {
  // The alerting keys off reason 'sexual' because routes/moderation.js has no
  // dedicated child-safety reason. If VALID_REASONS ever gains one (say
  // 'child_safety'), this test forces whoever adds it to extend
  // CHILD_SAFETY_REASONS in the same change instead of the new reason quietly
  // alerting like spam.
  const { VALID_REASONS } = require('../routes/moderation').__test;
  assert.ok(VALID_REASONS.includes('sexual'), 'the reason the alerting keys off must exist in the vocabulary');
  const childish = VALID_REASONS.filter((r) => /child|minor|csam/i.test(r));
  for (const r of childish) {
    assert.ok(__testing.CHILD_SAFETY_REASONS.has(r),
      `VALID_REASONS gained ${JSON.stringify(r)}; add it to CHILD_SAFETY_REASONS in services/moderationAlerts.js`);
  }
});

test('a moderator push that fails is counted, named, and in the summary line', async () => {
  // The push leg is the only real-time channel to a human (no client
  // registers the socket event). It used to be fire-and-forget with a
  // swallowed rejection: pushAttempts was counted, never printed, and the
  // summary line could say "2 admins, 0 connected" over two pushes that had
  // both died, which is the exact blindness this file exists to prevent.
  const pushHelper = require('../services/pushHelper');
  const realPush = pushHelper.pushIfOffline;
  const realOnline = pushHelper.isUserOnline;
  pushHelper.pushIfOffline = async () => { throw new Error('APNs refused the token'); };
  pushHelper.isUserOnline = () => false;
  const h = harness({ admins: [{ id: 1, email: 'one@example.com' }, { id: 2, email: 'two@example.com' }] });
  try {
    const s = await alerts.alertModerators(null, GENERIC_REPORT);
    assert.strictEqual(s.admins, 2, 'two admins were resolved (or this test proves nothing)');
    assert.strictEqual(s.pushAttempts, 2);
    assert.strictEqual(s.pushFailures, 2, 'both rejections were counted before the summary was written');
    assert.match(h.all(), /push to admin 1 FAILED: APNs refused the token/);
    assert.match(h.all(), /push to admin 2 FAILED: APNs refused the token/);
    assert.match(h.all(), /push 0\/2 sent/, 'the summary line says how many pages actually went out');
  } finally {
    pushHelper.pushIfOffline = realPush;
    pushHelper.isUserOnline = realOnline;
    h.restore();
  }
});
