-- 087: the reply authors 083 gave out, given out again by a rule that holds.
--
-- ASCII only, like 065 and 082: the embedded server the boot-safety suite runs
-- is WIN1252.
--
-- WHAT 083 GOT WRONG. 083 added venue_reviews.venue_reply_user_id and gave
-- each reply written before the column existed to the place's verified owner
-- at the moment it ran, unless the reply was older than that owner's profile
-- or than the owner's LATEST venue_verified row. 083 never runs again (its
-- guard is the column it adds), so this file corrects what it wrote. Three
-- things were wrong with it:
--
--   1. The latest verification is not where an owner's claim began. PUT
--      /api/admin/venues/:profileId/verify writes a venue_verified row on every
--      success, a second one for a claim that is already verified included,
--      and an owner who moves a claim to another place and back loses the badge
--      without any row at all (routes/venueProfile.js resets verified on a
--      place change and writes nothing). Either way the owner's own replies
--      from before the newer row were left with no author: off the card, off
--      the owner's Reviews tab, and not erased if that account is deleted.
--   2. A reply with no timestamp skipped the date test and went to whoever was
--      verified that day. A reply has no timestamp because the review was
--      rewritten under it (submit-review retires it that way), so nothing says
--      when it was written, and a verified owner could be shown a previous
--      owner's words as their own earlier reply.
--   3. With no venue_verified row for the owner's claim, the comparison fell
--      back to the profile's created_at, which says nothing about when the
--      claim reached this place. A claim moved here, or verified before
--      migration 020 started writing those rows, took every reply dated after
--      its profile was made, a previous owner's included.
--
-- THE RULE, for one reply on one place:
--   * no timestamp: no author;
--   * no verified owner now, or no venue_verified row for its claim: no author;
--   * the owner's claim began at its earliest venue_verified after its latest
--     venue_unverified. A reply from before that has no author. An un-verify
--     is a decision that the claim did not hold, and nothing in the audit row
--     says which place an earlier verification was for.
--   * a reply at or after the owner's latest venue_verified is the owner's.
--     That part is exact: the claim has been verified on this place from that
--     row until now, because a place change or an un-verify would have needed
--     a newer verification to get the badge back.
--   * a reply after the claim began and before that latest row is the owner's,
--     unless another claim's own audit trail says it held a verification at
--     that moment. The badge can have been off in between with no row saying
--     so (the place change in 1), and only a verified claim on the place could
--     write a reply. "Another claim" is one still on this place, or one whose
--     profile no longer exists, so its place cannot be known. A previous
--     owner that moved its claim to a different place cannot be seen from
--     here, and a reply it wrote inside the current owner's claim is the one
--     case this rule can still give to the wrong account.
--
-- WHICH ROWS. Only the ones 083 could have written: a reply dated before 083's
-- applied_at in schema_migrations, and a reply with no date on a review
-- written before then. Every reply the reply route has written since carries
-- its real author, written in the same statement as the words, and is left
-- alone. That includes one retired since by a rewrite of its review, when the
-- review is newer than 083. A retired reply on an older review cannot be told
-- apart from one 083 gave out, so it loses its author: it is not published
-- either way, and the owner can reply again.
--
-- A reply stored between 083 and the code that writes authors (an old server
-- still answering during that deploy) is dated after 083 and has no author.
-- It is left as it is, unpublished, the same as before this file.
--
-- ONCE, AND WHY THE INDEX IS WHAT SAYS SO. The correction runs in the block
-- that builds the index below, and only when the index is not there yet, the
-- way 083's backfill runs only in the block that adds the column. A
-- schema_migrations row cannot carry that: __tests__/migrationBootSafety.test.js
-- wipes the table and replays every file over live data on purpose, a replay
-- records 083 again at that moment, every reply ever written is then "before
-- 083", and a reply the route attributed would be decided a second time
-- against whoever holds the place on the day of the replay. So the index must
-- not be dropped or renamed without something else taking over that job: the
-- boot-safety suite shows a replay without it emptying the route's replies.
--
-- The index is worth having for its own sake. Account deletion reads replies
-- by author twice: deleteAccount erases a deleted owner's replies WHERE
-- venue_reply_user_id is that account, and the foreign key's SET NULL looks
-- them up the same way. Both were scans of venue_reviews, and the erase runs
-- while the deletion holds the account's row. Partial, because most reviews
-- have no reply. A plain build inside this file's transaction, not
-- CONCURRENTLY: venue_reviews is small, and one transaction is what keeps the
-- correction and the marker of it from landing apart.
--
-- Default transactional mode (no directive line): all of it or none of it.

