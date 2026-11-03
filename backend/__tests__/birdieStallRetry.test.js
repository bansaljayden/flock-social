// Run: node --test __tests__/birdieStallRetry.test.js  (from backend/)
//
// ONE RETRY AFTER A STALL (routes/ai.js), the owner's decision of 2026-11-03.
// A Birdie Gemini call that dies on our own twelve-second deadline is sent once
// more, and nothing else is. Pinned through the real route with Gemini faked:
//   * a stall, then a good reply: the turn answers, and both attempts are
//     charged to the spend ledger before they go;
//   * a second stall ends the turn exactly as one stall always has;
//   * one retry a turn;
//   * a 402, 429, 503, or a timeout Google itself reported, is never retried
//     as a stall, and a retry Google answers with a 503 is not tried again;
//   * no retry while Birdie's or Roost's outage breaker is open;
//   * no retry whose deadline would end past the turn's cap, and the cap
//     leaves the app's own 75 s wait room;
//   * the daily spend ceiling still refuses a retry that does not fit;
//   * one log line per stall, numbers and fixed words, no user text;
//   * Roost's model calls (the chip phrasing and a typed question) are still
//     never retried on a timeout.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'birdie-stall-retry-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
// posthog-node holds a connection open, and NODE_ENV is deleted above.
delete process.env.POSTHOG_API_KEY;
// Roost's model is asked (section 7), so its phrasing is on and the playbook
// does not answer first.
process.env.ADVISOR_PHRASING_ENABLED = 'true';
delete process.env.ROOST_PLAYBOOK_FIRST;

// The spend ledger keys its day on the UTC date and these cases charge it and
// read it back, so the clock is pinned to the middle of a UTC day before
// anything loads (helpers/pinnedClock.js says why).
const { pinClock } = require('./helpers/pinnedClock');
const PINNED_AT = Date.UTC(2026, 6, 15, 12, 0, 0);
const pinnedClock = pinClock(PINNED_AT);
test.after(() => pinnedClock.restore());
const { withSteppingClock } = require('./helpers/steppingClock');

// THE DEADLINE, SHORTENED FOR THIS FILE ONLY, before the route takes the
// function (the eval's --gemini-deadline does the same). A fake can then stall
// on the real signal and reject with what the SDK rejects with when our
// deadline fires: the signal's own TimeoutError. UPSTREAM_TIMEOUT_MS is not
// touched, so the turn's cap is computed on the real twelve seconds.
const STALL_MS = 40;
const upstream = require('../utils/upstream');
const { UPSTREAM_TIMEOUT_MS } = upstream;
const realSignal = upstream.upstreamSignal;
upstream.upstreamSignal = (kind) => (kind === 'gemini' ? AbortSignal.timeout(STALL_MS) : realSignal(kind));

