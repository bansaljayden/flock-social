// TABLE MONITORING ON THE OWNER DASHBOARD: THE WORDS AND THE ARITHMETIC.
//
// A venue's Flux sensor can be set up with table zones. It counts the people
// in each zone and keeps a state for every table: free, seated, waiting (seated
// past the five-minute limit with nobody stopping by yet) or needs_clearing
// (the party has left and the table has not been cleared). Two routes hand
// that to the venue's verified owner and to nobody else:
//
//   GET /api/sensors/:placeId/tables
//     { tables: [{ number, people, state, since, seats }], updated_at, stale, next_free }
//     `since` is when the state began, and for seated and waiting it is when
//     the party sat down. `seats` is optional, null when unknown. `stale` is
//     true once the sensor has not reported for over 3 minutes. `next_free`
//     is the seated or waiting table seated longest, or null.
//
//   GET /api/sensors/:placeId/tables/hours
//     { hours: [{ hour, occupied, total }] } for the last 7 days, oldest first.
//
// This file turns those answers into the sentences and bar heights that the
// dashboard's Tables tab draws (components/venue/tables/). Nothing here
// estimates: every figure is one the sensor sent, or an average of them.

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

// The server's pick for the table likely to free up next: the seated or
// waiting table seated longest. Said only while that table is on the list as
// seated or waiting, so the line never names a table its tile contradicts.
export function nextFreeText(data, tables, nowMs) {
  const pick = data ? num(data.next_free) : null;
  if (pick === null) return null;
  const table = tables.find((t) => t.number === pick && (t.state === 'seated' || t.state === 'waiting'));
  if (!table) return null;
  const ms = msSince(table.since, nowMs);
  return ms === null
    ? `Next likely free: Table ${table.number}`
    : `Next likely free: Table ${table.number} (seated ${durationText(ms)})`;
}

// "3 of 8 free".
export function freeSummary(tables) {
  const free = tables.filter((t) => t.state === 'free').length;
  return `${free} of ${tables.length} free`;
}

// What follows "Sensor offline." while the sensor is quiet. The tiles keep
// its last reading, so the line says how old that reading is and what it saw.
export function staleDetail(tables, updatedAtMs, nowMs) {
  const free = tables.filter((t) => t.state === 'free').length;
  const were = free === 1 ? 'was' : 'were';
  const ms = updatedAtMs === null ? null : msSince(new Date(updatedAtMs), nowMs);
  return ms === null
    ? `At its last reading ${free} of ${tables.length} ${were} free.`
    : `Last reading ${durationText(ms)} ago, when ${free} of ${tables.length} ${were} free.`;
}

// ── Tables in use by hour ──────────────────────────────────────────────────

// The hour of the day, on the viewer's own clock, that an hour row starts in.
// The server sends each hour as an ISO time; read in local time, 7 PM on the
// chart is 7 PM where the owner is.
export const localHourOf = (iso) => {
  const t = timeMs(iso);
  return t === null ? null : new Date(t).getHours();
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

// The hours to draw, in clock order, starting after the longest run of hours
// with no data, which for a venue is the hours it is shut. A place open 11 AM
// to 11 PM gets 13 bars instead of 24 with 11 empty, and a bar open until 2 AM
// reads 6 PM to 1 AM in one run instead of breaking at midnight. A gap inside
// the open hours stays in, drawn empty.
export function hoursToDraw(slots) {
  const has = slots.map((s) => s.avg !== null);
  if (!has.some(Boolean)) return [];
  if (has.every(Boolean)) return slots.slice();
  let gapStart = 0;
  let gapLength = 0;
  for (let i = 0; i < 24; i += 1) {
    // Only the first hour of a gap starts a run.
    if (has[i] || !has[(i + 23) % 24]) continue;
    let length = 0;
    while (length < 24 && !has[(i + length) % 24]) length += 1;
    if (length > gapLength) {
      gapLength = length;
      gapStart = i;
    }
  }
  const first = (gapStart + gapLength) % 24;
  return Array.from({ length: 24 - gapLength }, (_, k) => slots[(first + k) % 24]);
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
