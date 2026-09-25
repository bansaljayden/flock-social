'use strict';
// ---------------------------------------------------------------------------
// ROOST ON THE WEB: Stripe Checkout for venues, written straight into the
// venue grant table.
//
// THE SHAPE, AND HOW IT DIFFERS FROM FLOCK PRO. Consumer Pro is sold in two
// stores (Apple and Stripe), so its one record is RevenueCat's
// (services/proBilling.js). Roost is sold in ONE place, flockcorp.com, and it
// already has a record built for exactly this: venue_subscriptions (migration
// 040), whose columns are Stripe's own and whose statuses are Stripe's own
// vocabulary. So there is no third party in the middle here. The signed Stripe
// webhook re-reads the subscription from Stripe and this file writes it into
// that row, and every gate in the product (services/venueEntitlements.js)
// already resolves the answer from it, expiry included, on every request.
//
// ONE WRITER, AUDITED. syncVenueSubscription is the only code that writes a
// Stripe-sourced grant. Like the admin comp route, it writes the grant, the
// venue_profiles.tier cache and the moderation_actions audit row in ONE
// statement, so the three cannot half-agree. moderator_id is NULL on those
// audit rows: nobody on the team decided it, the customer's payment did.
//
// THE RULE THAT COSTS MONEY IF MISSED (VENUE-BILLING.md, stated three times
// there): a paid tier requires venue_profiles.verified = true. Checkout
// refuses an unverified claim before Stripe is ever called, and the writer
// below keeps the cache at 'free' for an unverified profile even if a
// subscription somehow exists, so the resolver (which takes the lower of the
// cache and the grant) never serves Roost to a claim nobody has confirmed.
//
// METADATA. Every session and subscription carries kind='venue' and
// flock_venue_user_id. Deliberately NOT app_user_id: RevenueCat's Stripe
// integration tracks every purchase on this Stripe account and attributes it
// by that key, and a Roost subscription attributed to an app user would be
// recorded there as that person's consumer purchase. The webhook routes on
// kind, so the Pro path never sees a venue event.
//
// OFF UNTIL EVERY PART EXISTS. checkoutState() is ready only when venue
// billing is switched on (VENUE_BILLING_ENABLED, which also turns the tier
// gates on), Stripe has a key, the monthly Roost price is configured, and the
// webhook secret is set, because without the webhook a trial that converts,
// a card that fails or a cancellation would never reach the grant.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const billing = require('./proBilling');
const { venueBillingEnabled, getVenueEntitlement } = require('./venueEntitlements');
const roostNotice = require('./roostNotice');
const { longDate } = require('../templates/roostNoticeEmail');

const KIND = 'venue';
// 'pro' is Roost's stored name. There are two plans, a free venue account and
// Roost (VENUE-PRICING.md section 4), and every Roost surface is gated at
// 'pro', so this grant opens all of them.
const ROOST_TIER = 'pro';
// VENUE-PRICING.md: 14-day self-serve trial, card required.
const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// Stripe refuses a Checkout trial_end less than 48 hours out. A notice date
// closer than that is moved to just past it: later than promised is allowed,
// earlier is not.
const STRIPE_MIN_TRIAL_MS = 48 * 60 * 60 * 1000 + 10 * 60 * 1000;
// A paid-up subscription stays open for three days past its period end, so a
// renewal webhook that arrives late does not lock a paying venue out at
// midnight. A missed webhook still cannot grant forever: the next period only
// starts when Stripe says it did.
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
// Stripe statuses that keep the tier. Same set as GRANT_LIVE_STATUSES in
// venueEntitlements.js, which is what the resolver applies.
const KEEP_STATUSES = new Set(['active', 'trialing', 'past_due']);
// A subscription already running, so a second checkout would bill twice. NOT
// 'incomplete', for the reason proBilling.js gives.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

