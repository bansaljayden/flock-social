// The You tab's Legal row holds four buttons. In one centered row they are
// wider than a 375 px screen, which is the size App Review sees, because an
// iPad runs this iPhone-only app in iPhone compatibility mode. A centered flex
// row's left overflow cannot be scrolled to, so the first and last buttons
// were cut off. The row must wrap.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');

test('the Legal row wraps instead of overflowing a narrow screen', () => {
  const at = src.indexOf('>Legal</p>');
  expect(at).toBeGreaterThan(-1);
  const row = src.slice(at, at + 400);
  expect(row).toMatch(/<div style=\{\{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center' \}\}>/);
  // All four legal links are still in it.
  const block = src.slice(at, at + 6000);
  for (const label of ['Terms of Service', 'Privacy Policy', 'Support', 'Community Guidelines']) {
    expect(block).toContain(label);
  }
});
