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
// `extractionEquivalence.test.js`. So this walks every shipped `.js` file in
// the frontend, parses it, and looks at three node types and nothing else:
//
//   StringLiteral    every quoted string in the file
//   TemplateElement  the literal chunks of every backtick string
//   JSXText          the bare text between JSX tags
//
// Comments are not any of those node types, so they are excluded by
// construction rather than by a pattern somebody has to keep correct.
//
// WHAT IT COVERS: every non test `.js` file under `frontend/src`, `frontend/api`
// and `frontend/public`, found by walking the directories rather than by naming
// files, so a new screen or a new component is swept the day it is written.
// `externalLinksAndCoordinatePrivacy` established that pattern here and it is
// the one to copy: a suite that names files stops seeing the code the moment
// the code moves, which is what happened to six sweeps when 3,600 lines left
// `App.js` on 2026-08-26.
//
// WHY `api/` AND `public/` AND NOT JUST `src/`. The rule is about copy a person
// reads, and `src/` is where MOST of it lives, not where all of it lives.
// `api/invite-preview.js` writes the card every share link draws in a group
// chat, which is the one Flock surface read by people who have never heard of
// the product; `api/marketing-page.js` is the whole site as the answer engines
// receive it; `public/firebase-messaging-sw.js` writes the push notification
// title on the web. A sweep rooted at `src/` reports zero em dashes in all
// three, which reads exactly like three clean files. Measured 2026-08-26: an em
// dash planted in the completed plan line of `describe()` in
// `api/invite-preview.js` passed all 1,725 assertions, because the one em dash
// test that file had renders `renderPage` with a hand written title and
// description and never reaches `describe()` at all.
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
//   3. A QUOTED STRING whose entire value is one em dash and nothing else. Four
//      exist, all in the admin only moderation console, all of the shape
//      `{someName || placeholder}`: the glyph for a cell with no value, which
//      is also what the console renders in place of "Invalid Date". Prose
//      punctuation always has a word on at least one side of it INSIDE THE SAME
//      STRING, so a whole string one character long cannot be the thing this
//      rule is about. SLOP-AUDIT A2 counted these four itself and still rated
//      the rule PASS.
//
//      That argument is about a whole string, and it is the whole string that
//      gets the allowance. It used to be handed to template chunks as well, and
//      a template chunk is not a whole string: the text either side of it is
//      the neighbouring interpolation. So `Invited 3` + glyph + `9:00 PM`
//      renders an em dash with a word on both sides out of a chunk whose entire
//      value is the glyph, and until 2026-08-26 that shipped green. Measured:
//      `${money(f.usd, 0)}` + glyph + `${f.period}` planted in App.js passed all
//      1,725 assertions. Chunks and JSX text get no allowance at all now, and
//      there is not one chunk in the tree that wants one.
//
// VACUITY. A broadened sweep fails quietly by inspecting less, not by
// inspecting wrong, so these guards run before any em dash assertion: the walk
// must find at least 40 files under `src/` AND reach `api/` and `public/`
// separately, because a total that only counts `src/` is met by a walk that
// quietly stopped covering the other two; the parse must inspect at least
// 25,000 strings; not one file may fail to parse (a parse error is a hard
// failure here, never a skipped file); and the collected strings must contain a
// piece of real copy from each of nine named files, one per root. That last one
// is the mechanism the mutation audit named: a positive assertion anchored in a
// file is the only thing that lets a source scan tell that file from an empty
// string.
//
// And the carve-outs are guarded by the sweep itself rather than by a sentence
// about them. `the carve-outs are exactly as wide as they claim` at the bottom
// runs the collector over a synthetic source and reads back what it flagged, so
// the allowance is measured the way the app is measured. The assertion it
// replaced compared two JavaScript strings, which is true whatever the
// collector does with them.
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
const FRONTEND = path.resolve(__dirname, '..', '..');
// The three roots that ship. `build/` is a sibling of these and is deliberately
// absent: it is generated from `src/`, so sweeping it would report every offence
// twice and every fix as still broken until somebody happened to rebuild.
const ROOTS = ['src', 'api', 'public'];

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

