-- @noTransaction
-- 008: composite indexes for the tables that actually grow (round 12).
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. Concurrent builds never take a write lock, so this file is
-- safe to apply while the app is serving — the whole point, since three of
-- these tables are on hot read paths.
--
-- A CONCURRENTLY build that dies partway leaves an INVALID index behind, and
-- `IF NOT EXISTS` would then skip it forever — the index would look present and
-- never be used. Drop any invalid leftovers of exactly these names first, so a
-- retry actually rebuilds them.
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
        'idx_messages_flock_created',
        'idx_dm_sender_receiver_created',
        'idx_dm_receiver_sender_created',
        'idx_dm_reply_to',
        'idx_venue_checkins_place_created',
        'idx_venue_votes_user',
        'idx_ml_venues_lat_lng',
        'idx_venue_sensor_data_place_recorded'
      ])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- Flock chat history: every open of a flock runs
-- "WHERE flock_id = $1 ORDER BY created_at DESC LIMIT n". The baseline has two
-- single-column indexes, so Postgres filters by flock then sorts the whole
-- match set; the composite serves filter + order from one scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_flock_created
  ON messages (flock_id, created_at DESC);

-- DM thread reads are directional and pull the newest page first. A DM
-- conversation query ORs both directions, so BOTH orderings are needed —
-- with only (sender, receiver) the reverse leg falls back to a scan + sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_sender_receiver_created
  ON direct_messages (sender_id, receiver_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_receiver_sender_created
  ON direct_messages (receiver_id, sender_id, created_at DESC);

-- reply_to_id is a self-FK with ON DELETE SET NULL. Unindexed, every DM delete
-- (and every account deletion cascade, which deletes many) sequentially scans
-- direct_messages once per row to find referencing replies.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_reply_to
  ON direct_messages (reply_to_id);

-- Live occupancy: "checkins at this venue in the last N minutes" is the hottest
-- read on the fastest-growing table (public NFC endpoint writes it).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_checkins_place_created
  ON venue_checkins (venue_place_id, created_at DESC);

-- venue_votes is indexed by flock only; account deletion and "my votes" reads
-- filter by user_id and scan the whole table without this.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_votes_user
  ON venue_votes (user_id);

-- ML inference resolves "nearest training venue to this lat/lng" by bounding
-- box. 250+ rows today, but it runs per prediction request.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ml_venues_lat_lng
  ON ml_venues (latitude, longitude);

-- Sensor ingest appends continuously per venue and every read is
-- "this venue, most recent window" — the single-column indexes force a sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_sensor_data_place_recorded
  ON venue_sensor_data (venue_place_id, recorded_at DESC);
