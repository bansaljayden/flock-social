-- 052: when a trusted contact's ADDRESS joined the list, as distinct from when
-- the row did.
--
-- POST /api/safety/alert/cancel mails the all clear to "exactly the contacts
-- who existed when the alert went out", and it decided that with
--
--     WHERE user_id = $1 AND created_at <= <the alert's created_at>
--
-- The guard is the right one. A contact added after the alert never received
-- it, and a stand-down for an emergency somebody never heard about is the worst
-- possible first message from an app they have never used. It is also the
-- narrow argument that lets the stand-down past the do-not-mail list at all
-- (services/emailSuppression.js, EMERGENCY_CATEGORY): the only person who can
-- receive one already received the alarm, so nothing reaches a suppressed
-- address that the address did not already get.
--
-- created_at is the wrong column to hang that on, because it identifies the
-- ROW and the obligation is about the ADDRESS. PUT /api/safety/contacts/:id
-- rewrites contact_email in place and created_at does not move, so:
--
--     add a contact, raise a real SOS, edit that contact's email, stand down
--
-- mails "All Clear" to an address that was never on the list when the alert
-- went out, through the emergency bypass, for an alarm it never received. Both
-- halves of the sentence the route wrote about itself are false in that case.
--
-- So the address gets its own timestamp. The route stamps it whenever the
-- address actually changes and leaves it alone when a name or a relationship is
-- edited, and the stand-down reads COALESCE(email_set_at, created_at), which is
-- exactly created_at for every row that predates this file and for every
-- contact whose address has never been touched.
--
-- WHY NOT MOVE created_at INSTEAD. It is what GET /api/safety/contacts orders
-- by, what the alert path orders by, and what the account data export publishes
-- as when the contact was added. Rewriting it to fix a mail decision would
-- reorder a user's safety screen and put a false date in their export.
--
-- REPLAY SAFETY. IF NOT EXISTS, no default that rewrites rows, and the backfill
-- below only ever touches rows where the column is still NULL, so a second run
-- over the same data is a no-op. __tests__/migrationBootSafety.test.js replays
-- this file over populated data.

-- @requires column trusted_contacts.email_set_at

ALTER TABLE trusted_contacts ADD COLUMN IF NOT EXISTS email_set_at TIMESTAMP;

-- Every existing address has been on the list since its row was created, which
-- is what the stand-down assumed and, for a row nobody has edited, was true.
UPDATE trusted_contacts SET email_set_at = created_at WHERE email_set_at IS NULL;