function plain(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// Read by name, in the literal form, so the environment inventory test can see
// what this file depends on.
function roostPrices() {
  const plans = {};
  const monthly = plain(process.env.STRIPE_PRICE_ROOST_MONTHLY);
  const yearly = plain(process.env.STRIPE_PRICE_ROOST_YEARLY);
  if (monthly) plans.monthly = monthly;
  if (yearly) plans.yearly = yearly;
  return plans;
}

// Prices no longer sold that existing subscribers are still billed on, comma
// separated. Replacing STRIPE_PRICE_ROOST_MONTHLY or _YEARLY with a new price
// moves every venue on the old one here, not onto the new one: Terms 9.6 says
// a new price applies to a plan only after 30 days' notice, so until Stripe
// moves them the old id has to keep meaning Roost.
function legacyRoostPrices() {
  const raw = plain(process.env.STRIPE_PRICE_ROOST_LEGACY);
  return raw ? raw.split(',').map((id) => id.trim()).filter(Boolean) : [];
}

// Every price a Roost subscription may legitimately be on. The founding-cohort
// rate (VENUE-PRICING.md: $59/month locked for 24 months) is its own Stripe
// Price, sold by hand, so it is recognised here without being offered at
// checkout, and so are the retired prices above.
function recognisedPrices() {
  const set = new Set(Object.values(roostPrices()));
  const founding = plain(process.env.STRIPE_PRICE_ROOST_FOUNDING);
  if (founding) set.add(founding);
  for (const id of legacyRoostPrices()) set.add(id);
  return set;
}

function checkoutState() {
  const missing = [];
  if (!venueBillingEnabled()) missing.push('VENUE_BILLING_ENABLED');
  if (!billing.stripeConfigured()) missing.push('STRIPE_SECRET_KEY');
  if (!roostPrices().monthly) missing.push('STRIPE_PRICE_ROOST_MONTHLY');
  if (!billing.stripeWebhookConfigured()) missing.push('STRIPE_WEBHOOK_SECRET');
  return { ready: missing.length === 0, missing };
}

const stripe = () => billing.stripeClient();

function refusal(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function venueUserIdFrom(metadata) {
  const raw = metadata && typeof metadata.flock_venue_user_id === 'string' ? metadata.flock_venue_user_id.trim() : '';
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 2147483647 ? n : null;
}

function isVenueObject(obj) {
  return !!(obj && obj.metadata && obj.metadata.kind === KIND);
}

// ---------------------------------------------------------------------------
// Customers and sessions
// ---------------------------------------------------------------------------

async function venueProfileFor(userId) {
  const r = await pool.query(
    'SELECT id, verified, business_name, stripe_customer_id FROM venue_profiles WHERE user_id = $1',
    [userId]
  );
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  return rows[0] || null;
}

async function venueCustomerIdFor(userId) {
  const r = await pool.query('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1', [userId]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  return rows[0] ? rows[0].stripe_customer_id || null : null;
}

// Account deletion. Deleting the customer cancels its Roost subscription at
// once. THROWS if Stripe would not do it, so routes/users.js can refuse the
// deletion instead of leaving a card being billed for a venue that is gone.
//
// "Would not do it" includes Stripe not being reachable at all. closeCustomer
// answers false rather than throwing when STRIPE_SECRET_KEY is missing or too
// short, and this returned that false to a caller that never read it, so the
// account was deleted, the customer id went with the venue row, and Stripe
// went on billing a venue nobody could cancel from inside Flock. A customer on
// file that was not closed is a refusal now. No customer on file is still an
// ordinary false: there is nothing to cancel.
async function closeVenueCustomer(userId) {
  const customerId = await venueCustomerIdFor(userId);
  if (!customerId) return false;
  const closed = await billing.closeCustomer(customerId);
  if (!closed) {
    throw refusal(503, `Roost Stripe customer ${customerId} was not cancelled; Stripe is not configured`, 'STRIPE_NOT_CONFIGURED');
  }
  await pool.query(
    'UPDATE venue_profiles SET stripe_customer_id = NULL WHERE user_id = $1 AND stripe_customer_id = $2::text',
    [userId, customerId]
  );
  return true;
}

// The venue's Stripe customer, created once. Same idempotency reasoning as
// proBilling.ensureCustomer, with its own key prefix so the two products can
// never be handed each other's customer.
async function ensureVenueCustomer(user, profile) {
  if (profile.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe().customers.create({
    email: user.email || undefined,
    name: profile.business_name || user.name || undefined,
    metadata: { kind: KIND, flock_venue_user_id: String(user.id) },
  }, { idempotencyKey: `flock-venue-customer-${user.id}-${Math.floor(Date.now() / 3600e3)}` });
  const r = await pool.query(
    `UPDATE venue_profiles SET stripe_customer_id = $1
      WHERE user_id = $2 AND stripe_customer_id IS NULL
      RETURNING stripe_customer_id`,
    [customer.id, user.id]
  );
  if (r.rows[0]) return r.rows[0].stripe_customer_id;
  return venueCustomerIdFor(user.id);
}

async function hasLiveSubscription(customerId) {
  const list = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  return list.data.some((s) => LIVE_STATUSES.has(s.status));
}

// One trial per venue. A customer who has ever held a Roost subscription, in
// any state, has had theirs.
async function hasEverSubscribed(customerId) {
  const list = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 1 });
  return list.data.length > 0;
}

// Only the newest checkout can ever be paid; see proBilling.expireOpenSessions
// for why a session that will not expire blocks a second one.
async function expireOpenSessions(customerId) {
  const open = await stripe().checkout.sessions.list({ customer: customerId, status: 'open', limit: 20 });
  for (const s of open.data) {
    try {
      await stripe().checkout.sessions.expire(s.id);
    } catch (err) {
      const again = await stripe().checkout.sessions.retrieve(s.id).catch(() => null);
      if (!again || again.status === 'open') {
        throw refusal(409, 'A Roost checkout is already open. Finish it, or wait a minute and try again.', 'CHECKOUT_IN_PROGRESS');
      }
    }
  }
}

// ONE ROOST CHECKOUT BEING BUILT PER ACCOUNT AT A TIME. Expiring the open
// sessions, checking for a live subscription and creating the session are
// separate Stripe calls, and two requests that interleave them (a double
// click, two tabs) could each create a session after the other's expire step:
// two payable sessions, two subscriptions, one venue billed twice. Flock Pro
// queued its builds through proBilling.withCheckoutLock from the start and
// this path did not. It goes through the same queue now, under a key of its
// own, so a venue's Roost builds run one after the other and the second
// expires the session the first one made. A Pro checkout by the same person is
// on a different Stripe customer and cannot double-bill a Roost one, so the
// two products do not wait on each other.
function createVenueCheckout(user, plan) {
  return billing.withCheckoutLock(`venue:${user && user.id}`, () => buildVenueCheckout(user, plan));
}

async function buildVenueCheckout(user, plan) {
  const priceId = roostPrices()[plan];
  if (!priceId) throw refusal(400, 'That plan is not offered.');
  const profile = await venueProfileFor(user.id);
  if (!profile) throw refusal(404, 'There is no venue on this account.', 'NO_VENUE');
  if (profile.verified !== true) {
    throw refusal(409, 'Your venue has to be verified before Roost can be bought. Settings has the request.', 'VENUE_NOT_VERIFIED');
  }
  // A venue already holding a live paid grant from us (a founding comp, a
  // hand-sold plan) must not be walked into a second, paid one on top. The
  // GRANT decides this, not the served tier: a venue inside its notice window
  // is served everything and still needs to be able to buy the plan that
  // keeps it after the window.
  const ent = await getVenueEntitlement(user.id);
  if (ent.paidTier !== 'free') {
    if (ent.source === 'stripe') throw refusal(409, 'You already have Roost. Manage it from billing.', 'ALREADY_SUBSCRIBED');
    throw refusal(409, 'Your plan is already covered. Write to us if you want to switch to paying for it.', 'PLAN_ALREADY_GRANTED');
  }
  const customerId = await ensureVenueCustomer(user, profile);
  await expireOpenSessions(customerId);
  if (await hasLiveSubscription(customerId)) {
    throw refusal(409, 'You already have Roost. Manage it from billing.', 'ALREADY_SUBSCRIBED');
  }
  const trial = !(await hasEverSubscribed(customerId));
  // THE NOTICE FLOOR. A venue account from before Roost had a price is not
  // charged before the date its notice email named (Terms 9.6,
  // services/roostNotice.js). If the notice has not gone out yet it is sent
  // now, so the window has an end; if it cannot be sent, the floor is 30 days
  // from now, which is never earlier than a notice sent now would have named.
  // Inside the window this applies even to a venue that has had its trial.
  let noticeFloor = 0;
  if (ent.inNoticeWindow) {
    const named = ent.noticeUntil ? Date.parse(ent.noticeUntil) : NaN;
    if (Number.isFinite(named)) {
      noticeFloor = named;
    } else {
      const sent = await roostNotice.sendNoticeForCheckout(user.id).catch((err) => {
        console.error(`[venue-billing] notice for venue user ${user.id} could not be sent at checkout:`, err && err.message);
        return null;
      });
      noticeFloor = sent ? sent.getTime() : Date.now() + roostNotice.NOTICE_MS;
    }
  }
  const trialEndMs = noticeFloor
    ? Math.max(noticeFloor, trial ? Date.now() + TRIAL_DAYS * DAY_MS : 0, Date.now() + STRIPE_MIN_TRIAL_MS)
    : 0;
  const price = await billing.describePrice(priceId);
  const every = price.interval === 'year' ? 'year' : 'month';
  const tax = billing.taxEnabled();
  const web = billing.webBase();
  const meta = { kind: KIND, flock_venue_user_id: String(user.id), plan };
  // NO client_reference_id. RevenueCat's Stripe integration reads a Checkout
  // Session's client_reference_id as the app user id, exactly as it reads
  // app_user_id in metadata (the header of this file says why that key is kept
  // off), so a Roost session carrying the Flock user id there could be
  // imported as that person's consumer purchase. Nothing on the venue side
  // reads it: the webhook and the confirm route both take the account from
  // flock_venue_user_id in the metadata.
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: meta,
    // Session metadata does not reach the subscription, and the webhook reads
    // the subscription, so it is written on both.
    subscription_data: {
      metadata: meta,
      ...(trialEndMs ? {
        trial_end: Math.ceil(trialEndMs / 1000),
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      } : trial ? {
        trial_period_days: TRIAL_DAYS,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      } : {}),
    },
    // Card required even for the trial (VENUE-PRICING.md).
    payment_method_collection: 'always',
    automatic_tax: { enabled: tax },
    ...(tax ? { customer_update: { address: 'auto', name: 'auto' }, billing_address_collection: 'required' } : {}),
    allow_promotion_codes: false,
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: {
        message: `I agree that Roost ${trialEndMs ? `is free until ${longDate(trialEndMs)}, then ` : trial ? `is free for ${TRIAL_DAYS} days, then ` : ''}renews at ${billing.formatAmount(price)}${tax ? ' plus tax' : ''} every ${every} until I cancel, and to the [Terms](${web}/terms).`,
      },
    },
    success_url: `${web}/app?venue_billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${web}/app?venue_billing=cancelled`,
  });
  return session.url;
}

