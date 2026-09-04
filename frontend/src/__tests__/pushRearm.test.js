// A permission fixed in Settings is noticed without a cold start.
const fs = require('fs');
const path = require('path');

test('the push re-arm asks the OS when the sticky marker says denied on native', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'firebase.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function rearmIfUnresolved() {'), src.indexOf("if (status === 'denied' || status === 'unsupported') return;", src.indexOf('async function rearmIfUnresolved() {')));
  expect(fn).toMatch(/if \(status === 'denied' && isNativeApp\(\)\) \{/);
  expect(fn).toMatch(/status = await readNotificationPermission\(\);/);
});
