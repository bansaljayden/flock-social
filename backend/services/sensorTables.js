'use strict';
// ---------------------------------------------------------------------------
// TABLE MONITORING: what each table at a venue is doing, from the Flux box.
// ---------------------------------------------------------------------------
// The owner draws the venue's tables on the box's screen once. From then on the
// box counts the people at each table and runs a small state machine per
// table, and each reading it already sends to POST /api/sensors/data carries
// the result in one more field. This module is what the server does with that
// field: the strict parse, the four counts stored on the reading, the live
// state of each table (sensor_table_states, migration 130), the history of
// seatings built from the changes between readings (sensor_table_seatings,
// migration 131, THE HISTORY below), and the alert to the venue's owner when
// a table starts waiting or needs clearing. What is read back out of the
// history (turn times, waits, the public summary) is services/tableHistory.js.
//
// NOTHING HERE IDENTIFIES OR FOLLOWS A PERSON, and every part of this file is
// held to that. What leaves the Pi is a table number the owner chose, how many
// people are at it, a one-letter state and how long that state has held. No
// track, position, image or id of anybody arrives, so none can be stored.
//
// THE CONTRACT. The Pi side (flock-sensor/) is written to this exactly. An
// optional key `tables`, a STRING, because a sensor payload is scalars only
// (validators/shape.js and the scalarOnly rule on every field of /data).
// Present only when the unit has at least one table zone. A unit that sends
// it pushes a reading at least every 60 seconds, whatever its push interval
// is set to (the box warns when a longer one is configured): the floor is
// called stale TABLES_STALE_AFTER_MINUTES after its last row, and a unit on a
// five-minute interval would read as offline for most of every interval.
// A unit that stops sending it says nothing: the box cannot say "no tables".
// The server keeps the unit's table rows through ten minutes of such silence,
// which covers its model yielding nothing for a reading or two, and deletes
// them at the first live reading without the field after that, which is the
// owner having removed the last table zone or a build without tables
// (SILENCE below). Agreed with the box side.
//
//   entries joined by `;`, each N:P:S:A or N:P:S:A:C
//   N  table number, 1-200, unique, strictly ascending. A box sends at most
//      40 tables, but numbers run to 200 so that a venue with more than one
//      box (a second room, a big floor) can number its tables apart: each box
//      starts where the last one ended (TABLE_NUMBER_START on the box).
//   P  people counted at the table now, 0-30
//   S  f  free
//      s  seated: a party is at the table. The box says so once someone has
//         been there 60 seconds, but times the seating from the first moment
//         someone was.
//      w  seated, and nobody has come by since the party sat down, for longer
//         than the box's wait limit (TABLE_WAIT_SECONDS, 300 unless the owner
//         changed it). A visit turns it back to s for the rest of that
//         seating, so a seating waits at most once.
//      c  the party left and nobody has cleared the table yet: the box says
//         so after 90 seconds empty. It goes back to f once someone spends 5
//         to 60 seconds at the empty table (bussing it), or after 3 hours.
//   A  seconds since that state began, 0-86400 (the unit caps it). For s and
//      w it is the seconds since the party arrived: the seated timer. For c it
//      is the seconds since the table emptied.
//   C  optional: the seats at the table, 1-30, sent only when the unit knows
//      it (a table camera will count chairs). Entries with and without it mix
//      freely in one string.
//
//   1:0:f:340;2:3:s:845:4;3:2:w:410;4:0:c:95:6
//
// At most 40 entries, and nothing longer than 800 characters is looked at.
// Any part out of range, C included, makes the whole value invalid.
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

const pool = require('../config/database');
// Held as a module object, not destructured: tests replace pushAlways, and a
// destructured copy would keep calling the original.
const pushHelper = require('./pushHelper');
// The plan rule the table routes enforce, asked before a table alert too.
const venueEntitlements = require('./venueEntitlements');

const MAX_TABLES = 40;
const MAX_TABLE_NUMBER = 200;
const MAX_TABLE_PEOPLE = 30;
// The unit caps A at a day, so anything above it was not written by one.
const MAX_STATE_SECONDS = 86400;
const MIN_TABLE_SEATS = 1;
const MAX_TABLE_SEATS = 30;
// The contract's ceiling, and the pattern below is never asked to look at a
// megabyte. The longest legal string, forty tables each at every limit with a
// seat count ("200:30:w:86400:30"), is 719 characters, so 800 always holds a
// whole list. That is the point of the number: a live reading replaces the
// unit's rows, so a list the box had to cut short would read here as tables
// the owner removed. The box cuts at a whole entry under the same ceiling, and
// with 800 that path never runs on a legal list.
const MAX_TABLES_LENGTH = 800;

// One entry, in canonical decimal only: no sign, no leading zero, no exponent,
// no space. Each number is bounded in length here and in range in parseTables,
// so a 400-digit "table number" is refused before Number() ever sees it. The
// optional seat count is a fifth field, and 0 is not a seat count. Anchored at
// both ends (a JS `$` without the m flag does not match before a trailing
// newline). Each field ends at a `:` or `;` it cannot contain, and every
// repetition starts with a `;`, so the pattern has nothing to backtrack over.
const TABLE_ENTRY = String.raw`[1-9]\d{0,2}:(?:0|[1-9]\d?):[fswc]:(?:0|[1-9]\d{0,4})(?::[1-9]\d?)?`;
const TABLES_SHAPE = new RegExp(`^${TABLE_ENTRY}(?:;${TABLE_ENTRY}){0,${MAX_TABLES - 1}}$`);

