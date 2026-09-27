/**
 * THE CLIENT HALF OF SESSION RENEWAL (services/api.js, RENEWING THE SESSION).
 *
 * The access token lives a day and nothing used to renew it, so every user was
 * signed out a day after signing in: GET /api/auth/me answered 401 at the next
 * launch and api.js ended the session, or the socket was cut mid-chat. The
 * server now hands out a refresh credential at sign-in and POST
 * /api/auth/refresh trades it for a new access token
 * (backend/__tests__/sessionRenewal.test.js holds that side). This file holds
 * the client to its half:
 *
 *   - a request made on a token that has run out renews first, and goes out on
 *     the new token, instead of ending the session;
 *   - a 401 "Token expired" is renewed once and the request sent again, writes
 *     included, because authenticate turned the first one away unrun;
 *   - only a renewal the SERVER refuses ends the session, and it ends it
 *     exactly the way a dead token always did; a renewal the network ate keeps
 *     the session;
 *   - requests racing past one expiry share one renewal;
 *   - sign-in stores both halves, sign-out sends the credential to be retired
 *     and wipes it, and sign-out never renews, because a renewal answered after
 *     the wipe would put a session back on the device;
 *   - the socket re-dials with a renewed token for the same sign-in, keeping
 *     its instance and so its rooms, and ignores a token from another sign-in.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

import { getCurrentUser, login, logout, blockUser, renewSession } from '../services/api';
import * as socketApi from '../services/socket';
import { io } from 'socket.io-client';

// A plain function, NOT jest.fn(impl): CRA sets resetMocks: true, which strips
// implementations off every jest.fn between tests.
jest.mock('socket.io-client', () => {
  const mockInstances = [];
  function mockIo(_url, opts) {
    const handlers = {};
    const inst = {
      auth: opts && opts.auth,
      connected: true,
      active: true,
      on: (event, cb) => { (handlers[event] = handlers[event] || []).push(cb); },
      off: () => {},
      emit: () => {},
      connectCalls: 0,
      disconnectCalls: 0,
      connect() { inst.connectCalls += 1; },
      disconnect() { inst.disconnectCalls += 1; },
      removeAllListeners: () => {},
    };
    mockInstances.push(inst);
    return inst;
  }
  mockIo.__instances = mockInstances;
  return { io: mockIo };
});

// --- tokens ------------------------------------------------------------------

// The client never verifies a signature; it only reads the claims to know when
// the token runs out and which sign-in it belongs to.
const b64url = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwtOf = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const nowS = () => Math.floor(Date.now() / 1000);
const SIGNED_IN = nowS() - 3 * 86400;

// A day-long token for user 7's sign-in, issued `ageS` seconds ago.
const tokenAged = (ageS, extra = {}) => {
  const iat = nowS() - ageS;
  return jwtOf({ userId: 7, tv: 0, auth_time: SIGNED_IN, iat, exp: iat + 86400, ...extra });
};

function holdSession(token, refreshToken, ageS) {
  window.localStorage.setItem('flockToken', token);
  window.localStorage.setItem('flockTokenReceivedAt', String(Date.now() - ageS * 1000));
  if (refreshToken) window.localStorage.setItem('flockRefreshToken', refreshToken);
}

// --- responses ---------------------------------------------------------------

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    text: async () => JSON.stringify(body),
  };
}

// Route each call by path, and keep the log of what was asked, in order.
let calls;
function serve(routes) {
  calls = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const call = {
      path,
      method: (init.method || 'GET').toUpperCase(),
      auth: init.headers && init.headers.Authorization,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = routes[path];
    if (!handler) throw new Error(`unexpected fetch ${path}`);
    return handler(call, calls.filter((c) => c.path === path).length);
  });
}

let expiredEvents;
let refreshedEvents;
const onExpired = () => { expiredEvents += 1; };
const onRefreshed = () => { refreshedEvents += 1; };

beforeEach(() => {
  window.localStorage.clear();
  expiredEvents = 0;
  refreshedEvents = 0;
  window.addEventListener('flock-session-expired', onExpired);
  window.addEventListener('flock-token-refreshed', onRefreshed);
});

afterEach(() => {
  window.removeEventListener('flock-session-expired', onExpired);
  window.removeEventListener('flock-token-refreshed', onRefreshed);
  socketApi.disconnectSocket();
});

// --- the tests ---------------------------------------------------------------

test('opening the app a day later renews the session instead of ending it', async () => {
  const stale = tokenAged(25 * 3600);
  const fresh = tokenAged(0);
  holdSession(stale, 'R1', 25 * 3600);
  serve({
    '/api/auth/refresh': () => jsonRes({ token: fresh, refreshToken: 'R2' }),
    '/api/auth/me': (c) => jsonRes({ user: { id: 7, sentWith: c.auth } }),
  });

  const data = await getCurrentUser();

  expect(calls.map((c) => c.path)).toEqual(['/api/auth/refresh', '/api/auth/me']);
  expect(calls[0].body).toEqual({ refreshToken: 'R1' });
  // Renewing is not a signed-in call: the expired token is not sent to it.
  expect(calls[0].auth).toBeUndefined();
  expect(data.user.sentWith).toBe(`Bearer ${fresh}`);
  expect(window.localStorage.getItem('flockToken')).toBe(fresh);
  expect(window.localStorage.getItem('flockRefreshToken')).toBe('R2');
  expect(expiredEvents).toBe(0);
  expect(refreshedEvents).toBe(1);
});

test('a token with hours left is used as it is, with no renewal in front of it', async () => {
  const token = tokenAged(3600);
  holdSession(token, 'R1', 3600);
  serve({ '/api/auth/me': () => jsonRes({ user: { id: 7 } }) });
  await getCurrentUser();
  expect(calls.map((c) => c.path)).toEqual(['/api/auth/me']);
  expect(calls[0].auth).toBe(`Bearer ${token}`);
});

test('a 401 "Token expired" is renewed once and the write sent again', async () => {
  // The device thinks the token has hours left (its clock is off, say); the
  // server says it has run out. authenticate refused the request before any
  // handler ran, so sending the block again is not a duplicate block.
  const token = tokenAged(3600);
  const fresh = tokenAged(0);
  holdSession(token, 'R1', 3600);
  serve({
    '/api/blocks/5': (c, n) => (n === 1
      ? jsonRes({ error: 'Token expired' }, 401)
      : jsonRes({ blocked: true, sentWith: c.auth })),
    '/api/auth/refresh': () => jsonRes({ token: fresh, refreshToken: 'R2' }),
  });

  const res = await blockUser(5);

  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    'POST /api/blocks/5', 'POST /api/auth/refresh', 'POST /api/blocks/5',
  ]);
  expect(res.sentWith).toBe(`Bearer ${fresh}`);
  expect(expiredEvents).toBe(0);
});

test('a renewal the server refuses ends the session the way a dead token always did', async () => {
  holdSession(tokenAged(25 * 3600), 'R1', 25 * 3600);
  serve({
    '/api/auth/refresh': () => jsonRes({ error: 'Session expired, please sign in again' }, 401),
    '/api/auth/me': () => jsonRes({ error: 'Token expired' }, 401),
  });

  await expect(getCurrentUser()).rejects.toMatchObject({ status: 401, sessionExpired: true });
  // One renewal, not one per attempt: the refused credential is forgotten.
  expect(calls.filter((c) => c.path === '/api/auth/refresh')).toHaveLength(1);
  expect(window.localStorage.getItem('flockToken')).toBeNull();
  expect(window.localStorage.getItem('flockRefreshToken')).toBeNull();
  expect(expiredEvents).toBe(1);
});

test('a renewal the network ate keeps the session, and the caller hears a network error', async () => {
  const stale = tokenAged(25 * 3600);
  holdSession(stale, 'R1', 25 * 3600);
  serve({
    '/api/auth/refresh': () => { throw new TypeError('Failed to fetch'); },
    '/api/auth/me': () => jsonRes({ error: 'Token expired' }, 401),
  });

  await expect(getCurrentUser()).rejects.toMatchObject({ isNetworkError: true });
  // Nothing was sent on a token that could only earn the 401 that ends it.
  expect(calls.map((c) => c.path)).toEqual(['/api/auth/refresh']);
  expect(window.localStorage.getItem('flockToken')).toBe(stale);
  expect(window.localStorage.getItem('flockRefreshToken')).toBe('R1');
  expect(expiredEvents).toBe(0);
});

test('requests racing past one expiry share one renewal', async () => {
  holdSession(tokenAged(25 * 3600), 'R1', 25 * 3600);
  const fresh = tokenAged(0);
  serve({
    '/api/auth/refresh': () => jsonRes({ token: fresh, refreshToken: 'R2' }),
    '/api/auth/me': () => jsonRes({ user: { id: 7 } }),
    '/api/blocks/5': () => jsonRes({ blocked: true }),
  });
  await Promise.all([getCurrentUser(), blockUser(5), getCurrentUser()]);
  expect(calls.filter((c) => c.path === '/api/auth/refresh')).toHaveLength(1);
});

test('a sign-in stores both halves of the session, and sign-out retires and wipes them without renewing', async () => {
  const token = tokenAged(0);
  serve({
    '/api/auth/login': () => jsonRes({ token, refreshToken: 'R1', user: { id: 7 } }),
    '/api/auth/logout': () => jsonRes({ message: 'Logged out successfully' }),
  });
  await login('ava@example.com', 'Password1');
  expect(window.localStorage.getItem('flockToken')).toBe(token);
  expect(window.localStorage.getItem('flockRefreshToken')).toBe('R1');

  // A day passes. Signing out must not renew first: the renewal would be
  // answered after the wipe below and write a session back onto the device.
  window.localStorage.setItem('flockTokenReceivedAt', String(Date.now() - 25 * 3600 * 1000));
  calls.length = 0;
  await logout();

  expect(calls.map((c) => c.path)).toEqual(['/api/auth/logout']);
  expect(calls[0].body).toEqual({ refreshToken: 'R1' });
  expect(window.localStorage.getItem('flockToken')).toBeNull();
  expect(window.localStorage.getItem('flockRefreshToken')).toBeNull();
  expect(window.localStorage.getItem('flockTokenReceivedAt')).toBeNull();
});

test('a sign-in that returns no refresh credential leaves none behind from before', async () => {
  window.localStorage.setItem('flockRefreshToken', 'previous-account-credential');
  serve({ '/api/auth/login': () => jsonRes({ token: tokenAged(0), user: { id: 8 } }) });
  await login('bea@example.com', 'Password1');
  expect(window.localStorage.getItem('flockRefreshToken')).toBeNull();
});

test('the socket re-dials with a renewed token for the same sign-in, keeping its instance and rooms', async () => {
  const token = tokenAged(20 * 3600);
  holdSession(token, 'R1', 20 * 3600);
  socketApi.connectSocket();
  const instances = io.__instances;
  const before = instances.length;
  const sock = instances[instances.length - 1];
  expect(sock.auth.token).toBe(token);

  const fresh = tokenAged(0);
  serve({ '/api/auth/refresh': () => jsonRes({ token: fresh, refreshToken: 'R2' }) });
  await expect(renewSession()).resolves.toBe('ok');

  // Same instance, so the subscription and room registries carry over and the
  // 'connect' handler replays the rooms; the handshake now carries the new token.
  expect(instances.length).toBe(before);
  expect(sock.auth.token).toBe(fresh);
  expect(sock.disconnectCalls).toBe(1);
  expect(sock.connectCalls).toBe(1);

  // A token from a different sign-in arriving on the same event is not a
  // renewal, and is left for connectSocket to treat as an account switch.
  window.localStorage.setItem('flockToken', jwtOf({ userId: 8, tv: 0, auth_time: nowS(), iat: nowS(), exp: nowS() + 86400 }));
  window.dispatchEvent(new CustomEvent('flock-token-refreshed'));
  expect(sock.auth.token).toBe(fresh);
  expect(sock.connectCalls).toBe(1);
});
