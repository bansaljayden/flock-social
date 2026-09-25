'use strict';
// ---------------------------------------------------------------------------
// FLOCK PRO ON THE WEB: Stripe Checkout in, RevenueCat as the one answer.
//
// THE SHAPE, AND WHY IT IS THIS ONE. Pro can be bought two ways: Apple's in-app
// purchase inside the iOS app, and Stripe Checkout on flockcorp.com. Both have
// to unlock the same thing everywhere, so there has to be ONE record of "is
// this account Pro right now". That record is RevenueCat's. Its Stripe
// integration reads the `app_user_id` this file writes into every Checkout
// Session and Subscription, attributes the purchase to our user, and fires the
// same webhook the App Store purchases fire. routes/revenuecat.js stays the
// only writer of users.is_premium, and it asks RevenueCat for the subscriber's
// whole state on every event (syncPremiumFromRevenueCat) instead of flipping a
// boolean per event, because with two stores an Apple EXPIRATION would
// otherwise switch off somebody whose Stripe subscription is still paid.
//
// WHAT THIS FILE DOES NOT DO: decide who is Pro. It creates checkout and
// portal sessions, nudges RevenueCat to pick up a purchase immediately instead
// of within its polling window, and cancels a departing account's Stripe
// subscriptions. Nothing here writes is_premium.
//
// OFF UNTIL EVERY PART EXISTS. webCheckout() is ready only when all of these
// hold, and each missing one is named in `missing` so the status route can say
// which, and so nothing is ever sold that cannot be delivered:
//   * PRO_WEB_CHECKOUT_ENABLED=true, the operator's switch;
//   * PAYWALL_ENABLED=true. With the paywall dormant every account already has
//     every feature, so taking $3.99 would be charging for nothing;
//   * STRIPE_SECRET_KEY and STRIPE_PRICE_PRO_MONTHLY;
//   * REVENUECAT_SECRET_API_KEY, without which a web purchase would never
//     reach users.is_premium and the customer would have paid for nothing.
// ---------------------------------------------------------------------------

const pool = require('../config/database');

const RC_API = 'https://api.revenuecat.com/v1';
const PRO_ENTITLEMENT = process.env.REVENUECAT_ENTITLEMENT_ID || 'pro';

// A key shorter than this is a paste accident, not a key. Same floor for all
// three secrets, for the reason routes/revenuecat.js gives for its own.
const MIN_KEY_LENGTH = 16;

function keyValue(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length >= MIN_KEY_LENGTH ? v : null;
}

function plain(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// Each variable is read by name, in the literal form, so the environment
// inventory test can see what this file depends on.
const stripeSecret = () => keyValue(process.env.STRIPE_SECRET_KEY);
const stripeWebhookSecret = () => keyValue(process.env.STRIPE_WEBHOOK_SECRET);
const rcSecret = () => keyValue(process.env.REVENUECAT_SECRET_API_KEY);
const rcStripePublic = () => keyValue(process.env.REVENUECAT_STRIPE_PUBLIC_KEY);
const stripeConfigured = () => !!stripeSecret();

// Accounts allowed to be Pro through a SANDBOX purchase: App Review's demo
// account and the operator's own test account, as numeric ids, comma
// separated. Everyone else's sandbox purchase unlocks nothing (fetchProActive).
function sandboxUserIds() {
  const raw = plain(process.env.REVENUECAT_SANDBOX_USER_IDS) || '';
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^[1-9][0-9]{0,9}$/.test(s)));
}
function sandboxAllowed(userId) {
  return sandboxUserIds().has(String(userId));
}
const revenueCatApiConfigured = () => !!rcSecret();

let stripeClient = null;
let stripeKeySeen = null;
// One client per key. Lazy, so a process with no Stripe key never loads it,
// and rebuilt if the key changes under a test.
function stripe() {
  const key = stripeSecret();
  if (!key) return null;
  if (!stripeClient || stripeKeySeen !== key) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(key, { maxNetworkRetries: 2, timeout: 15000 });
    stripeKeySeen = key;
  }
  return stripeClient;
}

