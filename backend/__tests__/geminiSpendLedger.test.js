// Run: node --test  (from backend/)
//
// MONEY. Gemini is billed PER TOKEN and it is the one paid upstream in this app
// whose call count a user can steer directly, because routes/ai.js runs a tool
// loop on prompts they write.
//
// What was actually here before this file. There WAS a per-account meter —
// services/birdieUsage.js, 150 turns a day and 15 a minute — so the claim that
// Gemini had "no per-account ledger at all" was wrong. The real defect was
// narrower and worse: that meter counts CONVERSATION TURNS, and one turn is not
// one billed call. The route makes the first send, then up to five more tool
// rounds, and every one of those re-sends the entire conversation because the
// SDK keeps no server-side session. A transient 429/5xx buys each of them one
// retry on top. So ONE unit of the turn meter authorised up to TWELVE billed
// calls, of a payload the caller sizes: the body validator accepts 24 messages
// of 4,000 characters, which is ~200,000 input tokens for a single "message".
// Five out of every six Gemini calls the app made passed through no meter at
// all, and there was no process-wide ceiling of any kind — utils/placesBudget.js
// has GLOBAL_DAILY, Gemini had nothing. 150 turns a day times that payload times
// as many free accounts as anyone cares to register is the same four-figure
// monthly shape as the Places hole placesBudget.js was written to close.
//
// So this file pins three properties:
//   1. EVERY chat.sendMessage charges the ledger — the retry too — and the
//      charge lands BEFORE the vendor call, because an aborted paid request is
//      still billed (utils/upstream.js).
//   2. The charge is denominated in TOKENS, not calls, so a long prompt costs
//      more than a short one and a later tool round costs more than an early
//      one.
//   3. There is a ceiling per account and a ceiling for the whole process, and
//      the account is named from a VERIFIED token by the same single function
//      the billed-image meter uses.
//
// It does NOT claim to bound the output half. Nothing sets maxOutputTokens, so
// one reply's length is the model's business; settleGeminiCall notices it after
// the fact instead. See the report in services/birdieUsage.js.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'gemini-spend-ledger-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;

const BACKEND = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
const handlersSrc = fs.readFileSync(path.join(BACKEND, 'sockets', 'handlers.js'), 'utf8');
const aiSrc = fs.readFileSync(path.join(BACKEND, 'routes', 'ai.js'), 'utf8');

const { TOKEN_ALGORITHMS, signUserToken } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// The real ledger
// ---------------------------------------------------------------------------
const birdieUsage = require('../services/birdieUsage');
const {
  estimateGeminiTokens,
  geminiSpendStatus,
  __resetGeminiSpend,
  checkUserRateLimit,
  getUsedToday,
  PER_USER_HOURLY_TOKENS,
  PER_USER_DAILY_TOKENS,
  GLOBAL_DAILY_TOKENS,
  OUTPUT_RESERVE_TOKENS,
  CHARS_PER_TOKEN,
} = birdieUsage;

const realAllow = birdieUsage.allowGeminiCall;
const realSettle = birdieUsage.settleGeminiCall;

// routes/ai.js destructures these at load, so the module object is instrumented
// BEFORE the router is required. Both wrappers call through to the real
// implementation — what is being observed is the wiring, not a stub.
let ledgerCalls = [];
let settleCalls = [];
let refuseFrom = null; // 1-based index of the first call to force a refusal on
birdieUsage.allowGeminiCall = (userId, tokens) => {
  const n = ledgerCalls.length + 1;
  const forced = refuseFrom !== null && n >= refuseFrom;
  const allowed = forced ? false : realAllow(userId, tokens);
  ledgerCalls.push({ n, userId, tokens, allowed, forced });
  return allowed;
};
birdieUsage.settleGeminiCall = (userId, estimated, actual) => {
  const added = realSettle(userId, estimated, actual);
  settleCalls.push({ userId, estimated, actual, added });
  return added;
};

// ---------------------------------------------------------------------------
// Harness for the real /api/ai router (same technique as paidCallBudgets)
// ---------------------------------------------------------------------------
const pool = require('../config/database');
pool.query = (sql) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(flat)) {
    return Promise.resolve({ rows: [{ name: 'Ava Lee', date_of_birth: '2000-01-01' }] });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 7, name: 'Ava' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// Gemini, faked. sendImpl decides whether a round emits a function call (which
// makes the tool loop go round again) or final text.
const genaiMod = require('@google/genai');
let sendCalls = [];
let sendImpl = null;
const fakeChat = {
  sendMessage: async (params) => {
    sendCalls.push(params);
    if (sendImpl) return sendImpl(params, sendCalls.length);
    return { candidates: [{ content: { parts: [{ text: 'oakwood, chill till 9' }] } }] };
  },
};
genaiMod.GoogleGenAI = function FakeGenAI() {
  return { chats: { create: () => fakeChat } };
};

// navigate_app is the one tool that touches no network and no other budget, so
// a tool loop built on it measures Gemini spend and nothing else.
const NAV_CALL = {
  candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'navigate_app', args: { tab: 'home' } } }] } }],
};
const FINAL_TEXT = { candidates: [{ content: { parts: [{ text: 'nest tab, go' }] } }] };
const toolRounds = (n) => (_p, call) => (call <= n ? NAV_CALL : FINAL_TEXT);

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

