// TABLE MONITORING ON THE OWNER DASHBOARD: THE WORDS AND THE ARITHMETIC.
//
// A venue's Flux sensor can be set up with table zones. It counts the people
// in each zone and keeps a state for every table: free, seated, waiting (seated
// past the five-minute limit with nobody stopping by yet) or needs_clearing
// (the party has left and the table has not been cleared). Two routes hand
// that to the venue's verified owner and to nobody else:
//
//   GET /api/sensors/:placeId/tables
//     { tables: [{ number, people, state, since, seats, party_max }],
//     updated_at, stale, next_free }
//     `since` is when the state began, and for seated and waiting it is when
//     the party sat down. `seats` is the unit's own count of the table's
//     seats, null when the unit does not know it; `party_max` is the largest
//     party the box has seen at the table lately, null when none, and is not
//     a seat count. `stale` is true once the sensor has not reported for over
//     3 minutes. `next_free` is the seated or waiting table seated longest,
//     or null.
//
//   GET /api/sensors/:placeId/tables/hours
//     { hours: [{ hour, occupied, total }], timeZone } for the last 7 days,
//     oldest first.
//
//   GET /api/sensors/:placeId/tables/waits
//     { updated_at, stale, by_party: [{ party, open_now, minutes, table }] }
//     for a party of 2, 4, 6 and 8. `open_now` is true when an open table is
//     known to fit (then `table` names it), false when none does (then
//     `minutes` and `table` are the server's estimate of the next, or null
//     with no estimate yet), and null when tables are open but no open
//     table's seat count is known for that party (then `table` is the lowest
//     open table and `minutes` is null). The answer may carry how many
//     tables are open, `open`, on the row or beside the list.
//
//   GET /api/sensors/:placeId/tables/incoming
//     { flocks: [{ id, event_time, status, party, suggestion }] }, where
//     `suggestion` is { table, free_now, likely_free_at } or null. Party sizes
//     and times, never names. The window is the last 12 hours to 7 days
//     ahead, so a plan can be on another day, or already past.
//
//   GET /api/sensors/:placeId/tables/stats?days=28
//     { days, seatings, turn_minutes: { median, by_hour: [{ dow, hour, median,
//     seatings }] }, waited_share, clear_minutes_median, full_hours: [{ dow,
//     hour, share }], timeZone }. `dow` 0 to 6 from Sunday and `hour` 0 to
//     23, on the venue's clock when `timeZone` is a zone and in UTC when it
//     is null (an older server said 'UTC', read the same way). A cell's
//     median is null under 20 seatings in the cell, the overall median null
//     under 20 in the window; a cell's `seatings` is sent whatever the count.
//
// A table that is seated or waiting may also carry `likely_free_at` (an ISO
// time, or null), the server's estimate from its history of when the party
// will be up.
//
// This file turns those answers into the sentences and bar heights that the
// dashboard's Tables tab draws (components/venue/tables/). Nothing here
// estimates: every figure is one the sensor sent, an average of them, or an
// estimate the server made, and the words say which ("likely", "about").

// The reading itself (when, how often, what a failure becomes) is
// lib/venueTablesReading.js, kept apart because App.js imports it and this
// file is only ever needed by the dashboard's own chunk.