/** Path as this suite names it: `src/App.js`, `api/invite-preview.js`. */
const relative = (file) => path.relative(FRONTEND, file).split(path.sep).join('/');

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
function collect(code, rel) {
  const ast = parser.parse(code, PARSE_OPTIONS); // throws on purpose
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
        // NO lone glyph allowance here, and that is the whole point of the
        // carve-out being about a WHOLE string. A chunk is not a whole string:
        // what sits either side of it is the neighbouring interpolation, so
        // `${a}` glyph `${b}` puts a dash between two words out of a chunk
        // whose entire value is the glyph.
        keep(value, quasi.loc.start.line, 'template', false);
      }
    },
  });

  return { strings, inspected };
}

const readStrings = (file) => collect(fs.readFileSync(file, 'utf8'), relative(file));

const files = [];
const filesPerRoot = {};
for (const root of ROOTS) {
  const found = listSourceFiles(path.join(FRONTEND, root));
  filesPerRoot[root] = found.length;
  files.push(...found);
}

const parseFailures = [];
const allStrings = [];
let inspectedCount = 0;

for (const file of files) {
  try {
    const { strings, inspected } = readStrings(file);
    allStrings.push(...strings);
    inspectedCount += inspected;
  } catch (err) {
    parseFailures.push(`${relative(file)}: ${err.message}`);
  }
}

// Real copy from six files, one per area of the app. A scan that stops reading
// a file reports zero em dashes in it, which looks exactly like a clean file.
// These say the difference out loud.
const ANCHORS = [
  ['src/App.js', 'Sent. Check your inbox, and your spam folder.'],
  ['src/screens/ChatDetail.js', 'The host picks the spot. Vote to say where you want to go.'],
  ['src/screens/AddFriends.js', 'Matches the number you typed'],
  ['src/screens/VenueDashboard.js', 'Set your live crowd number, on any plan'],
  ['src/components/PaywallSheet.js', 'See the whole night before it happens'],
  ['src/website/LandingPage.js', 'Coming soon to the App Store. Join the waitlist.'],
  // One per root outside src/, for the same reason: these three files are the
  // ones the sweep was widened to reach, and a walk that stopped reaching them
  // reports them clean.
  ['api/invite-preview.js', 'Flock is a free app for sorting out where a group is going.'],
  ['api/marketing-page.js', 'Vote on where to go, see how busy it is before you leave, split the bill, and go.'],
  ['public/firebase-messaging-sw.js', 'Flock'],
];

describe('the sweep is actually looking at the app', () => {
  test('every .js file in the three roots parsed, and none was skipped', () => {
    expect(parseFailures).toEqual([]);
  });

  test('the walk found the whole source tree, not a corner of it', () => {
    expect(files.length).toBeGreaterThanOrEqual(44);
  });

  test('each root was reached on its own, not covered by the total', () => {
    // A single total is met by `src/` alone, so a walk that silently stopped
    // descending into the other two roots reads as a healthy number and every
    // file in them reads as clean. 46 / 3 / 1 on 2026-08-26.
    expect(filesPerRoot.src).toBeGreaterThanOrEqual(40);
    expect(filesPerRoot.api).toBeGreaterThanOrEqual(3);
    expect(filesPerRoot.public).toBeGreaterThanOrEqual(1);
  });

  test('the parse inspected a real number of strings', () => {
    // 37,551 on 2026-08-26. The floor sits well under that so ordinary
    // deletions do not trip it, and well over zero so a walk that reads nothing
    // cannot pass the em dash assertion by having nothing to read.
    expect(inspectedCount).toBeGreaterThan(25000);
  });

  test.each(ANCHORS)('%s: its copy reached the sweep', (file, copy) => {
    const seen = allStrings.some((s) => s.rel === file && s.value.includes(copy));
    expect(seen).toBe(true);
  });
});

