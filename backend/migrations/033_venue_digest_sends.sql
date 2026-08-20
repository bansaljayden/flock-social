-- 033: durable dedupe for the Monday venue digest.
--
-- Same defect class 007 closed for crowd alerts: the digest sweep runs on an
-- interval inside the web process, Railway overlaps containers on every
-- deploy, and a Monday-morning deploy would mail every venue twice. The
-- marker row is claimed with INSERT ... ON CONFLICT DO NOTHING BEFORE the
-- send; exactly one instance wins the primary key, the losers see rowCount 0
-- and send nothing. A failed send deletes its marker so the next sweep that
-- hour can retry.
--
-- week_start is the Monday date in the VENUE'S local calendar (ml_venues
-- timezone when the venue is in the corpus, America/New_York otherwise), so
-- one row means "this venue's Monday digest for this week went out",
-- regardless of which UTC hour the sweep fired in.
CREATE TABLE IF NOT EXISTS venue_digest_sends (
  venue_profile_id INTEGER NOT NULL REFERENCES venue_profiles(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (venue_profile_id, week_start)
);

-- Prune index: the service deletes markers older than 90 days so the table
-- stays proportional to active venues, not to every Monday since launch.
CREATE INDEX IF NOT EXISTS idx_venue_digest_sends_sent_at ON venue_digest_sends(sent_at);
