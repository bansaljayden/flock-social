-- ---------------------------------------------------------------------------
-- ML Training Data Collection — Schema
-- Run via: node scripts/ml/initTables.js
-- ---------------------------------------------------------------------------

-- Curated venues for ML data collection (250 venues across 5 cities)
CREATE TABLE IF NOT EXISTS ml_venues (
  id SERIAL PRIMARY KEY,
  google_place_id VARCHAR(255) NOT NULL UNIQUE,
  besttime_venue_id VARCHAR(255),
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(100) NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  venue_category VARCHAR(100) NOT NULL,
  google_types TEXT[],
  price_level SMALLINT,
  rating NUMERIC(2,1),
  review_count INTEGER DEFAULT 0,
  timezone VARCHAR(50) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  last_collected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_venues_city ON ml_venues(city);
CREATE INDEX IF NOT EXISTS idx_ml_venues_category ON ml_venues(venue_category);
CREATE INDEX IF NOT EXISTS idx_ml_venues_active ON ml_venues(is_active);

-- Training data: one row per venue-hour observation
CREATE TABLE IF NOT EXISTS ml_training_data (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES ml_venues(id) ON DELETE CASCADE,
  collection_mode VARCHAR(20) NOT NULL CHECK (collection_mode IN ('weekly', 'realtime')),

  -- Temporal features
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  month SMALLINT,
  season VARCHAR(10),
  is_holiday BOOLEAN DEFAULT false,
  is_school_break BOOLEAN DEFAULT false,

  -- Venue features (denormalized at collection time)
  venue_category VARCHAR(100) NOT NULL,
  price_level SMALLINT,
  rating NUMERIC(2,1),
  review_count INTEGER,

  -- Weather features
  temperature NUMERIC(5,1),
  humidity SMALLINT,
  wind_speed NUMERIC(5,1),
  weather_condition VARCHAR(50),
  weather_condition_code INTEGER,
  is_raining BOOLEAN,

  -- Event features (Model 1.5 — Ticketmaster/SeatGeek)
  event_nearby BOOLEAN DEFAULT false,
  event_distance_km NUMERIC(5,1),          -- distance from venue to nearest event
  event_size INTEGER,                       -- venue capacity / tickets sold
  event_type VARCHAR(50),                   -- concert, sports, festival, conference
  event_hours_until SMALLINT,               -- hours until event starts (negative = already started)

  -- Label (ground truth from BestTime)
  busyness_pct SMALLINT NOT NULL CHECK (busyness_pct BETWEEN 0 AND 100),

  -- Metadata
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  besttime_epoch BIGINT
);

CREATE INDEX IF NOT EXISTS idx_ml_training_venue ON ml_training_data(venue_id);
CREATE INDEX IF NOT EXISTS idx_ml_training_mode ON ml_training_data(collection_mode);
CREATE INDEX IF NOT EXISTS idx_ml_training_day_hour ON ml_training_data(day_of_week, hour);
CREATE INDEX IF NOT EXISTS idx_ml_training_collected ON ml_training_data(collected_at);

-- Ticketmaster events for ML enrichment
CREATE TABLE IF NOT EXISTS ml_events (
  id SERIAL PRIMARY KEY,
  ticketmaster_id VARCHAR(255) UNIQUE,
  name VARCHAR(500),
  city VARCHAR(100),
  venue_name VARCHAR(255),
  venue_lat DECIMAL(10,7),
  venue_lng DECIMAL(10,7),
  event_date DATE,
  event_start_hour INTEGER CHECK (event_start_hour BETWEEN 0 AND 23),
  event_end_hour INTEGER CHECK (event_end_hour BETWEEN 0 AND 23),
  event_type VARCHAR(50),
  estimated_attendance INTEGER,
  collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_events_city ON ml_events(city);
CREATE INDEX IF NOT EXISTS idx_ml_events_date ON ml_events(event_date);

-- Event enrichment columns on ml_training_data
ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS has_nearby_event BOOLEAN DEFAULT false;
ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_distance_km DECIMAL(5,2);
ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_attendance INTEGER DEFAULT 0;
ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS total_nearby_events INTEGER DEFAULT 0;
ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS total_nearby_attendance INTEGER DEFAULT 0;
ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS nearest_event_type VARCHAR(50);
