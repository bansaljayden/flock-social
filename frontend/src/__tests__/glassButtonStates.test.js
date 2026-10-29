/**
 * The glass buttons' theme rules in index.css set background, border and color
 * with !important, so anything a button asks for inline in those three
 * properties is silently lost. Two bugs came from that:
 *
 * 1. A .glass-primary button is navy with white text in light mode and cream
 *    with #1e293b text in dark mode. An icon drawn in a fixed 'white' stayed
 *    white on the cream, so in dark mode it vanished: the Create Flock, Send
 *    the link and Select Venue buttons all did. An icon inside one is drawn in
 *    currentColor, which follows the button's own text colour in both themes.
 *
 * 2. The budget presets, the bill's "paid by" row and the tip row are
 *    .glass-secondary toggles that asked inline for a steel border, tint and
 *    text when chosen; the !important rules overrode all three, so the chosen
 *    chip looked like the rest. The pressed look now lives in index.css, keyed
 *    on aria-pressed.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Each element whose className carries `cls`, from its className to its closing tag.
function elementsWith(cls) {
  const out = [];
  for (const file of sources(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const opener = new RegExp(`className=\\{?["'\`][^"'\`]*${cls}`, 'g');
    let m;
    while ((m = opener.exec(text))) {
      const start = text.lastIndexOf('<', m.index);
      const tag = /^<(\w+)/.exec(text.slice(start))[1];
      const end = text.indexOf(`</${tag}>`, m.index);
      out.push({ file: path.relative(SRC, file), body: text.slice(m.index, end > 0 ? end : m.index + 1500) });
    }
  }
  return out;
}

describe('glass-primary icons follow the button text', () => {
  test('no .glass-primary button draws an icon in a fixed white', () => {
    const found = [];
    for (const { file, body } of elementsWith('glass-primary')) {
      for (const icon of body.matchAll(/Icons\.(\w+)\(\s*('white'|"white"|'#fff(?:fff)?'|"#fff(?:fff)?")/gi)) {
        found.push(`${file}: Icons.${icon[1]}(${icon[2]})`);
      }
    }
    expect(found).toEqual([]);
  });

  test('the dark .glass-primary rule still sets the dark text those icons follow', () => {
    const dark = /\[data-theme="dark"\] \.glass-primary \{([^}]*)\}/.exec(CSS);
    expect(dark).not.toBeNull();
    expect(dark[1]).toMatch(/color:\s*#1e293b/);
  });
});

describe('a pressed glass-secondary toggle looks pressed', () => {
  test('index.css gives aria-pressed glass-secondary a steel border and text in both themes, after the plain rules', () => {
    const light = CSS.indexOf('[data-theme="light"] .glass-secondary[aria-pressed="true"] {');
    const dark = CSS.indexOf('[data-theme="dark"] .glass-secondary[aria-pressed="true"] {');
    expect(light).toBeGreaterThan(-1);
    expect(dark).toBeGreaterThan(-1);
    // Later than the plain rules, so a rule of equal weight could not undo them.
    expect(light).toBeGreaterThan(CSS.indexOf('[data-theme="dark"] .glass-secondary {'));
    const body = (at) => CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
    expect(body(light)).toMatch(/border:\s*2px solid #2d5a87 !important/);
    expect(body(light)).toMatch(/color:\s*#2d5a87 !important/);
    expect(body(dark)).toMatch(/border:\s*2px solid #6d9ac3 !important/);
    expect(body(dark)).toMatch(/color:\s*#78a4cb !important/);
  });

  test('every glass-secondary toggle that styles its chosen state inline says so with aria-pressed', () => {
    const missing = elementsWith('glass-secondary')
      .filter(({ body }) => /2px solid \$\{colors\.steel\}/.test(body.slice(0, 900)))
      .filter(({ body }) => !/aria-pressed=\{/.test(body.slice(0, 600)))
      .map(({ file, body }) => `${file}: ${body.slice(0, 80)}`);
    expect(missing).toEqual([]);
  });
});
