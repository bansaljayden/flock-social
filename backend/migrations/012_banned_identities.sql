-- 012: banned_identities — ban-evasion tombstones (round 16)
--
-- THE HOLE
-- A banned account is deliberately still allowed to call DELETE /api/users/me
-- (Apple 5.1.1(v) / Google Play / GDPR: deletion must stay reachable even while
-- suspended). Nothing recorded that the deleted row had been banned, so the
-- evasion was: get banned, delete the account, sign up again ninety seconds
-- later on the same email, phone or Apple/Google identity, and receive a clean
-- row. Every ban in the product was therefore self-serve reversible, and the
-- moderation evidence de-attribution in routes/users.js was preserving reports
-- against a person who was already back with a fresh id.
--
-- WHAT THIS STORES, AND WHY IT IS HASHED
-- Rows here are written ONLY when a BANNED account is deleted, and hold nothing
-- but keyed one-way digests of the three values a returning user would reuse:
--   email_hash  HMAC-SHA256 of the canonicalized email (Gmail dots/+tags folded,
--               matching canonicalEmail() in routes/auth.js, so a dot variant
--               cannot walk straight back in)
--   phone_hash  HMAC-SHA256 of the last 10 digits, which is exactly the
--               comparison POST /api/friends/find-by-phone uses, so formatting
--               changes do not defeat it
--   oauth_hash  HMAC-SHA256 of "provider:oauth_id" (the Apple/Google subject),
--               which survives an email change at the provider
--
-- No name, no avatar, no date of birth, no message content, no user id, no
-- plaintext of anything. Flock's users are 15-22 and many are minors, so a
-- plain-text table of the emails and phone numbers of banned teenagers would be
-- a genuinely dangerous asset to hold, and it would outlive the account the
-- user asked us to erase.
--
-- HMAC, not a bare hash: a phone number is ~10 digits of entropy and an email
-- address is guessable, so SHA-256(value) would be reversible by anyone who
-- read this table with a laptop and an afternoon. The digests are keyed with a
-- server-side pepper (BAN_TOMBSTONE_SECRET, falling back to JWT_SECRET) that
-- lives only in the Railway environment, so a database dump on its own reveals
-- nothing and cannot be tested against a candidate address. Rotating that
-- secret orphans existing tombstones: they stop matching and simply age out.
-- That fails in the privacy-preserving direction (a ban is forgotten early)
-- rather than the harmful one, which is the deliberate trade.
--
-- RETENTION: 12 MONTHS FROM THE DELETION, THEN GONE
-- Measured from the deletion, not from the ban, and deliberately: the window
-- exists to cover the period after an identity is RELEASED back into the
-- signup pool, so dating it from a ban imposed two years earlier would write a
-- tombstone that was already expired the moment it was created and protected
-- nothing. banned_at is stored as context (a human handling an appeal wants to
-- know whether the ban was last week or last year), never as the clock.
--
-- expires_at is set at write time and every lookup filters on it, so an expired
-- tombstone stops having any effect the moment it expires, whether or not the
-- purge has run yet. Twelve months is the shortest window that still does the
-- job: ban evasion is an impulsive, same-week behaviour, and the deterrent
-- value of a fingerprint decays fast, while the privacy cost of holding data
-- about a minor does not. Keeping it "forever" would mean a 15-year-old's
-- identifiers sitting in our database into adulthood to punish something they
-- did in one school year, which we are not willing to defend. Twelve months is
-- also what we can defend to a reviewer or a regulator: the account, its
-- content, its messages and its profile are genuinely and irreversibly gone
-- (deletion is real, not a soft-delete), and what remains is an unreadable
-- self-expiring fingerprint retained under legitimate interest in preventing
-- the recurrence of abuse against other minors on the platform.
--
-- KNOWN FALSE POSITIVES, AND WHY THE WINDOW IS PART OF THE ANSWER
-- Phone numbers are recycled by carriers, and an attacker who puts a stranger's
-- number on their own profile and then earns a ban would leave a fingerprint
-- that blocks the real owner of that number. Both are real, both are bounded:
-- phone is OPTIONAL at signup, so a person hit by either can still create an
-- account without one, the rejection names a support address a human reads, and
-- nothing here survives past the retention window. A permanent list would turn
-- a rare annoyance into a permanent exclusion, which is the second reason this
-- expires.
--
-- Everything below is IF NOT EXISTS and runs inside the migration runner's
-- single transaction (db/migrate.js default mode).

-- TEXT, not CHAR(64), even though every digest is exactly 64 hex characters.
-- A bpchar column compared against a text parameter is cast to text first
-- (`(email_hash)::text = $1`), which uses the text operator family and cannot
-- use a bpchar index: verified on PostgreSQL 18 against 5,000 rows, where the
-- CHAR(64) version planned a sequential scan for every signup. TEXT indexes the
-- same values and is searched directly.
CREATE TABLE IF NOT EXISTS banned_identities (
  id SERIAL PRIMARY KEY,
  email_hash TEXT,
  phone_hash TEXT,
  oauth_hash TEXT,
  -- When the ban was imposed (users.banned_at). Context for a human handling an
  -- appeal, not an identifier and not the retention clock (see above).
  banned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Hard stop. Lookups require expires_at > NOW(), so retention is enforced by
  -- the read path and not only by the purge job.
  expires_at TIMESTAMPTZ NOT NULL
);

-- A row with no digest at all would be an unmatchable record of nothing, i.e.
-- data held for no purpose. Refuse to write one.
DO $$ BEGIN
  ALTER TABLE banned_identities ADD CONSTRAINT banned_identities_has_identity
    CHECK (email_hash IS NOT NULL OR phone_hash IS NOT NULL OR oauth_hash IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Signup runs ONE query that ORs the three digest columns, which the planner
-- resolves against whichever of these partial indexes the supplied digests
-- select (verified: index scan, not a sequential scan). Partial, so rows that
-- carry no digest of a given kind stay out of that kind's index.
CREATE INDEX IF NOT EXISTS idx_banned_identities_email ON banned_identities(email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_banned_identities_phone ON banned_identities(phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_banned_identities_oauth ON banned_identities(oauth_hash) WHERE oauth_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_banned_identities_expires ON banned_identities(expires_at);
