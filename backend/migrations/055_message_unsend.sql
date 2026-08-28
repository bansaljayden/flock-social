-- Unsend. A sent message could never be taken back: no route deleted a
-- message in either chat, so a wrong-thread paste or a regretted photo was
-- permanent. The column is a sender-owned tombstone, NOT a delete, for the
-- same reason owner-deleted promotions retire instead of vanishing
-- (migration 020): a reported message is evidence, and the one person with a
-- motive to destroy it must not be able to. History and live reads exclude
-- tombstoned rows; the moderation evidence routes, which deliberately read
-- through is_hidden, read through this the same way.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_deleted_at TIMESTAMPTZ;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS sender_deleted_at TIMESTAMPTZ;
