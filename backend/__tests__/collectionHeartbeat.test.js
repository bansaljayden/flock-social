// Run: node --test  (from backend/)
//
// THE HEARTBEAT WATCHES THE DATA, NOT THE JOB.
//
// The nightly BestTime pull exits silently on failure by design (a cron with
// restart NEVER), and the last time collection stopped, 2026-05-18, nobody
// noticed for months. The heartbeat's contract, pinned here:
//   1. A HEALTHY night means silence. Healthy is a floor, not a mere
//      nonzero: a run that aborts after twenty venues leaves rows behind,
//      and the bare "any rows" test stayed silent through exactly the
//      failure the collector's throttle wall produces (2026-09-01 review).
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
// Distinct hours the rows landed across, of a 26-hour window. It is a second
// signal and not a cosmetic one: a collector that stops firing keeps a full
// row count for most of a day, so the row floor alone cannot see it. Default
// to a healthy full window, so a test that cares only about volume says so by
// setting freshRows alone.
let freshHours = 26;
let queryError = null;
// The durable dedupe ledger, emulated: (alert_key, sent_on) uniqueness with
// ON CONFLICT DO NOTHING semantics, so the suite can prove once-per-day
// holds ACROSS process restarts, the exact bug the ledger replaced.
const ledger = new Set();
pool.query = async (text) => {
  if (queryError) throw queryError;
  const sql = String(text).replace(/\s+/g, ' ');
  if (sql.includes('DELETE FROM ops_alert_ledger')) {
    ledger.clear();
    return { rows: [] };
  }
  if (sql.includes('INSERT INTO ops_alert_ledger')) {
    const key = 'collection_heartbeat:' + new Date().toISOString().slice(0, 10);
    if (ledger.has(key)) return { rows: [] };
    ledger.add(key);
    return { rows: [{ sent_on: key }] };
  }
  return { rows: [{ n: freshRows, hours: freshHours }] };
};

const sent = [];
// The service destructures sendEmail at require time, so the stub has to be
// installed before it loads and cannot be swapped later: a flag is how a test
// makes this one throw.
let sendThrows = false;
require('../services/emailService').sendEmail = async (msg) => {
  if (sendThrows) throw new Error('resend is down');
  sent.push(msg);
  return { id: 'test' };
};

const hb = require('../services/collectionHeartbeat');

test('a healthy day means silence', async () => {
  hb.__test.reset();
  ledger.clear();
  sent.length = 0;
  // The trailing 26 hours as measured in production on 2026-09-06.
  freshRows = 3779;
  freshHours = 26;
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 0);
});

test('a run that died partway still alerts, and says so', async () => {
  // The shape a throttle wall produces: the run started, wrote a handful
  // of rows, and aborted. A nonzero test would have stayed silent here.
  hb.__test.reset();
  ledger.clear();
  sent.length = 0;
  freshRows = 20;
  freshHours = 26;
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 1, 'twenty rows against roughly 3,000 is a failure, not a day');
  assert.match(sent[0].subject, /failing partway/);
  assert.match(sent[0].text, /Only 20 live crowd observations/);
});

test('the floor is sized for the hourly cadence, not the old nightly one', async () => {
  // THE REGRESSION THIS EXISTS TO STOP. The floor was 200 while the collector
  // was producing 3,779 rows a window, because it had been sized when the cron
  // fired once a night and nothing moved it when the cadence went hourly. At
  // 200, a collector down to 6% of its yield reported healthy. Anything that
  // lowers the floor back under a real collapse has to fail here.
  hb.__test.reset();
  ledger.clear();
  sent.length = 0;
  freshRows = 250;
  freshHours = 26;
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 1, '250 rows is a 93% collapse and must alarm');
  assert.match(sent[0].subject, /failing partway/);
});

test('a collector that stopped firing alarms while its row count still looks fine', async () => {
  // The failure the row floor cannot see. The cron quit twelve hours ago, so
  // the window still holds half a day of good rows, well over the floor. What
  // gives it away is that they all landed in the far half of the window.
  hb.__test.reset();
  ledger.clear();
  sent.length = 0;
  freshRows = 1800;
  freshHours = 6;
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 1, '1,800 rows over 6 of 26 hours is a stopped cron');
  assert.match(sent[0].subject, /stopped firing/);
  assert.match(sent[0].text, /only across 6 distinct hours/,
    'the email distinguishes a stopped cron from a throttled one');
});

test('a stopped pipeline mails once per day, even across restarts', async () => {
  hb.__test.reset();
  ledger.clear();
  sent.length = 0;
  freshRows = 0;
  await hb.runCollectionHeartbeat();
  // A deploy restarts the process; the ledger, not process memory, must be
  // what remembers. reset() models the restart.
  hb.__test.reset();
  await hb.runCollectionHeartbeat();
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 1, 'a redeploy must not re-mail the same day, 2026-09-01 did exactly that twice');
  assert.match(sent[0].subject, /collection has stopped/);
  assert.strictEqual(sent[0].to, 'jayden@example.com');
  assert.match(sent[0].text, /BESTTIME/, 'the email names where to look first');
});

test('a database failure is caught, never thrown', async () => {
  hb.__test.reset();
  ledger.clear();
  sent.length = 0;
  queryError = new Error('database blip');
  await assert.doesNotReject(() => hb.runCollectionHeartbeat());
  queryError = null;
  assert.strictEqual(sent.length, 0);
});

test('a failed send releases the day claim instead of buying silence', async () => {
  // The claim is taken before the send so concurrent sweeps cannot double
  // mail. If the send then throws, holding the claim would silence the one
  // service whose whole job is to break silence (2026-09-01 review).
  hb.__test.reset();
  ledger.clear();
  sent.length = 0;
  freshRows = 0;
  sendThrows = true;
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 0, 'nothing was sent');
  assert.strictEqual(ledger.size, 0, 'the claim was released, so the next sweep can retry');
  sendThrows = false;
  await hb.runCollectionHeartbeat();
  assert.strictEqual(sent.length, 1, 'the retry sends once the provider recovers');
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
