/**
 * API client resilience — the offline / retry / timeout / captive-portal
 * behavior that decides whether Flock feels solid or broken on venue wifi.
 *
 * The one failure mode worth naming: a captive portal (venue wifi with a
 * sign-in page) answers EVERY request with 200 OK and its own HTML login
 * page. Before the guard these tests pin, that HTML was handed to callers as
 * if it were data, and the crash happened later, deep in App.js, as a
 * TypeError on a property read. The contract now: a 2xx that is not JSON on a
 * JSON API is a network failure, thrown with err.isNetworkError (and
 * err.isCaptivePortal), never returned and never surfaced as a SyntaxError.
 *
 * Retry policy pinned here:
 *   - GETs get up to two retries with backoff on fast network failures,
 *     502/503/504, and truncated bodies.
 *   - Timeouts are never retried (one already cost the full budget).
 *   - Captive-portal responses are never retried (deterministic).
 *   - Writes are never retried, full stop: a replayed POST double-posts.
 */

import request, { getBlockedUsers, uploadProfileImage } from '../services/api';
import { voteForVenue } from '../services/api';
import { queueSync, pullSettings } from '../services/userSettings';
import * as socketApi from '../services/socket';
import { io } from 'socket.io-client';

const fs = require('fs');
const path = require('path');

// A plain function, NOT jest.fn(impl): CRA sets resetMocks: true, which
// strips implementations off every jest.fn between tests, and an io() that
// returns undefined crashes createSocket.
jest.mock('socket.io-client', () => {
  const mockInstances = [];
  function mockIo() {
    const handlers = {};
    const inst = {
      connected: false,
      active: true,
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

// --- response builders -----------------------------------------------------

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// What a captive portal actually sends back: 200, text/html, a login page.
function portalRes(status = 200) {
  const html = '<html><head><title>Venue Guest WiFi</title></head><body>Sign in to browse</body></html>';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    json: async () => { throw new SyntaxError('Unexpected token <'); },
    text: async () => html,
  };
}

// A 2xx whose declared-JSON body died mid-download.
function truncatedRes(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    text: async () => { throw new TypeError('network error'); },
  };
}

function netFail() {
  return Promise.reject(new TypeError('Failed to fetch'));
}

function setOnline(value) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
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
});

afterEach(() => {
  socketApi.disconnectSocket();
});

// --- captive portal: THE venue-app failure mode ----------------------------

