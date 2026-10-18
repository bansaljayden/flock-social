// WHICH REQUESTS COME FROM THE IPHONE APP.
//
// The iPhone app is the React build inside a Capacitor WKWebView, served from
// capacitor://localhost: frontend/capacitor.config.ts sets no iosScheme, no
// hostname and no server.url, so Capacitor's iOS default stands, and every API
// call the app makes is a cross-origin fetch that carries that Origin. server.js
// lets exactly that origin through CORS. ionic://localhost is the older iOS
// scheme of the same WebView and is read the same way. Android serves from
// http(s)://localhost, which is also what a laptop's dev server can send, so
// neither of those is read as the iPhone app.
//
// WHAT IT DECIDES. Whether an account may be created, or signed in to, without a
// date of birth. App Review rejected version 1.0 (build 47) on 2026-10-18 under
// guideline 5.1.1(v), "Update the app to not require users to provide ... Date
// of Birth", so the iPhone app asks for none and relies on the App Store's 13+
// age rating. The website keeps its neutral age screen, and the server keeps
// requiring a date from it. routes/auth.js is the only reader.
//
// AN ORIGIN HEADER PROVES NOTHING ABOUT WHO SENT IT. Any client that is not a
// browser can send any Origin. That is accepted for the same reason the age
// screen itself accepts a typed year: somebody willing to forge the header is
// equally willing to type an older year, so the header buys them nothing the
// screen did not already give away. What the header does carry is the one thing
// a page cannot fake: script in a browser tab cannot set it, which is what keeps
// the website's age screen enforced on the server rather than in the page.
//
// frontend/src/lib/nativeShell.js isIOSAppShell() is the screens' half of this
// rule and reads the same fact (the page's own protocol), so a screen hides the
// year field exactly when the server stops asking for it.
const IOS_APP_ORIGINS = Object.freeze(['capacitor://localhost', 'ionic://localhost']);

function isIOSAppRequest(req) {
  if (!req) return false;
  const origin = typeof req.get === 'function'
    ? req.get('origin')
    : (req.headers ? req.headers.origin : undefined);
  return typeof origin === 'string' && IOS_APP_ORIGINS.includes(origin);
}

module.exports = { IOS_APP_ORIGINS, isIOSAppRequest };
