/**
 * THE CAMERA THAT DID NOT START SAYS WHY IN WORDS OF ITS OWN.
 *
 * The chat camera toasted 'Could not access camera: ' plus the browser's or
 * the native bridge's text, and its permission line sent an iPhone to browser
 * settings the app does not have. lib/cameraErrorCopy.js picks a fixed
 * sentence by the error's name; App.js uses it for the chat camera and for the
 * QR scanner's camera.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test cameraErrorCopy --watchAll=false
 */
import { cameraErrorCopy, cameraErrorName, CAMERA_COPY } from '../lib/cameraErrorCopy';

const fs = require('fs');
const path = require('path');

const domError = (name, message = 'whatever the browser says') => Object.assign(new Error(message), { name });

test('a refused permission names the switch where it lives: Settings in the app, the browser outside it', () => {
  expect(cameraErrorCopy(domError('NotAllowedError'), true)).toBe('Camera access is off. Turn it on in Settings > Flock, then try again.');
  expect(cameraErrorCopy(domError('NotAllowedError'), false)).toBe('Camera access is blocked. Allow it in your browser settings, then try again.');
  // Chrome's older name for the same refusal.
  expect(cameraErrorCopy(domError('PermissionDeniedError'), false)).toBe(CAMERA_COPY.deniedWeb);
});

test('no camera at all says so', () => {
  expect(cameraErrorCopy(domError('NotFoundError'), true)).toBe('No camera was found on this device.');
  expect(cameraErrorCopy(domError('DevicesNotFoundError'), false)).toBe(CAMERA_COPY.noCamera);
});

test('anything else is one plain sentence, never the error text', () => {
  for (const err of [domError('NotReadableError', 'Could not start video source'), domError('AbortError'), new TypeError('x is undefined'), null, undefined, {}]) {
    const said = cameraErrorCopy(err, false);
    expect(said).toBe("The camera didn't start. Try again.");
    expect(said).not.toMatch(/video source|undefined|Error/);
  }
});

test("a library that reports the refusal as text still gets the refusal's sentence", () => {
  expect(cameraErrorName('Error getting userMedia, error = NotAllowedError: Permission denied')).toBe('NotAllowedError');
  expect(cameraErrorCopy('Error getting userMedia, error = NotAllowedError: Permission denied', true)).toBe(CAMERA_COPY.deniedNative);
  expect(cameraErrorCopy(new Error('NotFoundError: Requested device not found'), false)).toBe(CAMERA_COPY.noCamera);
});

test('no em dash in anything the camera says', () => {
  for (const s of Object.values(CAMERA_COPY)) expect(s).not.toMatch(/—/);
});

test('App.js says these and nothing of the error\'s own, for the chat camera and the QR scanner', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
  const open = app.slice(app.indexOf('const openCameraViewfinder = useCallback('), app.indexOf('const closeCameraViewfinder = useCallback('));
  expect(open).toContain("showToast(cameraErrorCopy(err, isNativeShell()), 'error');");
  expect(open).not.toMatch(/err\.message/);
  const scanner = app.slice(app.indexOf('const startQrScanner = useCallback('), app.indexOf('const stopQrScanner = useCallback('));
  expect(scanner).toContain(': cameraErrorCopy(err, isNativeShell())');
  expect(scanner).not.toMatch(/err\.message \|\| 'Could not access camera'/);
});