// The words the owner's dashboard is given for each letter, so no client has
// to carry the box's alphabet.
const STATE_WORDS = Object.freeze({ f: 'free', s: 'seated', w: 'waiting', c: 'needs_clearing' });

/**
 * The strict parse. Returns { ok: true, tables } with tables as
 * [{ number, people, state, seconds, seats }] in table order (seats null where
 * the entry carried none), or { ok: false, reason } where the reason names the
 * problem in words and never quotes the value.
 */
function parseTables(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' };
  if (raw.length === 0) return { ok: false, reason: 'empty' };
  if (raw.length > MAX_TABLES_LENGTH) return { ok: false, reason: `longer than ${MAX_TABLES_LENGTH} characters` };
  if (!TABLES_SHAPE.test(raw)) return { ok: false, reason: 'not N:P:S:A entries joined by semicolons' };

  const tables = [];
  let previous = 0;
  for (const entry of raw.split(';')) {
    const [n, p, state, a, c] = entry.split(':');
    const number = Number(n);
    const people = Number(p);
    const seconds = Number(a);
    const seats = c === undefined ? null : Number(c);
    if (number > MAX_TABLE_NUMBER) return { ok: false, reason: `a table number above ${MAX_TABLE_NUMBER}` };
    // Strictly ascending is what makes the numbers unique, and a repeated
    // number would ask the state writer to set one row twice in one statement.
    if (number <= previous) return { ok: false, reason: 'table numbers not strictly ascending' };
    if (people > MAX_TABLE_PEOPLE) return { ok: false, reason: `a head count above ${MAX_TABLE_PEOPLE}` };
    if (seconds > MAX_STATE_SECONDS) return { ok: false, reason: `a state age above ${MAX_STATE_SECONDS} seconds` };
    if (seats !== null && (seats < MIN_TABLE_SEATS || seats > MAX_TABLE_SEATS)) {
      return { ok: false, reason: `a seat count outside ${MIN_TABLE_SEATS}-${MAX_TABLE_SEATS}` };
    }
    tables.push({ number, people, state, seconds, seats });
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
// Two log lines, each once an hour per key at most.
//
// An ignored value: a unit with a firmware bug sends the same bad string with
// every reading, twice a minute, so one line per reading would bury
// everything else in the log. One line an hour still says which unit needs
// attention and why. Keyed by device id.
//
// A table-number clash: two units at one place reporting the same table
// number, which the floor read settles by showing the newer row (routes/
// sensors.js TABLE_FLOOR_SQL). The dashboard reads every 15 seconds for as
// long as it is open, so the clash would otherwise be a line every 15 seconds
// until a box is renumbered. Keyed by place.
//
// In process memory, and on purpose. These are log throttles, not rules: a
// deploy or a second instance costs at most one extra line, and nothing a
// device or a person sees depends on them. Keyed only by device ids that have
// already authenticated and by places a verified owner has read, so neither
// map is bigger than the fleet; the bound is there for the day that stops
// being true, and it evicts the oldest note first (utils/cacheKeyInventory.js
// has both rows).
// ---------------------------------------------------------------------------
const NOTE_INTERVAL_MS = 60 * 60 * 1000;
const NOTE_MAX_KEYS = 1000;
const ignoredNotedAt = new Map();
const clashNotedAt = new Map();

// Whether a line may be written for `key` now, and the note that it was.
function noteOnceAnHour(notes, key, now) {
  const last = notes.get(key);
  if (last !== undefined && now - last < NOTE_INTERVAL_MS) return false;
  // Deleted and set again, so the map's own order stays oldest note first and
  // the bound below always drops the note that matters least.
  notes.delete(key);
  while (notes.size >= NOTE_MAX_KEYS) {
    notes.delete(notes.keys().next().value);
  }
  notes.set(key, now);
  return true;
}

function noteIgnoredTables(deviceId, reason, now = Date.now()) {
  if (!noteOnceAnHour(ignoredNotedAt, deviceId, now)) return false;
  // The reason, never the value: the value is whatever the device (or whoever
  // holds its key) chose to send, and a log line is not a place to replay it.
  console.warn(
    `Sensor ${deviceId}: a reading's tables value was ignored (${reason}). The reading was stored without it. `
    + 'Logged at most once an hour per device.'
  );
  return true;
}

/**
 * Say that two units at a place report the same table number(s). `clashes` is
 * [{ table_no, shown, hidden }] with the two units' device ids: the ids and
 * the numbers, and nothing about what is at the tables.
 */
function noteTableClash(placeId, clashes, now = Date.now()) {
  if (!noteOnceAnHour(clashNotedAt, placeId, now)) return false;
  const units = [...new Set(clashes.flatMap((c) => [c.shown, c.hidden]))].sort();
  const numbers = [...new Set(clashes.map((c) => c.table_no))].sort((a, b) => a - b);
  console.warn(
    `Venue ${placeId}: units ${units.join(', ')} report the same table number${numbers.length > 1 ? 's' : ''} `
    + `(${numbers.join(', ')}); the newer row is shown. Set TABLE_NUMBER_START on one box so they number apart. `
    + 'Logged at most once an hour per place.'
  );
  return true;
}

// ---------------------------------------------------------------------------
// THE LIVE FLOOR: one row per table, replaced by every live reading.
//
// WHICH READINGS. Only the ones GET /api/sensors/:placeId/current could serve
// as the venue's live figure (`affectsLiveFigure` in routes/sensors.js, $7 of
// INGEST_SQL), and only after the reading is stored and the device has its
// answer. A backfilled reading from an hour ago is history, not the floor, so
// it never touches these rows. A live reading with no tables string leaves
// them alone for ten minutes and then forgets them (SILENCE below): the
// contract has no way to say "no tables" other than silence, a moment of it
// is the box's model yielding nothing for a reading, and ten minutes of it is
// the owner having removed the last table or a unit running a build without
// tables. Rows that stop being refreshed are reported stale by the read route
// in the meantime.
//
// ONE STATEMENT, for the reason INGEST_SQL is one: the database is a network
// round trip away. In it, all reading the same snapshot:
//   reading  the time the figures were true: the reading's stamp, capped at
//            the server's clock, so a device clock running ahead cannot date
//            a table in the future. For a live push the two are seconds apart.
//   gate     a reading older than the rows already hold changes nothing. The
//            device delivers oldest first, so this only matters when two
//            deliveries cross, and then the newer one must win.
//   prior    each table's state BEFORE this reading, for the alert, which
//            fires on a change of state and never on a repeat.
//   gone     this device's tables that are not in the reading: the owner
//            removed them on the box.
//   saved    every table in the reading, upserted. state_since is the
//            reading's time minus A, so it holds still from one reading to
//            the next while the state does. A table sent without a seat
//            count keeps the one it had: chairs do not move with every
//            reading, and a unit that counts them may not send the count
//            every time.
//   minutes  whole minutes since the party arrived, on the reading's own
//            clock: as_of minus state_since is the A the unit sent. Not
//            NOW(): a reading that sat in the box's buffer through an outage
//            would otherwise have its delay added to the party's wait, and
//            "Seated 12 min" would be said of a party seated for five.
// gone and saved touch disjoint rows (in the reading or not), and the parse
// guarantees each table appears once, so no row is written twice.
//
// ONE WRITER PER UNIT AT A TIME. The statement runs in a transaction that
// first takes a transaction-scoped advisory lock on the unit, so two table
// writes for one unit run one after the other. Two can overlap: the ingest
// never awaits this, the pool has twenty connections, and a drain delivers a
// reading every two seconds. Without the lock an older reading's statement
// could start before a newer one's commit and read the snapshot from before
// it: its gate would say fresh, its DELETE would remove a table the newer
// reading had just written, and its upsert would bring back one the newer
// reading removed, and the floor would be wrong until the next reading. With
// it, the second statement starts after the first commits, sees its rows,
// and the gate holds. The lock is released with the commit. BEGIN, the lock
// and COMMIT are three more short round trips on one connection, all after
// the device has its answer, so they cost nothing anybody waits for.
//
// Every parameter has one cast, used the same way each time it appears, for
// __tests__/sqlParameterTypes.test.js.
// ---------------------------------------------------------------------------
// How long the floor stays the present: a unit sending tables pushes at least
// every 60 seconds (the contract above), so three minutes without a fresh row
// is at least three missed readings, and the dashboard is told the floor is
// stale rather than shown an old one as now. The alert reads the same number,
// below, so a push never describes a floor the dashboard would call stale.
const TABLES_STALE_AFTER_MINUTES = 3;

// Work started after an answer has been written (the floor write, the alert,
// the forgetting of a silent unit's rows), so a test can wait for it to
// finish instead of sleeping and hoping.
const inFlight = new Set();

// The unit's lock (ONE WRITER PER UNIT AT A TIME above), in the namespaced
// form every advisory lock in this codebase uses, so it can never collide
// with a vote's or a budget's.
const TABLE_WRITE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('sensor_tables:' || $1::text))";

const TABLE_STATES_SQL = `
  WITH reading AS (
    SELECT LEAST($3::timestamptz, NOW()) AS as_of
  ),
  incoming AS (
    SELECT t.table_no, t.people, t.state, t.seconds, t.seats
      FROM unnest($4::smallint[], $5::smallint[], $6::text[], $7::integer[], $8::smallint[])
           AS t(table_no, people, state, seconds, seats)
  ),
  gate AS (
    SELECT NOT EXISTS (
      SELECT 1 FROM sensor_table_states s, reading r
       WHERE s.sensor_device_id = $1::varchar AND s.updated_at > r.as_of
    ) AS fresh
  ),
  prior AS (
    SELECT s.table_no, s.state, s.updated_at FROM sensor_table_states s WHERE s.sensor_device_id = $1::varchar
  ),
  gone AS (
    DELETE FROM sensor_table_states s
     USING gate g
     WHERE g.fresh
       AND s.sensor_device_id = $1::varchar
       AND s.table_no <> ALL ($4::smallint[])
  ),
  saved AS (
    INSERT INTO sensor_table_states AS s
           (sensor_device_id, table_no, venue_place_id, people, state, state_since, updated_at, seats)
    SELECT $1::varchar, i.table_no, $2::varchar, i.people, i.state,
           r.as_of - i.seconds * INTERVAL '1 second', r.as_of, i.seats
      FROM incoming i, reading r, gate g
     WHERE g.fresh
    ON CONFLICT (sensor_device_id, table_no) DO UPDATE
       SET venue_place_id = EXCLUDED.venue_place_id,
           people = EXCLUDED.people,
           state = EXCLUDED.state,
           state_since = EXCLUDED.state_since,
           updated_at = EXCLUDED.updated_at,
           seats = COALESCE(EXCLUDED.seats, s.seats)
     WHERE s.updated_at <= EXCLUDED.updated_at
    RETURNING s.table_no, s.state, s.state_since
  )
  SELECT v.table_no, v.state, p.state AS prior_state, p.updated_at AS prior_updated_at,
         GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (r.as_of - v.state_since)) / 60))::int AS minutes
    FROM saved v
   CROSS JOIN reading r
    LEFT JOIN prior p ON p.table_no = v.table_no
   ORDER BY v.table_no`;

// ---------------------------------------------------------------------------
// THE HISTORY: one row per seating (sensor_table_seatings, migration 131),
// written in the floor's transaction, after the floor, from the change each
// table made with this reading. The floor says what a table is doing now; a
// seating says how long a party sat, whether it waited and how long the
// table then stood uncleared, which is what a turn time, a wait estimate and
// the owner's stats are made of. Nothing in a seating says who sat there: a
// table number, four times and a head count.
//
// FROM THE CHANGE, NEVER FROM THE STATE ALONE. The floor statement reports
// each table's state before the reading (prior_state), and that is what this
// compares with:
//   f, c or no row -> s or w   OPENS a seating, seated_at the reading's time
//                              minus the unit's seated timer (A), which for s
//                              and w is the seconds since the party arrived,
//                              so a seating is dated from the moment the
//                              party sat, not from the reading that first
//                              said so. party_max is the head count, waited
//                              is true when the table is already w. A table's
//                              first reading ever opens one only this way: a
//                              first reading of f or c has no party to count.
//   s or w -> s or w           CONTINUES it: party_max keeps the most people
//                              seen while open, and any reading in w sets
//                              waited, which stays set.
//   s or w -> c                CLOSES it: left_at is the reading's time minus
//                              A, which for c is the seconds since the table
//                              emptied, so the party left when it left, not
//                              when the box noticed 90 seconds later.
//   s or w -> f                CLOSES it at the reading's time, and clears it
//                              as it closes: the box only says needs-clearing
//                              after 90 seconds empty, so a table seen free
//                              again was cleared inside that, and the clear
//                              took no measurable time. Without this the next
//                              c -> f at the table would be read as its clear,
//                              hours late.
//   c -> f                     sets cleared_at on the table's latest closed
//                              seating that has none: the table was bussed.
//   not in the reading         CLOSES its open seating at the reading's time:
//                              the owner removed the table on the box.
//   the unit moved venue       CLOSES every open seating it holds at another
//                              venue at the reading's time, and only seatings
//                              at its current venue are continued, closed or
//                              cleared, so a table seated at the new venue
//                              opens a fresh seating there instead of
//                              stretching one from the old venue.
// A CLOSE IS NEVER LATER THAN THE TABLE WAS LAST SEEN, PLUS A GRACE. A box that
// lost power at eleven with twelve tables seated says so the next morning;
// dated at that reading, its closes would be twelve turns of twelve hours.
// So a close from the change is capped at the table's previous row's
// updated_at plus two minutes (the floor statement hands it over as
// prior_updated_at), which is later than the reading itself whenever readings
// arrive at their usual pace and changes nothing then. The silence rule
// below caps the same way, and services/tableHistory.js leaves any seating
// over six hours out of every figure besides.
// The open seating of a table is the one with left_at NULL, so each step is
// idempotent and a reading replayed in order changes nothing twice; the
// steps touch disjoint rows (a table is in one of them, and the clear step
// reaches only rows already closed in the snapshot), which is what lets them
// be one statement. left_at is never earlier than seated_at, whatever timer
// the unit sent.
//
// IN THE FLOOR'S TRANSACTION, AFTER THE FLOOR, BEHIND A SAVEPOINT. The same
// unit lock serialises it with the floor, so the change it reads is the
// change the floor just made. The savepoint is so that a failure here (a
// constraint the box found a way to trip, a bug in a statement nobody has
// run on that data) costs this reading's history and nothing else: the
// floor still commits, the device already has its answer, and the next
// reading finds the open seatings as they were and carries on. Logged like
// every failure after the answer.
//
// Every parameter has one cast, used the same way each time it appears, for
// __tests__/sqlParameterTypes.test.js.
// ---------------------------------------------------------------------------
const TABLE_SEATINGS_SQL = `
  WITH reading AS (
    SELECT LEAST($3::timestamptz, NOW()) AS as_of
  ),
  incoming AS (
    SELECT t.table_no, t.prior_state, t.state, t.people, t.seconds, t.prior_updated_at
      FROM unnest($4::smallint[], $5::text[], $6::text[], $7::smallint[], $8::integer[], $9::timestamptz[])
           AS t(table_no, prior_state, state, people, seconds, prior_updated_at)
  ),
  moved AS (
    UPDATE sensor_table_seatings g
       SET left_at = GREATEST(g.seated_at, r.as_of)
      FROM reading r
     WHERE g.sensor_device_id = $1::varchar
       AND g.left_at IS NULL
       AND g.venue_place_id <> $2::varchar
    RETURNING g.id
  ),
  open_now AS (
    SELECT o.id, o.table_no
      FROM sensor_table_seatings o
     WHERE o.sensor_device_id = $1::varchar AND o.left_at IS NULL
       AND o.venue_place_id = $2::varchar
  ),
  opened AS (
    INSERT INTO sensor_table_seatings (sensor_device_id, table_no, venue_place_id, seated_at, party_max, waited)
    SELECT $1::varchar, i.table_no, $2::varchar,
           r.as_of - i.seconds * INTERVAL '1 second', i.people, i.state = 'w'
      FROM incoming i, reading r
     WHERE i.state IN ('s', 'w')
       AND NOT EXISTS (SELECT 1 FROM open_now o WHERE o.table_no = i.table_no)
    RETURNING id
  ),
  continued AS (
    UPDATE sensor_table_seatings g
       SET party_max = GREATEST(g.party_max, i.people),
           waited = g.waited OR i.state = 'w'
      FROM open_now o
      JOIN incoming i ON i.table_no = o.table_no
     WHERE g.id = o.id
       AND i.state IN ('s', 'w')
    RETURNING g.id
  ),
  closed AS (
    UPDATE sensor_table_seatings g
       SET left_at = GREATEST(g.seated_at, LEAST(
                              CASE WHEN i.state = 'c' THEN r.as_of - i.seconds * INTERVAL '1 second' ELSE r.as_of END,
                              COALESCE(i.prior_updated_at + INTERVAL '2 minutes', r.as_of))),
           cleared_at = CASE WHEN i.state = 'f'
                             THEN GREATEST(g.seated_at, LEAST(r.as_of, COALESCE(i.prior_updated_at + INTERVAL '2 minutes', r.as_of)))
                             ELSE g.cleared_at END
      FROM open_now o
     CROSS JOIN reading r
      LEFT JOIN incoming i ON i.table_no = o.table_no
     WHERE g.id = o.id
       AND (i.table_no IS NULL OR i.state IN ('f', 'c'))
    RETURNING g.id
  ),
  cleared AS (
    UPDATE sensor_table_seatings g
       SET cleared_at = r.as_of
      FROM reading r
     WHERE g.cleared_at IS NULL
       AND g.id IN (
         SELECT (SELECT c.id
                   FROM sensor_table_seatings c
                  WHERE c.sensor_device_id = $1::varchar
                    AND c.venue_place_id = $2::varchar
                    AND c.table_no = i.table_no
                    AND c.left_at IS NOT NULL
                  ORDER BY c.left_at DESC, c.id DESC
                  LIMIT 1)
           FROM incoming i
          WHERE i.prior_state = 'c' AND i.state = 'f')
    RETURNING g.id
  )
  SELECT (SELECT COUNT(*) FROM moved)::int AS moved,
         (SELECT COUNT(*) FROM opened)::int AS opened,
         (SELECT COUNT(*) FROM continued)::int AS continued,
         (SELECT COUNT(*) FROM closed)::int AS closed,
         (SELECT COUNT(*) FROM cleared)::int AS cleared`;

// The history statement's parameters: the tables the floor statement wrote,
// each with its state before the reading, joined back to the head count and
// timer the reading carried for it.
function seatingParams(device, tables, recordedAt, written) {
  const sent = new Map(tables.map((t) => [t.number, t]));
  const rows = written.map((w) => ({ ...sent.get(Number(w.table_no)), number: Number(w.table_no), prior: w.prior_state, priorUpdatedAt: w.prior_updated_at, state: w.state }));
  return [
    device.device_id,
    device.venue_place_id,
    recordedAt,
    rows.map((r) => r.number),
    rows.map((r) => (r.prior == null ? null : r.prior)),
    rows.map((r) => r.state),
    rows.map((r) => r.people),
    rows.map((r) => r.seconds),
    rows.map((r) => (r.priorUpdatedAt == null ? null : r.priorUpdatedAt)),
  ];
}

/**
 * Write one live reading's tables, and the seatings they open, continue and
 * close. Resolves to the tables written, each { table_no, state, prior_state,
 * minutes }: prior_state is null for a table that had no row, and minutes is
 * whole minutes from state_since to the reading's own time, at least 1.
 * Resolves to [] when the gate found newer rows, and then writes no history
 * either.
 */
async function storeTableStates(device, tables, recordedAt) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(TABLE_WRITE_LOCK_SQL, [device.device_id]);
    const { rows } = await client.query(TABLE_STATES_SQL, [
      device.device_id,
      device.venue_place_id,
      recordedAt,
      tables.map((t) => t.number),
      tables.map((t) => t.people),
      tables.map((t) => t.state),
      tables.map((t) => t.seconds),
      // null where the entry carried no seat count; the upsert keeps the old one.
      tables.map((t) => (t.seats === undefined ? null : t.seats)),
    ]);
    if (rows.length > 0) {
      await client.query('SAVEPOINT history');
      try {
        await client.query(TABLE_SEATINGS_SQL, seatingParams(device, tables, recordedAt, rows));
      } catch (err) {
        // The floor commits without this reading's history (THE HISTORY
        // above); the next reading carries on from the open seatings.
        await client.query('ROLLBACK TO SAVEPOINT history');
        console.error(`Table history for ${device.device_id} failed after the reading was stored; the floor was kept:`, err.message);
      }
    }
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// SILENCE: a live reading with no `tables` from a unit that has table rows.
//
// The box cannot say "no tables". When the owner removes the last table zone
// it stops sending the field, and it also stops for a moment when its model
// yields nothing for a reading or two. The two look the same from here and
// need opposite answers, so time tells them apart (agreed with the box side):
// the unit's rows are kept through SILENT_UNIT_MINUTES of silence and deleted
// by the first live reading without tables after that. Measured on the
// reading's own clock, like everything in the floor, so a drain after an
// outage judges each reading by when it was taken, not when it arrived, and
// a reading older than the rows (two deliveries crossing) deletes nothing. A
// string that was sent and ignored is not silence: the unit still has tables,
// and a bug that noteIgnoredTables names.
//
// NO ROUND TRIP FOR MOST READINGS. Most units have no table rows at all, and
// the ingest is pinned to one statement, so that statement reports when the
// unit last wrote its rows (INGEST_SQL, tables_updated_at) and the DELETE is
// sent only when there is something old enough to delete: once per silence,
// since afterwards there are no rows to report. The DELETE still carries the
// rule in its WHERE, so a row a newer reading wrote in the meantime survives
// it, and no lock is needed for one statement that re-checks its own
// condition on the row it reaches.
//
// AND THE HISTORY CLOSES WITH THE ROWS. A table the unit has stopped
// reporting cannot be sat at as far as this server knows, so the open
// seating of every table the DELETE forgets is closed at that moment, in the
// same statement, dated no later than the row's last update plus two
// minutes (THE HISTORY says why), so that a seating cannot be left open by a unit that went
// quiet about its tables and sit there inflating the next turn-time median.
// Only the tables the DELETE actually removed: a row a newer reading wrote
// survives the DELETE and keeps its seating open.
// ---------------------------------------------------------------------------
const SILENT_UNIT_MINUTES = 10;
const SILENT_UNIT_SQL = `
  WITH gone AS (
    DELETE FROM sensor_table_states s
     WHERE s.sensor_device_id = $1::varchar
       AND s.updated_at < LEAST($2::timestamptz, NOW()) - ($3::int * INTERVAL '1 minute')
    RETURNING s.table_no, s.updated_at
  )
  UPDATE sensor_table_seatings g
     SET left_at = GREATEST(g.seated_at, LEAST($2::timestamptz, NOW(), gone.updated_at + INTERVAL '2 minutes'))
    FROM gone
   WHERE g.sensor_device_id = $1::varchar
     AND g.table_no = gone.table_no
     AND g.left_at IS NULL`;

/**
 * Forget a unit's table rows once a live reading without tables finds them
 * older than SILENT_UNIT_MINUTES. `device` is the ingest statement's row, with
 * tables_updated_at. Called like applyTableReading: after the 201, never
 * awaited, never throws. Resolves to null when there is nothing to do.
 */
function applySilentReading(device, recordedAt) {
  const lastWrite = device.tables_updated_at;
  if (!lastWrite) return null;
  const asOf = Math.min(new Date(recordedAt).getTime(), Date.now());
  if (new Date(lastWrite).getTime() >= asOf - SILENT_UNIT_MINUTES * 60 * 1000) return null;
  const run = (async () => {
    await pool.query(SILENT_UNIT_SQL, [device.device_id, recordedAt, SILENT_UNIT_MINUTES]);
  })().catch((err) => {
    console.error(`Table states for ${device.device_id} could not be forgotten after the reading was stored:`, err.message);
  });
  inFlight.add(run);
  run.then(() => inFlight.delete(run));
  return run;
}

// ---------------------------------------------------------------------------
// THE TABLE ALERT: one push to the venue's verified owner when a table starts
// waiting, or is left needing a clear.
//
// WHEN. A table whose state CHANGED with this reading into w (seated, and
// nobody has come by for longer than the unit's wait limit) or into c (the
// party left and the table has not been cleared), judged against the table's
// row from before the reading. A table that stays waiting across fifty
// readings is told once, not fifty times. A table with no row before has no
// change to report: that is the first reading after the table was drawn, or
// after this shipped, and a burst of alerts about tables that may have been
// waiting since before anybody was watching tells the owner nothing new.
//
// ONLY FROM A RECENT READING. The floor is written from any live reading (the
// 15-minute window /current reads), but an alert only from one at most
// TABLE_ALERT_MAX_AGE_MS old, measured from the reading's own stamp. After an
// outage the box drains its buffer oldest first, one reading every two
// seconds, and each is the floor as it was minutes ago: a table that started
// waiting at minute two and was visited at minute five would ring the phone
// about a wait that ended, seconds before the reading that ended it arrives.
// The ceiling is TABLES_STALE_AFTER_MINUTES, so a push never describes a floor
// the dashboard would call stale, and it is longer than the box's wait after
// one failed delivery (its first backoff step is 60 seconds), so one failure
// does not cost an alert. The trade, accepted: a state that begins inside a
// longer gap and still holds when the drain catches up is on the dashboard
// and never pushed, because the first recent reading finds the replayed row
// already in that state. An old reading spends no claim.
//
// AT MOST ONE PER UNIT, TABLE AND STATE IN 15 MINUTES. The box already lets a
// seating wait only once (a visit ends waiting for the rest of it), so this is
// the ceiling over everything the box cannot see: a table turned over fast, a
// unit restarted mid-seating, a wait limit set very low. However the states
// move, one table cannot ring the owner's phone about the same thing twice in
// fifteen minutes; the dashboard shows every change, the phone gets the first.
// Claimed in push_debounce, not a Map: a Map is per process, so it is empty
// after every deploy and a second server instance would keep a copy of its
// own, each allowing an alert of its own. sweepPushMaintenance keeps a row
// there for an hour, longer than the window, so the window and the table
// agree. Claimed only once every refusal (no push service, no verified owner,
// the switch off, no Roost) has passed, so a refused alert does not burn it.
//
// AND AT MOST ONE PER VENUE IN 2 MINUTES, over that. The table window bounds
// each table, not the phone: forty tables are eighty table-and-state keys, so
// one reading could ring the owner eighty times, and whoever holds a unit's
// key (routes/sensors.js opens with the walked-off Pi) could make it do so
// every fifteen minutes. One more push_debounce claim, table_alert:venue:
// <place>, lets one push through per venue per window; the tables after it,
// in the same reading or the next, are on the dashboard, which shows every
// change. The venue claim is taken after the table's, so a table already told
// of inside its fifteen minutes does not spend the venue's one push, and a
// reading's changes are tried in table order, so the lowest-numbered changed
// table is the one named. Two minutes is shorter than any seating and well
// inside the hour push_debounce rows are kept.
//
// WHO. The verified owner of the unit's place and nobody else: the
// venue_profiles row for that place with verified true, the same claim GET
// /status and GET /tables ask for. An unverified claim on the place is told
// nothing, and nobody else ever is.
//
// THE SWITCH. venue_profiles.notification_prefs, key `tables`: absent means
// on, false means off. The dashboard writes it through PUT /api/venue-profile,
// which keeps it among the switches it stores (routes/venueProfile.js). It is
// read when the alert is sent, and only then, which is enough because a send
// that fails is dropped, never retried: table_alert is in NEVER_RETRIED in
// services/pushHelper.js, so no copy waits in push_outbox to be released
// minutes later, past the switch, past the owner's verification, with words
// about a moment that has passed. The claims above stay spent for it: the
// dashboard shows the table, and the next change is news again.
//
// THE PLAN. Table monitoring is a Roost feature, so an alert goes out only
// while the venue is on Roost: the same rule, through the same decision, as
// GET /tables (venueEntitlements.checkVenueTier). With venue billing off
// every venue qualifies, as every gate there agrees. A plan lookup that fails
// sends nothing, which is the gate's fail-closed answer applied to a push: an
// alert that does not go out costs a glance at the dashboard, and the next
// change tries again.
//
// THE WORDS name a table and how long its party has sat. No head count, no
// guest, no price, no offer: transactional under App Store 4.5.4, for the
// reason the header of services/pushHelper.js gives for table_alert.
//
// AFTER THE ANSWER, like everything here: a push service that is down, slow or
// throwing costs the owner a notification and costs the device nothing.
// ---------------------------------------------------------------------------
const ALERT_STATES = new Set(['w', 'c']);
const TABLE_ALERT_WINDOW_MINUTES = 15;
const TABLE_ALERT_VENUE_WINDOW_MINUTES = 2;
const TABLE_ALERT_MAX_AGE_MS = TABLES_STALE_AFTER_MINUTES * 60 * 1000;
const TABLE_ALERT_CLAIM_SQL = `
  INSERT INTO push_debounce (debounce_key, sent_at)
  VALUES ($1, NOW())
  ON CONFLICT (debounce_key) DO UPDATE
     SET sent_at = NOW()
   WHERE push_debounce.sent_at < NOW() - ($2::int * INTERVAL '1 minute')
  RETURNING debounce_key`;

// One row at most: the partial unique index on venue_profiles allows a single
// VERIFIED claim per place.
const VENUE_OWNER_SQL = `
  SELECT user_id, notification_prefs
    FROM venue_profiles
   WHERE google_place_id = $1 AND verified = true
   LIMIT 1`;

// Absent means on, false means off. A value that is not an object (a legacy
// row) is "never touched", which is on, the same as an empty object.
function wantsTableAlerts(prefs) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return true;
  return prefs.tables !== false;
}

