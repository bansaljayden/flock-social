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

/**
 * Run INGEST_SQL against `store` ({ devices, readings }, read at call time so a
 * suite may reassign its arrays between tests). Parameters in INGEST_SQL order:
 *   $1 digest, $2 legacy key, $3 may write, $4 claimed device_id, $5 client
 *   stamped, $6 recorded_at, $7 affects the live figure, $8 guard interval,
 *   $9-$11 the reading.
 */
function runIngest(store, params) {
  const [digest, legacy, mayWrite, claim, clientSupplied, recordedAt, affectsLive, gap, ir, thermal, noise] = params;

  // device: the key lookup, first match, as LIMIT 1 without an ORDER BY.
  const device = store.devices.find((d) => d.api_key === digest || d.api_key === legacy);
  if (!device) return { rows: [], rowCount: 0 };

  // writer: only an active device, only when the handler said it may write,
  // only when a claimed device_id is this device's own.
  const writer = device.is_active === true && mayWrite === true
    && (claim === null || claim === undefined || device.device_id === claim)
    ? device : null;

  // dup: the replay check, only for client-stamped readings.
  const dup = writer && clientSupplied
    ? store.readings.find(
      (r) => r.sensor_device_id === writer.device_id && r.recorded_at.getTime() === recordedAt.getTime()
    )
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

  // ins: never for a duplicate, and on the live figure only once touched.
  let inserted = null;
  if (writer && !dup && (!affectsLive || touched)) {
    const row = {
      venue_place_id: writer.venue_place_id,
      ir_beam_count: ir,
      thermal_headcount: thermal,
      noise_db: noise,
      sensor_device_id: writer.device_id,
      recorded_at: recordedAt || new Date(),
    };
    store.readings.push(row);
    inserted = row.recorded_at;
  }

  return {
    rows: [{
      id: device.id,
      device_id: device.device_id,
      venue_place_id: device.venue_place_id,
      is_active: device.is_active,
      duplicate_of: dup ? dup.recorded_at : null,
      recorded_at: inserted,
    }],
    rowCount: 1,
  };
}

module.exports = { INGEST_STATEMENT, runIngest, intervalToMs };
