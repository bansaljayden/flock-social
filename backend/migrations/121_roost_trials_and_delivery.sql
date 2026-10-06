-- 121: a Roost trial stays used after the account that used it is deleted,
-- and a Roost subscription records when it was first served.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY, THE TRIAL. Terms 9.6 promise "14 days free, once per venue", and the
-- trial was decided from venue_stripe_subscriptions and venue_subscriptions,
-- both keyed on the owner's account and both ON DELETE CASCADE. An owner who
-- took the trial, deleted the account and claimed the same listing from a new
-- one found no record of it, and the new Stripe customer had no history
-- either, so every deletion bought another 14 days (billing review
-- 2026-10-06). roost_trial_listings holds one row per Google listing a Roost
-- subscription has ever been bought for, written by the Stripe writer whenever
-- it binds a subscription to a listing (services/venueBilling.js), and read
-- with the rest of the trial record by checkout and the status route.
--
-- NO ACCOUNT IN IT. A Google place id names a business listing, not a person,
-- and first_seen_at is a date, so nothing here follows an account deletion.
-- Outliving the account is the whole point, the way 118's endings do.
--
-- WHY, served_at. A completed checkout is checked against the claim again at
-- fulfillment, and a purchase against a claim no longer verified for its
-- listing is cancelled and its payment refunded. Fulfillment can run again
-- (the owner's return reopened, a confirm sent by hand with an old session
-- id, Stripe resending checkout.session.completed), and it judged the claim
-- as it was at that moment, so a purchase delivered for months was refunded
-- once the claim had moved on. venue_stripe_subscriptions.served_at is set the
-- first time the writer serves the subscription, and fulfillment never
-- refuses or refunds a subscription that has been served.
--
-- BACKFILL. Every listing already on record goes into roost_trial_listings;
-- the insert skips what is there, so a replay changes nothing. served_at is
-- not backfilled: no Roost subscription has been sold through Stripe yet, so
-- there is nothing it could be set from.
--
-- WHERE 040 HAS NOT RUN. __tests__/migrationBootSafety.test.js applies every
-- file but 040 to an empty database first, so the venue_subscriptions half of
-- the backfill is skipped where that table does not exist (119 does the same).
-- @requires table roost_trial_listings
-- @requires column venue_stripe_subscriptions.served_at
CREATE TABLE IF NOT EXISTS roost_trial_listings (
  google_place_id VARCHAR(255) PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE venue_stripe_subscriptions ADD COLUMN IF NOT EXISTS served_at TIMESTAMPTZ;

INSERT INTO roost_trial_listings (google_place_id, first_seen_at)
SELECT google_place_id, MIN(first_seen_at)
  FROM venue_stripe_subscriptions
 WHERE google_place_id IS NOT NULL
 GROUP BY google_place_id
ON CONFLICT (google_place_id) DO NOTHING;

DO $$ BEGIN
  IF to_regclass('venue_subscriptions') IS NOT NULL THEN
    INSERT INTO roost_trial_listings (google_place_id, first_seen_at)
    SELECT google_place_id, MIN(granted_at)
      FROM venue_subscriptions
     WHERE stripe_subscription_id IS NOT NULL
       AND google_place_id IS NOT NULL
     GROUP BY google_place_id
    ON CONFLICT (google_place_id) DO NOTHING;
  END IF;
END $$;
