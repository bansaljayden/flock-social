// Run: node --test  (from backend/)
//
// THE DM THREAD'S TWO GATES, ASKED TOGETHER.
//
// GET /api/dm/:userId hides the thread when the pair is blocked either way or
// the counterpart is banned. The two reads go out at the same time. Asked one
// after the other, a blocked pair was answered by the block read and the ban
// read never ran, so a refusal has to outrank the other read failing:
//   1. Blocked, and the ban read fails: still the blocked answer, not a 500.
//   2. Banned, and the block read fails: the blocked answer too.
//   3. Neither refuses and one read fails: the route's 500, since nothing
//      answered for that pair.
//   4. A refused thread is never read.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'dm-gate-precedence-test-secret';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ME = { id: 5, email: 'me@example.com', name: 'Me', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const TOKEN = signUserToken(ME);

let answers = {};
let order = [];

function kindOf(sql) {
  if (sql.includes('token_version FROM users WHERE id = $1')) return 'auth';
  if (sql.includes('FROM user_blocks') && sql.includes('blocker_id = $1 AND blocked_id = $2')) return 'block';
  if (sql.includes('FROM users WHERE id = $1 AND is_banned IS TRUE')) return 'ban';
  if (sql.includes('FROM direct_messages dm') && sql.includes('ORDER BY dm.id DESC')) return 'thread';
  return 'other';
}

const realQuery = pool.query;
pool.query = async (text) => {
  const sql = String(text && typeof text === 'object' ? text.text : text).replace(/\s+/g, ' ');
  const kind = kindOf(sql);
  order.push(kind);
  const answer = answers[kind];
  if (answer === 'fail') throw Object.assign(new Error(`${kind} read failed`), { code: '57P01' });
  switch (kind) {
    case 'auth': return { rows: [ME], rowCount: 1 };
    case 'block':
    case 'ban': return answer === true ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    default: return { rows: [], rowCount: 0 };
  }
};

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

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; });
test.beforeEach(() => { answers = {}; order = []; });

test('a blocked pair gets the blocked answer even when the ban read fails', async () => {
  answers = { block: true, ban: 'fail' };
  const res = await get('/api/dm/6');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { messages: [], blocked: true });
  assert.ok(!order.includes('thread'), 'a refused thread is never read');
});

test('a banned counterpart gets the blocked answer even when the block read fails', async () => {
  answers = { block: 'fail', ban: true };
  const res = await get('/api/dm/6');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { messages: [], blocked: true });
  assert.ok(!order.includes('thread'), 'a refused thread is never read');
});

for (const failed of ['block', 'ban']) {
  test(`with no refusal, a failed ${failed} read is the route's 500 and the thread is not read`, async () => {
    answers = { block: false, ban: false, [failed]: 'fail' };
    const res = await get('/api/dm/6');
    assert.strictEqual(res.status, 500);
    assert.ok(!order.includes('thread'));
  });
}

test('both gates asked, neither refusing: the thread is read', async () => {
  answers = { block: false, ban: false };
  const res = await get('/api/dm/6');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.messages, []);
  assert.ok(order.includes('block') && order.includes('ban') && order.includes('thread'));
});
