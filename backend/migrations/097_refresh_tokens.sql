-- @requires table refresh_tokens
-- @requires column refresh_tokens.parent_id
--
-- 097: refresh credentials, so a session can be renewed instead of ending.
--
-- ASCII only, like 065 and 091-096: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. A Flock access token lives 24 hours and nothing renewed it. Every user
-- was signed out a day after signing in: mid-chat, by the socket recheck in
-- sockets/handlers.js, or at the next launch by GET /api/auth/me answering
-- 401. Making the access token long-lived instead would have made every
-- stolen token long-lived with it. So sign-in now also hands out a refresh
-- credential, and POST /api/auth/refresh trades it for a new access token
-- (services/refreshTokens.js). One row here per credential ever issued:
--
--   token_hash     SHA-256 of the credential. The credential itself is never
--                  stored, the same rule password_resets and
--                  email_verifications follow.
--   family_id      one per sign-in. Every renewal of that sign-in shares it,
--                  so a sign-out, a replayed old credential or a ban can end
--                  the whole chain at once.
--   parent_id      the credential this one was issued in exchange for. A
--                  rotated credential presented again is told apart from a
--                  lost response by whether any child of it was ever used.
--                  SET NULL rather than CASCADE: expired rows are pruned, and
--                  a parent always expires before its children do.
--   token_version  users.token_version when it was issued. A bump (password
--                  change, reset, sign out everywhere, an account claim) makes
--                  every credential issued before it worthless, exactly as it
--                  does every access token issued before it.
--   auth_time      when the person actually signed in. Carried into every
--                  renewed access token as its auth_time claim, so a renewal
--                  never counts as a fresh sign-in for the checks that ask for
--                  one (hasFreshSession in routes/users.js).
--   rotated_at     set when the credential is spent on a renewal.
--   revoked_at     set when it may never be spent again.
--
-- A new table and its indexes, all IF NOT EXISTS, so replaying this file over
-- a populated database moves no row. user_id cascades from users like every
-- other per-account table, so deleting an account deletes its credentials.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  parent_id BIGINT REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL,
  auth_time TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_key ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_parent ON refresh_tokens (parent_id);
