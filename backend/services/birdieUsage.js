// ---------------------------------------------------------------------------
// Birdie (Gemini) usage tracking. TWO LEDGERS LIVE HERE AND THEY MEASURE
// DIFFERENT THINGS. Read this before changing either.
//
//   1. THE TURN METER — checkUserRateLimit(). Counts CONVERSATION TURNS: 150 a
//      day (10 on the free tier), 15 a minute. This is the PRODUCT limit. It is
//      what services/entitlements.js reports to the client, what the paywall
//      copy promises, and what the 429 tells the user. It is denominated in
//      messages because that is the unit a person understands.
//
//   2. THE SPEND LEDGER — allowGeminiCall(). Counts TOKENS, per Gemini API
//      call. This is the FINANCIAL control, the direct equivalent of
//      utils/placesBudget.js, and it exists because the turn meter is not one.
//
// WHY ONE IS NOT ENOUGH — the hole this file used to have.
//
//   Gemini is billed PER TOKEN, and one accepted turn is not one billed call.
//   routes/ai.js runs a tool loop of up to 5 further rounds after the first
//   send, and every round re-sends the whole conversation (the SDK has no
//   server-side session; history goes up the wire again each time). A transient
//   429/5xx additionally buys one retry per call. So ONE unit of the turn meter
//   authorised up to 6 calls, up to 12 with retries, of a payload the CALLER
//   sizes: the route accepts 24 messages of 4,000 characters each, so a maximal
//   turn is roughly 24,000 input tokens on the first round and grows from there
//   as tool results accumulate. Around 200,000 input tokens for one "message".
//
//   Multiply that by the 150 turns a day the turn meter allows and one account
//   could ask for on the order of 30 million tokens a day. Multiply THAT by as
//   many free accounts as somebody cares to register — there is no global
//   ceiling anywhere in this process — and the monthly number lands in the same
//   four figures as the ungated Places surface described in
//   utils/placesBudget.js. That is the hole. A meter that charges 1 for up to 12
//   billed calls of caller-chosen size is a limit on politeness, not on money.
//
//   CHARGE BEFORE YOU CALL, AND CHARGE WHAT YOU SPEND — the same two rules
//   placesBudget.js states, applied to a per-token upstream:
//     * Every single chat.sendMessage() charges this ledger, including the
//       retry. An aborted or failed call is still billed by Google
//       (utils/upstream.js), so a charge-on-success design undercounts exactly
//       when the upstream is sick and our call rate is highest.
//     * The charge is denominated in TOKENS, estimated from the character count
//       of everything going up the wire, plus a fixed reserve for the reply we
//       cannot see yet. A long prompt therefore costs more than a short one,
//       which is the whole point: a per-CALL ceiling bounds how many questions
//       are asked and says nothing about how expensive each one is.
//     * settleGeminiCall() trues the estimate up from the SDK's usageMetadata
//       when it is present, so the reserve being wrong in the cheap direction
//       does not accumulate into a free allowance.
//
// WHAT THIS BOUNDS AND WHAT IT DOES NOT.
//   It bounds tokens per account per rolling hour, per account per UTC day, and
//   across the whole process per UTC day. It does NOT cap the length of any
//   single reply — nothing here sets maxOutputTokens, so one call's output is
//   bounded by the model default, and a model that thinks before answering
//   bills those thinking tokens at output rates. The ledger notices that
//   afterwards (settleGeminiCall) rather than preventing it, so the worst case
//   is one over-long reply per account before their next call is refused.
//
// IN-MEMORY STATE — the same caveat utils/placesBudget.js and
// utils/probeBudget.js carry, restated because it changes what the numbers
// mean:
//   * Every counter below lives in this process's heap. It resets to zero on
//     every Railway deploy, crash and restart. A day with ten deploys has ten
//     fresh global allowances, so GLOBAL_DAILY_TOKENS is a brake, not a cap.
//   * The counters divide by the instance count. Two instances = double every
//     limit here, silently.
//   * Nothing races: every function below is fully synchronous and Node runs
//     one turn at a time, so two concurrent requests cannot interleave inside a
//     counter. That guarantee is per process and evaporates at two.
//   * WHAT SHOULD MOVE TO POSTGRES FIRST: GLOBAL_DAILY_TOKENS, for exactly the
//     reason placesBudget.js gives for its own global counter — it is the only
//     limit here denominated in money, and a deploy loop is indistinguishable
//     from having no cap. One row (`gemini_spend(day date primary key, tokens
//     bigint)`) updated with INSERT ... ON CONFLICT DO UPDATE ... RETURNING is
//     one round trip and survives restarts and instances.
// ---------------------------------------------------------------------------