// The copy, exactly. `minutes` is whole minutes since the party arrived (the
// seated timer the unit keeps for s and w), never less than 1.
function tableAlertCopy(change) {
  const title = `Table ${change.table_no}`;
  if (change.state === 'w') {
    const minutes = Math.max(1, Math.floor(Number(change.minutes)) || 1);
    return { title, body: `Seated ${minutes} min and nobody has stopped by yet.` };
  }
  return { title, body: "The party left and the table hasn't been cleared." };
}

// The tables in a write that changed INTO a state worth telling the owner about.
function alertWorthy(written) {
  return written.filter((r) => r.prior_state != null && r.prior_state !== r.state && ALERT_STATES.has(r.state));
}

// Whether a reading is recent enough to alert from (ONLY FROM A RECENT READING
// above). A stamp a little ahead of this clock is recent.
function recentEnoughToAlert(recordedAt, now = Date.now()) {
  return now - new Date(recordedAt).getTime() <= TABLE_ALERT_MAX_AGE_MS;
}

async function alertOwner(device, changes) {
  try {
    // No push service, no work: nothing is read and no claim is spent on a push
    // that cannot go anywhere.
    if (!pushHelper.isPushConfigured()) return;
    const owner = await pool.query(VENUE_OWNER_SQL, [device.venue_place_id]);
    if (owner.rows.length === 0) return;
    const { user_id: ownerId, notification_prefs: prefs } = owner.rows[0];
    if (!wantsTableAlerts(prefs)) return;
    const plan = await venueEntitlements.checkVenueTier(ownerId, 'pro');
    if (!plan.ok) return;

    const venueKey = `table_alert:venue:${device.venue_place_id}`;
    for (const change of changes) {
      let spentTheVenueWindow = false;
      try {
        const key = `table_alert:${device.device_id}:${change.table_no}:${change.state}`;
        const claim = await pool.query(TABLE_ALERT_CLAIM_SQL, [key, TABLE_ALERT_WINDOW_MINUTES]);
        if (claim.rowCount === 0) continue;
        // The venue's one push per window. Refused: the rest of this reading
        // would be refused by the same row, so nothing more is tried.
        const venue = await pool.query(TABLE_ALERT_CLAIM_SQL, [venueKey, TABLE_ALERT_VENUE_WINDOW_MINUTES]);
        if (venue.rowCount === 0) return;
        spentTheVenueWindow = true;
        const { title, body } = tableAlertCopy(change);
        await pushHelper.pushAlways(ownerId, title, body, {
          type: 'table_alert',
          table: String(change.table_no),
          state: STATE_WORDS[change.state],
        });
      } catch (err) {
        console.error(`Table alert for ${device.device_id} table ${change.table_no} failed:`, err.message);
      }
      // Sent or not, the window went to this table; the rest are on the
      // dashboard.
      if (spentTheVenueWindow) return;
    }
  } catch (err) {
    console.error(`Table alerts for ${device.device_id} failed:`, err.message);
  }
}

