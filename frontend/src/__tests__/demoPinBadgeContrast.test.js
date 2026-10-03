/**
 * The live demo's pin badge is 11px black type on the crowd colour the venue
 * scored. Every ground it can sit on has to hold WCAG AA 4.5:1 with black. The
 * closed slate did not (4.41:1, site audit 2026-10-03), so the badge has its
 * own lighter slate. FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'website', 'LiveDemo.js'), 'utf8');
const hex = (name) => {
  const m = new RegExp(`const ${name} = '(#[0-9A-Fa-f]{6})';`).exec(SRC);
  expect(m).not.toBeNull();
  return m[1];
};
const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const onBlack = (h) => (luminance(h) + 0.05) / 0.05;

test('black type holds 4.5:1 on every ground the badge can wear', () => {
  for (const name of ['CROWD_GREEN', 'CROWD_AMBER', 'CROWD_RED', 'CROWD_CLOSED_BADGE']) {
    expect(onBlack(hex(name))).toBeGreaterThanOrEqual(4.5);
  }
});

test('a closed or covered pin\'s badge wears the badge slate, not the ring\'s', () => {
  expect(onBlack(hex('CROWD_CLOSED'))).toBeLessThan(4.5); // why the badge has its own
  expect(SRC).toContain("badge.style.backgroundColor = (shut || covered) ? CROWD_CLOSED_BADGE : ring;");
});
