// Run: node --test __tests__/birdieOutageBreaker.test.js  (from backend/)
//
// A KEY THAT CANNOT ANSWER CLOSES BIRDIE FOR A WHILE, HONESTLY AND FOR FREE.
//
// On 2026-10-28 the Gemini key's prepaid credits ran out and every call
// answered 402. Birdie charged a chirp per message, waited on the refusal,
// refunded it, wrote a stack trace and answered 500 "hmm gimme a sec, hit me
// again", which asks for the retry that cannot work. routes/ai.js now has the
// breaker Roost has had since that evening (THE OUTAGE BREAKER there). Pinned
// through the real route with Gemini faked:
//   * a 402 answers the offline line as a 429 with Retry-After, refunds the
//     chirp and logs one warning instead of a stack trace;
//   * while the breaker is open, a turn is answered before either meter and
//     before Gemini;
//   * once the billing backoff has passed, Gemini is asked again;
//   * a quota 429 opens the one-minute breaker with the busy line;
//   * an ordinary failure still answers 500 and opens nothing.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-outage-breaker-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
// posthog-node holds a connection open, and NODE_ENV is deleted above.
delete process.env.POSTHOG_API_KEY;

const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// Destructured by routes/ai.js at load, so patched first.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

// --- Gemini, faked ---------------------------------------------------------
// What @google/genai throws for the credit outage: the HTTP status on the
// error, Google's JSON body in its message.
function geminiError(status, body) {
  const err = new Error(`got status: ${status} . ${JSON.stringify(body)}`);
  err.status = status;
  return err;
}
const PREPAYMENT_402 = () => geminiError(402, { error: {
  code: 402,
  message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.',
  status: 'RESOURCE_EXHAUSTED',
} });
const QUOTA_429 = () => geminiError(429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });

const genaiMod = require('@google/genai');
let sendCalls = 0;
let nextFailure = null; // () => Error, or null to answer
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: () => ({
        sendMessage: async () => {
          sendCalls++;
          if (nextFailure) throw nextFailure();
          return { candidates: [{ content: { parts: [{ text: 'try the place on 4th, it is quiet before 8' }] } }] };
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
let nextUserId = 9700;
test.beforeEach(() => {
  birdieUsage.__resetGeminiSpend();
  aiRouter.__clearBirdieSearchCache();
  aiRouter.__resetBirdieOutage();
  CURRENT_USER = { id: ++nextUserId, name: 'Ava' };
  sendCalls = 0;
  nextFailure = null;
});

async function chat() {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text: 'somewhere quiet for dinner tonight?' }] }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, retryAfter: res.headers.get('retry-after') };
}

// Every console line the route writes during fn, by level.
async function capturing(fn) {
  const lines = { warn: [], error: [] };
  const saved = { warn: console.warn, error: console.error };
  console.warn = (...a) => lines.warn.push(a.map(String).join(' '));
  console.error = (...a) => lines.error.push(a.map(String).join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

test('a 402 answers the offline line as a 429 with Retry-After, refunds the chirp and logs once', async () => {
  nextFailure = PREPAYMENT_402;
  const { result: res, lines } = await capturing(chat);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error, "birdie's offline right now. try me again later");
  assert.strictEqual(res.body.code, 'BIRDIE_OFFLINE');
  // Roost's billing backoff, ten minutes, read from the advisor rather than copied.
  assert.ok(res.body.retryAfterSeconds > 590 && res.body.retryAfterSeconds <= 600, String(res.body.retryAfterSeconds));
  assert.strictEqual(res.retryAfter, String(res.body.retryAfterSeconds));
  // A 402 is not transient: one call, no retry.
  assert.strictEqual(sendCalls, 1);
  assert.strictEqual(birdieUsage.getUsedToday(CURRENT_USER.id), 0, 'the chirp came back');
  assert.deepStrictEqual(lines.error, [], 'an outage is not stack-traced per message');
  assert.strictEqual(lines.warn.filter((l) => l.includes('[AI] Gemini answered 402 (billing)')).length, 1);
});

test('while the breaker is open a turn is answered before either meter and before Gemini', async () => {
  nextFailure = PREPAYMENT_402;
  await capturing(chat);
  assert.strictEqual(sendCalls, 1);

  // A second person, a minute later as far as anybody can tell: Google is not
  // asked and nothing is charged, then or on the way back.
  CURRENT_USER = { id: ++nextUserId, name: 'Ben' };
  nextFailure = null;
  const { result: res, lines } = await capturing(chat);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.code, 'BIRDIE_OFFLINE');
  assert.strictEqual(sendCalls, 1, 'the breaker let a call through');
  assert.strictEqual(birdieUsage.getUsedToday(CURRENT_USER.id), 0, 'a refused turn was charged');
  assert.deepStrictEqual(lines.error, []);
  assert.deepStrictEqual(lines.warn, [], 'the warning is said once per process, not per turn');
});

test('once the billing backoff has passed, Gemini is asked again', async () => {
  nextFailure = PREPAYMENT_402;
  await capturing(chat);
  nextFailure = null;
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  let res;
  try {
    CURRENT_USER = { id: ++nextUserId, name: 'Cam' };
    res = await chat();
  } finally {
    Date.now = realNow;
  }
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.text, 'try the place on 4th, it is quiet before 8');
  assert.strictEqual(sendCalls, 2);
});

test('a quota 429 opens the one-minute breaker with the busy line', async () => {
  nextFailure = QUOTA_429;
  const { result: res, lines } = await capturing(chat);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error, 'one sec, lots of people chatting rn. try that again');
  assert.strictEqual(res.body.code, 'BIRDIE_BUSY');
  assert.ok(res.body.retryAfterSeconds > 50 && res.body.retryAfterSeconds <= 60, String(res.body.retryAfterSeconds));
  // A 429 is retried once before it counts, as it always was.
  assert.strictEqual(sendCalls, 2);
  assert.strictEqual(birdieUsage.getUsedToday(CURRENT_USER.id), 0);
  assert.deepStrictEqual(lines.error, []);

  CURRENT_USER = { id: ++nextUserId, name: 'Dee' };
  nextFailure = null;
  const again = await chat();
  assert.strictEqual(again.status, 429);
  assert.strictEqual(again.body.code, 'BIRDIE_BUSY');
  assert.strictEqual(sendCalls, 2, 'the breaker let a call through');
});

test('an ordinary failure still answers 500, logs the error and opens nothing', async () => {
  nextFailure = () => new Error('socket hang up');
  const { result: res, lines } = await capturing(chat);
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error, 'hmm gimme a sec, hit me again');
  assert.ok(lines.error.some((l) => l.includes('[AI] Chat error:')));
  assert.strictEqual(birdieUsage.getUsedToday(CURRENT_USER.id), 0);

  CURRENT_USER = { id: ++nextUserId, name: 'Eli' };
  nextFailure = null;
  const after = await chat();
  assert.strictEqual(after.status, 200, 'an ordinary failure closed Birdie');
});
