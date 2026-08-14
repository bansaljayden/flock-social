-- 015: password reset (round 17)
--
-- THE HOLE THIS CLOSES
-- --------------------
-- There was no way back into a password account. A user who forgot their
-- password had exactly three options: remember it, create a second account on
-- another address, or stop using Flock. Support had no lever either, because
-- nothing in the codebase could set a password without the old one
-- (PUT /api/users/profile requires current_password). For an app whose users
-- are 15-22 and sign up on a phone they will reinstall, "forgot password" is
-- not an edge case, and App Review does look for it.
--
-- Password reset is also the single most attacked endpoint in any consumer
-- product, because it is a mailbox-to-account converter. Two tables, because
-- the token and the rate limit have different lifetimes and, critically,
-- different subjects: a token only exists when an account does, and a rate
-- limit has to be counted for addresses that have NO account or the neutral
-- response is a lie you can time.
--
-- password_resets
--   One row per issued link, in the same split-token layout migration 011 uses
--   for email verification: `selector` is the public lookup key, `verifier_hash`
--   is SHA-256 of the secret half. The secret is never stored, so a leaked
--   backup (or scripts/dump-db.js) contains no usable links, and the comparison
--   can be constant-time (crypto.timingSafeEqual in routes/auth.js) instead of
--   a database string match.
--
--   `email` records the address the link was mailed TO. An account that changes
--   its address after a link is issued must not have that link keep working:
--   the link proves control of the OLD mailbox and says nothing about the new
--   one. `used_at` makes a link single-use and `expires_at` expires it (one
--   hour, deliberately shorter than verification's 24, because this one hands
--   over the account itself); both are enforced in the same guarded UPDATE so
--   two clicks cannot race into two resets.
--
-- password_reset_requests
--   The rate-limit ledger, and the reason it is a SEPARATE table from
--   password_resets: the request endpoint must behave identically whether or
--   not the address has an account, and a budget counted in issued TOKENS can
--   only count the addresses that do. Counting requests instead means an
--   attacker spraying addresses is throttled the same way either way, and there
--   is nothing to read off the difference.
--
--   Counted in the DATABASE, not in memory, for the same reason the email
--   verification resend budget is (see 011): an in-memory counter resets on
--   every Railway redeploy, and outbound mail budget is exactly the thing worth
--   re-triggering a deploy to reset.
--
--   `email_key` is an HMAC of the canonical address, not the address itself.
--   This table would otherwise become a plaintext log of every address anyone
--   ever typed into the forgot-password box, most of which are NOT our users.
--   Keyed (BAN_TOMBSTONE_SECRET, else JWT_SECRET) exactly like the ban-evasion
--   digests in routes/users.js, because an unkeyed SHA-256 of an email address
--   is reversible by anyone holding a wordlist. A key rotation resets the
--   buckets, which costs one hour of loosened rate limiting and nothing else.
--
--   `request_ip` backs the per-IP budget. Kept deliberately loose in
--   routes/auth.js: Flock's users share school and campus wifi, so a tight
--   per-IP cap silently locks a whole friend group out of account recovery.

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selector VARCHAR(64) NOT NULL UNIQUE,
  verifier_hash VARCHAR(64) NOT NULL,
  email VARCHAR(255) NOT NULL,
  request_ip VARCHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Retire every other outstanding link for this user" reads this, and it runs
-- on every issue and every successful reset.
CREATE INDEX IF NOT EXISTS idx_password_resets_user
  ON password_resets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id SERIAL PRIMARY KEY,
  email_key VARCHAR(64) NOT NULL,
  request_ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_requests_email
  ON password_reset_requests (email_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_reset_requests_ip
  ON password_reset_requests (request_ip, created_at DESC);