/**
 * Apply a stored live reading's tables to the floor, then, if the reading is
 * recent, alert the owner about any table that changed into waiting or needs
 * clearing. Called by the ingest AFTER the device has its 201, and never
 * awaited there: it cannot delay the answer, and nothing it does can change
 * it. It never throws and never rejects; a failure is logged, and the reading
 * stays stored either way. The next live reading writes every table again, so
 * one failure costs the floor thirty seconds, not a table.
 */
function applyTableReading(device, tables, recordedAt) {
  const run = (async () => {
    const written = await storeTableStates(device, tables, recordedAt);
    if (!recentEnoughToAlert(recordedAt)) return;
    const changes = alertWorthy(written);
    if (changes.length > 0) await alertOwner(device, changes);
  })().catch((err) => {
    console.error(`Table states for ${device.device_id} failed after the reading was stored:`, err.message);
  });
  inFlight.add(run);
  run.then(() => inFlight.delete(run));
  return run;
}

module.exports = {
  MAX_TABLES,
  MAX_TABLE_NUMBER,
  MAX_TABLE_PEOPLE,
  MAX_STATE_SECONDS,
  MIN_TABLE_SEATS,
  MAX_TABLE_SEATS,
  MAX_TABLES_LENGTH,
  STATE_WORDS,
  parseTables,
  readTables,
  tableCounts,
  noteIgnoredTables,
  noteTableClash,
  applyTableReading,
  applySilentReading,
  SILENT_UNIT_MINUTES,
  wantsTableAlerts,
  tableAlertCopy,
  TABLE_ALERT_WINDOW_MINUTES,
  TABLE_ALERT_VENUE_WINDOW_MINUTES,
  TABLE_ALERT_MAX_AGE_MS,
  TABLES_STALE_AFTER_MINUTES,
  // Test seams: the log throttles are process-global state, and the floor is
  // written after the answer.
  _resetIgnoredNotes: () => { ignoredNotedAt.clear(); clashNotedAt.clear(); },
  _settled: () => Promise.allSettled([...inFlight]),
};
