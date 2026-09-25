// RevenueCat wrapper for the Capacitor iOS build.
//
// The @revenuecat/purchases-capacitor plugin only has a native implementation,
// so every function here is loaded via dynamic import() and guarded — on web
// (Vercel) the plugin is never touched and every export degrades gracefully
// (null / false returns, never a throw to the caller).
//
// app_user_id contract: initPurchases(userId) calls logIn(String(userId)) so the
// RevenueCat app_user_id is EXACTLY our numeric user id — the backend webhook
// maps entitlement events back to our users table by that id. Do not change.
//
// WHO THE STORE IS BUYING FOR. RevenueCat keeps its own idea of who is signed
// in, separate from ours and kept on the device across launches, and records
// every App Store purchase and restore against it. The webhook then grants Pro
// to whichever of our users that id names (backend/routes/revenuecat.js).
// Three gaps let the two drift apart, and each one put a purchase on the wrong
// account:
//   * no sign-out path told RevenueCat, so the last account stayed its user;
//   * configure ran without an id, so a fresh page load started as whoever
//     RevenueCat last held, or as an anonymous id the webhook drops;
//   * purchase and restore went straight to the store, so a buy made before
//     the session's logIn landed, or after it failed, was recorded under that
//     stale or anonymous id, and Pro went to the previous account or nowhere.
// Now initPurchases names the session's account and configure carries it,
// every sign-out logs RevenueCat out (endPurchasesSession, reached from
// api.js clearLocalSession), and purchase and restore confirm RevenueCat is
// the signed-in account before they touch the store, refusing when they
// cannot. Identity changes and store calls run one at a time, in the order
// they were asked for, so a sign-out's logOut cannot land between a
// purchase's check and its buy.
//
// And a buy or restore runs as the account that ASKED for it, or not at all.
// Waiting its turn in that queue, a tap could outlive its own session: a
// Restore tapped while the sign-in's logIn was still on the network waited
// behind it, the session was revoked, the next account signed in, and the
// restore then read the account only when its turn came, logged RevenueCat in
// as the newcomer and moved the Apple ID's purchases onto them. The account and
// the session are now read the moment the tap arrives (askedBy), before
// anything waits, and the store is asked only while both are still the ones
// signed in.

import { isNativeShell } from '../lib/nativeShell';

const API_KEY = process.env.REACT_APP_REVENUECAT_IOS_KEY;

/** True only when running inside the native Capacitor shell AND the
 *  RevenueCat public key was baked into the build.
 *
 *  lib/nativeShell.js, the same answer the purchase screens act on. PaywallSheet
 *  picks its App Store half or its Stripe half by asking that module, and a
 *  shell index.js booted as native stays native there even if @capacitor/core
 *  later answers "web". This file used to ask window.Capacitor.isNativePlatform()
 *  on its own, so in exactly that case the sheet showed the App Store half and
 *  this reported no store behind it. In the iOS shell and on the web both checks
 *  give the same answer, so RevenueCat configures exactly when it did before.
 *  They differ only on a bridge that answers badly, which the sheet already
 *  treats as the app; if that bridge is not native after all, the plugin's web
 *  stub refuses configure and nothing can be bought. */
export const isPurchasesAvailable = () => isNativeShell() && !!API_KEY;

// The account this session signed in as, as RevenueCat must name it: a string
// of our numeric user id (the webhook contract above). Set by initPurchases,
// cleared by endPurchasesSession.
let sessionUserId = null;
// Every sign-out, counted, so a request can tell that the session it was made
// in has ended even when the same account has since signed back in.
let signOuts = 0;
// Who is asking, read when they ask: the account and the session it is in.
const askedBy = () => ({ account: sessionUserId, signOuts });
const stillSignedIn = (asker) =>
  !!asker.account && asker.account === sessionUserId && asker.signOuts === signOuts;
// One configure per page load, shared by whoever asks first.
let configuring = null;
// Identity changes and store calls, one at a time, in the order asked for.
let chain = Promise.resolve();
const serially = (task) => {
  const run = chain.then(() => task());
  chain = run.catch(() => undefined);
  return run;
};

const loadPlugin = async () => {
  if (!isPurchasesAvailable()) return null;
  try {
    const mod = await import('@revenuecat/purchases-capacitor');
    return mod?.Purchases || null;
  } catch (err) {
    console.warn('RevenueCat plugin unavailable:', err?.message || err);
    return null;
  }
};

const configureOnce = (Purchases) => {
  if (!configuring) {
    // With the account when one is known, so RevenueCat never starts this page
    // load as the last account it held or as an anonymous id.
    const options = sessionUserId ? { apiKey: API_KEY, appUserID: sessionUserId } : { apiKey: API_KEY };
    configuring = Promise.resolve(Purchases.configure(options)).catch((err) => {
      configuring = null;
      throw err;
    });
  }
  return configuring;
};

const proFromCustomerInfo = (customerInfo) =>
  !!customerInfo?.entitlements?.active?.['pro'];