function webBase() {
  const base = plain(process.env.PUBLIC_WEB_URL) || 'https://www.flockcorp.com';
  return base.replace(/\/+$/, '');
}

// The plans the web can sell, from price ids in the environment. The yearly
// plan is optional: until STRIPE_PRICE_PRO_YEARLY is set, monthly is the only
// thing offered.
function planPrices() {
  const plans = {};
  const monthly = plain(process.env.STRIPE_PRICE_PRO_MONTHLY);
  const yearly = plain(process.env.STRIPE_PRICE_PRO_YEARLY);
  if (monthly) plans.monthly = monthly;
  if (yearly) plans.yearly = yearly;
  return plans;
}

// userId is the signed-in account asking, when there is one: an account on
// the review list (services/entitlements.js previewUserIds) can buy while the
// paywall is still off for everyone else, which is how the whole path from
// flockcorp.com/pro to the app is proven live before launch. The signed-out
// offer (routes/proOffer.js) passes nothing and gets the global answer.
function webCheckout(userId) {
  // Required lazily: entitlements.js requires routes/revenuecat.js, which
  // requires this file.
  const { paywallEnabled, boolFlag } = require('./entitlements');
  const missing = [];
  if (!boolFlag('PRO_WEB_CHECKOUT_ENABLED')) missing.push('PRO_WEB_CHECKOUT_ENABLED');
  if (!paywallEnabled(userId)) missing.push('PAYWALL_ENABLED');
  if (!stripeConfigured()) missing.push('STRIPE_SECRET_KEY');
  if (!planPrices().monthly) missing.push('STRIPE_PRICE_PRO_MONTHLY');
  if (!revenueCatApiConfigured()) missing.push('REVENUECAT_SECRET_API_KEY');
  // Delivery must not depend on the buyer's browser coming back. The signed
  // Stripe webhook hands every completed checkout to RevenueCat from the
  // server, and it needs both of these to do it.
  if (!rcStripePublic()) missing.push('REVENUECAT_STRIPE_PUBLIC_KEY');
  if (!stripeWebhookSecret()) missing.push('STRIPE_WEBHOOK_SECRET');
  return { ready: missing.length === 0, missing };
}

// Stripe Tax is on only once the operator says a registration exists. Turning
// automatic tax on before that computes nothing and asks every buyer for an
// address for no reason.
function taxEnabled() {
  const { boolFlag } = require('./entitlements');
  return boolFlag('STRIPE_AUTOMATIC_TAX');
}

// Trial length in days for web purchases. 0 by default: card networks attach
// extra rules to trials, and a minor can undo a purchase anyway, so the web
// starts without one until somebody decides otherwise.
function trialDays() {
  const n = Number.parseInt(plain(process.env.PRO_WEB_TRIAL_DAYS) || '0', 10);
  return Number.isFinite(n) && n > 0 && n <= 30 ? n : 0;
}

// Price display, read from Stripe rather than restated here, so the page can
// never show a number the checkout will not charge. Cached for ten minutes.
const priceCache = new Map();
const PRICE_TTL_MS = 10 * 60 * 1000;
// A failure is remembered for a minute too. The public pricing card calls
// this, and without a negative entry every homepage visit during a Stripe
// outage would be one more Stripe request.
const PRICE_FAIL_TTL_MS = 60 * 1000;
async function describePrice(priceId) {
  const hit = priceCache.get(priceId);
  if (hit && hit.failed && Date.now() - hit.at < PRICE_FAIL_TTL_MS) throw new Error('price lookup failed recently');
  if (hit && !hit.failed && Date.now() - hit.at < PRICE_TTL_MS) return hit.value;
  let p;
  try {
    p = await stripe().prices.retrieve(priceId);
  } catch (err) {
    priceCache.set(priceId, { at: Date.now(), failed: true });
    throw err;
  }
  const value = {
    unitAmount: p.unit_amount,
    currency: String(p.currency || 'usd').toUpperCase(),
    interval: p.recurring ? p.recurring.interval : null,
  };
  priceCache.set(priceId, { at: Date.now(), value });
  return value;
}

