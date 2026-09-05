-- 067: the plan's own events, in the stream where the plan is being made.
--
-- ASCII ONLY, for the reason 065 spells out at length: the boot-safety test
-- runs an embedded server in WIN1252 and a box-drawing character in a comment
-- fails the whole migration with a character-set error.
--
-- components/chat/cards/SystemRow.js was built, tested and exported, and its
-- own header says what it draws: "Maya set the venue: Kome", "Sam joined",
-- "Time moved to 8:30". It also says, accurately, that "today none of these
-- events are in the stream at all". It could not be otherwise. The CHECK on
-- messages.message_type has allowed exactly three values since the bootstrap
-- schema, and 'system' is not one of them, so a system row was not merely
-- unwired: it was unstorable. Every read path filtered a value nothing could
-- ever write, which is the same shape as the bug migration 016 fixed for
-- content_reports.content_type, and 016's header records that being the
-- SECOND time that shape had shipped. This is the third.
--
-- What the stream gains is the record of how the plan actually converged.
-- Today a venue confirmation updates the flocks row, repaints a banner above
-- the first message and broadcasts a toast, and leaves nothing behind: a
-- member who was not looking at that moment has no way to learn WHEN the
-- decision happened or WHO made it, because the header shows only the current
-- state. The stream is the record and the header is the state.
--
-- SYSTEM ROWS ARE SERVER-AUTHORED, AND THAT IS ENFORCED WHERE IT ALREADY WAS
-- rather than by anything added here. Both socket send paths clamp an unknown
-- message_type to 'text' through their own allowedTypes list, and the two REST
-- validators run .isIn(['text','venue_card','image']), so a client that sends
-- 'system' gets a plain message or a 400. NONE of those four lists gains
-- 'system'. A client that could author a system row could forge "Maya set the
-- venue: <somewhere else>" in the group's own voice, which is worse than an
-- ordinary impersonation because the row is drawn as the app speaking rather
-- than as a person.

DO $$ BEGIN
  ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_message_type_check;
  ALTER TABLE messages ADD CONSTRAINT messages_message_type_check
    CHECK (message_type IN ('text', 'venue_card', 'image', 'system'));
EXCEPTION WHEN others THEN NULL; END $$;

-- WHICH event, so the client can build the sentence instead of the server
-- shipping prose. SystemRow takes an array of pieces and decides for itself
-- which piece is accented, which is how the accent stays one decision in one
-- file. A server that sent "Maya set the venue: Kome" as a finished string
-- would also be choosing the wording, the casing and the punctuation for a
-- component whose whole documented contract is that it does not receive prose.
--
-- It also keeps the sentence translatable and re-wordable without a data
-- migration: the row records that a venue was set and to what, and the copy
-- lives in the client where copy belongs.
--
-- VARCHAR(32) with no CHECK, deliberately. A CHECK here would be the fourth
-- instance of the exact bug this migration exists to fix: a route learns a new
-- kind, the constraint does not, and the INSERT dies as a 500 on a feature
-- nobody can reach. The values are a closed set in the code
-- (utils/systemMessages.js) and an unknown kind renders as nothing rather than
-- as a broken row, so an unrecognised value is inert instead of fatal.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS system_kind VARCHAR(32);

-- The payload rides in message_text, which is already NOT NULL and already
-- read by every history query, so nothing else has to learn a new column. For
-- 'venue_set' it is the venue name, which is the value SystemRow accents. That
-- is also why a system row needs no separate takedown path: it is a message,
-- so is_hidden, sender_deleted_at and the blocked-sender filter in the history
-- read all already apply to it, and a system row naming a blocked member
-- disappears for the person who blocked them without another line of code.
