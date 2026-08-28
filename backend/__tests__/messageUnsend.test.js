// Run: node --test  (from backend/)
//
// UNSEND IS A SENDER-OWNED TOMBSTONE, NEVER A DELETE.
//
// A sent message could never be taken back; migration 055 adds
// sender_deleted_at to both chat tables and the two DELETE routes retire the
// row instead of destroying it, because a reported message is evidence and
// the one person with a motive to destroy it must not be able to (the
// owner-deleted promotions rule applied to chat). Pinned here:
//   1. Authorization lives in the UPDATE's own predicate (sender_id = the
//      verified caller), so a non-sender learns only 404 and there is no
//      check-then-act window.
//   2. The statement is an UPDATE. No route in messages.js deletes a row.
//   3. Every hidden-row filter in the file pairs with the tombstone filter,
//      counted, so an unsent message cannot leak through any read this file
//      serves, previews and full-size photos included.
//   4. The fan-outs carry exactly ids, and the DM one goes to exactly the
//      two participants.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'unsend-test-secret';

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
  if (sql.startsWith('UPDATE messages SET sender_deleted_at') || sql.startsWith('UPDATE direct_messages SET sender_deleted_at')) {
    updates.push({ sql, params });
    return updateResult;
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => { throw new Error('pool.connect reached unexpectedly'); };

const emits = [];
const fakeIo = { to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) };

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api', require('../routes/messages'));
const server = http.createServer(app);

function del(urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      host: '127.0.0.1', port: addr.port, path: urlPath, method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
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
    req.end();
  });
}

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('the sender unsends, and the predicate is the authorization', async () => {
  updates = []; emits.length = 0;
  updateResult = { rows: [{ id: 34 }], rowCount: 1 };
  const res = await del('/api/flocks/12/messages/34');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(updates.length, 1);
  assert.match(updates[0].sql, /sender_id = \$3/);
  assert.match(updates[0].sql, /sender_deleted_at IS NULL/);
  assert.deepStrictEqual(updates[0].params, ['34', 12, 5]);
});

test('a non-sender, or an already-unsent row, learns only 404', async () => {
  updates = []; emits.length = 0;
  updateResult = { rows: [], rowCount: 0 };
  const res = await del('/api/flocks/12/messages/34');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(emits.length, 0, 'no fan-out for nothing');
});

test('the flock fan-out reaches the room path and the sender, ids only', async () => {
  updates = []; emits.length = 0;
  updateResult = { rows: [{ id: 34 }], rowCount: 1 };
  await del('/api/flocks/12/messages/34');
  const own = emits.find((e) => e.room === 'user:5');
  assert.ok(own, 'the sender hears their own unsend');
  assert.strictEqual(own.event, 'flock_message_unsent');
  assert.deepStrictEqual(own.payload, { flockId: 12, messageId: 34 });
});

test('the DM unsend goes to exactly the two participants', async () => {
  updates = []; emits.length = 0;
  updateResult = { rows: [{ id: 77, receiver_id: 8 }], rowCount: 1 };
  const res = await del('/api/dm/messages/77');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(emits.map((e) => e.room).sort(), ['user:5', 'user:8']);
  for (const e of emits) {
    assert.strictEqual(e.event, 'dm_message_unsent');
    assert.deepStrictEqual(e.payload, { messageId: 77, senderId: 5 });
  }
});

// ---------------------------------------------------------------------------
// Source pins.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8');

test('unsend is an UPDATE; nothing in messages.js deletes a CONTENT row', () => {
  // Reactions and DM venue votes are legitimately deleted when taken back; a
  // removed reaction is not evidence of anything. The MESSAGE tables are:
  // content rows retire by tombstone, never by DELETE.
  assert.ok(!/DELETE FROM\s+messages/i.test(SRC), 'flock messages retire, never delete');
  assert.ok(!/DELETE FROM\s+direct_messages/i.test(SRC), 'DMs retire, never delete');
});

test('every hidden-row filter pairs with the tombstone filter', () => {
  // The two filter spellings this file uses. Each occurrence must ride with
  // its sender_deleted_at twin, so an unsent message cannot leak through any
  // read: history, previews, reactions, or the full-size photo endpoints.
  const hiddenCount = (SRC.match(/is_hidden IS NOT TRUE|COALESCE\((?:\w+\.)?is_hidden, false\) = false/g) || []).length;
  const pairCount = (SRC.match(/sender_deleted_at IS NULL/g) || []).length;
  // The two unsend UPDATEs also carry the predicate (idempotence), so the
  // pair count is the filter count plus exactly those two statements.
  assert.strictEqual(pairCount, hiddenCount + 2,
    `every is_hidden filter must carry the tombstone twin: ${hiddenCount} filters, ${pairCount} tombstone predicates`);
});

test('the tombstone filter rides beyond routes/messages.js', () => {
  // 2026-08-28 adversarial review: the pair count above scans only
  // routes/messages.js, and three reads live elsewhere.
  //   1. pushHelper.unreadBadge counts unread DMs for the app icon badge. A
  //      tombstoned row can never be opened or marked read, so counting one
  //      inflates the recipient's badge permanently, on every future push.
  //   2. The socket send_dm reply lookup SELECTs message_text and fans the
  //      row out verbatim; without the twin, replying to an unsent message
  //      re-broadcasts the unsent words into the live thread.
  //   3. Socket dm_react accepted reactions on rows the REST twin 404s.
  const PUSH = fs.readFileSync(path.join(__dirname, '..', 'services', 'pushHelper.js'), 'utf8');
  const badgeFn = PUSH.slice(PUSH.indexOf('async function unreadBadge'), PUSH.indexOf('async function deliver'));
  assert.match(badgeFn, /sender_deleted_at IS NULL/,
    'the badge count must exclude tombstoned rows the app can never clear');

  const SOCK = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');
  const sockPairs = (SOCK.match(/sender_deleted_at IS NULL/g) || []).length;
  assert.ok(sockPairs >= 2,
    `the socket transport must carry the tombstone twin on the reply lookup and dm_react (found ${sockPairs})`);
});

test('the migration carries both columns', () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '055_message_unsend.sql'), 'utf8');
  assert.match(mig, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_deleted_at TIMESTAMPTZ;/);
  assert.match(mig, /ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS sender_deleted_at TIMESTAMPTZ;/);
});
