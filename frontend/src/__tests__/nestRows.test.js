/**
 * NEEDS YOU (lib/nestAsks.js nestRows, components/nest/NestRows.js).
 *
 * Every open loop on the Nest is its own row that closes in one tap: in
 * nestAsks()'s order (owe, budget, vote), then invites, then nights to rate.
 * What the hero card already asks is left out. Three rows show and the rest
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
import { nestAsks, nestRows } from '../lib/nestAsks';
import NestRows, { NEST_ROW_LEAVE_MS } from '../components/nest/NestRows';

const plan = (id, extra = {}) => ({ id, name: `Plan ${id}`, status: 'voting', venue: 'TBD', ...extra });

describe('nestRows', () => {
  test('asks in their order, then invites, then nights to rate', () => {
    const asks = nestAsks([plan(1, { iOwe: true }), plan(2, { iBudgetOpen: true })], [plan(3)]);
    const rows = nestRows({
      asks,
      invites: [plan(4, { host: 'Leo' })],
      howWasIt: [plan(5, { status: 'confirmed', askHowItWas: true, venue: 'Juniper Bowl' })],
    });
    expect(rows.map((r) => r.kind)).toEqual(['owe', 'budget', 'vote', 'invite', 'how']);
    expect(rows.map((r) => r.title)).toEqual([
      'Pay your share for Plan 1',
      'Add your budget for Plan 2',
      'Vote on Plan 3',
      'Leo invited you to Plan 4',
      'How was Juniper Bowl?',
    ]);
  });

  test('what the hero and its night already ask is left out', () => {
    const asks = nestAsks([plan(1, { iOwe: true })], [plan(2), plan(3)]);
    expect(nestRows({ asks, excludeIds: [1, 3] }).map((r) => r.flockId)).toEqual([2]);
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
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(screen.getAllByRole('button', { name: /^Vote on Plan/ })).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
  });

  test('one tap closes the loop: the row calls its own target', () => {
    const list = rows(1);
    render(<NestRows rows={list} />);
    fireEvent.click(screen.getByRole('button', { name: /Vote on Plan 0/ }));
    expect(list[0].onClick).toHaveBeenCalledTimes(1);
  });

  test('the time and the place sit on one line, each unbroken, breaking at the dot', () => {
    const { container } = render(<NestRows rows={rows(1)} />);
    const spans = [...container.querySelectorAll('span')].filter((s) => s.style.whiteSpace === 'nowrap');
    expect(spans.map((s) => s.textContent)).toEqual(['Sat 7:00 PM', 'Juniper Bowl']);
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