DO $$
DECLARE
  cutoff TIMESTAMPTZ;
BEGIN
  IF to_regclass('idx_venue_reviews_reply_user') IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT applied_at INTO cutoff
    FROM schema_migrations
   WHERE name = '083_venue_reply_author.sql';

  -- No 083 row means no reply was ever given out by it.
  IF cutoff IS NOT NULL THEN
    WITH owner AS (
      -- The place's verified owner now, where its claim began, and its
      -- latest verification. venue_profiles allows one verified claim per
      -- place (migration 002), so this is at most one row per place.
      SELECT vp.id AS profile_id,
             vp.user_id,
             vp.google_place_id,
             (SELECT MIN(v.created_at)
                FROM moderation_actions v
               WHERE v.action = 'venue_verified'
                 AND v.content_type = 'venue_profile'
                 AND v.content_id = vp.id
                 AND v.created_at > COALESCE(
                       (SELECT MAX(u.created_at)
                          FROM moderation_actions u
                         WHERE u.action = 'venue_unverified'
                           AND u.content_type = 'venue_profile'
                           AND u.content_id = vp.id),
                       '-infinity'::timestamptz)) AS claim_from,
             (SELECT MAX(v.created_at)
                FROM moderation_actions v
               WHERE v.action = 'venue_verified'
                 AND v.content_type = 'venue_profile'
                 AND v.content_id = vp.id) AS verified_last
        FROM venue_profiles vp
       WHERE vp.verified = true
         AND vp.user_id IS NOT NULL
         AND vp.google_place_id IS NOT NULL
    ),
    decided AS (
      SELECT vr.id,
             CASE
               WHEN vr.venue_replied_at IS NULL THEN NULL
               WHEN o.claim_from IS NULL OR vr.venue_replied_at < o.claim_from THEN NULL
               WHEN vr.venue_replied_at >= o.verified_last THEN o.user_id
               -- Inside the claim, before its latest verification: refused
               -- when another claim was verified at that moment by its own
               -- audit trail (its latest verify or un-verify at or before the
               -- reply is a verify).
               WHEN EXISTS (
                 SELECT 1
                   FROM (SELECT DISTINCT r.content_id AS profile_id
                           FROM moderation_actions r
                          WHERE r.action IN ('venue_verified', 'venue_unverified')
                            AND r.content_type = 'venue_profile'
                            AND r.content_id <> o.profile_id) rival
                   LEFT JOIN venue_profiles rp ON rp.id = rival.profile_id
                  WHERE (rp.id IS NULL OR rp.google_place_id = vr.google_place_id)
                    AND (SELECT l.action
                           FROM moderation_actions l
                          WHERE l.action IN ('venue_verified', 'venue_unverified')
                            AND l.content_type = 'venue_profile'
                            AND l.content_id = rival.profile_id
                            AND l.created_at <= vr.venue_replied_at
                          ORDER BY l.created_at DESC, l.id DESC
                          LIMIT 1) = 'venue_verified'
               ) THEN NULL
               ELSE o.user_id
             END AS author
        FROM venue_reviews vr
        LEFT JOIN owner o ON o.google_place_id = vr.google_place_id
       WHERE vr.venue_reply IS NOT NULL
         AND (vr.venue_replied_at < cutoff
              OR (vr.venue_replied_at IS NULL
                  AND (vr.created_at IS NULL OR vr.created_at < cutoff)))
    )
    UPDATE venue_reviews vr
       SET venue_reply_user_id = d.author
      FROM decided d
     WHERE vr.id = d.id
       AND vr.venue_reply_user_id IS DISTINCT FROM d.author;
  END IF;

  CREATE INDEX idx_venue_reviews_reply_user
    ON venue_reviews (venue_reply_user_id)
    WHERE venue_reply_user_id IS NOT NULL;
END $$;