// Make RevenueCat the account that asked, or say it cannot. Answers the id it
// confirmed, or null. `asker` is askedBy() as it stood when the tap arrived,
// and a request whose session has ended since is refused before RevenueCat is
// touched: whoever is signed in now did not ask. logIn only when RevenueCat is
// not already that account: logIn is a network call, and asking for the id it
// already holds changes nothing. The id is read back afterwards rather than
// assumed, and a sign-out that landed meanwhile fails the check, because a buy
// for an account that is no longer signed in is exactly what this is here to
// stop.
const becomeSessionAccount = async (Purchases, asker) => {
  const { account } = asker;
  if (!stillSignedIn(asker)) return null;
  try {
    await configureOnce(Purchases);
    let current = (await Purchases.getAppUserID())?.appUserID;
    if (current !== account) {
      await Purchases.logIn({ appUserID: account });
      current = (await Purchases.getAppUserID())?.appUserID;
    }
    return current === account && stillSignedIn(asker) ? account : null;
  } catch (err) {
    console.warn('RevenueCat could not be set to the signed-in account:', err?.message || err);
    return null;
  }
};

/**
 * Configure RevenueCat and identify the user. Safe to call on web (no-op)
 * and safe to call more than once. Returns true when ready for purchases.
 */
export const initPurchases = async (userId) => {
  const account = userId !== undefined && userId !== null ? String(userId) : null;
  // Named before anything waits, so a sign-out that lands while the plugin is
  // still loading clears this instead of being overwritten by it.
  if (account) sessionUserId = account;
  const Purchases = await loadPlugin();
  if (!Purchases) return false;
  return serially(async () => {
    try {
      await configureOnce(Purchases);
      // app_user_id === our numeric user id (backend webhook contract).
      // Skipped when the session ended while this waited its turn.
      if (account && sessionUserId === account) {
        await Purchases.logIn({ appUserID: account });
      }
      return true;
    } catch (err) {
      console.warn('initPurchases failed:', err?.message || err);
      return false;
    }
  });
};

/**
 * The sign-out half: forget the session's account and log RevenueCat out, so
 * the next account on this device cannot buy under this one. Reached from
 * api.js clearLocalSession, which every sign-out path goes through (Log out, a
 * 401, account deletion). Never rejects, and nothing waits on it.
 */
export const endPurchasesSession = async () => {
  sessionUserId = null;
  // Before anything waits, like the line above: a buy or restore still in the
  // queue from this session is refused from here on (askedBy).
  signOuts += 1;
  const Purchases = await loadPlugin();
  if (!Purchases) return false;
  return serially(async () => {
    // Somebody signed in again while this waited: their logIn replaces the
    // old account anyway, and a logOut now would only undo it.
    if (sessionUserId !== null) return false;
    try {
      // Configured by this page load, or by an earlier one in the same app
      // process: a reloaded web view keeps the native SDK and the id it held.
      const ready = configuring
        ? await configuring.then(() => true, () => false)
        : !!(await Purchases.isConfigured())?.isConfigured;
      if (!ready) return false;
      // Rejects for a user who is already anonymous, which is the state this
      // wants anyway.
      await Purchases.logOut();
      return true;
    } catch (err) {
      return false;
    }
  });
};

/**
 * Returns the 'default' offering's availablePackages (array), or null when
 * purchases are unavailable / the offering has no packages / anything fails.
 */
export const getProOffering = async () => {
  const Purchases = await loadPlugin();
  if (!Purchases) return null;
  try {
    await configureOnce(Purchases);
    const offerings = await Purchases.getOfferings();
    const offering = offerings?.all?.['default'] || offerings?.current || null;
    const packages = offering?.availablePackages;
    return Array.isArray(packages) && packages.length > 0 ? packages : null;
  } catch (err) {
    console.warn('getProOffering failed:', err?.message || err);
    return null;
  }
};

/**
 * Purchase a RevenueCat package (as returned by getProOffering()).
 * Returns { success, isPro }. User cancellation and errors both resolve
 * (success: false) — this never throws to the caller. When RevenueCat cannot
 * be confirmed as the signed-in account the store is never asked, nothing is
 * charged, and the answer carries reason: 'account' so the sheet can say so.
 * The same answer when the session that asked has ended before its turn came.
 */
export const purchase = async (pkg) => {
  // Who asked, read before anything here waits (askedBy).
  const asker = askedBy();
  const Purchases = await loadPlugin();
  if (!Purchases || !pkg) return { success: false, isPro: false };
  return serially(async () => {
    if (!(await becomeSessionAccount(Purchases, asker))) return { success: false, isPro: false, reason: 'account' };
    try {
      const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
      const isPro = proFromCustomerInfo(customerInfo);
      return { success: isPro, isPro };
    } catch (err) {
      if (!err?.userCancelled) {
        console.warn('purchase failed:', err?.message || err);
      }
      return { success: false, isPro: false };
    }
  });
};

/**
 * Restore previous purchases (Apple-required). Returns { success, isPro }
 * where success means the restore call itself completed. A restore moves the
 * Apple ID's purchases onto whoever RevenueCat thinks is signed in, so it gets
 * the same account check a purchase does, with the same reason: 'account'.
 */
export const restore = async () => {
  // Who asked, read before anything here waits (askedBy).
  const asker = askedBy();
  const Purchases = await loadPlugin();
  if (!Purchases) return { success: false, isPro: false };
  return serially(async () => {
    if (!(await becomeSessionAccount(Purchases, asker))) return { success: false, isPro: false, reason: 'account' };
    try {
      const { customerInfo } = await Purchases.restorePurchases();
      return { success: true, isPro: proFromCustomerInfo(customerInfo) };
    } catch (err) {
      console.warn('restore failed:', err?.message || err);
      return { success: false, isPro: false };
    }
  });
};
