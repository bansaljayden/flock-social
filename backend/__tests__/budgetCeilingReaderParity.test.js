// Every reader of the budget ceiling has to ask the same question, or the
// ceiling appears and disappears depending on which screen you are on.
//
// Three readers in routes/flocks.js publish it: the list, the detail and the
// update response. They only ever publish a SETTLED ceiling, so the question
// is "was this budget settled over three people who shared an amount", asked
// of the crowd it settled over: every member row that shared an amount,
// present or not (routes/budget.js, settledSharersOf and settledCrowdHolds).
//
// It has been asked two other ways, and both were findings. First these
// readers counted bare rows while GET /api/budget/:id counted members still
// present, so after a departure one screen withheld the number and another
// published it. Then every reader counted members still present, which made
// the number vanish from every screen the moment a sharer left after the
// settle: the roster names who left, so the room learned that person had
// shared an amount rather than skipped. The number was published once and
// shown to everyone present, so withholding it protected nobody.
//
// budgetCeilingReadParity pins the VALUE each route publishes. This test
// reads the statements themselves, so a reader that goes back to counting on
// its own terms fails here even while the fixtures agree.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');

test('no ceiling reader in routes/flocks.js counts budget answers on its own terms', () => {
  const own = /COUNT\(\*\)(?:::int AS n)? FROM budget_submissions/g;
  assert.deepStrictEqual(src.match(own) || [], [],
    'a ceiling threshold written out here can drift from the one budget.js owns');
  assert.ok(!/MEMBER_SUBMISSIONS/.test(src),
    'a settled ceiling gated on members still present blinks off when a sharer leaves');
});

test('every ceiling reader in routes/flocks.js asks the settled crowd budget.js exports', () => {
  const cases = src.match(/CASE WHEN f\.budget_locked = true\s+AND \$\{settledSharersOf\('f\.id'\)\} >= 3/g) || [];
  assert.strictEqual(cases.length, 2, 'the list route and the detail route');
  assert.match(src, /await settledCrowdHolds\(\(q, p\) => pool\.query\(q, p\), flockId\)/, 'the update response');
  assert.match(src, /const \{ settledSharersOf, settledCrowdHolds \} = require\('\.\/budget'\)/,
    'and the count is the one budget.js exports, not a second copy of it');
});
