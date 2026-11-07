// The You tab's Legal row holds three buttons. In one row they are wider than
// a 375 px screen, which is the size App Review sees, because an iPad runs
// this iPhone-only app in iPhone compatibility mode. A flex row's overflow
// cannot be scrolled to, so the first and last buttons were cut off. The row
// must wrap. Support left it on 2026-11-06 for its own Help row above it
// (youScreenBottomGroups.test.js).
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');

test('the Legal row wraps instead of overflowing a narrow screen', () => {
  const at = src.indexOf('>Legal</h4>');
  expect(at).toBeGreaterThan(-1);
  const row = src.slice(at, at + 400);
  expect(row).toMatch(/<div style=\{\{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-start' \}\}>/);
  // All three legal links are still in it.
  const block = src.slice(at, at + 6000);
  for (const label of ['Terms of service', 'Privacy policy', 'Community guidelines']) {
    expect(block).toContain(label);
  }
});
