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
--
-- THE HANDLERS BELOW USED TO SAY `EXCEPTION WHEN others THEN NULL`, copying
-- 003/004/005/026, and that was wrong here in a way it is worth writing down.
-- `others` catches everything, including the things that are not "this already
-- exists, carry on". db/migrate.js sets lock_timeout to 10 seconds precisely so
-- a rolling deploy cannot queue DDL behind a long-running query forever;
-- venue_feedback is a populated, actively written table, so that timeout firing
-- on one of these ALTERs is an ordinary Tuesday. `others` swallowed it, the
-- statement batch returned, the runner wrote the schema_migrations row, and the
-- columns were then absent FOREVER, because nothing re-runs a migration the
-- runner believes is done. routes/feedback.js writes predicted_score_source,
-- client_predicted_score and served_prediction_id on every submit, so every
-- report would have 500'd from that point on and a redeploy would not have
-- healed it.
--
-- So the handlers are narrowed to the two conditions that genuinely mean
-- "already there": duplicate_column (42701) and duplicate_object (42710, the
-- auto-named CHECK constraint). A lock timeout (55P03), a permission error, a
-- missing venue_feedback and anything else now propagates, which fails the boot
-- loudly and retries on the next one instead of losing the column quietly.
--
-- The @requires lines are the belt to that braces: db/migrate.js verifies them
-- before it records this file, and re-verifies them on every later boot, so a
-- database that was ALREADY falsely marked applied gets the file replayed
-- rather than needing a human. See the header of db/migrate.js.
-- @requires table served_predictions
-- @requires column venue_feedback.predicted_score_source
-- @requires column venue_feedback.client_predicted_score
-- @requires column venue_feedback.served_prediction_id

DO $$ BEGIN
  ALTER TABLE venue_feedback ADD COLUMN IF NOT EXISTS predicted_score_source VARCHAR(10)
    CHECK (predicted_score_source IN ('server', 'client'));
EXCEPTION WHEN duplicate_column OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE venue_feedback ADD COLUMN IF NOT EXISTS client_predicted_score SMALLINT
    CHECK (client_predicted_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_column OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE venue_feedback ADD COLUMN IF NOT EXISTS served_prediction_id BIGINT;
EXCEPTION WHEN duplicate_column OR duplicate_object THEN NULL; END $$;
