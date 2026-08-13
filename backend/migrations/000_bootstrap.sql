-- 000_bootstrap: the CORE tables, as real migrations (round 12).
--
-- Audit finding: a rebuilt database could not boot. 001_baseline only ALTERs
-- users / flocks / flock_members / messages / direct_messages / stories — the
-- tables themselves lived ONLY in database/schema.sql, applied by the manual
-- `npm run db:init` script. Against an empty Postgres, 001 is `-- @tolerant`
-- so every statement failed and was skipped, then 002 threw on a nonexistent
-- device_tokens and server.js exited: a crash-loop with no way out except a
-- human running psql. A fresh database now boots from migrations alone.
--
-- This file is the verbatim content of database/schema.sql (which stays for
-- `npm run db:init` and for anyone reading the base shape). Every statement is
-- IF NOT EXISTS, so replaying it against the populated production database is
-- a no-op — it must never rewrite or drop anything that already exists. New
-- schema changes go in NEW numbered files, never here.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  interests TEXT[],
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'venue_owner', 'admin')),
  profile_image_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flocks (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  venue_name VARCHAR(255),
  venue_address TEXT,
  venue_id VARCHAR(255),
  venue_latitude DOUBLE PRECISION,
  venue_longitude DOUBLE PRECISION,
  event_time TIMESTAMP,
  status VARCHAR(20) DEFAULT 'planning' CHECK (status IN ('planning', 'confirmed', 'completed', 'cancelled')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flock_members (
  id SERIAL PRIMARY KEY,
  flock_id INTEGER REFERENCES flocks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'invited' CHECK (status IN ('invited', 'accepted', 'declined')),
  joined_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(flock_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  flock_id INTEGER REFERENCES flocks(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_text TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'venue_card', 'image')),
  venue_data JSONB,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  message_text TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'venue_card', 'image')),
  venue_data JSONB,
  image_url TEXT,
  reply_to_id INTEGER REFERENCES direct_messages(id) ON DELETE SET NULL,
  read_status BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dm_emoji_reactions (
  id SERIAL PRIMARY KEY,
  dm_id INTEGER REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(dm_id, user_id, emoji)
);

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

CREATE TABLE IF NOT EXISTS venue_votes (
  id SERIAL PRIMARY KEY,
  flock_id INTEGER REFERENCES flocks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  venue_name VARCHAR(255) NOT NULL,
  venue_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(flock_id, user_id, venue_name)
);

CREATE TABLE IF NOT EXISTS emoji_reactions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS stories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(requester_id, addressee_id)
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

CREATE TABLE IF NOT EXISTS emergency_alerts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  contacts_alerted INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id);
CREATE INDEX IF NOT EXISTS idx_flock_members_flock ON flock_members(flock_id);
CREATE INDEX IF NOT EXISTS idx_flock_members_user ON flock_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_flock ON messages(flock_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_dm_receiver ON direct_messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_dm_conversation ON direct_messages(sender_id, receiver_id);
CREATE INDEX IF NOT EXISTS idx_dm_emoji_reactions_dm ON dm_emoji_reactions(dm_id);
CREATE INDEX IF NOT EXISTS idx_dm_venue_votes_pair ON dm_venue_votes(user1_id, user2_id);
CREATE INDEX IF NOT EXISTS idx_venue_votes_flock ON venue_votes(flock_id);
CREATE INDEX IF NOT EXISTS idx_emoji_reactions_message ON emoji_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);
CREATE INDEX IF NOT EXISTS idx_trusted_contacts_user ON trusted_contacts(user_id);
