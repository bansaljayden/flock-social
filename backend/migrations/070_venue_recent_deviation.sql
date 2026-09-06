-- 070: the per-venue trailing deviation offset, precomputed.
--
-- WHAT IT HOLDS. For one venue, the median of (observed busyness - that venue's
-- own popular-times curve) across its most recent live readings. Not a
-- prediction and not a baseline: a running answer to "lately, does this place
-- run busier or quieter than its own typical pattern says?".
--
-- WHY IT EXISTS. MODEL-METRICS.md section 3 records that the model generalises
-- well across cities and is weak at exactly one thing: how a SPECIFIC venue
-- deviates from its OWN pattern tonight. That is not a generalisable rule, it
-- is a fact about one place, and it is learned only by watching that place.
-- Measured on the 8,895 provenance-verified live September rows that production
-- actually serves, adding this offset to the curve moved MAE 25.90 to 24.53,
-- within-10 32.8% to 35.7% and band-exact 32.1% to 38.0%, improving band-exact
-- on 5 of 5 days and in both cities independently.
--
-- WHY A TABLE AND NOT A QUERY. services/mlPredictor.js already does one indexed
-- read of ml_venue_baselines per prediction. This is the same shape keyed on
-- google_place_id alone, so serving stays one extra indexed read on one key
-- rather than an aggregate over ml_training_data on the request path.
--
-- WHY IT IS NOT THE VENUE INTERCEPT THAT WAS REFUTED. A static per-venue
-- intercept measured HARM at depth >= 50 readings, because it averages across
-- the drift the corpus contains (the served slice's mean busyness moves roughly
-- 12 points over six weeks). This is a TRAILING window: it tracks the level
-- instead of averaging it, and its measured gain holds at every depth band with
-- no reversal. The distinction is why `window_start` and `updated_at` are
-- columns rather than conveniences: a consumer must be able to tell a fresh
-- offset from a stale one and refuse the stale one.
CREATE TABLE IF NOT EXISTS ml_venue_recent_deviation (
  google_place_id  VARCHAR(255) PRIMARY KEY,
  -- Median, not mean. One anomalous night at a venue with four readings would
  -- drag a mean several points and the median not at all, and the whole point
  -- of the offset is to describe the venue's usual level rather than its last
  -- surprise.
  offset_pct       REAL NOT NULL,
  -- The floor is enforced by the consumer, not here, so the table can record an
  -- n of 1 for observability while the serving path declines to use it.
  n_readings       INTEGER NOT NULL,
  -- The oldest reading inside the window, so a reader can see the span the
  -- median was taken over rather than assuming it.
  window_start     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The serving read is by primary key, which is already indexed. This index is
-- for the REFRESH: the builder sweeps by staleness, and without it that sweep
-- is a sequential scan of the whole table every run.
CREATE INDEX IF NOT EXISTS idx_venue_recent_deviation_updated
  ON ml_venue_recent_deviation (updated_at);
