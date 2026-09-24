-- 075: the free-tier meters, kept across restarts.
--
-- WHAT IT ADDS. usage_meters, one row per account per meter per period:
--
--   forecast  period YYYY-MM (UTC)     used   = venues charged this month
--                                      venues = the place ids already charged,
--                                               so opening one again stays free
--   birdie    period YYYY-MM-DD (UTC)  used   = Birdie messages today
--                                      tokens = Gemini tokens charged today
--
-- services/usageStore.js writes it (coalesced write-through of the meters'
-- absolute values) and loads the current period back into memory at boot.
--
-- WHY. services/forecastUsage.js and services/birdieUsage.js enforce from
-- process memory, and Railway restarts the process on every push to main, so
-- "30 venues a month" had become "30 venues per deploy". Memory still does the
-- enforcing; this table is what it remembers across a restart.
--
-- DELETION. ON DELETE CASCADE: the rows describe an account's own usage and
-- leave with it. Rows are also pruned 62 days after their last change
-- (usageStore.js KEEP_DAYS), because the venues column says which places an
-- account opened and nothing needs that once its month is over.
CREATE TABLE IF NOT EXISTS usage_meters (
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meter      TEXT        NOT NULL,
  period     TEXT        NOT NULL,
  used       INTEGER     NOT NULL DEFAULT 0,
  tokens     BIGINT      NOT NULL DEFAULT 0,
  venues     TEXT[]      NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, meter, period),
  CONSTRAINT usage_meters_period_shape CHECK (
    (meter = 'forecast' AND period ~ '^[0-9]{4}-[0-9]{2}$')
    OR (meter = 'birdie' AND period ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  ),
  CONSTRAINT usage_meters_nonnegative CHECK (used >= 0 AND tokens >= 0)
);

-- Boot reads one period per meter; the prune reads by age.
CREATE INDEX IF NOT EXISTS idx_usage_meters_meter_period ON usage_meters (meter, period);
CREATE INDEX IF NOT EXISTS idx_usage_meters_updated_at ON usage_meters (updated_at);
