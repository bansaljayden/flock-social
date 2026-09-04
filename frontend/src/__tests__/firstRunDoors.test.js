// A fresh install, traced end to end on 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const signup = read('components/auth/SignupScreen.js');

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
  const events = app.slice(app.indexOf('Events need your location'), app.indexOf('Events need your location') + 1200);
  expect(events).toMatch(/if \(!locationEnabled\) toggleLocation\(true\); else requestUserLocation\(true\);/);
  expect(events).toMatch(/Turn on location/);
  expect(app).toMatch(/Finding where you are\. Venues near you show up once that lands\./);
});

test('the empty calendar has a next action', () => {
  const plans = app.slice(app.indexOf('Nothing on this day'), app.indexOf('Nothing on this day') + 900);
  expect(plans).toMatch(/setCurrentTab\('home'\); setCurrentScreen\('create'\);/);
  expect(plans).toMatch(/Start a flock/);
});
