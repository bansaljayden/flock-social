-- 003: feedback verification, moderation tombstones, and adoption of
-- route-owned DDL (REVIEW-ROUND5).
--
-- 1) venue_feedback.verified — feedback only counts toward live crowd
--    calibration and ML training export when the reporter provably was at the
--    venue (recent check-in, or accepted member of a flock that met there).
--    Without this, Sybil accounts could steer public predictions and poison
--    training features.
ALTER TABLE venue_feedback ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;

-- 2) Moderation tombstones — reporter_id / reported_user_id / target_user_id
--    must be able to outlive the referenced account as NULLs, so account
--    deletion cannot erase open reports or moderation audit history.
--    Each ALTER is wrapped so it tolerates already-nullable columns and
--    missing tables on drifted databases.
DO $$ BEGIN
  ALTER TABLE content_reports ALTER COLUMN reporter_id DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE content_reports ALTER COLUMN reported_user_id DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE moderation_actions ALTER COLUMN target_user_id DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- 3) Tables formerly self-created at require() time by route modules
--    (friends.js, users.js, availability.js, calendar.js, waitlist.js).
--    Route-owned DDL ran before migrate() on boot and could race the baseline
--    (e.g. REFERENCES users(id) before users exists), leaving fresh
--    deployments silently missing these tables until a restart. They now live
--    here, ordered after the baseline.
CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS availability_pulses (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL CHECK (status IN ('down', 'maybe', 'not')),
  note TEXT,
  set_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_availability_expires ON availability_pulses(expires_at);

CREATE TABLE IF NOT EXISTS calendar_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  venue VARCHAR(200),
  event_date DATE NOT NULL,
  time_label VARCHAR(20),
  color VARCHAR(30),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_user_date ON calendar_events(user_id, event_date);

CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
