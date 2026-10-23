/**
 * THE TABLES TAB ON THE OWNER DASHBOARD.
 *
 * A venue's Flux sensor can count people per table zone and keep a state for
 * every table. The verified owner reads it through
 * GET /api/sensors/:placeId/tables (the tables now) and
 * GET /api/sensors/:placeId/tables/hours (tables in use by hour, last 7 days),
 * and the dashboard gives it a tab of its own. This file pins what that tab
 * says and does:
 *
 *   - the tab is in the bar only once a read since the dashboard opened has
 *     returned a table, right after Analytics, and a venue with no tables
 *     never sees it; inside, the same Roost gate as Live Sensor;
 *   - Analytics keeps Live Sensor and no longer carries the board;
 *   - every state reads in words on its tile, so none rests on colour alone,
 *     and a tile names its seats when the setup knows them;
 *   - seated and waiting tiles count up in minutes and seconds off one interval
 *     for the whole board, which goes when the board goes;
 *   - only waiting and needs-clearing tables are listed as needing someone, and
 *     the one that has waited longest leads;
 *   - the server's next-free pick is named with how long it has been seated;
 *   - an offline sensor is called offline, the live part dims and its clocks
 *     stop at the last reading;
 *   - the hours chart averages each hour of the day on the viewer's own clock,
 *     draws the open hours and marks the busy stretch;
 *   - nothing the tab renders holds an em dash;
 *   - the read loop never has two reads out at once and stops cleanly, and
 *     App.js wires it, the tab's flag and the reopen rule as described;
 *   - the two api.js calls ask the paths the server serves.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false venueTablesPanel
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, act, within, fireEvent } from '@testing-library/react';

jest.mock('../services/api', () => ({
  getVenueBillingStatus: jest.fn(() => Promise.resolve(null)),
  startVenueCheckout: jest.fn(),
  openVenuePortal: jest.fn(),
}));
jest.mock('../components/ui/BirdieBird', () => {
  const R = require('react');
  const Stub = () => null;
  const BirdNote = ({ body, action }) => R.createElement('div', null, body, action || null);
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote, WARM_BIRD: {}, BIRDIE: {} };
});
// Roost's cards and its questions fetch on mount. Neither is what this file is
// about, and both sit in the Analytics body the tests below open.
jest.mock('../components/VenueInsightCards', () => ({ __esModule: true, default: () => null, clearAdvisorCards: () => {} }));
jest.mock('../components/VenueAdvisorChat', () => ({ __esModule: true, default: () => null }));

// eslint-disable-next-line import/first
import VenueTablesTab from '../components/venue/tables/VenueTablesTab';
// eslint-disable-next-line import/first
import VenueDashboard from '../screens/VenueDashboard';
// eslint-disable-next-line import/first
import {
  TABLE_STATE_WORDS,
  clockText,
  durationText,
  hourLabel,
  seatsText,
  tableHoursChart,
  tablesByLocalHour,
} from '../lib/venueTables';
// eslint-disable-next-line import/first
import { TABLES_READ_EVERY_MS, planCheckFailed, planLockedWithTables, startTablesReading } from '../lib/venueTablesReading';

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';
const SEC = 1000;
const MIN = 60 * SEC;
// 7:30 PM in New York, where this suite is run; nothing below depends on that.
const NOW = new Date('2026-10-23T23:30:00.000Z').getTime();
const ago = (ms) => new Date(NOW - ms).toISOString();

const COLORS = { navy: '#1e293b', steel: '#2d5a87', amber: '#F59E0B' };

// What the read loop hands on beside each answer.
const OPEN = { planLocked: false };
const LOCKED = { planLocked: true };
// The requirePro refusal both table routes give a plan below Roost, shaped the
// way api.js throws it (the body's code on err.code, the body on err.data).
const UPGRADE_BODY = (hasTables) => ({ error: 'This feature needs a venue plan upgrade.', code: 'UPGRADE_REQUIRED', requiredTier: 'pro', has_tables: hasTables });
const upgradeRequired = (hasTables) => Object.assign(new Error('This feature needs a venue plan upgrade.'), {
  status: 403, code: 'UPGRADE_REQUIRED', data: UPGRADE_BODY(hasTables),
});
// The gate's answer when the plan lookup itself failed (tierUnavailableRefusal
// in backend/services/venueEntitlements.js): the same code, no has_tables, and
// the two fields that say it is temporary.
const PLAN_CHECK_FAILED_BODY = { error: 'Could not check your venue plan just now. Try again.', code: 'UPGRADE_REQUIRED', reason: 'ENTITLEMENT_UNAVAILABLE', retryable: true };
const planCheckFailedErr = () => Object.assign(new Error(PLAN_CHECK_FAILED_BODY.error), {
  status: 403, code: 'UPGRADE_REQUIRED', data: PLAN_CHECK_FAILED_BODY,
});

// One table in every state, listed out of order on purpose. Seats are known
// for some tables and not for others, as the server allows.
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

// Hour rows at local wall-clock times: 7 PM three nights, 8 PM two, 11 PM one.
const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
const HOURS = [
  { hour: at(17, 19), occupied: 2, total: 8 },
  { hour: at(18, 19), occupied: 3, total: 8 },
  { hour: at(19, 19), occupied: 4, total: 8 },
  { hour: at(18, 20), occupied: 5, total: 8 },
  { hour: at(19, 20), occupied: 6, total: 8 },
  { hour: at(19, 23), occupied: 1, total: 8 },
];

const renderTab = (props = {}) => render(
  <VenueTablesTab data={LIVE} hours={null} colors={COLORS} wellPx={50} {...props} />
);
const tiles = () => within(screen.getByRole('list', { name: 'All tables' })).getAllByRole('listitem');
const tileFor = (n) => tiles().find((li) => li.querySelector('p').textContent === `Table ${n}`);
const stateWord = (tile) => tile.querySelector('[data-testid="table-state"]').textContent;
const alertLines = () => within(screen.getByRole('list', { name: 'Needs attention' }))
  .getAllByRole('listitem').map((li) => li.textContent);
// A paragraph whose whole text is `text`, across the spans inside it.
const paragraph = (text) => screen.getByText((_, el) => el.tagName === 'P' && el.textContent === text);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

describe('each tile says its table and its state in words', () => {
  test('tiles run in table-number order with the word for every state', () => {
    renderTab();
    expect(tiles().map((t) => t.querySelector('p').textContent)).toEqual(['Table 1', 'Table 2', 'Table 3', 'Table 4', 'Table 5']);
    expect(tiles().map(stateWord)).toEqual(['Free', 'Seated', 'Needs a server', 'Needs clearing', 'Seated']);
  });

  test('free and needs clearing say whole minutes; seated and waiting add the head count', () => {
    renderTab();
    expect(within(tileFor(1)).getByText('Free for 12 min')).toBeTruthy();
    expect(within(tileFor(4)).getByText('Waiting to be cleared 2 min')).toBeTruthy();
    expect(within(tileFor(2)).getByText('24:05')).toBeTruthy();
    expect(within(tileFor(2)).getByText('2 people')).toBeTruthy();
    expect(within(tileFor(3)).getByText('6:12')).toBeTruthy();
    expect(within(tileFor(3)).getByText('4 people')).toBeTruthy();
    expect(within(tileFor(5)).getByText('1 person')).toBeTruthy();
    // No head count and no running clock on a table nobody is sitting at.
    expect(tileFor(1).textContent).not.toMatch(/people|person|\d:\d\d/);
    expect(tileFor(4).textContent).not.toMatch(/people|person|\d:\d\d/);
  });

  test('a tile names its seats when the setup knows them, and says nothing when it does not', () => {
    renderTab();
    expect(within(tileFor(1)).getByText('4 seats')).toBeTruthy();
    expect(within(tileFor(4)).getByText('2 seats')).toBeTruthy();
    expect(within(tileFor(2)).getByText('1 seat')).toBeTruthy();
    // "seated 6 min" is the waiting tile's spoken clock; no seat count.
    expect(tileFor(3).textContent).not.toMatch(/\d seats?\b/);
    expect(tileFor(5).textContent).not.toMatch(/\d seats?\b/);
  });

  test('seats are optional: null, zero, a fraction or a word say nothing', () => {
    expect(seatsText(4)).toBe('4 seats');
    expect(seatsText(1)).toBe('1 seat');
    expect(seatsText('6')).toBe('6 seats');
    for (const seats of [null, undefined, 0, -2, 2.5, 'four', '']) expect(seatsText(seats)).toBeNull();
  });

  test('a screen reader hears minutes, not a clock face', () => {
    renderTab();
    const clock = within(tileFor(3)).getByText('6:12');
    expect(clock.getAttribute('aria-hidden')).toBe('true');
    expect(within(tileFor(3)).getByText('seated 6 min').className).toBe('sr-only');
    expect(within(tileFor(2)).getByText('for 24 min').className).toBe('sr-only');
  });

  test('the party nobody has stopped by for is the solid amber tile', () => {
    renderTab();
    expect(tileFor(3)).toHaveStyle({ backgroundColor: COLORS.amber });
    for (const n of [1, 2, 4, 5]) expect(tileFor(n)).not.toHaveStyle({ backgroundColor: COLORS.amber });
  });

  test('every state the server names has its own word', () => {
    expect(TABLE_STATE_WORDS).toEqual({ free: 'Free', seated: 'Seated', waiting: 'Needs a server', needs_clearing: 'Needs clearing' });
  });
});

describe('the seated clock', () => {
  test('reads minutes and seconds the way a kitchen timer does', () => {
    expect(clockText(9 * SEC)).toBe('0:09');
    expect(clockText(6 * MIN + 5 * SEC)).toBe('6:05');
    expect(clockText(75 * MIN + 2 * SEC)).toBe('75:02');
    expect(clockText(-5 * SEC)).toBe('0:00');
  });

  test('every other duration rolls up: minutes, then hours and minutes, then days', () => {
    const HOUR = 60 * MIN;
    expect(durationText(59 * SEC)).toBe('under 1 min');
    expect(durationText(12 * MIN + 59 * SEC)).toBe('12 min');
    expect(durationText(59 * MIN + 59 * SEC)).toBe('59 min');
    expect(durationText(HOUR)).toBe('1 h');
    expect(durationText(2 * HOUR + 10 * MIN)).toBe('2 h 10 min');
    expect(durationText(16 * HOUR)).toBe('16 h');
    expect(durationText(23 * HOUR + 59 * MIN)).toBe('23 h 59 min');
    expect(durationText(24 * HOUR)).toBe('1 day');
    expect(durationText(48 * HOUR + 5 * HOUR)).toBe('2 days');
    expect(durationText(-MIN)).toBe('under 1 min');
  });

  test('a table free since last night and a party at its second hour read in hours, not hundreds of minutes', () => {
    const HOUR = 60 * MIN;
    renderTab({
      data: {
        ...LIVE,
        next_free: 2,
        tables: [
          { number: 1, people: 0, state: 'free', since: ago(16 * HOUR) },
          { number: 2, people: 2, state: 'seated', since: ago(2 * HOUR + 5 * MIN) },
          { number: 3, people: 3, state: 'waiting', since: ago(HOUR + 1 * MIN) },
          { number: 4, people: 0, state: 'needs_clearing', since: ago(2 * HOUR + 30 * MIN) },
        ],
      },
    });
    expect(within(tileFor(1)).getByText('Free for 16 h')).toBeTruthy();
    expect(within(tileFor(4)).getByText('Waiting to be cleared 2 h 30 min')).toBeTruthy();
    // The seated clock is still the timer.
    expect(within(tileFor(2)).getByText('125:00')).toBeTruthy();
    expect(within(tileFor(2)).getByText('for 2 h 5 min').className).toBe('sr-only');
    expect(screen.getByText('Next likely free: Table 2 (seated 2 h 5 min)')).toBeTruthy();
    expect(alertLines()).toEqual([
      'Table 4: left 2 h 30 min ago, needs clearing',
      'Table 3: seated 1 h 1 min, nobody has stopped by yet',
    ]);
    expect(screen.getByText('Free for 16 h').textContent).not.toMatch(/\d{3,} min/);
  });

  test('ticks every second, and every tile ticks off the same one interval', () => {
    renderTab({ hours: HOURS });
    // Two seated tiles and a waiting one, and the chart beside them, and still
    // one timer.
    expect(jest.getTimerCount()).toBe(1);
    expect(within(tileFor(5)).getByText('1:05')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(SEC); });
    expect(within(tileFor(5)).getByText('1:06')).toBeTruthy();
    expect(within(tileFor(3)).getByText('6:13')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(54 * SEC); });
    expect(within(tileFor(5)).getByText('2:00')).toBeTruthy();
    expect(within(tileFor(1)).getByText('Free for 13 min')).toBeTruthy();
  });

  test('the interval goes when the tab goes', () => {
    const { unmount } = renderTab();
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a clock a little ahead of this phone reads zero, never a countdown', () => {
    renderTab({ data: { ...LIVE, tables: [{ number: 7, people: 2, state: 'seated', since: new Date(NOW + 3 * SEC).toISOString() }] } });
    expect(within(tileFor(7)).getByText('0:00')).toBeTruthy();
  });

  test('tables that arrive after the board mounted are timed from now, not from the mount', () => {
    const { rerender } = renderTab({ data: null });
    act(() => { jest.advanceTimersByTime(40 * SEC); });
    const later = { ...LIVE, tables: [{ number: 6, people: 2, state: 'seated', since: new Date(NOW + 40 * SEC - 70 * SEC).toISOString() }] };
    rerender(<VenueTablesTab data={later} hours={null} colors={COLORS} wellPx={50} />);
    expect(within(tileFor(6)).getByText('1:10')).toBeTruthy();
  });
});

describe('the tables that need someone', () => {
  test('lists only waiting and needs clearing, longest first', () => {
    renderTab();
    expect(alertLines()).toEqual([
      'Table 3: seated 6 min, nobody has stopped by yet',
      'Table 4: left 2 min ago, needs clearing',
    ]);
  });

  test('a table left longer than a party has waited goes first', () => {
    renderTab({
      data: {
        ...LIVE,
        next_free: null,
        tables: [
          { number: 8, people: 2, state: 'waiting', since: ago(6 * MIN) },
          { number: 9, people: 0, state: 'needs_clearing', since: ago(9 * MIN) },
          { number: 10, people: 3, state: 'waiting', since: ago(11 * MIN) },
          { number: 11, people: 2, state: 'seated', since: ago(40 * MIN) },
          { number: 12, people: 0, state: 'free', since: ago(50 * MIN) },
        ],
      },
    });
    expect(alertLines()).toEqual([
      'Table 10: seated 11 min, nobody has stopped by yet',
      'Table 9: left 9 min ago, needs clearing',
      'Table 8: seated 6 min, nobody has stopped by yet',
    ]);
  });

  test('a room where nobody is waiting and nothing needs clearing lists nothing', () => {
    renderTab({
      data: {
        ...LIVE,
        tables: [
          { number: 1, people: 0, state: 'free', since: ago(3 * MIN) },
          { number: 2, people: 2, state: 'seated', since: ago(20 * MIN) },
        ],
      },
    });
    expect(screen.queryByRole('list', { name: 'Needs attention' })).toBeNull();
  });
});

describe('next likely free', () => {
  test('names the server\'s pick and how long it has been seated', () => {
    renderTab();
    expect(screen.getByText('Next likely free: Table 2 (seated 24 min)')).toBeTruthy();
  });

  test('says nothing without a pick, or when the pick is not seated on the tiles', () => {
    const { unmount } = renderTab({ data: { ...LIVE, next_free: null } });
    expect(screen.queryByText(/Next likely free/)).toBeNull();
    unmount();
    renderTab({ data: { ...LIVE, next_free: 1 } });
    expect(screen.queryByText(/Next likely free/)).toBeNull();
  });
});

describe('the board\'s heading and summary', () => {
  test('"Right now", then free tables counted against all of them', () => {
    renderTab();
    expect(screen.getByRole('heading', { name: 'Right now' })).toBeTruthy();
    expect(screen.getByText('1 of 5 free')).toBeTruthy();
  });
});

describe('a sensor that has gone quiet', () => {
  const STALE = {
    tables: [
      { number: 1, people: 0, state: 'free', since: ago(30 * MIN) },
      { number: 2, people: 3, state: 'seated', since: ago(14 * MIN) },
    ],
    updated_at: ago(4 * MIN),
    stale: true,
    next_free: 2,
  };

  test('is called offline, with how old its last reading is and what it saw', () => {
    renderTab({ data: STALE });
    expect(paragraph('Sensor offline. Last reading 4 min ago, when 1 of 2 was free.')).toBeTruthy();
    expect(screen.queryByText('1 of 2 free')).toBeNull();
  });

  test('the live part dims and its clocks stop where the sensor left them', () => {
    renderTab({ data: STALE });
    expect(screen.getByTestId('tables-live')).toHaveStyle({ opacity: '0.55' });
    // Seated 14 minutes ago by this phone's clock, 10 at the last reading.
    expect(within(tileFor(2)).getByText('10:00')).toBeTruthy();
    expect(within(tileFor(1)).getByText('Free for 26 min')).toBeTruthy();
    expect(screen.getByText('Next likely free: Table 2 (seated 10 min)')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(65 * SEC); });
    expect(within(tileFor(2)).getByText('10:00')).toBeTruthy();
    // The age of the reading is the one thing that keeps moving.
    expect(paragraph('Sensor offline. Last reading 5 min ago, when 1 of 2 was free.')).toBeTruthy();
  });

  test('with no time for the last reading, no clock is shown at all', () => {
    renderTab({ data: { ...STALE, updated_at: null } });
    expect(paragraph('Sensor offline. At its last reading 1 of 2 was free.')).toBeTruthy();
    expect(tileFor(2).textContent).not.toMatch(/\d:\d\d/);
    expect(tileFor(1).textContent).not.toMatch(/min/);
  });

  test('a live sensor is not dimmed', () => {
    renderTab();
    expect(screen.getByTestId('tables-live')).toHaveStyle({ opacity: '1' });
    expect(screen.queryByText(/Sensor offline/)).toBeNull();
  });
});

describe('a later read that brings no tables', () => {
  // The tab stays for the rest of the visit once a table has been read, so a
  // read that fails or comes back empty after that is said in one line.
  test.each([
    ['a failed read', null, "Your tables couldn't load just now."],
    ['an empty list', { tables: [], updated_at: null, stale: false, next_free: null }, 'Your sensor is not reporting any tables right now.'],
    ['a list with nothing the board can draw', { tables: [{ number: 'two', state: 'free' }, { number: 3, state: 'dancing' }] }, 'Your sensor is not reporting any tables right now.'],
  ])('%s says so, with no tiles and no clock running', (_, data, line) => {
    renderTab({ data });
    expect(screen.getByRole('heading', { name: 'Right now' })).toBeTruthy();
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'All tables' })).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('tables in use by hour', () => {
  test('averages every row in the same local hour of the day', () => {
    const { slots, tables } = tablesByLocalHour(HOURS);
    expect(slots[19]).toEqual({ hour: 19, avg: 3, samples: 3 });
    expect(slots[20]).toEqual({ hour: 20, avg: 5.5, samples: 2 });
    expect(slots[23]).toEqual({ hour: 23, avg: 1, samples: 1 });
    expect(slots.filter((s) => s.avg !== null).map((s) => s.hour)).toEqual([19, 20, 23]);
    expect(tables).toBe(8);
  });

  test('the hour is the one on the viewer\'s clock, not the one written in the ISO string', () => {
    // 7 PM here is 11 PM UTC in New York. Bucketed by the string's own hour,
    // this row would land at 23.
    const iso = new Date(2026, 9, 19, 19).toISOString();
    const { slots } = tablesByLocalHour([{ hour: iso, occupied: 3, total: 8 }]);
    expect(slots.filter((s) => s.avg !== null).map((s) => s.hour)).toEqual([19]);
  });

  test('rows the tab cannot read are skipped, not counted as zero', () => {
    const { slots } = tablesByLocalHour([
      { hour: at(19, 19), occupied: 4, total: 8 },
      { hour: 'not a time', occupied: 9, total: 8 },
      { hour: at(19, 19), occupied: null, total: 8 },
      { hour: at(19, 19), occupied: -1, total: 8 },
      null,
    ]);
    expect(slots[19]).toEqual({ hour: 19, avg: 4, samples: 1 });
  });

  test('is its own section under the board, with the open hours, the gap inside them empty, and the busy stretch marked', () => {
    renderTab({ hours: HOURS });
    const board = screen.getByRole('heading', { name: 'Right now' });
    const hoursHeading = screen.getByRole('heading', { name: 'Tables in use by hour' });
    // eslint-disable-next-line no-bitwise
    expect(board.compareDocumentPosition(hoursHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const chart = screen.getByTestId('tables-hours-chart');
    const bars = [...chart.querySelectorAll('[data-hour]')];
    // 7 PM to 11 PM: the long overnight gap is left off, 9 and 10 PM stay in.
    expect(bars.map((b) => Number(b.getAttribute('data-hour')))).toEqual([19, 20, 21, 22, 23]);
    expect(bars.map((b) => b.querySelector('div').children.length)).toEqual([1, 1, 0, 0, 1]);
    // 8 PM's 5.5 is the peak; 7 PM's 3 is not within a fifth of it.
    expect(bars.filter((b) => b.getAttribute('data-busy') === 'true').map((b) => Number(b.getAttribute('data-hour')))).toEqual([20]);
    expect(screen.getByText('Busiest around 8 PM, with 5.5 of 8 tables in use on average.')).toBeTruthy();
    expect(screen.getByText('Averages for each hour of the day over the last 7 days.')).toBeTruthy();
  });

  test('a late bar reads in one run across midnight', () => {
    const rows = [18, 19, 20, 21, 22, 23, 0, 1].map((h) => ({ hour: h, occupied: h === 22 ? 6 : 2, total: 10 }));
    const chart = tableHoursChart(rows, (h) => h);
    expect(chart.bars.map((b) => b.hour)).toEqual([18, 19, 20, 21, 22, 23, 0, 1]);
    expect([...chart.busy]).toEqual([22]);
  });

  test('a room open all day draws all 24 hours from midnight', () => {
    const rows = Array.from({ length: 24 }, (_, h) => ({ hour: h, occupied: 1, total: 4 }));
    expect(tableHoursChart(rows, (h) => h).bars.map((b) => b.hour)).toEqual(Array.from({ length: 24 }, (_, h) => h));
  });

  // A box that stays on reports the closed hours as zero tables in use, so
  // every hour has a row and there is no gap to trim. The day then starts at
  // the quietest hour, and the night is one run instead of two ends.
  describe('a box that stays on all night', () => {
    const EVENING = [18, 19, 20, 21, 22, 23, 0, 1];
    const allNight = (occupiedAt) => Array.from({ length: 24 }, (_, h) => ({ hour: h, occupied: occupiedAt(h), total: 10 }));
    const hoursOf = (chart) => chart.bars.map((b) => b.hour);
    // Where the evening sits on the axis, and that it sits there whole.
    const eveningRun = (hours) => {
      const i = hours.indexOf(18);
      return i === -1 ? null : hours.slice(i, i + EVENING.length);
    };

    test('a bar open 6 PM to 2 AM draws all 24 hours from the first closed hour, with the night in one run', () => {
      const chart = tableHoursChart(allNight((h) => (EVENING.includes(h) ? (h === 22 ? 6 : 2) : 0)), (h) => h);
      expect(hoursOf(chart)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, ...EVENING]);
      expect(chart.bars).toHaveLength(24);
      expect([...chart.busy]).toEqual([22]);
    });

    test('one party in a week inside the closed hours does not split them: the night still reads whole', () => {
      // 9 AM averaged 0.14 over the week, which the chart reads as 0.1, so the
      // closed run is 10 AM to 5 PM and the day starts there.
      const chart = tableHoursChart(allNight((h) => (EVENING.includes(h) ? 3 : h === 9 ? 0.14 : 0)), (h) => h);
      expect(hoursOf(chart)[0]).toBe(10);
      expect(eveningRun(hoursOf(chart))).toEqual(EVENING);
    });

    test('a venue whose quiet hour is inside its day starts there, and a flat day starts at midnight', () => {
      // A diner open around the clock, emptiest at 4 AM.
      const diner = tableHoursChart(allNight((h) => (h === 4 ? 0.5 : 3)), (h) => h);
      expect(hoursOf(diner)[0]).toBe(4);
      expect(hoursOf(diner)).toHaveLength(24);
      const flat = tableHoursChart(allNight(() => 0), (h) => h);
      expect(hoursOf(flat)).toEqual(Array.from({ length: 24 }, (_, h) => h));
    });

    test('a box switched off overnight keeps the trim: the closed hours are left off', () => {
      const rows = EVENING.map((h) => ({ hour: h, occupied: 2, total: 10 }));
      expect(hoursOf(tableHoursChart(rows, (h) => h))).toEqual(EVENING);
    });

    test('drawn on the tab: 24 bars, the closed ones empty stubs, the busy stretch marked once', () => {
      const day = 19;
      const rows = Array.from({ length: 24 }, (_, h) => ({ hour: at(day, h), occupied: EVENING.includes(h) ? (h === 23 || h === 0 ? 7 : 3) : 0, total: 10 }));
      renderTab({ hours: rows });
      const bars = [...screen.getByTestId('tables-hours-chart').querySelectorAll('[data-hour]')];
      expect(bars).toHaveLength(24);
      const hours = bars.map((b) => Number(b.getAttribute('data-hour')));
      expect(eveningRun(hours)).toEqual(EVENING);
      expect(bars.filter((b) => b.getAttribute('data-busy') === 'true').map((b) => Number(b.getAttribute('data-hour')))).toEqual([23, 0]);
      expect(screen.getByText('Busiest around 11 PM, with 7 of 10 tables in use on average.')).toBeTruthy();
    });
  });

  test('hour labels match the app\'s', () => {
    expect([0, 1, 11, 12, 13, 19, 23].map(hourLabel)).toEqual(['12 AM', '1 AM', '11 AM', '12 PM', '1 PM', '7 PM', '11 PM']);
  });

  test('a one-table setup is "of 1 table", not "of 1 tables"', () => {
    renderTab({ hours: [{ hour: at(19, 19), occupied: 0.8, total: 1 }, { hour: at(18, 19), occupied: 1, total: 1 }] });
    expect(screen.getByText('Busiest around 7 PM, with 0.9 of 1 table in use on average.')).toBeTruthy();
  });

  test.each([
    ['a failed hours read', null],
    ['an empty week', []],
    ['nothing usable in it', [{ hour: 'never', occupied: 2, total: 8 }]],
  ])('is left out when there is %s', (_, hours) => {
    renderTab({ hours });
    expect(screen.queryByTestId('tables-hours-chart')).toBeNull();
    expect(screen.queryByTestId('tables-hours-loading')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tables in use by hour' })).toBeNull();
    // The board is still there.
    expect(screen.getByRole('heading', { name: 'Right now' })).toBeTruthy();
  });

  test('while the hours read is out, the card is a skeleton, then the chart', () => {
    const { rerender } = renderTab({ hours: undefined });
    const loading = screen.getByTestId('tables-hours-loading');
    expect(loading.className).toBe('skeleton');
    expect(loading.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByTestId('tables-hours-chart')).toBeNull();
    rerender(<VenueTablesTab data={LIVE} hours={HOURS} colors={COLORS} wellPx={50} />);
    expect(screen.queryByTestId('tables-hours-loading')).toBeNull();
    expect(screen.getByTestId('tables-hours-chart')).toBeTruthy();
  });
});

describe('no em dash in anything the tab renders', () => {
  test('live, offline, offline without a time and with nothing to show, with the chart', () => {
    const cases = [
      LIVE,
      { ...LIVE, stale: true, updated_at: ago(5 * MIN) },
      { ...LIVE, stale: true, updated_at: null },
      null,
      { tables: [] },
    ];
    for (const data of cases) {
      const { container, unmount } = renderTab({ data, hours: HOURS });
      expect(container.textContent.length).toBeGreaterThan(50);
      expect(container.textContent).not.toContain(EM_DASH);
      // No range is drawn anywhere on the tab, so no en dash either.
      expect(container.textContent).not.toContain(EN_DASH);
      unmount();
    }
  });
});

describe('the read loop', () => {
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  };

  test('reads at once, then 15 seconds after each answer', async () => {
    expect(TABLES_READ_EVERY_MS).toBe(15 * SEC);
    const readTables = jest.fn(() => Promise.resolve(LIVE));
    const onData = jest.fn();
    const stop = startTablesReading(readTables, onData);
    expect(readTables).toHaveBeenCalledTimes(1);
    await flush();
    expect(onData).toHaveBeenLastCalledWith(LIVE, OPEN);
    jest.advanceTimersByTime(15 * SEC - 1);
    await flush();
    expect(readTables).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(readTables).toHaveBeenCalledTimes(2);
    stop();
  });

  test('never two reads at once: a slow answer holds the next one back', async () => {
    let answer;
    const readTables = jest.fn(() => new Promise((resolve) => { answer = resolve; }));
    const onData = jest.fn();
    const stop = startTablesReading(readTables, onData);
    await flush();
    jest.advanceTimersByTime(2 * MIN);
    await flush();
    expect(readTables).toHaveBeenCalledTimes(1);
    answer(LIVE);
    await flush();
    expect(onData).toHaveBeenCalledWith(LIVE, OPEN);
    expect(readTables).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(readTables).toHaveBeenCalledTimes(2);
    stop();
  });

  test('once stopped, a late answer is dropped and nothing more is asked', async () => {
    let answer;
    const readTables = jest.fn(() => new Promise((resolve) => { answer = resolve; }));
    const onData = jest.fn();
    const stop = startTablesReading(readTables, onData);
    await flush();
    stop();
    answer(LIVE);
    await flush();
    expect(onData).not.toHaveBeenCalled();
    jest.advanceTimersByTime(MIN);
    await flush();
    expect(readTables).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('stopping between reads clears the timer that was waiting', async () => {
    const readTables = jest.fn(() => Promise.resolve(LIVE));
    const stop = startTablesReading(readTables, jest.fn());
    await flush();
    expect(jest.getTimerCount()).toBe(1);
    stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a dropped connection or a server error is no tables, and is asked again', async () => {
    const readTables = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { isOffline: true }))
      .mockRejectedValueOnce(Object.assign(new Error('Something went wrong on our end. Try again.'), { status: 500 }))
      .mockResolvedValue(LIVE);
    const onData = jest.fn();
    const stop = startTablesReading(readTables, onData);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(1, null, OPEN);
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(2, null, OPEN);
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(3, LIVE, OPEN);
    stop();
  });

  test.each([401, 403, 404])('a %i is no tables, and ends the reading', async (status) => {
    const readTables = jest.fn(() => Promise.reject(Object.assign(new Error('No'), { status })));
    const onData = jest.fn();
    startTablesReading(readTables, onData);
    await flush();
    expect(onData).toHaveBeenCalledWith(null, OPEN);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(MIN);
    await flush();
    expect(readTables).toHaveBeenCalledTimes(1);
  });

  test('the 403 for a plan check that could not run is no tables this turn, no lock, and is asked again', async () => {
    // One pool timeout inside the gate's tier lookup used to end the reading
    // for the rest of the visit, on the screen meant to stay open all shift.
    const readTables = jest.fn()
      .mockRejectedValueOnce(planCheckFailedErr())
      .mockResolvedValue(LIVE);
    const onData = jest.fn();
    const stop = startTablesReading(readTables, onData);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(1, null, OPEN);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(2, LIVE, OPEN);
    expect(readTables).toHaveBeenCalledTimes(2);
    stop();
  });

  test('only that 403 is retried: the fields that mark it, on a 403', () => {
    expect(planCheckFailed(planCheckFailedErr())).toBe(true);
    expect(planCheckFailed(Object.assign(planCheckFailedErr(), { data: { code: 'UPGRADE_REQUIRED', retryable: true } }))).toBe(true);
    // The real plan refusals, with and without tables, still end the reading.
    expect(planCheckFailed(upgradeRequired(true))).toBe(false);
    expect(planCheckFailed(upgradeRequired(false))).toBe(false);
    // Not the owner: no body fields that say temporary.
    expect(planCheckFailed(Object.assign(new Error('No'), { status: 403, data: { error: 'No' } }))).toBe(false);
    // A 500 carrying the words is a 500, handled as one already.
    expect(planCheckFailed(Object.assign(planCheckFailedErr(), { status: 500 }))).toBe(false);
    expect(planCheckFailed(Object.assign(planCheckFailedErr(), { data: undefined }))).toBe(false);
    expect(planCheckFailed(null)).toBe(false);
    // And it is never the lock.
    expect(planLockedWithTables(planCheckFailedErr())).toBe(false);
  });

  test('an answer without a tables list is no tables', async () => {
    for (const answer of [{}, { tables: 'x' }, null]) {
      const onData = jest.fn();
      const stop = startTablesReading(() => Promise.resolve(answer), onData);
      // eslint-disable-next-line no-await-in-loop
      await flush();
      expect(onData).toHaveBeenCalledWith(null, OPEN);
      stop();
    }
  });

  // Below Roost both routes answer the requirePro 403 with `has_tables`.
  test.each([
    ['a venue with tables: no data, the tab with its lock', true, LOCKED],
    ['a venue without tables: nothing, as for a venue with none', false, OPEN],
  ])('the plan refusal for %s, and no more reads', async (_, hasTables, info) => {
    const readTables = jest.fn(() => Promise.reject(upgradeRequired(hasTables)));
    const onData = jest.fn();
    startTablesReading(readTables, onData);
    await flush();
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith(null, info);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(MIN);
    await flush();
    expect(readTables).toHaveBeenCalledTimes(1);
  });

  test('only that refusal, with has_tables exactly true, counts as the plan lock', () => {
    expect(planLockedWithTables(upgradeRequired(true))).toBe(true);
    expect(planLockedWithTables(upgradeRequired(false))).toBe(false);
    // Another 403 (not the verified owner) has no code and is a plain refusal.
    expect(planLockedWithTables(Object.assign(new Error('No'), { status: 403, data: { error: 'No' } }))).toBe(false);
    expect(planLockedWithTables(Object.assign(upgradeRequired(true), { data: { code: 'UPGRADE_REQUIRED', has_tables: 'true' } }))).toBe(false);
    expect(planLockedWithTables(Object.assign(upgradeRequired(true), { data: undefined }))).toBe(false);
    expect(planLockedWithTables(Object.assign(upgradeRequired(true), { status: 401 }))).toBe(false);
    expect(planLockedWithTables(null)).toBe(false);
  });

  test('a plan that lapses mid-visit locks the tab it had opened', async () => {
    const readTables = jest.fn()
      .mockResolvedValueOnce(LIVE)
      .mockRejectedValueOnce(upgradeRequired(true));
    const onData = jest.fn();
    startTablesReading(readTables, onData);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(1, LIVE, OPEN);
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(2, null, LOCKED);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('App.js reads the tables for the dashboard and hands them down', () => {
  const APP = read('App.js');
  const start = APP.indexOf("// The same sensor's tables, for the same place");
  const effect = APP.slice(start, APP.indexOf('// The tab a dashboard opens on is the one it was left on', start));
  const reopen = APP.slice(APP.indexOf('// The tab a dashboard opens on is the one it was left on'), APP.indexOf('// Seed venueInfo from onboarding data'));

  test('the read and the reopen rule are found, so the checks below are reading something', () => {
    expect(start).toBeGreaterThan(-1);
    expect(effect).toContain('React.useEffect(');
    expect(reopen).toContain('React.useLayoutEffect(');
  });

  test('only while the owner\'s dashboard is open, starting from nothing each time', () => {
    expect(effect).toMatch(/setOwnerTables\(null\);\s*setOwnerTableHours\(undefined\);\s*setOwnerTablesSeen\(false\);\s*setOwnerTablesLocked\(false\);\s*if \(!pid \|\| currentScreen !== 'venueDashboard'\) return undefined;/);
  });

  test('read again when the plan changes, as the Analytics reads are, so a lock never outlasts a purchase', () => {
    expect(effect).toContain('}, [ownerVenuePlaceId, currentScreen, venueTier]);');
  });

  test('the tables on the loop, the hours once, and both stopped on the way out', () => {
    expect(effect).toContain('const stopReading = startTablesReading(() => getSensorTables(pid), (data, { planLocked }) => {');
    expect(effect).toContain('getSensorTableHours(pid).then(tableHoursFrom, () => null)');
    expect(effect).toContain('if (!cancelled) setOwnerTableHours(hours);');
    expect(effect).toMatch(/return \(\) => \{\s*cancelled = true;\s*stopReading\(\);\s*\};/);
    expect(effect).not.toContain('setInterval');
  });

  test('a table, or the plan lock of a venue with tables, puts the tab in the bar, and nothing takes it out mid-visit', () => {
    expect(effect).toMatch(/setOwnerTables\(data\);\s*if \(planLocked\) setOwnerTablesLocked\(true\);\s*if \(planLocked \|\| \(data && data\.tables\.length > 0\)\) setOwnerTablesSeen\(true\);/);
    // The only other writes are the resets when the visit, the place or the
    // plan changes.
    expect(APP.match(/setOwnerTablesSeen\(/g)).toHaveLength(2);
    expect(APP.match(/setOwnerTablesLocked\(/g)).toHaveLength(2);
  });

  test('a dashboard reopened on the Tables tab opens on Analytics, and leaving it starts nothing', () => {
    expect(reopen).toContain("if (currentScreen === 'venueDashboard' && venueTab === 'tables' && !ownerTablesSeen) setVenueTab('analytics');");
    expect(reopen).toContain('}, [currentScreen, venueTab, ownerTablesSeen]);');
  });

  test('all four reach the dashboard beside the sensor data', () => {
    expect(APP).toMatch(/ownerSensorData,\s*ownerSensorHistory,\s*ownerTableHours,\s*ownerTables,\s*ownerTablesLocked,\s*ownerTablesSeen,\s*promotions,/);
  });
});

// ── On the dashboard ───────────────────────────────────────────────────────

const DASH = read('screens', 'VenueDashboard.js');
// Every parameter the dashboard takes, read off its own signature, the way
// roostNotSoldInApp.test.js renders it.
const PARAMS = (() => {
  const s = DASH.indexOf('export default function VenueDashboard({');
  const block = DASH.slice(s, DASH.indexOf('}) {', s));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const STUB_COMPONENTS = new Set(['DialogBehavior', 'EventModal', 'MapLibreMapView', 'ModerationHiddenNotice', 'PromoModal', 'SearchInputLocal']);
const FUNCTIONS = /^(set|handle|load|open|render|retry|cancel|switch|calc|get|crowd|is|member)[A-Za-z]/;
const TAB_NAMES = ['Analytics', 'Tables', 'Map', 'Promotions', 'Events', 'Reviews', 'Settings'];

const ROOST = {
  colors: new Proxy({}, { get: () => '#2d5a87' }),
  HOUR_BAR_WELL_PX: 50,
  venueTab: 'analytics',
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
};
const SENSOR = {
  sensor_data: { thermal_headcount: 12, noise_db: 60, ir_beam_count: 3, recorded_at: ago(MIN) },
  recent_checkins: 2,
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
const tabBar = () => screen.getAllByRole('button').map((b) => b.textContent.trim()).filter((t) => TAB_NAMES.includes(t));

describe('the tab bar', () => {
  test('the dashboard takes the tables, the hours and both flags', () => {
    expect(PARAMS).toEqual(expect.arrayContaining(['ownerTables', 'ownerTableHours', 'ownerTablesSeen', 'ownerTablesLocked']));
  });

  test('a venue whose sensor has reported a table gets Tables, right after Analytics', async () => {
    dashboard({ ownerTablesSeen: true, ownerTables: LIVE });
    await settle();
    expect(tabBar()).toEqual(['Analytics', 'Tables', 'Map', 'Promotions', 'Events', 'Reviews', 'Settings']);
  });

  test.each([
    ['nothing read yet', { ownerTablesSeen: false, ownerTables: undefined }],
    ['no tables at all', { ownerTablesSeen: false, ownerTables: { tables: [], updated_at: null, stale: false, next_free: null } }],
    ['a refused read', { ownerTablesSeen: false, ownerTables: null }],
    // The plan refusal with has_tables false: App.js leaves both flags down.
    ['a plan refusal for a venue without tables', { ownerTablesSeen: false, ownerTablesLocked: false, ownerTables: null, venueTier: 'free' }],
  ])('%s: no Tables tab, and nothing about tables anywhere', async (_, overrides) => {
    const { container } = dashboard({ ownerSensorData: SENSOR, ...overrides });
    await settle();
    expect(tabBar()).toEqual(['Analytics', 'Map', 'Promotions', 'Events', 'Reviews', 'Settings']);
    expect(container.textContent).not.toMatch(/Right now|Tables in use by hour|Needs a server/);
    expect(container.textContent).not.toMatch(/coming soon/i);
  });

  test('the Tables button opens the tab', async () => {
    const { props } = dashboard({ ownerTablesSeen: true, ownerTables: LIVE });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Tables' }));
    expect(props.setVenueTab).toHaveBeenCalledWith('tables');
  });
});

describe('the Tables tab', () => {
  // The lock's web half is the build that sells; pinned here so the lock tests
  // do not depend on what the machine running them has set.
  const FLAG_BEFORE = process.env.REACT_APP_PURCHASES;
  beforeEach(() => { delete process.env.REACT_APP_PURCHASES; });
  afterEach(() => {
    if (FLAG_BEFORE === undefined) delete process.env.REACT_APP_PURCHASES;
    else process.env.REACT_APP_PURCHASES = FLAG_BEFORE;
  });

  test('a Roost venue gets the board and the week by hour', async () => {
    dashboard({ venueTab: 'tables', ownerTablesSeen: true, ownerTables: LIVE, ownerTableHours: HOURS, ownerSensorData: SENSOR });
    await settle();
    expect(screen.getByRole('heading', { name: 'Right now' })).toBeTruthy();
    expect(screen.getByText('1 of 5 free')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tables in use by hour' })).toBeTruthy();
    // The tab is the tables and nothing else: Live Sensor stays on Analytics.
    expect(screen.queryByRole('heading', { name: 'Live Sensor' })).toBeNull();
    expect(screen.queryByText('Post a Deal')).toBeNull();
  });

  test('a plan without Roost gets the same lock Analytics uses, named for the tab', async () => {
    const { container } = dashboard({ venueTab: 'tables', venueTier: 'free', ownerTablesSeen: true, ownerTables: LIVE, ownerTableHours: HOURS });
    await settle();
    expect(screen.getByRole('heading', { name: 'Tables' })).toBeTruthy();
    expect(screen.getByText('Each table live from your sensor: which are free, seated, waiting for a server or need clearing, and how many are in use at each hour.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade to Roost' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Right now' })).toBeNull();
    expect(screen.queryByTestId('tables-hours-chart')).toBeNull();
    expect(container.textContent).not.toContain(EM_DASH);
  });

  test('inside the app the lock names no price and offers nothing to buy', async () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
    try {
      const { container } = dashboard({ venueTab: 'tables', venueTier: 'free', ownerTablesSeen: true, ownerTables: LIVE });
      await settle();
      expect(screen.getByText('This is not turned on for your venue.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull();
      expect(container.textContent).not.toMatch(/\$\s?\d/);
    } finally {
      delete window.Capacitor;
    }
  });

  test('the server\'s plan refusal for a venue with tables shows the lock, even where this side reads Roost', async () => {
    // A stale plan read here and the server's own check disagree: the server
    // wins, so the lock shows and no board is drawn from data nobody sent.
    const { container } = dashboard({ venueTab: 'tables', venueTier: 'pro', ownerTablesSeen: true, ownerTablesLocked: true, ownerTables: null, ownerTableHours: null });
    await settle();
    expect(tabBar()).toContain('Tables');
    expect(screen.getByRole('heading', { name: 'Tables' })).toBeTruthy();
    expect(screen.getByText('Each table live from your sensor: which are free, seated, waiting for a server or need clearing, and how many are in use at each hour.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Right now' })).toBeNull();
    expect(container.textContent).not.toMatch(/couldn't load|Needs a server/);
  });

  test('that lock does not wait for the plan read', async () => {
    dashboard({ venueTab: 'tables', venueTier: 'free', venueTierKnown: false, ownerTablesSeen: true, ownerTablesLocked: true, ownerTables: null });
    await settle();
    expect(screen.getByRole('heading', { name: 'Tables' })).toBeTruthy();
    expect(document.querySelectorAll('.skeleton')).toHaveLength(0);
  });

  test('until the plan is known, the shimmer stands in for both', async () => {
    dashboard({ venueTab: 'tables', venueTierKnown: false, ownerTablesSeen: true, ownerTables: LIVE });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Right now' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tables' })).toBeNull();
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });

  test('without the flag the tab draws nothing, even asked for by name', async () => {
    const { container } = dashboard({ venueTab: 'tables', ownerTablesSeen: false, ownerTables: LIVE, ownerTableHours: HOURS });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Right now' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tables' })).toBeNull();
    expect(container.textContent).not.toMatch(/Needs a server|Tables in use by hour/);
  });

  test('a read that failed after the tab appeared says so on the tab', async () => {
    dashboard({ venueTab: 'tables', ownerTablesSeen: true, ownerTables: null, ownerTableHours: HOURS });
    await settle();
    expect(screen.getByText("Your tables couldn't load just now.")).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tables in use by hour' })).toBeTruthy();
  });
});

describe('Analytics', () => {
  test('keeps Live Sensor and no longer carries the board', async () => {
    dashboard({ venueTab: 'analytics', ownerTablesSeen: true, ownerTables: LIVE, ownerTableHours: HOURS, ownerSensorData: SENSOR });
    await settle();
    expect(screen.getByRole('heading', { name: 'Live Sensor' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Right now' })).toBeNull();
    expect(screen.queryByTestId('tables-hours-chart')).toBeNull();
    expect(screen.queryByText('Needs a server')).toBeNull();
  });
});

// ── The two api.js calls ───────────────────────────────────────────────────

describe('the two api.js calls', () => {
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

  test('getSensorTables asks for the place\'s tables, with the id encoded', async () => {
    const body = { tables: [{ number: 1, people: 0, state: 'free', since: '2026-10-23T23:00:00.000Z', seats: 4 }], updated_at: null, stale: false, next_free: null };
    global.fetch = jest.fn(() => reply(200, body));
    await expect(api.getSensorTables('ChIJ a/b')).resolves.toEqual(body);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/sensors\/ChIJ%20a%2Fb\/tables$/);
    expect((options && options.method) || 'GET').toBe('GET');
  });

  test('getSensorTableHours asks for the hours under the same place', async () => {
    const body = { hours: [{ hour: '2026-10-22T23:00:00.000Z', occupied: 2.4, total: 8 }] };
    global.fetch = jest.fn(() => reply(200, body));
    await expect(api.getSensorTableHours('place_1')).resolves.toEqual(body);
    expect(String(global.fetch.mock.calls[0][0])).toMatch(/\/api\/sensors\/place_1\/tables\/hours$/);
  });

  test('a refusal reaches the caller with its status, asked once', async () => {
    global.fetch = jest.fn(() => reply(403, { error: 'Only the verified owner of this venue can see its tables.' }));
    const err = await api.getSensorTables('place_1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(403);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(planLockedWithTables(err)).toBe(false);
  });

  test.each([[true, true], [false, false]])('the plan refusal with has_tables %s reaches the loop as the plan lock: %s', async (hasTables, locked) => {
    // The body the server's requirePro sends below Roost, through the real
    // request(): the code lands on err.code and the body on err.data, which is
    // all planLockedWithTables reads.
    global.fetch = jest.fn(() => reply(403, UPGRADE_BODY(hasTables)));
    const err = await api.getSensorTables('place_1').catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.code).toBe('UPGRADE_REQUIRED');
    expect(planLockedWithTables(err)).toBe(locked);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('the failed plan check reaches the loop as the one 403 to ask again, asked once by the transport', async () => {
    global.fetch = jest.fn(() => reply(403, PLAN_CHECK_FAILED_BODY));
    const err = await api.getSensorTables('place_1').catch((e) => e);
    expect(err.status).toBe(403);
    expect(planCheckFailed(err)).toBe(true);
    expect(planLockedWithTables(err)).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
