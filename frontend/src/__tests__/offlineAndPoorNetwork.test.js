/**
 * Offline and poor-network behaviour: what a person on a dying connection
 * actually experiences.
 *
 * Flock is used in bars, basements and moving trains, on phones, at night. Bad
 * signal is the normal operating condition here, not the edge case, and the
 * failures worth pinning are the quiet ones: a request that never settles, a
 * spinner with no end, a screen that cannot tell "slow" from "gone".
 *
 * THE DEFECT THIS FILE WAS WRITTEN FOR. fetch() resolves as soon as the status
 * line and headers arrive; the body is still on the wire at that moment. The
 * client used to clear its abort timer at exactly that point, so every byte
 * after the headers was downloaded with no deadline and no live abort signal.
 * A reply that started and then stopped (a cellular handoff, a venue router
 * that opens a socket and drops it, a proxy that dies after flushing headers)
 * left the caller's promise pending until the OS gave the socket up, which is
 * minutes. No error, no timeout, no rollback, and the caller's finally block
 * never ran, so the spinner stayed on screen forever.
 *
 * The rule these tests hold the client to: what ends a request is SILENCE, not
 * slowness. A download that is merely slow keeps its leash for as long as it
 * keeps arriving, because a flock's chat history carries photos and can
 * honestly take a while on 2G. A download that has stopped moving settles as a
 * timeout the caller can read and the screen can say out loud.
 *
 * Also pinned here, on the socket side: a hidden tab that has released its
 * connection stays released. 'online' fires on any network change, whether or
 * not anybody is looking at the app, and dialling back for a document nobody
 * can see undoes the release and never schedules another one.
 */

import request, { uploadProfileImage } from '../services/api';
import { voteForVenue } from '../services/api';
import * as socketApi from '../services/socket';
import { io } from 'socket.io-client';

// jsdom does not carry these; the streaming reader in api.js needs both.
// Required before any test touches a body, not before the import: api.js
// reaches for TextDecoder at call time.
const nodeUtil = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = nodeUtil.TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = nodeUtil.TextDecoder;

// A plain function, NOT jest.fn(impl): CRA sets resetMocks: true, which strips
// implementations off every jest.fn between tests, and an io() that returns
// undefined crashes createSocket.
jest.mock('socket.io-client', () => {
  const mockInstances = [];
  function mockIo() {
    const handlers = {};
    const inst = {
      connected: false,
      active: false,
      on: (event, cb) => { (handlers[event] = handlers[event] || []).push(cb); },
      off: () => {},
      emit: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      removeAllListeners: jest.fn(),
      _fire: (event, ...args) => (handlers[event] || []).forEach((cb) => cb(...args)),
    };
    mockInstances.push(inst);
    return inst;
  }
  mockIo.__instances = mockInstances;
  return { io: mockIo };
});

// --- a Response whose body arrives in pieces --------------------------------
//
// The mocks in apiClientResilience.test.js deliberately expose only json()/
// text(), which is the whole-body-at-once path. Everything here is about what
// happens BETWEEN the headers and the last byte, so these carry a real
// ReadableStream-shaped `body` instead.
function streamingRes({ status = 200, contentType = 'application/json', chunks = [], gapMs = 0, stallAfter = null, signal }) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => { throw new Error('these tests read the body as a stream'); },
    text: async () => chunks.join(''),
    body: {
      getReader: () => ({
        read: () => {
          if (stallAfter !== null && index >= stallAfter) {
            // The connection is open and answering nothing. The only way out
            // is the deadline, which is exactly what is under test.
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
              });
            });
          }
          if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
          const value = encoder.encode(chunks[index]);
          index += 1;
          if (!gapMs) return Promise.resolve({ done: false, value });
          return new Promise((resolve, reject) => {
            // Honour the deadline here too: if it fires mid-gap the read must
            // reject, so a lost rearm shows up as a failing assertion rather
            // than as a test that hangs.
            signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
            });
            setTimeout(() => resolve({ done: false, value }), gapMs);
          });
        },
      }),
    },
  };
}

function setOnline(value) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

beforeEach(() => {
  global.fetch = jest.fn();
  localStorage.clear();
  setOnline(true);
  setVisibility('visible');
});

afterEach(() => {
  socketApi.disconnectSocket();
});

// --- the reply that starts and then stops -----------------------------------

