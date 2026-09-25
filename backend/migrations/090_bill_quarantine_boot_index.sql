-- @noTransaction
-- 090: an index that holds only the bills the every-boot quarantine would
-- change, which on a healthy database is none.
--
-- ASCII only, like 065 and 082: the embedded server the boot-safety suite runs
-- is WIN1252.
--
-- db/migrate.js runs 089's UPDATE again after the files on every boot, because
-- a restore from a dump taken before 089 loads every bill from before August 27
-- with the flag false (db/billQuarantine.js has the whole reason). Unindexed,
-- that UPDATE reads every bill on every deploy. This index is partial on the
-- part of its WHERE that needs no join, so it holds exactly the bills from
-- before the cut-off that are outside the quarantine: none, until a restore
-- brings some in, and none again once the next boot has flagged them. A bill
-- made today never qualifies, so keeping it costs nothing. The budget test in
-- the WHERE still reads flocks, for those rows only.
--
-- The predicate is the first two conditions of the WHERE in
-- db/billQuarantine.js, unchanged, because the planner only uses a partial
-- index whose predicate the query implies; __tests__/migrationBootSafety.test.js
-- checks that the boot's UPDATE can use it.
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block; a concurrent build takes no write lock, so this is safe to
-- apply while the app is serving. Same invalid-index cleanup as 069: a build
-- that dies partway leaves an INVALID index that IF NOT EXISTS would then skip
-- forever, so a leftover of this name is dropped first and the retry rebuilds it.
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
      AND c.relname = 'idx_bill_splits_legacy_unquarantined'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bill_splits_legacy_unquarantined
  ON bill_splits (id)
  WHERE quarantined = false
    AND (created_at IS NULL OR created_at < TIMESTAMPTZ '2026-08-27 04:00:00+00');
