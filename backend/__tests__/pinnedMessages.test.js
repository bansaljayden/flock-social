// Run: node --test  (from backend/)
//
// PINNED MESSAGES (migration 068).
//
// components/chat/sheets/PinnedMessageBar.js was built, tested and exported
// and nothing imported it, because the table it reads did not exist. Its own
// header said "migration 066 adds the pinned_messages table"; 066 became the
// flock reply, and nothing tracked that the table had never been written.
//
// SHARED pins, not the reference app's private save: anyone in the thread can
// pin, up to three, and everyone sees them. That shape is what most of the
// assertions below are about, because "shared" is exactly what makes the
// authorisation questions interesting. Who may pin, who may unpin somebody
// else's pin, and whose copy of the list is whose.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'pinned-messages-test-secret';

const pool = require('../config/database');

let handlers = [];
let log = [];

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = await fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  if (/blocked_id AS id FROM user_blocks/.test(flat)) return { rows: [], rowCount: 0 };
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => dispatch(sql, params),
  release: () => {},
});

function on(re, fn) { handlers.push([re, fn]); }

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });

const messagesRouter = require('../routes/messages');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.set('io', null); // no live fan-out in these tests; broadcastPins returns early
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
});

async function call(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}

/** Membership, the target lookup, the count, the insert and the read back. */
function scriptPin({ member = true, target = true, count = 0, pins = [] } = {}) {
  on(/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: member ? [{ id: 1 }] : [] }));
  on(/SELECT id FROM messages WHERE id = \$1 AND flock_id = \$2/, () => ({ rows: target ? [{ id: 5 }] : [] }));
  on(/COUNT\(\*\)::int AS n FROM pinned_messages/, () => ({ rows: [{ n: count }] }));
  on(/INSERT INTO pinned_messages/, () => ({ rows: [], rowCount: 1 }));
  on(/DELETE FROM pinned_messages/, () => ({ rows: [], rowCount: 1 }));
  on(/FROM pinned_messages p/, () => ({ rows: pins }));
}

const PIN_ROW = {
  id: 11, message_id: 5, pinned_by: 2, created_at: '2026-09-05T20:00:00Z',
  message_text: 'Venmo @maya', message_type: 'text', sender_id: 2, sender_name: 'Maya',
};

// ---------------------------------------------------------------------------
// 1. Pinning
// ---------------------------------------------------------------------------

test('a pin stores the row and answers with the whole list', async () => {
  scriptPin({ pins: [PIN_ROW] });
  const res = await call('POST', '/api/flocks/7/pins', { message_id: 5 });

  assert.strictEqual(res.status, 201, res.text);
  // The WHOLE list, not the one row: the server is the only thing that knows
  // what this reader is allowed to see, so a client splicing one row into a
  // list it already had would be guessing.
  assert.deepStrictEqual(res.body.pins, [{
    id: 5, messageId: 5, text: 'Venmo @maya', messageType: 'text', senderName: 'Maya', pinnedBy: 2,
  }]);
});

test('pinning something already pinned is a no-op, not a 500', async () => {
  // Two people tapping Pin on the same message within a second of each other
  // is the ordinary case, and the unique index in 068 is what makes it safe.
  scriptPin({ count: 1, pins: [PIN_ROW] });
  const res = await call('POST', '/api/flocks/7/pins', { message_id: 5 });
  assert.strictEqual(res.status, 201, res.text);
  const insert = log.find((q) => /INSERT INTO pinned_messages/.test(q.sql));
  assert.match(insert.sql, /ON CONFLICT \(flock_id, message_id\) DO NOTHING/);
});

test('a fourth pin is REFUSED, and the refusal says what to do', async () => {
  /* Evicting the oldest would let one person silently remove something
     another person put there, on a surface whose whole point is that it is
     shared. */
  scriptPin({ count: 3 });
  const res = await call('POST', '/api/flocks/7/pins', { message_id: 5 });

  assert.strictEqual(res.status, 409, res.text);
  assert.match(res.body.error, /Only 3 messages can be pinned\. Unpin one first\./);
  assert.strictEqual(log.filter((q) => /INSERT INTO pinned_messages/.test(q.sql)).length, 0);
});

// ---------------------------------------------------------------------------
// 2. What may be pinned, and by whom
// ---------------------------------------------------------------------------

test('a non-member cannot pin', async () => {
  scriptPin({ member: false });
  const res = await call('POST', '/api/flocks/7/pins', { message_id: 5 });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(log.filter((q) => /INSERT INTO pinned_messages/.test(q.sql)).length, 0);
});

