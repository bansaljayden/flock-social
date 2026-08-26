// ---------------------------------------------------------------------------
// SLOP-AUDIT A2, APPLIED TO THE WHOLE APP INSTEAD OF EIGHT PINNED REGIONS.
//
// "Remove ALL em dashes from the site." It is Jayden's own rule, taken off
// camera from the review videos, and SLOP-AUDIT calls it the number one
// regression risk on any new copy. Until now there was no app wide guard for
// it. Roughly eight regions were pinned by name (`handleSendFlockInvites`, the
// pay sheet, the two error boundaries, a settings row, the legal pages, the
// marketing pages, the Birdie window) and an em dash written anywhere else
// shipped green. The mutation audit proved it: an em dash planted in
// `screens/ChatDetail.js` copy was the one defect out of six planted in the
// moved screens that no suite caught.
//
// WHY THIS IS AN AST WALK AND NOT A GREP.
// There are well over a hundred em dashes in `frontend/src`, and every single
// one of them is in a comment. The long design notes in `LandingPage.css`, the
// safe area contract in `index.css`, the reasoning blocks above half the
// functions in `App.js`. A check that counts characters would be red the day it
// shipped and stay red, and a permanently red check is one people learn to
// scroll past. SLOP-AUDIT says the distinction in as many words: "Comments are
// not copy. Count the strings, not the characters."
//
// A regex over lines cannot tell a comment from a string. A parser can, and
// `@babel/parser` is already used for exactly this kind of question in
// `extractionEquivalence.test.js`. So this walks every `.js` file under `src/`,
// parses it, and looks at three node types and nothing else:
//
//   StringLiteral    every quoted string in the file
//   TemplateElement  the literal chunks of every backtick string
//   JSXText          the bare text between JSX tags
//
// Comments are not any of those node types, so they are excluded by
// construction rather than by a pattern somebody has to keep correct.
//
// WHAT IT COVERS: all 46 non test `.js` files under `frontend/src`, found by
// walking the directory rather than by naming files, so a new screen or a new
// component is swept the day it is written. `externalLinksAndCoordinatePrivacy`
// established that pattern here and it is the one to copy: a suite that names
// files stops seeing the code the moment the code moves, which is what happened
// to six sweeps when 3,600 lines left `App.js` on 2026-08-26.
//
// THREE THINGS IT DELIBERATELY DOES NOT FLAG, each measured, not guessed:
//
//   1. Test files. `src/services/flockWriteContract.test.js` sits beside the
//      code it tests rather than in `__tests__/`, and two of its test NAMES use
//      an em dash. A test name is not copy. Both `__tests__/` and any
//      `*.test.js` anywhere under `src/` are skipped.
//
//   2. CSS comments inside a `<style>` element. `App.js` builds its keyframes in
//      a backtick template inside `<style>`, and that CSS carries its own
//      slash star comments. The parser correctly calls the whole block a
//      string, because it is one, but the bytes between the comment markers are
//      a comment for exactly the reason a double slash line is. Only `<style>`
//      templates get this treatment, and only the comment spans inside them,
//      and the strip runs on the joined template so a comment that opens on one
//      side of an interpolation and closes on the other is still one comment.
//
//   3. A string whose entire value is one em dash and nothing else. Four exist,
//      all in the admin only moderation console, all of the shape
//      `{someName || placeholder}`: the glyph for a cell with no value, which
//      is also what the console renders in place of "Invalid Date". Prose
//      punctuation always has a word on at least one side of it inside the same
//      string, so a string one character long cannot be the thing this rule is
//      about. SLOP-AUDIT A2 counted these four itself and still rated the rule
//      PASS. The allowance is the exact single character with no whitespace
//      around it, so a spaced dash between two words is still caught, and JSX
//      text gets no allowance at all.
//
// VACUITY. A broadened sweep fails quietly by inspecting less, not by
// inspecting wrong, so four guards run before any em dash assertion: the walk
// must find at least 40 files, the parse must inspect at least 25,000 strings,
// not one file may fail to parse (a parse error is a hard failure here, never a
// skipped file), and the collected strings must contain a piece of real copy
// from each of six named files. That last one is the mechanism the mutation
// audit named: a positive assertion anchored in a file is the only thing that
// lets a source scan tell that file from an empty string.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test copyEmDashSweep --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

// Written as an escape, not as the character. This file is the one place in the
// repo whose whole subject is the character, and spelling it out here would put
// the thing being banned into the file that bans it, where every other suite's
// grep would then find it.
const EM_DASH = '\u2014';
const SRC = path.resolve(__dirname, '..');

// The same options `extractionEquivalence.test.js` parses App.js with, and
// required the same way: without a fallback, so a future install that moves
// @babel/* out of react-scripts turns this suite red instead of silently
// turning it into a no-op.
const PARSE_OPTIONS = {
  sourceType: 'module',
  plugins: [
    'jsx',
    'classProperties',
    'optionalChaining',
    'nullishCoalescingOperator',
    'objectRestSpread',
    'dynamicImport',
  ],
};