function formatAmount({ unitAmount, currency }) {
  const dollars = (unitAmount / 100).toFixed(2);
  return currency === 'USD' ? `$${dollars}` : `${dollars} ${currency}`;
}

// ---------------------------------------------------------------------------
// RevenueCat
// ---------------------------------------------------------------------------

function rcHeaders(key, extra) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

// Whether this account holds the Pro entitlement right now, per RevenueCat.
// THROWS on anything that is not a clear answer, because the caller is either
// the webhook (a throw is a 500 and RevenueCat retries) or the confirm route
// (a throw is "try again"), and a guessed false would switch a payer off.
async function fetchProActive(userId) {
  const key = rcSecret();
  if (!key) throw new Error('REVENUECAT_SECRET_API_KEY is not configured');
  const r = await fetch(`${RC_API}/subscribers/${encodeURIComponent(String(userId))}`, {
    headers: rcHeaders(key),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`RevenueCat subscriber lookup answered ${r.status}`);
  const body = await r.json();
  const ent = body && body.subscriber && body.subscriber.entitlements
    ? body.subscriber.entitlements[PRO_ENTITLEMENT]
    : null;
  if (!ent) return false;
  const now = Date.now();
  const until = (v) => (v ? Date.parse(v) : null);
  const live = (x) => {
    if (!x) return false;
    // A null expires_date is a lifetime grant. A billing-retry grace period is
    // still Pro, which is what RevenueCat's own SDK reports for it.
    if (x.expires_date === null || x.expires_date === undefined) return true;
    const expires = until(x.expires_date);
    const grace = until(x.grace_period_expires_date);
    return (Number.isFinite(expires) && expires > now) || (Number.isFinite(grace) && grace > now);
  };
  if (!live(ent)) return false;
  // A PURCHASE THAT COST NOTHING UNLOCKS NOTHING. TestFlight and App Review buy
  // in Apple's sandbox, where nobody is charged, and RevenueCat grants the
  // entitlement all the same, so reading it as-is would hand production Pro
  // to every tester, free and renewable forever. A sandbox purchase counts only
  // for the accounts in REVENUECAT_SANDBOX_USER_IDS. An entitlement whose
  // source is sandbox still counts when another purchase that did cost money
  // is live, since this project sells nothing but Pro.
  const subs = (body.subscriber && body.subscriber.subscriptions) || {};
  const source = subs[ent.product_identifier];
  if (source && source.is_sandbox === true && !sandboxAllowed(userId)) {
    return Object.values(subs).some((s) => s && s.is_sandbox !== true && !s.refunded_at && live(s));
  }
  return true;
}

// Tells RevenueCat about a Stripe subscription right away. Its Stripe
// integration would find it on its own, but not within the seconds between a
// buyer finishing checkout and landing back in the app. Best effort: RevenueCat
// catches up from Stripe's notifications either way.
async function postStripeReceipt(userId, subscriptionId) {
  const key = rcStripePublic();
  if (!key || !subscriptionId) return false;
  const r = await fetch(`${RC_API}/receipts`, {
    method: 'POST',
    headers: rcHeaders(key, { 'X-Platform': 'stripe' }),
    body: JSON.stringify({ app_user_id: String(userId), fetch_token: subscriptionId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    console.warn(`[pro] RevenueCat receipt post answered ${r.status}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stripe customers and sessions
// ---------------------------------------------------------------------------

async function customerIdFor(userId) {
  const r = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  return rows[0] ? rows[0].stripe_customer_id || null : null;
}

// The account's Stripe customer, created once. The idempotency key makes two
// racing first checkouts produce ONE customer at Stripe, and the WHERE on the
// update keeps the first id written if both land.
async function ensureCustomer(user) {
  const existing = await customerIdFor(user.id);
  if (existing) return existing;
  const customer = await stripe().customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: { app_user_id: String(user.id) },
  // The key rolls over every hour. Stripe replays an idempotent response for
  // a day, and account deletion deletes the customer; a user whose deletion
  // then failed and who checks out again would otherwise be handed back the
  // DELETED customer and fail for a day. An hour still covers the race it is
  // for, two first checkouts landing together.
  }, { idempotencyKey: `flock-customer-${user.id}-${Math.floor(Date.now() / 3600e3)}` });
  const r = await pool.query(
    `UPDATE users SET stripe_customer_id = $1
      WHERE id = $2 AND stripe_customer_id IS NULL
      RETURNING stripe_customer_id`,
    [customer.id, user.id]
  );
  if (r.rows[0]) return r.rows[0].stripe_customer_id;
  return customerIdFor(user.id);
}

// Statuses that mean a subscription is already running, so a second checkout
// would be a second charge for the same thing. NOT 'incomplete': that is a
// first payment that did not go through (a failed card, an abandoned 3-D
// Secure step). It charged nothing, Stripe expires it within a day, and
// blocking a retry on it told the buyer they already had what they had just
// failed to buy.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

async function hasLiveSubscription(customerId) {
  const list = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  return list.data.some((s) => LIVE_STATUSES.has(s.status));
}

async function expireOpenSessions(customerId) {
  const open = await stripe().checkout.sessions.list({ customer: customerId, status: 'open', limit: 20 });
  const failed = [];
  for (const s of open.data) {
    try {
      await stripe().checkout.sessions.expire(s.id);
    } catch (err) {
      failed.push(s.id);
      console.warn('[pro] could not expire an open checkout session:', err?.message || err);
    }
  }
  // A session that would not expire is only harmless if it is no longer open
  // (it completed or expired between the list and the call). One still open
  // is payable, most likely mid 3-D Secure in another tab, and creating a
  // second would let both be paid. So refuse instead, and say why.
  for (const id of failed) {
    const again = await stripe().checkout.sessions.retrieve(id).catch(() => null);
    if (!again || again.status === 'open') {
      const err = new Error('A Flock Pro checkout is already open. Finish it, or wait a minute and try again.');
      err.status = 409;
      err.code = 'CHECKOUT_IN_PROGRESS';
      throw err;
    }
  }
}

// Whether this customer has ever had a subscription, in any state. Decides
// whether the account has anything to manage in the portal; a customer made
// for a checkout that was abandoned has nothing there.
// "Has ever subscribed" cannot become false again, so a yes is remembered for
// the life of the process and only a no asks Stripe again. The call is on
// /status, which the checkout return polls, so it gets a short timeout and no
// retries: a slow Stripe must not hold the page for three retries of fifteen
// seconds.
const everSubscribed = new Set();
const EVER_SUBSCRIBED_MAX = 50000;
async function hasEverSubscribed(customerId) {
  if (!customerId) return false;
  if (everSubscribed.has(customerId)) return true;
  const list = await stripe().subscriptions.list(
    { customer: customerId, status: 'all', limit: 1 },
    { timeout: 5000, maxNetworkRetries: 0 }
  );
  const yes = list.data.length > 0;
  if (yes) {
    if (everSubscribed.size >= EVER_SUBSCRIBED_MAX) everSubscribed.clear();
    everSubscribed.add(customerId);
  }
  return yes;
}

// The signed Stripe webhook's check. Throws on anything that is not a valid
// signature over these exact bytes.
function constructWebhookEvent(rawBody, signature) {
  const secret = stripeWebhookSecret();
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}

// ONE CHECKOUT BEING BUILT PER ACCOUNT AT A TIME. Expiring the open sessions,
// checking for a live subscription and creating the new session are three
// Stripe calls, and two requests that interleave them (a double click, two
// tabs) could each create a session after the other's expire step, leaving
// two payable at once and charging one person twice. Queued per account on
// this one instance (the app runs on exactly one server; a second would need
// this queue in Postgres, like every other in-memory lock here), the second
// request runs after the first and expires the session the first one made,
// which is the rule the comment inside says it keeps.
const checkoutQueues = new Map();
function withCheckoutLock(userId, fn) {
  const key = String(userId);
  const prev = checkoutQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  checkoutQueues.set(key, tail);
  tail.then(() => { if (checkoutQueues.get(key) === tail) checkoutQueues.delete(key); });
  return run;
}

// WHERE A BUYER CAME FROM, so the trip back from Stripe lands on the thing
// they were blocked from rather than on the home screen. A fixed list, checked
// again here although the route already validates it: this string becomes part
// of a URL Stripe will send the buyer to.
const RETURN_FROM = new Set(['forecast', 'birdie', 'settings', 'pro_page']);
const RETURN_PLACE_RE = /^[A-Za-z0-9_-]{6,128}$/;
// A promotion code as a person types it. Stripe's own codes are letters and
// digits; anything else is not looked up at all.
const PROMO_CODE_RE = /^[A-Za-z0-9]{3,32}$/;

function successUrl(web, { from, place } = {}) {
  let url = `${web}/app?pro=success&session_id={CHECKOUT_SESSION_ID}`;
  if (RETURN_FROM.has(from)) {
    url += `&from=${from}`;
    if (from === 'forecast' && typeof place === 'string' && RETURN_PLACE_RE.test(place)) url += `&place=${place}`;
  }
  return url;
}

// A code in a shared link (/pro?code=FLOCKFRIENDS) is applied for the buyer, so
// they never meet the code field at all. Only an ACTIVE promotion code is
// used, found by its code; anything else, including a lookup that fails,
// leaves the ordinary "Add promotion code" link on Stripe's page instead.
async function activePromotionCode(code) {
  if (typeof code !== 'string' || !PROMO_CODE_RE.test(code)) return null;
  try {
    const list = await stripe().promotionCodes.list({ code, active: true, limit: 1 }, { timeout: 5000, maxNetworkRetries: 0 });
    const pc = list && Array.isArray(list.data) ? list.data[0] : null;
    return pc && pc.active !== false ? pc.id : null;
  } catch (err) {
    console.warn('[pro] promotion code lookup failed; checkout keeps the code field:', err?.message || err);
    return null;
  }
}

// A live code can still be refused for this buyer: first-time customers only,
// a minimum amount, or a code tied to another customer. The buyer came to pay,
// so the session is made again with the ordinary code field instead of
// failing the checkout over a discount.
function isStripeRequestError(err) {
  return !!err && (err.type === 'StripeInvalidRequestError' || err.rawType === 'invalid_request_error');
}

async function createSession(params) {
  try {
    return await stripe().checkout.sessions.create(params);
  } catch (err) {
    if (!params.discounts || !isStripeRequestError(err)) throw err;
    console.warn('[pro] checkout refused the shared code; offering the code field instead:', err?.message || err);
    const { discounts, ...rest } = params; // eslint-disable-line no-unused-vars
    return stripe().checkout.sessions.create({ ...rest, allow_promotion_codes: true });
  }
}

// The sentence directly above Stripe's Pay button. California's automatic
// renewal law wants these five things there, in plain words and before the
// buyer agrees: that it renews until cancelled, the amount, how often, how to
// cancel, and that there is no minimum term. The refund window rides along
// because it is the other thing a buyer asks about at that moment.
function submitText({ amount, every, tax }) {
  return `Flock Pro renews every ${every} at ${amount}${tax ? ' plus tax' : ''} until you cancel, or at the lower price shown above while a code applies. `
    + `There is no minimum term. Cancel any time in Flock on the web (You, Flock Pro, Cancel subscription) or by emailing social@flockcorp.com, and you keep Pro until the paid ${every} ends. `
    + 'Full refund within 14 days of your first payment.';
}

function createCheckout(user, plan, options = {}) {
  return withCheckoutLock(user && user.id, () => buildCheckout(user, plan, options));
}

async function buildCheckout(user, plan, options = {}) {
  const prices = planPrices();
  const priceId = prices[plan];
  if (!priceId) {
    const err = new Error('That plan is not offered.');
    err.status = 400;
    throw err;
  }
  const customerId = await ensureCustomer(user);
  // ONE PAYABLE CHECKOUT PER ACCOUNT. A Checkout Session stays payable for a
  // day, so two tabs, or the back button after "Continue to payment", could
  // each be completed and each create a subscription: two charges for one
  // Pro. Every open session this customer already has is expired before a new
  // one is made, so only the newest can ever be paid.
  await expireOpenSessions(customerId);
  if (await hasLiveSubscription(customerId)) {
    const err = new Error('You already have Flock Pro on the web. Manage it from your account.');
    err.status = 409;
    err.code = 'ALREADY_SUBSCRIBED';
    throw err;
  }
  const price = await describePrice(priceId);
  const every = price.interval === 'year' ? 'year' : 'month';
  const tax = taxEnabled();
  // One trial per customer, ever. Without this a trial is renewable by
  // cancelling and checking out again, which is free Pro forever. Asked only
  // when a trial is configured at all, so it costs no Stripe call today.
  const trial = trialDays() && !(await hasEverSubscribed(customerId)) ? trialDays() : 0;
  const web = webBase();
  const appUserId = String(user.id);
  const promotionCode = await activePromotionCode(options.code);
  const session = await createSession({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: appUserId,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { app_user_id: appUserId, plan },
    subscription_data: {
      metadata: { app_user_id: appUserId, plan },
      ...(trial ? { trial_period_days: trial } : {}),
    },
    automatic_tax: { enabled: tax },
    ...(tax ? { customer_update: { address: 'auto', name: 'auto' }, billing_address_collection: 'required' } : {}),
    // Codes are how Flock gives Pro away (a 100%-off coupon handed to friends
    // and testers). A code that brings the total to zero should not demand a
    // card, so collection is 'if_required'; any real charge still needs one.
    // A trial keeps 'always' so the card is on file before the trial ends.
    // A code from a shared link is applied here and the field is not shown;
    // Stripe refuses a session that carries both.
    ...(promotionCode ? { discounts: [{ promotion_code: promotionCode }] } : { allow_promotion_codes: true }),
    payment_method_collection: trial ? 'always' : 'if_required',
    // The renewal terms sit next to an unchecked box the buyer has to tick,
    // which is what California's automatic renewal law asks of the consent.
    // The price is named for the ordinary buyer, and the sentence stays true
    // for somebody whose promotion code brings the page to $0.00: it used to
    // say "renews at $3.99" over a total that a friend code had made free.
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: {
        message: `I agree that Flock Pro renews every ${every} until I cancel, at ${formatAmount(price)}${tax ? ' plus tax' : ''} or the lower price shown above if a code applies, and to the [Terms](${web}/terms).`,
      },
      submit: { message: submitText({ amount: formatAmount(price), every, tax }) },
    },
    success_url: successUrl(web, options),
    cancel_url: `${web}/pro?checkout=cancelled`,
  });
  return session.url;
}

async function createPortal(userId) {
  const customerId = await customerIdFor(userId);
  if (!customerId) {
    const err = new Error('There is no web subscription on this account.');
    err.status = 404;
    err.code = 'NO_WEB_SUBSCRIPTION';
    throw err;
  }
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${webBase()}/app?pro=manage`,
  });
  return session.url;
}

// After the redirect back from Checkout: prove the session is this account's,
// tell RevenueCat about the subscription, and return what RevenueCat now says.
async function confirmCheckout(userId, sessionId) {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  const owner = session && session.metadata ? session.metadata.app_user_id : null;
  if (!session || owner !== String(userId)) {
    const err = new Error('That checkout does not belong to this account.');
    err.status = 404;
    throw err;
  }
  if (session.status !== 'complete') return { complete: false };
  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription && session.subscription.id;
  await postStripeReceipt(userId, subscriptionId).catch((err) => {
    console.warn('[pro] RevenueCat receipt post failed:', err?.message || err);
  });
  return { complete: true, session };
}

// ---------------------------------------------------------------------------
// Cancelling from inside Flock
// ---------------------------------------------------------------------------
//
// STRIPE'S PORTAL IS FOR ADULTS. Its customer portal terms require the person
// using it to be 18 or over, and much of Flock's audience is younger, so the
// way to stop a web subscription is a Flock button: cancel at the end of the
// paid period, or take that back before it arrives. The portal stays for a card
// or an invoice, which is the parent's business when a parent paid.
//
// Only this account's own Pro subscriptions are touched: live, carrying this
// account's app_user_id, and never a Roost one (kind=venue).
function proSubscriptionsOf(list, userId) {
  const data = list && Array.isArray(list.data) ? list.data : [];
  return data.filter((s) => LIVE_STATUSES.has(s.status) && s.metadata
    && s.metadata.app_user_id === String(userId) && s.metadata.kind !== 'venue');
}

// The end of the period already paid for, as ISO. Newer Stripe API versions
// keep it on the subscription item rather than the subscription.
function periodEndOf(s) {
  if (!s) return null;
  const item = s.items && Array.isArray(s.items.data) ? s.items.data[0] : null;
  const end = s.cancel_at || (item && item.current_period_end) || s.current_period_end || null;
  return Number.isFinite(end) ? new Date(end * 1000).toISOString() : null;
}

function noWebSubscription() {
  const err = new Error('There is no web subscription on this account.');
  err.status = 404;
  err.code = 'NO_WEB_SUBSCRIPTION';
  return err;
}

// For /status: whether the live web subscription is set to end, and when.
// null with nothing live. A short timeout and no retries, like
// hasEverSubscribed, because the checkout return polls this route.
async function webSubscriptionState(userId) {
  const customerId = await customerIdFor(userId);
  if (!customerId) return null;
  const list = await stripe().subscriptions.list(
    { customer: customerId, status: 'all', limit: 10 },
    { timeout: 5000, maxNetworkRetries: 0 }
  );
  const subs = proSubscriptionsOf(list, userId);
  if (!subs.length) return null;
  // "Set to end" only when nothing live will renew; otherwise the page offers
  // Cancel, which reaches every one of them.
  return { cancelAtPeriodEnd: subs.every((s) => !!s.cancel_at_period_end), periodEnd: periodEndOf(subs[0]) };
}

async function setCancelAtPeriodEnd(userId, cancel) {
  const customerId = await customerIdFor(userId);
  if (!customerId) throw noWebSubscription();
  const list = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  const subs = proSubscriptionsOf(list, userId);
  if (!subs.length) throw noWebSubscription();
  let last = null;
  for (const s of subs) {
    last = await stripe().subscriptions.update(s.id, { cancel_at_period_end: !!cancel });
  }
  return { cancelAtPeriodEnd: !!cancel, periodEnd: periodEndOf(last) };
}

const cancelAtPeriodEnd = (userId) => setCancelAtPeriodEnd(userId, true);
const resumeSubscription = (userId) => setCancelAtPeriodEnd(userId, false);

// Account deletion. Deleting the Stripe customer cancels every subscription it
// holds at once, which is the point: a deleted account must never be charged
// again. Apple subscriptions cannot be cancelled by us and are the user's to
// stop in their Apple settings. THROWS if Stripe would not do it, so the
// deletion route can refuse instead of deleting the account and leaving a
// card being billed.
async function closeCustomer(customerId) {
  if (!customerId) return false;
  const client = stripe();
  if (!client) {
    // False, not a throw: nothing was attempted. Both deletion callers
    // (routes/users.js for Pro, services/venueBilling.js closeVenueCustomer
    // for Roost) treat a customer on file that was not closed as a refusal,
    // so the account is kept and deleting it works again once the key is
    // back. Deleting it here would leave the card billed with no record of
    // which customer to cancel.
    console.error(`[pro] STRIPE_SECRET_KEY is not set: Stripe customer ${customerId} was NOT cancelled, so the account deletion asking for it is refused. Restore the key, or cancel the customer in the Stripe dashboard.`);
    return false;
  }
  try {
    await client.customers.del(customerId);
  } catch (err) {
    // Already gone at Stripe is the outcome we wanted.
    if (err && (err.code === 'resource_missing' || err.statusCode === 404)) return true;
    throw err;
  }
  return true;
}

// A CHARGEBACK ENDS WHAT IT PAID FOR. A dispute takes the money back by force,
// and without this the subscription it paid for ran on to the end of its
// period, a year on the yearly plan. Every live subscription our server made
// for the disputed charge's customer (Pro carries app_user_id, Roost carries
// kind=venue; a customer holds one product) is cancelled now, and the deleted
// event that follows revokes it through the usual path. A refund is left to
// whoever issues it: Stripe's refund dialog offers to cancel in the same step,
// and a partial refund is often a goodwill credit, not an ending.
async function cancelDisputedSubscriptions(dispute) {
  const chargeId = dispute && (typeof dispute.charge === 'string' ? dispute.charge : dispute.charge && dispute.charge.id);
  if (!chargeId) return { ignored: 'no_charge' };
  const charge = await stripe().charges.retrieve(chargeId);
  const customerId = charge && (typeof charge.customer === 'string' ? charge.customer : charge.customer && charge.customer.id);
  if (!customerId) return { ignored: 'no_customer' };
  const list = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
  const ours = (list.data || []).filter((s) => LIVE_STATUSES.has(s.status)
    && s.metadata && (s.metadata.app_user_id || s.metadata.kind === 'venue'));
  for (const s of ours) {
    await stripe().subscriptions.cancel(s.id, {}, { idempotencyKey: `flock-dispute-cancel-${s.id}` });
  }
  return { cancelled: ours.length };
}

module.exports = {
  webCheckout,
  planPrices,
  describePrice,
  formatAmount,
  trialDays,
  taxEnabled,
  fetchProActive,
  postStripeReceipt,
  createCheckout,
  cancelDisputedSubscriptions,
  cancelAtPeriodEnd,
  resumeSubscription,
  webSubscriptionState,
  createPortal,
  confirmCheckout,
  closeCustomer,
  customerIdFor,
  hasEverSubscribed,
  sandboxAllowed,
  constructWebhookEvent,
  stripeWebhookConfigured: () => !!stripeWebhookSecret(),
  stripeConfigured,
  // The one Stripe client, shared with services/venueBilling.js (Roost), so
  // both products use the same key and the same retry and timeout settings.
  stripeClient: stripe,
  // The per-account checkout queue, shared with Roost for the same reason:
  // two interleaved builds can each leave a payable session.
  withCheckoutLock,
  webBase,
  revenueCatApiConfigured,
  PRO_ENTITLEMENT,
  // Tests only.
  __test: { LIVE_STATUSES, successUrl, submitText, PROMO_CODE_RE, everSubscribed, resetStripe: () => { stripeClient = null; stripeKeySeen = null; priceCache.clear(); everSubscribed.clear(); } },
};