// --- The database --------------------------------------------------------
const pool = require('../config/database');
let handlers = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  for (const [re, fn] of handlers) {
    if (re.test(flat)) return Promise.resolve(fn(params || [], flat));
  }
  if (/FROM users WHERE id/.test(flat)) {
    return Promise.resolve({ rows: [{ name: 'Ava Lee', date_of_birth: '2000-01-01' }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// Each request names its own account, so two turns can be in flight at once.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => {
  req.user = { id: Number(req.headers['x-test-user']), name: 'Ava' };
  next();
};

// Destructured by routes/ai.js at load, so patched first.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

// Nothing here may reach the network.
const realFetch = global.fetch;
global.fetch = (url, opts) => (String(url).startsWith('http://127.0.0.1')
  ? realFetch(url, opts)
  : Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
test.after(() => { global.fetch = realFetch; });

// --- The spend ledger, watched -------------------------------------------
// routes/ai.js destructures these at load, so the module object is wrapped
// before the router is required. Both call through to the real ledger, and
// every charge and every send lands on one timeline, so "charged before it
// goes" is read off the order.
const birdieUsage = require('../services/birdieUsage');
const realAllow = birdieUsage.allowGeminiCall;
const realSettle = birdieUsage.settleGeminiCall;
let timeline = [];
let ledgerCalls = [];
let settleCalls = [];
let refuseFrom = null; // 1-based ledger call to refuse from, or null
birdieUsage.allowGeminiCall = (userId, tokens) => {
  const n = ledgerCalls.length + 1;
  const allowed = refuseFrom !== null && n >= refuseFrom ? false : realAllow(userId, tokens);
  ledgerCalls.push({ n, userId, tokens, allowed });
  timeline.push(allowed ? 'charge' : 'refuse');
  return allowed;
};
birdieUsage.settleGeminiCall = (userId, estimated, actual) => {
  const added = realSettle(userId, estimated, actual);
  settleCalls.push({ userId, estimated, actual, added });
  return added;
};
const { geminiSpendStatus, getUsedToday, PER_USER_DAILY_TOKENS, PER_USER_HOURLY_TOKENS, GLOBAL_DAILY_TOKENS } = birdieUsage;
const spent = (uid) => PER_USER_DAILY_TOKENS - geminiSpendStatus(uid).userDayRemaining;

// --- Gemini, faked -------------------------------------------------------
const genaiMod = require('@google/genai');
let sendCalls = [];
let sendImpl = null;
const fakeChat = {
  sendMessage: async (params) => {
    const signal = params?.config?.abortSignal;
    sendCalls.push({ params, signal, abortedAtSend: signal ? signal.aborted : null });
    timeline.push('send');
    if (sendImpl) return sendImpl(params, sendCalls.length);
    return TEXT('try the place on 4th, it is quiet before 8');
  },
};
genaiMod.GoogleGenAI = function FakeGenAI() {
  return { chats: { create: () => fakeChat } };
};

const TEXT = (text, totalTokenCount) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  ...(totalTokenCount ? { usageMetadata: { totalTokenCount } } : {}),
});
// navigate_app touches no network and no other budget, and a "Take me there"
// button is something delivered, so a stall after it keeps the button.
const NAV_CALL = { candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'navigate_app', args: { screen: 'addFriends' } } }] } }] };

// A stall on OUR deadline: the fake waits for the signal the route passed and
// rejects with its reason, which is what a fetch does when that signal fires.
const stallOnSignal = (params) => new Promise((_, reject) => {
  const s = params.config.abortSignal;
  if (s.aborted) { reject(s.reason); return; }
  s.addEventListener('abort', () => reject(s.reason), { once: true });
});
// The same, thrown at once: the shape the other suites use.
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
// What @google/genai throws for an HTTP answer: the status on the error.
function geminiError(status, message) {
  const err = new Error(`got status: ${status} . ${message}`);
  err.status = status;
  return err;
}

// --- The route -------------------------------------------------------------
const aiRouter = require('../routes/ai');
const advisorPhrasing = require('../services/advisorPhrasing');
const advisorFreeText = require('../services/advisorFreeText');
const { BIRDIE_STALL_RETRY_CAP_MS, geminiStalled } = aiRouter.__testables;

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
let nextUserId = 52000;
test.beforeEach(() => {
  birdieUsage.__resetGeminiSpend();
  aiRouter.__clearBirdieSearchCache();
  aiRouter.__resetBirdieOutage();
  aiRouter.__resetStallRetryCounts();
  advisorPhrasing.__resetAdvisorSpend();
  handlers = [];
  timeline = [];
  ledgerCalls = [];
  settleCalls = [];
  refuseFrom = null;
  sendCalls = [];
  sendImpl = null;
});

const MESSAGE = 'somewhere quiet for dinner tonight?';
async function chat(text = MESSAGE, userId = ++nextUserId) {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': String(userId) },
    body: JSON.stringify({ messages: [{ role: 'user', text }] }),
  });
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: res.status, body, userId };
}

// Every console line written during fn, by level.
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
const stallLines = (lines) => lines.warn.filter((l) => l.startsWith('[AI] Birdie stall retry:'));
const totals = (counts) => `This process: ${counts.stalls} stalls, ${counts.sent} retried, ${counts.answered} answered, `
  + `${counts.stalledAgain} stalled again, ${counts.failed} failed, ${counts.refused} refused by the spend ledger, ${counts.notSent} not sent`;
const ZERO = { stalls: 1, sent: 0, answered: 0, stalledAgain: 0, failed: 0, refused: 0, notSent: 0 };

// ===========================================================================
// 1. A stall, then an answer
// ===========================================================================

