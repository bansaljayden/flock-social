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

test('settled-ness is the server\'s answer over every share', () => {
  const chat = read('screens/ChatDetail.js');
  expect((chat.match(/billSplit\.fullySettled \?\? billSplit\.shares\?\.every\(s => s\.settled\)/g) || []).length).toBe(3);
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
