-- 060: ml_venues gets a unique key on the identity BestTime actually issues,
-- and the column that stored "we never asked Google" as "nobody has ever been
-- here" stops defaulting to zero.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG
--
-- `ml_venues` is UNIQUE on google_place_id and on nothing else.
-- scripts/ml/discoverBestTime.js gets its venues from BestTime's search, which
-- answers with a BestTime venue id and no Google place id, so the script built
-- one — `bt_${venue.venue_id}` — and upserted ON CONFLICT (google_place_id).
-- A venue already stored under its REAL Google place id therefore conflicted
-- with nothing: it got a SECOND row under the pseudo id, carrying the same
-- besttime_venue_id.
--
-- Measured on the 2026-09-03 production dump: 933 BestTime venue ids map to two
-- or more ml_venues rows, 1,871 rows in total. 909 of those groups contain a
-- `bt_` row. 111 groups are ACTIVE philly/lehigh venues, which is exactly the
-- hourly realtime cron's scope, so every sweep pays two BestTime credits for
-- one physical venue and writes two rows for one observation.
--
-- Willow Grove Park is ml_venues 33840 (`bt_ven_556d6c...`, category 'park',
-- rating NULL, review_count 0) and ml_venues 49000
-- (`ChIJfxx3xTuwxokRg2ccehxvlmU`, category 'mall', rating 4.4, review_count
-- 9,880). Both active, both philly, both carrying the same besttime_venue_id,
-- and both handed 168 identical weekly rows by the same 2026-09-01 run.
-- Migration 024's partial unique indexes are keyed on venue_id, so they cannot
-- see any of this: two venue ids are two venues as far as they are concerned.
-- train/export_training_data.js joins ml_venues, so both copies are exported,
-- and every average keyed on the venue — the per-venue means, the category
-- baselines — counts the same building twice.
--
-- ---------------------------------------------------------------------------
-- THE INDEX, AND WHY IT IS PARTIAL
--
--   CREATE UNIQUE INDEX ml_venues_besttime_venue_id_uniq
--     ON ml_venues (besttime_venue_id) WHERE besttime_venue_id IS NOT NULL
--
-- A plain unique index would behave identically, because Postgres already
-- treats NULLs as distinct and 12,634 of the 34,785 rows have no BestTime
-- mapping at all. The predicate is there to say that out loud — "a venue we
-- have never resolved is not a venue named NULL" — and to keep the index to the
-- 22,151 rows the constraint is actually about. It is also what
-- discoverBestTime.js repeats verbatim in its ON CONFLICT clause, which is how
-- Postgres infers a partial index as an arbiter.
--
-- ---------------------------------------------------------------------------
-- WHY THE BUILD IS CONDITIONAL, WHICH IS THE UNCOMFORTABLE PART OF THIS FILE
--
-- Production still holds those 933 duplicate groups, so this index cannot be
-- built there today. db/migrate.js runs the whole chain BEFORE
-- server.listen(), and a failed migration exits 1 — so a plain CREATE UNIQUE
-- INDEX here would not "surface the problem", it would take the API down until
-- somebody noticed. That is not a trade this file gets to make.
--
-- Collapsing the groups is also not something a boot-time migration should do
-- behind an operator's back. It means choosing which of two venue rows to
-- retire, moving another venue's training rows onto the survivor, resolving the
-- unique-slot collisions that move causes under migration 024's indexes, and,
-- for the 24 groups where two DIFFERENT Google places resolved to one BestTime
-- venue, deciding which Google place keeps the mapping. Each of those is a
-- judgement, and a judgement belongs in a script you can run in report mode
-- first: scripts/ml/repairBestTimeDiscoveredVenues.js.
--
-- So this file builds the index when it can and states the remedy when it
-- cannot. On a fresh database, on dev, and on the test harness there are no
-- duplicates and the index appears here. On production it appears when the
-- repair script finishes, because that script ends by running the SAME
-- statement — same name, same column, same predicate — against the corpus it
-- just cleaned. Nothing retries this file: db/migrate.js records it by name and
-- moves on, which is precisely why the index cannot be left to a later boot.
--
-- There is no `-- @requires` line for it, because @requires understands tables
-- and columns and not indexes, and a post-condition that fails on every boot of
-- an unrepaired production database would re-apply this file forever to no
-- effect.
--
-- ---------------------------------------------------------------------------
-- review_count: DEFAULT 0 IS AN ANSWER TO A QUESTION NOBODY ASKED
--
-- 006 declared `review_count INTEGER DEFAULT 0`. discoverBestTime.js then wrote
-- a literal 0 as well, because BestTime does not report review counts. Both say
-- the same false thing: "nobody has ever been here" is the far end of the
-- range, not the middle, and it is not what "we never looked" means.
--
-- It matters because review_count and log_review_count are shipped model
-- features. train/prepare_features.py fills a missing rating with the corpus
-- MEDIAN and stores that median for the holdout to reuse; review_count was
-- filled with 0 instead. A venue this script discovered was therefore described
-- to the model as an average-rated venue with zero reviews, and that pairing is
-- a strong learnable signature for "this row came from the discovery path"
-- rather than anything about the venue — the same leakage shape as the
-- single-instant weather that repairWeeklyWeather.js clears off the weekly
-- rows. prepare_features.py now imputes review_count the way it imputes rating.
--
-- Two changes here. The DEFAULT is dropped, so an unknown stays NULL. And the
-- 1,741 rows this script wrote a literal 0 onto are set to NULL — scoped by
-- `google_place_id LIKE 'bt\_%'`, which is the provable statement that
-- discoverBestTime.js created the row and never consulted Google. The 186 rows
-- with review_count 0 that came from Google are NOT touched: Google answering
-- "0 reviews" for a place nobody has reviewed is a measurement, and this
-- migration does not get to erase measurements it finds inconvenient. The
-- training rows already carrying the fabricated zero are the repair script's
-- phase 2, batched, because there are hundreds of thousands of them.
--
-- No reader assumes the column is non-null. services/crowdAlerts.js reads
-- `Number(row.review_count) || 0`, services/advisorFacts.js reads
-- `m.review_count != null ? Number(...) : 0`, the exporters write it through to
-- CSV where an empty cell becomes NaN, and both collectors copy it into
-- ml_training_data.review_count, which has never had a default.
--
-- ---------------------------------------------------------------------------
-- NOT @noTransaction, and that is a deliberate difference from 023 and 024.
-- Nothing here needs CREATE INDEX CONCURRENTLY: ml_venues is 34,785 rows,
-- three orders of magnitude smaller than ml_training_data, and the index build
-- takes a SHARE lock for a few milliseconds against writers that are hand-run
-- collectors. One transaction means a killed deploy leaves the column default,
-- the backfill and the index either all present or all absent.
-- ---------------------------------------------------------------------------

