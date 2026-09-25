-- @requires column device_tokens.signed_in_at
-- @requires column device_tokens.timezone_reported_at
-- @requires column push_outbox.token_ids
--
-- 085: who may take a device token, whose clock quiet hours read, and which
-- devices a queued push is still owed to.
--
-- ASCII only, like 065 and 082: the embedded server the boot-safety suite runs
-- is WIN1252.
--
-- 1. device_tokens.signed_in_at. When the session that registered the row
--    signed in: its JWT iat. routes/notifications.js moves a token to another
--    account only for a session that signed in no earlier than this. Without
--    it, a registration still in flight from an account that had signed out
--    could commit after the next account on the same phone registered, and
--    point the phone back at itself: every later push for the first account
--    then landed on the phone the second person was holding. NULL on rows
--    from before this column, which any session may take over, as before.
--
-- 2. device_tokens.timezone_reported_at. When the device last told us its
--    zone. Quiet hours read the zone of the device that reported most
--    recently (services/pushHelper.js recipientZone). They used to read the
--    newest updated_at, and a clean send stamps updated_at on every row of the
--    account in one statement, so every row tied and the highest id won: a
--    phone that had just reported Europe/London lost to a laptop row left on
--    America/New_York.
--
-- 3. push_outbox.token_ids. The devices (device_tokens.id) a queued push is
--    still owed to. NULL means every device the account holds when the row is
--    released, which is what every row meant until now. A retry after a batch
--    in which one device failed while another accepted names only the device
--    that failed, so the one that already shows the notification is not told
--    twice.
--
-- All three are additive and nullable, and nothing existing is written, so
-- replaying this file over a populated database moves no row.

ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS signed_in_at TIMESTAMPTZ;
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS timezone_reported_at TIMESTAMPTZ;
ALTER TABLE push_outbox ADD COLUMN IF NOT EXISTS token_ids INTEGER[];
