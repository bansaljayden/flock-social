/**
 * WHEN THE NOTIFICATION PROMPT IS ALLOWED TO FIRE.
 *
 * iOS gives an app one notification prompt per install and a denial is
 * permanent. `startPushSessionWatcher` in services/firebase.js polls the auth
 * token every two seconds and, on the first session it saw, called
 * requestNotificationPermission: so a brand new account met the OS prompt about
 * two seconds after signup, over an empty home screen, before it had seen
 * anything that says what a Flock notification is. The one ask the app will
 * ever get was spent where it could explain itself least, and it usually bought
 * a no, which cannot be re-asked.
 *
 * This is the same defect the location prompt had, fixed the same way in
 * 70df506: startup no longer asks, it only registers a device whose OS has
 * already answered yes, and the ask moves to a place where its reason is on
 * screen.
 *
 * These are SOURCE assertions on purpose. The failure mode is a future caller
 * putting requestNotificationPermission back on a startup path, and no
 * behavioural test of the happy path would catch that.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const FIREBASE = read('services', 'firebase.js');
const APP = read('App.js');

describe('startup registers, and never asks', () => {
  it('the session watcher calls the non-prompting path', () => {
    const watcher = FIREBASE.slice(
      FIREBASE.indexOf('async function syncPushForSession'),
      FIREBASE.indexOf('function rearmIfUnresolved')
    );
    expect(watcher).toMatch(/await syncPushRegistration\(\)/);
    expect(watcher).not.toMatch(/requestNotificationPermission\(/);
  });

  it('the registration path checks permission rather than requesting it', () => {
    const sync = FIREBASE.slice(
      FIREBASE.indexOf('async function syncNativeRegistration'),
      FIREBASE.indexOf('let tokenRotationSubscribed')
    );
    // checkPermissions reports. requestPermissions draws the prompt. On a
    // device that has never been asked the first answers 'prompt' and the
    // second is the thing being avoided.
    expect(sync).toMatch(/FirebaseMessaging\.checkPermissions\(\)/);
    expect(sync).not.toMatch(/requestPermissions/);

    const web = FIREBASE.slice(
      FIREBASE.indexOf('export async function syncPushRegistration'),
      FIREBASE.indexOf('export async function readNotificationPermission')
    );
    expect(web).toMatch(/getNotificationStatus\(\) !== 'granted'/);
    expect(web).not.toMatch(/Notification\.requestPermission/);
  });

  it('the boot effect in App.js does not ask either', () => {
    const boot = APP.slice(
      APP.indexOf('Promise.all([getCurrentUser(), pullSettings()])'),
      APP.indexOf('// Only an actual auth rejection ends the session')
    );
    expect(boot).toMatch(/syncPushRegistration\(\)/);
    expect(boot).not.toMatch(/requestNotificationPermission\(/);
  });
});

describe('the ask lives where its reason is on screen', () => {
  it('every caller of the prompting function is something the user tapped', () => {
    // Two, and both are onClick handlers: the Enable button in Settings, and
    // the notifications row inside a flock chat. If this count moves, the new
    // caller has to be a tap on a surface that has already said why.
    const callers = APP.match(/requestNotificationPermission\(\)/g) || [];
    expect(callers.length).toBe(2);
    APP.split('\n').forEach((line, i) => {
      if (!line.includes('requestNotificationPermission()')) return;
      const context = APP.split('\n').slice(Math.max(0, i - 6), i + 1).join('\n');
      expect(context).toMatch(/onClick=\{/);
    });
  });

  it('the flock-chat row says what the notification would be about', () => {
    const row = APP.slice(
      APP.indexOf('Know when they answer'),
      APP.indexOf('{/* Live location sharing banner */}')
    );
    expect(row).toMatch(/Flock can tell you when someone replies here, or this plan changes\./);
    // Named because they are what the backend sends to EVERY member.
    // flock_rsvp goes to the creator alone, so the row does not promise it.
    expect(row).not.toMatch(/RSVP/);
    // A dismiss that is not remembered is not a dismiss, and a row that comes
    // back on the next screen is nagging for a permission.
    expect(row).toMatch(/dismissNotifAsk/);
    expect(APP).toMatch(/localStorage\.setItem\('flock_notif_ask_dismissed', 'true'\)/);
  });

  it('it is not offered to a device that has already answered', () => {
    const guard = APP.slice(
      APP.indexOf("{(flock.memberCount || 1) > 1 && notifStatus !== 'granted'"),
      APP.indexOf('Know when they answer')
    );
    expect(guard).toMatch(/notifStatus !== 'denied'/);
    expect(guard).toMatch(/!notifAskDismissed/);
    // Inside the iOS shell there is no window.Notification, so the synchronous
    // initial value of notifStatus is 'default' for every native user whatever
    // the OS thinks. The plugin is asked once, without prompting.
    expect(APP).toMatch(/readNotificationPermission\(\)\s*\n\s*\.then/);
  });
});
