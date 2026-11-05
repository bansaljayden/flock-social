-- @requires table admin_access_keys
-- @requires table admin_key_uses
-- @requires column admin_access_keys.session_version
--
-- 135: admin access keys, so tools on the owner's computer can call the
-- admin routes without a signed-in browser, and a log of every use.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. Every admin route takes a signed-in session (requireAdmin in
-- routes/admin.js reads req.user.role), so an admin job such as the waitlist
-- launch email could only run from a browser where the owner was signed in. A
-- key minted once from that browser lets a script on the owner's machine do
-- the same admin work. middleware/adminKeys.js holds the rules: what a key may
-- reach (an explicit list of admin routes), what it may never reach (minting
-- or listing keys, moderation decisions, venue verification and tiers, any
-- route that is not an admin route), and how each use is written down.
--
-- admin_access_keys, one row per key ever minted:
--   key_hash         SHA-256 of the key, hex. The key itself is never stored,
--                    the rule refresh_tokens (097) and password_resets follow.
--                    The key is 32 random bytes, so a plain hash is enough: there
--                    is nothing to guess.
--   scopes           what the key is for. One scope exists, 'admin', and the
--                    CHECK refuses any other word, so a scope the code does not
--                    know can never be stored.
--   created_by       the admin who minted it. The key acts as this account, and
--                    dies with it (CASCADE), like every per-account credential.
--   session_version  the creator's users.token_version at minting. A password
--                    change, a reset, sign out everywhere or an account claim
--                    bumps that column and ends every key minted before it, the
--                    way it ends every session.
--   expires_at       90 days by default, 180 at most. The CHECK holds the ceiling
--                    whatever the route sends.
--   last_used_at, last_used_ip  the last use that reached a route.
--   revoked_at, revoked_via     set once, by the dashboard ('session') or by
--                    the key revoking itself ('key').
--
-- admin_key_uses, one row per use: method, route (the path, never the query
-- string), the answer's status, the time, and the caller's address. A use that
-- reaches a route is written before the route runs, and its status when the
-- answer goes out. A key that is refused (expired, revoked, ended, or sent to a
-- route a key may not reach) is written with the reason in `refused`.
--
-- New tables and indexes, all IF NOT EXISTS, so replaying this file over a
-- populated database moves no row. Only types the restore drill already
-- round-trips (__tests__/dumpLiteralRestore.test.js).

CREATE TABLE IF NOT EXISTS admin_access_keys (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes TEXT[] NOT NULL DEFAULT ARRAY['admin']::text[]
    CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['admin']::text[]),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT CHECK (last_used_ip IS NULL OR char_length(last_used_ip) <= 64),
  revoked_at TIMESTAMPTZ,
  revoked_via TEXT CHECK (revoked_via IS NULL OR revoked_via IN ('session', 'key')),
  CONSTRAINT admin_access_keys_expiry_check
    CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '180 days'),
  CONSTRAINT admin_access_keys_revoked_check
    CHECK ((revoked_at IS NULL) = (revoked_via IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_access_keys_key_hash_key ON admin_access_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_admin_access_keys_created_by ON admin_access_keys (created_by);

CREATE TABLE IF NOT EXISTS admin_key_uses (
  id BIGSERIAL PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES admin_access_keys(id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method TEXT NOT NULL CHECK (char_length(method) BETWEEN 1 AND 10),
  route TEXT NOT NULL CHECK (char_length(route) BETWEEN 1 AND 200),
  status SMALLINT CHECK (status IS NULL OR status BETWEEN 100 AND 599),
  ip TEXT CHECK (ip IS NULL OR char_length(ip) <= 64),
  refused TEXT CHECK (refused IS NULL OR refused IN ('expired', 'revoked', 'ended', 'route'))
);

CREATE INDEX IF NOT EXISTS idx_admin_key_uses_key_time ON admin_key_uses (key_id, used_at DESC);
