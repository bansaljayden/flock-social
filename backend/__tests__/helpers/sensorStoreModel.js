'use strict';
// ---------------------------------------------------------------------------
// A stateful model of routes/sensors.js INGEST_SQL, for the two suites that pin
// the ingest contract without a database: sensorIngest.test.js and
// sensorIngestionIntegrity.test.js.
//
// The ingest is ONE statement (the key lookup, the duplicate check, the flood
// guard, the liveness touch and the insert, as CTEs), so a fake that scripted
// one reply per statement would now be scripting the whole route. This models
// what the statement DOES instead, against the suites' own arrays, so the flood
// guard and the dedupe are actually enforced rather than assumed.
//
// A model is only as good as its agreement with Postgres, which is why it lives
// in one place: __tests__/sensorIngestStatement.test.js drives the real
// statement against a real, migrated schema, and any rule changed there has to
// be changed here in the same commit.
// ---------------------------------------------------------------------------

// The statement, recognised by its key lookup (whitespace already collapsed).
const INGEST_STATEMENT =
  /WITH device AS \( SELECT id, device_id, venue_place_id, is_active FROM sensor_devices WHERE api_key = \$1 OR api_key = \$2/;

function intervalToMs(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(millisecond|second|minute|hour)s?$/.exec(String(text).trim());
  if (!m) throw new Error(`fake db cannot parse interval ${text}`);
  return Number(m[1]) * { millisecond: 1, second: 1000, minute: 60000, hour: 3600000 }[m[2]];
}

const sameReading = (r, deviceId, at) => r.sensor_device_id === deviceId
  && r.recorded_at instanceof Date && at instanceof Date && r.recorded_at.getTime() === at.getTime();

/**
 * Run INGEST_SQL against `store` ({ devices, readings }, read at call time so a
 * suite may reassign its arrays between tests). Parameters in INGEST_SQL order:
 *   $1 digest, $2 legacy key, $3 may write, $4 claimed device_id, $5 client
 *   stamped, $6 recorded_at, $7 affects the live figure, $8 guard interval,
 *   $9-$11 the reading, $12-$15 the occupancy estimate (occupancy, its low
 *   and high band, dwell minutes), each null when the device sent none,
 *   $16-$19 the table counts (total, occupied, waiting, to clear; migration
 *   130), each null when the reading carried no usable tables string.
 *
 * `store.snapshot`, when a suite sets it, is the readings this statement's
 * snapshot can see, for modelling two deliveries that raced: the duplicate
 * check reads the snapshot, while the unique key on (sensor_device_id,
 * recorded_at), migration 082, is checked against every row committed, as
 * Postgres checks an ON CONFLICT arbiter.
 */
function runIngest(store, params) {
  const [digest, legacy, mayWrite, claim, clientSupplied, recordedAt, affectsLive, gap, ir, thermal, noise,
    occupancy, occupancyLow, occupancyHigh, dwellMinutes,
    tablesTotal, tablesOccupied, tablesWaiting, tablesToClear] = params;

  // device: the key lookup, first match, as LIMIT 1 without an ORDER BY.
  const device = store.devices.find((d) => d.api_key === digest || d.api_key === legacy);
  if (!device) return { rows: [], rowCount: 0 };

  // writer: only an active device, only when the handler said it may write,
  // only when a claimed device_id is this device's own.
  const writer = device.is_active === true && mayWrite === true
    && (claim === null || claim === undefined || device.device_id === claim)
    ? device : null;

  // dup: the replay check, only for client-stamped readings, read from the
  // statement's snapshot.
  const visible = Array.isArray(store.snapshot) ? store.snapshot : store.readings;
  const dup = writer && clientSupplied
    ? visible.find((r) => sameReading(r, writer.device_id, recordedAt))
    : undefined;

  // touch: ungated for a re-delivery and for old backfill, guarded otherwise.
  let touched = false;
  if (writer) {
    const gapMs = intervalToMs(gap);
    if (dup || !affectsLive || writer.last_seen_at === null || writer.last_seen_at === undefined
        || Date.now() - writer.last_seen_at >= gapMs) {
      writer.last_seen_at = Date.now();
      touched = true;
    }
  }

  // ins: never for a duplicate, and on the live figure only once touched. ON
  // CONFLICT DO NOTHING on the unique key: a row already committed for this
  // device and instant, whether or not the snapshot saw it, means nothing is
  // stored. raced: an insert that was allowed to run and stored nothing is
  // reported as a duplicate of the stamp it carried.
  let inserted = null;
  let raced = null;
  if (writer && !dup && (!affectsLive || touched)) {
    const at = recordedAt || new Date();
    if (store.readings.some((r) => sameReading(r, writer.device_id, at))) {
      raced = at;
    } else {
      const row = {
        venue_place_id: writer.venue_place_id,
        ir_beam_count: ir,
        thermal_headcount: thermal,
        noise_db: noise,
        occupancy,
        occupancy_low: occupancyLow,
        occupancy_high: occupancyHigh,
        dwell_minutes: dwellMinutes,
        tables_total: tablesTotal,
        tables_occupied: tablesOccupied,
        tables_waiting: tablesWaiting,
        tables_to_clear: tablesToClear,
        sensor_device_id: writer.device_id,
        recorded_at: at,
      };
      store.readings.push(row);
      inserted = row.recorded_at;
    }
  }

  // tables_updated_at: when the device last wrote its table rows (migration
  // 130), for the silence rule. Null for a suite whose store has no floor.
  const tableRows = Array.isArray(store.tableStates)
    ? store.tableStates.filter((r) => r.sensor_device_id === device.device_id)
    : [];
  const tablesUpdatedAt = tableRows.length
    ? new Date(Math.max(...tableRows.map((r) => r.updated_at.getTime())))
    : null;

  return {
    rows: [{
      id: device.id,
      device_id: device.device_id,
      venue_place_id: device.venue_place_id,
      is_active: device.is_active,
      duplicate_of: dup ? dup.recorded_at : raced,
      recorded_at: inserted,
      tables_updated_at: tablesUpdatedAt,
    }],
    rowCount: 1,
  };
}

// ---------------------------------------------------------------------------
// The table-state writer, services/sensorTables.js TABLE_STATES_SQL, modelled
// the same way and for the same suites (sensorTables.test.js). The real
// statement runs against Postgres in sensorIngestStatement.test.js, and a rule
// changed in one has to be changed in the other in the same commit.
// ---------------------------------------------------------------------------

// Recognised by its first two CTEs (whitespace already collapsed): the history
// statement below opens with the same `reading` CTE, so the shape of
// `incoming` is what tells them apart.
const TABLE_STATES_STATEMENT = /WITH reading AS \( SELECT LEAST\(\$3::timestamptz, NOW\(\)\) AS as_of \), incoming AS \( SELECT t\.table_no, t\.people, t\.state, t\.seconds, t\.seats/;

/**
 * Run TABLE_STATES_SQL against `store.tableStates` (an array of rows shaped
 * like sensor_table_states, mutated in place). Parameters in statement order:
 *   $1 device_id, $2 venue place id, $3 the reading's recorded_at, then five
 *   parallel arrays: $4 table numbers, $5 people, $6 states, $7 seconds, $8
 *   seat counts (null where the entry carried none).
 * Returns the written tables as the statement does: { table_no, state,
 * prior_state, minutes }, in table order.
 */
function runTableStates(store, params) {
  const [deviceId, placeId, recordedAt, numbers, people, states, seconds, seats] = params;
  const now = Date.now();
  // reading: the stamp, capped at the server's clock.
  const asOf = new Date(Math.min(new Date(recordedAt).getTime(), now));
  const mine = store.tableStates.filter((r) => r.sensor_device_id === deviceId);
  // gate: rows newer than this reading mean it changes nothing.
  if (mine.some((r) => r.updated_at.getTime() > asOf.getTime())) return { rows: [], rowCount: 0 };
  // prior: read before anything moves, as the statement's snapshot is.
  const prior = new Map(mine.map((r) => [r.table_no, r.state]));
  const priorAt = new Map(mine.map((r) => [r.table_no, r.updated_at]));
  // gone: this device's tables that are not in the reading.
  for (let i = store.tableStates.length - 1; i >= 0; i -= 1) {
    const r = store.tableStates[i];
    if (r.sensor_device_id === deviceId && !numbers.includes(r.table_no)) store.tableStates.splice(i, 1);
  }
  // saved: an upsert per table, behind the same not-older guard.
  const rows = [];
  numbers.forEach((n, i) => {
    const since = new Date(asOf.getTime() - seconds[i] * 1000);
    const sent = seats && seats[i] !== undefined ? seats[i] : null;
    const next = {
      sensor_device_id: deviceId, table_no: n, venue_place_id: placeId,
      people: people[i], state: states[i], state_since: since, updated_at: asOf, seats: sent,
    };
    const existing = store.tableStates.find((r) => r.sensor_device_id === deviceId && r.table_no === n);
    if (existing) {
      if (existing.updated_at.getTime() > asOf.getTime()) return;
      // COALESCE(EXCLUDED.seats, s.seats): no count sent keeps the last one.
      Object.assign(existing, next, { seats: sent === null ? (existing.seats ?? null) : sent });
    } else {
      store.tableStates.push(next);
    }
    rows.push({
      table_no: n,
      state: states[i],
      prior_state: prior.has(n) ? prior.get(n) : null,
      prior_updated_at: priorAt.has(n) ? priorAt.get(n) : null,
      // On the reading's own clock (as_of minus state_since), never NOW().
      minutes: Math.max(1, Math.floor((asOf.getTime() - since.getTime()) / 60000)),
    });
  });
  return { rows, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// The history writer, services/sensorTables.js TABLE_SEATINGS_SQL (migration
// 131), modelled the same way: one seating row per party at a table, opened,
// continued, closed and cleared from the change each table made with the
// reading. The real statement runs in sensorTableHistoryStatement.test.js,
// and a rule changed in one has to be changed in the other in the same commit.
// ---------------------------------------------------------------------------

// Recognised by the shape of its `incoming` CTE (see TABLE_STATES_STATEMENT).
const TABLE_SEATINGS_STATEMENT = /WITH reading AS \( SELECT LEAST\(\$3::timestamptz, NOW\(\)\) AS as_of \), incoming AS \( SELECT t\.table_no, t\.prior_state, t\.state, t\.people, t\.seconds/;

let nextSeatingId = 1;

/**
 * Run TABLE_SEATINGS_SQL against `store.seatings` (an array of rows shaped
 * like sensor_table_seatings, mutated in place; created when absent).
 * Parameters in statement order: $1 device_id, $2 venue place id, $3 the
 * reading's recorded_at, then six parallel arrays: $4 table numbers, $5 the
 * state each table had before the reading (null for none), $6 its state now,
 * $7 people, $8 the seconds its state has held, $9 when its previous row was
 * written (null for none). Open seatings at another venue close (moved).
 * Returns the five counts the
 * statement does.
 */
function runTableSeatings(store, params) {
  const [deviceId, placeId, recordedAt, numbers, priors, states, people, seconds, priorAts = []] = params;
  if (!Array.isArray(store.seatings)) store.seatings = [];
  const asOf = new Date(Math.min(new Date(recordedAt).getTime(), Date.now()));
  // The snapshot every step reads: which seating is open per table, and the
  // latest closed one, BEFORE anything in this statement moves.
  const openByTable = new Map();
  const latestClosedByTable = new Map();
  const counts = { moved: 0, opened: 0, continued: 0, closed: 0, cleared: 0 };
  for (const g of store.seatings) {
    if (g.sensor_device_id !== deviceId) continue;
    // moved: an open seating at another venue closes at the reading's time,
    // and nothing at another venue is continued, closed or cleared.
    if (g.venue_place_id !== placeId) {
      if (g.left_at === null) {
        g.left_at = new Date(Math.max(g.seated_at.getTime(), asOf.getTime()));
        counts.moved += 1;
      }
      continue;
    }
    if (g.left_at === null) openByTable.set(g.table_no, g);
    else {
      const have = latestClosedByTable.get(g.table_no);
      if (!have || g.left_at.getTime() > have.left_at.getTime()
        || (g.left_at.getTime() === have.left_at.getTime() && g.id > have.id)) {
        latestClosedByTable.set(g.table_no, g);
      }
    }
  }
  const inReading = new Set(numbers);
  numbers.forEach((n, i) => {
    const state = states[i];
    const open = openByTable.get(n);
    if ((state === 's' || state === 'w') && !open) {
      store.seatings.push({
        id: nextSeatingId++,
        sensor_device_id: deviceId,
        table_no: n,
        venue_place_id: placeId,
        seated_at: new Date(asOf.getTime() - seconds[i] * 1000),
        left_at: null,
        party_max: people[i],
        waited: state === 'w',
        cleared_at: null,
      });
      counts.opened += 1;
    } else if ((state === 's' || state === 'w') && open) {
      open.party_max = Math.max(open.party_max, people[i]);
      open.waited = open.waited || state === 'w';
      counts.continued += 1;
    } else if ((state === 'f' || state === 'c') && open) {
      // Never later than the table was last seen plus two minutes.
      const cap = priorAts[i] ? new Date(priorAts[i]).getTime() + 2 * 60000 : asOf.getTime();
      const at = state === 'c' ? asOf.getTime() - seconds[i] * 1000 : asOf.getTime();
      open.left_at = new Date(Math.max(open.seated_at.getTime(), Math.min(at, cap)));
      if (state === 'f') open.cleared_at = new Date(Math.max(open.seated_at.getTime(), Math.min(asOf.getTime(), cap)));
      counts.closed += 1;
    }
    if (priors[i] === 'c' && state === 'f') {
      const latest = latestClosedByTable.get(n);
      if (latest && latest.cleared_at === null) {
        latest.cleared_at = asOf;
        counts.cleared += 1;
      }
    }
  });
  // Tables that left the reading close at the reading's time.
  for (const [n, open] of openByTable) {
    if (inReading.has(n)) continue;
    open.left_at = new Date(Math.max(open.seated_at.getTime(), asOf.getTime()));
    counts.closed += 1;
  }
  return { rows: [counts], rowCount: 1 };
}

// ---------------------------------------------------------------------------
// The silence rule, services/sensorTables.js SILENT_UNIT_SQL: a device's table
// rows older than the window before the reading's time (capped at the server
// clock) are deleted, and the open seating of each table so forgotten is
// closed at that time. Modelled and real-run under the same agreement as
// above.
// ---------------------------------------------------------------------------
const SILENT_UNIT_STATEMENT = /^WITH gone AS \( DELETE FROM sensor_table_states s WHERE s\.sensor_device_id = \$1::varchar AND s\.updated_at < LEAST\(\$2::timestamptz, NOW\(\)\) - \(\$3::int \* INTERVAL '1 minute'\) RETURNING s\.table_no, s\.updated_at \) UPDATE sensor_table_seatings g SET left_at = GREATEST\(g\.seated_at, LEAST\(\$2::timestamptz, NOW\(\), gone\.updated_at \+ INTERVAL '2 minutes'\)\) FROM gone WHERE g\.sensor_device_id = \$1::varchar AND g\.table_no = gone\.table_no AND g\.left_at IS NULL$/;

/**
 * Run SILENT_UNIT_SQL against `store.tableStates` and `store.seatings`.
 * Parameters: $1 device_id, $2 the reading's recorded_at, $3 the window in
 * minutes.
 */
function runSilentUnit(store, params) {
  const [deviceId, recordedAt, minutes] = params;
  const asOf = Math.min(new Date(recordedAt).getTime(), Date.now());
  const cutoff = asOf - minutes * 60000;
  const gone = new Map();
  for (let i = store.tableStates.length - 1; i >= 0; i -= 1) {
    const r = store.tableStates[i];
    if (r.sensor_device_id === deviceId && r.updated_at.getTime() < cutoff) {
      store.tableStates.splice(i, 1);
      gone.set(r.table_no, r.updated_at.getTime());
    }
  }
  let closed = 0;
  for (const g of Array.isArray(store.seatings) ? store.seatings : []) {
    if (g.sensor_device_id === deviceId && g.left_at === null && gone.has(g.table_no)) {
      g.left_at = new Date(Math.max(g.seated_at.getTime(), Math.min(asOf, gone.get(g.table_no) + 2 * 60000)));
      closed += 1;
    }
  }
  return { rows: [], rowCount: closed };
}

module.exports = {
  INGEST_STATEMENT, runIngest, intervalToMs, TABLE_STATES_STATEMENT, runTableStates,
  TABLE_SEATINGS_STATEMENT, runTableSeatings, SILENT_UNIT_STATEMENT, runSilentUnit,
};
