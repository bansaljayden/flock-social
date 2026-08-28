// ---------------------------------------------------------------------------
// What actually leaves the device, asserted against the real capture calls.
//
// analyticsPrivacy.test.js reads services/api.js as text: it pins the config,
// the event vocabulary and the property KEYS. Text cannot answer the question
// this file exists for, which is what the VALUES turn out to be at runtime.
// Two of the findings that produced these events were exactly that kind:
//
//   * nfc_tap's `source` was the ?s= parameter forwarded verbatim, so the
//     property that measures which physical tag was tapped could be given new
//     categories by anyone holding the URL. Production has a source called
//     'standbad' from one tap on 2026-08-21 to prove it, and the comment above
//     the function claimed the clamp already existed.
//   * signup_failed must stay silent on a 403, because that status is the age
//     gate and PostHog merges a device's anonymous history into whoever
//     eventually signs up on it.
//
// Neither is visible in a source scan. Both are visible here.
// ---------------------------------------------------------------------------

// A key must be present for track() to do anything at all, and posthog-js must
// never be the real one: this suite would otherwise open a live connection to
// project 555076 and file its fixtures as product data.
process.env.REACT_APP_POSTHOG_KEY = 'phc_analytics_events_test';

const mockCapture = jest.fn();
const mockIdentify = jest.fn();
const mockReset = jest.fn();

jest.mock('posthog-js', () => ({
  __esModule: true,
  default: {
    capture: (...args) => mockCapture(...args),
    identify: (...args) => mockIdentify(...args),
    reset: (...args) => mockReset(...args),
  },
}));

const api = require('../services/api');

// track() reaches the SDK through a dynamic import, so a capture is always at
// least one microtask behind the call that made it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Minimal stand-in for what request() needs off a Response: a status, a
// content-type it can trust, and a body it can parse.
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

const respondWith = (status, body) => {
  global.fetch = jest.fn(() => Promise.resolve(jsonResponse(status, body)));
};

const events = (name) => mockCapture.mock.calls.filter(([e]) => e === name).map(([, props]) => props);

beforeEach(() => {
  mockCapture.mockClear();
  mockIdentify.mockClear();
  mockReset.mockClear();
  window.localStorage.clear();
  global.fetch = jest.fn(() => Promise.resolve(jsonResponse(200, {})));
});