// A number, or a numeric string, or null.
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// Milliseconds since the epoch, or null for anything that does not parse.
export const timeMs = (iso) => {
  if (typeof iso !== 'string' && !(iso instanceof Date)) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

// The state in words. The word is printed on every tile, so no state rests on
// its colour alone.
export const TABLE_STATE_WORDS = Object.freeze({
  free: 'Free',
  seated: 'Seated',
  waiting: 'Needs a server',
  needs_clearing: 'Needs clearing',
});

const knownState = (s) => typeof s === 'string' && Object.prototype.hasOwnProperty.call(TABLE_STATE_WORDS, s);

// The tables the panel can draw, in table-number order. A row with no usable
// number, or with a state this build does not know, is left out rather than
// drawn as something it is not.
export function tablesFrom(data) {
  const list = data && Array.isArray(data.tables) ? data.tables : [];
  return list
    .filter((t) => t && num(t.number) !== null && knownState(t.state))
    .map((t) => ({ ...t, number: num(t.number) }))
    .sort((a, b) => a.number - b.number);
}

// Time from `since` to `nowMs`, never below zero (a phone clock running a
// little behind the server's would otherwise count down), or null when either
// end is missing.
export function msSince(since, nowMs) {
  const t = timeMs(since);
  if (t === null || !Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - t);
}

// Minutes and seconds, the way a kitchen timer reads: 0:09, 6:05, 75:02.
export function clockText(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// A length of time in the words a manager reads at a glance: under an hour in
// minutes ("14 min"), under a day in hours and minutes ("2 h 10 min", or "2 h"
// on the hour), and from a day on in days ("1 day", "2 days"). Under a minute
// is "under 1 min". A table free since last night's close used to read "Free
// for 960 min". Every duration the panel prints goes through this; the seated
// tile's ticking clock (clockText) is the one timer and stays a timer.
export function durationText(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

// The time line on a tile. Seated and waiting count up in minutes and seconds
// from when the party sat down; free and needs clearing say how long in words.
// Null when there is no time to show.
export function tileTimeText(table, nowMs) {
  const ms = msSince(table.since, nowMs);
  if (ms === null) return null;
  if (table.state === 'seated' || table.state === 'waiting') return clockText(ms);
  if (table.state === 'free') return `Free for ${durationText(ms)}`;
  if (table.state === 'needs_clearing') return `Waiting to be cleared ${durationText(ms)}`;
  return null;
}

// What a screen reader hears in place of the ticking clock, which would
// otherwise be read out as a time of day.
export function tileClockSpoken(table, nowMs) {
  const ms = msSince(table.since, nowMs);
  if (ms === null) return null;
  return table.state === 'waiting' ? `seated ${durationText(ms)}` : `for ${durationText(ms)}`;
}

// The head count the sensor gives a seated table. Nothing for a count below
// one: a seated table showing "0 people" says nothing anyone can act on.
export function peopleText(people) {
  const n = num(people);
  if (n === null || n < 1) return null;
  const whole = Math.round(n);
  return `${whole} ${whole === 1 ? 'person' : 'people'}`;
}

// How many seats a table has, when the sensor's setup says. Optional: null,
// zero or anything that is not a whole number says nothing.
export function seatsText(seats) {
  const n = num(seats);
  if (n === null || !Number.isInteger(n) || n < 1) return null;
  return `${n} ${n === 1 ? 'seat' : 'seats'}`;
}

// The seats line on a tile, or null. `seats` is the unit's own count and is
// printed as what it is ("4 seats"). Without one, `party_max`, the largest
// party the box has seen at the table lately, is printed as what IT is
// ("seats 4 so far", `seen`, drawn in the muted style): a six-top that has
// only seated couples this month is not a two-top, and the line must not say
// it is. Nothing when both are unknown.
export function seatsLine(table) {
  const known = seatsText(table && table.seats);
  if (known) return { text: known, seen: false };
  const n = num(table && table.party_max);
  if (n === null || !Number.isInteger(n) || n < 1) return null;
  return { text: `seats ${n} so far`, seen: true };
}

// The tables that need someone, longest first: a party nobody has stopped by
// for yet, and a table its party has left. One with no usable time goes last.
export function tableAlerts(tables, nowMs) {
  return tables
    .filter((t) => t.state === 'waiting' || t.state === 'needs_clearing')
    .map((t) => {
      const ms = msSince(t.since, nowMs);
      let text;
      if (t.state === 'waiting') {
        text = ms === null
          ? `Table ${t.number}: nobody has stopped by yet`
          : `Table ${t.number}: seated ${durationText(ms)}, nobody has stopped by yet`;
      } else {
        text = ms === null
          ? `Table ${t.number}: needs clearing`
          : `Table ${t.number}: left ${durationText(ms)} ago, needs clearing`;
      }
      return { number: t.number, state: t.state, ms, text };
    })
    .sort((a, b) => {
      if (a.ms === null || b.ms === null) {
        return (a.ms === null) - (b.ms === null) || a.number - b.number;
      }
      return b.ms - a.ms || a.number - b.number;
    });
}

// The table likely to free up next, or null.
//
// THE RULE. The seated table whose party has sat longest: a party that has
// been served is the one furthest along its stay. A table nobody has stopped
// by for (waiting) has not ordered yet, however long it has sat, so it is the
// party least likely to leave next; waiting tables are picked from only when
// no table is plainly seated, longest first. Among equals the lower number.
// A table with no usable time ranks last. The server sends its own pick
// (next_free, the seated or waiting table seated longest); it is kept as a
// hint only where it agrees with the rule, that is, when it names a table in
// the class the rule chose, where it may settle a tie this side cannot see.
// Otherwise the pick is made here. So the line never names the table the
// alerts above it say needs a server while a served table is on the floor.
//
// THE ESTIMATE. A table may carry `likely_free_at`, the server's estimate
// from its history of when the party will be up. Inside the class the rule
// chose, a table with an estimate ranks ahead of one without, and the
// soonest estimate ranks first; the hint settles only a tie between equal
// estimates. The class comes first for the same reason as above: the server
// estimates from how long a party has sat, not from whether anyone has
// served it, so its soonest table can be the one the alerts say needs a
// server, and the line would contradict them.
export function nextFreePick(data, tables, nowMs) {
  const seated = tables.filter((t) => t.state === 'seated');
  const pool = seated.length ? seated : tables.filter((t) => t.state === 'waiting');
  if (!pool.length) return null;
  const age = (t) => msSince(t.since, nowMs);
  const byAge = (a, b) => {
    const am = age(a);
    const bm = age(b);
    if (am === null || bm === null) return (am === null) - (bm === null) || a.number - b.number;
    return bm - am || a.number - b.number;
  };
  const hint = data ? num(data.next_free) : null;
  const estimate = (t) => timeMs(t.likely_free_at);
  const estimated = pool.filter((t) => estimate(t) !== null);
  if (estimated.length) {
    const ranked = estimated.sort((a, b) => estimate(a) - estimate(b) || byAge(a, b));
    const soonest = estimate(ranked[0]);
    return ranked.find((t) => estimate(t) === soonest && t.number === hint) || ranked[0];
  }
  const ranked = pool.slice().sort(byAge);
  return ranked.find((t) => t.number === hint) || ranked[0];
}

// The one line under the alerts that names that table, or null: with the
// server's estimate when the table has one that is still ahead at `nowMs`
// ("likely free around 8:10 PM", on `clock`), else how long its party has
// sat. `timed` says a time of day was printed, so the board can say whose
// clock it is on. An estimate already behind the clock is left unsaid: the
// party is still there, and "likely free around 7:50" at 8:05 is a line
// that has been wrong for a quarter of an hour.
export function nextFreeLine(data, tables, nowMs, clock = clockIn(null)) {
  const table = nextFreePick(data, tables, nowMs);
  if (!table) return null;
  const at = timeMs(table.likely_free_at);
  if (at !== null && Number.isFinite(nowMs) && at > nowMs) {
    const when = clock.time(table.likely_free_at);
    if (when) return { text: `Next likely free: Table ${table.number} (likely free around ${when})`, timed: true };
  }
  const ms = msSince(table.since, nowMs);
  return {
    text: ms === null
      ? `Next likely free: Table ${table.number}`
      : `Next likely free: Table ${table.number} (seated ${durationText(ms)})`,
    timed: false,
  };
}

export function nextFreeText(data, tables, nowMs, clock) {
  const line = nextFreeLine(data, tables, nowMs, clock);
  return line ? line.text : null;
}

// "3 of 8 free".
export function freeSummary(tables) {
  const free = tables.filter((t) => t.state === 'free').length;
  return `${free} of ${tables.length} free`;
}

// The two sentences that replace the summary while the server marks the
// tables stale (no table reading for over 3 minutes). `lead` says how long,
// `detail` what the last reading saw. The server's flag covers a box that is
// off, one that is offline, and one that is on and sending readings with no
// tables in them (zones removed, the thermal frames gone stale), and the
// board cannot tell those apart, so the words claim only what the data shows:
// no table readings, for this long. "Sensor offline." used to be the lead,
// and it contradicted the Live Sensor card calling the same box online.
export function staleLines(tables, updatedAtMs, nowMs) {
  const free = tables.filter((t) => t.state === 'free').length;
  const ms = updatedAtMs === null ? null : msSince(new Date(updatedAtMs), nowMs);
  return {
    lead: ms === null ? 'No recent table readings.' : `No table readings for ${durationText(ms)}.`,
    detail: `Last reading had ${free} of ${tables.length} free.`,
  };
}

// The two sentences that replace the summary while the last read failed and
// the board is showing the reading before it (nextTablesState in
// lib/venueTablesReading.js). `readAtMs` is when that reading arrived.
// `what` names what is being shown: the board's reading, or the incoming
// list's "the last list".
export function refreshLines(readAtMs, nowMs, what = 'the last reading') {
  const ms = msSince(new Date(readAtMs), nowMs);
  return {
    lead: "Couldn't refresh just now.",
    detail: ms === null ? `Showing ${what}.` : `Showing ${what} from ${durationText(ms)} ago.`,
  };
}

// ── The clock a time of day is printed on ──────────────────────────────────

// An Intl formatter in `timeZone`, or null when there is no zone or this
// device cannot keep time in it.
const zoneFormat = (timeZone, options) => {
  if (typeof timeZone !== 'string' || !timeZone) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    return null;
  }
};

const CLOCK_PARTS = { weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };

// One clock per zone, built once: the board re-renders every second, and
// building the formatter is the expensive half of formatting a time.
const CLOCKS = new Map();

const DAY_MS = 24 * 60 * 60 * 1000;

// The clock a time of day is printed on: the venue's when its zone is known
// and this device can keep it, the Analytics charts' clock and the hours
// chart's (hourOfIn), else this device's, which the section says (clockWords).
//   venue       whether it is the venue's
//   time(iso)   "8:10 PM", or null for a time that does not parse
//   day(t)      the calendar day `t` (an ISO time or milliseconds) falls on,
//               on this clock, as a key two times are compared by; null for
//               one that does not parse
//   when(iso, nowMs)  the time with its day in front, judged on this clock
//               at `nowMs`: "Today 8:00 PM"; "Earlier today 7:00 PM" once
//               the time has passed; "Yesterday 11:00 PM"; "Sat 8:00 PM" on
//               another day; and with the date, "Fri 10/30 7:00 PM", from
//               six days out, where the weekday alone is this week's or
//               next's. A list of plans a week wide must say which day each
//               is on, and a bare "Fri 7:00 PM" on a Friday reads as
//               tonight. With no `nowMs` to judge by, the weekday.
export function clockIn(timeZone) {
  const key = typeof timeZone === 'string' ? timeZone : '';
  if (CLOCKS.has(key)) return CLOCKS.get(key);
  const zoned = zoneFormat(timeZone, CLOCK_PARTS);
  const format = zoned || new Intl.DateTimeFormat('en-US', CLOCK_PARTS);
  const parts = (t) => {
    const out = {};
    for (const p of format.formatToParts(t)) out[p.type] = p.value;
    return out;
  };
  const read = (iso) => {
    const t = timeMs(iso);
    return t === null ? null : parts(t);
  };
  // Rebuilt from the parts, so the thin space some engines put before "PM"
  // never reaches the page.
  const timeOf = (p) => `${p.hour}:${p.minute} ${p.dayPeriod}`;
  const dayOf = (p) => `${p.year}-${p.month}-${p.day}`;
  const clock = {
    venue: !!zoned,
    time: (iso) => {
      const p = read(iso);
      return p ? timeOf(p) : null;
    },
    day: (t) => {
      const ms = typeof t === 'number' ? (Number.isFinite(t) ? t : null) : timeMs(t);
      return ms === null ? null : dayOf(parts(ms));
    },
    when: (iso, nowMs) => {
      const p = read(iso);
      if (!p) return null;
      if (!Number.isFinite(nowMs)) return `${p.weekday} ${timeOf(p)}`;
      const t = timeMs(iso);
      const day = dayOf(p);
      if (day === dayOf(parts(nowMs))) return `${t < nowMs ? 'Earlier today' : 'Today'} ${timeOf(p)}`;
      if (t < nowMs) return day === dayOf(parts(nowMs - DAY_MS)) ? `Yesterday ${timeOf(p)}` : `${p.weekday} ${timeOf(p)}`;
      if (t - nowMs >= 6 * DAY_MS) return `${p.weekday} ${p.month}/${p.day} ${timeOf(p)}`;
      return `${p.weekday} ${timeOf(p)}`;
    },
  };
  // The device clock is one entry too (key ''), with the same cap.
  if (CLOCKS.size < 32) CLOCKS.set(key, clock);
  return clock;
}

// The words for the footer under any section that prints a time of day.
export const clockWords = (venue) => (venue ? "your venue's clock" : "this device's clock");

// ── Walk-in waits ──────────────────────────────────────────────────────────

// One row per party size, smallest first, each in words. A row with no
// usable party size is left out. `open` marks a party a table is open for
// now, the one line a host acts on at once.
export function waitRows(waits) {
  const list = waits && Array.isArray(waits.by_party) ? waits.by_party : [];
  return list
    .filter((r) => r && num(r.party) !== null && num(r.party) > 0)
    .map((r) => ({ ...r, party: Math.round(num(r.party)) }))
    .sort((a, b) => a.party - b.party)
    .map((r) => ({ party: r.party, open: r.open_now === true, text: waitText(r, waits) }));
}

// How many tables are open, when the waits answer says: on the row, else
// beside the list (the key the public summary uses for the same count).
// Null when it does not.
function openTables(row, waits) {
  for (const v of [row && row.open, waits && waits.open]) {
    const n = num(v);
    if (n !== null && n >= 0) return Math.round(n);
  }
  return null;
}

// One row in words, each state of `open_now` kept apart, since "no table
// that fits" is a claim about the room and "no estimate yet" is not:
//   true    "Party of 4: table 1 is open now" (or "a table is open now"
//           when the server sent no number)
//   null    "Party of 6: 3 tables open, seats unknown", or "tables open,
//           seats unknown" with no count: tables are open and none is known
//           to seat the party, which is not the same as none does
//   false   "Party of 4: about 12 min, table 6 next" from the server's
//           estimate, so "about" (under a minute said as that rather than
//           "about 0 min"); "Party of 4: table 6 next, no estimate yet" when
//           it named the table and could not say when; and "Party of 4: no
//           table that fits right now" only when it named nothing
export function waitText(row, waits) {
  const party = Math.round(num(row.party));
  const table = num(row.table);
  if (row.open_now === true) {
    return table !== null ? `Party of ${party}: table ${table} is open now` : `Party of ${party}: a table is open now`;
  }
  if (row.open_now === null) {
    const open = openTables(row, waits);
    return open !== null
      ? `Party of ${party}: ${open} ${open === 1 ? 'table' : 'tables'} open, seats unknown`
      : `Party of ${party}: tables open, seats unknown`;
  }
  const minutes = num(row.minutes);
  const wait = minutes === null || minutes < 0 ? null : minutes < 1 ? 'under 1 min' : `about ${durationText(minutes * 60000)}`;
  if (wait && table !== null) return `Party of ${party}: ${wait}, table ${table} next`;
  if (wait) return `Party of ${party}: ${wait}`;
  if (table !== null) return `Party of ${party}: table ${table} next, no estimate yet`;
  return `Party of ${party}: no table that fits right now`;
}

// The two sentences over the waits while the server marks them stale, the
// same flag and the same words as the board's.
export function waitsStaleLines(updatedAtMs, nowMs) {
  const ms = updatedAtMs === null ? null : msSince(new Date(updatedAtMs), nowMs);
  return {
    lead: ms === null ? 'No recent table readings.' : `No table readings for ${durationText(ms)}.`,
    detail: 'Waits are from the last reading.',
  };
}

// ── Coming up ──────────────────────────────────────────────────────────────

// The incoming flocks in time order (one with no usable time last), each as
// its line and the table that could seat it. The server sends party sizes
// and times and never names, and nothing here adds one.
export function incomingRows(incoming, clock, nowMs) {
  const list = incoming && Array.isArray(incoming.flocks) ? incoming.flocks : [];
  return list
    .filter((f) => f && typeof f === 'object')
    .map((f, i) => ({
      key: f.id === null || f.id === undefined ? `row-${i}` : String(f.id),
      at: timeMs(f.event_time),
      text: incomingText(f, clock, nowMs),
      fit: suggestionText(f.suggestion, clock, nowMs, f.event_time),
      confirmed: f.status === 'confirmed',
    }))
    .sort((a, b) => {
      if (a.at === null || b.at === null) return (a.at === null) - (b.at === null);
      return a.at - b.at;
    });
}

// "Today 8:00 PM: party of 5, confirmed". The day leads (clock.when), since
// the list runs from the last 12 hours to a week ahead and is read in time
// order: "Earlier today 7:00 PM: party of 4, confirmed", "Sat 8:00 PM:
// party of 10, confirmed". The feed sends a confirmed plan only to the
// venue it is locked in at, so confirmed means coming here; anything else
// is a plan still deciding with this venue in the running, the words the
// Events tab's card uses. With no usable time, "Party of 5, confirmed".
export function incomingText(flock, clock, nowMs) {
  const party = num(flock.party);
  const who = party !== null && party > 0 ? `party of ${Math.round(party)}` : 'a flock';
  const when = clock.when(flock.event_time, nowMs);
  const status = flock.status === 'confirmed' ? 'confirmed' : 'considering you';
  if (!when) return `${who[0].toUpperCase()}${who.slice(1)}, ${status}`;
  return `${when}: ${who}, ${status}`;
}

// The table that could seat a plan, in words. "Table 6 is free now" when the
// server says so, and "No table that fits yet" with no table at all. With
// the server's estimate of when a table will be up, judged at `nowMs`
// against the plan's time:
//   "Table 6 likely free by 7:50 PM"       ahead of the clock, before the plan
//   "Table 6 should be free now"           the clock has passed it; the party
//                                          may still be there, and "likely
//                                          free by 7:50" at 8:05 is a line
//                                          that has been wrong for a quarter
//                                          of an hour (the board's own rule)
//   "Table 6 may not be free in time (likely around 8:40 PM)"
//                                          after the plan's time
// A time of day is printed only when it falls on the plan's day on this
// clock: today's 7:50 PM under a plan for Saturday reads as Saturday's. An
// estimate is about today's room, so for a plan on another day it says
// nothing and the table simply fits, "Table 6 fits them", which is also all
// that can be said with no estimate, or no clock to judge one by.
export function suggestionText(suggestion, clock, nowMs, eventTime) {
  const table = suggestion && typeof suggestion === 'object' ? num(suggestion.table) : null;
  if (table === null) return 'No table that fits yet';
  if (suggestion.free_now === true) return `Table ${table} is free now`;
  const fits = `Table ${table} fits them`;
  const at = timeMs(suggestion.likely_free_at);
  if (at === null || !Number.isFinite(nowMs)) return fits;
  const planAt = timeMs(eventTime);
  if (planAt !== null && clock.day(planAt) !== clock.day(nowMs)) return fits;
  if (at <= nowMs) return `Table ${table} should be free now`;
  const when = clock.day(at) === clock.day(planAt === null ? nowMs : planAt) ? clock.time(suggestion.likely_free_at) : null;
  if (planAt !== null && at > planAt) {
    return when ? `Table ${table} may not be free in time (likely around ${when})` : `Table ${table} may not be free in time`;
  }
  return when ? `Table ${table} likely free by ${when}` : fits;
}

// ── Tables in use by hour ──────────────────────────────────────────────────

// The hour of the day, on the viewer's own clock, that an hour row starts in.
// The server sends each hour as an ISO time; read in local time, 7 PM on the
// chart is 7 PM where the viewer is. The fallback clock: hourOfIn below reads
// the venue's own when its zone is known.
export const localHourOf = (iso) => {
  const t = timeMs(iso);
  return t === null ? null : new Date(t).getHours();
};

// The hour of the day on the VENUE's clock, when its zone is known.
//
// The Analytics chart one card over ("Today, Hour by Hour") is labelled on
// the venue's clock: the server builds it in the IANA zone Google lists for
// the place. This chart read the same instants on the viewer's clock, so an
// owner reading a New York venue from Los Angeles saw the dinner rush at 4 PM
// here and at 7 PM there, and staffing planned off this chart was three hours
// out. So the hours are folded in the venue's zone, the same Google listing
// field, which reaches the dashboard with the venue's own listing when it is
// read this visit (App.js, ownerVenueTimeZone) or on the hours answer when
// the server sends one. With no zone, or one this device cannot keep time in,
// the viewer's clock is the fallback, and the card says which clock it used,
// so an owner away from the venue is not shown the venue's hours as theirs.
// Returns localHourOf itself for the fallback, so a caller can tell.
export const hourOfIn = (timeZone) => {
  if (typeof timeZone !== 'string' || !timeZone) return localHourOf;
  let format;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
  } catch {
    return localHourOf;
  }
  return (iso) => {
    const t = timeMs(iso);
    if (t === null) return null;
    const part = format.formatToParts(t).find((p) => p.type === 'hour');
    const hour = part ? Number(part.value) : NaN;
    // An engine that ignores hourCycle writes midnight as "24".
    return Number.isInteger(hour) ? hour % 24 : null;
  };
};

// Average tables in use for each hour of the day across the window the server
// sent (the last 7 days): every row that starts in that local hour, averaged.
// An hour of the day with no row at all is null rather than zero, because the
// sensor said nothing about it, which is not the same as nobody sitting down.
// `tables` is the most tables any row counted, the top of the chart's scale.
export function tablesByLocalHour(hours, hourOf = localHourOf) {
  const sums = new Array(24).fill(0);
  const counts = new Array(24).fill(0);
  let tables = 0;
  for (const row of Array.isArray(hours) ? hours : []) {
    if (!row) continue;
    const hour = hourOf(row.hour);
    const occupied = num(row.occupied);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || occupied === null || occupied < 0) continue;
    sums[hour] += occupied;
    counts[hour] += 1;
    const total = num(row.total);
    if (total !== null && total > tables) tables = total;
  }
  const slots = sums.map((sum, hour) => ({
    hour,
    avg: counts[hour] ? sum / counts[hour] : null,
    samples: counts[hour],
  }));
  return { slots, tables };
}

