-- 131: table history. One row per seating (a party's time at one table),
-- built from the state changes in the live table readings, and the owner's
-- switch for showing their tables in the Flock app.
--
-- ASCII only, like 065, 082, 091-095 and 130: the embedded server the
-- boot-safety suite runs is WIN1252.
--
-- WHY. The live floor (sensor_table_states, migration 130) says what each
-- table is doing now and nothing about what it did an hour ago: every live
-- reading replaces the unit's rows. So nobody could say how long a party sits
-- at this venue on a Friday at eight, which is the one number a host needs to
-- tell a party of four how long the wait is, and the one the owner needs to
-- see that tables sit uncleared for twelve minutes on Saturdays. A seating is
-- the unit of that history: it opens when a table goes from free or
-- needs-clearing to seated or waiting, and closes when it goes back.
--
-- WHAT IT HOLDS, AND WHAT IT NEVER WILL. A table number the owner chose, when
-- a party sat down and when it left, the most people counted at the table
-- while it sat, whether the party waited past the unit's wait limit, and when
-- the table was cleared. NOTHING IN IT SAYS WHO SAT THERE. The box sends no
-- track, position, image or id of anyone (the contract in
-- services/sensorTables.js), so a seating is a count and four times, and that
-- is all this table has room for. It is also never joined to a person: the
-- incoming-flocks suggestion reads a party SIZE from the dashboard's own feed
-- and matches it to a table, and neither side carries a name.
--
-- WHO WRITES IT. services/sensorTables.js, in the same transaction that writes
--   the unit's sensor_table_states rows, after them, comparing each table's
--   new state with its row from before the reading:
--     f or c -> s or w   opens a seating, seated_at the reading's time minus
--                        the unit's seated timer (A), party_max the head count,
--                        waited when the first reading is already w. A table's
--                        first reading ever opens one only when it is s or w.
--     s or w -> s or w   party_max keeps the most people seen; any reading in
--                        w sets waited.
--     s or w -> c        closes it: left_at the reading's time minus A, the
--                        moment the table emptied.
--     s or w -> f        closes it at the reading's time, cleared as it closes:
--                        the box only says needs-clearing after 90 seconds
--                        empty, so a table seen free again was cleared inside
--                        that, and the clear took no measurable time.
--     c -> f             sets cleared_at on the table's latest closed seating
--                        that has none.
--   A table that leaves the reading (removed on the box), and every table of a
--   unit whose rows the silence rule forgets, closes its open seating at that
--   moment. A failure anywhere here is logged and never reaches the device's
--   answer, which was written before any of this runs.
--
-- WHO READS IT. The owner's table routes in routes/sensors.js, through
--   services/tableHistory.js: likely_free_at on the live floor (seated_at plus
--   the median turn for that weekday and hour over 28 days), GET /tables/stats
--   (turn, wait and clear medians, with a floor of 20 closed seatings before a
--   median is said), GET /tables/waits and /tables/incoming (which table fits a
--   party, and when), and the public summary the Flock app reads, which carries
--   counts and minutes and never a table number.
--
-- tables_in_app is the owner's "show tables in the Flock app" switch. True
--   for every venue until the owner turns it off (PUT /tables/settings, not
--   behind the plan gate: a free venue may hide its tables too). The public
--   summary answers 404 for a venue that turned it off, exactly as for one with
--   no table data, so nobody can tell the two apart from outside.
--
-- sensor_device_id is sensor_devices.device_id, the VARCHAR name, as on
--   sensor_table_states. A unit deleted from sensor_devices takes its history
--   with it.
--
-- TWO INDEXES. The owner's reads go by place and time (28 and 30 day windows).
--   The writer goes by unit and table: the open seating of a table (left_at
--   NULL) and the latest closed one, on every live reading, so that lookup
--   must never be a scan of every venue's history.
--
-- ADDITIVE. A new table, two IF NOT EXISTS indexes, and one NOT NULL column
--   with a default on venue_profiles, which is a catalog change on this
--   Postgres (no rewrite) and reads true on every existing row, which is the
--   truth for a venue that never touched the switch. A replay is a no-op.
-- @requires table sensor_table_seatings
-- @requires column venue_profiles.tables_in_app

CREATE TABLE IF NOT EXISTS sensor_table_seatings (
  id BIGSERIAL PRIMARY KEY,
  sensor_device_id VARCHAR(100) NOT NULL REFERENCES sensor_devices(device_id) ON DELETE CASCADE,
  table_no SMALLINT NOT NULL CHECK (table_no BETWEEN 1 AND 200),
  venue_place_id VARCHAR(255) NOT NULL,
  seated_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  party_max SMALLINT NOT NULL DEFAULT 0 CHECK (party_max BETWEEN 0 AND 30),
  waited BOOLEAN NOT NULL DEFAULT false,
  cleared_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sensor_table_seatings_venue
  ON sensor_table_seatings (venue_place_id, seated_at);

CREATE INDEX IF NOT EXISTS idx_sensor_table_seatings_unit
  ON sensor_table_seatings (sensor_device_id, table_no, left_at);

ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS tables_in_app BOOLEAN NOT NULL DEFAULT true;
