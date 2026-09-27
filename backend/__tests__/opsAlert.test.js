// Run: node --test  (from backend/)
//
// ONE SENDER FOR EVERY OPS ALERT, AND IT HAS TO REACH A PERSON.
//
// services/opsAlert.js is what collectionHeartbeat, costHeartbeat, the Places
// outage alert, the money watch and the email alarm all send through now. The
// rules pinned here are the ones that decide whether the operator is told the
// truth:
//
//   1. once per key per day, through ops_alert_ledger, claimed BEFORE sending;
//   2. an email leg to MODERATION_ALERT_EMAIL and a push leg to every
//      ADMIN_USER_IDS account, each only when asked for;
//   3. the claim is released when no leg reached anybody, and kept when one
//      did, including when email's fail-soft { sent: false } is the failure;
//   4. nothing is claimed when there is nobody to tell;
//   5. it never throws.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'ops-alert-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');
const emailService = require('../services/emailService');
const pushHelper = require('../services/pushHelper');

const ledger = new Set();
let queries = [];
let queryError = null;
pool.query = async (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: flat, params });
  if (queryError) throw queryError;
  if (/INSERT INTO ops_alert_ledger/.test(flat)) {
    if (ledger.has(params[0])) return { rows: [] };
    ledger.add(params[0]);
    return { rows: [{ sent_on: '2026-09-27' }] };
  }
  if (/DELETE FROM ops_alert_ledger/.test(flat)) {
    ledger.delete(params[0]);
    return { rows: [] };
  }
  return { rows: [] };
};

let mails = [];
let mailAnswer = () => ({ sent: true, id: 'm1' });
emailService.sendEmail = async (msg) => {
  const out = mailAnswer(msg);
  if (out instanceof Error) throw out;
  if (out.sent !== false) mails.push(msg);
  return out;
};

let pushes = [];
let pushAnswer = () => ({ sent: 1, failed: 0 });
pushHelper.pushAlways = async (userId, title, body, data) => {
  pushes.push({ userId, title, body, data });
  const out = pushAnswer(userId);
  if (out instanceof Error) throw out;
  return out;
};

const { opsAlert, pushReached, PUSH_BODY_MAX, PUSH_TITLE_MAX } = require('../services/opsAlert');

function reset({ email = 'ops@example.com', admins = '' } = {}) {
  ledger.clear();
  queries = [];
  queryError = null;
  mails = [];
  pushes = [];
  mailAnswer = () => ({ sent: true, id: 'm1' });
  pushAnswer = () => ({ sent: 1, failed: 0 });
  if (email === null) delete process.env.MODERATION_ALERT_EMAIL; else process.env.MODERATION_ALERT_EMAIL = email;
  if (admins === null) delete process.env.ADMIN_USER_IDS; else process.env.ADMIN_USER_IDS = admins;
}

const ALERT = { key: 'test_alert', subject: 'Something broke', text: 'First line says what.\n\nMore detail.' };

test('with nobody to tell, it says so and does not burn the day', async () => {
  reset({ email: '', admins: '' });
  const out = await opsAlert(ALERT);
  assert.deepStrictEqual(out, { skipped: 'no-recipient' });
  assert.strictEqual(queries.length, 0, 'no claim was taken, so setting the variable works at once');
});

test('an email-only setup mails once and records the day', async () => {
  reset({ admins: '' });
  const out = await opsAlert(ALERT);
  assert.deepStrictEqual(out, { sent: true, legs: ['email'] });
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'ops@example.com');
  assert.strictEqual(mails[0].subject, 'Something broke');
  assert.ok(ledger.has('test_alert'));
  assert.strictEqual(pushes.length, 0);
});

test('every admin in ADMIN_USER_IDS gets the push, typed ops_alert', async () => {
  reset({ admins: '7, 9,not-a-number' });
  const out = await opsAlert({ ...ALERT, push: { title: 'Short title', body: 'What broke.' } });
  assert.deepStrictEqual(out, { sent: true, legs: ['email', 'push'] });
  assert.deepStrictEqual(pushes.map((p) => p.userId).sort(), [7, 9]);
  for (const p of pushes) {
    assert.strictEqual(p.data.type, 'ops_alert');
    assert.strictEqual(p.title, 'Short title');
    assert.match(p.body, /^What broke\./);
    assert.match(p.body, /alert email has the details/, 'with an email going out, the push says where the rest is');
  }
});

test('a push with no email leg does not point at an email that was never sent', async () => {
  reset({ email: '', admins: '7' });
  const out = await opsAlert(ALERT);
  assert.deepStrictEqual(out, { sent: true, legs: ['push'] });
  assert.strictEqual(pushes[0].body, 'First line says what.', 'the default body is the first line of the text');
  assert.doesNotMatch(pushes[0].body, /email/);
});

test('the lock-screen text is clamped', async () => {
  reset({ email: '', admins: '7' });
  await opsAlert({ ...ALERT, push: { title: 'T'.repeat(200), body: 'B'.repeat(500) } });
  assert.ok(pushes[0].title.length <= PUSH_TITLE_MAX);
  assert.ok(pushes[0].body.length <= PUSH_BODY_MAX);
});

test('it tells a person at most once a day per key', async () => {
  reset({ admins: '7' });
  for (let i = 0; i < 5; i += 1) await opsAlert(ALERT);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(pushes.length, 1);
  assert.deepStrictEqual(await opsAlert(ALERT), { skipped: 'already-sent-today' });
  // A different key is a different condition.
  await opsAlert({ ...ALERT, key: 'other_alert' });
  assert.strictEqual(mails.length, 2);
});

