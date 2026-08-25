-- @noTransaction
-- 049: the owner-reading history of a place, retracted rows included.
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, and concurrently because venue_owner_reports is written
-- by a live route (POST /api/venue-dashboard/busy-now). Same invalid-index
-- cleanup as 008/013/014/018/043: a CONCURRENTLY build that dies partway
-- leaves an INVALID index that IF NOT EXISTS would skip forever.
--
-- WHY. services/ownerReports.js LIVE_OWNER_REPORTS_SQL now projects
-- assertion_since: the moment the venue started asserting the number on the
-- row being served, found by walking back over that place's earlier readings
-- inside one TTL that say materially the same thing. It is what stops the
-- write path erasing the evidence against a sustained false reading one
-- re-post at a time, and it is a correlated subquery, so POST /api/crowd/batch
-- runs it once per place id in the request body.
--
-- Neither existing index can serve that walk. 031's is partial on
-- retracted = false and 043's is partial on diverged = true; the walk counts
-- rows in both states, deliberately, because retracting a reading takes the
-- number down (the remedy, and free) but must not also erase what the room
-- said while it was up. The planner cannot prove a partial index answers a
-- question with no predicate on it, so without this the walk is a sequential
-- scan per served place, on a table that grows by up to 48 rows per venue per
-- day (OWNER_REPORT_DAILY_CAP).
--
-- The two partial indexes are left in place. This one subsumes both for
-- planning purposes, but dropping a live index is a separate decision from
-- adding one, and 031's is still the narrower answer for the serve read's own
-- outer scan, which does filter on retracted.
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
      AND c.relname = 'idx_venue_owner_reports_place_created_all'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_owner_reports_place_created_all
  ON venue_owner_reports (google_place_id, created_at DESC);
