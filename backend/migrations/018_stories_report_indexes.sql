-- @noTransaction
-- 018: indexes the stories audit asked for.
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. Concurrent builds take no write lock, so this is safe to
-- apply while the app is serving.
--
-- Same invalid-index cleanup as 008/013/014: a CONCURRENTLY build that dies
-- partway leaves an INVALID index behind that `IF NOT EXISTS` would then skip
-- forever, present to the catalog and never used by the planner. Drop any
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
        'idx_stories_user_created',
        'idx_content_reports_content'
      ])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- The story feed reads "user_id IN (...) ... ORDER BY created_at DESC". Only
-- a plain (user_id) index and an (expires_at) index existed, so the sort was
-- unsupported and every feed read had to order the matched rows by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stories_user_created
  ON stories (user_id, created_at DESC);

-- content_reports is indexed on status, reported_user and (as of 014) reporter,
-- but nothing covers a lookup BY the content being reported. That is now the
-- hot path for three things: the story delete guard, which refuses to destroy
-- evidence a moderator still has open; the expiry purge, which skips reported
-- rows for the same reason; and the admin queue's per-content lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_reports_content
  ON content_reports (content_type, content_id);
