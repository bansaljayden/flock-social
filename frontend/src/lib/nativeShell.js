// IS THIS THE NATIVE APP? One answer for the whole bundle.
//
// index.js asks it once at boot to decide whether "/" is the marketing site or
// the app. Every surface that can sell something asks it too, before it shows a
// price: the Pro sheet (components/PaywallSheet.js), the You tab's Flock Pro row
// (screens/ProfileSettings.js), /pro (website/ProPage.js) and Roost's buy and
// manage buttons (components/venue/VenueBillingControl.js). Inside the iOS app a
// Stripe price, a link to /pro or a Roost buy button is an App Review 3.1.1
// problem, so none of those may answer "web" in a shell the boot check called
// native. They each used to ask window.Capacitor.isNativePlatform() alone, which
// is one of the signals below, so a shell booted as native by its protocol, or
// by a bridge that only half answers, could still have been sold to as a browser.
// The App Store behind the sheet asks it as well (services/purchases.js, and the
// RevenueCat sign-out in services/api.js), so the sheet never offers a store
// that the purchase code then says is not there.
//
// iOS serves the app from capacitor://localhost, but ANDROID serves it from
// https://localhost, so the protocol check alone never identified the Android
// shell. Every signal the bridge can give is accepted, and the one ambiguous
// case (a bridge that is present but answers badly) resolves to "native",
// because treating the app as a browser is the expensive mistake in both places
// this is asked: the marketing page booting inside the app, and a web price
// shown there. In the web build window.Capacitor does not exist at boot: nothing
// in src/ imports @capacitor/core, and the plugins that do are dynamic imports
// inside the App chunk. Once one of them loads, @capacitor/core defines
// window.Capacitor in a browser too, answering isNativePlatform() with false,
// which reads here as the web. `win` is for tests, which cannot give jsdom's
// own window a capacitor: protocol.
export function detectNativeShell(win = typeof window === 'undefined' ? undefined : window) {
  if (!win) return false;
  try {
    if (win.location && win.location.protocol === 'capacitor:') return true;
    const cap = win.Capacitor;
    if (!cap) return false;
    if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform() === true;
    if (typeof cap.getPlatform === 'function') return cap.getPlatform() !== 'web';
    return true;
  } catch {
    return typeof win.Capacitor !== 'undefined';
  }
}

// THE BOOT ANSWER HOLDS FOR THE LIFE OF THE PAGE. index.js imports this module,
// so it is evaluated once before anything renders, with the bridge injected and
// nothing redefined yet. @capacitor/core, pulled in later by a plugin chunk,
// rewrites isNativePlatform on the same object from its own reading of the
// bridge. A shell that booted as native stays native even if that later reading
// disagrees; asking again only ever adds "native", it never takes it away.
const BOOTED_NATIVE = detectNativeShell();

export function isNativeShell() {
  return BOOTED_NATIVE || detectNativeShell();
}
