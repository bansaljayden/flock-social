-- 064: NULL, not an empty array, marks an alert written before the recipient
-- snapshot existed.
--
-- 063 added flock_recipient_ids and contact_recipients with empty defaults so
-- that rows from before the snapshot fell back to the live audience at
-- stand-down. That made two different facts look the same (hardening review round 3,
-- 2026-09-05): a legacy row with no snapshot, and a new alert whose email leg
-- reached nobody, both carried an empty array, so the stand-down for the
-- second re-queried the live contacts and could send an all-clear to somebody
-- who never received the alarm. From here on an empty array is authoritative
-- ("nobody"), and NULL is the legacy sentinel the fallback keys on. The alert
-- INSERT writes both as empty, and the flock leg writes its audience before
-- anyone hears the alarm.
--
-- THE BACKFILL RUNS ONCE, on the application that drops the NOT NULL, and it
-- touches only rows that still hold the pair 063 filled in. It used to run on
-- every application, keyed on 063's applied_at, and that timestamp is exactly
-- what moves when the chain is replayed: with schema_migrations wiped (which
-- __tests__/migrationBootSafety.test.js does on purpose, because every file
-- here has to survive it over live data) 063 is recorded again at the moment
-- of the replay, every alert ever written is "older than 063", and the UPDATE
-- turned each recorded audience back into NULL. The next stand-down then
-- re-read the live flock and the live contact list, which is the all-clear to
-- people who never got the alarm that this file exists to stop, and an alert
-- whose legs reached nobody became a legacy row that re-reads everyone.
-- Measured on the embedded Postgres before this change: an alert holding a
-- flockmate and a contact, and one holding the authoritative empty pair, both
-- came out of a replay as NULL, NULL.
--
-- Two facts choose the rows now, and a replay moves neither. The columns are
-- still NOT NULL when this file starts only on its first application: 063
-- creates them NOT NULL, nothing but the statements below drops that, and a
-- replayed 063 finds the columns already there and adds nothing. And a row
-- that names anybody is a snapshot whatever its date, so only the default
-- pair, '{}' and '[]', can mark a row that has none. On a first application
-- the two select exactly the rows the old statement did, because every alert
-- written before 063 holds that pair and nothing writes to an old alert's
-- recipients again, so a database meeting this file for the first time ends
-- up as it always would have, and one that already ran it is left alone.
DO $$
DECLARE
  first_application BOOLEAN;
BEGIN
  SELECT attnotnull INTO first_application
    FROM pg_attribute
   WHERE attrelid = 'emergency_alerts'::regclass
     AND attname = 'flock_recipient_ids'
     AND NOT attisdropped;

  ALTER TABLE emergency_alerts ALTER COLUMN flock_recipient_ids DROP NOT NULL;
  ALTER TABLE emergency_alerts ALTER COLUMN flock_recipient_ids DROP DEFAULT;
  ALTER TABLE emergency_alerts ALTER COLUMN contact_recipients DROP NOT NULL;
  ALTER TABLE emergency_alerts ALTER COLUMN contact_recipients DROP DEFAULT;

  -- Rows written before 063 was applied never had a snapshot; the ledger's
  -- applied_at is the boundary. If the ledger has no timestamp for 063 (a
  -- database bootstrapped later), no row predates the snapshot and none change.
  IF first_application THEN
    UPDATE emergency_alerts
       SET flock_recipient_ids = NULL, contact_recipients = NULL
     WHERE created_at < (SELECT applied_at FROM schema_migrations WHERE name LIKE '063%' LIMIT 1)
       AND flock_recipient_ids = '{}'
       AND contact_recipients = '[]'::jsonb;
  END IF;
END $$;
