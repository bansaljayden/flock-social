// Export and deletion as a person does them, traced 2026-09-04. Source
// contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const profile = read('screens/ProfileSettings.js');
const signup = read('components/auth/SignupScreen.js');
const dataExport = read('services/dataExport.js');
const users = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'users.js'), 'utf8');
const auth = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'auth.js'), 'utf8');

test('an uploaded profile photo no longer breaks the export', () => {
  expect(users).toMatch(/\? \{ profile_image_url: null, profile_photo_omitted: true \}/);
  expect(users).toMatch(/and your profile photo, are not included in this file/);
  expect(users).toMatch(/EXPORT_OMISSIONS_NOTE,\s*\],/);
  expect(profile).toMatch(/Photos in messages and your profile photo are not included; they stay visible in the app\./);
});

test('an Apple or Google account is not asked for a password it does not have', () => {
  expect(auth).toMatch(/user\.sign_in_method = provider \|\| 'password';/);
  expect(profile).toMatch(/You sign in with \{authUser\.sign_in_method === 'apple' \? 'Apple' : 'Google'\}\. If it has been more than five minutes since you signed in, Flock will ask you to sign in again first\./);
  expect((profile.match(/authUser\.sign_in_method !== 'password'/g) || []).length).toBe(4);
});

test('a lockout is not a wrong password, and a cancelled share is not a saved file', () => {
  expect(app).toMatch(/if \(err\?\.status === 429\) \{[\s\S]{0,300}setExportError\(err\?\.message \|\| 'Too many tries\. Wait a few minutes and try again\.'\);/);
  expect(dataExport).toMatch(/if \(err && err\.name === 'AbortError'\) return 'cancelled';/);
  expect(app).toMatch(/if \(how === 'cancelled'\) \{[\s\S]{0,400}setExportError\('Nothing was saved\. Tap Get my data to open the share sheet again\.'\);/);
});

test('a deletion that committed while the reply was lost is treated as done, and an Apple failure tells the truth', () => {
  expect(profile).toMatch(/if \(err\?\.isNetworkError \|\| err\?\.isTimeout\) \{[\s\S]{0,700}gone = probe\?\.status === 401;[\s\S]{0,300}onLogout\(sessionEndCopy\('account_deleted'\)\);/);
  expect(users).toMatch(/let appleRevoked = false;/);
  expect(users).toMatch(/Your Apple sign-in was disconnected, but the account could not be deleted just now\. Sign in with Apple again, then try once more\./);
});

test('a refused address is told why, and not offered another try', () => {
  expect(auth).toMatch(/mailRefused = sendResult\.refused === true;/);
  expect(auth).toMatch(/verificationSent: sendResult\.sent === true, mailRefused: sendResult\.refused === true \}\);/);
  expect(signup).toMatch(/We cannot mail this address: mail to it bounced or was reported as spam before\. Email social@flockcorp\.com from it and we will clear that\./);
  expect(signup).toMatch(/disabled=\{resendCooldown > 0 \|\| mailRefused\}/);
});
