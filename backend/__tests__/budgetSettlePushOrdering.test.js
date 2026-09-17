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

test('every push fan-out in this file is allSettled, and each one is the push it should be', () => {
  // COUNTING WAS THE WRONG ASSERTION. This asserted there was exactly ONE
  // Promise.allSettled, which fails the moment a SECOND correct fan-out is
  // added and would still pass if somebody swapped the settle push for an
  // unrelated one. There are two now, both deliberate: the budget-settle push,
  // and the "Remind everyone" push, which stopped awaiting one Firebase
  // delivery per member in front of its own response. So each is located by
  // the push it actually sends.
  const offsets = [];
  for (let i = SRC.indexOf('Promise.allSettled'); i !== -1; i = SRC.indexOf('Promise.allSettled', i + 1)) {
    offsets.push(i);
  }
  assert.strictEqual(offsets.length, 2, 'the settle fan-out and the reminder fan-out');

  const types = offsets.map((at) => {
    const block = SRC.slice(at, at + 400);
    if (block.includes("type: 'budget_ready'")) return 'budget_ready';
    if (block.includes("type: 'budget_reminder'")) return 'budget_reminder';
    return 'unknown';
  });
  assert.ok(types.includes('budget_ready'), 'the settle push still fans out with allSettled');
  assert.ok(types.includes('budget_reminder'), 'the reminder push fans out with allSettled too');
  assert.ok(!types.includes('unknown'), 'no unidentified fan-out crept into this file');
});

test('the reminder pushes run after its response, not in front of the button', () => {
  // It used to `await pushAlways(...)` once per outstanding member, serially,
  // with res.json below the loop: roughly four DB round trips plus one FCM
  // call each, and firebaseService caps a single send at eight seconds.
  const iResponse = SRC.indexOf('reminded: missingResult.rows.length');
  const iFanOut = SRC.indexOf("type: 'budget_reminder'");
  assert.ok(iResponse > -1 && iFanOut > -1, 'both markers are present');
  assert.ok(iFanOut > iResponse, 'the reminder fans out after the response has gone');
  assert.ok(/if \(!res\.headersSent\) res\.status\(500\)/.test(SRC),
    'and the catch cannot answer a response that has already been sent');
});

test('the fan-out runs AFTER res.json, so a delivery failure cannot unwind a settled budget', () => {
  // The fan-out lives in pushBudgetSet, a helper defined above the route and
  // shared with the guest door (routes/guest.js POST /:token/budget), so the
  // order that matters is the CALL order inside the submit handler: the
  // response goes, then the helper is awaited. The helper itself carries the
  // concurrent fan-out and its own catch.
  const iRoute = SRC.indexOf("router.post('/:flockId/submit'");
  const iCatch = SRC.indexOf('Budget submit error');
  assert.ok(iRoute > -1 && iCatch > iRoute, 'the submit handler is where it was');
  const route = SRC.slice(iRoute, iCatch);
  const iResponse = route.indexOf('submitted: true');
  const iFanOut = route.indexOf('await pushBudgetSet(');
  assert.ok(iResponse > -1 && iFanOut > -1, 'both markers are present inside the submit handler');
  assert.ok(iFanOut > iResponse, 'the push fans out after res.json has returned the settled budget');
  const iHelper = SRC.indexOf('async function pushBudgetSet(');
  assert.ok(iHelper > -1 && iHelper < iRoute, 'the helper is defined once, above the route');
  const helper = SRC.slice(iHelper, iRoute);
  assert.ok(helper.includes('Promise.allSettled'), 'the helper fans out concurrently');
  assert.ok(helper.includes('catch (pushErr)'), 'and is guarded on its own');
});

test('the old sequential pre-response loop is gone and the fan-out is guarded on its own', () => {
  assert.ok(!SRC.includes('for (const m of membersResult.rows)'),
    'no sequential per-member await loop the submitter has to wait through');
  assert.ok(SRC.includes('catch (pushErr)'),
    'the fan-out has its own catch, so a throw after res.json cannot reach the outer 500');
});
