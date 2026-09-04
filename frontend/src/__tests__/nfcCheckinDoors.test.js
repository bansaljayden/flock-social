// A tag tap reaches the app, the screen is a component, and check-ins are
// visible without a hardware sensor. From the NFC check-in trace of
// 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const nav = read('services/pushNavigation.js');
const dash = read('screens/VenueDashboard.js');
const aasa = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'apple-app-site-association.js'), 'utf8');

test('a tag tap is a claimed universal link with an intent behind it', () => {
  expect(aasa).toMatch(/\{ '\/': '\/checkin\/\*', comment: 'NFC venue check-in; routed by intentFromUrl' \}/);
  expect(nav).toMatch(/const checkinMatch = url\.pathname\.match\(\/\^\\\/checkin\\\/\(\[\^\/\?#\]\+\)\/\);/);
  expect(nav).toMatch(/return \{ screen: 'checkin', placeId, sig: q\.get\('sig'\) \|\| null, type: 'link' \};/);
  expect(app).toMatch(/\} else if \(intent\.screen === 'checkin' && intent\.placeId\) \{\s*(?:\/\/[^\n]*\n\s*)*setNfcPlaceId\(intent\.placeId\);\s*setNfcSig\(intent\.sig \|\| null\);\s*setCurrentScreen\('nfcCheckin'\);/);
});

test('the check-in screen is a mounted component, not a called builder with hooks', () => {
  expect(app).toMatch(/^const NfcCheckinView = \(\{ placeId, sig, onViewVenue, onOpenApp \}\) => \{/m);
  const builder = app.slice(app.indexOf('const NfcCheckinScreen = () => ('), app.indexOf('const NfcCheckinScreen = () => (') + 1600);
  expect(builder).toMatch(/<NfcCheckinView/);
  expect(builder).not.toMatch(/useState|useEffect/);
  expect(app).toMatch(/if \(currentScreen === 'nfcCheckin'\) return NfcCheckinScreen\(\);/);
});

test('"View venue" opens the venue sheet, and a refresh on the web stays in the app', () => {
  const builder = app.slice(app.indexOf('const NfcCheckinScreen = () => ('), app.indexOf('const NfcCheckinScreen = () => (') + 1600);
  expect(builder).toMatch(/openVenueDetail\(pid, null, \{ panMap: true \}\)/);
  expect((builder.match(/window\.Capacitor\?\.isNativePlatform\?\.\(\) \? '\/' : '\/app'/g) || []).length).toBe(2);
  expect(app).not.toMatch(/window\.__flockPanToVenue\(\{ place_id: placeId \}\)/);
});

test('the screen names the venue and says what failed, with a retry where one can work', () => {
  const view = app.slice(app.indexOf('const NfcCheckinView = '), app.indexOf('const isFullBleedNow = () =>'));
  expect(view).toMatch(/You're checked in\{venueName \? ` at \$\{venueName\}` : ''\}/);
  expect(view).toMatch(/if \(failure\.status === 404\) return 'This tag is not on Flock\\u2019s map\. Tell the venue\.';/);
  expect(view).toMatch(/if \(failure\.offline\) return "You're offline\. Tap the tag again when you have signal\.";/);
  expect(view).toMatch(/const canRetry = !failure \|\| failure\.offline \|\| failure\.status === 0 \|\| failure\.status >= 500;/);
  expect(view).not.toMatch(/Continue to website/);
  expect(view).not.toMatch(/\{placeId\}<\/p>/);
});

test('check-ins are visible to the sheet and the dashboard without a hardware sensor', () => {
  expect(app).toMatch(/setSensorData\(current \|\| null\);/);
  expect(app).toMatch(/setOwnerSensorData\(current \|\| null\);/);
  expect(app).not.toMatch(/current && current\.sensor_data \? current : null/);
  expect(app).toMatch(/\{sensorData && !sensorData\.sensor_data && sensorData\.recent_checkins > 0 && \(/);
  expect(dash).toMatch(/\{ownerSensorData && !ownerSensorData\.sensor_data && \(/);
});
