/**
 * THE TABLE LINE AND THE READ BEHIND IT.
 *
 * components/venue/TableAvailability.js chooses the words for a venue's table
 * summary; lib/tableSummaries.js asks the server for the summaries, one POST
 * per list, one GET per detail, a minute's cache under both. This file pins
 * both halves:
 *
 *   1. Every wording branch, the compact forms (verdict first, so a cut row
 *      keeps it), the singular, fits_now null counted with no verdict, the
 *      party the server echoed winning over the caller's, nothing said when
 *      there is nothing to say, and no em dash in any of it.
 *   2. Stale: nothing live, the busy hours still said, the caption honest.
 *   3. Busy hours: consecutive hours fold into one range per day, the range
 *      nearest to now on the venue's clock comes first, at most two, the day
 *      said once when both share it, the AM/PM and midnight edges of the
 *      range label, and none said at all for a summary with no zone. Then the
 *      map plate's rows, and the chat's and the plan's gate and names.
 *   4. The party defaults: two outside a flock, the flock's going count inside
 *      one from two up, clamped to what the server accepts.
 *   5. The read: ids asked for in one tick go as one POST, deduplicated, split
 *      at fifty; a fresh answer is not asked for again; a minute later it is;
 *      an id the server left out is remembered as "no data" under the place,
 *      for every party, and draws nothing; the GET's 404 is the same silence;
 *      a failed read keeps what was known; answers past five minutes are
 *      dropped; nothing goes out signed out; the hooks ask on mount, again
 *      each minute, stop on unmount, render only for their own places, do not
 *      subscribe while parked, and catch a write landing before they subscribe.
 *
 * MUTATIONS RUN AGAINST THIS FILE (2026-10-23), each applied to the source
 * by a script, the suite run, the file restored, the failing tests recorded
 * as the run printed them (50 tests in the suite):
 *
 *   - tableLineText: "Table open now" for every party in the compact form
 *     (the `n === TABLE_PARTY_DEFAULT` test dropped)
 *       -> 3 failed: "a table that fits says so, with the number", "the
 *          compact form keeps the number for any party but two", "the
 *          compact form is one truncating line with no caption"
 *   - tableLineText: the stale check removed
 *       -> 5 failed, "a stale sensor says nothing live" first among them
 *   - tableLineText: 'tables' for a count of one
 *       -> 1 failed: "one table takes its singular"
 *   - busyRanges: consecutive hours no longer folded (`h === prev + 1` made
 *     always false)
 *       -> 3 failed, "consecutive hours fold into one range per day" among them
 *   - busyHoursText: the two-range cap dropped (the slice removed)
 *       -> 2 failed: "at most two ranges, nearest first", "the compact line
 *          takes one range even when there are two"
 *   - tableSummaries: distinctPlaceIds no longer deduplicates
 *       -> 1 failed: "a flock's places are its vote rows and its venue cards,
 *          once each". The POST test did NOT catch this one: the pending set
 *          each tick's ids are gathered in deduplicates on its own, so the
 *          request path is covered twice and the helper's own test is what
 *          guards the helper.
 *   - tableSummaries: TABLE_SUMMARY_BATCH_MAX raised to 500
 *       -> 1 failed: "more than fifty ids go as several POSTs"
 *   - tableSummaries: the freshness check removed from requestTableSummaries
 *       -> 3 failed, "a fresh answer is not asked for again within the
 *          minute, and is after it" among them
 *   - tableSummaries: the signed-out gate removed from canAsk
 *       -> 1 failed: "nothing goes out signed out"
 *   - tableSummaries: the GET's 404 rethrown (the catch removed)
 *       -> 3 failed, "the GET's 404 is a remembered no-data answer" among them
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false tableAvailability
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';

jest.mock('../services/api', () => ({
  isLoggedIn: jest.fn(() => true),
  getTableSummaries: jest.fn(),
  getTableSummary: jest.fn(),
}));

const api = require('../services/api');
const lib = require('../lib/tableSummaries');
const {
  TABLE_PARTY_DEFAULT,
  TABLE_SUMMARY_FRESH_MS,
  TABLE_SUMMARY_BATCH_MAX,
  clampParty,
  tablePartyFor,
  tablePartyForFlockId,
  flockTablePlaceIds,
  distinctPlaceIds,
  requestTableSummaries,
  requestTableSummary,
  readTableSummary,
  readTableSummaries,
  useTableSummaries,
  useTableSummary,
  resetTableSummariesForTests,
  tableSummaryCacheSizeForTests,
  seedTableSummaryForTests,
} = lib;
const TableAvailabilityModule = require('../components/venue/TableAvailability');
const TableAvailability = TableAvailabilityModule.default;
const {
  tableLineText,
  tableCompactText,
  busyRanges,
  busyHoursText,
  hourRangeLabel,
  hourLabel,
} = TableAvailabilityModule;

// The venue's zone is this machine's, so a local Date below is the same wall
// clock on the venue's clock and the "nearest" answers do not move with the
// machine running the suite.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const live = (over = {}) => ({
  open: 3, total: 10, party: 5, fits_now: true, wait_minutes: null, busy_hours: [],
  timeZone: ZONE, updated_at: '2026-10-23T20:00:00Z', stale: false, ...over,
});

// A Friday at 7:30 PM, so "nearest" has a fixed answer.
const FRIDAY_1930 = new Date(2026, 9, 23, 19, 30, 0, 0);

// Settles the promise chains a flush starts. The chain is a handful of
// `then`s deep and nothing in it waits on a timer once the flush has fired.
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

const noEmDash = (s) => expect(s).not.toMatch(/—/);

beforeEach(() => {
  resetTableSummariesForTests();
  api.isLoggedIn.mockReset();
  api.isLoggedIn.mockReturnValue(true);
  api.getTableSummaries.mockReset();
  api.getTableSummary.mockReset();
});

// ---------------------------------------------------------------------------
// 1. the words
// ---------------------------------------------------------------------------

describe('the live sentence', () => {
  it('a table that fits says so, with the number', () => {
    expect(tableLineText(live(), 5)).toBe('Table for 5 open now');
    expect(tableLineText(live(), 5, true)).toBe('Table for 5 open now');
  });

  it('the compact form drops the number for the default party of two only', () => {
    expect(tableLineText(live({ party: 2 }), 2, true)).toBe('Table open now');
    expect(tableLineText(live({ party: 2 }), 2, false)).toBe('Table for 2 open now');
  });

  it('the compact form keeps the number for any party but two', () => {
    expect(tableLineText(live({ party: 3 }), 3, true)).toBe('Table for 3 open now');
    expect(tableLineText(live({ party: 1 }), 1, true)).toBe('Table for 1 open now');
  });

  it("the party the server judged wins over the caller's", () => {
    expect(tableLineText(live({ party: 6 }), 2)).toBe('Table for 6 open now');
  });

  it("the caller's party stands in when the server sent none", () => {
    expect(tableLineText(live({ party: undefined }), 4)).toBe('Table for 4 open now');
    expect(tableLineText(live({ party: undefined }))).toBe(`Table for ${TABLE_PARTY_DEFAULT} open now`);
  });

  it('a known wait is said as about so many minutes', () => {
    expect(tableLineText(live({ fits_now: false, wait_minutes: 10 }), 5)).toBe('About 10 min for a table for 5');
    expect(tableLineText(live({ fits_now: false, wait_minutes: 7.6 }), 5)).toBe('About 8 min for a table for 5');
    // Compact: the wait and the party, nothing a cut row could lose first.
    expect(tableLineText(live({ fits_now: false, wait_minutes: 10 }), 5, true)).toBe('About 10 min for 5');
    expect(tableLineText(live({ fits_now: false, wait_minutes: 7.6, party: 2 }), 2, true)).toBe('About 8 min for 2');
  });

  it('tables open that the server says do not seat the party are counted, verdict first in the compact form', () => {
    expect(tableLineText(live({ fits_now: false, wait_minutes: null, open: 3 }), 5)).toBe('3 tables open, none seats 5');
    expect(tableLineText(live({ fits_now: false, wait_minutes: null, open: 3 }), 5, true)).toBe('None seats 5, 3 open');
    expect(tableLineText(live({ fits_now: false, wait_minutes: null, open: 12 }), 5, true)).toBe('None seats 5, 12 open');
  });

  it('tables open whose fit for the party is not known are counted with no verdict', () => {
    // fits_now null: the server knows tables are open and not whether any
    // seats the party (no seat count sent, no seating seen yet). The words
    // say what it knows and nothing about what it does not.
    expect(tableLineText(live({ fits_now: null, wait_minutes: null, open: 3 }), 5)).toBe('3 tables open');
    expect(tableLineText(live({ fits_now: null, wait_minutes: null, open: 3 }), 5, true)).toBe('3 tables open');
    expect(tableLineText(live({ fits_now: null, wait_minutes: null, open: 1 }), 5)).toBe('1 table open');
    expect(tableLineText(live({ fits_now: undefined, wait_minutes: null, open: 3 }), 5)).toBe('3 tables open');
    expect(tableLineText(live({ fits_now: null, wait_minutes: null, open: 3 }), 5)).not.toMatch(/seats|for 5/);
  });

  it('one table takes its singular', () => {
    expect(tableLineText(live({ fits_now: false, wait_minutes: null, open: 1 }), 5)).toBe('1 table open, none seats 5');
    expect(tableLineText(live({ fits_now: false, wait_minutes: null, open: 1 }), 5, true)).toBe('None seats 5, 1 open');
    expect(tableLineText(live({ fits_now: null, wait_minutes: null, open: 1 }), 5, true)).toBe('1 table open');
  });

  it('no tables and no wait is said plainly', () => {
    expect(tableLineText(live({ fits_now: false, wait_minutes: null, open: 0 }), 5)).toBe('No tables open right now');
    expect(tableLineText(live({ fits_now: false, wait_minutes: 0, open: 0 }), 5)).toBe('No tables open right now');
    expect(tableLineText(live({ fits_now: null, wait_minutes: null, open: 0 }), 5)).toBe('No tables open right now');
  });

  it('the wait is tried before the open count', () => {
    expect(tableLineText(live({ fits_now: false, wait_minutes: 12, open: 2 }), 5)).toBe('About 12 min for a table for 5');
  });

  it('the compact forms put what the group needs first, so a cut row keeps it', () => {
    // The chat card's text column is about 120px on a 320px phone, roughly
    // twenty characters of this line, and the row ellipsizes from the end.
    const WIDTH = 20;
    const wait = tableLineText(live({ fits_now: false, wait_minutes: 10 }), 5, true);
    const none = tableLineText(live({ fits_now: false, wait_minutes: null, open: 3 }), 5, true);
    const unknown = tableLineText(live({ fits_now: null, wait_minutes: null, open: 3 }), 5, true);
    const fits = tableLineText(live(), 5, true);
    expect(wait.length).toBeLessThanOrEqual(WIDTH);
    expect(none.length).toBeLessThanOrEqual(WIDTH);
    expect(unknown.length).toBeLessThanOrEqual(WIDTH);
    expect(fits.length).toBeLessThanOrEqual(WIDTH);
    // Even the widest values keep the verdict inside the first twenty.
    expect(tableLineText(live({ fits_now: false, wait_minutes: 120, party: 30 }), 30, true).slice(0, WIDTH)).toBe('About 120 min for 30');
    expect(tableLineText(live({ fits_now: false, wait_minutes: null, open: 99, party: 30 }), 30, true).slice(0, WIDTH)).toMatch(/^None seats 30/);
  });

  it('nothing is said from nothing', () => {
    expect(tableLineText(null, 5)).toBeNull();
    expect(tableLineText({}, 5)).toBeNull();
    expect(tableLineText({ party: 5, stale: false }, 5)).toBeNull();
    expect(tableLineText({ fits_now: false, party: 5 }, 5)).toBeNull();
    expect(tableLineText('Table for 5 open now', 5)).toBeNull();
    expect(tableLineText([live()], 5)).toBeNull();
  });

  it('carries no em dash and none of the banned words', () => {
    const all = [
      tableLineText(live(), 5),
      tableLineText(live(), 5, true),
      tableLineText(live({ fits_now: false, wait_minutes: 10 }), 5),
      tableLineText(live({ fits_now: false, wait_minutes: 10 }), 5, true),
      tableLineText(live({ fits_now: false, wait_minutes: null, open: 3 }), 5),
      tableLineText(live({ fits_now: false, wait_minutes: null, open: 3 }), 5, true),
      tableLineText(live({ fits_now: null, wait_minutes: null, open: 3 }), 5),
      tableLineText(live({ fits_now: false, wait_minutes: null, open: 0 }), 5),
      busyHoursText(live({ busy_hours: [{ dow: 5, hour: 20 }, { dow: 5, hour: 21 }] }), 2, FRIDAY_1930),
    ].join(' ');
    noEmDash(all);
    expect(all).not.toMatch(/seamless|effortless|unlock|likely|~/i);
  });
});

// ---------------------------------------------------------------------------
// 2. stale
// ---------------------------------------------------------------------------

describe('a stale sensor', () => {
  const stale = live({ stale: true, busy_hours: [{ dow: 5, hour: 20 }, { dow: 5, hour: 21 }] });

  it('a stale sensor says nothing live', () => {
    expect(tableLineText(stale, 5)).toBeNull();
    expect(tableLineText(live({ stale: true, busy_hours: [] }), 5)).toBeNull();
  });

  it('the compact line falls back to the nearest busy range', () => {
    expect(tableCompactText(stale, 5, FRIDAY_1930)).toBe('Usually full Fri 8 to 10 PM');
    expect(tableCompactText(live({ stale: true, busy_hours: [] }), 5, FRIDAY_1930)).toBeNull();
  });

  it('the compact line takes one range even when there are two', () => {
    const two = live({ stale: true, busy_hours: [{ dow: 5, hour: 20 }, { dow: 6, hour: 21 }] });
    expect(tableCompactText(two, 5, FRIDAY_1930)).toBe('Usually full Fri 8 to 9 PM');
  });

  it('the full form draws the busy hours and an honest caption, no live line', () => {
    jest.useFakeTimers('modern');
    jest.setSystemTime(FRIDAY_1930);
    try {
      render(<TableAvailability summary={stale} party={5} />);
      expect(screen.queryByText(/open now/)).toBeNull();
      expect(screen.getByText('Usually full Fri 8 to 10 PM')).toBeInTheDocument();
      expect(screen.getByText("From the venue's Flux sensor. Not live right now.")).toBeInTheDocument();
      expect(screen.queryByText("Live from the venue's Flux sensor")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a stale sensor with no busy hours draws nothing at all', () => {
    const { container } = render(<TableAvailability summary={live({ stale: true, busy_hours: [] })} party={5} />);
    expect(container.firstChild).toBeNull();
    const compact = render(<TableAvailability summary={live({ stale: true, busy_hours: [] })} party={5} compact />);
    expect(compact.container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. busy hours
// ---------------------------------------------------------------------------

describe('busy hours', () => {
  it('consecutive hours fold into one range per day', () => {
    const ranges = busyRanges([
      { dow: 5, hour: 21 }, { dow: 5, hour: 20 }, { dow: 5, hour: 22 },
      { dow: 6, hour: 20 }, { dow: 6, hour: 22 },
    ], FRIDAY_1930);
    expect(ranges).toEqual([
      { dow: 5, start: 20, end: 23 },
      { dow: 6, start: 20, end: 21 },
      { dow: 6, start: 22, end: 23 },
    ]);
  });

  it('at most two ranges, nearest first', () => {
    // Friday 7:30 PM: Friday 8 PM is half an hour away, Thursday is six days
    // off, Saturday is a day off.
    const s = live({ busy_hours: [{ dow: 4, hour: 20 }, { dow: 6, hour: 20 }, { dow: 5, hour: 20 }] });
    expect(busyHoursText(s, 2, FRIDAY_1930)).toBe('Usually full Fri 8 to 9 PM and Sat 8 to 9 PM');
    expect(busyHoursText(s, 1, FRIDAY_1930)).toBe('Usually full Fri 8 to 9 PM');
  });

  it('a range that is on right now comes first', () => {
    const s = live({ busy_hours: [{ dow: 5, hour: 19 }, { dow: 5, hour: 21 }] });
    expect(busyHoursText(s, 2, FRIDAY_1930)).toBe('Usually full Fri 7 to 8 PM and 9 to 10 PM');
  });

  it('a range already over today is next week and sorts last', () => {
    const s = live({ busy_hours: [{ dow: 5, hour: 12 }, { dow: 0, hour: 12 }] });
    expect(busyHoursText(s, 2, FRIDAY_1930)).toBe('Usually full Sun 12 to 1 PM and Fri 12 to 1 PM');
  });

  it('the day is said once when both ranges share it', () => {
    const s = live({ busy_hours: [{ dow: 5, hour: 20 }, { dow: 5, hour: 23 }] });
    expect(busyHoursText(s, 2, FRIDAY_1930)).toBe('Usually full Fri 8 to 9 PM and 11 PM to 12 AM');
  });

  it('the range label handles noon and midnight', () => {
    expect(hourRangeLabel(20, 22)).toBe('8 to 10 PM');
    expect(hourRangeLabel(11, 13)).toBe('11 AM to 1 PM');
    expect(hourRangeLabel(0, 2)).toBe('12 to 2 AM');
    expect(hourRangeLabel(23, 24)).toBe('11 PM to 12 AM');
    expect(hourRangeLabel(12, 13)).toBe('12 to 1 PM');
    expect(hourLabel(24)).toBe('12 AM');
  });

  it('rows that are not a day and an hour are left out', () => {
    expect(busyRanges([{ dow: 7, hour: 20 }, { dow: 5, hour: 24 }, { dow: '5', hour: 20 }, null, { dow: 5 }], FRIDAY_1930)).toEqual([]);
    expect(busyHoursText(live({ busy_hours: 'Fri' }), 2, FRIDAY_1930)).toBeNull();
    expect(busyHoursText(live({ busy_hours: [] }), 2, FRIDAY_1930)).toBeNull();
  });

  it('a summary with no zone says no busy hours: its hours are UTC, which means nothing to the group', () => {
    const hours = [{ dow: 5, hour: 20 }, { dow: 5, hour: 21 }];
    for (const timeZone of [null, undefined, '', 7]) {
      expect(busyHoursText(live({ busy_hours: hours, timeZone }), 2, FRIDAY_1930)).toBeNull();
      expect(tableCompactText(live({ stale: true, busy_hours: hours, timeZone }), 5, FRIDAY_1930)).toBeNull();
    }
    // The live line still stands; only the pattern is withheld.
    expect(tableCompactText(live({ busy_hours: hours, timeZone: null }), 5, FRIDAY_1930)).toBe('Table for 5 open now');
    expect(tableLineText(live({ busy_hours: hours, timeZone: null }), 5)).toBe('Table for 5 open now');
    // Nothing in the words says UTC either way.
    expect(busyHoursText(live({ busy_hours: hours }), 2, FRIDAY_1930)).toBe('Usually full Fri 8 to 10 PM');
    expect(busyHoursText(live({ busy_hours: hours }), 2, FRIDAY_1930)).not.toMatch(/UTC/);
  });

  it('the full form with no zone draws the live line and its caption, and no busy line', () => {
    const { container } = render(<TableAvailability summary={live({ busy_hours: [{ dow: 5, hour: 21 }], timeZone: null })} party={5} />);
    const lines = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
    expect(lines).toEqual(['Table for 5 open now', "Live from the venue's Flux sensor"]);
    // Stale and no zone: nothing at all, as with no hours.
    const stale = render(<TableAvailability summary={live({ stale: true, busy_hours: [{ dow: 5, hour: 21 }], timeZone: null })} party={5} />);
    expect(stale.container.firstChild).toBeNull();
  });

  it("the nearest range is picked on the venue's clock, not the phone's", () => {
    // 02:30 UTC on Saturday Oct 24: Friday 10:30 PM in New York, Friday 7:30
    // PM in Los Angeles. The same hours read differently on each clock.
    const now = new Date('2026-10-24T02:30:00Z');
    const hours = [{ dow: 5, hour: 20 }, { dow: 5, hour: 21 }, { dow: 5, hour: 23 }];
    // Los Angeles at 7:30 PM: 8 PM is half an hour away.
    expect(busyHoursText(live({ busy_hours: hours, timeZone: 'America/Los_Angeles' }), 2, now)).toBe('Usually full Fri 8 to 10 PM and 11 PM to 12 AM');
    // New York at 10:30 PM: 8 to 10 PM is over, 11 PM is half an hour away.
    expect(busyHoursText(live({ busy_hours: hours, timeZone: 'America/New_York' }), 2, now)).toBe('Usually full Fri 11 PM to 12 AM and 8 to 10 PM');
    // Tokyo, where it is already Saturday morning: Friday is six days off.
    expect(busyHoursText(live({ busy_hours: [...hours, { dow: 6, hour: 12 }], timeZone: 'Asia/Tokyo' }), 1, now)).toBe('Usually full Sat 12 to 1 PM');
    // The ranges themselves, by the same clock.
    expect(busyRanges(hours, now, 'America/New_York')[0]).toEqual({ dow: 5, start: 23, end: 24 });
    expect(busyRanges(hours, now, 'America/Los_Angeles')[0]).toEqual({ dow: 5, start: 20, end: 22 });
  });

  it("a zone this device cannot resolve falls back to the phone's clock for the order and still labels the hours", () => {
    // The hours are on the venue's clock whatever the phone can resolve, so
    // the label is right; only which range comes first is decided locally.
    const s = live({ busy_hours: [{ dow: 5, hour: 20 }, { dow: 6, hour: 20 }], timeZone: 'Mars/Olympus_Mons' });
    expect(busyHoursText(s, 2, FRIDAY_1930)).toBe('Usually full Fri 8 to 9 PM and Sat 8 to 9 PM');
  });

  it('the full form says the live line, then the busy hours, then the source', () => {
    jest.useFakeTimers('modern');
    jest.setSystemTime(FRIDAY_1930);
    try {
      const { container } = render(<TableAvailability summary={live({ busy_hours: [{ dow: 5, hour: 21 }] })} party={5} />);
      const lines = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
      expect(lines).toEqual(['Table for 5 open now', 'Usually full Fri 9 to 10 PM', "Live from the venue's Flux sensor"]);
      noEmDash(container.textContent);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the compact form is one truncating line with no caption', () => {
    const { container } = render(<TableAvailability summary={live()} party={5} compact className="chat-truncate" />);
    const p = container.querySelector('p[data-table-line="compact"]');
    expect(p).not.toBeNull();
    expect(p.textContent).toBe('Table for 5 open now');
    expect(p.className).toBe('chat-truncate');
    expect(p.style.whiteSpace).toBe('nowrap');
    expect(p.style.overflow).toBe('hidden');
    expect(p.style.textOverflow).toBe('ellipsis');
    expect(container.querySelectorAll('p')).toHaveLength(1);
  });

  it('a summary with nothing to say draws nothing in either form', () => {
    expect(render(<TableAvailability summary={null} party={5} />).container.firstChild).toBeNull();
    expect(render(<TableAvailability summary={{ party: 5 }} party={5} compact />).container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3b. the map plate
// ---------------------------------------------------------------------------

describe('the map plate', () => {
  const fs = require('fs');
  const path = require('path');
  const MAP = fs.readFileSync(path.join(__dirname, '..', 'components', 'map', 'MapLibreMapView.js'), 'utf8').replace(/\r\n/g, '\n');

  it('keeps the name and the rating in one row and gives the table line a row of its own', () => {
    // The plate is a column of rows. A plate with no table line has one row
    // and the layout it had before the line existed (measured: identical
    // width, height, clamp and rating position for every pin without a line);
    // only a plate with a line grows a second row. The row flex that used to
    // wrap pushed the rating under any name wider than about 130px.
    expect(MAP).toContain('label.innerHTML = `<span class="mlb-label-main"><span class="mlb-label-name">${escapeHtml(venue.name || \'\')}</span>${ratingHtml}</span>`;');
    const plate = MAP.slice(MAP.indexOf('.mlb-marker-label {'), MAP.indexOf('.mlb-label-name {'));
    expect(plate).toMatch(/display: flex;\s*flex-direction: column;\s*align-items: flex-start;\s*row-gap: 2px;/);
    expect(plate).not.toMatch(/flex-wrap/);
    expect(MAP).not.toMatch(/\.mlb-marker-label \{ flex-wrap: wrap/);
    const main = MAP.slice(MAP.indexOf('.mlb-label-main {'), MAP.indexOf('.mlb-label-name {'));
    expect(main).toMatch(/display: flex;\s*align-items: center;\s*gap: 5px;\s*max-width: 100%;/);
    const tables = MAP.slice(MAP.indexOf('.mlb-label-tables {'));
    const rule = tables.slice(0, tables.indexOf('}'));
    expect(rule).toMatch(/max-width: 100%;/);
    expect(rule).not.toMatch(/flex-basis|166px/);
    expect(rule).toMatch(/white-space: nowrap;\s*overflow: hidden;\s*text-overflow: ellipsis;/);
    // paintTableLine still appends the line to the plate, after the main row.
    expect(MAP).toContain("line.className = 'mlb-label-tables';\n        label.appendChild(line);");
  });
});

// ---------------------------------------------------------------------------
// 3c. the chat and the plan
// ---------------------------------------------------------------------------

describe('the chat and the plan', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
  const CHAT = read('screens', 'ChatDetail.js');
  const PLAN = read('screens', 'FlockDetail.js');
  const CARD = read('components', 'chat', 'cards', 'VenueCardRow.js');

  it('stop asking and drawing once the plan is over, by status or by the night being over', () => {
    const gate = "flock.status === 'completed' || flock.status === 'cancelled' || isNightOver(flock)";
    expect(CHAT).toContain(`const tablesOver = !!flock && (${gate});`);
    expect(CHAT).toContain('useTableSummaries(tablesOver ? [] : flockTablePlaceIds(flock), tableParty)');
    expect(CHAT).toContain("import { isNightOver } from '../lib/planNight';");
    expect(PLAN).toContain(`const tablesOver = !!flock && (${gate});`);
    expect(PLAN).toContain('useTableSummary(tablesOver ? null : (flock?.venueId || null), tableParty)');
    expect(PLAN).toContain("import { isNightOver } from '../lib/planNight';");
  });

  it("the vote row's and the venue card's accessible names carry the table line", () => {
    // Both are aria-labelled controls, and an aria-label replaces the content
    // it wraps; the line drawn inside is read by nobody unless it is in the name.
    expect(CHAT).toContain("import TableAvailability, { tableCompactText } from '../components/venue/TableAvailability';");
    expect(CHAT).toContain('const tableLine = v.place_id && tableSummaries[v.place_id] ? tableCompactText(tableSummaries[v.place_id], tableParty) : null;');
    expect(CHAT).toContain("aria-label={`${v.venue}, ${count} vote${count === 1 ? '' : 's'}${tableLine ? `, ${tableLine}` : ''}`}");
    expect(CARD).toContain('const tableLine = tables ? tableCompactText(tables, tableParty) : null;');
    expect(CARD).toContain("? `${venue.name}${address ? `, ${address}` : ''}${tableLine ? `. ${tableLine}` : ''}. Open the place.`");
    // And the drawn line is not hidden from the tree either.
    expect(CHAT).not.toMatch(/<TableAvailability[^>]*aria-hidden/);
    expect(CARD).not.toMatch(/<TableAvailability[^>]*aria-hidden/);
  });
});

// ---------------------------------------------------------------------------
// 4. the party
// ---------------------------------------------------------------------------

describe('the party', () => {
  it('is two outside a flock and clamps to what the server accepts', () => {
    expect(TABLE_PARTY_DEFAULT).toBe(2);
    expect(clampParty(undefined)).toBe(2);
    expect(clampParty(null)).toBe(2);
    expect(clampParty('x')).toBe(2);
    expect(clampParty(0)).toBe(1);
    expect(clampParty(-3)).toBe(1);
    expect(clampParty(40)).toBe(30);
    expect(clampParty(4.4)).toBe(4);
    expect(clampParty('6')).toBe(6);
  });

  it("is the flock's going count inside one, never below two", () => {
    expect(tablePartyFor({ memberCount: 5 })).toBe(5);
    expect(tablePartyFor({ memberCount: 2 })).toBe(2);
    expect(tablePartyFor({ memberCount: 45 })).toBe(30);
    expect(tablePartyFor({ memberCount: 0 })).toBe(2);
    expect(tablePartyFor({})).toBe(2);
    expect(tablePartyFor(null)).toBe(2);
  });

  it('a flock with only its host accepted is written for two, not one', () => {
    // The host is accepted on creation and the invites are still out, so a
    // going count of one is the planning order, not a party of one.
    expect(tablePartyFor({ memberCount: 1 })).toBe(2);
    expect(tablePartyFor({ memberCount: '1' })).toBe(2);
    expect(tablePartyForFlockId([{ id: 7, memberCount: 1 }], 7)).toBe(2);
    // Discover's own chip is not a flock and may still ask for one.
    expect(clampParty(1)).toBe(1);
  });

  it("follows the flock Discover is picking for, else two", () => {
    const flocks = [{ id: 7, memberCount: 4 }, { id: 9, memberCount: 11 }];
    expect(tablePartyForFlockId(flocks, 9)).toBe(11);
    expect(tablePartyForFlockId(flocks, '7')).toBe(4);
    expect(tablePartyForFlockId(flocks, null)).toBe(2);
    expect(tablePartyForFlockId(flocks, 3)).toBe(2);
    expect(tablePartyForFlockId(undefined, 7)).toBe(2);
  });

  it("a flock's places are its vote rows and its venue cards, once each", () => {
    const flock = {
      votes: [{ venue: 'A', place_id: 'pa' }, { venue: 'B', place_id: null }, { venue: 'C', place_id: 'pc' }],
      messages: [
        { message_type: 'venue_card', venue_data: { place_id: 'pa' } },
        { message_type: 'venue_card', venue_data: { place_id: 'pd' } },
        { message_type: 'venue_card', venue_data: {} },
        { message_type: 'text', text: 'hi' },
      ],
    };
    expect(flockTablePlaceIds(flock)).toEqual(['pa', 'pc', 'pd']);
    expect(flockTablePlaceIds(null)).toEqual([]);
    expect(distinctPlaceIds(['a', 'a', 3, '', null, 'b'])).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 5. the read
// ---------------------------------------------------------------------------

describe('the read', () => {
  beforeEach(() => {
    jest.useFakeTimers('modern');
    jest.setSystemTime(FRIDAY_1930);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const answer = (ids) => Promise.resolve({ summaries: Object.fromEntries(ids.map((id) => [id, live({ party: 5 })])) });

  // Moves the clock, settles what that started, then runs the zero-delay
  // flush a timer that fired in the move will have scheduled. One more
  // millisecond, not zero: the fake clock gives a timer created during a
  // tick a due time of now plus one so it cannot loop, so a zero advance
  // never reaches it. Called inside act, in an act of its own after the
  // render whose effect armed the timer: an effect runs when its act closes,
  // so a clock moved in the same act moves before the effect has scheduled
  // anything.
  const tick = async (ms = 0) => {
    jest.advanceTimersByTime(ms);
    await settle();
    jest.advanceTimersByTime(1);
    await settle();
  };

  it('external place ids are own summary properties, including prototype names', () => {
    for (const id of ['__proto__', 'constructor', 'toString']) seedTableSummaryForTests(id, 5, live());
    const summaries = readTableSummaries(['__proto__', 'constructor', 'toString'], 5);
    expect(Object.keys(summaries)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getPrototypeOf(summaries)).toBe(Object.prototype);
    expect(summaries.__proto__).toEqual(live());
  });

  it('ids asked for in one tick go as one POST, once each', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    const p1 = requestTableSummaries(['a', 'b', 'a'], 5);
    const p2 = requestTableSummaries(['b', 'c'], 5);
    expect(api.getTableSummaries).not.toHaveBeenCalled();
    jest.advanceTimersByTime(0);
    await p1;
    await p2;
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
    expect(api.getTableSummaries).toHaveBeenCalledWith(['a', 'b', 'c'], 5);
    expect(readTableSummary('a', 5)).toEqual(live({ party: 5 }));
    expect(readTableSummaries(['a', 'b', 'c', 'zz'], 5)).toEqual({ a: live({ party: 5 }), b: live({ party: 5 }), c: live({ party: 5 }) });
  });

  it('different parties are different asks', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    const p1 = requestTableSummaries(['a'], 2);
    const p2 = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await Promise.all([p1, p2]);
    expect(api.getTableSummaries).toHaveBeenCalledTimes(2);
    expect(api.getTableSummaries).toHaveBeenCalledWith(['a'], 2);
    expect(api.getTableSummaries).toHaveBeenCalledWith(['a'], 5);
  });

  it('more than fifty ids go as several POSTs', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    const ids = Array.from({ length: 120 }, (_, i) => `p${i}`);
    const p = requestTableSummaries(ids, 5);
    jest.advanceTimersByTime(0);
    await p;
    expect(TABLE_SUMMARY_BATCH_MAX).toBe(50);
    expect(api.getTableSummaries).toHaveBeenCalledTimes(3);
    const sizes = api.getTableSummaries.mock.calls.map(([list]) => list.length);
    expect(sizes).toEqual([50, 50, 20]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    expect(readTableSummary('p119', 5)).toEqual(live({ party: 5 }));
  });

  it('an id the server left out is a remembered no-data answer and draws nothing', async () => {
    api.getTableSummaries.mockImplementation(() => answer(['a']));
    const p = requestTableSummaries(['a', 'b'], 5);
    jest.advanceTimersByTime(0);
    await p;
    expect(readTableSummary('b', 5)).toBeNull();
    expect(readTableSummaries(['a', 'b'], 5)).toEqual({ a: live({ party: 5 }) });
    // Not asked again within the minute: silence is an answer too.
    const again = requestTableSummaries(['b'], 5);
    jest.advanceTimersByTime(0);
    await again;
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
  });

  it('a fresh answer is not asked for again within the minute, and is after it', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    let p = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await p;
    jest.advanceTimersByTime(30 * 1000);
    p = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await p;
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(TABLE_SUMMARY_FRESH_MS);
    p = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await p;
    expect(api.getTableSummaries).toHaveBeenCalledTimes(2);
  });

  it('a timed refresh treats an answer about to turn a minute old as due', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    let p = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await p;
    jest.advanceTimersByTime(TABLE_SUMMARY_FRESH_MS - 1000);
    p = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await p;
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
    p = requestTableSummaries(['a'], 5, { refresh: true });
    jest.advanceTimersByTime(0);
    await p;
    expect(api.getTableSummaries).toHaveBeenCalledTimes(2);
  });

  it('an id already on its way is not asked for twice', async () => {
    const releases = [];
    api.getTableSummaries.mockImplementation((ids) => new Promise((resolve) => {
      releases.push(() => resolve({ summaries: Object.fromEntries(ids.map((id) => [id, live({ party: 5 })])) }));
    }));
    const p1 = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await settle();
    const p2 = requestTableSummaries(['a', 'b'], 5);
    jest.advanceTimersByTime(0);
    await settle();
    expect(api.getTableSummaries).toHaveBeenCalledTimes(2);
    expect(api.getTableSummaries.mock.calls[1][0]).toEqual(['b']);
    releases.forEach((release) => release());
    await settle();
    await p1;
    await p2;
    expect(readTableSummaries(['a', 'b'], 5)).toEqual({ a: live({ party: 5 }), b: live({ party: 5 }) });
  });

  it('a failed POST keeps what was known and asks again next time', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    let p = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await p;
    jest.advanceTimersByTime(TABLE_SUMMARY_FRESH_MS + 1000);
    api.getTableSummaries.mockImplementation(() => Promise.reject(new Error('502')));
    p = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await expect(p).resolves.toBeUndefined();
    expect(readTableSummary('a', 5)).toEqual(live({ party: 5 }));
    p = requestTableSummaries(['a'], 5);
    jest.advanceTimersByTime(0);
    await p;
    expect(api.getTableSummaries).toHaveBeenCalledTimes(3);
  });

  it('an answer older than five minutes is no longer read, and the next batch of writes drops it', async () => {
    api.getTableSummaries.mockImplementation(() => answer(['a']));
    let p = requestTableSummaries(['a', 'left-out'], 5);
    jest.advanceTimersByTime(0);
    await p;
    expect(tableSummaryCacheSizeForTests()).toBe(3); // a, the left-out id, and its no-data memory
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(readTableSummary('a', 5)).toBeUndefined();
    expect(readTableSummaries(['a'], 5)).toEqual({});
    // Still held until something is written; then gone, the no-data memory
    // with it, while the fresh answer stays.
    expect(tableSummaryCacheSizeForTests()).toBe(3);
    api.getTableSummaries.mockImplementation(() => answer(['b']));
    p = requestTableSummaries(['b'], 5);
    jest.advanceTimersByTime(0);
    await p;
    expect(tableSummaryCacheSizeForTests()).toBe(1);
    expect(readTableSummary('b', 5)).toEqual(live({ party: 5 }));
    expect(readTableSummary('left-out', 5)).toBeUndefined();
  });

  it('the GET sweeps too, and a surface showing a place keeps it from being swept', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    api.getTableSummary.mockImplementation(() => Promise.resolve(live({ party: 5 })));
    let p = requestTableSummaries(['old'], 5);
    jest.advanceTimersByTime(0);
    await p;
    // 'shown' is rewritten every minute, as a mounted surface's ids are.
    for (let minute = 0; minute < 6; minute += 1) {
      jest.advanceTimersByTime(TABLE_SUMMARY_FRESH_MS);
      p = requestTableSummaries(['shown'], 5, { refresh: true });
      jest.advanceTimersByTime(0);
      await p;
    }
    expect(readTableSummary('shown', 5)).toEqual(live({ party: 5 }));
    expect(readTableSummary('old', 5)).toBeUndefined();
    await requestTableSummary('detail', 5);
    expect(tableSummaryCacheSizeForTests()).toBe(2); // shown and detail; old is gone
  });

  it("a no-data answer is the place's, not the party's: the GET is not asked again for another party", async () => {
    const notFound = Object.assign(new Error('Not found'), { status: 404 });
    api.getTableSummary.mockImplementation(() => Promise.reject(notFound));
    await requestTableSummary('a', 2);
    expect(readTableSummary('a', 2)).toBeNull();
    // The venue sheet's Group chips: 1 through 7, one GET for all of them.
    for (const party of [1, 3, 4, 5, 6, 7]) await requestTableSummary('a', party);
    expect(api.getTableSummary).toHaveBeenCalledTimes(1);
    expect(readTableSummary('a', 5)).toBeNull();
    expect(readTableSummaries(['a'], 7)).toEqual({});
    // Remembered for the same minute as any answer, then asked once more.
    jest.advanceTimersByTime(TABLE_SUMMARY_FRESH_MS + 1000);
    await requestTableSummary('a', 5);
    expect(api.getTableSummary).toHaveBeenCalledTimes(2);
  });

  it("the POST's silence is the place's too, and is not asked by the GET for another party", async () => {
    api.getTableSummaries.mockImplementation(() => answer(['a']));
    api.getTableSummary.mockImplementation(() => Promise.resolve(live({ party: 5 })));
    const p = requestTableSummaries(['a', 'b'], 2);
    jest.advanceTimersByTime(0);
    await p;
    await requestTableSummary('b', 5);
    expect(api.getTableSummary).not.toHaveBeenCalled();
    expect(readTableSummary('b', 5)).toBeNull();
    // The place that answered is still asked for a party it has not been asked for.
    await requestTableSummary('a', 5);
    expect(api.getTableSummary).toHaveBeenCalledTimes(1);
    expect(api.getTableSummary).toHaveBeenCalledWith('a', 5);
  });

  it('a real answer for the place clears its no-data memory', async () => {
    const notFound = Object.assign(new Error('Not found'), { status: 404 });
    api.getTableSummary.mockImplementation(() => Promise.reject(notFound));
    await requestTableSummary('a', 2);
    jest.advanceTimersByTime(TABLE_SUMMARY_FRESH_MS + 1000);
    api.getTableSummary.mockImplementation(() => Promise.resolve(live({ party: 5 })));
    await requestTableSummary('a', 5);
    expect(readTableSummary('a', 5)).toEqual(live({ party: 5 }));
    // Party two's own answer is the old null, past its minute, so it is asked
    // again rather than held back by a memory the place has outgrown.
    await requestTableSummary('a', 2);
    expect(api.getTableSummary).toHaveBeenCalledTimes(3);
  });

  it('nothing goes out signed out', async () => {
    api.isLoggedIn.mockReturnValue(false);
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    api.getTableSummary.mockImplementation(() => Promise.resolve(live()));
    const p1 = requestTableSummaries(['a'], 5);
    const p2 = requestTableSummary('a', 5);
    jest.advanceTimersByTime(0);
    await Promise.all([p1, p2]);
    expect(api.getTableSummaries).not.toHaveBeenCalled();
    expect(api.getTableSummary).not.toHaveBeenCalled();
    expect(readTableSummary('a', 5)).toBeUndefined();
  });

  it('a mocked api with no readers reads as signed out rather than crashing', async () => {
    const was = { s: api.getTableSummaries, g: api.getTableSummary };
    api.getTableSummaries = undefined;
    api.getTableSummary = undefined;
    try {
      await expect(requestTableSummaries(['a'], 5)).resolves.toBeUndefined();
      await expect(requestTableSummary('a', 5)).resolves.toBeUndefined();
    } finally {
      api.getTableSummaries = was.s;
      api.getTableSummary = was.g;
    }
  });

  it('the GET answers one place and is not asked twice while out', async () => {
    let release;
    api.getTableSummary.mockImplementation(() => new Promise((resolve) => { release = () => resolve(live({ party: 5 })); }));
    const p1 = requestTableSummary('a', 5);
    const p2 = requestTableSummary('a', 5);
    await settle();
    expect(api.getTableSummary).toHaveBeenCalledTimes(1);
    expect(api.getTableSummary).toHaveBeenCalledWith('a', 5);
    release();
    await Promise.all([p1, p2]);
    expect(readTableSummary('a', 5)).toEqual(live({ party: 5 }));
    // And not again within the minute.
    await requestTableSummary('a', 5);
    expect(api.getTableSummary).toHaveBeenCalledTimes(1);
  });

  it("the GET's 404 is a remembered no-data answer", async () => {
    const notFound = Object.assign(new Error('Not found'), { status: 404 });
    api.getTableSummary.mockImplementation(() => Promise.reject(notFound));
    await expect(requestTableSummary('a', 5)).resolves.toBeUndefined();
    expect(readTableSummary('a', 5)).toBeNull();
    await requestTableSummary('a', 5);
    expect(api.getTableSummary).toHaveBeenCalledTimes(1);
  });

  it("the GET's other failures leave the place unknown and ask again", async () => {
    api.getTableSummary.mockImplementation(() => Promise.reject(Object.assign(new Error('bad gateway'), { status: 502 })));
    await expect(requestTableSummary('a', 5)).resolves.toBeUndefined();
    expect(readTableSummary('a', 5)).toBeUndefined();
    await requestTableSummary('a', 5);
    expect(api.getTableSummary).toHaveBeenCalledTimes(2);
  });

  it('the GET asks nothing for a place with no usable id', async () => {
    api.getTableSummary.mockImplementation(() => Promise.resolve(live()));
    await requestTableSummary(null, 5);
    await requestTableSummary('', 5);
    await requestTableSummary(42, 5);
    expect(api.getTableSummary).not.toHaveBeenCalled();
  });

  it('the list hook asks on mount, again each minute, and stops on unmount', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    function List({ ids, party }) {
      const got = useTableSummaries(ids, party);
      return <div data-testid="n">{Object.keys(got).length}</div>;
    }
    const ids = ['a', 'b'];
    let view;
    await act(async () => { view = render(<List ids={ids} party={5} />); });
    expect(screen.getByTestId('n').textContent).toBe('0');
    await act(async () => { await tick(0); });
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
    expect(api.getTableSummaries).toHaveBeenCalledWith(['a', 'b'], 5);
    expect(screen.getByTestId('n').textContent).toBe('2');
    // A re-render with the same places does not restart the minute.
    await act(async () => { view.rerender(<List ids={['a', 'b']} party={5} />); });
    await act(async () => { await tick(0); });
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
    await act(async () => { await tick(TABLE_SUMMARY_FRESH_MS); });
    expect(api.getTableSummaries).toHaveBeenCalledTimes(2);
    await act(async () => { view.unmount(); });
    await act(async () => { await tick(3 * TABLE_SUMMARY_FRESH_MS); });
    expect(api.getTableSummaries).toHaveBeenCalledTimes(2);
  });

  it('a disabled list hook asks nothing and keeps what is cached', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    function List({ enabled }) {
      const got = useTableSummaries(['a'], 5, enabled);
      return <div data-testid="n">{Object.keys(got).length}</div>;
    }
    let view;
    await act(async () => { view = render(<List enabled={false} />); });
    await act(async () => { await tick(0); });
    expect(api.getTableSummaries).not.toHaveBeenCalled();
    await act(async () => { view.rerender(<List enabled />); });
    await act(async () => { await tick(0); });
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('n').textContent).toBe('1');
    await act(async () => { view.rerender(<List enabled={false} />); });
    await act(async () => { await tick(2 * TABLE_SUMMARY_FRESH_MS); });
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('n').textContent).toBe('1');
  });

  it.each(['reject', 'hang'])('mounted availability expires when refreshes %s and returns when the server recovers', async (failure) => {
    api.getTableSummary.mockResolvedValue(live());
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    function Views() {
      const detail = useTableSummary('detail', 5);
      const list = useTableSummaries(['list'], 5);
      return <><span data-testid="detail">{detail ? 'live' : 'none'}</span><span data-testid="list">{list.list ? 'live' : 'none'}</span></>;
    }
    render(<Views />);
    await act(async () => { await tick(0); });
    expect(screen.getByTestId('detail')).toHaveTextContent('live');
    expect(screen.getByTestId('list')).toHaveTextContent('live');
    let recoverDetail;
    let recoverList;
    api.getTableSummary.mockImplementation(() => failure === 'reject'
      ? Promise.reject(new Error('offline')) : new Promise((resolve) => { recoverDetail = resolve; }));
    api.getTableSummaries.mockImplementation(() => failure === 'reject'
      ? Promise.reject(new Error('offline')) : new Promise((resolve) => { recoverList = resolve; }));
    for (let minute = 0; minute < 6; minute += 1) {
      await act(async () => { await tick(TABLE_SUMMARY_FRESH_MS); });
    }
    expect(screen.getByTestId('detail')).toHaveTextContent('none');
    expect(screen.getByTestId('list')).toHaveTextContent('none');
    await act(async () => {
      if (failure === 'hang') {
        recoverDetail(live());
        recoverList({ summaries: { list: live() } });
        await settle();
      } else {
        api.getTableSummary.mockResolvedValue(live());
        api.getTableSummaries.mockImplementation((ids) => answer(ids));
        await tick(TABLE_SUMMARY_FRESH_MS);
      }
    });
    expect(screen.getByTestId('detail')).toHaveTextContent('live');
    expect(screen.getByTestId('list')).toHaveTextContent('live');
  });

  it('two lists showing the same place in one tick share one POST', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    function List({ ids }) {
      const got = useTableSummaries(ids, 5);
      return <span>{Object.keys(got).join(',')}</span>;
    }
    await act(async () => { render(<><List ids={['a', 'b']} /><List ids={['b', 'c']} /></>); });
    await act(async () => { await tick(0); });
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
    expect(api.getTableSummaries).toHaveBeenCalledWith(['a', 'b', 'c'], 5);
  });

  it('the detail hook reads by the GET, refreshes each minute, and draws nothing on a 404', async () => {
    api.getTableSummary.mockImplementation(() => Promise.resolve(live({ party: 5 })));
    function Detail({ id }) {
      const s = useTableSummary(id, 5);
      return <div data-testid="t">{s ? tableLineText(s, 5) : 'none'}</div>;
    }
    let view;
    await act(async () => { view = render(<Detail id="a" />); await settle(); });
    expect(api.getTableSummary).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('t').textContent).toBe('Table for 5 open now');
    await act(async () => { jest.advanceTimersByTime(TABLE_SUMMARY_FRESH_MS); await settle(); });
    expect(api.getTableSummary).toHaveBeenCalledTimes(2);
    api.getTableSummary.mockImplementation(() => Promise.reject(Object.assign(new Error('Not found'), { status: 404 })));
    await act(async () => { view.rerender(<Detail id="b" />); await settle(); });
    expect(screen.getByTestId('t').textContent).toBe('none');
    view.unmount();
    await act(async () => { jest.advanceTimersByTime(3 * TABLE_SUMMARY_FRESH_MS); await settle(); });
    expect(api.getTableSummary).toHaveBeenCalledTimes(3);
  });

  it('a write about other places renders neither hook, and hands the list the same object back', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    api.getTableSummary.mockImplementation(() => Promise.resolve(live({ party: 5 })));
    const listSeen = [];
    const detailSeen = [];
    function List() { listSeen.push(useTableSummaries(['a'], 5)); return null; }
    function Detail() { detailSeen.push(useTableSummary('d', 5)); return null; }
    await act(async () => { render(<><List /><Detail /></>); });
    await act(async () => { await tick(0); });
    const got = listSeen[listSeen.length - 1];
    expect(got).toEqual({ a: live({ party: 5 }) });
    expect(detailSeen[detailSeen.length - 1]).toEqual(live({ party: 5 }));
    const listRenders = listSeen.length;
    const detailRenders = detailSeen.length;
    // Another surface's answers land: a POST for other places, a GET for
    // another venue, and a no-data 404. None of them is about these two.
    await act(async () => {
      const p = requestTableSummaries(['x', 'y'], 5);
      jest.advanceTimersByTime(0);
      await p;
      await requestTableSummary('z', 5);
      api.getTableSummary.mockImplementation(() => Promise.reject(Object.assign(new Error('Not found'), { status: 404 })));
      await requestTableSummary('w', 5);
    });
    expect(readTableSummaries(['x', 'y', 'z'], 5)).toEqual({ x: live({ party: 5 }), y: live({ party: 5 }), z: live({ party: 5 }) });
    expect(listSeen.length).toBe(listRenders);
    expect(detailSeen.length).toBe(detailRenders);
    expect(listSeen[listSeen.length - 1]).toBe(got);
    // Their own minute: a new answer, so a new object, and one render each.
    api.getTableSummary.mockImplementation(() => Promise.resolve(live({ party: 5 })));
    await act(async () => { await tick(TABLE_SUMMARY_FRESH_MS); });
    expect(listSeen.length).toBe(listRenders + 1);
    expect(detailSeen.length).toBe(detailRenders + 1);
    expect(listSeen[listSeen.length - 1]).not.toBe(got);
    expect(listSeen[listSeen.length - 1]).toEqual({ a: live({ party: 5 }) });
  });

  it('a list under another party is not rendered for a write under this one', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    const seen = [];
    function List() { seen.push(useTableSummaries(['a'], 2)); return null; }
    await act(async () => { render(<List />); });
    await act(async () => { await tick(0); });
    const renders = seen.length;
    await act(async () => {
      const p = requestTableSummaries(['a'], 5);
      jest.advanceTimersByTime(0);
      await p;
    });
    expect(api.getTableSummaries).toHaveBeenCalledTimes(2);
    expect(seen.length).toBe(renders);
  });

  it('a parked list does not subscribe: nothing renders it until it is shown again, when it reads the cache fresh', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    const seen = [];
    function List({ enabled }) { seen.push(Object.keys(useTableSummaries(['a'], 5, enabled)).length); return null; }
    let view;
    await act(async () => { view = render(<List enabled={false} />); });
    expect(seen).toEqual([0]);
    // Another surface fetches the parked list's own place.
    await act(async () => {
      const p = requestTableSummaries(['a'], 5);
      jest.advanceTimersByTime(0);
      await p;
    });
    expect(readTableSummary('a', 5)).toEqual(live({ party: 5 }));
    expect(seen).toEqual([0]);
    // Shown again: the render reads the cache, and the answer is fresh, so
    // nothing new is sent.
    await act(async () => { view.rerender(<List enabled />); });
    await act(async () => { await tick(0); });
    expect(seen[seen.length - 1]).toBe(1);
    expect(api.getTableSummaries).toHaveBeenCalledTimes(1);
  });

  it('a write landing between a render and its subscription is read on subscribe, not a minute later', async () => {
    api.getTableSummaries.mockImplementation((ids) => answer(ids));
    api.getTableSummary.mockImplementation(() => Promise.resolve(live({ party: 5 })));
    function List() {
      const got = useTableSummaries(['a'], 5);
      return <div data-testid="n">{Object.keys(got).length}</div>;
    }
    function Detail() {
      const s = useTableSummary('a', 5);
      return <div data-testid="t">{s ? 'yes' : 'no'}</div>;
    }
    // A layout effect runs after the render and before the subscriptions,
    // which are passive effects: the window another surface's answer can
    // land in.
    function Writer() {
      React.useLayoutEffect(() => { seedTableSummaryForTests('a', 5, live({ party: 5 })); }, []);
      return null;
    }
    await act(async () => { render(<><List /><Detail /><Writer /></>); });
    expect(screen.getByTestId('n').textContent).toBe('1');
    expect(screen.getByTestId('t').textContent).toBe('yes');
    // The mount's own asks found the answer fresh, so nothing went out.
    await act(async () => { await tick(0); });
    expect(api.getTableSummaries).not.toHaveBeenCalled();
    expect(api.getTableSummary).not.toHaveBeenCalled();
  });
});
