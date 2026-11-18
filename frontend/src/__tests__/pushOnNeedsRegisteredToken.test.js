/**
 * "ON" MEANS THIS DEVICE HOLDS A REGISTERED PUSH TOKEN, NOT THAT THE BROWSER
 * SAID YES.
 *
 * Brave grants notification permission and then fails every FCM getToken with
 * "push service error". requestNotificationPermission returned null, Set up
 * toasted "Notifications aren't on", and then re-read Notification.permission,
 * which said 'granted': the row turned to "On", told the person how to turn
 * them off, and took Set up away. The flock chat's row wrote the same answer
 * into the shared status, and App.js re-read it on every focus.
 *
 * pushSetupStatus is the one rule: a grant with no registered token is not set
 * up. The two taps that ask are pinned beside their other tests
 * (profileSettingsTapFeedback.test.js, hostPlanControls.test.js).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test pushOnNeedsRegisteredToken --watchAll=false
 */
const fs = require('fs');
const path = require('path');

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  jest.resetModules();
  localStorage.clear();
  global.fetch = jest.fn(() => Promise.resolve(jsonRes({ message: 'ok' })));
});

describe('pushSetupStatus', () => {
  test('a granted permission on a device holding no registered token is not set up', () => {
    // eslint-disable-next-line global-require
    const { pushSetupStatus } = require('../services/firebase');
    expect(pushSetupStatus('granted')).toBe('default');
  });

  test('a granted permission with this device registered is on', () => {
    localStorage.setItem('flock_push_token', 'fcm-token-for-this-browser');
    // eslint-disable-next-line global-require
    const { pushSetupStatus } = require('../services/firebase');
    expect(pushSetupStatus('granted')).toBe('granted');
  });

  test('every other answer passes through unchanged', () => {
    // eslint-disable-next-line global-require
    const { pushSetupStatus } = require('../services/firebase');
    for (const status of ['default', 'denied', 'unsupported']) {
      expect(pushSetupStatus(status)).toBe(status);
    }
  });

  test('a token going away is announced, and the device is no longer set up', () => {
    localStorage.setItem('flock_push_token', 'fcm-token-for-this-browser');
    // eslint-disable-next-line global-require
    const firebase = require('../services/firebase');
    expect(firebase.pushSetupStatus('granted')).toBe('granted');
    const heard = jest.fn();
    window.addEventListener('flock-push-token-changed', heard);
    try {
      firebase.unregisterPushToken();
    } finally {
      window.removeEventListener('flock-push-token-changed', heard);
    }
    expect(heard).toHaveBeenCalled();
    expect(firebase.pushSetupStatus('granted')).toBe('default');
  });
});

describe('the status App.js hands both screens', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
  const FIREBASE = fs.readFileSync(path.join(__dirname, '..', 'services', 'firebase.js'), 'utf8').replace(/\r\n/g, '\n');

  test('every read goes through the rule, the first one included', () => {
    expect(APP).toMatch(/useState\(\(\) => pushSetupStatus\(typeof Notification !== 'undefined' \? Notification\.permission : 'default'\)\)/);
    expect(APP).toMatch(/\.then\(\(status\) => \{ if \(live\) setNotifStatus\(pushSetupStatus\(status\)\); \}\)/);
  });

  test('a token registered with nobody tapping anything is heard', () => {
    // The session watcher registers a device whose OS already said yes, on a
    // fresh sign-in, a couple of seconds after the first read. Without the
    // re-read the row would sit on Set up until the next focus.
    expect(FIREBASE).toMatch(/function rememberPushToken\(token\) \{[\s\S]*?window\.dispatchEvent\(new CustomEvent\('flock-push-token-changed'\)\)/);
    expect(APP).toMatch(/window\.addEventListener\('flock-push-token-changed', read\);/);
    expect(APP).toMatch(/window\.removeEventListener\('flock-push-token-changed', read\);/);
  });
});
