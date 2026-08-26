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
    expect(events('venue_vote_cast')).toEqual([{}]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('Molly');
    expect(sent).not.toContain('ChIJ');
  });

  test('a message reports its kind and not a word of it', async () => {
    respondWith(201, { id: 1 });
    await api.sendMessage(7, 'meet me at the corner at nine', { message_type: 'venue' });
    await api.sendDM(9, 'my address is 12 Elm St', { image_url: 'data:image/png;base64,AAAA' });
    await flush();
    expect(events('flock_message_sent')).toEqual([{ kind: 'venue' }]);
    expect(events('dm_sent')).toEqual([{ kind: 'image' }]);
    const sent = JSON.stringify(mockCapture.mock.calls);
    expect(sent).not.toContain('corner');
    expect(sent).not.toContain('Elm');
    expect(sent).not.toContain('base64');
  });

  test('an unrecognised message type falls back rather than becoming a category', async () => {
    respondWith(201, { id: 1 });
    await api.sendMessage(7, 'hi', { message_type: 'something_new' });
    await flush();
    expect(events('flock_message_sent')).toEqual([{ kind: 'text' }]);
  });

  test('an RSVP reports the answer, a status change reports the status', async () => {
    respondWith(200, { ok: true });
    await api.acceptFlockInvite(7);
    await api.declineFlockInvite(8);
    await api.setFlockStatus(7, 'confirmed');
    await flush();
    expect(events('flock_rsvp')).toEqual([{ response: 'yes' }, { response: 'no' }]);
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
    ['submitBudget', () => api.submitBudget(7, { amount: 20 }), 'budget_submitted'],
    ['sendAiChat', () => api.sendAiChat([], null, null), 'birdie_message'],
  ])('%s does not fire %s on a 500', async (_label, run, event) => {
    respondWith(500, { error: 'Server error' });
    await expect(run()).rejects.toThrow();
    await flush();
    expect(events(event)).toEqual([]);
  });
});
