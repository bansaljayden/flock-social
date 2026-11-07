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
import { localeDate, localeTime } from './localeFormat';

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

/*
 * A TIME NEVER BREAKS FROM ITS AM OR PM. "How busy is The Copper Finch at
 * 11:33 / PM?" wrapped at 390 with PM alone on the second line, because
 * Chromium's Intl writes an ordinary space there (some ICU builds write a
 * narrow no-break one, so it depended on the engine). Every time the Nest
 * writes joins its figures to its AM or PM with U+202F, the narrow no-break
 * space iOS's own clock uses, and a month keeps its day with U+00A0.
 */
const NARROW_NBSP = '\u202f';
const NBSP = '\u00a0';
const timeOf = (d) => localeTime(d, [], { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, NARROW_NBSP);
const monthDay = (d) => localeDate(d, [], { month: 'short', day: 'numeric' }).replace(/\s+/g, NBSP);
const shortWeekday = (d) => WEEKDAYS[d.getDay()].slice(0, 3);
const isEveningHour = (h) => h >= 17 || h < NIGHT_ROLL_HOUR;

/** A clock time that does not break: "11:33 PM" with a narrow no-break space. '' for no date. */
export function clockTime(value) {
  const d = asDate(value);
  return d ? timeOf(d) : '';
}

/**
 * When a plan is, in the words a person uses for it, from the night it falls
 * on. A real clock time always, never a countdown.
 *
 *   same night, still ahead  "Tonight at 8:33 PM" (from 5 PM to 3:59 AM)
 *                            "Today at 11:00 AM"  (before 5 PM)
 *   same night, under way    "Started at 8:33 PM"
 *   the next night           "Tomorrow at 8:33 PM"
 *   two to six nights out    "Sunday at 11:00 AM"
 *   further out              "Nov 21 at 8:00 PM"
 *   the night before         "Last night at 8:33 PM" / "Yesterday at 11:00 AM"
 *   earlier still            "Nov 4 at 8:00 PM"
 *
 * '' for a plan with no readable time.
 */
export function whenLine(eventTime, now = new Date()) {
  const t = asDate(eventTime);
  const n = asDate(now);
  if (!t || !n) return '';
  const nights = nightsBetween(n, t);
  const at = timeOf(t);
  if (nights === 0) {
    if (t.getTime() <= n.getTime()) return `Started at ${at}`;
    return isEveningHour(t.getHours()) ? `Tonight at ${at}` : `Today at ${at}`;
  }
  if (nights === 1) return `Tomorrow at ${at}`;
  if (nights >= 2 && nights <= 6) return `${WEEKDAYS[t.getDay()]} at ${at}`;
  if (nights === -1) return isEveningHour(t.getHours()) ? `Last night at ${at}` : `Yesterday at ${at}`;
  return `${monthDay(t)} at ${at}`;
}

/**
 * The same facts, short, for everything below the hero: the Needs you rows
 * and the Coming up cards say a plan's time one way, where the rows said
 * "Sunday at 11:00 AM" over a card that said "Sun 11:00 AM" (and at 320 the
 * long form took every row to three or four lines). The sentence form stays
 * in the hero, the one place a plan is read as a sentence.
 *
 *   same night, still ahead  "Tonight 8:33 PM" / "Today 11:00 AM"
 *   same night, under way    "Started 8:33 PM"
 *   the next night           "Tomorrow 7:00 PM"
 *   two to six nights out    "Sun 11:00 AM"
 *   further out              "Nov 15, 8:00 PM"
 *   the night before         "Last night 8:00 PM" / "Yesterday 11:00 AM"
 *   earlier still            "Nov 4, 8:00 PM"
 *
 * '' for a plan with no readable time.
 */
export function shortWhen(eventTime, now = new Date()) {
  const t = asDate(eventTime);
  const n = asDate(now);
  if (!t || !n) return '';
  const nights = nightsBetween(n, t);
  const at = timeOf(t);
  if (nights === 0) {
    if (t.getTime() <= n.getTime()) return `Started ${at}`;
    return isEveningHour(t.getHours()) ? `Tonight ${at}` : `Today ${at}`;
  }
  if (nights === 1) return `Tomorrow ${at}`;
  if (nights >= 2 && nights <= 6) return `${shortWeekday(t)}${NBSP}${at}`;
  if (nights === -1) return isEveningHour(t.getHours()) ? `Last night ${at}` : `Yesterday ${at}`;
  return `${monthDay(t)}, ${at}`;
}

/**
 * The line on another plan the same night as the hero: "Also tonight at
 * 8:00 PM", "Also tomorrow at 8:00 PM", or "Started at 8:00 PM" once it is
 * under way (never "also tonight" about a plan that began an hour ago).
 */
export function alsoLine(eventTime, now = new Date()) {
  const w = whenLine(eventTime, now);
  if (!w || w.startsWith('Started')) return w;
  if (/^(Tonight|Today|Tomorrow) /.test(w)) return `Also ${w.charAt(0).toLowerCase()}${w.slice(1)}`;
  return `Also ${w}`;
}

/**
 * THE HERO: which plan leads the Nest.
 *
 * Candidates are live plans with a time that are not "time passed" (still
 * voting twelve hours on). The earliest night from tonight on wins, and
 * within that night a locked-in plan comes before one still voting, then the
 * soonest. A plan holds the hero until the 4 AM after its night, so at
 * 12:40 AM Friday's plan is still the one on top, asking how it was.
 *
 * Returns { hero, sameNight }: the hero, and the other plans on its night in
 * the list's own order. Both are taken from `liveFlocks` as given, which
 * App.js has already filtered and sorted once; nothing here re-sorts the list
 * the rest of the page reads.
 */
export function pickHero(liveFlocks, now = new Date()) {
  const list = Array.isArray(liveFlocks) ? liveFlocks : [];
  const nowKey = nightKey(now);
  const candidates = list.filter((f) => f
    && f.status !== 'completed' && f.status !== 'cancelled'
    && !f.timePassed
    && asDate(f.eventTime)
    && nightKey(f.eventTime) >= nowKey);
  if (candidates.length === 0) return { hero: null, sameNight: [] };
  const night = candidates.reduce((min, f) => (nightKey(f.eventTime) < min ? nightKey(f.eventTime) : min), nightKey(candidates[0].eventTime));
  const onNight = candidates.filter((f) => nightKey(f.eventTime) === night);
  const locked = (f) => (f.status === 'confirmed' || f.status === 'locked' ? 0 : 1);
  const hero = onNight.reduce((best, f) => {
    if (!best) return f;
    if (locked(f) !== locked(best)) return locked(f) < locked(best) ? f : best;
    return asDate(f.eventTime).getTime() < asDate(best.eventTime).getTime() ? f : best;
  }, null);
  return { hero, sameNight: onNight.filter((f) => f !== hero) };
}

/**
 * COMING UP: the plans after the hero's night, in bands of when. A partition
 * of `rest` in its own order (App.js's one sort), never a re-sort.
 *
 *   "Tonight"      a plan on tonight's night the hero did not take (rare)
 *   "Tomorrow"     the next night
 *   "This week"    two to six nights out
 *   "Later"        a week or more
 *   "No date yet"  no time set
 *   "Earlier"      past nights still open: still voting long after, or a
 *                  night over and waiting to be rated
 *
 * Empty bands are left out.
 */
export const COMING_GROUPS = ['Tonight', 'Tomorrow', 'This week', 'Later', 'No date yet', 'Earlier'];

export function comingGroupOf(f, now = new Date()) {
  if (!f) return null;
  if (f.timePassed) return 'Earlier';
  const t = asDate(f.eventTime);
  if (!t) return 'No date yet';
  const nights = nightsBetween(now, t);
  if (nights < 0) return 'Earlier';
  if (nights === 0) return 'Tonight';
  if (nights === 1) return 'Tomorrow';
  if (nights <= 6) return 'This week';
  return 'Later';
}

export function comingGroups(rest, now = new Date()) {
  const list = Array.isArray(rest) ? rest : [];
  return COMING_GROUPS
    .map((label) => ({ label, flocks: list.filter((f) => comingGroupOf(f, now) === label) }))
    .filter((g) => g.flocks.length > 0);
}

/**
 * The time on a Coming up card: the clock alone under Tonight and Tomorrow,
 * where the band already says the day, and shortWhen's words everywhere
 * else, the same words a Needs you row uses for the same plan: "Sun
 * 11:00 AM" in This week, "Nov 21, 8:00 PM" under Later, and under Earlier
 * "Last night 8:00 PM" or "Nov 4, 8:00 PM", where it gave a weekday that
 * could be weeks old. '' with no time.
 */
export function cardTime(eventTime, group, now = new Date()) {
  const t = asDate(eventTime);
  if (!t) return '';
  if (group === 'Tomorrow' || group === 'Tonight') return timeOf(t);
  return shortWhen(t, now);
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
