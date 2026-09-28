// Run: node --test  (from backend/)
//
// THE CHANNEL THAT ACTUALLY REACHES A PERSON.
//
// utils/placesHealth.js detects the outage and server.js says so with
// console.error and Sentry.captureMessage. On this deployment both are dead
// ends: the Railway log carried "[PublicDemo] Places search failed: HTTP 429"
// for five days in September while nobody read it, and Sentry is disabled
// because SENTRY_DSN is unset — the boot log prints that on every deploy.
//
// So the detection was worth nothing without this file, and the thing worth
// testing here is not "does it send an email" but the two rules that decide
// whether the operator's inbox tells the truth: one mail a day, and NEVER a
// silent day bought by a send that failed.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'places-alert-test-secret';

const pool = require('../config/database');
const emailService = require('../services/emailService');

let queries = [];
let sent = [];
let claimTaken = false;    // has today's ledger row already been claimed?
let sendShouldFail = false;
// What a real failed send looks like. sendEmail never throws; it RESOLVES
// { sent: false, ... }, and a stub that only threw hid a claim that no real
// failure ever released.
let sendResult = null;

pool.query = async (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: flat, params });
  if (/INSERT INTO ops_alert_ledger/.test(flat)) {
    if (claimTaken) return { rows: [], rowCount: 0 };
    claimTaken = true;
    return { rows: [{ sent_on: '2026-09-06' }], rowCount: 1 };
  }
  if (/DELETE FROM ops_alert_ledger/.test(flat)) {
    claimTaken = false;
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

emailService.sendEmail = async (msg) => {
  if (sendShouldFail) throw new Error('resend is down');
  if (sendResult) return sendResult;
  sent.push(msg);
  return { sent: true, id: 'msg_1' };
};

const { runPlacesOutageAlert } = require('../services/placesOutageAlert');

const UNHEALTHY = {
  day: '2026-09-06',
  unhealthy: true,
  consecutiveFailures: 12,
  failingForMs: 4 * 60 * 60 * 1000,
  reasons: ['HTTP 429'],
};
const HEALTHY = { ...UNHEALTHY, unhealthy: false, consecutiveFailures: 0 };

test.beforeEach(() => {
  queries = [];
  sent = [];
  claimTaken = false;
  sendShouldFail = false;
  sendResult = null;
  process.env.MODERATION_ALERT_EMAIL = 'jayden@example.com';
  // Email is the only leg unless a test turns the admin push on itself.
  delete process.env.ADMIN_USER_IDS;
});

const inserts = () => queries.filter((q) => /INSERT INTO ops_alert_ledger/.test(q.sql));
const deletes = () => queries.filter((q) => /DELETE FROM ops_alert_ledger/.test(q.sql));

test('a healthy Places sends nothing and does not touch the ledger', async () => {
  const out = await runPlacesOutageAlert(HEALTHY);
  assert.deepStrictEqual(out, { skipped: 'healthy' });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(queries.length, 0, 'a healthy check costs no database work at all');
});

test('an outage mails once, and the mail says what is broken for users', async () => {
  const out = await runPlacesOutageAlert(UNHEALTHY);
  assert.deepStrictEqual(out, { sent: true, legs: ['email'] });
  assert.strictEqual(sent.length, 1);

  const msg = sent[0];
  assert.match(msg.subject, /Places/i);
  assert.strictEqual(msg.to, 'jayden@example.com');
  // The failure count, the duration and Google's own words.
  assert.match(msg.text, /12 times in a row/);
  assert.match(msg.text, /4 hours/);
  assert.match(msg.text, /HTTP 429/);
  // What a person can act on.
  assert.match(msg.text, /broken for users right now: venue search, the crowd card/);
  // Photos have their own quota and their own alert, so a search outage must
  // not claim they are broken; it points at the photos alert instead.
  const brokenLine = msg.text.slice(msg.text.indexOf('What is broken'), msg.text.indexOf('Venue photos are metered'));
  assert.doesNotMatch(brokenLine, /photo/i, 'the search alert names search only');
  assert.match(msg.text, /Venue photos are metered on a separate Google quota/);
  assert.match(msg.text, /"Venue photos are failing"/);
  assert.match(msg.text, /quotas/i);
  // The trap that cost hours during the real incident.
  assert.match(msg.text, /caches an area search for 20 minutes/);
  assert.match(msg.text, /NOT a spend ceiling/);
});

test('it mails at most once a day, even though the watch runs every 15 minutes', async () => {
  // The money watch fires four times an hour. Ninety-six identical emails in a
  // day is how somebody learns to filter the alert into a folder.
  for (let i = 0; i < 20; i += 1) await runPlacesOutageAlert(UNHEALTHY);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(inserts().length, 20, 'every run still ASKS');
  assert.strictEqual(deletes().length, 0, 'and none of them released the claim');
});

test('the claim is taken BEFORE the mail, not after', async () => {
  // Mailing first and recording second means a crash between them repeats the
  // mail forever. The ledger insert must be the gate.
  await runPlacesOutageAlert(UNHEALTHY);
  const insertAt = queries.findIndex((q) => /INSERT INTO ops_alert_ledger/.test(q.sql));
  assert.ok(insertAt >= 0);
  assert.strictEqual(sent.length, 1);
});

test('A FAILED SEND RELEASES THE CLAIM, or one bad minute buys a silent day', async () => {
  // THE RULE THIS FILE EXISTS FOR, and the one services/collectionHeartbeat.js
  // learned first. Holding a claim after the send threw would mean the one
  // service whose entire job is to break silence goes quiet for 24 hours
  // because Resend blipped. A duplicate email costs nothing by comparison.
  sendShouldFail = true;
  const out = await runPlacesOutageAlert(UNHEALTHY);
  assert.deepStrictEqual(out, { failed: true }, 'it swallows the throw rather than taking the app down');
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(deletes().length, 1, 'the claim was released');

  // And the very next run is free to try again.
  sendShouldFail = false;
  await runPlacesOutageAlert(UNHEALTHY);
  assert.strictEqual(sent.length, 1);
});

test('a send that RESOLVES as failed releases the claim and is not reported as mailed', async () => {
  // The shape every real failure takes: Resend answering 429 or 5xx, the 8s
  // deadline aborting, or no key. The release used to sit only in a catch, so
  // these kept the claim, answered { mailed: true }, and every run for the
  // rest of the UTC day said 'already-sent-today' during a Places outage.
  for (const failure of [
    { sent: false, error: 'Too many requests', refused: true },
    { sent: false, error: 'This operation was aborted' },
    { sent: false, skipped: true },
  ]) {
    queries = [];
    sent = [];
    claimTaken = false;
    sendResult = failure;
    const out = await runPlacesOutageAlert(UNHEALTHY);
    assert.deepStrictEqual(out, { failed: true }, `${JSON.stringify(failure)} was reported as ${JSON.stringify(out)}`);
    assert.strictEqual(deletes().length, 1, `${JSON.stringify(failure)} did not release the claim`);
    assert.strictEqual(claimTaken, false);

    sendResult = null;
    const retry = await runPlacesOutageAlert(UNHEALTHY);
    // opsAlert's answer for a delivered alert, naming the legs that reached
    // somebody; the email leg is the only one configured here.
    assert.deepStrictEqual(retry, { sent: true, legs: ['email'] }, 'the next run mails instead of answering already-sent-today');
    assert.strictEqual(sent.length, 1);
  }
});

test('no configured address is reported, not swallowed', async () => {
  // Silently doing nothing here would recreate the original bug one layer up:
  // a watchdog that looks armed and reaches nobody.
  process.env.MODERATION_ALERT_EMAIL = '';
  const out = await runPlacesOutageAlert(UNHEALTHY);
  assert.deepStrictEqual(out, { skipped: 'no-recipient' });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(inserts().length, 0, 'and it does not burn the day\'s claim');
});

test('a garbage recipient list does not become a send to nobody', async () => {
  process.env.MODERATION_ALERT_EMAIL = '  , not-an-email ,  ';
  const out = await runPlacesOutageAlert(UNHEALTHY);
  assert.deepStrictEqual(out, { skipped: 'no-recipient' });
  assert.strictEqual(sent.length, 0);
});

test('a database failure never takes the app down', async () => {
  // This runs inside the money watch, on a timer, in production. A watchdog
  // that can crash the process it watches is worse than no watchdog.
  const saved = pool.query;
  pool.query = async () => { throw new Error('pool exhausted'); };
  const out = await runPlacesOutageAlert(UNHEALTHY);
  assert.deepStrictEqual(out, { failed: true });
  pool.query = saved;
});

test('it reads live health when handed nothing', async () => {
  // server.js passes the status it already read, but the default path must
  // work, or a future caller gets a silent no-op.
  const { __resetPlacesHealth, recordPlacesResult } = require('../utils/placesHealth');
  __resetPlacesHealth();
  const quiet = await runPlacesOutageAlert();
  assert.deepStrictEqual(quiet, { skipped: 'healthy' });

  for (let i = 0; i < 5; i += 1) recordPlacesResult(false, 'HTTP 429');
  const loud = await runPlacesOutageAlert();
  assert.deepStrictEqual(loud, { sent: true, legs: ['email'] });
  __resetPlacesHealth();
});

test('the outage also reaches the admins as a push, through the shared ops sender', async () => {
  // The email alone reaches an inbox that might not be opened until the
  // evening. services/opsAlert.js adds a push to each ADMIN_USER_IDS account.
  const pushHelper = require('../services/pushHelper');
  const saved = pushHelper.pushAlways;
  const pushes = [];
  pushHelper.pushAlways = async (userId, title, body, data) => {
    pushes.push({ userId, title, body, data });
    return { sent: 1, failed: 0 };
  };
  process.env.ADMIN_USER_IDS = '42';
  try {
    const out = await runPlacesOutageAlert(UNHEALTHY);
    assert.deepStrictEqual(out, { sent: true, legs: ['email', 'push'] });
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].userId, 42);
    assert.strictEqual(pushes[0].data.type, 'ops_alert');
    assert.match(pushes[0].title, /Places/);
    assert.match(pushes[0].body, /12 calls in a row over 4 hours/);
    assert.match(pushes[0].body, /^Venue search is failing/);
    assert.doesNotMatch(pushes[0].body, /photo/i, 'photos push their own alert');
  } finally {
    pushHelper.pushAlways = saved;
    delete process.env.ADMIN_USER_IDS;
  }
});

test('a Resend refusal answered softly is not mistaken for a sent alert', async () => {
  // sendEmail fails SOFT with { sent: false }. The old code only caught a
  // throw, so a dead key held the day's claim and the outage went unreported.
  const saved = emailService.sendEmail;
  emailService.sendEmail = async () => ({ sent: false, error: 'API key is invalid' });
  try {
    const out = await runPlacesOutageAlert(UNHEALTHY);
    assert.deepStrictEqual(out, { failed: true });
    assert.strictEqual(deletes().length, 1, 'the claim was released');
  } finally {
    emailService.sendEmail = saved;
  }
});