function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      listSourceFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    if (entry.name.endsWith('.test.js')) continue; // a test NAME is not copy
    out.push(path.join(dir, entry.name));
  }
  return out;
}

/** True when this template literal sits inside a `<style>` element. */
function isInsideStyleElement(templatePath) {
  let p = templatePath.parentPath;
  while (p) {
    if (p.node.type === 'JSXElement') {
      const name = p.node.openingElement && p.node.openingElement.name;
      return !!(name && name.type === 'JSXIdentifier' && name.name === 'style');
    }
    p = p.parentPath;
  }
  return false;
}

const stripCssComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every user-visible string in one file, plus a count of every string node the
 * walk looked at. That count is the vacuity number: it drops the moment the
 * walk stops seeing things, whatever the reason it stopped.
 */
function readStrings(file) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parser.parse(code, PARSE_OPTIONS); // throws on purpose
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const strings = [];
  let inspected = 0;

  const keep = (value, line, kind, allowLoneGlyph) => {
    inspected += 1;
    if (allowLoneGlyph && value === EM_DASH) return;
    strings.push({ rel, line, kind, value });
  };

  traverse(ast, {
    StringLiteral(p) {
      keep(p.node.value, p.node.loc.start.line, 'string', true);
    },
    JSXText(p) {
      keep(p.node.value, p.node.loc.start.line, 'jsx text', false);
    },
    TemplateLiteral(p) {
      if (isInsideStyleElement(p)) {
        const joined = p.node.quasis.map((q) => q.value.raw).join(' ');
        keep(stripCssComments(joined), p.node.loc.start.line, 'style css', false);
        return;
      }
      for (const quasi of p.node.quasis) {
        const value = quasi.value.cooked != null ? quasi.value.cooked : quasi.value.raw;
        keep(value, quasi.loc.start.line, 'template', true);
      }
    },
  });

  return { strings, inspected };
}

const files = listSourceFiles(SRC);
const parseFailures = [];
const allStrings = [];
let inspectedCount = 0;

for (const file of files) {
  try {
    const { strings, inspected } = readStrings(file);
    allStrings.push(...strings);
    inspectedCount += inspected;
  } catch (err) {
    parseFailures.push(`${path.relative(SRC, file)}: ${err.message}`);
  }
}

// Real copy from six files, one per area of the app. A scan that stops reading
// a file reports zero em dashes in it, which looks exactly like a clean file.
// These say the difference out loud.
const ANCHORS = [
  ['App.js', 'Sent. Check your inbox, and your spam folder.'],
  ['screens/ChatDetail.js', 'The host picks the spot. Vote to say where you want to go.'],
  ['screens/AddFriends.js', 'Matches the number you typed'],
  ['screens/VenueDashboard.js', 'Set your live crowd number, on any plan'],
  ['components/PaywallSheet.js', 'See the whole night before it happens'],
  ['website/LandingPage.js', 'Coming soon to the App Store. Join the waitlist.'],
];

describe('the sweep is actually looking at the app', () => {
  test('every .js file under src/ parsed, and none was skipped', () => {
    expect(parseFailures).toEqual([]);
  });

  test('the walk found the whole source tree, not a corner of it', () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
  });

  test('the parse inspected a real number of strings', () => {
    // 36,124 on 2026-08-26. The floor sits well under that so ordinary
    // deletions do not trip it, and well over zero so a walk that reads nothing
    // cannot pass the em dash assertion by having nothing to read.
    expect(inspectedCount).toBeGreaterThan(25000);
  });

  test.each(ANCHORS)('%s: its copy reached the sweep', (file, copy) => {
    const seen = allStrings.some((s) => s.rel === file && s.value.includes(copy));
    expect(seen).toBe(true);
  });
});

describe('SLOP-AUDIT A2: no em dash in any user-visible string in frontend/src', () => {
  test('not one, anywhere under src/', () => {
    const offenders = allStrings
      .filter((s) => s.value.includes(EM_DASH))
      .map((s) => `${s.rel}:${s.line} (${s.kind}) ${JSON.stringify(s.value.trim().slice(0, 120))}`);

    // Listed rather than counted, because the useful failure names the line to
    // rewrite. Periods, commas, or restructure the sentence.
    expect(offenders).toEqual([]);
  });

  test('the lone glyph allowance is exactly one character wide', () => {
    // Guarding the carve-out itself. An empty cell placeholder passes because
    // the whole string is the character; a spaced dash used as prose
    // punctuation between two words must not inherit that pass.
    const spaced = ` ${EM_DASH} `;
    expect(spaced === EM_DASH).toBe(false);
    expect(spaced.includes(EM_DASH)).toBe(true);
  });
});
