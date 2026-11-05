// Notifications and the settings a person can change, traced 2026-09-04.
// Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const firebase = read('services/firebase.js');
const userSettings = read('services/userSettings.js');
const profile = read('screens/ProfileSettings.js');

test('signing out on a device that never registered does not unregister the account', () => {
  expect(firebase).toMatch(/const everRegistered = !!token \|\| getNotificationStatus\(\) === 'granted';/);
  expect(firebase).toMatch(/: everRegistered\s*(?:\/\/[^\n]*\n\s*)*\? unregisterAllTokens\(isNativeApp\(\) \? \(window\.Capacitor\.getPlatform\(\) === 'android' \? 'android' : 'ios'\) : 'web'\)\.catch\(\(\) => \{\}\)\s*: Promise\.resolve\(\);/);
});

test('every session start pulls the account settings, not only a cold boot', () => {
  const i = app.indexOf('const beginSession = useCallback');
  const fn = app.slice(i, i + 1400);
  expect(fn).toMatch(/pullSettings\(\)\.catch\(\(\) => \{\}\);/);
});

test('the notification row re-reads the OS answer on resume', () => {
  expect(app).toMatch(/document\.addEventListener\('visibilitychange', onVisible\);\s*window\.addEventListener\('focus', read\);/);
  expect(app).toMatch(/window\.removeEventListener\('focus', read\);/);
});

test('a setting that could not be saved to the account says so', () => {
  expect(userSettings).toMatch(/That setting did not save to your account\. It still applies on this device\./);
  expect(userSettings).toMatch(/\} else if \(typeof window !== 'undefined'\) \{/);
});

test('the night-mode switch announces what it does, and an unsupported browser is not offered a button', () => {
  expect(profile).toMatch(/<Toggle label="Smart Night Mode" on=\{themeMode === 'auto'\}/);
  expect(profile).not.toMatch(/Match device appearance/);
  expect(profile).toMatch(/\) : notifStatus === 'denied' \|\| notifStatus === 'unsupported' \? \(/);
  // Until 2026-11-04 this said "The iPhone app can, once it is out.", because
  // telling a web user to install something that was not on the App Store was
  // a false availability claim. Apple released 1.0 that day, so it says the
  // app is there, in Apple's naming ("Flock for iPhone").
  expect(profile).toMatch(/This browser cannot show notifications\. Flock for iPhone can, and it is on the App Store\./);
  expect(profile).not.toMatch(/once it is out/);
});
