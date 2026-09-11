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
 * ONE EXCEPTION, 2026-09-10: THE WEB API IS THE FALLBACK WHEN THE BRIDGE IS
 * SILENT. On a device the plugin can fail to answer at all: not a denial, not
 * a timeout from CoreLocation, but a call that never reaches native.
 * ionic-team/capacitor-plugins#2525 describes exactly that on iOS 26, with
 * every other plugin on the same bridge fine and the maintainers unable to
 * reproduce it. From the user's side it is no permission sheet, a spinner,
 * and "Could not get your location just now" on every try, with the
 * permission granted the whole time. So before asking for a fix this module
 * asks the plugin a question with no side effects, checkPermissions, and
 * gives it PROBE_WINDOW to answer. Silence means the bridge is not delivering,
 * and the request goes to navigator.geolocation instead, for the rest of the
 * session or until the plugin answers something. WebKit's own sheet can appear
 * on that path. A second sheet is the price of a location at all, and it is
 * paid only where the alternative was none.
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

// The second, coarse attempt a precise request falls back to on a timeout or
// an unavailable fix: low accuracy, a twelve-second window, and a fix up to
// five minutes old is fine. Exported so the test can pin it.
export const COARSE_RETRY = Object.freeze({ enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });

// How long checkPermissions gets to answer before the bridge is judged silent
// for this plugin. A live bridge answers in tens of milliseconds; three
// seconds is a busy main thread on an old phone, not a working plugin.
export const PROBE_WINDOW = 3000;
// The clock on an attempt that will raise the system permission sheet. The
// plugin's own timer, the caller's `timeout`, starts after the grant.
export const PROMPT_WINDOW = 120000;

// Set when the plugin failed to answer the probe. Cleared the moment it
// answers anything, even late: a slow bridge is not a dead one.
let bridgeSilent = false;

/* checkPermissions, with a clock. Resolves to one of:
     granted | prompt | denied  the plugin's answer
     error                      the plugin rejected (Location Services off is 0007)
     silent                     no answer inside PROBE_WINDOW
     no-plugin                  the chunk did not load
     unprobed                   a plugin build with no checkPermissions
   Never rejects. */
function probe() {
  return new Promise((resolve) => {
    let done = false;
    const answer = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      bridgeSilent = true;
      answer({ state: 'silent' });
    }, PROBE_WINDOW);
    load().then((Geolocation) => {
      if (!Geolocation) {
        clearTimeout(timer);
        answer({ state: 'no-plugin' });
        return;
      }
      if (typeof Geolocation.checkPermissions !== 'function') {
        clearTimeout(timer);
        answer({ state: 'unprobed' });
        return;
      }
      const heard = () => { clearTimeout(timer); bridgeSilent = false; };
      try {
        Geolocation.checkPermissions().then((res) => {
          heard();
          const status = res && res.location;
          answer({ state: status === 'granted' || status === 'denied' ? status : 'prompt' });
        }, (err) => {
          heard();
          answer({ state: 'error', pluginErr: err });
        });
      } catch (err) {
        heard();
        answer({ state: 'error', pluginErr: err });
      }
    });
  });
}

/* navigator.geolocation on a device: WebKit's API, which does not use the
   Capacitor bridge. Errors carry where they came from in `detail` so a report
   can tell a WebKit failure from a plugin one. */
function webOnDevice(onSuccess, onError, options, reason) {
  const geo = typeof navigator !== 'undefined' ? navigator.geolocation : null;
  if (!geo) {
    fail(onError, POSITION_UNAVAILABLE, 'Location is not available on this device.', reason);
    return;
  }
  geo.getCurrentPosition(
    (position) => { if (typeof onSuccess === 'function') onSuccess(position); },
    (err) => {
      const code = err && [PERMISSION_DENIED, POSITION_UNAVAILABLE, TIMEOUT].includes(err.code)
        ? err.code
        : POSITION_UNAVAILABLE;
      fail(onError, code, (err && err.message) || 'Could not get a location.', 'webkit/' + reason);
    },
    options,
  );
}


