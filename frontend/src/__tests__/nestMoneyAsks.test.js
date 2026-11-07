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
//      Since 2026-11-06 each ask is its own row under Needs you (nestRows),
//      where one card named the first ask and counted the rest.
//   2. The list read maps both flags and the rows read them from the whole
//      list, finished plans included, and open the money sheet for them.
//   3. The flags follow the reader's own actions between two list reads, so
//      the card never asks for something already done.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test nestMoneyAsks --watchAll=false
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { nestAsks, nestRows, NEST_ROWS_CAP, owesOnBill } from '../lib/nestAsks';

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

describe('the words on each row', () => {
  // One row per ask, worded as what to do, with no count of what else is
  // waiting: "2 more waiting on you" was a number to feel behind on, and the
  // second and third ask could not be tapped.
  const titles = (asks) => nestRows({ asks }).map((r) => r.title);

  test('each ask is its own row, in nestAsks order, verb first', () => {
    const owe = plan(1, { iOwe: true, name: 'Trivia Night' });
    const budget = plan(2, { iBudgetOpen: true, name: 'Sam\'s Birthday' });
    const vote = plan(3, { status: 'voting', name: 'Sunday Brunch' });
    expect(titles(nestAsks([owe, budget], [vote]))).toEqual([
      'Pay your share for Trivia Night',
      'Add your budget for Sam\'s Birthday',
      'Vote on Sunday Brunch',
    ]);
  });

  test('no row counts the others, and none says money in figures or with a dash', () => {
    const rows = nestRows({ asks: nestAsks([plan(1, { iOwe: true }), plan(2, { iBudgetOpen: true })], [plan(3), plan(4), plan(5)]) });
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.title).not.toMatch(/\d+ (more|other)|waiting on you/);
      expect(r.title).not.toContain(String.fromCharCode(0x2014));
      expect(r.title).not.toMatch(/\$/);
    }
    // Three show; the rest wait behind Show N more (components/nest/NestRows).
    expect(NEST_ROWS_CAP).toBe(3);
  });

  test('an ask the hero card already carries is not asked twice', () => {
    const asks = nestAsks([plan(1, { iBudgetOpen: true }), plan(2, { iOwe: true })], []);
    expect(nestRows({ asks, excludeKeys: ['budget:1'] }).map((r) => r.flockId)).toEqual([2]);
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

  test('the rows are built from the whole list and the vote asks, and money opens the money sheet', () => {
    const at = APP.indexOf('const HomeScreen = () => {');
    const home = APP.slice(at, at + 40000);
    // The vote half is untouched, so nestCardTruth's lift still runs it.
    expect(home).toMatch(/const needsAction = liveFlocks\.filter\(f => f\.status === 'voting' && !f\.timePassed && needsMyVote\(f\)\);/);
    expect(home).toMatch(/const nestAskList = nestAsks\(flocks, needsAction\);/);
    expect(home).toMatch(/const nestOpenRows = nestRows\(\{ asks: nestAskList, invites: pendingFlockInvites, howWasIt: nestRateList, excludeKeys: heroAsk \? \[`\$\{heroAsk\.kind\}:\$\{heroFlock\.id\}`\] : \[\] \}\)/);
    // An invite lands on its own card in Messages (highlightedInviteId).
    expect(home).toMatch(/onClick: r\.kind === 'invite' \? \(\) => \{ setHighlightedInviteId\(r\.flockId\); setCurrentTab\('chat'\); \} : \(\) => openNestAsk\(r\.flockId, r\.kind\),/);
    expect(home).toMatch(/<NestRows rows=\{nestOpenRows\} \/>/);
    // The hero's button goes to the same places: money to the money sheet,
    // a vote and a night to rate to the plan.
    expect(home).toMatch(/const openNestAsk = \(flockId, kind\) => \{\s+setSelectedFlockId\(flockId\);\s+if \(kind === 'vote' \|\| kind === 'how'\) \{ setCurrentScreen\('detail'\); return; \}\s+setCurrentScreen\('chatDetail'\);\s+setShowChatPool\(true\);\s+\};/);
    expect(home).toMatch(/onAction=\{\(\) => heroAsk && openNestAsk\(heroFlock\.id, heroAsk\.kind\)\}/);
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
