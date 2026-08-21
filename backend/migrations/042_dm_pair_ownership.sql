-- 042: the two DM tables that did not notice when one of the two people left.
--
-- WHAT WAS WRONG.
--
-- Every other table in the DM surface is keyed to users(id) with a real
-- foreign key: direct_messages.sender_id and .receiver_id both CASCADE,
-- dm_emoji_reactions.user_id CASCADEs, and DELETE /api/users/me relies on that
-- — the account row goes, the conversation goes with it. Two tables are keyed
-- to the CONVERSATION instead of to a person, by an ordered pair of raw
-- integers with no constraint behind either of them:
--
--   dm_venue_votes  (user1_id, user2_id, user_id, venue_name, venue_id)
--   dm_pinned_venues(user1_id, user2_id, venue_name, venue_address, venue_id,
--                    venue_rating, venue_photo_url, pinned_by)
--
-- user1_id and user2_id are plain `INTEGER NOT NULL` in 001_baseline.sql. Only
-- the third column carries a constraint: dm_venue_votes.user_id CASCADEs, and
-- dm_pinned_venues.pinned_by is ON DELETE SET NULL.
--
-- So when somebody deletes their account:
--
--   * every dm_pinned_venues row for every conversation they were in SURVIVES
--     the deletion in full. pinned_by is nulled, which anonymises the pinner
--     and nothing else: the row still holds their user id in user1_id or
--     user2_id, plus the name, street address, rating and photo of the place
--     that conversation was about. Nulling the author of a record while
--     leaving the record — and the deleted person's id inside it — is not
--     deletion, and this table is the one that keeps a venue's ADDRESS.
--   * dm_venue_votes loses the deleted user's own votes (user_id CASCADEs) and
--     keeps the other party's votes in that same conversation, each still
--     carrying the deleted user's id in the pair columns. What is left behind
--     is a durable statement that account 412, which no longer exists, was in
--     a private conversation with account 907 about a named bar.
--
-- Neither row is reachable by any product surface once the account is gone —
-- routes/messages.js only ever reads a pair where the caller is one of the two
-- — so nothing surfaces it, nothing prunes it, and it accumulates silently.
-- "Nobody can see it" is not the standard a deletion promise is held to; the
-- standard is that it is gone.
--
-- THE FIX is the constraint the other DM tables already have. user1_id and
-- user2_id become real foreign keys with ON DELETE CASCADE, so either party
-- leaving takes the pair's rows with them, which is what "the conversation is
-- deleted" has always meant everywhere else in this schema. No route changes:
-- every write already inserts two ids that exist, because both come from an
-- authenticated session and a participant check.
--
-- ORDER INSIDE THIS FILE MATTERS. Adding a foreign key to a column that
-- already holds a dangling id fails, and a migration that fails is a boot that
-- fails, which is production down. So the pre-existing orphans are deleted
-- FIRST, in the same transaction, and the ADD CONSTRAINT after them cannot hit
-- data it has not already cleaned. The DELETEs are idempotent (a second run
-- matches nothing) and are the same rows the cascade would have taken had the
-- constraint existed on the day those accounts were deleted.
--
-- WHY ONE PLAIN TRANSACTION AND NOT `-- @noTransaction` WITH CONCURRENTLY.
-- The CONCURRENTLY migrations here (004, 008, 013, 014, 018) exist because a
-- plain CREATE INDEX holds a write lock for the length of the build on a table
-- that is being written to. That reasoning does not reach these two: they are
-- among the smallest tables in the database, and ADD CONSTRAINT ... FOREIGN
-- KEY takes ACCESS EXCLUSIVE on the table regardless of how its index was
-- built, so building the index concurrently would buy nothing and would cost
-- the atomicity that makes the purge-then-constrain order safe. A failure here
-- rolls back whole, leaves no INVALID index to clean up, and is retried on the
-- next boot.

-- -- The orphans, before anything can trip over them ------------------------
DELETE FROM dm_venue_votes
 WHERE user1_id NOT IN (SELECT id FROM users)
    OR user2_id NOT IN (SELECT id FROM users);

DELETE FROM dm_pinned_venues
 WHERE user1_id NOT IN (SELECT id FROM users)
    OR user2_id NOT IN (SELECT id FROM users);

-- -- The indexes the cascade will walk --------------------------------------
-- A cascading delete looks up child rows by the referencing column, and with
-- no index on it that lookup is a sequential scan of the whole table, taken
-- while the users row is locked. user1_id is already the leading column of
-- idx_dm_venue_votes_pair and of dm_pinned_venues' UNIQUE(user1_id, user2_id),
-- so it is covered; user2_id is the trailing column of both and is covered by
-- neither.
--
-- dm_venue_votes.user_id is here for the same reason and is NOT new breakage:
-- it has CASCADEd since 001 and its only index is UNIQUE(user1_id, user2_id,
-- user_id, venue_name), where user_id is the third column and therefore not a
-- usable prefix. Every account deletion since launch has sequentially scanned
-- this table; it is small enough that nobody noticed, and it is a one-line fix
-- to stop.
--
-- dm_pinned_venues.pinned_by is ON DELETE SET NULL, which is an UPDATE of the
-- matching rows and needs to find them by the same lookup.
CREATE INDEX IF NOT EXISTS idx_dm_venue_votes_user2 ON dm_venue_votes(user2_id);
CREATE INDEX IF NOT EXISTS idx_dm_venue_votes_user ON dm_venue_votes(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_pinned_user2 ON dm_pinned_venues(user2_id);
CREATE INDEX IF NOT EXISTS idx_dm_pinned_pinned_by ON dm_pinned_venues(pinned_by);

-- -- The constraints ---------------------------------------------------------
-- Named explicitly so a replay is decidable, and guarded on duplicate_object
-- ONLY. Not `WHEN others`: if one of these fails for any reason other than
-- already existing, the deletion promise is still unenforced and the boot has
-- to say so rather than record the file as applied and move on. The purge
-- above means the one remaining way to fail is the lock_timeout db/migrate.js
-- sets, which is a clean retry on the next boot.
DO $$ BEGIN
  ALTER TABLE dm_venue_votes
    ADD CONSTRAINT dm_venue_votes_user1_id_fkey
    FOREIGN KEY (user1_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE dm_venue_votes
    ADD CONSTRAINT dm_venue_votes_user2_id_fkey
    FOREIGN KEY (user2_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE dm_pinned_venues
    ADD CONSTRAINT dm_pinned_venues_user1_id_fkey
    FOREIGN KEY (user1_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE dm_pinned_venues
    ADD CONSTRAINT dm_pinned_venues_user2_id_fkey
    FOREIGN KEY (user2_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
