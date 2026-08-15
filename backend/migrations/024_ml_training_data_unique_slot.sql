-- @noTransaction
-- 024: ml_training_data finally gets the unique key its INSERT statements have
-- been naming since migration 006, the duplicate rows that key forbids are
-- collapsed to one row per slot, and the two calendar columns collectWeekly
-- never wrote are stamped from each row's own collection timestamp.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
--
-- scripts/ml/collectWeekly.js inserts 168 rows per venue with
-- `ON CONFLICT DO NOTHING` and NO conflict target. There has never been a
-- unique index for it to hit — migration 006 declares `id SERIAL PRIMARY KEY`
-- and four non-unique indexes, and database/ml-schema.sql agrees — so the
-- clause is decorative. Postgres accepts it (a bare DO NOTHING needs no
-- arbiter) and every re-collection stacks another full copy of the venue's
-- week on top of the last one, silently, with the log line still reading
-- "168 rows inserted".
--
-- Measured on the 2026-08-12 corpus export (300 sampled venues, keyed on
-- lat|lng so distinct venues sharing coordinates merge — a LOWER bound):
--
--   venue-dow-hour-mode cells 29,490   cells with >1 row 4,743 (16.1%)  max 8
--     WEEKLY cells    n=27,305  mean=1.16  p90=2  max=3
--     REALTIME cells  n=2,185   mean=2.05  p90=4  max=8
--
-- Every average keyed on (venue, dow, hour) — ml_venue_baselines, the
-- leave-one-out baseline in train/export_training_data.js, the category
-- baselines in prepare_features.py — is therefore an UNWEIGHTED mean over an
-- uneven number of repeats. A venue collected three times counts three times.
-- Nothing anywhere says so.
--
-- ---------------------------------------------------------------------------
-- THE SURVIVOR RULE, and why it is this one
--
-- Duplicate rows are not identical: they can differ in busyness_pct,
-- collected_at, baseline_busyness, hour_axis, observed_date and every weather
-- column. Choosing between them is a judgement, so it is written down here and
-- pinned in __tests__/mlCorpusDedupe.test.js:
--
--     ORDER BY (hour_axis = 'venue_local') DESC NULLS LAST,   -- 1. corrected axis
--              collected_at              DESC NULLS LAST,     -- 2. newest snapshot
--              besttime_epoch            DESC NULLS LAST,     -- 3. newest vendor analysis
--              id                        DESC                 -- 4. total order
--
-- 1. CORRECTED BEATS LEGACY, ALWAYS. Migration 023 stamped every weekly row it
--    converted `hour_axis = 'venue_local'`, so within the corpus 023 left
--    behind, this key is constant and rule 2 decides. It is here for the case
--    that is not constant: a row still carrying `'besttime_index'` holds a
--    BestTime day_raw ARRAY INDEX in `hour`, i.e. a number six hours away from
--    what the column means. Recency must never be allowed to promote such a row
--    over a corrected one — a newer wrong number is still a wrong number. Note
--    this ordering cannot be inverted by a later collector either: nothing
--    writes 'besttime_index' today, and 023's CHECK constraint makes an
--    undeclared weekly row impossible.
-- 2. NEWEST SNAPSHOT WINS. A weekly row is not an observation; it is BestTime's
--    estimate of the venue's typical week, re-read. Three re-reads are one
--    estimand sampled three times, not three facts — which is why they are
--    collapsed rather than averaged. Averaging would invent a busyness value the
--    vendor never reported, weight a months-old picture of a venue equally with
--    today's, and (worse) leave a row whose busyness_pct came from one fetch
--    while its weather, rating and besttime_epoch came from another. The
--    surviving row is a real row, internally consistent, from a single fetch.
-- 3. besttime_epoch is BestTime's own analysis timestamp. It breaks the tie when
--    two rows were written inside the same second — a single batched INSERT
--    gives all 168 rows the same collected_at.
-- 4. `id DESC` makes the order total, so the migration is deterministic and the
--    test can assert a specific survivor rather than "one of them".
--
-- NULLS LAST everywhere: a NULL carries no evidence, and a row that cannot say
-- when it was collected must not outrank one that can.
--
-- The collectors were changed to agree with this rule, so history and
-- go-forward behaviour are the same rule and not two:
--   * collectWeekly.js now does ON CONFLICT ... DO UPDATE — a re-collection
--     REFRESHES the venue's typical week in place instead of stacking. "Newest
--     wins" then holds forever, not just for the rows this migration touched.
--   * collectRealtime.js does ON CONFLICT ... DO NOTHING. A realtime row is an
--     OBSERVATION of one venue-hour on one date; a second pull inside the same
--     clock hour is the same observation re-read, and there is nothing stale
--     about the stored one to refresh. Overwriting a recorded observation is a
--     different act from refreshing an estimate, and this is the asymmetry.
--
-- ---------------------------------------------------------------------------
-- THE INDEX — and where it deviates from the one the audit specified
--
-- PRE-RETRAIN-AUDIT.md finding #2 and RETRAIN.md's status board both name:
--
--   CREATE UNIQUE INDEX CONCURRENTLY … ON ml_training_data
--     (venue_id, collection_mode, day_of_week, hour,
--      COALESCE(observed_date, '1970-01-01'))
--
-- That form is NOT applied here, and the reason is the COALESCE. `observed_date`
-- was added on 2026-08-12; realtime rows written before it are undated. Under
-- the COALESCE key every one of a venue's undated realtime rows at a given
-- (dow, hour) collapses onto the SAME key — including rows the audit itself
-- says are "legitimately repeated across dates". Enforcing that key would delete
-- genuinely distinct observations, which are the highest-value rows in the
-- corpus (sample weight 1.0, versus 0.05 for a weekly anchor row) and are
-- unrecoverable: the dates they were collected on cannot be reconstructed from
-- a busyness number. So the key is split into two PARTIAL unique indexes that
-- assert only what can be proven:
--
--   weekly   : UNIQUE (venue_id, day_of_week, hour)
--                WHERE collection_mode = 'weekly' AND hour_axis = 'venue_local'
--   realtime : UNIQUE (venue_id, day_of_week, hour, observed_date)
--                WHERE collection_mode = 'realtime' AND observed_date IS NOT NULL
--
-- collection_mode is in the predicate rather than the key, which is the same
-- statement in a cheaper shape. Undated legacy realtime rows are left alone and
-- uncovered — that is deliberate and it is the only honest option. No new
-- undated realtime row can appear: collectRealtime.js has stamped
-- observed_date on every row since 2026-08-12.
--
-- WHY THE WEEKLY INDEX IS SCOPED TO hour_axis = 'venue_local', which is not a
-- detail. `hour` only means something once you know which clock it is on: a
-- 'besttime_index' row at (dow 6, hour 6) is BestTime slot 6, i.e. the venue's
-- NOON, while a 'venue_local' row at (dow 6, hour 6) is 6 AM. They are not two
-- statements about the same slot, so a key that treats them as one is asserting
-- something false. The practical consequence is sharper: migration 023's
-- transform is a ROTATION of the 168-cell week, and rows chase each other
-- through it (slot 0 lands where slot 18 currently sits). A unique index that
-- did not distinguish the axes would reject the intermediate state of that
-- UPDATE — 23505 inside the DO block — which would make 023 impossible to
-- re-run, breaking the "permanent repair tool, not a one-shot" property its own
-- header claims and __tests__/mlClockAxisBackfill.test.js pins. Because 023
-- writes the shift and the axis stamp in the SAME UPDATE, a converting row
-- enters this index at its new slot while the row it displaces has not entered
-- yet, and the rotation goes through.
--
-- Nothing is lost by the scoping: 023 left every weekly row in the corpus
-- stamped 'venue_local', its CHECK constraint makes an undeclared weekly row
-- impossible, and collectWeekly.js writes the literal. The dedupe below is
-- deliberately NOT scoped that way — it collapses per (venue, dow, hour) across
-- axes and prefers the corrected row, because a legacy row sharing a slot with
-- a corrected one is a defect to retire, not a fact to keep.
--
-- ---------------------------------------------------------------------------
-- month / season — backfilled from collected_at, which is NOT inventing a date
--
-- 62.9% of the corpus carries `month = 0` with all four season one-hots at 0
-- (prep_v25.log), a combination `mlPredictor.buildFeatureMap` can never produce
-- at inference: it always writes `month = ts.getMonth() + 1` in 1..12 and
-- exactly one season at 1. Two thirds of the corpus therefore sits in a corner
-- of feature space the serving path cannot reach. The cause is that
-- collectWeekly.js omits both columns from its INSERT and prepare_features.py
-- fills the resulting NaN with 0.
--
-- `collected_at` is `TIMESTAMPTZ DEFAULT NOW()`, written by Postgres at insert
-- time and never set by any caller, so it is a real record of when the snapshot
-- was taken. Deriving month and season from it is reading a date the row
-- already carries, not fabricating one. Three honest limitations, stated rather
-- than hidden:
--
--   * It is extracted `AT TIME ZONE 'UTC'`, not the venue's zone, so a row
--     collected within a few hours of a month boundary can land in the adjacent
--     month. Consulting ml_venues.timezone would be more precise and would also
--     make this migration raise on any venue whose timezone string is unusable
--     — 023 refused to depend on that column for the same reason. A one-day
--     boundary error on a monthly feature is the cheaper mistake.
--   * For a weekly row, month means "the month this typical-week snapshot was
--     taken in", not "the month this busyness happened in" — BestTime's typical
--     week is an average over a trailing window. It is genuine metadata about
--     the row; it is not the same quantity a realtime row's month is. This is
--     exactly what the go-forward collector stamp means too, so the backfill and
--     the collector agree.
--   * It does NOT stop month from proxying row provenance (audit finding #5's
--     second worry). The corpus was collected in a narrow window, so weekly rows
--     will cluster in a couple of months. What it does fix is the impossible
--     corner: after this, every stamped row has a month in 1..12 and exactly one
--     season, which is a region the serving path actually reaches.
--
-- Rows whose `collected_at` is NULL are SKIPPED, not guessed.
--
-- `weather_condition_code` is deliberately NOT backfilled here.
-- prepare_features.py already recovers it for the whole corpus from the
-- free-text `weather_condition` via WEATHER_DESCRIPTION_CODES /
-- recover_weather_codes(), and stops the run on any description it does not
-- know. A second full-table rewrite to store what the exporter can already
-- derive would buy nothing and cost another pass over 3.5M rows. Both
-- collectors now write `weather.conditionId` on new rows, so recovery is a
-- transitional path and not a permanent one.
--
-- ---------------------------------------------------------------------------
-- PRODUCTION COST, AND WHY EVERY HEAVY STATEMENT IS BATCHED
--
-- Migration 023 took the API down for NINE MINUTES (540s). db/migrate.js runs
-- the chain BEFORE server.listen(), so every second of this file is a second
-- the port is closed.
--
-- MEASURED, not guessed. Embedded Postgres, a corpus built to the shape of the
-- 2026-08-12 export: 3,705,600 rows (3,345,600 weekly + 360,000 realtime),
-- 708 MB with indexes, 489,600 surplus weekly rows across 469,200 multi-row
-- cells, month NULL on 64.1% (the audit measured 62.9%).
--
--   023's rotation UPDATE, the comparable reference       38.0s local
--   024 invalid-index cleanup                              0.0s
--   024 batched dedupe + calendar stamp (68 batches)      26.4s
--   024 CREATE UNIQUE INDEX CONCURRENTLY, weekly           4.6s
--   024 CREATE UNIQUE INDEX CONCURRENTLY, realtime         0.7s
--   024 TOTAL                                             31.7s local
--   (deletes 491,100 rows; leaves 0 rows without a month)
--
-- 023's own header measured its rotation at ~10.4s per million weekly rows,
-- which is 35s for this corpus — so this harness reproduces that author's
-- number and can be trusted for this kind of work.
--
-- The bound on production: the whole of 023 (rotation PLUS an
-- ml_venue_baselines rebuild) cost 540s there, so
-- factor = prod_rotation / 38.0s <= 540 / 38.0 = 14.2, and 024 <= 31.7 x 14.2
-- = 451s, i.e. UNDER EIGHT MINUTES OF CLOSED PORT, worst case. It is a bound
-- and not an estimate: it credits the entire nine minutes to the rotation, and
-- the rebuild is certainly most of it (on this harness the rebuild alone ran
-- 57x longer than the rotation before it was abandoned). Two to four minutes is
-- the realistic figure. 024 has no baseline rebuild at all.
--
-- Note what that factor does to the runner's 300s per-statement cap: the DO
-- block below is ONE statement at 26.4s local, which is 375s at 14.2x. That is
-- why `SET statement_timeout = 0` is not optional here.
--
-- Consequences, all of them applied below:
--   * The dedupe and the calendar stamp run in a batched loop with a COMMIT per
--     batch, exactly as 023 does, so a killed deploy resumes from committed
--     progress instead of restarting from zero. Both operations are idempotent
--     (the DELETE's predicate is "is not the survivor of its group"; the
--     UPDATE's is "this row still has no usable month or season"), so a resumed
--     run repeats work rather than corrupting it.
--   * The batch is a range of venue_id, NOT of id. venue_id is the leading
--     column of BOTH unique keys, so no duplicate group can straddle a batch
--     boundary — which is what makes ONE pass provably complete. An id-range
--     batch would split a group whose members were inserted in different runs
--     and leave duplicates behind, and the only place that would surface is the
--     unique index build failing mid-deploy. idx_ml_training_venue supports the
--     range scan.
--   * statement_timeout is lifted for the loop and the index builds only, and
--     restored at the end of the file. lock_timeout still guards the DDL.
--   * The indexes are built CONCURRENTLY (house pattern: 004, 008, 013, 014,
--     018), with the same invalid-index cleanup first — a CONCURRENTLY build
--     that dies partway leaves an INVALID index behind that `IF NOT EXISTS`
--     would then skip forever, present to the catalog, never used by the
--     planner, and (for a unique index) still enforcing itself on every insert.
--
-- The index build is the verification step. If the dedupe missed anything,
-- CREATE UNIQUE INDEX fails and names the offending key in its own error
-- message, which is more precise than any assertion this file could raise.
--
-- IDEMPOTENT BY CONSTRUCTION. On a second run the DELETE matches no row (every
-- group has exactly one member), the UPDATE matches no row (every datable row
-- now has a month and a season, and the undatable ones never matched and never
-- will), the cleanup finds no invalid index, and `IF NOT EXISTS` skips both
-- builds. __tests__/mlCorpusDedupe.test.js pins that by xmin: the second run
-- writes nothing at all, not "the same values again".
--
-- Operator's counts query (read-only, run before to size the change):
--
--   SELECT collection_mode, COUNT(*) AS rows, COUNT(*) - COUNT(DISTINCT (
--            venue_id, day_of_week, hour, COALESCE(observed_date, DATE '1970-01-01')
--          )) AS surplus
--   FROM ml_training_data GROUP BY 1;
-- ---------------------------------------------------------------------------

-- Same invalid-index cleanup as 008/013/014/018, run FIRST so a retry after a
-- half-built CONCURRENTLY index starts from a clean catalog.
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
        'ml_training_data_weekly_slot_uniq',
        'ml_training_data_realtime_slot_uniq'
      ])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;