// The first hour of the longest run of `flag` hours around the clock, or null
// when no run has a first hour (no hour is flagged, or every hour is). Equal
// runs go to the one earlier in clock order from midnight.
function longestRunStart(flag) {
  let start = null;
  let longest = 0;
  for (let i = 0; i < 24; i += 1) {
    // Only the first hour of a run starts one.
    if (!flag[i] || flag[(i + 23) % 24]) continue;
    let length = 0;
    while (length < 24 && flag[(i + length) % 24]) length += 1;
    if (length > longest) {
      longest = length;
      start = i;
    }
  }
  return start === null ? null : { start, length: longest };
}

// The hours to draw, in clock order, and where the day starts.
//
// A venue with hours that have no row at all (a box switched off overnight,
// the first days of a new unit) starts after the longest run of such hours,
// which for a venue is the hours it is shut: a place open 11 AM to 11 PM gets
// 13 bars instead of 24 with 11 empty. A gap inside the open hours stays in,
// drawn empty.
//
// A box that stays on has a row for every hour, the closed hours at zero, so
// there is no gap to trim, and drawn from midnight a bar open until 2 AM had
// its 10 PM to 1 AM rush split across both ends of the chart. So with a row in
// every hour the day starts at the quietest hour: the first hour of the
// longest run of hours at the day's lowest average, read at the one-decimal
// resolution the chart prints so one reading in a week does not break the
// run. All 24 bars are drawn, and an evening that runs past midnight is one
// continuous run. A day with every hour at the same level starts at midnight.
export function hoursToDraw(slots) {
  const has = slots.map((s) => s.avg !== null);
  if (!has.some(Boolean)) return [];
  if (has.every(Boolean)) {
    const level = slots.map((s) => Math.round(s.avg * 10) / 10);
    const low = Math.min(...level);
    const quiet = longestRunStart(level.map((v) => v === low));
    const first = quiet ? quiet.start : 0;
    return Array.from({ length: 24 }, (_, k) => slots[(first + k) % 24]);
  }
  return hoursInClockOrder(has).map((h) => slots[h]);
}

