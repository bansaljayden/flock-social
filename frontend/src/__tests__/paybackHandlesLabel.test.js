// The You tab's row for Venmo / Cash App / Zelle handles. It used to read
// "Payment" with a credit-card icon and open "Payment methods", which reads as
// a card on file: the kind of label that draws App Review's questions about
// paid content, for a screen that only stores where friends can pay a person
// back. It is named for what it is now.
const fs = require('fs');
const path = require('path');

const settings = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const signup = fs.readFileSync(path.join(__dirname, '..', 'components', 'auth', 'SignupScreen.js'), 'utf8');
const birdie = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'ai.js'), 'utf8');
const usersRoute = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'users.js'), 'utf8');

test('the handles row, its title and its heading say pay-back, not payment methods', () => {
  expect(settings).toContain("{ l: 'Pay-back handles', s: 'payment', icon: Icons.dollar,");
  expect(app).toMatch(/payment: 'Pay-back handles',/);
  expect(settings).toContain('>How friends pay you back</h2>');
  expect(settings).not.toContain('>Payment methods</h2>');
  expect(settings).not.toMatch(/l: 'Payment', s: 'payment'/);
  // An unmapped sub-screen gets no title rather than another screen's.
  expect(settings).toContain("{PROFILE_SUBSCREEN_TITLES[profileScreen] || ''}");
});

test('the words around it say the same thing: the save toast, the verify hint, signup and Birdie', () => {
  expect(settings).toContain("showToast('Pay-back handles saved');");
  expect(settings).toContain("needsEmailVerification(err, 'save a pay-back handle')");
  expect(signup).toContain('add friends and save a pay-back handle.');
  // Birdie sends people to this screen by name; it must use the row's name.
  expect(birdie).toContain('"payment" (pay-back handles: Venmo, Cash App, Zelle)');
  expect(birdie).toContain('- **You** (tab: profile): profile, settings, pay-back handles (Venmo, Cash App, Zelle), appearance');
  expect(birdie).not.toMatch(/payment methods/i);
  // The save route's errors reach the screen word for word (ProfileSettings
  // toasts err.message).
  expect(usersRoute).toContain("{ error: 'No pay-back handles provided' }");
  expect(usersRoute).toContain("{ error: 'Failed to save pay-back handles' }");
  expect(usersRoute).not.toMatch(/error: '[^']*payment methods/i);
});

test('the Interests row counts in the singular for one', () => {
  // It read "1 interests" (found on the local stack, 2026-10-07).
  expect(settings).toContain("`${userInterests.length} interest${userInterests.length === 1 ? '' : 's'}`");
});
