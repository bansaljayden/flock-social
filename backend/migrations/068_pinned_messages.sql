-- 068: pinned messages. Shared pins, not the reference app's private save.
--
-- ASCII ONLY, for the reason 065 gives: the boot-safety test runs an embedded
-- server in WIN1252 and a box-drawing character in a comment fails the whole
-- migration with a character-set error.
--
-- components/chat/sheets/PinnedMessageBar.js was built, tested and exported
-- and nothing imported it, because the table it reads did not exist. Its own
-- header says "migration 066 adds the pinned_messages table"; 066 became the
-- flock reply and this table was never written, so the plan drifted from the
-- code and nothing tracked that it had. That note is corrected in the same
-- change as this file.
--
-- WHAT A PIN IS HERE. Decision 4 of the rebuild plan: Flock has SHARED pins.
-- Anyone in the thread can pin, up to three per flock, and the pin is visible
-- to everyone. That is deliberately not the private save the reference app
-- has: the thing a group needs to keep is the Venmo handle, the address, the
-- door code, and every one of those is worth keeping for the whole group
-- rather than for whoever thought to save it.
--
-- THE THREE IS NOT ENFORCED HERE. A CHECK cannot count rows in a sibling
-- group, and a trigger to do it would put the rule somewhere nobody looking at
-- the route would find it. routes/messages.js counts and refuses, and
-- __tests__/pinnedMessages.test.js pins that it does. This is the same reason
-- 067 left system_kind unconstrained: a rule the database enforces and the
-- route does not know about surfaces as a 23514 that the route turns into a
-- 500 on a feature nobody can reach.

CREATE TABLE IF NOT EXISTS pinned_messages (
  id SERIAL PRIMARY KEY,
  flock_id INTEGER NOT NULL REFERENCES flocks(id) ON DELETE CASCADE,
  -- CASCADE, so a pin cannot outlive the message it points at. Unsending a
  -- message takes its pin with it. Anything else leaves a bar at the top of
  -- the chat quoting a line the author withdrew, which is the same hole the
  -- flock reply's quote had to close on the read side.
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: a member leaving or deleting their account
  -- does not un-pin the group's Venmo handle. The pin belongs to the thread.
  pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One pin per message. Two people tapping Pin on the same message within a
-- second of each other is the ordinary case, not an edge one, and without this
-- it stores two rows that both draw and both have to be un-pinned separately.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pinned_messages_unique
  ON pinned_messages (flock_id, message_id);

-- The read is always "this flock's pins, oldest first", which is also the
-- order the bar pages through them in.
CREATE INDEX IF NOT EXISTS idx_pinned_messages_flock
  ON pinned_messages (flock_id, created_at);