// The hours of the day with something in them (`has[hour]`), in clock order
// from the end of the longest run of hours with nothing: the closed hours of
// a venue, left off. All 24 from midnight when every hour has something, and
// none when none has. The trim the hours chart uses, shared with the
// turn-time grid.
export function hoursInClockOrder(has) {
  if (!has.some(Boolean)) return [];
  if (has.every(Boolean)) return Array.from({ length: 24 }, (_, h) => h);
  const gap = longestRunStart(has.map((h) => !h));
  const first = (gap.start + gap.length) % 24;
  return Array.from({ length: 24 - gap.length }, (_, k) => (first + k) % 24);
}

// An hour reaching this share of the busiest hour is drawn as busy, so the
// highlight marks the stretch that is near the peak rather than an arbitrary
// top few whose order is within noise of each other.
export const BUSY_SHARE = 0.8;

// Everything the chart draws, or null when there is nothing to draw.
export function tableHoursChart(hours, hourOf = localHourOf) {
  const { slots, tables } = tablesByLocalHour(hours, hourOf);
  const bars = hoursToDraw(slots);
  if (!bars.length) return null;
  const measured = bars.filter((s) => s.avg !== null);
  const peak = measured.reduce((a, b) => (b.avg > a.avg ? b : a));
  const busy = new Set(peak.avg > 0
    ? measured.filter((s) => s.avg >= peak.avg * BUSY_SHARE).map((s) => s.hour)
    : []);
  return { bars, peak, busy, tables };
}

