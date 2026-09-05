/**
 * A FAILED BIRDIE CALL DOES NOT COST A CHIRP (chat audit, 2026-09-05).
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/birdieRefund.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const usage = require('../services/birdieUsage');

test('refundTurn hands one chirp back and never goes below zero', () => {
  const u = 910000 + Math.floor(Math.random() * 1000);
  assert.strictEqual(usage.getUsedToday(u), 0);
  const first = usage.checkUserRateLimit(u, 10);
  assert.strictEqual(first.allowed, true);
  assert.strictEqual(usage.getUsedToday(u), 1);
  usage.refundTurn(u);
  assert.strictEqual(usage.getUsedToday(u), 0);
  usage.refundTurn(u);
  assert.strictEqual(usage.getUsedToday(u), 0, 'a second refund is a no-op');
  const again = usage.checkUserRateLimit(u, 10);
  assert.strictEqual(again.remaining, 9, 'the refunded chirp is spendable again');
});

test('the route charges once, marks it, and refunds on every path that delivers nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  assert.match(src, /if \(rateCheck\.allowed\) \{ res\.locals\.chirpCharged = true; res\.locals\.chirpUser = userId; \}/);
  assert.match(src, /function refundChirp\(res\) \{/);
  assert.match(src, /if \(e\?\.geminiBudget\) \{ refundChirp\(res\); return birdieRefusal\(res, e\.leg\); \}/);
  assert.match(src, /const blockReason = response\.promptFeedback\?\.blockReason/);
  assert.match(src, /candidate\?\.finishReason === 'SAFETY'/);
  assert.match(src, /text: "not something i'll help with\. ask me something else", venues: \[\], remaining: rateCheck\.remaining \+ 1/);
  assert.match(src, /if \(textParts\.length === 0 && !budgetStopped && !cutShort\) refundChirp\(res\);/);
  assert.match(src, /console\.error\('\[AI\] Chat error:', err\);\n\s+refundChirp\(res\);/);
  assert.match(src, /error: "birdie's offline right now\. try again in a bit"/);
  assert.ok(!src.includes("error: 'hold up, gimme a sec'"), 'the permanent outage no longer reads as a moment');
});
