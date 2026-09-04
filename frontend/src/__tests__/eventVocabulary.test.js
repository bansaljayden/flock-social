// Two silent no-ops found by cross-checking what the backend sends against
// what the client handles. Each was a real thing a person saw, or rather did
// not see. Pinned as source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a badge sync never becomes a blank notification on the web', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'firebase-messaging-sw.js'), 'utf8');
  const handler = sw.slice(sw.indexOf('messaging.onBackgroundMessage('), sw.indexOf('showNotification(data.title'));
  expect(handler).toMatch(/if \(data\.type === 'badge_sync'\) return;/);
});

test('a payment taken back reaches the open bill sheet', () => {
  const socket = read('services/socket.js');
  expect(socket).toMatch(/export function onShareUnsettled\(callback\) \{\s*return register\('share_unsettled', callback\);/);
  const app = read('App.js');
  expect(app).toMatch(/onShareSettled, onShareUnsettled,/);
  const effect = app.slice(app.indexOf('const unsubUnsettled = onShareUnsettled('), app.indexOf('unsubUnsettled();'));
  expect(effect).toMatch(/settled: false/);
  expect(effect).toMatch(/data\.flockId === selectedFlockId/);
});

test('a foreground push on the device is shown once, by the OS banner, not again as a toast', () => {
  const app = read('App.js');
  const effect = app.slice(app.indexOf('const unsubscribe = onForegroundMessage((notification) => {'), app.indexOf("new CustomEvent('flock-toast'"));
  expect(effect).toMatch(/if \(window\.Capacitor\?\.isNativePlatform\?\.\(\)\) return;/);
});
