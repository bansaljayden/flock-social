// What the budget pill and the bill sheet said that was not so, from the
// budget-and-bill trace of 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a bill with no payer says so and offers no way to pay nobody', () => {
  const chat = read('screens/ChatDetail.js');
  expect(chat).toMatch(/Nobody has paid yet\. These are estimates from the group budget\./);
  expect((chat.match(/billSplit\.hasPayer !== false && billSplit\.shares\?\.find/g) || []).length).toBe(2);
  expect(chat).not.toMatch(/Paid by \{billSplit\.paidBy\?\.name \|\| 'Unknown'\}/);
});

test('settled-ness is read live, not from a snapshot that stops moving', () => {
  const chat = read('screens/ChatDetail.js');
  // WAS the three server fields behind a `??` fallback, in three places. `??`
  // only falls back on null or undefined and the route always sends all three,
  // so after the first GET they were frozen: every settle path afterwards
  // rewrites `shares` and none of them touch those counts. The header bar read
  // "1/3 settled" beside its own green icon, which used the raw `shares` test
  // and was right, while the "Everyone's settled up" toast arrived.
  expect(chat).toMatch(/const billTally = \(bill\) => \{/);
  expect(chat).toMatch(/const settled = shares\.filter\(\(sh\) => sh\.settled\)\.length;/);
  expect(chat).toMatch(/const billBar = billTally\(billSplit\);/);
  expect((chat.match(/billBar\.all/g) || []).length).toBe(3);
  expect(chat).not.toMatch(/billSplit\.fullySettled \?\? billSplit\.shares\?\.every/);
  // And a withheld total is dropped rather than printed as $undefined.
  expect(chat).toMatch(/typeof billSplit\.totalWithTip === 'number' \?/);
});

test('the bill form opens over a payerless shell, which is the state it is for', () => {
  const chat = read('screens/ChatDetail.js');
  // A ghost commit creates a real bill_splits row with paid_by NULL. Gating the
  // form on `!billSplit` therefore shut it permanently at the first commit, and
  // ghost mode defaults on for any budget flock, so whoever actually paid had
  // nowhere in the app to post the bill the sheet was asking them for.
  expect(chat).toMatch(/const billSplitIsShell = !!billSplit && billSplit\.hasPayer === false;/);
  expect(chat).toMatch(/\{showCreateBill && \(!billSplit \|\| billSplitIsShell\) && \(/);
  expect(chat).toMatch(/\{!hasBudget && !showCreateBill && \(!billSplit \|\| billSplitIsShell\) && \(/);
  // And the estimate steps aside while the real total is being typed.
  expect(chat).toMatch(/\{billSplit && !\(showCreateBill && billSplitIsShell\) && \(/);
});

test('the header pill has words for a closed budget', () => {
  expect(read('screens/ChatDetail.js')).toMatch(/Budget closed · no group number to show/);
});

test('a ghost commit re-reads the bill, the 409 speaks, and the two toasts say what happened', () => {
  const chat = read('screens/ChatDetail.js');
  expect(chat).toMatch(/await ghostCommit\(selectedFlockId\);\s*[\s\S]{0,300}?const d = await getBillSplit\(selectedFlockId\); setBillSplit\(d\.bill\);/);
  expect(chat).toMatch(/showToast\(err\?\.message \|\| 'Could not load payment links\./);
  expect(chat).toMatch(/'Nobody left to remind'/);
  expect(chat).toMatch(/Skipped\. You will not count toward the group number\./);
});

test('the reconnect catch-up re-reads the money state of the open chat', () => {
  const app = read('App.js');
  expect(app).toMatch(/const loadMoneyState = useCallback\(\(flockId\) => \{/);
  // Votes and the roster ride along since 2026-09-04: both are socket-only
  // with no replay, so a pocketed phone came back to a stale tally.
  expect(app).toMatch(/read = \(\) => \{ loadFlockMessages\(flockId, \{ keepOlder: true \}\); loadMoneyState\(flockId\); loadFlockVotes\(flockId\); refreshFlockRoster\(flockId\); \};/);
});

// ---------------------------------------------------------------------------
// The rest of the money trace, 2026-09-04. Backend source contracts read from
// here for the same reason attendanceAndReliabilityTruth reads them: the defect
// and the screen that shows it are one story.
// ---------------------------------------------------------------------------
const backend = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', f), 'utf8');

test('a first ghost commit reaches every other sheet, not just the committer', () => {
  const app = read('App.js');
  // The commit CREATES a bill_split_shares row, so mapping over the rows this
  // client already holds cannot introduce it.
  expect(app).toMatch(/const known = \(prev\.shares \|\| \[\]\)\.some\(s => String\(s\.userId\) === String\(data\.userId\)\);/);
  expect(app).toMatch(/if \(!known\) \{\s*loadMoneyState\(selectedFlockId\);/);
});

test('two people committing in the same second both get an answer', () => {
  const billing = backend('billing.js');
  // bill_splits carries UNIQUE(flock_id) and this path takes no flock row lock,
  // and the "Lock in your share?" card appears for everyone at once.
  expect(billing).toMatch(/ON CONFLICT \(flock_id\) DO UPDATE SET flock_id = EXCLUDED\.flock_id\s*\n\s*RETURNING id, paid_by/);
  expect(billing).toMatch(/if \(newBill\.rows\[0\]\.paid_by !== null && newBill\.rows\[0\]\.paid_by !== undefined\) \{/);
});

test('a settled share does not survive being asked for more money', () => {
  const billing = backend('billing.js');
  expect(billing).toMatch(/const existingAmounts = new Map\(\);/);
  expect(billing).toMatch(/existingAmounts\.set\(row\.user_id, Number\(row\.amount\)\);/);
  expect(billing).toMatch(/const owesMore = typeof paidBefore === 'number' && Number\(share\.amount\) > paidBefore \+ 0\.004;/);
  expect(billing).toMatch(/const wasSettled = existingSettled\.has\(share\.userId\) && !owesMore;/);
});

test('a closed budget cannot be reminded about', () => {
  const budget = backend('budget.js');
  expect(budget).toMatch(/SELECT creator_id, name, budget_enabled, budget_locked FROM flocks WHERE id = \$1/);
  expect(budget).toMatch(/The budget is closed, so there is nothing left to remind anyone about/);
});
