-- 007: durable dedupe for proactive crowd alerts (round 12).
--
-- services/crowdAlerts.js tracked "already alerted this flock" in a per-process
-- Map. server.js runs the 15-minute sweep inside the WEB process, so the moment
-- Railway runs two instances (or a deploy overlaps the old container) every
-- confirmed flock member gets the same push once per instance. A restart also
-- wiped the Map and re-sent.
--
-- The marker is a row, claimed with INSERT ... ON CONFLICT DO NOTHING BEFORE
-- any push goes out: exactly one instance wins the primary key, the losers see
-- rowCount 0 and send nothing. flock_id CASCADEs so deleting a flock cleans up.
CREATE TABLE IF NOT EXISTS crowd_alert_sends (
  flock_id INTEGER NOT NULL REFERENCES flocks(id) ON DELETE CASCADE,
  alert_type VARCHAR(30) NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flock_id, alert_type)
);

-- Sweep index: the service prunes markers older than 7 days so the table stays
-- proportional to live flocks rather than to all flocks ever confirmed.
CREATE INDEX IF NOT EXISTS idx_crowd_alert_sends_sent_at ON crowd_alert_sends(sent_at);
