'use strict';

// ---------------------------------------------------------------------------
// THE LABEL QUARANTINE (2026-11-27).
//
// From 23 October 2026 the data provider's live endpoint answered with values
// made from its own weekly forecast while still flagging them as live. They
// sit in ml_training_data as label_source 'live', indistinguishable row by
// row from the real readings before them. labelQuarantine.json names the
// window and the evidence; this module is the one reading of it, so serving,
// the export, preparation and the evaluation scripts cannot disagree about
// which readings are real.
//
// A window is closed (from_date and through_date both set) on what was found.
// The file refuses an open window: "everything from here on" is a decision
// about readings nobody has looked at yet, and the guard for those is the
// repetition check in train/prepare_features.py, not a date.
// ---------------------------------------------------------------------------

const RAW = require('./labelQuarantine.json');

const DAY_MS = 86400000;

// 'YYYY-MM-DD' -> whole days since 1970-01-01 UTC, the same day number
// mlPredictor.slotDayNumber gives a stored reading's date. Null for anything
// that is not a real calendar date.
function dayNumber(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo || back.getUTCDate() !== d) return null;
  return Math.round(ms / DAY_MS);
}

function validate(raw) {
  if (!raw || !Array.isArray(raw.windows)) throw new Error('labelQuarantine.json: no windows array');
  const ids = new Set();
  return raw.windows.map((w, i) => {
    const where = `labelQuarantine.json windows[${i}]`;
    if (!w || typeof w.id !== 'string' || !w.id) throw new Error(`${where}: no id`);
    if (ids.has(w.id)) throw new Error(`${where}: duplicate id ${w.id}`);
    ids.add(w.id);
    if (w.label_source !== 'live') throw new Error(`${where}: label_source must be 'live'`);
    const fromDay = dayNumber(w.from_date);
    const throughDay = dayNumber(w.through_date);
    if (fromDay === null) throw new Error(`${where}: from_date ${w.from_date} is not a date`);
    if (throughDay === null) throw new Error(`${where}: through_date must be a date (an open window is refused)`);
    if (throughDay < fromDay) throw new Error(`${where}: through_date is before from_date`);
    if (!Array.isArray(w.evidence) || w.evidence.length === 0) throw new Error(`${where}: no evidence`);
    return Object.freeze({ id: w.id, labelSource: w.label_source, fromDate: w.from_date, throughDate: w.through_date, fromDay, throughDay });
  });
}

const WINDOWS = Object.freeze(validate(RAW));

// The window a day number falls in, or null.
function windowForDay(day, windows = WINDOWS) {
  if (!Number.isInteger(day)) return null;
  for (const w of windows) if (day >= w.fromDay && day <= w.throughDay) return w;
  return null;
}

// Whether a reading's local date ('YYYY-MM-DD') with this label_source is quarantined.
function isQuarantinedDate(dateStr, labelSource = 'live', windows = WINDOWS) {
  if (labelSource !== 'live') return false;
  return windowForDay(dayNumber(dateStr), windows) !== null;
}

// A parsed reading list (mlPredictor.parseOffsetReadings / parseRecentReadings:
// entries carry slot = day * 24 + hour) without its quarantined readings. Null
// stays null, so "no list" and "an empty list" keep their meanings.
function withoutQuarantinedSlots(list, windows = WINDOWS) {
  if (!Array.isArray(list)) return list;
  return list.filter((r) => !(r && Number.isInteger(r.slot) && windowForDay(Math.floor(r.slot / 24), windows)));
}

// Whether the span [fromMs, toMs] (instants) can hold a reading dated inside a
// window. A window's dates are the venue's local calendar (observed_date), and
// a venue-local date differs from the UTC date of the same instant by at most
// one day either way (UTC-12 to UTC+14), so the span is widened by a day on
// each side before the calendar days are compared: a Los Angeles reading dated
// 25 November at 20:00 was taken on 26 November in UTC. Used where a number
// was built from readings nobody can list any more (the stored single offset):
// erring wide there refuses a median, which serving answers with no offset.
function overlapsQuarantine(fromMs, toMs, windows = WINDOWS) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
  const a = Math.floor(Math.min(fromMs, toMs) / DAY_MS) - 1;
  const b = Math.floor(Math.max(fromMs, toMs) / DAY_MS) + 1;
  return windows.some((w) => a <= w.throughDay && b >= w.fromDay);
}

module.exports = { WINDOWS, dayNumber, validate, windowForDay, isQuarantinedDate, withoutQuarantinedSlots, overlapsQuarantine };
