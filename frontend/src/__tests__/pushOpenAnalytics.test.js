// ---------------------------------------------------------------------------
// A notification tap must report push_opened, end to end and at runtime.
//
// analyticsEvents.test.js pins what the ONE property of push_opened turns out
// to be. This file proves the other half a source scan cannot: that a real
// native notification tap, driven through services/pushNavigation.js, actually
// reaches api.js's trackPushOpened and files the event. The whole chain runs,
// with the real pushNavigation module, the real api client, and a fake FCM
// plugin whose listener we fire ourselves. Nothing here reads a source file.
//
// The id the notification carried (a senderId, a flockId) is a person, so it is
// asserted absent from everything captured, the same discipline every other
// event in the vocabulary keeps.
// ---------------------------------------------------------------------------

// track() needs a key or it drops every capture, and posthog-js must be the
// fake or this would file its fixtures into a live project.
process.env.REACT_APP_POSTHOG_KEY = 'phc_push_open_test';

const mockCapture = jest.fn();
jest.mock('posthog-js', () => ({
  __esModule: true,
  default: {
    capture: (...args) => mockCapture(...args),
    identify: () => {},
    reset: () => {},
  },
}));

// A fake @capacitor-firebase/messaging that captures the tap listener so the
// test can fire it. Plain functions, not jest.fn(): react-scripts sets
// resetMocks: true, which would strip the implementation between tests. The
// name must start with "mock" for jest's hoisting to allow the reference.
const mockFcm = {
  listeners: new Map(),
  reset() { this.listeners = new Map(); },
  fire(name, payload) { for (const cb of this.listeners.get(name) || []) cb(payload); },
};

jest.mock('@capacitor-firebase/messaging', () => ({
  FirebaseMessaging: {
    addListener: (name, cb) => {
      if (!mockFcm.listeners.has(name)) mockFcm.listeners.set(name, new Set());
      mockFcm.listeners.get(name).add(cb);
      return Promise.resolve({ remove: () => {} });
    },
  },
}));

// The native branch also attaches an @capacitor/app appUrlOpen listener and
// asks getLaunchUrl; a launch with no URL produces nothing, which keeps this
// test to the FCM path it is about.
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: () => Promise.resolve({ remove: () => {} }),
    getLaunchUrl: () => Promise.resolve(undefined),
  },
}));

// track() reaches the SDK through a dynamic import, and so does the FCM plugin
// listener attach, so each is at least one microtask behind the call.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const pushOpens = () => mockCapture.mock.calls
  .filter(([e]) => e === 'push_opened')
  .map(([, props]) => props);

beforeEach(() => {
  jest.resetModules();
  mockCapture.mockClear();
  mockFcm.reset();
  window.Capacitor = { isNativePlatform: () => true };
});

afterEach(() => {
  delete window.Capacitor;
});

async function tap(data) {
  // eslint-disable-next-line global-require
  const nav = require('../services/pushNavigation');
  nav.startPushNavigation();
  await flush(); // let the dynamic import attach the notificationActionPerformed listener
  mockFcm.fire('notificationActionPerformed', { notification: { data } });
  await flush(); // let trackPushOpened -> track -> import('posthog-js') resolve
}

describe('a native notification tap files push_opened with the resolved destination', () => {
  test('a DM notification opens to dm, and the sender id never leaves', async () => {
    await tap({ type: 'dm_message', senderId: '4210' });
    expect(pushOpens()).toEqual([{ destination: 'dm' }]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('4210');
  });

  test('a flock-scoped notification opens to flock, and the flock id never leaves', async () => {
    await tap({ type: 'crowd_alert', flockId: '8817' });
    expect(pushOpens()).toEqual([{ destination: 'flock' }]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('8817');
  });

  test('an invite notification opens to flockInvite', async () => {
    await tap({ type: 'flock_invite', flockId: '55' });
    expect(pushOpens()).toEqual([{ destination: 'flockInvite' }]);
  });

  test('a tap that resolves to no screen is still an open, reported as none', async () => {
    // A payload with nothing to route to: intentFromData answers null, and the
    // open is still recorded because the user did open the app.
    await tap({ type: 'flock_message' });
    expect(pushOpens()).toEqual([{ destination: 'none' }]);
  });
});
