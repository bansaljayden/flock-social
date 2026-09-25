-- 083: who wrote the business's reply to a review.
--
-- WHY. venue_reviews.venue_reply held the words and nothing about whose they
-- were. POST /api/venue-dashboard/reviews/:id/reply lets only the account that
-- is verified at that moment write one, but GET /public-reviews/:placeId
-- published the text whenever ANY verified, unbanned claim existed on the
-- place. So when verification moved (an admin un-verifies account A and
-- verifies account B on the same Google place, or A re-points its claim, or A
-- deletes its account), A's reply stayed on the card as the business, under
-- B's badge, and B's own Reviews tab showed A's words as B's.
--
-- WHAT IT ADDS. venue_reply_user_id, written by the reply route in the same
-- statement as the text. A reply is published, and read back on the owner's
-- tab, only while that account is the place's current verified owner and is
-- not banned. ON DELETE SET NULL: the review belongs to the reviewer, so it
-- stays when the replier's account goes, and a reply with no author is
-- published by nobody.
--
-- THE BACKFILL, AND WHY IT RUNS ONCE. A reply written before this column has
-- no recorded author. Each one is given to the place's verified owner at the
-- moment this file first runs, which is exactly who the card already credits
-- it to, so nothing a user sees moves on the deploy. It is skipped when the
-- reply provably predates that owner's claim: older than their profile, or
-- older than the most recent admin verification of it in moderation_actions.
-- Anything it cannot give to anyone stays NULL, and stays unpublished.
-- The column and the backfill live in one guarded block, so the backfill runs
-- only on the application that creates the column. A replay (which
-- __tests__/migrationBootSafety.test.js performs over live data on purpose)
-- finds the column and does nothing, so a reply left unattributed today can
-- never be handed to whoever holds the place on the day of a replay.
-- @requires column venue_reviews.venue_reply_user_id

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'venue_reviews'::regclass
       AND attname = 'venue_reply_user_id'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE venue_reviews
      ADD COLUMN venue_reply_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

    UPDATE venue_reviews vr
       SET venue_reply_user_id = vp.user_id
      FROM venue_profiles vp
     WHERE vr.venue_reply IS NOT NULL
       AND vp.google_place_id = vr.google_place_id
       AND vp.verified = true
       AND vp.user_id IS NOT NULL
       AND (
         vr.venue_replied_at IS NULL
         OR vr.venue_replied_at >= GREATEST(
              vp.created_at,
              (SELECT MAX(ma.created_at)
                 FROM moderation_actions ma
                WHERE ma.action = 'venue_verified'
                  AND ma.content_type = 'venue_profile'
                  AND ma.content_id = vp.id)
            )
       );
  END IF;
END $$;
