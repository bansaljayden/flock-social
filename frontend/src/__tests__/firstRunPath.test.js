/**
 * THE FIRST FIVE MINUTES: what a brand new account meets, and what it is told.
 *
 * Three separate defects, one test file, because all three sit on the same
 * path: open the app, make an account, confirm the address, look at a screen
 * with nothing on it yet.
 *
 * 1. THE LOCATION PROMPT AT BOOT. The Discover map layer is deliberately never
 *    unmounted so a tab switch is instant, and it was also never mounted late:
 *    it rendered on the first commit of the signed-in shell behind
 *    `visibility: hidden`. A hidden component is a mounted component, so
 *    MapLibreMapView ran its init effect at boot and that effect calls
 *    getUserLocation() whenever no initialCenter is passed. The iOS location
 *    dialog therefore landed on the Nest tab, seconds after signup, with no map
 *    on screen. iOS allows one location prompt per install and a denial is
 *    permanent, so that spent the only ask the app will ever get at the moment
 *    it could explain itself least. It is the same defect
 *    pushPermissionMoment.test.js pins for notifications, and the same one the
 *    "Load venues on mount" effect was rewritten to avoid; both of those fixes
 *    covered their own call site and this was the other boot path into the same
 *    dialog.
 *
 * 2. THE CONFIRMATION LINK CAME BACK TO SILENCE. GET /api/auth/verify-email
 *    consumes the token and redirects to PUBLIC_WEB_URL/?email_verified=<outcome>.
 *    index.js lists email_verified in APP_INTENT_PARAMS so that URL boots the
 *    app, and then nothing read the parameter. All four outcomes rendered the
 *    same screen, so a link that had expired was indistinguishable from one that
 *    had worked, and the one instruction that helps, ask for another, never
 *    reached the only person who needed it.
 *
 * 3. A FAILED LIST READ CLAIMED THE ACCOUNT WAS EMPTY. The flocks fetch answered
 *    a failure with setFlocks([]), which is the same state as an account with no
 *    plans, so a dropped request printed "No flocks yet" on the primary screen
 *    and "No conversations yet" on Messages. The rule is already written down at
 *    pastFlocks, at Blocked accounts and on every venue dashboard list.
 *
 * These are SOURCE assertions on purpose, and comments are stripped before every
 * one of them, so a sentence describing the fix can never stand in for the fix.
 * The failure mode in each case is a future edit putting the old shape back, and
 * no behavioural test of the happy path would notice.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const REPO = path.join(SRC, '..', '..');

const APP = fs.readFileSync(path.join(SRC, 'App.js'), 'utf8');
const AUTH_ROUTES = fs.readFileSync(path.join(REPO, 'backend', 'routes', 'auth.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');

// Comments are prose, not behaviour. Every slice below runs through this first
// so an assertion can only ever be satisfied by code.
//
// Two rules only, and the one that is NOT here is the lesson. A rule for JSX
// comment nodes, /\{\s*\/\*[\s\S]*?\*\/\s*\}/, looks tighter and is far worse:
// it has to find `*/` followed by `}`, and App.js holds JSX comments that end
// `*/ }` with code between, so one of them paired with a closing brace 90,000
// characters later and deleted the region this file was written to assert on.
// The tests still passed, because everything they looked for had been deleted
// along with it. Stripping the comment BODY leaves a bare `{}` behind, which is
// inert in JSX and cannot satisfy any assertion below.
//
// Line comments are only dropped when they begin the line, which leaves
// "https://" inside a string alone.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// The source between two anchors, with the anchors included, so a slice cannot
// silently become empty and pass every `not.toMatch` in the file.
function region(source, startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + endAnchor.length);
}

describe('the location prompt waits for a map to be on screen', () => {
  it('the persistent map layer is mounted by a latch, not at boot', () => {
    const shell = codeOnly(region(
      APP,
      'const isExploreVisible =',
      '<ScreenSlot render={ExploreScreen} />'
    ));

    // The latch itself: set the first time Discover is visible, never cleared.
    expect(shell).toMatch(/const exploreEverVisibleRef = useRef\(false\)/);
    expect(shell).toMatch(/if \(isExploreVisible\) exploreEverVisibleRef\.current = true/);
    expect(shell).toMatch(/const exploreMounted = exploreEverVisibleRef\.current/);

    // And the render actually reads it. Without this line the latch exists and
    // the map still mounts at boot, which is exactly the state this file was
    // written about.
    expect(shell).toMatch(/\{exploreMounted && \(/);
  });

  it('the map still locates itself once it is mounted', () => {
    // The fix is about WHEN the component mounts. If the init effect ever stops
    // asking, opening Discover shows a map of the whole country and no fix has
    // been made, it has been moved.
    const init = codeOnly(region(
      APP,
      'const MapLibreMapView = React.memo(',
      'const rehydrateAfterStyleSwap'
    ));
    // Asserted as a property rather than as one spelling. The expression grew a
    // second skip on 2026-08-26 (the Settings "Location services" switch, which
    // used to report a state it did not enforce), and a test pinned to the exact
    // characters would have called that a regression when the behaviour it
    // guards was untouched.
    expect(init).toMatch(/await getUserLocation\(\)/);
    expect(init).toMatch(/initialCenter/);
    // The two legitimate reasons not to ask, and only those two: the caller
    // already knows where to open, or the person turned the switch off.
    expect(init).toMatch(/locationAllowed/);
  });

  it('the venue load on mount still refuses to ask on an unanswered device', () => {
    // The sibling gate. Both boot paths into the OS dialog have to stay shut;
    // closing one and reopening the other is the whole history here.
    const effect = codeOnly(region(
      APP,
      'if (venueLoadAttemptedRef.current) return;',
      '}, [requestUserLocation]);'
    ));
    expect(effect).toMatch(/localStorage\.getItem\('flock_location_enabled'\) === 'false'\) return/);
    expect(effect).toMatch(/if \(alreadyAnswered\) requestUserLocation\(\)/);
    // An unconditional call is the regression. The only requestUserLocation()
    // in this effect must be the guarded one.
    expect(effect.match(/requestUserLocation\(\)/g)).toHaveLength(1);
  });
});

describe('the confirmation link says what happened', () => {
  // Every outcome the backend can redirect with, read off the handler rather
  // than copied from it.
  const verifyHandler = codeOnly(region(
    AUTH_ROUTES,
    "router.get('/verify-email'",
    "router.post('/resend-verification'"
  ));
  const backendOutcomes = [...verifyHandler.matchAll(/land\('([^']+)'\)/g)].map((m) => m[1])
    .concat([...verifyHandler.matchAll(/\? '([^']+)' : '([^']+)'/g)].flatMap((m) => [m[1], m[2]]));

  const copyBlock = codeOnly(region(APP, 'const EMAIL_VERIFIED_COPY = {', '};'));
  const frontendOutcomes = [...copyBlock.matchAll(/^\s*([A-Za-z0-9_]+):\s*'/gm)].map((m) => m[1]);

  it('the backend really does redirect with a set of outcomes', () => {
    // Guards the two regexes above: if the handler is rewritten into a shape
    // they cannot read, this goes red instead of every assertion below passing
    // over an empty list.
    expect(backendOutcomes.length).toBeGreaterThanOrEqual(4);
    expect(backendOutcomes).toContain('1');
  });

  it('the app has a sentence for every outcome the backend can send', () => {
    for (const outcome of backendOutcomes) {
      expect(frontendOutcomes).toContain(outcome);
    }
  });

  it('every sentence is a sentence, and none of them contains an em dash', () => {
    const sentences = [...copyBlock.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(sentences).toHaveLength(frontendOutcomes.length);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(15);
      expect(sentence).not.toContain('—');
    }
  });

  it('the parameter is read once, at module scope, and taken off the URL', () => {
    const reader = codeOnly(region(APP, 'function readEmailVerifiedOutcome()', 'const EMAIL_VERIFIED_OUTCOME ='));
    expect(reader).toMatch(/params\.get\('email_verified'\)/);
    // Stripped, so a refresh cannot replay a message about a token that was
    // spent the first time.
    expect(reader).toMatch(/params\.delete\('email_verified'\)/);
    expect(reader).toMatch(/replaceState/);
    // An outcome this build does not know is still a failed confirmation.
    expect(reader).toMatch(/: 'error'/);
  });

  it('the notice is rendered whether or not this device holds a session', () => {
    const app = codeOnly(APP);
    expect(app).toMatch(/const noticeText = linkNote \|\| sessionNote/);
    // Two render sites: the signed-out auth screens already had one, and the
    // signed-in tree is the one that was silent. The link can be opened in a
    // browser that is already signed in.
    expect(app.match(/\{notice\}/g).length).toBeGreaterThanOrEqual(2);
    expect(app).toMatch(/\{notice\}\s*<FlockAppInner/);
  });

  it('index.js still boots the app for that URL rather than the marketing page', () => {
    // The whole redirect lands on "/", which is the marketing site on the web.
    // Without email_verified in this list the app never renders and no notice
    // can be shown by any of the code above.
    expect(codeOnly(INDEX)).toMatch(/APP_INTENT_PARAMS = \[[^\]]*'email_verified'/);
  });
});

describe('a failed list read is not an empty account', () => {
  it('the flock fetch records the failure instead of emptying the list', () => {
    const loader = codeOnly(region(APP, 'const loadFlocks = useCallback(', 'useEffect(() => { loadFlocks(); }'));
    expect(loader).toMatch(/setFlocksError\(/);
    // setFlocks([]) in the catch is the defect verbatim: it is indistinguishable
    // from an account with no plans in it.
    const catchBlock = loader.slice(loader.indexOf('.catch('));
    expect(catchBlock).not.toMatch(/setFlocks\(\[\]\)/);
  });

  it('the Nest empty state waits for an answer that was not a failure', () => {
    const nest = codeOnly(region(APP, "<ListSkeleton label=\"Loading your flocks\" />", 'No flocks yet</h3>'));
    expect(nest).toMatch(/!flocksLoading && flocksError &&/);
    expect(nest).toMatch(/!flocksLoading && !flocksError && flocks\.length === 0/);
    // The retry has to run the same read the screen ran.
    expect(nest).toMatch(/onClick=\{loadFlocks\}/);
  });

  it('the DM fetch records its failure too', () => {
    const loader = codeOnly(region(APP, 'const loadDmConversations = useCallback(', 'useEffect(() => { loadDmConversations(); }'));
    expect(loader).toMatch(/setDmsError\(/);
    // A bare `.catch(() => {})` is how this one hid for as long as it did.
    expect(loader).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  it('the Messages empty state is gated on both reads', () => {
    const list = codeOnly(region(APP, 'const conversationsError =', "'No conversations yet'"));
    expect(list).toMatch(/const conversationsError = flocksError \|\| dmsError/);
    expect(list).toMatch(/!conversationsLoading && conversationsError &&/);
    expect(list).toMatch(/!conversationsLoading && !conversationsError && filteredDms\.length === 0/);
    expect(list).toMatch(/onClick=\{retryConversations\}/);
  });
});
