// Run: node --test  (from backend/)
//
// THE LOCKED-OUT PUSH NAMES WHAT WAS REFUSED (2026-11-13).
//
// When a bounced address refuses a transactional email, sendEmail raises the
// locked-out alarm and the admins' phones get a push. The push used to say "a
// verification or password reset email was refused" whatever the message was.
// From 2026-11-10 the daily push was the Roost pricing notice to a bounced
// address of our own, and it was read as somebody failing to sign in. Pinned:
//   1. A sender that says what its message is (sendEmail's `purpose`) is named
//      in the push and in the log line.
//   2. A sender that does not is called "an account email", never a
//      verification or reset it may not have been.
//   3. The push never carries the address.
//   4. The Roost notice, the verification, the password reset and the sign-in
//      help emails all say what they are.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const suppression = require('../services/emailSuppression');
const ops = require('../services/opsAlert');
const emailService = require('../services/emailService');

const pushes = [];
ops.opsAlert = async (args) => { pushes.push(args); return { sent: true }; };
suppression.checkSendAllowed = async () => ({ blocked: true, reason: 'bounce' });

const ADDRESS = 'owner@example.com';

async function refusedSend(extra) {
  emailService.resetEmailHealth();
  pushes.length = 0;
  const errors = [];
  const error = console.error;
  const warn = console.warn;
  console.error = (...a) => errors.push(a.join(' '));
  console.warn = () => {};
  let out;
  try {
    out = await emailService.sendEmail({ to: ADDRESS, subject: 'Hello', text: 'Hello', ...extra });
    // The page is sent from a promise chain the send does not wait on.
    await new Promise((r) => setImmediate(r));
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return { out, errors };
}

test('a message that says what it is is named in the push and the log', async () => {
  const { out, errors } = await refusedSend({ purpose: 'the Roost pricing notice' });
  assert.strictEqual(out.suppressed, true);
  assert.strictEqual(pushes.length, 1);
  const { push } = pushes[0];
  assert.strictEqual(push.title, 'Someone cannot get their email');
  assert.match(push.body, /^The Roost pricing notice was refused because the address is on the do-not-mail list, so it cannot get a verification or password reset email either\./);
  assert.match(errors.join('\n'), /a transactional message \(the Roost pricing notice\) was just refused/);
});

test('a message that does not say is "an account email", not a verification or reset', async () => {
  await refusedSend({});
  assert.strictEqual(pushes.length, 1);
  assert.match(pushes[0].push.body, /^An account email was refused because/);
  assert.doesNotMatch(pushes[0].push.body, /^A verification or password reset email was refused/);
});

test('the push never carries the address', async () => {
  await refusedSend({ purpose: 'a password reset email' });
  const words = JSON.stringify(pushes[0].push);
  assert.ok(!words.includes(ADDRESS) && !words.includes('owner@'), 'the address reached the lock screen');
  assert.match(pushes[0].push.body, /^A password reset email was refused/);
});

test('the account emails and the Roost notice each say what they are', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const email = read('services', 'emailService.js');
  for (const [subject, purpose] of [
    ['Confirm your email for Flock', 'a verification email'],
    ['Reset your Flock password', 'a password reset email'],
    ['About your Flock sign-in', 'a sign-in help email'],
  ]) {
    assert.match(email, new RegExp(`subject: '${subject}',\\r?\\n\\s+purpose: '${purpose}',`), `${subject} names no purpose`);
  }
  assert.match(read('services', 'roostNotice.js'), /purpose: 'the Roost pricing notice',/);
});
