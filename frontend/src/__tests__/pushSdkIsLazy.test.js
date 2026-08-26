/**
 * THE FIREBASE JS SDK MUST NOT BE ON THE FIRST PAINT PATH.
 *
 * `App.js` imports `services/firebase.js` at the top level, so anything that
 * file imports statically lands in the chunk group a logged in user downloads
 * before the app draws anything. Until 2026-08-26 that included
 * `firebase/app` and `firebase/messaging`, paid by every user on every launch,
 * including everyone who had never granted notification permission and
 * everyone who never would. On native iOS and Android it was paid for nothing
 * at all: push there goes through `@capacitor-firebase/messaging`, and the JS
 * SDK is never touched.
 *
 * WHY A TEST AND NOT A NOTE
 *
 * This regression is invisible. Putting `import { getMessaging } from
 * 'firebase/messaging'` back at the top of the file changes no behaviour, logs
 * no warning, and fails no other test. The only symptom is a number in a build
 * report that nobody reads, on a metric Jayden cares about for a growth reason:
 * the audience is teenagers on mid-range Android phones, so first paint is how
 * fast the app feels to the users he is trying to get.
 *
 * The second half of this file is the more subtle half. A lazy import returns a
 * promise, and the one thing in this module that cannot wait on a promise is
 * the OS permission prompt: `Notification.requestPermission()` has to be called
 * from the tap that reached it, or Safari refuses it outright and Chrome's
 * transient activation runs out. iOS gives an app one notification prompt per
 * install and a denial is permanent, so an `await` accidentally placed above
 * that line would not throw, it would quietly lose the only ask the app ever
 * gets. That is pinned here too.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false -t "firebase"
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const FIREBASE = read('services', 'firebase.js');

const CODE_EXT = ['.js', '.jsx', '.ts', '.tsx'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (CODE_EXT.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/* Comments do not import anything, and this file is about a module whose
   comments discuss the very import it must not contain. Every assertion below
   runs on code with the comment lines taken out, or the explanation of the rule
   would break the rule. */