describe('the NFC tag source is an allowlist, not a pass-through', () => {
  test.each([
    ['stand', 'stand'],
    ['card', 'card'],
    ['standbad', 'unknown'],
    ['unknown', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['a'.repeat(32), 'unknown'],
  ])('?s=%p is reported as %p', async (tag, expected) => {
    api.trackNfcTap(tag);
    await flush();
    expect(events('nfc_tap')).toEqual([{ source: expected }]);
  });

  test('the action event clamps the same value the same way', async () => {
    api.trackNfcAction('whatever-someone-typed', 'open_app');
    await flush();
    expect(events('nfc_tap_action')).toEqual([{ source: 'unknown', action: 'open_app' }]);
  });
});

// The top of the funnel, where almost every visitor is lost today, had two
// dark steps: arrival at the auth forms (screen_viewed only fires inside the
// authed shell) and the email-verification wall (its outcome was computed and
// then dropped). Both clamp to a fixed vocabulary; neither carries anything
// about the person.
describe('the top-of-funnel arrival and verification events', () => {
  test('auth_screen_viewed reports the form shown, clamped to the two it knows', async () => {
    api.trackAuthScreen('signup');
    api.trackAuthScreen('login');
    api.trackAuthScreen('whatever-someone-passed');
    await flush();
    expect(events('auth_screen_viewed')).toEqual([
      { screen: 'signup' }, { screen: 'login' }, { screen: 'unknown' },
    ]);
  });

  test('email_verified reports the outcome bucket, and one it does not know is a failure', async () => {
    api.trackEmailVerified('1');
    api.trackEmailVerified('expired');
    api.trackEmailVerified('invalid');
    api.trackEmailVerified('surprise');
    await flush();
    expect(events('email_verified')).toEqual([
      { outcome: '1' }, { outcome: 'expired' }, { outcome: 'invalid' }, { outcome: 'error' },
    ]);
  });
});

describe('signup and login failures', () => {
  test('a 400 is recorded as a bucket, and the server copy is not', async () => {
    respondWith(400, { error: 'Email already registered' });
    await expect(api.signup('N', 'a@b.com', 'pw', '2005-01-01')).rejects.toThrow();
    await flush();
    expect(events('signup_failed')).toEqual([{ method: 'email', reason: 'invalid' }]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('a@b.com');
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('Email already registered');
  });

  test('the age gate produces no event at all', async () => {
    respondWith(403, { error: 'You must be at least 13 to use Flock.' });
    await expect(api.signup('N', 'a@b.com', 'pw', '2020-01-01')).rejects.toThrow();
    await flush();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test('a needsDob re-prompt produces no event either', async () => {
    respondWith(400, { error: 'Add your date of birth to create an account.', needsDob: true });
    await expect(api.signup('N', 'a@b.com', 'pw')).rejects.toThrow();
    await flush();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test('a wrong password on login is a bucket, and Google failures name their method', async () => {
    respondWith(401, { error: 'Invalid email or password' });
    await expect(api.login('a@b.com', 'wrong')).rejects.toThrow();
    respondWith(400, { error: 'Google sign-in failed' });
    await expect(api.googleLogin('cred')).rejects.toThrow();
    await flush();
    expect(events('login_failed')).toEqual([
      { method: 'email', reason: 'rejected' },
      { method: 'google', reason: 'invalid' },
    ]);
  });

  test('a dead connection is told apart from a refusal', async () => {
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(api.login('a@b.com', 'pw')).rejects.toThrow();
    await flush();
    expect(events('login_failed')).toEqual([{ method: 'email', reason: 'network' }]);
  });

  test('a success still identifies by account id and by nothing else', async () => {
    respondWith(200, { token: 't', user: { id: 42, name: 'Jayden', email: 'a@b.com' } });
    await api.login('a@b.com', 'pw');
    await flush();
    expect(mockIdentify).toHaveBeenCalledWith('42');
    expect(mockIdentify.mock.calls[0]).toHaveLength(1);
    expect(events('login')).toEqual([{ method: 'email' }]);
  });
});

describe('the funnel events carry the count and never the content', () => {
  test('a budget submission reports whether it was skipped, never the amount', async () => {
    respondWith(200, { ceiling: null, submissionCount: 1 });
    await api.submitBudget(7, { amount: 63.5, skipped: false });
    await flush();
    expect(events('budget_submitted')).toEqual([{ skipped: false }]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('63.5');
  });

  test('a vote reports that it happened and not which venue', async () => {
    respondWith(200, { ok: true });
    await api.voteForVenue(7, "Molly's Irish Pub", 'ChIJplacechars');
    await flush();
    expect(events('venue_vote_cast')).toEqual([{ surface: 'member' }]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('Molly');
    expect(sent).not.toContain('ChIJ');
  });

  test('a DM venue vote is the same event as a member vote, on a third surface', async () => {
    // App.js casts a DM vote over the socket (trackDmVenueVote); the REST
    // helper below is the unused fallback. Both must report one venue_vote_cast
    // with surface 'dm', and neither may carry the venue the way the member
    // and guest votes do not.
    respondWith(200, { ok: true });
    await api.voteDmVenue(9, "Molly's Irish Pub", 'ChIJdmvenuevote');
    api.trackDmVenueVote();
    await flush();
    expect(events('venue_vote_cast')).toEqual([{ surface: 'dm' }, { surface: 'dm' }]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('Molly');
    expect(sent).not.toContain('ChIJ');
  });

  test('a message reports its kind and not a word of it', async () => {
    respondWith(201, { id: 1 });
    await api.sendMessage(7, 'meet me at the corner at nine', { message_type: 'venue' });
    await api.sendDM(9, 'my address is 12 Elm St', { image_url: 'data:image/png;base64,AAAA' });
    await flush();
    expect(events('flock_message_sent')).toEqual([{ kind: 'venue', transport: 'http' }]);
    expect(events('dm_sent')).toEqual([{ kind: 'image', transport: 'http' }]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('corner');
    expect(sent).not.toContain('Elm');
    expect(sent).not.toContain('base64');
  });

  test('an unrecognised message type falls back rather than becoming a category', async () => {
    respondWith(201, { id: 1 });
    await api.sendMessage(7, 'hi', { message_type: 'something_new' });
    await flush();
    expect(events('flock_message_sent')).toEqual([{ kind: 'text', transport: 'http' }]);
  });

  test('an RSVP reports the answer, a status change reports the status', async () => {
    respondWith(200, { ok: true });
    await api.acceptFlockInvite(7);
    await api.declineFlockInvite(8);
    await api.setFlockStatus(7, 'confirmed');
    await flush();
    expect(events('flock_rsvp')).toEqual([
      { response: 'yes', surface: 'member' },
      { response: 'no', surface: 'member' },
    ]);
    expect(events('flock_status_set')).toEqual([{ status: 'confirmed' }]);
  });

  test('a status this client refuses to send is never reported as if it happened', async () => {
    respondWith(200, { ok: true });
    await expect(api.setFlockStatus(7, 'vibing')).rejects.toThrow();
    await flush();
    expect(events('flock_status_set')).toEqual([]);
  });

  test('attendance reports two counts and names nobody', async () => {
    respondWith(200, { ok: true });
    await api.submitAttendance(7, [
      { userId: 1, attended: true },
      { userId: 2, attended: true },
      { userId: 3, attended: false },
    ]);
    await flush();
    expect(events('attendance_marked')).toEqual([{ party_size: 3, attended: 2 }]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('userId');
  });

  test('Birdie reports the depth of the conversation and none of its words', async () => {
    respondWith(200, { reply: 'try the diner' });
    await api.sendAiChat(
      [{ role: 'user', content: 'where should we go tonight' }, { role: 'model', content: 'the diner' }],
      '40.6,-75.4',
      { flockId: 7 },
    );
    await flush();
    expect(events('birdie_message')).toEqual([{ turn: 2 }]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('tonight');
    expect(sent).not.toContain('40.6');
  });

  test('an invite opening reports whether the link was complete, never the token', async () => {
    api.trackInviteLinkOpened(true);
    api.trackInviteLinkOpened(false);
    await flush();
    expect(events('invite_link_opened')).toEqual([{ complete: true }, { complete: false }]);
  });

  test('an app open reports the shell and whether anyone was signed in', async () => {
    api.trackAppOpened('native');
    await flush();
    expect(events('app_opened')).toEqual([{ shell: 'native', signed_in: false }]);

    mockCapture.mockClear();
    window.localStorage.setItem('flockToken', 'a-real-token');
    api.trackAppOpened('anything-else');
    await flush();
    expect(events('app_opened')).toEqual([{ shell: 'web', signed_in: true }]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('a-real-token');
  });
});

describe('a failed request never reports the step as done', () => {
  test.each([
    ['acceptFlockInvite', () => api.acceptFlockInvite(7), 'flock_rsvp'],
    ['voteForVenue', () => api.voteForVenue(7, 'Bar'), 'venue_vote_cast'],
    ['voteDmVenue', () => api.voteDmVenue(9, 'Bar'), 'venue_vote_cast'],
    ['submitBudget', () => api.submitBudget(7, { amount: 20 }), 'budget_submitted'],
    ['sendAiChat', () => api.sendAiChat([], null, null), 'birdie_message'],
  ])('%s does not fire %s on a 500', async (_label, run, event) => {
    respondWith(500, { error: 'Server error' });
    await expect(run()).rejects.toThrow();
    await flush();
    expect(events(event)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE CHAT EVENTS USED TO COUNT SOCKET OUTAGES.
//
// App.js emits over the websocket first and only calls api.js's sendMessage /
// sendDM in the `else` of that emit's own return value. The capture lived
// exclusively inside those two functions, so `flock_message_sent` and
// `dm_sent` fired on the bad-network path and nowhere else: two of the
// twenty-one names in the vocabulary read on a dashboard as message volume
// while measuring how often the socket was down, which moves in the opposite
// direction from the thing the name promises.
//
// Both transports now report the same event, distinguished by a property, so
// a funnel counts every message and the transport split is readable next to
// it. This suite exists for exactly this class of question, because a source
// scan can see the call and not what the value turns out to be.
// ---------------------------------------------------------------------------
describe('chat events cover both transports and are told apart by one property', () => {
  test('the socket path reports transport socket, and carries no message text', async () => {
    api.trackFlockMessageSent({ message_type: 'text' });
    api.trackDmSent({ image_url: 'data:image/png;base64,AAAA' });
    await flush();
    expect(events('flock_message_sent')).toEqual([{ kind: 'text', transport: 'socket' }]);
    expect(events('dm_sent')).toEqual([{ kind: 'image', transport: 'socket' }]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('base64');
  });

  test('both transports file the SAME event name, which is what makes one count possible', async () => {
    respondWith(201, { id: 1 });
    api.trackFlockMessageSent({ message_type: 'text' });
    await api.sendMessage(7, 'hi');
    await flush();
    expect(events('flock_message_sent')).toEqual([
      { kind: 'text', transport: 'socket' },
      { kind: 'text', transport: 'http' },
    ]);
  });

  test('the socket tracker classifies kinds exactly as the HTTP one does', async () => {
    api.trackFlockMessageSent({ message_type: 'something_new' });
    api.trackFlockMessageSent({ message_type: 'venue' });
    await flush();
    expect(events('flock_message_sent')).toEqual([
      { kind: 'text', transport: 'socket' },
      { kind: 'venue', transport: 'socket' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// THE GUEST PAGE, which is how this product spreads and was dark after its
// first event. A guest answering an invite and a member answering one are the
// same funnel step, so they share a name and are told apart by `surface`.
// ---------------------------------------------------------------------------
describe('the guest invite funnel', () => {
  test('an RSVP maps the status onto the same words a member answer uses', async () => {
    api.trackGuestRsvp('in');
    api.trackGuestRsvp('out');
    api.trackGuestRsvp(undefined);
    await flush();
    expect(events('flock_rsvp')).toEqual([
      { response: 'yes', surface: 'guest' },
      { response: 'no', surface: 'guest' },
      { response: 'no', surface: 'guest' },
    ]);
  });

  test('a guest vote is the same event as a member vote, with the door named', async () => {
    api.trackGuestVenueVote();
    await flush();
    expect(events('venue_vote_cast')).toEqual([{ surface: 'guest' }]);
  });

  test('the handoff out of the page reports where it went, as a category', async () => {
    api.trackInviteHandoffStarted('/signup');
    api.trackInviteHandoffStarted('/app');
    // Anything the page could be changed to pass tomorrow still lands in one of
    // the two buckets rather than inventing a third out of a path.
    api.trackInviteHandoffStarted('/app?flock=12&token=abc');
    await flush();
    expect(events('invite_handoff_started')).toEqual([
      { destination: 'signup' },
      { destination: 'app' },
      { destination: 'app' },
    ]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('abc');
  });
});

// ---------------------------------------------------------------------------
// THE B2B SURFACE had no instrumentation of any kind, and it is the revenue
// story. These are the smallest set that says whether it is alive. Every one
// of them must stay free of the venue's identity: the owner is identified by
// account id, so an event naming their bar is a record of which real business
// this person runs, sitting in a vendor.
// ---------------------------------------------------------------------------
describe('venue and Roost events say whether the surface is used, never which venue', () => {
  test('a profile reports only whether a real place was claimed', async () => {
    respondWith(201, { id: 1 });
    await api.createVenueProfile({
      businessName: 'Mollys Irish Pub',
      googlePlaceId: 'ChIJplacechars',
      location: '123 Elm St',
    });
    await flush();
    expect(events('venue_profile_created')).toEqual([{ has_place: true }]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('Mollys');
    expect(sent).not.toContain('ChIJ');
    expect(sent).not.toContain('Elm');
  });

  test('a typed-in draft with no place is the case worth telling apart', async () => {
    respondWith(201, { id: 1 });
    await api.createVenueProfile({ businessName: 'A Bar', location: 'Austin, TX' });
    await flush();
    expect(events('venue_profile_created')).toEqual([{ has_place: false }]);
  });

  test('verification is a bare count', async () => {
    respondWith(200, { verification_status: 'pending' });
    await api.requestVenueVerification();
    await flush();
    expect(events('venue_verification_requested')).toEqual([{}]);
  });

  test('a Roost chip reports the intent and how the answer came out', async () => {
    respondWith(200, { intentId: 'busiest_night', mode: 'phrased', text: 'Fridays.' });
    await api.askAdvisor('busiest_night');
    await flush();
    expect(events('roost_question_asked')).toEqual([
      { kind: 'chip', intent: 'busiest_night', answer: 'phrased' },
    ]);
  });

  test('a typed Roost question never carries the question, and the body echoes it back', async () => {
    respondWith(200, {
      mode: 'refusal',
      text: 'Claim your venue first.',
      question: 'why is my tuesday dead at the Broken Spoke',
    });
    await api.askAdvisorQuestion('why is my tuesday dead at the Broken Spoke');
    await flush();
    expect(events('roost_question_asked')).toEqual([{ kind: 'typed', answer: 'refusal' }]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('tuesday');
    expect(sent).not.toContain('Broken Spoke');
  });

  test('an answer mode this client does not know is unknown, not passed through', async () => {
    // The categories on this property must be a set the frontend owns. A
    // server that starts answering with a new mode would otherwise silently
    // add a column to every chart built on it.
    respondWith(200, { mode: 'something_new', text: 'x' });
    await api.askAdvisorQuestion('anything');
    await flush();
    expect(events('roost_question_asked')).toEqual([{ kind: 'typed', answer: 'unknown' }]);
  });

  test('the four real answer modes all survive the allowlist', async () => {
    for (const mode of ['refusal', 'template', 'phrased', 'advice']) {
      respondWith(200, { mode, text: 'x' });
      // eslint-disable-next-line no-await-in-loop
      await api.askAdvisorQuestion('anything');
    }
    await flush();
    expect(events('roost_question_asked').map((p) => p.answer))
      .toEqual(['refusal', 'template', 'phrased', 'advice']);
  });
});

describe('the pulse is measured, and its categories cannot be invented', () => {
  test('the three offered statuses and the clear all record', async () => {
    for (const status of ['down', 'maybe', 'not']) {
      respondWith(200, { pulse: { status } });
      // eslint-disable-next-line no-await-in-loop
      await api.setAvailability({ status, expiresAt: '2026-08-28T08:00:00.000Z' });
    }
    respondWith(200, {});
    await api.clearAvailability();
    await flush();
    expect(events('pulse_set').map((p) => p.status)).toEqual(['down', 'maybe', 'not', 'cleared']);
  });

  test('a status the UI does not offer lands as other, not as a new category', async () => {
    respondWith(200, { pulse: { status: 'standbad' } });
    await api.setAvailability({ status: 'standbad', expiresAt: '2026-08-28T08:00:00.000Z' });
    await flush();
    expect(events('pulse_set').map((p) => p.status)).toEqual(['other']);
  });
});

describe('the friend graph is counted, never named', () => {
  test('sent and accepted each record one bare event', async () => {
    respondWith(200, { status: 'pending' });
    await api.sendFriendRequest(41);
    respondWith(200, { ok: true });
    await api.acceptFriendRequest(41);
    await flush();
    expect(events('friend_request_sent')).toEqual([{}]);
    expect(events('friend_request_accepted')).toEqual([{}]);
  });

  test('a refused request records nothing', async () => {
    respondWith(403, { error: 'no' });
    await expect(api.sendFriendRequest(41)).rejects.toBeTruthy();
    await flush();
    expect(events('friend_request_sent')).toEqual([]);
  });
});

describe('the notification permission outcome is clamped on both axes', () => {
  test('real outcomes and surfaces pass; invented ones land as other', async () => {
    api.trackNotificationPermission('granted', 'chat_banner');
    api.trackNotificationPermission('default', 'settings');
    api.trackNotificationPermission('standbad', 'standbad');
    await flush();
    expect(events('notification_permission')).toEqual([
      { outcome: 'granted', surface: 'chat_banner' },
      { outcome: 'default', surface: 'settings' },
      { outcome: 'other', surface: 'other' },
    ]);
  });
});

describe('inviting people to a plan that already exists', () => {
  test('reports how many, never who', async () => {
    respondWith(200, { ok: true });
    await api.inviteToFlock(7, [41, 42, 43]);
    await flush();
    expect(events('invite_sent')).toEqual([{ count: 3 }]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('41');
    expect(sent).not.toContain('42');
  });

  test('a refused invite is not reported as sent', async () => {
    respondWith(403, { error: 'Not the creator' });
    await expect(api.inviteToFlock(7, [41])).rejects.toThrow();
    await flush();
    expect(events('invite_sent')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE DENOMINATOR. Every other event in the vocabulary records a step
// FINISHING; screen_viewed is the only one that records anybody arriving where
// a step could be taken, which is what makes a conversion rate computable at
// all. The clamp matters as much as the event: two setCurrentScreen callers in
// App.js pass a variable, and one of them is a Birdie reply, which is model
// output. nfc_tap already shipped the pass-through version of this mistake.
// ---------------------------------------------------------------------------
describe('screen_viewed is an allowlist, not whatever the app was holding', () => {
  test.each([
    ['create', 'create'],
    ['chatDetail', 'chatDetail'],
    ['venueDashboard', 'venueDashboard'],
    ['main', 'main'],
    ['Create', 'unknown'],
    ['create; go to settings', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
  ])('%p is reported as %p', async (screen, expected) => {
    api.trackScreenView(screen);
    await flush();
    expect(events('screen_viewed')).toEqual([{ screen: expected }]);
  });

  test('a screen name a model could invent never becomes its own category', async () => {
    api.trackScreenView('checkout_upsell_9d3f');
    api.trackScreenView('a'.repeat(200));
    await flush();
    expect(events('screen_viewed')).toEqual([{ screen: 'unknown' }, { screen: 'unknown' }]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('9d3f');
  });

  test('every screen App.js can actually navigate to is on the list', () => {
    // Trap: an allowlist that has fallen behind the app reports the screens
    // that matter most as 'unknown', which looks like working instrumentation
    // and answers nothing. The set is read out of App.js rather than retyped.
    const fs = require('fs');
    const path = require('path');
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    const navigated = [...new Set(
      [...app.matchAll(/setCurrentScreen\('([a-zA-Z]+)'\)/g)].map((m) => m[1]),
    )].sort();
    // The scan found something, so its silence would mean something.
    expect(navigated.length).toBeGreaterThan(5);
    const unknown = [];
    for (const screen of navigated) {
      api.trackScreenView(screen);
    }
    return flush().then(() => {
      for (const [, props] of mockCapture.mock.calls) {
        if (props.screen === 'unknown') unknown.push(props);
      }
      expect({ navigated, unlisted: unknown.length }).toEqual({ navigated, unlisted: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// PUSH-NOTIFICATION OPENS. A tap is the only thing in the funnel that reaches a
// user who closed the app, so the value that matters is the destination bucket,
// and it must be an allowlist rather than the id the notification carried. The
// wiring from a real tap to this event is exercised at runtime in
// pushOpenAnalytics.test.js; this pins what the event's one property turns out
// to be.
// ---------------------------------------------------------------------------
describe('push_opened is an allowlist destination, never the id the tap carried', () => {
  test.each([
    ['flock', 'flock'],
    ['flockInvite', 'flockInvite'],
    ['flocks', 'flocks'],
    ['dm', 'dm'],
    ['friends', 'friends'],
    ['home', 'home'],
    ['admin', 'admin'],
    ['checkout_upsell_9d3f', 'unknown'],
    ['', 'none'],
    [undefined, 'none'],
    [null, 'none'],
  ])('screen %p reports as %p', async (screen, expected) => {
    api.trackPushOpened(screen);
    await flush();
    expect(events('push_opened')).toEqual([{ destination: expected }]);
  });

  test('a screen a model could invent never becomes its own category', async () => {
    api.trackPushOpened('a'.repeat(200));
    await flush();
    expect(events('push_opened')).toEqual([{ destination: 'unknown' }]);
  });
});
