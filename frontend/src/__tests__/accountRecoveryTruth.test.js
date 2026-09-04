// Account recovery, traced 2026-09-04. Source contracts.
//
// Every one of these is a place where the recovery path told the user something
// the code did not do, or left a door open the user had just asked to close.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const backend = (f) => fs.readFileSync(path.join(REPO, 'backend', 'routes', f), 'utf8');
const auth = backend('auth.js');
const users = backend('users.js');

test('a superseded link is superseded, not reported as spent', () => {
  // Retiring an older link and spending one both wrote used_at, so the check
  // route answered 'used' for both, and the copy behind 'used' warns that
  // somebody else opened the link. Asking twice and opening the older mail is
  // ordinary, and it raised a break-in alarm about nobody.
  expect(auth).toMatch(/DELETE FROM password_resets WHERE user_id = \$1 AND used_at IS NULL/);
  const issue = auth.slice(auth.indexOf('async function issueReset('), auth.indexOf('async function issueReset(') + 1800);
  expect(issue).toMatch(/DELETE FROM password_resets/);
  expect(issue).not.toMatch(/UPDATE password_resets SET used_at/);
  // consumeReset still stamps its siblings: there a link really was spent.
  const consume = auth.slice(auth.indexOf('async function consumeReset('), auth.indexOf('async function consumeReset(') + 3000);
  expect(consume).toMatch(/UPDATE password_resets SET used_at = NOW\(\) WHERE user_id = \$1 AND used_at IS NULL/);
});

test('a completed reset lifts the sign-in lockout it exists to get past', () => {
  // clearLoginFailures was called from exactly one place, a successful login,
  // so ten wrong guesses then a successful reset ended on "Too many failed
  // sign-in attempts" for the password the person had just chosen.
  expect(auth).toMatch(/clearLoginFailures\(canonicalEmail\(result\.email\)\);/);
  expect(auth).toMatch(/return \{ ok: true, userId: row\.user_id, email: row\.current_email \};/);
});

test('both credential-change doors retire an outstanding reset link', () => {
  // A live link overwrites the new password and re-revokes every session for
  // the rest of its hour, which is the opposite of what either door was for.
  expect(auth).toMatch(/\[auth\] reset link retirement failed for user/);
  expect(users).toMatch(/\[users\] reset link retirement failed for user/);
  // Neither is awaited into the response: the credential has already changed.
  expect(auth).not.toMatch(/await pool\.query\('DELETE FROM password_resets/);
  expect(users).not.toMatch(/await pool\.query\('DELETE FROM password_resets/);
});

test('there is one answer to whether an address can receive mail', () => {
  // The local copy accepted anything with an @ that did not end in .invalid, so
  // an address the mailer refuses still minted a token row and spent a slot of
  // the sending budget on mail that was never attempted.
  expect(auth).toMatch(/isMailableAddress: emailServiceIsMailable,/);
  expect(auth).toMatch(/function isMailableAddress\(addr\) \{\s*return emailServiceIsMailable\(addr\);\s*\}/);
  expect(auth).not.toMatch(/\/@\/\.test\(addr\) && !\/\\\.invalid\$\/i\.test/);
});

test('the Apple button names the API by its own domain', () => {
  const btn = fs.readFileSync(path.join(REPO, 'frontend', 'src', 'components', 'auth', 'AppleSignInButton.js'), 'utf8');
  expect(btn).toMatch(/redirectURI: 'https:\/\/api\.flockcorp\.com\/api\/auth\/apple'/);
  expect(btn).not.toMatch(/flock-app-production\.up\.railway\.app/);
});
