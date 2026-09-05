-- 064: NULL, not an empty array, marks an alert written before the recipient
-- snapshot existed.
--
-- 063 added flock_recipient_ids and contact_recipients with empty defaults so
-- that rows from before the snapshot fell back to the live audience at
-- stand-down. That made two different facts look the same (Codex round 3,
-- 2026-09-05): a legacy row with no snapshot, and a new alert whose email leg
-- reached nobody, both carried an empty array, so the stand-down for the
-- second re-queried the live contacts and could send an all-clear to somebody
-- who never received the alarm. From here on an empty array is authoritative
-- ("nobody"), and NULL is the legacy sentinel the fallback keys on. The alert
-- INSERT writes both as empty, and the flock leg writes its audience before
-- anyone hears the alarm.
ALTER TABLE emergency_alerts ALTER COLUMN flock_recipient_ids DROP NOT NULL;
ALTER TABLE emergency_alerts ALTER COLUMN flock_recipient_ids DROP DEFAULT;
ALTER TABLE emergency_alerts ALTER COLUMN contact_recipients DROP NOT NULL;
ALTER TABLE emergency_alerts ALTER COLUMN contact_recipients DROP DEFAULT;
-- Rows written before 063 was applied never had a snapshot; the ledger's
-- applied_at is the boundary. If the ledger has no timestamp for 063 (a
-- database bootstrapped later), no row predates the snapshot and none change.
UPDATE emergency_alerts
   SET flock_recipient_ids = NULL, contact_recipients = NULL
 WHERE created_at < (SELECT applied_at FROM schema_migrations WHERE name LIKE '063%' LIMIT 1);
