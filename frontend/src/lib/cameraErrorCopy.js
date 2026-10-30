/**
 * WHAT TO SAY WHEN THE CAMERA DOES NOT START.
 *
 * The chat camera's toast was 'Could not access camera: ' and then the error's
 * own text, which is the browser's or the native bridge's wording for a log
 * ("Could not start video source"), and its permission line sent an iPhone to
 * browser settings that do not exist inside the app. Each failure has a fixed
 * sentence now, picked by the error's name, and the permission sentence names
 * the switch on the platform the app is running on.
 *
 * Pure, so the rule is tested without a camera.
 */

export const CAMERA_COPY = {
  deniedNative: 'Camera access is off. Turn it on in Settings > Flock, then try again.',
  deniedWeb: 'Camera access is blocked. Allow it in your browser settings, then try again.',
  noCamera: 'No camera was found on this device.',
  other: "The camera didn't start. Try again.",
};

const DENIED = new Set(['NotAllowedError', 'PermissionDeniedError']);
const NO_CAMERA = new Set(['NotFoundError', 'DevicesNotFoundError']);
// A library that reports a refusal as text (html5-qrcode hands back
// "Error getting userMedia, error = NotAllowedError: Permission denied")
// still names the error inside it.
const NAME_IN_TEXT = /\b(NotAllowedError|PermissionDeniedError|NotFoundError|DevicesNotFoundError)\b/;

/** The DOMException name behind a camera failure, or '' when there is none to read. */
export function cameraErrorName(err) {
  if (!err) return '';
  if (typeof err === 'string') {
    const m = err.match(NAME_IN_TEXT);
    return m ? m[1] : '';
  }
  if (typeof err.name === 'string' && err.name && err.name !== 'Error') return err.name;
  const m = typeof err.message === 'string' ? err.message.match(NAME_IN_TEXT) : null;
  return m ? m[1] : '';
}

/** The sentence for a camera that did not start. `native` is lib/nativeShell's answer. */
export function cameraErrorCopy(err, native) {
  const name = cameraErrorName(err);
  if (DENIED.has(name)) return native ? CAMERA_COPY.deniedNative : CAMERA_COPY.deniedWeb;
  if (NO_CAMERA.has(name)) return CAMERA_COPY.noCamera;
  return CAMERA_COPY.other;
}
