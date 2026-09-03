/*
 * WHY THIS FILE EXISTS: the iOS build asked for location TWICE.
 *
 * App Review's recording shows two prompts back to back. The first is the real
 * one, the iOS system sheet that says "Flock" and quotes
 * NSLocationWhenInUseUsageDescription. The second is WKWebView's own page-level
 * prompt, and it reads:
 *
 *     "localhost" would like to use your current location
 *
 * That second sheet is not the app asking. It is the WEB geolocation API being
 * called from inside a web view, so WebKit asks for permission on behalf of the
 * PAGE and names the page's origin. Capacitor serves the bundle from
 * capacitor://localhost, so the origin the user is asked to trust is the word
 * "localhost" — a hostname with no relationship to Flock, arriving immediately
 * after a sheet that had just named Flock properly. Two prompts, one of them
 * anonymous, is a bad first thirty seconds and a live review liability.
 *
 * THE FIX is to stop calling the web API on the device. @capacitor/geolocation
 * routes the request through the native bridge to CoreLocation, which raises
 * exactly one sheet: the system one, with the app's name and our purpose
 * string. WKWebView is never asked, so it never asks the user anything.
 *
 * WHAT WAS REJECTED, and why it stays rejected: setting `server.hostname` (or
 * `server.iosScheme`) in capacitor.config.ts would also change the sheet's
 * wording, by moving the web view's origin to something like
 * capacitor://app.flock.social. It would still be TWO prompts, and it would
 * additionally:
 *   - break the backend CORS allowlist (backend/server.js), which is pinned by
 *     backend/__tests__/corsAllowlist.test.js, and
 *   - sign out every existing install, because the session token lives in
 *     localStorage (services/api.js) and localStorage is keyed by origin.
 * A cosmetic change to a prompt is not worth a forced global sign-out. Do not
 * touch the origin.
 *
 * CONTRACT: this module is a drop-in for the three navigator.geolocation
 * methods App.js used, callbacks and all.
 *
 *   - ON THE WEB it calls navigator.geolocation directly and changes nothing:
 *     same arguments, same GeolocationPosition, same GeolocationPositionError,
 *     same watch id. There is no plugin in the web bundle at all — the import
 *     below is dynamic and sits behind the native guard, so a browser never
 *     fetches that chunk.
 *   - ON NATIVE it calls the plugin and translates the answer back into the
 *     shapes the callers already handle. That translation is the whole job:
 *     every call site downstream reads err.code as a NUMBER (1 denied,
 *     2 unavailable, 3 timeout) to decide between "turn it on in Settings" and
 *     "try again in a second", and one of them (handleShareLocationWithContacts)
 *     uses `typeof err.code === 'number'` to tell a location failure apart from
 *     an api.js failure. The plugin's own codes are strings like
 *     "OS-PLUG-GLOC-0003", so handing those through unchanged would silently
 *     retarget every one of those branches.
 */

