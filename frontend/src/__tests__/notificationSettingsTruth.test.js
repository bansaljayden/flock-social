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
  // Not "install it from the App Store": the app is not on the App Store, the
  // submission was rejected, and this sentence was telling a web user to go
  // and fetch something that is not there. Same false availability claim the
  // Terms heading and llms.txt carried.
  expect(profile).toMatch(/This browser cannot show notifications\. The iPhone app can, once it is out\./);
});
