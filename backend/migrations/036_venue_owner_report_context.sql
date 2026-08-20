-- 036: venue_owner_report_context — what the world looked like when the owner
-- moved the slider.
--
-- WHY THIS TABLE EXISTS. venue_owner_reports (031) is the only live 0-100
-- label source the plan has, and a label without its context is a weak label:
-- at training time the exporter (scripts/ml/train/ownerLabelExport.js) had to
-- ship every weather and event column as NULL with the comment "nothing was
-- recorded at the moment the reading describes and neither is recoverable."
-- This table makes it recoverable, by recording it the only time it is cheap
-- and true: at the moment the report is inserted. Weather is a cache read the
-- serve path was going to make anyway; the last served prediction is already
-- a row in served_predictions (032); the venue's clock and category are one
-- ml_venues read.
--
-- SIDE TABLE, NOT COLUMNS ON THE REPORT — for three reasons:
--   * The report row is the OWNER's assertion (attributable, retractable,
--     strike-stamped); this row is the SERVER's observation. Different author,
--     different lifecycle, different trust — mixing them would put
--     fire-and-forget NULL-able telemetry inside a row whose columns are all
--     CHECK-constrained facts the serve path relies on.
--   * The capture is asynchronous (services/ownerReportContext.js runs after
--     the POST has already answered). An UPDATE on venue_owner_reports would
--     race the serve path's own divergence stamp on the same row; an INSERT
--     into a table nothing serves from races nothing.
--   * Idempotency falls out of the key: report_id is the PRIMARY KEY, so the
--     write is ON CONFLICT DO NOTHING and a retried capture cannot duplicate.
--
-- EVERY COLUMN IS NULLABLE except the key and captured_at, deliberately: the
-- capture must never block or fail the report POST, so a weather outage, a
-- venue outside the ml_venues corpus, or a missing serve record all degrade
-- to NULLs, quietly. NULL means "not observed", never 0 — the same fillna
-- doctrine the ML exporters keep.
--
-- SERVING: nothing reads this table at request time, ever. It is written by
-- the slider POST and read by the training export. Feeding any serving
-- surface from here would launder an owner-adjacent record back into the
-- number users see; the 031 boundary (nothing owner-flavored writes
-- ml_venue_baselines) extends to this table in full.
--
-- UNITS: imperial (°F, mph), because services/weatherService.js returns
-- imperial and the frozen BestTime corpus was collected through that same
-- function. A training join that mixed units would be worse than a NULL.

CREATE TABLE IF NOT EXISTS venue_owner_report_context (
  report_id INTEGER PRIMARY KEY REFERENCES venue_owner_reports(id) ON DELETE CASCADE,

  -- Weather at the venue's coordinates when the slider moved
  -- (weatherService.getWeather: cache-first, budget-gated, fail-soft null).
  temperature NUMERIC(5,1),
  feels_like NUMERIC(5,1),
  humidity SMALLINT,
  wind_speed NUMERIC(5,1),
  weather_condition VARCHAR(100),
  weather_condition_code INTEGER,
  is_raining BOOLEAN,

  -- Nearby events at that instant (mlPredictor's Ticketmaster lookup: same
  -- cache, same budget, same "ongoing at the instant" window training used).
  has_nearby_event BOOLEAN,
  total_nearby_events INTEGER,
  total_nearby_attendance INTEGER,
  nearest_event_distance_km NUMERIC(6,2),
  nearest_event_attendance INTEGER,
  nearest_event_type VARCHAR(100),

  -- What Flock itself was telling users when the owner said X% — the newest
  -- served_predictions row for the venue inside the capture window. Read,
  -- never recomputed: recomputing would record what the model WOULD say, not
  -- what anyone saw. served_prediction_id is a plain BIGINT, not a foreign
  -- key, for the same reason venue_feedback.served_prediction_id is (032):
  -- the serve log prunes on a 180-day horizon and this row must not block it;
  -- score/method/version are materialized here so the value survives the
  -- prune.
  served_prediction_id BIGINT,
  served_score SMALLINT CHECK (served_score BETWEEN 0 AND 100),
  served_prediction_method TEXT,
  served_model_version TEXT,
  served_at TIMESTAMPTZ,

  -- The venue's own clock and identity at capture time. Redundant with
  -- created_at AT TIME ZONE ml_venues.timezone on purpose: ml_venues rows
  -- mutate (timezone fixes, category re-mapping), and a label's context must
  -- say what was true THEN, not what the corpus says later.
  day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  hour SMALLINT CHECK (hour BETWEEN 0 AND 23),
  timezone VARCHAR(50),
  venue_category VARCHAR(100),

  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The capture's serve read: newest published score for a venue inside the
-- join window. 032's indexes both lead on user_id or served_at alone; this
-- lookup is by venue, so it gets its own.
CREATE INDEX IF NOT EXISTS idx_served_predictions_venue_at
  ON served_predictions (venue_place_id, served_at DESC);
