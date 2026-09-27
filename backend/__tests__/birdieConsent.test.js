// Run: node --test  (from backend/)
//
// BIRDIE ASKS BEFORE ANYTHING GOES TO GEMINI, AND THE SERVER HOLDS THE LINE.
//
// Every Birdie turn sends the user's messages, first name, age range, what they
// have open in the app, their area when location is on, and on request their
// plans and friends' names to Google's Gemini. App Store Guideline 5.1.2(i)
// asks for explicit permission before personal data goes to a third-party AI.
// The app asks once, before the first message (components/birdie/BirdiePanel
// .js), and the answer is users.birdie_ai_consent_at (migration 099).
//
// The question in the app is cosmetic on its own: a cached older bundle never
// shows it and any client can call the route. So this file drives the real
// router and pins the server side:
//   1. no recorded consent: 403 BIRDIE_CONSENT_REQUIRED, Gemini never called,
//      no chat created, the user's name and birthday never even read
//   2. a refusal costs no message from the user's day
//   3. Allow records a time, a repeated Allow keeps the first one, withdraw
//      clears it, and /chat follows each change on the very next turn
//   4. nothing the client sends can stand in for the recorded answer

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-consent-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;

// --- a users table with one column that matters ----------------------------
const pool = require('../config/database');
const consentAt = new Map(); // user id -> Date | null
let sql = [];
pool.query = (text, params = []) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  sql.push(flat);
  const id = params[0];
  if (/^SELECT birdie_ai_consent_at FROM users WHERE id = \$1$/.test(flat)) {
    if (!consentAt.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({ rows: [{ birdie_ai_consent_at: consentAt.get(id) }], rowCount: 1 });
  }
  if (/^UPDATE users SET birdie_ai_consent_at = COALESCE\(birdie_ai_consent_at, NOW\(\)\) WHERE id = \$1 RETURNING birdie_ai_consent_at$/.test(flat)) {
    if (!consentAt.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    if (!consentAt.get(id)) consentAt.set(id, new Date());
    return Promise.resolve({ rows: [{ birdie_ai_consent_at: consentAt.get(id) }], rowCount: 1 });
  }
  if (/^UPDATE users SET birdie_ai_consent_at = NULL WHERE id = \$1 RETURNING id$/.test(flat)) {
    if (!consentAt.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    consentAt.set(id, null);
    return Promise.resolve({ rows: [{ id }], rowCount: 1 });
  }
  if (/FROM users WHERE id/.test(flat)) {
    return Promise.resolve({ rows: [{ name: 'Ava Lee', date_of_birth: '2000-01-01' }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// --- Gemini, faked, and counted ---------------------------------------------
const genaiMod = require('@google/genai');
let chatsCreated = 0;
let sendCalls = 0;
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: () => {
        chatsCreated += 1;
        return {
          sendMessage: async () => {
            sendCalls += 1;
            return { candidates: [{ content: { parts: [{ text: 'oakwood, chill till 9' }] } }] };
          },
        };
      },
    },
  };
};

const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json({ limit: '2mb' }));
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

// A fresh account per test: the turn meter has no reset hook by design.
let nextUserId = 5000;
test.beforeEach(() => {
  CURRENT_USER = { id: ++nextUserId, name: 'Ava' };
  consentAt.set(CURRENT_USER.id, null);
  sql = [];
  chatsCreated = 0;
  sendCalls = 0;
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}
const chat = (extra = {}) => call('POST', '/api/ai/chat', {
  messages: [{ role: 'user', text: "what's the move tonight" }],
  location: { lat: 39.9526, lng: -75.1652 },
  ...extra,
});

test('with no recorded consent, a turn is refused and nothing reaches Gemini', async () => {
  const res = await chat();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'BIRDIE_CONSENT_REQUIRED');
  assert.match(res.body.error, /Google's Gemini/, 'an older app with no question to show still says why');
  assert.strictEqual(chatsCreated, 0, 'no Gemini chat is even created');
  assert.strictEqual(sendCalls, 0, 'nothing is sent to Gemini');
  // The consent read is the only thing the refused turn did. The name and
  // birthday the prompt is built from were never read.
  assert.deepStrictEqual(sql, ['SELECT birdie_ai_consent_at FROM users WHERE id = $1']);
});

test('a refused turn costs no message from the day', async () => {
  // Twenty refusals, past the 15-a-minute turn meter. If a refusal charged a
  // turn, the first allowed message below would be refused as rate limited.
  for (let i = 0; i < 20; i += 1) {
    const res = await chat();
    assert.strictEqual(res.status, 403);
  }
  assert.strictEqual((await call('POST', '/api/ai/consent')).status, 200);
  const ok = await chat();
  assert.strictEqual(ok.status, 200, `expected an answer, got ${ok.status} ${JSON.stringify(ok.body)}`);
  assert.strictEqual(sendCalls, 1);
});

test('Allow records the time, and the next turn goes through', async () => {
  const before = await call('GET', '/api/ai/consent');
  assert.deepStrictEqual(before.body, { consented: false, consentedAt: null });

  const granted = await call('POST', '/api/ai/consent');
  assert.strictEqual(granted.status, 200);
  assert.strictEqual(granted.body.consented, true);
  assert.ok(!Number.isNaN(Date.parse(granted.body.consentedAt)), 'the time it was given comes back');

  const res = await chat();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.text, 'oakwood, chill till 9');
  assert.strictEqual(sendCalls, 1);
});

test('a second Allow keeps the time consent was first given', async () => {
  const first = await call('POST', '/api/ai/consent');
  await new Promise((r) => setTimeout(r, 15));
  const second = await call('POST', '/api/ai/consent');
  assert.strictEqual(second.body.consentedAt, first.body.consentedAt);
});

test('withdrawing consent stops the very next turn, and asking again works', async () => {
  await call('POST', '/api/ai/consent');
  assert.strictEqual((await chat()).status, 200);

  const withdrawn = await call('DELETE', '/api/ai/consent');
  assert.strictEqual(withdrawn.status, 200);
  assert.deepStrictEqual(withdrawn.body, { consented: false, consentedAt: null });
  assert.strictEqual(consentAt.get(CURRENT_USER.id), null);

  const refused = await chat();
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(refused.body.code, 'BIRDIE_CONSENT_REQUIRED');
  assert.strictEqual(sendCalls, 1, 'only the turn before the withdrawal reached Gemini');

  await call('POST', '/api/ai/consent');
  assert.strictEqual((await chat()).status, 200);
});

test('nothing in the request can stand in for the recorded answer', async () => {
  for (const extra of [{ consent: true }, { birdie_ai_consent_at: new Date().toISOString() }, { birdieAiConsent: 'granted' }]) {
    const res = await chat(extra);
    assert.strictEqual(res.status, 403, `${JSON.stringify(extra)} must not unlock Birdie`);
  }
  assert.strictEqual(sendCalls, 0);
});

test('an account row that is gone is refused too, not treated as consenting', async () => {
  consentAt.delete(CURRENT_USER.id);
  assert.strictEqual((await chat()).status, 403);
  assert.strictEqual((await call('POST', '/api/ai/consent')).status, 404);
  assert.strictEqual((await call('DELETE', '/api/ai/consent')).status, 404);
  assert.strictEqual((await call('GET', '/api/ai/consent')).status, 404);
  assert.strictEqual(sendCalls, 0);
});

test('a database failure on the consent read is a 500, never a pass', async () => {
  const real = pool.query;
  pool.query = (text, params) => (/birdie_ai_consent_at/.test(String(text))
    ? Promise.reject(new Error('connection terminated unexpectedly'))
    : real(text, params));
  const errors = console.error;
  console.error = () => {};
  try {
    const res = await chat();
    assert.strictEqual(res.status, 500);
    assert.strictEqual(sendCalls, 0);
  } finally {
    pool.query = real;
    console.error = errors;
  }
});
