-- 077: the Roost notice, once per venue account that existed before Terms 9.6
-- put a price on Roost.
--
-- THE PROMISE THIS KEEPS. Terms 9.6 used to say that nothing in the venue
-- dashboard costs money, and that a venue gets at least 30 days' notice at the
-- email on its account before it is charged anything. The section that replaced
-- it keeps that promise for every venue account created before it took effect:
-- the venue is emailed once (services/roostNotice.js), the email names a date 30
-- days out, and until that date the venue keeps everything it has today and
-- nothing can be charged (services/venueEntitlements.js reads the window from
-- this row; services/venueBilling.js sets a Stripe trial_end no earlier than it).
--
-- WHAT A ROW MEANS. The notice email was accepted by the provider at emailed_at,
-- and it told the venue that nothing changes before charge_not_before. The date
-- is stored rather than recomputed so the date enforced is the date the email
-- quoted, whatever the notice period is later changed to. A send that failed,
-- or whose outcome is unknown, writes no row, and the next sweep tries again:
-- without a row the window has not started, so the venue keeps everything.
--
-- DELETION. ON DELETE CASCADE: the row describes one account's notice and leaves
-- with it.

CREATE TABLE IF NOT EXISTS venue_roost_notices (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  emailed_at TIMESTAMPTZ NOT NULL,
  charge_not_before TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE venue_roost_notices ADD CONSTRAINT venue_roost_notices_window
    CHECK (charge_not_before >= emailed_at);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
