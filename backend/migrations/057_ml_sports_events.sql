-- Game nights for the crowd model (TheSportsDB, key acquired 2026-08-29).
--
-- One row per game involving a tracked team, home or away. Home or away on
-- purpose, and it is the reason this table is not just "home fixtures": the
-- expanded scope in RETRAIN.md records that sports bars pack for road games
-- on TV too, so the flag the model wants is "is this team playing at all
-- tonight", with home-ness and arena distance as separate features layered
-- on top.
--
-- Times are stored as the UTC instant plus the raw local fields the API
-- returns, because the feature builder joins these against venue-local
-- observation hours and the naive-timestamp landmine (see migration 056's
-- header) applies here with extra force: a game that starts 2026-01-04
-- 20:00 Eastern is 2026-01-05 01:00 UTC, and joining on the wrong side of
-- that boundary silently moves every evening game to the wrong night.
--
-- Populated by scripts/ml/collectSportsSchedules.js. Nothing serves from
-- this table yet: the first consumer is the free historical ablation
-- (backfill onto the frozen corpus), per the sequencing in RETRAIN.md.
CREATE TABLE IF NOT EXISTS ml_sports_events (
  id BIGSERIAL PRIMARY KEY,
  sportsdb_event_id VARCHAR(32) NOT NULL UNIQUE,
  league VARCHAR(16) NOT NULL,
  season VARCHAR(16) NOT NULL,
  team_key VARCHAR(32) NOT NULL,
  is_home BOOLEAN NOT NULL,
  opponent VARCHAR(128),
  event_utc TIMESTAMPTZ,
  event_local_date DATE,
  event_local_time TIME,
  venue_name VARCHAR(255),
  venue_lat DOUBLE PRECISION,
  venue_lon DOUBLE PRECISION,
  raw_status VARCHAR(64),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The backfill's join shape: which tracked teams play on a given local date.
CREATE INDEX IF NOT EXISTS idx_ml_sports_events_date ON ml_sports_events (event_local_date);
CREATE INDEX IF NOT EXISTS idx_ml_sports_events_team_date ON ml_sports_events (team_key, event_local_date);
