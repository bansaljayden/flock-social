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
// ONE VENUE PER PLAN. The account is not the venue: a claim can be re-pointed
// at another Google listing (PUT /api/venue-profile), and a plan whose
// metadata named only the account was served to whichever venue the claim
// named next. So every session and subscription also carries
// flock_venue_place_id, the listing it is bought for, and flock_venue_profile_id,
// the claim. The writer binds each subscription to that listing (or, for one
// made by hand without it, to the listing the claim named when it first
// arrived), records the binding in venue_stripe_subscriptions and on the grant
// (migration 119), and the resolver serves a grant only while the claim still
// names its listing. Moving a plan to another listing is an explicit step: an
// operator changes the subscription's flock_venue_place_id in Stripe, and the
// next event re-binds it.
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
// Statuses after which Stripe will never bill the subscription again, so
// there is nothing left to cancel.
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

// What a subscription WE ended early is written as in venue_subscriptions.status
// (stripe_subscription_endings.cause, migration 118). Not Stripe's word on
// purpose: Stripe can still call such a subscription active, and the row says
// why the grant ended. Any status outside GRANT_LIVE_STATUSES revokes in the
// resolver, so these two need nothing there.
function endingStatus(cause) {
  if (cause === 'refund') return 'refunded';
  if (cause === 'dispute') return 'disputed';
  return 'ended';
}

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

// The listing a subscription is bought for (ONE VENUE PER PLAN above). Width
// is the column's, venue_profiles.google_place_id; anything wider names no
// listing a claim could hold.
const MAX_PLACE_ID = 255;
function venuePlaceIdFrom(metadata) {
  const raw = metadata && typeof metadata.flock_venue_place_id === 'string' ? metadata.flock_venue_place_id.trim() : '';
  return raw && raw.length <= MAX_PLACE_ID ? raw : null;
}

function isVenueObject(obj) {
  return !!(obj && obj.metadata && obj.metadata.kind === KIND);
}

// ---------------------------------------------------------------------------
// Customers and sessions
// ---------------------------------------------------------------------------

async function venueProfileFor(userId) {
  const r = await pool.query(
    'SELECT id, verified, business_name, stripe_customer_id, google_place_id FROM venue_profiles WHERE user_id = $1',
    [userId]
  );
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  return rows[0] || null;
}

// ONE TRIAL PER VENUE (Terms 9.6: "14 days free, once per venue"). The trial
// used to be decided by asking the CURRENT Stripe customer whether it had
// ever held a subscription, which is a question about a customer, not a
// venue: another account claiming the same venue, or this account on a new
// customer, started a second 14 days. The record of every Roost subscription
// the writer has seen (venue_stripe_subscriptions, migration 119) answers it
// for the venue and for the account, and so does a grant row that has ever
// named a subscription. Stripe's own answer for the customer is still asked
// as well, for a subscription made a moment ago whose first event has not
// arrived yet.
const TRIAL_USED_SQL = `SELECT (EXISTS (SELECT 1 FROM venue_stripe_subscriptions WHERE user_id = $1::int OR google_place_id = $2::varchar)
     OR EXISTS (SELECT 1 FROM venue_subscriptions WHERE user_id = $1::int AND stripe_subscription_id IS NOT NULL)) AS used`;

async function venueTrialUsed(userId, placeId) {
  const r = await pool.query(TRIAL_USED_SQL, [userId, placeId || null]);
  const row = r && Array.isArray(r.rows) ? r.rows[0] : null;
  return !!(row && row.used === true);
}

