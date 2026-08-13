-- 004: NFC check-in verification (round 8)
--
-- The public NFC GET stored every tap as source 'nfc', which feedback
-- verification trusts as proof of physical presence — so opening the URL in a
-- browser minted "verified" training-eligible feedback for any venue. Taps now
-- carry an HMAC signature (NFC_TAG_SECRET); unsigned taps are recorded as
-- 'nfc_unverified'. The CHECK constraint must admit the new value, and
-- feedback's trust rule flips to an allowlist in the route.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'venue_checkins' AND constraint_name = 'venue_checkins_checkin_source_check'
  ) THEN
    ALTER TABLE venue_checkins DROP CONSTRAINT venue_checkins_checkin_source_check;
  END IF;
END $$;

ALTER TABLE venue_checkins
  ADD CONSTRAINT venue_checkins_checkin_source_check
  CHECK (checkin_source IN ('nfc', 'nfc_unverified', 'manual', 'gps'));
