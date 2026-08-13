-- 009: users.token_version — server-side JWT invalidation (round 13)
--
-- Flock JWTs are stateless and live 24h. Nothing could revoke one early, so the
-- OAuth account-claim in routes/auth.js (Google :/google, Apple :/apple) had a
-- real hole: the claim moves the ROW to the verified owner and clears the
-- password, but any token an address SQUATTER already minted for that user id
-- kept working for the remainder of its 24h — reading the real owner's DMs,
-- flocks and live location after they signed in.
--
-- token_version is stamped into the JWT as `tv` and compared on every request
-- and socket handshake. Bumping it invalidates every token outstanding for that
-- user. Bumped by: the Google claim, the Apple claim, and any password change.
--
-- Existing tokens predate the `tv` claim; middleware/auth.js treats a missing
-- claim as version 0, which is exactly the DEFAULT here, so tokens issued
-- before this migration keep working until something bumps the row (at which
-- point they are rejected like any other stale token).
--
-- Same tolerant DO-block style as 003/004/005 for drifted databases.

DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN others THEN NULL; END $$;
