/**
 * THE NEST'S CLOCK (lib/nestTime.js), run at its edges.
 *
 * The home tab's day ends at 4 AM, the hour the Tonight answer clears, so
 * 12:40 AM on Saturday is still Friday night. Every date below is built from
 * local fields, so the cases hold in any time zone the suite runs in; the
 * clock-change cases are real changes in America/New_York and plain days
 * elsewhere, and pass either way because the rule is read off the local hour.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestTime --watchAll=false
 */
import { dayLine, nightKey, nightsBetween, nightWeekday, NIGHT_ROLL_HOUR } from '../lib/nestTime';

// 2026-11-06 is a Friday.
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);

describe('dayLine', () => {
  test.each([
    [6, 3, 59, 'Thursday night'],
    [6, 4, 0, 'Friday morning'],
    [6, 11, 59, 'Friday morning'],
    [6, 12, 0, 'Friday afternoon'],
    [6, 16, 59, 'Friday afternoon'],
    [6, 17, 0, 'Friday evening'],
    [6, 21, 59, 'Friday evening'],
    [6, 22, 0, 'Friday night'],
    [7, 0, 40, 'Friday night'],
    [7, 3, 59, 'Friday night'],
    [7, 4, 0, 'Saturday morning'],
  ])('Nov %i %i:%i reads %s', (day, h, m, want) => {
    expect(dayLine(at(day, h, m))).toBe(want);
  });

  test('rolls at the same hour the Tonight answer clears', () => {
    expect(NIGHT_ROLL_HOUR).toBe(4);
  });

  test('across the 2026-11-01 clock change, the night is still the calendar one', () => {
    // US clocks went back at 2:00 AM on Sunday 2026-11-01: 1:30 AM happened
    // twice that night, and both are Saturday night.
    expect(dayLine(new Date(2026, 10, 1, 1, 30))).toBe('Saturday night');
    expect(dayLine(new Date(2026, 10, 1, 3, 59))).toBe('Saturday night');
    expect(dayLine(new Date(2026, 10, 1, 4, 0))).toBe('Sunday morning');
    expect(nightsBetween(new Date(2026, 9, 31, 20, 0), new Date(2026, 10, 1, 20, 0))).toBe(1);
  });

  test('and across the spring change, 4:30 AM is already the new day', () => {
    // US clocks went forward at 2:00 AM on 2026-03-08. Four hours of
    // milliseconds before 4:30 AM that morning is 11:30 PM the night before,
    // which is why the roll reads the local hour instead.
    expect(dayLine(new Date(2026, 2, 8, 4, 30))).toBe('Sunday morning');
    expect(nightKey(new Date(2026, 2, 8, 4, 30))).toBe('2026-03-08');
  });

  test('says nothing for a value that is not a date', () => {
    expect(dayLine('not a date')).toBe('');
  });
});

describe('nightKey and nightsBetween', () => {
  test('a plan after midnight belongs to the night before', () => {
    expect(nightKey(at(7, 0, 40))).toBe('2026-11-06');
    expect(nightKey(at(7, 4, 0))).toBe('2026-11-07');
    expect(nightWeekday(at(7, 1, 0))).toBe('Friday');
  });

  test('counts nights, not 24-hour spans', () => {
    expect(nightsBetween(at(6, 19, 12), at(6, 23, 0))).toBe(0);
    expect(nightsBetween(at(6, 19, 12), at(7, 1, 0))).toBe(0);
    expect(nightsBetween(at(6, 19, 12), at(7, 11, 0))).toBe(1);
    expect(nightsBetween(at(7, 0, 40), at(7, 19, 0))).toBe(1);
    expect(nightsBetween(at(6, 19, 12), at(8, 11, 0))).toBe(2);
    expect(nightsBetween(at(6, 19, 12), at(5, 20, 0))).toBe(-1);
  });

  test('null in, null out', () => {
    expect(nightKey(null)).toBeNull();
    expect(nightsBetween(null, at(6, 1))).toBeNull();
  });
});
