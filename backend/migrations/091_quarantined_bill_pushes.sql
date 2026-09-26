-- 091: no queued notification carries a figure from a quarantined bill.
--
-- ASCII only, like 065 and 082: the embedded server the boot-safety suite runs
-- is WIN1252.
--
-- Two pushes name a bill's figure in their body (routes/billing.js):
-- bill_created, "You owe {payer} $X", and bill_settled, "{name} says they paid
-- you $X". A push held for quiet hours or queued for a retry waits in
-- push_outbox with that body verbatim, and its delivery checked membership,
-- blocks and bans but not the quarantine 089 put on bills from before August
-- 27. So a bill_settled queued overnight by a settle on a legacy bill before
-- 089 ran could go out after it, with the figure the bill no longer shows
-- anybody: on a ghost share, that figure is somebody else's budget answer.
--
-- This deletes every queued bill_created or bill_settled whose bill is
-- quarantined. The payload names the bill by its plan (bill_splits is UNIQUE on
-- flock_id), as text, and it is compared as a number only when it is one, so a
-- malformed payload matches nothing rather than failing the boot.
-- services/pushHelper.js now refuses either push about a quarantined bill at
-- delivery, fresh or queued, and db/migrate.js runs this same DELETE after the
-- files on every boot (db/billQuarantine.js), for a restore that brings old
-- outbox rows back.
--
-- REPLAY: it deletes the rows that match, so a second pass finds none.

DELETE FROM push_outbox o
 WHERE o.data->>'type' IN ('bill_created', 'bill_settled')
   AND EXISTS (SELECT 1 FROM bill_splits b
                WHERE b.quarantined IS TRUE
                  AND b.flock_id = CASE WHEN o.data->>'flockId' ~ '^[0-9]{1,18}$'
                                        THEN (o.data->>'flockId')::bigint END);
