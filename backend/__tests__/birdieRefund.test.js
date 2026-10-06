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
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /if \(rateCheck\.allowed\) \{ res\.locals\.chirpCharged = true; res\.locals\.chirpUser = userId; res\.locals\.chirpDay = rateCheck\.chargeDay; \}/);
  assert.match(src, /function refundChirp\(res\) \{/);
  assert.match(src, /if \(e\?\.geminiBudget\) \{ refundChirp\(res\); return birdieRefusal\(res, e\.leg\); \}/);
  assert.match(src, /const blockReason = response\.promptFeedback\?\.blockReason/);
  // Every finish reason but STOP and MAX_TOKENS is a withheld reply, not just
  // SAFETY (birdiePromptInjection.test.js drives each one through the route).
  assert.match(src, /\|\| withheldFinishReason\(candidate\?\.finishReason\);/);
  assert.match(src, /return finishReason === 'STOP' \|\| finishReason === 'MAX_TOKENS' \? null : finishReason;/);
  assert.doesNotMatch(src, /candidate\?\.finishReason === 'SAFETY'/);
  assert.match(src, /text: "not something i'll help with\. ask me something else", venues: \[\], remaining: rateCheck\.remaining \+ 1/);
  // The empty-answer refund is for a turn that delivered NOTHING: no words,
  // no cards, no button, no staged card. And the count it reports says so.
  assert.match(src, /if \(textParts\.length === 0 && !budgetStopped && !cutShort && !deliveredSomething\) \{\n\s+refundChirp\(res\);\n\s+remaining \+= 1;/);
  assert.match(src, /const deliveredSomething = venueCards\.length > 0\n\s+\|\| Boolean\(navigationAction \|\| flockDraftAction \|\| venueVoteAction\);/);
  assert.match(src, /console\.error\('\[AI\] Chat error:', err\);\n\s+refundChirp\(res\);/);
  assert.match(src, /error: "birdie's offline right now\. try again in a bit"/);
  assert.ok(!src.includes("error: 'hold up, gimme a sec'"), 'the permanent outage no longer reads as a moment');
});
