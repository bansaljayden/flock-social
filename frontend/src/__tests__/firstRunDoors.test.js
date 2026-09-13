// A fresh install, traced end to end on 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const signup = read('components/auth/SignupScreen.js');
// The Plans tab left App.js on 2026-09-13 for screens/CalendarScreen.js,
// lazily fetched, and the empty-day state below went with it. A slice of
// App.js for a marker that is no longer in App.js is an empty window, and
// every assertion against an empty window is one that cannot fail, so the
// empty-calendar test reads the file that holds the state now.
const calendarScreen = read('screens/CalendarScreen.js');
// The Discover tab left App.js on 2026-09-13 for screens/ExploreScreen.js,
// lazily fetched, and the Live Events drawer with its location gate went
// with it. Same reason as the line above: a slice of App.js for a marker
// App.js no longer holds is an empty window, and nothing asserted against
// an empty window can fail.
const exploreScreen = read('screens/ExploreScreen.js');

test('confirming the email in Safari has a way back into the app', () => {
  expect(signup).toMatch(/const me = await getCurrentUser\(\);/);
  expect(signup).toMatch(/if \(user\?\.email_verified\) \{\s*onSignupSuccess\(user\);/);
  expect(signup).toMatch(/I opened the link, continue/);
  expect(signup).toMatch(/Not confirmed yet\. Open the link in the email, then come back and tap this again\./);
});

test('a fresh native install opens on account creation', () => {
  expect(app).toMatch(/return \(window\.Capacitor\?\.isNativePlatform\?\.\(\) && !hasToken\) \? 'signup' : 'login';/);
  expect(app).toMatch(/window\.localStorage\.getItem\('flockToken'\)/);
});

test('every ask for location on a first run carries the control', () => {
  // The window is wide enough for the three-sentence gate (the ask, the
  // wait, the failure) that sits between the heading and the control.
  const events = exploreScreen.slice(exploreScreen.indexOf('Events need your location'), exploreScreen.indexOf('Events need your location') + 2400);
  expect(events).toMatch(/if \(!locationEnabled\) toggleLocation\(true\); else requestUserLocation\(true\);/);
  expect(events).toMatch(/Turn on location/);
  expect(exploreScreen).toMatch(/Finding where you are\. Venues near you show up once that lands\./);
});

test('the events gate reads the list once a location lands, and says what it is doing', () => {
  // The tap used to ask the device and then stop: a fix that arrived set
  // userLocation and nothing read events, so the screen did not change. And
  // for the ten seconds a device can take to answer, nothing on the screen
  // said a request was running.
  expect(app).toMatch(/if \(!showEventsView \|\| !userLocation\) return;\s*if \(featuredEvents \|\| featuredEventsLoading \|\| featuredEventsError\) return;\s*fetchFeaturedEvents\(`\$\{userLocation\.lat\},\$\{userLocation\.lng\}`, eventsSearchQuery\);/);
  const events = exploreScreen.slice(exploreScreen.indexOf('Events need your location'), exploreScreen.indexOf('Events need your location') + 2400);
  expect(events).toMatch(/Finding where you are\. Events near you show up once that lands\./);
  expect(events).toMatch(/Could not get your location just now\. Try again\./);
  expect(events).toMatch(/Turn it on in Settings, then come back\./);
  expect(events).toMatch(/disabled=\{locationLoading\}/);
  // The toggle path reports its wait, or the gate above would have nothing
  // to show while a device thinks.
  const toggle = app.slice(app.indexOf('const toggleLocation = '), app.indexOf('const toggleLocation = ') + 2400);
  expect(toggle).toMatch(/setLocationLoading\(true\);\s*getCurrentPosition\(/);
  expect((toggle.match(/setLocationLoading\(false\);/g) || []).length).toBe(2);
});

test('the empty calendar has a next action', () => {
  // Asserted before the slice: indexOf returning -1 would make the window an
  // empty string, and an empty window passes nothing rather than failing loudly.
  expect(calendarScreen).toContain('Nothing on this day');
  const plans = calendarScreen.slice(calendarScreen.indexOf('Nothing on this day'), calendarScreen.indexOf('Nothing on this day') + 900);
  expect(plans).toMatch(/setCurrentTab\('home'\); setCurrentScreen\('create'\);/);
  expect(plans).toMatch(/Start a flock/);
});
