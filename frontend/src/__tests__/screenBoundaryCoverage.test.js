/**
 * SCREEN BOUNDARY COVERAGE — one screen crashing must not be the whole app
 * crashing.
 *
 * WHAT WAS WRONG. index.js wrapped the App root in components/ErrorBoundary.js
 * and nothing else did. The root boundary is a real net — it is why a crash is
 * a card with a Reload button rather than a literal white page — but it is the
 * WRONG net for a render crash inside one screen: it unmounts the entire tree,
 * which takes the socket, the session, the loaded flocks and the tab bar with
 * it, and the only recovery it can offer is a full reload. Inside the Capacitor
 * shell there is no URL bar and no pull-to-refresh, so from a reviewer's chair
 * that is a dead app, and from a user's chair it is a deleted one.
 *
 * WHY THE OBVIOUS FIX IS NOT A FIX. Every screen in App.js is a plain function
 * called as HomeScreen(), not mounted as <HomeScreen />. Its JSX is therefore
 * built DURING the parent's own render, so
 *
 *     <ErrorBoundary>{renderScreen()}</ErrorBoundary>
 *
 * catches nothing at all: renderScreen() has already run and already thrown
 * before that element exists, and the throw sails past to the root. The fix is
 * the ScreenSlot component — it takes the BUILDER and calls it one component
 * deeper, inside the boundary's subtree, which is the only place React can
 * catch it. `it cannot catch a builder called inline` below is the test that
 * fails the day someone "simplifies" that indirection away.
 *
 * WHY resetKey. The screen boundary is one element that never unmounts, so
 * without a reset the FIRST crash would pin its fallback over every screen the
 * switch can render afterwards. The boundary drops its error whenever the
 * identity of the screen under it changes, so navigating away and back gets a
 * fresh attempt instead of a permanent error state.
 *
 * Both halves are checked: the behaviour, with the real ErrorBoundary and the
 * real ScreenSlot driven by a miniature of App.js's screen switch, and the
 * wiring in App.js itself by source scan, because the switch lives in a
 * 19,000-line monolith that no test is going to mount.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from '../components/ErrorBoundary';
import { ScreenSlot } from '../App';

const fs = require('fs');
const path = require('path');

// Normalised to LF: App.js is CRLF on disk and a multi-line assertion written
// with \n would pass on one checkout convention and fail on the other.
const APP = fs
  .readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const BOUNDARY = fs
  .readFileSync(path.join(__dirname, '..', 'components', 'ErrorBoundary.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/** Comment lines dropped, so prose that QUOTES the broken shape (this file's
 *  fix is documented with the exact bad snippet in App.js) cannot pass or fail
 *  a test the code did not earn. Same helper, same reason, as
 *  appIconFloorAndAlerts.test.js. */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}

const APP_CODE = codeOnly(APP);

const count = (src, re) => (src.match(re) || []).length;

// ═══════════════════════════════════════════════════════════════════════════
// 1. BEHAVIOUR — the real ErrorBoundary + the real ScreenSlot
// ═══════════════════════════════════════════════════════════════════════════

const BOOM = 'screen exploded';

/** The five-tab bar, standing in for App.js's BottomNav. The point of every
 *  test below is that this keeps working. */
function Nav({ go }) {
  return (
    <nav aria-label="Main">
      <button type="button" onClick={() => go('home')}>Nest</button>
      <button type="button" onClick={() => go('plans')}>Plans</button>
    </nav>
  );
}

/** A screen that works. Like the real ones, it draws its own tab bar. */
const working = (name) => (go) => (
  <>
    <p>{name} screen</p>
    <Nav go={go} />
  </>
);

/** A screen that throws while it is being built — the common case, and the
 *  one the production crash in normalizeVotes was. */
const throwsInRender = () => { throw new Error(BOOM); };

/** A screen whose CHILD throws in an effect rather than in render. */
const throwsInEffect = (go) => {
  const Detonator = () => {
    React.useEffect(() => { throw new Error(BOOM); }, []);
    return <p>loading</p>;
  };
  return (
    <>
      <Detonator />
      <Nav go={go} />
    </>
  );
};

/** A screen that is fine until a modal opens over it, then throws inside the
 *  modal. A sheet is still part of the screen's subtree. */
const throwsInModal = (go) => {
  const Sheet = () => { throw new Error(BOOM); };
  return (
    <>
      <p>home screen</p>
      <Sheet />
      <Nav go={go} />
    </>
  );
};

