-- 011: email verification at signup (round 16)
--
-- THE HOLE THIS CLOSES
-- --------------------
-- Password signup never proved that the person creating an account could read
-- the mailbox they typed. So an attacker could pre-register a victim's address,
-- accumulate the things that make an account valuable — Venmo / Cash App /
-- Zelle handles, accepted friendships, flock membership — and then simply wait.
-- When the victim eventually signed in with Google or Apple, the round-8
-- anti-squat claim in routes/auth.js welded the victim's verified identity onto
-- the attacker's row and cleared its password. The victim inherited the
-- attacker's payment handles and friend graph, and every bill split from then
-- on paid the attacker, who was already inside the victim's friend list.
--
-- That is not fixable inside the claim: "a squatter pre-registered your
-- address" and "I had a password and now I use Google" are the same request.
-- The only thing that separates them is whether the password row ever proved it
-- owns the mailbox. This migration is that proof.
--
-- users.email_verified
--   Added with DEFAULT TRUE so every row that already exists is grandfathered
--   in one atomic step (no backfill UPDATE that could mislabel rows on a
--   replay), then the default is flipped to FALSE so every account created from
--   now on starts unverified. Password signup inserts FALSE explicitly; the
--   Google and Apple paths insert TRUE, because the provider has already
--   verified the address and must never be asked again.
--
--   Grandfathering is deliberate and is the one residual risk here: an account
--   that predates this migration is treated as verified because there is no
--   way to retroactively prove it. Anything created after it must earn it.
--
-- users.verified_email
--   The address that was actually PROVEN, captured at the moment the link was
--   clicked. users.email can be changed later (PUT /api/users/profile), so
--   email_verified alone would let someone verify their own mailbox, switch the
--   address to a victim's, and arrive at the claim wearing a verified badge for
--   an address they never proved. The claim compares this column, not email.
--
-- email_verifications
--   One row per issued link. Split-token layout: `selector` is the public
--   lookup key, `verifier_hash` is SHA-256 of the secret half, so the secret is
--   never stored and the comparison can be constant-time (crypto.timingSafeEqual
--   in routes/auth.js) instead of a database string match.
--
--   `email` records which address the link was issued FOR. A link issued for
--   a@x and clicked after the account switched to b@y must not verify b@y.
--   `used_at` makes a link single-use; `expires_at` makes it expire; both are
--   enforced in the same guarded UPDATE so a double click cannot race.
--   `request_ip` backs the per-IP resend budget, which has to be durable —
--   an in-memory counter resets on every Railway redeploy, and mail budget is
--   exactly the thing an attacker will try to burn.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT FALSE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_email VARCHAR(255);

-- Grandfathered rows proved nothing, but they are trusted for the address they
-- currently hold — that is what "grandfathered" means. Only ever fills NULLs,
-- so a replay cannot overwrite an address a real verification recorded.
UPDATE users SET verified_email = email
 WHERE verified_email IS NULL AND email_verified = TRUE;

CREATE TABLE IF NOT EXISTS email_verifications (
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

-- Per-account resend budget + "invalidate my older links" both read this.
CREATE INDEX IF NOT EXISTS idx_email_verifications_user
  ON email_verifications (user_id, created_at DESC);

-- Per-IP resend budget.
CREATE INDEX IF NOT EXISTS idx_email_verifications_ip
  ON email_verifications (request_ip, created_at DESC);
