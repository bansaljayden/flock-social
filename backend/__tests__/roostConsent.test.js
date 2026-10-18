// Run: node --test __tests__/roostConsent.test.js  (from backend/)
//
// ROOST ASKS BEFORE A TYPED QUESTION GOES TO GEMINI.
//
// A venue owner's typed question goes to Google's Gemini with the venue's name,
// its numbers and the details the owner filled in. App Store Guideline 5.1.2(i)
// asks for explicit permission first, so the app asks before the first typed
// question (frontend components/VenueAdvisorChat.js) and the answer is
// users.roost_ai_consent_at (migration 127). POST /api/venue/advisor/question
// refuses without it; advisorFreeText.test.js pins that half. This file pins
// where the answer is recorded and withdrawn: /api/ai/roost-consent, beside
// Birdie's own answer, because routes/advisor.js has no write path by design.
//
//   1. Allow records a time, and a repeated Allow keeps the first one
//   2. withdraw clears it
//   3. Roost's answer and Birdie's are separate columns: neither statement
//      touches the other
//   4. routes/advisor.js still has no write path of its own

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'roost-consent-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
delete process.env.NODE_ENV;

const pool = require('../config/database');
const roostAt = new Map(); // user id -> Date | null
let sql = [];
pool.query = (text, params = []) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  sql.push(flat);
  const id = params[0];
  if (flat === 'UPDATE users SET roost_ai_consent_at = COALESCE(roost_ai_consent_at, NOW()) WHERE id = $1 RETURNING roost_ai_consent_at') {
    if (!roostAt.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    if (!roostAt.get(id)) roostAt.set(id, new Date());
    return Promise.resolve({ rows: [{ roost_ai_consent_at: roostAt.get(id) }], rowCount: 1 });
  }
  if (flat === 'UPDATE users SET roost_ai_consent_at = NULL WHERE id = $1 RETURNING id') {
    if (!roostAt.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    roostAt.set(id, null);
    return Promise.resolve({ rows: [{ id }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Pat' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const aiRouter = require('../routes/ai');
const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

let nextUserId = 7000;
test.beforeEach(() => {
  CURRENT_USER = { id: ++nextUserId, name: 'Pat' };
  roostAt.set(CURRENT_USER.id, null);
  sql = [];
});

async function call(method, urlPath) {
  const res = await fetch(`${base}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' } });
  return { status: res.status, body: await res.json() };
}

test('Allow records a time, and a repeated Allow keeps the first one', async () => {
  const first = await call('POST', '/api/ai/roost-consent');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.consented, true);
  assert.ok(first.body.consentedAt);
  const again = await call('POST', '/api/ai/roost-consent');
  assert.strictEqual(again.body.consentedAt, first.body.consentedAt);
});

test('withdraw clears it', async () => {
  await call('POST', '/api/ai/roost-consent');
  const off = await call('DELETE', '/api/ai/roost-consent');
  assert.strictEqual(off.status, 200);
  assert.deepStrictEqual(off.body, { consented: false, consentedAt: null });
  assert.strictEqual(roostAt.get(CURRENT_USER.id), null);
});

test('Roost\'s answer and Birdie\'s are separate: neither statement touches the other column', async () => {
  await call('POST', '/api/ai/roost-consent');
  await call('DELETE', '/api/ai/roost-consent');
  assert.ok(sql.length >= 2);
  for (const s of sql) assert.ok(!/birdie_ai_consent/.test(s), `a Roost statement touched Birdie's answer: ${s}`);
});

test('an account that is gone gets a 404, not a recorded yes', async () => {
  roostAt.delete(CURRENT_USER.id);
  const r = await call('POST', '/api/ai/roost-consent');
  assert.strictEqual(r.status, 404);
});

test('routes/advisor.js reads the answer and still writes nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'advisor.js'), 'utf8');
  assert.match(src, /SELECT roost_ai_consent_at FROM users WHERE id = \$1/);
  assert.ok(!/router\.(put|patch|delete)\(/.test(src));
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\b(INSERT INTO|UPDATE users)\b/.test(code), 'the advisor route does not write the answer itself');
});
