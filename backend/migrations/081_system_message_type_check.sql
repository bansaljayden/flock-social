-- @noTransaction
-- 081: messages.message_type admits 'system' on every database, including one
-- where 067 was recorded as applied without it, and the widening no longer
-- scans the table under ACCESS EXCLUSIVE.
--
-- ASCII ONLY, for the reason 065 spells out: the boot-safety test runs an
-- embedded server in WIN1252, and a non-ASCII character in a comment fails
-- the whole migration with a character-set error.
--
-- WHAT 067 CAN LEAVE BEHIND. 067 widened this CHECK inside a DO block whose
-- handler is EXCEPTION WHEN others THEN NULL, the handler 032 and 038 were
-- narrowed away from for exactly this reason. db/migrate.js arms lock_timeout
-- at 10 seconds, `others` catches the 55P03 that raises, and so a conflicting
-- lock on messages that outlives the first wait makes the block give up in
-- silence with the three-value CHECK still in place. The next statement in
-- 067, the system_kind ADD COLUMN, then queues for the same table with a fresh
-- 10 seconds, and if the conflicting lock clears inside that second window the
-- file commits and the runner records 067 as applied. Measured on the
-- embedded Postgres with a second connection holding ACCESS SHARE on messages
-- for 13 seconds: 067 recorded, the CHECK still text / venue_card / image, and
-- the exact INSERT utils/systemMessages.js runs refused with 23514. Held past
-- 20 seconds the ADD COLUMN times out as well and the boot fails, which is the
-- safe outcome; the harm is confined to the window between, and one statement
-- on messages running to the pool's 15 second statement_timeout sits inside
-- it. Nothing re-runs a file the runner believes is done, so from then on
-- every venue change confirmed in a plan logs "writeSystemMessage error: new
-- row for relation messages violates check constraint" and the stream never
-- gets its row.
--
-- AND WHEN 067 DOES GET ITS LOCK, its ADD CONSTRAINT validates every row of
-- messages under the ACCESS EXCLUSIVE the DROP took, and holds it until the
-- file commits: every chat read and write waits behind a full scan of one of
-- the largest tables in the product, during a deploy.
--
-- 067 is not edited. It is recorded wherever it ran, so an edit would reach
-- only databases that never applied it, which already get the widened CHECK,
-- and never the ones this is for; 048's header is the record of what editing
-- an applied file does. This file is the repair, and it is shaped like 004:
--
--   * the widening is ADD ... NOT VALID, a catalog change. The ACCESS
--     EXCLUSIVE it needs is held for as long as the catalog write takes, not
--     for a scan, and every new row is checked from that moment;
--   * VALIDATE CONSTRAINT is its own statement, and @noTransaction makes it
--     its own transaction, so the scan runs under SHARE UPDATE EXCLUSIVE and
--     chat keeps reading and writing while it does;
--   * nothing catches anything. A lock timeout here raises, the boot fails,
--     the file is not recorded and the next boot tries again, which is the
--     trade 032 and 038 made and the reason they made it.
--
-- Every statement is safe to run again. Where the CHECK already admits
-- 'system' (every database where 067 landed, and every fresh one) the first
-- statement changes nothing, VALIDATE on a validated constraint returns at
-- once, and the last statement confirms it.
--
-- The runner's @requires lines name tables and columns, and neither can say
-- what matters here: the constraint has the same NAME before and after 067,
-- so only its definition tells a repaired database from a broken one. The
-- last statement reads that definition and raises if it is still wrong, which
-- fails the boot and leaves this file unrecorded, the same outcome a failed
-- post-condition has.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'messages'::regclass
       AND conname = 'messages_message_type_check'
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%''system''%'
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_message_type_check;
    ALTER TABLE messages ADD CONSTRAINT messages_message_type_check
      CHECK (message_type IN ('text', 'venue_card', 'image', 'system')) NOT VALID;
  END IF;
END $$;

ALTER TABLE messages VALIDATE CONSTRAINT messages_message_type_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'messages'::regclass
       AND conname = 'messages_message_type_check'
       AND contype = 'c'
       AND convalidated
       AND pg_get_constraintdef(oid) LIKE '%''system''%'
  ) THEN
    RAISE EXCEPTION '081: messages_message_type_check still refuses message_type system';
  END IF;
END $$;
