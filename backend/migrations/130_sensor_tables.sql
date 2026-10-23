-- 130: table monitoring. What each table at a venue is doing, from the Flux
-- sensor, and how many tables were in use with each reading.
--
-- ASCII only, like 065, 082, 091-095: the embedded server the boot-safety
-- suite runs is WIN1252.
--
-- WHY. The owner draws the venue's tables on the box's screen once. From then
-- on the box counts the people at each table and runs a small state machine
-- per table: free, seated, seated and nobody has come by for longer than the
-- unit's wait limit, and the party has left but the table has not been
-- cleared. It sends the result with each reading as one short string (the
-- contract is in services/sensorTables.js). Without somewhere to keep it the
-- owner's dashboard has nothing to show and nobody can be told that table 3
-- has been waiting ten minutes.
--
-- WHAT IT HOLDS, AND WHAT IT NEVER WILL. A table number the owner chose, a
-- head count, a one-letter state and when that state began. Nothing here
-- identifies or follows a person: the box sends no track, position, image or
-- id of anyone, only per-table counts and states, and that is all this
-- migration has room for.
--
-- WHO WRITES IT.
--   venue_sensor_data.tables_total / tables_occupied (seated or waiting) /
--   tables_waiting / tables_to_clear: routes/sensors.js INGEST_SQL, counted
--   from the string on every reading that carried a valid one. NULL on a
--   reading that did not (older firmware, a unit with no table zones, or a
--   string that failed the strict parse and was ignored rather than refused,
--   because a refused reading is one the device drops forever).
--   sensor_table_states: services/sensorTables.js, after a LIVE reading is
--   stored (one GET /current could serve), replacing that device's rows with
--   the tables in the reading. A backfilled reading never touches it, and a
--   live reading without the string leaves the rows as they were.
--
-- WHO READS IT. GET /api/sensors/:placeId/tables (the live floor) and
--   /tables/hours (tables in use by hour), both for the venue's verified owner
--   only; and the table alert, which compares a table's state with its row
--   before the row is replaced.
--
-- updated_at IS THE TIME THE FIGURES WERE TRUE, not the time of the write: the
--   reading's own stamp, capped at the server's clock so a device clock that
--   runs ahead cannot date a table in the future. For a live push the two are
--   seconds apart. state_since is on the same clock.
--
-- sensor_device_id is sensor_devices.device_id, the VARCHAR name, the same
--   value venue_sensor_data.sensor_device_id holds. A unit deleted from
--   sensor_devices takes its tables with it.
--
-- ADDITIVE. Nullable columns with no default are catalog changes: no rewrite,
--   no scan, and every existing row reads NULL, which is the truth for it. The
--   table and its index are IF NOT EXISTS. A replay is a no-op.
-- @requires column venue_sensor_data.tables_total
-- @requires column venue_sensor_data.tables_occupied
-- @requires column venue_sensor_data.tables_waiting
-- @requires column venue_sensor_data.tables_to_clear
-- @requires table sensor_table_states

ALTER TABLE venue_sensor_data ADD COLUMN IF NOT EXISTS tables_total INTEGER;
ALTER TABLE venue_sensor_data ADD COLUMN IF NOT EXISTS tables_occupied INTEGER;
ALTER TABLE venue_sensor_data ADD COLUMN IF NOT EXISTS tables_waiting INTEGER;
ALTER TABLE venue_sensor_data ADD COLUMN IF NOT EXISTS tables_to_clear INTEGER;

CREATE TABLE IF NOT EXISTS sensor_table_states (
  sensor_device_id VARCHAR(100) NOT NULL REFERENCES sensor_devices(device_id) ON DELETE CASCADE,
  table_no SMALLINT NOT NULL CHECK (table_no BETWEEN 1 AND 40),
  venue_place_id VARCHAR(255) NOT NULL,
  people SMALLINT NOT NULL CHECK (people BETWEEN 0 AND 30),
  state CHAR(1) NOT NULL CHECK (state IN ('f', 's', 'w', 'c')),
  state_since TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sensor_device_id, table_no)
);

-- The owner's reads go by place. The primary key already serves the writer,
-- which goes by device.
CREATE INDEX IF NOT EXISTS idx_sensor_table_states_venue ON sensor_table_states (venue_place_id);
