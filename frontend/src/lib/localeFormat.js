// Date and time text through cached Intl.DateTimeFormat instances.
//
// `date.toLocaleTimeString(locales, options)` builds a new Intl.DateTimeFormat
// on every call. That is the expensive half of formatting a date, and the app
// does it per message when a thread is mapped (every message of every plan on
// a list refresh), per row when the conversation list or a thread renders, and
// per cell on the calendar. These three take the same arguments and give the
// same text, building each formatter once per locale and options.
//
// The defaults are the ones the Date methods apply: a time call with no time
// field shows hour, minute and second, a date call with no date field shows
// year, month and day, and toLocaleString with neither shows both. An invalid
// date reads "Invalid Date", as the methods do, where Intl.format would throw.

const cache = new Map();

const TIME_FIELDS = ['hour', 'minute', 'second', 'dayPeriod', 'fractionalSecondDigits', 'timeStyle'];
const DATE_FIELDS = ['weekday', 'year', 'month', 'day', 'dateStyle'];
const has = (options, fields) => !!options && fields.some((f) => options[f] !== undefined);

const formatter = (locales, options) => {
  const key = JSON.stringify([locales === undefined ? null : locales, options]);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locales === null ? undefined : locales, options);
    cache.set(key, f);
  }
  return f;
};

const run = (date, locales, options) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return 'Invalid Date';
  return formatter(locales, options).format(d);
};

export const localeTime = (date, locales, options) => run(date, locales,
  has(options, TIME_FIELDS) ? options : { ...options, hour: 'numeric', minute: 'numeric', second: 'numeric' });

export const localeDate = (date, locales, options) => run(date, locales,
  has(options, DATE_FIELDS) ? options : { ...options, year: 'numeric', month: 'numeric', day: 'numeric' });

export const localeDateTime = (date, locales, options) => run(date, locales,
  has(options, TIME_FIELDS) || has(options, DATE_FIELDS)
    ? options
    : { ...options, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