let nextUserId = 1000;
test.beforeEach(() => {
  __resetGeminiSpend();
  ledgerCalls = [];
  settleCalls = [];
  sendCalls = [];
  sendImpl = null;
  refuseFrom = null;
  // A fresh account per test: the TURN meter (15/min, 150/day) has no reset
  // hook by design — production code must never reset a spending counter — so
  // tests move to a new id rather than rewinding one.
  CURRENT_USER = { id: ++nextUserId, name: 'Ava' };
});

async function chat(body) {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { messages: [{ role: 'user', text: "what's the move tonight" }] }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

const spent = (uid) => {
  const s = geminiSpendStatus(uid);
  return PER_USER_DAILY_TOKENS - s.userDayRemaining;
};

// ---------------------------------------------------------------------------
// 1. The estimator is denominated in tokens, and output is not free
// ---------------------------------------------------------------------------

test('the estimate grows with the size of the prompt', () => {
  const small = estimateGeminiTokens(100);
  const large = estimateGeminiTokens(100_000);
  assert.ok(large > small * 10,
    'a per-CALL ceiling bounds how many questions are asked and says nothing about how expensive each one is');
  assert.strictEqual(small, Math.ceil(100 / CHARS_PER_TOKEN) + OUTPUT_RESERVE_TOKENS);
});

test('an unmeasurable prompt is still charged the output reserve, never zero', () => {
  for (const bad of [undefined, null, NaN, -5, 'lots', {}]) {
    assert.strictEqual(estimateGeminiTokens(bad), OUTPUT_RESERVE_TOKENS,
      `${String(bad)} must not estimate a free call`);
  }
  assert.ok(OUTPUT_RESERVE_TOKENS > 0,
    'a reply we have not seen yet is still billed, and at the higher output rate');
});

// ---------------------------------------------------------------------------
// 2. The ledger itself
// ---------------------------------------------------------------------------

test('a refused call is charged nothing — all or nothing', () => {
  __resetGeminiSpend();
  const uid = 501;
  assert.strictEqual(realAllow(uid, PER_USER_HOURLY_TOKENS - 10), true);
  const before = geminiSpendStatus(uid);
  assert.strictEqual(realAllow(uid, 100), false, 'this call does not fit under the hourly ceiling');
  const after = geminiSpendStatus(uid);
  assert.strictEqual(after.globalUsed, before.globalUsed, 'a refused charge costs nothing globally');
  assert.strictEqual(after.userHourRemaining, before.userHourRemaining, 'nor against the account');
  // And a call that DOES fit still goes through, so the refusal was about size.
  assert.strictEqual(realAllow(uid, 10), true);
});

test('the per-account hourly ceiling holds, and one account running out refuses nobody else', () => {
  __resetGeminiSpend();
  assert.strictEqual(realAllow(502, PER_USER_HOURLY_TOKENS), true);
  assert.strictEqual(realAllow(502, 1), false, 'the hour is spent');
  assert.strictEqual(realAllow(503, 1), true, 'a per-account meter must not become a global outage');
});

test('the rolling hour is the first wall inside a single instant', () => {
  __resetGeminiSpend();
  const uid = 504;
  assert.ok(PER_USER_DAILY_TOKENS > PER_USER_HOURLY_TOKENS,
    'a daily ceiling below the hourly one would be unreachable and therefore a lie');
  let charged = 0;
  while (realAllow(uid, 1000)) charged += 1000;
  assert.strictEqual(charged, PER_USER_HOURLY_TOKENS, 'the hour is what bounds a burst');
  assert.strictEqual(geminiSpendStatus(uid).userDayRemaining, PER_USER_DAILY_TOKENS - charged);
});

test('waiting out the hour does not buy an unlimited day', () => {
  // Found by mutation: with time frozen, the rolling hour refuses first, so
  // deleting the DAILY ceiling entirely changed nothing any test could see. A
  // patient caller does not experience frozen time — they wait an hour and come
  // back, and the daily ceiling is the only thing standing between that and 24
  // hours of full-rate spend. So the clock is advanced here.
  __resetGeminiSpend();
  const uid = 505;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    let hours = 0;
    let charged = 0;
    // Each pass spends a full hourly allowance, then waits out the rolling hour.
    // The UTC day is not advanced, so only the daily ceiling can stop this.
    while (realAllow(uid, PER_USER_HOURLY_TOKENS)) {
      charged += PER_USER_HOURLY_TOKENS;
      clock += 61 * 60 * 1000;
      if (++hours > 24) break;
    }
    assert.strictEqual(charged, PER_USER_DAILY_TOKENS,
      'the day is what stops a caller who is willing to wait between bursts');
    assert.strictEqual(geminiSpendStatus(uid).userDayRemaining, 0);
    assert.ok(geminiSpendStatus(uid).userHourRemaining > 0,
      'and it stops them while their hourly window is wide open, which is the point');
    assert.strictEqual(realAllow(uid, 1), false);
  } finally {
    Date.now = realNow;
  }
});

