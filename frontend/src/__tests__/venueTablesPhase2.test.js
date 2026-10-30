/**
 * THE TABLES TAB, PHASE 2: WAITS, WHO IS COMING, TURN TIMES, AND THE SWITCH
 * THAT SHOWS THE TABLES IN THE APP.
 *
 * Phase 1 (venueTablesPanel.test.js) gave the venue dashboard a Tables tab
 * with the live board and tables in use by hour. This phase adds, from four
 * more owner-only routes on the same sensor:
 *
 *   GET .../tables/waits     { updated_at, stale, by_party: [{ party, open_now, minutes, table }] }
 *   GET .../tables/incoming  { flocks: [{ id, event_time, status, party, suggestion }] }
 *   GET .../tables/stats     { days, seatings, turn_minutes: { median, by_hour }, waited_share,
 *                              clear_minutes_median, full_hours, timeZone }
 *   GET/PUT .../tables/settings  { show_in_app, alerts }
 *
 * and `likely_free_at` on a seated or waiting table. This file pins:
 *
 *   - the five api.js calls ask the paths the server serves, and the PUT
 *     writes only the key it is given;
 *   - the waits are read on the tables' cadence, the incoming flocks once a
 *     minute, both under the tables loop's rules (never two out at once, a
 *     refusal ends the reading, the plan check's 403 is asked again); the
 *     stats once with the hours' retry; the settings once with no retry;
 *   - what the dashboard keeps after a failed read, for each;
 *   - the words of every section in every state: loading, failed, stale,
 *     unrefreshed, empty, full, and every null the stats can carry;
 *   - the board's next-free line uses the server's estimate when there is
 *     one, inside the rule phase 1 set, and says whose clock the time is on;
 *   - the waits keep "no table that fits" apart from "no estimate yet" and
 *     from "tables open, seats unknown" (open_now true, false or null);
 *   - Coming up leads every row with its day on the venue's clock (today,
 *     earlier today, yesterday, the weekday, the date from six days out),
 *     and prints an estimate only while it is ahead of the clock and on the
 *     plan's own day, else says the table should be free now, or may not be
 *     free in time, or simply fits;
 *   - the turn-time grid carries a key and a label per measured cell, reads
 *     "Busiest" and "Longest turns" from the measured cells only, and never
 *     calls UTC the venue's clock (timeZone null or 'UTC');
 *   - a tile says "N seats" from the unit's own count only, and "seats N so
 *     far" from the largest party seen (party_max), in the muted style;
 *   - the Settings Tables card is never drawn without a place id;
 *   - the sections stack in the order a manager reads them;
 *   - the turn-time grid cannot push the page wider than the screen: fluid
 *     columns down to a floor, then a scroll inside its own card;
 *   - App.js starts the three reads only while the Tables tab is on screen
 *     with tables, stops them on the way out, reads the settings when
 *     Settings opens for a venue with tables, and hands everything down;
 *   - Settings carries a Tables card: the alerts switch as before, and the
 *     show-in-app switch for every venue with tables, plan or no plan;
 *   - nothing any of it renders holds an em dash.
 *
 * MUTATIONS RUN (each made by hand, watched fail here, then reverted):
 *   1. waits cadence 10 s instead of the tables' 15 s
 *   2. the incoming loop accepting an answer without a flocks list
 *   3. nextFreePick ignoring likely_free_at
 *   4. dayHourRanges not joining a run over midnight
 *   5. VenueTablesTab drawing Coming up above Walk-in waits
 *   6. the show-in-app switch gated by the plan
 *   7. updateSensorTableSettings sending both keys on a one-key save
 *   8. an em dash in a waits row
 *   9. the stats retry never turning
 *  10. the settings read without the ownerTablesSeen gate
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false venueTablesPhase2
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, act, within, fireEvent, cleanup } from '@testing-library/react';

jest.mock('../services/api', () => ({
  getVenueBillingStatus: jest.fn(() => Promise.resolve(null)),
  startVenueCheckout: jest.fn(),
  openVenuePortal: jest.fn(),
  updateVenueProfile: jest.fn(),
  // The show-in-app switch's one write. react-scripts resets mocks between
  // tests, so each test that presses the switch gives it its answer.
  updateSensorTableSettings: jest.fn(),
  // The real one: which sentence a failed save shows is part of the contract.
  userMessage: jest.requireActual('../services/api').userMessage,
}));
jest.mock('../components/ui/BirdieBird', () => {
  const R = require('react');
  const Stub = () => null;
  const BirdNote = ({ body, action }) => R.createElement('div', null, body, action || null);
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote, WARM_BIRD: {}, BIRDIE: {} };
});
jest.mock('../components/VenueInsightCards', () => ({ __esModule: true, default: () => null, clearAdvisorCards: () => {} }));
jest.mock('../components/VenueAdvisorChat', () => ({ __esModule: true, default: () => null }));

// eslint-disable-next-line import/first
import VenueTablesTab from '../components/venue/tables/VenueTablesTab';
// eslint-disable-next-line import/first
import VenueDashboard from '../screens/VenueDashboard';
// eslint-disable-next-line import/first
import {
  TABLE_STATS_DAYS,
  TURN_GRID_KEY,
  clearedText,
  clockIn,
  clockWords,
  dayHourRanges,
  hourRangeText,
  hoursInClockOrder,
  incomingRows,
  incomingText,
  isUtcZone,
  longestTurnText,
  medianTurnText,
  nextFreeLine,
  nextFreePick,
  nextFreeText,
  seatsLine,
  suggestionText,
  tablesFrom,
  turnCellLabel,
  turnGrid,
  turnTimes,
  turnTimesFooter,
  venueZoneOf,
  waitRows,
  waitText,
  waitedShareText,
  waitsStaleLines,
} from '../lib/venueTables';
// eslint-disable-next-line import/first
import {
  TABLES_READ_EVERY_MS,
  TABLE_HOURS_RETRY_EVERY_TURNS,
  TABLE_INCOMING_READ_EVERY_MS,
  nextIncomingState,
  nextTablesState,
  nextWaitsState,
  startTableIncomingReading,
  startTableSettingsReading,
  startTableStatsReading,
  startTableWaitsReading,
  tableSettingsFrom,
  tableStatsFrom,
} from '../lib/venueTablesReading';

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const EM_DASH = String.fromCharCode(0x2014);
const SEC = 1000;
const MIN = 60 * SEC;
// Friday 23 October 2026, 7:30 PM in New York (11:30 PM UTC). Every clock
// expectation below names its zone, so the machine's own zone does not matter.
const NOW = new Date('2026-10-23T23:30:00.000Z').getTime();
const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();
const NY = 'America/New_York';

const COLORS = { navy: '#1e293b', steel: '#2d5a87', amber: '#F59E0B' };

const OPEN = { planLocked: false, refused: false };
const REFUSED = { planLocked: false, refused: true };
const planCheckFailedErr = () => Object.assign(new Error('Could not check your venue plan just now. Try again.'), {
  status: 403, code: 'UPGRADE_REQUIRED', data: { code: 'UPGRADE_REQUIRED', reason: 'ENTITLEMENT_UNAVAILABLE', retryable: true },
});

// Phase 1's room: one table in every state.
const LIVE = {
  tables: [
    { number: 4, people: 0, state: 'needs_clearing', since: ago(2 * MIN + 10 * SEC), seats: 2 },
    { number: 1, people: 0, state: 'free', since: ago(12 * MIN + 30 * SEC), seats: 4 },
    { number: 3, people: 4, state: 'waiting', since: ago(6 * MIN + 12 * SEC), seats: null },
    { number: 2, people: 2, state: 'seated', since: ago(24 * MIN + 5 * SEC), seats: 1 },
    { number: 5, people: 1, state: 'seated', since: ago(65 * SEC) },
  ],
  updated_at: ago(5 * SEC),
  stale: false,
  next_free: 2,
};

// The same room with the server's estimates on the seated and waiting
// tables: Table 2 up at 8:10 PM New York, Table 5 at 8:20, and the waiting
// Table 3 earliest of all at 7:45, which the rule must not name.
const ESTIMATED = {
  ...LIVE,
  tables: LIVE.tables.map((t) => {
    if (t.number === 2) return { ...t, likely_free_at: ahead(40 * MIN) };
    if (t.number === 5) return { ...t, likely_free_at: ahead(50 * MIN) };
    if (t.number === 3) return { ...t, likely_free_at: ahead(15 * MIN) };
    return { ...t, likely_free_at: null };
  }),
};

// One row in each state of open_now: a table open and named (true), the
// server's estimate of the next (false, with minutes), tables open but none
// known to seat the party (null, with the count of open tables the answer
// carries), and no table that fits (false, nothing named).
const WAITS = {
  updated_at: ago(5 * SEC),
  stale: false,
  by_party: [
    { party: 8, open_now: false, minutes: null, table: null },
    { party: 4, open_now: false, minutes: 12, table: 6 },
    { party: 2, open_now: true, minutes: 0, table: 1 },
    { party: 6, open_now: null, minutes: null, table: 3, open: 3 },
  ],
};
const WAIT_LINES = [
  'Party of 2: table 1 is open now',
  'Party of 4: about 12 min, table 6 next',
  'Party of 6: 3 tables open, seats unknown',
  'Party of 8: no table that fits right now',
];

// Five plans, out of time order: 6:00 PM earlier tonight in New York (the
// server's window reaches 12 hours back), 8:00 PM and 9:30 PM tonight, 8:00
// PM tomorrow, and 7:00 PM next Friday (the window's far edge, where the
// weekday alone reads as tonight). Table 4's estimate is behind the clock;
// Table 2's 7:50 PM is today's and is offered for tonight's 9:30 and for next
// Friday's plan alike, since the server bounds it by the plan's time only.
const INCOMING = {
  flocks: [
    { id: 'f2', event_time: '2026-10-24T01:30:00.000Z', status: 'active', party: 3, suggestion: { table: 2, free_now: false, likely_free_at: '2026-10-23T23:50:00.000Z' } },
    { id: 'f3', event_time: '2026-10-25T00:00:00.000Z', status: 'confirmed', party: 10, suggestion: null },
    { id: 'f4', event_time: '2026-10-30T23:00:00.000Z', status: 'active', party: 6, suggestion: { table: 2, free_now: false, likely_free_at: '2026-10-23T23:50:00.000Z' } },
    { id: 'f1', event_time: '2026-10-24T00:00:00.000Z', status: 'confirmed', party: 5, suggestion: { table: 6, free_now: true, likely_free_at: null } },
    { id: 'f0', event_time: '2026-10-23T22:00:00.000Z', status: 'confirmed', party: 4, suggestion: { table: 4, free_now: false, likely_free_at: ago(10 * MIN) } },
  ],
};
const INCOMING_LINES = [
  ['Earlier today 6:00 PM: party of 4, confirmed', 'Table 4 should be free now'],
  ['Today 8:00 PM: party of 5, confirmed', 'Table 6 is free now'],
  ['Today 9:30 PM: party of 3, considering you', 'Table 2 likely free by 7:50 PM'],
  ['Sat 8:00 PM: party of 10, confirmed', 'No table that fits yet'],
  ['Fri 10/30 7:00 PM: party of 6, considering you', 'Table 2 fits them'],
];

const STATS = {
  days: 28,
  seatings: 212,
  turn_minutes: {
    median: 52,
    by_hour: [
      { dow: 5, hour: 20, median: 65, seatings: 14 },
      { dow: 5, hour: 21, median: 58, seatings: 13 },
      { dow: 6, hour: 19, median: 49, seatings: 12 },
      // Too few seatings in the cell to say: drawn empty, column kept.
      { dow: 5, hour: 18, median: null, seatings: 2 },
      { dow: 2, hour: 12, median: 35, seatings: 4 },
    ],
  },
  waited_share: 0.12,
  clear_minutes_median: 4,
  full_hours: [
    { dow: 5, hour: 20, share: 0.8 },
    { dow: 5, hour: 21, share: 0.7 },
    { dow: 6, hour: 19, share: 0.6 },
    { dow: 6, hour: 20, share: 0.9 },
    { dow: 6, hour: 21, share: 0.9 },
    { dow: 6, hour: 22, share: 0.75 },
  ],
  timeZone: NY,
};
// What the server sends under 20 seatings: every median null, and still a
// seating count for every cell that had one, two seatings included.
const TOO_FEW = {
  days: 28,
  seatings: 7,
  turn_minutes: { median: null, by_hour: [{ dow: 2, hour: 19, median: null, seatings: 2 }, { dow: 5, hour: 20, median: null, seatings: 5 }] },
  waited_share: null,
  clear_minutes_median: null,
  full_hours: [],
  timeZone: NY,
};

const SETTINGS = { show_in_app: true, alerts: true };

const renderTab = (props = {}) => render(
  <VenueTablesTab data={LIVE} hours={null} waits={WAITS} incoming={INCOMING} stats={STATS} colors={COLORS} wellPx={50} timeZone={NY} {...props} />
);
const headings = () => screen.getAllByRole('heading').map((h) => h.textContent);
const waitLines = () => within(screen.getByRole('list', { name: 'Walk-in waits' })).getAllByRole('listitem').map((li) => li.textContent);
const incomingItems = () => within(screen.getByRole('list', { name: 'Coming up' })).getAllByRole('listitem');
const incomingLines = () => incomingItems().map((li) => [...li.querySelectorAll('p')].map((p) => p.textContent));
const paragraph = (text) => screen.getByText((_, el) => el.tagName === 'P' && el.textContent === text);
const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

// ── The clock a time is printed on ─────────────────────────────────────────

describe('the clock a time of day is printed on', () => {
  test('the venue\'s when its zone is known: "8:10 PM" in New York is "5:10 PM" in Los Angeles and "9:10 AM" in Tokyo', () => {
    const at = '2026-10-24T00:10:00.000Z';
    expect(clockIn(NY).time(at)).toBe('8:10 PM');
    expect(clockIn('America/Los_Angeles').time(at)).toBe('5:10 PM');
    expect(clockIn('Asia/Tokyo').time(at)).toBe('9:10 AM');
    expect(clockIn(NY).venue).toBe(true);
    // Midnight and noon read as 12, never 0 or 24.
    expect(clockIn(NY).time('2026-10-24T04:00:00.000Z')).toBe('12:00 AM');
    expect(clockIn(NY).time('2026-10-24T16:05:00.000Z')).toBe('12:05 PM');
    expect(clockIn(NY).time('not a time')).toBeNull();
    expect(clockIn(NY).time(null)).toBeNull();
  });

  test('no zone, or one this device cannot keep, is this device\'s clock, and says so', () => {
    for (const zone of [null, undefined, '', 42, 'Mars/Olympus_Mons']) {
      const clock = clockIn(zone);
      expect(clock.venue).toBe(false);
      // The same instant through Intl on this machine, with the thin space
      // some engines print before PM taken out.
      const expected = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(NOW).replace(/ /g, ' ');
      expect(clock.time(new Date(NOW).toISOString())).toBe(expected);
    }
    expect(clockWords(true)).toBe("your venue's clock");
    expect(clockWords(false)).toBe("this device's clock");
  });

  test('every time carries its day, judged on the same clock: today, earlier today, yesterday, the weekday, the date from six days out', () => {
    const clock = clockIn(NY);
    const DAY = 24 * 60 * MIN;
    // 8:00 PM tonight in New York, 6:00 PM earlier tonight, and 8:00 PM tomorrow.
    expect(clock.when('2026-10-24T00:00:00.000Z', NOW)).toBe('Today 8:00 PM');
    expect(clock.when('2026-10-23T22:00:00.000Z', NOW)).toBe('Earlier today 6:00 PM');
    expect(clock.when('2026-10-25T00:00:00.000Z', NOW)).toBe('Sat 8:00 PM');
    // A plan that has passed on another day: yesterday is said as that, so
    // "Thu 11:00 PM" on a Friday does not read as next Thursday's.
    expect(clock.when('2026-10-23T03:00:00.000Z', NOW)).toBe('Yesterday 11:00 PM');
    expect(clock.when(ago(3 * DAY), NOW)).toBe('Tue 7:30 PM');
    // From six full days out the weekday alone is this week's or next's, so
    // the date goes with it: next Friday, at the window's far edge, above all.
    expect(clock.when(ahead(6 * DAY), NOW)).toBe('Thu 10/29 7:30 PM');
    expect(clock.when('2026-10-30T23:00:00.000Z', NOW)).toBe('Fri 10/30 7:00 PM');
    expect(clock.when(ahead(6 * DAY - MIN), NOW)).toBe('Thu 7:29 PM');
    expect(clock.when(ahead(5 * DAY), NOW)).toBe('Wed 7:30 PM');
    // In Tokyo it is already Saturday morning at NOW, so 8:00 PM New York
    // tonight is 9:00 AM today there, and tomorrow's plan is Sunday's.
    expect(clockIn('Asia/Tokyo').when('2026-10-24T00:00:00.000Z', NOW)).toBe('Today 9:00 AM');
    expect(clockIn('Asia/Tokyo').when('2026-10-25T00:00:00.000Z', NOW)).toBe('Sun 9:00 AM');
    expect(clock.when('nope', NOW)).toBeNull();
    // With no now to judge by the weekday is always said.
    expect(clock.when('2026-10-24T00:00:00.000Z', null)).toBe('Fri 8:00 PM');
    // The day a time falls on, on this clock, as a key: tonight's two plans
    // share one, tomorrow's does not, and midnight New York is still Friday
    // in Los Angeles.
    expect(clock.day('2026-10-24T00:00:00.000Z')).toBe(clock.day(NOW));
    expect(clock.day('2026-10-24T01:30:00.000Z')).toBe(clock.day(NOW));
    expect(clock.day('2026-10-25T00:00:00.000Z')).not.toBe(clock.day(NOW));
    expect(clock.day('2026-10-24T04:00:00.000Z')).not.toBe(clock.day(NOW));
    expect(clockIn('America/Los_Angeles').day('2026-10-24T04:00:00.000Z')).toBe(clockIn('America/Los_Angeles').day(NOW));
    expect(clock.day('nope')).toBeNull();
    expect(clock.day(NaN)).toBeNull();
  });

  test('one clock per zone, built once', () => {
    expect(clockIn(NY)).toBe(clockIn(NY));
    expect(clockIn(null)).toBe(clockIn(''));
    expect(clockIn(NY)).not.toBe(clockIn('Asia/Tokyo'));
  });
});

// ── The board's next-free line, with the server's estimate ─────────────────

describe('next likely free, with the server\'s estimate', () => {
  const tables = tablesFrom(ESTIMATED);

  test('names the seated table with the soonest estimate and says when, on the venue\'s clock', () => {
    expect(nextFreePick(ESTIMATED, tables, NOW).number).toBe(2);
    expect(nextFreeText(ESTIMATED, tables, NOW, clockIn(NY))).toBe('Next likely free: Table 2 (likely free around 8:10 PM)');
    expect(nextFreeLine(ESTIMATED, tables, NOW, clockIn(NY))).toEqual({ text: 'Next likely free: Table 2 (likely free around 8:10 PM)', timed: true });
    // The estimate wins over the seated-longest order when it disagrees.
    const swapped = { ...ESTIMATED, tables: ESTIMATED.tables.map((t) => (t.number === 5 ? { ...t, likely_free_at: ahead(5 * MIN) } : t)) };
    expect(nextFreeText(swapped, tablesFrom(swapped), NOW, clockIn(NY))).toBe('Next likely free: Table 5 (likely free around 7:35 PM)');
  });

  test('the party nobody has served is never named over a served one, however soon the server thinks it will be up', () => {
    // Table 3, waiting, has the earliest estimate of all (7:45 PM).
    expect(nextFreePick(ESTIMATED, tables, NOW).number).not.toBe(3);
    expect(nextFreePick({ ...ESTIMATED, next_free: 3 }, tables, NOW).number).toBe(2);
    // With nothing seated, the waiting table with the soonest estimate is it.
    const waitingOnly = { ...ESTIMATED, tables: ESTIMATED.tables.filter((t) => t.state !== 'seated') };
    expect(nextFreeText(waitingOnly, tablesFrom(waitingOnly), NOW, clockIn(NY))).toBe('Next likely free: Table 3 (likely free around 7:45 PM)');
  });

  test('the server\'s pick settles only a tie between equal estimates', () => {
    const at = ahead(30 * MIN);
    const tied = { ...LIVE, next_free: 7, tables: [
      { number: 6, people: 2, state: 'seated', since: ago(20 * MIN), likely_free_at: at },
      { number: 7, people: 2, state: 'seated', since: ago(10 * MIN), likely_free_at: at },
      { number: 8, people: 2, state: 'seated', since: ago(50 * MIN), likely_free_at: ahead(45 * MIN) },
    ] };
    expect(nextFreePick(tied, tablesFrom(tied), NOW).number).toBe(7);
    expect(nextFreePick({ ...tied, next_free: 8 }, tablesFrom(tied), NOW).number).toBe(6);
    expect(nextFreePick({ ...tied, next_free: null }, tablesFrom(tied), NOW).number).toBe(6);
  });

  test('a table with an estimate ranks ahead of one without; without any, phase 1\'s rule and words hold', () => {
    const mixed = { ...LIVE, next_free: null, tables: [
      { number: 6, people: 2, state: 'seated', since: ago(50 * MIN) },
      { number: 7, people: 2, state: 'seated', since: ago(10 * MIN), likely_free_at: ahead(30 * MIN) },
    ] };
    expect(nextFreePick(mixed, tablesFrom(mixed), NOW).number).toBe(7);
    expect(nextFreeText(LIVE, tablesFrom(LIVE), NOW, clockIn(NY))).toBe('Next likely free: Table 2 (seated 24 min)');
    expect(nextFreeLine(LIVE, tablesFrom(LIVE), NOW).timed).toBe(false);
    // An estimate that does not parse is no estimate.
    const junk = { ...LIVE, tables: LIVE.tables.map((t) => ({ ...t, likely_free_at: 'soon' })) };
    expect(nextFreeText(junk, tablesFrom(junk), NOW)).toBe('Next likely free: Table 2 (seated 24 min)');
  });

  test('an estimate already behind the clock is left unsaid: the party is still there', () => {
    const late = { ...LIVE, tables: LIVE.tables.map((t) => (t.number === 2 ? { ...t, likely_free_at: ago(10 * MIN) } : t)) };
    expect(nextFreeText(late, tablesFrom(late), NOW, clockIn(NY))).toBe('Next likely free: Table 2 (seated 24 min)');
    // Judged at the clock the board is on: at the last reading, 8:10 was ahead.
    expect(nextFreeText(ESTIMATED, tables, NOW - 50 * MIN, clockIn(NY))).toBe('Next likely free: Table 2 (likely free around 8:10 PM)');
    expect(nextFreeText(ESTIMATED, tables, null, clockIn(NY))).toBe('Next likely free: Table 2');
  });

  test('on the board: the line, and whose clock it is on, which is said only when a time is printed', () => {
    const { unmount } = renderTab({ data: ESTIMATED });
    expect(screen.getByText('Next likely free: Table 2 (likely free around 8:10 PM)')).toBeTruthy();
    const board = screen.getByRole('heading', { name: 'Right now' }).parentElement;
    expect(within(board).getByText("Times on your venue's clock.")).toBeTruthy();
    unmount();
    renderTab({ data: ESTIMATED, timeZone: null });
    const device = clockIn(null).time(ESTIMATED.tables.find((t) => t.number === 2).likely_free_at);
    expect(screen.getByText(`Next likely free: Table 2 (likely free around ${device})`)).toBeTruthy();
    expect(within(screen.getByRole('heading', { name: 'Right now' }).parentElement).getByText("Times on this device's clock.")).toBeTruthy();
    cleanup();
    renderTab({ data: LIVE });
    expect(screen.getByText('Next likely free: Table 2 (seated 24 min)')).toBeTruthy();
    expect(within(screen.getByRole('heading', { name: 'Right now' }).parentElement).queryByText(/Times on/)).toBeNull();
  });

  test('a stopped reading keeps the estimate it had, dimmed with the rest', () => {
    renderTab({ data: { ...ESTIMATED, stale: true, updated_at: ago(4 * MIN) } });
    expect(screen.getByText('Next likely free: Table 2 (likely free around 8:10 PM)')).toBeTruthy();
    expect(screen.getByTestId('tables-live')).toHaveStyle({ opacity: '0.55' });
  });
});

// ── Walk-in waits ──────────────────────────────────────────────────────────

describe('walk-in waits', () => {
  test('one line per party size, smallest first, in the words for each state', () => {
    expect(waitRows(WAITS).map((r) => r.text)).toEqual(WAIT_LINES);
    expect(waitRows(WAITS).map((r) => r.open)).toEqual([true, false, false, false]);
    renderTab();
    expect(screen.getByRole('heading', { name: 'Walk-in waits' })).toBeTruthy();
    expect(waitLines()).toEqual(WAIT_LINES);
    expect(screen.getByRole('list', { name: 'Walk-in waits' }).querySelector('[data-party="2"]').getAttribute('data-open')).toBe('true');
  });

  test('every form the row can take, with "no table that fits" kept apart from "no estimate yet" and "seats unknown"', () => {
    // Open now: the table is named when the server sent one.
    expect(waitText({ party: 4, open_now: true, minutes: 0, table: 6 })).toBe('Party of 4: table 6 is open now');
    expect(waitText({ party: 4, open_now: true, minutes: 12, table: null })).toBe('Party of 4: a table is open now');
    // The server's estimate of the next table.
    expect(waitText({ party: 4, open_now: false, minutes: 12, table: 6 })).toBe('Party of 4: about 12 min, table 6 next');
    expect(waitText({ party: 4, open_now: false, minutes: 12, table: null })).toBe('Party of 4: about 12 min');
    expect(waitText({ party: 4, open_now: false, minutes: 0.4, table: 6 })).toBe('Party of 4: under 1 min, table 6 next');
    expect(waitText({ party: 4, open_now: false, minutes: 75, table: 6 })).toBe('Party of 4: about 1 h 15 min, table 6 next');
    // A table that fits, with no history to estimate from yet.
    expect(waitText({ party: 4, open_now: false, minutes: null, table: 6 })).toBe('Party of 4: table 6 next, no estimate yet');
    // Nothing named at all is the one case that says no table fits.
    expect(waitText({ party: 6, open_now: false, minutes: null, table: null })).toBe('Party of 6: no table that fits right now');
    expect(waitText({ party: '8', open_now: false, minutes: -3, table: null })).toBe('Party of 8: no table that fits right now');
    // Tables open, none known to seat the party: the count from the row,
    // else from beside the list, else the words alone. The lowest open
    // table the server names is not printed, since it is not known to fit.
    expect(waitText({ party: 6, open_now: null, minutes: null, table: 3, open: 3 })).toBe('Party of 6: 3 tables open, seats unknown');
    expect(waitText({ party: 6, open_now: null, minutes: null, table: 3, open: 1 })).toBe('Party of 6: 1 table open, seats unknown');
    expect(waitText({ party: 6, open_now: null, minutes: null, table: 3 }, { open: 2 })).toBe('Party of 6: 2 tables open, seats unknown');
    expect(waitText({ party: 6, open_now: null, minutes: null, table: 3 }, { open: 'many' })).toBe('Party of 6: tables open, seats unknown');
    expect(waitText({ party: 6, open_now: null, minutes: null, table: null })).toBe('Party of 6: tables open, seats unknown');
    // Through the rows: the null row is not the bold "open" row.
    expect(waitRows({ by_party: [{ party: 6, open_now: null, table: 3 }] })).toEqual([{ party: 6, open: false, text: 'Party of 6: tables open, seats unknown' }]);
    expect(waitRows({ open: 4, by_party: [{ party: 6, open_now: null, table: 3 }] })[0].text).toBe('Party of 6: 4 tables open, seats unknown');
  });

  test('rows with no usable party size are left out, and no rows at all is said', () => {
    expect(waitRows({ by_party: [{ party: 0 }, { party: 'four' }, null, { party: 4, minutes: 5 }] }).map((r) => r.party)).toEqual([4]);
    expect(waitRows({ by_party: 'x' })).toEqual([]);
    expect(waitRows(null)).toEqual([]);
    renderTab({ waits: { ...WAITS, by_party: [] } });
    expect(screen.getByText('No wait estimates yet.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Walk-in waits' })).toBeNull();
  });

  test('a skeleton while the first read is out, one line when it failed with nothing before', () => {
    const { rerender } = renderTab({ waits: undefined });
    const loading = screen.getByTestId('tables-waits-loading');
    expect(loading.className).toBe('skeleton');
    expect(loading.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Walk-in waits' })).toBeNull();
    rerender(<VenueTablesTab data={LIVE} hours={null} waits={null} incoming={INCOMING} stats={STATS} colors={COLORS} wellPx={50} timeZone={NY} />);
    expect(screen.getByRole('heading', { name: 'Walk-in waits' })).toBeTruthy();
    expect(screen.getByText("Walk-in waits couldn't load.")).toBeTruthy();
    expect(screen.queryByTestId('tables-waits-loading')).toBeNull();
  });

  test('while the readings have stopped the rows dim under the board\'s words, and the age keeps moving', () => {
    renderTab({ waits: { ...WAITS, stale: true, updated_at: ago(4 * MIN) } });
    expect(paragraph('No table readings for 4 min. Waits are from the last reading.')).toBeTruthy();
    expect(screen.getByTestId('tables-waits-live')).toHaveStyle({ opacity: '0.55' });
    expect(waitLines()).toEqual(WAIT_LINES);
    act(() => { jest.advanceTimersByTime(65 * SEC); });
    expect(paragraph('No table readings for 5 min. Waits are from the last reading.')).toBeTruthy();
    expect(waitsStaleLines(null, NOW)).toEqual({ lead: 'No recent table readings.', detail: 'Waits are from the last reading.' });
  });

  test('a refresh that failed keeps the last answer, dimmed, and says so', () => {
    renderTab({ waits: { ...WAITS, readAt: NOW - 40 * SEC, unrefreshed: true } });
    expect(paragraph("Couldn't refresh just now. Showing the last reading from under 1 min ago.")).toBeTruthy();
    expect(screen.getByTestId('tables-waits-live')).toHaveStyle({ opacity: '0.55' });
    expect(waitLines()).toEqual(WAIT_LINES);
    // Live rows are not dimmed.
    cleanup();
    renderTab();
    expect(screen.getByTestId('tables-waits-live')).toHaveStyle({ opacity: '1' });
  });
});

// ── Coming up ──────────────────────────────────────────────────────────────

describe('coming up', () => {
  test('one row per flock in time order, each led by its day: party, standing, and the table that could seat them', () => {
    renderTab();
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeTruthy();
    expect(screen.queryByText(/Coming tonight/)).toBeNull();
    expect(incomingLines()).toEqual(INCOMING_LINES);
    expect(incomingItems().map((li) => li.getAttribute('data-confirmed'))).toEqual(['true', 'true', null, 'true', null]);
    // The window, and whose clock, under the list.
    expect(screen.getByText("Plans from the last 12 hours to 7 days ahead. Times on your venue's clock.")).toBeTruthy();
    expect(screen.getByText('A flock is a group of friends planning a night out in the Flock app. Each row is a party size and a time, never who.')).toBeTruthy();
  });

  test('the words for every row and every gap in one', () => {
    const clock = clockIn(NY);
    expect(incomingText({ party: 5, event_time: '2026-10-24T00:00:00.000Z', status: 'confirmed' }, clock, NOW)).toBe('Today 8:00 PM: party of 5, confirmed');
    expect(incomingText({ party: 5, event_time: '2026-10-24T00:00:00.000Z', status: 'voting' }, clock, NOW)).toBe('Today 8:00 PM: party of 5, considering you');
    expect(incomingText({ party: 4, event_time: '2026-10-23T22:00:00.000Z', status: 'confirmed' }, clock, NOW)).toBe('Earlier today 6:00 PM: party of 4, confirmed');
    expect(incomingText({ party: 10, event_time: '2026-10-25T00:00:00.000Z', status: 'confirmed' }, clock, NOW)).toBe('Sat 8:00 PM: party of 10, confirmed');
    expect(incomingText({ party: null, event_time: '2026-10-24T00:00:00.000Z', status: 'confirmed' }, clock, NOW)).toBe('Today 8:00 PM: a flock, confirmed');
    expect(incomingText({ party: 5, event_time: null, status: 'confirmed' }, clock, NOW)).toBe('Party of 5, confirmed');
    expect(incomingText({ party: null, event_time: null, status: 'confirmed' }, clock, NOW)).toBe('A flock, confirmed');
    // A row with no time goes last; a row that is not an object is skipped;
    // the rows run in time order whatever order the server sent.
    const rows = incomingRows({ flocks: [{ id: 1, event_time: null, party: 2 }, 'x', { id: 2, event_time: '2026-10-24T00:00:00.000Z', party: 4 }] }, clock, NOW);
    expect(rows.map((r) => r.key)).toEqual(['2', '1']);
    expect(incomingRows(INCOMING, clock, NOW).map((r) => r.key)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
  });

  test('the table that could seat them: an estimate is printed only while it is ahead of the clock and on the plan\'s day', () => {
    const clock = clockIn(NY);
    const tonight = '2026-10-24T00:00:00.000Z'; // 8:00 PM
    const later = '2026-10-24T01:30:00.000Z'; // 9:30 PM
    const estimate = '2026-10-23T23:50:00.000Z'; // 7:50 PM, ahead of NOW (7:30 PM)
    expect(suggestionText({ table: 6, free_now: true, likely_free_at: null }, clock, NOW, tonight)).toBe('Table 6 is free now');
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: estimate }, clock, NOW, later)).toBe('Table 2 likely free by 7:50 PM');
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: estimate }, clock, NOW, null)).toBe('Table 2 likely free by 7:50 PM');
    // Behind the clock: the party may still be there, and "likely free by
    // 7:50" at 8:05 has been wrong for a quarter of an hour.
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: ago(10 * MIN) }, clock, NOW, later)).toBe('Table 2 should be free now');
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: ago(10 * MIN) }, clock, NOW, null)).toBe('Table 2 should be free now');
    // After the plan's time, on the same day.
    expect(suggestionText({ table: 6, free_now: false, likely_free_at: '2026-10-24T00:40:00.000Z' }, clock, NOW, tonight)).toBe('Table 6 may not be free in time (likely around 8:40 PM)');
    // After the plan's time and on another day (1:00 AM for an 11:00 PM
    // plan): the fact without a time that would read as the plan's day's.
    expect(suggestionText({ table: 6, free_now: false, likely_free_at: '2026-10-24T05:00:00.000Z' }, clock, NOW, '2026-10-24T03:00:00.000Z')).toBe('Table 6 may not be free in time');
    // A plan on another day: today's estimate says nothing about Saturday.
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: estimate }, clock, NOW, '2026-10-25T00:00:00.000Z')).toBe('Table 2 fits them');
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: ago(10 * MIN) }, clock, NOW, '2026-10-25T00:00:00.000Z')).toBe('Table 2 fits them');
    // No plan time and an estimate on another day; no estimate; no clock to
    // judge by; an estimate that does not parse.
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: '2026-10-24T05:00:00.000Z' }, clock, NOW, null)).toBe('Table 2 fits them');
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: null }, clock, NOW, tonight)).toBe('Table 2 fits them');
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: estimate }, clock, null, tonight)).toBe('Table 2 fits them');
    expect(suggestionText({ table: 2, free_now: false, likely_free_at: 'soon' }, clock, NOW, tonight)).toBe('Table 2 fits them');
    expect(suggestionText({ table: null, free_now: false, likely_free_at: null }, clock, NOW, tonight)).toBe('No table that fits yet');
    expect(suggestionText(null, clock, NOW, tonight)).toBe('No table that fits yet');
    expect(suggestionText(undefined, clock, NOW, tonight)).toBe('No table that fits yet');
  });

  test('a stale estimate goes once the clock passes it, on the tab, between two reads', () => {
    renderTab();
    expect(incomingLines()[2]).toEqual(['Today 9:30 PM: party of 3, considering you', 'Table 2 likely free by 7:50 PM']);
    act(() => { jest.advanceTimersByTime(21 * MIN); });
    expect(incomingLines()[2]).toEqual(['Today 9:30 PM: party of 3, considering you', 'Table 2 should be free now']);
  });

  test('on this device\'s clock when the dashboard has no zone, and it says so', () => {
    renderTab({ timeZone: null });
    const device = clockIn(null);
    expect(incomingLines()[1][0]).toBe(`${device.when('2026-10-24T00:00:00.000Z', NOW)}: party of 5, confirmed`);
    // The estimate is printed only when it is on the plan's day on this
    // device's clock, which depends on where the suite runs.
    const sameDay = device.day('2026-10-23T23:50:00.000Z') === device.day('2026-10-24T01:30:00.000Z');
    expect(incomingLines()[2][1]).toBe(sameDay ? `Table 2 likely free by ${device.time('2026-10-23T23:50:00.000Z')}` : 'Table 2 fits them');
    expect(screen.getByText("Plans from the last 12 hours to 7 days ahead. Times on this device's clock.")).toBeTruthy();
  });

  test('nothing is drawn while the read is out or when no flock has a plan here, and a failure is said', () => {
    const { rerender } = renderTab({ incoming: undefined });
    expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull();
    expect(document.querySelector('[data-testid="tables-incoming-loading"]')).toBeNull();
    rerender(<VenueTablesTab data={LIVE} hours={null} waits={WAITS} incoming={{ flocks: [] }} stats={STATS} colors={COLORS} wellPx={50} timeZone={NY} />);
    expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull();
    rerender(<VenueTablesTab data={LIVE} hours={null} waits={WAITS} incoming={null} stats={STATS} colors={COLORS} wellPx={50} timeZone={NY} />);
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeTruthy();
    expect(screen.getByText("Coming up couldn't load.")).toBeTruthy();
  });

  test('a refresh that failed keeps the list, dimmed, with its age', () => {
    renderTab({ incoming: { ...INCOMING, readAt: NOW - 3 * MIN, unrefreshed: true } });
    expect(paragraph("Couldn't refresh just now. Showing the last list from 3 min ago.")).toBeTruthy();
    expect(screen.getByTestId('tables-incoming-live')).toHaveStyle({ opacity: '0.55' });
    expect(incomingLines()).toHaveLength(5);
  });
});

// ── Turn times ─────────────────────────────────────────────────────────────

describe('turn times', () => {
  test('the grid: Monday first, the open hours only, medians shaded against the longest, the busiest cells marked', () => {
    const grid = turnGrid(STATS.turn_minutes.by_hour);
    // Noon to 9 PM: the long empty stretch 10 PM to 11 AM is left off, the
    // afternoon gap inside the day stays in.
    expect(grid.hours).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(grid.rows.map((r) => r.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(grid.maxMedian).toBe(65);
    expect(grid.maxSeatings).toBe(14);
    const fri = grid.rows.find((r) => r.label === 'Fri');
    const at = (row, hour) => row.cells[grid.hours.indexOf(hour)];
    expect(at(fri, 20)).toEqual({ dow: 5, hour: 20, median: 65, seatings: 14, shade: 1, busy: true });
    expect(at(fri, 21).busy).toBe(true);
    expect(at(fri, 18)).toEqual({ dow: 5, hour: 18, median: null, seatings: 2, shade: 0, busy: false });
    expect(at(fri, 12)).toBeNull();
    const sat = grid.rows.find((r) => r.label === 'Sat');
    expect(at(sat, 19).busy).toBe(true);
    const tue = grid.rows.find((r) => r.label === 'Tue');
    expect(at(tue, 12).busy).toBe(false);
    expect(at(tue, 12).shade).toBeCloseTo(35 / 65);
  });

  test('a cell under the server\'s floor keeps its column and says nothing else: never busy, never the longest, however many seatings it counts', () => {
    // The server sends a seating count for every cell and a median only
    // from 20; a cell with 40 seatings and no median is drawn empty.
    const grid = turnGrid([...STATS.turn_minutes.by_hour, { dow: 6, hour: 18, median: null, seatings: 40 }]);
    expect(grid.maxSeatings).toBe(14);
    expect(grid.maxMedian).toBe(65);
    const sat = grid.rows.find((r) => r.label === 'Sat');
    const cell = sat.cells[grid.hours.indexOf(18)];
    expect(cell).toEqual({ dow: 6, hour: 18, median: null, seatings: 40, shade: 0, busy: false });
    expect(grid.rows.flatMap((r) => r.cells.filter((c) => c && c.busy)).map((c) => `${c.dow}:${c.hour}`)).toEqual(['5:20', '5:21', '6:19']);
    expect(turnCellLabel('Sat', cell)).toBeNull();
    expect(turnCellLabel('Fri', grid.rows.find((r) => r.label === 'Fri').cells[grid.hours.indexOf(20)])).toBe('Fri 8 PM: typical turn 1 h 5 min, most seatings');
    expect(turnCellLabel('Tue', grid.rows.find((r) => r.label === 'Tue').cells[grid.hours.indexOf(12)])).toBe('Tue 12 PM: typical turn 35 min');
    expect(turnCellLabel('Fri', null)).toBeNull();
    // With no measured cell there is nothing to shade or ring, and no grid,
    // so neither "Busiest" nor "Longest turns" is said off a few seatings.
    expect(turnGrid(TOO_FEW.turn_minutes.by_hour)).toBeNull();
    expect(turnGrid([{ dow: 2, hour: 19, median: null, seatings: 1 }])).toBeNull();
    const few = turnTimes(TOO_FEW);
    expect(few.grid).toBeNull();
    expect(few.busiest).toBeNull();
    expect(few.longest).toBeNull();
    expect(few.any).toBe(false);
    expect(longestTurnText(null)).toBeNull();
  });

  test('rows the grid cannot read are skipped, and no rows is no grid', () => {
    expect(turnGrid([{ dow: 7, hour: 20, median: 5, seatings: 3 }, { dow: 5, hour: 24, median: 5, seatings: 3 }, { dow: 5, hour: 20, median: null, seatings: null }, null])).toBeNull();
    expect(turnGrid([])).toBeNull();
    expect(turnGrid('x')).toBeNull();
    expect(hoursInClockOrder(new Array(24).fill(false))).toEqual([]);
    expect(hoursInClockOrder(new Array(24).fill(true))).toEqual(Array.from({ length: 24 }, (_, h) => h));
  });

  test('hour ranges read the way a manager says them', () => {
    expect(hourRangeText(20, 22)).toBe('8 to 10 PM');
    expect(hourRangeText(11, 13)).toBe('11 AM to 1 PM');
    expect(hourRangeText(23, 26)).toBe('11 PM to 2 AM');
    expect(hourRangeText(22, 24)).toBe('10 PM to 12 AM');
    expect(hourRangeText(0, 2)).toBe('12 to 2 AM');
    expect(hourRangeText(12, 14)).toBe('12 to 2 PM');
    expect(hourRangeText(8, 20)).toBe('8 AM to 8 PM');
    expect(hourRangeText(20, 21)).toBe('8 to 9 PM');
  });

  test('day-by-hour cells become ranges, consecutive hours joined and a run over midnight kept whole', () => {
    expect(dayHourRanges(STATS.full_hours)).toBe('Fri 8 to 10 PM, Sat 7 to 11 PM');
    expect(dayHourRanges([{ dow: 5, hour: 23 }, { dow: 6, hour: 0 }, { dow: 6, hour: 1 }])).toBe('Fri 11 PM to 2 AM');
    expect(dayHourRanges([{ dow: 6, hour: 23 }, { dow: 0, hour: 0 }])).toBe('Sat 11 PM to 1 AM');
    // Two runs on one day stay two ranges; a bad cell is skipped; none is null.
    expect(dayHourRanges([{ dow: 3, hour: 12 }, { dow: 3, hour: 13 }, { dow: 3, hour: 19 }, { dow: 9, hour: 1 }])).toBe('Wed 12 to 2 PM, Wed 7 to 8 PM');
    expect(dayHourRanges([])).toBeNull();
  });

  test('every sentence, from the server\'s figures', () => {
    const t = turnTimes(STATS);
    expect(t.any).toBe(true);
    expect(t.days).toBe(28);
    expect(medianTurnText(t.median)).toBe('Half the parties stay under 52 min, half stay longer.');
    expect(t.busiest).toBe('Fri 8 to 10 PM, Sat 7 to 8 PM');
    expect(longestTurnText(t.grid)).toBe('Longest turns: Fri 8 PM, 1 h 5 min');
    expect(waitedShareText(t.waited)).toBe('Waited for a server: 12% of seatings');
    expect(waitedShareText(0.004)).toBe('Waited for a server: under 1% of seatings');
    expect(waitedShareText(0)).toBe('Waited for a server: 0% of seatings');
    expect(clearedText(t.cleared)).toBe('Cleared after: about 4 min, typically');
    expect(t.full).toBe('Fri 8 to 10 PM, Sat 7 to 11 PM');
    expect(t.timeZone).toBe(NY);
    expect(turnTimesFooter(28, NY)).toBe("Last 28 days, on your venue's clock.");
    expect(turnTimesFooter(28, null)).toBe('Last 28 days. Hours in UTC, since your listing has no time zone.');
    expect(TABLE_STATS_DAYS).toBe(28);
  });

  test('UTC is never the venue\'s clock: the server says "no zone" with null today and said it with the string before', () => {
    for (const zone of [null, undefined, '', 'UTC', 'utc', 'Etc/UTC', ' UTC ', 42]) {
      expect(turnTimes({ ...STATS, timeZone: zone }).timeZone).toBeNull();
      expect(venueZoneOf(zone)).toBeNull();
    }
    expect(turnTimes({ ...STATS, timeZone: 'Europe/London' }).timeZone).toBe('Europe/London');
    expect(venueZoneOf('Europe/London')).toBe('Europe/London');
    expect(isUtcZone('UTC')).toBe(true);
    expect(isUtcZone('Etc/UTC')).toBe(true);
    expect(isUtcZone('Europe/London')).toBe(false);
    expect(isUtcZone(null)).toBe(false);
  });

  test('nulls: each part is left out on its own, and all of them together is one line', () => {
    const partial = turnTimes({ ...STATS, waited_share: null, clear_minutes_median: null, full_hours: [] });
    expect(partial.any).toBe(true);
    expect(partial.waited).toBeNull();
    expect(partial.cleared).toBeNull();
    expect(partial.full).toBeNull();
    expect(partial.median).toBe(52);
    const none = turnTimes(TOO_FEW);
    expect(none.any).toBe(false);
    expect(turnTimes({ ...TOO_FEW, turn_minutes: { median: null, by_hour: [] } }).any).toBe(false);
    // A share outside 0 to 1, a negative median and a bad day count are not figures.
    const odd = turnTimes({ days: -3, turn_minutes: { median: -5, by_hour: null }, waited_share: 1.5, clear_minutes_median: 'x', full_hours: 'x' });
    expect(odd.any).toBe(false);
    expect(odd.days).toBe(28);
    expect(turnTimes(null)).toBeNull();
    // Full hours with a zero share are not full.
    expect(turnTimes({ ...TOO_FEW, full_hours: [{ dow: 5, hour: 20, share: 0 }] }).full).toBeNull();
  });

  test('drawn on the tab: the lines, the grid with its marks and labels, and the footer', () => {
    renderTab();
    expect(screen.getByRole('heading', { name: 'Turn times' })).toBeTruthy();
    expect(screen.getByText('Half the parties stay under 52 min, half stay longer.')).toBeTruthy();
    expect(screen.getByText('Busiest (most seatings): Fri 8 to 10 PM, Sat 7 to 8 PM')).toBeTruthy();
    expect(screen.getByText('Longest turns: Fri 8 PM, 1 h 5 min')).toBeTruthy();
    expect(screen.getByText('Waited for a server: 12% of seatings')).toBeTruthy();
    expect(screen.getByText('Cleared after: about 4 min, typically')).toBeTruthy();
    expect(screen.getByText('Usually full: Fri 8 to 10 PM, Sat 7 to 11 PM')).toBeTruthy();
    expect(screen.getByText("Last 28 days, on your venue's clock.")).toBeTruthy();
    const grid = screen.getByTestId('turn-grid');
    const rows = [...grid.querySelectorAll('[data-dow]')];
    expect(rows.map((r) => Number(r.getAttribute('data-dow')))).toEqual([1, 2, 3, 4, 5, 6, 0]);
    const fri = rows[4];
    expect([...fri.querySelectorAll('[data-hour]')].map((c) => Number(c.getAttribute('data-hour')))).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect([...grid.querySelectorAll('[data-busy="true"]')].map((c) => `${c.parentElement.getAttribute('data-dow')}:${c.getAttribute('data-hour')}`)).toEqual(['5:20', '5:21', '6:19']);
    expect(fri.querySelector('[data-hour="20"]')).toHaveStyle({ backgroundColor: COLORS.steel });
    expect(fri.querySelector('[data-hour="18"]').getAttribute('data-median')).toBeNull();
    // Ten columns, labels on every other one: noon, 2, 4, 6 and 8 PM.
    const labels = [...grid.querySelectorAll('span')].map((s) => s.textContent).filter((t) => /M$/.test(t));
    expect(labels).toEqual(['12 PM', '2 PM', '4 PM', '6 PM', '8 PM']);
    // The key, for the eye: what the blue and the ring mean, in words the
    // dark theme does not turn backwards. Hidden from a screen reader, which
    // gets the grid cell by cell instead.
    const key = screen.getByTestId('turn-grid-key');
    expect(key.textContent).toBe('A stronger blue means a longer typical turn. The amber ring marks the hours with the most seatings.');
    expect(key.textContent).toBe(TURN_GRID_KEY);
    expect(key.getAttribute('aria-hidden')).toBe('true');
    expect(key.textContent).not.toMatch(/darker/i);
    // Each measured cell says its median in words, and whether it is one of
    // the ringed ones; a cell with no median is hidden.
    expect(grid.getAttribute('aria-hidden')).toBeNull();
    expect(grid.getAttribute('role')).toBe('group');
    expect(grid.getAttribute('aria-label')).toBe('Typical turn by day and hour');
    const cell = fri.querySelector('[data-hour="20"]');
    expect(cell.getAttribute('role')).toBe('img');
    expect(cell.getAttribute('aria-label')).toBe('Fri 8 PM: typical turn 1 h 5 min, most seatings');
    expect(cell.getAttribute('title')).toBe('Fri 8 PM: typical turn 1 h 5 min, most seatings');
    expect(screen.getByRole('img', { name: 'Tue 12 PM: typical turn 35 min' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sat 7 PM: typical turn 49 min, most seatings' })).toBeTruthy();
    const empty = fri.querySelector('[data-hour="18"]');
    expect(empty.getAttribute('aria-hidden')).toBe('true');
    expect(empty.getAttribute('aria-label')).toBeNull();
    expect(empty.getAttribute('role')).toBeNull();
    expect(screen.getAllByRole('img')).toHaveLength(4);
  });

  test('a skeleton while the read is out, one line when it failed, one line with too few seatings', () => {
    const { rerender } = renderTab({ stats: undefined });
    expect(screen.getByTestId('tables-turns-loading').className).toBe('skeleton');
    expect(screen.queryByRole('heading', { name: 'Turn times' })).toBeNull();
    rerender(<VenueTablesTab data={LIVE} hours={null} waits={WAITS} incoming={INCOMING} stats={null} colors={COLORS} wellPx={50} timeZone={NY} />);
    expect(screen.getByText("Turn times couldn't load.")).toBeTruthy();
    rerender(<VenueTablesTab data={LIVE} hours={null} waits={WAITS} incoming={INCOMING} stats={TOO_FEW} colors={COLORS} wellPx={50} timeZone={NY} />);
    expect(screen.getByText('Not enough seatings yet to say.')).toBeTruthy();
    expect(screen.queryByTestId('turn-grid')).toBeNull();
    expect(screen.queryByText(/Busiest|Longest|stronger blue/)).toBeNull();
    expect(screen.queryByText(/Last 28 days/)).toBeNull();
  });

  test('hidden parts: lines with no grid, a median with every cell under the floor, and the UTC footer for null and for the old string', () => {
    const { unmount } = renderTab({ stats: { ...STATS, days: 14, turn_minutes: { median: 40, by_hour: [] }, full_hours: [] } });
    expect(screen.getByText('Half the parties stay under 40 min, half stay longer.')).toBeTruthy();
    expect(screen.queryByTestId('turn-grid')).toBeNull();
    expect(screen.queryByText(/Busiest|Longest|Usually full|stronger blue/)).toBeNull();
    expect(screen.getByText("Last 14 days, on your venue's clock.")).toBeTruthy();
    unmount();
    // Twenty-odd seatings spread thin: the server says the overall median
    // and no cell's. The median line, the full hours and the footer stand;
    // nothing is drawn or said off the cells.
    const thin = { ...STATS, turn_minutes: { median: 52, by_hour: [{ dow: 5, hour: 20, median: null, seatings: 9 }, { dow: 6, hour: 19, median: null, seatings: 8 }] } };
    const r = renderTab({ stats: thin });
    expect(screen.getByText('Half the parties stay under 52 min, half stay longer.')).toBeTruthy();
    expect(screen.queryByTestId('turn-grid')).toBeNull();
    expect(screen.queryByTestId('turn-grid-key')).toBeNull();
    expect(screen.queryByText(/Busiest|Longest/)).toBeNull();
    expect(screen.getByText('Usually full: Fri 8 to 10 PM, Sat 7 to 11 PM')).toBeTruthy();
    expect(screen.getByText("Last 28 days, on your venue's clock.")).toBeTruthy();
    r.unmount();
    for (const zone of [null, 'UTC']) {
      const u = renderTab({ stats: { ...STATS, timeZone: zone } });
      const card = screen.getByRole('heading', { name: 'Turn times' }).parentElement;
      expect(within(card).getByTestId('turn-grid')).toBeTruthy();
      expect(within(card).getByText('Last 28 days. Hours in UTC, since your listing has no time zone.')).toBeTruthy();
      expect(within(card).queryByText(/venue's clock/)).toBeNull();
      u.unmount();
    }
  });

  test('on a phone the grid shrinks to a floor and then scrolls inside its card, never the page', () => {
    renderTab();
    const grid = screen.getByTestId('turn-grid');
    expect(grid).toHaveStyle({ overflowX: 'auto' });
    // The floor: 28px of day label, then ten cells of at least 10px with 2px
    // between, so the card's own width is what gives at 320px.
    expect(grid.firstChild).toHaveStyle({ minWidth: `${28 + 2 + 10 * 12}px` });
    const cells = [...grid.querySelectorAll('[data-hour]')];
    expect(cells).toHaveLength(70);
    for (const c of cells) {
      expect(c).toHaveStyle({ minWidth: '10px', flex: '1 1 0' });
    }
    // Nothing on the tab sets a fixed width wider than the narrowest phone.
    for (const el of document.body.querySelectorAll('[style]')) {
      const w = el.style.width;
      if (/px$/.test(w)) expect(parseFloat(w)).toBeLessThanOrEqual(300);
    }
  });
});

// ── The stack ──────────────────────────────────────────────────────────────

describe('the tab is a stack of sections in the order a manager reads them', () => {
  test('tonight first, then the week', () => {
    renderTab({ hours: [{ hour: '2026-10-22T23:00:00.000Z', occupied: 3, total: 8 }] });
    expect(headings()).toEqual(['Right now', 'Walk-in waits', 'Coming up', 'Tables in use by hour', 'Turn times']);
  });

  test('while the visit\'s first read is out, every section that will come is a skeleton and none claims anything', () => {
    const { container } = renderTab({ data: undefined, hours: undefined, waits: undefined, incoming: undefined, stats: undefined });
    expect(screen.getByTestId('tables-board-loading')).toBeTruthy();
    expect(screen.getByTestId('tables-waits-loading')).toBeTruthy();
    expect(screen.getByTestId('tables-hours-loading')).toBeTruthy();
    expect(screen.getByTestId('tables-turns-loading')).toBeTruthy();
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
    expect(container.textContent.trim()).toBe('');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('after a read that failed or brought no tables, the board speaks alone for tonight: nothing is read for the rest, and the hours card keeps its own say', () => {
    for (const data of [null, { tables: [], updated_at: null, stale: false, next_free: null }]) {
      const { unmount } = renderTab({ data });
      expect(headings()).toEqual(['Right now', 'Tables in use by hour']);
      expect(screen.queryByTestId('tables-waits-loading')).toBeNull();
      expect(screen.queryByTestId('tables-turns-loading')).toBeNull();
      unmount();
    }
  });

  test('one clock for the whole tab: one timer with every section up, none without tables', () => {
    const { unmount } = renderTab();
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    renderTab({ data: { tables: [] } });
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ── No em dash ─────────────────────────────────────────────────────────────

describe('no em dash in anything the tab renders', () => {
  test('every state of every section', () => {
    const cases = [
      {},
      { data: ESTIMATED },
      { waits: { ...WAITS, stale: true, updated_at: ago(5 * MIN) } },
      { waits: { ...WAITS, readAt: NOW - MIN, unrefreshed: true }, incoming: { ...INCOMING, readAt: NOW - MIN, unrefreshed: true } },
      { waits: null, incoming: null, stats: null },
      { waits: { ...WAITS, by_party: [] }, incoming: { flocks: [] }, stats: TOO_FEW },
      { stats: { ...STATS, timeZone: null }, timeZone: null },
      { stats: { ...STATS, timeZone: 'UTC' }, data: { ...LIVE, tables: LIVE.tables.map((t) => ({ ...t, seats: null, party_max: 3 })) } },
    ];
    for (const props of cases) {
      const { container, unmount } = renderTab(props);
      expect(container.textContent.length).toBeGreaterThan(50);
      expect(container.textContent).not.toContain(EM_DASH);
      unmount();
    }
  });
});

// ── The reads ──────────────────────────────────────────────────────────────

describe('the waits loop', () => {
  test('reads at once, then on the tables\' own cadence, and hands each answer on', async () => {
    const readWaits = jest.fn(() => Promise.resolve(WAITS));
    const onData = jest.fn();
    const stop = startTableWaitsReading(readWaits, onData);
    expect(readWaits).toHaveBeenCalledTimes(1);
    await flush();
    expect(onData).toHaveBeenLastCalledWith(WAITS, OPEN);
    jest.advanceTimersByTime(TABLES_READ_EVERY_MS - 1);
    await flush();
    expect(readWaits).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(readWaits).toHaveBeenCalledTimes(2);
    expect(TABLES_READ_EVERY_MS).toBe(15 * SEC);
    stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('never two out at once; a late answer after the stop is dropped', async () => {
    let answer;
    const readWaits = jest.fn(() => new Promise((resolve) => { answer = resolve; }));
    const onData = jest.fn();
    const stop = startTableWaitsReading(readWaits, onData);
    jest.advanceTimersByTime(2 * MIN);
    await flush();
    expect(readWaits).toHaveBeenCalledTimes(1);
    stop();
    answer(WAITS);
    await flush();
    expect(onData).not.toHaveBeenCalled();
  });

  test('an answer without the list, a dropped connection or a 500 is nothing this turn and is asked again; a refusal ends it', async () => {
    const readWaits = jest.fn()
      .mockResolvedValueOnce({ waits: [] })
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { isOffline: true }))
      .mockRejectedValueOnce(planCheckFailedErr())
      .mockResolvedValueOnce(WAITS)
      .mockRejectedValue(Object.assign(new Error('No'), { status: 403 }));
    const onData = jest.fn();
    startTableWaitsReading(readWaits, onData);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(1, null, OPEN);
    for (const n of [2, 3]) {
      jest.advanceTimersByTime(15 * SEC);
      // eslint-disable-next-line no-await-in-loop
      await flush();
      expect(onData).toHaveBeenNthCalledWith(n, null, OPEN);
    }
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(4, WAITS, OPEN);
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(5, null, REFUSED);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(MIN);
    await flush();
    expect(readWaits).toHaveBeenCalledTimes(5);
  });
});

describe('the incoming loop', () => {
  test('reads at once, then once a minute, and accepts only an answer with a flocks list', async () => {
    expect(TABLE_INCOMING_READ_EVERY_MS).toBe(60 * SEC);
    const readIncoming = jest.fn()
      .mockResolvedValueOnce(INCOMING)
      .mockResolvedValueOnce({ flocks: 'x' })
      .mockResolvedValue({ flocks: [] });
    const onData = jest.fn();
    const stop = startTableIncomingReading(readIncoming, onData);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(1, INCOMING, OPEN);
    jest.advanceTimersByTime(59 * SEC);
    await flush();
    expect(readIncoming).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(2, null, OPEN);
    jest.advanceTimersByTime(60 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(3, { flocks: [] }, OPEN);
    stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([401, 403, 404])('a %i ends the reading', async (status) => {
    const readIncoming = jest.fn(() => Promise.reject(Object.assign(new Error('No'), { status })));
    const onData = jest.fn();
    startTableIncomingReading(readIncoming, onData);
    await flush();
    expect(onData).toHaveBeenCalledWith(null, REFUSED);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('what the dashboard keeps after each answer', () => {
  test('the waits and the incoming list follow the tables\' rule: shown as they came, kept marked after a failure, dropped on a refusal', () => {
    expect(nextWaitsState(undefined, WAITS, false, NOW)).toEqual({ ...WAITS, readAt: NOW });
    const kept = nextWaitsState({ ...WAITS, readAt: NOW - 15 * SEC }, null, false, NOW);
    expect(kept).toEqual({ ...WAITS, readAt: NOW - 15 * SEC, unrefreshed: true });
    expect(nextWaitsState(kept, null, false, NOW + 15 * SEC)).toBe(kept);
    expect(nextWaitsState(kept, null, true, NOW)).toBeNull();
    expect(nextWaitsState(null, null, false, NOW)).toBeNull();
    // Nothing of the wrong shape is kept: a tables answer is not a waits answer.
    expect(nextWaitsState({ ...LIVE, readAt: NOW }, null, false, NOW)).toBeNull();
    expect(nextIncomingState(undefined, INCOMING, false, NOW)).toEqual({ ...INCOMING, readAt: NOW });
    expect(nextIncomingState({ ...INCOMING, readAt: NOW - MIN }, null, false, NOW)).toEqual({ ...INCOMING, readAt: NOW - MIN, unrefreshed: true });
    expect(nextIncomingState({ ...INCOMING, readAt: NOW - MIN }, null, true, NOW)).toBeNull();
    // Phase 1's own is unchanged by sharing the rule.
    expect(nextTablesState({ readAt: NOW }, null, false, NOW)).toBeNull();
    expect(nextTablesState({ ...WAITS, readAt: NOW }, null, false, NOW)).toBeNull();
  });
});

describe('the stats read', () => {
  test('once, kept as the object with its nulls, and asked again only after every 20th turn while it has failed', async () => {
    const readStats = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Something went wrong on our end. Try again.'), { status: 500 }))
      .mockResolvedValueOnce({ nope: true })
      .mockResolvedValueOnce(TOO_FEW)
      .mockResolvedValue(STATS);
    const onStats = jest.fn();
    const reading = startTableStatsReading(readStats, onStats);
    expect(readStats).toHaveBeenCalledTimes(1);
    await flush();
    expect(onStats).toHaveBeenNthCalledWith(1, null);
    for (let i = 0; i < TABLE_HOURS_RETRY_EVERY_TURNS - 1; i += 1) reading.turn();
    expect(readStats).toHaveBeenCalledTimes(1);
    reading.turn();
    expect(readStats).toHaveBeenCalledTimes(2);
    await flush();
    expect(onStats).toHaveBeenNthCalledWith(2, null);
    for (let i = 0; i < TABLE_HOURS_RETRY_EVERY_TURNS; i += 1) reading.turn();
    await flush();
    // Too few seatings is an answer, not a failure: no more asking.
    expect(onStats).toHaveBeenNthCalledWith(3, TOO_FEW);
    for (let i = 0; i < 3 * TABLE_HOURS_RETRY_EVERY_TURNS; i += 1) reading.turn();
    await flush();
    expect(readStats).toHaveBeenCalledTimes(3);
    reading.stop();
  });

  test('a late answer after the stop is dropped, and the shapes it accepts', async () => {
    let answer;
    const reading = startTableStatsReading(() => new Promise((resolve) => { answer = resolve; }), jest.fn());
    reading.stop();
    answer(STATS);
    await flush();
    expect(tableStatsFrom(STATS)).toBe(STATS);
    expect(tableStatsFrom(TOO_FEW)).toBe(TOO_FEW);
    expect(tableStatsFrom({ seatings: 3 })).toEqual({ seatings: 3 });
    for (const bad of [null, undefined, 'x', [], {}, { hours: [] }]) expect(tableStatsFrom(bad)).toBeNull();
  });
});

describe('the settings read', () => {
  test('once, with the defaults filled in, and never again on a turn', async () => {
    const readSettings = jest.fn(() => Promise.resolve({ show_in_app: false }));
    const onSettings = jest.fn();
    const reading = startTableSettingsReading(readSettings, onSettings);
    await flush();
    expect(onSettings).toHaveBeenCalledWith({ show_in_app: false, alerts: true });
    for (let i = 0; i < 100; i += 1) reading.turn();
    await flush();
    expect(readSettings).toHaveBeenCalledTimes(1);
    reading.stop();
  });

  test('a failure is null, and after the stop nothing is handed on', async () => {
    const onSettings = jest.fn();
    const failed = startTableSettingsReading(() => Promise.reject(new Error('offline')), onSettings);
    await flush();
    expect(onSettings).toHaveBeenCalledWith(null);
    // A failure is not asked again by turns either: the next open of the tab is the retry.
    for (let i = 0; i < 100; i += 1) failed.turn();
    expect(onSettings).toHaveBeenCalledTimes(1);
    let answer;
    const late = jest.fn();
    const reading = startTableSettingsReading(() => new Promise((resolve) => { answer = resolve; }), late);
    reading.stop();
    answer(SETTINGS);
    await flush();
    expect(late).not.toHaveBeenCalled();
  });

  test('only an explicit false is off, and anything that is not the settings object is a failure', () => {
    expect(tableSettingsFrom({ show_in_app: true, alerts: true })).toEqual({ show_in_app: true, alerts: true });
    expect(tableSettingsFrom({ show_in_app: false, alerts: false })).toEqual({ show_in_app: false, alerts: false });
    expect(tableSettingsFrom({ alerts: false })).toEqual({ show_in_app: true, alerts: false });
    expect(tableSettingsFrom({ show_in_app: 'false' })).toEqual({ show_in_app: true, alerts: true });
    for (const bad of [null, undefined, 'x', [], {}, { tables: [] }]) expect(tableSettingsFrom(bad)).toBeNull();
  });
});

// ── App.js ─────────────────────────────────────────────────────────────────

describe('App.js reads the rest of the tab for the dashboard and hands it down', () => {
  const APP = read('App.js');
  const tabStart = APP.indexOf("// THE TABLES TAB'S OWN READS");
  const settingsStart = APP.indexOf('// THE TABLES SETTINGS, read once each time the Settings tab opens');
  const tabEffect = APP.slice(tabStart, settingsStart);
  const settingsEffect = APP.slice(settingsStart, APP.indexOf('// The tab a dashboard opens on is the one it was left on', settingsStart));

  test('both effects are found, so the checks below are reading something', () => {
    expect(tabStart).toBeGreaterThan(-1);
    expect(settingsStart).toBeGreaterThan(tabStart);
    expect(tabEffect).toContain('React.useEffect(');
    expect(settingsEffect).toContain('React.useEffect(');
  });

  test('the three reads run only while the Tables tab is on screen with live tables, and the plan is in their deps', () => {
    expect(APP).toContain('const ownerTablesLive = !!(ownerTables && Array.isArray(ownerTables.tables) && ownerTables.tables.length > 0);');
    expect(tabEffect).toMatch(/const pid = ownerVenuePlaceId;\s*if \(!pid \|\| currentScreen !== 'venueDashboard' \|\| venueTab !== 'tables' \|\| !ownerTablesLive\) return undefined;/);
    expect(tabEffect).toContain('}, [ownerVenuePlaceId, currentScreen, venueTab, ownerTablesLive, venueTier]);');
    expect(tabEffect).not.toContain('setInterval');
  });

  test('the waits on their loop, the incoming on theirs, the stats once per visit with the waits\' good answers as the retry turns', () => {
    expect(tabEffect).toMatch(/const statsReading = ownerTableStatsReadFor\.current === pid \? null : startTableStatsReading\(\(\) => getSensorTableStats\(pid\), \(stats\) => \{\s*setOwnerTableStats\(stats\);\s*if \(stats\) ownerTableStatsReadFor\.current = pid;\s*\}\);/);
    expect(tabEffect).toMatch(/const stopWaits = startTableWaitsReading\(\(\) => getSensorTableWaits\(pid\), \(data, \{ refused \}\) => \{\s*setOwnerTableWaits\(\(prev\) => nextWaitsState\(prev, data, refused\)\);\s*if \(data && statsReading\) statsReading\.turn\(\);\s*if \(data\) looksReading\.turn\(\);\s*\}\);/);
    // The camera's looks: read each time the tab opens, retried on the same turns.
    expect(tabEffect).toContain('const looksReading = startTableCameraLooksReading(() => getSensorTableCameraLooks(pid), setOwnerTableCameraLooks);');
    expect(tabEffect).toMatch(/const stopIncoming = startTableIncomingReading\(\(\) => getSensorTableIncoming\(pid\), \(data, \{ refused \}\) => \{\s*setOwnerTableIncoming\(\(prev\) => nextIncomingState\(prev, data, refused\)\);\s*\}\);/);
  });

  test('leaving the tab stops all three and drops what describes this minute, keeping the month\'s stats', () => {
    expect(tabEffect).toMatch(/return \(\) => \{\s*if \(statsReading\) statsReading\.stop\(\);\s*looksReading\.stop\(\);\s*stopWaits\(\);\s*stopIncoming\(\);\s*setOwnerTableWaits\(undefined\);\s*setOwnerTableIncoming\(undefined\);\s*setOwnerTableCameraLooks\(undefined\);\s*\};/);
    expect(tabEffect).not.toContain('setOwnerTableStats(undefined)');
  });

  test('the settings are read once each time Settings opens for a venue with tables, the lock included, and a late answer is dropped', () => {
    expect(settingsEffect).toMatch(/if \(!pid \|\| currentScreen !== 'venueDashboard' \|\| venueTab !== 'settings' \|\| !ownerTablesSeen\) return undefined;/);
    expect(settingsEffect).not.toContain('ownerTablesLocked');
    expect(settingsEffect).toMatch(/const reading = startTableSettingsReading\(\(\) => getSensorTableSettings\(pid\), \(settings\) => \{\s*setOwnerTableSettings\(\(prev\) => \(settings \|\| !prev \? settings : prev\)\);\s*\}\);\s*return \(\) => reading\.stop\(\);\s*\}, \[ownerVenuePlaceId, currentScreen, venueTab, ownerTablesSeen, venueTier\]\);/);
  });

  test('a new visit, place or plan starts every read from nothing', () => {
    expect(APP).toMatch(/React\.useLayoutEffect\(\(\) => \{\s*setOwnerTables\(undefined\);\s*setOwnerTableHours\(undefined\);\s*setOwnerTableWaits\(undefined\);\s*setOwnerTableIncoming\(undefined\);\s*setOwnerTableStats\(undefined\);\s*setOwnerTableCameraLooks\(undefined\);\s*setOwnerTableSettings\(undefined\);\s*ownerTableStatsReadFor\.current = null;\s*setOwnerTablesLocked\(false\);/);
    // The stats memory is written in one place and cleared in one.
    expect(APP.match(/ownerTableStatsReadFor\.current = pid;/g)).toHaveLength(1);
    expect(APP.match(/ownerTableStatsReadFor\.current = null;/g)).toHaveLength(1);
  });

  test('everything reaches the dashboard, with the place and the one setter the show-in-app switch writes', () => {
    expect(APP).toMatch(/ownerTableCameraLooks,\s*ownerTableHours,\s*ownerTableIncoming,\s*ownerTableSettings,\s*ownerTableStats,\s*ownerTableWaits,\s*ownerTables,\s*ownerTablesLocked,\s*ownerTablesSeen,\s*ownerVenuePlaceId,\s*ownerVenueTimeZone,/);
    expect(APP).toMatch(/setOperatingHours,\s*setOwnerTableSettings,\s*setPickingVenueForCreate,/);
    expect(APP).toContain("import { forgetTables, nextIncomingState, nextTablesState, nextWaitsState, rememberTables, startTableCameraLooksReading, startTableHoursReading, startTableIncomingReading, startTableSettingsReading, startTableStatsReading, startTableWaitsReading, startTablesReading, tablesRemembered } from './lib/venueTablesReading';");
  });
});

// ── On the dashboard ───────────────────────────────────────────────────────

const DASH = read('screens', 'VenueDashboard.js');
const PARAMS = (() => {
  const s = DASH.indexOf('export default function VenueDashboard({');
  const block = DASH.slice(s, DASH.indexOf('}) {', s));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const STUB_COMPONENTS = new Set(['DialogBehavior', 'EventModal', 'MapLibreMapView', 'ModerationHiddenNotice', 'PromoModal', 'SearchInputLocal']);
const FUNCTIONS = /^(set|handle|load|open|render|retry|cancel|switch|calc|get|crowd|is|member)[A-Za-z]/;

const ROOST = {
  colors: new Proxy({}, { get: () => '#2d5a87' }),
  HOUR_BAR_WELL_PX: 50,
  venueTab: 'settings',
  venueTier: 'pro',
  venueTierKnown: true,
  venueBillingOn: true,
  venueProfile: { business_name: 'Hoppers', verification_status: 'verified', google_place_id: 'place_1' },
  venueInfo: { name: 'Hoppers', address: '', phone: '' },
  venueOnboardingData: {},
  venueListErrors: {},
  venueListLoaded: {},
  venueReviewsData: { reviews: [], stats: null },
  realIncomingFlocks: [],
  promotions: [],
  venueEventsList: [],
  operatingHours: [],
  dealDescription: '',
  dealTimeSlot: 'Happy Hour',
  dealCustomTime: '',
  ownerSensorHistory: [],
  showUpgradeModal: false,
  venuePlanPriceLabel: () => null,
  venueProfileToIntake: jest.fn(),
  ownerTablesSeen: true,
  ownerTables: LIVE,
  ownerVenuePlaceId: 'place_1',
  ownerTableSettings: SETTINGS,
};

function dashboard(overrides = {}) {
  const props = {};
  for (const name of PARAMS) {
    if (STUB_COMPONENTS.has(name)) props[name] = () => null;
    else if (FUNCTIONS.test(name)) props[name] = jest.fn();
    else props[name] = undefined;
  }
  const all = { ...props, showToast: jest.fn(), onLogout: jest.fn(), ...ROOST, ...overrides };
  return { ...render(<VenueDashboard {...all} />), props: all };
}
const settle = () => act(async () => {});
const alertsSwitch = () => screen.queryByRole('checkbox', { name: 'Table alerts' });
const showSwitch = () => screen.queryByRole('checkbox', { name: 'Show tables in the Flock app' });
const HELP = "Groups choosing a place see how many tables are open and the likely wait. Never one table's details.";

describe('the Tables card on Settings', () => {
  const { updateSensorTableSettings: updateMock } = jest.requireMock('../services/api');

  test('the dashboard takes the four reads, the place and the settings setter', () => {
    expect(PARAMS).toEqual(expect.arrayContaining(['ownerTableWaits', 'ownerTableIncoming', 'ownerTableStats', 'ownerTableSettings', 'ownerVenuePlaceId', 'setOwnerTableSettings']));
  });

  test('one card named Tables with both switches for a Roost venue, each with its name and plain help', async () => {
    const { container } = dashboard();
    await settle();
    expect(screen.getByRole('heading', { name: /Tables/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Table alerts/ })).toBeNull();
    expect(alertsSwitch().checked).toBe(true);
    expect(showSwitch().checked).toBe(true);
    expect(screen.getByText('A push when a table has waited for a server or needs clearing.')).toBeTruthy();
    expect(screen.getByText(HELP)).toBeTruthy();
    expect(container.textContent).not.toContain(EM_DASH);
  });

  test('the show-in-app switch is not plan-gated: below Roost and under the server\'s lock it is there and the alerts switch is not', async () => {
    for (const overrides of [
      { venueTier: 'free' },
      { ownerTablesLocked: true, ownerTables: null },
      { venueTierKnown: false },
    ]) {
      const r = dashboard(overrides);
      // eslint-disable-next-line no-await-in-loop
      await settle();
      expect(alertsSwitch()).toBeNull();
      expect(showSwitch()).toBeTruthy();
      expect(screen.getByText(HELP)).toBeTruthy();
      r.unmount();
    }
  });

  test('no card at all for a venue without tables', async () => {
    dashboard({ ownerTablesSeen: false, ownerTables: { tables: [], updated_at: null, stale: false, next_free: null } });
    await settle();
    expect(screen.queryByRole('heading', { name: /^Tables$/ })).toBeNull();
    expect(showSwitch()).toBeNull();
    expect(alertsSwitch()).toBeNull();
  });

  test('a skeleton while the settings read is out, one line when it failed, and the switch reads only an explicit false as off', async () => {
    const { rerender, props } = dashboard({ ownerTableSettings: undefined });
    await settle();
    expect(screen.getByTestId('tables-settings-loading').className).toBe('skeleton');
    expect(showSwitch()).toBeNull();
    rerender(<VenueDashboard {...props} ownerTableSettings={null} />);
    expect(screen.getByText("Couldn't load whether your tables show in the Flock app. Open Settings again to retry.")).toBeTruthy();
    expect(showSwitch()).toBeNull();
    rerender(<VenueDashboard {...props} ownerTableSettings={{ show_in_app: false, alerts: true }} />);
    expect(showSwitch().checked).toBe(false);
    expect(screen.queryByTestId('tables-settings-loading')).toBeNull();
  });

  test('no card at all without a place id: not a heading over nothing, whatever the plan and the settings read say', async () => {
    // The profile read failed, or has not answered yet, on a device that
    // remembers the venue's tables: the tab is in the bar, the place is
    // unknown, and the plan is unknown too (tierKnown false), so neither
    // switch could be drawn. The card used to be drawn anyway, empty.
    for (const overrides of [
      { ownerVenuePlaceId: null, venueProfile: null, venueTierKnown: false, ownerTableSettings: undefined, ownerTables: undefined },
      { ownerVenuePlaceId: null, ownerTableSettings: undefined },
      { ownerVenuePlaceId: null, ownerTableSettings: null },
      { ownerVenuePlaceId: null, ownerTableSettings: SETTINGS },
      { ownerVenuePlaceId: '', ownerTableSettings: SETTINGS },
    ]) {
      const r = dashboard(overrides);
      // eslint-disable-next-line no-await-in-loop
      await settle();
      expect(screen.queryByRole('heading', { name: /^Tables$/ })).toBeNull();
      expect(showSwitch()).toBeNull();
      expect(alertsSwitch()).toBeNull();
      expect(screen.queryByTestId('tables-settings-loading')).toBeNull();
      expect(screen.queryByText(/Couldn't load whether your tables show/)).toBeNull();
      r.unmount();
    }
    // The card comes with the place.
    dashboard({ ownerVenuePlaceId: 'place_1', ownerTableSettings: undefined });
    await settle();
    expect(screen.getByRole('heading', { name: /^Tables$/ })).toBeTruthy();
    expect(screen.getByTestId('tables-settings-loading')).toBeTruthy();
    expect(alertsSwitch()).toBeTruthy();
  });

  test('turning it off writes that one key for the place, keeps what the server answered, and says so', async () => {
    updateMock.mockResolvedValue({ show_in_app: false, alerts: true });
    const { props } = dashboard();
    await settle();
    await act(async () => { fireEvent.click(showSwitch()); });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith('place_1', { show_in_app: false });
    expect(props.setOwnerTableSettings).toHaveBeenCalledTimes(1);
    const next = props.setOwnerTableSettings.mock.calls[0][0];
    expect(next({ show_in_app: true, alerts: false })).toEqual({ show_in_app: false, alerts: true });
    expect(props.showToast).toHaveBeenCalledWith('Tables hidden in the Flock app.');
    // The alerts switch's own write is untouched.
    expect(jest.requireMock('../services/api').updateVenueProfile).not.toHaveBeenCalled();
  });

  test('turning it on writes true; an answer without the shape keeps the switch where the owner put it', async () => {
    updateMock.mockResolvedValue({ ok: true });
    const { props } = dashboard({ ownerTableSettings: { show_in_app: false, alerts: true } });
    await settle();
    expect(showSwitch().checked).toBe(false);
    await act(async () => { fireEvent.click(showSwitch()); });
    expect(updateMock).toHaveBeenCalledWith('place_1', { show_in_app: true });
    const next = props.setOwnerTableSettings.mock.calls[0][0];
    expect(next({ show_in_app: false, alerts: false })).toEqual({ show_in_app: true, alerts: false });
    expect(props.showToast).toHaveBeenCalledWith('Tables shown in the Flock app.');
  });

  test('a save that fails says so as an error and writes nothing', async () => {
    // A network failure as services/api.js builds it: its sentence is written
    // for people, so it is the one shown.
    updateMock.mockRejectedValue(Object.assign(new Error('Could not reach the server.'), { isNetworkError: true }));
    const { props } = dashboard();
    await settle();
    await act(async () => { fireEvent.click(showSwitch()); });
    expect(props.setOwnerTableSettings).not.toHaveBeenCalled();
    expect(props.showToast).toHaveBeenCalledWith('Could not reach the server.', 'error');
    // And the switch is back where the server has it.
    expect(showSwitch().checked).toBe(true);
  });

  test('the switch moves on the tap, before the save comes back', async () => {
    let answer;
    updateMock.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    dashboard();
    await settle();
    expect(showSwitch().checked).toBe(true);
    fireEvent.click(showSwitch());
    expect(showSwitch().checked).toBe(false);
    // One save at a time: a second tap while this one is out sends nothing.
    fireEvent.click(showSwitch());
    expect(updateMock).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ show_in_app: false, alerts: true }); });
  });

  test('an error not written for people gives the plain copy', async () => {
    updateMock.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'show_in_app')"));
    const { props } = dashboard();
    await settle();
    await act(async () => { fireEvent.click(showSwitch()); });
    expect(props.showToast).toHaveBeenCalledWith('Could not save that. Try again.', 'error');
  });

  test('the alerts switch keeps its wiring word for word', async () => {
    expect(DASH).toContain('checked={venueProfile?.notification_prefs?.tables !== false}');
    expect(DASH).toContain('updateVenueProfile({ notificationPrefs: { tables } })');
    expect(DASH).toContain('updateSensorTableSettings(ownerVenuePlaceId, { show_in_app })');
  });
});

describe('the Tables tab on the dashboard', () => {
  test('a Roost venue gets all five sections in order', async () => {
    dashboard({ venueTab: 'tables', ownerTableWaits: WAITS, ownerTableIncoming: INCOMING, ownerTableStats: STATS, ownerTableHours: [{ hour: '2026-10-22T23:00:00.000Z', occupied: 3, total: 8 }], ownerVenueTimeZone: NY });
    await settle();
    const names = ['Right now', 'Walk-in waits', 'Coming up', 'Tables in use by hour', 'Turn times'];
    const found = screen.getAllByRole('heading').map((h) => h.textContent).filter((t) => names.includes(t));
    expect(found).toEqual(names);
    expect(screen.getByText('Today 8:00 PM: party of 5, confirmed')).toBeTruthy();
    expect(screen.getByText('Party of 4: about 12 min, table 6 next')).toBeTruthy();
    expect(screen.getByText('Party of 6: 3 tables open, seats unknown')).toBeTruthy();
    expect(screen.getByText('Usually full: Fri 8 to 10 PM, Sat 7 to 11 PM')).toBeTruthy();
    expect(screen.getByText(TURN_GRID_KEY)).toBeTruthy();
  });

  test('a plan without Roost gets the lock and none of the words', async () => {
    const { container } = dashboard({ venueTab: 'tables', venueTier: 'free', ownerTableWaits: WAITS, ownerTableIncoming: INCOMING, ownerTableStats: STATS });
    await settle();
    expect(screen.getByRole('button', { name: 'Upgrade to Roost' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Walk-in waits|Coming up|Turn times|Party of|party of/);
  });
});

// ── The five api.js calls ──────────────────────────────────────────────────

describe('the five api.js calls', () => {
  const api = jest.requireActual('../services/api');
  const realFetch = global.fetch;
  const reply = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  beforeEach(() => { jest.useRealTimers(); });
  afterEach(() => { global.fetch = realFetch; });

  test('the stats ask for 28 days by default, under the place, with both encoded', async () => {
    global.fetch = jest.fn(() => reply(200, STATS));
    await expect(api.getSensorTableStats('ChIJ a/b')).resolves.toEqual(STATS);
    expect(String(global.fetch.mock.calls[0][0])).toMatch(/\/api\/sensors\/ChIJ%20a%2Fb\/tables\/stats\?days=28$/);
    await api.getSensorTableStats('place_1', 7);
    expect(String(global.fetch.mock.calls[1][0])).toMatch(/\/api\/sensors\/place_1\/tables\/stats\?days=7$/);
    expect(api.TABLE_STATS_DAYS).toBe(28);
  });

  test.each([
    ['getSensorTableWaits', 'waits', WAITS],
    ['getSensorTableIncoming', 'incoming', INCOMING],
    ['getSensorTableSettings', 'settings', SETTINGS],
  ])('%s asks GET .../tables/%s', async (name, tail, body) => {
    global.fetch = jest.fn(() => reply(200, body));
    await expect(api[name]('place_1')).resolves.toEqual(body);
    const [url, options] = global.fetch.mock.calls[0];
    expect(String(url)).toMatch(new RegExp(`/api/sensors/place_1/tables/${tail}$`));
    expect((options && options.method) || 'GET').toBe('GET');
  });

  test('the settings PUT writes only the keys it is given, as booleans', async () => {
    global.fetch = jest.fn(() => reply(200, { show_in_app: false, alerts: true }));
    await expect(api.updateSensorTableSettings('place_1', { show_in_app: false })).resolves.toEqual({ show_in_app: false, alerts: true });
    let [url, options] = global.fetch.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/sensors\/place_1\/tables\/settings$/);
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ show_in_app: false });
    await api.updateSensorTableSettings('place_1', { alerts: true, show_in_app: 'yes' });
    [url, options] = global.fetch.mock.calls[1];
    expect(JSON.parse(options.body)).toEqual({ alerts: true });
    await api.updateSensorTableSettings('place_1', { show_in_app: true, alerts: false });
    expect(JSON.parse(global.fetch.mock.calls[2][1].body)).toEqual({ show_in_app: true, alerts: false });
  });

  test('a refusal reaches the caller with its status and code, asked once', async () => {
    global.fetch = jest.fn(() => reply(403, { error: 'This feature needs a venue plan upgrade.', code: 'UPGRADE_REQUIRED', has_tables: true }));
    const err = await api.getSensorTableWaits('place_1').catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.code).toBe('UPGRADE_REQUIRED');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
