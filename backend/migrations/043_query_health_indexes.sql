-- @noTransaction
-- 043: five sequential scans on live read paths, in order of how hot they are.
--
-- @noTransaction because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. A concurrent build takes no write lock, so this applies
-- while the app is serving, which is the whole point: three of these five are
-- on tables the API writes to on every request.
--
-- Same invalid-index cleanup as 008/013/014/018: a CONCURRENTLY build that
-- dies partway leaves an INVALID index behind that `IF NOT EXISTS` would then
-- skip forever, present in the catalog and never used by the planner. Drop any
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
        'idx_venue_owner_reports_diverged',
        'idx_emergency_alerts_user_created',
        'idx_venue_sensor_data_device_recorded',
        'idx_venue_reviews_place_created',
        'idx_venue_reviews_user',
        'idx_emoji_reactions_user'
      ])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- 1. THE DIVERGENCE STRIKE COUNT, WHICH RUNS ON EVERY CROWD READ.
--
-- 031 gave venue_owner_reports exactly one index on google_place_id and made
-- it PARTIAL on `retracted = false`, because the serve path only ever reads
-- live rows. The strike counter that sits inside the same statement does not:
-- services/ownerReports.js LIVE_OWNER_REPORTS_SQL asks whether three or more
-- rows for this place were stamped `diverged = true` in the last 30 days, and
-- a diverged row is very often a retracted one, so it carries no `retracted`
-- predicate at all. `diverged = true` does not imply `retracted = false`, the
-- planner cannot prove the partial index covers the question, and there is no
-- other index on google_place_id — so the subquery sequentially scans the
-- table.
--
-- It is a CORRELATED subquery, which is what turns a small cost into a real
-- one: POST /api/crowd/batch calls getLiveOwnerReports once per place id in
-- the request body, so a twenty-venue vote list re-scans venue_owner_reports
-- twenty times. The same statement is behind the crowd card, the detail card,
-- the alternatives list, Birdie's venue answer and the owner dashboard's own
-- strike display (routes/venueDashboard.js ownerBusyState).
--
-- Partial on `diverged = true` rather than a three-column index, deliberately:
-- diverged rows are the rare ones, and this table's other index is already
-- partial on the same reasoning.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_owner_reports_diverged
  ON venue_owner_reports (google_place_id, created_at DESC)
  WHERE diverged = true;

-- 2. THE SOS PRE-FLIGHT, ON THE TABLE WITH NO SECONDARY INDEX AT ALL.
--
-- emergency_alerts has carried nothing but its primary key since 001, and
-- user_id is an ON DELETE CASCADE foreign key with no index behind it. The
-- panic button's pre-flight (routes/safety.js) is one statement that reads the
-- caller's last alert and counts two more windows over the same column, so it
-- is three scans of the table in a row, inside a held transaction, on the one
-- route in this app where latency is a safety property rather than a comfort.
-- Every account deletion scans it too.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_emergency_alerts_user_created
  ON emergency_alerts (user_id, created_at DESC);

-- 3. THE SENSOR REPLAY CHECK, WHOSE ONLY INDEX GETS WORSE EVERY MINUTE.
--
-- routes/sensors.js rejects a duplicate client-supplied timestamp with
-- `WHERE sensor_device_id = $1 AND recorded_at = $2`. idx_venue_sensor_data_
-- device covers the first column, and that is the problem rather than the fix:
-- one device is ONE value of that column against a table it appends to
-- forever, so the equality on recorded_at is a scan of that device's entire
-- history, and it lengthens by one row per reading. A device sampling once a
-- minute crosses half a million rows under a single key inside a year. The
-- check runs before the write, on the primary pool.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_sensor_data_device_recorded
  ON venue_sensor_data (sensor_device_id, recorded_at);

-- 4. THE REVIEW LISTS, WHICH SORT BY HAND.
--
-- idx_venue_reviews_place is (google_place_id) alone, so all three review
-- reads (the owner's list, the PUBLIC list, and the 7-day pulse rollup in
-- routes/venueDashboard.js) fetch every review for the place and then sort it
-- in memory before applying their LIMIT. Adding created_at DESC to the index
-- makes the LIMIT stop early instead.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_reviews_place_created
  ON venue_reviews (google_place_id, created_at DESC);

-- 5. THE TWO user_id COLUMNS THAT CASCADE WITHOUT AN INDEX.
--
-- Both of these are ON DELETE CASCADE foreign keys to users(id) whose only
-- index buries user_id mid-constraint, where it is not a usable prefix:
-- venue_reviews has UNIQUE(google_place_id, user_id) and emoji_reactions has
-- UNIQUE(message_id, user_id, emoji). So every account deletion sequentially
-- scans both tables to find the rows to remove, and so does the GDPR export in
-- routes/users.js, which reads the same column. Same defect and same fix as
-- the dm_venue_votes and dm_pinned_venues columns in 042; these two are here
-- rather than there because their tables are large enough to be worth building
-- concurrently.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_reviews_user
  ON venue_reviews (user_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_emoji_reactions_user
  ON emoji_reactions (user_id);
