/**
 * "THIS WEEKEND" ON A SATURDAY PAST THE HOUR IS SUNDAY, NOT NEXT SATURDAY.
 *
 * resolveEventTime in App.js turns a day chip and an hour chip into the
 * instant a plan is saved at. Its rule for the weekend chip is "already the
 * weekend: keep today unless that hour is behind us". On a Saturday evening
 * with an earlier hour picked, the hour was behind us and the arithmetic
 * added seven days, so the plan landed a week out while Sunday of the same
 * weekend was still ahead. A Sunday past the hour has no weekend day left and
 * still moves to the next Saturday.
 *
 * The two helpers are lifted out of App.js by source and run.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test weekendChipSunday --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

function lift(name) {
  const start = APP.indexOf(`const ${name} = (`);
  expect(start).toBeGreaterThan(-1);
  const end = APP.indexOf('\n};\n', start);
  return APP.slice(start, end + '\n};'.length);
}

// eslint-disable-next-line no-new-func
const resolveEventTime = new Function(`${lift('parseHourChoice')}\n${lift('resolveEventTime')}\nreturn resolveEventTime;`)();

// Saturday 14 and Sunday 15 November 2026, on this machine's clock.
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);
const dayOf = (d) => [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()];

test('Saturday evening, an earlier hour: Sunday of the same weekend', () => {
  expect(dayOf(resolveEventTime('This Weekend', '6 PM', at(14, 20)))).toEqual([2026, 10, 15, 18]);
});

test('Saturday, the hour still ahead: tonight', () => {
  expect(dayOf(resolveEventTime('This Weekend', '9 PM', at(14, 20)))).toEqual([2026, 10, 14, 21]);
});

test('Sunday, the hour still ahead: today; past it: next Saturday', () => {
  expect(dayOf(resolveEventTime('This Weekend', '9 PM', at(15, 20)))).toEqual([2026, 10, 15, 21]);
  expect(dayOf(resolveEventTime('This Weekend', '6 PM', at(15, 20)))).toEqual([2026, 10, 21, 18]);
});

test('a weekday: the coming Saturday', () => {
  expect(dayOf(resolveEventTime('This Weekend', '9 PM', at(11, 10)))).toEqual([2026, 10, 14, 21]);
});