const userRateLimits = new Map();

const PREMIUM_DAILY_LIMIT = 150; // was USER_DAILY_LIMIT — applies when paywall off or user is premium
const FREE_DAILY_LIMIT = 10;     // applies when paywall on and user is not premium
const USER_PER_MIN_LIMIT = 15;   // everyone, always

// Soft ceiling on tracked accounts, same shape and same reasoning as
// utils/placesBudget.js: the entries are tiny and dropping one hands its owner
// a fresh allowance, so eviction is a last resort and never a clear().
const MAX_TRACKED_USERS = 20000;
const EVICT_TARGET = 18000;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// '5' and 5 are the same account and must share one bucket, and anything that
// is not a real id is refused rather than handed a free lane. Copied in intent
// from utils/placesBudget.js keyOf(): Number(null), Number(''), Number(false)
// and Number([]) are all 0, so a permissive check would give every
// unidentifiable caller one shared allowance AND let them through. users.id is
// SERIAL, so a positive integer is the only valid shape. Fail closed — both
// ledgers below are spending controls.
function accountKey(userId) {
  if (typeof userId !== 'number' && typeof userId !== 'string') return null;
  const n = Number(userId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Never clear() a map to make room: a wholesale clear hands every tracked
// account a fresh allowance, so whoever pushes the map over the threshold wipes
// their own counter. Evict LEAST CONSUMED first — the entries dropped are the
// ones with almost nothing left to remember, and an account that has spent
// everything is the last to go. Age is the wrong key, because an attacker
// spends their allowance and only THEN floods the map, which makes their entry
// the oldest one there.
//
// CALL THIS BEFORE INSERTING, NEVER AFTER. Found re-auditing this file: a fresh
// entry has spent nothing, so it sorts FIRST under a least-consumed policy and
// is the very entry eviction deletes. Evicting after the insert therefore threw
// away the counter belonging to the caller who triggered the eviction — in the
// turn meter the subsequent `.get()` came back undefined and 500'd the request,
// and in the spend ledger the charge was written to an object no longer in the
// map, i.e. silently not charged at all. Making room first means the entry
// being written is never a candidate to remove.
function evictLeastConsumed(map, spentOf) {
  if (map.size <= MAX_TRACKED_USERS) return;
  const bySpend = [...map.entries()].sort((a, b) => spentOf(a[1]) - spentOf(b[1]));
  for (const [k] of bySpend) {
    if (map.size <= EVICT_TARGET) break;
    map.delete(k);
  }
}

function checkUserRateLimit(userId, dailyLimit = PREMIUM_DAILY_LIMIT) {
  const now = Date.now();
  const key = todayKey();

  const id = accountKey(userId);
  if (id === null) {
    return { allowed: false, reason: 'identity', error: 'hold up, gimme a sec' };
  }

  if (!userRateLimits.has(id)) {
    // Room first, then the insert — see evictLeastConsumed.
    evictLeastConsumed(userRateLimits, (v) => (v.day === key ? v.dailyCount : 0));
    userRateLimits.set(id, { day: key, dailyCount: 0, recentTimestamps: [] });
  }

  const limit = userRateLimits.get(id);

  // Reset daily count if new day
  if (limit.day !== key) {
    limit.day = key;
    limit.dailyCount = 0;
  }

  // Check daily limit
  if (limit.dailyCount >= dailyLimit) {
    return { allowed: false, reason: 'daily', error: `you've been chatting up a storm 🐦 catch up tomorrow!` };
  }

  // Check per-minute limit
  const oneMinAgo = now - 60000;
  limit.recentTimestamps = limit.recentTimestamps.filter(ts => ts > oneMinAgo);
  if (limit.recentTimestamps.length >= USER_PER_MIN_LIMIT) {
    return { allowed: false, reason: 'minute', error: 'easy there, gimme a sec to catch up' };
  }

  // Allow and record
  limit.dailyCount++;
  limit.recentTimestamps.push(now);
  return { allowed: true, remaining: dailyLimit - limit.dailyCount };
}

// How many Birdie messages this user has used today (0 if none or stale day).
// Reads through accountKey for the same reason checkUserRateLimit writes
// through it: '5' and 5 must be one account, or the number the client is shown
// in its entitlements can disagree with the number the meter is enforcing.
// Hands one daily chirp back. The meter charges before the model is called,
// so a failed call (provider 5xx or 429, a spend-ledger refusal, a safety
// block, an empty answer) used to cost a free-tier message that delivered
// nothing, and the error copy invited the retry that spent the next one
// (chat audit, 2026-09-05). The per-minute stamp stays: a burst is a burst
// whether or not the model answered.
function refundTurn(userId) {
  const id = accountKey(userId);
  if (id === null) return;
  const limit = userRateLimits.get(id);
  if (!limit || limit.day !== todayKey()) return;
  if (limit.dailyCount > 0) limit.dailyCount -= 1;
}

function getUsedToday(userId) {
  const id = accountKey(userId);
  if (id === null) return 0;
  const limit = userRateLimits.get(id);
  if (!limit || limit.day !== todayKey()) return 0;
  return limit.dailyCount;
}

// ISO timestamp of the next UTC midnight — when daily counts reset.
function nextUtcMidnightISO() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

// Clean up stale entries every hour (unref so this never keeps the process alive).
// The spend ledger below is swept by the same timer, but only where BOTH of its
// windows are empty: dropping an entry on the day rollover alone would discard
// live hourly timestamps and hand that account a second full hour, which is the
// trap utils/probeBudget.js documents in its own prune().
setInterval(() => {
  const key = todayKey();
  for (const [userId, limit] of userRateLimits) {
    if (limit.day !== key) userRateLimits.delete(userId);
  }
  const now = Date.now();
  for (const [userId, entry] of geminiUserSpend) {
    if (entry.day === geminiDayKey) continue;
    if (liveHourTokens(entry, now) === 0) geminiUserSpend.delete(userId);
  }
}, 3600000).unref();

// ---------------------------------------------------------------------------
// THE SPEND LEDGER — tokens, per Gemini call. See the header of this file for
// why the turn meter above is not one.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

// THE LIMITS (the authoritative statement — nothing else in the repo states
// them, so keep this block current):
//
//   PER_USER_HOURLY_TOKENS = 1,000,000  per account, per ROLLING 60 minutes.
//                            Rolling, so there is no boundary a caller can wait
//                            for and burst across.
//   PER_USER_DAILY_TOKENS  = 4,000,000  per account, per FIXED UTC day.
//   GLOBAL_DAILY_TOKENS    = 30,000,000 across the whole process, per FIXED UTC
//                            day.
//
// WHERE THE PER-USER NUMBERS COME FROM, AND WHY THEY ARE NOT TIGHTER. Every
// call re-sends the ~2,000-token system prompt and tool declarations, so even a
// trivial exchange costs about 2,500 tokens per call. A tool-heavy turn runs the
// full six rounds: ~15,000 tokens. The TURN meter already allows 150 turns a
// day, so an entirely legitimate heavy day is ~2.25M tokens. Setting the daily
// figure below that would mean this ledger throttling ordinary use, which is the
// failure a money control must not have — it would look like Birdie being
// broken, and the next person to debug it would raise the ceiling without
// reading why it was there. 4M leaves real headroom above the heaviest honest
// day. The abusive shape from the header (24 maximal messages driven through six
// rounds, ~200,000 tokens for one "message") gets about 20 turns a day instead
// of 150, and about 5 an hour, which is the bite that matters.
//
// THE GLOBAL FIGURE IS THE ONE DENOMINATED IN MONEY, AND THE RATE IT IS
// DENOMINATED AT IS NOT A CONSTANT. This paragraph used to price 30M mixed
// tokens at "roughly $0.10 per million input and $0.40 per million output",
// giving ~$5 a day and ~$150 a month at the wall. Those are Gemini 2.5
// Flash-Lite's rates. routes/ai.js:69 defaults BIRDIE_MODEL to
// gemini-3.5-flash-lite, which is $0.30 and $2.50 — three times the input and
// six times the output (ai.google.dev/gemini-api/docs/pricing, checked
// 2026-08-19).
//
// settleGeminiCall charges usageMetadata.totalTokenCount, a single mixed
// figure, so pricing it needs a split. Birdie is input-heavy by construction —
// every call re-sends the ~2,000-token system prompt and the whole conversation
// — so output is roughly 5-10% of the total. At that mix, 30M tokens is:
//
//     gemini-2.5-flash-lite   ~$3.45-3.90/day   ~$105-120/month
//     gemini-3.5-flash-lite   ~$12.30-15.60/day  ~$370-470/month
//
// Both are numbers this project can survive being surprised by, which is the
// only property a ceiling has to have. The point of writing them both down is
// that the ceiling's meaning moved without the ceiling moving.
//
// WHICH IS THE HOLE THE PARAGRAPH BELOW USED TO CLAIM WAS CLOSED. The token
// count is a hard constant and not an env var, on the reasoning that a spending
// ceiling widenable from a dashboard is one somebody widens at 2am during an
// incident. That reasoning is right and it is incomplete: BIRDIE_MODEL *is* an
// env var, switchable from Railway with no deploy (routes/ai.js:64 advertises
// this as a feature), and switching it multiplies what this constant costs by
// up to 6x on output. The number of tokens is protected. The number of dollars
// is not.
//
// So a model change is a spend change, and anyone making one has to re-read
// this block and re-derive the two lines above for the new rate card. That is
// the actual invariant, and it could not be enforced in code without pinning
// the model here — which would cost the ability to switch away from a model
// that is failing, and that is worth more than the guardrail.
//
// THE TRADE THIS MAKES, STATED PLAINLY. 30M global against 4M per account means
// about EIGHT accounts spending their full daily allowance exhaust the process
// ceiling, and Birdie then answers "lot of chatter right now" to everybody until
// UTC midnight. That is a denial-of-service surface, and it is chosen on
// purpose: Birdie is a nice-to-have inside a coordination app, an unbounded
// Gemini invoice is not survivable, and a feature outage is recoverable where a
// four-figure bill is not. If Birdie ever becomes load-bearing, the fix is not a
// bigger number — it is moving this counter to Postgres so it can be watched and
// alerted on before it is reached.
//
// SIZE IT AGAINST REAL TRAFFIC BEFORE LAUNCH. 30M a day is roughly 12,000 simple
// turns process-wide. At the ~0 real users this app has today that is vast
// headroom; at a few hundred daily actives it is not. Whoever watches the first
// real traffic should read geminiSpendStatus().globalUsed against this number
// before it becomes an outage.
const PER_USER_HOURLY_TOKENS = 1_000_000;
const PER_USER_DAILY_TOKENS = 4_000_000;
const GLOBAL_DAILY_TOKENS = 30_000_000;

// Estimating an input size from characters. Four characters per token is the
// conventional English approximation and it is close enough for a ceiling —
// this is not a billing reconciliation, it is a brake. Where it is wrong it is
// wrong in the cheap direction for dense text (code, JSON, non-Latin scripts
// tokenize worse than 4:1), which is why settleGeminiCall exists.
const CHARS_PER_TOKEN = 4;

// What we reserve for a reply we have not seen yet. Nothing in routes/ai.js
// sets maxOutputTokens, so the true figure is bounded only by the model default
// and, on a thinking model, by however long it thinks. The reserve makes the
// pre-call charge honest about the fact that output exists and is billed at a
// higher rate; settleGeminiCall corrects it upward from usageMetadata when the
// SDK reports one.
const OUTPUT_RESERVE_TOKENS = 512;

const geminiUserSpend = new Map(); // account id -> { hits: [{t, tokens}], day, dayTokens }
let geminiDayKey = todayKey();
let geminiDayTokens = 0;

function rollGeminiDay() {
  const today = todayKey();
  if (today !== geminiDayKey) {
    geminiDayKey = today;
    geminiDayTokens = 0;
  }
}

function liveHourTokens(entry, now) {
  entry.hits = entry.hits.filter((h) => now - h.t < HOUR_MS);
  let total = 0;
  for (const h of entry.hits) total += h.tokens;
  return total;
}

/**
 * Estimate what one Gemini call will cost, in tokens, from the number of
 * characters going up the wire. `promptChars` must be EVERYTHING the SDK will
 * send — system instruction, full history, and the new payload — because the
 * SDK holds no server-side session and re-sends the whole conversation on every
 * call. Charging only the new part is how a six-round tool loop ends up billed
 * as one short question.
 *
 * A non-finite or negative input is treated as zero characters rather than
 * throwing: the reserve still applies, so an unmeasurable payload is charged
 * something rather than nothing.
 */
function estimateGeminiTokens(promptChars) {
  const chars = Number.isFinite(promptChars) && promptChars > 0 ? promptChars : 0;
  return Math.ceil(chars / CHARS_PER_TOKEN) + OUTPUT_RESERVE_TOKENS;
}

function chargeGemini(id, tokens, now) {
  let entry = geminiUserSpend.get(id);
  if (!entry) {
    // Room first, then the insert — see evictLeastConsumed.
    evictLeastConsumed(geminiUserSpend, (v) => (v.day === geminiDayKey ? v.dayTokens : 0));
    entry = { hits: [], day: geminiDayKey, dayTokens: 0 };
    geminiUserSpend.set(id, entry);
  }
  if (entry.day !== geminiDayKey) {
    // Roll the DAY only. The rolling hour has to survive the rollover, or a
    // caller who spent their hour in the last minutes of the UTC day gets a
    // second full hour seconds later, at a moment they can compute exactly.
    // utils/probeBudget.js documents the same trap.
    entry.day = geminiDayKey;
    entry.dayTokens = 0;
  }
  entry.hits.push({ t: now, tokens });
  entry.dayTokens += tokens;
  geminiDayTokens += tokens;
  return entry;
}

/**
 * Charge the Gemini spend ledger for ONE call, BEFORE the call is made.
 *
 * All-or-nothing: a call that does not fit under every ceiling is refused and
 * charged nothing, so a partial charge can never leave the caller believing it
 * may proceed.
 *
 * @param {number|string} userId  authenticated users.id
 * @param {number} tokens         estimateGeminiTokens() for this call
 * @returns {boolean} true when the caller may make the call
 */
function allowGeminiCall(userId, tokens) {
  // `tokens` is DERIVED FROM USER INPUT here, which is the one place this
  // module deliberately parts company with utils/placesBudget.js. There, `cost`
  // is always a literal at the call site, so a bad one is a programming error
  // and throwing is right. Here a caller can make the estimate large simply by
  // typing a lot, and a request that 500s because somebody pasted an essay is a
  // worse outcome than one that is throttled. So an impossible size is REFUSED,
  // not thrown; only a value that could not have come from the estimator at all
  // (not an integer, not positive) is a programming error.
  if (!Number.isInteger(tokens) || tokens < 1) {
    throw new Error(`birdieUsage: tokens must be a positive integer, got ${String(tokens)}`);
  }
  const id = accountKey(userId);
  if (id === null) return false;
  if (tokens > PER_USER_HOURLY_TOKENS) return false;

  rollGeminiDay();
  if (geminiDayTokens + tokens > GLOBAL_DAILY_TOKENS) return false;

  const now = Date.now();
  const entry = geminiUserSpend.get(id);
  if (entry) {
    if (entry.day !== geminiDayKey) {
      entry.day = geminiDayKey;
      entry.dayTokens = 0;
    }
    // Prune first and WRITE BACK even on a refusal, so an idle-then-refused
    // account does not keep a stale hour of timestamps alive.
    const hourUsed = liveHourTokens(entry, now);
    if (hourUsed + tokens > PER_USER_HOURLY_TOKENS) return false;
    if (entry.dayTokens + tokens > PER_USER_DAILY_TOKENS) return false;
  }

  chargeGemini(id, tokens, now);
  return true;
}

/**
 * True the estimate up after the call, from the SDK's usageMetadata.
 *
 * Only ever charges the DIFFERENCE, and only when the real figure is larger.
 * Refunding an over-estimate is deliberately not done: the estimate is a brake
 * and giving budget back on every short reply would let a caller alternate one
 * huge prompt with many tiny ones and never settle up. An over-estimate simply
 * costs that account a little of its own allowance.
 *
 * This cannot refuse anything — the call is already made and already billed by
 * Google. What it does is make the NEXT call see the real number.
 *
 * @param {number|string} userId
 * @param {number} estimatedTokens  what allowGeminiCall was charged
 * @param {number} actualTokens     usageMetadata.totalTokenCount, or absent
 * @returns {number} tokens added by this settlement (0 when there is nothing to do)
 */
function settleGeminiCall(userId, estimatedTokens, actualTokens) {
  const id = accountKey(userId);
  if (id === null) return 0;
  if (!Number.isFinite(actualTokens) || !Number.isFinite(estimatedTokens)) return 0;
  const delta = Math.ceil(actualTokens - estimatedTokens);
  if (!(delta > 0)) return 0;
  rollGeminiDay();
  chargeGemini(id, delta, Date.now());
  return delta;
}

/**
 * Non-consuming read, for tests and diagnostics. Never gate on this and then
 * call Gemini — read-then-act is not the same as allowGeminiCall()'s single
 * synchronous charge.
 */
function geminiSpendStatus(userId) {
  rollGeminiDay();
  const now = Date.now();
  const id = accountKey(userId);
  const entry = id === null ? null : geminiUserSpend.get(id);
  const hourUsed = entry ? liveHourTokens(entry, now) : 0;
  const dayUsed = entry && entry.day === geminiDayKey ? entry.dayTokens : 0;
  return {
    day: geminiDayKey,
    globalUsed: geminiDayTokens,
    globalRemaining: Math.max(0, GLOBAL_DAILY_TOKENS - geminiDayTokens),
    userHourRemaining: id === null ? 0 : Math.max(0, PER_USER_HOURLY_TOKENS - hourUsed),
    userDayRemaining: id === null ? 0 : Math.max(0, PER_USER_DAILY_TOKENS - dayUsed),
    trackedUsers: geminiUserSpend.size,
    limits: {
      perUserHourly: PER_USER_HOURLY_TOKENS,
      perUserDaily: PER_USER_DAILY_TOKENS,
      globalDaily: GLOBAL_DAILY_TOKENS,
    },
    // Say it out loud everywhere the numbers are read: this is process-local.
    inMemory: true,
  };
}

// Tests only. Production code must never reset a spending counter.
function __resetGeminiSpend() {
  geminiUserSpend.clear();
  geminiDayKey = todayKey();
  geminiDayTokens = 0;
}

module.exports = {
  checkUserRateLimit,
  refundTurn,
  getUsedToday,
  nextUtcMidnightISO,
  PREMIUM_DAILY_LIMIT,
  FREE_DAILY_LIMIT,
  USER_PER_MIN_LIMIT,
  // The spend ledger
  estimateGeminiTokens,
  allowGeminiCall,
  settleGeminiCall,
  geminiSpendStatus,
  __resetGeminiSpend,
  PER_USER_HOURLY_TOKENS,
  PER_USER_DAILY_TOKENS,
  GLOBAL_DAILY_TOKENS,
  OUTPUT_RESERVE_TOKENS,
  CHARS_PER_TOKEN,
};