function codeOnly(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/* `from 'firebase/x'` and `require('firebase/x')`, but NOT `import('firebase/x')`.
   The distinction is the whole point of the file, so the pattern has to be able
   to tell a static specifier from a dynamic one rather than matching the
   package name anywhere it appears. */
const STATIC_FIREBASE = /(?:^|[^(\w])(?:from|require\s*\(|import)\s*['"]firebase\/[a-z-]+['"]/m;

const CODE = codeOnly(FIREBASE);

describe('firebase JS SDK is loaded lazily, never at import time', () => {
  it('services/firebase.js imports no firebase module statically', () => {
    expect(CODE).not.toMatch(STATIC_FIREBASE);
  });

  it('it reaches the SDK through dynamic import instead', () => {
    expect(FIREBASE).toMatch(/import\(\s*'firebase\/app'\s*\)/);
    expect(FIREBASE).toMatch(/import\(\s*'firebase\/messaging'\s*\)/);
  });

  it('no other file in src/ pulls firebase onto a static import either', () => {
    const offenders = walk(SRC)
      .filter((f) => STATIC_FIREBASE.test(codeOnly(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('caches one download and does not cache a failure', () => {
    const loader = FIREBASE.slice(
      FIREBASE.indexOf('function loadMessagingSdk'),
      FIREBASE.indexOf('async function getFirebaseMessaging')
    );
    // One in-flight promise shared by every caller, so a tap and a watcher tick
    // that land together fetch the chunk once.
    expect(loader).toMatch(/if \(!sdkPromise\)/);
    // A rejected promise left in the cache would hand the focus and 'online'
    // re-arms in the session watcher the same old failure forever.
    expect(loader).toMatch(/sdkPromise = null;/);
  });
});

describe('the SDK is not fetched by users who have no push', () => {
  it('the sync path checks permission before it checks the SDK', () => {
    const sync = FIREBASE.slice(
      FIREBASE.indexOf('export async function syncPushRegistration'),
      FIREBASE.indexOf('export async function readNotificationPermission')
    );
    // This runs on a 2s tick for every signed in web user and almost none of
    // them have granted. The cheap synchronous answer has to come first or the
    // lazy import saves nothing.
    expect(sync.indexOf("getNotificationStatus() !== 'granted'"))
      .toBeLessThan(sync.indexOf('await getFirebaseMessaging()'));
  });

  it('the foreground listener waits for a token rather than fetching on mount', () => {
    const listener = FIREBASE.slice(
      FIREBASE.indexOf('export function onForegroundMessage'),
      FIREBASE.indexOf('export function getNotificationStatus')
    );
    // App.js calls onForegroundMessage from a mount effect for every signed in
    // user. An unconditional attach here would fetch the chunk on every launch.
    expect(listener).toMatch(/knownPushToken\(\) \|\| getNotificationStatus\(\) === 'granted'/);
    // And waiting must not become never: the mount effect has an empty
    // dependency list, so a grant later in the session has to release it.
    expect(listener).toMatch(/pendingForegroundAttaches\.add\(attach\)/);
    expect(FIREBASE).toMatch(/if \(token\) flushForegroundAttaches\(\);/);
    // Cleanup drops a waiter that never attached, or an unmounted screen keeps
    // a callback alive for the rest of the page load.
    expect(listener).toMatch(/pendingForegroundAttaches\.delete\(attach\)/);
  });

  it('logout does not download the SDK to delete a token that cannot exist', () => {
    const logout = FIREBASE.slice(
      FIREBASE.indexOf('export function unregisterPushToken'),
      FIREBASE.indexOf('export function onForegroundMessage')
    );
    expect(logout).toMatch(/if \(!sdkPromise\) return;/);
  });
});

describe('the lazy import never gets between the tap and the OS prompt', () => {
  const ask = FIREBASE.slice(
    FIREBASE.indexOf('export async function requestNotificationPermission'),
    FIREBASE.indexOf('export async function syncPushRegistration')
  );

  it('starts the download without awaiting it, then asks', () => {
    const started = ask.indexOf('const loading = getFirebaseMessaging();');
    const prompt = ask.indexOf('await Notification.requestPermission()');
    const awaited = ask.indexOf('const m = await loading;');

    expect(started).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(started);
    expect(awaited).toBeGreaterThan(prompt);
  });

  it('has no await at all above the prompt on the web branch', () => {
    // The native branch returns before this point, so everything between the
    // isNativeApp() line and the prompt runs in the same synchronous turn as
    // the tap. One stray await there and the prompt no longer draws on Safari.
    const web = ask.slice(
      ask.indexOf('if (isNativeApp()) return await requestNativePermission();')
        + 'if (isNativeApp()) return await requestNativePermission();'.length,
      ask.indexOf('await Notification.requestPermission()')
    );
    const code = web
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/\bawait\b/);
  });

  it('still refuses to ask when there is no Firebase project to register with', () => {
    // The synchronous half of the guard that getFirebaseMessaging used to
    // provide here. Losing it would spend the one prompt on a build that
    // cannot register a token anyway.
    expect(ask.indexOf('if (!hasFirebaseConfig()) return null;'))
      .toBeLessThan(ask.indexOf('await Notification.requestPermission()'));
  });

  it('is still the only function in the file that may draw a prompt', () => {
    const asks = CODE.match(/Notification\.requestPermission\(|requestPermissions\(/g) || [];
    expect(asks.length).toBe(2); // web prompt, native plugin prompt
    for (const fn of ['syncPushRegistration', 'syncNativeRegistration', 'onForegroundMessage']) {
      const start = FIREBASE.indexOf(`function ${fn}`);
      const body = FIREBASE.slice(start, FIREBASE.indexOf('\n}', start));
      expect(body).not.toMatch(/requestPermission/);
    }
  });
});
