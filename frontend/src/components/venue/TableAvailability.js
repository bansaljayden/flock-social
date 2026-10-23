/**
 * THE TABLE LINE.
 *
 * One sentence about tables at a venue whose Flux sensor watches them, drawn
 * wherever the app shows that venue: a vote row, a venue card in the chat, a
 * search result, a map pin, the venue sheet, the plan. The summary it is
 * written from comes from lib/tableSummaries.js, which asks the server
 * ({ open, total, party, fits_now, wait_minutes, busy_hours, updated_at,
 * stale }); this file only chooses the words.
 *
 * THE WORDS, in the order they are tried:
 *
 *   fits_now            "Table for 5 open now"
 *                       ("Table open now" in the compact form when the party
 *                       is the default two: the number adds nothing there and
 *                       the line has one row to fit in.)
 *   wait_minutes known  "About 10 min for a table for 5"
 *   open, none fits     "3 tables open, none seats 5"
 *   none open           "No tables open right now"
 *
 * STALE MEANS NOTHING LIVE. When the sensor has stopped reporting the server
 * says so, and a sentence in the present tense would then be a claim about a
 * room nobody is watching. What can still be said is the pattern: "Usually
 * full Fri 8 to 10 PM", from busy_hours, consecutive hours folded into one
 * range per day, the range nearest to now first, at most two of them (one in
 * the compact form). The hours are on the venue's clock; the phone's clock
 * only decides which range is nearest, and the venue is near the phone in
 * every case this line is drawn for.
 *
 * TWO FORMS. The compact form is one truncating line for lists, under a
 * venue's name. The full form, for the venue sheet and the plan, adds the
 * busy hours under the live line and a caption saying where the figure came
 * from, "Live from the venue's Flux sensor", because a figure with no source
 * is the thing App Review rejects and DESIGN-STANDARD rule 5 forbids.
 *
 * NOTHING IS GUESSED. A summary with none of the figures draws nothing, and
 * nothing here says "about" or "likely" of anything the server did not send.
 * The forecast ("Table for 5 likely free at 8:00") lands with plan item I3
 * and is not written from this contract.
 */
import React from 'react';
import { TABLE_PARTY_DEFAULT, clampParty, usableSummary } from '../../lib/tableSummaries';

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const isHour = (h) => Number.isInteger(h) && h >= 0 && h <= 23;
const isDow = (d) => Number.isInteger(d) && d >= 0 && d <= 6;

// The party a line is written for: the one the server judged the fit for,
// which is the one that was asked, else the caller's.
export function partyOf(summary, party) {
  if (summary && Number.isInteger(summary.party) && summary.party >= 1) return clampParty(summary.party);
  return clampParty(party);
}