// 8 AM, 12 PM, 7 PM: the form FlockDetail's hour chips use.
export const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;

// The one sentence under the chart that names the peak, or null when no table
// was in use at any hour (or so little that it rounds to nothing).
export function busiestText(chart) {
  if (!chart) return null;
  const avg = Math.round(chart.peak.avg * 10) / 10;
  if (!(avg > 0)) return null;
  const when = hourLabel(chart.peak.hour);
  const all = Math.round(chart.tables);
  return all > 0
    ? `Busiest around ${when}, with ${avg} of ${all} ${all === 1 ? 'table' : 'tables'} in use on average.`
    : `Busiest around ${when}, with ${avg} ${avg === 1 ? 'table' : 'tables'} in use on average.`;
}

// ── Turn times ─────────────────────────────────────────────────────────────

// How many days the stats cover unless the answer says.
export const TABLE_STATS_DAYS = 28;

export const DOW_SHORT = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

// The rows of the grid, Monday first, so a bar's Friday and Saturday sit
// together instead of at the two ends.
export const WEEK_FROM_MONDAY = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

const dowOf = (v) => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
};
const clockHourOf = (v) => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
};
const nonNegative = (v) => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};

// The day-by-hour grid of median turn minutes, or null with nothing to draw.
//   hours   the columns, in clock order, the closed hours left off
//           (hoursInClockOrder)
//   rows    one per day from Monday: { dow, label, cells }, a cell being
//           { dow, hour, median, seatings, shade, busy } or null where the
//           day has no row at that hour. `median` is null where the server
//           had too few seatings in the cell to say (its floor is 20); such
//           a cell is drawn empty and keeps its column, and says nothing
//           else: `shade`, the median against the longest in the grid, 0 to
//           1, and `busy`, the cells with the most seatings (within
//           BUSY_SHARE of the most among the measured cells, the rule the
//           hours chart uses), are read from the cells with a median only,
//           since the server sends a count for every cell, two seatings
//           included, and "Busiest" off two seatings is a planning claim
//           built on less than the server will put a median on. With no
//           measured cell there is nothing to shade or ring, and no grid.
export function turnGrid(byHour) {
  const cells = new Map();
  const has = new Array(24).fill(false);
  let measured = 0;
  let maxMedian = 0;
  let maxSeatings = 0;
  for (const row of Array.isArray(byHour) ? byHour : []) {
    if (!row) continue;
    const dow = dowOf(row.dow);
    const hour = clockHourOf(row.hour);
    if (dow === null || hour === null) continue;
    const median = nonNegative(row.median);
    const seatings = nonNegative(row.seatings) || 0;
    if (median === null && seatings <= 0) continue;
    cells.set(dow * 24 + hour, { dow, hour, median, seatings });
    has[hour] = true;
    if (median === null) continue;
    measured += 1;
    if (median > maxMedian) maxMedian = median;
    if (seatings > maxSeatings) maxSeatings = seatings;
  }
  const hours = hoursInClockOrder(has);
  if (!hours.length || !measured) return null;
  const rows = WEEK_FROM_MONDAY.map((dow) => ({
    dow,
    label: DOW_SHORT[dow],
    cells: hours.map((hour) => {
      const c = cells.get(dow * 24 + hour);
      if (!c) return null;
      return {
        ...c,
        shade: c.median === null || maxMedian <= 0 ? 0 : c.median / maxMedian,
        busy: c.median !== null && maxSeatings > 0 && c.seatings >= maxSeatings * BUSY_SHARE,
      };
    }),
  }));
  return { hours, rows, maxMedian, maxSeatings };
}

