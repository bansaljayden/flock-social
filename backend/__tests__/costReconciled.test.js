// Run: node --test  (from backend/)
//
// THE RECONCILED INVOICE FIGURE IS RECORDED FROM THE DASHBOARD, NOT IN CODE.
//
// services/costModel.js carried RECONCILED as a hand-edited constant, and on
// 2026-09-01 it had stood twelve days stale at a mid-month snapshot because
// recording a bill meant editing a source file. Migration 059 adds
// cost_reconciled; this pins the seam around it:
//   1. readReconciled merges a saved row OVER the code constant for that line,
//      leaves lines with no row on the code figure, says which is which, and
//      dates the block by the newest line actually used.
//   2. A database failure degrades to the code figures, marked, never to nothing.
//   3. POST /api/admin/costs/reconciled validates by hand and upserts.

const test = require('node:test');
const assert = require('node:assert');

const pool = require('../config/database');
const costModel = require('../services/costModel');

let rows = [];
let queryError = null;
const writes = [];
pool.query = async (text, params) => {
  if (queryError) throw queryError;
  const sql = String(text).replace(/\s+/g, ' ');
  if (sql.startsWith('INSERT INTO cost_reconciled')) {
    writes.push(params);
    return { rows: [] };
  }
  if (sql.includes('FROM cost_reconciled')) return { rows };
  return { rows: [] };
};

const CODE = costModel.RECONCILED;
const firstId = CODE.lines[0].id;

test.beforeEach(() => { rows = []; queryError = null; writes.length = 0; });

test('with no saved rows every line reads from code and the block keeps the code date', async () => {
  const r = await costModel.readReconciled(pool);
  assert.equal(r.lines.length, CODE.lines.length);
  for (const l of r.lines) assert.equal(l.source, 'code');
  assert.equal(r.lines[0].usdPerMonth, CODE.lines[0].usdPerMonth);
  assert.equal(r.asOf, CODE.asOf);
  assert.equal(r.readError, null);
});

test('a saved row wins over the code constant for its line and moves the block date', async () => {
  rows = [{ line_id: firstId, usd_per_month: '42.50', as_of: '2026-09-15', note: 'September invoice', updated_at: 'x' }];
  const r = await costModel.readReconciled(pool);
  const l = r.lines.find((x) => x.id === firstId);
  assert.equal(l.source, 'dashboard');
  assert.equal(l.usdPerMonth, 42.5);
  assert.equal(l.asOf, '2026-09-15');
  assert.equal(l.note, 'September invoice');
  assert.equal(r.asOf, '2026-09-15', 'the block is dated by the newest line actually used');
});

test('a row for an unknown line id is ignored rather than invented into the block', async () => {
  rows = [{ line_id: 'not-a-line', usd_per_month: '999', as_of: '2026-09-15', note: null }];
  const r = await costModel.readReconciled(pool);
  assert.ok(!r.lines.some((l) => l.id === 'not-a-line'));
  for (const l of r.lines) assert.equal(l.source, 'code');
});

test('a database failure degrades to the code figures and says so', async () => {
  queryError = new Error('connection terminated');
  const r = await costModel.readReconciled(pool);
  for (const l of r.lines) assert.equal(l.source, 'code');
  assert.equal(r.lines[0].usdPerMonth, CODE.lines[0].usdPerMonth);
  assert.match(r.readError, /connection terminated/);
});

// ---------------------------------------------------------------------------
// The route. Exercised through a minimal express app with the admin gate
// satisfied, so the validation and the upsert are what is under test.
// ---------------------------------------------------------------------------
const express = require('express');
const http = require('node:http');

process.env.ADMIN_USER_IDS = process.env.ADMIN_USER_IDS || '7';
const authMod = require('../middleware/auth');
authMod.authenticate = (req, res, next) => { req.user = { id: 7, role: 'admin' }; next(); };
const adminRouter = require('../routes/admin');

function withServer(fn) {
  return async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/costs/reconciled`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    try { await fn(post); } finally { await new Promise((r) => server.close(r)); }
  };
}

test('an unknown line id is refused and the known ids are named', withServer(async (post) => {
  const r = await post({ id: 'nope', usdPerMonth: 10, asOf: '2026-09-01' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, new RegExp(firstId));
  assert.equal(writes.length, 0);
}));

test('a negative, huge or non-numeric amount is refused', withServer(async (post) => {
  for (const bad of [-1, 1e9, 'x', null]) {
    const r = await post({ id: firstId, usdPerMonth: bad, asOf: '2026-09-01' });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  assert.equal(writes.length, 0);
}));

test('a malformed or future date is refused', withServer(async (post) => {
  for (const bad of ['yesterday', '2026-13-40', '2999-01-01', 20260901]) {
    const r = await post({ id: firstId, usdPerMonth: 10, asOf: bad });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  assert.equal(writes.length, 0);
}));

test('a valid entry upserts the row for that line, stamped by the admin, and returns the merged block', withServer(async (post) => {
  const r = await post({ id: firstId, usdPerMonth: '31.19', asOf: '2026-09-01', note: '  paid  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], [firstId, 31.19, '2026-09-01', 'paid', 7]);
  assert.ok(r.body.reconciled && Array.isArray(r.body.reconciled.lines), 'the response carries the merged block');
}));