describe('SLOP-AUDIT A2: no em dash in any user-visible string the frontend ships', () => {
  test('not one, in src/ or api/ or public/', () => {
    const offenders = allStrings
      .filter((s) => s.value.includes(EM_DASH))
      .map((s) => `${s.rel}:${s.line} (${s.kind}) ${JSON.stringify(s.value.trim().slice(0, 120))}`);

    // Listed rather than counted, because the useful failure names the line to
    // rewrite. Periods, commas, or restructure the sentence.
    expect(offenders).toEqual([]);
  });

  test('the carve-outs are exactly as wide as they claim', () => {
    // The carve-outs are the only place a real em dash can hide, so they are
    // measured with the collector rather than described. What stood here before
    // compared two JavaScript strings and asserted that a spaced dash is not the
    // bare glyph, which is true of JavaScript whatever this file does with it.
    //
    // Written with escapes so the source of the sweep never contains the
    // character it bans.
    const G = EM_DASH;
    // The interpolation in the chunk case is assembled rather than typed out.
    // A synthetic source that contains one has to hold the two characters that
    // OPEN it, and a plain string holding those two characters is exactly what
    // `no-template-curly-in-string` exists to catch. Here it is the subject.
    const hole = (name) => `$${'{'}${name}}`;
    const source = [
      `// a source comment with a ${G} in it`,
      `const placeholder = '${G}';`,
      `const spaced = 'two words ${G} apart';`,
      'const chunk = `' + hole('a') + G + hole('b') + '`;',
      `const styled = <style>{\`.x{color:red} /* note ${G} note */\`}</style>;`,
      `const jsx = <p>{x} ${G} {y}</p>;`,
    ].join('\n');

    const flagged = collect(source, 'synthetic.js').strings
      .filter((str) => str.value.includes(EM_DASH))
      .map((str) => str.kind)
      .sort();

    // The comment and the whole-glyph placeholder are allowed. The CSS comment
    // inside the style template is stripped before it is read. Everything that
    // renders a dash between two words is caught, INCLUDING the template chunk
    // whose entire value is the glyph, which is the one this used to miss.
    expect(flagged).toEqual(['jsx text', 'string', 'template']);
  });

  test('the style carve-out strips comments and keeps the CSS', () => {
    // The half the test above cannot see. It reads what was FLAGGED, and a
    // strip that returned the empty string for every style template flags
    // nothing and passes: measured 2026-08-26 by replacing stripCssComments
    // with `() => ''` and watching all 15 stay green. So the CSS itself has to
    // be asserted present, not just the comment asserted absent.
    const G = EM_DASH;
    const kinds = (src) => collect(src, 'synthetic.js').strings
      .filter((str) => str.value.includes(EM_DASH))
      .map((str) => str.kind);

    // A dash in a CSS comment: allowed, for the same reason a `//` line is.
    expect(kinds('const a = <style>{`/* note ' + G + ' note */ .x{color:red}`}</style>;')).toEqual([]);
    // A dash in the CSS itself: caught. `content` renders, and a strip wide
    // enough to swallow this is a carve-out that has stopped carving.
    expect(kinds('const b = <style>{`.x::after{content:"a ' + G + ' b"}`}</style>;')).toEqual(['style css']);
    // Two comments with a rule between them. This is the case that separates
    // the non-greedy strip from a greedy one: greedy runs from the FIRST `/*`
    // in the block to the LAST `*/` in it and takes every rule in between,
    // which on App.js's real keyframes block would hide most of the CSS.
    expect(kinds('const c = <style>{`/* one */ .x::after{content:"a ' + G + ' b"} /* two */`}</style>;')).toEqual(['style css']);
    // A comment that opens and never closes is not a comment span, so nothing
    // after it is stripped. That is the safe direction: a stray `/*` makes the
    // sweep read more, never less.
    expect(kinds('const d = <style>{`/* opened .x::after{content:"a ' + G + ' b"}`}</style>;')).toEqual(['style css']);
    // And the style template still reaches the collector at all.
    const seen = collect('const e = <style>{`.y{margin:0}`}</style>;', 'synthetic.js').strings;
    expect(seen.some((str) => str.kind === 'style css' && str.value.includes('margin:0'))).toBe(true);
  });
});