// What a screen reader hears for one measured cell of the grid, which is
// otherwise shading and a ring: "Fri 8 PM: typical turn 1 h 5 min", and
// ", most seatings" on a ringed cell. Null for a cell with no median.
export function turnCellLabel(dayLabel, cell) {
  if (!cell || cell.median === null) return null;
  return `${dayLabel} ${hourLabel(cell.hour)}: typical turn ${durationText(cell.median * 60000)}${cell.busy ? ', most seatings' : ''}`;
}

// The one line under the grid that says what its marks mean. "Stronger"
// rather than "darker": after dark the card is the dark surface and a fuller
// cell is the lighter one.
export const TURN_GRID_KEY = 'A stronger blue means a longer typical turn. The amber ring marks the hours with the most seatings.';

// "8 to 10 PM", "11 AM to 1 PM", "11 PM to 2 AM": the hours from `start` to
// `end`, the end exclusive and allowed past 24 for a run over midnight. One
// period word when both ends share it and the run is under twelve hours.
export function hourRangeText(start, end) {
  const h12 = (h) => ((h % 24) + 11) % 12 + 1;
  const period = (h) => ((h % 24) < 12 ? 'AM' : 'PM');
  if (period(start) === period(end) && end - start < 12) return `${h12(start)} to ${h12(end)} ${period(end)}`;
  return `${h12(start)} ${period(start)} to ${h12(end)} ${period(end)}`;
}