-- The loop below is bounded work, but the whole DO block is ONE statement to
-- the server and the timer armed when it started cannot be reset from inside
-- it. db/migrate.js caps a statement at 300s (STATEMENT_TIMEOUT_MS); on
-- Railway's storage that cap would kill the loop part-way. Lifted here,
-- restored at the end of the file. (The runner uses one dedicated connection
-- and destroys it afterwards, so this cannot leak into the request pool.)
SET statement_timeout = 0;

DO $$
DECLARE
  batch     CONSTANT BIGINT := 250;   -- venue_ids per batch, not rows
  lo        BIGINT;                   -- BIGINT like 023's loop, so `lo + batch`
  hi        BIGINT;                   -- cannot overflow a high SERIAL
  n         BIGINT;
  collapsed BIGINT := 0;
  stamped   BIGINT := 0;
BEGIN
  SELECT MIN(venue_id), MAX(venue_id) INTO lo, hi FROM ml_training_data;

  WHILE lo IS NOT NULL AND lo <= hi LOOP
    -- Weekly: one row per (venue, day, hour). The survivor rule is the ORDER BY;
    -- everything ranked below the first row of its group goes.
    DELETE FROM ml_training_data t
     USING (
       SELECT id FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY venue_id, day_of_week, hour
                  ORDER BY (hour_axis = 'venue_local') DESC NULLS LAST,
                           collected_at   DESC NULLS LAST,
                           besttime_epoch DESC NULLS LAST,
                           id             DESC
                ) AS rn
           FROM ml_training_data
          WHERE venue_id >= lo AND venue_id < lo + batch
            AND collection_mode = 'weekly'
       ) ranked
       WHERE ranked.rn > 1
     ) dupe
     WHERE t.id = dupe.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    collapsed := collapsed + n;

    -- Realtime: one row per (venue, day, hour, observed_date), DATED ROWS ONLY.
    -- Undated legacy rows are not provably duplicates of each other and are not
    -- touched. hour_axis is not in the order: a realtime row's hour has always
    -- been the venue wall clock whether or not it says so, so preferring a
    -- stamped row would only be recency by another name.
    DELETE FROM ml_training_data t
     USING (
       SELECT id FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY venue_id, day_of_week, hour, observed_date
                  ORDER BY collected_at   DESC NULLS LAST,
                           besttime_epoch DESC NULLS LAST,
                           id             DESC
                ) AS rn
           FROM ml_training_data
          WHERE venue_id >= lo AND venue_id < lo + batch
            AND collection_mode = 'realtime'
            AND observed_date IS NOT NULL
       ) ranked
       WHERE ranked.rn > 1
     ) dupe
     WHERE t.id = dupe.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    collapsed := collapsed + n;

    -- Calendar stamp. COALESCE on both sides so a row that already carries a
    -- month keeps it — the SET list reads the pre-update tuple. `season` is
    -- derived from the month the row ENDS UP with, not from collected_at
    -- directly, so a row that already had a month can never come out of this
    -- with a season that contradicts it. The four ranges are
    -- scripts/ml/config.js getSeason(), and the test pins all twelve months
    -- against that function rather than against a copy of this CASE. Rows with
    -- no collected_at are skipped rather than guessed. Neither column is
    -- indexed, so these are HOT updates and touch no index.
    -- NULLIF(month, 0): zero is not a month. The column is NULL in the database
    -- and only becomes 0 when prepare_features.py fills the NaN, but nothing
    -- constrains it, and a stored 0 is the same defect wearing a different
    -- value — it must not be mistaken for "already stamped".
    UPDATE ml_training_data
       SET month  = COALESCE(NULLIF(month, 0),
                      EXTRACT(MONTH FROM collected_at AT TIME ZONE 'UTC')::smallint),
           season = COALESCE(NULLIF(season, ''),
                      CASE
                        WHEN COALESCE(NULLIF(month, 0), EXTRACT(MONTH FROM collected_at AT TIME ZONE 'UTC')::smallint) BETWEEN 3 AND 5  THEN 'spring'
                        WHEN COALESCE(NULLIF(month, 0), EXTRACT(MONTH FROM collected_at AT TIME ZONE 'UTC')::smallint) BETWEEN 6 AND 8  THEN 'summer'
                        WHEN COALESCE(NULLIF(month, 0), EXTRACT(MONTH FROM collected_at AT TIME ZONE 'UTC')::smallint) BETWEEN 9 AND 11 THEN 'fall'
                        ELSE 'winter'
                      END)
     WHERE venue_id >= lo AND venue_id < lo + batch
       AND (month IS NULL OR month = 0 OR season IS NULL OR season = '')
       AND collected_at IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    stamped := stamped + n;

    COMMIT;   -- legal: a DO block invoked outside a transaction block may end
              -- transactions. This is what makes a killed deploy resumable.
    lo := lo + batch;
  END LOOP;

  RAISE NOTICE '024: collapsed % duplicate rows; stamped month/season on % rows', collapsed, stamped;
END $$;

-- The protection itself. CONCURRENTLY takes no write lock, so this is safe to
-- apply while an older instance is still serving.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ml_training_data_weekly_slot_uniq
  ON ml_training_data (venue_id, day_of_week, hour)
  WHERE collection_mode = 'weekly' AND hour_axis = 'venue_local';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ml_training_data_realtime_slot_uniq
  ON ml_training_data (venue_id, day_of_week, hour, observed_date)
  WHERE collection_mode = 'realtime' AND observed_date IS NOT NULL;

-- Restore db/migrate.js's cap (STATEMENT_TIMEOUT_MS) for anything that lands
-- after this file.
SET statement_timeout = 300000;
