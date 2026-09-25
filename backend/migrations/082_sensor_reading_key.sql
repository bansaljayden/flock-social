-- @noTransaction
-- 082: one row per sensor reading. venue_sensor_data gets a unique key on
-- (sensor_device_id, recorded_at), the pair routes/sensors.js already treats
-- as a reading's identity.
--
-- ASCII only, like 065: the embedded server the boot-safety suite runs is
-- WIN1252.
--
-- WHY. The ingest (routes/sensors.js INGEST_SQL) answers a delivery whose
-- device and stamp it already holds as a duplicate and stores nothing. It
-- decides that by reading the table, and a statement reads the snapshot it
-- started with, so two deliveries of one reading that start before either
-- commits both find nothing. A reading stamped more than fifteen minutes ago
-- is backfill, which no flood guard slows, so both inserted, and the hourly
-- sum behind GET /:placeId/history counted the doorway twice. 043 indexed the
-- same two columns for that lookup and did not make them unique. With this key
-- the second insert waits for the first, finds the reading there and stores
-- nothing, and INGEST_SQL answers it the way it answers any re-delivery.
--
-- THE ROWS ALREADY STORED TWICE. Production may hold copies that race left
-- behind. A unique index cannot be built over them, and a migration that
-- throws is a boot that never reaches listen(), so the later copies are
-- deleted first, keeping the lowest id of each (device, instant). Why that is
-- safe for measurements: a device takes one reading per instant, and the
-- device and its stamp are the identity the ingest has always given a reading.
-- The lowest id is the copy stored first, and it is the one the ingest keeps
-- when the same stamp arrives again one delivery after another: the later
-- delivery is answered as a duplicate and its values are never written, even
-- when they differ. Deleting the later copies leaves the table as the ingest
-- would have left it had the deliveries not overlapped. What goes is a second
-- count of one reading, never a second reading.
--
-- REPLAY. __tests__/migrationBootSafety.test.js runs this file again over live
-- data and asserts no row moves. Once the index exists no two rows can share a
-- device and an instant, so on any later run the DELETE finds nothing and IF
-- NOT EXISTS skips the build. A row whose recorded_at is NULL is never a copy
-- of anything: NULL equals nothing in the DELETE, and a unique index treats
-- NULLs as distinct.
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, and this table takes a row every thirty seconds from
-- every device, for good (043 put one device at half a million rows a year).
-- A concurrent build lets the sensors keep writing while it runs.
--
-- DURING A DEPLOY the old server keeps taking readings while this runs. A
-- copy it stores after the DELETE and before the build starts enforcing the
-- key fails the build: that leaves an INVALID index, fails this boot and does
-- not record the file, and the restart runs it again, where the cleanup below
-- drops the invalid index, the DELETE removes the new copy and the build goes
-- through. Once the build is enforcing, the old server's copy is refused with
-- a unique violation instead, which the device retries as an ordinary failure
-- and the retry is answered as a duplicate.
--
-- 043's idx_venue_sensor_data_device_recorded covers the same two columns
-- without the rule and is left as it is.
--
-- Same invalid-index cleanup as 008/013/014/018/043: a CONCURRENTLY build that
-- dies partway leaves an INVALID index behind that IF NOT EXISTS would then
-- skip forever, present in the catalog and never enforced.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT i.indisvalid
      AND n.nspname = 'public'
      AND c.relname = 'venue_sensor_data_reading_key'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

DELETE FROM venue_sensor_data v
 WHERE EXISTS (
   SELECT 1
     FROM venue_sensor_data k
    WHERE k.sensor_device_id = v.sensor_device_id
      AND k.recorded_at = v.recorded_at
      AND k.id < v.id
 );

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS venue_sensor_data_reading_key
  ON venue_sensor_data (sensor_device_id, recorded_at);