// "8 PM", "12 AM". 24 is midnight at the end of a day.
export function hourLabel(h) {
  const hour = ((h % 24) + 24) % 24;
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${hour < 12 ? 'AM' : 'PM'}`;
}

// "8 to 10 PM" when both ends share a half of the day, "11 AM to 1 PM" when
// they do not. `end` is the hour the range ends at, so a single busy hour of
// 20 reads "8 to 9 PM".
export function hourRangeLabel(start, end) {
  const a = hourLabel(start);
  const b = hourLabel(end);
  const halfA = a.slice(-2);
  const halfB = b.slice(-2);
  if (halfA === halfB) return `${a.slice(0, -3)} to ${b}`;
  return `${a} to ${b}`;
}

// busy_hours folded into ranges: [{ dow, start, end }], consecutive hours on
// one day as one range, sorted by how soon each starts from `now` (a range
// that is on right now comes first). Rows that are not a day and an hour are
// left out.
export function busyRanges(busyHours, now = new Date()) {
  const byDay = new Map();
  for (const row of Array.isArray(busyHours) ? busyHours : []) {
    if (!row || !isDow(row.dow) || !isHour(row.hour)) continue;
    if (!byDay.has(row.dow)) byDay.set(row.dow, new Set());
    byDay.get(row.dow).add(row.hour);
  }
  const ranges = [];
  byDay.forEach((hours, dow) => {
    const sorted = Array.from(hours).sort((a, b) => a - b);
    let start = null;
    let prev = null;
    sorted.forEach((h) => {
      if (start === null) { start = h; prev = h; return; }
      if (h === prev + 1) { prev = h; return; }
      ranges.push({ dow, start, end: prev + 1 });
      start = h;
      prev = h;
    });
    if (start !== null) ranges.push({ dow, start, end: prev + 1 });
  });
  const nowDow = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const week = 7 * 24 * 60;
  const minutesUntil = (r) => {
    const startAt = ((r.dow - nowDow + 7) % 7) * 24 * 60 + r.start * 60 - nowMinutes;
    const endAt = ((r.dow - nowDow + 7) % 7) * 24 * 60 + r.end * 60 - nowMinutes;
    // On right now.
    if (startAt <= 0 && endAt > 0) return 0;
    // Already over today: next week's.
    if (endAt <= 0) return startAt + week;
    return startAt;
  };
  return ranges
    .map((r) => ({ ...r, soon: minutesUntil(r) }))
    .sort((a, b) => a.soon - b.soon || a.dow - b.dow || a.start - b.start)
    .map(({ soon, ...r }) => r);
}

// "Usually full Fri 8 to 10 PM", "Usually full Fri 8 to 10 PM and Sat 9 to
// 11 PM", the day said once when both ranges share it. Null with no hours.
export function busyHoursText(summary, max = 2, now = new Date()) {
  const ranges = busyRanges(summary && summary.busy_hours, now).slice(0, Math.max(1, max));
  if (ranges.length === 0) return null;
  const parts = ranges.map((r, i) => {
    const sameDay = i > 0 && ranges[i - 1].dow === r.dow;
    return `${sameDay ? '' : `${DAY_SHORT[r.dow]} `}${hourRangeLabel(r.start, r.end)}`;
  });
  return `Usually full ${parts.join(' and ')}`;
}

// The live sentence, or null when there is nothing live to say (a stale
// sensor, a summary with no figures).
export function tableLineText(summary, party = TABLE_PARTY_DEFAULT, compact = false) {
  if (!usableSummary(summary) || summary.stale) return null;
  const n = partyOf(summary, party);
  const forN = `for ${n}`;
  if (summary.fits_now === true) {
    return compact && n === TABLE_PARTY_DEFAULT ? 'Table open now' : `Table ${forN} open now`;
  }
  const wait = Number(summary.wait_minutes);
  if (Number.isFinite(wait) && wait >= 1) {
    return `About ${Math.round(wait)} min for a table ${forN}`;
  }
  const open = Number(summary.open);
  if (Number.isFinite(open) && open > 0) {
    return `${Math.round(open)} ${Math.round(open) === 1 ? 'table' : 'tables'} open, none seats ${n}`;
  }
  if (Number.isFinite(open) && open === 0) return 'No tables open right now';
  return null;
}

// One line for a list or a pin: the live sentence, else the nearest busy
// range when the sensor is stale, else nothing.
export function tableCompactText(summary, party = TABLE_PARTY_DEFAULT, now = new Date()) {
  const live = tableLineText(summary, party, true);
  if (live) return live;
  if (usableSummary(summary) && summary.stale) return busyHoursText(summary, 1, now);
  return null;
}

export default function TableAvailability({ summary, party = TABLE_PARTY_DEFAULT, compact = false, style, className }) {
  if (!usableSummary(summary)) return null;
  if (compact) {
    const text = tableCompactText(summary, party);
    if (!text) return null;
    return (
      <p
        data-table-line="compact"
        className={className}
        style={{
          margin: 0,
          fontSize: 'var(--t-meta)',
          fontWeight: 500,
          color: 'var(--text-secondary)',
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          ...style,
        }}
      >
        {text}
      </p>
    );
  }
  const live = tableLineText(summary, party, false);
  const busy = busyHoursText(summary, 2);
  if (!live && !busy) return null;
  return (
    <div data-table-line="full" className={className} style={{ minWidth: 0, ...style }}>
      {live && (
        <p style={{ margin: 0, fontSize: 'var(--t-label)', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>{live}</p>
      )}
      {busy && (
        <p style={{ margin: live ? '3px 0 0' : 0, fontSize: 'var(--t-meta)', fontWeight: 500, color: 'var(--text-secondary)', lineHeight: 1.35 }}>{busy}</p>
      )}
      <p style={{ margin: '4px 0 0', fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)' }}>
        {live ? "Live from the venue's Flux sensor" : "From the venue's Flux sensor. Not live right now."}
      </p>
    </div>
  );
}