// Cells ({ dow, hour }) as "Fri 8 to 10 PM, Sat 7 to 11 PM": consecutive
// hours on one day are one range, days run from Monday, and a range that
// reaches midnight joins the next day's range from midnight, so a Friday that
// is full until 2 AM reads "Fri 11 PM to 2 AM" and not as two ranges. Null
// for no cells.
export function dayHourRanges(cells) {
  const byDow = new Map();
  for (const c of cells) {
    const dow = dowOf(c && c.dow);
    const hour = clockHourOf(c && c.hour);
    if (dow === null || hour === null) continue;
    if (!byDow.has(dow)) byDow.set(dow, new Set());
    byDow.get(dow).add(hour);
  }
  const runs = [];
  for (const dow of WEEK_FROM_MONDAY) {
    const hours = [...(byDow.get(dow) || [])].sort((a, b) => a - b);
    let i = 0;
    while (i < hours.length) {
      let j = i;
      while (j + 1 < hours.length && hours[j + 1] === hours[j] + 1) j += 1;
      const run = { dow, start: hours[i], end: hours[j] + 1 };
      const last = runs[runs.length - 1];
      if (last && last.end === 24 && run.start === 0 && dow === (last.dow + 1) % 7) last.end = 24 + run.end;
      else runs.push(run);
      i = j + 1;
    }
  }
  if (!runs.length) return null;
  return runs.map((r) => `${DOW_SHORT[r.dow]} ${hourRangeText(r.start, r.end)}`).join(', ');
}

