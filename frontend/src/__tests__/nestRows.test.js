/**
 * NEEDS YOU (lib/nestAsks.js nestRows, components/nest/NestRows.js).
 *
 * Every open loop on the Nest is its own row that closes in one tap: invites
 * first, then nestAsks()'s order (owe, budget, vote), then nights to rate.
 * Only the ask on the hero card's button is left out. Three rows show and the rest
 * wait behind "Show N more". An invite from a host whose name did not come
 * through is "You're invited to", never "Unknown invited you". A plan whose
 * tally this session has not read is never in the vote asks, so it is never a
 * row: an unread [] is not evidence the reader has not voted.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestRows --watchAll=false
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { nestAsks, nestRows, NEST_ROWS_CAP } from '../lib/nestAsks';
import { heroAction } from '../lib/nestHero';
import NestRows, { NEST_ROW_LEAVE_MS } from '../components/nest/NestRows';
import Icons from '../components/ui/Icons';

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const HOME = APP.slice(APP.indexOf('const HomeScreen = () => {'), APP.indexOf('// The past flocks screen was declared here'));

const plan = (id, extra = {}) => ({ id, name: `Plan ${id}`, status: 'voting', venue: 'TBD', ...extra });

describe('nestRows', () => {
  test('invites first, then the asks in their order, then nights to rate', () => {
    // An invite waits on a reply to a named friend, and behind three asks it
    // went fifth, under Show 2 more, at every width (seeded run, 2026-11-06).
    const asks = nestAsks([plan(1, { iOwe: true }), plan(2, { iBudgetOpen: true })], [plan(3)]);
    const rows = nestRows({
      asks,
      invites: [plan(4, { host: 'Leo' })],
      howWasIt: [plan(5, { status: 'confirmed', askHowItWas: true, venue: 'Juniper Bowl' })],
    });
    expect(rows.map((r) => r.kind)).toEqual(['invite', 'owe', 'budget', 'vote', 'how']);
    expect(rows.map((r) => r.title)).toEqual([
      'Leo invited you to Plan 4',
      'Pay your share for Plan 1',
      'Add your budget for Plan 2',
      'Vote on Plan 3',
      'How was Juniper Bowl?',
    ]);
  });

  test('an invite is inside the three that show, whatever else is open', () => {
    const asks = nestAsks([plan(1, { iBudgetOpen: true })], [plan(2), plan(3), plan(5)]);
    const rows = nestRows({ asks, invites: [plan(4, { host: 'Leo Martin' })] });
    expect(rows.slice(0, NEST_ROWS_CAP).map((r) => r.title)).toContain('Leo invited you to Plan 4');
  });

  test('only the ask the hero\'s button carries is left out', () => {
    // The hero shows one button. Its plan's other asks, and the asks of the
    // other plans that night, are rows like any other.
    const asks = nestAsks([plan(1, { iOwe: true })], [plan(1), plan(2), plan(3)]);
    expect(nestRows({ asks, excludeKeys: ['owe:1'] }).map((r) => r.key)).toEqual(['vote:1', 'vote:2', 'vote:3']);
  });

  test('a hero with a budget and a vote open: the button asks the budget, and the vote is a row', () => {
    // Tonight's plan was voting with a budget open: the hero said Add your
    // budget, and the vote appeared nowhere on the Nest until the budget was in.
    const hero = plan(1, { iBudgetOpen: true });
    const asks = nestAsks([hero], [hero]);
    const action = heroAction(hero, asks);
    expect(action.kind).toBe('budget');
    const rows = nestRows({ asks, excludeKeys: [`${action.kind}:${hero.id}`] });
    expect(rows.map((r) => r.title)).toEqual(['Vote on Plan 1']);
  });

  test('the host is named by first name, the way a friend is', () => {
    expect(nestRows({ invites: [plan(4, { host: 'Leo Martin' })] })[0].title).toBe('Leo invited you to Plan 4');
  });

  test('an Unknown host is not named', () => {
    expect(nestRows({ invites: [plan(4, { host: 'Unknown' })] })[0].title).toBe("You're invited to Plan 4");
    expect(nestRows({ invites: [plan(4, {})] })[0].title).toBe("You're invited to Plan 4");
  });

  test('a vote this session has not read is not a row: only the asks handed in are', () => {
    // App.js hands in needsAction, which holds a plan only when its tally was
    // read, or the list read said i_voted false. A voting plan with neither
    // is not in it, so nothing here can accuse the reader of not voting.
    const unread = plan(9, { status: 'voting', votes: [] });
    expect(nestRows({ asks: nestAsks([unread], []) })).toEqual([]);
  });

  test('a night to rate needs a place to rate', () => {
    expect(nestRows({ howWasIt: [plan(5, { askHowItWas: true, venue: 'TBD' })] })).toEqual([]);
  });

  test('the line carries the time and the place as data, TBD as nothing', () => {
    const [row] = nestRows({ asks: nestAsks([], [plan(3, { eventTime: '2026-11-07T19:00:00Z', venue: 'Juniper Bowl' })]) });
    expect(row.eventTime).toBe('2026-11-07T19:00:00Z');
    expect(row.venue).toBe('Juniper Bowl');
    expect(nestRows({ asks: nestAsks([], [plan(3)]) })[0].venue).toBeNull();
  });
});

describe('the Nest builds the rows', () => {
  test('leaving out only the hero button\'s own ask, and saying the time the short way', () => {
    expect(HOME).toMatch(/const nestOpenRows = nestRows\(\{ asks: nestAskList, invites: pendingFlockInvites, howWasIt: nestRateList, excludeKeys: heroAsk \? \[`\$\{heroAsk\.kind\}:\$\{heroFlock\.id\}`\] : \[\] \}\)/);
    expect(HOME).toMatch(/when: shortWhen\(r\.eventTime, nestNow\),/);
  });

  test('an invite row lands on that invite, called out, as a push for it does', () => {
    // It named one invite ("Leo invited you to Bowling Night") and the tap
    // showed the Messages list.
    expect(HOME).toContain("onClick: r.kind === 'invite' ? () => { setHighlightedInviteId(r.flockId); setCurrentTab('chat'); } : () => openNestAsk(r.flockId, r.kind),");
    const LIST = require('fs').readFileSync(require('path').join(__dirname, '..', 'screens', 'ChatListScreen.js'), 'utf8');
    expect(LIST).toContain('const tapped = highlightedInviteId === f.id;');
  });

  test('one place per open loop: a plan with a row is not a card or a same-night row too', () => {
    // Sam's Birthday was a "Vote on" row and again a Coming up card with an
    // accent chip: six entries for four plans.
    expect(HOME).toContain("const rowPlanIds = new Set(nestOpenRows.filter((r) => r.kind !== 'invite').map((r) => r.flockId));");
    expect(HOME).toContain('const cardFlocks = restFlocks.filter((f) => !rowPlanIds.has(f.id));');
    expect(HOME).toContain('const comingList = comingGroups(cardFlocks, nestNow);');
    expect(HOME).toContain('const nestStillOpen = stillOpen(cardFlocks, nestNow)');
    expect(HOME).toContain('sameNight={heroNight.filter((f) => !rowPlanIds.has(f.id)).map((f) => ({');
    // The rows are built before the cards that read them.
    expect(HOME.indexOf('const nestOpenRows = nestRows(')).toBeLessThan(HOME.indexOf('const cardFlocks'));
  });

  test('a plan beside the hero is a state and opens the plan: its asks are Needs you rows', () => {
    // It used to carry the ask on its chip and open the money sheet, so a
    // same-night vote or money ask showed only as a chip on a row titled with
    // the plan's name.
    const at0 = HOME.indexOf('sameNight={heroNight.filter((f) => !rowPlanIds.has(f.id)).map((f) => ({');
    const block = HOME.slice(at0, HOME.indexOf('}))}', at0));
    expect(block).toMatch(/chip: planChip\(f, \{ needsVote: f\.status === 'voting' && !f\.timePassed && needsMyVote\(f\), voted: iHaveVoted\(f\) \}\),/);
    expect(block).toMatch(/onClick: \(\) => openPlan\(f\.id\),/);
    expect(block).not.toMatch(/openNestAsk|askKindFor/);
  });
});

describe('NestRows', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({
    key: `vote:${i}`, kind: 'vote', flockId: i, title: `Vote on Plan ${i}`, when: 'Sat 7:00 PM', venue: 'Juniper Bowl', onClick: jest.fn(),
  }));

  afterEach(() => { delete window.matchMedia; jest.useRealTimers(); });

  test('nothing needs the reader: nothing is drawn, not even the heading', () => {
    const { container } = render(<NestRows rows={[]} />);
    expect(container.innerHTML).toBe('');
  });

  test('three rows show and the rest wait behind Show N more, which opens in place', () => {
    const list = rows(5);
    render(<NestRows rows={list} />);
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Vote on Plan/ })).toHaveLength(3);
    const more = screen.getByRole('button', { name: 'Show 2 more' });
    fireEvent.click(more);
    expect(screen.getAllByRole('button', { name: /^Vote on Plan/ })).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
  });

  test('Show N more hands focus to the first row it revealed, never to the top of the page', () => {
    // The button unmounts itself on the tap, and focus fell to <body>; its
    // aria-expanded could only ever say false.
    render(<NestRows rows={rows(5)} />);
    const more = screen.getByRole('button', { name: 'Show 2 more' });
    expect(more).not.toHaveAttribute('aria-expanded');
    more.focus();
    fireEvent.click(more);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Vote on Plan 3/ }));
  });

  test('an open vote wears the place pin, never a ticked square', () => {
    // A check in a box is a to-do list's sign for done, on a row still open.
    const { container } = render(<NestRows rows={rows(1)} />);
    const rowPaths = [...container.querySelectorAll('[data-nest-row="vote"] svg path')].map((p) => p.getAttribute('d'));
    const pin = render(<span data-pin="">{Icons.mapPin('var(--text-secondary)', 18)}</span>).container;
    const pinPaths = [...pin.querySelectorAll('[data-pin] svg path')].map((p) => p.getAttribute('d'));
    expect(pinPaths.length).toBeGreaterThan(0);
    for (const d of pinPaths) expect(rowPaths).toContain(d);
    expect(rowPaths).not.toContain('M8 13 11 16 16 11');
    const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'nest', 'NestRows.js'), 'utf8');
    expect(SRC).toContain("vote: 'mapPin'");
  });

  test('one tap closes the loop: the row calls its own target', () => {
    const list = rows(1);
    render(<NestRows rows={list} />);
    fireEvent.click(screen.getByRole('button', { name: /Vote on Plan 0/ }));
    expect(list[0].onClick).toHaveBeenCalledTimes(1);
  });

  test('the time and the place sit on one line, each unbroken, and the dot goes with the place', () => {
    // At 320 the line broke after the dot: "Tomorrow at 7:00 PM ·" over
    // "Juniper Bowl".
    const { container } = render(<NestRows rows={rows(1)} />);
    const spans = [...container.querySelectorAll('span')].filter((s) => s.style.whiteSpace === 'nowrap');
    expect(spans.map((s) => s.textContent)).toEqual(['Sat 7:00 PM', '· Juniper Bowl']);
  });

  test('a closed loop folds away over 220 ms, then goes', () => {
    jest.useFakeTimers();
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    const list = rows(2);
    const { rerender, container } = render(<NestRows rows={list} />);
    rerender(<NestRows rows={[list[1]]} />);
    const leaving = container.querySelector('[data-nest-row][aria-hidden="true"]');
    expect(leaving).not.toBeNull();
    expect(leaving.style.gridTemplateRows).toBe('0fr');
    expect(leaving.style.opacity).toBe('0');
    expect(leaving.querySelector('button').disabled).toBe(true);
    act(() => { jest.advanceTimersByTime(NEST_ROW_LEAVE_MS + 40); });
    expect(container.querySelector('[data-nest-row][aria-hidden="true"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Vote on Plan/ })).toHaveLength(1);
  });

  test('under Reduce Motion it goes at once', () => {
    window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
    const list = rows(2);
    const { rerender, container } = render(<NestRows rows={list} />);
    rerender(<NestRows rows={[list[1]]} />);
    expect(container.querySelector('[data-nest-row][aria-hidden="true"]')).toBeNull();
  });

  test('the last loop closing takes the heading with it', () => {
    jest.useFakeTimers();
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    const { rerender, container } = render(<NestRows rows={rows(1)} />);
    rerender(<NestRows rows={[]} />);
    act(() => { jest.advanceTimersByTime(NEST_ROW_LEAVE_MS + 40); });
    expect(container.innerHTML).toBe('');
  });
});
