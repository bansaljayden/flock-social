/**
 * THE NEST'S CLOCK: which night it is, and how the home tab says a time.
 *
 * The Nest is about tonight, and "tonight" does not end at midnight. A plan
 * at 8:30 PM on Friday is still Friday's plan at 12:40 AM, and the Tonight
 * answer a person gives clears at 4 AM (routes/availability.js), so the whole
 * home tab rolls its day over at 4 AM too. A NIGHT KEY is the calendar date a
 * moment belongs to under that rule: the local date, or the day before for
 * anything from midnight to 3:59.
 *
 * It is read from the local hour, not by subtracting four hours of
 * milliseconds. The two agree on every ordinary day, and they disagree on the
 * two days a year the clocks change: at 4:30 AM on the morning the clocks go
 * forward, four hours ago was 11:30 PM the night before, so a millisecond
 * subtraction would still call it last night.
 *
 * Pure (the one hook aside), so every edge is run in
 * src/__tests__/nestTime.test.js rather than pinned in App.js.
 */
import { useEffect, useState } from 'react';

/** The hour the Nest's day begins. The Tonight answer clears at the same hour. */
export const NIGHT_ROLL_HOUR = 4;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const asDate = (value) => {
  if (value instanceof Date) return value;
  if (value == null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The night a moment belongs to, as local [year, month, day], or null for a
 * value that is not a date. The day before for 00:00-03:59.
 */
function nightParts(value) {
  const d = asDate(value);
  if (!d || Number.isNaN(d.getTime())) return null;
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (d.getHours() < NIGHT_ROLL_HOUR) day.setDate(day.getDate() - 1);
  return [day.getFullYear(), day.getMonth(), day.getDate()];
}

/** The night key, 'YYYY-MM-DD', or null. Sorts as a string. */
export function nightKey(value) {
  const p = nightParts(value);
  if (!p) return null;
  const [y, m, d] = p;
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Whole nights from the night of `from` to the night of `to`: 0 for the same
 * night, 1 for the next, -1 for the one before. Counted on the calendar, so a
 * 23- or 25-hour day is still one night.
 */
export function nightsBetween(from, to) {
  const a = nightParts(from);
  const b = nightParts(to);
  if (!a || !b) return null;
  return Math.round((Date.UTC(b[0], b[1], b[2]) - Date.UTC(a[0], a[1], a[2])) / 86400000);
}

/** The weekday of a moment's night, in the app's own words. */
export function nightWeekday(value) {
  const p = nightParts(value);
  if (!p) return '';
  return WEEKDAYS[new Date(p[0], p[1], p[2]).getDay()];
}

/**
 * The one line over "Hey, {name}": the day and the part of it, which never
 * changes while it is true. 12:40 AM on Saturday is still "Friday night",
 * the night the person is in.
 *
 *   04:00-11:59  "{Weekday} morning"
 *   12:00-16:59  "{Weekday} afternoon"
 *   17:00-21:59  "{Weekday} evening"
 *   22:00-03:59  "{Weekday} night"
 */
export function dayLine(now = new Date()) {
  const d = asDate(now);
  if (!d) return '';
  const h = d.getHours();
  const part = h >= NIGHT_ROLL_HOUR && h < 12 ? 'morning'
    : h >= 12 && h < 17 ? 'afternoon'
      : h >= 17 && h < 22 ? 'evening'
        : 'night';
  return `${nightWeekday(d)} ${part}`;
}

/**
 * A line of text that follows the clock: `read(new Date())`, read again every
 * `everyMs`, with state set only when the words change. The day line changes
 * four times a day, so the component holding it renders four times a day,
 * not once a minute. Nothing about it moves on screen: the words are swapped,
 * not animated.
 */
export function useNow(everyMs = 60000, read = dayLine) {
  const [text, setText] = useState(() => read(new Date()));
  useEffect(() => {
    const tick = () => {
      const next = read(new Date());
      setText((prev) => (prev === next ? prev : next));
    };
    tick();
    const id = setInterval(tick, everyMs);
    return () => clearInterval(id);
  }, [everyMs, read]);
  return text;
}
