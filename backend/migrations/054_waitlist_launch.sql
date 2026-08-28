-- The waitlist becomes an honest end-to-end promise. Joining always sent a
-- confirmation, but nothing recorded whether anyone was ever told the app is
-- out (announced_at), and an account created with a waitlisted email never
-- linked back to its row, so "your friends on the waitlist get informed and
-- their signup counts from when they joined" was true of nothing. created_at
-- has always held their place in line; these three columns record the two
-- events that close the loop.
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ;
-- CASCADE, not SET NULL: once a waitlist row is claimed by an account, it is
-- that person's row, and deleting the account must take the row (and the
-- address in it) with it. An unclaimed row keeps today's rule: it stays until
-- unsubscribed or removed on request, because there is no account to reach it.
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS converted_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;
