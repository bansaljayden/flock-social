-- 062: one account per mailbox, enforced by the database and not only by the
-- check that runs before the INSERT.
--
-- routes/auth.js compares addresses in a canonical alphabet before it creates
-- an account (EMAIL_CANONICAL_SQL: lower-cased, and for Gmail with the dots
-- and the +suffix removed, because Gmail delivers john.doe+x@ to johndoe@), and
-- routes/users.js applies the same expression before it moves an account onto
-- a new address. The only UNIQUE the table carried was on the raw string, so
-- two signups for john.doe@gmail.com and johndoe@gmail.com in the same moment
-- both passed the check, both inserted, and one mailbox owned two accounts
-- (adversarial audit round 2, 2026-09-05). The check is a check; this index is
-- the constraint. The loser of that race now raises 23505, which every path
-- that creates or moves an account answers as "already registered".
--
-- The expression below is EMAIL_CANONICAL_SQL verbatim, and
-- __tests__/canonicalEmailIndex.test.js pins the two equal so they cannot
-- drift: an index over a different alphabet than the check would let a row in
-- that the check refuses, or refuse one the check allows, and either way the
-- database and the route would disagree about who owns a mailbox.
--
-- Verified against production before this was written: 33 accounts, zero
-- collisions under the expression, so it builds on the live data. Not
-- CONCURRENTLY, deliberately: the table is small, the migration runner already
-- holds its advisory lock, and a transactional build is the one that cannot
-- leave an invalid index behind on failure.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_canonical_email ON users ((
  CASE
    WHEN split_part(LOWER(email), '@', 2) IN ('gmail.com', 'googlemail.com')
      THEN regexp_replace(split_part(split_part(LOWER(email), '@', 1), '+', 1), '\.', '', 'g') || '@gmail.com'
    ELSE LOWER(email)
  END
));
