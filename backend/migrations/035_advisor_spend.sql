-- The advisor phrasing layer's GLOBAL daily token counter (services/
-- advisorPhrasing.js). One row per UTC day, incremented with a conditional
-- upsert before every Gemini call the advisor makes.
--
-- Postgres rather than the in-memory idiom, deliberately: this is the one
-- advisor ceiling denominated in money, and services/birdieUsage.js's own
-- header calls its in-process global figure "a brake, not a cap" because a
-- deploy loop hands out fresh allowances. A paid surface starts with the fix
-- that file recommends (its suggested shape is exactly this table).
--
-- The per-venue meters stay in memory: they are product limits, not money,
-- and losing one to a deploy costs a venue a few extra phrased answers, not
-- dollars.

CREATE TABLE IF NOT EXISTS advisor_spend (
  day    date   PRIMARY KEY,
  tokens bigint NOT NULL DEFAULT 0
);
