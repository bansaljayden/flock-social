-- 040: every venue tier now carries an END DATE, or an explicit statement that
-- it has none.
--
-- The hole this closes (VENUE-PRICING.md, "What gets comped, and for what"):
-- the founding-cohort offer is Roost free for SIX MONTHS in exchange for a
-- maintained slider habit, and the only way to grant a tier today is
-- POST /api/admin/venues/:userId/tier, which writes venue_profiles.tier and
-- nothing else. Nothing expires it. There is no billing side and no periodic
-- job, so comping fifteen venues for a six-month pilot creates fifteen
-- permanent free accounts and the mistake is invisible: no error, no alert,
-- just a tier that never ends. "We forgot to end the pilot" is a revenue hole
-- that opens quietly.
--
-- WHY A SIDE TABLE RATHER THAN TWO COLUMNS ON venue_profiles. VENUE-BILLING.md
-- already specifies the table Stripe will need (Architecture, "Schema"), and
-- specifies it with these exact columns. Building it now, with the comp path as
-- its first writer, means the Stripe work inherits a table instead of writing a
-- second migration to reshape one: a webhook fills in the stripe_* columns,
-- status, current_period_end and trial_end, sets source='stripe', and every
-- gate in the product already reads the answer.
--
-- ONE EXPIRY COLUMN, DELIBERATELY. expires_at is the single date the resolver
-- compares against, whatever wrote the row. A Stripe subscription writes its
-- period end into BOTH current_period_end (the raw fact from Stripe, kept for
-- the billing UI and for reconciliation) and expires_at (the entitlement
-- decision, which is period end plus whatever grace the status implies). Two
-- columns that both mean "when does this stop" is how one of them goes stale.
--
-- NULL expires_at means NO EXPIRY, and it stays legal: a paying subscriber in
-- good standing, or a deliberately permanent grant, has no end date. The point
-- is not that everything expires, it is that "forever" has to be said out loud.
--
-- NOTHING IN HERE ENFORCES ANYTHING. There is no trigger and no scheduled job
-- on purpose: expiry is evaluated at READ time in services/venueEntitlements.js,
-- so a grant that lapsed at 03:00 is refused at 03:00:01 by the next request
-- rather than whenever a sweep next runs.

CREATE TABLE IF NOT EXISTS venue_subscriptions (
  -- One row per venue owner. PRIMARY KEY, not merely UNIQUE: a venue has one
  -- entitlement at a time, and the admin route and the future webhook both
  -- upsert on it.
  user_id                INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- The tier this grant confers. Same vocabulary as venue_profiles.tier and as
  -- TIER_ORDER in services/venueEntitlements.js (free | premium | pro); an
  -- unrecognised value normalises to free at read time rather than opening a
  -- gate, so this is not constrained here.
  tier                   VARCHAR(20)  NOT NULL DEFAULT 'free',

  -- Where the entitlement came from. 'comp' and 'admin' are the only two that
  -- can exist today; 'stripe' is written by the webhook when it lands.
  source                 VARCHAR(20)  NOT NULL DEFAULT 'admin',

  -- Stripe's subscription status vocabulary, used from day one so the webhook
  -- has nothing to translate: active | trialing | past_due keep the tier,
  -- canceled | unpaid | incomplete | incomplete_expired | paused revoke it.
  -- Anything unrecognised revokes it too (fail closed).
  status                 VARCHAR(32)  NOT NULL DEFAULT 'active',

  -- WHY this venue holds this tier, in a machine-readable code:
  -- 'founding_comp' (the six-month first-city cohort), 'paid', 'admin', 'demo'.
  -- The human sentence stays where every other admin action's reason lives, in
  -- moderation_actions.
  granted_reason         VARCHAR(40),

  granted_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  granted_by             INTEGER      REFERENCES users(id) ON DELETE SET NULL,

  -- THE COLUMN THE WHOLE MIGRATION IS FOR. NULL = no end date.
  expires_at             TIMESTAMPTZ,

  -- Stripe's side. Unwritten until VENUE-BILLING.md's Stripe phase ships; here
  -- now so that phase is a webhook and a route, not another migration.
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id        TEXT,
  current_period_end     TIMESTAMPTZ,
  cancel_at              TIMESTAMPTZ,
  trial_end              TIMESTAMPTZ,

  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One Stripe subscription cannot back two venue accounts. Partial, because
-- every row written before Stripe exists leaves this NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_subscriptions_stripe_sub
  ON venue_subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- "Which comps end this month" is the question an operator asks, and the answer
-- has to be cheap enough that asking it is a habit. Partial for the same reason
-- as above: rows with no end date are not part of that answer.
CREATE INDEX IF NOT EXISTS idx_venue_subscriptions_expires_at
  ON venue_subscriptions(expires_at)
  WHERE expires_at IS NOT NULL;

-- BACKFILL, and it is deliberately generous. Every venue already holding a paid
-- tier got it by hand from an admin with no end date agreed, so writing one now
-- would be inventing a promise nobody made and revoking access on a schedule
-- the owner never heard. They come across as permanent grants
-- (expires_at NULL) with a reason that says exactly what they are, and an
-- operator who wants one of them to end can now say so.
--
-- The alternative — leaving them with no row at all — also works, because the
-- resolver falls back to venue_profiles.tier when no grant exists. This is
-- written anyway so that "which venues hold a paid tier, and until when" has
-- ONE table to read instead of two, from the first day the table exists.
INSERT INTO venue_subscriptions (user_id, tier, source, status, granted_reason, granted_at, expires_at)
SELECT vp.user_id, vp.tier, 'admin', 'active', 'legacy_grant', COALESCE(vp.updated_at, NOW()), NULL
  FROM venue_profiles vp
 WHERE vp.tier IN ('premium', 'pro')
ON CONFLICT (user_id) DO NOTHING;
