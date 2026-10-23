'use strict';
// ---------------------------------------------------------------------------
// TABLE MONITORING: what each table at a venue is doing, from the Flux box.
// ---------------------------------------------------------------------------
// The owner draws the venue's tables on the box's screen once. From then on the
// box counts the people at each table and runs a small state machine per
// table, and each reading it already sends to POST /api/sensors/data carries
// the result in one more field. This module is what the server does with that
// field: the strict parse, the four counts stored on the reading, the live
// state of each table (sensor_table_states, migration 130), and the alert to
// the venue's owner when a table starts waiting or needs clearing.
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
// The log line for an ignored value: once an hour per device at most.
//
// A unit with a firmware bug sends the same bad string with every reading,
// twice a minute, so one line per reading would bury everything else in the
// log. One line an hour still says which unit needs attention and why.
//
// In process memory, and on purpose. This is a log throttle, not a rule: a
// deploy or a second instance costs at most one extra line, and nothing a
// device or a person sees depends on it. Keyed only by device ids that have
// already authenticated, so the map is no bigger than the fleet; the bound is
// there for the day that stops being true, and it evicts the oldest note
// first (utils/cacheKeyInventory.js has the row).
// ---------------------------------------------------------------------------
const IGNORED_NOTE_INTERVAL_MS = 60 * 60 * 1000;
const IGNORED_NOTE_MAX_DEVICES = 1000;
const ignoredNotedAt = new Map();

function noteIgnoredTables(deviceId, reason, now = Date.now()) {
  const last = ignoredNotedAt.get(deviceId);
  if (last !== undefined && now - last < IGNORED_NOTE_INTERVAL_MS) return false;
  // Deleted and set again, so the map's own order stays oldest note first and
  // the bound below always drops the note that matters least.
  ignoredNotedAt.delete(deviceId);
  while (ignoredNotedAt.size >= IGNORED_NOTE_MAX_DEVICES) {
    ignoredNotedAt.delete(ignoredNotedAt.keys().next().value);
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

// ---------------------------------------------------------------------------
// THE LIVE FLOOR: one row per table, replaced by every live reading.
//
// WHICH READINGS. Only the ones GET /api/sensors/:placeId/current could serve
// as the venue's live figure (`affectsLiveFigure` in routes/sensors.js, $7 of
// INGEST_SQL), and only after the reading is stored and the device has its
// answer. A backfilled reading from an hour ago is history, not the floor, so
// it never touches these rows. A live reading with no tables string leaves
// them alone: the contract has no way to say "no tables" other than silence,
// and silence from an older build is not a reason to wipe the floor. Rows that
// stop being refreshed are reported stale by the read route instead.
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
// gone and saved touch disjoint rows (in the reading or not), and the parse
// guarantees each table appears once, so no row is written twice.
//
// Every parameter has one cast, used the same way each time it appears, for
// __tests__/sqlParameterTypes.test.js.
// ---------------------------------------------------------------------------
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
    SELECT s.table_no, s.state FROM sensor_table_states s WHERE s.sensor_device_id = $1::varchar
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
  SELECT v.table_no, v.state, p.state AS prior_state,
         GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (NOW() - v.state_since)) / 60))::int AS minutes
    FROM saved v
    LEFT JOIN prior p ON p.table_no = v.table_no
   ORDER BY v.table_no`;

/**
 * Write one live reading's tables. Resolves to the tables written, each
 * { table_no, state, prior_state, minutes }: prior_state is null for a table
 * that had no row, and minutes is whole minutes since state_since, at least 1.
 * Resolves to [] when the gate found newer rows.
 */
async function storeTableStates(device, tables, recordedAt) {
  const { rows } = await pool.query(TABLE_STATES_SQL, [
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
  return rows;
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
// WHO. The verified owner of the unit's place and nobody else: the
// venue_profiles row for that place with verified true, the same claim GET
// /status and GET /tables ask for. An unverified claim on the place is told
// nothing, and nobody else ever is.
//
// THE SWITCH. venue_profiles.notification_prefs, key `tables`: absent means
// on, false means off. The dashboard writes it through PUT /api/venue-profile,
// which keeps it among the switches it stores (routes/venueProfile.js). It is
// read when the alert is sent, and only then: a send that fails is retried by
// services/pushHelper.js for up to 30 minutes without asking the switch again,
// so an owner who turns alerts off inside that window can still receive the
// one retried alert. Accepted as it stands; deliver() would need a table_alert
// check like its crowd_alert one to close it.
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

    for (const change of changes) {
      try {
        const key = `table_alert:${device.device_id}:${change.table_no}:${change.state}`;
        const claim = await pool.query(TABLE_ALERT_CLAIM_SQL, [key, TABLE_ALERT_WINDOW_MINUTES]);
        if (claim.rowCount === 0) continue;
        const { title, body } = tableAlertCopy(change);
        await pushHelper.pushAlways(ownerId, title, body, {
          type: 'table_alert',
          table: String(change.table_no),
          state: STATE_WORDS[change.state],
        });
      } catch (err) {
        console.error(`Table alert for ${device.device_id} table ${change.table_no} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error(`Table alerts for ${device.device_id} failed:`, err.message);
  }
}

// Work started after an answer has been written, so a test can wait for it to
// finish instead of sleeping and hoping.
const inFlight = new Set();

/**
 * Apply a stored live reading's tables to the floor, then alert the owner
 * about any table that changed into waiting or needs clearing. Called by the
 * ingest AFTER the device has its 201, and never awaited there: it cannot
 * delay the answer, and nothing it does can change it. It never throws and
 * never rejects; a failure is logged, and the reading stays stored either way.
 * The next live reading writes every table again, so one failure costs the
 * floor thirty seconds, not a table.
 */
function applyTableReading(device, tables, recordedAt) {
  const run = (async () => {
    const written = await storeTableStates(device, tables, recordedAt);
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
  applyTableReading,
  wantsTableAlerts,
  tableAlertCopy,
  TABLE_ALERT_WINDOW_MINUTES,
  // Test seams: the throttle is process-global state, and the floor is
  // written after the answer.
  _resetIgnoredNotes: () => ignoredNotedAt.clear(),
  _settled: () => Promise.allSettled([...inFlight]),
};
