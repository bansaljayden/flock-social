-- 076: the unmetered first week is once per identity.
--
-- THE HOLE. services/entitlements.js gives an account younger than seven days
-- the forecast allowance and Birdie cap that Pro gets (NEW_ACCOUNT_GRACE_DAYS).
-- Measured from users.created_at alone, that week came back every time the same
-- person deleted the account and signed up again on the same address or the
-- same Apple/Google identity: a fresh row, a fresh created_at, a fresh week, and
-- the old month's usage_meters rows gone with the old account (CASCADE).
--
-- WHAT THIS ADDS.
--   grace_spent_identities  keyed one-way digests of the identifiers a returning
--                           person reuses, written when ANY account is deleted
--                           (routes/users.js recordGraceSpentIdentity):
--     email_hash  HMAC-SHA256 of the canonical address the account PROVED
--                 (verified_email, or a grandfathered verified row's email),
--                 never an address it merely typed, so a squatter who registers
--                 somebody else's mailbox and deletes the account cannot cost
--                 the real owner anything
--     oauth_hash  HMAC-SHA256 of "provider:subject", the Apple or Google identity
--   users.grace_forfeited   set TRUE by the signup paths in routes/auth.js when
--                           a new account's address or sign-in identity matches
--                           a row here. Written by the server only; no route
--                           accepts it from a client.
--
-- HOW IT IS KEYED. The same server-side pepper as banned_identities (migration
-- 012: BAN_TOMBSTONE_SECRET, falling back to JWT_SECRET), under its own HMAC
-- namespace ('grace-email', 'grace-oauth'), so no value in this table can be
-- compared with, or matched against, a value in banned_identities even for the
-- same address. A database dump alone reveals nothing and cannot be tested
-- against a candidate address. No phone digest: signup does not ask for a
-- phone, so there is nothing to compare one against at the moment it matters.
--
-- WHAT IT HOLDS AND FOR HOW LONG. No name, no user id, no plaintext of
-- anything. 12 months from the deletion, the same window as banned_identities
-- and for the same reason: the behaviour it answers (delete, sign straight back
-- up) happens within days, and the privacy cost of holding anything about an
-- account that is gone does not shrink with time. Every lookup filters on
-- expires_at, so an expired row stops mattering the moment it expires, and the
-- purge in routes/users.js removes it.
--
-- WHAT A MATCH COSTS. Only the first week without free-tier limits. The new
-- account is created, works, and is metered like any account older than a week.
-- Nothing is refused and nothing is said, so this can never be used as an
-- oracle for whether an address once had an account.
--
-- Everything is IF NOT EXISTS / idempotent; it runs in the migration runner's
-- single transaction (db/migrate.js default mode).

CREATE TABLE IF NOT EXISTS grace_spent_identities (
  id BIGSERIAL PRIMARY KEY,
  email_hash TEXT,
  oauth_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- A row with no digest would be a record of nothing, held for no purpose.
DO $$ BEGIN
  ALTER TABLE grace_spent_identities ADD CONSTRAINT grace_spent_identities_has_identity
    CHECK (email_hash IS NOT NULL OR oauth_hash IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_grace_spent_identities_email ON grace_spent_identities(email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grace_spent_identities_oauth ON grace_spent_identities(oauth_hash) WHERE oauth_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grace_spent_identities_expires ON grace_spent_identities(expires_at);

-- FALSE for every existing row: an account made before this migration keeps
-- whatever week it has left. A constant default, so no table rewrite.
ALTER TABLE users ADD COLUMN IF NOT EXISTS grace_forfeited BOOLEAN NOT NULL DEFAULT FALSE;