/**
 * A miniature of App.js's screen switch, wired exactly the way App.js wires
 * it: one boundary that never unmounts, the screen identity as its resetKey,
 * a fallback that puts the tab bar back, and the builder handed to ScreenSlot
 * rather than called inline.
 */
function Shell({ screens, start = 'home', freezeResetKey = false }) {
  const [tab, setTab] = React.useState(start);
  const renderScreen = () => screens[tab](setTab);

  const fallback = ({ error, reset }) => (
    <>
      <div role="alert">This screen stopped working</div>
      <p>{error.message}</p>
      <button type="button" onClick={reset}>Try again</button>
      <Nav go={setTab} />
    </>
  );

  return (
    <ErrorBoundary
      label={`screen:main:${tab}`}
      resetKey={freezeResetKey ? 'frozen' : `main:${tab}`}
      fallback={fallback}
    >
      <ScreenSlot render={renderScreen} />
    </ErrorBoundary>
  );
}

describe('a crash in one screen is contained', () => {
  let errorSpy;
  beforeEach(() => {
    // React and the boundary both log a caught crash on purpose. Muted here so
    // a passing run does not read like a failing one.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  test('the crashed screen shows a recoverable state instead of nothing', () => {
    render(<Shell screens={{ home: throwsInRender, plans: working('plans') }} />);

    expect(screen.getByRole('alert')).toHaveTextContent('This screen stopped working');
    // Honest about what broke, not a fabricated cause.
    expect(screen.getByText(BOOM)).toBeInTheDocument();
  });

  test('the very first screen mounted can be the one that crashes', () => {
    // No successful render has happened at all: the boundary's only chance to
    // catch is the initial mount.
    render(<Shell start="home" screens={{ home: throwsInRender, plans: working('plans') }} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  test('navigation survives the crash', () => {
    render(<Shell screens={{ home: throwsInRender, plans: working('plans') }} />);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plans' })).toBeInTheDocument();
  });

  test('another screen still mounts and works', () => {
    render(<Shell screens={{ home: throwsInRender, plans: working('plans') }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));

    expect(screen.getByText('plans screen')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a screen that crashes later leaves the working ones reachable', () => {
    render(<Shell screens={{ home: working('home'), plans: throwsInRender }} />);
    expect(screen.getByText('home screen')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Nest' }));
    expect(screen.getByText('home screen')).toBeInTheDocument();
  });

  test('a crash in an effect, not in render, is contained the same way', () => {
    render(<Shell screens={{ home: throwsInEffect, plans: working('plans') }} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    expect(screen.getByText('plans screen')).toBeInTheDocument();
  });

  test('a crash in a modal over a screen is contained the same way', () => {
    render(<Shell screens={{ home: throwsInModal, plans: working('plans') }} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // The screen went with its sheet, which is correct: the sheet threw while
    // the screen was being built, so there is no half-drawn screen to keep.
    expect(screen.queryByText('home screen')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    expect(screen.getByText('plans screen')).toBeInTheDocument();
  });
});

describe('the error state clears on navigation', () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  test('away and back is a fresh attempt, not a stuck error screen', () => {
    // Broken until the test says otherwise. A render COUNTER would not work
    // here: React retries a failed render once, on its own, before it hands
    // the error to a boundary, so a screen that throws exactly once never
    // reaches the fallback at all.
    let broken = true;
    const fixable = (go) => {
      if (broken) throw new Error(BOOM);
      return working('home')(go);
    };

    render(<Shell screens={{ home: fixable, plans: working('plans') }} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    expect(screen.getByText('plans screen')).toBeInTheDocument();

    // Whatever was wrong is gone by the time they come back — a payload that
    // reloaded, a socket that reconnected. The boundary has to give the screen
    // another go, or "back to Nest" is a one-way door for the rest of the
    // session.
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Nest' }));
    expect(screen.getByText('home screen')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('without the reset key the first crash pins the fallback over every screen', () => {
    // The regression this pins: the boundary is ONE element that never
    // unmounts, so a boundary with a constant resetKey is a boundary that
    // breaks the app permanently the first time anything throws.
    render(
      <Shell
        freezeResetKey
        screens={{ home: throwsInRender, plans: working('plans') }}
      />
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    expect(screen.queryByText('plans screen')).not.toBeInTheDocument();
  });

  test('Try again re-renders the screen in place', () => {
    let broken = true;
    const fixable = (go) => {
      if (broken) throw new Error(BOOM);
      return working('home')(go);
    };

    render(<Shell screens={{ home: fixable, plans: working('plans') }} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    // Same screen, same place in the app: no navigation, no reload.
    expect(screen.getByText('home screen')).toBeInTheDocument();
  });

  test('Try again on a screen that is still broken stays contained', () => {
    render(<Shell screens={{ home: throwsInRender, plans: working('plans') }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    // Caught again rather than escaping, and the way out is still on screen.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plans' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    expect(screen.getByText('plans screen')).toBeInTheDocument();
  });
});

describe('ScreenSlot is what makes the boundary able to catch anything', () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  test('it cannot catch a builder called inline', () => {
    // The shape the fix replaced. The builder runs during the PARENT's render,
    // so the boundary element does not exist yet and the throw goes straight
    // past it. Delete ScreenSlot from App.js and this is what ships.
    function Inline() {
      const renderScreen = () => throwsInRender();
      return (
        <ErrorBoundary label="inline" fallback={() => <div role="alert">caught</div>}>
          {renderScreen()}
        </ErrorBoundary>
      );
    }
    expect(() => render(<Inline />)).toThrow(BOOM);
  });

  test('a screen that answers with nothing is not itself an error', () => {
    // dmDetailScreen is a && chain and the role-gated screens return null
    // while their redirect effect runs. Returning undefined from a component
    // is a React error in its own right, which would turn a no-op screen into
    // a crash the moment it went through a component.
    const { container } = render(
      <ErrorBoundary label="empty">
        <ScreenSlot render={() => undefined} />
      </ErrorBoundary>
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. WIRING — that App.js is actually built this way
// ═══════════════════════════════════════════════════════════════════════════

describe('App.js routes every screen through a boundary', () => {
  test('the boundary component is the shared one, not a second copy', () => {
    expect(APP_CODE).toMatch(/import ErrorBoundary from '\.\/components\/ErrorBoundary'/);
    // No hand-rolled second implementation.
    expect(APP_CODE).not.toMatch(/getDerivedStateFromError/);
  });

  test('ScreenSlot sits at module scope, above the component that uses it', () => {
    const slot = APP_CODE.indexOf('export const ScreenSlot = ({ render })');
    const inner = APP_CODE.indexOf('const FlockAppInner = ');
    expect(slot).toBeGreaterThan(-1);
    expect(inner).toBeGreaterThan(slot); // stable type: never remounts on a re-render
  });

  test('the screen switch has exactly one render site and it is inside a boundary', () => {
    // Definition plus one use. A second use is a screen rendered outside the
    // boundary, which is the bug this file exists to stop.
    expect(count(APP_CODE, /renderScreen/g)).toBe(2);
    expect(APP_CODE).toMatch(
      /<ErrorBoundary\s+label=\{`screen:\$\{screenLabel\}`\}\s+resetKey=\{screenKey\}\s+fallback=\{screenCrashFallback\}>\s*\n\s*<ScreenSlot render=\{renderScreen\} \/>/
    );
  });

  test('Discover gets its own boundary, because its map layer never unmounts', () => {
    expect(count(APP_CODE, /ExploreScreen/g)).toBe(2);
    expect(APP_CODE).toMatch(
      /<ErrorBoundary label="screen:explore" resetKey=\{screenKey\} fallback=\{exploreCrashFallback\}>\s*\n\s*<ScreenSlot render=\{ExploreScreen\} \/>/
    );
  });

  test('no screen builder is called straight into the tree any more', () => {
    expect(APP_CODE).not.toMatch(/\{renderScreen\(\)\}/);
    expect(APP_CODE).not.toMatch(/\{ExploreScreen\(\)\}/);
  });

  test('the DM thread is a builder, not a tree built on every render', () => {
    // As a value its whole JSX was constructed during the component's own
    // render, on every screen — i.e. outside the boundary, where a throw is
    // still fatal.
    expect(APP_CODE).toMatch(/const dmDetailScreen = \(\) =>/);
    expect(APP_CODE).toMatch(/if \(currentScreen === 'dmDetail'\) return dmDetailScreen\(\);/);
  });

  test('a screen added to the switch later is boundaried without anyone remembering', () => {
    // The whole top-level JSX of the app component. If a future edit renders a
    // screen HERE instead of from the switch, it is outside both boundaries,
    // and this is the test that says so.
    const start = APP.indexOf('  return (\n    <div style={fullBleed');
    const end = APP.indexOf('\nconst SESSION_END_COPY');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const topLevelJsx = codeOnly(APP.slice(start, end));

    expect(topLevelJsx.match(/\b[A-Za-z]\w*Screen\(\)/g)).toBeNull();
    expect(count(topLevelJsx, /<ScreenSlot render=\{/g)).toBe(2);
    expect(count(topLevelJsx, /<ErrorBoundary/g)).toBe(2);
  });

  test('the screen key changes on every move out of a crashed screen', () => {
    const at = APP_CODE.indexOf('const screenKey = ');
    expect(at).toBeGreaterThan(-1);
    const key = APP_CODE.slice(at, APP_CODE.indexOf(';', at));
    // Same currentScreen, different target: flock A detail to flock B detail,
    // and DM thread to DM thread, both have to reset.
    expect(key).toMatch(/selectedFlockId/);
    expect(key).toMatch(/selectedDmId/);

    const labelAt = APP_CODE.indexOf('const screenLabel = ');
    const label = APP_CODE.slice(labelAt, APP_CODE.indexOf(': currentScreen;', labelAt));
    // Tab switches inside 'main', and the two screens that sit in front of the
    // switch entirely.
    expect(label).toMatch(/main:\$\{currentTab\}/);
    expect(label).toMatch(/showModeSelection/);
    expect(label).toMatch(/showVenueOnboarding/);
  });

  test('the boundary label a crash is filed under is a closed set', () => {
    // A Sentry tag carrying a flock id is an unbounded tag. The label is the
    // coarse one; only the reset key carries the target.
    expect(APP_CODE).toMatch(/label=\{`screen:\$\{screenLabel\}`\}/);
    expect(APP_CODE).not.toMatch(/label=\{`screen:\$\{screenKey\}`\}/);
    const labelAt = APP_CODE.indexOf('const screenLabel = ');
    const label = APP_CODE.slice(labelAt, APP_CODE.indexOf(': currentScreen;', labelAt));
    expect(label).not.toMatch(/selectedFlockId|selectedDmId/);
  });
});

describe('the fallback is a way out, not a dead end', () => {
  const fallbackSrc = APP.slice(
    APP.indexOf('const screenCrashFallback = '),
    APP.indexOf('const exploreCrashFallback = ')
  );
  // Discover's fallback, which lives behind the persistent map layer.
  const exploreFallbackSrc = APP.slice(
    APP.indexOf('const exploreCrashFallback = '),
    APP.indexOf('  return (\n    <div style={fullBleed')
  );

  test('it puts the tab bar back', () => {
    // The tab bar is drawn by the screens themselves, so the crash took it
    // with the screen. Without this line the fallback is a room with no doors.
    expect(fallbackSrc).toMatch(/\{BottomNav\(\)\}/);
  });

  test('it offers a way out that does not need the tab bar', () => {
    // The two dashboard screens hide the tab bar by design, and the mode
    // chooser and venue onboarding sit in front of it.
    expect(fallbackSrc).toMatch(/Try again/);
    expect(fallbackSrc).toMatch(/Go to Nest/);
    expect(fallbackSrc).toMatch(/onClick=\{\(\) => \{ reset\(\); leaveCrashedScreen\(\); \}\}/);
    expect(APP_CODE).toMatch(/const leaveCrashedScreen = \(\) => \{/);
    // Both gate flags are dropped, or a crash in either is a trap: they
    // re-render the same broken screen.
    const exit = APP_CODE.slice(
      APP_CODE.indexOf('const leaveCrashedScreen = () => {'),
      APP_CODE.indexOf('const screenCrashFallback = ')
    );
    expect(exit).toMatch(/setShowModeSelection\(false\)/);
    expect(exit).toMatch(/setShowVenueOnboarding\(false\)/);
    expect(exit).toMatch(/setCurrentScreen\('main'\)/);
    expect(exit).toMatch(/setCurrentTab\('home'\)/);
  });

  test('it is announced', () => {
    expect(fallbackSrc).toMatch(/role="alert"/);
  });

  test('the copy says what happened, in words a person would use', () => {
    expect(fallbackSrc).toContain('This screen stopped working');
    expect(fallbackSrc).toContain(
      'Your account, your flocks and your messages are saved on the server. Anything you were typing on this screen is gone.'
    );
  });

  test('Discover says the same thing about its own layer', () => {
    expect(exploreFallbackSrc).toContain('The map stopped working');
    expect(exploreFallbackSrc).toMatch(/role="alert"/);
    expect(exploreFallbackSrc).toMatch(/Try again/);
  });

  test('Discover puts its own tab bar back too', () => {
    // The switch answers null for the Discover tab, so ExploreScreen is the
    // ONLY thing that draws the tab bar there. A fallback without this line
    // strands the user on Discover with no navigation at all — which is the
    // exact failure the whole change exists to prevent, reintroduced one layer
    // down.
    expect(exploreFallbackSrc).toMatch(/\{BottomNav\(\)\}/);
    // And it has to fill the layer as a column, or the tab bar floats.
    expect(exploreFallbackSrc).toMatch(/flexDirection: 'column', height: '100%'/);
  });

  test('the copy passes the SLOP-AUDIT rules', () => {
    // Both fallbacks, comments dropped: App.js prose uses em dashes freely and
    // always has. What a user reads may not.
    const copy = codeOnly(fallbackSrc) + codeOnly(exploreFallbackSrc);
    // Rule 1: no em dashes.
    expect(copy).not.toMatch(/—/);
    // Rule 4: no marketing voice, and no cartoon apology standing in for a
    // fact about what broke.
    expect(copy).not.toMatch(/seamless|effortless|unlock|oops|whoops|gremlin/i);
    // Rule 5: no promise the build cannot keep. Nothing here reports the crash
    // to a human, so nothing here may claim it does.
    expect(copy).not.toMatch(/we'?re on it|our team|we'?ve been notified|coming soon/i);
  });

  test('it survives a 320px screen', () => {
    // Nothing fixed-width: a capped max-width inside full-width padding, and
    // the two buttons wrap rather than overflow.
    expect(fallbackSrc).toMatch(/maxWidth: '340px'/);
    expect(fallbackSrc).toMatch(/flexWrap: 'wrap'/);
    expect(fallbackSrc).toMatch(/boxSizing: 'border-box'/);
    // The raw error message is the one string of unbounded length on screen.
    expect(fallbackSrc).toMatch(/wordBreak: 'break-word'/);
    // Centred with auto margins, never justifyContent: on a short phone in
    // landscape, justify-content clips the top of an overflowing child rather
    // than letting it scroll into view.
    expect(fallbackSrc).toMatch(/maxWidth: '340px', margin: 'auto'/);
    expect(fallbackSrc).not.toMatch(/justifyContent: 'center'/);
    expect(exploreFallbackSrc).not.toMatch(/justifyContent: 'center'/);
  });

  test('it draws in both themes off the shared tokens', () => {
    expect(fallbackSrc).toMatch(/var\(--bg-primary\)/);
    expect(fallbackSrc).toMatch(/var\(--text-primary\)/);
    expect(fallbackSrc).toMatch(/var\(--text-secondary\)/);
    // No literal light-theme colour hardcoded into it.
    expect(fallbackSrc).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  test('it uses the icon system rather than a new glyph', () => {
    expect(fallbackSrc).toMatch(/Icons\.alertCircle\(/);
    expect(fallbackSrc).not.toMatch(/<svg/);
  });
});

describe('ErrorBoundary gained a reset key and nothing else', () => {
  test('the reset clears the error when the screen under it changes', () => {
    expect(BOUNDARY).toMatch(/componentDidUpdate\(prevProps\) \{/);
    expect(BOUNDARY).toMatch(/Object\.is\(prevProps\.resetKey, this\.props\.resetKey\)/);
  });

  test('it cannot loop: a child that throws again is caught, not re-reset', () => {
    // The guard is that the clear is keyed on the PROP changing, never on the
    // error state alone.
    const body = BOUNDARY.slice(
      BOUNDARY.indexOf('componentDidUpdate(prevProps) {'),
      BOUNDARY.indexOf('reload() {')
    );
    expect(body).toMatch(/if \(!this\.state\.error\) return;/);
    expect(body).toMatch(/return;\n\s*this\.setState\(\{ error: null, eventId: null \}\)/);
  });

  test('a late Sentry id cannot be filed under the wrong crash', () => {
    // The SDK loads asynchronously. With resetKey in play the boundary can
    // have recovered, or crashed somewhere else, before captureException
    // resolves, so the id is only shown if it belongs to the error on screen.
    expect(BOUNDARY).toMatch(
      /if \(eventId && this\._mounted && this\.state\.error === error\) this\.setState\(\{ eventId \}\);/
    );
  });

  test('the root boundary in index.js is untouched and still the last net', () => {
    const INDEX = fs
      .readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(INDEX).toMatch(/<ErrorBoundary label="app-root">/);
  });
});
