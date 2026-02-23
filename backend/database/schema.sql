-- Flock Database Schema
-- Run this against your PostgreSQL database to initialize tables

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
  read_status BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
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

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_flock_members_flock ON flock_members(flock_id);
CREATE INDEX IF NOT EXISTS idx_flock_members_user ON flock_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_flock ON messages(flock_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_dm_receiver ON direct_messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_dm_conversation ON direct_messages(sender_id, receiver_id);
CREATE INDEX IF NOT EXISTS idx_venue_votes_flock ON venue_votes(flock_id);
CREATE INDEX IF NOT EXISTS idx_emoji_reactions_message ON emoji_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
