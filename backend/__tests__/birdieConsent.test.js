// Run: node --test  (from backend/)
//
// BIRDIE ASKS BEFORE ANYTHING GOES TO GEMINI, AND THE SERVER HOLDS THE LINE
// FOR EVERY CLIENT THAT ASKS.
//
// Every Birdie turn sends the user's messages, first name, age range, what they
// have open in the app, their area when location is on, and on request their
// plans and friends' names to Google's Gemini. App Store Guideline 5.1.2(i)
// asks for explicit permission before personal data goes to a third-party AI.
// The app asks once, before the first message (components/birdie/BirdiePanel
// .js), and the answer is users.birdie_ai_consent_at (migration 100).
//
// TWO KINDS OF CLIENT, AND BOTH DIRECTIONS ARE PINNED HERE.
//
// A client that runs the question sends consentFlow: 'ask' on every turn
// (sendAiChat in the frontend's services/api.js). For it the server holds the
// line on its own, so a stale copy of the answer or a direct call cannot skip
// the question:
//   1. no recorded consent: 403 BIRDIE_CONSENT_REQUIRED, Gemini never called,
//      no chat created, the user's name and birthday never even read
//   2. a refusal costs no message from the user's day
//   3. Allow records a time, a repeated Allow keeps the first one, withdraw
//      clears it, and /chat follows each change on the very next turn
//   4. nothing else the client sends can stand in for the recorded answer
//
// An iOS build installed before the question existed sends no flag. It has no
// question to show and no way to record an answer, and every account starts
// with the column NULL, so refusing it would switch Birdie off for every
// person on that build, including the one App Review is testing. It is served
// exactly as before:
//   5. an answer with no consent on record, and the column is never read, not
//      even when reading it would fail
//   6. the flag takes one value, and the frontend sends that value
//
// Allow also says which question it answered (migration 122), and /chat reads
// the zone a turn carries only on a yes to one that names it. The app's half
// is pinned at the bottom; the route's, on a real database, is
// birdieConsentCopyRealDb.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-consent-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;

