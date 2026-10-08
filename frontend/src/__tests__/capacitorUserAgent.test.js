/**
 * The word the iPhone build appends to its WebView User-Agent, for the MapTiler
 * key limited to it.
 *
 * MapTiler matches a key's User-Agent rule as one exact, case-sensitive
 * substring, with no wildcards. So the word has to be stable across builds
 * (no version number, no space inside it, which would make it two words a
 * future edit could reorder), it has to sit in the ios block, where Capacitor's
 * iOS shell reads it (CAPInstanceDescriptor reads ios.appendUserAgent, then the
 * top-level one), and it must append, never replace: overrideUserAgent would
 * drop WebKit's own User-Agent, which the app and its vendors read.
 *
 * Read from capacitor.config.ts as text, the way iosShellConfigMatchesCode
 * reads it, because the file is TypeScript and the suite does not compile it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false capacitorUserAgent
 */

const fs = require('fs');
const path = require('path');

const CONFIG = fs.readFileSync(path.join(__dirname, '..', '..', 'capacitor.config.ts'), 'utf8');
// Comments stripped, so a word quoted in prose cannot satisfy an assertion.
const CODE = CONFIG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The text of the top-level `ios: { ... }` block, by brace counting.
function blockAfter(src, label) {
  const at = src.search(new RegExp(`\\n\\s{2}${label}:\\s*\\{`));
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

describe('the iPhone WebView appends a stable word to its User-Agent', () => {
  const ios = blockAfter(CODE, 'ios');
  const values = [...CODE.matchAll(/appendUserAgent:\s*'([^']*)'/g)].map((m) => m[1]);

  it('sets appendUserAgent once, inside the ios block', () => {
    expect(ios).toBeTruthy();
    expect(values).toHaveLength(1);
    expect(ios).toMatch(/appendUserAgent:\s*'FlockiOS'/);
  });

  it('is one word with no space and no version number, so one key rule matches every build', () => {
    const [word] = values;
    expect(word).toBe('FlockiOS');
    expect(word).not.toMatch(/\s/);
    expect(word).not.toMatch(/\d/);
    expect(word).not.toMatch(/\//);
  });

  it('appends and never replaces the WebView User-Agent', () => {
    expect(CODE).not.toMatch(/overrideUserAgent/);
  });
});