describe('a body that stalls after the headers arrive', () => {
  test('a GET settles as a timeout instead of hanging on the spinner forever', async () => {
    global.fetch.mockImplementation((url, opts) => Promise.resolve(streamingRes({
      chunks: ['{"blocked":'],
      stallAfter: 1, // one chunk lands, then the connection goes quiet
      signal: opts.signal,
    })));
    const err = await rejection(request('/api/blocks', { timeout: 60 }));
    expect(err.isTimeout).toBe(true);
    expect(err.isNetworkError).toBe(true);
    // A timeout costs its whole budget already; re-running one stacks spinner.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('the copy says what happened and what to do, and never blames the user', async () => {
    global.fetch.mockImplementation((url, opts) => Promise.resolve(streamingRes({
      chunks: ['{'],
      stallAfter: 1,
      signal: opts.signal,
    })));
    const err = await rejection(request('/api/blocks', { timeout: 60 }));
    expect(err.message).toMatch(/took too long/i);
    expect(err.message).toMatch(/signal/i);
    expect(err.message).not.toMatch(/\u2014/); // no em dash in user-visible copy
  });

  test('a write is never replayed when its reply stalls, so nothing double-posts', async () => {
    global.fetch.mockImplementation((url, opts) => Promise.resolve(streamingRes({
      chunks: ['{"vote":'],
      stallAfter: 1,
      signal: opts.signal,
    })));
    const err = await rejection(request('/api/flocks/1/vote', {
      method: 'POST',
      timeout: 60,
      body: JSON.stringify({ venue_name: 'The Basement' }),
    }));
    expect(err.isTimeout).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a photo upload gets the same deadline, not an open-ended one', async () => {
    global.fetch.mockImplementation((url, opts) => Promise.resolve(streamingRes({
      chunks: ['{"url":'],
      stallAfter: 1,
      signal: opts.signal,
    })));
    localStorage.setItem('flockToken', 'tok');
    const file = new File(['x'], 'me.png', { type: 'image/png' });
    // uploadProfileImage runs outside request() (multipart), so it has to be
    // proven separately. Its own leash is 90s, which no test should sit
    // through; what matters is that the promise settles at all, and it only
    // can if the deadline survives the headers. jest's own 5s timeout is the
    // backstop that would catch a regression here.
    jest.useFakeTimers();
    const pending = rejection(uploadProfileImage(file));
    // Let the fetch resolve and the reader register its abort listener before
    // the clock moves. Advancing first would fire the pre-headers deadline
    // against a request that has already answered.
    for (let i = 0; i < 50; i += 1) await Promise.resolve(); // eslint-disable-line no-await-in-loop
    jest.advanceTimersByTime(95000);
    const err = await pending;
    jest.useRealTimers();
    expect(err.isTimeout).toBe(true);
  });
});

// --- slow is not the same as stopped ----------------------------------------

describe('a slow download is not a failed one', () => {
  test('a body arriving in pieces outlives the window, because every piece rearms it', async () => {
    const payload = JSON.stringify({ flocks: [{ id: 1, name: 'Friday' }] });
    // Eight chunks, 25ms apart: 200ms of wire time against a 400ms window
    // that no single gap comes close to. It only passes because the deadline
    // is rearmed on each chunk, which is the difference between punishing
    // slowness and ending silence.
    const chunks = payload.match(/[\s\S]{1,8}/g);
    global.fetch.mockImplementation((url, opts) => Promise.resolve(streamingRes({
      chunks,
      gapMs: 25,
      signal: opts.signal,
    })));
    const data = await request('/api/flocks', { timeout: 400 });
    expect(data).toEqual({ flocks: [{ id: 1, name: 'Friday' }] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  }, 10000);

  test('a trickle cannot hold a request open for as long as it likes', async () => {
    // THE OTHER SIDE OF THE REARM. A deadline that every chunk pushes back is
    // not a bound on anything: a reply that dribbles one byte just inside the
    // window, forever, is "progress" by that rule. The promise never settles,
    // the spinner never ends, and readBodyText concatenates every byte of it,
    // so the tab's memory goes the same way the request did. That is the exact
    // failure this file exists for, arrived at from the opposite direction.
    //
    // So under the idle window there is an absolute ceiling that is never
    // rearmed, and the request dies on whichever fires first. Virtual time
    // here: chunks every ten seconds against a fifteen second idle window, so
    // no gap ever looks like silence and only the ceiling can end this.
    jest.useFakeTimers();
    const chunks = new Array(400).fill('x'); // never reaches the end
    global.fetch.mockImplementation((url, opts) => Promise.resolve(streamingRes({
      chunks,
      gapMs: 10000,
      signal: opts.signal,
    })));
    const pending = rejection(request('/api/flocks', { retry: false }));
    const settle = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); }; // eslint-disable-line no-await-in-loop
    await settle();
    // Ten minutes of wire time, all of it "moving".
    for (let i = 0; i < 60; i += 1) {
      jest.advanceTimersByTime(10000);
      await settle(); // eslint-disable-line no-await-in-loop
    }
    const err = await pending;
    jest.useRealTimers();
    expect(err.isTimeout).toBe(true);
    expect(err.isNetworkError).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  }, 15000);

  test('an upload that trickles is bounded too, on its own longer leash', async () => {
    // uploadProfileImage runs outside request(), so the ceiling has to reach it
    // through the shared helper rather than through the caller. Its idle window
    // is ninety seconds, which is longer than the ceiling would allow on its
    // own, and the ceiling is what ends this either way.
    jest.useFakeTimers();
    localStorage.setItem('flockToken', 'tok');
    global.fetch.mockImplementation((url, opts) => Promise.resolve(streamingRes({
      chunks: new Array(400).fill('y'),
      gapMs: 60000,
      signal: opts.signal,
    })));
    const file = new File(['x'], 'me.png', { type: 'image/png' });
    const pending = rejection(uploadProfileImage(file));
    const settle = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); }; // eslint-disable-line no-await-in-loop
    await settle();
    for (let i = 0; i < 20; i += 1) {
      jest.advanceTimersByTime(60000);
      await settle(); // eslint-disable-line no-await-in-loop
    }
    const err = await pending;
    jest.useRealTimers();
    expect(err.isTimeout).toBe(true);
  }, 15000);

  test('a name with an accent split across two chunks decodes whole, not mangled', async () => {
    // The photo case in miniature: multi-byte characters do not respect chunk
    // boundaries, and a non-streaming decode turns them into replacement
    // characters. A user called Chloé should not be renamed by bad signal.
    const payload = JSON.stringify({ user: { name: 'Chloé' } });
    const bytes = new TextEncoder().encode(payload);
    const split = payload.indexOf('é') + 1; // lands mid-character in bytes
    const decoder = new TextDecoder();
    const head = decoder.decode(bytes.slice(0, split), { stream: true });
    void head;
    global.fetch.mockImplementation((url, opts) => {
      const inst = streamingRes({ chunks: [], signal: opts.signal });
      let sent = 0;
      const parts = [bytes.slice(0, split), bytes.slice(split)];
      inst.body.getReader = () => ({
        read: () => {
          if (sent >= parts.length) return Promise.resolve({ done: true, value: undefined });
          const value = parts[sent];
          sent += 1;
          return Promise.resolve({ done: false, value });
        },
      });
      return Promise.resolve(inst);
    });
    const data = await request('/api/users/me');
    expect(data).toEqual({ user: { name: 'Chloé' } });
  });
});

