/**
 * A SMALL BUTTON'S 44PX FINGER BOX IS NOT CLIPPED BY THE BUTTON ITSELF.
 *
 * .hit44 (index.css) leaves the paint alone and lays a transparent 44x44 box
 * over the button with a ::after, so a 14px icon is still a 44px target. A
 * pseudo-element is the button's own content, so `overflow: hidden` on the
 * button clips it back to the paint. The x that removes an interest on the
 * Interests screen did exactly that: 14 by 14 px, measured by the
 * click-through crawl on 2026-11-11, with a 44px box drawn and cut away.
 *
 * Buttons with real padding keep most of their size when clipped; the one
 * that cannot afford it is an icon with no padding at all. So: no hit44
 * button with `padding: 0` sets `overflow: hidden` on itself, in any file.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test hitAreaNotClipped --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

function sourceFiles(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('the index.css rule this relies on is still a ::after box', () => {
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
  expect(css).toMatch(/\.hit44::after \{[\s\S]{0,200}width: max\(100%, 44px\);[\s\S]{0,60}height: max\(100%, 44px\);/);
});

test('no icon-only hit44 button clips its own finger box', () => {
  const files = sourceFiles();
  expect(files.length).toBeGreaterThan(50);
  const offenders = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (!/<button[^>]*className="hit44[^"]*"/.test(line)) return;
      if (/padding: 0[,\s}]/.test(line) && /overflow: 'hidden'/.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});

test('the interest x is a hit44 button with no overflow of its own', () => {
  const settings = fs.readFileSync(path.join(SRC, 'screens', 'ProfileSettings.js'), 'utf8');
  const line = settings.split(/\r?\n/).find((l) => l.includes('aria-label="Remove interest"'));
  expect(line).toMatch(/className="hit44"/);
  expect(line).not.toMatch(/overflow:/);
});