test('a stall on our deadline is sent once more, and the reply answers the turn', async () => {
  const words = 'meet me by the zephyr quartz fountain, somewhere quiet?';
  sendImpl = (p, n) => (n === 1 ? stallOnSignal(p) : TEXT('mango street, quiet till 8', 50_000));
  const { result: r, lines } = await capturing(() => chat(words));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.text, 'mango street, quiet till 8');
  assert.strictEqual(sendCalls.length, 2);

  // The same request, on a deadline of its own.
  assert.strictEqual(sendCalls[0].signal.aborted, true, 'the first attempt died on the real signal');
  assert.notStrictEqual(sendCalls[1].signal, sendCalls[0].signal, 'the retry reused a deadline that had already fired');
  assert.strictEqual(sendCalls[1].abortedAtSend, false);
  assert.deepStrictEqual(sendCalls[1].params.message, sendCalls[0].params.message);
  assert.match(String(sendCalls[1].params.config.systemInstruction), /You are Birdie/,
    'the retry kept the system prompt (a per-request config replaces the chat\'s)');
  const tools = (sendCalls[1].params.config.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
  assert.ok(tools.includes('search_venues'), 'the retry kept the tools');

  // One message, one chirp: the retry is not a second message.
  assert.strictEqual(getUsedToday(r.userId), 1);

  // The log line: what the retry did and this process's totals, and nothing
  // the user typed.
  const said = stallLines(lines);
  assert.strictEqual(said.length, 1, lines.warn.join('\n'));
  assert.match(said[0], /^\[AI\] Birdie stall retry: answered \(\d+ ms\)\. /);
  assert.ok(said[0].endsWith(totals({ ...ZERO, sent: 1, answered: 1 })), said[0]);
  for (const word of ['zephyr', 'quartz', 'fountain', 'mango']) {
    assert.ok(!lines.warn.join('\n').includes(word), `"${word}" reached the log`);
  }
  assert.deepStrictEqual(aiRouter.__stallRetryCounts(), { stalls: 1, answered: 1, stalledAgain: 0, failed: 0, refused: 0, notSent: 0 });
});

test('both attempts are charged to the spend ledger, each before it goes', async () => {
  sendImpl = (p, n) => (n === 1 ? stallOnSignal(p) : TEXT('mango street, quiet till 8', 50_000));
  const r = await chat();
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(timeline, ['charge', 'send', 'charge', 'send'],
    'the retry must be charged before it is sent, like any attempt Google bills');
  assert.strictEqual(ledgerCalls.length, 2);
  assert.ok(ledgerCalls.every((c) => c.userId === r.userId && c.allowed));
  assert.strictEqual(ledgerCalls[1].tokens, ledgerCalls[0].tokens,
    'the retry re-sends the same conversation, so it is charged the same estimate');
  // The stalled attempt is never refunded (Google bills an aborted request),
  // and the retry's own reply is trued up like any other.
  assert.strictEqual(settleCalls.length, 1);
  assert.strictEqual(settleCalls[0].estimated, ledgerCalls[1].tokens);
  assert.strictEqual(spent(r.userId), ledgerCalls[0].tokens + ledgerCalls[1].tokens + settleCalls[0].added);
  assert.strictEqual(geminiSpendStatus(r.userId).globalUsed, spent(r.userId), 'the process-wide day pays for both too');
});

// ===========================================================================
// 2. A second stall ends the turn exactly as one always has
// ===========================================================================

test('a second stall on the first call answers 500 and hands the chirp back, as one stall did', async () => {
  sendImpl = (p) => stallOnSignal(p);
  const { result: r, lines } = await capturing(() => chat());
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.error, 'hmm gimme a sec, hit me again');
  assert.strictEqual(sendCalls.length, 2, 'one retry, and never a third attempt');
  assert.strictEqual(ledgerCalls.length, 2, 'both stalled attempts were billed and both were charged');
  assert.strictEqual(getUsedToday(r.userId), 0, 'nothing was delivered, so the chirp comes back as before');
  const said = stallLines(lines);
  assert.strictEqual(said.length, 1);
  assert.ok(said[0].startsWith('[AI] Birdie stall retry: stalled again. '), said[0]);
  assert.ok(said[0].endsWith(totals({ ...ZERO, sent: 1, stalledAgain: 1 })), said[0]);
});

test('a second stall after the tools delivered keeps what they delivered, as one stall did', async () => {
  sendImpl = (p, n) => (n === 1 ? NAV_CALL : stallOnSignal(p));
  const r = await chat('how do i add friends');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.navigate, { screen: 'addFriends' });
  assert.strictEqual(r.body.text, 'tap Take me there below');
  assert.strictEqual(sendCalls.length, 3);
  assert.strictEqual(getUsedToday(r.userId), 1, 'the button was delivered, so the chirp stays spent');
});

