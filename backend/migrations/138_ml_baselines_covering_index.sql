-- @noTransaction
-- 138: a covering index for the crowd model's neighbour box read.
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. A concurrent build takes no write lock, so the app and the
-- hourly baseline refresh keep running while it builds.
--
-- WHY. The homepage demo's slow cold builds come from one read: the neighbour
-- box scan in services/mlPredictor.js (NEIGHBOR_BOX_SQL), which totals the
-- weekly curve rows of every venue within about 1 km for one weekday. The
-- neighbour box probe (services/neighborBoxProbe.js) logged production's plan
-- for four random boxes on 2026-11-14: Buenos Aires 0.32 s for 1,710 curve
-- rows, Berlin 1.49 s for 1,530, Mexico City 0.21 s for 190, Rome 0.72 s for
-- 192. Every one read about 1.1 to 1.2 pages per curve row from outside the
-- shared buffers: a venue's 24 rows for a weekday sit on 24 different heap
-- pages, because the table has been upserted venue by venue for months, and the
-- plan (a bitmap scan of the primary key, then the heap) visits each of them.
--
-- This index holds the four columns that read needs, in key order, so a
-- venue's rows for a weekday are neighbours on one or two leaf pages and the
-- planner can answer the box with an index-only scan instead of 24 heap pages
-- per venue. It changes no row and no result: the same statement reads the same
-- values. The probe's next lines say whether the planner takes it.
--
-- Same invalid-index cleanup as 008/013/014/018/069: a concurrent build that
-- dies partway leaves an INVALID index that `IF NOT EXISTS` would skip forever.
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
      AND c.relname = 'idx_ml_baselines_place_dow_hour_cover'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ml_baselines_place_dow_hour_cover
  ON ml_venue_baselines (google_place_id, day_of_week, hour) INCLUDE (baseline);
