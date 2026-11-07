/**
 * THE SVG FILES ARE THE ICONS.JS DRAWINGS, ONE FOR ONE.
 *
 * components/ui/icons/ holds every Icons.js glyph as a standalone SVG at 24 px,
 * for design tools and for anything that cannot run React. Two copies of a
 * drawing drift unless something holds them together, so this renders every
 * key and compares it with its file, character for character.
 *
 * After changing a glyph, rewrite the files (from frontend/):
 *   WRITE_ICON_SVGS=1 CI=true npx react-scripts test iconSvgFiles --watchAll=false
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test iconSvgFiles --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const { renderToStaticMarkup: toMarkup } = require('react-dom/server');
const Icons = require('../components/ui/Icons').default;

const DIR = path.join(__dirname, '..', 'components', 'ui', 'icons');
const KEYS = Object.keys(Icons).sort();
const KEEP = ['width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
const EMPTY_ELEMENTS = /<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*)><\/\1>/g;

/** The top-level elements of a markup string, each as one string. */
function topLevel(markup) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (const m of markup.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    const closing = tag.startsWith('</');
    const selfClosing = tag.endsWith('/>');
    if (!closing && depth === 0) start = m.index;
    if (closing) depth -= 1;
    else if (!selfClosing) depth += 1;
    if (depth === 0) out.push(markup.slice(start, m.index + tag.length));
  }
  return out;
}

/** Icons[key] at 24 px as the file this folder keeps for it. */
function standalone(key) {
  const markup = toMarkup(Icons[key]('currentColor', 24));
  const svg = markup.slice(markup.indexOf('<svg'), markup.lastIndexOf('</svg>') + '</svg>'.length);
  const open = svg.slice(0, svg.indexOf('>') + 1);
  const body = svg.slice(open.length, -'</svg>'.length).replace(EMPTY_ELEMENTS, '<$1$2/>');
  const attrs = [...open.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)];
  const kept = KEEP.flatMap((k) => attrs.filter(([, name]) => name === k).map(([, name, v]) => `${name}="${v}"`));
  // chevronUp/Right/Down are one path turned by a CSS transform on the <svg>;
  // a standalone file carries the turn on a group instead.
  const style = (attrs.find(([, name]) => name === 'style') || [])[2] || '';
  const turn = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(style);
  let lines = topLevel(body);
  if (turn && Number(turn[1]) !== 0) {
    lines = [`<g transform="rotate(${turn[1]} 12 12)">`, ...lines.map((l) => `  ${l}`), '</g>'];
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" ${kept.join(' ')}>\n${lines.map((l) => `  ${l}`).join('\n')}\n</svg>\n`;
}

if (process.env.WRITE_ICON_SVGS === '1') {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of fs.readdirSync(DIR)) {
    if (f.endsWith('.svg') && !KEYS.includes(f.slice(0, -4))) fs.unlinkSync(path.join(DIR, f));
  }
  for (const key of KEYS) fs.writeFileSync(path.join(DIR, `${key}.svg`), standalone(key));
}

describe('components/ui/icons holds every Icons.js drawing as a file', () => {
  test.each(KEYS)('%s.svg matches its Icons.js drawing', (key) => {
    const file = path.join(DIR, `${key}.svg`);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(standalone(key));
  });

  test('and nothing else: every file names a key', () => {
    const orphans = fs.readdirSync(DIR).filter((f) => f.endsWith('.svg') && !KEYS.includes(f.slice(0, -4)));
    expect(orphans).toEqual([]);
  });

  test('every file is a 24 grid drawing in currentColor', () => {
    for (const key of KEYS.filter((k) => k !== 'safetyBirds')) {
      const text = fs.readFileSync(path.join(DIR, `${key}.svg`), 'utf8');
      expect(text).toContain('viewBox="0 0 24 24"');
      expect(text).toContain('stroke="currentColor"');
      expect(text).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  test('the folder says how the files are kept and what the rules are', () => {
    const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    expect(readme).toContain('WRITE_ICON_SVGS=1');
    expect(readme).toMatch(/size \/ 10\.5/);
    expect(readme).toMatch(/currentColor/);
  });
});
