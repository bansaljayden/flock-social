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
// (stripe_subscription_endings.cause, migration 118, or a purchase refused at
// fulfillment, migration 123). Not Stripe's word on purpose: Stripe can still
// call such a subscription active, and the row says why the grant ended. Any
// status outside GRANT_LIVE_STATUSES revokes in the resolver, so these need
// nothing there.
function endingStatus(cause) {
  if (cause === 'refund') return 'refunded';
  if (cause === 'dispute') return 'disputed';
  if (cause === 'refused') return 'refused';
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

const PROFILE_SQL = 'SELECT id, verified, business_name, stripe_customer_id, google_place_id FROM venue_profiles WHERE user_id = $1';

async function venueProfileFor(userId) {
  const r = await pool.query(PROFILE_SQL, [userId]);
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
//
// THE LISTING'S RECORD OUTLIVES THE ACCOUNT. Both of those tables are keyed on
// the account and go with it when it is deleted, so an owner who took the
// trial, deleted the account and claimed the same listing again was handed
// another 14 days. roost_trial_listings (migration 121) keeps the listings a
// Roost subscription was ever bought for, with no account in it, and the
// writer adds to it whenever it binds a subscription to a listing.
const TRIAL_USED_SQL = `SELECT (EXISTS (SELECT 1 FROM venue_stripe_subscriptions WHERE user_id = $1::int OR google_place_id = $2::varchar)
     OR EXISTS (SELECT 1 FROM venue_subscriptions WHERE user_id = $1::int AND stripe_subscription_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM roost_trial_listings WHERE google_place_id = $2::varchar)) AS used`;

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

// A CUSTOMER SHARED WITH ANOTHER ACCOUNT. An operator may put two venues' plans
// on one Stripe customer (FILL_CUSTOMER_SQL below leaves it where it is), and
// every customer on record used to be treated as this account's alone: the
// account's deletion deleted it, which cancels every subscription on it, the
// other venue's included; Manage billing opened the portal on it, where the
// owner sees and can cancel the other venue's plan and card; a revocation
// expired the other venue's open checkout. A customer is shared when another
// account has it on record (a venue profile, a grant, a subscription record,
// or a Flock Pro customer), or when Stripe holds a subscription on it that
// names another account (namesAnotherAccount). A shared customer is never
// deleted or opened in the portal for one of them, and only this account's
// own subscriptions on it are touched.
const SHARED_CUSTOMERS_SQL = `SELECT c.id FROM unnest($2::text[]) AS c(id)
  WHERE EXISTS (SELECT 1 FROM venue_profiles WHERE stripe_customer_id = c.id AND user_id IS DISTINCT FROM $1::int)
     OR EXISTS (SELECT 1 FROM venue_subscriptions WHERE stripe_customer_id = c.id AND user_id <> $1::int)
     OR EXISTS (SELECT 1 FROM venue_stripe_subscriptions WHERE stripe_customer_id = c.id AND user_id <> $1::int)
     OR EXISTS (SELECT 1 FROM users WHERE stripe_customer_id = c.id AND id <> $1::int)`;

async function customersOnRecordElsewhere(userId, customerIds) {
  if (!customerIds.length) return new Set();
  const r = await pool.query(SHARED_CUSTOMERS_SQL, [userId, customerIds]);
  return new Set((r && Array.isArray(r.rows) ? r.rows : []).map((row) => row.id));
}

// A subscription that is another account's: a Roost plan naming another venue
// account, or a Flock Pro plan naming another person.
function namesAnotherAccount(s, userId) {
  const meta = (s && s.metadata) || {};
  if (meta.app_user_id && String(meta.app_user_id) !== String(userId)) return true;
  const owner = venueUserIdFrom(meta);
  return owner !== null && owner !== userId;
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

// EVERY PAGE OF A STRIPE LIST. A list answers one page, ten items unless asked
// for more, and says has_more when there is another. Every reader here took
// the first page as the whole answer (ten subscriptions for the status route
// and checkout, twenty for a revocation), so a live plan older than ten or
// twenty newer ones that ended (failed payments leave one each) was invisible:
// the status hid Manage billing, checkout sold a second plan, and a revocation
// reported success without cancelling it. Read to the end, a hundred at a
// time. Past MAX_LIST_PAGES the read throws rather than answer from part of
// the list: a refusal can be retried, a wrong answer cannot.
const MAX_LIST_PAGES = 10;
async function listAll(list, params, requestOptions) {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await list({ ...params, limit: 100, ...(after ? { starting_after: after } : {}) }, requestOptions);
    const data = res && Array.isArray(res.data) ? res.data : [];
    out.push(...data);
    if (!res || !res.has_more || data.length === 0) return out;
    after = data[data.length - 1].id;
  }
  throw new Error(`a Stripe list for ${params.customer || 'a customer'} ran past ${MAX_LIST_PAGES} pages`);
}

// Every subscription on a customer, in any status, and every checkout of one
// still open.
const subscriptionsOn = (customerId, requestOptions) =>
  listAll((p, o) => stripe().subscriptions.list(p, o), { customer: customerId, status: 'all' }, requestOptions);
const openSessionsOn = (customerId) =>
  listAll((p, o) => stripe().checkout.sessions.list(p, o), { customer: customerId, status: 'open' });

// Expires every open Roost checkout of this account's on one customer, and
// none of another account's: on a customer two venues share
// (customersOnRecordElsewhere), an open checkout naming the other venue is its
// own business. Answers how many it expired. A session that completed or
// expired in between is the outcome wanted; one still open after a failed
// expire throws. A customer Stripe has deleted (a failed account deletion
// keeps its id on file) holds nothing to expire.
async function expireOwnSessions(customerId, userId) {
  let open;
  try {
    open = await openSessionsOn(customerId);
  } catch (err) {
    if (missingAtStripe(err)) return 0;
    throw err;
  }
  let expired = 0;
  for (const s of open) {
    if (!isVenueObject(s) || venueUserIdFrom(s.metadata) !== userId) continue;
    try {
      await stripe().checkout.sessions.expire(s.id);
      expired += 1;
    } catch (err) {
      const again = await stripe().checkout.sessions.retrieve(s.id).catch(() => null);
      if (!again || again.status === 'open') throw err;
    }
  }
  return expired;
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
// `skip` passes over the subscriptions it answers true for (the status route
// hands in plansLeftBehind).
const createdAt = (s) => Number(s && s.created) || 0;
async function latestVenueSubscription(userId, customerIds, requestOptions, { skip = null } = {}) {
  let newest = null;
  let newestBilling = null;
  for (const customerId of customerIds) {
    let data;
    try {
      data = await subscriptionsOn(customerId, requestOptions);
    } catch (err) {
      if (missingAtStripe(err)) continue;
      throw err;
    }
    for (const s of data) {
      if (!isVenueObject(s) || venueUserIdFrom(s.metadata) !== userId) continue;
      if (skip && skip(s)) continue;
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
//
// A SHARED CUSTOMER IS NOT DELETED (customersOnRecordElsewhere). Deleting it
// cancelled the other venue's plan at once, with no refund, and left that
// venue's profile pointing at a customer that was gone. Only this account's
// own subscriptions on it are cancelled, at once, and the customer stays.
// Its open checkouts stay with it too, and this account's could be paid after
// the account was gone: a plan billed every period with nothing in Flock
// pointing at it. So this account's checkouts on it are expired first, and
// its subscriptions are read again after that, so a checkout paid before the
// expire landed is among the plans cancelled. One that still slips past is
// cancelled and refunded if its checkout completes once the account is gone
// (fulfillForGoneAccount).
//
// WHAT WAS CANCELLED IS SAID, on the way out either way: { cancelled } lists
// the plans still billing that this call ended, and a throw carries the ones
// it ended before it failed as err.cancelledBefore. The customers are closed
// one by one, so a failure on the second could follow the first plan's end,
// and the deletion route told the owner only that Roost could not be
// cancelled while the plan they were paying for already had been.
async function closeVenueCustomer(userId) {
  const customerIds = await venueCustomerIdsFor(userId);
  if (customerIds.length === 0) return false;
  if (!billing.stripeConfigured()) {
    throw refusal(503, `Roost Stripe customers ${customerIds.join(', ')} were not cancelled; Stripe is not configured`, 'STRIPE_NOT_CONFIGURED');
  }
  const cancelled = [];
  // A customer Stripe has deleted (a failed deletion keeps its id on file)
  // holds nothing.
  const heldBy = (customerId) => subscriptionsOn(customerId).catch((err) => {
    if (missingAtStripe(err)) return [];
    throw err;
  });
  try {
    const elsewhere = await customersOnRecordElsewhere(userId, customerIds);
    for (const customerId of customerIds) {
      let held = await heldBy(customerId);
      if (elsewhere.has(customerId) || held.some((s) => namesAnotherAccount(s, userId))) {
        await expireOwnSessions(customerId, userId);
        held = await heldBy(customerId);
        for (const s of held) {
          if (!isVenueObject(s) || venueUserIdFrom(s.metadata) !== userId) continue;
          if (await cancelNow(s, `flock-account-deleted-cancel-${s.id}`)) cancelled.push(s.id);
        }
        console.error(`[venue-billing] venue user ${userId}'s Roost customer ${customerId} is shared with another account, so it was kept and only this account's subscriptions and open checkouts on it were ended.`);
        continue;
      }
      const closed = await billing.closeCustomer(customerId);
      if (!closed) {
        throw refusal(503, `Roost Stripe customer ${customerId} was not cancelled; Stripe is not configured`, 'STRIPE_NOT_CONFIGURED');
      }
      for (const s of held) if (stillBilling(s)) cancelled.push(s.id);
    }
  } catch (err) {
    if (err && typeof err === 'object') err.cancelledBefore = cancelled;
    throw err;
  }
  return { cancelled };
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

// A SUBSCRIPTION THAT MAKES A SECOND CHECKOUT A SECOND BILL, on ANY customer a
// Roost plan of this account is on record with. Only the customer checkout
// uses was asked, so a hand-sold plan on a customer of its own that had gone
// past due beyond the grant's grace (the grant then reads free) let checkout
// sell a new plan while Stripe went on retrying the old one: billed twice. A
// live subscription blocks when it names this account. One naming nobody
// blocks on the customer checkout made for this account (a plan made there by
// hand without its metadata is still this venue's), and nowhere else. One
// naming another account (an operator who put two venues' plans on one
// customer) or a Flock Pro subscription never blocks Roost.
function blocksCheckout(s, userId, checkoutCustomer) {
  if (!s || !LIVE_STATUSES.has(s.status)) return false;
  if (s.metadata && s.metadata.app_user_id) return false;
  const owner = venueUserIdFrom(s.metadata);
  return owner === userId || (owner === null && checkoutCustomer);
}

// A PLAN LEFT WITH THE LISTING ITS CLAIM MOVED AWAY FROM. ROOST_LISTING_MSG
// (routes/venueProfile.js) tells an owner to end the plan before moving the
// claim; once it is set to end the claim can move, and the rest of its period
// stays with the old listing. Stripe still calls that plan active until its
// period ends, and it blocked checkout (ALREADY_SUBSCRIBED) and was the plan
// the status route offered to manage, so the new listing could not buy Roost
// until the old plan ran out, up to a year on the yearly plan, and the one
// button on the card led to Stripe's Renew, which bills for a listing the
// claim has left. A plan bound to another listing than the one the claim
// names now, and ending inside its current period or past collecting
// (endsThisPeriod), bills nothing more for this claim, so neither checkout
// nor the status route counts it. The binding is the listing in its
// metadata, else the one on record (venue_stripe_subscriptions); a plan bound
// to nothing binds to whatever the claim names, as in the resolver, and
// always counts.
const BINDINGS_SQL = 'SELECT stripe_subscription_id, google_place_id FROM venue_stripe_subscriptions WHERE user_id = $1::int';

async function planBindings(userId) {
  const r = await pool.query(BINDINGS_SQL, [userId]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  return new Map(rows.filter((row) => row.google_place_id).map((row) => [row.stripe_subscription_id, row.google_place_id]));
}

// SET TO END MEANS NOTHING MORE IS INVOICED. Any cancel date used to count,
// but Stripe invoices a plan every period until its cancel date, so one with
// a cancel date past the period it is in (a dashboard "cancel on a date", a
// fixed-term founding plan) still renews: skipped as left behind, it let
// checkout sell a second plan while it went on charging, and the card hid it.
// A plan ends this period when it is set to end at its period end, or its
// cancel date is no later than that end, or it is past collecting (unpaid,
// which Stripe no longer tries to charge). A plan with no period end to
// compare is taken as renewing. routes/venueProfile.js applies the same rule
// to the listing guard.
function endsThisPeriod(s) {
  if (!s) return false;
  if (s.status === 'unpaid' || s.cancel_at_period_end) return true;
  const item = s.items && Array.isArray(s.items.data) ? s.items.data[0] : null;
  const periodEnd = (item && item.current_period_end) || s.current_period_end || null;
  return Number.isFinite(s.cancel_at) && s.cancel_at > 0 && Number.isFinite(periodEnd) && s.cancel_at <= periodEnd;
}

function leftBehind(s, placeId, bindings) {
  if (!endsThisPeriod(s)) return false;
  const bound = venuePlaceIdFrom(s.metadata) || (bindings && bindings.get(s.id)) || null;
  return !!bound && bound !== (placeId || null);
}

// For the status route: which of the account's plans were left with a listing
// its claim no longer names.
async function plansLeftBehind(userId, placeId) {
  const bindings = await planBindings(userId);
  return (s) => leftBehind(s, placeId, bindings);
}

async function blockingSubscription(userId, checkoutCustomerId, placeId) {
  const customers = [...new Set([checkoutCustomerId, ...(await venueCustomerIdsFor(userId))].filter(Boolean))];
  const bindings = await planBindings(userId);
  for (const customerId of customers) {
    let data;
    try {
      data = await subscriptionsOn(customerId);
    } catch (err) {
      if (missingAtStripe(err)) continue;
      throw err;
    }
    const found = data.find((s) => blocksCheckout(s, userId, customerId === checkoutCustomerId) && !leftBehind(s, placeId, bindings));
    if (found) return found;
  }
  return null;
}

// One trial per venue. A customer who has ever held a Roost subscription, in
// any state, has had theirs.
async function hasEverSubscribed(customerId) {
  const list = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 1 });
  return list.data.length > 0;
}

// Only the newest checkout can ever be paid; see proBilling.expireOpenSessions
// for why a session that will not expire blocks a second one. A session that
// names another venue account (a customer an operator shared between two
// venues) is that venue's checkout, not this one's to expire.
async function expireOpenSessions(customerId, userId) {
  for (const s of await openSessionsOn(customerId)) {
    if (namesAnotherAccount(s, userId)) continue;
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
  await expireOpenSessions(customerId, user.id);
  if (await blockingSubscription(user.id, customerId, profile.google_place_id)) {
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
//
// NEVER ON A SHARED CUSTOMER. Stripe's portal is customer-wide: it lists every
// subscription, invoice and card on the customer, and lets whoever opens it
// cancel any of them. On a customer another account shares
// (customersOnRecordElsewhere) that is the other venue's plan, so the owner is
// sent to email instead.
async function customerShared(userId, customerId) {
  if ((await customersOnRecordElsewhere(userId, [customerId])).has(customerId)) return true;
  let held;
  try {
    held = await subscriptionsOn(customerId);
  } catch (err) {
    if (missingAtStripe(err)) return false;
    throw err;
  }
  return held.some((s) => namesAnotherAccount(s, userId));
}

async function createVenuePortal(userId) {
  const customerIds = await venueCustomerIdsFor(userId);
  if (customerIds.length === 0) throw refusal(404, 'There is no Roost subscription on this account.', 'NO_WEB_SUBSCRIPTION');
  const latest = customerIds.length > 1 ? await latestVenueSubscription(userId, customerIds) : null;
  const customerId = latest ? latest.customerId : customerIds[0];
  if (await customerShared(userId, customerId)) {
    throw refusal(409, 'Billing for your Roost plan is shared with another venue, so we handle it by email. Write to social@flockcorp.com.', 'SHARED_BILLING');
  }
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

// The earliest of the dates given that has already passed, or null.
function earliestPast(dates, now) {
  let found = null;
  for (const d of dates) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime()) || d.getTime() > now) continue;
    if (!found || d.getTime() < found.getTime()) found = d;
  }
  return found;
}

// What one Stripe subscription means for the grant. Pure, so a test can walk
// every status through it. unknownPriceIsRoost is for a subscription Stripe is
// still billing on a price missing from the configuration (see
// syncVenueSubscription): it counts that price as Roost. endedBy is the cause
// recorded for a subscription we ended early (a full refund, a dispute): it
// is never live, whatever Stripe's status says, and its status is written as
// that cause (endingStatus above). endedAt is when that ending was recorded.
//
// AN ENDED PLAN'S DATE IS THE DAY IT ENDED, ON EVERY READ. A plan that is not
// live used to be written as ending now whenever its period end was still
// ahead, so a yearly plan cancelled at once on one day and replayed the next
// was said to have ended the next day, and every later event moved the date
// again. It is the earliest of the moments it really stopped: Stripe's
// ended_at, the day we recorded ending it, and a period end already past.
// Only a plan with none of those (unpaid, paused) is written as ending now,
// and SYNC_SQL keeps the first such date on a replay.
function grantFromSubscription(sub, now = Date.now(), { unknownPriceIsRoost = false, endedBy = null, endedAt = null } = {}) {
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
    const endedByUs = endedBy && endedAt ? new Date(endedAt) : null;
    expiresAt = earliestPast([toDate(sub.ended_at), endedByUs, periodEnd], now) || new Date(now);
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
//            And a subscription bound to another listing than the one the
//            claim names never takes the row from a different, live Stripe
//            plan that serves the claim (bound to the claim's listing, or to
//            none). After the move ROOST_LISTING_MSG describes, the old plan
//            runs out its period while the new listing has a plan of its own,
//            and any live event of the old one (an update, a resent checkout,
//            the old success link) wrote the row back to the old listing: the
//            new plan, paid for, served nothing until its own next event, up
//            to a year away, and the listing guard (routes/venueProfile.js),
//            which reads this row, saw the old plan's cancel date and let the
//            claim move again while the new plan renewed.
//   upd      moves the cache only when it changes, only when the grant was
//            written, never to a paid tier for an unverified profile, and
//            never to a paid tier for a claim that names a different listing
//            from the one the subscription is bound to ($13, ONE VENUE PER
//            PLAN at the top of this file). A subscription bound to no
//            listing binds nothing, as in the resolver.
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
      -- An ended plan keeps the day it ended (grantFromSubscription): a dead
      -- event of the same subscription over a row already ended never moves
      -- that day later.
      expires_at = CASE WHEN NOT $11::boolean
                         AND venue_subscriptions.source = 'stripe'
                         AND venue_subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id
                         AND venue_subscriptions.status NOT IN ('active', 'trialing', 'past_due')
                         AND venue_subscriptions.expires_at < EXCLUDED.expires_at
                        THEN venue_subscriptions.expires_at ELSE EXCLUDED.expires_at END,
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
      AND NOT (EXCLUDED.google_place_id IS NOT NULL
       AND EXCLUDED.google_place_id IS DISTINCT FROM (SELECT google_place_id FROM old)
       AND venue_subscriptions.source = 'stripe'
       AND venue_subscriptions.stripe_subscription_id IS DISTINCT FROM EXCLUDED.stripe_subscription_id
       AND venue_subscriptions.status IN ('active', 'trialing', 'past_due')
       AND venue_subscriptions.expires_at > NOW()
       AND (venue_subscriptions.google_place_id IS NULL
            OR venue_subscriptions.google_place_id IS NOT DISTINCT FROM (SELECT google_place_id FROM old)))
    RETURNING user_id
  ),
  upd AS (
    UPDATE venue_profiles SET tier = $12::text, updated_at = NOW()
      FROM old
     WHERE venue_profiles.user_id = old.user_id
       AND EXISTS (SELECT 1 FROM granted)
       AND old.tier IS DISTINCT FROM $12::text
       AND ($12::text = 'free' OR old.verified = true)
       AND ($12::text = 'free' OR $13::varchar IS NULL OR old.google_place_id IS NOT DISTINCT FROM $13::varchar)
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
// without one keeps the listing its claim named when it first arrived (or,
// for a claim with no listing then, the first one it names), read from the
// row and never from whatever the claim names later. Nothing is recorded for
// an account that no longer exists (a deletion's own cancel event), and the
// binding then comes from the metadata alone.
const RECORD_SUBSCRIPTION_SQL = `INSERT INTO venue_stripe_subscriptions (stripe_subscription_id, user_id, stripe_customer_id, google_place_id)
  SELECT $1::text, u.id, $3::text, COALESCE($4::varchar, vp.google_place_id)
    FROM users u
    LEFT JOIN venue_profiles vp ON vp.user_id = u.id
   WHERE u.id = $2::int
  ON CONFLICT (stripe_subscription_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, venue_stripe_subscriptions.stripe_customer_id),
    google_place_id = COALESCE($4::varchar, venue_stripe_subscriptions.google_place_id, EXCLUDED.google_place_id)
  RETURNING google_place_id, refused_at`;

// THE FIRST TIME A SUBSCRIPTION IS SERVED (migration 121). Fulfillment never
// refuses or refunds a subscription that has been (fulfillVenueCheckout), so
// it is written on the sync's own transaction, by the read that served it.
// Never over a refusal (migration 123): the two are decided on this one row,
// each only while the other is unset, so whichever lands first stands. The
// admin's verify writes the same mark when it is the step that starts serving
// a plan (routes/admin.js).
const MARK_SERVED_SQL = 'UPDATE venue_stripe_subscriptions SET served_at = NOW() WHERE stripe_subscription_id = $1::text AND served_at IS NULL AND refused_at IS NULL';

// A PURCHASE REFUSED AT FULFILLMENT, DECIDED UNDER THE VENUE'S LOCK
// (decideRefusal). The claim is read with its row locked, so a verification
// landing at the same moment either finishes first, and the claim is good, or
// waits until the refusal is written. The refusal is then marked on the
// subscription's record only while it has never been served, inserting the
// record when the writer has not seen the subscription yet (the binding is
// RECORD_SUBSCRIPTION_SQL's). No row back means it was served: delivered,
// and never refused.
const PROFILE_FOR_UPDATE_SQL = `${PROFILE_SQL} FOR UPDATE`;
const REFUSE_SQL = `INSERT INTO venue_stripe_subscriptions (stripe_subscription_id, user_id, stripe_customer_id, google_place_id, refused_at)
  SELECT $1::text, u.id, $3::text, COALESCE($4::varchar, vp.google_place_id), NOW()
    FROM users u
    LEFT JOIN venue_profiles vp ON vp.user_id = u.id
   WHERE u.id = $2::int
  ON CONFLICT (stripe_subscription_id) DO UPDATE SET refused_at = COALESCE(venue_stripe_subscriptions.refused_at, NOW())
   WHERE venue_stripe_subscriptions.served_at IS NULL
  RETURNING refused_at`;

// WHAT A REFUSAL STILL OWES (migration 123). Written before anything is
// cancelled, kept with no account in it, and finished (finishRefusal) the
// next time the checkout is handled, whoever and whatever is left by then.
const RECORD_REFUSAL_SQL = `INSERT INTO roost_refused_purchases (stripe_subscription_id, stripe_checkout_session_id, stripe_invoice_id, reason)
  VALUES ($1::text, $2::text, $3::text, $4::varchar)
  ON CONFLICT (stripe_subscription_id) DO NOTHING`;
const REFUSAL_SQL = 'SELECT stripe_subscription_id, stripe_checkout_session_id, stripe_invoice_id, reason, created_at, finished_at FROM roost_refused_purchases WHERE stripe_subscription_id = $1::text';
const FINISH_REFUSAL_SQL = 'UPDATE roost_refused_purchases SET finished_at = NOW() WHERE stripe_subscription_id = $1::text AND finished_at IS NULL';

// The listing's trial is used, whoever's account bought the plan (migration
// 121, TRIAL_USED_SQL). Written for an account that no longer exists too, from
// the listing in the metadata: a deletion's own cancel event can be the first
// event a trial bought a moment before it ever sends.
const RECORD_TRIAL_LISTING_SQL = 'INSERT INTO roost_trial_listings (google_place_id) VALUES ($1::varchar) ON CONFLICT (google_place_id) DO NOTHING';

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
const ENDED_SQL = 'SELECT cause, created_at FROM stripe_subscription_endings WHERE stripe_subscription_id = $1::text ORDER BY id LIMIT 1';

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
//
// A REFUSED PURCHASE STAYS ENDED. A subscription refused at fulfillment
// (refused_at on its record, migration 123) is written as ended by us on this
// and every later event, like a refund or a dispute, so a cancel that has not
// landed yet never lets a later event serve it. `refuse` is fulfillment asking
// for that refusal to be decided here, under this venue's lock
// (decideRefusal); the answer comes back as `decision`, with the refusal when
// one was recorded.
async function syncVenueSubscription(subscriptionId, { refuse = null } = {}) {
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
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
    // The listing this subscription pays for (ONE VENUE PER PLAN).
    const metaPlace = venuePlaceIdFrom(sub.metadata);
    const decided = refuse ? await decideRefusal(client, refuse, sub, userId, customerId, metaPlace) : null;
    const ended = await client.query(ENDED_SQL, [sub.id]);
    const endingRow = ended && Array.isArray(ended.rows) && ended.rows[0] ? ended.rows[0] : null;
    const recorded = await client.query(RECORD_SUBSCRIPTION_SQL, [sub.id, userId, customerId || null, metaPlace]);
    const recordRow = recorded && Array.isArray(recorded.rows) ? recorded.rows[0] : null;
    const boundPlace = recordRow ? recordRow.google_place_id : metaPlace;
    const refusedAt = (decided && decided.refusedAt) || (recordRow && recordRow.refused_at) || null;
    const endedBy = endingRow ? endingRow.cause : refusedAt ? 'refused' : null;
    const endedAt = endingRow ? endingRow.created_at : refusedAt;
    let g = grantFromSubscription(sub, Date.now(), { endedBy, endedAt });
    if (!g.priceOk && KEEP_STATUSES.has(sub.status) && !endedBy) {
      console.error(`[venue-billing] subscription ${sub.id} is ${g.status} on price ${g.priceId}, which is not a configured Roost price. Stripe is billing it, so Roost is kept through the period being billed. If the price is real, set it in STRIPE_PRICE_ROOST_* (a price no longer sold goes in STRIPE_PRICE_ROOST_LEGACY).`);
      g = grantFromSubscription(sub, Date.now(), { unknownPriceIsRoost: true });
    }
    // The refusal decided just now is cancelled straight after this commits
    // (finishRefusal), so only a later event finding it still billing says so.
    if (endedBy && KEEP_STATUSES.has(sub.status) && !(decided && decided.decision === 'refused')) {
      console.error(`[venue-billing] subscription ${sub.id} is ${sub.status} at Stripe, but we ended it (${endedBy}), so the grant stays revoked. Cancel it in Stripe if it is still billing.`);
    }
    if (!g.priceOk) {
      console.error(`[venue-billing] subscription ${sub.id} is ${g.status} on price ${g.priceId}, which is not a configured Roost price. It is not live, so the grant is revoked as for any ended subscription.`);
    }
    if (boundPlace) await client.query(RECORD_TRIAL_LISTING_SQL, [boundPlace]);
    if (customerId) await client.query(FILL_CUSTOMER_SQL, [userId, customerId]);
    const r = await client.query(SYNC_SQL, [
      userId, g.grantTier, g.status, g.expiresAt, customerId || null, sub.id, g.priceId,
      g.periodEnd, g.cancelAt, g.trialEnd, g.live, g.cachedTier, boundPlace || null,
    ]);
    const row = r.rows[0] || {};
    // Bound to no listing binds nothing (the resolver's rule too).
    const otherListing = !!boundPlace && boundPlace !== (row.place_id || null);
    const served = !!row.profiles && g.live && row.verified === true && !otherListing;
    if (served) await client.query(MARK_SERVED_SQL, [sub.id]);
    await client.query('COMMIT');
    const asked = decided ? { decision: decided.decision, refusal: decided.refusal || null } : {};
    if (!row.profiles) return { ignored: 'no_venue_profile', ...asked };
    if (g.live && otherListing) {
      console.error(`[venue-billing] venue user ${userId} holds a live Roost subscription (${sub.id}) bought for listing ${boundPlace || 'none'}, but the claim names ${row.place_id || 'no listing'}, so it is not served there. To move the plan, set flock_venue_place_id on the subscription in Stripe to the listing the claim names; otherwise cancel it.`);
    }
    // Live and not written, for a plan not bound to another listing, can
    // only be the rule in SYNC_SQL that keeps a grant we wrote: Stripe is
    // billing a venue that already holds Roost from us for longer than this
    // period. Nothing is taken from the venue, but somebody is paying for
    // what we gave away, so it is said out loud. A plan for another listing
    // that was kept off the row is said just above.
    if (g.live && !(row.written > 0) && !otherListing) {
      console.error(`[venue-billing] venue user ${userId} holds a Roost grant from us (a comp or a hand-sold plan) that runs past Stripe subscription ${sub.id} (${g.status}), so the grant was kept and the subscription was not written over it. Stripe has billed a venue we already cover: refund or cancel it in Stripe, or end the grant.`);
    }
    if (g.live && row.verified !== true) {
      console.error(`[venue-billing] venue user ${userId} holds a live Roost subscription (${sub.id}) but the profile is not verified, so no tier is served. Verify the claim or refund it.`);
    }
    return { userId, tier: served ? g.cachedTier : 'free', status: g.status, written: row.written > 0, ...asked };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// THE REFUSAL, DECIDED WHERE A DELIVERY IS. Fulfillment used to read the claim
// and then whether the subscription had been served, each in a query of its
// own, and cancel and refund on what it read: a verification that landed in
// between made the plan served (the resolver serves a Stripe grant the moment
// its claim is verified) while fulfillment went on to refund it. Here, inside
// the sync's transaction and under the venue's lock, the claim is read with its
// row locked and the refusal is marked on the subscription's record only while
// it has never been served (REFUSE_SQL), and the grant written in this same
// transaction is ended by it. Answers 'good' (the claim is good now; nothing
// is refused), 'gone' (the account's venue is gone), 'moved' (an operator has
// since moved the plan to another account, whose it is), 'delivered' (it was
// served, so it is never refused), or 'refused', with what the refusal owes.
async function decideRefusal(client, { session, userId: buyer, placeId, why }, sub, userId, customerId, metaPlace) {
  if (buyer !== userId) return { decision: 'moved' };
  const claim = await client.query(PROFILE_FOR_UPDATE_SQL, [userId]);
  const profile = claim && Array.isArray(claim.rows) ? claim.rows[0] : null;
  if (!profile) return { decision: 'gone' };
  if (claimIsGood(profile, placeId)) return { decision: 'good' };
  const marked = await client.query(REFUSE_SQL, [sub.id, userId, customerId || null, metaPlace]);
  const mark = marked && Array.isArray(marked.rows) ? marked.rows[0] : null;
  if (!mark) return { decision: 'delivered' };
  const refusal = await recordRefusal(client, session, sub.id, why);
  return { decision: 'refused', refusal, refusedAt: mark.refused_at };
}

// The invoice a refused purchase paid, or null when it took nothing (a trial).
function refundableInvoice(session) {
  return session && session.payment_status !== 'no_payment_required' ? idOf(session.invoice) : null;
}

async function refusalOnRecord(subscriptionId, db = pool) {
  const r = await db.query(REFUSAL_SQL, [subscriptionId]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  return rows[0] || null;
}

// Records what a refusal owes, once per subscription: a second handling of
// the same checkout finds the first record and finishes that one.
async function recordRefusal(db, session, subscriptionId, why) {
  const sessionId = session && typeof session.id === 'string' ? session.id : null;
  await db.query(RECORD_REFUSAL_SQL, [subscriptionId, sessionId, refundableInvoice(session), why.reason]);
  const refusal = await refusalOnRecord(subscriptionId, db);
  if (!refusal) throw new Error(`the refusal of Roost subscription ${subscriptionId} was written and then not found`);
  return refusal;
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

// THE INVOICE THAT PAID FOR THE PERIOD BEING SERVED. This used to be "the
// subscription's latest invoice", which is only the most recent invoice made,
// not the one paying for the period. A mid-period change makes a proration
// invoice that becomes the latest, so refunding a $10 adjustment in full
// cancelled a yearly plan whose $990 was still paid, and a full refund of the
// $990 itself, once a proration had come after it, left the year of Roost
// standing. The invoice that pays for the period carries a line for the
// subscription's own item, not a proration, covering that period: its period
// ends when the subscription's current period ends. A proration line, an
// invoice item, or a period that has since been renewed past does not count.
function linePaysPeriod(line, subscriptionId, periodEnd) {
  if (!line || !line.period || line.period.end !== periodEnd) return false;
  const details = line.parent && line.parent.type === 'subscription_item_details' ? line.parent.subscription_item_details : null;
  // An invoice rendered before Stripe's 2025-03-31 API names the line's kind
  // on the line itself.
  const subscriptionLine = details ? true : line.type === 'subscription';
  const proration = details ? details.proration === true : line.proration === true;
  const lineSub = details ? idOf(details.subscription) : idOf(line.subscription);
  return subscriptionLine && !proration && (!lineSub || lineSub === subscriptionId);
}

async function paysCurrentPeriod(invoice, sub) {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const periodEnd = (item && item.current_period_end) || sub.current_period_end || null;
  if (!invoice || !periodEnd) return false;
  const lines = invoice.lines && Array.isArray(invoice.lines.data) ? invoice.lines.data : [];
  if (lines.some((l) => linePaysPeriod(l, sub.id, periodEnd))) return true;
  if (!invoice.lines || !invoice.lines.has_more || !invoice.id) return false;
  const rest = await listAll((p, o) => stripe().invoices.listLineItems(invoice.id, p, o), {});
  return rest.some((l) => linePaysPeriod(l, sub.id, periodEnd));
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
//   ONLY THE CURRENT PERIOD. The refunded invoice has to be the one that paid
//   for the period being served now (paysCurrentPeriod). A full refund of
//   last month, after this month was paid, returned nothing that pays for
//   today, so today's grant stands.
//
//   DURABLY. The decision is recorded (stripe_subscription_endings, migration
//   118) before anything else, and the writer reads that on every sync, so a
//   later event that still reads the subscription as active cannot restore
//   it. Then the subscription is cancelled now, without proration: the money
//   for the period is back with the venue, so there is nothing paid to run
//   out, and a subscription left open would bill again at its next renewal.
//   Last, the grant is written from Stripe as usual, which revokes it now.
//
//   A RECORDED ENDING IS FINISHED FIRST, whatever came after it. When the
//   cancel failed after the ending was recorded, the webhook answered 500 and
//   Stripe sent the event again, but by then the subscription could have
//   renewed, the period check below no longer matched, and the retry
//   answered not_current_roost_period without cancelling: Stripe went on
//   billing a subscription the writer refuses to grant for good. Every
//   subscription already recorded for this charge is cancelled and written
//   again before anything is decided anew, the way a recorded dispute is
//   (proBilling.cancelDisputedSubscriptions).
//
// A Pro subscription is left alone: RevenueCat reads Stripe's refunds itself
// and revokes on its own path (routes/revenuecat.js).
async function revokeRefundedSubscription(obj) {
  const chargeId = obj && obj.object === 'charge'
    ? (typeof obj.id === 'string' ? obj.id : null)
    : (typeof (obj && obj.charge) === 'string' ? obj.charge : obj && obj.charge && obj.charge.id) || null;
  if (!chargeId) return { ignored: 'no_charge' };
  const revoked = [];
  const recorded = await billing.endingsRecordedFor('refund', chargeId);
  for (const r of recorded) {
    if (revoked.includes(r.stripe_subscription_id)) continue;
    const sub = await stripe().subscriptions.retrieve(r.stripe_subscription_id);
    if (!isVenueObject(sub)) continue;
    await cancelNow(sub, `flock-refund-cancel-${sub.id}`);
    await syncVenueSubscription(sub.id);
    revoked.push(sub.id);
  }
  const answer = (ignored) => (revoked.length ? { revoked } : { ignored });
  const charge = await stripe().charges.retrieve(chargeId);
  const amount = charge && Number.isFinite(charge.amount) ? charge.amount : 0;
  if (!(amount > 0)) return answer('no_payment');
  if ((await succeededRefundTotal(chargeId)) < amount) return answer('partial_refund');
  const { funded } = await billing.subscriptionsFundedBy(charge);
  if (funded.length === 0) return answer('no_subscription');
  for (const f of funded) {
    if (recorded.some((r) => r.stripe_subscription_id === f.subscriptionId)) continue;
    const sub = await stripe().subscriptions.retrieve(f.subscriptionId);
    if (!isVenueObject(sub)) continue;
    if (!(await paysCurrentPeriod(f.invoice, sub))) {
      console.log(`[venue-billing] charge ${chargeId} was refunded in full, but invoice ${f.invoiceId} did not pay for subscription ${sub.id}'s current period (an earlier period, or an adjustment), so Roost stands.`);
      continue;
    }
    await billing.recordEnding({ cause: 'refund', sourceId: chargeId, subscriptionId: sub.id, invoiceId: f.invoiceId, chargeId });
    await cancelNow(sub, `flock-refund-cancel-${sub.id}`);
    await syncVenueSubscription(sub.id);
    revoked.push(sub.id);
  }
  return answer('not_current_roost_period');
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
// every open Roost checkout of the account's, on every customer it has on
// record, and cancels every Roost subscription of the account's.
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
    // A customer Stripe has deleted (a failed account deletion keeps its id on
    // file) holds nothing to stop.
    const orNothing = (err) => {
      if (missingAtStripe(err)) return [];
      throw err;
    };
    for (const customerId of customers) {
      // Only this account's checkouts (expireOwnSessions).
      outcome.checkoutsExpired += await expireOwnSessions(customerId, userId);
      for (const s of await subscriptionsOn(customerId).catch(orNothing)) {
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

// Whether a claim is still good for a plan bought for `placeId`: 'good' when
// the account's venue is verified and still names that listing, 'bad' when it
// is not, and 'gone' when the account has no venue any more (its deletion
// took the profile with it). A session from before flock_venue_place_id
// existed names no listing, and then verified alone decides.
function claimIsGood(profile, placeId) {
  return !!profile && profile.verified === true && (!placeId || profile.google_place_id === placeId);
}

async function claimFor(userId, placeId) {
  const profile = await venueProfileFor(userId);
  if (!profile) return 'gone';
  return claimIsGood(profile, placeId) ? 'good' : 'bad';
}

// Why a purchase was refused: the reason the refusal is recorded under and the
// refund carries at Stripe, the prefixes of the idempotency keys that make a
// retried cancel and refund happen once, and the code a return from Stripe is
// answered with.
const CLAIM_NOT_VERIFIED_REFUND = {
  reason: 'claim_not_verified', key: 'flock-claim-revoked-refund', cancelKey: 'flock-claim-revoked-cancel', code: 'CLAIM_NOT_VERIFIED',
};
const ACCOUNT_DELETED_REFUND = {
  reason: 'account_deleted', key: 'flock-account-deleted-refund', cancelKey: 'flock-account-deleted-cancel', code: 'ACCOUNT_DELETED',
};
const REFUSALS = new Map([CLAIM_NOT_VERIFIED_REFUND, ACCOUNT_DELETED_REFUND].map((why) => [why.reason, why]));

// The money a refused purchase took, given back. A trial took none (its
// refusal records no invoice). The first invoice of the session is paid by one
// PaymentIntent (InvoicePayments, the same lookup proBilling.subscriptionsFundedBy
// documents), and the refund is keyed on the invoice, so every retry asks for
// the same refund and Stripe makes it once. A payment already refunded is the
// outcome wanted. Answers whether nothing more is owed: an invoice that shows
// no payment yet leaves the refusal open, and the next handling of its
// checkout tries again.
async function refundRefusedInvoice(invoiceId, why) {
  if (!invoiceId) return true;
  const list = await stripe().invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 10 });
  const paid = (list && Array.isArray(list.data) ? list.data : [])
    .find((p) => p && p.status === 'paid' && p.payment && idOf(p.payment.payment_intent));
  if (!paid) {
    console.error(`[venue-billing] invoice ${invoiceId} of a refused Roost purchase shows no payment to refund yet, so the refusal stays open until its checkout is handled again.`);
    return false;
  }
  try {
    await stripe().refunds.create(
      { payment_intent: idOf(paid.payment.payment_intent), metadata: { flock_reason: why.reason } },
      { idempotencyKey: `${why.key}-${invoiceId}` }
    );
  } catch (err) {
    if (!(err && err.code === 'charge_already_refunded')) throw err;
  }
  return true;
}

// A REFUSAL ON RECORD IS FINISHED, WHATEVER CAME AFTER IT. The cancel and the
// refund are two calls to Stripe, and the refund used to be asked for only
// when this handling's cancel was the one that ended the plan: a refund that
// failed after its cancel went through was never asked for again, because the
// retry found the plan cancelled. Now every handling of a refused checkout
// finishes its recorded refusal: the plan is cancelled unless Stripe already
// ended it (and only while it still names the buyer's account; one an operator
// has since moved is that account's), and the refund is asked for under the
// same idempotency key, whatever the subscription's status, the claim or the
// account is by then. finished_at is set once nothing more is owed, so a later
// replay asks Stripe for nothing. Then the grant is written from Stripe, ended
// by the refusal.
async function finishRefusal(session, refusal) {
  const why = REFUSALS.get(refusal.reason) || CLAIM_NOT_VERIFIED_REFUND;
  const subscriptionId = refusal.stripe_subscription_id;
  if (!refusal.finished_at) {
    const sub = await stripe().subscriptions.retrieve(subscriptionId);
    const buyer = venueUserIdFrom(session && session.metadata);
    if (isVenueObject(sub) && venueUserIdFrom(sub.metadata) === buyer) await cancelNow(sub, `${why.cancelKey}-${sub.id}`);
    if (await refundRefusedInvoice(refusal.stripe_invoice_id, why)) {
      await pool.query(FINISH_REFUSAL_SQL, [subscriptionId]);
      console.error(`[venue-billing] checkout ${refusal.stripe_checkout_session_id || 'unknown'} was refused (${why.reason}), so subscription ${subscriptionId} was cancelled and what it took refunded.`);
    }
  }
  const result = await syncVenueSubscription(subscriptionId);
  return { ...result, tier: 'free', refused: why.code };
}

// A PURCHASE FOR AN ACCOUNT THAT IS GONE. The deletion ended every Roost plan
// of the account's that Stripe listed, or was refused (closeVenueCustomer), so
// a plan of its still billing now is one the deletion never saw: a checkout
// that slipped past it on a customer it kept because another venue shares
// it. Fulfillment used to write it from Stripe and stop, which records
// nothing for an account that does not exist, so it renewed every period
// with nothing in Flock pointing at it. An account that is gone
// can never be served, so that plan is refused: the refusal is recorded first
// (no account in it, migration 123), then the plan is cancelled now and what
// it took refunded (finishRefusal). A plan the deletion already ended is left
// as it is: whether it was ever served went with the account's records, and a
// replay must not refund a plan used for months. Only a plan that still names
// the account is touched; one an operator has since moved to another account
// is theirs.
async function fulfillForGoneAccount(session, subscriptionId, userId) {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const theirs = isVenueObject(sub) && venueUserIdFrom(sub.metadata) === userId;
  if (theirs && !ENDED_STATUSES.has(sub.status)) {
    const refusal = await recordRefusal(pool, session, sub.id, ACCOUNT_DELETED_REFUND);
    return finishRefusal(session, refusal);
  }
  console.log(`[venue-billing] checkout ${session.id} was handed back for venue user ${userId}, whose account is gone, and subscription ${subscriptionId} is not billing for it, so nothing was cancelled or refunded.`);
  return syncVenueSubscription(subscriptionId);
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
//
// ONLY A PURCHASE THAT WAS NEVER DELIVERED. Fulfillment runs again whenever a
// completed session is handed back: the owner reopens the old success link or
// sends a confirm by hand with any session the account owns, or Stripe resends
// checkout.session.completed. It judged the claim as it was at that moment, so
// a plan used for months, then set to end and its claim moved on (the steps
// ROOST_LISTING_MSG gives), had its first payment refunded on any replay, and
// so did a plan that had already ended, or one whose claim an admin revoked,
// where whether to refund is a person's call (stopRoostForRevokedClaim). So a
// subscription ever served (served_at, migration 121: written by the writer,
// or by the admin's verify when that is what starts serving it) is never
// refused or refunded here: it is only written from Stripe as usual, and the
// writer serves nothing to a claim that is not good. The refusal itself is
// decided under the venue's lock, against the claim and the delivery mark as
// they are there (decideRefusal), and recorded before anything is cancelled;
// a refusal already on record is finished first, whatever has changed since
// (finishRefusal). A purchase whose account is gone is decided apart
// (fulfillForGoneAccount).
async function fulfillVenueCheckout(session) {
  const subscriptionId = idOf(session && session.subscription);
  if (!subscriptionId) return { ignored: 'no_subscription' };
  const recorded = await refusalOnRecord(subscriptionId);
  if (recorded) return finishRefusal(session, recorded);
  const userId = venueUserIdFrom(session.metadata);
  const placeId = venuePlaceIdFrom(session.metadata);
  if (!userId) return syncVenueSubscription(subscriptionId);
  const claim = await claimFor(userId, placeId);
  if (claim === 'good') return syncVenueSubscription(subscriptionId);
  if (claim === 'gone') return fulfillForGoneAccount(session, subscriptionId, userId);
  const { decision, refusal, ...result } = await syncVenueSubscription(subscriptionId, {
    refuse: { session, userId, placeId, why: CLAIM_NOT_VERIFIED_REFUND },
  });
  if (decision === 'refused') return finishRefusal(session, refusal);
  if (decision === 'gone') return fulfillForGoneAccount(session, subscriptionId, userId);
  if (decision === 'delivered') {
    console.log(`[venue-billing] checkout ${session.id} was handed back for venue user ${userId}, whose claim is not verified for listing ${placeId || 'none'} now, but subscription ${subscriptionId} was already delivered, so nothing was cancelled or refunded.`);
  }
  return result;
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
  plansLeftBehind,
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
