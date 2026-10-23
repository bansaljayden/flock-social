'use strict';
// ---------------------------------------------------------------------------
// TABLE MONITORING: what each table at a venue is doing, from the Flux box.
// ---------------------------------------------------------------------------
// The owner draws the venue's tables on the box's screen once. From then on the
// box counts the people at each table and runs a small state machine per
// table, and each reading it already sends to POST /api/sensors/data carries
// the result in one more field. This module is what the server does with that
// field: the strict parse and the four counts stored on the reading.
//
// NOTHING HERE IDENTIFIES OR FOLLOWS A PERSON, and every part of this file is
// held to that. What leaves the Pi is a table number the owner chose, how many
// people are at it, a one-letter state and how long that state has held. No
// track, position, image or id of anybody arrives, so none can be stored.
//
// THE CONTRACT. The Pi side (flock-sensor/) is written to this exactly. An
// optional key `tables`, a STRING, because a sensor payload is scalars only
// (validators/shape.js and the scalarOnly rule on every field of /data).
// Present only when the unit has at least one table zone.
//
//   entries joined by `;`, each N:P:S:A
//   N  table number, 1-40, unique, strictly ascending
//   P  people counted at the table now, 0-30
//   S  f  free
//      s  seated: a party is at the table
//      w  seated, and nobody has come by since the party sat down, for longer
//         than the unit's wait limit (5 minutes unless the owner changed it)
//      c  the party left and nobody has cleared the table yet
//   A  seconds since that state began, 0-86400 (the unit caps it). For s and
//      w it is the seconds since the party arrived: the seated timer.
//
//   1:0:f:340;2:3:s:845;3:2:w:410;4:0:c:95
//
// At most 40 entries, and nothing longer than 600 characters is looked at.
//
// A BAD VALUE IS IGNORED, NEVER REFUSED. The Pi reads 400, 413 and 422 as "this
// reading can never succeed" and drops the WHOLE reading (flock-sensor/main.py,
// FATAL_PAYLOAD_STATUSES), so refusing one for a malformed tables string would
// throw away its three counts and its occupancy estimate with it. The string is
// dropped instead, the way routes/sensors.js drops an occupancy band that
// contradicts its own estimate: the reading is stored without it, the device
// is answered 201, and the server log says so at most once an hour per device,
// naming the problem and never repeating the value.
// ---------------------------------------------------------------------------

const MAX_TABLES = 40;
const MAX_TABLE_PEOPLE = 30;
// The unit caps A at a day, so anything above it was not written by one.
const MAX_STATE_SECONDS = 86400;
// Forty of the longest entry ("40:30:w:86400") and their separators come to
// 559 characters, so nothing honest is near this, and the pattern below is
// never asked to look at a megabyte.
const MAX_TABLES_LENGTH = 600;

// One entry, in canonical decimal only: no sign, no leading zero, no exponent,
// no space. Each number is bounded in length here and in range in parseTables,
// so a 400-digit "table number" is refused before Number() ever sees it.
// Anchored at both ends (a JS `$` without the m flag does not match before a
// trailing newline), and every repetition starts with a `;` the entry cannot
// contain, so the pattern has nothing to backtrack over.
const TABLES_SHAPE =
  /^[1-9]\d?:(?:0|[1-9]\d?):[fswc]:(?:0|[1-9]\d{0,4})(?:;[1-9]\d?:(?:0|[1-9]\d?):[fswc]:(?:0|[1-9]\d{0,4})){0,39}$/;

// The words the owner's dashboard is given for each letter, so no client has
// to carry the box's alphabet.
const STATE_WORDS = Object.freeze({ f: 'free', s: 'seated', w: 'waiting', c: 'needs_clearing' });

/**
 * The strict parse. Returns { ok: true, tables } with tables as
 * [{ number, people, state, seconds }] in table order, or { ok: false, reason }
 * where the reason names the problem in words and never quotes the value.
 */
function parseTables(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' };
  if (raw.length === 0) return { ok: false, reason: 'empty' };
  if (raw.length > MAX_TABLES_LENGTH) return { ok: false, reason: `longer than ${MAX_TABLES_LENGTH} characters` };
  if (!TABLES_SHAPE.test(raw)) return { ok: false, reason: 'not N:P:S:A entries joined by semicolons' };

  const tables = [];
  let previous = 0;
  for (const entry of raw.split(';')) {
    const [n, p, state, a] = entry.split(':');
    const number = Number(n);
    const people = Number(p);
    const seconds = Number(a);
    if (number > MAX_TABLES) return { ok: false, reason: `a table number above ${MAX_TABLES}` };
    // Strictly ascending is what makes the numbers unique, and a repeated
    // number would ask the state writer to set one row twice in one statement.
    if (number <= previous) return { ok: false, reason: 'table numbers not strictly ascending' };
    if (people > MAX_TABLE_PEOPLE) return { ok: false, reason: `a head count above ${MAX_TABLE_PEOPLE}` };
    if (seconds > MAX_STATE_SECONDS) return { ok: false, reason: `a state age above ${MAX_STATE_SECONDS} seconds` };
    tables.push({ number, people, state, seconds });
    previous = number;
  }
  return { ok: true, tables };
}

