// After a password reset succeeds the page sends the person to sign in. On
// the web "/" is the marketing site (src/index.js), so that used to land them
// on landing copy with no sign-in form; "/app" is the canonical web entry.
const fs = require('fs');
const path = require('path');

test('the reset page exits to the app, not the marketing site', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'auth', 'PasswordReset.js'), 'utf8');
  expect(src).toMatch(/const goHome = \(\) => \{ window\.location\.assign\('\/app'\); \};/);
  expect(src).not.toMatch(/window\.location\.assign\('\/'\)/);
});
