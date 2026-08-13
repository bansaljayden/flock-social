-- @tolerant
-- 001_baseline: the historical inline startup DDL, verbatim and in
-- order. Every statement is idempotent (IF NOT EXISTS); tolerant mode
-- replays it safely against databases in any drift state. New schema
-- changes go in NEW numbered files, never here.

ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text';

ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS venue_data JSONB;

ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES direct_messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS dm_emoji_reactions (
      id SERIAL PRIMARY KEY,
      dm_id INTEGER REFERENCES direct_messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      emoji VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(dm_id, user_id, emoji)
    );

CREATE INDEX IF NOT EXISTS idx_dm_emoji_reactions_dm ON dm_emoji_reactions(dm_id);

CREATE TABLE IF NOT EXISTS dm_venue_votes (
      id SERIAL PRIMARY KEY,
      user1_id INTEGER NOT NULL,
      user2_id INTEGER NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      venue_name VARCHAR(255) NOT NULL,
      venue_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user1_id, user2_id, user_id, venue_name)
    );

CREATE INDEX IF NOT EXISTS idx_dm_venue_votes_pair ON dm_venue_votes(user1_id, user2_id);

CREATE TABLE IF NOT EXISTS dm_pinned_venues (
      id SERIAL PRIMARY KEY,
      user1_id INTEGER NOT NULL,
      user2_id INTEGER NOT NULL,
      venue_name VARCHAR(255) NOT NULL,
      venue_address TEXT,
      venue_id VARCHAR(255),
      venue_rating NUMERIC(2,1),
      venue_photo_url TEXT,
      pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user1_id, user2_id)
    );

CREATE TABLE IF NOT EXISTS trusted_contacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      contact_name VARCHAR(100) NOT NULL,
      contact_phone VARCHAR(20) NOT NULL,
      contact_email VARCHAR(255),
      relationship VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, contact_phone)
    );

CREATE INDEX IF NOT EXISTS idx_trusted_contacts_user ON trusted_contacts(user_id);

CREATE TABLE IF NOT EXISTS emergency_alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      contacts_alerted INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );

