-- @noTransaction
-- 065: read receipts. "Delivered", "Opened", and in a group "Opened by 3".
--
-- ASCII ONLY, deliberately. This file was written with box-drawing rules in
-- its section headers and __tests__/migrationBootSafety.test.js refused the
-- whole boot over them: the embedded server runs WIN1252, and U+2500 has no
-- encoding there, so the migration failed with a character-set error rather
-- than anything to do with what it was trying to do. Every other file in this
-- directory is Latin-1 clean by accident; this one says so on purpose.
--
-- Nothing in this database has ever recorded whether a message reached a
-- device or whether anybody looked at it. frontend/src/components/chat/
-- StatusLine.js already draws the whole ladder and its own comment says why it
-- draws nothing instead of guessing: "NEVER A STATE THE SERVER CANNOT BACK."
-- Until this file, the server could back exactly two of the five words, and
-- both of them ('sending', 'failed') are the client's own knowledge of a send
-- that has not come back yet. This is the other three.
--
-- DELIVERY IS NOT READING, and the two are stored separately because they are
-- different facts with different sources. Delivered means the bytes reached a
-- device: the recipient's socket took the emit, or the recipient's client
-- pulled the thread over REST. Opened means a person had that thread on
-- screen, which only the client can assert and only about itself.
--
-- WHY flock_members.last_read_message_id (056) IS NOT THE ANSWER. It is a
-- badge cursor the client writes whenever it decides the unread dot should
-- clear, and the app advances it on a history fetch. A history fetch is a
-- background catch-up, not a person reading. Telling a sender "Opened" because
-- somebody's phone woke up and paged the thread is exactly the lie StatusLine
-- refuses to draw, so the two receipt watermarks below are separate columns
-- written only by the receipt routes and the receipt socket events. 056 keeps
-- doing its own job and is not read here.
--
-- SHAPE
--
-- A DM has ONE recipient, so the receipt is a property of the row: two
-- nullable timestamps, null meaning "not yet". A group message has as many
-- recipients as the flock has members, so a per-message-per-reader table would
-- write N rows for every message sent and then need a join per row to answer
-- "Opened by Sam and two others": an N+1 on the one screen that pages fifty
-- messages at a time.
--
-- So the group side stores a WATERMARK per member instead, on the membership
-- row that already exists once per member per flock. Message ids are SERIAL
-- and monotone with arrival (the reasoning 056 wrote out in full and this file
-- inherits: created_at on messages is a NAIVE timestamp, so a timestamp cursor
-- against it is the four-hour restore shift again). A member has opened
-- message m exactly when their watermark is >= m.id. One roster read, bounded
-- by flock size, answers every row on the page with no query per message and
-- no rows written per message at all.
--
-- The invariant the readers rely on: OPENED IMPLIES DELIVERED. Every write
-- path sets the delivered half whenever it sets the opened half, so a reader
-- never has to check both, and the single partial index below can serve both
-- scans.
--
-- REPLAY
--
-- No backfill, for the reason 056 states: __tests__/migrationBootSafety.test.js
-- replays every file over live data and asserts not one row moves. Existing
-- messages therefore carry no receipt, which is honest, because nobody ever
-- recorded one, and StatusLine renders a missing status as nothing at all
-- rather than as "Sent". Existing members start at watermark 0, which reads as
-- "has opened nothing", and the first real open moves it for good.
--
-- @noTransaction is for the CONCURRENTLY build at the foot of the file, which
-- cannot run inside a transaction block. The four ALTERs above it are
-- metadata-only on PostgreSQL 11+ (a non-volatile DEFAULT no longer rewrites
-- the table) and each is idempotent on its own, so autocommitting them one at
-- a time costs nothing and leaves nothing half-done.
-- @requires column direct_messages.delivered_at
-- @requires column direct_messages.opened_at
-- @requires column flock_members.last_delivered_message_id
-- @requires column flock_members.last_opened_message_id

ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;

-- NOT NULL DEFAULT 0 rather than a nullable id, same as 056: every read is a
-- greater-or-equal comparison against a member's watermark, and a NULL there
-- would make every one of those comparisons NULL, which WHERE discards, so a
-- member who had never opened anything would drop out of the roster instead of
-- reading as "opened nothing".
ALTER TABLE flock_members ADD COLUMN IF NOT EXISTS last_delivered_message_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flock_members ADD COLUMN IF NOT EXISTS last_opened_message_id INTEGER NOT NULL DEFAULT 0;

-- Same invalid-index cleanup as 008/013/014/018: a CONCURRENTLY build that
-- dies partway leaves an INVALID index behind that IF NOT EXISTS would then
-- skip forever, present to the catalog and never used by the planner.
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
      AND c.relname = 'idx_dm_receipts_pending'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- ONE partial index, not two, and the predicate is the OPENED half on
-- purpose. Every write path keeps "opened implies delivered", so the set of
-- rows with no open receipt is a superset of the set with no delivery
-- receipt: a scan for undelivered rows adds `AND delivered_at IS NULL` on top
-- of this index rather than needing its own. direct_messages is the
-- fastest-growing table in the schema and every index on it is paid on every
-- INSERT, so the second one has to earn its keep and does not.
--
-- Partial rather than plain because the interesting set shrinks toward empty:
-- a row is unreceipted only between arriving and being seen, so this index
-- covers the whole table on the day it is built and a working set from then
-- on. idx_dm_pair_recent (008) still serves the per-conversation reads; this
-- one serves the catch-up scan that asks a single question of the whole
-- inbox: "everything addressed to me that nobody has been told about yet".
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_receipts_pending
  ON direct_messages (receiver_id, id)
  WHERE opened_at IS NULL;