test('a message from ANOTHER flock cannot be pinned', async () => {
  /* Without the flock_id predicate any member could pin an arbitrary message
     id and have its text drawn at the top of a thread it was never in. */
  scriptPin({ target: false });
  const res = await call('POST', '/api/flocks/7/pins', { message_id: 99999 });

  assert.strictEqual(res.status, 404, res.text);
  const lookup = log.find((q) => /SELECT id FROM messages WHERE id = \$1/.test(q.sql));
  assert.match(lookup.sql, /flock_id = \$2/);
  assert.match(lookup.sql, /is_hidden IS NOT TRUE/, 'a moderated message is not pinnable');
  assert.match(lookup.sql, /sender_deleted_at IS NULL/, 'an unsent message is not pinnable');
});

test('ANYONE in the flock can unpin, not only whoever pinned it', async () => {
  /* A shared surface that only its author can clear is a surface one person
     can fill and walk away from, and the three slots are the whole group's. */
  CURRENT_USER = { id: 9, name: 'Someone else', email_verified: true, role: 'user' };
  scriptPin({ pins: [] });
  const res = await call('DELETE', '/api/flocks/7/pins/5');

  assert.strictEqual(res.status, 200, res.text);
  const del = log.find((q) => /DELETE FROM pinned_messages/.test(q.sql));
  assert.match(del.sql, /WHERE flock_id = \$1 AND message_id = \$2/);
  assert.ok(!/pinned_by/.test(del.sql), 'the delete must not be scoped to the pinner');
});

test('a non-member cannot unpin either', async () => {
  scriptPin({ member: false });
  const res = await call('DELETE', '/api/flocks/7/pins/5');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(log.filter((q) => /DELETE FROM pinned_messages/.test(q.sql)).length, 0);
});

// ---------------------------------------------------------------------------
// 3. Whose list is whose
// ---------------------------------------------------------------------------

test('the pin read carries the same three filters the reply quote does', async () => {
  scriptPin({ pins: [PIN_ROW] });
  await call('POST', '/api/flocks/7/pins', { message_id: 5 });

  const read = log.find((q) => /FROM pinned_messages p/.test(q.sql));
  assert.ok(read, 'the list is read back');
  // A pin is another path to a message's words: scoped to the flock, hidden
  // and unsent dropped so a pin cannot outlive what it points at, and blocked
  // senders dropped so a pin is not how a blocked member's line reaches the
  // person who blocked them.
  assert.match(read.sql, /p\.flock_id = \$1/);
  assert.match(read.sql, /m\.is_hidden IS NOT TRUE/);
  assert.match(read.sql, /m\.sender_deleted_at IS NULL/);
  assert.match(read.sql, /NOT \(m\.sender_id = ANY\(\$2::int\[\]\)\)/);
  // A message whose author was deleted is still pinnable: sender_id is ON
  // DELETE SET NULL, and `NOT (NULL = ANY(...))` is NULL, which WHERE discards.
  assert.match(read.sql, /m\.sender_id IS NULL OR/);
});

// ---------------------------------------------------------------------------
// 4. The migration
// ---------------------------------------------------------------------------

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '068_pinned_messages.sql'), 'utf8'
).replace(/\r\n/g, '\n');

test('a pin cannot outlive the message it points at', () => {
  // Anything else leaves a bar at the top of the chat quoting a line the
  // author withdrew.
  assert.match(MIGRATION, /message_id INTEGER NOT NULL REFERENCES messages\(id\) ON DELETE CASCADE/);
});

test('a member leaving does not un-pin the group\'s Venmo handle', () => {
  // The pin belongs to the thread, so pinned_by is SET NULL rather than CASCADE.
  assert.match(MIGRATION, /pinned_by INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
});

test('one pin per message, enforced by the database', () => {
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS idx_pinned_messages_unique\s*\n\s*ON pinned_messages \(flock_id, message_id\)/);
});

test('the THREE is not a check constraint', () => {
  /* A CHECK cannot count rows in a sibling group and a trigger would put the
     rule where nobody reading the route would find it. Same reasoning as 067
     leaving system_kind unconstrained. */
  // COMMENTS STRIPPED FIRST. This file explains at length why there is no
  // CHECK here, so a whole-file grep matches the prose arguing against the
  // very thing it is looking for. The assertion is about the SQL.
  const sqlOnly = MIGRATION.replace(/^\s*--.*$/gm, '');
  assert.ok(!/CHECK/i.test(sqlOnly), 'the ceiling belongs in the route, which counts and refuses');
});

test('the migration is Latin-1 clean, which the boot-safety test requires', () => {
  const offending = [...MIGRATION].filter((ch) => ch.charCodeAt(0) > 255);
  assert.deepStrictEqual(offending, [], `non-Latin-1 characters: ${offending.join(' ')}`);
});