ALTER TABLE ml_venues ALTER COLUMN review_count DROP DEFAULT;

UPDATE ml_venues
   SET review_count = NULL,
       updated_at = NOW()
 WHERE google_place_id LIKE 'bt\_%' ESCAPE '\'
   AND review_count = 0
   AND rating IS NULL;

DO $$
DECLARE
  dup_groups INTEGER;
  dup_rows INTEGER;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(n), 0)
    INTO dup_groups, dup_rows
    FROM (
      SELECT COUNT(*) AS n
        FROM ml_venues
       WHERE besttime_venue_id IS NOT NULL
       GROUP BY besttime_venue_id
      HAVING COUNT(*) > 1
    ) g;

  IF dup_groups > 0 THEN
    RAISE NOTICE '060: ml_venues_besttime_venue_id_uniq NOT built. % BestTime venue ids are held by % ml_venues rows between them. Run scripts/ml/repairBestTimeDiscoveredVenues.js (report only), then --commit; it merges the groups and builds this index itself.',
      dup_groups, dup_rows;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS ml_venues_besttime_venue_id_uniq
      ON ml_venues (besttime_venue_id)
      WHERE besttime_venue_id IS NOT NULL;
    RAISE NOTICE '060: ml_venues_besttime_venue_id_uniq is in place.';
  END IF;
END $$;