test('one retry a turn: a stall after the retry answered is not retried again', async () => {
  sendImpl = (p, n) => {
    if (n === 1) return stallOnSignal(p);
    if (n === 2) return NAV_CALL;
    return stallOnSignal(p);
  };
  const { result: r, lines } = await capturing(() => chat('how do i add friends'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.text, 'tap Take me there below');
  assert.strictEqual(sendCalls.length, 3, 'the second stall in the turn was bought again');
  const said = stallLines(lines);
  assert.strictEqual(said.length, 2);
  assert.ok(said[0].startsWith('[AI] Birdie stall retry: answered ('), said[0]);
  assert.ok(said[1].startsWith('[AI] Birdie stall retry: not sent (the turn had its retry). '), said[1]);
  assert.ok(said[1].endsWith(totals({ ...ZERO, stalls: 2, sent: 1, answered: 1, notSent: 1 })), said[1]);
});

// ===========================================================================
// 3. Google's answers keep their own handling
// ===========================================================================

for (const [label, error, sends, status, code] of [
  ['a 402', () => geminiError(402, 'Your prepayment credits are depleted.'), 1, 429, 'BIRDIE_OFFLINE'],
  ['a 429', () => geminiError(429, 'Resource has been exhausted (e.g. check quota).'), 2, 429, 'BIRDIE_BUSY'],
  ['a 503', () => geminiError(503, 'The model is overloaded. Please try again later.'), 2, 429, 'BIRDIE_BUSY'],
  // Google's own deadline, not ours: it carries a status.
  ['a 504 that says it timed out', () => geminiError(504, 'The request timed out.'), 1, 500, undefined],
]) {
  test(`${label} is never retried as a stall`, async () => {
    sendImpl = () => { throw error(); };
    const { result: r, lines } = await capturing(() => chat());
    assert.strictEqual(r.status, status, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, code);
    assert.strictEqual(sendCalls.length, sends, 'only the transient retry a 429 or 503 already had');
    assert.strictEqual(ledgerCalls.length, sends);
    assert.deepStrictEqual(stallLines(lines), [], 'a status Google sent was counted as our stall');
  });
}

test('a stall whose retry Google answers with a 503 is not tried a third time, and the breaker hears it', async () => {
  sendImpl = (p, n) => (n === 1 ? stallOnSignal(p) : Promise.reject(geminiError(503, 'The model is overloaded.')));
  const { result: r, lines } = await capturing(() => chat());
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.code, 'BIRDIE_BUSY');
  assert.strictEqual(sendCalls.length, 2, 'the retry got its 503 and that is the call\'s outcome');
  const said = stallLines(lines);
  assert.strictEqual(said.length, 1);
  assert.ok(said[0].startsWith('[AI] Birdie stall retry: failed (503). '), said[0]);
  // The breaker is open now, so the next turn costs nothing and asks nothing.
  const next = await chat();
  assert.strictEqual(next.status, 429);
  assert.strictEqual(sendCalls.length, 2);
});

