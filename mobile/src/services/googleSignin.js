// Google Sign-In wrapper. Configures the native module once at app boot.
// MUST run before any GoogleSignin.signIn() call or the returned idToken
// will be null and the backend will reject the login.
//
// Wire-up order:
//   1. App.js calls init() once at boot, BEFORE the auth screens render.
//   2. LoginScreen / SignupScreen call GoogleSignin.signIn() — already configured.
//
// webClientId source: Firebase Console -> Project Settings -> General ->
// "Your apps" -> Web SDK -> OAuth 2.0 client ID. Same value the backend
// validates against in GOOGLE_CLIENT_ID. NOT secret (ships in the app bundle
// by design) but must match the backend.

let GoogleSignin = null;
try {
  // Defensive — if the package isn't installed yet (pre-pod-install) skip.
  // eslint-disable-next-line global-require
  GoogleSignin = require('@react-native-google-signin/google-signin').GoogleSignin;
} catch {
  GoogleSignin = null;
}

// TODO: replace with real webClientId before TestFlight.
const GOOGLE_WEB_CLIENT_ID = '';
const GOOGLE_IOS_CLIENT_ID = ''; // optional on iOS; falls back to webClientId

let _configured = false;

export function init() {
  if (_configured) return;
  if (!GoogleSignin) {
    console.log('[GoogleSignIn] SDK not installed yet — sign-in disabled');
    return;
  }
  if (!GOOGLE_WEB_CLIENT_ID) {
    console.log('[GoogleSignIn] No webClientId set — sign-in disabled until configured');
    return;
  }
  try {
    GoogleSignin.configure({
      webClientId: GOOGLE_WEB_CLIENT_ID,
      iosClientId: GOOGLE_IOS_CLIENT_ID || undefined,
      offlineAccess: false,
    });
    _configured = true;
    console.log('[GoogleSignIn] Configured');
  } catch (e) {
    console.warn('[GoogleSignIn] configure() failed:', e.message);
  }
}

export function isConfigured() {
  return _configured;
}
