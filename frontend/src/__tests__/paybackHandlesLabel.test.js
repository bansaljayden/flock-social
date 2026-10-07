// The You tab's row for Venmo / Cash App / Zelle handles. It used to read
// "Payment" with a credit-card icon and open "Payment methods", which reads as
// a card on file: the kind of label that draws App Review's questions about
// paid content, for a screen that only stores where friends can pay a person
// back. It is named for what it is now.
const fs = require('fs');
const path = require('path');

const settings = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('the handles row, its title and its heading say pay-back, not payment methods', () => {
  expect(settings).toContain("{ l: 'Pay-back handles', s: 'payment', icon: Icons.dollar,");
  expect(app).toMatch(/payment: 'Pay-back handles',/);
  expect(settings).toContain('>How friends pay you back</h2>');
  expect(settings).not.toContain('>Payment methods</h2>');
  expect(settings).not.toMatch(/l: 'Payment', s: 'payment'/);
  // An unmapped sub-screen gets no title rather than another screen's.
  expect(settings).toContain("{PROFILE_SUBSCREEN_TITLES[profileScreen] || ''}");
});
