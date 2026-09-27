// ---------------------------------------------------------------------------
// THE NEST ASKS FOR MORE THAN A VOTE.
//
// The card at the top of the Nest knew one thing, a missing vote. A budget the
// reader had not answered reached them only through the host's manual
// reminder, and a share of a bill only through the one push sent when the bill
// was posted, so people who owed money had nothing on Home at all. GET
// /api/flocks now says, for the reader alone, whether their budget answer is
// missing (i_budget_open) and whether they still owe on a bill (i_owe): two
// booleans, no amount (budgetBillIntegrity.test.js runs the SQL for real).
//
// What is pinned:
//   1. lib/nestAsks.js, run: what is asked, in what order, in what words.
//   2. The list read maps both flags and the card reads them from the whole
//      list, finished plans included, and opens the money sheet for them.
//   3. The flags follow the reader's own actions between two list reads, so
//      the card never asks for something already done.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test nestMoneyAsks --watchAll=false
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { nestAsks, nestAskLine, NEST_ASK_CHIP, owesOnBill } from '../lib/nestAsks';

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const CHAT = read('screens', 'ChatDetail.js');

const plan = (id, over = {}) => ({ id, name: `Plan ${id}`, status: 'confirmed', ...over });

describe('what the Nest asks for, and in what order', () => {
  test('money a friend fronted first, then the budget, then the vote', () => {
    const flocks = [
      plan(1, { iBudgetOpen: true }),
      plan(2, { iOwe: true, status: 'completed' }),
      plan(3, { status: 'voting' }),
    ];
    const asks = nestAsks(flocks, [flocks[2]]);
    expect(asks.map((a) => [a.flock.id, a.kind])).toEqual([[2, 'owe'], [1, 'budget'], [3, 'vote']]);
  });

  test('a finished plan still asks for what is owed on it, because that is when bills are posted', () => {
    expect(nestAsks([plan(4, { iOwe: true, status: 'completed' })]).map((a) => a.kind)).toEqual(['owe']);
    expect(nestAsks([plan(5, { iOwe: true, status: 'cancelled' })]).map((a) => a.kind)).toEqual(['owe']);
  });

  test('a budget is asked for only while it can still take an answer', () => {
    expect(nestAsks([plan(6, { iBudgetOpen: true, budgetLocked: true })])).toEqual([]);
    expect(nestAsks([plan(7, { iBudgetOpen: true, status: 'completed' })])).toEqual([]);
    expect(nestAsks([plan(8, { iBudgetOpen: true, status: 'cancelled' })])).toEqual([]);
    expect(nestAsks([plan(9, { iBudgetOpen: true, status: 'voting' })]).map((a) => a.kind)).toEqual(['budget']);
  });

  test('a flag the server did not send is not a flag', () => {
    // undefined is "an older server said nothing", which must keep the card
    // quiet rather than accuse anybody.
    expect(nestAsks([plan(10), plan(11, { iOwe: undefined, iBudgetOpen: undefined })])).toEqual([]);
    expect(nestAsks([plan(12, { iOwe: false, iBudgetOpen: false })])).toEqual([]);
    expect(nestAsks(null, null)).toEqual([]);
  });
});

describe('the words on the card', () => {
  test('votes alone keep the sentence they always had', () => {
    const one = nestAsks([], [plan(1, { status: 'voting' })]);
    const two = nestAsks([], [plan(1, { status: 'voting' }), plan(2, { status: 'voting' })]);
    const three = nestAsks([], [plan(1), plan(2), plan(3)]);
    expect(nestAskLine(one)).toBe('Needs your vote');
    expect(nestAskLine(two)).toBe('1 other flock needs your vote too');
    expect(nestAskLine(three)).toBe('2 other flocks need your vote too');
  });

  test('money says what is owed without a figure, and counts what else is waiting', () => {
    expect(nestAskLine(nestAsks([plan(1, { iOwe: true })]))).toBe('You still owe your share of the bill');
    expect(nestAskLine(nestAsks([plan(1, { iBudgetOpen: true })]))).toBe('Add your budget');
    expect(nestAskLine(nestAsks([plan(1, { iOwe: true }), plan(2, { iBudgetOpen: true })], [plan(3)])))
      .toBe('You still owe your share of the bill · 2 more waiting on you');
  });

  test('the chip names the ask, and no line carries an em dash or a number of dollars', () => {
    expect(NEST_ASK_CHIP).toEqual({ owe: 'Settle Up', budget: 'Budget', vote: 'Needs Votes' });
    const lines = [
      nestAskLine(nestAsks([plan(1, { iOwe: true })])),
      nestAskLine(nestAsks([plan(1, { iBudgetOpen: true })], [plan(2)])),
    ];
    for (const l of lines) {
      expect(l).not.toContain(String.fromCharCode(0x2014));
      expect(l).not.toMatch(/\$/);
    }
  });
});

