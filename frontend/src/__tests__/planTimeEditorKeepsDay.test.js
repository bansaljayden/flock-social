// Changing a plan's HOUR must not move its DAY. The editor's day chips are
// relative words, and opening it used to set 'Tonight' unconditionally, so
// a host who changed a Saturday plan from 9 PM to 10 PM moved it to today
// for everybody. When no chip lands on the plan's own day, the day itself
// is the chip and resolves to that date at the chosen hour.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'screens', 'FlockDetail.js'), 'utf8');

test('opening the editor picks the chip that lands on the plan\'s own day', () => {
  expect(src).toMatch(/setTimeEditDay\(dayChipFor\(resolveEventTime, FLOCK_DAY_CHOICES, when, hourLabel\)\);/);
  expect(src).not.toMatch(/\n\s+setTimeEditDay\('Tonight'\);\n\s+setShowTimeEditor\(true\);/);
});

test('a plan on no relative day gets its own date as a chip, and it resolves to that date', () => {
  expect(src).toMatch(/\[\.\.\.FLOCK_DAY_CHOICES, \.\.\.\(isDateKey\(timeEditDay\) \? \[timeEditDay\] : \[\]\)\]\.map/);
  expect(src).toMatch(/const chosen = resolveEditTime\(resolveEventTime, timeEditDay, timeEditHour\);[\s\S]{0,500}?saveFlockEventTime\(flock\.id, chosen\.toISOString\(\)\)/);
  expect(src).not.toMatch(/resolveEventTime\(timeEditDay, timeEditHour\)/);
});

test('the helpers behave', () => {
  // Pull the helper block out and evaluate it: pure functions, no React.
  const start = src.indexOf('const DATE_KEY_RE');
  const end = src.indexOf('const dayChipFor');
  const endOfChip = src.indexOf('};', end) + 2;
  const block = src.slice(start, endOfChip);
  // eslint-disable-next-line no-new-func
  const api = new Function(`${block}; return { isDateKey, dateKeyOf, resolveEditTime, dayChipLabel, dayChipFor, hourOfChoice };`)();
  expect(api.isDateKey('2026-09-12')).toBe(true);
  expect(api.isDateKey('Tonight')).toBe(false);
  const d = api.resolveEditTime(() => { throw new Error('not called'); }, '2026-09-12', '10 PM');
  expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 12, 22]);
  // a plan sitting on 'Tomorrow' picks that chip; one two weeks out gets its date
  const now = new Date(2026, 8, 3, 12, 0, 0);
  const resolve = (day, hour) => {
    const h = api.hourOfChoice(hour);
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0);
    if (day === 'Tomorrow') t.setDate(t.getDate() + 1);
    if (day === 'Next Week') t.setDate(t.getDate() + 7);
    return t;
  };
  expect(api.dayChipFor(resolve, ['Tonight', 'Tomorrow', 'Next Week'], new Date(2026, 8, 4, 21), '9 PM')).toBe('Tomorrow');
  expect(api.dayChipFor(resolve, ['Tonight', 'Tomorrow', 'Next Week'], new Date(2026, 8, 19, 21), '9 PM')).toBe('2026-09-19');
  expect(api.dayChipLabel('Tonight')).toBe('Tonight');
  expect(api.dayChipLabel('2026-09-19')).toMatch(/Sep 19/);
});
