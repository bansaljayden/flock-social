-- 079: friend codes are issued, not derived.
--
-- WHY. Until this migration a friend code was 'FLOCK-' plus the user's id in
-- base36 (FLOCK-0016 was user 42), computed on both ends and stored nowhere.
-- Every account's code could be worked out, so POST /api/friends/add-by-code
-- was the user directory walked with a different spelling, and the only thing
-- between a stranger and a friend request at any account was the probe budget.
--
-- WHAT CHANGES. A code is now 'FLOCK-' plus eight characters drawn at random
-- (routes/friends.js, newFriendCode), stored here, and issued the first time
-- its owner opens Add Friends (GET /api/friends/my-code). add-by-code resolves
-- a code by this column only. Codes shared under the old scheme stop resolving
-- on purpose: they were the user id, and keeping them working would keep the
-- directory walkable.
--
-- NULL until issued. Unique among the issued ones, so a code names one person.
-- The column leaves with the account row, like everything else about it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_code VARCHAR(16);

CREATE UNIQUE INDEX IF NOT EXISTS users_friend_code_key
  ON users (friend_code) WHERE friend_code IS NOT NULL;
