-- @noTransaction
-- 013: indexes for the sequential scans left after 008 (reliability round).
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. Concurrent builds never take a write lock, so this file is
-- safe to apply while the app is serving — which matters here, because two of
-- these tables (messages, flocks) are on the hottest paths in the product.
--
-- Same invalid-index cleanup as 008: a CONCURRENTLY build that dies partway
-- leaves an INVALID index behind, and `IF NOT EXISTS` would then skip it
-- forever — present to the catalog, never used by the planner. Drop any invalid
-- leftovers of exactly these names first so a retry actually rebuilds them.
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
        'idx_messages_sender',
        'idx_flocks_venue_id',
        'idx_flocks_status_event_time',
        'idx_venue_feedback_user_created',
        'idx_venue_votes_venue'
      ])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- messages is the fastest-growing table in the schema and had NO index on
-- sender_id (000_bootstrap indexes flock_id and created_at only). Three
-- separate paths scan the whole table without this:
--   1. GET /api/users/stats runs "SELECT COUNT(*) FROM messages WHERE
--      sender_id = $1" on every profile open;
--   2. the streak UNION in that same request re-reads created_at for the
--      sender;
--   3. DELETE /api/users/me runs "DELETE FROM messages WHERE sender_id = $1"
--      INSIDE the de-attribution transaction — a scan there holds that
--      transaction (and its locks) open for its whole duration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_sender
  ON messages (sender_id);

-- flocks.venue_id is read by the UNAUTHENTICATED NFC check-in path
-- (routes/checkin.js markFlockAttendance) and by the join_venue known-venue
-- test, both of which run "WHERE venue_id = $1". Partial: the column is NULL
-- for every flock that has not picked a place yet, and those rows can never
-- match an equality probe, so they are dead weight in the index. `venue_id =
-- $1` implies IS NOT NULL, so the planner can still use it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flocks_venue_id
  ON flocks (venue_id)
  WHERE venue_id IS NOT NULL;

-- The crowd-alert sweep (services/crowdAlerts.js, every 15 minutes forever)
-- selects "status = 'confirmed' AND event_time > NOW() AND event_time <
-- NOW() + INTERVAL '3 hours'". Composite in that order: equality on status
-- first, then the range on event_time, so one index scan serves both.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flocks_status_event_time
  ON flocks (status, event_time);

-- POST /api/feedback runs two per-user reads (the 2-hour dedup DELETE and the
-- 1-hour rate-limit COUNT) inside a transaction that already holds a per-user
-- advisory lock. The baseline indexes venue_feedback by place id only, so both
-- were table scans taken while a lock was held. created_at DESC matches the
-- "recent rows for this user" shape of both predicates.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_feedback_user_created
  ON venue_feedback (user_id, created_at DESC);

-- venue_votes is indexed by flock (000_bootstrap) and by user (008), but the
-- venue-owner dashboard joins on the third column: "JOIN venue_votes vv ON
-- vv.flock_id = f.id WHERE vv.venue_id = $1". Partial for the same reason as
-- flocks.venue_id — the column is nullable and NULL rows never match.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_votes_venue
  ON venue_votes (venue_id)
  WHERE venue_id IS NOT NULL;
