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
//     (`opens_at`, Google's next opening as an instant, said on this device's
//     clock, which is the venue's for the places Birdie finds near you);
//   * "Open" and "Closed" otherwise, as before.
// Returns { text, tone } with tone 'open', 'later' or 'closed', or null for
// no pill.
import { isLaterDay } from './usualNight';

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "5 PM" or "5:30 PM" for an instant later today on this device, else null.
export function opensLaterToday(iso, now = new Date()) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t <= now.getTime()) return null;
  const at = new Date(t);
  if (at.getFullYear() !== now.getFullYear() || at.getMonth() !== now.getMonth() || at.getDate() !== now.getDate()) return null;
  const h = at.getHours();
  const m = at.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
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
    const opens = opensLaterToday(v.opens_at, now);
    return opens ? { text: `Opens ${opens}`, tone: 'later' } : { text: 'Closed', tone: 'closed' };
  }
  return null;
}