test('the stall test is narrow: our deadline\'s own error, never one with a status', () => {
  assert.strictEqual(geminiStalled(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true);
  assert.strictEqual(geminiStalled(abortError()), true);
  assert.strictEqual(geminiStalled(geminiError(504, 'Deadline exceeded: the request timed out')), false);
  assert.strictEqual(geminiStalled(geminiError(503, 'UNAVAILABLE')), false);
  assert.strictEqual(geminiStalled(Object.assign(abortError(), { status: 499 })), false);
  assert.strictEqual(geminiStalled(new Error('fetch failed')), false);
  assert.strictEqual(geminiStalled(null), false);
});

// ===========================================================================
// 4. Never into an open breaker
// ===========================================================================

test("no retry once Birdie's breaker opens: another turn's 402 lands while this one stalls", async () => {
  let stalledStarted;
  const firstCallInFlight = new Promise((resolve) => { stalledStarted = resolve; });
  let releaseStall;
  const outageAnswered = new Promise((resolve) => { releaseStall = resolve; });
  sendImpl = (p) => {
    if (p.message === 'the slow one') {
      stalledStarted();
      return outageAnswered.then(() => { throw abortError(); });
    }
    throw geminiError(402, 'Your prepayment credits are depleted.');
  };
  const { result, lines } = await capturing(async () => {
    const slow = chat('the slow one');
    await firstCallInFlight;
    const outage = await chat('the outage one');
    releaseStall();
    return { slow: await slow, outage };
  });
  assert.strictEqual(result.outage.status, 429);
  assert.strictEqual(result.outage.body.code, 'BIRDIE_OFFLINE');
  assert.strictEqual(result.slow.status, 500, 'the stalled turn ends as a stall did before');
  assert.strictEqual(sendCalls.filter((c) => c.params.message === 'the slow one').length, 1,
    'the stall was retried into an outage the breaker already knew about');
  const said = stallLines(lines);
  assert.strictEqual(said.length, 1);
  assert.ok(said[0].startsWith('[AI] Birdie stall retry: not sent (an outage breaker is open). '), said[0]);
});

test("no retry while Roost's breaker is open: the two call Gemini on one key", async () => {
  advisorPhrasing.internals.noteModelFailure(geminiError(402, 'Your prepayment credits are depleted.'));
  assert.strictEqual(advisorPhrasing.internals.modelAvailable(), false, 'precondition: Roost\'s breaker is open');
  sendImpl = (p) => stallOnSignal(p);
  const { result: r, lines } = await capturing(() => chat());
  assert.strictEqual(r.status, 500, 'Birdie\'s own breaker is closed, so the turn ran and its stall ended it');
  assert.strictEqual(sendCalls.length, 1);
  assert.strictEqual(ledgerCalls.length, 1);
  assert.ok(stallLines(lines)[0].startsWith('[AI] Birdie stall retry: not sent (an outage breaker is open). '));
});

// ===========================================================================
// 5. The cap
// ===========================================================================

test('the cap is the turn budget, so the longest turn still fits inside the app\'s 75 s', () => {
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  const budget = Number(/const BIRDIE_TURN_BUDGET_MS = ([\d_]+);/.exec(aiSrc)[1].replace(/_/g, ''));
  assert.strictEqual(BIRDIE_STALL_RETRY_CAP_MS, budget);
  // After a retry that ends inside the cap, one more call may start at the
  // budget's last moment, fail fast, pause and be retried once as a
  // transient, and that second attempt may run its whole deadline. That is
  // the longest turn, with or without a stall retry, and the app has to still
  // be waiting at the end of it.
  assert.match(aiSrc, /await new Promise\(r => setTimeout\(r, 800\)\);/);
  const longestTurn = budget + 2 * UPSTREAM_TIMEOUT_MS.gemini + 800;
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'services', 'api.js'), 'utf8');
  const appWaits = Number(/^const AI_TIMEOUT_MS = (\d+);/m.exec(apiSrc)[1]);
  assert.ok(longestTurn < appWaits, `a turn can run ${longestTurn} ms and the app waits ${appWaits} ms`);
});

for (const [label, stalledAtMs, retried] of [
  ['a retry that ends inside the cap is sent', 32_000, true],
  ['a retry whose deadline would end past the cap is not sent', 34_000, false],
]) {
  test(label, async () => {
    // The stall moves the clock to where it ends, so the route decides with
    // the turn that far along. The real deadline is 12 s, so the line between
    // the two cases is 33 s into the turn (45 s less 12 s).
    await withSteppingClock(PINNED_AT, async (clock) => {
      sendImpl = (_p, n) => {
        if (n === 1) {
          clock.set(PINNED_AT + stalledAtMs);
          throw abortError();
        }
        return TEXT('mango street, quiet till 8');
      };
      const { result: r, lines } = await capturing(() => chat());
      const said = stallLines(lines);
      assert.strictEqual(said.length, 1);
      if (retried) {
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.text, 'mango street, quiet till 8');
        assert.strictEqual(sendCalls.length, 2);
        assert.ok(said[0].startsWith('[AI] Birdie stall retry: answered ('), said[0]);
      } else {
        assert.strictEqual(r.status, 500);
        assert.strictEqual(sendCalls.length, 1);
        assert.strictEqual(ledgerCalls.length, 1, 'a retry the cap ruled out was charged anyway');
        assert.ok(said[0].startsWith('[AI] Birdie stall retry: not sent (past the turn cap). '), said[0]);
      }
    });
  });
}

