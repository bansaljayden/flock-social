// "OPEN UNTIL 9:30 PM", NOT "OPEN NOW".
//
// The venue sheet's third tile said Open Now or Closed and nothing else, so a
// place that shuts in twenty minutes and one that just opened read the same,
// and a Closed tile at 3:44 PM gave no hint that the room opens at five. Place
// Details already sends the week as periods (currentOpeningHours.periods, the
// venue's own wall-clock times), so the tile can say when it closes or opens.
//
// The clock is the VENUE's: Place Details sends its UTC offset, and a person
// looking at a place in another time zone is told that place's hours, the way
// the hours list under the tile prints them. Without an offset the device's
// clock is used, which is the same zone for nearly everyone looking at a
// place near them.
//
// Both shapes Google has sent are read: Places API (New) gives
// { open: { day, hour, minute }, close: { ... } } with day 0 = Sunday, the
// legacy API gave { open: { day, time: '1700' } }. A period with no close is
// open around the clock. Anything unreadable returns null, and the tile keeps
// the plain openNow answer.

const WEEK_MIN = 7 * 24 * 60;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pointMinutes = (pt) => {
  if (!pt || typeof pt !== 'object') return null;
  const day = Number(pt.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  let hour = pt.hour;
  let minute = pt.minute;
  if (typeof pt.time === 'string' && /^\d{4}$/.test(pt.time)) {
    hour = Number(pt.time.slice(0, 2));
    minute = Number(pt.time.slice(2));
  }
  hour = Number(hour || 0);
  minute = Number(minute || 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  return day * 1440 + hour * 60 + minute;
};

// [start, end) in minutes of the week, end past start (a period over the
// Saturday-to-Sunday edge runs past WEEK_MIN).
const spansOf = (periods) => {
  if (!Array.isArray(periods)) return null;
  const spans = [];
  for (const p of periods) {
    const start = pointMinutes(p && p.open);
    if (start === null) return null;
    if (!p.close) { spans.push([start, start + WEEK_MIN]); continue; }
    let end = pointMinutes(p.close);
    if (end === null) return null;
    if (end <= start) end += WEEK_MIN;
    spans.push([start, end]);
  }
  return spans.length ? spans : null;
};

// The venue's clock as minutes of the week.
const venueNowMinutes = (now, utcOffsetMinutes) => {
  if (typeof utcOffsetMinutes === 'number' && Number.isFinite(utcOffsetMinutes)) {
    const t = new Date(now.getTime() + utcOffsetMinutes * 60000);
    return t.getUTCDay() * 1440 + t.getUTCHours() * 60 + t.getUTCMinutes();
  }
  return now.getDay() * 1440 + now.getHours() * 60 + now.getMinutes();
};

const clockWords = (minutesOfWeek) => {
  const m = ((minutesOfWeek % 1440) + 1440) % 1440;
  const hour = Math.floor(m / 60);
  const minute = m % 60;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return minute === 0 ? `${h12} ${ampm}` : `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
};

/**
 * { open, text } for the sheet's tile, or null when the hours cannot be read.
 *   open: true  -> "Open until 9:30 PM" / "Open 24 hours"
 *   open: false -> "Opens 5 PM" (later today) / "Opens Fri 5 PM"
 */
export const openStatus = (openingHours, { now = new Date(), utcOffsetMinutes } = {}) => {
  const spans = spansOf(openingHours && openingHours.periods);
  if (!spans) return null;
  const at = venueNowMinutes(now, utcOffsetMinutes);
  // Merge back-to-back periods (closes 11:59 PM, opens 12 AM) so the close
  // said is the real one.
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  const covering = (m) => sorted.find(([s, e]) => (m >= s && m < e) || (m + WEEK_MIN >= s && m + WEEK_MIN < e));
  const current = covering(at);
  if (current) {
    let end = current[1];
    let guard = 0;
    for (;;) {
      const next = sorted.find(([s]) => s % WEEK_MIN === end % WEEK_MIN && end - current[0] < WEEK_MIN);
      if (!next || guard++ > 14) break;
      end += next[1] - next[0];
    }
    if (end - current[0] >= WEEK_MIN) return { open: true, text: 'Open 24 hours' };
    return { open: true, text: `Open until ${clockWords(end)}` };
  }
  let best = null;
  for (const [s] of sorted) {
    const wait = (((s - at) % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
    if (best === null || wait < best.wait) best = { wait, start: s };
  }
  if (!best) return null;
  const sameDay = Math.floor(at / 1440) === Math.floor(((at + best.wait) % WEEK_MIN) / 1440) && best.wait < 1440;
  const day = DAY_NAMES[Math.floor((best.start % WEEK_MIN) / 1440)];
  return { open: false, text: sameDay ? `Opens ${clockWords(best.start)}` : `Opens ${day} ${clockWords(best.start)}` };
};

export default openStatus;
