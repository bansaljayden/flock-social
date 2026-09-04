// Run: node --test  (from backend/)
//
// THE ICON BADGE CLEARS WHEN THE USER READS, NOT ONLY WHEN A PUSH ARRIVES.
//
// aps.badge is absolute and the server is its only writer; nothing on the
// client sets or clears a badge and no badge plugin is installed. Until
// 2026-09-01 the number travelled only on alert pushes, so a user who opened
// the app and read everything kept the last push's count on the icon until
// some later notification happened to carry a lower one. The contract now:
//   1. pushBadgeSync sends a BADGE-ONLY push: aps.badge set, no alert, no
//      sound, so nothing appears on the lock screen when a read clears a count.
//   2. It carries the same unreadBadge() count deliver() attaches to alerts,
//      so a read that empties the count sends exactly 0, which clears the icon.
//   3. An unreadable count sends nothing rather than a wrong number.
//   4. Both read routes call it, fire-and-forget, so a push failure can never
//      fail a read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pool = require('../config/database');
const firebaseService = require('../services/firebaseService');

let unread = 0;
let tokenRows = [{ id: 1, token: 'tok-1' }];
let queryError = null;
pool.query = async (text, params) => {
  if (queryError) throw queryError;
  const sql = String(text).replace(/\s+/g, ' ');
  if (sql.includes('FROM device_tokens')) return { rows: tokenRows };
  if (sql.includes('DELETE FROM device_tokens')) return { rows: [] };
  // unreadBadge's single aggregate SELECT.
  return { rows: [{ n: unread }] };
};

const sentMessages = [];
firebaseService.__setSenderForTests(async (message) => {
  sentMessages.push(message);
  return { success: true, stale: false };
});

const pushHelper = require('../services/pushHelper');

test.beforeEach(() => {
  sentMessages.length = 0;
  unread = 0;
  tokenRows = [{ id: 1, token: 'tok-1' }];
  queryError = null;
  delete process.env.PUSH_DISABLED;
});

test('a read that empties the count pushes a badge of exactly zero with no alert', async () => {
  unread = 0;
  const r = await pushHelper.pushBadgeSync(42);
  assert.equal(r.sent, 1, 'one device, one badge push');
  assert.equal(sentMessages.length, 1);
  const m = sentMessages[0];
  assert.equal(m.token, 'tok-1');
  assert.equal(m.apns && m.apns.payload && m.apns.payload.aps && m.apns.payload.aps.badge, 0, 'aps.badge must be exactly 0');
  assert.ok(!m.notification, 'a badge sync carries no notification block, so nothing shows on the lock screen');
  assert.ok(!(m.apns.payload.aps.alert), 'no alert');
  assert.ok(!(m.apns.payload.aps.sound), 'no sound');
});

test('a read that leaves unread items pushes the remaining count, still silently', async () => {
  unread = 3;
  await pushHelper.pushBadgeSync(42);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].apns.payload.aps.badge, 3);
  assert.ok(!sentMessages[0].notification);
});

test('an unreadable count sends nothing rather than a wrong number', async () => {
  queryError = new Error('connection terminated');
  const r = await pushHelper.pushBadgeSync(42);
  assert.deepEqual(r, { skipped: true, reason: 'unreadable' });
  assert.equal(sentMessages.length, 0);
});

test('no registered device is a quiet no-op', async () => {
  tokenRows = [];
  const r = await pushHelper.pushBadgeSync(42);
  assert.equal(r.sent, 0);
  assert.equal(sentMessages.length, 0);
});

test('every device the user has registered gets the same absolute number', async () => {
  tokenRows = [{ id: 1, token: 'a' }, { id: 2, token: 'b' }];
  unread = 0;
  const r = await pushHelper.pushBadgeSync(42);
  assert.equal(r.sent, 2);
  assert.deepEqual(sentMessages.map((m) => m.apns.payload.aps.badge), [0, 0]);
});

test('all three read paths call the sync fire-and-forget, after responding', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8').replace(/\r\n/g, '\n');
  const calls = src.match(/pushBadgeSync\(req\.user\.id\)\.catch\(\(\) => \{\}\);/g) || [];
  // Three since 2026-09-04: the flock read, the per-message DM read, and
  // opening a DM thread (GET /dm/:userId), which marks the thread read and
  // used to leave the icon's number stale until the next push.
  assert.equal(calls.length, 3, `the flock read, the DM read and the DM open must all sync the badge (found ${calls.length} in ${src.length} chars; regex ${String(/pushBadgeSync\(req\.user\.id\)\.catch\(\(\) => \{\}\);/g)})`);
  // Fire-and-forget: neither call may be awaited, so a push failure cannot
  // turn a successful read into a 500.
  assert.ok(!/await pushBadgeSync/.test(src), 'the sync must not be awaited inside a read route');
  // And each sits after the success response, not before it.
  const flockRead = src.indexOf("res.json({ success: true, lastReadMessageId");
  const flockSync = src.indexOf('pushBadgeSync(req.user.id)', flockRead);
  assert.ok(flockRead > 0 && flockSync > flockRead && flockSync - flockRead < 600, 'the flock read syncs right after it responds');
  // Anchor on the DM read-mark UPDATE: the flock history route answers with
  // the same res.json line earlier in the file.
  const dmMark = src.indexOf('WHERE sender_id = $1 AND receiver_id = $2 AND read_status = FALSE');
  const dmOpen = src.indexOf('res.json({ messages: messages.reverse() });', dmMark);
  const dmOpenSync = src.indexOf('pushBadgeSync(req.user.id)', dmOpen);
  assert.ok(dmOpen > 0 && dmOpenSync > dmOpen && dmOpenSync - dmOpen < 600, 'the DM open syncs right after it responds');
});
