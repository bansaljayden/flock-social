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

const API_KEY = process.env.REACT_APP_REVENUECAT_IOS_KEY;

const isNative = () => {
  try {
    return !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
};

/** True only when running inside the native Capacitor shell AND the
 *  RevenueCat public key was baked into the build. */
export const isPurchasesAvailable = () => isNative() && !!API_KEY;

let configured = false;

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

const proFromCustomerInfo = (customerInfo) =>
  !!customerInfo?.entitlements?.active?.['pro'];

/**
 * Configure RevenueCat and identify the user. Safe to call on web (no-op)
 * and safe to call more than once. Returns true when ready for purchases.
 */
export const initPurchases = async (userId) => {
  const Purchases = await loadPlugin();
  if (!Purchases) return false;
  try {
    if (!configured) {
      await Purchases.configure({ apiKey: API_KEY });
      configured = true;
    }
    if (userId !== undefined && userId !== null) {
      // app_user_id === our numeric user id (backend webhook contract).
      await Purchases.logIn({ appUserID: String(userId) });
    }
    return true;
  } catch (err) {
    console.warn('initPurchases failed:', err?.message || err);
    return false;
  }
};

/**
 * Returns the 'default' offering's availablePackages (array), or null when
 * purchases are unavailable / the offering has no packages / anything fails.
 */
export const getProOffering = async () => {
  const Purchases = await loadPlugin();
  if (!Purchases) return null;
  try {
    if (!configured) {
      await Purchases.configure({ apiKey: API_KEY });
      configured = true;
    }
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
 * (success: false) — this never throws to the caller.
 */
export const purchase = async (pkg) => {
  const Purchases = await loadPlugin();
  if (!Purchases || !pkg) return { success: false, isPro: false };
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
};

/**
 * Restore previous purchases (Apple-required). Returns { success, isPro }
 * where success means the restore call itself completed.
 */
export const restore = async () => {
  const Purchases = await loadPlugin();
  if (!Purchases) return { success: false, isPro: false };
  try {
    const { customerInfo } = await Purchases.restorePurchases();
    return { success: true, isPro: proFromCustomerInfo(customerInfo) };
  } catch (err) {
    console.warn('restore failed:', err?.message || err);
    return { success: false, isPro: false };
  }
};
