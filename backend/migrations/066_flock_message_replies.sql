-- @noTransaction
-- 066: replying to a specific message in a FLOCK, which is the one chat
-- surface that never could.
--
-- ASCII ONLY, for the reason 065 spells out: the boot-safety test runs an
-- embedded server in WIN1252 and a box-drawing rule in a comment fails the
-- whole migration with a character-set error.
--
-- direct_messages has had reply_to_id since the bootstrap schema (000, line
-- 73) and messages never got it. So a one-to-one thread could quote a
-- specific line and a GROUP thread, where several conversations are actually
-- braided together and a quote is worth far more, could not. The frontend
-- reply UI, the swipe gesture and the quoted bubble were all built against
-- the DM path only.
--
-- Same column, same self-FK, same ON DELETE SET NULL as the DM twin, so a
-- deleted parent leaves the reply standing with its quote dropped rather than
-- taking the reply down with it. Anything else means one person deleting one
-- message silently removes other people's messages from a group thread.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

-- Same invalid-index cleanup as 008/013/014/018/065: a CONCURRENTLY build
-- that dies partway leaves an INVALID index behind that IF NOT EXISTS would
-- then skip forever, present to the catalog and never used by the planner.
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
      AND c.relname = 'idx_messages_reply_to'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- The reason this index is not optional, copied from 008's DM twin because it
-- is the same trap: reply_to_id is a self-FK with ON DELETE SET NULL, and
-- Postgres has to find the referencing rows before it can null them. Without
-- an index that is a sequential scan of `messages` per deleted row, and the
-- deletes come in bulk (a flock delete cascades its whole history, an account
-- deletion cascades many flocks). Partial rather than plain: a reply is a
-- minority of messages, the planner only ever looks up non-null values here,
-- and messages is a fast-growing table where every index is paid on INSERT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_reply_to
  ON messages (reply_to_id)
  WHERE reply_to_id IS NOT NULL;
