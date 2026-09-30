// Run: node --test  (from backend/)
//
// THE CHAT HISTORY READ AND ITS DECORATIONS.
//
// GET /api/flocks/:id/messages reads a page of history and decorates it with
// reactions, reply quotes, the receipt roster and the pins. The four
// decorations go out together once the page is back. The roster and the pins
// could start sooner, but the app replaces its receipts and its pin bar with
// this response while live events update both, so they are read last to keep
// that snapshot fresh.
// Pinned here:
//   1. A full page comes back decorated.
//   2. A failed roster, pins or quote read costs that decoration only: 200.
//   3. A failed reactions read, or a failed history read, is the route's 500,
//      and nothing is left as an unhandled rejection.
//   4. No decoration is asked for before the history read answers, and all
//      four are asked for before any of them answers.

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
let decorationGate = null;
const DECORATIONS = ['reactions', 'quotes', 'roster', 'pins'];

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
  if (DECORATIONS.includes(kind) && decorationGate) await decorationGate;
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
test.beforeEach(() => { failing = new Set(); order = []; historyGate = null; decorationGate = null; unhandled.length = 0; });

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

test('a failed history read is the route\'s 500 and spends no decoration read', async () => {
  failing.add('history');
  const res = await get('/api/flocks/1/messages?limit=50');
  assert.strictEqual(res.status, 500);
  await settle();
  assert.deepStrictEqual(unhandled, []);
  assert.deepStrictEqual(order.filter((k) => DECORATIONS.includes(k)), []);
});

test('the decorations wait for the page, then all four go out together', async () => {
  let releaseHistory;
  historyGate = new Promise((r) => { releaseHistory = r; });
  let releaseDecorations;
  decorationGate = new Promise((r) => { releaseDecorations = r; });
  const pending = get('/api/flocks/1/messages?limit=50');
  for (let i = 0; i < 50 && !order.includes('history'); i += 1) await settle();
  await settle();
  // What had been asked for while the history read was held.
  const beforeHistoryAnswered = [...order];
  releaseHistory();
  // Every decoration read is held now, so a route that awaited one before
  // sending the next would stop at one and never ask for the other three.
  for (let i = 0; i < 50 && !DECORATIONS.every((k) => order.includes(k)); i += 1) await settle();
  const beforeAnyDecorationAnswered = [...order];
  // Released before any assertion so a failure cannot leave the request hanging.
  releaseDecorations();
  const res = await pending;
  assert.strictEqual(res.status, 200);
  assert.ok(beforeHistoryAnswered.includes('history'), 'the history read was sent');
  assert.deepStrictEqual(beforeHistoryAnswered.filter((k) => DECORATIONS.includes(k)), [],
    `nothing is decorated before the page: ${beforeHistoryAnswered.join(', ')}`);
  for (const k of DECORATIONS) {
    assert.ok(beforeAnyDecorationAnswered.includes(k),
      `${k} asked for before any decoration answered: ${beforeAnyDecorationAnswered.join(', ')}`);
  }
});