test('waiting out the hour does not wipe it either', () => {
  // The rolling hour must survive a UTC day rollover. utils/probeBudget.js
  // documents the trap: rebuilding the entry on the day boundary discards live
  // hourly timestamps, so a caller who spends their hour in the last minutes of
  // the day gets a second full hour seconds later, at a moment they can compute
  // exactly.
  __resetGeminiSpend();
  const uid = 507;
  assert.strictEqual(realAllow(uid, PER_USER_HOURLY_TOKENS), true);
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'birdieUsage.js'), 'utf8');
  const charge = src.slice(src.indexOf('function chargeGemini'), src.indexOf('function allowGeminiCall'));
  assert.ok(!/entry\.hits = \[\]/.test(charge),
    'a day rollover must roll the day, not reset the rolling hour');
  assert.strictEqual(realAllow(uid, 1), false, 'the hour is still spent');
});

test('the GLOBAL ceiling refuses even a brand new account', () => {
  __resetGeminiSpend();
  // ~200 accounts' worth, the way a sock-puppet farm would spend it. This is the
  // ceiling utils/placesBudget.js has and Gemini did not have at all.
  let uid = 600;
  while (geminiSpendStatus(uid).globalRemaining >= PER_USER_HOURLY_TOKENS) {
    assert.strictEqual(realAllow(uid++, PER_USER_HOURLY_TOKENS), true);
  }
  const remaining = geminiSpendStatus(uid).globalRemaining;
  if (remaining > 0) assert.strictEqual(realAllow(uid++, remaining), true);
  assert.strictEqual(geminiSpendStatus(uid).globalRemaining, 0);
  assert.strictEqual(realAllow(999999, 1), false,
    'a fresh account must not be able to spend past the process ceiling');
});

test('a call larger than any allowance is refused, not thrown', () => {
  __resetGeminiSpend();
  // `tokens` is derived from user input here — somebody pasting an essay must be
  // throttled, not handed a 500. Only a value the estimator could never have
  // produced is a programming error.
  assert.strictEqual(realAllow(505, PER_USER_HOURLY_TOKENS + 1), false);
  assert.strictEqual(geminiSpendStatus(505).globalUsed, 0);
  for (const bad of [0, -1, 1.5, NaN, '100', null, undefined]) {
    assert.throws(() => realAllow(505, bad), /positive integer/,
      `${String(bad)} cannot come from estimateGeminiTokens, so it is a bug not a big prompt`);
  }
});

test('an unusable account id is refused and never shares a bucket', () => {
  __resetGeminiSpend();
  // Number(null), Number(''), Number(false) and Number([]) are all 0, so a
  // permissive check would give every unidentifiable caller one shared allowance
  // AND let them through. Fail closed — this is a spending control.
  for (const bad of [null, undefined, 0, -1, 1.5, '', 'abc', true, [9], {}, NaN]) {
    assert.strictEqual(realAllow(bad, 100), false, `${String(bad)} is not an account`);
  }
  assert.strictEqual(geminiSpendStatus(1).globalUsed, 0, 'and none of them spent anything');
  // '5' and 5 are one account.
  assert.strictEqual(realAllow('5', 1000), true);
  assert.strictEqual(geminiSpendStatus(5).userHourRemaining, PER_USER_HOURLY_TOKENS - 1000);
});

test('settling charges the shortfall and never refunds an over-estimate', () => {
  __resetGeminiSpend();
  const uid = 506;
  assert.strictEqual(realAllow(uid, 1000), true);
  assert.strictEqual(realSettle(uid, 1000, 4000), 3000, 'the real figure was 3000 tokens higher');
  assert.strictEqual(geminiSpendStatus(uid).userHourRemaining, PER_USER_HOURLY_TOKENS - 4000);
  // Refunding would let a caller alternate one huge prompt with many tiny ones
  // and never settle up.
  assert.strictEqual(realSettle(uid, 1000, 10), 0);
  assert.strictEqual(geminiSpendStatus(uid).userHourRemaining, PER_USER_HOURLY_TOKENS - 4000);
  // No usage reported is "no information", not "zero tokens".
  for (const absent of [undefined, null, NaN, 'lots']) {
    assert.strictEqual(realSettle(uid, 1000, absent), 0);
  }
  assert.strictEqual(realSettle(null, 1000, 9e9), 0, 'and an unusable id settles nothing');
});

// ---------------------------------------------------------------------------
// 3. The route charges EVERY call, which is the hole this file exists to close
// ---------------------------------------------------------------------------

test('a tool loop charges the ledger once per Gemini call, not once per turn', async () => {
  sendImpl = toolRounds(3); // 3 rounds emitting a tool call, then final text
  const res = await chat();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(sendCalls.length, 4, 'precondition: this turn made four Gemini calls');
  assert.strictEqual(ledgerCalls.length, 4,
    'one unit for six billed calls is exactly the bug utils/placesBudget.js exists to prevent');
  for (const c of ledgerCalls) {
    assert.strictEqual(c.userId, CURRENT_USER.id, 'charged to the account steering the model');
    assert.ok(c.tokens >= OUTPUT_RESERVE_TOKENS);
  }
});

