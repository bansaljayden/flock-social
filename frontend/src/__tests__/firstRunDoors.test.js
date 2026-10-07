// A fresh install, traced end to end on 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const signup = read('components/auth/SignupScreen.js');
const login = read('components/auth/LoginScreen.js');
// The Plans tab left App.js on 2026-09-13 for screens/CalendarScreen.js,
// lazily fetched, and the empty-day state below went with it. A slice of
// App.js for a marker that is no longer in App.js is an empty window, and
// every assertion against an empty window is one that cannot fail, so the
// empty-calendar test reads the file that holds the state now.
const calendarScreen = read('screens/CalendarScreen.js');
// The Discover tab left App.js on 2026-09-13 for screens/ExploreScreen.js,
// lazily fetched, and the Live Events drawer with its location gate went
// with it. Same reason as the line above: a slice of App.js for a marker
// App.js no longer holds is an empty window, and nothing asserted against
// an empty window can fail.
const exploreScreen = read('screens/ExploreScreen.js');

test('confirming the email in Safari has a way back into the app', () => {
  expect(signup).toMatch(/const me = await getCurrentUser\(\);/);
  expect(signup).toMatch(/if \(user\?\.email_verified\) \{\s*onSignupSuccess\(user\);/);
  expect(signup).toMatch(/I opened the link, continue/);
  expect(signup).toMatch(/Not confirmed yet\. Open the link in the email, then come back and tap this again\./);
});

test('a fresh install opens on sign-in, and both doors stay reachable', () => {
  // This used to open on ACCOUNT CREATION for a native install with no stored
  // token, which is right for the common case and wrong for the one that
  // decides submissions. Anyone arriving WITH credentials lands here, and the
  // signup form's only route to the sign-in form is the line at its very
  // bottom, under the create button, the terms, the divider and both OAuth
  // buttons. On a short viewport that line is never on screen, so the
  // credentials cannot be used and the account reads as broken.
  expect(app).toMatch(/const \[authScreen, setAuthScreen\] = useState\(\(\) => \{/);
  expect(app).toMatch(/return 'login';\s*\}\);/);
  // The deep link from the marketing site's Create account CTA still has to
  // pick signup, or that button goes to the wrong screen.
  expect(app).toMatch(/if \(window\.location\.pathname === '\/signup'\) return 'signup';/);
  // And the way BACK to account creation has to stay on the sign-in screen,
  // because that is now the only door a new arrival is shown.
  expect(login).toMatch(/New here\?/);
  expect(login).toMatch(/onClick=\{onSwitchToSignup\}/);
});

// THE DOOR A DEAD STORED SESSION USED TO SHUT. The invite page's Join and the
// site's Create account send somebody with no account to /signup. When that
// browser held a token an earlier visit had left to expire, the boot's 401 ran
// endSession, which sent every ending to the sign-in form, so the person was
// shown the wrong form under their thumb. endSession is lifted out of App.js
// and RUN with its collaborators stubbed, so this follows the code and not its
// spelling.
describe('which auth screen a session ending leaves', () => {
  const src = app.replace(/\r\n/g, '\n');
  const start = src.indexOf('const endSession = useCallback(');
  const fnStart = src.indexOf('(note, opts) => {', start);
  const fnEnd = src.indexOf('\n  }, []);', fnStart);
  const fnText = src.slice(fnStart, fnEnd + '\n  }'.length);

  const run = (ranHere) => {
    const screens = [];
    const ref = (current) => ({ current });
    // eslint-disable-next-line no-new-func
    const make = new Function(
      'sessionEndedRef', 'sessionEndedByRevokeRef', 'sessionLiveRef',
      'unregisterPushToken', 'forgetDeliveredNotifications', 'disconnectSocket', 'logout',
      'setAuthUser', 'setAuthScreen', 'setVenueLoginFlag', 'setSessionNote',
      `return ${fnText};`,
    );
    const endSession = make(
      ref(false), ref(false), ref(ranHere),
      () => Promise.resolve(), () => {}, () => {}, () => Promise.resolve(),
      () => {}, (s) => screens.push(s), () => {}, () => {},
    );
    endSession('Your session expired. Sign in again to pick up where you left off.');
    return screens;
  };

  test('the extraction found the function it is meant to run', () => {
    expect(start).toBeGreaterThan(-1);
    expect(fnStart).toBeGreaterThan(start);
    expect(fnText).toContain('setAuthScreen(');
  });

  test('after a session that ran on this page, back to sign-in', () => {
    expect(run(true)).toEqual(['login']);
  });

  test('at a boot that finds the stored session already dead, the screen the page opened on stays', () => {
    expect(run(false)).toEqual([]);
  });
});

test('every ask for location on a first run carries the control', () => {
  // The window is wide enough for the three-sentence gate (the ask, the
  // wait, the failure) that sits between the heading and the control.
  const events = exploreScreen.slice(exploreScreen.indexOf('Events need your location'), exploreScreen.indexOf('Events need your location') + 2400);
  expect(events).toMatch(/if \(!locationEnabled\) toggleLocation\(true\); else requestUserLocation\(true\);/);
  expect(events).toMatch(/Turn on location/);
  expect(exploreScreen).toMatch(/Finding where you are\. Venues near you show up once that lands\./);
});

test('the events gate reads the list once a location lands, and says what it is doing', () => {
  // The tap used to ask the device and then stop: a fix that arrived set
  // userLocation and nothing read events, so the screen did not change. And
  // for the ten seconds a device can take to answer, nothing on the screen
  // said a request was running.
  expect(app).toMatch(/if \(!showEventsView \|\| !userLocation\) return;\s*if \(featuredEvents \|\| featuredEventsLoading \|\| featuredEventsError\) return;\s*fetchFeaturedEvents\(`\$\{userLocation\.lat\},\$\{userLocation\.lng\}`, eventsSearchQuery\);/);
  const events = exploreScreen.slice(exploreScreen.indexOf('Events need your location'), exploreScreen.indexOf('Events need your location') + 2400);
  expect(events).toMatch(/Finding where you are\. Events near you show up once that lands\./);
  expect(events).toMatch(/Could not get your location just now\. Try again\./);
  expect(events).toMatch(/Turn it on in Settings, then come back\./);
  expect(events).toMatch(/disabled=\{locationLoading\}/);
  // The toggle path reports its wait, or the gate above would have nothing
  // to show while a device thinks.
  const toggle = app.slice(app.indexOf('const toggleLocation = '), app.indexOf('const toggleLocation = ') + 3000);
  // The request is stamped first, so an answer that lands after Location was
  // switched off or after a sign-out is dropped.
  expect(toggle).toMatch(/setLocationLoading\(true\);\s*const ask = locationAskRef\.current;\s*getCurrentPosition\(/);
  // The answer, the error, and switching Location off (a stale answer no
  // longer clears it).
  expect((toggle.match(/setLocationLoading\(false\);/g) || []).length).toBe(3);
});

test('the empty calendar has a next action', () => {
  // Asserted before the slice: indexOf returning -1 would make the window an
  // empty string, and an empty window passes nothing rather than failing loudly.
  expect(calendarScreen).toContain('Nothing on this day');
  const plans = calendarScreen.slice(calendarScreen.indexOf('Nothing on this day'), calendarScreen.indexOf('Nothing on this day') + 900);
  expect(plans).toMatch(/setCurrentTab\('home'\); setCurrentScreen\('create'\);/);
  expect(plans).toMatch(/Start a flock/);
});

// Opening Birdie asks for location only on a device that has never answered.
// requestUserLocation reloads the map's default venues, so calling it on a
// device that already had a location replaced a Discover search with
// "popular nearby" every time Birdie opened (app audit 2026-10-03).
test('opening Birdie does not reload the map on a device that already has a location', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');
  const start = app.indexOf("if (aiChatMode !== 'panel' && aiChatMode !== 'fullscreen') return;");
  expect(start).toBeGreaterThan(-1);
  const effect = app.slice(start, app.indexOf('}, [aiChatMode]);', start));
  expect(effect).toMatch(/if \(userLocation \|\| localStorage\.getItem\('flock_user_lat'\) !== null\) return;\s*requestUserLocation\(\);/);
});
