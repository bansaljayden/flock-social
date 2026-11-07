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

// When a plan member's "How was it?" answer stops counting, on the phone's
// clock: the moment the Nest stops asking (nestAsksHowItWas). The server's
// rule is backend utils/planReportWindow.js planReportClosesAtMs: noon the day
// after the plan's night on the venue's clock, or 12 hours after the start
// when that is later. Built from local fields, so the words hold in any zone.
describe('howWasItClosesAt', () => {
  const { howWasItClosesAt, HOW_WAS_IT_CLOSE_HOUR, HOW_WAS_IT_FLOOR_MS } = require('../lib/planNight');
  const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);

  test('an evening plan: noon the next day', () => {
    expect(howWasItClosesAt(at(6, 20, 33))).toBe(at(7, 12, 0).getTime());
    expect(howWasItClosesAt(at(6, 23, 59).toISOString())).toBe(at(7, 12, 0).getTime());
  });

  test('a plan after midnight is the night before\'s, and keeps its 12 hours', () => {
    // 2 AM Saturday is Friday's night: its noon is Saturday's, 10 hours in,
    // so the floor wins, as the server's does (a 2 AM plan counts until 2 PM).
    expect(howWasItClosesAt(at(7, 2, 0))).toBe(at(7, 14, 0).getTime());
    expect(howWasItClosesAt(at(7, 3, 59))).toBe(at(7, 15, 59).getTime());
  });

  test('a daytime plan: noon the day after its day', () => {
    expect(howWasItClosesAt(at(7, 4, 0))).toBe(at(8, 12, 0).getTime());
    expect(howWasItClosesAt(at(7, 11, 0))).toBe(at(8, 12, 0).getTime());
  });

  test('nothing readable is no close', () => {
    for (const bad of [null, undefined, '', 'not a date']) expect(howWasItClosesAt(bad)).toBeNull();
  });

  test('the same moment the server stops counting, in this zone, at every half hour of three days', () => {
    // The server reads the venue's zone; a phone at the venue is on it. Here
    // both read the zone the suite runs in, so the two rules must agree on
    // every start, across the 4 AM roll and both sides of midnight.
    const { planReportClosesAtMs, REPORT_CLOSE_HOUR, PLAN_REPORT_FLOOR_MS, NIGHT_ROLL_HOUR } = require('../../../backend/utils/planReportWindow');
    const { NIGHT_ROLL_HOUR: NEST_ROLL_HOUR } = require('../lib/nestTime');
    expect(HOW_WAS_IT_CLOSE_HOUR).toBe(REPORT_CLOSE_HOUR);
    expect(HOW_WAS_IT_FLOOR_MS).toBe(PLAN_REPORT_FLOOR_MS);
    expect(NEST_ROLL_HOUR).toBe(NIGHT_ROLL_HOUR);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(typeof zone).toBe('string');
    const start = at(5, 0, 0).getTime();
    let checked = 0;
    for (let t = start; t < start + 3 * 24 * 3600 * 1000; t += 30 * 60 * 1000) {
      expect([new Date(t).toString(), howWasItClosesAt(new Date(t).toISOString())]).toEqual([new Date(t).toString(), planReportClosesAtMs(t, zone)]);
      checked += 1;
    }
    expect(checked).toBe(144);
  });
});