test('the claim is taken before anything is sent', async () => {
  reset({ admins: '' });
  let claimedFirst = null;
  mailAnswer = () => {
    claimedFirst = ledger.has('test_alert');
    return { sent: true };
  };
  await opsAlert(ALERT);
  assert.strictEqual(claimedFirst, true);
});

test('email failing SOFT still counts as failing, and releases the claim', async () => {
  // emailService.sendEmail answers { sent: false } rather than throwing. The
  // alerts this sender replaced only caught throws, so a dead Resend key read
  // as mailed and bought a silent day.
  reset({ admins: '' });
  mailAnswer = () => ({ sent: false, error: 'API key is invalid' });
  const out = await opsAlert(ALERT);
  assert.deepStrictEqual(out, { failed: true });
  assert.ok(!ledger.has('test_alert'), 'the claim was released');
  mailAnswer = () => ({ sent: true });
  assert.deepStrictEqual(await opsAlert(ALERT), { sent: true, legs: ['email'] }, 'and the next run tries again');
});

test('a thrown email with no push leg releases the claim', async () => {
  reset({ admins: '' });
  mailAnswer = () => new Error('resend is down');
  assert.deepStrictEqual(await opsAlert(ALERT), { failed: true });
  assert.ok(!ledger.has('test_alert'));
});

test('one leg reaching somebody is enough to keep the claim', async () => {
  reset({ admins: '7' });
  mailAnswer = () => ({ sent: false, error: 'domain unverified' });
  const out = await opsAlert(ALERT);
  assert.deepStrictEqual(out, { sent: true, legs: ['push'] });
  assert.ok(ledger.has('test_alert'));
});

test('a push that reached no device is a failed leg', async () => {
  reset({ email: '', admins: '7' });
  pushAnswer = () => ({ skipped: true, reason: 'no-device' });
  assert.deepStrictEqual(await opsAlert(ALERT), { failed: true });
  assert.ok(!ledger.has('test_alert'));
});

test('a push held for quiet hours or still in flight has reached somebody', () => {
  assert.strictEqual(pushReached({ sent: 1, failed: 0 }), true);
  assert.strictEqual(pushReached({ skipped: true, reason: 'quiet-held' }), true);
  assert.strictEqual(pushReached({ sent: 0, failed: 1, settled: Promise.resolve() }), true);
  assert.strictEqual(pushReached({ skipped: true, reason: 'disabled' }), false);
  assert.strictEqual(pushReached({ sent: 0, failed: 1 }), false);
  assert.strictEqual(pushReached(null), false);
});

test('legs limits the channels: an email alarm never tries to mail', async () => {
  reset({ admins: '7' });
  const out = await opsAlert({ ...ALERT, legs: ['push'] });
  assert.deepStrictEqual(out, { sent: true, legs: ['push'] });
  assert.strictEqual(mails.length, 0);
  assert.doesNotMatch(pushes[0].body, /email has the details/);
});

test('legs limits the channels: a push alarm never tries to push', async () => {
  reset({ admins: '7' });
  const out = await opsAlert({ ...ALERT, legs: ['email'] });
  assert.deepStrictEqual(out, { sent: true, legs: ['email'] });
  assert.strictEqual(pushes.length, 0);
});

test('a database failure is caught and reported, never thrown', async () => {
  reset({ admins: '7' });
  queryError = new Error('connection terminated');
  assert.deepStrictEqual(await opsAlert(ALERT), { failed: true });
  assert.strictEqual(mails.length, 0);
  assert.strictEqual(pushes.length, 0);
});

test('a missing key is refused rather than claimed under an empty name', async () => {
  reset();
  assert.deepStrictEqual(await opsAlert({ subject: 's', text: 't' }), { skipped: 'no-key' });
  assert.strictEqual(queries.length, 0);
});

// ---------------------------------------------------------------------------
// The email alarm reaches a phone, because it cannot reach an inbox.
// ---------------------------------------------------------------------------
test('the email alarm pages the admins by push only, naming the condition and never the address', async () => {
  reset({ admins: '7' });
  emailService.resetEmailHealth();
  const realError = console.error;
  console.error = () => {};
  try {
    emailService.raiseEmailAlarm('locked-out:someone@example.com', 'someone@example.com is locked out', {});
    emailService.raiseEmailAlarm('locked-out:other@example.com', 'other@example.com is locked out', {});
    emailService.raiseEmailAlarm('failing', 'the last 5 outbound emails all failed', { consecutiveFailures: 5 });
    // The page is fire-and-forget from inside a send, so wait for it to land.
    for (let i = 0; i < 50 && pushes.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
  } finally {
    console.error = realError;
  }
  assert.strictEqual(mails.length, 0, 'an email alarm is never mailed');
  const keys = [...ledger].sort();
  assert.deepStrictEqual(keys, ['email_failing', 'email_locked-out'],
    'one alert per condition, and the ledger key carries no address');
  assert.strictEqual(pushes.length, 2);
  for (const p of pushes) {
    assert.strictEqual(p.data.type, 'ops_alert');
    assert.doesNotMatch(`${p.title} ${p.body}`, /@/, 'no address on a lock screen');
  }
  assert.ok(pushes.some((p) => /verification, password reset and SOS/.test(p.body)));
});
