-- 119: a Roost grant belongs to one venue, and every Roost subscription is
-- kept on record.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. venue_subscriptions is keyed on the owner's ACCOUNT, and a Roost
-- subscription's Stripe metadata named only the account, while the venue an
-- account claims can change: PUT /api/venue-profile re-points the claim at
-- another Google listing and resets verified. An owner could subscribe for
-- venue A, re-point the claim at venue B, get B verified, and B was served the
-- Roost that A's subscription paid for (billing review 2026-10-06). Comps had
-- the same shape: a founding comp given to one venue followed the account to
-- the next.
--
-- venue_subscriptions.google_place_id is the listing the grant was bought or
-- given for. The resolver (services/venueEntitlements.js) serves a grant only
-- while the claim still names that listing, the Stripe writer raises the tier
-- cache only for it, and the admin comp route writes it from the claim it
-- comps. NULL is a grant from before this column, or for a claim with no
-- listing, and is served as it always was.
--
-- venue_stripe_subscriptions records every Roost subscription the Stripe
-- writer has ever seen: whose account it was for, its Stripe customer, and
-- the listing it is bound to. The binding is the place in the subscription's
-- metadata (flock_venue_place_id, which checkout writes and an operator may
-- change to move a plan between listings) or, for a subscription made by hand
-- without it, the listing the claim named when the subscription first arrived.
-- It is what decides one trial per venue (any row for the listing, or for the
-- account, means the trial was used), and which Stripe customers an account
-- has to have closed before it can be deleted.
--
-- BACKFILL. Existing grants are bound to the listing their claim names today.
-- Roost has not been sold through Stripe yet and a comp is only given to a
-- verified claim, so that is the listing each grant was given for, short of a
-- claim re-pointed since, which nothing on file can tell apart. Rows that
-- already name a subscription are copied into the record.
--
-- DELETION. venue_stripe_subscriptions.user_id is ON DELETE CASCADE: the row
-- describes one account's billing and leaves with it.
--
-- WHERE 040 HAS NOT RUN. __tests__/migrationBootSafety.test.js holds 040 back
-- and applies every other file to an empty database first, so the
-- venue_subscriptions half of this file is skipped where that table does not
-- exist, and runs on the replay that follows. On a real database 040 sorts
-- first and has run, so the half always runs. That is also why only the new
-- table is declared below: a requirement on the column could not be met in
-- that first pass.
-- @requires table venue_stripe_subscriptions
ALTER TABLE IF EXISTS venue_subscriptions ADD COLUMN IF NOT EXISTS google_place_id VARCHAR(255);

DO $$ BEGIN
  IF to_regclass('venue_subscriptions') IS NOT NULL THEN
    UPDATE venue_subscriptions vs
       SET google_place_id = vp.google_place_id
      FROM venue_profiles vp
     WHERE vp.user_id = vs.user_id
       AND vs.google_place_id IS NULL
       AND vp.google_place_id IS NOT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS venue_stripe_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  google_place_id VARCHAR(255),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_venue_stripe_subscriptions_user
  ON venue_stripe_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_venue_stripe_subscriptions_place
  ON venue_stripe_subscriptions (google_place_id)
  WHERE google_place_id IS NOT NULL;

DO $$ BEGIN
  IF to_regclass('venue_subscriptions') IS NOT NULL THEN
    INSERT INTO venue_stripe_subscriptions (stripe_subscription_id, user_id, stripe_customer_id, google_place_id, first_seen_at)
    SELECT vs.stripe_subscription_id, vs.user_id, vs.stripe_customer_id, vs.google_place_id, vs.granted_at
      FROM venue_subscriptions vs
     WHERE vs.stripe_subscription_id IS NOT NULL
    ON CONFLICT (stripe_subscription_id) DO NOTHING;
  END IF;
END $$;
