-- Operational alert dedupe that survives restarts. The collection heartbeat
-- promised at most one email a day, but its memory of "already sent today"
-- lived in process RAM, and every deploy restarts the process: two deploys
-- on 2026-09-01 mailed Jayden twice inside an hour about the same condition.
-- One row per (alert kind, calendar day); the sender INSERTs with ON CONFLICT
-- DO NOTHING and only mails when its insert actually landed, which is atomic
-- and honest across restarts and, if that day ever comes, across replicas.
-- Pure CREATE, replay-safe under migrationBootSafety like 056 and 057.
CREATE TABLE IF NOT EXISTS ops_alert_ledger (
  alert_key TEXT NOT NULL,
  sent_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alert_key, sent_on)
);
