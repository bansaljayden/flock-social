// WHETHER THIS BUILD SELLS ANYTHING AT ALL.
//
// REACT_APP_PURCHASES=off is set on the iOS build lines in codemagic.yaml and
// nowhere else (never on Vercel, never in .env). With it off, the build that
// goes to the App Store carries no purchase screen, no price, no link to a
// checkout and no store SDK start-up: the Pro sheet, the You tab's Pro row,
// /pro, the landing page, the venue plans sheet, Roost's buy buttons and the
// subscription notes are not rendered, a server limit is stated without an
// offer, and RevenueCat is never configured. Unset (the web), everything is
// exactly as it was.
//
// WHY THE GATES SPELL THE VARIABLE OUT. CRA inlines process.env.REACT_APP_* at
// build time, so `process.env.REACT_APP_PURCHASES !== 'off'` becomes the
// constant false in the iOS build and the minifier deletes every branch behind
// it, the purchase copy and prices included, and webpack does not build a
// chunk whose import() sits in such a branch. A call to the function below
// does NOT get that: the minifier does not inline it across modules, so the
// screens stayed hidden but their strings still shipped. So every gate in the
// app writes the comparison out in place. It reads process.env at render time,
// which is also what lets a test set the variable and render again.
//
// This function is for code that only needs the answer at run time
// (services/purchases.js, which the iOS build does not even contain).
export function purchasesInBuild() {
  return process.env.REACT_APP_PURCHASES !== 'off';
}
