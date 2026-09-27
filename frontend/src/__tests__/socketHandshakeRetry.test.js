/**
 * A REFUSED HANDSHAKE IS DIALLED AGAIN (services/socket.js, NOBODY ELSE
 * RETRIES A REFUSED HANDSHAKE).
 *
 * When the server's socket middleware refuses a handshake, socket.io-client
 * destroys the socket and switches its manager's reconnection off: `active`
 * goes false and no retry is ever scheduled. backend/__tests__/
 * socketHandshakeRetry.test.js proves that against the real library and a real
 * server. services/socket.js was written as if the library kept retrying, so
 * one database blip during a handshake, or one refusal from the per-IP limiter
 * during a venue-wide reconnect burst, left a foreground app with no live chat
 * until it was backgrounded.
 *
 * What this file holds the client to:
 *   - a transient refusal (the server's "busy" answer, the limiter) is dialled
 *     again on a backoff that grows, and a connect restores the base delay;
 *   - a dead credential is tried until its three strikes and then left alone;
 *   - a transport failure is left to the library's own loop, not doubled;
 *   - a retry never dials a socket that was replaced or signed out, or a
 *     document that is hidden.
 *
 * The mock stands in for socket.io-client and does what the real one does on
 * each path: a refusal clears `active` before connect_error fires, a transport
 * failure leaves it set.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern socketHandshakeRetry
 */

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
      connected: false,
      active: true,
      on: (event, cb) => { (handlers[event] = handlers[event] || []).push(cb); },
      off: () => {},
      emit: () => {},
      connectCalls: 0,
      disconnectCalls: 0,
      connect() { inst.connectCalls += 1; inst.active = true; },
      disconnect() { inst.disconnectCalls += 1; inst.active = false; inst.connected = false; },
      removeAllListeners: () => {},
      fire(event, ...args) { (handlers[event] || []).forEach((cb) => cb(...args)); },
    };
    mockInstances.push(inst);
    return inst;
  }
  mockIo.__instances = mockInstances;
  return { io: mockIo };
});

const BUSY = 'Server busy, try again shortly'; // backend/middleware/auth.js SOCKET_RETRYABLE_MESSAGE
const LIMITED = 'Too many connections, please try again later'; // backend/server.js per-IP limiter

// What the real library does with a CONNECT_ERROR packet: destroy() first, so
// `active` is already false when connect_error reaches the listener.
function refuse(inst, message, data) {
  inst.active = false;
  inst.connected = false;
  const err = new Error(message);
  if (data) err.data = data;
  inst.fire('connect_error', err);
}

function connectFresh() {
  window.localStorage.setItem('flockToken', 'token-A');
  const inst = socketApi.connectSocket();
  expect(inst).toBe(io.__instances[io.__instances.length - 1]);
  return inst;
}

function setHidden(hidden) {
  if (hidden) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  } else {
    delete document.visibilityState;
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  window.localStorage.clear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  socketApi.disconnectSocket();
  setHidden(false);
  jest.useRealTimers();
  console.warn.mockRestore();
});

test('a handshake the server was too busy to check is dialled again, on a backoff that grows', () => {
  const inst = connectFresh();

  refuse(inst, BUSY, { retryable: true });
  // First delay: 1s, randomised by half either way.
  jest.advanceTimersByTime(499);
  expect(inst.connectCalls).toBe(0);
  jest.advanceTimersByTime(1001);
  expect(inst.connectCalls).toBe(1);

  // Second: 2s, so never sooner than 1s.
  refuse(inst, BUSY, { retryable: true });
  jest.advanceTimersByTime(999);
  expect(inst.connectCalls).toBe(1);
  jest.advanceTimersByTime(2001);
  expect(inst.connectCalls).toBe(2);

  // However many times it is busy, it is never mistaken for a dead credential.
  for (let i = 0; i < 6; i += 1) {
    refuse(inst, BUSY, { retryable: true });
    jest.advanceTimersByTime(45000);
  }
  expect(inst.connectCalls).toBe(8);
  expect(inst.disconnectCalls).toBe(0);
  expect(socketApi.getSocket()).toBe(inst);

  // A connect puts the backoff back to its base.
  inst.connected = true;
  inst.active = true;
  inst.fire('connect');
  refuse(inst, BUSY, { retryable: true });
  jest.advanceTimersByTime(1500);
  expect(inst.connectCalls).toBe(9);
});

test('the per-IP limiter turning a handshake away is retried too', () => {
  const inst = connectFresh();
  refuse(inst, LIMITED);
  jest.advanceTimersByTime(1500);
  expect(inst.connectCalls).toBe(1);
});

test('a dead credential is tried until its third strike, then left alone', () => {
  const inst = connectFresh();

  refuse(inst, 'Session expired');
  jest.advanceTimersByTime(1500);
  expect(inst.connectCalls).toBe(1);

  refuse(inst, 'Session expired');
  jest.advanceTimersByTime(3000);
  expect(inst.connectCalls).toBe(2);

  refuse(inst, 'Session expired');
  expect(inst.disconnectCalls).toBe(1);
  jest.advanceTimersByTime(120000);
  expect(inst.connectCalls).toBe(2);

  // An explicit reconnect (a fresh sign-in, the tab coming back) still gets a
  // new connection rather than the one that gave up.
  socketApi.reconnectSocket();
  expect(io.__instances[io.__instances.length - 1]).not.toBe(inst);
});

test('a transport failure is left to the library, which is still retrying it', () => {
  const inst = connectFresh();
  // No destroy() on this path: the manager's own reconnect loop is running.
  inst.fire('connect_error', new Error('websocket error'));
  jest.advanceTimersByTime(120000);
  expect(inst.connectCalls).toBe(0);
});

test('a retry set before a sign-out does not dial the socket that was signed out', () => {
  const inst = connectFresh();
  refuse(inst, BUSY, { retryable: true });
  socketApi.disconnectSocket();
  const disconnectsAtSignOut = inst.disconnectCalls;
  jest.advanceTimersByTime(120000);
  expect(inst.connectCalls).toBe(0);
  expect(inst.disconnectCalls).toBe(disconnectsAtSignOut);
});

test('a hidden document is not dialled by the retry; coming back to it is what dials', () => {
  const inst = connectFresh();
  refuse(inst, BUSY, { retryable: true });
  setHidden(true);
  jest.advanceTimersByTime(120000);
  expect(inst.connectCalls).toBe(0);

  setHidden(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(inst.connectCalls).toBe(1);
});
