// Run: node --test  (from backend/)
//
// A PUSH OUTAGE HAS TO BE LOUD.
//
// An APNs key that lapses in the Firebase console, or a service account key
// that is rotated away, fails every push: the SOS alarm, the "Still in?"
// check, every chat notification. Until this, each failed send logged one
// console line and nothing counted them, so the product looked normal on both
// ends while nothing reached a phone. services/firebaseService.js now keeps a
// health count and raises one email a day through services/opsAlert.js.
// Pinned here, driven through the real send path:
//
//   1. a dead token is one uninstalled app, not a failure of the channel;
//   2. five failures in a row alarm once, and a success in between resets it;
//   3. a single auth-class code alarms at once, because it is about our
//      credentials and every send after it fails the same way;
//   4. the alarm is email only, since push is the thing that is broken;
//   5. push that is off before any send (unset in production, or an SDK that
//      never started) is found by the money watch's check.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'push-health-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const firebaseService = require('../services/firebaseService');
const opsAlertModule = require('../services/opsAlert');

const alarms = [];
let alarmAnswer = { sent: true, legs: ['email'] };
opsAlertModule.opsAlert = async (a) => { alarms.push(a); return alarmAnswer; };

let nextError = null;
firebaseService.__setSenderForTests(async () => {
  if (nextError) {
    const e = new Error(nextError.message || 'send failed');
    e.code = nextError.code;
    throw e;
  }
  return 'projects/x/messages/1';
});

const realError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = realError; firebaseService.__setSenderForTests(null); });

function reset() {
  firebaseService.__resetPushHealthForTests();
  alarms.length = 0;
  alarmAnswer = { sent: true, legs: ['email'] };
  nextError = null;
}

async function send(code, message) {
  nextError = code === null ? null : { code, message };
  return firebaseService.sendPushNotification('tok', 'T', 'B', { type: 'flock_message' });
}

// The alarm is fire-and-forget from inside a send.
const settle = () => new Promise((r) => setImmediate(r));

test('a dead token is not a channel failure, and a success is counted', async () => {
  reset();
  await send('messaging/registration-token-not-registered', 'Requested entity was not found.');
  await send(null);
  const h = firebaseService.pushHealthStatus();
  assert.strictEqual(h.stale, 1);
  assert.strictEqual(h.failed, 0);
  assert.strictEqual(h.consecutiveFailures, 0);
  assert.strictEqual(h.sent, 1);
  assert.ok(h.lastSuccessAt);
});

test('four failures are weather; the fifth in a row raises one alarm', async () => {
  reset();
  const n = firebaseService.CONSECUTIVE_FAILURES_BEFORE_ALARM;
  for (let i = 0; i < n - 1; i += 1) await send('messaging/internal-error', 'Internal error');
  await settle();
  assert.strictEqual(alarms.length, 0, 'one bad minute is not an outage');
  await send('messaging/internal-error', 'Internal error');
  await settle();
  assert.strictEqual(alarms.length, 1);
  assert.strictEqual(alarms[0].key, 'push_failing');
  assert.deepStrictEqual(alarms[0].legs, ['email'], 'a push about push failing would go down the broken channel');
  assert.match(alarms[0].text, /last 5 push sends all failed/);
  assert.match(alarms[0].text, /messaging\/internal-error/);
  // And it does not ask again on every failed send after that.
  for (let i = 0; i < 10; i += 1) await send('messaging/internal-error', 'Internal error');
  await settle();
  assert.strictEqual(alarms.length, 1);
});

test('one success resets the run, so scattered failures never alarm', async () => {
  reset();
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < firebaseService.CONSECUTIVE_FAILURES_BEFORE_ALARM - 1; i += 1) {
      await send('messaging/internal-error', 'x');
    }
    await send(null);
  }
  await settle();
  assert.strictEqual(alarms.length, 0);
  assert.strictEqual(firebaseService.pushHealthStatus().failed, 12);
});

test('a single auth-class code alarms at once and says where to look', async () => {
  for (const code of firebaseService.AUTH_FAILURE_CODES) {
    reset();
    await send(code, 'Auth error from APNS or Web Push Service');
    await settle();
    assert.strictEqual(alarms.length, 1, `${code} did not alarm on the first send`);
    const a = alarms[0];
    assert.strictEqual(a.key, 'push_failing');
    assert.deepStrictEqual(a.legs, ['email']);
    assert.match(a.text, new RegExp(code.replace('/', '\\/')));
    assert.match(a.text, /APNs auth key/);
    assert.match(a.text, /FIREBASE_SERVICE_ACCOUNT/);
    assert.match(a.text, /SOS alarm/, 'the email says what stops working, not just a code');
    assert.doesNotMatch(`${a.subject}\n${a.text}`, /—/, 'no em dashes in copy a person reads');
    assert.strictEqual(firebaseService.pushHealthStatus().authCode, code);
  }
});

test('a token from another Firebase project is one device, not our credentials', async () => {
  reset();
  const code = 'messaging/mismatched-credential';
  assert.ok(!firebaseService.AUTH_FAILURE_CODES.has(code));
  // One dev-build token among working ones: no alarm, and the token is kept,
  // because a wrong-project service account would answer this for every token.
  const r = await send(code, 'SenderId mismatch');
  await send(null);
  await settle();
  assert.strictEqual(alarms.length, 0, 'one odd token must not claim every push fails');
  assert.strictEqual(r.stale, false);
  assert.strictEqual(firebaseService.pushHealthStatus().stale, 0);
  assert.strictEqual(firebaseService.pushHealthStatus().consecutiveFailures, 0);
  // A key for the wrong project fails every send the same way, so the run
  // still finds it.
  for (let i = 0; i < firebaseService.CONSECUTIVE_FAILURES_BEFORE_ALARM; i += 1) {
    await send(code, 'SenderId mismatch');
  }
  await settle();
  assert.strictEqual(alarms.length, 1);
  assert.match(alarms[0].text, /last 5 push sends all failed/);
  assert.match(alarms[0].text, /mismatched-credential/);
});

test('an alarm nobody received does not ask again on every send', async () => {
  reset();
  alarmAnswer = { failed: true };
  await send('messaging/third-party-auth-error', 'x');
  await send('messaging/third-party-auth-error', 'x');
  await settle();
  assert.strictEqual(alarms.length, 1, 'retries are spaced, not one per failed send');
});

test('the money watch finds push switched off in production, and nowhere else', () => {
  reset();
  firebaseService.__setSenderForTests(null);
  const savedEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'test';
    firebaseService.checkPushHealth();
    assert.strictEqual(alarms.length, 0, 'a laptop with no service account is ordinary');

    process.env.NODE_ENV = 'production';
    firebaseService.checkPushHealth();
    assert.strictEqual(alarms.length, 1);
    assert.match(alarms[0].subject, /push notifications are off/);
    assert.match(alarms[0].text, /FIREBASE_SERVICE_ACCOUNT is not set on the production service/);
    assert.strictEqual(firebaseService.pushHealthStatus().configured, false);
  } finally {
    process.env.NODE_ENV = savedEnv;
    firebaseService.__setSenderForTests(async () => {
      if (nextError) { const e = new Error('x'); e.code = nextError.code; throw e; }
      return 'ok';
    });
  }
});

test('the money watch asks, so a silent push outage cannot outlive one warning', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const watch = /async function runMoneyWatch\(\) \{([\s\S]*?)\n\}/.exec(src)[1];
  assert.match(watch, /checkPushHealth\(\)/);
});
