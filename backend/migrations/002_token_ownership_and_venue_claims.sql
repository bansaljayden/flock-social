-- Device tokens: one physical device belongs to exactly ONE account.
-- The old UNIQUE(user_id, token) let the same APNs/FCM token stay attached to
-- multiple accounts after an account switch, delivering one account's private
-- push notifications to the other's device. Dedupe (keep the most recent
-- registration), then enforce global token uniqueness so the route's upsert
-- can transfer ownership atomically.
DELETE FROM device_tokens older
USING device_tokens newer
WHERE older.token = newer.token
  AND older.id < newer.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_device_tokens_token ON device_tokens (token);

-- Venue claims: only one VERIFIED owner per Google place. Without this, an
-- attacker could hold a second (unverified) claim on the same place id and,
-- combined with a place-id-only join, publish content as the verified venue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_profiles_verified_place
  ON venue_profiles (google_place_id)
  WHERE verified = true;
