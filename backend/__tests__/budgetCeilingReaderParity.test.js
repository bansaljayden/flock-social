// Every reader of the budget ceiling has to ask the same question, or the
// ceiling appears and disappears depending on which screen you are on.
//
// The question is "have at least three people who are STILL MEMBERS shared
// an amount". routes/budget.js and routes/billing.js ask it through
// MEMBER_SUBMISSIONS, a join onto flock_members with status = 'accepted'.
// Three readers in routes/flocks.js asked a different question, "are there at
// least three non-skipped budget_submissions rows", which still counts a
// sharer who has since left. So after a departure GET /api/budget/:id
// withheld the ceiling while the flock list, the flock detail and the update
// response kept publishing it, and a member who joined afterwards read a
// banded ceiling derived from a cohort they were never part of.
//
// budgetCeilingReadParity cannot see this class: its pg fake answers both
// count shapes from the same number, so it pins the VALUE each route
// publishes and never the threshold each one asks. This test reads the
// statements themselves.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');

test('no ceiling reader in routes/flocks.js counts bare budget_submissions rows', () => {
  const bare = /COUNT\(\*\)(?:::int AS n)? FROM budget_submissions(?:\s+bs)?\s+WHERE/g;
  assert.deepStrictEqual(src.match(bare) || [], [],
    'a ceiling threshold that counts budget_submissions without the member join still counts people who left');
});

test('every ceiling reader in routes/flocks.js counts through MEMBER_SUBMISSIONS', () => {
  const readers = src.match(/FROM \$\{MEMBER_SUBMISSIONS\}\s+WHERE bs\.flock_id = (?:f\.id|\$1) AND bs\.skipped = false/g) || [];
  assert.strictEqual(readers.length, 3, 'the list route, the detail route and the update response');
  assert.match(src, /const \{ MEMBER_SUBMISSIONS \} = require\('\.\/budget'\)/,
    'and the join is the one budget.js exports, not a second copy of it');
});
