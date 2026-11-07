// lib/planNight.js: whether a locked-in plan's night is over. The plan screen's
// "How was {venue}?" card and the Nest's "How was it?" chip both read it, so
// the hour it draws is the one thing both must agree on.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test planNight --watchAll=false

import { isNightOver, NIGHT_OVER_AFTER_MS } from '../lib/planNight';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const at = (msFromNow) => new Date(NOW + msFromNow).toISOString();

test('the line is one hour after the plan time', () => {
  expect(NIGHT_OVER_AFTER_MS).toBe(60 * 60 * 1000);
});

test('a confirmed plan is over from exactly an hour after its time', () => {
  expect(isNightOver({ status: 'confirmed', eventTime: at(-NIGHT_OVER_AFTER_MS) }, NOW)).toBe(true);
  expect(isNightOver({ status: 'confirmed', eventTime: at(-NIGHT_OVER_AFTER_MS + 1) }, NOW)).toBe(false);
  expect(isNightOver({ status: 'confirmed', eventTime: at(-20 * 3600 * 1000) }, NOW)).toBe(true);
});

test('the legacy locked status reads the same as confirmed', () => {
  expect(isNightOver({ status: 'locked', eventTime: at(-2 * 3600 * 1000) }, NOW)).toBe(true);
});

test('a plan still being planned, or already ended, is never "over" by this rule', () => {
  for (const status of ['voting', 'planning', 'completed', 'cancelled', undefined]) {
    expect(isNightOver({ status, eventTime: at(-5 * 3600 * 1000) }, NOW)).toBe(false);
  }
});

test('no readable time is no night to be over', () => {
  for (const eventTime of [null, undefined, '', 'not a date']) {
    expect(isNightOver({ status: 'confirmed', eventTime }, NOW)).toBe(false);
  }
  expect(isNightOver(null, NOW)).toBe(false);
});

test('a future plan is not over', () => {
  expect(isNightOver({ status: 'confirmed', eventTime: at(3 * 3600 * 1000) }, NOW)).toBe(false);
});

// The words for the moment a plan's answers stopped counting (the plan
// screen's thanks after the plan window). Every instant is built from local
// fields, so the words are the same in whatever zone the suite runs.
describe('reportWindowWords', () => {
  const { reportWindowWords } = require('../lib/planNight');
  const SAT_NOON = new Date(2026, 10, 7, 12, 0, 0);

  test('noon is noon, other times are hours and minutes', () => {
    expect(reportWindowWords(SAT_NOON, new Date(2026, 10, 7, 13, 5))).toBe('noon today');
    expect(reportWindowWords(new Date(2026, 10, 7, 14, 0), new Date(2026, 10, 7, 15, 0))).toBe('2 PM today');
    expect(reportWindowWords(new Date(2026, 10, 7, 9, 30), new Date(2026, 10, 7, 15, 0))).toBe('9:30 AM today');
  });

  test('a day back is yesterday, a few days back is the weekday, a week back is the date', () => {
    expect(reportWindowWords(SAT_NOON, new Date(2026, 10, 8, 10, 0))).toBe('noon yesterday');
    expect(reportWindowWords(SAT_NOON, new Date(2026, 10, 10, 10, 0))).toBe('noon Saturday');
    expect(reportWindowWords(SAT_NOON, new Date(2026, 10, 16, 10, 0))).toBe('noon Nov 7');
  });

  test('an ISO string reads the same as a Date', () => {
    expect(reportWindowWords(SAT_NOON.toISOString(), new Date(2026, 10, 7, 13, 0))).toBe('noon today');
  });

  test('nothing readable is null, so the caller keeps its other sentence', () => {
    for (const bad of [null, undefined, '', 'not a time']) {
      expect(reportWindowWords(bad)).toBeNull();
    }
  });
});
