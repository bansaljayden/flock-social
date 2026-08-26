/**
 * The client half of the push suppression fix (2026-08-25).
 *
 * The backend used to read "a socket exists in `user:{id}`" as "this person is
 * looking at this", and suppressed the push. Two things made that wrong, and
 * both of them are fixed on this side of the wire:
 *
 *   1. A LAPTOP TAB LEFT OPEN held that room forever, so the phone in the
 *      owner's pocket received nothing, indefinitely, with no symptom at all.
 *      services/socket.js now gives the connection up when the document is
 *      hidden, so a live socket means a foreground app.
 *
 *   2. A BACKGROUNDED PHONE still looked online for up to 85 seconds
 *      (server.js: pingTimeout 60000, pingInterval 25000). The native shell
 *      releases immediately rather than after the web grace, because a hidden
 *      WKWebView is unambiguously a backgrounded app.
 *
 * And the handshake now names WHICH device the connection speaks for, so the
 * server can suppress one device instead of the whole account.
 *
 * These are source assertions rather than a driven socket: the behaviour is
 * three browser event listeners registered at module scope, and standing up
 * jsdom plus a fake socket.io manager to observe them would test the fake.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'services');
const socketSrc = fs.readFileSync(path.join(SRC, 'socket.js'), 'utf8');
const firebaseSrc = fs.readFileSync(path.join(SRC, 'firebase.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(SRC, 'api.js'), 'utf8');

describe('a hidden client gives its socket up', () => {
  test('visibilitychange does more than reconnect', () => {
    // The whole listener used to be "if visible, nudge()". The missing half is
    // the expensive one.
    expect(socketSrc).toMatch(/hiddenTimer = setTimeout\(releaseWhileHidden, HIDDEN_GRACE_MS\)/);
    expect(socketSrc).toMatch(/function releaseWhileHidden/);
    expect(socketSrc).toMatch(/socket\.disconnect\(\)/);
  });

  test('a backgrounded native app releases immediately, a hidden tab after a grace', () => {
    expect(socketSrc).toMatch(/if \(isNativeShell\(\)\) \{\s*releaseWhileHidden\(\);/);
    const grace = socketSrc.match(/const HIDDEN_GRACE_MS = (\d+);/);
    expect(grace).toBeTruthy();
    // Longer than an alt-tab, and far shorter than the indefinite silence it
    // replaces. If this ever grows past a minute it stops being a fix.
    expect(Number(grace[1])).toBeGreaterThanOrEqual(5000);
    expect(Number(grace[1])).toBeLessThanOrEqual(60000);
  });

  test('the grace timer re-checks visibility instead of trusting when it was set', () => {
    // Otherwise a tab the user came back to nine seconds in is torn down anyway.
    expect(socketSrc).toMatch(/if \(!force && typeof document !== 'undefined' && document\.visibilityState !== 'hidden'\) return;/);
  });

  test('coming back to the tab is not throttled behind a flapping-connection guard', () => {
    expect(socketSrc).toMatch(/function nudgeNow\(\)/);
    expect(socketSrc).toMatch(/document\.visibilityState === 'visible'\) \{\s*cancelHiddenTimer\(\);\s*nudgeNow\(\);/);
  });

  test('a closing page releases too, since visibilitychange does not always land', () => {
    expect(socketSrc).toMatch(/addEventListener\('pagehide'/);
    expect(socketSrc).toMatch(/releaseWhileHidden\(true\)/);
  });

  test('the room and subscription registries survive a hidden release', () => {
    // clearRooms() belongs to sign-out and account switch. Calling it here
    // would silently drop the user out of the chat they had open, and the
    // reconnect would come back to an app receiving nothing room-scoped.
    const release = socketSrc.slice(
      socketSrc.indexOf('function releaseWhileHidden'),
      socketSrc.indexOf('function nudgeNow')
    );
    expect(release).not.toMatch(/clearRooms/);
    expect(release).not.toMatch(/removeAllListeners/);
    expect(release).not.toMatch(/socketToken = null/);
  });
});

describe('a socket names the device it speaks for', () => {
  test('the handshake carries this device push token when there is one', () => {
    expect(socketSrc).toMatch(/auth: devicePushToken \? \{ token, pushToken: devicePushToken \} : \{ token \}/);
  });

  test('the token is pushed in from firebase.js, not re-read from localStorage', () => {
    // firebase.js owns PUSH_TOKEN_KEY. A second reader of that key is how a
    // rename silently unsubscribes everybody, which is the mistake its own
    // header records having already been made once with the auth token.
    expect(socketSrc).toMatch(/export function setDevicePushToken/);
    expect(socketSrc).not.toMatch(/flock_push_token/);
    expect(firebaseSrc).toMatch(/import \{ setDevicePushToken \} from '\.\/socket'/);
    // Every path that changes this device's identity: first registration, a
    // rotated token, and logout clearing it.
    expect(firebaseSrc).toMatch(/function rememberPushToken\(token\) \{[\s\S]*?setDevicePushToken\(token\)/);
    // And a cold start, where registration does not run again.
    expect(firebaseSrc).toMatch(/setDevicePushToken\(knownPushToken\(\)\)/);
  });

  test('a token that arrives or rotates mid-session reaches the server', () => {
    // The handshake is fixed at connect time, so the connection has to be
    // rebuilt or it keeps claiming a device it is no longer.
    const setter = socketSrc.slice(
      socketSrc.indexOf('export function setDevicePushToken'),
      socketSrc.indexOf('SUBSCRIPTION REGISTRY')
    );
    expect(setter).toMatch(/connectSocket\(\)/);
    expect(setter).toMatch(/if \(next === devicePushToken\) return;/);
  });
});

describe('the device reports the clock quiet hours are decided on', () => {
  test('registration sends an IANA zone', () => {
    expect(firebaseSrc).toMatch(/function deviceTimezone\(\)/);
    expect(firebaseSrc).toMatch(/Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
    // All three registration paths: native, native token rotation, and web.
    const calls = firebaseSrc.match(/registerDeviceToken\([^)]*deviceTimezone\(\)\)/g) || [];
    expect(calls.length).toBe(3);
  });

  test('an unresolvable zone is omitted rather than guessed', () => {
    // The backend reads an unknown zone as "deliver now". Holding somebody's
    // messages for six hours on a wrong guess is the worse failure.
    expect(firebaseSrc).toMatch(/return typeof zone === 'string' && zone\.length > 0 && zone\.length <= 64 \? zone : undefined;/);
    expect(apiSrc).toMatch(/if \(timezone\) body\.timezone = timezone;/);
  });
});
