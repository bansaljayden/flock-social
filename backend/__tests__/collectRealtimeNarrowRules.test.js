'use strict';
// ---------------------------------------------------------------------------
// NARROWER OPEN-HOURS RULES (2026-10-31). The hourly sweep calls a venue when
// its weekly curve is busy within two hours of the local hour on ANY day, a
// rule measured on 1,198 live readings in September. Over a third of today's
// calls come back with no live reading, so every run now counts, on its own
// calls, what three narrower rules would have skipped and how many live
// readings those skips would have cost. Pinned here, with no database:
//   * weekDayMasks turns weekly slots (day_of_week * 24 + hour) into seven
//     day masks, Sunday first, and ignores anything outside the week;
//   * narrowRuleCalls answers each rule for one local day and hour, with a
//     same-weekday band running across midnight into the next or previous day
//     and across the week's end;
//   * the tally counts calls and live readings apart for the main scope and
//     the fill, leaves venues without day masks out, and prints nothing when
//     it counted nothing;
//   * run() fills the masks from the open-hours query, counts at the call and
//     at the live write, and cannot fail a call by counting.
// The masks' query is pinned against a real Postgres in mlOpenHoursSkip.test.js.
//
// HOW TO RUN
//   cd backend && node --test __tests__/collectRealtimeNarrowRules.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Nothing here may reach a real service (collectRealtimeFillCities.test.js).
process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/none';
process.env.PGSSLMODE = 'disable';
process.env.BESTTIME_API_KEY = '';

const {
  NARROWER_OPEN_HOUR_RULES, weekDayMasks, narrowRuleCalls, createNarrowRuleTally,
} = require('../scripts/ml/collectRealtime');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectRealtime.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const SUN = 0;
const MON = 1;
const TUE = 2;
const FRI = 5;
const SAT = 6;
const slot = (day, hour) => day * 24 + hour;
const [DAY1, DAY2, WEEK1] = NARROWER_OPEN_HOUR_RULES;

test('the three rules counted are the same weekday within one and two hours, and any weekday within one', () => {
  assert.deepStrictEqual(NARROWER_OPEN_HOUR_RULES.map(({ label, sameDay, pad }) => ({ label, sameDay, pad })), [
    { label: 'same weekday +/-1h', sameDay: true, pad: 1 },
    { label: 'same weekday +/-2h', sameDay: true, pad: 2 },
    { label: 'week-wide +/-1h', sameDay: false, pad: 1 },
  ]);
});

test('weekDayMasks: one mask per weekday from Sunday, and nothing outside the week', () => {
  const days = weekDayMasks([slot(FRI, 22), slot(FRI, 23), slot(SUN, 1), '30', 167, 168, -1, 2.5, 'x']);
  assert.strictEqual(days.length, 7);
  assert.strictEqual(days[FRI], (1 << 22) | (1 << 23));
  assert.strictEqual(days[SUN], 1 << 1);
  assert.strictEqual(days[MON], 1 << 6, 'slot 30 is Monday 06:00');
  assert.strictEqual(days[SAT], 1 << 23, 'slot 167 is Saturday 23:00');
  assert.deepStrictEqual(weekDayMasks(null), [0, 0, 0, 0, 0, 0, 0]);
  // array_agg keeps NULLs, and a NULL is not Sunday midnight.
  assert.deepStrictEqual(weekDayMasks([null, undefined]), [0, 0, 0, 0, 0, 0, 0]);
});

test('a late Friday bar: the narrow rules skip it on a Tuesday night, the week-wide one does not', () => {
  // Busy 22:00-23:00 on Fridays only. The current rule calls it from 20:00
  // to 01:00 on every night of the week.
  const bar = weekDayMasks([slot(FRI, 22), slot(FRI, 23)]);
  // Tuesday 22:00: no Friday in band.
  assert.strictEqual(narrowRuleCalls(bar, TUE, 22, DAY1), false);
  assert.strictEqual(narrowRuleCalls(bar, TUE, 22, DAY2), false);
  assert.strictEqual(narrowRuleCalls(bar, TUE, 22, WEEK1), true, 'any weekday at 22:00 is busy');
  // Friday 21:00: in band for every rule.
  for (const rule of NARROWER_OPEN_HOUR_RULES) assert.strictEqual(narrowRuleCalls(bar, FRI, 21, rule), true);
  // Friday 20:00 is two hours early: only the two-hour band reaches it.
  assert.strictEqual(narrowRuleCalls(bar, FRI, 20, DAY1), false);
  assert.strictEqual(narrowRuleCalls(bar, FRI, 20, DAY2), true);
  assert.strictEqual(narrowRuleCalls(bar, FRI, 20, WEEK1), false);
});

test('the same-weekday band runs across midnight and across the end of the week', () => {
  const lateFriday = weekDayMasks([slot(FRI, 23)]);
  assert.strictEqual(narrowRuleCalls(lateFriday, SAT, 0, DAY1), true, 'Friday 23:00 is an hour before Saturday 00:00');
  assert.strictEqual(narrowRuleCalls(lateFriday, SAT, 1, DAY1), false);
  assert.strictEqual(narrowRuleCalls(lateFriday, SAT, 1, DAY2), true);
  const lateSaturday = weekDayMasks([slot(SAT, 23)]);
  assert.strictEqual(narrowRuleCalls(lateSaturday, SUN, 0, DAY1), true, 'Saturday 23:00 is an hour before Sunday 00:00');
  const earlySunday = weekDayMasks([slot(SUN, 0)]);
  assert.strictEqual(narrowRuleCalls(earlySunday, SAT, 23, DAY1), true, 'and Sunday 00:00 an hour after Saturday 23:00');
  // The week-wide band wraps the clock, not the week: 23:00 is in band at 01:00.
  assert.strictEqual(narrowRuleCalls(lateFriday, MON, 0, WEEK1), true);
  assert.strictEqual(narrowRuleCalls(lateFriday, MON, 1, WEEK1), false);
  // A curve of zeros is never in band.
  for (const rule of NARROWER_OPEN_HOUR_RULES) {
    assert.strictEqual(narrowRuleCalls(weekDayMasks([]), FRI, 22, rule), false);
  }
});

