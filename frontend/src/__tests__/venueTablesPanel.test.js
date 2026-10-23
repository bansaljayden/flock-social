/**
 * TABLES ON THE OWNER DASHBOARD.
 *
 * A venue's Flux sensor can count people per table zone and keep a state for
 * every table. The verified owner reads it through
 * GET /api/sensors/:placeId/tables (the tables now) and
 * GET /api/sensors/:placeId/tables/hours (tables in use by hour, last 7 days),
 * and the Analytics tab draws it in a Tables panel beside Live Sensor. This
 * file pins what the panel says and does:
 *
 *   - every state reads in words on its tile, so none rests on colour alone;
 *   - seated and waiting tiles count up in minutes and seconds off one interval
 *     for the whole panel, which goes when the panel goes;
 *   - only waiting and needs-clearing tables are listed as needing someone, and
 *     the one that has waited longest leads;
 *   - the server's next-free pick is named with how long it has been seated;
 *   - an offline sensor is called offline, the live part dims and its clocks
 *     stop at the last reading;
 *   - no tables, or a failed read, draws nothing at all, and a free plan sees
 *     the lock instead of the panel;
 *   - the hours chart averages each hour of the day on the viewer's own clock,
 *     draws the open hours and marks the busy stretch;
 *   - nothing the panel renders holds an em dash;
 *   - the read loop never has two reads out at once and stops cleanly;
 *   - the two api.js calls ask the paths the server serves.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false venueTablesPanel
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, act, within } from '@testing-library/react';

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
// about, and both sit in the same Analytics body as the panel.
jest.mock('../components/VenueInsightCards', () => ({ __esModule: true, default: () => null, clearAdvisorCards: () => {} }));
jest.mock('../components/VenueAdvisorChat', () => ({ __esModule: true, default: () => null }));

// eslint-disable-next-line import/first
import VenueTablesPanel from '../components/venue/VenueTablesPanel';
// eslint-disable-next-line import/first
import VenueDashboard from '../screens/VenueDashboard';
// eslint-disable-next-line import/first
import {
  TABLE_STATE_WORDS,
  clockText,
  hourLabel,
  minutesText,
  tableHoursChart,
  tablesByLocalHour,
} from '../lib/venueTables';
// eslint-disable-next-line import/first
import { TABLES_READ_EVERY_MS, startTablesReading } from '../lib/venueTablesReading';

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

// One table in every state, listed out of order on purpose.
const LIVE = {
  tables: [
    { number: 4, people: 0, state: 'needs_clearing', since: ago(2 * MIN + 10 * SEC) },
    { number: 1, people: 0, state: 'free', since: ago(12 * MIN + 30 * SEC) },
    { number: 3, people: 4, state: 'waiting', since: ago(6 * MIN + 12 * SEC) },
    { number: 2, people: 2, state: 'seated', since: ago(24 * MIN + 5 * SEC) },
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

const renderPanel = (props = {}) => render(
  <VenueTablesPanel data={LIVE} hours={null} colors={COLORS} wellPx={50} {...props} />
);
const tiles = () => within(screen.getByRole('list', { name: 'All tables' })).getAllByRole('listitem');
const tileFor = (n) => tiles().find((li) => li.querySelector('p').textContent === `Table ${n}`);
const stateWord = (tile) => tile.querySelectorAll('p')[1].textContent;
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
    renderPanel();
    expect(tiles().map((t) => t.querySelector('p').textContent)).toEqual(['Table 1', 'Table 2', 'Table 3', 'Table 4', 'Table 5']);
    expect(tiles().map(stateWord)).toEqual(['Free', 'Seated', 'Needs a server', 'Needs clearing', 'Seated']);
  });

  test('free and needs clearing say whole minutes; seated and waiting add the head count', () => {
    renderPanel();
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

  test('a screen reader hears minutes, not a clock face', () => {
    renderPanel();
    const clock = within(tileFor(3)).getByText('6:12');
    expect(clock.getAttribute('aria-hidden')).toBe('true');
    expect(within(tileFor(3)).getByText('seated 6 min').className).toBe('sr-only');
    expect(within(tileFor(2)).getByText('for 24 min').className).toBe('sr-only');
  });

  test('the party nobody has stopped by for is the solid amber tile', () => {
    renderPanel();
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
    expect(minutesText(59 * SEC)).toBe('under 1 min');
    expect(minutesText(12 * MIN + 59 * SEC)).toBe('12 min');
  });

  test('ticks every second, and every tile ticks off the same one interval', () => {
    renderPanel();
    // Two seated tiles and a waiting one, and still one timer.
    expect(jest.getTimerCount()).toBe(1);
    expect(within(tileFor(5)).getByText('1:05')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(SEC); });
    expect(within(tileFor(5)).getByText('1:06')).toBeTruthy();
    expect(within(tileFor(3)).getByText('6:13')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(54 * SEC); });
    expect(within(tileFor(5)).getByText('2:00')).toBeTruthy();
    expect(within(tileFor(1)).getByText('Free for 13 min')).toBeTruthy();
  });

  test('the interval goes when the panel goes', () => {
    const { unmount } = renderPanel();
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a clock a little ahead of this phone reads zero, never a countdown', () => {
    renderPanel({ data: { ...LIVE, tables: [{ number: 7, people: 2, state: 'seated', since: new Date(NOW + 3 * SEC).toISOString() }] } });
    expect(within(tileFor(7)).getByText('0:00')).toBeTruthy();
  });
});

describe('the tables that need someone', () => {
  test('lists only waiting and needs clearing, longest first', () => {
    renderPanel();
    expect(alertLines()).toEqual([
      'Table 3: seated 6 min, nobody has stopped by yet',
      'Table 4: left 2 min ago, needs clearing',
    ]);
  });

  test('a table left longer than a party has waited goes first', () => {
    renderPanel({
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
    renderPanel({
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
    renderPanel();
    expect(screen.getByText('Next likely free: Table 2 (seated 24 min)')).toBeTruthy();
  });

  test('says nothing without a pick, or when the pick is not seated on the tiles', () => {
    const { unmount } = renderPanel({ data: { ...LIVE, next_free: null } });
    expect(screen.queryByText(/Next likely free/)).toBeNull();
    unmount();
    renderPanel({ data: { ...LIVE, next_free: 1 } });
    expect(screen.queryByText(/Next likely free/)).toBeNull();
  });
});

describe('the summary line', () => {
  test('counts free tables against all of them', () => {
    renderPanel();
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
    renderPanel({ data: STALE });
    expect(paragraph('Sensor offline. Last reading 4 min ago, when 1 of 2 was free.')).toBeTruthy();
    expect(screen.queryByText('1 of 2 free')).toBeNull();
  });

  test('the tiles dim and their clocks stop where the sensor left them', () => {
    renderPanel({ data: STALE });
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
    renderPanel({ data: { ...STALE, updated_at: null } });
    expect(paragraph('Sensor offline. At its last reading 1 of 2 was free.')).toBeTruthy();
    expect(tileFor(2).textContent).not.toMatch(/\d:\d\d/);
    expect(tileFor(1).textContent).not.toMatch(/min/);
  });

  test('a live sensor is not dimmed', () => {
    renderPanel();
    expect(screen.getByTestId('tables-live')).toHaveStyle({ opacity: '1' });
    expect(screen.queryByText(/Sensor offline/)).toBeNull();
  });
});

describe('no tables draws nothing', () => {
  test.each([
    ['an empty list', { tables: [], updated_at: null, stale: false, next_free: null }],
    ['a failed read', null],
    ['no answer yet', undefined],
    ['a list with nothing the panel can draw', { tables: [{ number: 'two', state: 'free' }, { number: 3, state: 'dancing' }] }],
  ])('%s', (_, data) => {
    const { container } = renderPanel({ data });
    expect(container.innerHTML).toBe('');
    // And no clock is left running for a panel that is not there.
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

  test('rows the panel cannot read are skipped, not counted as zero', () => {
    const { slots } = tablesByLocalHour([
      { hour: at(19, 19), occupied: 4, total: 8 },
      { hour: 'not a time', occupied: 9, total: 8 },
      { hour: at(19, 19), occupied: null, total: 8 },
      { hour: at(19, 19), occupied: -1, total: 8 },
      null,
    ]);
    expect(slots[19]).toEqual({ hour: 19, avg: 4, samples: 1 });
  });

  test('draws the open hours, the gap inside them empty, and marks the busy stretch', () => {
    renderPanel({ hours: HOURS });
    const chart = screen.getByTestId('tables-hours-chart');
    const bars = [...chart.querySelectorAll('[data-hour]')];
    // 7 PM to 11 PM: the long overnight gap is left off, 9 and 10 PM stay in.
    expect(bars.map((b) => Number(b.getAttribute('data-hour')))).toEqual([19, 20, 21, 22, 23]);
    expect(bars.map((b) => b.querySelector('div').children.length)).toEqual([1, 1, 0, 0, 1]);
    // 8 PM's 5.5 is the peak; 7 PM's 3 is not within a fifth of it.
    expect(bars.filter((b) => b.getAttribute('data-busy') === 'true').map((b) => Number(b.getAttribute('data-hour')))).toEqual([20]);
    expect(screen.getByRole('heading', { name: 'Tables in use by hour' })).toBeTruthy();
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

  test('hour labels match the app\'s', () => {
    expect([0, 1, 11, 12, 13, 19, 23].map(hourLabel)).toEqual(['12 AM', '1 AM', '11 AM', '12 PM', '1 PM', '7 PM', '11 PM']);
  });

  test.each([
    ['no hours read', null],
    ['an empty week', []],
    ['nothing usable in it', [{ hour: 'never', occupied: 2, total: 8 }]],
  ])('is hidden when there is %s', (_, hours) => {
    renderPanel({ hours });
    expect(screen.queryByTestId('tables-hours-chart')).toBeNull();
    expect(screen.queryByText('Tables in use by hour')).toBeNull();
    // The tables themselves are still there.
    expect(screen.getByRole('heading', { name: 'Tables' })).toBeTruthy();
  });
});

describe('no em dash in anything the panel renders', () => {
  test('live, offline and offline without a time, with the chart', () => {
    const cases = [
      LIVE,
      { ...LIVE, stale: true, updated_at: ago(5 * MIN) },
      { ...LIVE, stale: true, updated_at: null },
    ];
    for (const data of cases) {
      const { container, unmount } = renderPanel({ data, hours: HOURS });
      expect(container.textContent.length).toBeGreaterThan(100);
      expect(container.textContent).not.toContain(EM_DASH);
      // No range is drawn anywhere on the panel, so no en dash either.
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
    expect(onData).toHaveBeenLastCalledWith(LIVE);
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
    expect(onData).toHaveBeenCalledWith(LIVE);
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
    expect(onData).toHaveBeenNthCalledWith(1, null);
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(2, null);
    jest.advanceTimersByTime(15 * SEC);
    await flush();
    expect(onData).toHaveBeenNthCalledWith(3, LIVE);
    stop();
  });

  test.each([401, 403, 404])('a %i is no tables, and ends the reading', async (status) => {
    const readTables = jest.fn(() => Promise.reject(Object.assign(new Error('No'), { status })));
    const onData = jest.fn();
    startTablesReading(readTables, onData);
    await flush();
    expect(onData).toHaveBeenCalledWith(null);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(MIN);
    await flush();
    expect(readTables).toHaveBeenCalledTimes(1);
  });

  test('an answer without a tables list is no tables', async () => {
    for (const answer of [{}, { tables: 'x' }, null]) {
      const onData = jest.fn();
      const stop = startTablesReading(() => Promise.resolve(answer), onData);
      // eslint-disable-next-line no-await-in-loop
      await flush();
      expect(onData).toHaveBeenCalledWith(null);
      stop();
    }
  });
});

describe('App.js reads the tables for the dashboard and hands them down', () => {
  const APP = read('App.js');
  const start = APP.indexOf("// The same sensor's tables, for the same place");
  const effect = APP.slice(start, APP.indexOf('// Seed venueInfo from onboarding data', start));

  test('the read is found, so the checks below are reading something', () => {
    expect(start).toBeGreaterThan(-1);
    expect(effect).toContain('React.useEffect(');
  });

  test('only while the owner\'s dashboard is open, starting from nothing each time', () => {
    expect(effect).toMatch(/setOwnerTables\(null\);\s*setOwnerTableHours\(null\);\s*if \(!pid \|\| currentScreen !== 'venueDashboard'\) return undefined;/);
    expect(effect).toContain('}, [ownerVenuePlaceId, currentScreen]);');
  });

  test('the tables on the loop, the hours once, and both stopped on the way out', () => {
    expect(effect).toContain('const stopReading = startTablesReading(() => getSensorTables(pid), setOwnerTables);');
    expect(effect).toContain('getSensorTableHours(pid).then(tableHoursFrom, () => null)');
    expect(effect).toContain('if (!cancelled) setOwnerTableHours(hours);');
    expect(effect).toMatch(/return \(\) => \{\s*cancelled = true;\s*stopReading\(\);\s*\};/);
    expect(effect).not.toContain('setInterval');
  });

  test('both reach the dashboard beside the sensor data', () => {
    expect(APP).toMatch(/ownerSensorData,\s*ownerSensorHistory,\s*ownerTableHours,\s*ownerTables,\s*promotions,/);
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

const ROOST_ANALYTICS = {
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

function dashboard(overrides = {}) {
  const props = {};
  for (const name of PARAMS) {
    if (STUB_COMPONENTS.has(name)) props[name] = () => null;
    else if (FUNCTIONS.test(name)) props[name] = jest.fn();
    else props[name] = undefined;
  }
  return render(<VenueDashboard {...props} showToast={jest.fn()} onLogout={jest.fn()} {...ROOST_ANALYTICS} {...overrides} />);
}
const settle = () => act(async () => {});

describe('on the dashboard', () => {
  const SENSOR = {
    sensor_data: { thermal_headcount: 12, noise_db: 60, ir_beam_count: 3, recorded_at: ago(MIN) },
    recent_checkins: 2,
  };

  test('the dashboard takes both, so App.js has somewhere to hand them', () => {
    expect(PARAMS).toEqual(expect.arrayContaining(['ownerTables', 'ownerTableHours']));
  });

  test('a Roost venue sees Tables right after Live Sensor and before Post a Deal', async () => {
    dashboard({ ownerSensorData: SENSOR, ownerTables: LIVE, ownerTableHours: HOURS });
    await settle();
    const live = screen.getByRole('heading', { name: 'Live Sensor' });
    const tables = screen.getByRole('heading', { name: 'Tables' });
    const deal = screen.getByText('Post a Deal');
    // eslint-disable-next-line no-bitwise
    expect(live.compareDocumentPosition(tables) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // eslint-disable-next-line no-bitwise
    expect(tables.compareDocumentPosition(deal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('1 of 5 free')).toBeTruthy();
    expect(screen.getByTestId('tables-hours-chart')).toBeTruthy();
  });

  test('it does not need Live Sensor to be there', async () => {
    dashboard({ ownerTables: LIVE });
    await settle();
    expect(screen.getByRole('heading', { name: 'Tables' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Live Sensor' })).toBeNull();
  });

  test('a free venue sees the lock, not the panel', async () => {
    dashboard({ venueTier: 'free', ownerTables: LIVE, ownerTableHours: HOURS });
    await settle();
    expect(screen.getByRole('heading', { name: 'Analytics' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Tables' })).toBeNull();
  });

  test('another tab does not draw it', async () => {
    dashboard({ venueTab: 'events', ownerTables: LIVE });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Tables' })).toBeNull();
  });

  test.each([
    ['no answer yet', undefined],
    ['a failed read', null],
    ['an empty list', { tables: [], updated_at: null, stale: false, next_free: null }],
    ['an answer with no list', { stale: false }],
  ])('%s draws nothing on the tab', async (_, ownerTables) => {
    dashboard({ ownerSensorData: SENSOR, ownerTables, ownerTableHours: HOURS });
    await settle();
    expect(screen.getByRole('heading', { name: 'Live Sensor' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Tables' })).toBeNull();
    expect(screen.queryByTestId('tables-hours-chart')).toBeNull();
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
    const body = { tables: [], updated_at: null, stale: false, next_free: null };
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
  });
});
