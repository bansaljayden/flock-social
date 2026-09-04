// After a password reset succeeds the page sends the person to sign in. On
// the web "/" is the marketing site (src/index.js), so that used to land them
// on landing copy with no sign-in form; "/app" is the canonical web entry.
const fs = require('fs');
const path = require('path');

test('the reset page exits to the app, not the marketing site', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'auth', 'PasswordReset.js'), 'utf8');
  expect(src).toMatch(/const goHome = \(arg\) => \{/);
  expect((src.match(/window\.location\.assign\('\/app'\)/g) || []).length).toBe(2);
  expect(src).not.toMatch(/window\.location\.assign\('\/'\)/);
  // A successful reset also has to survive the navigation. ResetPasswordScreen
  // hands { updated: true } to onSignIn and the in-app flow renders "Password
  // updated. Sign in with the new one." from it; a full page load cannot carry
  // an argument, so the fact goes through sessionStorage and the stale JWT is
  // cleared on the way. Without that, resetting on a machine you were still
  // signed in on booted /app on a token one version behind, and the person was
  // shown "Your session expired" seconds after being told their password was set.
  expect(src).toMatch(/if \(arg && arg\.updated\) \{/);
  expect(src).toMatch(/clearLocalSession\(\);/);
  expect(src).toMatch(/sessionStorage\.setItem\(RESET_DONE_KEY, '1'\);/);
  const login = fs.readFileSync(path.join(__dirname, '..', 'components', 'auth', 'LoginScreen.js'), 'utf8');
  expect(login).toMatch(/sessionStorage\.getItem\(RESET_DONE_KEY\) === '1'/);
  expect(login).toMatch(/sessionStorage\.removeItem\(RESET_DONE_KEY\)/);
  expect(login).toMatch(/setNotice\('Password updated\. Sign in with the new one\.'\)/);
});