// Native detection is read off the injected window.Capacitor global rather than
// by importing @capacitor/core, the same way api.js, useGoogleAuth.js and
// AppleSignInButton.js decide it. index.js depends on that rule: it boots the
// marketing site or the app by looking for window.Capacitor, and it documents
// that nothing in src/ imports the runtime statically.
const isNative = () => {
  try {
    return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
};

// The plugin chunk, loaded once and only on a device. A failure to load is not
// an exception anyone downstream can use: it is answered as an ordinary
// "position unavailable", which every caller already has words for.
let loading = null;
function load() {
  if (!loading) {
    loading = import('@capacitor/geolocation')
      .then((mod) => mod.Geolocation || null)
      .catch(() => null);
  }
  return loading;
}

const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

/*
 * The plugin's iOS errors, from
 * node_modules/@capacitor/geolocation/ios/.../GeolocationError.swift:
 *
 *   0002 positionUnavailable      0003 permissionDenied
 *   0004/0005/0006 bad arguments  0007 locationServicesDisabled
 *   0008 permissionRestricted     0010 timeout
 *
 * Denied, services-disabled and restricted all collapse to PERMISSION_DENIED
 * because they are the same fact to a user: the app cannot have your location
 * until you change something in Settings, and that is the sentence the call
 * sites already print for code 1. Bad arguments is a programming mistake with
 * no user-facing meaning, so it lands on "unavailable" rather than accusing the
 * user of refusing anything.
 */
const CODE_BY_PLUGIN_CODE = {
  'OS-PLUG-GLOC-0002': POSITION_UNAVAILABLE,
  'OS-PLUG-GLOC-0003': PERMISSION_DENIED,
  'OS-PLUG-GLOC-0004': POSITION_UNAVAILABLE,
  'OS-PLUG-GLOC-0005': POSITION_UNAVAILABLE,
  'OS-PLUG-GLOC-0006': POSITION_UNAVAILABLE,
  'OS-PLUG-GLOC-0007': PERMISSION_DENIED,
  'OS-PLUG-GLOC-0008': PERMISSION_DENIED,
  'OS-PLUG-GLOC-0010': TIMEOUT,
};

function codeFor(err) {
  const mapped = CODE_BY_PLUGIN_CODE[err?.code];
  if (mapped) return mapped;
  // Android and any future bridge that does not carry the iOS code strings.
  // Message matching is a fallback, never the primary route.
  const text = String(err?.message || '');
  if (/denied|restricted|not enabled|disabled/i.test(text)) return PERMISSION_DENIED;
  if (/time ?out|in time/i.test(text)) return TIMEOUT;
  return POSITION_UNAVAILABLE;
}

/* A GeolocationPositionError in every way the app reads one. The three
   constants ride along because that is what the web type carries and something
   downstream may one day compare against them instead of the literal. */
function toPositionError(code, message) {
  return {
    code,
    message,
    PERMISSION_DENIED,
    POSITION_UNAVAILABLE,
    TIMEOUT,
  };
}

function fail(onError, code, message) {
  if (typeof onError === 'function') onError(toPositionError(code, message));
}

function failFromPlugin(onError, err) {
  fail(onError, codeFor(err), err?.message || 'Could not get a location.');
}

/**
 * Is there any way at all to ask for a position?
 *
 * On a device the answer is yes: the plugin is compiled into the shell. On the
 * web it is the same `navigator.geolocation` truthiness check the call sites
 * used to do inline, which is what a browser without the API answers no to.
 */
export function geolocationAvailable() {
  if (isNative()) return true;
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

/**
 * navigator.geolocation.getCurrentPosition, with the native path swapped in.
 * Returns nothing, exactly like the web API; the answer arrives on a callback.
 */
export function getCurrentPosition(onSuccess, onError, options) {
  if (!isNative()) {
    navigator.geolocation.getCurrentPosition(onSuccess, onError, options);
    return;
  }
  load().then((Geolocation) => {
    if (!Geolocation) {
      fail(onError, POSITION_UNAVAILABLE, 'Location is not available on this device.');
      return;
    }
    // try/catch as well as the rejection handler: an SOS is one of the callers,
    // and a bridge that throws synchronously must still reach an error path
    // rather than becoming an unhandled rejection nobody is waiting on.
    try {
      Geolocation.getCurrentPosition(options).then(
        (position) => { if (typeof onSuccess === 'function') onSuccess(position); },
        (err) => failFromPlugin(onError, err),
      );
    } catch (err) {
      failFromPlugin(onError, err);
    }
  });
}

/**
 * navigator.geolocation.watchPosition, with the native path swapped in.
 *
 * The web API hands back a number synchronously and the plugin hands back a
 * string from a promise, and App.js stores whatever this returns in a ref it
 * compares against null and later passes to clearWatch. So: the web branch
 * returns the real number unchanged, and the native branch returns an opaque
 * handle immediately, filling in the plugin's id when it arrives. clearWatch
 * below takes either. Callers must not read anything off the return value.
 *
 * The handle also carries the cancellation race the promise creates: an effect
 * that unmounts before the plugin has answered marks the handle cancelled, and
 * the id is cleared the moment it exists. Without that, a fast mount/unmount
 * leaves CoreLocation running for the life of the app.
 */
export function watchPosition(onSuccess, onError, options) {
  if (!isNative()) {
    return navigator.geolocation.watchPosition(onSuccess, onError, options);
  }
  const handle = { id: null, cancelled: false };
  load().then((Geolocation) => {
    if (!Geolocation) {
      fail(onError, POSITION_UNAVAILABLE, 'Location is not available on this device.');
      return;
    }
    if (handle.cancelled) return;
    Geolocation.watchPosition(options || {}, (position, err) => {
      if (handle.cancelled) return;
      if (err) { failFromPlugin(onError, err); return; }
      if (position && typeof onSuccess === 'function') onSuccess(position);
    }).then((id) => {
      handle.id = id;
      if (handle.cancelled) stopNativeWatch(handle);
    }, (err) => {
      failFromPlugin(onError, err);
    });
  });
  return handle;
}

function stopNativeWatch(handle) {
  const id = handle.id;
  if (id === null || id === undefined) return;
  handle.id = null;
  load().then((Geolocation) => {
    if (Geolocation) Geolocation.clearWatch({ id }).catch(() => {});
  });
}

/**
 * navigator.geolocation.clearWatch, taking whatever watchPosition returned: a
 * number on the web, one of the handles above on a device.
 */
export function clearWatch(watchId) {
  if (watchId === null || watchId === undefined) return;
  if (typeof watchId === 'number') {
    navigator.geolocation.clearWatch(watchId);
    return;
  }
  watchId.cancelled = true;
  stopNativeWatch(watchId);
}
