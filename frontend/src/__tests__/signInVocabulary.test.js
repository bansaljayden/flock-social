// ---------------------------------------------------------------------------
// ONE VERB FOR A SESSION, AND ONE NAME FOR THE SAFETY LIST.
//
// The app says "Sign in" and "Sign out": the sign-in button, every session
// message App.js shows after one ends, "Sign out everywhere". Seven strings
// said "Log in" or "Log out" instead, and two of them sat where the mismatch
// is loudest: "Log out" directly under "Sign out everywhere" on the You tab,
// which reads as two different actions, and the website's "Log in" buttons,
// which land on a screen whose button says "Sign in". The server's 409 for an
// address that already has an account said "Log in the way you originally
// signed up", on the sign-in screen itself.
//
// The Safety screen had the same problem with a noun. Its info card was titled
// "Emergency Contacts" directly above the section titled "Trusted Contacts",
// and two toasts sent people to "Safety settings", a screen that does not
// exist under that name. The screen is Safety, under You.
//
// WHY AN AST WALK. Identifiers, routes and event names say login and logout
// all over the codebase (onLogout, /api/auth/logout) and none of them is copy.
// copyEmDashSweep.test.js walks the same three roots for the same reason and
// its reasoning holds here: only string literals, template chunks and JSX text
// are read, so comments and code are excluded by construction.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test signInVocabulary --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const FRONTEND = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(FRONTEND, '..');

const PARSE_OPTIONS = {
  sourceType: 'unambiguous',
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
    if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

const relative = (file) => path.relative(REPO, file).split(path.sep).join('/');

function copyIn(file) {
  const ast = parser.parse(fs.readFileSync(file, 'utf8'), PARSE_OPTIONS);
  const out = [];
  traverse(ast, {
    StringLiteral(p) { out.push({ line: p.node.loc.start.line, value: p.node.value }); },
    JSXText(p) { out.push({ line: p.node.loc.start.line, value: p.node.value }); },
    TemplateElement(p) {
      const v = p.node.value.cooked != null ? p.node.value.cooked : p.node.value.raw;
      out.push({ line: p.node.loc.start.line, value: v });
    },
  });
  return out;
}

// Everything the app, the website and the crawler copy can put in front of a
// person, plus the two backend routes whose error sentences the sign-in and
// Safety screens print as they arrive.
const FILES = [
  ...['src', 'api', 'public'].flatMap((root) => listSourceFiles(path.join(FRONTEND, root))),
  path.join(REPO, 'backend', 'routes', 'auth.js'),
  path.join(REPO, 'backend', 'routes', 'safety.js'),
];
const COPY = FILES.flatMap((file) => copyIn(file).map((s) => ({ ...s, file: relative(file) })));

// "Log in", "log out", "Logged out", "log-in". Never the bare words "login" or
// "logout", which are route and event names, not sentences, and not the
// gerund: the Privacy Policy lists "logging in" among the analytics events it
// describes, which is prose about an event and not the name of a control, and
// rewording policy text is its own change with its own effective date.
const LOG_VERB = /\blog(ged)?[ -](in|out)\b/i;

describe('the sweep is reading the app', () => {
  test('it found the source tree and the two backend routes', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(50);
    expect(FILES.map(relative)).toEqual(expect.arrayContaining([
      'frontend/src/App.js',
      'frontend/src/screens/ProfileSettings.js',
      'frontend/src/components/auth/LoginScreen.js',
      'frontend/src/website/LandingPage.js',
      'backend/routes/auth.js',
      'backend/routes/safety.js',
    ]));
  });

  test('it sees real copy, so a clean result is not an empty read', () => {
    const values = COPY.map((s) => s.value.trim());
    expect(values.includes('Sign out everywhere')).toBe(true);
    expect(values.some((v) => /Trusted Contacts/.test(v))).toBe(true);
    expect(COPY.length).toBeGreaterThan(20000);
  });
});

describe('sign in and sign out, everywhere', () => {
  test('no user-visible string says log in or log out', () => {
    const hits = COPY
      .filter((s) => LOG_VERB.test(s.value))
      .map((s) => `${s.file}:${s.line} ${JSON.stringify(s.value.trim().slice(0, 100))}`);
    expect(hits).toEqual([]);
  });

  test('the You tab pairs "Sign out everywhere" with "Sign out"', () => {
    const settings = copyIn(path.join(FRONTEND, 'src', 'screens', 'ProfileSettings.js')).map((s) => s.value.trim());
    expect(settings).toContain('Sign out everywhere');
    expect(settings).toContain('Sign out');
  });

  test('the website\'s way in and the app\'s button use the same words', () => {
    const landing = copyIn(path.join(FRONTEND, 'src', 'website', 'LandingPage.js')).map((s) => s.value.trim());
    const footer = copyIn(path.join(FRONTEND, 'src', 'website', 'SiteFooter.js')).map((s) => s.value.trim());
    const pro = copyIn(path.join(FRONTEND, 'src', 'website', 'ProPage.js')).map((s) => s.value.trim());
    const login = copyIn(path.join(FRONTEND, 'src', 'components', 'auth', 'LoginScreen.js')).map((s) => s.value.trim());
    expect(landing).toContain('Sign in');
    expect(footer).toContain('Sign in');
    expect(pro).toContain('Sign in to continue');
    expect(login).toContain('Sign in here');
  });
});

describe('the Safety screen has one name for its list', () => {
  test('no string sends anyone to "Safety settings" or calls the list "Emergency Contacts"', () => {
    const hits = COPY
      .filter((s) => /Safety settings|Emergency Contacts/.test(s.value))
      .map((s) => `${s.file}:${s.line} ${JSON.stringify(s.value.trim().slice(0, 100))}`);
    expect(hits).toEqual([]);
  });

  test('the info card says what it explains, above the Trusted Contacts section', () => {
    const settings = fs.readFileSync(path.join(FRONTEND, 'src', 'screens', 'ProfileSettings.js'), 'utf8');
    const card = settings.indexOf('>How SOS works</p>');
    const list = settings.indexOf('Trusted Contacts{trustedContactsLoaded');
    expect(card).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(card);
  });

  test('the two no-contacts toasts say where the list is', () => {
    const toasts = COPY.filter((s) => s.file === 'frontend/src/App.js'
      && s.value === "Add a trusted contact first. It's under You, then Safety.");
    expect(toasts).toHaveLength(2);
  });
});