test('a four-call turn costs about four times what a one-call turn costs', async () => {
  const body = { messages: [{ role: 'user', text: 'where should we go' }] };
  const cheapUser = CURRENT_USER.id;
  await chat(body);
  const cheap = spent(cheapUser);
  assert.ok(cheap > 0);

  CURRENT_USER = { id: ++nextUserId, name: 'Ava' };
  // toolRounds counts from sendCalls.length, so the second turn needs a clean
  // slate or it inherits the first turn's call number and stops a round early.
  sendCalls = [];
  sendImpl = toolRounds(3);
  await chat(body);
  const dear = spent(CURRENT_USER.id);
  assert.strictEqual(sendCalls.length, 4, 'precondition: the second turn really made four calls');
  assert.ok(dear >= cheap * 4,
    `four calls must cost at least four times one call (${dear} vs ${cheap})`);
});

test('a long prompt costs more than a short one — the unit is tokens, not calls', async () => {
  const shortUser = CURRENT_USER.id;
  await chat({ messages: [{ role: 'user', text: 'hi' }] });
  const cheap = spent(shortUser);

  CURRENT_USER = { id: ++nextUserId, name: 'Ava' };
  await chat({ messages: [{ role: 'user', text: 'x'.repeat(4000) }] });
  const dear = spent(CURRENT_USER.id);
  assert.ok(dear > cheap + 900,
    `4,000 characters is ~1,000 tokens more than "hi" and must be charged as such (${dear} vs ${cheap})`);
});

test('a later tool round is charged more than an earlier one, because the whole conversation is re-sent', async () => {
  sendImpl = toolRounds(3);
  await chat();
  assert.strictEqual(ledgerCalls.length, 4);
  for (let i = 1; i < ledgerCalls.length; i++) {
    assert.ok(ledgerCalls[i].tokens > ledgerCalls[i - 1].tokens,
      `round ${i + 1} carries the conversation so far and must cost more than round ${i}`);
  }
});

test('the whole prompt is measured, not just the new message', async () => {
  // The system instruction and every tool declaration go up the wire on every
  // call. Charging only the user's words would under-count a short question by
  // the better part of 2,000 tokens.
  await chat({ messages: [{ role: 'user', text: 'hi' }] });
  assert.strictEqual(ledgerCalls.length, 1);
  const systemChars = String(sendCalls[0].config.systemInstruction).length;
  assert.ok(ledgerCalls[0].tokens > systemChars / CHARS_PER_TOKEN,
    'the system prompt is re-sent every call and must be inside the charge');
});

test('the retry is charged as the second invoice it is', async () => {
  sendImpl = (_p, n) => {
    if (n === 1) { const e = new Error('overloaded'); e.status = 429; throw e; }
    return FINAL_TEXT;
  };
  const res = await chat();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(sendCalls.length, 2, 'precondition: a transient 429 still gets its one retry');
  assert.strictEqual(ledgerCalls.length, 2,
    'Google bills the first attempt too; a retry charged once is a call we got for free');
});

test('the charge lands BEFORE the call, so a refusal never reaches Gemini', async () => {
  refuseFrom = 1;
  const res = await chat();
  assert.strictEqual(res.status, 429);
  assert.strictEqual(sendCalls.length, 0,
    'an aborted paid request is still billed, so a charge-on-success design would spend money here');
  assert.strictEqual(ledgerCalls.length, 1, 'and the ledger was asked exactly once');
});

test('a ledger refusal is never retried', async () => {
  // The retry path treats 429/5xx as transient. A refusal from our OWN ceiling
  // must not look transient to it, or the ceiling retries itself.
  refuseFrom = 1;
  await chat();
  assert.strictEqual(ledgerCalls.length, 1, 'a second charge attempt for a call we declined to make');
  assert.strictEqual(sendCalls.length, 0);
});

test('a refusal mid tool loop stops the turn and still answers, rather than 500ing', async () => {
  sendImpl = toolRounds(4);
  refuseFrom = 3; // first two calls go through, the third is refused
  const res = await chat();
  assert.strictEqual(res.status, 200, 'the tool work is done; throwing it away helps nobody');
  assert.strictEqual(sendCalls.length, 2, 'the loop stopped at the ceiling instead of running on');
  assert.ok(typeof res.body.text === 'string' && res.body.text.length > 0);
  assert.ok(!/error|sorry|broken/i.test(res.body.text),
    'the user gets a sentence in Birdie‘s voice, not an apology for being down');
});