CREATE TABLE IF NOT EXISTS venue_feedback (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      flock_id INTEGER,
      venue_place_id VARCHAR(255) NOT NULL,
      venue_name VARCHAR(255) NOT NULL,
      crowd_level SMALLINT NOT NULL CHECK (crowd_level BETWEEN 1 AND 3),
      price_worth BOOLEAN,
      rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
      predicted_score SMALLINT CHECK (predicted_score BETWEEN 0 AND 100),
      day_of_week SMALLINT NOT NULL,
      hour SMALLINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

CREATE INDEX IF NOT EXISTS idx_venue_feedback_place ON venue_feedback(venue_place_id);

CREATE INDEX IF NOT EXISTS idx_venue_feedback_day_hour ON venue_feedback(venue_place_id, day_of_week, hour);

ALTER TABLE flocks ADD COLUMN IF NOT EXISTS budget_enabled BOOLEAN DEFAULT false;

ALTER TABLE flocks ADD COLUMN IF NOT EXISTS budget_context VARCHAR(100);

ALTER TABLE flocks ADD COLUMN IF NOT EXISTS budget_locked BOOLEAN DEFAULT false;

ALTER TABLE flocks ADD COLUMN IF NOT EXISTS budget_ceiling DECIMAL(8,2);

ALTER TABLE flocks ADD COLUMN IF NOT EXISTS ghost_mode_enabled BOOLEAN DEFAULT false;

ALTER TABLE flocks ADD COLUMN IF NOT EXISTS venue_rating NUMERIC(2,1);

ALTER TABLE flocks ADD COLUMN IF NOT EXISTS venue_photo_url TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS venmo_username VARCHAR(50);

ALTER TABLE users ADD COLUMN IF NOT EXISTS cashapp_cashtag VARCHAR(50);

ALTER TABLE users ADD COLUMN IF NOT EXISTS zelle_identifier VARCHAR(255);

CREATE TABLE IF NOT EXISTS budget_submissions (
        id SERIAL PRIMARY KEY,
        flock_id INTEGER REFERENCES flocks(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(8,2),
        skipped BOOLEAN DEFAULT false,
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(flock_id, user_id)
      );

CREATE INDEX IF NOT EXISTS idx_budget_submissions_flock ON budget_submissions(flock_id);

CREATE TABLE IF NOT EXISTS bill_splits (
        id SERIAL PRIMARY KEY,
        flock_id INTEGER REFERENCES flocks(id) ON DELETE CASCADE,
        total_amount DECIMAL(8,2) NOT NULL,
        split_type VARCHAR(20) DEFAULT 'equal',
        paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        tip_percent DECIMAL(4,1) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(flock_id)
      );

CREATE TABLE IF NOT EXISTS bill_split_shares (
        id SERIAL PRIMARY KEY,
        bill_id INTEGER REFERENCES bill_splits(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(8,2) NOT NULL,
        committed BOOLEAN DEFAULT false,
        settled BOOLEAN DEFAULT false,
        settled_at TIMESTAMPTZ,
        UNIQUE(bill_id, user_id)
      );

CREATE INDEX IF NOT EXISTS idx_bill_split_shares_bill ON bill_split_shares(bill_id);

DELETE FROM budget_submissions
        WHERE flock_id IN (
          SELECT id FROM flocks
          WHERE status IN ('completed', 'cancelled')
          AND updated_at < NOW() - INTERVAL '24 hours'
        );

CREATE TABLE IF NOT EXISTS device_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      device_type VARCHAR(20) DEFAULT 'web',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, token)
    );

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS reliability_score DECIMAL(5,2);

ALTER TABLE users ADD COLUMN IF NOT EXISTS total_plans_joined INTEGER DEFAULT 0;

ALTER TABLE users ADD COLUMN IF NOT EXISTS total_plans_attended INTEGER DEFAULT 0;

ALTER TABLE flock_members ADD COLUMN IF NOT EXISTS attendance VARCHAR(20) DEFAULT 'unmarked';

CREATE INDEX IF NOT EXISTS idx_flock_members_attendance ON flock_members(attendance);

CREATE TABLE IF NOT EXISTS research_analytics (
        id SERIAL PRIMARY KEY,
        flock_id INTEGER REFERENCES flocks(id) ON DELETE SET NULL,
        group_size INTEGER,
        budget_enabled BOOLEAN DEFAULT false,
        budget_ceiling DECIMAL(8,2),
        submission_count INTEGER DEFAULT 0,
        skip_count INTEGER DEFAULT 0,
        flock_completed BOOLEAN DEFAULT false,
        venue_price_level_selected INTEGER,
        time_to_confirmation INTEGER,
        stall_point VARCHAR(30),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(flock_id)
      );

CREATE INDEX IF NOT EXISTS idx_research_analytics_created ON research_analytics(created_at);

CREATE INDEX IF NOT EXISTS idx_research_analytics_stall ON research_analytics(stall_point);

ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(20);

ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_id VARCHAR(255);

ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

CREATE TABLE IF NOT EXISTS venue_profiles (
          id SERIAL PRIMARY KEY,
          user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          business_name VARCHAR(255) NOT NULL,
          category VARCHAR(100),
          location VARCHAR(255),
          description TEXT,
          goals TEXT[],
          google_place_id VARCHAR(255),
          photo_url TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS operating_hours JSONB DEFAULT '[]';

ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{"bookings":true,"reviews":true,"weekly":false}';

ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'free';

CREATE TABLE IF NOT EXISTS venue_promotions (
          id SERIAL PRIMARY KEY,
          venue_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          google_place_id VARCHAR(255),
          title VARCHAR(255) NOT NULL,
          description TEXT,
          time_slot VARCHAR(100),
          days VARCHAR(100),
          active BOOLEAN DEFAULT true,
          views INTEGER DEFAULT 0,
          claims INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

CREATE INDEX IF NOT EXISTS idx_venue_promos_place ON venue_promotions(google_place_id);

CREATE TABLE IF NOT EXISTS venue_events (
          id SERIAL PRIMARY KEY,
          venue_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          google_place_id VARCHAR(255),
          title VARCHAR(255) NOT NULL,
          event_date VARCHAR(50),
          event_time VARCHAR(50),
          capacity INTEGER DEFAULT 50,
          rsvps INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

CREATE INDEX IF NOT EXISTS idx_venue_events_place ON venue_events(google_place_id);

CREATE TABLE IF NOT EXISTS venue_reviews (
          id SERIAL PRIMARY KEY,
          google_place_id VARCHAR(255) NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          text TEXT,
          venue_reply TEXT,
          venue_replied_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(google_place_id, user_id)
        );

CREATE INDEX IF NOT EXISTS idx_venue_reviews_place ON venue_reviews(google_place_id);

CREATE TABLE IF NOT EXISTS sensor_devices (
          id SERIAL PRIMARY KEY,
          device_id VARCHAR(100) UNIQUE NOT NULL,
          venue_place_id VARCHAR(255) NOT NULL,
          api_key VARCHAR(255) NOT NULL,
          device_name VARCHAR(100),
          is_active BOOLEAN DEFAULT true,
          last_seen_at TIMESTAMPTZ,
          deployed_at TIMESTAMPTZ DEFAULT NOW()
        );

CREATE INDEX IF NOT EXISTS idx_sensor_devices_device_id ON sensor_devices(device_id);

CREATE INDEX IF NOT EXISTS idx_sensor_devices_api_key ON sensor_devices(api_key);

CREATE TABLE IF NOT EXISTS venue_sensor_data (
          id SERIAL PRIMARY KEY,
          venue_place_id VARCHAR(255) NOT NULL,
          ir_beam_count INTEGER DEFAULT 0,
          thermal_headcount INTEGER DEFAULT 0,
          noise_db DECIMAL(5,2),
          sensor_device_id VARCHAR(100) NOT NULL,
          recorded_at TIMESTAMPTZ DEFAULT NOW()
        );

CREATE INDEX IF NOT EXISTS idx_venue_sensor_data_place ON venue_sensor_data(venue_place_id);

CREATE INDEX IF NOT EXISTS idx_venue_sensor_data_recorded ON venue_sensor_data(recorded_at);

CREATE INDEX IF NOT EXISTS idx_venue_sensor_data_device ON venue_sensor_data(sensor_device_id);

CREATE TABLE IF NOT EXISTS venue_checkins (
          id SERIAL PRIMARY KEY,
          venue_place_id VARCHAR(255) NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          checkin_source VARCHAR(20) DEFAULT 'nfc' CHECK (checkin_source IN ('nfc', 'manual', 'gps')),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

CREATE INDEX IF NOT EXISTS idx_venue_checkins_place ON venue_checkins(venue_place_id);

CREATE INDEX IF NOT EXISTS idx_venue_checkins_user ON venue_checkins(user_id);

CREATE INDEX IF NOT EXISTS idx_venue_checkins_created ON venue_checkins(created_at);

CREATE TABLE IF NOT EXISTS content_reports (
        id SERIAL PRIMARY KEY,
        reporter_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        reported_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('flock_message','dm','profile','story')),
        content_id INTEGER,
        reason VARCHAR(50) NOT NULL,
        details TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','resolved','dismissed')),
        handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(status);

CREATE INDEX IF NOT EXISTS idx_content_reports_reported_user ON content_reports(reported_user_id);

CREATE TABLE IF NOT EXISTS user_blocks (
        id SERIAL PRIMARY KEY,
        blocker_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        blocked_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(blocker_id, blocked_id)
      );

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
        id SERIAL PRIMARY KEY,
        report_id INTEGER REFERENCES content_reports(id) ON DELETE SET NULL,
        moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        action VARCHAR(30) NOT NULL CHECK (action IN ('content_hidden','content_removed','user_warned','user_banned','user_unbanned','dismissed')),
        content_type VARCHAR(20),
        content_id INTEGER,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_moderation_actions_target ON moderation_actions(target_user_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;

ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;

ALTER TABLE stories ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_refresh_token TEXT;

CREATE TABLE IF NOT EXISTS flock_invite_links (
        token VARCHAR(20) PRIMARY KEY,
        flock_id INTEGER NOT NULL REFERENCES flocks(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        revoked BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_invite_links_flock ON flock_invite_links(flock_id);

CREATE TABLE IF NOT EXISTS guest_rsvps (
        id SERIAL PRIMARY KEY,
        flock_id INTEGER NOT NULL REFERENCES flocks(id) ON DELETE CASCADE,
        guest_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        name VARCHAR(60) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'in' CHECK (status IN ('in','out')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_guest_rsvps_flock ON guest_rsvps(flock_id);

CREATE TABLE IF NOT EXISTS guest_votes (
        id SERIAL PRIMARY KEY,
        flock_id INTEGER NOT NULL REFERENCES flocks(id) ON DELETE CASCADE,
        guest_rsvp_id INTEGER NOT NULL REFERENCES guest_rsvps(id) ON DELETE CASCADE,
        venue_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(flock_id, guest_rsvp_id, venue_name)
      );

CREATE INDEX IF NOT EXISTS idx_guest_votes_flock ON guest_votes(flock_id);

ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;
