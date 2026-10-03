/**
 * A crowd reading that changes nothing hands the map the same venue list
 * (app audit 2026-10-03). Every pin tap and venue sheet re-reads the crowd and
 * wrote prev.map(...) whatever came back, so an identical reading still gave
 * MapLibreMapView a new array and it rebuilt every marker mid-ease.
 * FRONTEND test (jest via react-scripts): the helper is lifted out of App.js
 * and run.
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const start = APP.indexOf('const withVenueCrowd = (list, placeId, score, label) => {');
const end = APP.indexOf('\n};', start);
// eslint-disable-next-line no-new-func
const withVenueCrowd = new Function(`${APP.slice(start, end + 3)}\nreturn withVenueCrowd;`)();

const LIST = [
  { place_id: 'a', crowd: 40, crowdLabel: 'Steady' },
  { place_id: 'b', crowd: 80, crowdLabel: 'Busy' },
];

test('the same reading returns the same list, so no marker is rebuilt', () => {
  expect(withVenueCrowd(LIST, 'a', 40, 'Steady')).toBe(LIST);
  expect(withVenueCrowd(LIST, 'a', 40, null)).toBe(LIST); // a missing label keeps the one shown
  expect(withVenueCrowd(LIST, 'zzz', 10, 'Quiet')).toBe(LIST);
});

test('a new reading replaces only that venue', () => {
  const next = withVenueCrowd(LIST, 'a', 70, 'Busy');
  expect(next).not.toBe(LIST);
  expect(next[0]).toEqual({ place_id: 'a', crowd: 70, crowdLabel: 'Busy' });
  expect(next[1]).toBe(LIST[1]);
});

test('every crowd write to the map goes through it', () => {
  expect(APP).not.toMatch(/setAllVenues\(prev => prev\.map\(v => v\.place_id === /);
  expect((APP.match(/setAllVenues\(prev => withVenueCrowd\(prev, /g) || []).length).toBe(3);
});
