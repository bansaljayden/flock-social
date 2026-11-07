// HOW BUSY A PLACE USUALLY IS ON A LATER DAY, IN WORDS (2026-11-06).
//
// Asked about a plan on another day, Birdie's crowd tool answers with how busy
// the venue usually is on that weekday (backend routes/ai.js A LATER DAY), and
// the card under the answer carries it as `usual`:
//   { date: '2026-11-13', weekday: 5, source: 'venue_pattern' | 'category_typical',
//     busiest: { start: 19, end: 21 }, hours: [{ h: 17, v: 44 }, ...] }
// `busiest` is the venue's busiest open stretch that night in clock hours,
// `end` the hour it closes at, and `hours` the night's open hours in order
// with how busy each usually is, for the bars. Nothing here is a forecast for
// that night, so every line says "usually", and a number from the category
// table is said as what places like it do, never as this venue's.

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const face = (h) => {
  const x = ((Math.trunc(h) % 24) + 24) % 24;
  return { n: x % 12 === 0 ? 12 : x % 12, m: x < 12 ? 'AM' : 'PM' };
};

// "around 9 PM" for one hour, "7-9 PM" for a stretch, "11 AM-2 PM" across
// noon. Null for anything that is not a stretch of clock hours.
export function busiestWords(busiest) {
  if (!busiest || !Number.isInteger(busiest.start) || !Number.isInteger(busiest.end)) return null;
  const span = (busiest.end - busiest.start + 24) % 24;
  const a = face(busiest.start);
  const b = face(busiest.end);
  if (span === 1) return `around ${a.n} ${a.m}`;
  return a.m === b.m ? `${a.n}-${b.n} ${b.m}` : `${a.n} ${a.m}-${b.n} ${b.m}`;
}

// "Fri 13" for 2026-11-13, read as a calendar day (never as an instant, which
// would move it a day west of UTC). Null for anything else.
export function planDayLabel(iso) {
  const m = typeof iso === 'string' ? ISO_DAY.exec(iso) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCDate() !== Number(m[3])) return null;
  return `${DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()}`;
}

// The device's own calendar day as YYYY-MM-DD.
export function localDayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Whether `iso` is a day after today on this device.
export function isLaterDay(iso, now = new Date()) {
  return typeof iso === 'string' && ISO_DAY.test(iso) && iso > localDayIso(now);
}

// The one line a card draws: "Usually busiest 7-9 PM Fri", or for the
// category table "Places like this: busiest 7-9 PM Fri". `withDay: false`
// leaves the weekday off, for a line that already starts with the date. Null
// when there is no busiest stretch to name.
export function usualNightText(usual, { withDay = true } = {}) {
  if (!usual) return null;
  const when = busiestWords(usual.busiest);
  const day = Number.isInteger(usual.weekday) ? DAYS_SHORT[((usual.weekday % 7) + 7) % 7] : null;
  if (!when || !day) return null;
  const tail = withDay ? ` ${day}` : '';
  return usual.source === 'category_typical'
    ? `Places like this: busiest ${when}${tail}`
    : `Usually busiest ${when}${tail}`;
}

// The same, said in full for a screen reader, with the day spelled out.
export function usualNightSpoken(usual) {
  const text = usualNightText(usual);
  if (!text) return null;
  const long = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][((usual.weekday % 7) + 7) % 7];
  return `${text.replace(/ (Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/, '')} on ${long}`;
}

// Whether clock hour `h` is inside the busiest stretch.
export function inBusiest(busiest, h) {
  if (!busiest) return false;
  const span = (busiest.end - busiest.start + 24) % 24 || 24;
  return ((h - busiest.start + 24) % 24) < span;
}