async function venueCustomerIdFor(userId) {
  const r = await pool.query('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1', [userId]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  return rows[0] ? rows[0].stripe_customer_id || null : null;
}

// EVERY STRIPE CUSTOMER A ROOST PLAN OF THIS ACCOUNT IS ON RECORD WITH. The
// one on the venue profile is the customer checkout made. A plan sold by hand
// (the founding rate) is made in the Stripe dashboard on a customer of the
// operator's making, and was recorded only in venue_subscriptions, so the
// portal told that owner there was nothing to manage and account deletion
// left its card billed. The writer now records every subscription's customer
// (venue_stripe_subscriptions) and puts it on the profile when the profile
// has none, and the portal and deletion read all of them. The profile's own
// customer first.
const CUSTOMERS_SQL = `SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1 AND stripe_customer_id IS NOT NULL
  UNION ALL
  SELECT stripe_customer_id FROM venue_subscriptions WHERE user_id = $1 AND stripe_customer_id IS NOT NULL
  UNION ALL
  SELECT stripe_customer_id FROM venue_stripe_subscriptions WHERE user_id = $1 AND stripe_customer_id IS NOT NULL`;

async function venueCustomerIdsFor(userId) {
  const r = await pool.query(CUSTOMERS_SQL, [userId]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  const ids = [];
  for (const row of rows) {
    const id = row && typeof row.stripe_customer_id === 'string' ? row.stripe_customer_id : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Whether Stripe may still bill this subscription: the statuses that block a
// second checkout (LIVE_STATUSES), and the ones a venue manages in the portal.
const stillBilling = (sub) => !!(sub && LIVE_STATUSES.has(sub.status));

// The dates a plans card names, from the subscription itself: when a trial is
// charged, when the current period ends (the renewal), and when a plan set to
// end ends, as ISO strings. A plan set to end at its period end can say so
// with cancel_at_period_end alone, so that is its end date. None of them is
// the grant's expires_at, which carries the grace a late webhook is allowed.
const isoFromUnix = (s) => (Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null);
function subscriptionDates(sub) {
  if (!sub) return null;
  const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const periodEnd = (item && item.current_period_end) || sub.current_period_end || null;
  return {
    status: typeof sub.status === 'string' ? sub.status : null,
    trialEnd: sub.status === 'trialing' ? isoFromUnix(sub.trial_end) : null,
    currentPeriodEnd: isoFromUnix(periodEnd),
    cancelAt: isoFromUnix(sub.cancel_at || (sub.cancel_at_period_end ? periodEnd : null)),
  };
}

// The Roost subscription that matters now, on any of the account's customers,
// with the customer it is on, or null: the newest one Stripe may still bill,
// else the newest of all. Only subscriptions naming this account. A plan that
// is still billing is the one its owner has to be able to manage, even when a
// newer checkout was started and abandoned after it (that one ends
// incomplete_expired); taking the newest alone would have hidden Manage
// billing from a venue Stripe was still charging, while checkout refused it
// as already subscribed. A customer Stripe has deleted (a failed account
// deletion keeps its id on file) holds nothing and is passed over.
const createdAt = (s) => Number(s && s.created) || 0;
async function latestVenueSubscription(userId, customerIds, requestOptions) {
  let newest = null;
  let newestBilling = null;
  for (const customerId of customerIds) {
    let list;
    try {
      list = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 }, requestOptions);
    } catch (err) {
      if (missingAtStripe(err)) continue;
      throw err;
    }
    const data = list && Array.isArray(list.data) ? list.data : [];
    for (const s of data) {
      if (!isVenueObject(s) || venueUserIdFrom(s.metadata) !== userId) continue;
      const entry = { subscription: s, customerId };
      if (!newest || createdAt(s) > createdAt(newest.subscription)) newest = entry;
      if (stillBilling(s) && (!newestBilling || createdAt(s) > createdAt(newestBilling.subscription))) newestBilling = entry;
    }
  }
  return newestBilling || newest;
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
//
// EVERY CUSTOMER ON RECORD, not only the profile's (venueCustomerIdsFor): a
// plan sold by hand lives on a customer checkout never made, and the deletion
// used to skip it and leave its card billed for an account that was gone.
//
// NOTHING IS FORGOTTEN HERE. This used to clear venue_profiles.stripe_customer_id
// in a write of its own, committed before the deletion's transaction began. When
// that transaction then rolled back, the account stayed with no customer on
// file, and the trial asked only the next checkout's NEW customer whether it
// had ever subscribed: a second 14 days for the same venue. The ids go with the
// account's rows when its deletion commits (venue_profiles and the subscription
// record are ON DELETE CASCADE), and stay on file when it does not. A customer
// on file that Stripe has deleted is replaced at the next checkout
// (ensureVenueCustomer), and the trial is read from the venue's record of
// subscriptions (venueTrialUsed), not from whichever customer is current.
async function closeVenueCustomer(userId) {
  const customerIds = await venueCustomerIdsFor(userId);
  if (customerIds.length === 0) return false;
  for (const customerId of customerIds) {
    const closed = await billing.closeCustomer(customerId);
    if (!closed) {
      throw refusal(503, `Roost Stripe customer ${customerId} was not cancelled; Stripe is not configured`, 'STRIPE_NOT_CONFIGURED');
    }
  }
  return true;
}

const missingAtStripe = (err) => !!err && (err.code === 'resource_missing' || err.statusCode === 404);

// The venue's Stripe customer, created once. Same idempotency reasoning as
// proBilling.ensureCustomer, with its own key prefix so the two products can
// never be handed each other's customer.
//
// A CUSTOMER ON FILE CAN BE ONE STRIPE HAS DELETED. Account deletion closes
// the customer before its own transaction and no longer forgets it
// (closeVenueCustomer), so a deletion that then failed leaves the account
// holding a customer that cannot take a checkout. It is replaced here: a new
// customer, swapped in only over the dead one. Its idempotency key names the
// customer it replaces, because the hourly key that made the first one could
// still hand that deleted customer back. A new customer is not a new trial
// (venueTrialUsed).
async function ensureVenueCustomer(user, profile) {
  if (profile.stripe_customer_id) {
    const onFile = profile.stripe_customer_id;
    const existing = await stripe().customers.retrieve(onFile).catch((err) => {
      if (missingAtStripe(err)) return { id: onFile, deleted: true };
      throw err;
    });
    if (!existing || existing.deleted !== true) return onFile;
    const replacement = await stripe().customers.create({
      email: user.email || undefined,
      name: profile.business_name || user.name || undefined,
      metadata: { kind: KIND, flock_venue_user_id: String(user.id) },
    }, { idempotencyKey: `flock-venue-customer-${user.id}-replaces-${onFile}` });
    const swapped = await pool.query(
      `UPDATE venue_profiles SET stripe_customer_id = $1
        WHERE user_id = $2 AND stripe_customer_id = $3
        RETURNING stripe_customer_id`,
      [replacement.id, user.id, onFile]
    );
    if (swapped.rows[0]) return swapped.rows[0].stripe_customer_id;
    return venueCustomerIdFor(user.id);
  }
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
//
// The key is exported because account deletion holds this queue too, from
// before it reads the Roost customer until its COMMIT, so a build can never
// save a customer the deletion has already looked for.
const venueCheckoutKey = (userId) => `venue:${userId}`;

function createVenueCheckout(user, plan) {
  return billing.withCheckoutLock(venueCheckoutKey(user && user.id), () => buildVenueCheckout(user, plan));
}

async function buildVenueCheckout(user, plan) {
  const priceId = roostPrices()[plan];
  if (!priceId) throw refusal(400, 'That plan is not offered.');
  const profile = await venueProfileFor(user.id);
  if (!profile) throw refusal(404, 'There is no venue on this account.', 'NO_VENUE');
  if (profile.verified !== true) {
    throw refusal(409, 'Your venue has to be verified before Roost can be bought. Settings has the request.', 'VENUE_NOT_VERIFIED');
  }
  // A plan is bought for a listing (ONE VENUE PER PLAN), and a claim the
  // admin verified with no listing has none to bind it to. Roost's forecast
  // needs one anyway (routes/venueDashboard.js /intelligence).
  if (!profile.google_place_id) {
    throw refusal(409, 'Roost is bought for your Google listing, and none is linked to this venue yet. Write to social@flockcorp.com to link one.', 'NO_LISTING');
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
  // THE NOTICE FLOOR. A venue account from before Roost had a price is not
  // charged before the date its notice email named (Terms 9.6,
  // services/roostNotice.js). If the notice has not gone out yet it is sent
  // now, so the window has an end, and the first charge is never before that
  // date. Inside the window this applies even to a venue that has had its
  // trial.
  //
  // NO NOTICE ON RECORD, NO CHARGEABLE CHECKOUT. When the notice could not be
  // sent here, this used to floor the first charge at 30 days from now and go
  // ahead. The daily sweep then sent the notice on some later day, and that
  // email promised no charge until 30 days after IT, while the Stripe
  // trial_end still said 30 days after the checkout: the venue was charged
  // before the date it had been told, by however many days the sweep came
  // later. The date a venue is promised is the one its recorded notice names,
  // so a checkout is only made once one is recorded, and the owner is asked to
  // try again. Refused before Stripe is touched, so a refusal leaves no
  // customer or session behind. A 409 rather than a 5xx, because the route
  // hides a 5xx's words and the owner can act on these (a bounced address is
  // the usual reason).
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
      if (!sent) {
        throw refusal(409, 'Before Roost can be bought, we email you a notice that names the date of your first charge, and that email could not be sent just now. Check the email address on your account, then try again.', 'NOTICE_NOT_SENT');
      }
      noticeFloor = sent.getTime();
    }
  }
  const customerId = await ensureVenueCustomer(user, profile);
  await expireOpenSessions(customerId);
  if (await hasLiveSubscription(customerId)) {
    throw refusal(409, 'You already have Roost. Manage it from billing.', 'ALREADY_SUBSCRIBED');
  }
  const trial = !(await venueTrialUsed(user.id, profile.google_place_id)) && !(await hasEverSubscribed(customerId));
  const trialEndMs = noticeFloor
    ? Math.max(noticeFloor, trial ? Date.now() + TRIAL_DAYS * DAY_MS : 0, Date.now() + STRIPE_MIN_TRIAL_MS)
    : 0;
  const price = await billing.describePrice(priceId);
  const every = price.interval === 'year' ? 'year' : 'month';
  const tax = billing.taxEnabled();
  const web = billing.webBase();
  const meta = {
    kind: KIND,
    flock_venue_user_id: String(user.id),
    flock_venue_place_id: profile.google_place_id,
    flock_venue_profile_id: String(profile.id),
    plan,
  };
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

// The portal opens on the customer that holds the account's newest Roost
// subscription, on any customer on record (venueCustomerIdsFor), and on the
// profile's own customer when none of them holds one.
async function createVenuePortal(userId) {
  const customerIds = await venueCustomerIdsFor(userId);
  if (customerIds.length === 0) throw refusal(404, 'There is no Roost subscription on this account.', 'NO_WEB_SUBSCRIPTION');
  const latest = customerIds.length > 1 ? await latestVenueSubscription(userId, customerIds) : null;
  const customerId = latest ? latest.customerId : customerIds[0];
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
// syncVenueSubscription): it counts that price as Roost. endedBy is the cause
// recorded for a subscription we ended early (a full refund, a dispute): it
// is never live, whatever Stripe's status says, and its status is written as
// that cause (endingStatus above).
function grantFromSubscription(sub, now = Date.now(), { unknownPriceIsRoost = false, endedBy = null } = {}) {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const priceId = item && item.price ? item.price.id : null;
  const priceOk = !!priceId && (unknownPriceIsRoost || recognisedPrices().has(priceId));
  // current_period_end moved onto the item in recent API versions; the
  // subscription-level field is the older home.
  const periodEnd = toDate(item && item.current_period_end) || toDate(sub.current_period_end);
  const live = KEEP_STATUSES.has(sub.status) && priceOk && !endedBy;
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
    status: endedBy ? endingStatus(endedBy) : typeof sub.status === 'string' ? sub.status.slice(0, 32) : 'unknown',
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
//            started must not revoke the new one. The same subscription always
//            overwrites its own row, which is only safe because of how the
//            caller orders the writes. Re-reading Stripe on every event does
//            not order them by itself: two syncs that overlapped could read
//            active and then cancelled and commit in the other order, and the
//            older active read restored Roost through the old period end plus
//            grace. syncVenueSubscription therefore runs one sync per venue at
//            a time, with its Stripe read inside the lock and this statement
//            on the same transaction, so the last write is the latest read.
//            And never over a live paid grant WE wrote (source 'comp' or
//            'admin', from POST /api/admin/venues/:userId/tier) unless the
//            subscription is live and paid through at least that grant's end.
//            A comp laid over a paying venue keeps the Stripe columns it
//            found, so the row still names the old subscription, and "the
//            same subscription overwrites its own row" let that
//            subscription's events undo the comp: the cancel_at_period_end
//            update cut six months down to the
//            Stripe period plus grace, and the deleted event wrote 'canceled'
//            and the cache 'free'. Checkout already refuses a venue holding a
//            live grant (buildVenueCheckout), so the only subscription that can
//            reach such a row is one that was running before the grant. It
//            takes the row back once it is paid through at least the grant's
//            end. At least, not strictly past: a grant the admin route lifted
//            to the Stripe end meets any event from that same period with the
//            same date, and that subscription already covers everything the
//            grant does. Two things keep a venue that kept paying out of a
//            gap between the two. The admin route never ends a grant it
//            writes over a live Stripe grant before that Stripe grant ends,
//            so the subscription renews while ours is still running. And
//            each renewal carries the end of a full period, so the last one
//            before our grant ends carries a date past it. A later admin edit
//            that shortens a grant already written over a subscription is not
//            covered: the row no longer says whether that subscription is
//            still live, because its events were not written. Nor does a
//            subscription ever take the row from a live grant WE wrote for a
//            different listing, whatever its dates: a plan for venue A is not
//            a reason to end a comp given to venue B.
//   upd      moves the cache only when it changes, only when the grant was
//            written, never to a paid tier for an unverified profile, and
//            never to a paid tier for a claim that names a different listing
//            from the one the subscription is bound to ($13, ONE VENUE PER
//            PLAN at the top of this file).
//   audit    one tier_changed row per actual change, none per renewal.
const SYNC_SQL = `WITH old AS (
    SELECT user_id, tier, verified, google_place_id FROM venue_profiles WHERE user_id = $1::int
  ),
  granted AS (
    INSERT INTO venue_subscriptions
      (user_id, tier, source, status, granted_reason, granted_at, granted_by, expires_at,
       stripe_customer_id, stripe_subscription_id, stripe_price_id, current_period_end, cancel_at, trial_end,
       google_place_id, updated_at)
    SELECT $1::int, $2::text, 'stripe', $3::text, 'paid', NOW(), NULL, $4::timestamptz,
           $5::text, $6::text, $7::text, $8::timestamptz, $9::timestamptz, $10::timestamptz,
           $13::varchar, NOW()
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
      google_place_id = EXCLUDED.google_place_id,
      updated_at = NOW()
    WHERE (venue_subscriptions.stripe_subscription_id IS NULL
       OR venue_subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id
       OR $11::boolean
       OR venue_subscriptions.status NOT IN ('active', 'trialing', 'past_due'))
      AND NOT (venue_subscriptions.source IS DISTINCT FROM 'stripe'
       AND venue_subscriptions.tier IN ('premium', 'pro')
       AND venue_subscriptions.status IN ('active', 'trialing', 'past_due')
       AND (venue_subscriptions.expires_at IS NULL OR venue_subscriptions.expires_at > NOW())
       AND NOT ($11::boolean AND venue_subscriptions.expires_at IS NOT NULL
                AND EXCLUDED.expires_at >= venue_subscriptions.expires_at
                AND venue_subscriptions.google_place_id IS NOT DISTINCT FROM EXCLUDED.google_place_id))
    RETURNING user_id
  ),
  upd AS (
    UPDATE venue_profiles SET tier = $12::text, updated_at = NOW()
      FROM old
     WHERE venue_profiles.user_id = old.user_id
       AND EXISTS (SELECT 1 FROM granted)
       AND old.tier IS DISTINCT FROM $12::text
       AND ($12::text = 'free' OR old.verified = true)
       AND ($12::text = 'free' OR old.google_place_id IS NOT DISTINCT FROM $13::varchar)
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
         (SELECT old.verified FROM old) AS verified,
         (SELECT old.google_place_id FROM old) AS place_id`;

// EVERY ROOST SUBSCRIPTION ON RECORD, AND THE LISTING IT IS BOUND TO
// (venue_stripe_subscriptions, migration 119). Written on the sync's locked
// transaction, before the grant. The binding is the listing in the
// subscription's metadata whenever it names one, so an operator moving a plan
// to another listing is one metadata change; a subscription made by hand
// without one keeps the listing its claim named when it first arrived, read
// from the row and never from whatever the claim names later. Nothing is
// recorded for an account that no longer exists (a deletion's own cancel
// event), and the binding then comes from the metadata alone.
const RECORD_SUBSCRIPTION_SQL = `INSERT INTO venue_stripe_subscriptions (stripe_subscription_id, user_id, stripe_customer_id, google_place_id)
  SELECT $1::text, u.id, $3::text, COALESCE($4::varchar, vp.google_place_id)
    FROM users u
    LEFT JOIN venue_profiles vp ON vp.user_id = u.id
   WHERE u.id = $2::int
  ON CONFLICT (stripe_subscription_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, venue_stripe_subscriptions.stripe_customer_id),
    google_place_id = CASE WHEN $4::varchar IS NOT NULL THEN $4::varchar ELSE venue_stripe_subscriptions.google_place_id END
  RETURNING google_place_id`;

// THE CUSTOMER GOES WHERE THE PORTAL LOOKS FIRST. Checkout was the only
// writer of venue_profiles.stripe_customer_id, so a plan sold by hand left it
// empty. The writer fills it from the subscription's customer when the
// profile has none, and never takes one another venue already holds (the
// column is unique; an operator who made two venues' plans on one customer
// gets the grant written and that customer left where it is).
const FILL_CUSTOMER_SQL = `UPDATE venue_profiles SET stripe_customer_id = $2::text
   WHERE user_id = $1::int
     AND stripe_customer_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM venue_profiles other
                      WHERE other.stripe_customer_id = $2::text AND other.user_id <> $1::int)`;

// ONE SYNC PER VENUE AT A TIME, AND THE LAST ONE READS LAST. Every caller (the
// webhook, once per subscription event, and the confirm route after the
// redirect back) re-reads the subscription and writes what it says, and at the
// end of a checkout several of them arrive for one venue in the same second.
// Re-reading alone did not order them. Sync A could read the subscription while
// it was active, Stripe could cancel it, sync B could read the cancellation and
// revoke Roost, and then A committed its older active read, which SYNC_SQL
// accepts because it is the same subscription. Roost was back until the old
// period end plus the grace, and no later event was coming to correct it. The
// Pro path closed the same hole the same way (routes/revenuecat.js
// syncPremiumFromRevenueCat): the Stripe read happens inside a transaction that
// holds a per-venue advisory lock, and the write is on that transaction, so a
// second sync for the venue waits for the first to commit and then reads Stripe
// itself.
//
// READ, LOCK, READ AGAIN. The lock is keyed on the venue's account, because
// venue_subscriptions holds one row per account and the order that matters is
// the order of every write to that row, whichever subscription it comes from. A
// lock on the subscription id would order two syncs of one subscription and
// nothing else: an old subscription's stale active read could still commit
// after a new subscription's write, point the row back at the old one, and let
// the old one's deleted event revoke a venue that is paying. The account is
// only known from the subscription's metadata, so the first read finds it,
// outside the lock, and decides nothing else. Everything written comes from the
// second read, taken under the lock. A subscription whose second read names a
// different account (its metadata edited in the dashboard between the two) is
// refused rather than written under a lock that does not cover it: the throw
// is a 500, and Stripe's retry starts again from the account it names then.
//
// HOW LONG THE LOCK IS HELD, AGAINST THE POOL'S STATEMENT TIMEOUT. A sync that
// has to wait does its waiting inside its pg_advisory_xact_lock statement, and
// the pool cancels any statement at 15 seconds (config/database.js). The holder
// keeps the lock for one Stripe read and one short statement, so the read under
// the lock is bounded: LOCKED_READ allows it five seconds and no retry in
// place, where the client's default is fifteen seconds tried three times. A
// sync queued behind two others still gets the lock inside the timeout. A
// longer queue is only possible while Stripe itself is slow, and then the
// waiter's statement is cancelled and thrown like any Stripe failure: the
// webhook answers 500, Stripe delivers the event again later, and nothing was
// written from a stale read. Syncs for different venues do not wait on each
// other. The two-int lock form keys on the exact account id, as the Pro sync
// and routes/feedback.js do, in a namespace of its own.
const SYNC_LOCK_NAMESPACE = 81437;
const LOCKED_READ = { timeout: 5000, maxNetworkRetries: 0 };

// ENDED BY US STAYS ENDED. A subscription whose current period's payment was
// refunded in full, or which a dispute ended, has a row in
// stripe_subscription_endings (migration 118). Stripe can still call it
// active (the cancel has not landed, or somebody undid it in the dashboard),
// and every event re-reads Stripe, so without this read a later
// customer.subscription.updated wrote the year of Roost straight back. Read on
// the locked transaction, with the subscription it is about.
const ENDED_SQL = 'SELECT cause FROM stripe_subscription_endings WHERE stripe_subscription_id = $1::text ORDER BY id LIMIT 1';

// Re-reads the subscription from Stripe and writes what it says. Events arrive
// out of order and can be replayed, so the event body is never the source:
// whatever Stripe says under the venue's lock is written, and writing it twice
// changes nothing. Throws on a Stripe or database failure, so the webhook
// answers 500 and Stripe retries.
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
  // Whose venue this is, and nothing else: see READ, LOCK, READ AGAIN.
  const first = await stripe().subscriptions.retrieve(subscriptionId);
  if (!isVenueObject(first)) return { ignored: 'not_venue' };
  const userId = venueUserIdFrom(first.metadata);
  if (!userId) return { ignored: 'no_account' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [SYNC_LOCK_NAMESPACE, userId]);
    const sub = await stripe().subscriptions.retrieve(subscriptionId, {}, LOCKED_READ);
    const owner = isVenueObject(sub) ? venueUserIdFrom(sub.metadata) : null;
    if (owner !== userId) {
      throw new Error(`Roost subscription ${subscriptionId} named venue user ${userId} and then ${owner ? `venue user ${owner}` : 'no venue account'} on the read under the lock. Nothing was written; Stripe's retry reads it again.`);
    }
    const ended = await client.query(ENDED_SQL, [sub.id]);
    const endedBy = ended && Array.isArray(ended.rows) && ended.rows[0] ? ended.rows[0].cause : null;
    let g = grantFromSubscription(sub, Date.now(), { endedBy });
    if (!g.priceOk && KEEP_STATUSES.has(sub.status) && !endedBy) {
      console.error(`[venue-billing] subscription ${sub.id} is ${g.status} on price ${g.priceId}, which is not a configured Roost price. Stripe is billing it, so Roost is kept through the period being billed. If the price is real, set it in STRIPE_PRICE_ROOST_* (a price no longer sold goes in STRIPE_PRICE_ROOST_LEGACY).`);
      g = grantFromSubscription(sub, Date.now(), { unknownPriceIsRoost: true });
    }
    if (endedBy && KEEP_STATUSES.has(sub.status)) {
      console.error(`[venue-billing] subscription ${sub.id} is ${sub.status} at Stripe, but we ended it (${endedBy}), so the grant stays revoked. Cancel it in Stripe if it is still billing.`);
    }
    if (!g.priceOk) {
      console.error(`[venue-billing] subscription ${sub.id} is ${g.status} on price ${g.priceId}, which is not a configured Roost price. It is not live, so the grant is revoked as for any ended subscription.`);
    }
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
    // The listing this subscription pays for (ONE VENUE PER PLAN).
    const metaPlace = venuePlaceIdFrom(sub.metadata);
    const recorded = await client.query(RECORD_SUBSCRIPTION_SQL, [sub.id, userId, customerId || null, metaPlace]);
    const boundPlace = recorded && Array.isArray(recorded.rows) && recorded.rows[0]
      ? recorded.rows[0].google_place_id
      : metaPlace;
    if (customerId) await client.query(FILL_CUSTOMER_SQL, [userId, customerId]);
    const r = await client.query(SYNC_SQL, [
      userId, g.grantTier, g.status, g.expiresAt, customerId || null, sub.id, g.priceId,
      g.periodEnd, g.cancelAt, g.trialEnd, g.live, g.cachedTier, boundPlace || null,
    ]);
    await client.query('COMMIT');
    const row = r.rows[0] || {};
    if (!row.profiles) return { ignored: 'no_venue_profile' };
    const otherListing = (boundPlace || null) !== (row.place_id || null);
    if (g.live && otherListing) {
      console.error(`[venue-billing] venue user ${userId} holds a live Roost subscription (${sub.id}) bought for listing ${boundPlace || 'none'}, but the claim names ${row.place_id || 'no listing'}, so it is not served there. To move the plan, set flock_venue_place_id on the subscription in Stripe to the listing the claim names; otherwise cancel it.`);
    }
    // Live and not written can only be the rule in SYNC_SQL that keeps a
    // grant we wrote: Stripe is billing a venue that already holds Roost from
    // us for longer than this period. Nothing is taken from the venue, but
    // somebody is paying for what we gave away, so it is said out loud.
    if (g.live && !(row.written > 0)) {
      console.error(`[venue-billing] venue user ${userId} holds a Roost grant from us (a comp or a hand-sold plan) that runs past Stripe subscription ${sub.id} (${g.status}), so the grant was kept and the subscription was not written over it. Stripe has billed a venue we already cover: refund or cancel it in Stripe, or end the grant.`);
    }
    if (g.live && row.verified !== true) {
      console.error(`[venue-billing] venue user ${userId} holds a live Roost subscription (${sub.id}) but the profile is not verified, so no tier is served. Verify the claim or refund it.`);
    }
    const served = g.live && row.verified === true && !otherListing;
    return { userId, tier: served ? g.cachedTier : 'free', status: g.status, written: row.written > 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

// Cancels a subscription now, unless Stripe has already ended it. A cancel
// that fails because the subscription ended in between (the venue cancelled,
// a deleted event raced us) is the outcome wanted, so it is checked for
// before the failure is passed on.
async function cancelNow(sub, idempotencyKey) {
  if (!sub || ENDED_STATUSES.has(sub.status)) return false;
  try {
    await stripe().subscriptions.cancel(sub.id, {}, { idempotencyKey });
    return true;
  } catch (err) {
    const again = await stripe().subscriptions.retrieve(sub.id).catch(() => null);
    if (again && ENDED_STATUSES.has(again.status)) return false;
    throw err;
  }
}

// Pages of a charge's refunds read, at most. A charge carries a handful.
const MAX_REFUND_PAGES = 5;

// What has really come back to the venue: refunds Stripe says succeeded. A
// refund can be pending for days on some payment methods and can still fail,
// and a failed or cancelled refund returned nothing.
async function succeededRefundTotal(chargeId) {
  let total = 0;
  let after = null;
  for (let page = 0; page < MAX_REFUND_PAGES; page += 1) {
    const list = await stripe().refunds.list({ charge: chargeId, limit: 100, ...(after ? { starting_after: after } : {}) });
    const data = list && Array.isArray(list.data) ? list.data : [];
    for (const r of data) {
      if (r && r.status === 'succeeded' && Number.isFinite(r.amount)) total += r.amount;
    }
    if (!list || !list.has_more || data.length === 0) break;
    after = data[data.length - 1].id;
  }
  return total;
}

// A FULL REFUND ENDS WHAT IT PAID FOR. The webhook used to acknowledge every
// refund event as ignored, and the subscription stayed the one authority for
// the grant, so a venue whose $990 for the year was refunded in full kept the
// year of Roost: Stripe still called the subscription active, and every later
// event re-read it and wrote it again. Stripe's refund dialog offers to cancel
// in the same step, but nothing made anyone tick it.
//
// Called for charge.refunded and the refund events (routes/stripeWebhook.js),
// with the event's object, which is only used for the charge id: everything
// decided here is read back from Stripe, like every other venue event.
//
//   FULL means the refunds Stripe says SUCCEEDED add up to the whole charge.
//   A partial refund is a credit (a goodwill amount, a price correction), not
//   an ending, and changes nothing. A pending one changes nothing until it
//   lands, and the refund.updated that says it landed brings it back here.
//
//   ITS SUBSCRIPTION is found through the charge's invoice
//   (proBilling.subscriptionsFundedBy), never through the customer: a customer
//   outlives a subscription.
//
//   ONLY THE CURRENT PERIOD. The refunded invoice has to be the subscription's
//   latest, the one paying for today. A full refund of last month, after this
//   month was paid, returned nothing that pays for today, so today's grant
//   stands.
//
//   DURABLY. The decision is recorded (stripe_subscription_endings, migration
//   118) before anything else, and the writer reads that on every sync, so a
//   later event that still reads the subscription as active cannot restore
//   it. Then the subscription is cancelled now, without proration: the money
//   for the period is back with the venue, so there is nothing paid to run
//   out, and a subscription left open would bill again at its next renewal.
//   Last, the grant is written from Stripe as usual, which revokes it now.
//
// A Pro subscription is left alone: RevenueCat reads Stripe's refunds itself
// and revokes on its own path (routes/revenuecat.js).
async function revokeRefundedSubscription(obj) {
  const chargeId = obj && obj.object === 'charge'
    ? (typeof obj.id === 'string' ? obj.id : null)
    : (typeof (obj && obj.charge) === 'string' ? obj.charge : obj && obj.charge && obj.charge.id) || null;
  if (!chargeId) return { ignored: 'no_charge' };
  const charge = await stripe().charges.retrieve(chargeId);
  const amount = charge && Number.isFinite(charge.amount) ? charge.amount : 0;
  if (!(amount > 0)) return { ignored: 'no_payment' };
  if ((await succeededRefundTotal(chargeId)) < amount) return { ignored: 'partial_refund' };
  const { funded } = await billing.subscriptionsFundedBy(charge);
  if (funded.length === 0) return { ignored: 'no_subscription' };
  const revoked = [];
  for (const f of funded) {
    const sub = await stripe().subscriptions.retrieve(f.subscriptionId);
    if (!isVenueObject(sub)) continue;
    const latest = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice && sub.latest_invoice.id;
    if (latest !== f.invoiceId) {
      console.log(`[venue-billing] charge ${chargeId} was refunded in full, but it paid invoice ${f.invoiceId}, not the one paying for subscription ${sub.id}'s current period (${latest || 'none'}), so Roost stands.`);
      continue;
    }
    await billing.recordEnding({ cause: 'refund', sourceId: chargeId, subscriptionId: sub.id, invoiceId: f.invoiceId, chargeId });
    await cancelNow(sub, `flock-refund-cancel-${sub.id}`);
    await syncVenueSubscription(sub.id);
    revoked.push(sub.id);
  }
  if (revoked.length === 0) return { ignored: 'not_current_roost_period' };
  return { revoked };
}

// ---------------------------------------------------------------------------
// A claim that is no longer good
// ---------------------------------------------------------------------------

const idOf = (ref) => (typeof ref === 'string' && ref ? ref : ref && typeof ref.id === 'string' ? ref.id : null);

// WHEN A CLAIM IS REVOKED, ITS BILLING STOPS. Un-verifying a claim (routes/admin.js,
// PUT /api/admin/venues/:profileId/verify with verified: false) refuses Roost
// on the dashboard from that moment, and nothing told Stripe: an open checkout
// stayed payable, the subscription renewed, and the writer only logged the
// unverified profile on each event while the card was charged. This expires
// every open Roost checkout on every customer the account has on record and
// cancels every Roost subscription of the account's.
//
// IMMEDIATELY, NOT AT THE PERIOD END. That is the fairer of the two for a
// revoked claim: the venue is served nothing from the moment of revocation,
// and a subscription left to its period end is still a standing authority to
// charge it, by a renewal, by a trial converting, or by Stripe retrying a
// failed invoice, which cancel_at_period_end does not stop and a cancellation
// does (Stripe turns off collection on a cancelled subscription's open
// invoices). No proration credit is made: a credit on a customer who can no
// longer buy anything is not money back. What the venue already paid for the
// current period is a refund for a person to decide, because a claim is
// revoked when we could not confirm the account runs the venue, which can be
// fraud, so the log names the subscription.
//
// Runs in the venue's checkout queue, so a checkout being built for the claim
// finishes first and its session is expired here, and one asked for after
// this finds the claim unverified and is refused. customerIds may be handed in
// by a caller that has just read them in its own statement.
async function stopRoostForRevokedClaim(userId, { customerIds = null } = {}) {
  return billing.withCheckoutLock(venueCheckoutKey(userId), async () => {
    const customers = Array.isArray(customerIds) ? [...new Set(customerIds.filter(Boolean))] : await venueCustomerIdsFor(userId);
    const outcome = { checkoutsExpired: 0, subscriptionsCancelled: [] };
    if (customers.length === 0) return outcome;
    if (!billing.stripeConfigured()) {
      throw refusal(503, `venue user ${userId} has Roost customers on record (${customers.join(', ')}) and Stripe is not configured, so nothing was cancelled`, 'STRIPE_NOT_CONFIGURED');
    }
    for (const customerId of customers) {
      const open = await stripe().checkout.sessions.list({ customer: customerId, status: 'open', limit: 20 });
      for (const s of (open && Array.isArray(open.data) ? open.data : [])) {
        if (!isVenueObject(s)) continue;
        try {
          await stripe().checkout.sessions.expire(s.id);
          outcome.checkoutsExpired += 1;
        } catch (err) {
          const again = await stripe().checkout.sessions.retrieve(s.id).catch(() => null);
          if (!again || again.status === 'open') throw err;
        }
      }
      const list = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
      for (const s of (list && Array.isArray(list.data) ? list.data : [])) {
        if (!isVenueObject(s) || venueUserIdFrom(s.metadata) !== userId) continue;
        if (await cancelNow(s, `flock-claim-revoked-cancel-${s.id}`)) outcome.subscriptionsCancelled.push(s.id);
      }
    }
    // The grant is written from Stripe now, rather than when the deleted
    // events arrive.
    for (const subscriptionId of outcome.subscriptionsCancelled) await syncVenueSubscription(subscriptionId);
    if (outcome.subscriptionsCancelled.length) {
      console.error(`[venue-billing] venue user ${userId}'s claim was revoked, so Roost subscription(s) ${outcome.subscriptionsCancelled.join(', ')} were cancelled now. Whether to refund what was paid for the current period is a person's decision.`);
    }
    return outcome;
  });
}

// Whether a claim is still good for a plan bought for `placeId`: the account's
// venue is verified and still names that listing. A session from before
// flock_venue_place_id existed names none, and then verified alone decides.
async function claimStillGood(userId, placeId) {
  const profile = await venueProfileFor(userId);
  return !!(profile && profile.verified === true && (!placeId || profile.google_place_id === placeId));
}

// The money a refused purchase took, given back. A trial took none. The first
// invoice of the session is paid by one PaymentIntent (InvoicePayments, the
// same lookup proBilling.subscriptionsFundedBy documents), and the refund is
// keyed on the invoice, so a retried event refunds once. A payment already
// refunded is the outcome wanted.
async function refundRefusedPurchase(session) {
  if (!session || session.payment_status === 'no_payment_required') return null;
  const invoiceId = idOf(session.invoice);
  if (!invoiceId) return null;
  const list = await stripe().invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 10 });
  const paid = (list && Array.isArray(list.data) ? list.data : [])
    .find((p) => p && p.status === 'paid' && p.payment && idOf(p.payment.payment_intent));
  if (!paid) return null;
  try {
    return await stripe().refunds.create(
      { payment_intent: idOf(paid.payment.payment_intent), metadata: { flock_reason: 'claim_not_verified' } },
      { idempotencyKey: `flock-claim-revoked-refund-${invoiceId}` }
    );
  } catch (err) {
    if (err && err.code === 'charge_already_refunded') return null;
    throw err;
  }
}

// FULFILLMENT CHECKS THE CLAIM AGAIN. Checkout refuses an unverified claim
// when the session is made, and that was the last time the claim was asked
// about: a session paid after the claim was revoked (or re-pointed at another
// listing) became a plan the dashboard refused to serve, billed every period.
// When a checkout completes (the webhook, or the owner's return from Stripe,
// whichever is first) the claim is read again, and a purchase against a claim
// that is no longer verified for the listing it was bought for is cancelled at
// once and its payment refunded: a purchase we will not deliver is not one we
// keep the money for. Then the grant is written from Stripe as for any event,
// which records the cancellation.
async function fulfillVenueCheckout(session) {
  const subscriptionId = idOf(session && session.subscription);
  if (!subscriptionId) return { ignored: 'no_subscription' };
  const userId = venueUserIdFrom(session.metadata);
  const placeId = venuePlaceIdFrom(session.metadata);
  if (!userId || await claimStillGood(userId, placeId)) return syncVenueSubscription(subscriptionId);
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  if (isVenueObject(sub)) {
    await cancelNow(sub, `flock-claim-revoked-cancel-${sub.id}`);
    await refundRefusedPurchase(session);
  }
  console.error(`[venue-billing] checkout ${session.id} completed for venue user ${userId}, whose claim is not verified for listing ${placeId || 'none'} any more, so subscription ${subscriptionId} was cancelled and its payment refunded.`);
  const result = await syncVenueSubscription(subscriptionId);
  return { ...result, tier: 'free', refused: 'CLAIM_NOT_VERIFIED' };
}

// The Stripe webhook's venue branch. Only called for objects that carry
// kind='venue', so nothing here can touch a Pro event.
async function handleVenueEvent(event) {
  const obj = event.data && event.data.object ? event.data.object : {};
  if (event.type === 'checkout.session.completed') {
    if (obj.mode !== 'subscription') return { ignored: 'not_subscription' };
    return fulfillVenueCheckout(obj);
  }
  if (event.type.startsWith('customer.subscription.')) return syncVenueSubscription(obj.id);
  return { ignored: event.type };
}

// After the redirect back: prove the session is this account's, then write
// the subscription now rather than waiting for the webhook, so the owner lands
// on a dashboard that already shows Roost. A purchase refused at fulfillment
// says so, so the return does not tell the owner it went through.
async function confirmVenueCheckout(userId, sessionId) {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  if (!session || !isVenueObject(session) || venueUserIdFrom(session.metadata) !== userId) {
    throw refusal(404, 'That checkout does not belong to this account.');
  }
  if (session.status !== 'complete') return { complete: false, tier: null };
  if (!idOf(session.subscription)) return { complete: true, tier: null };
  const result = await fulfillVenueCheckout(session);
  if (result.refused) return { complete: true, tier: null, refused: result.refused };
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
  revokeRefundedSubscription,
  stopRoostForRevokedClaim,
  venueCustomerIdFor,
  venueCustomerIdsFor,
  latestVenueSubscription,
  stillBilling,
  subscriptionDates,
  venueTrialUsed,
  closeVenueCustomer,
  venueCheckoutKey,
  grantFromSubscription,
  legacyRoostPrices,
  TRIAL_DAYS,
  ROOST_TIER,
  __test: { SYNC_SQL, venueUserIdFrom, GRACE_MS, STRIPE_MIN_TRIAL_MS, SYNC_LOCK_NAMESPACE, LOCKED_READ },
};
