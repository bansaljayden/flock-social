import { localeTime, localeDate, localeDateTime } from '../lib/localeFormat';

// The cached formatters must give exactly the text the Date methods give, for
// every option shape the app passes and for the bare calls, or a timestamp
// somewhere changes under a performance change.
const DATES = [new Date(2026, 9, 13, 9, 5, 7), new Date(2026, 0, 1, 23, 59, 0), new Date(2025, 6, 4, 0, 0, 0)];
const OPTIONS = [
  undefined,
  { hour: 'numeric', minute: '2-digit' },
  { hour: 'numeric' },
  { weekday: 'long' },
  { weekday: 'short' },
  { month: 'short', day: 'numeric' },
  { month: 'long', day: 'numeric' },
  { weekday: 'short', month: 'short', day: 'numeric' },
  { weekday: 'long', month: 'short', day: 'numeric' },
  { weekday: 'short', hour: 'numeric', minute: '2-digit' },
  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
];
const LOCALES = [[], 'en-US', undefined];

describe('localeFormat matches the Date methods', () => {
  for (const locales of LOCALES) {
    for (const options of OPTIONS) {
      test(`${JSON.stringify(locales)} ${JSON.stringify(options)}`, () => {
        for (const d of DATES) {
          expect(localeTime(d, locales, options)).toBe(d.toLocaleTimeString(locales, options));
          expect(localeDate(d, locales, options)).toBe(d.toLocaleDateString(locales, options));
          expect(localeDateTime(d, locales, options)).toBe(d.toLocaleString(locales, options));
        }
      });
    }
  }

  test('accepts a timestamp or a string, as new Date would', () => {
    const d = DATES[0];
    expect(localeTime(d.getTime(), [], OPTIONS[1])).toBe(d.toLocaleTimeString([], OPTIONS[1]));
    expect(localeDate(d.toISOString(), [], OPTIONS[5])).toBe(d.toLocaleDateString([], OPTIONS[5]));
  });

  test('an invalid date reads as the methods read it instead of throwing', () => {
    expect(localeTime('nope', [], OPTIONS[1])).toBe(new Date('nope').toLocaleTimeString([], OPTIONS[1]));
    expect(localeDate(NaN, [], OPTIONS[5])).toBe('Invalid Date');
  });
});
