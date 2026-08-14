-- @noTransaction
-- 014: indexes for the owner-dashboard and moderation scans the route
-- reliability pass found (same round, different tables than 013).
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. Concurrent builds never take a write lock, so this file is
-- safe to apply while the app is serving.
--
-- Same invalid-index cleanup as 008/013: a CONCURRENTLY build that dies partway
-- leaves an INVALID index that `IF NOT EXISTS` would then skip forever. Drop any
-- invalid leftovers of exactly these names first so a retry rebuilds them.
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
      AND c.relname = ANY (ARRAY[
        'idx_venue_promotions_owner',
        'idx_venue_events_owner',
        'idx_content_reports_reporter'
      ])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- GET /api/venue-dashboard/promotions filters "WHERE venue_user_id = $1", but
-- venue_promotions was indexed only on google_place_id, so a venue owner's own
-- promotions list scanned the table. Grows with usage.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_promotions_owner
  ON venue_promotions (venue_user_id);

-- Same shape: GET /api/venue-dashboard/events filters "WHERE venue_user_id =
-- $1" and venue_events was indexed only on google_place_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_events_owner
  ON venue_events (venue_user_id);

-- The report-dedupe check in routes/moderation.js runs "WHERE reporter_id = $1
-- AND content_type = $2 AND ... status IN (...)" on every report submission;
-- content_reports was indexed on status and reported_user_id but not on the
-- reporter, so the per-reporter lookup scanned. Lead with the equality column.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_reports_reporter
  ON content_reports (reporter_id, content_type);
