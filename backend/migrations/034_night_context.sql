-- 034: night_context — the evening a venue owner will ask about, written down
--
-- WHY THIS TABLE EXISTS.
--
-- The advisor's why-layer answers "why was I dead last Friday" by differencing:
-- stating every observable way that night differed from a normal one. Two of
-- its drivers currently evaporate before the question can be asked:
--
--   * Weather (driver D4): services/weatherService.js holds readings in a
--     30-minute in-memory cache that resets on every deploy. Nothing persists.
--     "Was it raining last Friday" is unanswerable from Flock's own data.
--   * Events (driver D3): routes/events.js caches Ticketmaster for one hour in
--     memory, and Ticketmaster's Discovery API drops past events entirely. A
--     night whose listings were not snapshotted in advance is a night whose
--     events are gone from the world, not just from us.
--
-- Events land in the EXISTING ml_events table (migration 006) through the same
-- insert shape scripts/ml/collectEvents.js uses — no new event store. What is
-- new here is the weather half and the run ledger.
--
-- GRANULARITY, per the why-layer design: one row per city per evening hour,
-- 17:00 through 23:00 LOCAL — seven readings a night per city. City means a
-- key of scripts/ml/config.js CITIES (same vocabulary as ml_venues.city and
-- ml_events.city), so the why-query can join all three without a mapping
-- table. Per-venue weather rows would be the same reading copied N times:
-- OpenWeatherMap is fetched on a bucketed city coordinate anyway.
--
-- UNITS ARE IMPERIAL (°F, mph) because the rows come through the same
-- weatherService.getWeather call that collected ml_training_data's weather
-- columns. Comparisons against the frozen corpus stay unit-consistent for free.
--
-- IDEMPOTENCY: (city, night, hour) is UNIQUE and the writer upserts, so a
-- sweep that fires twice inside one hour refreshes the reading instead of
-- duplicating it. A missing row means "we were not watching", never zero —
-- the advisor says "we started watching on <date>" for anything earlier.
--
-- night_context_runs is the cross-instance, deploy-surviving dedupe for the
-- once-per-city-per-day Ticketmaster fetch, claimed with
-- INSERT ... ON CONFLICT DO NOTHING before any paid call — the exact idiom
-- crowd_alert_sends (migration 007) uses for pushes, and for the same reason:
-- an in-memory marker re-spends the budget on every deploy and on every extra
-- instance. `kind` exists so a later snapshot kind (holidays, closures) can
-- ride the same ledger without a new table.

CREATE TABLE IF NOT EXISTS night_context (
  id BIGSERIAL PRIMARY KEY,
  city VARCHAR(100) NOT NULL,
  night DATE NOT NULL,
  hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  temp NUMERIC(5,1),
  feels_like NUMERIC(5,1),
  humidity SMALLINT,
  wind_speed NUMERIC(5,1),
  conditions VARCHAR(100),
  condition_code INTEGER,
  is_raining BOOLEAN,
  observed_at TIMESTAMPTZ NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'openweathermap',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (city, night, hour)
);

-- The why-query's access path: "the evening of <night> in <city>" is a prefix
-- of the unique index above, so no extra index is needed for it. This one
-- serves the reverse question ("which nights do we have?") cheaply.
CREATE INDEX IF NOT EXISTS idx_night_context_night ON night_context(night);

CREATE TABLE IF NOT EXISTS night_context_runs (
  city VARCHAR(100) NOT NULL,
  night DATE NOT NULL,
  kind VARCHAR(16) NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (city, night, kind)
);