// ===========================================================================
// 6. The spend ceiling still applies before the retry
// ===========================================================================

test('the daily spend ceiling refuses a retry that does not fit, and the turn says so', async () => {
  // What this conversation costs a call, from one that answers.
  sendImpl = () => TEXT('ok');
  const dry = await chat();
  assert.strictEqual(dry.status, 200);
  const estimate = ledgerCalls[0].tokens;

  // Fill the process-wide day to one and a half calls short of the ceiling,
  // spread over accounts the way it fills in production.
  let left = GLOBAL_DAILY_TOKENS - geminiSpendStatus(0).globalUsed - Math.floor(estimate * 1.5);
  for (let id = 990_000; left > 0; id++) {
    const t = Math.min(left, PER_USER_HOURLY_TOKENS);
    assert.strictEqual(realAllow(id, t), true);
    left -= t;
  }
  ledgerCalls = [];
  timeline = [];
  sendCalls = [];

  sendImpl = (p) => stallOnSignal(p);
  const { result: r, lines } = await capturing(() => chat());
  assert.strictEqual(r.status, 429);
  assert.match(r.body.error, /we've hit the day's limit/);
  assert.deepStrictEqual(timeline, ['charge', 'send', 'refuse'], 'the retry that did not fit reached Gemini');
  assert.strictEqual(getUsedToday(r.userId), 0, 'nothing was delivered, so the chirp comes back');
  const said = stallLines(lines);
  assert.strictEqual(said.length, 1);
  assert.ok(said[0].startsWith('[AI] Birdie stall retry: refused. '), said[0]);
});

test('a retry the ledger refuses mid-turn keeps what the tools delivered and names the limit', async () => {
  // Call 1 asks for the button, call 2 stalls, and the ledger refuses call 3.
  refuseFrom = 3;
  sendImpl = (p, n) => (n === 1 ? NAV_CALL : stallOnSignal(p));
  const r = await chat('how do i add friends');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.navigate, { screen: 'addFriends' });
  assert.match(r.body.text, /^that's my limit for today\. i'm back /);
  assert.strictEqual(sendCalls.length, 2);
});

// ===========================================================================
// 7. Roost is not Birdie
// ===========================================================================

const ROOST_TIMEOUT = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
function roostSees() {
  const calls = [];
  advisorPhrasing.__setGenAIForTests({
    models: { generateContent: async (args) => { calls.push(args); throw ROOST_TIMEOUT(); } },
  });
  // Both of Roost's meters say yes, so the model is asked.
  handlers.push([/INSERT INTO advisor_venue_spend/, () => ({ rows: [{ tokens: 1 }], rowCount: 1 })]);
  handlers.push([/INSERT INTO advisor_spend/, () => ({ rows: [{ tokens: 1 }], rowCount: 1 })]);
  return calls;
}
test.after(() => advisorPhrasing.__setGenAIForTests(null));

test("Roost's chip phrasing still serves its template after one call that times out", async () => {
  const calls = roostSees();
  const block = {
    intent: 'peak_hours',
    facts: [
      { id: 'peak_hour', value: 21, unit: 'hour', source: 'model_holdout', asOf: '2026-07-15T10:00:00Z', label: 'Projected peak tonight is 9 PM. An estimate, not a promise.' },
      { id: 'kitchen_last_order', value: '21:00', source: 'intake', asOf: 'owner-set 2026-07-14', label: 'You told us your kitchen takes its last order at 21:00.' },
    ],
    refusals: [],
  };
  const out = await advisorPhrasing.phrase(block, { venueUserId: 7 });
  assert.strictEqual(out.mode, 'template');
  assert.strictEqual(calls.length, 1, 'Roost retried a timed-out paid call');
  assert.strictEqual(advisorPhrasing.internals.modelAvailable(), true, 'a timeout is not an outage');
});

test("a typed question to Roost is asked once when its model call times out", async () => {
  const calls = roostSees();
  const out = await advisorFreeText.advise({
    userId: 7,
    question: 'how do I fill Tuesdays',
    ctx: { profile: { user_id: 7, google_place_id: 'place-x', verified: true, business_name: 'Test Room', capacity: 90, service_style: 'counter' } },
    unrouted: true,
  });
  assert.ok(out && typeof out.text === 'string' && out.text.length > 0);
  assert.strictEqual(calls.length, 1, 'Roost retried a timed-out paid call');
});
