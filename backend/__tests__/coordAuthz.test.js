// Run: node --test  (from backend/)
//
// Coordination-core ID bounds (audit 2026-08-14).
//
// flocks / budget / billing / messages / friends all take a numeric id in a
// path param or body, and every id column in the schema is SERIAL — i.e. INT4,
// ceiling 2147483647 (migrations 000/001). express-validator `isInt()` with no
// bound accepts "9999999999": it is a valid integer, just not a valid INT4. That
// value passed validation and reached the query, where Postgres answered
// "integer out of range" (22003) and the route turned it into a 500.
//
// This is the same failure class routesReliability.test.js pins for
// admin.js / venueDashboard.js, and the reason friends.js already bounds user
// ids with MAX_USER_ID. These tests pin the rest of it: an id past the INT4
// ceiling is a 400 that never reaches a query.
//
// No database. pool.query answers the auth lookup and THROWS a 22003 if any
// out-of-range id ever reaches it — so a passing 400 proves the validator
// returned BEFORE the query, not that the harness tolerated a bad value.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'coord-authz-test-secret';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const INT4_MAX = 2147483647;
const OVERSIZED = String(INT4_MAX + 1); // 2147483648 — a valid integer, not a valid INT4

const USER = { id: 1, email: 'a@example.com', name: 'Alice', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const TOKEN = signUserToken(USER);

let issued; // non-auth queries the routes actually issued

function outOfRange(v) {
  if (Array.isArray(v)) return v.some(outOfRange);
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) > INT4_MAX;
}

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  // middleware/auth.js user lookup — never a "route" query.
  if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) {
    return { rows: [USER], rowCount: 1 };
  }

  issued.push({ sql, params });

  // Simulate the real INT4 column: an out-of-range id that got this far is the
  // exact 500 the bound is meant to prevent.
  if (params.some(outOfRange)) {
    const e = new Error('integer out of range');
    e.code = '22003';
    throw e;
  }

  // Benign default so a valid-id positive control can complete.
  return { rows: [], rowCount: 0 };
};

// pool.connect is only reached AFTER validation on the routes that use a
// transaction; if a bound is missing the validator 400s first and this is never
// called. Guard it so a regression surfaces as a thrown error, not a hang.
pool.connect = async () => { throw new Error('pool.connect reached — validation did not short-circuit'); };