// Everything the Turn times section says, from a stats answer, or null for
// no answer. `any` is false when every part is null: too few seatings yet.
export function turnTimes(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const tm = stats.turn_minutes && typeof stats.turn_minutes === 'object' ? stats.turn_minutes : {};
  const grid = turnGrid(tm.by_hour);
  const full = Array.isArray(stats.full_hours)
    ? dayHourRanges(stats.full_hours.filter((r) => r && (r.share === null || r.share === undefined || num(r.share) > 0)))
    : null;
  const days = num(stats.days);
  const out = {
    days: days !== null && Number.isInteger(days) && days > 0 ? days : TABLE_STATS_DAYS,
    median: nonNegative(tm.median),
    grid,
    busiest: grid ? dayHourRanges(grid.rows.flatMap((r) => r.cells.filter((c) => c && c.busy))) : null,
    longest: longestTurnText(grid),
    waited: (() => {
      const s = num(stats.waited_share);
      return s !== null && s >= 0 && s <= 1 ? s : null;
    })(),
    cleared: nonNegative(stats.clear_minutes_median),
    full,
    timeZone: venueZoneOf(stats.timeZone),
  };
  out.any = out.median !== null || out.grid !== null || out.waited !== null || out.cleared !== null || out.full !== null;
  return out;
}

// Whether a zone name is UTC itself, which no listing carries: the server
// folds a venue without a zone in UTC and says so with null today and with
// the string 'UTC' before, and both must read as "no zone", never as the
// venue's clock.
export const isUtcZone = (zone) => typeof zone === 'string' && /^(utc|etc\/utc)$/i.test(zone.trim());

// The venue's zone off a stats answer, or null for none, UTC included.
export const venueZoneOf = (zone) => (typeof zone === 'string' && zone && !isUtcZone(zone) ? zone : null);

// "Half the parties stay under 52 min, half stay longer." is what a median
// means, said without the word.
export const medianTurnText = (minutes) => `Half the parties stay under ${durationText(minutes * 60000)}, half stay longer.`;

// "Waited for a server: 12% of seatings". A share under half a percent is
// "under 1%" rather than a zero that says it never happens.
export function waitedShareText(share) {
  const pct = Math.round(share * 100);
  const words = pct === 0 && share > 0 ? 'under 1%' : `${pct}%`;
  return `Waited for a server: ${words} of seatings`;
}

// "Cleared after: about 4 min, typically". The figure is a median, so
// "typically" rather than "on average", which it is not.
export const clearedText = (minutes) => `Cleared after: about ${durationText(minutes * 60000)}, typically`;

// The cell with the longest median, named: "Longest turns: Fri 8 PM, 65 min".
// Null when no cell has a median. Ties go to the first from Monday.
export function longestTurnText(grid) {
  if (!grid || !(grid.maxMedian > 0)) return null;
  for (const row of grid.rows) {
    const cell = row.cells.find((c) => c && c.median === grid.maxMedian);
    if (cell) return `Longest turns: ${row.label} ${hourLabel(cell.hour)}, ${durationText(cell.median * 60000)}`;
  }
  return null;
}

// The line under the section. The server folds the hours in the venue's
// zone when the listing has one and in UTC when it does not, and this side
// cannot refold a day-by-hour grid, so the words say which it was.
export const turnTimesFooter = (days, timeZone) => (timeZone
  ? `Last ${days} days, on your venue's clock.`
  : `Last ${days} days. Hours in UTC, since your listing has no time zone.`);
