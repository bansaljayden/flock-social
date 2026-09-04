/**
 * WHERE A NOTIFICATION TAP LANDS — the client half.
 *
 * `backend/__tests__/pushDelivery.test.js` pins the LINK the server builds.
 * This file pins what the app does with it, on both paths a tap can arrive on:
 * the data payload (what a native tap carries, and the authoritative one) and
 * the URL (the web query form, and a universal link once associated domains
 * are on).
 *
 * The defect this file was written against, in order of how much it cost:
 *
 *   1. AN INVITE COULD NOT LAND ANYWHERE CORRECT, and the invite is the growth
 *      loop. `flock_invite` resolved to { screen: 'flock' }, which App.js turns
 *      into 'chatDetail', which resolves through getSelectedFlock against
 *      `flocks` — a list filtered to memberStatus === 'accepted'. An invited
 *      flock is by definition not in it. So the tap either opened AN UNRELATED
 *      PLAN (getSelectedFlock ended `|| flocks[0]`) or, for the normal case of
 *      a first invite, showed a panel saying the plan was deleted or that you
 *      are no longer in it, about a live invite you had not answered.
 *   2. FIVE TYPES LANDED ONE SCREEN AWAY. "You owe Ava $12", "Budget set",
 *      "Submit your budget", "Your reliability score updated" and "Tonight
 *      looks busy" all opened the flock CHAT.
 *   3. THREE LANDED NOWHERE. moderation_report resolved to '/' and to a null
 *      intent, so tapping it did nothing at all.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const { intentFromData, intentFromUrl } = require('../services/pushNavigation');

const REPO = path.resolve(__dirname, '..', '..', '..');
// Normalised to LF: these files are CRLF on disk, and a multi-line assertion
// written with \n would pass on one checkout convention and fail on the other.
const readSource = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = readSource('frontend', 'src', 'App.js');
const FIREBASE_SERVICE = readSource('backend', 'services', 'firebaseService.js');

// ───────────────────────────────────────────────────────────────────────────
// 1. The invite
// ───────────────────────────────────────────────────────────────────────────
describe('a tapped invite lands on the invite', () => {
  test('flock_invite is its own destination, never the chat', () => {
    expect(intentFromData({ type: 'flock_invite', flockId: '12', fromUserId: '3' }))
      .toEqual({ screen: 'flockInvite', flockId: 12, type: 'flock_invite' });
  });

  test('the link form the backend emits resolves to the same place', () => {
    expect(intentFromUrl('/?invite=12'))
      .toEqual({ screen: 'flockInvite', flockId: 12, type: 'link' });
  });

  test('an invite with no usable id is dropped rather than pointed somewhere', () => {
    for (const bad of [{}, { flockId: '0' }, { flockId: 'abc' }, { flockId: '-1' }]) {
      expect(intentFromData({ type: 'flock_invite', ...bad })).toBeNull();
    }
    expect(intentFromUrl('/?invite=0')).toBeNull();
  });

  test('App.js routes the invite intent to the plans list, not to a chat', () => {
    // The pending-invite card is on the plans list and already carries Accept,
    // Decline, the plan name and the host name, so it IS the decision. A
    // dedicated screen would be a second copy of two buttons, built for one
    // notification, with its own empty and error states to get wrong.
    expect(APP).toMatch(/intent\.screen === 'flockInvite'/);
    expect(APP).toMatch(/setPushInviteFlockId\(intent\.flockId\)/);
  });

  test('resolution waits for the lists, because a cold start has neither yet', () => {
    // A tap that LAUNCHES the app delivers its intent before GET /api/flocks
    // has answered, so the invite is in neither list at the moment it arrives.
    expect(APP).toMatch(/if \(!pushInviteFlockId \|\| flocksLoading\) return;/);
    // Three outcomes, and none of them is the "this plan isn't open anymore"
    // panel: still invited, already joined, or genuinely gone.
    expect(APP).toMatch(/pendingFlockInvites\.some\(f => f\.id === pushInviteFlockId\)/);
    expect(APP).toMatch(/flocks\.some\(f => f\.id === pushInviteFlockId\)/);
    expect(APP).toMatch(/That invite is no longer open\./);
  });

  test('the card the tap meant is called out on the list', () => {
    expect(APP).toMatch(/const tapped = highlightedInviteId === f\.id;/);
    expect(APP).toMatch(/setHighlightedInviteId/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The dangerous fallback
// ───────────────────────────────────────────────────────────────────────────
describe('a chat screen opened for a flock we do not have is honest about it', () => {
  test('getSelectedFlock no longer falls back to somebody else\'s plan', () => {
    const line = APP.split('\n').find((l) => l.includes('const getSelectedFlock ='));
    expect(line).toBeTruthy();
    // `|| flocks[0]` silently rendered a DIFFERENT plan: its venue, its roster,
    // its messages, with every control on the screen wired to it. Opening the
    // wrong plan is worse than an empty state, and it got worse the more plans
    // you had, which is exactly backwards.
    expect(line).not.toMatch(/\|\|\s*flocks\[0\]/);
    expect(line).toMatch(/flocks\.find\(f => f\.id === selectedFlockId\)/);
  });

  test('the empty state does not call a plan deleted while the list is still loading', () => {
    // With no fallback, a tap during a cold start reaches this panel for a
    // second or two while GET /api/flocks is in flight, and "it was deleted" is
    // a lie about a plan that is on its way.
    expect(APP).toMatch(/\{flocksLoading \? \(/);
    expect(APP).toMatch(/Opening your plan/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The five that landed one screen away
// ───────────────────────────────────────────────────────────────────────────
describe('a notification opens the surface it names', () => {
  const cases = [
    ['bill_created', 'bill'],
    ['bill_settled', 'bill'],
    ['budget_ready', 'budget'],
    ['budget_reminder', 'budget'],
    ['crowd_alert', 'plan'],
    ['flock_updated', 'plan'],
    ['flock_cancelled', 'plan'],
  ];

  test.each(cases)('%s carries the %s surface, not just the flock', (type, view) => {
    expect(intentFromData({ type, flockId: '12' }))
      .toEqual({ screen: 'flock', flockId: 12, view, type });
    expect(intentFromUrl(`/?flock=12&view=${view}`))
      .toEqual({ screen: 'flock', flockId: 12, view, type: 'link' });
  });

  test('the chat stays the default for everything that IS the conversation', () => {
    for (const type of ['flock_message', 'flock_rsvp', 'flock_confirmed', 'guest_rsvp']) {
      expect(intentFromData({ type, flockId: '12' }))
        .toEqual({ screen: 'flock', flockId: 12, type });
    }
    // And the bare link keeps the exact shape it always had, so a notification
    // sent before `view` existed still routes.
    expect(intentFromUrl('/?flock=12'))
      .toEqual({ screen: 'flock', flockId: 12, type: 'link' });
  });

  test('a view the client does not know is ignored rather than obeyed', () => {
    expect(intentFromUrl('/?flock=12&view=../admin'))
      .toEqual({ screen: 'flock', flockId: 12, type: 'link' });
  });

  test('the score lands on the score, which is on the profile', () => {
    expect(intentFromData({ type: 'attendance_marked', flockId: '12', fromUserId: '3' }))
      .toEqual({ screen: 'friends', tab: 'profile', type: 'attendance_marked' });
  });

  test('App.js opens the cash pool for money and the plan screen for the plan', () => {
    expect(APP).toMatch(/if \(intent\.view === 'plan'\) \{\s*\n\s*setCurrentScreen\('detail'\);/);
    expect(APP).toMatch(/if \(intent\.view === 'bill' \|\| intent\.view === 'budget'\) setShowChatPool\(true\);/);
  });

  test('the client map and the server map name the same surfaces', () => {
    // Two tables, one contract. The data payload is what a native tap carries,
    // so the client cannot simply trust a query string it may never see, which
    // is why the map exists twice — and why it has to be checked twice.
    const serverBlock = FIREBASE_SERVICE.slice(
      FIREBASE_SERVICE.indexOf('const FLOCK_VIEW = {'),
      FIREBASE_SERVICE.indexOf('function deepLinkPath')
    );
    for (const [type, view] of cases) {
      expect(serverBlock).toContain(`${type}: '${view}'`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The ones that used to land nowhere
// ───────────────────────────────────────────────────────────────────────────
describe('every type the app declares has somewhere to go', () => {
  test('a moderation alert reaches the moderation surface', () => {
    expect(intentFromData({ type: 'moderation_report', reportId: '3' }))
      .toEqual({ screen: 'admin', type: 'moderation_report' });
    expect(intentFromUrl('/?admin=true')).toEqual({ screen: 'admin', type: 'link' });
  });

  test('an SOS tap opens the alert modal from its own payload, with the location it carries', () => {
    // The one notification that may not land on the home screen: the member who
    // was offline when the socket fired is exactly who taps it, and the socket
    // emit is never replayed to them. The payload carries who and where, so the
    // tap resolves with no server round trip. Coordinates arrive as STRINGS on
    // the wire (FCM data values are strings, and the service worker stringifies
    // on relay), so this passes strings on purpose and expects finite numbers
    // back, dropped to null when absent so a missing location is never a pin at
    // 0,0.
    expect(intentFromData({
      type: 'safety_alert', fromUserId: '7', fromUserName: 'Ava',
      latitude: '40.05', longitude: '-75.12', at: '2026-08-27T04:00:00.000Z',
    })).toEqual({
      screen: 'safety', userId: 7, name: 'Ava',
      lat: 40.05, lng: -75.12, at: '2026-08-27T04:00:00.000Z', type: 'safety_alert',
    });
    // No shared location: the two coordinate keys are absent from the payload,
    // and the intent reports them as null rather than as some default place.
    expect(intentFromData({ type: 'safety_alert', fromUserId: '7', fromUserName: 'Ava', at: 'x' }))
      .toEqual({ screen: 'safety', userId: 7, name: 'Ava', lat: null, lng: null, at: 'x', type: 'safety_alert' });
    // No sender id is not a usable alert.
    expect(intentFromData({ type: 'safety_alert', fromUserName: 'Ava' })).toBeNull();
  });

  test('the stand-down push clears the alarm it follows', () => {
    // Until now the one type with no branch at all: the tap resolved to null,
    // landed on home, and the full-screen SOS from the earlier push stayed up.
    expect(intentFromData({ type: 'safety_alert_cancelled', fromUserId: '7', fromUserName: 'Ava' }))
      .toEqual({ screen: 'safety', cancelled: true, userId: 7, name: 'Ava', type: 'safety_alert_cancelled' });
    expect(intentFromData({ type: 'safety_alert_cancelled', fromUserName: 'Ava' })).toBeNull();
    // App.js consumes it by clearing the same modal by the same id
    const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    const branch = APP.slice(APP.indexOf("intent.screen === 'safety' && intent.cancelled"), APP.indexOf("} else if (intent.screen === 'safety') {"));
    expect(branch).toMatch(/setSafetyAlert\(\(prev\) => \(prev && prev\.userId === String\(intent\.userId\) \? null : prev\)\);/);
    expect(branch).toMatch(/says they are OK/);
    // Its live fields are a name and a location, so it deliberately gets NO
    // deep-link URL: a cold web tap lands on the app, never a coordinate in the
    // address bar. The backend records that decision explicitly.
    expect(FIREBASE_SERVICE).toMatch(/if \(type === 'safety_alert'\) return '\/';/);
  });

  test('the App.js safety branch feeds the same modal the live socket handler does', () => {
    expect(APP).toContain("intent.screen === 'safety'");
    // Both the tap branch and the onSafetyAlert socket handler build the modal
    // object, so both must set it through the same setter.
    expect((APP.match(/setSafetyAlert\(\{/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('the admin intent is role-checked, waits for the account, and opens the queue itself', () => {
    expect(APP).toMatch(/if \(!pushAdminIntent \|\| !authUser\) return;/);
    // The destination is the moderation console, not the analytics dashboard.
    // adminRevenue is where this tap used to land, and on iOS its only pointer
    // onward was a span that could be neither tapped nor copied, so a
    // child-safety alert's tap could not reach the queue on the one device
    // that receives it. The backend link agrees, so a web push with no open
    // client lands on the console directly.
    expect(APP).toMatch(/if \(authUser\.role === 'admin'\) window\.location\.assign\('\/admin\/moderation'\);/);
    expect(FIREBASE_SERVICE).toContain("if (type === 'moderation_report') return '/admin/moderation';");
  });

  test('both halves of a friend request answer to the same tab', () => {
    expect(intentFromData({ type: 'friend_accepted', fromUserId: '4' }))
      .toEqual({ screen: 'friends', tab: 'profile', type: 'friend_accepted' });
  });

  test('a free-tonight pulse opens the Nest, where the answer is', () => {
    expect(intentFromData({ type: 'availability_pulse', fromUserId: '4' }))
      .toEqual({ screen: 'home', type: 'availability_pulse' });
    expect(intentFromUrl('/?tab=home')).toEqual({ screen: 'home', type: 'link' });
  });

  test('a cancellation with no flock left opens the plans list', () => {
    // The row is deleted, so the payload carries no id: there is nothing for
    // the visibility gate to check and no screen to open.
    expect(intentFromData({ type: 'flock_cancelled' }))
      .toEqual({ screen: 'flocks', type: 'flock_cancelled' });
    expect(intentFromUrl('/?tab=chat')).toEqual({ screen: 'flocks', type: 'link' });
  });

  test('App.js has a branch for every screen the intent parser can produce', () => {
    for (const screen of ['flockInvite', 'flocks', 'home', 'admin', 'safety']) {
      expect(APP).toContain(`intent.screen === '${screen}'`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. The same list, in three files
//
// The set of flock-scoped push types is written out three times: the backend
// builds the link from it, pushNavigation.js parses a native tap with it, and
// the service worker falls back to it when a notification carries no `link`.
// They went one type out of step (`flock_cancelled` reached two of the three),
// and the only reason that was survivable is that `data.link` wins whenever it
// is present and the backend now always sets it. A type missing from the third
// copy is a tap that lands on the home screen instead of on the thing it names,
// and nothing failed when it happened.
// ───────────────────────────────────────────────────────────────────────────
describe('the flock-scoped type list does not drift between its three copies', () => {
  const PUSH_NAV = readSource('frontend', 'src', 'services', 'pushNavigation.js');
  const SW = readSource('frontend', 'public', 'firebase-messaging-sw.js');

  // Slice between the declaration and the first `]`, and then REFUSE a slice
  // that is not list-shaped. An anchor that moves hands back most of the file,
  // and every assertion below would pass on text from somewhere else.
  const typeList = (source, declaration) => {
    const start = source.indexOf(declaration);
    expect(start).toBeGreaterThan(-1);
    const open = source.indexOf('[', start);
    const close = source.indexOf(']', open);
    expect(open).toBeGreaterThan(start);
    expect(close).toBeGreaterThan(open);
    const slice = source.slice(open + 1, close);
    expect(slice.length).toBeGreaterThan(80);
    expect(slice.length).toBeLessThan(700);
    // A comment inside the literal is prose, not a type name.
    const names = (slice.replace(/\/\/[^\n]*/g, '').match(/'[a-z_]+'/g) || [])
      .map((s) => s.slice(1, -1));
    expect(names.length).toBeGreaterThan(8);
    return names.slice().sort();
  };

  const backend = typeList(FIREBASE_SERVICE, 'const FLOCK_SCOPED_TYPES = new Set(');

  test('pushNavigation.js carries exactly the backend list', () => {
    expect(typeList(PUSH_NAV, 'const FLOCK_TYPES = new Set(')).toEqual(backend);
  });

  test('the service worker fallback carries exactly the backend list', () => {
    expect(typeList(SW, 'var FLOCK_TYPES = [')).toEqual(backend);
  });
});
