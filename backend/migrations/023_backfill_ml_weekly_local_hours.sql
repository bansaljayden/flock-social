-- @noTransaction
-- 023: the ML corpus's weekly rows are moved onto the venue's wall clock, and
-- the column is made to say which clock it is on.
--
-- WHAT WENT WRONG. `ml_training_data.hour` is read everywhere as a venue-local
-- hour: services/mlPredictor.js getBaseline looks ml_venue_baselines up by the
-- venue's wall clock hour, and that table is built from this column
-- (scripts/ml/buildBaselines.js). But scripts/ml/collectWeekly.js iterated
-- BestTime's `day_raw` array and wrote the ARRAY INDEX:
--
--     for (let hour = 0; hour < day.hours.length && hour < 24; hour++) {
--       const busyness = day.hours[hour];        // day.hours = day.day_raw
--       ... venue.id, jsDayOfWeek, hour, ...
--
-- BestTime's day runs 06:00 to 05:59, so day_raw[0] is the venue's 6 AM and
-- day_raw[18] is the venue's MIDNIGHT:
--
--     stored_index = (venue_local_hour - 6) mod 24
--
-- The shipped model is a delta model (score = baseline + a bounded nudge), so
-- the baseline IS the answer: a 6 PM request read stored slot 18 and was
-- answered with the venue's overnight number. That is the reported symptom — a
-- well-known dinner restaurant reading ~20% at 6 PM. The proof is arithmetic on
-- the shipped artifact rather than on the vendor's documentation: read
-- literally, model_metadata.json's category_baselines have restaurants peaking
-- at lunch every day of the week, bars mid-afternoon, nightclubs at 5 PM and
-- gyms at noon; add six hours and all 91 (category, day) peaks land in local
-- noon to 9 PM. __tests__/dinnerPeakAccuracy.test.js PART 3 pins that.
--
-- THE TRANSFORM, both halves:
--
--     hour        := (hour + 6) % 24
--     day_of_week := CASE WHEN hour >= 18 THEN (day_of_week + 1) % 7 ELSE day_of_week END
--
-- The second half is the one that is easy to miss. A BestTime day labelled D
-- covers local D 06:00 through D+1 05:59, so indices 18..23 are the NEXT
-- calendar day's small hours: Saturday index 20 is Sunday 02:00, which also
-- means the roll crosses the week boundary (6 -> 0) and not merely the day
-- boundary. Filing those six slots under the labelled day would leave every
-- venue's overnight block on the wrong weekday.
--
-- BOTH assignments read the OLD row. Postgres evaluates every expression in an
-- UPDATE's SET list against the pre-update tuple, so the CASE below tests the
-- STORED index (>= 18), not the already-shifted hour. Do not "simplify" it into
-- two statements; the second would test the new value and roll the wrong rows.
--
-- WHY THE PREDICATE IS A DECLARED AXIS AND NOT A VALUE TEST. 021 could ask
-- whether a row disagreed with its own recomputation, because there the correct
-- value was a pure function of data the migration did not write. Here it is
-- not: adding six hours is a bijection on 0..23 with NO fixed point, so no
-- (day, hour) pair can tell you whether the shift has been applied. Something
-- has to record the axis, and the honest thing to record is the axis itself —
-- not "did migration 023 run". Hence the new column:
--
--     hour_axis = 'venue_local'    hour is the venue's wall clock hour
--     hour_axis = 'besttime_index' hour is a BestTime day_raw array index
--     hour_axis IS NULL            written before the column existed
--
-- NULL is not ambiguous once collection_mode is taken into account, and that is
-- exactly why the predicate names both:
--   * weekly + NULL  -> written by collectWeekly.js/discoverBestTime.js, which
--                       wrote array indices and nothing else ever wrote a
--                       weekly row. This is the disease.
--   * realtime + NULL -> written by collectRealtime.js, which has ALWAYS
--                       written config.getLocalTime(tz).hour — a true wall
--                       clock hour. Correcting one of these would CORRUPT it,
--                       so realtime rows are not merely skipped by accident:
--                       collection_mode is in the WHERE clause for this reason,
--                       and __tests__/mlClockAxisBackfill.test.js proves by
--                       xmin snapshot that no realtime row is written at all.
--
-- IDEMPOTENT BY CONSTRUCTION. After the loop no row satisfies
-- `collection_mode = 'weekly' AND hour_axis IN (NULL, 'besttime_index')`, so a
-- second run's UPDATE matches nothing and writes nothing — not "writes the same
-- values again". The baseline rebuild at the end is a pure function of the
-- corrected corpus and suppresses no-op rewrites with an
-- `IS DISTINCT FROM` clause on the conflict target, so it too writes nothing on
-- a second run. The whole file is a fixed point, pinned by xmin in the test.
--
-- The same property makes the statement a permanent repair tool rather than a
-- one-shot: if an unfixed collector (see WHAT STAYS BROKEN) ever inserts more
-- index-axis rows, re-running this UPDATE is still exactly right.
--
-- WHY @noTransaction, WHICH 021 DELIBERATELY DID NOT USE. ml_training_data was
-- ~4.0M rows at the last export, ~91% of them weekly, and this UPDATE rewrites
-- every one of those tuples plus four index entries each. Measured on a local
-- NVMe instance with the same four indexes: ~11s per million rows, so ~40s for
-- the corpus — and Railway's Postgres writes to network storage, several times
-- slower. db/migrate.js caps a single statement at 300s (STATEMENT_TIMEOUT_MS)
-- and server.js awaits migrate() BEFORE listen(), so a one-statement version is
-- a bet: win and it costs a minute of boot, lose and the transaction rolls back
-- ALL of it, the boot fails, the platform restarts, and the next attempt starts
-- from zero — a loop that never makes progress and takes the deploy with it.
--
-- The batched form was measured at the same total cost (10.4s vs 10.2s per
-- million) and has no such failure mode: the work commits per batch, and a
-- batch is safe to interrupt precisely BECAUSE of the marker — each row's shift
-- and its axis stamp are written by the same UPDATE, so a row is either fully
-- converted or untouched, never half. A killed deploy leaves committed progress
-- and the next boot resumes where it stopped. Same price, no bet.
-- statement_timeout is lifted for the loop only (bounded work; lock_timeout
-- still guards the DDL) and restored afterwards.
--
-- WHAT STAYS UNTOUCHED, deliberately:
--   * every collection_mode = 'realtime' row. Their hour is already the venue
--     wall clock. They are left NULL-axis rather than stamped 'venue_local',
--     because stamping 4M rows to record something their collection_mode
--     already implies would be a second full table rewrite for no information —
--     and it would destroy the xmin evidence that this migration never touched
--     them. New realtime rows declare the axis at insert time.
--   * ml_training_data.baseline_busyness on those realtime rows, which
--     collectRealtime stamped by reading weekly rows at the local hour and is
--     therefore off by the same six hours. It is NOT used to train anything:
--     train/export_training_data.js recomputes the baseline leave-one-out at
--     export time from ml_training_data itself (round 13, to kill a label
--     leak), and mlPredictor reads ml_venue_baselines, not this column. It is
--     stale operational metadata on rows whose immutability is load-bearing
--     evidence here; the cost of correcting it is higher than its value.
--   * ml_venue_baselines rows with source <> 'collected'. mlPredictor's
--     storeGoogleBaselines writes source='google' from Google popular_times,
--     which is indexed from midnight and was never on this axis.
--
-- Operator's counts-by-category query (read-only; run before or after):
--
--   SELECT CASE
--            WHEN collection_mode <> 'weekly' THEN 'untouched: realtime (already venue-local)'
--            WHEN hour_axis = 'venue_local'   THEN 'untouched: weekly already on the venue clock'
--            ELSE 'corrected by 023: weekly BestTime index -> venue-local'
--          END AS category, COUNT(*)
--   FROM ml_training_data GROUP BY 1 ORDER BY 1;
--
-- After this file, the two CHECK constraints below make an undeclared weekly
-- row impossible, so that query can never again need a fourth category.
--
-- WHAT STAYS BROKEN, named so it is not discovered the hard way:
-- scripts/ml/discoverBestTime.js insertForecastData() still writes `hour` from
-- the same day_raw index and does not set hour_axis. It is not in this change's
-- file scope. It now fails LOUDLY on the CHECK constraint instead of silently
-- poisoning the corpus, which is the intended outcome; the fix is the same two
-- lines collectWeekly.js got. See scripts/ml/RETRAIN.md.

ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS hour_axis VARCHAR(16);

-- The loop is bounded work (~40s at the corpus's measured rate) but the whole
-- DO block is ONE statement to the server, and the timer armed when it started
-- cannot be reset from inside it — so on slower storage the 300s cap would kill
-- the loop mid-way. Lifted only for it, restored at the end of the file.
-- (db/migrate.js runs the chain on one dedicated connection and destroys it
-- afterwards, so this cannot leak into the request pool either way.)
SET statement_timeout = 0;

DO $$
DECLARE
  batch   CONSTANT BIGINT := 100000;   -- ids per batch, not rows
  lo      BIGINT;
  hi      BIGINT;
  n       BIGINT;
  moved   BIGINT := 0;
BEGIN
  SELECT MIN(id), MAX(id) INTO lo, hi FROM ml_training_data;

  WHILE lo IS NOT NULL AND lo <= hi LOOP
    UPDATE ml_training_data
       SET hour        = (hour + 6) % 24,
           -- reads the OLD hour: 18..23 are the next calendar day's 00:00..05:59
           day_of_week = CASE WHEN hour >= 18 THEN (day_of_week + 1) % 7 ELSE day_of_week END,
           hour_axis   = 'venue_local'
     WHERE id >= lo AND id < lo + batch
       AND collection_mode = 'weekly'
       AND (hour_axis IS NULL OR hour_axis = 'besttime_index');

    GET DIAGNOSTICS n = ROW_COUNT;
    moved := moved + n;
    COMMIT;                            -- legal: a DO block invoked outside a
                                       -- transaction block may end transactions
    lo := lo + batch;
  END LOOP;

  RAISE NOTICE '023: moved % weekly rows onto the venue-local hour axis', moved;
END $$;

-- Vocabulary. Without this, a typo ('local', 'venue-local') reads as "not
-- venue_local" everywhere and silently drops rows out of every baseline.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ml_training_data_hour_axis_check'
      AND conrelid = 'ml_training_data'::regclass
  ) THEN
    ALTER TABLE ml_training_data
      ADD CONSTRAINT ml_training_data_hour_axis_check
      CHECK (hour_axis IS NULL OR hour_axis IN ('venue_local', 'besttime_index')) NOT VALID;
  END IF;
END $$;

ALTER TABLE ml_training_data VALIDATE CONSTRAINT ml_training_data_hour_axis_check;

-- The guard that ends this class of bug: a weekly row must state its clock.
-- Realtime rows stay exempt so the ~360k legacy realtime rows need no rewrite.
-- ADD ... NOT VALID takes ACCESS EXCLUSIVE for microseconds; the separate
-- VALIDATE scans under SHARE UPDATE EXCLUSIVE and lets reads and writes
-- continue (the split is the house pattern, see migration 004).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ml_training_data_weekly_axis_declared'
      AND conrelid = 'ml_training_data'::regclass
  ) THEN
    ALTER TABLE ml_training_data
      ADD CONSTRAINT ml_training_data_weekly_axis_declared
      CHECK (collection_mode <> 'weekly' OR hour_axis IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE ml_training_data VALIDATE CONSTRAINT ml_training_data_weekly_axis_declared;

-- ---------------------------------------------------------------------------
-- Derived-and-stored data: ml_venue_baselines. It is a copy of the column this
-- file just permuted, and services/mlPredictor.js serves it at request time, so
-- leaving it behind would keep production on the old axis with a corrected
-- corpus underneath — the two-clock state, one table further out.
--
-- These two statements are the same ones scripts/ml/buildBaselines.js runs
-- (DELETE_STALE_SQL / UPSERT_SQL there). Kept literally in sync, and
-- __tests__/mlClockAxisBackfill.test.js proves it by running buildBaselines
-- after this migration and asserting it changes nothing.
-- ---------------------------------------------------------------------------

DELETE FROM ml_venue_baselines b
WHERE b.source = 'collected'
  AND NOT EXISTS (
    SELECT 1
    FROM ml_training_data t
    JOIN ml_venues v ON t.venue_id = v.id
    WHERE v.google_place_id = b.google_place_id
      AND t.day_of_week = b.day_of_week
      AND t.hour = b.hour
      AND t.collection_mode = 'weekly'
      AND t.hour_axis = 'venue_local'
      AND t.busyness_pct IS NOT NULL
  );

INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source, updated_at)
SELECT
  v.google_place_id,
  t.day_of_week,
  t.hour,
  ROUND(AVG(t.busyness_pct))::smallint,
  'collected',
  NOW()
FROM ml_training_data t
JOIN ml_venues v ON t.venue_id = v.id
WHERE t.collection_mode = 'weekly'
  AND t.hour_axis = 'venue_local'
  AND t.busyness_pct IS NOT NULL
GROUP BY v.google_place_id, t.day_of_week, t.hour
ON CONFLICT (google_place_id, day_of_week, hour)
DO UPDATE SET
  baseline = EXCLUDED.baseline,
  updated_at = NOW()
WHERE ml_venue_baselines.baseline IS DISTINCT FROM EXCLUDED.baseline;

-- Restore db/migrate.js's cap (STATEMENT_TIMEOUT_MS) for any migration that
-- lands after this one. 023 is currently last, so this is defensive.
SET statement_timeout = 300000;