// --- a users table with the two columns that matter -------------------------
// The consent time (migration 100) and which question it answered (migration
// 122). The statements' own Postgres semantics are run for real in
// birdieConsentCopyRealDb.test.js; this file is about who is held to them.
const pool = require('../config/database');
const consentAt = new Map(); // user id -> Date | null
const consentCopy = new Map(); // user id -> number | null
let sql = [];
pool.query = (text, params = []) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  sql.push(flat);
  const id = params[0];
  // GET /consent reads the time; /chat reads it with the question.
  if (/^SELECT birdie_ai_consent_at(, birdie_ai_consent_copy)? FROM users WHERE id = \$1$/.test(flat)) {
    if (!consentAt.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({ rows: [{ birdie_ai_consent_at: consentAt.get(id), birdie_ai_consent_copy: consentCopy.get(id) ?? null }], rowCount: 1 });
  }
  if (/^UPDATE users SET birdie_ai_consent_copy = CASE WHEN birdie_ai_consent_at IS NULL THEN \$2::smallint ELSE GREATEST\(birdie_ai_consent_copy, \$2::smallint\) END, birdie_ai_consent_at = COALESCE\(birdie_ai_consent_at, NOW\(\)\) WHERE id = \$1 RETURNING birdie_ai_consent_at$/.test(flat)) {
    if (!consentAt.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    const copy = params[1] ?? null;
    if (!consentAt.get(id)) {
      consentAt.set(id, new Date());
      consentCopy.set(id, copy);
    } else if (copy !== null) {
      consentCopy.set(id, Math.max(consentCopy.get(id) ?? copy, copy));
    }
    return Promise.resolve({ rows: [{ birdie_ai_consent_at: consentAt.get(id) }], rowCount: 1 });
  }
  if (/^UPDATE users SET birdie_ai_consent_at = NULL, birdie_ai_consent_copy = NULL WHERE id = \$1 RETURNING id$/.test(flat)) {
    if (!consentAt.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    consentAt.set(id, null);
    consentCopy.set(id, null);
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
  consentCopy.set(CURRENT_USER.id, null);
  sql = [];
  chatsCreated = 0;
  sendCalls = 0;
});

async function call(method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}
const TURN = {
  messages: [{ role: 'user', text: "what's the move tonight" }],
  location: { lat: 39.9526, lng: -75.1652 },
};
// The web and every build from this change on: they ask, and say so.
const chat = (extra = {}) => call('POST', '/api/ai/chat', { ...TURN, consentFlow: 'ask', ...extra });
// Builds 38 and 44 and anything else installed before the question existed:
// the same turn with no flag, which is the body they have always sent.
const installedBuildChat = (extra = {}) => call('POST', '/api/ai/chat', { ...TURN, ...extra });

const readsConsent = () => sql.some((s) => /birdie_ai_consent_at/.test(s));

test('with no recorded consent, a turn is refused and nothing reaches Gemini', async () => {
  const res = await chat();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'BIRDIE_CONSENT_REQUIRED');
  assert.match(res.body.error, /Google's Gemini/);
  // Only a client that shows the question ever gets this, so the sentence
  // must not send the person looking for a version of the app to update to.
  assert.doesNotMatch(res.body.error, /latest version|update/i);
  assert.strictEqual(chatsCreated, 0, 'no Gemini chat is even created');
  assert.strictEqual(sendCalls, 0, 'nothing is sent to Gemini');
  // The consent read is the only thing the refused turn did. The name and
  // birthday the prompt is built from were never read.
  assert.deepStrictEqual(sql, ['SELECT birdie_ai_consent_at, birdie_ai_consent_copy FROM users WHERE id = $1']);
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
  assert.ok(consentAt.get(CURRENT_USER.id) instanceof Date, 'the answer is recorded on the account, not only echoed');

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

test('nothing else in the request can stand in for the recorded answer', async () => {
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

// --- builds installed before the question existed ---------------------------

test('an installed build with no question to show gets its answer, and the column is never read', async () => {
  // Every account starts NULL after migration 100. This is that account, on
  // the build App Review has in hand.
  assert.strictEqual(consentAt.get(CURRENT_USER.id), null);
  const res = await installedBuildChat();
  assert.strictEqual(res.status, 200, `expected an answer, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.text, 'oakwood, chill till 9');
  assert.strictEqual(sendCalls, 1);
  assert.strictEqual(readsConsent(), false, 'the old path now reads a column it never read before');
});

test('an installed build is not refused after a withdrawal on another device either', async () => {
  // It has no question to show and no switch to flip back, so a refusal would
  // leave Birdie dead on that phone with nothing to tap.
  await call('POST', '/api/ai/consent');
  await call('DELETE', '/api/ai/consent');
  sql = [];
  const res = await installedBuildChat();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(readsConsent(), false);
});

test('an installed build keeps working when the consent read would fail', async () => {
  // The strongest form of "not read": if the old path touched the column, a
  // database that cannot answer for it would turn this into a 500.
  const real = pool.query;
  pool.query = (text, params) => (/birdie_ai_consent_at/.test(String(text))
    ? Promise.reject(new Error('column "birdie_ai_consent_at" does not exist'))
    : real(text, params));
  try {
    const res = await installedBuildChat();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sendCalls, 1);
  } finally {
    pool.query = real;
  }
});

test('the flag takes one value; anything else is refused before any spend', async () => {
  for (const consentFlow of ['yes', true, 1, 'ASK', { ask: true }]) {
    const res = await chat({ consentFlow });
    assert.strictEqual(res.status, 400, `consentFlow ${JSON.stringify(consentFlow)} was accepted`);
  }
  // A null is the absent flag, the same as an installed build.
  assert.strictEqual((await chat({ consentFlow: null })).status, 200);
  assert.strictEqual(chatsCreated, 1, 'only the null turn reached Gemini');
});

test('the frontend sends exactly the flag this route holds to the answer', () => {
  // The two halves meet on one literal. If the app sent a different spelling,
  // every new client would be served as an installed build and the question
  // would be the only thing standing between a turn and Gemini.
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'services', 'api.js'), 'utf8');
  const start = api.indexOf('export async function sendAiChat(');
  assert.ok(start > -1, 'sendAiChat moved; point this test at it');
  const sendAiChat = api.slice(start, api.indexOf('\n}', start));
  assert.match(sendAiChat, /\n {2}body\.consentFlow = 'ask';/, 'sendAiChat must set the flag on every turn, unconditionally');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  assert.match(route, /const BIRDIE_CONSENT_FLOW = 'ask';/);
});

test("the app's Allow names the question this route reads the zone on, and that question names the zone", () => {
  // Migration 122. The number the app sends with Allow is what lets /chat
  // read the zone the app sends on every turn, so it has to be the route's,
  // and it has to be sent from a build whose question says the zone goes.
  const frontend = path.join(__dirname, '..', '..', 'frontend', 'src');
  const api = fs.readFileSync(path.join(frontend, 'services', 'api.js'), 'utf8');
  const sent = api.match(/export const BIRDIE_CONSENT_COPY = (\d+);/);
  assert.ok(sent, 'services/api.js no longer names the question its Allow answered');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  const read = route.match(/const BIRDIE_CONSENT_COPY_ZONE = (\d+);/);
  assert.ok(read, 'routes/ai.js no longer names the question that names the zone');
  assert.strictEqual(sent[1], read[1]);
  const grant = api.slice(api.indexOf('export async function grantBirdieConsent('));
  assert.match(grant.slice(0, grant.indexOf('\n}')), /body: JSON\.stringify\(\{ copy: BIRDIE_CONSENT_COPY \}\)/);
  for (const screen of [['components', 'birdie', 'BirdiePanel.js'], ['screens', 'ProfileSettings.js']]) {
    const text = fs.readFileSync(path.join(frontend, ...screen), 'utf8');
    assert.ok(text.includes('your time zone with the date and time it is there'), `${screen.join('/')} no longer names the zone`);
  }
});