/* NO SEEDED LOCATION FOR THE RECORDING RIG. The Simulator that Maestro
 * launches never delivers a fix to the app (the grant and `simctl location
 * set` both run clean and the read still times out; mobile-dev-inc/maestro
 * #1458), so for one evening a build-time REACT_APP_REVIEW_LOCATION answered
 * the read with Center City. On both takes built that way the Discover tab
 * then loaded neither a venue nor the map; every take without it loaded both
 * behind the honest "Could not get your location just now" banner. The
 * timeout below is the whole of what this module does about a missing fix. */

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
   downstream may one day compare against them instead of the literal.

   Two fields the web type does not have: `detail` is the plugin's own error
   identifier (OS-PLUG-GLOC-0010) or, when the failure was decided here, which
   decision ('client-timer' for the timeout this module enforces, 'no-plugin'
   when the bridge could not be loaded); `retried` says the low-accuracy
   second attempt ran before this answer. Both exist so a failure can be
   reported from a device in four bounded values and no free text: the three
   web codes fold seven plugin outcomes into three words, and the words on
   screen are the same for two of them, so a report that carried only the
   code could not say what the phone actually did. */
function toPositionError(code, message, detail, retried) {
  return {
    code,
    message,
    detail: detail || '',
    retried: !!retried,
    PERMISSION_DENIED,
    POSITION_UNAVAILABLE,
    TIMEOUT,
  };
}

function fail(onError, code, message, detail, retried) {
  if (typeof onError === 'function') onError(toPositionError(code, message, detail, retried));
}

