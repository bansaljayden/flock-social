// Run: node --test  (from backend/)
//
// A BIRDIE TOOL THAT THROWS TELLS THE MODEL "lookup_failed", NOTHING MORE.
//
// routes/ai.js runs the tools Gemini asks for and hands each result back as
// the next message. When a tool threw, the catch handed back the error's own
// text, `{ error: err.message }`, and the model reads a tool result as
// material for its answer. So a Postgres failure ("relation ... does not
// exist", "password authentication failed for user ...") or a fetch failure
// naming an internal host could be quoted to the person asking about their
// friends. The log is where that text belongs.
//
// Pinned through the real route, with Gemini and Postgres faked: the tool
// result is exactly { error: 'lookup_failed' }, the raw text appears nowhere
// in anything Gemini was sent, the real error is still logged, and the turn
// still answers.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-tool-failure-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
// posthog-node holds a connection open, and NODE_ENV is deleted above.
delete process.env.POSTHOG_API_KEY;

// What a real failure looks like: the database's own words, with a role name
// and an internal address in them.
const RAW = 'password authentication failed for user "flock_app" at 10.0.3.7:5432';

// --- the database ---------------------------------------------------------
const pool = require('../config/database');
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM friendships fr/.test(flat)) return Promise.reject(new Error(RAW));
  if (/FROM users WHERE id/.test(flat)) {
    return Promise.resolve({ rows: [{ name: 'Ava Lee', date_of_birth: '2000-01-01' }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// Destructured by routes/ai.js at load, so patched first.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

// --- Gemini, faked --------------------------------------------------------
// The first reply asks for the friends tool; every later one answers.
const genaiMod = require('@google/genai');
let sendCalls = [];
let firstReply = null;
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: () => ({
        sendMessage: async (params) => {
          sendCalls.push(params);
          if (sendCalls.length === 1 && firstReply) return { candidates: [{ content: { parts: firstReply } }] };
          return { candidates: [{ content: { parts: [{ text: 'could not pull up your friends right now' }] } }] };
        },
      }),
    },
  };
};

// Nothing here may reach the network.
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
test.after(() => { global.fetch = realFetch; });

const birdieUsage = require('../services/birdieUsage');
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

// A fresh account per case: the turn meter has no reset hook by design.
let nextUserId = 9300;
test.beforeEach(() => {
  birdieUsage.__resetGeminiSpend();
  aiRouter.__clearBirdieSearchCache();
  CURRENT_USER = { id: ++nextUserId, name: 'Ava' };
  sendCalls = [];
  firstReply = [{ functionCall: { id: 'c1', name: 'get_user_friends', args: {} } }];
});

async function chat(body) {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

function toolResult(name) {
  for (const c of sendCalls) {
    if (!Array.isArray(c.message)) continue;
    for (const p of c.message) {
      if (p.functionResponse?.name === name) return p.functionResponse;
    }
  }
  return null;
}

test('a tool that throws hands the model "lookup_failed" and keeps the real error in the log', async () => {
  const realError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  let res;
  try {
    res = await chat({ messages: [{ role: 'user', text: 'who are my friends on here' }] });
  } finally {
    console.error = realError;
  }
  assert.strictEqual(res.status, 200, res.text);

  const out = toolResult('get_user_friends');
  assert.ok(out, 'the tool result never went back to the model');
  assert.strictEqual(out.id, 'c1', 'the result lost the call id it answers');
  assert.deepStrictEqual(out.response, { error: 'lookup_failed' });

  // Not in the tool result, and not anywhere else in what Gemini was sent.
  const sent = JSON.stringify(sendCalls);
  assert.ok(!sent.includes('password authentication failed'), 'the database error reached the model');
  assert.ok(!sent.includes('10.0.3.7'), 'an internal address reached the model');
  assert.ok(!sent.includes('flock_app'), 'a database role name reached the model');

  // The person still gets an answer, and the operator still gets the cause.
  assert.ok(res.body && typeof res.body.text === 'string' && res.body.text.length > 0);
  assert.ok(logged.some((l) => l.includes('[AI] Tool get_user_friends failed') && l.includes(RAW)),
    `the real error was not logged:\n${logged.join('\n')}`);
});
