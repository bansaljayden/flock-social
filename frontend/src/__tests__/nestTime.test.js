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

describe('comingGroups, stillOpen, showComingLabels and cardTime', () => {
  const { comingGroups, stillOpen, showComingLabels, cardTime } = require('../lib/nestTime');
  const FRI = at(6, 19, 12);
  const f = (id, when, extra = {}) => ({ id, eventTime: when ? when.toISOString() : null, ...extra });
  const plain = (s) => String(s).replace(/[\u202f\u00a0]/g, ' ');

  test('a partition of the list in its own order, empty bands left out; past nights are Still open, not coming up', () => {
    const list = [
      f(1, at(7, 19, 0)),
      f(2, at(8, 11, 0)),
      f(3, at(13, 20, 0)),
      f(4, null),
      f(5, at(5, 20, 0)),
      f(6, at(6, 18, 0), { timePassed: true }),
      f(7, at(9, 9, 0)),
    ];
    const groups = comingGroups(list, FRI);
    expect(groups.map((g) => [g.label, g.flocks.map((x) => x.id)])).toEqual([
      ['Tomorrow', [1]],
      ['This week', [2, 7]],
      ['Later', [3]],
      ['No date yet', [4]],
    ]);
    // "Earlier" sat under the heading "Coming up", past plans under a word
    // for what is ahead. They are their own band after it.
    expect(groups.map((g) => g.label)).not.toContain('Earlier');
    expect(stillOpen(list, FRI).map((x) => x.id)).toEqual([5, 6]);
    // Every plan lands in exactly one place.
    expect(groups.reduce((n, g) => n + g.flocks.length, 0) + stillOpen(list, FRI).length).toBe(list.length);
  });

  test('band labels only when a band holds two or more plans, or there are four or more in all', () => {
    // Three labels each over one card made two levels of heading for three
    // plans.
    const one = (label, n) => ({ label, flocks: Array.from({ length: n }, (_, i) => f(i, null)) });
    expect(showComingLabels([one('Tomorrow', 1), one('This week', 1), one('Later', 1)])).toBe(false);
    expect(showComingLabels([one('Tomorrow', 1)])).toBe(false);
    expect(showComingLabels([one('This week', 2)])).toBe(true);
    expect(showComingLabels([one('Tomorrow', 1), one('This week', 1), one('Later', 1), one('No date yet', 1)])).toBe(true);
    expect(showComingLabels([])).toBe(false);
  });

  test('with no label over it, a card says its whole day in the rows\' own words', () => {
    expect(plain(cardTime(at(7, 19, 0), 'Tomorrow', FRI, { labelled: false }))).toBe('Tomorrow 7:00 PM');
    expect(plain(cardTime(at(8, 11, 0), 'This week', FRI, { labelled: false }))).toBe('Sun 11:00 AM');
    expect(plain(cardTime(at(21, 20, 0), 'Later', FRI, { labelled: false }))).toBe('Nov 21, 8:00 PM');
  });

  test('a plan after midnight is still that night', () => {
    expect(comingGroups([f(1, at(8, 1, 0))], FRI)[0].label).toBe('Tomorrow');
  });

  test('the card time is short where the band already says the day', () => {
    expect(plain(cardTime(at(7, 19, 0), 'Tomorrow', FRI))).toBe('7:00 PM');
    expect(plain(cardTime(at(8, 11, 0), 'This week', FRI))).toBe('Sun 11:00 AM');
    expect(plain(cardTime(at(21, 20, 0), 'Later', FRI))).toBe('Nov 21, 8:00 PM');
    expect(cardTime(null, 'No date yet', FRI)).toBe('');
  });

  test("a Still open card says which night in the rows' own words, never a weekday weeks old", () => {
    expect(plain(cardTime(at(5, 20, 0), 'Earlier', FRI))).toBe('Last night 8:00 PM');
    expect(plain(cardTime(at(4, 11, 0), 'Earlier', FRI))).toBe('Nov 4, 11:00 AM');
    expect(plain(cardTime(at(1, 20, 0), 'Earlier', at(20, 19, 0)))).toBe('Nov 1, 8:00 PM');
  });
});

// "How busy is The Copper Finch at 11:33 / PM?": a time broke across two lines
// at 390, its PM alone on the second. Every time the Nest writes keeps its
// figures and its AM or PM together (a narrow no-break space, the one iOS's
// own clock uses), and a month keeps its day (a no-break space).
describe('a time never breaks from its AM or PM', () => {
  const { whenLine, alsoLine, shortWhen, cardTime, clockTime } = require('../lib/nestTime');
  const FRI = at(6, 19, 12);
  const breakable = /[0-9] (AM|PM)|[A-Z][a-z]{2} [0-9]/;

  test.each([
    ['whenLine tonight', () => whenLine(at(6, 23, 33), FRI)],
    ['whenLine far out', () => whenLine(at(21, 20, 0), FRI)],
    ['alsoLine', () => alsoLine(at(6, 20, 0), FRI)],
    ['shortWhen this week', () => shortWhen(at(8, 11, 0), FRI)],
    ['shortWhen later', () => shortWhen(at(21, 20, 0), FRI)],
    ['cardTime later', () => cardTime(at(21, 20, 0), 'Later', FRI)],
    ['clockTime', () => clockTime(at(6, 23, 33))],
  ])('%s', (_, run) => {
    const s = run();
    expect(s).toMatch(/[0-9]\u202f(AM|PM)/);
    expect(s).not.toMatch(breakable);
  });
});

// One plan, one way of saying when, below the hero: the Needs you rows and the
// Coming up cards both say "Sun 11:00 AM", where the rows said "Sunday at
// 11:00 AM" over a card that said "Sun 11:00 AM", and at 320 the long form
// took every row to three or four lines. The sentence form stays in the hero.
describe('shortWhen', () => {
  const { shortWhen } = require('../lib/nestTime');
  const FRI = at(6, 19, 12);
  const plain = (s) => String(s).replace(/[\u202f\u00a0]/g, ' ');

  test.each([
    [at(6, 20, 33), 'Tonight 8:33 PM'],
    [at(6, 19, 0), 'Started 7:00 PM'],
    [at(7, 19, 0), 'Tomorrow 7:00 PM'],
    [at(8, 11, 0), 'Sun 11:00 AM'],
    [at(12, 22, 19), 'Thu 10:19 PM'],
    [at(15, 22, 19), 'Nov 15, 10:19 PM'],
    [at(5, 20, 0), 'Last night 8:00 PM'],
    [at(5, 11, 0), 'Yesterday 11:00 AM'],
  ])('%s from Friday 7:12 PM reads %s', (t, want) => {
    expect(plain(shortWhen(t, FRI))).toBe(want);
  });

  test('a morning plan the same day is Today', () => {
    expect(plain(shortWhen(at(6, 11, 0), at(6, 9, 0)))).toBe('Today 11:00 AM');
  });

  test('no time, no words', () => {
    expect(shortWhen(null, FRI)).toBe('');
  });
});
