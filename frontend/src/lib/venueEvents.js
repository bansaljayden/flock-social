// A venue's own events, as the venue card and the owner's dashboard print them.
//
// event_date is a calendar date with no time zone ('2026-10-24', what the
// editor's date picker sends), so it is read as that day on the reader's own
// calendar. `new Date('2026-10-24')` would parse it as UTC midnight and show a
// Friday event as Thursday everywhere west of London. An older event can hold
// free text ("Friday"), which the server never shows on the card; the owner's
// list prints it as typed. event_time is always the owner's own words.

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Local midnight of a 'YYYY-MM-DD' that names a real day, otherwise null.
export const parseEventDay = (text) => {
  if (typeof text !== 'string') return null;
  const m = ISO_DAY.exec(text.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const day = new Date(y, mo, d);
  if (day.getFullYear() !== y || day.getMonth() !== mo || day.getDate() !== d) return null;
  return day;
};

// The picker's own format for a local date.
export const localDayString = (d) => (
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
);

// What the date picker offers: today on the owner's calendar through a year
// on. The server takes a date up to 366 days past today's UTC date, so 365
// local days is inside it from every time zone.
export const eventPickerBounds = (now = new Date()) => ({
  min: localDayString(now),
  max: localDayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 365)),
});

// "Today", "Tomorrow", a weekday inside the coming week, or "Sat, Nov 1".
// "Last night" for yesterday's date, which the card can still be holding in
// the early hours: the server keeps an event until the morning after it.
export const eventDayLabel = (text, now = new Date()) => {
  const day = parseEventDay(text);
  if (!day) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((day - today) / DAY_MS);
  if (days === -1) return 'Last night';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return day.toLocaleDateString('en-US', { weekday: 'long' });
  return day.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
};

// One line for when an event is: the day as above with the owner's time after
// it, or, for an older event with no calendar date, the words as typed.
export const eventWhenLine = (date, time, now = new Date()) => {
  const label = eventDayLabel(date, now);
  const t = typeof time === 'string' ? time.trim() : '';
  if (label) return t ? `${label} · ${t}` : label;
  return [typeof date === 'string' ? date.trim() : '', t].filter(Boolean).join(' · ');
};

// What the owner's list says under each event, keyed by the public_status the
// server works out by the card's own rules (GET /api/venue-dashboard/events).
// Two statuses print nothing here on purpose: 'hidden', which
// ModerationHiddenNotice says, and 'unverified', which the line above the list
// says once instead of on every row.
export const EVENT_STATUS_LINE = {
  shown: 'Showing on your venue page in Flock.',
  needs_date: 'Not shown: it has no calendar date. Edit it and pick one.',
  past: 'Not shown: this date has passed.',
  other_place: 'Not shown: it was written for the place this account was linked to before.',
};
