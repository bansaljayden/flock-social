// WHAT THIS BUILD SELLS, AND THROUGH WHICH STORE.
//
// REACT_APP_PURCHASES is set on the iOS build lines in codemagic.yaml and
// nowhere else (never on Vercel or Cloudflare, never in .env). Three modes:
//
//   unset  The website, and everything exactly as it always was: Flock Pro
//          through Stripe on the web and through the App Store inside a native
//          shell, /pro, the landing page's prices, Roost's plans and checkout.
//
//   iap    The App Store build (both iOS workflows in codemagic.yaml). Flock
//          Pro through Apple's in-app purchase and nothing else: the Pro sheet
//          with the App Store plans through RevenueCat, the You tab's Flock Pro
//          row, Restore purchases, the App Store renewal and terms lines, and
//          RevenueCat configured with REACT_APP_REVENUECAT_IOS_KEY. Every way
//          to pay on the web is compiled out, exactly as in off: Stripe's
//          checkout and portal, /pro and its codes, the landing page, the
//          venue plans sheet, Roost's prices and buy, upgrade and See plans
//          buttons, the venue Subscription card, and any sentence that points
//          to buying somewhere else (App Store Review Guideline 3.1.1). Roost
//          is never sold in the app. The Pro surfaces still appear only to an
//          account the server says the paywall is on for (paywallEnabled in
//          GET /api/entitlements: PAYWALL_ENABLED, or the account on
//          PAYWALL_PREVIEW_USER_IDS).
//
//   off    Sells nothing: no purchase screen, no price, no link to a checkout
//          and no store SDK start-up. The Pro sheet, the You tab's Pro row,
//          /pro, the landing page, the venue plans sheet, Roost's buy buttons
//          and the subscription notes are not rendered, a server limit is
//          stated without an offer, and RevenueCat is never configured. It was
//          the App Store build's mode until the build that sells Pro (1.0.3).
//
// TWO GATES, EACH WRITTEN OUT IN PLACE.
//
//   Flock Pro is sold at all (unset and iap; the App Store half of every Pro
//   surface, RevenueCat):
//       process.env.REACT_APP_PURCHASES !== 'off'
//
//   The web's ways to pay (unset only; Stripe, /pro, Roost's billing):
//       (process.env.REACT_APP_PURCHASES !== 'off' && process.env.REACT_APP_PURCHASES !== 'iap')
//   and where code needs the opposite, a build with no web checkout:
//       (process.env.REACT_APP_PURCHASES === 'off' || process.env.REACT_APP_PURCHASES === 'iap')
//
//   A surface with an App Store half and a web half (the Pro sheet, the You
//   tab's Flock Pro row, the deletion sheet's subscription note) takes the App
//   Store half whenever the build is iap, whatever the bridge says:
//       const native = process.env.REACT_APP_PURCHASES === 'iap' || isNativeShell();
//
// WHY THE GATES SPELL THE VARIABLE OUT. CRA inlines process.env.REACT_APP_* at
// build time, so `process.env.REACT_APP_PURCHASES !== 'off'` becomes the
// constant false in an off build and the minifier deletes every branch behind
// it, the purchase copy and prices included, and webpack does not build a
// chunk whose import() sits in such a branch. The same holds for the web gate
// in an iap build, and for a local `native` whose value is the constant true
// there. A call to the function below does NOT get that: the minifier does not
// inline it across modules, so the screens stayed hidden but their strings
// still shipped. So every gate in the app writes the comparison out in place.
// It reads process.env at render time, which is also what lets a test set the
// variable and render again.
//
// The built output is checked by scripts/check-purchase-bundle.js:
//   node scripts/check-purchase-bundle.js iap --build
// builds with REACT_APP_PURCHASES=iap and fails unless the RevenueCat SDK and
// the Pro sheet are in the bundle and no web way to pay is (off and web too).
//
// This function is for code that only needs the answer at run time
// (services/purchases.js, which an off build does not even contain).
export function purchasesInBuild() {
  return process.env.REACT_APP_PURCHASES !== 'off';
}