async function createVenuePortal(userId) {
  const customerId = await venueCustomerIdFor(userId);
  if (!customerId) throw refusal(404, 'There is no Roost subscription on this account.', 'NO_WEB_SUBSCRIPTION');
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${billing.webBase()}/app?venue_billing=manage`,
  });
  return session.url;
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

function toDate(unixSeconds) {
  return Number.isFinite(unixSeconds) && unixSeconds > 0 ? new Date(unixSeconds * 1000) : null;
}

// What one Stripe subscription means for the grant. Pure, so a test can walk
// every status through it. unknownPriceIsRoost is for a subscription Stripe is
// still billing on a price missing from the configuration (see
// syncVenueSubscription): it counts that price as Roost.
function grantFromSubscription(sub, now = Date.now(), { unknownPriceIsRoost = false } = {}) {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const priceId = item && item.price ? item.price.id : null;
  const priceOk = !!priceId && (unknownPriceIsRoost || recognisedPrices().has(priceId));
  // current_period_end moved onto the item in recent API versions; the
  // subscription-level field is the older home.
  const periodEnd = toDate(item && item.current_period_end) || toDate(sub.current_period_end);
  const live = KEEP_STATUSES.has(sub.status) && priceOk;
  let expiresAt;
  if (live) {
    // Never NULL for a Stripe grant: NULL means "no end date" to the
    // resolver, and a subscription always has one.
    expiresAt = new Date((periodEnd ? periodEnd.getTime() : now) + GRACE_MS);
  } else {
    expiresAt = periodEnd && periodEnd.getTime() < now ? periodEnd : new Date(now);
  }
  return {
    live,
    priceOk,
    priceId,
    status: typeof sub.status === 'string' ? sub.status.slice(0, 32) : 'unknown',
    grantTier: priceOk ? ROOST_TIER : 'free',
    cachedTier: live ? ROOST_TIER : 'free',
    expiresAt,
    periodEnd,
    cancelAt: toDate(sub.cancel_at),
    trialEnd: toDate(sub.trial_end),
  };
}

// ONE STATEMENT: the grant, the cache and the audit row, the same three the
// admin comp route writes together.
//
//   granted  upserts the grant, EXCEPT when the row already belongs to a
//            different subscription that is still live and this one is dead:
//            the deleted event of an old subscription arriving after a new one
//            started must not revoke the new one. Every event re-reads Stripe,
//            so the same subscription always writes its current state.
//   upd      moves the cache only when it changes, only when the grant was
//            written, and never to a paid tier for an unverified profile.
//   audit    one tier_changed row per actual change, none per renewal.
const SYNC_SQL = `WITH old AS (
    SELECT user_id, tier, verified FROM venue_profiles WHERE user_id = $1::int
  ),
  granted AS (
    INSERT INTO venue_subscriptions
      (user_id, tier, source, status, granted_reason, granted_at, granted_by, expires_at,
       stripe_customer_id, stripe_subscription_id, stripe_price_id, current_period_end, cancel_at, trial_end, updated_at)
    SELECT $1::int, $2::text, 'stripe', $3::text, 'paid', NOW(), NULL, $4::timestamptz,
           $5::text, $6::text, $7::text, $8::timestamptz, $9::timestamptz, $10::timestamptz, NOW()
      FROM old
    ON CONFLICT (user_id) DO UPDATE SET
      tier = EXCLUDED.tier,
      source = 'stripe',
      status = EXCLUDED.status,
      granted_reason = 'paid',
      granted_at = CASE WHEN venue_subscriptions.stripe_subscription_id IS DISTINCT FROM EXCLUDED.stripe_subscription_id
                        THEN NOW() ELSE venue_subscriptions.granted_at END,
      granted_by = NULL,
      expires_at = EXCLUDED.expires_at,
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      stripe_price_id = EXCLUDED.stripe_price_id,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at = EXCLUDED.cancel_at,
      trial_end = EXCLUDED.trial_end,
      updated_at = NOW()
    WHERE venue_subscriptions.stripe_subscription_id IS NULL
       OR venue_subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id
       OR $11::boolean
       OR venue_subscriptions.status NOT IN ('active', 'trialing', 'past_due')
    RETURNING user_id
  ),
  upd AS (
    UPDATE venue_profiles SET tier = $12::text, updated_at = NOW()
      FROM old
     WHERE venue_profiles.user_id = old.user_id
       AND EXISTS (SELECT 1 FROM granted)
       AND old.tier IS DISTINCT FROM $12::text
       AND ($12::text = 'free' OR old.verified = true)
    RETURNING venue_profiles.id, venue_profiles.tier, old.tier AS old_tier
  ),
  audit AS (
    INSERT INTO moderation_actions (moderator_id, target_user_id, action, content_type, content_id, reason)
    SELECT NULL, $1::int, 'tier_changed', 'venue_profile', u.id,
           'tier ' || COALESCE(u.old_tier, 'free') || ' -> ' || u.tier || ': Stripe subscription '
             || $6::text || ' ' || $3::text || COALESCE(' (until ' || to_char($4::timestamptz, 'YYYY-MM-DD') || ')', '')
      FROM upd u
  )
  SELECT (SELECT COUNT(*) FROM old)::int AS profiles,
         (SELECT COUNT(*) FROM granted)::int AS written,
         (SELECT old.verified FROM old) AS verified`;

// Re-reads the subscription from Stripe and writes what it says. Events arrive
// out of order and can be replayed, so the event body is never the source:
// whatever Stripe says NOW is written, and writing it twice changes nothing.
// Throws on a Stripe or database failure, so the webhook answers 500 and
// Stripe retries.
//
// A LIVE SUBSCRIPTION ON A PRICE THIS SERVER DOES NOT RECOGNISE IS NOT A
// CANCELLATION. It used to be written as tier free with expires_at now, so a
// venue Stripe was still charging lost Roost the moment a price id changed
// under it: a new Price made in the dashboard, a typo in STRIPE_PRICE_ROOST_*,
// the founding price left unset, a price rise with the old id not moved to
// STRIPE_PRICE_ROOST_LEGACY. That is a configuration fault on our side, and
// the venue must not pay for it. So Roost is written through the period Stripe
// is billing, the same as for a known price, and the error below names the
// price to add. Only Stripe can create a subscription carrying venue metadata,
// so an unknown price here is always one of ours.
//
// It does not throw. Leaving the old grant and answering 500 kept the end date
// of the PREVIOUS period, so the venue still lost Roost three days after it
// while Stripe billed the new one, and every retry repeated the refusal. An
// endpoint that fails for days can also be disabled by Stripe, which would
// stop every Pro and Roost event, not just this one.
//
// A DEAD subscription on an unknown price is still written, because revoking
// is what a dead subscription means whatever it was on.
async function syncVenueSubscription(subscriptionId) {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  if (!isVenueObject(sub)) return { ignored: 'not_venue' };
  const userId = venueUserIdFrom(sub.metadata);
  if (!userId) return { ignored: 'no_account' };
  let g = grantFromSubscription(sub);
  if (!g.priceOk && KEEP_STATUSES.has(sub.status)) {
    console.error(`[venue-billing] subscription ${sub.id} is ${g.status} on price ${g.priceId}, which is not a configured Roost price. Stripe is billing it, so Roost is kept through the period being billed. If the price is real, set it in STRIPE_PRICE_ROOST_* (a price no longer sold goes in STRIPE_PRICE_ROOST_LEGACY).`);
    g = grantFromSubscription(sub, Date.now(), { unknownPriceIsRoost: true });
  }
  if (!g.priceOk) {
    console.error(`[venue-billing] subscription ${sub.id} is ${g.status} on price ${g.priceId}, which is not a configured Roost price. It is not live, so the grant is revoked as for any ended subscription.`);
  }
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
  const r = await pool.query(SYNC_SQL, [
    userId, g.grantTier, g.status, g.expiresAt, customerId || null, sub.id, g.priceId,
    g.periodEnd, g.cancelAt, g.trialEnd, g.live, g.cachedTier,
  ]);
  const row = r.rows[0] || {};
  if (!row.profiles) return { ignored: 'no_venue_profile' };
  if (g.live && row.verified !== true) {
    console.error(`[venue-billing] venue user ${userId} holds a live Roost subscription (${sub.id}) but the profile is not verified, so no tier is served. Verify the claim or refund it.`);
  }
  return { userId, tier: g.live ? g.cachedTier : 'free', status: g.status, written: row.written > 0 };
}

// The Stripe webhook's venue branch. Only called for objects that carry
// kind='venue', so nothing here can touch a Pro event.
async function handleVenueEvent(event) {
  const obj = event.data && event.data.object ? event.data.object : {};
  if (event.type === 'checkout.session.completed') {
    if (obj.mode !== 'subscription') return { ignored: 'not_subscription' };
    const subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription && obj.subscription.id;
    if (!subscriptionId) return { ignored: 'no_subscription' };
    return syncVenueSubscription(subscriptionId);
  }
  if (event.type.startsWith('customer.subscription.')) return syncVenueSubscription(obj.id);
  return { ignored: event.type };
}

// After the redirect back: prove the session is this account's, then write
// the subscription now rather than waiting for the webhook, so the owner lands
// on a dashboard that already shows Roost.
async function confirmVenueCheckout(userId, sessionId) {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  if (!session || !isVenueObject(session) || venueUserIdFrom(session.metadata) !== userId) {
    throw refusal(404, 'That checkout does not belong to this account.');
  }
  if (session.status !== 'complete') return { complete: false, tier: null };
  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription && session.subscription.id;
  if (!subscriptionId) return { complete: true, tier: null };
  const result = await syncVenueSubscription(subscriptionId);
  return { complete: true, tier: result.tier || null };
}

module.exports = {
  checkoutState,
  roostPrices,
  isVenueObject,
  createVenueCheckout,
  createVenuePortal,
  confirmVenueCheckout,
  syncVenueSubscription,
  handleVenueEvent,
  venueCustomerIdFor,
  closeVenueCustomer,
  grantFromSubscription,
  legacyRoostPrices,
  TRIAL_DAYS,
  ROOST_TIER,
  __test: { SYNC_SQL, venueUserIdFrom, GRACE_MS, STRIPE_MIN_TRIAL_MS },
};