/**
 * What the ingest makes of the field. `refusedByValidator` is true when the
 * express-validator chain in routes/sensors.js had an error on `tables` (not a
 * single string, or longer than the limit); that chain is never allowed to
 * turn into a 400 for this field, so its verdict arrives here instead.
 *
 * Returns { tables, ignored }: tables is the parsed list or null, and ignored
 * is null or the reason a value that was sent is being dropped.
 */
function readTables(value, refusedByValidator) {
  if (refusedByValidator) {
    return { tables: null, ignored: `not one string of at most ${MAX_TABLES_LENGTH} characters` };
  }
  // Absent, or an explicit null: a unit with no table zones, or older firmware.
  if (value === undefined || value === null) return { tables: null, ignored: null };
  const parsed = parseTables(value);
  return parsed.ok ? { tables: parsed.tables, ignored: null } : { tables: null, ignored: parsed.reason };
}

/**
 * The four counts stored on the reading, for the "tables in use by hour" chart.
 * Occupied is seated plus waiting: a waiting table has a party at it. All four
 * are null when the reading carried no usable string, which is the truth for
 * it, exactly as the occupancy estimate is null on older firmware.
 */
function tableCounts(tables) {
  if (!tables) return { tablesTotal: null, tablesOccupied: null, tablesWaiting: null, tablesToClear: null };
  let occupied = 0;
  let waiting = 0;
  let toClear = 0;
  for (const t of tables) {
    if (t.state === 's' || t.state === 'w') occupied += 1;
    if (t.state === 'w') waiting += 1;
    if (t.state === 'c') toClear += 1;
  }
  return { tablesTotal: tables.length, tablesOccupied: occupied, tablesWaiting: waiting, tablesToClear: toClear };
}

// ---------------------------------------------------------------------------
// The log line for an ignored value: once an hour per device at most.
//
// A unit with a firmware bug sends the same bad string with every reading,
// twice a minute, so one line per reading would bury everything else in the
// log. One line an hour still says which unit needs attention and why.
//
// In process memory, and on purpose. This is a log throttle, not a rule: a
// deploy or a second instance costs at most one extra line, and nothing a
// device or a person sees depends on it. Keyed only by device ids that have
// already authenticated, so the set is no bigger than the fleet; the prune is
// there for the day that stops being true.
// ---------------------------------------------------------------------------
const IGNORED_NOTE_INTERVAL_MS = 60 * 60 * 1000;
const IGNORED_NOTE_MAX_DEVICES = 1000;
const ignoredNotedAt = new Map();

function noteIgnoredTables(deviceId, reason, now = Date.now()) {
  const last = ignoredNotedAt.get(deviceId);
  if (last !== undefined && now - last < IGNORED_NOTE_INTERVAL_MS) return false;
  if (ignoredNotedAt.size >= IGNORED_NOTE_MAX_DEVICES) {
    for (const [id, at] of ignoredNotedAt) {
      if (now - at >= IGNORED_NOTE_INTERVAL_MS) ignoredNotedAt.delete(id);
    }
    if (ignoredNotedAt.size >= IGNORED_NOTE_MAX_DEVICES) ignoredNotedAt.clear();
  }
  ignoredNotedAt.set(deviceId, now);
  // The reason, never the value: the value is whatever the device (or whoever
  // holds its key) chose to send, and a log line is not a place to replay it.
  console.warn(
    `Sensor ${deviceId}: a reading's tables value was ignored (${reason}). The reading was stored without it. `
    + 'Logged at most once an hour per device.'
  );
  return true;
}

module.exports = {
  MAX_TABLES,
  MAX_TABLE_PEOPLE,
  MAX_STATE_SECONDS,
  MAX_TABLES_LENGTH,
  STATE_WORDS,
  parseTables,
  readTables,
  tableCounts,
  noteIgnoredTables,
  // Test seam: the throttle is process-global state.
  _resetIgnoredNotes: () => ignoredNotedAt.clear(),
};