describe('whether a bill just sent leaves the reader owing', () => {
  const bill = (over = {}) => ({
    hasPayer: true,
    quarantined: false,
    paidBy: { id: 9, name: 'Ava' },
    shares: [{ userId: 9, settled: true }, { userId: 2, settled: false }],
    ...over,
  });

  test('a share owed to somebody else is owed', () => {
    expect(owesOnBill(bill(), 2)).toBe(true);
    expect(owesOnBill(bill(), '2')).toBe(true);
  });

  test('the payer, a settled share, no share, a payerless shell and a quarantined bill owe nothing', () => {
    expect(owesOnBill(bill(), 9)).toBe(false);
    expect(owesOnBill(bill({ shares: [{ userId: 2, settled: true }] }), 2)).toBe(false);
    expect(owesOnBill(bill(), 5)).toBe(false);
    expect(owesOnBill(bill({ hasPayer: false, paidBy: null }), 2)).toBe(false);
    expect(owesOnBill(bill({ quarantined: true }), 2)).toBe(false);
    expect(owesOnBill(null, 2)).toBe(false);
    expect(owesOnBill(bill(), null)).toBe(false);
  });
});

describe('App.js reads the flags, and the card uses them', () => {
  test('the list read maps both flags, undefined when the server says nothing', () => {
    expect(APP).toMatch(/iBudgetOpen: typeof f\.i_budget_open === 'boolean' \? f\.i_budget_open : undefined,/);
    expect(APP).toMatch(/iOwe: typeof f\.i_owe === 'boolean' \? f\.i_owe : undefined,/);
  });

  test('the card is built from the whole list and the vote asks, and money opens the money sheet', () => {
    const at = APP.indexOf('const HomeScreen = () => {');
    const home = APP.slice(at, at + 40000);
    // The vote half is untouched, so nestCardTruth's lift still runs it.
    expect(home).toMatch(/const needsAction = liveFlocks\.filter\(f => f\.status === 'voting' && !f\.timePassed && needsMyVote\(f\)\);/);
    expect(home).toMatch(/const asks = nestAsks\(flocks, needsAction\);/);
    expect(home).toMatch(/if \(asks\.length === 0\) return null;/);
    expect(home).toMatch(/if \(top\.kind === 'vote'\) \{ setCurrentScreen\('detail'\); return; \}\s+setCurrentScreen\('chatDetail'\);\s+setShowChatPool\(true\);/);
    expect(home).toMatch(/\{nestAskLine\(asks\)\}/);
    expect(home).toMatch(/\{NEST_ASK_CHIP\[top\.kind\]\}/);
  });
});

describe('the flags follow what the reader does between two list reads', () => {
  test('answering or skipping the budget clears the ask at once', () => {
    expect(CHAT).toMatch(/setFlocks\(prev => prev\.map\(f => f\.id === selectedFlockId \? \{ \.\.\.f, iBudgetOpen: false, \.\.\.\(data\.ceiling \? \{ budgetCeiling: data\.ceiling \} : \{\}\) \} : f\)\);/);
    expect(CHAT).toMatch(/setFlocks\(prev => prev\.map\(f => f\.id === selectedFlockId \? \{ \.\.\.f, iBudgetOpen: false \} : f\)\);\s+showToast\('Skipped\./);
  });

  test('marking a share paid clears "you owe", and taking it back restores it', () => {
    expect(CHAT).toMatch(/const settled = await settleShare\(selectedFlockId\);[\s\S]{0,900}iOwe: false/);
    expect(CHAT).toMatch(/const unsettled = await unsettleShare\(selectedFlockId\);[\s\S]{0,900}iOwe: true/);
  });

  test('the socket keeps every plan honest, including the ones nobody has open', () => {
    expect(APP).toMatch(/if \(data\.bill\) setMyOwe\(data\.flockId, owesOnBill\(data\.bill, meRef\.current\?\.id\)\);/);
    expect(APP).toMatch(/const unsubSettled = onShareSettled\(\(data\) => \{\s+if \(isMe\(data\.userId\)\) setMyOwe\(data\.flockId, false\);/);
    expect(APP).toMatch(/const unsubUnsettled = onShareUnsettled\(\(data\) => \{[\s\S]{0,300}if \(isMe\(data\.userId\)\) setMyOwe\(data\.flockId, true\);/);
    // A reset deletes every answer, this reader's included.
    expect(APP).toMatch(/if \(data\.reset\) setFlocks\(prev => prev\.map\(f => f\.id === data\.flockId \? \{ \.\.\.f, budgetCeiling: null, budgetLocked: false, iBudgetOpen: true \} : f\)\);/);
  });
});
