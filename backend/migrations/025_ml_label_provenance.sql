-- 025: the ML corpus gets a column that says what its realtime labels ARE, in
-- the migration chain rather than in a hand-run script — and the 457,402 rows
-- that can never answer the question are left alone, on purpose, forever.
--
-- ---------------------------------------------------------------------------
-- WHAT A REALTIME ROW ACTUALLY HOLDS
--
-- scripts/ml/collectRealtime.js calls BestTime's /forecasts/live endpoint once
-- per venue. That endpoint answers with TWO numbers and one flag:
--
--   venue_forecasted_busyness      the vendor's PREDICTION for this moment.
--                                  Always present. A model output, not traffic.
--   venue_live_busyness            the live reading — but only when
--   venue_live_busyness_available  this is true. When it is false the field
--                                  still carries a number, and that number is
--                                  the forecast again.
--
-- The collector stores whichever it got in ONE column, `busyness_pct`, and
-- `collection_mode = 'realtime'` records only WHEN the row was taken, never
-- whether the number is an observation. So the corpus mixes observed foot
-- traffic with a vendor's forecast of foot traffic under a single name, and
-- train/prepare_features.py's 0.3 sample weight for vendor forecasts has never
-- applied to one row, because it keys on a provenance that was never written.
--
-- ---------------------------------------------------------------------------
-- THE LEGACY ROWS ARE NOT RECOVERABLE, AND THIS FILE DOES NOT PRETEND THEY ARE
--
-- Measured against production on 2026-08-15, read-only, before this file was
-- written:
--
--   collection_mode  rows       label_source
--   realtime           457,402  NULL on every row
--   weekly           3,454,955  NULL on every row (weekly is named by mode)
--
-- The realtime rows also carry observed_date NULL, hour_axis NULL and
-- besttime_epoch NULL on all 457,402. Collection ran 2026-03-10 to 2026-05-18
-- and stopped; every one of those columns was added after it stopped. There is
-- no per-row marker of any kind, and no dated cutoff can help because there is
-- no date on which the collector's behaviour changed — it wrote the same
-- ambiguous number for the whole window.
--
-- Two candidate discriminators were tested and both are dead:
--
--   1. VALUE GRID. If live readings and forecasts were quantised differently,
--      a value off one grid would name itself. They are not: all 457,402
--      realtime values AND all 3,454,955 weekly values are multiples of 5, on
--      the same 21-point grid {0,5,...,100}, in every month of collection.
--
--   2. ECHO OF THE WEEKLY FORECAST. A forecast-sourced realtime row should
--      equal the venue's weekly forecast for the same venue-local slot. It
--      matches 25,158 / 446,039 rows = 5.64%. The SAME test aimed at a
--      deliberately WRONG slot — the null control — matches 5.02% (dow+3),
--      5.07% (dow+4), 6.31% (hour+1) and 6.89% (hour+2). Two of the four wrong
--      answers score HIGHER than the right one. The equality is chance on a
--      21-point grid and carries no information about provenance.
--
-- A backfill would therefore have to guess, and the thing it would be guessing
-- is the one measurement that decides whether the crowd model has been trained
-- to predict a prediction (WITHIN-CITY-EVAL.md §6). A wrong answer there is
-- worse than a missing one, because a wrong one gets believed. So:
--
--   NO ROW'S label_source IS WRITTEN BY THIS FILE. The 457,402 realtime rows
--   stay NULL, train/export_training_data.js keeps exporting them as
--   'unknown', and 'unknown' keeps meaning what it says.
--
-- Operator's counts query (read-only, before and after — the numbers must be
-- IDENTICAL, that is the point):
--
--   SELECT collection_mode,
--          COUNT(*)                                            AS rows,
--          COUNT(*) FILTER (WHERE label_source IS NULL)        AS unknown,
--          COUNT(*) FILTER (WHERE label_source = 'live')       AS live,
--          COUNT(*) FILTER (WHERE label_source = 'forecast')   AS forecast,
--          COUNT(vendor_forecast_pct)                          AS with_vendor_fc
--   FROM ml_training_data GROUP BY 1 ORDER BY 1;
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FILE DOES DO
--
-- 1. label_source enters the migration chain. It has existed in production only
--    because collectRealtime.js runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
--    on first use — a column created as a side effect of a hand-run script.
--    That is not an aesthetic complaint. train/export_training_data.js probes
--    for the column and, when it is absent, selects `NULL AS label_source`,
--    which exports EVERY realtime row as 'unknown' with no error and no log
--    line. Any database the collector has not run against — a restored backup,
--    a staging clone, a fresh instance — silently reproduces the exact defect
--    this migration is written about. A column the export depends on must not
--    depend on a script having been run.
--
-- 2. vendor_forecast_pct is added. BestTime hands us the forecast in the SAME
--    response as the live reading and the collector threw it away. Stored, it
--    makes a 'live' label falsifiable instead of an unbacked assertion (a
--    'forecast' row has vendor_forecast_pct = busyness_pct by construction; a
--    'live' row that always agreed with its own counterfactual would expose a
--    repeat of this bug immediately), and it is the only way to ever measure
--    how far the labels sit from the vendor's own prediction. It costs no extra
--    API call. It is NULL on all 3,912,357 existing rows and stays NULL.
--
-- 3. A CHECK pins the domain. `unknown` is deliberately NOT an accepted value:
--    it is what the exporter SAYS about a row that never declared itself, never
--    something a collector may write. Note the direction of the risk this
--    guards — a typo'd or truncated label does not raise anywhere in the
--    pipeline, it just becomes 'unknown' in labelProvenance() and silently
--    rejoins the untrained-weight pool. CLAUDE.md records three separate
--    incidents of a value set being widened in code while the CHECK behind it
--    was not; this is the same lesson applied before the fact.
--
-- ---------------------------------------------------------------------------
-- COST: CATALOG ONLY. NO TABLE SCAN, NO REWRITE.
--
-- 023 closed the port for 9 minutes and 024 for ~2. This file touches no row.
--
--   * ADD COLUMN ... (nullable, no DEFAULT) is a catalog update in every
--     supported Postgres. It does not rewrite the table and does not read it.
--   * ADD CONSTRAINT ... NOT VALID takes ACCESS EXCLUSIVE for the catalog write
--     and then returns; it does NOT scan the 3.9M existing rows. It is enforced
--     on every INSERT and UPDATE from the moment it lands, which is the whole
--     benefit. lock_timeout (db/migrate.js, 10s) still guards the lock wait.
--
-- MEASURED on the embedded-postgres harness, at two corpus sizes, because one
-- number cannot show independence and two can. __tests__/mlLabelProvenance.test.js
-- drops the columns and applies the whole file again at each size and prints:
--
--   5 rows          3 ms
--   1,000,005 rows 17 ms
--
-- A 200,000x change in row count moves it by 14 ms, which is catalog latency,
-- not a scan — a seq scan of a million rows could not hide in it. Production
-- carries 3,912,357 rows, and 024's own worst-case Railway factor of 14.2x
-- applied to 17 ms is a quarter of a second. The test fails if the large-corpus
-- time ever exceeds 4x the empty-table time, so this claim cannot silently rot.
--
-- VALIDATE CONSTRAINT is deliberately NOT run. Validating would seq-scan ~1 GB
-- to learn what the census above already proves (every existing value is NULL,
-- so no row can violate it), and would buy only the planner's right to use the
-- constraint for exclusion, which no query in this repo does. NOT VALID already
-- enforces every future write. If someone later wants the flag set, the
-- statement is one line and takes SHARE UPDATE EXCLUSIVE, so it can be run by
-- hand against a live database without closing the port:
--
--   ALTER TABLE ml_training_data VALIDATE CONSTRAINT ml_training_data_label_provenance_valid;
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENT BY CONSTRUCTION. Both ADD COLUMNs are IF NOT EXISTS. The
-- constraint is added only when pg_constraint does not already carry the name,
-- so a second run adds nothing and drops nothing (dropping and re-adding would
-- discard a VALIDATE someone had since run by hand). No statement in this file
-- writes a row, so a second run cannot change one — pinned by xmin in
-- __tests__/mlLabelProvenance.test.js, not by comparing values.
-- ---------------------------------------------------------------------------

ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS label_source VARCHAR(10);

ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS vendor_forecast_pct SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ml_training_data_label_provenance_valid'
       AND conrelid = 'ml_training_data'::regclass
  ) THEN
    ALTER TABLE ml_training_data
      ADD CONSTRAINT ml_training_data_label_provenance_valid
      CHECK (
        (label_source IS NULL OR label_source IN ('live', 'forecast'))
        AND (vendor_forecast_pct IS NULL OR vendor_forecast_pct BETWEEN 0 AND 100)
      ) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN ml_training_data.label_source IS
  'realtime rows only: ''live'' = BestTime reported live foot traffic for that moment, '
  '''forecast'' = the vendor''s own prediction was stored instead. NULL means the row '
  'predates the column (all 457,402 rows collected 2026-03-10..2026-05-18) and the '
  'distinction is NOT recoverable — see migration 025. Weekly rows are named by '
  'collection_mode and leave this NULL.';

COMMENT ON COLUMN ml_training_data.vendor_forecast_pct IS
  'realtime rows only: BestTime''s forecast for the same moment, recorded whatever '
  'label_source says. Equals busyness_pct by construction when label_source = ''forecast''; '
  'is the counterfactual when it is ''live''. NULL on every row collected before 2026-08-15.';
