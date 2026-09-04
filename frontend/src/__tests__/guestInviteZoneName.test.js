// The invite page and the link preview must agree on what clock they are
// showing. The preview names its zone; the page did not, so a reader in
// another zone saw two different times with nothing to explain the gap.
const fs = require('fs');
const path = require('path');

test('the guest invite page names the zone next to the time', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'GuestInvite.js'), 'utf8');
  const fn = src.slice(src.indexOf('const whenLabel = (d) => {'), src.indexOf('return `${day} ${DOT} ${time}`;'));
  expect(fn).toMatch(/toLocaleTimeString\(undefined, \{ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' \}\)/);
  const preview = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'invite-preview.js'), 'utf8');
  expect(preview).toMatch(/timeZoneName: 'short'/);
});
