// Run: node --test  (from backend/)
//
// THE BUDGET-SETTLE PUSH RUNS AFTER THE RESPONSE, FANS OUT WITH allSettled, AND
// CANNOT 500 A BUDGET THAT HAS ALREADY SETTLED.
//
// On the settling submission, POST /api/budget/:flockId/submit sends a
// "Budget set!" push to every offline member. That push used to sit BEFORE
// res.json, in a sequential `for (const m of membersResult.rows) await
// pushIfOffline(...)` loop, inside the handler's outer try with no inner guard.
// Every other push path in the app was deliberately moved after the response
// and switched to Promise.allSettled, for the reason billing.js writes out in
// full: pushIfOffline is not guaranteed to hand back a promise, so a synchronous
// throw there landed in the outer catch and answered a budget that had ALREADY
// locked in the transaction with a 500 "Failed to submit budget" that a retry
// then refuses; and a twenty-member fan-out was twenty sequential Firebase round
// trips the submitter waited on before their own response returned.
//
// This was the one path that had drifted from the pattern (a push audit found
// it on 2026-08-27), so the invariant is pinned here. If the fan-out moves back
// before the response, goes sequential again, or loses its own guard, this goes
// red. pushRestDelivery.test.js drives the equivalent bill and attendance paths
// end to end; the budget submit path is a large multi-query transaction to
// script in full, so its ordering invariant is pinned on the source shape.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'budget.js'), 'utf8');

test('the settle push fans out with Promise.allSettled, once, and it is the Budget set push', () => {
  assert.strictEqual((SRC.match(/Promise\.allSettled/g) || []).length, 1,
    'the one fan-out in this file is the budget-settle push');
  const at = SRC.indexOf('Promise.allSettled');
  assert.ok(SRC.slice(at, at + 400).includes("type: 'budget_ready'"),
    'the allSettled block is the Budget set push, not some unrelated fan-out');
});

test('the fan-out runs AFTER res.json, so a delivery failure cannot unwind a settled budget', () => {
  const iResponse = SRC.indexOf('submitted: true');
  const iFanOut = SRC.indexOf('Promise.allSettled');
  const iCatch = SRC.indexOf('Budget submit error');
  assert.ok(iResponse > -1 && iFanOut > -1 && iCatch > -1, 'all three markers are present');
  assert.ok(iFanOut > iResponse, 'the push fans out after res.json has returned the settled budget');
  assert.ok(iFanOut < iCatch, 'and still inside the submit handler, not leaked into another route');
});

test('the old sequential pre-response loop is gone and the fan-out is guarded on its own', () => {
  assert.ok(!SRC.includes('for (const m of membersResult.rows)'),
    'no sequential per-member await loop the submitter has to wait through');
  assert.ok(SRC.includes('catch (pushErr)'),
    'the fan-out has its own catch, so a throw after res.json cannot reach the outer 500');
});
