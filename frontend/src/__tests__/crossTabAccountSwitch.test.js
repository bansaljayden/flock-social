/**
 * ONE BROWSER, TWO TABS, TWO ACCOUNTS.
 *
 * Every tab shares the one stored session, and getToken() reads it fresh on
 * every call. Tab 1 signed in as Ava; in tab 2 somebody signed out and signed
 * in as Ben. Tab 1 kept Ava's screens and sent its next request with Ben's
 * token: "Mark as paid" on Ava's share settled Ben's, and the payer was told
 * Ben had paid. The socket re-dialled as Ben too, and Ben's messages streamed
 * into Ava's screen.
 *
 * services/api.js now binds each page load to the account it began with
 * (WHOSE TAB THIS IS): a request whose stored token names another account, or
 * none, is refused before anything is sent, and 'flock-account-switched' tells
 * the app to reload as whoever is signed in now.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test crossTabAccountSwitch --watchAll=false
 */

import { login, logout, settleShare, uploadProfileImage, storedSessionIsThisTabs } from '../services/api';
import * as socketApi from '../services/socket';
import { io } from 'socket.io-client';

// A plain function, NOT jest.fn(impl): CRA sets resetMocks: true, which strips
// implementations off every jest.fn between tests.
jest.mock('socket.io-client', () => {
  const mockInstances = [];
  function mockIo(_url, opts) {
    const inst = {
      auth: opts && opts.auth,
      connected: true,
      active: true,
      on: () => {},
      off: () => {},
      emit: () => {},
      connect() {},
      disconnect() {},
      removeAllListeners: () => {},
    };
    mockInstances.push(inst);
    return inst;
  }
  mockIo.__instances = mockInstances;
  return { io: mockIo };
});

const fs = require('fs');
const path = require('path');

const b64url = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwtOf = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const nowS = () => Math.floor(Date.now() / 1000);
const tokenFor = (userId, authTime = nowS() - 60) => jwtOf({ userId, tv: 0, auth_time: authTime, iat: nowS(), exp: nowS() + 86400 });

const AVA = 7;
const BEN = 8;

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    text: async () => JSON.stringify(body),
  };
}

let calls;
function serve(routes) {
  calls = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '');
    const call = { path: p, method: (init.method || 'GET').toUpperCase(), auth: init.headers && init.headers.Authorization };
    calls.push(call);
    const handler = routes[p];
    if (!handler) throw new Error(`unexpected fetch ${p}`);
    return handler(call);
  });
}

let switched;
const onSwitched = () => { switched += 1; };

// Tab 1 signs in as Ava, the way the sign-in screen does.
async function signInAs(userId) {
  const token = tokenFor(userId);
  serve({ '/api/auth/login': () => jsonRes({ token, refreshToken: `R-${userId}`, user: { id: userId } }) });
  await login(`u${userId}@example.com`, 'pw');
  return token;
}

// What tab 2 writing the shared store looks like from tab 1: the value moves,
// and the browser fires a storage event in every OTHER tab.
function otherTabStores(token) {
  const oldValue = window.localStorage.getItem('flockToken');
  if (token) window.localStorage.setItem('flockToken', token);
  else window.localStorage.removeItem('flockToken');
  window.dispatchEvent(new StorageEvent('storage', { key: 'flockToken', oldValue, newValue: token || null }));
}

beforeEach(() => {
  window.localStorage.clear();
  switched = 0;
  window.addEventListener('flock-account-switched', onSwitched);
});

afterEach(() => {
  window.removeEventListener('flock-account-switched', onSwitched);
  socketApi.disconnectSocket();
});

test('a write from a tab whose account was replaced is refused, not sent as the new account', async () => {
  await signInAs(AVA);
  // Tab 2: signed out, signed in as Ben. Written without an event this time,
  // so the request itself has to notice.
  window.localStorage.setItem('flockToken', tokenFor(BEN));
  serve({ '/api/billing/41/settle': () => jsonRes({ settled: true }) });

  await expect(settleShare(41)).rejects.toMatchObject({ accountSwitched: true });

  expect(calls).toEqual([]);
  expect(switched).toBe(1);
  // Still refused, and announced only once.
  await expect(settleShare(41)).rejects.toMatchObject({ accountSwitched: true });
  expect(calls).toEqual([]);
  expect(switched).toBe(1);
});

