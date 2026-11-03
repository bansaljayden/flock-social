// Run: node --test  (from backend/)
//
// HOW LONG BIRDIE'S MODEL THINKS (routes/ai.js BIRDIE_THINKING_LEVEL).
//
// Production runs Birdie on gemini-3.7-flash, which reasons before it writes,
// and nothing set how much: on the Birdie eval (scripts/birdie/birdieEval.js)
// 17 of 59 answers died on the twelve-second per-call deadline while the model
// thought. Every Gemini 3 call now asks for the low level, and a 2.x model,
// which sets thinking with a budget instead, is sent nothing.
//
// Pinned through the real route with Gemini faked: the level is on the chat
// AND on every send, because a per-call config replaces the chat's outright
// (the SDK does `params.config ?? this.config`), so a send that dropped it
// would think at the default again.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-thinking-level-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.BIRDIE_MODEL;
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
delete process.env.POSTHOG_API_KEY;

const pool = require('../config/database');
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(flat)) return Promise.resolve({ rows: [{ name: 'Ava Lee', date_of_birth: '2000-01-01' }], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 0 });
};
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava' }; next(); };
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

const genaiMod = require('@google/genai');
let creates = [];
let sends = [];
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: (params) => {
        creates.push(params);
        return {
          sendMessage: async (p) => {
            sends.push(p);
            if (sends.length === 1) return { candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'navigate_app', args: { tab: 'home' } } }] } }] };
            return { candidates: [{ content: { parts: [{ text: 'nest, go' }] } }] };
          },
        };
      },
    },
  };
};

const aiRouter = require('../routes/ai');
const { birdieThinkingConfig } = aiRouter.__testables;

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('Gemini 3 models think at the low level; a 2.x model is sent nothing', () => {
  assert.deepStrictEqual(birdieThinkingConfig('gemini-3.7-flash'), { thinkingLevel: 'low' });
  assert.deepStrictEqual(birdieThinkingConfig('gemini-3.5-flash-lite'), { thinkingLevel: 'low' });
  assert.strictEqual(birdieThinkingConfig('gemini-2.5-flash-lite'), null);
  assert.strictEqual(birdieThinkingConfig(undefined), null);
});

test('the chat and every send carry the level, beside the prompt and the tools', async () => {
  creates = [];
  sends = [];
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text: 'take me home' }] }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(creates.length, 1);
  // The code default, gemini-3.5-flash-lite, is a Gemini 3 model.
  assert.strictEqual(creates[0].model, 'gemini-3.5-flash-lite');
  assert.deepStrictEqual(creates[0].config.thinkingConfig, { thinkingLevel: 'low' });
  assert.strictEqual(sends.length, 2, 'precondition: a tool round and an answer');
  for (const s of sends) {
    assert.deepStrictEqual(s.config.thinkingConfig, { thinkingLevel: 'low' }, 'a send that drops the level thinks at the default');
    assert.match(s.config.systemInstruction, /^You are Birdie/);
    assert.ok(Array.isArray(s.config.tools) && s.config.tools.length === 1);
    assert.ok(s.config.abortSignal, 'the per-call deadline is still on every send');
  }
});