// --- the device knowing it has no network -----------------------------------

describe('what the app can tell the user', () => {
  test('airplane mode is named as offline, separately from a server problem', async () => {
    setOnline(false);
    const err = await rejection(request('/api/flocks'));
    expect(err.isOffline).toBe(true);
    expect(err.message).toMatch(/offline/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a connection that dies while the device believes it is online reads differently', async () => {
    global.fetch.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = await rejection(voteForVenue(1, 'The Basement'));
    expect(err.isOffline).toBeUndefined();
    expect(err.isNetworkError).toBe(true);
    expect(err.message).toMatch(/reach Flock/i);
    // Three distinct sentences for three distinct situations. One shared
    // "something went wrong" is what makes a bad connection feel like a broken
    // app.
    expect(err.message).not.toMatch(/took too long/i);
  });

  test('every network error carries a flag a screen can branch on, never just prose', async () => {
    global.fetch.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = await rejection(request('/api/flocks', { retry: false }));
    expect(err.isNetworkError).toBe(true);
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });
});

// --- the socket, once the tab is out of sight -------------------------------

describe('a hidden document stays released', () => {
  test("'online' does not dial a connection back for a tab nobody is looking at", () => {
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();
    instance.connected = false;
    instance.active = false;

    setVisibility('hidden');
    window.dispatchEvent(new Event('online'));

    // Reconnecting here would rebuild exactly the connection the hidden-tab
    // release gave up, and nothing would ever release it again: the only thing
    // that schedules a release is a visibilitychange INTO hidden, which cannot
    // fire while the tab is already hidden.
    expect(instance.connect).not.toHaveBeenCalled();
  });

  test('coming back to the tab does reconnect, and the rooms come with it', () => {
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();
    socketApi.joinFlock(7);
    instance.connected = true;
    instance._fire('connect');
    instance.emit.mockClear();

    instance.connected = false;
    instance.active = false;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instance.connect).toHaveBeenCalled();

    // The chat the user left open is re-entered, so it does not sit there
    // looking healthy while receiving nothing.
    instance.connected = true;
    instance._fire('connect');
    expect(instance.emit).toHaveBeenCalledWith('join_flock', 7);
  });

  test('a message the socket could not send says so, rather than reporting success', () => {
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();
    instance.connected = false;
    // The caller uses this answer to fall back to HTTP. A silent no-op here is
    // how a message got typed, shown, and delivered to nobody.
    expect(socketApi.sendMessage(7, 'we still going?')).toBe(false);
    expect(instance.emit).not.toHaveBeenCalled();
  });
});
