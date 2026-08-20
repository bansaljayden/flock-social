-- 032: served_predictions — the server's own record of every score it published
--
-- WHY THIS TABLE EXISTS.
--
-- venue_feedback.predicted_score has always been what the CLIENT says we
-- predicted, and it is the denominator of every calibration feature:
-- services/mlPredictor.js averages `mapped(crowd_level) - predicted_score`,
-- routes/crowd.js feeds the same rows to buildCalibrationAdjustment, and the
-- training export ships the figure as avg_prediction_error. The server had the
-- real published number in hand every time it served a crowd card and kept no
-- record of it, so a verified account could assert any denominator in 0-100
-- and nothing could contradict it. This table is the record.
--
-- APPEND-ONLY, DELIBERATELY — not a last-serve upsert. A one-row-per-
-- (user, venue) table answers "what did we tell them most recently" and
-- nothing else; it cannot answer "what was on screen when this feedback was
-- filed" once the user re-opens the card, and it makes "what did Flock tell
-- users that night" permanently unanswerable. Every serve is a row; the
-- feedback route joins the newest one inside its window and materializes its
-- id AND its score onto the venue_feedback row, so the linkage survives even
-- after old log rows are eventually pruned.
--
-- WRITE PATHS (fire-and-forget, never on the response's critical path):
--   * routes/crowd.js GET /:placeId  — the detail card, cached and fresh.
--   * routes/crowd.js POST /batch    — the vote-list scores, shaped ids only
--     (batch place ids are deliberately unvalidated for SCORING, but a junk id
--     must not mint rows here — that would be unbounded growth one POST away).
--
-- READ PATH: routes/feedback.js takes the newest serve for (user, venue)
-- inside 12 hours and prefers its score over the client's claim;
-- venue_feedback.predicted_score_source records which one won.
--
-- RETENTION: routes/crowd.js opportunistically prunes rows older than 180
-- days. Six months keeps the night-by-night serve history long enough for any
-- calibration or "what did we publish" question the current pipeline asks
-- (its windows are 12 hours and 28 days); if this table ever needs to live
-- longer, the answer is a rollup job, not a longer prune.

CREATE TABLE IF NOT EXISTS served_predictions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_place_id VARCHAR(255) NOT NULL,
  score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  prediction_method TEXT,
  model_version TEXT,
  served_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The feedback join: newest serve for (user, venue) inside a window.
CREATE INDEX IF NOT EXISTS idx_served_predictions_user_venue_at
  ON served_predictions (user_id, venue_place_id, served_at DESC);

-- The opportunistic prune, so it never scans.
CREATE INDEX IF NOT EXISTS idx_served_predictions_served_at
  ON served_predictions (served_at);

-- venue_feedback grows three columns:
--   predicted_score_source — 'server' when predicted_score came from this
--     table (verifiable), 'client' when it is still the client's claim
--     (legacy clients, or no served record inside the join window). NULL on
--     rows written before this migration and on rows with no score at all.
--   client_predicted_score — what the client asserted, kept verbatim even
--     when the server value wins, so the two can be compared after the fact.
--   served_prediction_id — the id of the exact serve the denominator came
--     from. A plain BIGINT, not a foreign key, on purpose: the log is pruned
--     on a 180-day horizon and the feedback row must not be deletable (or the
--     prune blockable) because of it. The score and source are materialized
--     here at submit time, so the id is a forensic join key while the log row
--     lives, not the value's only home.
-- Same tolerant DO-block style as 003/004/005/026 for drifted databases.

DO $$ BEGIN
  ALTER TABLE venue_feedback ADD COLUMN IF NOT EXISTS predicted_score_source VARCHAR(10)
    CHECK (predicted_score_source IN ('server', 'client'));
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE venue_feedback ADD COLUMN IF NOT EXISTS client_predicted_score SMALLINT
    CHECK (client_predicted_score BETWEEN 0 AND 100);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE venue_feedback ADD COLUMN IF NOT EXISTS served_prediction_id BIGINT;
EXCEPTION WHEN others THEN NULL; END $$;
