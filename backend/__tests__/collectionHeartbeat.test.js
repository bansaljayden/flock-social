// Run: node --test  (from backend/)
//
// THE HEARTBEAT WATCHES THE DATA, NOT THE JOB.
//
// The nightly BestTime pull exits silently on failure by design (a cron with
// restart NEVER), and the last time collection stopped, 2026-05-18, nobody
// noticed for months. The heartbeat's contract, pinned here:
//   1. Fresh realtime rows in the window mean silence, no email, ever.
//   2. Zero fresh rows mean ONE email per calendar day, not one per hourly
//      sweep, to the same address moderation alerts use.
//   3. No configured address degrades to a loud console error, never a
//      swallowed nothing.
//   4. A database failure inside the sweep is caught: the heartbeat can
//      never take the app down.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.MODERATION_ALERT_EMAIL = 'jayden@example.com';

const pool = require('../config/database');

let freshRows = 1;
let queryError = null;
pool.query = async () => {
  if (queryError) throw queryError;
  return { rows: [{ n: freshRows }] };
};

const sent = [];
require('../services/emailService').sendEmail = async (msg) => { sent.push(msg); return { id: 'test' }; };

const hb = require('../services/collectionHeartbeat');

test('fresh rows mean silence', async () => {
  hb.__test.reset();
  sent.length = 0;
  freshRows = 42;
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 0);
});

test('a stopped pipeline mails once per day, not once per sweep', async () => {
  hb.__test.reset();
  sent.length = 0;
  freshRows = 0;
  await hb.runCollectionHeartbeat();
  await hb.runCollectionHeartbeat();
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 1, 'hourly sweeps must not stack emails');
  assert.match(sent[0].subject, /collection has stopped/);
  assert.strictEqual(sent[0].to, 'jayden@example.com');
  assert.match(sent[0].text, /BESTTIME/, 'the email names where to look first');
});

test('a database failure is caught, never thrown', async () => {
  hb.__test.reset();
  sent.length = 0;
  queryError = new Error('database blip');
  await assert.doesNotReject(() => hb.runCollectionHeartbeat());
  queryError = null;
  assert.strictEqual(sent.length, 0);
});

test('the kill switch works and defaults open', () => {
  assert.strictEqual(hb.heartbeatEnabled(), true, 'default is on');
  process.env.HEARTBEAT_DISABLED = 'TRUE';
  assert.strictEqual(hb.heartbeatEnabled(), false, 'case-insensitive kill switch');
  delete process.env.HEARTBEAT_DISABLED;
});

test('server boot wires the heartbeat on an hourly interval', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(SRC, /runCollectionHeartbeat, HEARTBEAT_MS/);
  assert.match(SRC, /watches the DATA rather than the cron/,
    'the wiring comment carries the reason: the pull fails silently by design');
});