test('the tab hears about the switch the moment the other tab signs in', async () => {
  await signInAs(AVA);
  otherTabStores(tokenFor(BEN));
  expect(switched).toBe(1);
  expect(storedSessionIsThisTabs()).toBe(false);
});

test('a sign-out in the other tab is a switch too, and the tab does not carry on without a token', async () => {
  await signInAs(AVA);
  otherTabStores(null);
  expect(switched).toBe(1);
  serve({ '/api/billing/41/settle': () => jsonRes({ settled: true }) });
  await expect(settleShare(41)).rejects.toMatchObject({ accountSwitched: true });
  expect(calls).toEqual([]);
});

test('a renewal of the same account in the other tab is not a switch', async () => {
  const signedInAt = nowS() - 3600;
  const first = tokenFor(AVA, signedInAt);
  serve({ '/api/auth/login': () => jsonRes({ token: first, refreshToken: 'R1', user: { id: AVA } }) });
  await login('ava@example.com', 'pw');

  const renewed = tokenFor(AVA, signedInAt);
  otherTabStores(renewed);
  expect(switched).toBe(0);

  // The same person signing in again over there is still this tab's person.
  const again = tokenFor(AVA, nowS());
  otherTabStores(again);
  expect(switched).toBe(0);

  serve({ '/api/billing/41/settle': (c) => jsonRes({ settled: true, sentWith: c.auth }) });
  const res = await settleShare(41);
  expect(res.sentWith).toBe(`Bearer ${again}`);
});

test('the photo upload is refused the same way', async () => {
  await signInAs(AVA);
  window.localStorage.setItem('flockToken', tokenFor(BEN));
  serve({ '/api/users/upload-image': () => jsonRes({ profile_image_url: 'x' }) });
  await expect(uploadProfileImage(new Blob(['x'], { type: 'image/png' }))).rejects.toMatchObject({ accountSwitched: true });
  expect(calls).toEqual([]);
});

test('signing out of a replaced tab leaves the other account signed in', async () => {
  await signInAs(AVA);
  const ben = tokenFor(BEN);
  window.localStorage.setItem('flockToken', ben);
  window.localStorage.setItem('flockRefreshToken', 'R-ben');
  serve({ '/api/auth/logout': () => jsonRes({ ok: true }) });

  await logout();

  // Ben's refresh credential was not sent to be retired, and Ben's session is
  // still on the device for the tab that holds it.
  expect(calls).toEqual([]);
  expect(window.localStorage.getItem('flockToken')).toBe(ben);
  expect(window.localStorage.getItem('flockRefreshToken')).toBe('R-ben');
  expect(switched).toBe(1);
});

test('a sign-out and a new sign-in in this same tab are this tab\'s own, and are served', async () => {
  await signInAs(AVA);
  serve({ '/api/auth/logout': () => jsonRes({ ok: true }) });
  await logout();
  const ben = await signInAs(BEN);
  serve({ '/api/billing/41/settle': (c) => jsonRes({ settled: true, sentWith: c.auth }) });
  const res = await settleShare(41);
  expect(res.sentWith).toBe(`Bearer ${ben}`);
  expect(switched).toBe(0);
});

test('the socket is never dialled with the other account\'s token', async () => {
  await signInAs(AVA);
  const before = io.__instances.length;
  window.localStorage.setItem('flockToken', tokenFor(BEN));
  expect(socketApi.connectSocket()).toBeNull();
  expect(socketApi.reconnectSocket()).toBeNull();
  expect(io.__instances.length).toBe(before);
});

test('the app reloads on the switch rather than signing the other account out', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  expect(app).toContain("const onAccountSwitched = () => { window.location.reload(); };");
  expect(app).toContain("window.addEventListener('flock-account-switched', onAccountSwitched);");
  expect(app).toContain("window.removeEventListener('flock-account-switched', onAccountSwitched);");
});
