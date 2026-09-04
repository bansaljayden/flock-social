// Account doors that dead-ended or lied, from the account-settings trace of
// 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a password change keeps the replacement token', () => {
  const api = read('services/api.js');
  expect(api).toMatch(/if \(data && typeof data\.token === 'string' && data\.token\) setToken\(data\.token\);/);
  expect(api).toMatch(/export async function logoutAll\(\) \{\s*return request\('\/api\/auth\/logout-all', \{ method: 'POST' \}\);/);
});

test('an email change mails the new address and says so', () => {
  const form = read('components/EditProfileForm.js');
  expect(form).toMatch(/if \(data\.emailVerificationRequired\) \{\s*[\s\S]{0,400}?resendVerificationEmail\(\)\.catch\(\(\) => \{\}\);/);
  expect(form).toMatch(/Saved\. We sent a link to your new address; confirm it to keep making plans\./);
  expect(form).toMatch(/else if \(profilePhone\) payload\.phone = null;/);
});

test('a saved payment handle is read back, and sign out everywhere has a door', () => {
  const settings = read('screens/ProfileSettings.js');
  expect(settings).toMatch(/onUserUpdated\?\.\(\{ venmo_username: venmoUsername, cashapp_cashtag: cashappCashtag, zelle_identifier: zelleIdentifier \}\);/);
  expect(settings).toMatch(/await logoutAll\(\);/);
  expect(settings).toMatch(/Sign out everywhere/);
  const app = read('App.js');
  expect(app).toMatch(/const onUserUpdated = useCallback\(\(patch\) => \{ if \(onUserPatch\) onUserPatch\(patch\); \}, \[onUserPatch\]\);/);
  expect(app).toMatch(/onUserPatch=\{\(patch\) => setAuthUser\(prev => \(prev \? \{ \.\.\.prev, \.\.\.patch \} : prev\)\)\}/);
  expect(app).toMatch(/signed_out_everywhere: 'Signed out on every device, this one included\./);
});
