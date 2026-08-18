-- 026: users.bio — a short self-description for the profile card
--
-- Write path: PUT /api/users/profile only. The route is the ceiling (200
-- characters, trimmed, markup stripped by freeText, profanity-screened like
-- every other free-text user field), so the column is plain TEXT — the same
-- arrangement flocks.venue_address has, where the bound is a product rule the
-- route owns rather than a column width that turns overflow into a 500.
--
-- Read paths: GET /api/users/profile (own profile), GET /api/users/:id/card
-- (the mini card, block- and ban-gated in the route), and the
-- GET /api/users/export data export. It is NOT on the server.js
-- SECRET_RESPONSE_FIELDS strip list, deliberately: a bio is content the
-- product serves, not a credential.
--
-- Nullable, no default: an account that never wrote a bio has nothing to say,
-- which is a NULL and not an empty string.
--
-- Same tolerant DO-block style as 003/004/005 for drifted databases.

DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
EXCEPTION WHEN others THEN NULL; END $$;
