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

test('an email change mails the new address and says what happened', () => {
  const form = read('components/EditProfileForm.js');
  // This form is the ONLY sender of the new address's link: routes/users.js
  // clears both verified columns and deliberately does not mail, so a swallowed
  // failure here is an account that can never make a plan again and a screen
  // that says a link is on its way. The call is awaited and all three answers
  // the route can give are rendered.
  expect(form).toMatch(/if \(data\.emailVerificationRequired\) \{\s*[\s\S]{0,800}?applyResendResult\(await resendVerificationEmail\(\)\);/);
  expect(form).not.toMatch(/resendVerificationEmail\(\)\.catch\(\(\) => \{\}\)/);
  // A 200 is not a send. The route reports verificationSent separately.
  expect(form).toMatch(/const sent = data\?\.verificationSent !== false;/);
  expect(form).toMatch(/Saved\. We sent a link to your new address; confirm it to keep making plans\./);
  expect(form).toMatch(/Saved, but the confirmation link did not go out\./);
  expect(form).toMatch(/Saved\. We cannot mail your new address: mail to it bounced or was reported as spam before\./);
  expect(form).toMatch(/else if \(profilePhone\) payload\.phone = null;/);
});

test('and it offers a way to ask for the link again, on the same cooldown the server keeps', () => {
  const form = read('components/EditProfileForm.js');
  expect(form).toMatch(/const \[resendCooldown, setResendCooldown\] = React\.useState\(0\);/);
  expect(form).toMatch(/setTimeout\(\(\) => setResendCooldown\(\(n\) => n - 1\), 1000\)/);
  // Cooldown before the request, so a double tap cannot get through.
  expect(form).toMatch(/setResendCooldown\(60\);\s*try \{\s*applyResendResult\(await resendVerificationEmail\(\)\);/);
  expect(form).toMatch(/\{verifyPending && !verifyRefused && \(/);
  // "again" is a claim. Nothing was sent when the first attempt did not land.
  expect(form).toMatch(/verifyLinkSent \? 'Send the link again' : 'Send the link'/);
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
