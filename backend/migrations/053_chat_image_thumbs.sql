-- Chat photos are stored and served as full ~700KB base64 data URLs, inline in
-- every history page, and the app renders them at most 260px wide with no zoom
-- viewer, so nearly all of those bytes are waste the reader pays for on every
-- thread open. The client now sends a small thumbnail alongside the full image
-- (both derived from the same bytes on the sender's phone, both moderated);
-- history serves the thumbnail and withholds the full image when one exists.
-- The full image stays stored for a future full-size viewer. Rows from before
-- this migration have no thumbnail and history serves them exactly as before.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thumb_url TEXT;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS thumb_url TEXT;
