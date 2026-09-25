// ---------------------------------------------------------------------------
// TWO BUDGET ANSWERS THAT CROSS ON THE WAY BACK (lib/budgetStatus.js)
//
// The server commits a non-settling answer and then looks up who to tell; the
// settling answer can commit behind it, find its recipients first and go out
// first with the group number. The earlier answer's budget_updated then
// arrives after it with `ceiling: null`, and so can that answer's own HTTP
// reply. budgetBillIntegrity.test.js (backend, on a real Postgres) shows the
// event arriving in that order. This pins what the app does with it: the
// socket handler assigned `ceiling: data.ceiling` straight into the status,
// kept the lock flag, and the open sheet then said "The group number is not
// being shown" over a settled budget; the answer buttons spread their own
// reply over the status and could unlock it outright.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test budgetStatusMerge --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { mergeBudgetUpdate, budgetCrowdSize } = require('../lib/budgetStatus');

const open = {
  budgetEnabled: true, budgetLocked: false, ceiling: null, submissionCount: 1, totalMembers: 3,
  memberCount: 3, isReady: false, skipCount: null, userSubmitted: true, userAmount: 40, userSkipped: false,
};
// The settling answer, as the room hears it.
const settle = { flockId: 1, ceiling: 40, submissionCount: 3, totalMembers: 3, memberCount: 3, isReady: true, skipCount: null, budgetLocked: true };
// The answer before it, arriving late.
const late = { flockId: 1, ceiling: null, submissionCount: 2, totalMembers: 3, memberCount: 3, isReady: false, skipCount: null, budgetLocked: false };

describe('mergeBudgetUpdate', () => {
  test('in order, the settle sets the number', () => {
    const s = mergeBudgetUpdate(mergeBudgetUpdate(open, late), settle);
    expect(s).toMatchObject({ ceiling: 40, budgetLocked: true, submissionCount: 3, isReady: true });
  });

  test('out of order, an answer older than the settle changes nothing on screen', () => {
    const settled = mergeBudgetUpdate(open, settle);
    const after = mergeBudgetUpdate(settled, late);
    expect(after).toBe(settled);
    expect(after).toMatchObject({ ceiling: 40, budgetLocked: true, submissionCount: 3, isReady: true });
  });

  test('the late answer\'s own HTTP reply is the same message and is treated the same way', () => {
    const settled = mergeBudgetUpdate(open, settle);
    const reply = { submitted: true, userSubmitted: true, ...late };
    expect(mergeBudgetUpdate(settled, reply)).toMatchObject({ ceiling: 40, budgetLocked: true });
  });

  test('a reset is the one message that takes a settled number away, and it clears this person\'s answer', () => {
    const settled = mergeBudgetUpdate(open, settle);
    const reset = { flockId: 1, ceiling: null, submissionCount: 0, totalMembers: 3, memberCount: 3, isReady: false, skipCount: null, budgetLocked: false, reset: true };
    expect(mergeBudgetUpdate(settled, reset)).toMatchObject({
      ceiling: null, budgetLocked: false, submissionCount: 0, userSubmitted: false, userAmount: null, userSkipped: false,
    });
  });

  test('while the budget is open on both sides a null ceiling is simply no number', () => {
    expect(mergeBudgetUpdate(open, late)).toMatchObject({ ceiling: null, budgetLocked: false, submissionCount: 2 });
  });

  test('a locked message without a number does not clear the one on screen', () => {
    const settled = mergeBudgetUpdate(open, settle);
    expect(mergeBudgetUpdate(settled, { ...settle, ceiling: null })).toMatchObject({ ceiling: 40, budgetLocked: true });
  });

  test('fields a message does not carry are kept, and nothing outside the aggregate is copied in', () => {
    const noCount = { ...late };
    delete noCount.memberCount;
    const s = mergeBudgetUpdate({ ...open, memberCount: 2 }, noCount);
    expect(s.memberCount).toBe(2);
    expect(s).not.toHaveProperty('flockId');
    expect(mergeBudgetUpdate(open, null)).toBe(open);
  });
});

describe('budgetCrowdSize', () => {
  test('counts members, not the guests totalMembers includes', () => {
    expect(budgetCrowdSize({ totalMembers: 3, memberCount: 2 })).toBe(2);
  });
  test('falls back to the old reading when the server did not say', () => {
    expect(budgetCrowdSize({ totalMembers: 2 })).toBe(2);
    expect(budgetCrowdSize({ totalMembers: 2, memberCount: null })).toBe(2);
    expect(budgetCrowdSize(null)).toBe(0);
  });
});

// Both readers of an answer go through it: the socket handler in App.js and
// the answer buttons in the chat sheet. Source contracts, because App.js does
// not mount on its own.
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the budget_updated handler merges through the rule and re-reads the bill on a reset', () => {
  const app = read('App.js');
  const start = app.indexOf('const unsubBudget = onBudgetUpdated((data) => {');
  const end = app.indexOf('const unsubLocked = onBudgetLocked', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const handler = app.slice(start, end);
  expect(handler).toMatch(/return mergeBudgetUpdate\(prev, data\);/);
  expect(handler).not.toMatch(/ceiling: data\.ceiling,/);
  // A reset deletes a ghost-commit shell estimated from the old number, so the
  // bill is read again rather than left quoting it.
  expect(handler).toMatch(/if \(data\.reset\) loadMoneyState\(selectedFlockId\);/);
  expect(app).toMatch(/import \{ mergeBudgetUpdate \} from '\.\/lib\/budgetStatus';/);
});

test('the answer buttons merge their own reply through the same rule', () => {
  const chat = read('screens/ChatDetail.js');
  expect(chat).toMatch(/setBudgetStatus\(prev => \(\{ \.\.\.mergeBudgetUpdate\(prev, data\), userSubmitted: true, userAmount: amt, userSkipped: false \}\)\);/);
  expect(chat).toMatch(/setBudgetStatus\(prev => \(\{ \.\.\.mergeBudgetUpdate\(prev, data\), userSubmitted: true, userSkipped: true, userAmount: null \}\)\);/);
  expect(chat).not.toMatch(/setBudgetStatus\(prev => \(\{ \.\.\.prev, \.\.\.data/);
});
