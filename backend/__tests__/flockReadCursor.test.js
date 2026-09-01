// Run: node --test  (from backend/)
//
// FLOCK CHAT'S READ STATE IS A MONOTONIC ID WATERMARK, AND EVERY COUNT OVER
// IT USES THE HISTORY READ'S OWN VISIBILITY FILTERS.
//
// Migration 056 gives flock_members a last_read_message_id cursor, the server
// half the client's localStorage dot always lacked (its own comment called
// this the handoff). Pinned here:
//   1. The PUT is idempotent and order-proof: GREATEST means a late or
//      repeated mark can only move the cursor forward, and membership is the
//      UPDATE's own predicate, so a non-member learns only 404.
//   2. The list's unread_count and the icon badge's flock count both carry
//      the exact filter set the history read uses (hidden, unsent, blocked
//      either way, deleted sender, never your own), because a count that
//      includes a row the chat will not show is a badge that can never be
//      cleared.
//   3. The migration is a pure ALTER. A backfill UPDATE would move rows when
//      migrationBootSafety replays the chain over live data.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'read-cursor-test-secret';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ME = { id: 5, email: 'me@example.com', name: 'Me', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const TOKEN = signUserToken(ME);

let updates = [];
let updateResult = { rows: [], rowCount: 0 };
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) {
    return { rows: [ME], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE flock_members SET last_read_message_id')) {
    updates.push({ sql, params });
    return updateResult;
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => { throw new Error('pool.connect reached unexpectedly'); };

const app = express();
app.use(express.json());
app.use('/api', require('../routes/messages'));
const server = http.createServer(app);

function put(urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = JSON.stringify(bodyObj || {});
    const req = http.request({
      host: '127.0.0.1', port: addr.port, path: urlPath, method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('the mark is monotonic and membership is the predicate', async () => {
  updates = [];
  updateResult = { rows: [{ last_read_message_id: 90 }], rowCount: 1 };
  const res = await put('/api/flocks/12/read', { lastMessageId: 90 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.lastReadMessageId, 90);
  assert.strictEqual(updates.length, 1);
  assert.match(updates[0].sql, /GREATEST\(COALESCE\(last_read_message_id, 0\), \$3\)/,
    'a late or repeated PUT may only move the cursor forward');
  assert.match(updates[0].sql, /WHERE flock_id = \$1 AND user_id = \$2/,
    'membership lives in the UPDATE predicate, not a separate check');
  assert.deepStrictEqual(updates[0].params, [12, 5, 90]);
});

test('a non-member learns only 404', async () => {
  updates = [];
  updateResult = { rows: [], rowCount: 0 };
  const res = await put('/api/flocks/12/read', { lastMessageId: 4 });
  assert.strictEqual(res.status, 404);
});

test('a non-integer watermark is refused before the database', async () => {
  updates = [];
  const res = await put('/api/flocks/12/read', { lastMessageId: 'newest' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(updates.length, 0);
});

// ---------------------------------------------------------------------------
// Source pins.
// ---------------------------------------------------------------------------
const FLOCKS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');
const PUSH = fs.readFileSync(path.join(__dirname, '..', 'services', 'pushHelper.js'), 'utf8');

function unreadCountBlock(src, startMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i !== -1, `count query not found at marker: ${startMarker}`);
  return src.slice(i, i + 1400);
}

test('the list unread_count uses the history read filter set, capped', () => {
  // The cap lives INSIDE the subquery as a LIMIT so the scan stops at 100
  // rows; LEAST(COUNT(*), 100) computed the full count first (Codex review,
  // 2026-09-01).
  const block = unreadCountBlock(FLOCKS, 'SELECT COUNT(*) FROM (');
  assert.match(block, /LIMIT 100/, 'the cap must stop the scan, not decorate the count');
  assert.match(block, /m\.id > COALESCE\(fm\.last_read_message_id, 0\)/);
  assert.match(block, /m\.sender_id IS NOT NULL/, 'a deleted sender row must under-count, never strand the badge');
  assert.match(block, /m\.sender_id != \$1/, 'your own messages are not unread');
  assert.match(block, /m\.is_hidden IS NOT TRUE/);
  assert.match(block, /m\.sender_deleted_at IS NULL/, 'an unsent message must not hold a badge');
  assert.match(block, /user_blocks/, 'a blocked sender the chat hides must not hold a badge');
});

test('the icon badge flock count mirrors the same filters and only accepted memberships', () => {
  const i = PUSH.indexOf('async function unreadBadge');
  const j = PUSH.indexOf('async function deliver');
  const badgeFn = PUSH.slice(i, j);
  assert.match(badgeFn, /fm\.status = 'accepted'/,
    'an invitation you never accepted must not put a number on the app icon');
  assert.match(badgeFn, /fm\.last_read_message_id > 0/,
    'the flock half counts only cursors the client has proven it can move: '
      + 'installed builds without the read call would otherwise carry a badge '
      + 'they can never clear (Codex review, 2026-09-01)');
  assert.match(badgeFn, /m\.id > COALESCE\(fm\.last_read_message_id, 0\)/);
  assert.match(badgeFn, /m\.sender_id IS NOT NULL/);
  assert.match(badgeFn, /m\.is_hidden IS NOT TRUE/);
  assert.match(badgeFn, /m\.sender_deleted_at IS NULL/);
  const blockFilters = (badgeFn.match(/user_blocks/g) || []).length;
  assert.ok(blockFilters >= 2, 'both halves of the badge exclude blocked either way');
});

test('the migration is a pure ALTER, replay-safe by construction', () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '056_flock_read_cursor.sql'), 'utf8');
  assert.match(mig, /ALTER TABLE flock_members ADD COLUMN IF NOT EXISTS last_read_message_id INTEGER NOT NULL DEFAULT 0;/);
  assert.ok(!/UPDATE\s+flock_members/i.test(mig),
    'a backfill UPDATE would move rows when migrationBootSafety replays the chain over live data');
});
