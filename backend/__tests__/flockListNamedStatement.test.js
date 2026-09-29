// Run: node --test  (from backend/)
//
// THE FLOCK LIST RUNS AS A NAMED STATEMENT AND FALLS BACK WHEN A MIGRATION
// CHANGES ITS RESULT ROW.
//
// GET /api/flocks is parsed and planned once per pooled connection instead of
// on every request (routes/flocks.js, queryFlockList). Its SELECT starts with
// `f.*`, so a migration that adds a column to flocks makes Postgres refuse the
// already-prepared statement with 0A000 on the server that was running before
// the deploy. Pinned here:
//   1. The list goes out named, with the same text and values as before.
//   2. On 0A000 the same request answers from an unnamed query, and every later
//      request in this process skips the named one.
//   3. Any other database error still reaches the route's own 500.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'flock-list-named-test-secret';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ME = { id: 5, email: 'me@example.com', name: 'Me', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const TOKEN = signUserToken(ME);

let calls = [];
let namedFailure = null;
const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const named = text && typeof text === 'object';
  const sql = String(named ? text.text : text).replace(/\s+/g, ' ').trim();
  if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) {
    return { rows: [ME], rowCount: 1 };
  }
  if (sql.includes('FROM flocks f')) {
    calls.push({ name: named ? text.name : null, values: named ? text.values : params });
    if (named && namedFailure) throw namedFailure;
    return { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};

const app = express();
app.use(express.json());
app.use('/api/flocks', require('../routes/flocks'));
const server = http.createServer(app);

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false,
      host: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET',
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
test.after(() => { pool.query = realQuery; });

test('the list goes out as one named statement with the caller and the cap', async () => {
  calls = [];
  const res = await get('/api/flocks');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { flocks: [] });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'flocks-list');
  assert.strictEqual(calls[0].values[0], ME.id);
});

test('any other database error is still the route\'s 500, and the name stays in use', async () => {
  calls = [];
  namedFailure = Object.assign(new Error('connection terminated'), { code: '57P01' });
  const res = await get('/api/flocks');
  assert.strictEqual(res.status, 500);
  assert.strictEqual(calls.length, 1, 'no second attempt on an unrelated error');
  namedFailure = null;
  calls = [];
  await get('/api/flocks');
  assert.strictEqual(calls[0].name, 'flocks-list');
});

test('a changed result row (0A000) answers the same request unnamed, and later ones skip the name', async () => {
  calls = [];
  namedFailure = Object.assign(new Error('cached plan must not change result type'), { code: '0A000' });
  const res = await get('/api/flocks');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { flocks: [] });
  assert.deepStrictEqual(calls.map((c) => c.name), ['flocks-list', null]);
  assert.deepStrictEqual(calls[1].values, calls[0].values, 'the fallback sends the same values');

  calls = [];
  const again = await get('/api/flocks');
  assert.strictEqual(again.status, 200);
  assert.deepStrictEqual(calls.map((c) => c.name), [null]);
  namedFailure = null;
});
