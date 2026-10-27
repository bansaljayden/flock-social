-- 132: the table camera's looks. One row per time the Flux unit opened its
-- table camera's shutter, failures included, so the owner can see how often
-- the camera looked today and how each look ended.
--
-- ASCII only, like 065, 082, 091-095, 130 and 131: the embedded server the
-- boot-safety suite runs is WIN1252.
--
-- WHAT IT HOLDS, AND WHAT IT NEVER WILL. When the look was taken (null when
-- the unit's clock was not synced, and then received_at stands in), which
-- look it was (the whole room, or one table and its number), how it ended
-- (found, clear, dishes, person, failed) and, for a room look, how many
-- tables it found. No picture, no position, nothing about a person: the
-- picture never leaves tablecam's one check on the unit, and the contract in
-- services/sensorCameraLooks.js has no field that could carry one.
--
-- WHO WRITES IT. services/sensorCameraLooks.js, after the reading that carried
--   the looks is stored and answered, and only for a reading that was newly
--   written: a retried delivery the ingest answers as a duplicate stores its
--   looks nothing a second time, which is the whole of the dedupe the unit's
--   send-once contract needs. The same statement deletes the unit's rows older
--   than 90 days, the unit's own retention for its CSV record.
--
-- WHO READS IT. GET /api/sensors/:placeId/tables/camera-looks, the owner's
--   day of looks, behind the same Roost gate as every owner table route.
--
-- sensor_device_id is sensor_devices.device_id, the VARCHAR name, as on
--   sensor_table_states and sensor_table_seatings. A unit deleted from
--   sensor_devices takes its looks with it.
--
-- TWO INDEXES. The owner reads by place and the look's time (at, or
--   received_at when at is null), so that expression is the index. The 90-day
--   delete goes by unit and received_at.
--
-- ADDITIVE. A new table and two IF NOT EXISTS indexes. A replay is a no-op.
-- @requires table sensor_camera_looks

CREATE TABLE IF NOT EXISTS sensor_camera_looks (
  id BIGSERIAL PRIMARY KEY,
  sensor_device_id VARCHAR(100) NOT NULL REFERENCES sensor_devices(device_id) ON DELETE CASCADE,
  venue_place_id VARCHAR(255) NOT NULL,
  at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  look VARCHAR(5) NOT NULL CHECK (look IN ('room', 'table')),
  table_no SMALLINT CHECK (table_no BETWEEN 1 AND 200),
  result VARCHAR(6) NOT NULL CHECK (result IN ('found', 'clear', 'dishes', 'person', 'failed')),
  found SMALLINT CHECK (found BETWEEN 0 AND 200),
  CHECK ((look = 'room' AND table_no IS NULL) OR (look = 'table' AND table_no IS NOT NULL)),
  CHECK (found IS NULL OR look = 'room')
);

CREATE INDEX IF NOT EXISTS idx_sensor_camera_looks_venue
  ON sensor_camera_looks (venue_place_id, (COALESCE(at, received_at)));

CREATE INDEX IF NOT EXISTS idx_sensor_camera_looks_unit
  ON sensor_camera_looks (sensor_device_id, received_at);
