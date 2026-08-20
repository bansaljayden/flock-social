-- The advisor phrasing layer's PER-VENUE daily meters, moved out of process
-- memory (services/advisorPhrasing.js).
--
-- 035 put the GLOBAL token ceiling in Postgres and left the per-venue meters in
-- a Map, on the reasoning that they are product limits rather than money and
-- that losing one to a deploy costs a venue a few extra phrased answers. That
-- reasoning holds for a deploy. It does not hold for REPLICAS: Railway can run
-- more than one container, express-rate-limit and every other in-process meter
-- in this repo is per-container, and a Map-backed cap of fifty answers a day
-- becomes fifty PER CONTAINER. The per-venue token cap is what decides how few
-- venues it takes to drain the global ceiling and leave every other venue on
-- template answers, so multiplying it by the replica count is not a fairness
-- rounding error, it is the fairness control itself.
--
-- Same shape as advisor_spend: one row per venue per UTC day, incremented by a
-- conditional upsert that returns nothing when the increment would breach a
-- cap. No row back means refused, and a refused charge is not an error -- the
-- deterministic template twin answers, carrying the same numbers.
--
-- answers and tokens are charged together, all or nothing, so a venue cannot
-- buy the answer count without paying the tokens.

CREATE TABLE IF NOT EXISTS advisor_venue_spend (
  day           date   NOT NULL,
  venue_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers       integer NOT NULL DEFAULT 0,
  tokens        bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, venue_user_id)
);

-- The only sweep this table needs: yesterday's rows are never read again.
-- Kept as an index rather than a job so a retention pass stays cheap.
CREATE INDEX IF NOT EXISTS idx_advisor_venue_spend_day
  ON advisor_venue_spend (day);
