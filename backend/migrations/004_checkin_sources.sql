-- @noTransaction
-- 004: NFC check-in verification (round 8)
--
-- The public NFC GET stored every tap as source 'nfc', which feedback
-- verification trusts as proof of physical presence — so opening the URL in a
-- browser minted "verified" training-eligible feedback for any venue. Taps now
-- carry an HMAC signature (NFC_TAG_SECRET); unsigned taps are recorded as
-- 'nfc_unverified'. The CHECK constraint must admit the new value, and
-- feedback's trust rule flips to an allowlist in the route.
--
-- Round 12 (migration safety): this used to be a plain validating
-- ADD CONSTRAINT, which holds ACCESS EXCLUSIVE on venue_checkins for the whole
-- table scan — on a table an unauthenticated endpoint can grow (see
-- routes/checkin.js), and BEFORE the port opens, so a deploy could simply hang
-- with the app down. Split into ADD ... NOT VALID (metadata only, lock held for
-- microseconds) plus a separate VALIDATE CONSTRAINT, which takes only
-- SHARE UPDATE EXCLUSIVE and lets reads and writes continue during the scan.
-- @noTransaction keeps them in separate transactions — inside one, the ADD's
-- ACCESS EXCLUSIVE would be held until commit and the split would buy nothing.
--
-- Already recorded as applied on production; this shape is what fresh and
-- not-yet-migrated databases run.

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
  CHECK (checkin_source IN ('nfc', 'nfc_unverified', 'manual', 'gps')) NOT VALID;

ALTER TABLE venue_checkins
  VALIDATE CONSTRAINT venue_checkins_checkin_source_check;
