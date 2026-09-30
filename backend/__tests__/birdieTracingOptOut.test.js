// Run: node --test  (from backend/)
//
// BIRDIE'S TRACES FOLLOW THE ACCOUNT'S "SHARE USAGE ANALYTICS" SWITCH.
//
// routes/ai.js can send each Birdie turn's token counts and latency to PostHog
// ($ai_generation, $ai_span) when POSTHOG_API_KEY is set. The account's switch
// (users.analytics_opt_out, migration 111) covers that too. Pinned here:
//   1. Without POSTHOG_API_KEY, or outside production, nothing is read and
//      tracing is off.
//   2. Configured, an account that is on is traced and one that is off is not.
//   3. A missing account or a failed read counts as off.
//   4. The chat route asks once per turn and gates both captures on the answer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { aiTracingConfigured, aiTracingAllowedFor } = require('../routes/ai').__testables;

const PROD = { NODE_ENV: 'production', POSTHOG_API_KEY: 'phc_test_key' };

function fakeDb(answer) {
  const calls = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      if (answer instanceof Error) throw answer;
      return { rows: answer === undefined ? [] : [{ analytics_opt_out: answer }] };
    },
  };
}

test('without a key, or outside production, tracing is off and nothing is read', async () => {
  assert.strictEqual(aiTracingConfigured({ NODE_ENV: 'production' }), false);
  assert.strictEqual(aiTracingConfigured({ NODE_ENV: 'test', POSTHOG_API_KEY: 'phc_test_key' }), false);
  assert.strictEqual(aiTracingConfigured({ NODE_ENV: 'development', POSTHOG_API_KEY: 'phc_test_key' }), false);
  const db = fakeDb(false);
  assert.strictEqual(await aiTracingAllowedFor(7, db, { NODE_ENV: 'production' }), false);
  assert.strictEqual(db.calls.length, 0);
});

test('configured: an account that is on is traced, one that switched it off is not', async () => {
  assert.strictEqual(aiTracingConfigured(PROD), true);
  const on = fakeDb(false);
  assert.strictEqual(await aiTracingAllowedFor(7, on, PROD), true);
  assert.deepStrictEqual(on.calls, [{ text: 'SELECT analytics_opt_out FROM users WHERE id = $1', values: [7] }]);
  const off = fakeDb(true);
  assert.strictEqual(await aiTracingAllowedFor(7, off, PROD), false);
});

test('a missing account or a failed read counts as off', async () => {
  assert.strictEqual(await aiTracingAllowedFor(7, fakeDb(undefined), PROD), false);
  assert.strictEqual(await aiTracingAllowedFor(7, fakeDb(new Error('connection terminated')), PROD), false);
});

test('the chat route asks once per turn and gates both captures on the answer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  assert.strictEqual((src.match(/await aiTracingAllowedFor\(userId\)/g) || []).length, 1);
  const generationCalls = src.match(/^\s*(if \(aiTraceAllowed\) )?captureAiGeneration\(\{/gm) || [];
  const spanCalls = src.match(/^\s*(if \(aiTraceAllowed\) )?captureAiToolSpan\(\{/gm) || [];
  assert.ok(generationCalls.length > 0 && spanCalls.length > 0);
  for (const call of [...generationCalls, ...spanCalls]) {
    assert.match(call, /if \(aiTraceAllowed\)/, `ungated capture: ${call.trim()}`);
  }
});