test('the tally counts calls and live readings apart for the main scope and the fill, and only for judged venues', () => {
  const weekDays = new Map([
    [1, weekDayMasks([slot(FRI, 22), slot(FRI, 23)])], // philly, a Friday bar
    [2, weekDayMasks([slot(TUE, 22)])], // philly, busy now
    [3, weekDayMasks([slot(FRI, 22)])], // seoul, fill
  ]);
  const tally = createNarrowRuleTally(weekDays, new Set(['seoul']));
  const tueNight = { dayOfWeek: TUE, hour: 22 };
  const philly = (id) => ({ id, city: 'philly' });
  tally.onCall(philly(1), tueNight);
  tally.onCall(philly(2), tueNight);
  tally.onLive(philly(2), tueNight);
  tally.onCall({ id: 3, city: 'seoul' }, tueNight);
  tally.onLive({ id: 3, city: 'seoul' }, tueNight);
  // No masks (no full curve): every rule calls it, so it is not counted at all.
  tally.onCall(philly(4), tueNight);
  tally.onLive(philly(4), tueNight);
  // A reading with no clock is not counted either.
  tally.onLive(philly(2), undefined);

  const { main, fill } = tally.scopes;
  assert.deepStrictEqual({ calls: main.calls, live: main.live }, { calls: 2, live: 1 });
  // Venue 1 (Friday only) is skipped by both same-weekday rules; venue 2 by none.
  assert.deepStrictEqual(main.rules, [{ calls: 1, live: 0 }, { calls: 1, live: 0 }, { calls: 0, live: 0 }]);
  // Venue 3 was live on a Tuesday though its curve says Friday: the reading
  // the same-weekday rules would have cost, which is what this counts.
  assert.deepStrictEqual({ calls: fill.calls, live: fill.live }, { calls: 1, live: 1 });
  assert.deepStrictEqual(fill.rules, [{ calls: 1, live: 1 }, { calls: 1, live: 1 }, { calls: 0, live: 0 }]);
  assert.strictEqual(tally.line(),
    '[ML:Realtime] Narrower open-hours rules on this run\'s calls to venues with a full curve '
    + '(calls each would not have made, live readings among them): '
    + 'main scope, 2 calls (1 live): same weekday +/-1h 1 (0 live), same weekday +/-2h 1 (0 live), '
    + 'week-wide +/-1h 0 (0 live); '
    + 'fill, 1 calls (1 live): same weekday +/-1h 1 (1 live), same weekday +/-2h 1 (1 live), '
    + 'week-wide +/-1h 0 (0 live).');
});

test('a tally that counted nothing prints nothing, and a run with no fill prints no fill part', () => {
  assert.strictEqual(createNarrowRuleTally(new Map()).line(), null);
  const tally = createNarrowRuleTally(new Map([[7, weekDayMasks([slot(MON, 9)])]]));
  tally.onCall({ id: 7, city: 'philly' }, { dayOfWeek: MON, hour: 9 });
  assert.match(tally.line(), /: main scope, 1 calls \(0 live\): same weekday \+\/-1h 0 \(0 live\), .*week-wide \+\/-1h 0 \(0 live\)\.$/);
  assert.ok(!/fill,/.test(tally.line()));
});

test('run() fills the masks from the open-hours query and counts at the call and at the live write, never failing either', () => {
  assert.match(SRC, /const weekDays = new Map\(\);/);
  assert.match(SRC, /openHourMasks = await loadOpenHourMasks\(queryScope, \{ weekDays \}\);/);
  // A failed lookup leaves nothing half-filled to count against.
  assert.match(SRC, /openHourMasks = new Map\(\);\n {6}weekDays\.clear\(\);/);
  assert.match(SRC, /const narrowTally = createNarrowRuleTally\(weekDays, fillSet\);/);
  assert.match(SRC, /const countNarrow = \(fn\) => \{ try \{ fn\(\); \} catch \(_\) \{ \/\* a count, nothing more \*\/ \} \};/);
  // At the call, on the venue's own clock at that moment.
  assert.match(SRC, /countNarrow\(\(\) => \{\n {8}const venue = venueOfVendorId\.get\(vendorId\);\n {8}if \(venue\) narrowTally\.onCall\(venue, getLocalTime\(venue\.timezone \|\| CITIES\[venue\.city\]\.tz, new Date\(\)\)\);\n {6}\}\);\n {6}return fetchLiveBusyness\(vendorId\);/);
  // At the live write, on the clock the row itself is filed under.
  assert.match(SRC, /if \(outcome === LABEL_LIVE\) \{\n {8}tally\(venue\.city, 'live'\);\n {8}countNarrow\(\(\) => narrowTally\.onLive\(venue, at\.obs\)\);\n {6}\}/);
  assert.match(SRC, /const narrowLine = narrowTally\.line\(\);\n {2}if \(narrowLine\) console\.log\(narrowLine\);/);
  // The busy slots ride the open-hours query, only when asked for.
  assert.match(SRC, /\+ \(weekDays \? `,\n {12}array_agg\(t\.day_of_week \* 24 \+ t\.hour\) FILTER \(WHERE t\.busyness_pct > 0\) AS busy_slots` : ''\)/);
  assert.match(SRC, /if \(weekDays\) weekDays\.set\(row\.venue_id, weekDayMasks\(row\.busy_slots \|\| \[\]\)\);/);
});
