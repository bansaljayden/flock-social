// THE OPEN PILL ON BIRDIE'S VENUE CARD (S19, 2026-11-06).
//
// The pill said whether a place was open at the moment of the answer, and only
// that: at 3:44 PM on a Thursday a card read "Closed" for a restaurant opening
// at 5, under an answer about a plan on the 13th. It now says:
//   * nothing about right now on a card about another day (`for_date`, which
//     the server sets on every card of such an answer, and it sends is_open as
//     null there too so builds without this file drop the pill), except
//     "Closed Fri" when the venue's posted hours say it is shut that day;
//   * "Opens 5 PM" for a place closed now that opens later today
//     (`opens_at`, Google's next opening as an instant, said on the venue's
//     clock from `opens_tz`, its zone, and on this device's clock for a card
//     without one: a search about Los Angeles made from New York read 8 PM
//     on the phone's clock for a 5 PM opening, and "today" was New York's);
//   * "Open" and "Closed" otherwise, as before.
// Returns { text, tone } with tone 'open', 'later' or 'closed', or null for
// no pill.
import { isLaterDay } from './usualNight';

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// An instant's wall clock in `timeZone` ({ y, mo, d, h, m }), or null for a
// zone this engine does not know.
function wallIn(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const f = {};
    for (const x of parts) f[x.type] = Number(x.value);
    if (![f.year, f.month, f.day, f.hour, f.minute].every(Number.isInteger)) return null;
    return { y: f.year, mo: f.month, d: f.day, h: f.hour % 24, m: f.minute };
  } catch {
    return null;
  }
}

// "5 PM" or "5:30 PM" for an instant later today, else null: today and the
// hour on the venue's clock when `timeZone` is a zone this engine knows, on
// this device's otherwise.
export function opensLaterToday(iso, now = new Date(), timeZone = null) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t <= now.getTime()) return null;
  const local = (ms) => {
    const x = new Date(ms);
    return { y: x.getFullYear(), mo: x.getMonth() + 1, d: x.getDate(), h: x.getHours(), m: x.getMinutes() };
  };
  const zoned = typeof timeZone === 'string' && timeZone ? [wallIn(t, timeZone), wallIn(now.getTime(), timeZone)] : null;
  const [at, today] = zoned && zoned[0] && zoned[1] ? zoned : [local(t), local(now.getTime())];
  if (at.y !== today.y || at.mo !== today.mo || at.d !== today.d) return null;
  return `${at.h % 12 === 0 ? 12 : at.h % 12}${at.m ? `:${String(at.m).padStart(2, '0')}` : ''} ${at.h < 12 ? 'AM' : 'PM'}`;
}

export function cardOpenPill(v, now = new Date()) {
  if (!v) return null;
  if (isLaterDay(v.for_date, now)) {
    if (v.hours_that_day !== 'closed') return null;
    const [y, mo, d] = v.for_date.split('-').map(Number);
    return { text: `Closed ${DAYS_SHORT[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]}`, tone: 'closed' };
  }
  if (v.is_open === true) return { text: 'Open', tone: 'open' };
  if (v.is_open === false) {
    const opens = opensLaterToday(v.opens_at, now, v.opens_tz);
    return opens ? { text: `Opens ${opens}`, tone: 'later' } : { text: 'Closed', tone: 'closed' };
  }
  return null;
}