function failFromPlugin(onError, err, retried) {
  const detail = err && err.code != null ? String(err.code) : '';
  fail(onError, codeFor(err), err?.message || 'Could not get a location.', detail, retried);
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
  /* THE `timeout` OPTION IS ENFORCED HERE, WHATEVER THE PLUGIN DOES WITH IT.
     On the web, `timeout` is part of the geolocation API's contract and the
     browser fires the error callback with code 3 when it elapses. Across the
     bridge the number reaches @capacitor/geolocation 8.2.2, whose native
     library (IONGeolocationLib 2.1.0) does run a timer of its own, but only
     from the moment authorization is granted and only for a call that
     reached it at all. A call the bridge never delivers, or one parked behind
     the permission sheet, has no clock but this one. When this paragraph was
     first written the plugin's timer did not exist yet, and a Simulator with
     no location set produced no fix, no error and no callback, forever.

     The caller in App.js has always passed `timeout: 10000` and has always had
     a code-3 branch written for it. Neither could run on a device until this
     clock existed. What the user saw instead was the "Finding where you are"
     spinner and the line under it, with nothing behind them and no way to a
     different answer. The demonstration recording found it: the vote panel's
     nearby list is fed by the granted location, and it sat empty behind a
     request that never finished.

     THE BRIDGE IS ASKED A QUESTION BEFORE IT IS ASKED FOR A FIX. Every request
     starts with checkPermissions, which has no side effect and no sheet, and
     the answer decides the path: denied is answered at once with the words
     the caller prints for code 1; not-yet-asked means the request will raise
     the system sheet, so that attempt gets a two-minute window instead of
     ten seconds, because a person reads a sheet at their own pace and the
     short clock was firing underneath it, printing the failure and dropping
     the fix that arrived when they tapped Allow; granted is the ordinary
     attempt. And no answer inside PROBE_WINDOW means the bridge is not
     delivering this plugin's calls (see the file header), in which case the
     request goes to WebKit's navigator.geolocation instead, and so does every
     later one until the plugin is heard from.

     First answer wins, per attempt and overall. A late fix arriving after the
     timeout must not call `onSuccess` on a caller that has already been told
     the request failed and has already moved on, and an error arriving after
     a success must not overwrite a real coordinate with a banner.

     ONE COARSE RETRY BEFORE "TRY AGAIN". Every caller asks for a precise fix
     with a ten-second window, and indoors a precise fix can take longer than
     that or never come, while a coarse one (cell, Wi-Fi, the fix from a few
     minutes ago) is there for the asking. On a granted device that is what
     "Could not get your location just now. Try again" was: a precise-only
     request timing out, over and over, with the permission fine the whole
     time. So a precise request that times out or comes back unavailable is
     tried once more at low accuracy, accepting a fix up to five minutes old,
     before the caller hears a failure. A refused permission is not retried:
     the answer would be the same and the words the caller prints for code 1
     are the right ones. */
  if (bridgeSilent) {
    webOnDevice(onSuccess, onError, options, 'bridge-silent');
    return;
  }

  let settled = false;
  const finish = (fn) => (...args) => {
    if (settled) return;
    settled = true;
    fn(...args);
  };
  const succeed = finish((position) => { if (typeof onSuccess === 'function') onSuccess(position); });
  const failFinal = finish((code, message, pluginErr, retried, detail) => {
    if (pluginErr) failFromPlugin(onError, pluginErr, retried);
    else fail(onError, code, message, detail || (code === TIMEOUT ? 'client-timer' : 'no-plugin'), retried);
  });

  // One call across the bridge with a clock of its own. `windowMs` is this
  // module's clock for the attempt, which is not the same number as the
  // `timeout` inside `opts`: that one crosses the bridge and becomes the
  // plugin's own timer, which only starts once authorization is granted.
  const attempt = (opts, windowMs, timerDetail, onAttemptFail) => {
    let done = false;
    let timer = null;
    const settle = (code, message, pluginErr, detail) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      onAttemptFail(code, message, pluginErr, detail);
    };
    /* No timeout asked for, no timeout imposed: watchPosition-style callers
       that want to wait indefinitely keep that behaviour by passing nothing,
       which is also what the web API does with the option absent. */
    const ms = Number(windowMs);
    timer = Number.isFinite(ms) && ms > 0
      ? setTimeout(() => settle(TIMEOUT, 'Timed out getting your location.', null, timerDetail), ms)
      : null;
    load().then((Geolocation) => {
      if (!Geolocation) {
        settle(POSITION_UNAVAILABLE, 'Location is not available on this device.', null, 'no-plugin');
        return;
      }
      // try/catch as well as the rejection handler: an SOS is one of the
      // callers, and a bridge that throws synchronously must still reach an
      // error path rather than becoming an unhandled rejection nobody is
      // waiting on.
      try {
        Geolocation.getCurrentPosition(opts).then(
          (position) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            succeed(position);
          },
          (err) => settle(codeFor(err), null, err),
        );
      } catch (err) {
        settle(codeFor(err), null, err);
      }
    });
  };

  const wantsPrecise = !!(options && options.enableHighAccuracy);
  const firstAttemptFailed = (code, message, pluginErr, detail) => {
    // A sheet nobody answered is not a fix that failed; asking again would
    // only queue a second request behind the same sheet.
    const retryable = wantsPrecise && detail !== 'prompt-timer'
      && (code === TIMEOUT || code === POSITION_UNAVAILABLE);
    if (retryable) {
      attempt(COARSE_RETRY, COARSE_RETRY.timeout, 'client-timer',
        (code2, message2, pluginErr2, detail2) => failFinal(code2, message2, pluginErr2, true, detail2));
      return;
    }
    failFinal(code, message, pluginErr, false, detail);
  };

  probe().then((answer) => {
    switch (answer.state) {
      case 'silent':
        webOnDevice(onSuccess, onError, options, 'bridge-silent');
        return;
      case 'no-plugin':
        webOnDevice(onSuccess, onError, options, 'no-plugin');
        return;
      case 'denied':
        // The same words the plugin would have answered a request with, without
        // spending a request on a question whose answer is already known.
        failFinal(PERMISSION_DENIED, 'Location permission was denied.', null, false, 'probe-denied');
        return;
      case 'error':
        // Location Services off device-wide is the usual one (0007).
        failFinal(codeFor(answer.pluginErr), null, answer.pluginErr, false);
        return;
      case 'prompt':
        attempt(options, PROMPT_WINDOW, 'prompt-timer', firstAttemptFailed);
        return;
      default:
        attempt(options, options && options.timeout, 'client-timer', firstAttemptFailed);
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
  if (!isNative() || bridgeSilent) {
    return navigator.geolocation.watchPosition(onSuccess, onError, options);
  }
  const handle = { id: null, webId: null, cancelled: false };
  load().then((Geolocation) => {
    if (handle.cancelled) return;
    if (!Geolocation) {
      // Same fallback as getCurrentPosition: the chunk that did not load is
      // not a reason to leave a person without a location WebKit can give.
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        handle.webId = navigator.geolocation.watchPosition(onSuccess, onError, options);
      } else {
        fail(onError, POSITION_UNAVAILABLE, 'Location is not available on this device.', 'no-plugin');
      }
      return;
    }
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
  if (typeof watchId.webId === 'number') {
    navigator.geolocation.clearWatch(watchId.webId);
    watchId.webId = null;
  }
  stopNativeWatch(watchId);
}
