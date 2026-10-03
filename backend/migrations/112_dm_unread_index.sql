-- @noTransaction
-- 112: an index for unread direct messages.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. Four reads ask one question, "which DMs addressed to this person are
-- still unread", and nothing indexed it:
--
--   services/pushHelper.js unreadBadge, on EVERY push and every badge sync,
--     counts receiver_id = $1 AND read_status = FALSE;
--   routes/messages.js, the inbox count, the same predicate;
--   routes/messages.js, both mark-read statements, the same plus sender_id
--     (and the single-message one, id < $1);
--   services/pushHelper.js, the DM push collapse, the same plus sender_id and
--     id >= $3.
--
-- idx_dm_receiver_sender_created (008) finds the receiver's rows, and then
-- every one of them is read to test read_status, so each of these walked the
-- person's whole received history. Measured on a local Postgres with seeded
-- DMs (backend audit 2026-10-03): 2,700-4,100 buffers per call, about 90 with
-- this index.
--
-- PARTIAL, for the reason 065 gives for idx_dm_receipts_pending: the unread set
-- shrinks toward empty as people read, so after the build this indexes a
-- working set rather than the table, and direct_messages pays for every index
-- on every INSERT. (receiver_id, sender_id, id) serves all four shapes: the
-- receiver alone is a prefix, the pair is a prefix, and id is the range the
-- mark-read and the collapse bound by.
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. A concurrent build takes no write lock, so this applies
-- while the app serves. One that dies partway leaves an INVALID index that
-- IF NOT EXISTS would then skip forever, so any invalid leftover of this name
-- is dropped first and a retry rebuilds it (the same guard as 008 and 065).
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
      AND c.relname = 'idx_dm_unread'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_unread
  ON direct_messages (receiver_id, sender_id, id)
  WHERE read_status = FALSE;
