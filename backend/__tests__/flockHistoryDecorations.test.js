// Run: node --test  (from backend/)
//
// THE CHAT HISTORY READ AND ITS DECORATIONS.
//
// GET /api/flocks/:id/messages reads a page of history and decorates it with
// reactions, reply quotes, the receipt roster and the pins. The roster and the
// pins need only the invisible set, so they start beside the history read;
// reactions and quotes need the page, so they go out together once it is back.
// Pinned here:
//   1. A full page comes back decorated.
//   2. A failed roster, pins or quote read costs that decoration only: 200.
//   3. A failed reactions read, or a failed history read, is the route's 500,
//      and nothing started early is left as an unhandled rejection.
//   4. The roster and the pins are asked for before the history read answers.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'flock-history-decorations-test-secret';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ME = { id: 5, email: 'me@example.com', name: 'Me', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const TOKEN = signUserToken(ME);

const PAGE = [
  { id: 12, flock_id: 1, sender_id: 6, message_text: 'replying', message_type: 'text', venue_data: null, created_at: new Date('2026-09-30T12:01:00Z'), is_hidden: false, thumb_url: null, sender_deleted_at: null, reply_to_id: 11, system_kind: null, sender_name: 'Ana', sender_image: null, image_url: null },
  { id: 11, flock_id: 1, sender_id: 5, message_text: 'first', message_type: 'text', venue_data: null, created_at: new Date('2026-09-30T12:00:00Z'), is_hidden: false, thumb_url: null, sender_deleted_at: null, reply_to_id: null, system_kind: null, sender_name: 'Me', sender_image: null, image_url: null },
];

let failing = new Set();
let order = [];
let historyGate = null;

function kindOf(sql) {
  if (sql.includes('token_version FROM users WHERE id = $1')) return 'auth';
  if (sql.includes('FROM user_blocks') && sql.includes('UNION')) return 'invisible';
  if (sql.includes("SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) return 'gate';
  if (sql.includes('FROM emoji_reactions er')) return 'reactions';
  if (sql.includes('FROM pinned_messages p')) return 'pins';
  if (sql.includes('fm.last_delivered_message_id, fm.last_opened_message_id')) return 'roster';
  if (sql.includes('WHERE m.id = ANY($1) AND m.flock_id = $2')) return 'quotes';
  if (sql.includes('FROM messages m') && sql.includes('ORDER BY m.id DESC')) return 'history';
  return 'other';
}

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text && typeof text === 'object' ? text.text : text).replace(/\s+/g, ' ');
  const kind = kindOf(sql);
  order.push(kind);
  if (kind === 'history' && historyGate) await historyGate;
  if (failing.has(kind)) throw Object.assign(new Error(`${kind} read failed`), { code: '57P01' });
  switch (kind) {
    case 'auth': return { rows: [ME], rowCount: 1 };
    case 'invisible': return { rows: [], rowCount: 0 };
    case 'gate': return { rows: [{ id: 1 }], rowCount: 1 };
    case 'history': return { rows: PAGE.map((m) => ({ ...m })), rowCount: PAGE.length };
    case 'reactions': return { rows: [{ message_id: 11, emoji: '🔥', user_id: 6, user_name: 'Ana' }], rowCount: 1 };
    case 'quotes': return { rows: [{ id: 11, message_text: 'first', message_type: 'text', sender_id: 5, sender_name: 'Me' }], rowCount: 1 };
    case 'roster': return { rows: [{ user_id: 6, name: 'Ana', last_delivered_message_id: 12, last_opened_message_id: 11 }], rowCount: 1 };
    case 'pins': return { rows: [{ id: 1, message_id: 11, pinned_by: 5, created_at: new Date(), message_text: 'first', message_type: 'text', sender_id: 5, sender_name: 'Me' }], rowCount: 1 };
    default: return { rows: [], rowCount: 0 };
  }
};

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);

const app = express();
app.use(express.json());
app.use('/api', require('../routes/messages'));
const server = http.createServer(app);

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent: false, host: '127.0.0.1', port: server.address().port, path, method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; process.off('unhandledRejection', onUnhandled); });
test.beforeEach(() => { failing = new Set(); order = []; historyGate = null; unhandled.length = 0; });

test('a full page comes back decorated', async () => {
  const res = await get('/api/flocks/1/messages?limit=50');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.messages.map((m) => m.id), [11, 12]);
  const reply = res.body.messages.find((m) => m.id === 12);
  assert.strictEqual(reply.reply_to.id, 11);
  assert.strictEqual(res.body.messages.find((m) => m.id === 11).reactions.length, 1);
  assert.strictEqual(res.body.pins.length, 1);
  assert.ok(Array.isArray(res.body.readers) && res.body.readers.length === 1);
});

for (const kind of ['roster', 'pins', 'quotes']) {
  test(`a failed ${kind} read costs that decoration only`, async () => {
    failing.add(kind);
    const res = await get('/api/flocks/1/messages?limit=50');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.messages.map((m) => m.id), [11, 12]);
    if (kind === 'roster') assert.deepStrictEqual(res.body.readers, []);
    if (kind === 'pins') assert.deepStrictEqual(res.body.pins, []);
    if (kind === 'quotes') assert.strictEqual(res.body.messages.find((m) => m.id === 12).reply_to, undefined);
    await settle();
    assert.deepStrictEqual(unhandled, []);
  });
}

test('a failed reactions read is the route\'s 500', async () => {
  failing.add('reactions');
  const res = await get('/api/flocks/1/messages?limit=50');
  assert.strictEqual(res.status, 500);
  await settle();
  assert.deepStrictEqual(unhandled, []);
});

test('a failed history read is the route\'s 500, and the reads started beside it settle quietly', async () => {
  failing.add('history');
  failing.add('roster');
  failing.add('pins');
  const res = await get('/api/flocks/1/messages?limit=50');
  assert.strictEqual(res.status, 500);
  await settle();
  assert.deepStrictEqual(unhandled, []);
});

test('the roster and the pins are asked for before the history read answers', async () => {
  let release;
  historyGate = new Promise((r) => { release = r; });
  const pending = get('/api/flocks/1/messages?limit=50');
  for (let i = 0; i < 50 && !(order.includes('roster') && order.includes('pins')); i += 1) await settle();
  // What had been asked for while the history read was held; released before
  // any assertion so a failure here cannot leave the request hanging.
  const beforeHistoryAnswered = [...order];
  release();
  const res = await pending;
  assert.strictEqual(res.status, 200);
  assert.ok(beforeHistoryAnswered.includes('history'), 'the history read was sent');
  assert.ok(beforeHistoryAnswered.includes('roster') && beforeHistoryAnswered.includes('pins'),
    `asked for before the history answered: ${beforeHistoryAnswered.join(', ')}`);
  assert.ok(!beforeHistoryAnswered.includes('reactions'), 'reactions wait for the page');
});
