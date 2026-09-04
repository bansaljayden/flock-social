// Every door the server refuses for an unverified email answers with the
// same machine-readable body, and the client has one sheet for it, with the
// resend. These call sites dropped that refusal into a generic toast, or
// worse, mislabelled it. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a QR scan routes a server refusal to the sheet instead of calling the code invalid', () => {
  const app = read('App.js');
  const scan = app.slice(app.indexOf("if (parsed.type === 'flock_friend' && parsed.code) {"), app.indexOf("setQrScanError('Not a valid Flock QR code')"));
  expect(scan).toMatch(/const data = await addFriendByCode\(parsed\.code\);/);
  expect(scan).toMatch(/if \(needsEmailVerification\(err, 'add friends'\)\) return;/);
  expect(scan).toMatch(/Could not add that friend\. Try again\./);
});

test('accepting a request, sending invites and requesting venue verification use the sheet', () => {
  const app = read('App.js');
  const accept = app.slice(app.indexOf('const handleAcceptFriendRequest = useCallback('), app.indexOf("showToast(err.message || 'Failed to accept', 'error');"));
  expect(accept).toMatch(/if \(needsEmailVerification\(err, 'add friends'\)\) return;/);
  expect(app).toMatch(/if \(needsEmailVerification\(err, 'invite people'\)\) return;\s*showToast\(err\.message \|\| 'Failed to send invites', 'error'\);/);
  expect(app).toMatch(/if \(needsEmailVerification\(err, 'request verification'\)\) return;\s*setVerificationRequestError\(/);
});

test('venue onboarding says confirm your email instead of check your details', () => {
  const ob = read('screens/VenueOnboarding.js');
  expect(ob).toMatch(/err\?\.data\?\.emailVerificationRequired\s*\?\s*'Confirm your email first\./);
});