test('the turn still carries the system prompt, the tools and a fresh deadline', async () => {
  // Guard on the edit itself: the charge was threaded through sendWithRetry, and
  // the SDK REPLACES config rather than merging it. Dropping the persona or the
  // tool declarations while adding a meter would be a worse bug than the one
  // being fixed. (paidCallBudgets.test.js asserts this too; it is repeated here
  // because this file is what changed the function.)
  sendImpl = toolRounds(2);
  await chat();
  assert.strictEqual(sendCalls.length, 3);
  for (const call of sendCalls) {
    assert.match(String(call.config.systemInstruction), /You are Birdie/);
    const names = (call.config.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
    assert.ok(names.includes('search_venues'));
    assert.ok(call.config.abortSignal instanceof AbortSignal);
    assert.strictEqual(call.config.abortSignal.aborted, false);
  }
});

test('a ledger refusal looks like the 429 it is, and is still not retried', async () => {
  // Found by mutation: deleting the `geminiBudget` guard from the retry path
  // changed nothing, because the refusal happened not to match the transient
  // test — its MESSAGE contained neither "quota" nor "unavailable". That is a
  // property of a sentence, not of a design, and it would have quietly become a
  // retry loop the first time somebody reworded the error. The refusal now
  // carries status 429, which is what it is, and the guard is what stops it.
  const src = aiSrc.slice(aiSrc.indexOf('class GeminiBudgetError'), aiSrc.indexOf('const BIRDIE_BUSY_MESSAGE'));
  assert.match(src, /this\.status = 429/,
    'the refusal must be classified honestly, so the guard that skips the retry is load-bearing');
  refuseFrom = 1;
  const res = await chat();
  assert.strictEqual(res.status, 429);
  assert.strictEqual(ledgerCalls.length, 1,
    'a ceiling that retries itself is not a ceiling — one refusal, one charge attempt, no second try');
  assert.strictEqual(sendCalls.length, 0);
});

test('a payload we cannot measure is charged expensively, never free', () => {
  // The estimator is fed a character count. If that count cannot be taken, the
  // only safe direction is to assume the payload is huge: a body we cannot
  // measure must not be a body that costs nothing, or "unmeasurable" becomes
  // the cheapest way to talk to a paid model.
  const decl = /const UNMEASURABLE_PAYLOAD_CHARS = ([\d_]+);/.exec(aiSrc);
  assert.ok(decl, 'routes/ai.js must declare a fallback size');
  const fallback = Number(decl[1].replace(/_/g, ''));
  assert.ok(fallback > 100_000,
    'the fallback must dwarf a normal prompt, or an unmeasurable payload is a discount');

  const fn = /function payloadChars\(payload\) \{[\s\S]*?\n\}/.exec(aiSrc);
  assert.ok(fn, 'routes/ai.js must measure its payloads in a named function');
  // eslint-disable-next-line no-new-func
  const payloadChars = new Function(
    'UNMEASURABLE_PAYLOAD_CHARS', `${fn[0]}\nreturn payloadChars;`)(fallback);

  const circular = {}; circular.self = circular;
  for (const bad of [undefined, circular, { n: 1n }, () => {}]) {
    assert.strictEqual(payloadChars(bad), fallback,
      `${String(bad)} cannot be measured and must be charged as if it were huge`);
  }
  assert.strictEqual(payloadChars('hello'), 5);
  assert.ok(estimateGeminiTokens(fallback) > 20_000,
    'and the fallback must translate into a charge big enough to actually bite');
});

test('what the model sends back is charged on the next round', async () => {
  // The reply becomes part of the prompt of the very next call, because the SDK
  // re-sends the whole conversation. A verbose model is therefore something the
  // caller pays for, and dropping the reply from the running total is a
  // discount on exactly the turns that cost the most.
  // The bulk has to be in a part the TOOL RESULT does not echo back, or the
  // next round grows by that much anyway and the test proves nothing. Found by
  // mutation: a huge `args.tab` comes straight back inside the functionResponse,
  // so deleting responseChars entirely still looked correct. Text alongside the
  // call is carried by the conversation and by nothing else.
  const BIG = 'z'.repeat(60_000);
  sendImpl = (_p, call) => (call === 1
    ? { candidates: [{ content: { parts: [
        { text: BIG },
        { functionCall: { id: 'c1', name: 'navigate_app', args: { tab: 'home' } } },
      ] } }] }
    : FINAL_TEXT);
  await chat({ messages: [{ role: 'user', text: 'hi' }] });
  assert.strictEqual(ledgerCalls.length, 2);
  const grew = ledgerCalls[1].tokens - ledgerCalls[0].tokens;
  assert.ok(grew > BIG.length / CHARS_PER_TOKEN,
    `a 60,000-character reply must show up in the next charge, and it grew by only ${grew} tokens`);
});

test('the estimate is trued up from usageMetadata when the SDK reports one', async () => {
  sendImpl = () => ({ ...FINAL_TEXT, usageMetadata: { totalTokenCount: 250_000 } });
  await chat();
  assert.strictEqual(settleCalls.length, 1);
  assert.strictEqual(settleCalls[0].actual, 250_000);
  assert.ok(settleCalls[0].added > 200_000, 'the shortfall between estimate and reality is charged');
  assert.ok(spent(CURRENT_USER.id) >= 250_000,
    'an output-heavy reply must show up in the ledger, not be estimated away');
});

test('an absent usageMetadata leaves the estimate standing rather than zeroing it', async () => {
  await chat();
  assert.strictEqual(settleCalls.length, 1);
  assert.strictEqual(settleCalls[0].added, 0);
  assert.ok(spent(CURRENT_USER.id) > 0, 'the pre-call charge is still there');
});

test('a body with no message spends nothing, on either meter', async () => {
  // Round 2, found re-auditing this file's own fix. `messages.*.text` is
  // optional in the validator, so `{ messages: [{}] }` is a well-formed request
  // with nothing to say. The payload was then unmeasurable, and the ledger
  // charges an unmeasurable payload at the deliberately-expensive fallback rate
  // — about 100,000 tokens — for a request that never reaches Gemini at all.
  // The turn meter allows 150 of those a day, so TWO accounts could have burnt
  // the whole 30,000,000-token process ceiling and taken Birdie down for
  // everybody without spending a cent of Google's money. A meter that can be
  // driven by requests it refuses is a denial-of-service surface, not a control.
  const uid = CURRENT_USER.id;
  const before = getUsedToday(uid);
  for (const body of [
    { messages: [{}] },
    { messages: [{ role: 'user' }] },
    { messages: [{ role: 'user', text: '   ' }] },
    { messages: [{ role: 'user', text: 'real' }, { role: 'user' }] },
  ]) {
    const res = await chat(body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} has nothing to send`);
  }
  assert.strictEqual(ledgerCalls.length, 0, 'the spend ledger was never touched');
  assert.strictEqual(sendCalls.length, 0, 'and Gemini was never reached');
  assert.strictEqual(geminiSpendStatus(uid).globalUsed, 0,
    'a request that cannot reach the vendor must not move the process-wide ceiling');
  assert.strictEqual(getUsedToday(uid), before,
    'nor should it cost the user one of their daily turns');
});

test('the location prefix never turns a missing message into the word "undefined"', async () => {
  // The same body with coordinates attached used to become
  // "[My approximate location: 39.74,-104.98]\nundefined" — a real paid call
  // asking the model about nothing.
  const res = await chat({ messages: [{ role: 'user' }], location: { lat: 39.74, lng: -104.98 } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(sendCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Adversarial: the spellings that beat URL-pattern gates
// ---------------------------------------------------------------------------

test('no spelling of the chat URL reaches the handler unmetered', async () => {
  // The class of bug that beat the billed-image limiter twice: Express does not
  // collapse repeated slashes, routes case-insensitively, treats a trailing
  // slash as the same route, and decodes percent escapes. Any of those that
  // still reaches the handler must still be charged. This meter lives INSIDE the
  // route handler rather than behind a URL regex, which is what makes that true
  // by construction — but "by construction" is what the last two agents also
  // believed, so it is measured.
  for (const spelling of [
    '/api/ai/chat',
    '/api/AI/chat',
    '/api/ai/chat/',
    '/api//ai/chat',
    '/api/ai//chat',
    '/api/ai/%63hat',
    '/api/ai/CHAT',
  ]) {
    ledgerCalls = [];
    sendCalls = [];
    CURRENT_USER = { id: ++nextUserId, name: 'Ava' };
    const res = await fetch(base + spelling, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', text: 'hi' }] }),
    });
    if (res.status === 404) { await res.text(); continue; } // never reached a handler
    await res.text();
    assert.ok(ledgerCalls.length > 0,
      `${spelling} reached the chat handler and must be charged — a meter a caller steps around by typing an extra slash is not a meter`);
    assert.strictEqual(ledgerCalls.length, sendCalls.length,
      `${spelling}: every Gemini call it made must have a charge`);
  }
});

test('the charge is not gated on a URL pattern at all', () => {
  // If a future edit ever moves this meter behind a route regex in routes/ai.js,
  // it inherits every spelling bug above. There is no such regex today and there
  // should not be one: the charge sits next to the call it is paying for.
  const chargeLine = /allowGeminiCall\(/.exec(aiSrc);
  assert.ok(chargeLine, 'routes/ai.js must charge the ledger');
  assert.ok(!/req\.(path|originalUrl|baseUrl)/.test(aiSrc),
    'routes/ai.js must not decide what to charge from the spelling of a URL');
});

// ---------------------------------------------------------------------------
// 5. Identity: one derivation of "which account is this", used by both meters
// ---------------------------------------------------------------------------

function liftBilledImageKey() {
  const fn = /function billedImageKey\(req\) \{[\s\S]*?\n\}/.exec(serverSrc);
  assert.ok(fn, 'server.js must derive the bucket key in a named function');
  // eslint-disable-next-line no-new-func
  return new Function('jwt', 'TOKEN_ALGORITHMS', `${fn[0]}\nreturn billedImageKey;`)(jwt, TOKEN_ALGORITHMS);
}

function liftAiLimiter(keyFn) {
  const decl = /const aiLimiter = isDev \? [\s\S]*?\n\}\);/.exec(serverSrc);
  assert.ok(decl, 'server.js must declare aiLimiter');
  // eslint-disable-next-line no-new-func
  return new Function('rateLimit', 'isDev', 'billedAccountKey', `${decl[0]}\nreturn aiLimiter;`)(
    rateLimit, false, keyFn
  );
}

test('server.js has exactly ONE token-verifying key derivation', () => {
  assert.strictEqual((serverSrc.match(/jwt\.verify\(/g) || []).length, 1,
    'two readings of one header is the bug: a caller who can pick their bucket by adding a space to their own Authorization header is not metered by account at all');
  assert.match(serverSrc, /const billedAccountKey = billedImageKey;/,
    'the AI limiter must reuse that derivation rather than grow a second copy');
});

test('the AI limiter keys on the account, not the address', () => {
  const decl = /const aiLimiter = isDev \? [\s\S]*?\n\}\);/.exec(serverSrc)[0];
  assert.match(decl, /keyGenerator: billedAccountKey/,
    'a per-address ceiling on a paid upstream is bought around by rotating addresses');
  // And it is declared after the function it borrows, or the reference is dead.
  assert.ok(serverSrc.indexOf('function billedImageKey') < serverSrc.indexOf('const aiLimiter ='));
  assert.ok(serverSrc.indexOf('const aiLimiter =') < serverSrc.indexOf("app.use('/api/ai'"),
    'a limiter declared after its mount is a ReferenceError at boot');
});

test('rotating addresses buys no extra Birdie allowance, and one address is not one bucket', async () => {
  const keyFn = liftBilledImageKey();
  const limiter = liftAiLimiter(keyFn);
  const token = signUserToken({ id: 8181, token_version: 0 });

  const mini = express();
  mini.use((req, _res, next) => { Object.defineProperty(req, 'ip', { value: req.headers['x-test-ip'], configurable: true }); next(); });
  mini.use(limiter);
  mini.post('*', (_req, res) => res.status(201).json({ ok: true }));
  const s = http.createServer(mini);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  // Closed in a finally: a failing assertion inside the block used to leave this
  // listener open, and node --test then waited on a live handle instead of
  // reporting the failure. A test that hangs on failure reads as a hung suite.
  try {
    const url = `http://127.0.0.1:${s.address().port}/api/ai/chat`;

    const hit = (auth, ip) => fetch(url, {
      method: 'POST',
      headers: { 'x-test-ip': ip, ...(auth ? { Authorization: auth } : {}) },
    }).then(async (r) => { await r.text(); return r.status; });

    let ok = 0;
    for (let i = 0; i < 40; i++) {
      // A new address every single request. The old per-IP limiter gave this
      // caller a fresh 30 a minute each time.
      if (await hit(`Bearer ${token}`, `198.51.100.${i}`) === 201) ok++;
    }
    assert.strictEqual(ok, 30, 'one account is one bucket however many addresses it comes from');

    // A header the router authenticates is a header this meter recognises: the
    // token is read `split(' ')[1]`, exactly as middleware/auth.js reads it.
    assert.strictEqual(await hit(`Bearer ${token} junk`, '203.0.113.1'), 429,
      'adding a space to your own header must not buy a fresh bucket');
    // A different account on the SAME address is unaffected.
    const other = signUserToken({ id: 8282, token_version: 0 });
    assert.strictEqual(await hit(`Bearer ${other}`, '198.51.100.0'), 201,
      'one school or one household on a shared address must not be one bucket');
  } finally {
    await new Promise((r) => s.close(r));
  }
});

// ---------------------------------------------------------------------------
// 6. The turn meter, which the spend ledger sits underneath
// ---------------------------------------------------------------------------

test('the turn meter fails closed on an id it cannot use', () => {
  for (const bad of [null, undefined, 0, -1, '', 'abc', true, [9], {}]) {
    assert.strictEqual(checkUserRateLimit(bad).allowed, false, `${String(bad)} is not an account`);
  }
  assert.strictEqual(getUsedToday(null), 0);
});

test("'5' and 5 are one account in the turn meter too", () => {
  const before = getUsedToday(7777);
  assert.strictEqual(checkUserRateLimit('7777').allowed, true);
  assert.strictEqual(getUsedToday(7777), before + 1,
    'a client shown one number while the meter enforces another is how a limit gets debugged as a bug');
  // Both directions, found by mutation: the meter WRITES through accountKey, so
  // reading a raw id happens to work for the number spelling and silently
  // reports zero for the string one. services/entitlements.js is the caller, and
  // a zero there tells the client it has its whole day's allowance left while
  // the meter is already counting down.
  assert.strictEqual(getUsedToday('7777'), before + 1,
    "reading a raw id makes '7777' a different account from 7777 on the way out");
});

// ---------------------------------------------------------------------------
// 7. The comments that made the REST side look already handled
// ---------------------------------------------------------------------------

test('the socket image comments no longer quote a limit that does not exist', () => {
  // Both halves of the old sentence were wrong: apiLimiter is 3000 per 15
  // minutes, not 300, and there is now a real per-image meter on the REST side.
  // That wrong number is what made REST look protected, and it is a direct cause
  // of the hole server.js's billed-image limiter had to close.
  assert.ok(!/300 requests per 15 minutes/.test(handlersSrc),
    'the ten-times-too-small figure must not survive anywhere in this file');
  assert.ok(!/300\n\s*\/\/ requests per 15 minutes/.test(handlersSrc),
    'nor split across a line break');
  const mentions = handlersSrc.match(/3000 per 15\s*\n?\s*\/\/ minutes|3000 per 15 minutes/g) || [];
  assert.strictEqual(mentions.length, 2,
    'both image call sites must state the real general-limiter figure');
  assert.strictEqual((handlersSrc.match(/imageSpendLimiter/g) || []).length, 2,
    'and both must name the per-image meter that now exists');
});

test('the figure those comments quote is the figure server.js enforces', () => {
  const apiLimiter = /const apiLimiter = isDev \? [\s\S]*?\n\}\);/.exec(serverSrc);
  assert.ok(apiLimiter, 'server.js must declare apiLimiter');
  assert.match(apiLimiter[0], /max: 3000/,
    'if this number moves, the two comments in sockets/handlers.js move with it');
  assert.match(apiLimiter[0], /windowMs: 15 \* 60 \* 1000/);
});

