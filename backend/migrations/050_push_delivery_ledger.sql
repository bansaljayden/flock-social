-- @requires table push_sends
-- @requires table push_outbox
-- @requires table push_debounce
-- @requires column device_tokens.timezone
--
-- 050: the four things the push path had no storage for.
--
-- Everything here is additive. No existing column changes type, no existing
-- row is written, and every statement is IF NOT EXISTS, so this file is safe
-- to replay over a populated database (which is what
-- __tests__/migrationBootSafety.test.js replays it against).
--
-- ---------------------------------------------------------------------------
-- 1. push_sends. The delivery ledger.
--
-- Before this table nobody could answer "has a single push ever been delivered
-- in production". sendPushToUser returned { sent, failed } and every caller
-- except services/crowdAlerts.js threw it away, so a notification that never
-- left the building and one that landed on a lock screen produced identical
-- evidence: none.
--
-- One row per push ATTEMPT, written by services/pushHelper.js at the one
-- chokepoint every push in the app passes through. It is deliberately small:
--   * no title, no body, no message text. A notification body is a private
--     message and a lock-screen preview; it does not belong in a metrics table
--     that outlives it.
--   * no token, no device id. The question is "did pushes land", not "which
--     handset".
--   * user_id is kept because the only useful support question is "why did
--     THIS person not get it", and it is ON DELETE SET NULL so a deleted
--     account leaves counts intact without leaving a person behind.
--
-- Retention is 30 days, swept by pushHelper.sweepPushMaintenance(). "Did
-- pushes go out this week" is the question; a year of rows answers it no
-- better and is a year of rows.
CREATE TABLE IF NOT EXISTS push_sends (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  push_type VARCHAR(40) NOT NULL DEFAULT 'unknown',
  -- The verdict, from services/pushHelper.js PUSH_OUTCOMES. Not a CHECK
  -- constraint: migration 017's header records three separate near-misses
  -- where route code widened a value set and the CHECK behind it was not, and
  -- a ledger insert that raises 23514 would turn "we could not measure this
  -- push" into "this push failed". A metrics table must never be able to break
  -- the thing it measures.
  outcome VARCHAR(32) NOT NULL,
  devices_sent SMALLINT NOT NULL DEFAULT 0,
  devices_failed SMALLINT NOT NULL DEFAULT 0,
  -- True when the send was held back because it was the middle of the night
  -- where the recipient's device is. Kept separate from outcome so "we
  -- deferred it" and "we later delivered it" are both countable.
  quiet_hours BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only two reads this table has: a time window, and one person's history.
CREATE INDEX IF NOT EXISTS idx_push_sends_created ON push_sends (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_sends_user ON push_sends (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. push_outbox. Notifications that have not happened yet, and why.
--
-- Two reasons a push is written now and delivered later, and they share one
-- table because they share every mechanic: a claim, a backoff, an expiry, and
-- a sweep that runs on some other instance.
--
--   'retry'  the provider failed transiently. firebase-admin retries a send
--            four times on its own, and services/firebaseService.js races that
--            with an 8 second deadline ON PURPOSE (the comment above
--            SEND_TIMEOUT_MS explains why: a notification failing must never
--            be something a user experiences as the app hanging). So the retry
--            cannot live inside the send. It lives out here, where a later
--            sweep can take another run at it without any request waiting.
--
--   'quiet'  it is the middle of the night where the recipient is. The push is
--            NOT dropped, it is held until the window closes. See the quiet
--            hours block in services/pushHelper.js for what "night" means for
--            an app whose entire purpose is people going out at night.
--
-- This generalises the pattern crowd_alert_sends (migration 007) already
-- proved: durable state, claimed with SQL, so two Railway instances cannot
-- both act on the same row.
--
-- WHAT IS STORED. title and body are the notification text, so this table does
-- hold message previews. That is unavoidable for a queue whose whole job is to
-- deliver them later, and it is bounded: nothing sits here longer than
-- expires_at (30 minutes for a retry, 12 hours for a quiet-hours hold), the
-- sweep deletes on delivery, and the maintenance sweep deletes the expired.
CREATE TABLE IF NOT EXISTS push_outbox (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(16) NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- The data payload, verbatim. It carries the type and the ids the deep link
  -- is built from, and pushHelper re-runs the whole visibility gate against it
  -- when the row is released, so a recipient who left the flock, blocked the
  -- sender, or was banned in the meantime still gets nothing.
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The sweep's only query: what is due. Partial on nothing, because every row
-- in this table is due eventually and the table is bounded by its own expiry.
CREATE INDEX IF NOT EXISTS idx_push_outbox_due ON push_outbox (next_attempt_at);

-- ---------------------------------------------------------------------------
-- 3. push_debounce. The chat debounce, out of one process's heap.
--
-- Of the three debounces in the push path, exactly one was durable
-- (crowd_alert_sends, migration 007). The other two were in-heap Maps, which
-- means they do not exist the moment Railway runs two instances or an
-- overlapping deploy: each process holds its own window, so a message
-- debounced on instance A is sent again by instance B, and a restart clears
-- every window at once.
--
-- This is the durable half of the chat debounce. The in-heap Map stays in
-- front of it as a free local fast path; this table is what makes the window
-- true across instances. The key shape is unchanged
-- (`${userId}|${type}|${scope}`), so both layers agree on what a conversation
-- is.
--
-- sent_at is the whole row. A claim is an upsert that only wins when the
-- stored timestamp is older than the window, which is atomic in one statement
-- and needs no transaction.
CREATE TABLE IF NOT EXISTS push_debounce (
  debounce_key TEXT PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 4. device_tokens.timezone. The recipient's clock.
--
-- Quiet hours are meaningless without one. The server runs on UTC, and this
-- app's users are on the US east coast, so muting "02:00 to 08:00" on the
-- server's clock would mute 22:00 to 04:00 local, which is the entire night
-- out. It would delete the product's core hours to protect its dead ones.
--
-- The zone belongs on the DEVICE, not on the user, because the device is the
-- thing with a clock and the thing a notification arrives on. IANA name
-- ("America/New_York"), sent by frontend/src/services/firebase.js from
-- Intl.DateTimeFormat().resolvedOptions().timeZone at registration, which
-- happens on every sign-in, so a user who travels re-registers on arrival.
--
-- NULL means we do not know, and pushHelper treats "do not know" as "do not
-- defer". Guessing a zone and being six hours wrong holds a message for a
-- person who is wide awake; delivering one at a bad hour to a device that
-- predates this column costs one badly timed notification and self-corrects
-- the next time they open the app.
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