const app = express();
app.use(express.json());
app.use('/api/flocks', require('../routes/flocks'));
app.use('/api', require('../routes/messages'));
app.use('/api/budget', require('../routes/budget'));
app.use('/api/billing', require('../routes/billing'));
app.use('/api/friends', require('../routes/friends'));
const server = http.createServer(app);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const addr = server.address();
    const req = http.request({
      host: '127.0.0.1', port: addr.port, path, method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', r)));
test.after(() => { pool.query = realQuery; server.close(); });

// Every coordination-core route that takes an id, with an OVERSIZED id in the
// spot the id lives. Bodies are otherwise valid so the ONLY thing wrong is the
// id — which must still be caught before any query runs.
const CASES = [
  // flocks.js (mounted /api/flocks)
  ['GET',    `/api/flocks/${OVERSIZED}`],
  ['PUT',    `/api/flocks/${OVERSIZED}`, { name: 'x' }],
  ['DELETE', `/api/flocks/${OVERSIZED}`],
  ['POST',   `/api/flocks/${OVERSIZED}/join`],
  ['POST',   `/api/flocks/${OVERSIZED}/invite-link`],
  ['POST',   `/api/flocks/${OVERSIZED}/invite`, { user_ids: [2] }],
  ['POST',   `/api/flocks/${OVERSIZED}/decline`],
  ['POST',   `/api/flocks/${OVERSIZED}/leave`],
  ['GET',    `/api/flocks/${OVERSIZED}/members`],
  ['POST',   `/api/flocks/${OVERSIZED}/attendance`, { attendance: [{ userId: 2, attended: true }] }],
  // messages.js (mounted /api)
  ['GET',    `/api/flocks/${OVERSIZED}/messages`],
  ['POST',   `/api/flocks/${OVERSIZED}/messages`, { message_text: 'hi' }],
  ['POST',   `/api/messages/${OVERSIZED}/react`, { emoji: '👍' }],
  ['DELETE', `/api/messages/${OVERSIZED}/react/%F0%9F%91%8D`],
  ['GET',    `/api/dm/${OVERSIZED}`],
  ['POST',   `/api/dm/${OVERSIZED}`, { message_text: 'hi' }],
  ['POST',   `/api/dm/messages/${OVERSIZED}/react`, { emoji: '👍' }],
  ['DELETE', `/api/dm/messages/${OVERSIZED}/react/x`],
  ['GET',    `/api/dm/${OVERSIZED}/venue-votes`],
  ['POST',   `/api/dm/${OVERSIZED}/venue-votes`, { venue_name: 'The Fig' }],
  ['PUT',    `/api/dm/${OVERSIZED}/read`],
  ['GET',    `/api/dm/${OVERSIZED}/pinned-venue`],
  ['PUT',    `/api/dm/${OVERSIZED}/pinned-venue`, { venue_name: 'The Fig' }],
  // budget.js (mounted /api/budget)
  ['POST',   `/api/budget/${OVERSIZED}/submit`, { amount: 40 }],
  ['GET',    `/api/budget/${OVERSIZED}`],
  ['POST',   `/api/budget/${OVERSIZED}/lock`],
  ['POST',   `/api/budget/${OVERSIZED}/remind`],
  // billing.js (mounted /api/billing)
  ['POST',   `/api/billing/${OVERSIZED}/create`, { totalAmount: 40 }],
  ['GET',    `/api/billing/${OVERSIZED}`],
  ['POST',   `/api/billing/${OVERSIZED}/settle`],
  ['POST',   `/api/billing/${OVERSIZED}/ghost-commit`],
  ['GET',    `/api/billing/${OVERSIZED}/venmo-link`],
  ['GET',    `/api/billing/${OVERSIZED}/payment-links`],
  // friends.js (mounted /api/friends)
  ['POST',   `/api/friends/request`, { user_id: OVERSIZED }],
  ['POST',   `/api/friends/accept`, { user_id: OVERSIZED }],
  ['POST',   `/api/friends/decline`, { user_id: OVERSIZED }],
  ['DELETE', `/api/friends/${OVERSIZED}`],
  ['GET',    `/api/friends/status/${OVERSIZED}`],
];

for (const [method, path, body] of CASES) {
  test(`${method} ${path} — oversized id is a 400, never a query`, async () => {
    issued = [];
    const res = await request(method, path, body);
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status} (${JSON.stringify(res.json)})`);
    assert.strictEqual(issued.length, 0, `no query should run for a rejected id, but ${issued.length} did: ${JSON.stringify(issued.map((q) => q.sql))}`);
  });
}

// billing paidBy is a body id on an otherwise-valid flock — bounding the param
// is not enough, the payer id has to be bounded too.
test('POST /api/billing/:flockId/create — oversized paidBy is a 400, never a query', async () => {
  issued = [];
  const res = await request('POST', '/api/billing/10/create', { totalAmount: 40, paidBy: OVERSIZED });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status} (${JSON.stringify(res.json)})`);
  assert.strictEqual(issued.length, 0, `no query should run: ${JSON.stringify(issued.map((q) => q.sql))}`);
});

// Positive control: a normal, in-range id is NOT rejected by the new bound — it
// passes validation and reaches the query layer. GET /api/friends/status/:id
// has no gate before its single friendships lookup, so a 200 here proves the
// bound accepts real ids (and did not turn every id into a 400).
test('GET /api/friends/status/:id — an in-range id passes the bound and reaches the query', async () => {
  issued = [];
  const res = await request('GET', '/api/friends/status/2');
  assert.strictEqual(res.status, 200, `expected 200, got ${res.status} (${JSON.stringify(res.json)})`);
  assert.ok(issued.length > 0, 'the friendships lookup should have run for a valid id');
  assert.deepStrictEqual(res.json, { status: 'none' });
});