// ---------------------------------------------------------------------------
// 8. Eviction — kept last, because it deliberately floods the shared maps
// ---------------------------------------------------------------------------

test('overflowing the tracked-account maps never drops the caller that caused it', () => {
  // Round 3, found re-auditing this file's own fix. Eviction is
  // least-consumed-first, and a brand new entry has consumed nothing — so it
  // sorts first and is exactly the entry a post-insert eviction deletes. The
  // caller who trips the threshold is the caller who is spending, so that
  // version threw their counter away: the turn meter's following `.get()` came
  // back undefined and 500'd, and the spend ledger wrote its charge to an object
  // that was no longer in the map, which is a charge that never happened.
  //
  // Neither map may be clear()ed to make room either — a wholesale clear hands
  // every tracked account a fresh allowance, so whoever fills the map wipes
  // their own counter, which is the same bug wearing a different hat.
  // The index matters, and getting it wrong is how this test first passed
  // against the very ordering it exists to forbid. Eviction only fires when the
  // map is ALREADY over MAX_TRACKED_USERS, so the two orderings trip it on
  // different accounts: evicting before the insert first fires on account
  // MAX + 2, evicting after it first fires on account MAX + 1. Account MAX + 1
  // is therefore the one that separates them — under the correct ordering it is
  // inserted with no eviction at all, and under the broken one its own insert
  // pushes the map over and it is the zero-spend entry deleted first.
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'birdieUsage.js'), 'utf8');
  const MAX = Number(/const MAX_TRACKED_USERS = ([\d_]+);/.exec(src)[1].replace(/_/g, ''));

  __resetGeminiSpend();
  const FLOOD_BASE = 500_000;
  const total = MAX + 1;
  for (let i = 0; i < total; i++) {
    assert.strictEqual(realAllow(FLOOD_BASE + i, 100), true, `flood account ${i} should charge`);
  }
  const trigger = FLOOD_BASE + total - 1;
  assert.strictEqual(geminiSpendStatus(trigger).userHourRemaining, PER_USER_HOURLY_TOKENS - 100,
    'the account whose insert crossed the ceiling must still hold its own charge');
  assert.strictEqual(geminiSpendStatus(trigger).trackedUsers, total,
    'eviction is lazy: it runs on the NEXT insert, so nothing is dropped yet');

  // Now push past it so eviction genuinely runs, and check both that the map is
  // bounded and that an account inserted AFTER an eviction still keeps its own.
  for (let i = total; i < total + 5; i++) {
    assert.strictEqual(realAllow(FLOOD_BASE + i, 100), true, `post-eviction account ${i}`);
  }
  const after = FLOOD_BASE + total + 4;
  assert.ok(geminiSpendStatus(after).trackedUsers <= MAX, 'the map must actually have been bounded');
  assert.strictEqual(geminiSpendStatus(after).userHourRemaining, PER_USER_HOURLY_TOKENS - 100,
    'and the charge that ran the eviction is still recorded against its account');
  assert.strictEqual(geminiSpendStatus(after).globalUsed, (total + 5) * 100,
    'every charge reached the process-wide counter, evicted or not');

  for (let i = 0; i < total; i++) {
    const r = checkUserRateLimit(FLOOD_BASE + i);
    assert.strictEqual(r.allowed, true, `turn meter flood account ${i}`);
  }
  assert.strictEqual(getUsedToday(trigger), 1,
    'the turn meter must not lose the entry it just created either');
});

test('the eviction path is bounded work, not a scan on every call', () => {
  // Evicting down to exactly the ceiling means a map held at the ceiling pays a
  // full sort on EVERY charge — a self-inflicted CPU DoS for anyone able to keep
  // it full. There has to be a gap.
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'birdieUsage.js'), 'utf8');
  const max = Number(/const MAX_TRACKED_USERS = ([\d_]+);/.exec(src)[1].replace(/_/g, ''));
  const target = Number(/const EVICT_TARGET = ([\d_]+);/.exec(src)[1].replace(/_/g, ''));
  assert.ok(target < max, 'eviction must drop below the ceiling, not to it');
  assert.ok(max - target >= max * 0.05, 'and the gap must be big enough to amortise the sort');
  assert.ok(!/\.clear\(\)/.test(src.slice(src.indexOf('function evictLeastConsumed'), src.indexOf('function checkUserRateLimit'))),
    'never clear() a map to make room');
});

