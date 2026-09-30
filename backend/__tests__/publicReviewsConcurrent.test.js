// Run: node --test  (from backend/)
//
// THE PUBLIC REVIEWS READ ASKS ITS TWO QUESTIONS TOGETHER.
//
// GET /api/venue-dashboard/public-reviews/:placeId reads the venue's review
// count and average, and a page of reviews. Neither needs the other, so both
// go out before either answers. Pinned here:
//   1. The answer is the same shape it always was.
//   2. Both reads are asked for before either one answers.
//   3. Either read failing is still the route's 500.
//   4. The stats read is sent as a named statement, one name per text.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'public-reviews-concurrent-test-secret';
delete process.env.DEMO_USER_IDS;

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');
const { preparedName } = require('../db/prepared');

const ME = { id: 5, email: 'me@example.com', name: 'Me', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const TOKEN = signUserToken(ME);
const PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

let failing = new Set();
let order = [];
let gate = null;
const texts = {};

function kindOf(sql) {
  if (sql.includes('token_version FROM users WHERE id = $1')) return 'auth';
  if (sql.includes('COUNT(*)::int AS total, AVG(vr.rating)::float AS average')) return 'stats';
  if (sql.includes('SELECT vr.id, vr.rating, vr.text')) return 'page';
  return 'other';
}

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const raw = String(text && typeof text === 'object' ? text.text : text);
  const kind = kindOf(raw.replace(/\s+/g, ' '));
  texts[kind] = raw;
  order.push(kind);
  if ((kind === 'stats' || kind === 'page') && gate) await gate;
  if (failing.has(kind)) throw Object.assign(new Error(`${kind} read failed`), { code: '57P01' });
  switch (kind) {
    case 'auth': return { rows: [ME], rowCount: 1 };
    case 'stats': return { rows: [{ total: 2, average: 4.5 }], rowCount: 1 };
    case 'page': return {
      rows: [
        { id: 9, rating: 5, text: 'great', venue_reply: null, venue_replied_at: null, created_at: new Date('2026-09-30T12:00:00Z'), user_id: 6, name: 'Ana' },
        { id: 8, rating: 4, text: 'good', venue_reply: null, venue_replied_at: null, created_at: new Date('2026-09-29T12:00:00Z'), user_id: 7, name: 'Bo' },
      ],
      rowCount: 2,
    };
    default: return { rows: [], rowCount: 0 };
  }
};

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', require('../routes/venueDashboard'));
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
test.after(() => { pool.query = realQuery; });
test.beforeEach(() => { failing = new Set(); order = []; gate = null; });

test('the answer keeps its shape', async () => {
  const res = await get(`/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 2);
  assert.strictEqual(res.body.average, 4.5);
  assert.deepStrictEqual(res.body.reviews.map((r) => r.id), [9, 8]);
  assert.strictEqual(res.body.hasMore, false);
});

test('both reads are asked for before either one answers', async () => {
  let release;
  gate = new Promise((r) => { release = r; });
  const pending = get(`/api/venue-dashboard/public-reviews/${PLACE}`);
  for (let i = 0; i < 50 && !(order.includes('stats') && order.includes('page')); i += 1) await settle();
  const asked = [...order];
  release();
  const res = await pending;
  assert.strictEqual(res.status, 200);
  assert.ok(asked.includes('stats') && asked.includes('page'), `asked while both were held: ${asked.join(', ')}`);
});

for (const kind of ['stats', 'page']) {
  test(`a failed ${kind} read is the route's 500`, async () => {
    failing.add(kind);
    const res = await get(`/api/venue-dashboard/public-reviews/${PLACE}`);
    assert.strictEqual(res.status, 500);
  });
}

test('the stats read is registered as a named statement and the page read is not', async () => {
  await get(`/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.match(preparedName(texts.stats) || '', /^public-reviews-stats-[0-9a-f]{12}$/);
  assert.strictEqual(preparedName(texts.page), null);
});

test('a different demo list is a different text under a different name, not a clash', async () => {
  const first = preparedName(texts.stats);
  process.env.DEMO_USER_IDS = '900001,900002';
  try {
    const res = await get(`/api/venue-dashboard/public-reviews/${PLACE}`);
    assert.strictEqual(res.status, 200);
    const second = preparedName(texts.stats);
    assert.match(texts.stats, /900001,900002/);
    assert.ok(second && second !== first, `${first} then ${second}`);
  } finally {
    delete process.env.DEMO_USER_IDS;
  }
});
