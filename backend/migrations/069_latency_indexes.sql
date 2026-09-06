-- @noTransaction
-- 069: the five indexes a latency audit found missing on hot read paths.
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. Concurrent builds take no write lock, so this is safe to
-- apply while the app is serving.
--
-- Same invalid-index cleanup as 008/013/014/018: a CONCURRENTLY build that
-- dies partway leaves an INVALID index behind that `IF NOT EXISTS` would then
-- skip forever, present to the catalog and never used by the planner. Drop any
-- invalid leftovers of exactly these names first so a retry rebuilds them.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT i.indisvalid
      AND n.nspname = 'public'
      AND c.relname = ANY (ARRAY[
        'idx_messages_flock_id_desc',
        'idx_users_banned',
        'idx_dm_sender_receiver_id',
        'idx_dm_receiver_sender_id',
        'idx_pinned_messages_message'
      ])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1. messages: every index keys on created_at, both hot reads page on id.
-- ---------------------------------------------------------------------------
-- Both chat reads were deliberately moved OFF created_at and ONTO id, and the
-- reason is written out at routes/messages.js:417 -- created_at is a plain
-- TIMESTAMP DEFAULT NOW() and ties, so it cannot be a stable cursor. The
-- indexes were never moved with them. idx_messages_flock_created
-- (flock_id, created_at DESC) satisfies the FILTER and not the ORDER, so:
--
--   * History (routes/messages.js) does `ORDER BY m.id DESC LIMIT n` -- it
--     collects every message in the flock and top-N sorts them. A 5,000
--     message flock sorts 5,000 rows to return 50, on every scroll up.
--
--   * The unread badge (routes/flocks.js) is worse, because THE COMMON CASE IS
--     THE WORST CASE. It counts `m.id > COALESCE(fm.last_read_message_id, 0)`
--     under a LIMIT 100. The limit stops the scan only once 100 unread rows
--     are FOUND; for a member who is caught up, nothing matches, so Postgres
--     walks every index entry for that flock and heap-fetches each row (id,
--     is_hidden, sender_deleted_at and sender_id are none of them in the
--     index) before concluding there is nothing to show. That runs once per
--     row of GET /api/flocks, capped at 300 flocks -- roughly 60,000 heap
--     fetches at 200 messages a flock, to render zero badges, on the request
--     the app issues every single time it opens.
--
-- One index closes both: `m.id > cursor` becomes a bounded range that returns
-- immediately when empty, and the DESC order is served straight off the scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_flock_id_desc
  ON messages (flock_id, id DESC);

-- ---------------------------------------------------------------------------
-- 2. users.is_banned: indexed nowhere, and read on nearly every request.
-- ---------------------------------------------------------------------------
-- utils/blocks.js getInvisibleUserIds UNIONs three legs. The two user_blocks
-- legs are indexed. The third, `SELECT id FROM users WHERE is_banned IS TRUE`,
-- has no index at all, so every call SEQUENTIALLY SCANS users.
--
-- It runs on flock history, the DM inbox, DM threads, flock detail, members,
-- history, friends, pending and outgoing requests, bill splits, stories, and
-- every socket send_message / send_dm / flock_invite / select_venue. Several
-- routes call it more than once per request. Partial, because the banned set
-- is moderation-scale and the index only ever needs to cover it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_banned
  ON users (id) WHERE is_banned IS TRUE;

-- ---------------------------------------------------------------------------
-- 3 and 4. direct_messages: the same order/index mismatch as messages.
-- ---------------------------------------------------------------------------
-- idx_dm_sender_receiver_created and its mirror both end in created_at DESC,
-- while the thread read filters on the pair in either direction and then does
-- `ORDER BY dm.id DESC LIMIT n`. So Postgres BitmapOrs both directions,
-- collects the whole conversation, sorts it, and returns 50.
--
-- The created_at pair is deliberately KEPT: the inbox query's DISTINCT ON
-- still orders by created_at, so dropping them would trade one slow read for
-- another.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_sender_receiver_id
  ON direct_messages (sender_id, receiver_id, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_receiver_sender_id
  ON direct_messages (receiver_id, sender_id, id DESC);

-- ---------------------------------------------------------------------------
-- 5. pinned_messages.message_id: an unindexed foreign key on a delete path.
-- ---------------------------------------------------------------------------
-- Postgres does not index the referencing side of a foreign key. Migration 068
-- added pinned_messages with a message_id FK and no index, so every message
-- unsend and every message delete sequentially scans the whole pin table to
-- find rows to cascade. Migration 042 made exactly this argument for two other
-- tables; the audit was never extended to 068.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pinned_messages_message
  ON pinned_messages (message_id);
