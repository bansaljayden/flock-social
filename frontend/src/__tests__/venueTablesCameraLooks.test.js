/**
 * THE TABLES TAB: CAMERA LOOKS TODAY.
 *
 * GET .../tables/camera-looks answers { day, timeZone, count, looks: [{ at,
 * received_at, look, table, result, found }] }, newest first. This file pins:
 *
 *   - the api.js call asks the path the server serves, with the day only
 *     when one is given;
 *   - an answer is kept only in that shape, anything else is a failure;
 *   - the words of every result, "Whole room" for a room look, "about" for a
 *     look the unit could not time, and the section in every state: loading,
 *     failed, empty, full, and a day longer than the list.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import TablesCameraLooks from '../components/venue/tables/TablesCameraLooks';
import { cameraLookResultText, cameraLookRows, clockIn } from '../lib/venueTables';
import { tableCameraLooksFrom } from '../lib/venueTablesReading';

const COLORS = { navy: '#0d2847' };
const NY = 'America/New_York';

describe('the api call', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('asks the camera-looks path, with ?day only when one is given', async () => {
    const { getSensorTableCameraLooks } = jest.requireActual('../services/api');
    const urls = [];
    global.fetch = jest.fn((url) => {
      urls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ day: '2026-10-27', timeZone: null, count: 0, looks: [] }), text: () => Promise.resolve('{}') });
    });
    await getSensorTableCameraLooks('ChIJ a/b').catch(() => {});
    await getSensorTableCameraLooks('ChIJx', '2026-10-26').catch(() => {});
    expect(urls[0]).toMatch(/\/api\/sensors\/ChIJ%20a%2Fb\/tables\/camera-looks$/);
    expect(urls[1]).toMatch(/\/api\/sensors\/ChIJx\/tables\/camera-looks\?day=2026-10-26$/);
  });
});

test('an answer is kept only in its shape', () => {
  const good = { day: '2026-10-27', timeZone: NY, count: 0, looks: [] };
  expect(tableCameraLooksFrom(good)).toBe(good);
  for (const bad of [undefined, null, [], 'x', { looks: [] }, { count: 1 }, { count: '1', looks: [] }]) {
    expect(tableCameraLooksFrom(bad)).toBeNull();
  }
});

test('every result in plain words', () => {
  expect(cameraLookResultText({ result: 'found', found: 12 })).toBe('Found 12 tables');
  expect(cameraLookResultText({ result: 'found', found: 1 })).toBe('Found 1 table');
  expect(cameraLookResultText({ result: 'clear' })).toBe('Table clear');
  expect(cameraLookResultText({ result: 'dishes' })).toBe('Dishes left');
  expect(cameraLookResultText({ result: 'person' })).toBe('Someone there, dropped');
  expect(cameraLookResultText({ result: 'failed' })).toBe("Didn't work");
  expect(cameraLookResultText({ result: 'photo' })).toBeNull();
});

test('a row is its time on the clock, its target and its result; an untimed look says about', () => {
  const rows = cameraLookRows({
    looks: [
      { at: '2026-10-28T00:15:00.000Z', received_at: '2026-10-28T00:15:20.000Z', look: 'table', table: 4, result: 'dishes', found: null },
      { at: null, received_at: '2026-10-27T23:00:00.000Z', look: 'room', table: null, result: 'found', found: 9 },
    ],
  }, clockIn(NY));
  expect(rows.map((r) => [r.time, r.target, r.result])).toEqual([
    ['8:15 PM', 'Table 4', 'Dishes left'],
    ['about 7:00 PM', 'Whole room', 'Found 9 tables'],
  ]);
});

describe('the section', () => {
  const LOOKS = {
    day: '2026-10-27',
    timeZone: NY,
    count: 3,
    looks: [
      { at: '2026-10-28T00:15:00.000Z', received_at: '2026-10-28T00:15:20.000Z', look: 'table', table: 4, result: 'person', found: null },
      { at: '2026-10-27T23:40:00.000Z', received_at: '2026-10-27T23:40:20.000Z', look: 'table', table: 2, result: 'failed', found: null },
      { at: '2026-10-27T13:00:00.000Z', received_at: '2026-10-27T13:00:20.000Z', look: 'room', table: null, result: 'found', found: 11 },
    ],
  };

  test('loading is a skeleton, a failure says so', () => {
    const { rerender } = render(<TablesCameraLooks looks={undefined} colors={COLORS} timeZone={NY} />);
    expect(screen.getByTestId('tables-camera-looks-loading')).toBeInTheDocument();
    rerender(<TablesCameraLooks looks={null} colors={COLORS} timeZone={NY} />);
    expect(screen.getByText("Camera looks couldn't load.")).toBeInTheDocument();
  });

  test('an empty day says the camera has not looked', () => {
    render(<TablesCameraLooks looks={{ day: '2026-10-27', timeZone: NY, count: 0, looks: [] }} colors={COLORS} timeZone={NY} />);
    expect(screen.getByRole('heading').textContent).toBe('Camera looks today: 0');
    expect(screen.getByText("The camera hasn't looked yet today.")).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  test('a full day: the count, then each look newest first, failures included', () => {
    render(<TablesCameraLooks looks={LOOKS} colors={COLORS} timeZone={NY} />);
    expect(screen.getByRole('heading').textContent).toBe('Camera looks today: 3');
    const items = within(screen.getByRole('list', { name: 'Camera looks' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      '8:15 PMTable 4Someone there, dropped',
      '7:40 PMTable 2Didn\'t work',
      '9:00 AMWhole roomFound 11 tables',
    ]);
    expect(screen.getByText(/No picture is kept\. Times on your venue's clock\./)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  test('a day longer than the list says only the latest are shown; a UTC day says so', () => {
    render(<TablesCameraLooks looks={{ ...LOOKS, timeZone: null, count: 640 }} colors={COLORS} timeZone={null} />);
    expect(screen.getByRole('heading').textContent).toBe('Camera looks today: 640');
    expect(screen.getByText('Showing the latest 3.')).toBeInTheDocument();
    expect(screen.getByText(/The day is in UTC, since your listing has no time zone/)).toBeInTheDocument();
  });
});
