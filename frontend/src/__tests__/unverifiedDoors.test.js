// Every door the server refuses for an unverified email answers with the
// same machine-readable body, and the client has one sheet for it, with the
// resend. These call sites dropped that refusal into a generic toast, or
// worse, mislabelled it. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a QR scan routes a server refusal to the sheet instead of calling the code invalid', () => {
  // The scanner is components/QrScanner.js since 2026-11-23; a code it reads
  // comes back to App.js's addFromScanner, which owns the refusal. The confirm
  // sheet would be under the full-screen scanner, so the scanner is told to
  // close, and the code is kept to offer again once the address is confirmed.
  const app = read('App.js');
  const at = app.indexOf('const addFromScanner = useCallback(');
  expect(at).toBeGreaterThan(-1);
  const scan = app.slice(at, app.indexOf('}, [sendFriendCode, showToast, needsEmailVerification]);', at));
  expect(scan).toMatch(/const result = await sendFriendCode\(code\);/);
  expect(scan).toMatch(/if \(needsEmailVerification\(err, 'add friends'\)\) \{\s*rememberFriendCode\(code\);\s*return \{ ok: false, close: true \};/);
  expect(scan).toMatch(/Could not add that friend\. Try again\./);
});

test('accepting a request, sending invites and requesting venue verification use the sheet', () => {
  const app = read('App.js');
  const accept = app.slice(app.indexOf('const handleAcceptFriendRequest = useCallback('), app.indexOf(`showToast(userMessage(err, "Couldn't accept that request. Try again."), 'error');`));
  expect(accept.length).toBeGreaterThan(200);
  expect(accept).toMatch(/if \(needsEmailVerification\(err, 'add friends'\)\) return;/);
  expect(app).toMatch(/if \(needsEmailVerification\(err, 'invite people'\)\) return;\s*showToast\(userMessage\(err, 'Failed to send invites'\), 'error'\);/);
  expect(app).toMatch(/if \(needsEmailVerification\(err, 'request verification'\)\) return;\s*setVerificationRequestError\(/);
});

test('venue onboarding says confirm your email instead of check your details, and raises the sheet', () => {
  const ob = read('screens/VenueOnboarding.js');
  // The sheet, so the link can be asked for from here; the line under the
  // button says what to do, never that a link was sent.
  expect(ob).toMatch(/const unconfirmed = needsEmailVerification\(err, 'launch your dashboard'\);\s*setVenueOnboardingError\(unconfirmed\s*\?\s*'Confirm your email first,/);
  expect(ob).not.toMatch(/link we sent/i);
  const app = read('App.js');
  const props = app.slice(app.indexOf('const venueOnboardingProps = {'), app.indexOf('<VenueOnboarding {...venueOnboardingProps} />'));
  expect(props).toMatch(/\n\s*needsEmailVerification,\r?\n/);
});
