// WHEN A VENUE'S EVENT IS ON, AND WHETHER IT HAS PASSED.
//
// venue_events.event_date is 40 characters of owner-typed text ("Friday",
// "8/15", "doors at 9"), because the first event editor was a plain text box.
// A card that shows events to people has to know which ones have already
// happened, and free text cannot say. So the editor now asks for a calendar
// date (an <input type="date">, which sends YYYY-MM-DD), and only an event whose
// date is a real calendar date is ever shown to anyone. An older event typed as
// free text stays on its owner's list, marked as needing a date, and still saves
// from an older app that only knows the text box.
//
// "PASSED" GETS A TWELVE-HOUR GRACE ON THE UTC CLOCK, because the venue's own
// time zone is not on the row and reading it costs a paid Places call. The UTC
// date of (now - 12 h) is never later than today's date in any zone from UTC-12
// east, so an event dated today is never hidden early anywhere, and last night's
// event drops off once morning comes (about 8 am on the US East Coast).

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const GRACE_MS = 12 * 60 * 60 * 1000;
// A year ahead. A typo that dates an event 2062 would never show and never end.
const MAX_AHEAD_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

// True when the text is shaped like what the date picker sends, whether or not
// it names a real day. Old free text never looks like this, so a shaped value
// that is not a real day ("2026-02-30") is a bad date, not an old one.
function looksLikeEventDay(text) {
  return typeof text === 'string' && ISO_DAY.test(text.trim());
}

// 'YYYY-MM-DD' when the text is exactly a real calendar date, otherwise null.
function eventDay(text) {
  if (!looksLikeEventDay(text)) return null;
  const m = ISO_DAY.exec(text.trim());
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// The earliest date that still counts as upcoming, as 'YYYY-MM-DD'.
function firstUpcomingDay(now = new Date()) {
  return new Date(now.getTime() - GRACE_MS).toISOString().slice(0, 10);
}

// The latest date an owner may give an event, as 'YYYY-MM-DD'.
function lastAllowedDay(now = new Date()) {
  return new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS).toISOString().slice(0, 10);
}

function isUpcoming(day, now = new Date()) {
  return typeof day === 'string' && day >= firstUpcomingDay(now);
}

// Minutes after midnight for the two ways a start time is written that leave no
// doubt: with am or pm ("9 PM", "9:30pm", "8 a.m.") or on a 24-hour clock with
// two-digit hours ("21:00", "09:30"). Anything else ("doors at 9", "9:30",
// "late") is null: a bare "9:30" at a bar is almost never the morning, and a
// guess would put it first. Used only to order two events on the same day; the
// card prints the owner's own words.
const TIME_12 = /^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?$/i;
const TIME_24 = /^(\d{2}):(\d{2})$/;
function eventTimeMinutes(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  let m = TIME_12.exec(t);
  if (m) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    return ((h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + min;
  }
  m = TIME_24.exec(t);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

// Soonest first: by day, then by start time where one can be read, then in the
// order given (the caller's own tie-break). An unreadable time goes after the
// readable ones on its day, never before them.
function soonestFirst(events) {
  const keyed = events.map((e, i) => ({ e, i, day: eventDay(e.event_date) || '', mins: eventTimeMinutes(e.event_time) }));
  keyed.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    const am = a.mins == null ? Infinity : a.mins;
    const bm = b.mins == null ? Infinity : b.mins;
    if (am !== bm) return am - bm;
    return a.i - b.i;
  });
  return keyed.map((k) => k.e);
}

// Why a date from the editor cannot be saved, or null when it can. Only a value
// shaped like the picker's is judged; free text from an older app passes
// through untouched, exactly as it always has.
//
// A date that has gone by is NOT refused. The picker already starts at today,
// the public read leaves a past event out, and the owner's list says "past"
// beside it, so a refusal here would protect nobody. It would stop an owner
// retitling last week's event, whose edit sends its own date back.
function eventDayProblem(text, now = new Date()) {
  if (!looksLikeEventDay(text)) return null;
  const day = eventDay(text);
  if (!day) return 'That date does not exist. Pick it again from the calendar.';
  if (day > lastAllowedDay(now)) return 'Pick a date within the next year.';
  return null;
}

module.exports = {
  looksLikeEventDay,
  eventDay,
  firstUpcomingDay,
  lastAllowedDay,
  isUpcoming,
  eventTimeMinutes,
  soonestFirst,
  eventDayProblem,
};