describe('captive portal (200 OK that is not JSON)', () => {
  test('a GET rejects as a network failure, is not retried, and never leaks HTML', async () => {
    global.fetch.mockResolvedValue(portalRes());
    const err = await rejection(getBlockedUsers());
    expect(err.isNetworkError).toBe(true);
    expect(err.isCaptivePortal).toBe(true);
    expect(err.message).not.toContain('<');
    // Deterministic response: retrying a portal buys nothing but spinner time.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a write rejects the same way, exactly once', async () => {
    global.fetch.mockResolvedValue(portalRes());
    const err = await rejection(voteForVenue(1, 'The Basement'));
    expect(err.isCaptivePortal).toBe(true);
    expect(err.isNetworkError).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('uploadProfileImage (multipart, outside request()) gets the same guard', async () => {
    global.fetch.mockResolvedValue(portalRes());
    const file = new File(['x'], 'me.png', { type: 'image/png' });
    const err = await rejection(uploadProfileImage(file));
    expect(err.isCaptivePortal).toBe(true);
    expect(err.isNetworkError).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// --- truncated JSON on a 2xx -----------------------------------------------

describe('2xx with a JSON body that could not be read', () => {
  test('a GET retries the blip and succeeds on the second attempt', async () => {
    global.fetch
      .mockResolvedValueOnce(truncatedRes())
      .mockResolvedValueOnce(jsonRes({ blocked: [] }));
    const data = await getBlockedUsers();
    expect(data).toEqual({ blocked: [] });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  test('a GET gives up after two retries with a network error, never a SyntaxError or null', async () => {
    global.fetch.mockResolvedValue(truncatedRes());
    const err = await rejection(getBlockedUsers());
    expect(err.isNetworkError).toBe(true);
    expect(err.isBadReply).toBe(true);
    expect(err.name).not.toBe('SyntaxError');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 10000);

  test('a write is never replayed, and the copy warns it may have gone through', async () => {
    global.fetch.mockResolvedValue(truncatedRes());
    const err = await rejection(voteForVenue(1, 'The Basement'));
    expect(err.isNetworkError).toBe(true);
    expect(err.isBadReply).toBe(true);
    expect(err.message).toMatch(/may have gone through/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// --- retry policy on network failures and 5xx ------------------------------

describe('retry policy', () => {
  test('a GET survives two fast connection failures', async () => {
    global.fetch
      .mockImplementationOnce(netFail)
      .mockImplementationOnce(netFail)
      .mockResolvedValueOnce(jsonRes({ blocked: [] }));
    const data = await getBlockedUsers();
    expect(data).toEqual({ blocked: [] });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 10000);

  test('a GET retries gateway 503s and surfaces the friendly copy, not the HTML error page', async () => {
    global.fetch.mockResolvedValue(portalRes(503));
    const err = await rejection(getBlockedUsers());
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/servers are having a moment/i);
    expect(err.message).not.toContain('<');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 10000);

  test('a write is sent exactly once even on a 503', async () => {
    global.fetch.mockResolvedValue(jsonRes({ error: 'upstream' }, 503));
    const err = await rejection(voteForVenue(1, 'The Basement'));
    expect(err.status).toBe(503);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a write is sent exactly once on a network failure', async () => {
    global.fetch.mockImplementation(netFail);
    const err = await rejection(voteForVenue(1, 'The Basement'));
    expect(err.isNetworkError).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a 400 surfaces the server\'s own message with the status attached', async () => {
    global.fetch.mockResolvedValue(jsonRes({ error: 'Venue name required' }, 400));
    const err = await rejection(voteForVenue(1, ''));
    expect(err.message).toBe('Venue name required');
    expect(err.status).toBe(400);
  });
});

// --- offline and timeout ---------------------------------------------------

describe('offline and timeout', () => {
  test('airplane mode fails fast without touching the network', async () => {
    setOnline(false);
    const err = await rejection(getBlockedUsers());
    expect(err.isOffline).toBe(true);
    expect(err.isNetworkError).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a hung request settles as a timeout the caller can read, and is not retried', async () => {
    global.fetch.mockImplementation((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      });
    }));
    const err = await rejection(request('/api/blocks', { timeout: 40 }));
    expect(err.isTimeout).toBe(true);
    expect(err.isNetworkError).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// --- userSettings: the String(value) round-trip landmine -------------------

describe('userSettings sync', () => {
  test('server booleans land in localStorage as strings the readers can handle', async () => {
    localStorage.setItem('flockToken', 't');
    global.fetch.mockResolvedValue(jsonRes({
      settings: {
        locationEnabled: false, // stored as a real boolean server-side
        safetyOn: false,
        mapType: 'satellite',
        userInterests: ['Trivia'],
        pinnedFlockIds: [3],
      },
    }));
    const settings = await pullSettings();
    expect(settings).not.toBeNull();
    // The landmine: String(false) === 'false', which is truthy. The stored
    // value must be exactly 'false' so `!== 'false'` readers see "off".
    expect(localStorage.getItem('flock_location_enabled')).toBe('false');
    expect(localStorage.getItem('flock_safety_on')).toBe('false');
    expect(localStorage.getItem('flock_map_type')).toBe('satellite');
    // JSON keys round-trip as JSON, not as "[object Object]"-style strings.
    expect(JSON.parse(localStorage.getItem('flock_interests'))).toEqual(['Trivia']);
    expect(JSON.parse(localStorage.getItem('flock_pinned'))).toEqual([3]);
  });

  test('every App.js reader of a synced boolean compares against the string, never truthiness', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    // If one of these patterns disappears, a refactor changed how a synced
    // boolean is read. String(false) is 'false' and 'false' is truthy, so the
    // reader MUST compare against the string. Update the reader to keep the
    // comparison, then update this pin.
    expect(appSource).toContain("localStorage.getItem('flock_location_enabled') !== 'false'");
    expect(appSource).toContain("localStorage.getItem('flock_location_enabled') === 'false'");
    expect(appSource).toContain("localStorage.getItem('flock_safety_on') !== 'false'");
    expect(appSource).toContain("String(s.safetyOn) !== 'false'");
  });

  test('first-time sync pushes local settings up, including safetyOn and interests', async () => {
    localStorage.setItem('flockToken', 't');
    localStorage.setItem('flock_safety_on', 'false');
    localStorage.setItem('flock_interests', '["Sports"]');
    localStorage.setItem('flock_map_type', 'terrain');
    global.fetch
      .mockResolvedValueOnce(jsonRes({ settings: {} })) // GET: server empty
      .mockResolvedValueOnce(jsonRes({ settings: {} })); // PATCH echo
    await pullSettings();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [, patchOpts] = global.fetch.mock.calls[1];
    expect(patchOpts.method).toBe('PATCH');
    const pushed = JSON.parse(patchOpts.body);
    expect(pushed.safetyOn).toBe('false');
    expect(pushed.userInterests).toEqual(['Sports']);
    expect(pushed.mapType).toBe('terrain');
  });

  test('a sync lost to a dead spot is re-queued and flushed when the network returns', async () => {
    localStorage.setItem('flockToken', 't');
    global.fetch.mockImplementation(netFail);
    queueSync({ mapType: 'satellite' });
    await new Promise((r) => setTimeout(r, 750)); // debounce (600ms) + the failed PATCH
    expect(global.fetch).toHaveBeenCalledTimes(1);

    global.fetch.mockResolvedValue(jsonRes({ settings: { mapType: 'satellite' } }));
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 750));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [, opts] = global.fetch.mock.calls[1];
    expect(JSON.parse(opts.body)).toEqual({ mapType: 'satellite' });
  }, 10000);
});

// --- socket: room replay and send honesty ----------------------------------

describe('socket resilience', () => {
  test('joins recorded while disconnected replay on connect; leaves are forgotten even offline', () => {
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();
    expect(io.__instances.length).toBeGreaterThan(0);

    // Join while the handshake is still in flight: nothing emitted yet...
    socketApi.joinFlock(42);
    expect(instance.emit).not.toHaveBeenCalledWith('join_flock', 42);

    // ...but the intent replays the moment the connection lands.
    instance.connected = true;
    instance._fire('connect');
    expect(instance.emit).toHaveBeenCalledWith('join_flock', 42);

    // A leave is forgotten even if issued while the socket is down, so a
    // reconnect does not silently re-enter a chat the user closed.
    instance.connected = false;
    socketApi.leaveFlock(42);
    instance.emit.mockClear();
    instance.connected = true;
    instance._fire('connect');
    expect(instance.emit).not.toHaveBeenCalledWith('join_flock', 42);
  });

  test('a venue room outlives one screen leaving while another still holds it', () => {
    // `venue:{placeId}` is joined from two independent effects in App.js, the map
    // bottom sheet and the venue owner's dashboard, so a verified owner who taps
    // their own venue and then opens their dashboard holds one room twice. While
    // the registry was a Set the dashboard's cleanup emitted leave_venue and took
    // the id out of the replay registry, and the sheet behind it went quiet with
    // no symptom at all: its listeners were still registered, and the events were
    // addressed to a room this connection had just been removed from.
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();
    instance.connected = true;

    socketApi.joinVenueRoom('place-owned'); // the map bottom sheet
    socketApi.joinVenueRoom('place-owned'); // the owner dashboard, same venue

    instance.emit.mockClear();
    socketApi.leaveVenueRoom('place-owned'); // the dashboard closes
    expect(instance.emit).not.toHaveBeenCalledWith('leave_venue', { placeId: 'place-owned' });

    // Still held, so a reconnect puts the sheet back in the room rather than
    // leaving it listening to one this connection is no longer in.
    instance._fire('connect');
    expect(instance.emit).toHaveBeenCalledWith('join_venue', { placeId: 'place-owned' });

    // The last holder leaving is the one the server hears about.
    instance.emit.mockClear();
    socketApi.leaveVenueRoom('place-owned'); // the sheet closes
    expect(instance.emit).toHaveBeenCalledWith('leave_venue', { placeId: 'place-owned' });

    // And the id is gone from the replay registry, so nothing re-joins it.
    instance.emit.mockClear();
    instance._fire('connect');
    expect(instance.emit).not.toHaveBeenCalledWith('join_venue', { placeId: 'place-owned' });
  });

  test('a leave for a venue room this client never joined says nothing to the server', () => {
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();
    instance.connected = true;
    instance.emit.mockClear();
    socketApi.leaveVenueRoom('place-never-opened');
    expect(instance.emit).not.toHaveBeenCalled();
  });

  test('the venue content room counts its holders the same way the crowd room does', () => {
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();
    instance.connected = true;

    socketApi.joinVenueContentRoom('place-card');
    socketApi.joinVenueContentRoom('place-card');

    instance.emit.mockClear();
    socketApi.leaveVenueContentRoom('place-card');
    expect(instance.emit).not.toHaveBeenCalledWith('leave_venue_content', { placeId: 'place-card' });
    instance._fire('connect');
    expect(instance.emit).toHaveBeenCalledWith('join_venue_content', { placeId: 'place-card' });

    instance.emit.mockClear();
    socketApi.leaveVenueContentRoom('place-card');
    expect(instance.emit).toHaveBeenCalledWith('leave_venue_content', { placeId: 'place-card' });
  });

  test('sendMessage tells the truth about whether the emit happened', () => {
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();

    instance.connected = false;
    expect(socketApi.sendMessage(42, 'you here yet?')).toBe(false);

    instance.connected = true;
    expect(socketApi.sendMessage(42, 'you here yet?')).toBe(true);
    expect(instance.emit).toHaveBeenCalledWith('send_message', expect.objectContaining({
      flockId: 42,
      message_text: 'you here yet?',
    }));
  });

  test('dmVoteVenue tells the truth about whether the vote left the device', () => {
    // Same contract as sendMessage above, and it did not have it. The guard was
    // `if (socket?.connected) socket.emit(...)` with no return, so a vote cast
    // in a tunnel emitted nothing and answered nothing, and the DM vote panel
    // had no way to know it had just flipped a tile over a dead socket.
    localStorage.setItem('flockToken', 'tok');
    const instance = socketApi.connectSocket();

    instance.connected = false;
    expect(socketApi.dmVoteVenue(7, 'Cafe Nine', 'place-9')).toBe(false);
    expect(instance.emit).not.toHaveBeenCalledWith('dm_vote_venue', expect.anything());

    instance.connected = true;
    expect(socketApi.dmVoteVenue(7, 'Cafe Nine', 'place-9')).toBe(true);
    expect(instance.emit).toHaveBeenCalledWith('dm_vote_venue', expect.objectContaining({
      receiverId: 7,
      venue_name: 'Cafe Nine',
      venue_id: 'place-9',
    }));
  });

  test('connectSocket without a token refuses rather than dialing unauthenticated', () => {
    localStorage.removeItem('flockToken');
    expect(socketApi.connectSocket()).toBeNull();
  });
});
